/**
 * Copyright 2018 Novage LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Debug from "debug";
import { Events, Segment, LoaderInterface/*, XhrSetupCallback */} from "p2p-media-loader-core-basyton";
import { Manifest, Parser } from "m3u8-parser";
import { ByteRange, byteRangeToString, compareByteRanges } from "./byte-range";
import { AssetsStorage } from "./engine";

const defaultSettings: SegmentManagerSettings = {
    forwardSegmentCount: 20,
    swarmId: undefined,
    assetsStorage: undefined,
};

export class SegmentManager {
    private readonly debug = Debug("p2pml:segment-manager");

    public readonly loader: LoaderInterface;
    private masterPlaylist: Playlist | null = null;
    private readonly variantPlaylists = new Map<string, Playlist>();
    private segmentRequest: SegmentRequest | null = null;
    private readonly fetch: typeof fetch = (...args) => fetch(...args);

    private playQueue: {
        segmentSequence: number;
        segmentUrl: string;
        segmentByteRange: ByteRange;
        playPosition?: {
            start: number;
            duration: number;
        };
    }[] = [];
    private readonly settings: SegmentManagerSettings;

    public constructor(loader: LoaderInterface, settings: Partial<SegmentManagerSettings> = {}, loadersettings: any = {}) {
        this.settings = { ...defaultSettings, ...settings };

        this.loader = loader;
        this.loader.on(Events.SegmentLoaded, this.onSegmentLoaded);
        this.loader.on(Events.SegmentError, this.onSegmentError);
        this.loader.on(Events.SegmentAbort, this.onSegmentAbort);

        if (loadersettings.localTransport) {
            this.fetch = loadersettings.localTransport;
        }
    }

    public getSettings(): SegmentManagerSettings {
        return this.settings;
    }

    public processPlaylist(requestUrl: string, content: string, responseUrl: string): void {
        const parser = new Parser();
        parser.push(content);
        parser.end();

        const playlist = new Playlist(requestUrl, responseUrl, parser.manifest);

        if (playlist.manifest.playlists) {
            this.masterPlaylist = playlist;

            for (const [key, variantPlaylist] of this.variantPlaylists) {
                const { streamSwarmId, found, index } = this.getStreamSwarmId(variantPlaylist.requestUrl);
                if (!found) {
                    this.variantPlaylists.delete(key);
                } else {
                    variantPlaylist.streamSwarmId = streamSwarmId;
                    variantPlaylist.streamId = "V" + index.toString();
                }
            }
        } else {
            const { streamSwarmId, found, index } = this.getStreamSwarmId(requestUrl);

            if (found || this.masterPlaylist === null) {
                // do not add audio and subtitles to variants
                playlist.streamSwarmId = streamSwarmId;
                playlist.streamId = this.masterPlaylist === null ? undefined : "V" + index.toString();
                this.variantPlaylists.set(requestUrl, playlist);
                this.updateSegments();
            }
        }
    }

    public async loadPlaylist(url: string): Promise<{ response: string; responseURL: string }> {
        const assetsStorage = this.settings.assetsStorage;
        let xhr: { response: string; responseURL: string } | undefined;

        if (assetsStorage !== undefined) {
            let masterSwarmId: string | undefined;
            masterSwarmId = this.getMasterSwarmId();
            if (masterSwarmId === undefined) {
                masterSwarmId = url.split("?")[0];
            }
            const asset = await assetsStorage.getAsset(url, undefined, masterSwarmId);

            if (asset !== undefined) {
                xhr = {
                    responseURL: asset.responseUri,
                    response: asset.data as string,
                };
            } else {

                const fetch = await this.loadContent(url);

                xhr = {
                    responseURL: fetch.url,
                    response: await fetch.text(),
                };

                void assetsStorage.storeAsset({
                    masterManifestUri: this.masterPlaylist !== null ? this.masterPlaylist.requestUrl : url,
                    masterSwarmId: masterSwarmId,
                    requestUri: url,
                    responseUri: xhr.responseURL,
                    data: xhr.response,
                });
            }
        } else {
            const fetch = await this.loadContent(url);

            xhr = {
                responseURL: fetch.url,
                response: await fetch.text(),
            };
        }

        this.processPlaylist(url, xhr.response, xhr.responseURL);
        return xhr;
    }

    public async loadSegment(
        url: string,
        byteRange: ByteRange
    ): Promise<{ content: ArrayBuffer | undefined; downloadBandwidth?: number; bwEstimateSample? : boolean }> {
        const segmentLocation = this.getSegmentLocation(url, byteRange);
        const byteRangeString = byteRangeToString(byteRange);

        if (!segmentLocation) {
            let content: ArrayBuffer | undefined;

            // Not a segment from variants; usually can be: init, audio or subtitles segment, encryption key etc.
            const assetsStorage = this.settings.assetsStorage;
            if (assetsStorage !== undefined) {
                let masterManifestUri = this.masterPlaylist?.requestUrl;

                let masterSwarmId: string | undefined;
                masterSwarmId = this.getMasterSwarmId();

                if (masterSwarmId === undefined && this.variantPlaylists.size === 1) {
                    const result = this.variantPlaylists.values().next();
                    if (!result.done) {
                        // always true
                        masterSwarmId = result.value.requestUrl.split("?")[0];
                    }
                }

                if (masterManifestUri === undefined && this.variantPlaylists.size === 1) {
                    const result = this.variantPlaylists.values().next();
                    if (!result.done) {
                        // always true
                        masterManifestUri = result.value.requestUrl;
                    }
                }

                if (masterSwarmId !== undefined && masterManifestUri !== undefined) {
                    const asset = await assetsStorage.getAsset(url, byteRangeString, masterSwarmId);
                    if (asset !== undefined) {
                        content = asset.data as ArrayBuffer;
                    } else {
                        const fetch  = await this.loadContent(url, byteRangeString);
                        content = await fetch.arrayBuffer();

                        void assetsStorage.storeAsset({
                            masterManifestUri: masterManifestUri,
                            masterSwarmId: masterSwarmId,
                            requestUri: url,
                            requestRange: byteRangeString,
                            responseUri: fetch.url,
                            data: content as ArrayBuffer,
                        });

                    }
                }
            }

            if (content === undefined) {
                const fetch = await this.loadContent(url, byteRangeString);
                content = await fetch.arrayBuffer();
            }

            return { content, downloadBandwidth: 0 };
        }

        const segmentSequence =
            (segmentLocation.playlist.manifest.mediaSequence ? segmentLocation.playlist.manifest.mediaSequence : 0) +
            segmentLocation.segmentIndex;

        if (this.playQueue.length > 0) {
            const previousSegment = this.playQueue[this.playQueue.length - 1];
            if (previousSegment.segmentSequence !== segmentSequence - 1) {
                // Reset play queue in case of segment loading out of sequence
                this.playQueue = [];
            }
        }

        if (this.segmentRequest) {
            this.segmentRequest.onError("Cancel segment request: simultaneous segment requests are not supported");
        }

        const promise = new Promise<{ content: ArrayBuffer | undefined; downloadBandwidth?: number; bwEstimateSample? : boolean }>(
            (resolve, reject) => {
                this.segmentRequest = new SegmentRequest(
                    url,
                    byteRange,
                    segmentSequence,
                    segmentLocation.playlist.requestUrl,
                    (content: ArrayBuffer | undefined, downloadBandwidth?: number, bwEstimateSample? : boolean ) =>
                        resolve({ content, downloadBandwidth, bwEstimateSample }),
                    (error) => reject(error)
                );
            }
        );

        this.playQueue.push({ segmentUrl: url, segmentByteRange: byteRange, segmentSequence: segmentSequence });
        void this.loadSegments(segmentLocation.playlist, segmentLocation.segmentIndex, true);

        return promise;
    }

    public setPlayingSegment(url: string, byteRange: ByteRange, start: number, duration: number): void {
        const urlIndex = this.playQueue.findIndex(
            (segment) => segment.segmentUrl === url && compareByteRanges(segment.segmentByteRange, byteRange)
        );

        this.debug("Set playing segment to index %d", urlIndex, this.playQueue);

        if (urlIndex >= 0) {
            this.playQueue = this.playQueue.slice(urlIndex);
            this.playQueue[0].playPosition = { start, duration };
            this.updateSegments();
        }
    }

    public setPlayingSegmentByCurrentTime(playheadPosition: number): void {
        if (this.playQueue.length === 0 || !this.playQueue[0].playPosition) {
            return;
        }

        const currentSegmentPosition = this.playQueue[0].playPosition;
        const segmentEndTime = currentSegmentPosition.start + currentSegmentPosition.duration;

        if (segmentEndTime - playheadPosition < 0.2) {
            // means that current segment is (almost) finished playing
            // remove it from queue

            this.playQueue = this.playQueue.slice(1);
            this.updateSegments();
        }
    }

    public abortSegment(url: string, byteRange: ByteRange): void {
        if (
            this.segmentRequest &&
            this.segmentRequest.segmentUrl === url &&
            compareByteRanges(this.segmentRequest.segmentByteRange, byteRange)
        ) {
            this.segmentRequest.onSuccess(undefined, 0, false);
            this.segmentRequest = null;
        }
    }

    public abortCurrentSegment () {
        if (!this.segmentRequest) return;

        this.segmentRequest.onSuccess(undefined, 0, false);
        this.segmentRequest = null;
    }

    public async destroy(): Promise<void> {
        if (this.segmentRequest) {
            this.segmentRequest.onError("Loading aborted: object destroyed");
            this.segmentRequest = null;
        }

        this.masterPlaylist = null;
        this.variantPlaylists.clear();
        this.playQueue = [];

        if (this.settings.assetsStorage !== undefined) {
            await this.settings.assetsStorage.destroy();
        }

        await this.loader.destroy();
    }

    private updateSegments(): void {
        if (!this.segmentRequest) {
            return;
        }


        const segmentLocation = this.getSegmentLocation(
            this.segmentRequest.segmentUrl,
            this.segmentRequest.segmentByteRange
            );

        this.debug("update segments", segmentLocation);

        if (segmentLocation) {
            void this.loadSegments(segmentLocation.playlist, segmentLocation.segmentIndex, false);
        }
    }

    private onSegmentLoaded = (segment: Segment, peerId? : String) => {
        if (
            this.segmentRequest &&
            this.segmentRequest.segmentUrl === segment.url &&
            byteRangeToString(this.segmentRequest.segmentByteRange) === segment.range
        ) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this.segmentRequest.onSuccess(segment.data!.slice(0), segment.downloadBandwidth, peerId ? false : true);
            this.segmentRequest = null;
        }
    };

    private onSegmentError = (segment: Segment, error: unknown) => {
        if (
            this.segmentRequest &&
            this.segmentRequest.segmentUrl === segment.url &&
            byteRangeToString(this.segmentRequest.segmentByteRange) === segment.range
        ) {
            this.segmentRequest.onError(error);
            this.segmentRequest = null;
        }
    };

    private onSegmentAbort = (segment: Segment) => {
        if (
            this.segmentRequest &&
            this.segmentRequest.segmentUrl === segment.url &&
            byteRangeToString(this.segmentRequest.segmentByteRange) === segment.range
        ) {
            this.segmentRequest.onError("Loading aborted: internal abort");
            this.segmentRequest = null;
        }
    };

    private getSegmentLocation(
        url: string,
        byteRange: ByteRange
    ): { playlist: Playlist; segmentIndex: number } | undefined {
        for (const playlist of this.variantPlaylists.values()) {
            const segmentIndex = playlist.getSegmentIndex(url, byteRange);
            if (segmentIndex >= 0) {
                return { playlist: playlist, segmentIndex: segmentIndex };
            }
        }

        return undefined;
    }

    private async loadSegments(playlist: Playlist, segmentIndex: number, requestFirstSegment: boolean) {
        const segments: Segment[] = [];
        const playlistSegments = playlist.manifest.segments;
        const initialSequence = playlist.manifest.mediaSequence ?? 0;
        let loadSegmentId: string | null = null;

        let priority = Math.max(0, this.playQueue.length - 1);

        const masterSwarmId = this.getMasterSwarmId();

        this.debug("load segments", priority, segmentIndex);

        for (
            let i = segmentIndex;
            i < playlistSegments.length && segments.length < this.settings.forwardSegmentCount;
            ++i
        ) {
            const segment = playlist.manifest.segments[i];

            const url = playlist.getSegmentAbsoluteUrl(segment.uri);
            const byteRange: ByteRange = segment.byterange;
            const id = this.getSegmentId(playlist, initialSequence + i);
            segments.push({
                id: id,
                url: url,
                masterSwarmId: masterSwarmId !== undefined ? masterSwarmId : playlist.streamSwarmId,
                masterManifestUri: this.masterPlaylist !== null ? this.masterPlaylist.requestUrl : playlist.requestUrl,
                streamId: playlist.streamId,
                sequence: (initialSequence + i).toString(),
                range: byteRangeToString(byteRange),
                priority: priority++,
            });
            if (requestFirstSegment && !loadSegmentId) {
                loadSegmentId = id;
            }
        }

        this.loader.load(segments, playlist.streamSwarmId);

        if (loadSegmentId) {
            const segment = await this.loader.getSegment(loadSegmentId);
            if (segment) {
                // Segment already loaded by loader
                this.onSegmentLoaded(segment, 'fakepeerid');
            }
        }
    }

    private getSegmentId(playlist: Playlist, segmentSequence: number): string {
        return `${playlist.streamSwarmId}+${segmentSequence}`;
    }

    private getMasterSwarmId() {
        const settingsSwarmId =
            this.settings.swarmId && this.settings.swarmId.length !== 0 ? this.settings.swarmId : undefined;
        if (settingsSwarmId !== undefined) {
            return settingsSwarmId;
        }

        return this.masterPlaylist !== null ? this.masterPlaylist.requestUrl.split("?")[0] : undefined;
    }

    private getStreamSwarmId(playlistUrl: string): { streamSwarmId: string; found: boolean; index: number } {
        const masterSwarmId = this.getMasterSwarmId();

        if (this.masterPlaylist && this.masterPlaylist.manifest.playlists && masterSwarmId) {
            for (let i = 0; i < this.masterPlaylist.manifest.playlists.length; ++i) {
                const url = new URL(
                    this.masterPlaylist.manifest.playlists[i].uri,
                    this.masterPlaylist.responseUrl
                ).toString();
                if (url === playlistUrl) {
                    return { streamSwarmId: `${masterSwarmId}+V${i}`, found: true, index: i };
                }
            }
        }

        return {
            streamSwarmId: masterSwarmId ?? playlistUrl.split("?")[0],
            found: false,
            index: -1,
        };
    }

    private async loadContent(
        url: string,
        range?: string
    ): Promise<any> {
        const headers = new Headers();

        if (range) {
            headers.append('Range', range);
        }

        return this.fetch(url, { headers });
      
    }

    /*private async loadContent(
        url: string,
        responseType: XMLHttpRequestResponseType,
        range?: string
    ): Promise<XMLHttpRequest> {
        return new Promise<XMLHttpRequest>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", url, true);
            xhr.responseType = responseType;

            if (range) {
                xhr.setRequestHeader("Range", range);
            }

            xhr.addEventListener("readystatechange", () => {
                if (xhr.readyState !== 4) return;
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr);
                } else {
                    reject(xhr.statusText);
                }
            });

            const xhrSetup = (this.loader.getSettings() as { xhrSetup?: XhrSetupCallback }).xhrSetup;
            if (xhrSetup) {
                xhrSetup(xhr, url);
            }

            xhr.send();
        });
    }*/
}

class Playlist {
    public streamSwarmId = "";
    public streamId?: string;

    public constructor(readonly requestUrl: string, readonly responseUrl: string, readonly manifest: Manifest) {}

    public getSegmentIndex(url: string, byteRange: ByteRange): number {
        for (let i = 0; i < this.manifest.segments.length; ++i) {
            const segment = this.manifest.segments[i];
            const segmentUrl = this.getSegmentAbsoluteUrl(segment.uri);

            if (url === segmentUrl && compareByteRanges(segment.byterange, byteRange)) {
                return i;
            }
        }

        return -1;
    }

    public getSegmentAbsoluteUrl(segmentUrl: string): string {
        return new URL(segmentUrl, this.responseUrl).toString();
    }
}

class SegmentRequest {
    public constructor(
        readonly segmentUrl: string,
        readonly segmentByteRange: ByteRange,
        readonly segmentSequence: number,
        readonly playlistRequestUrl: string,
        readonly onSuccess: (content: ArrayBuffer | undefined, downloadBandwidth: number | undefined, bwEstimateSample : boolean | false) => void,
        readonly onError: (error: unknown) => void
    ) {}
}

export interface SegmentManagerSettings {
    /**
     * Number of segments for building up predicted forward segments sequence; used to predownload and share via P2P
     */
    forwardSegmentCount: number;

    /**
     * Override default swarm ID that is used to identify unique media stream with trackers (manifest URL without
     * query parameters is used as the swarm ID if the parameter is not specified)
     */
    swarmId?: string;

    /**
     * A storage for the downloaded assets: manifests, subtitles, init segments, DRM assets etc. By default the assets are not stored.
     */
    assetsStorage?: AssetsStorage;

    localTransport? : typeof fetch;
}
