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

import { STEEmitter } from "./stringly-typed-event-emitter";
import { Segment } from "./loader-interface";
import { SegmentValidatorCallback, XhrSetupCallback, SegmentUrlBuilder } from "./hybrid-loader";

class FilteredEmitter extends STEEmitter<
    "segment-start-load" | "segment-loaded" | "segment-error" | "segment-size" | "bytes-downloaded"
> { }

export class HttpMediaManager extends FilteredEmitter {
    
    private fetchRequests = new Map<string, { request?: Promise<Response>; fetchAbort: AbortController, segment: Segment, initialPriority: number, segmentUrl: string }>();
    private failedSegments = new Map<string, number>();
    private fetch: typeof fetch = (...args) => fetch(...args);
    private debug = Debug("p2pml:http-media-manager");

    public constructor(
        readonly settings: {
            httpFailedSegmentTimeout: number;
            httpUseRanges: boolean;
            requiredSegmentsPriority: number;
            skipSegmentBuilderPriority: number;
            segmentValidator?: SegmentValidatorCallback;
            xhrSetup?: XhrSetupCallback;
            segmentUrlBuilder?: SegmentUrlBuilder;
            localTransport?: typeof fetch;
        }
    ) {
        super();

        if (settings.localTransport) {
            this.fetch = settings.localTransport;
        }
    }

    public download = (segment: Segment, downloadedPieces?: ArrayBuffer[]): void => {
        if (this.isDownloading(segment)) {
            return;
        }

        this.cleanTimedOutFailedSegments();

        this.emit("segment-start-load", segment);

        const segmentUrl = segment.priority <= this.settings.skipSegmentBuilderPriority
            ? segment.url
            : this.buildSegmentUrl(segment);

        this.debug("http segment download", segmentUrl);

        segment.requestUrl = segmentUrl;

        const fetchAbort = new AbortController();
        const signal = fetchAbort.signal;
        const headers = new Headers();

        if (segment.range) {
            headers.append("Range", segment.range);
            downloadedPieces = undefined; // TODO: process downloadedPieces for segments with range headers too
        } else if (downloadedPieces !== undefined && this.settings.httpUseRanges) {
            let bytesDownloaded = 0;
            for (const piece of downloadedPieces) {
                bytesDownloaded += piece.byteLength;
            }

            headers.append("Range", `bytes=${bytesDownloaded}-`);

            this.debug("continue download from", bytesDownloaded);
        } else {
            downloadedPieces = undefined;
        }

        const fetchRequest = this.fetch(segmentUrl, { headers, signal });

        void this.setupFetchEvents(fetchRequest, segment, downloadedPieces)
            .catch((err: Error) => {
                /**
                 * Handling all fetch errors here
                 */

                if (err.name === "AbortError") {
                    /**
                     * This may happen on video seeking
                     * or halted video playing. In most
                     * cases it is normal. For more info
                     * look AbortController...
                     */
                    this.debug("Segment loading was aborted by user", segment);
                    return;
                }

                if (err.message === "network error") {
                    this.debug("Segment loading is unavailable. No internet", segment);

                    const netError = Error("NETWORK_ERROR");

                    this.segmentFailure(segment, netError, segment.url);
                    return;
                }

                if (err.message === "Failed to fetch") {
                    /**
                     * This error might occur in next cases:
                     *   - Network error
                     *   - Response with erroneous CORS headers
                     *   - Unsupported protocol, e.g. HTTPS
                     *   - Wrong request method
                     */

                    this.debug("Segment fetch failed", segment);

                    const fetchError = Error("FETCH_FAILED");

                    this.segmentFailure(segment, fetchError, segment.url);
                    return;
                }
            });

        this.fetchRequests.set(segment.id, { fetchAbort, segment, initialPriority: segment.priority, segmentUrl });
    };

    public updatePriority = (segment: Segment): void => {
        const request = this.fetchRequests.get(segment.id);

        if (!request) {
            throw new Error("Cannot update priority of not downloaded segment " + segment.id);
        }

        // Segment is now in high priority
        // If the segment URL changed, retry the request with the new URL
        if (
            segment.priority <= this.settings.requiredSegmentsPriority &&
            request.initialPriority > this.settings.requiredSegmentsPriority &&
            request.segmentUrl !== this.buildSegmentUrl(segment)
        ) {
            this.debug("aborting http segment abort because the segment is now in a high priority", segment.id);
            this.abort(segment)
            this.download(segment)
        }

    };

    public abort = (segment: Segment): void => {
        const request = this.fetchRequests.get(segment.id);

        if (request) {

            request.fetchAbort.abort();
            this.fetchRequests.delete(segment.id);
            this.debug("http segment abort", segment.id);
        }
    };

    public isDownloading = (segment: Segment): boolean => {
        return this.fetchRequests.has(segment.id);
    };

    public isFailed = (segment: Segment): boolean => {
        const time = this.failedSegments.get(segment.id);
        return time !== undefined && time > this.now();
    };

    public getActiveDownloads = (): ReadonlyMap<string, { segment: Segment }> => {
        return this.fetchRequests;
    };

    public getActiveDownloadsCount = (): number => {
        return this.fetchRequests.size;
    };

    public destroy = (): void => {
        this.fetchRequests.forEach((request) => request.fetchAbort.abort());
        this.fetchRequests.clear();
    };

    private setupFetchEvents = async (fetch: Promise<Response>, segment: Segment, downloadedPieces?: ArrayBuffer[]) => {
        const fetchResponse = await fetch as Response & { body: ReadableStream };

        const dataReader = fetchResponse.body.getReader();

        const contentLengthStr = fetchResponse.headers.get("Content-Length") as string;

        

        const contentLength = Number.parseFloat(contentLengthStr);

        const dataBytes: Uint8Array = new Uint8Array(contentLength);

        let nextChunkPos = 0;

        if (Array.isArray(downloadedPieces) && fetchResponse.status === 206) {
            for (const piece of downloadedPieces) {
                const pieceBytes = new Uint8Array(piece);

                dataBytes.set(pieceBytes, nextChunkPos);

                nextChunkPos = piece.byteLength;
            }
        }

        let read;

        while (!(read = await dataReader.read()).done) {
            const chunkBytes = read.value;

            dataBytes.set(chunkBytes, nextChunkPos);

            nextChunkPos += chunkBytes.length;

            /** Events emitters */

            this.emit("bytes-downloaded", segment, chunkBytes.length);

            if (contentLength) {
                this.emit("segment-size", segment, contentLength);
            }
        }

        if (fetchResponse.status < 200 || fetchResponse.status >= 300) {
            const err = Error(`Segment failure with HTTP code ${fetchResponse.status}`);
            this.segmentFailure(segment, err, fetchResponse.url);
            return;
        }

        await this.segmentDownloadFinished(segment, dataBytes.buffer, fetchResponse);
    };

    private segmentDownloadFinished = async (segment: Segment, data: ArrayBuffer, fetchResponse: Response) => {
        segment.responseUrl = fetchResponse.url;

        if (this.settings.segmentValidator) {
            try {
                await this.settings.segmentValidator({ ...segment, data: data }, "http");
            } catch (error : any) {
                this.debug("segment validator failed", error);
                this.segmentFailure(segment, error, fetchResponse.url);
                return;
            }
        }

        this.fetchRequests.delete(segment.id);
        this.emit("segment-loaded", segment, data);
    };

    private segmentFailure = (segment: Segment, error: Error, responseUrl: string) => {
        segment.responseUrl = responseUrl;

        this.fetchRequests.delete(segment.id);
        this.failedSegments.set(segment.id, this.now() + this.settings.httpFailedSegmentTimeout);
        this.emit("segment-error", segment, error);
    };

    private cleanTimedOutFailedSegments = () => {
        const now = this.now();
        const candidates: string[] = [];

        this.failedSegments.forEach((time, id) => {
            if (time < now) {
                candidates.push(id);
            }
        });

        candidates.forEach((id) => this.failedSegments.delete(id));
    };

    private buildSegmentUrl (segment: Segment) {
        if (this.settings.segmentUrlBuilder) {
            return this.settings.segmentUrlBuilder(segment);
        }

        return segment.url;
    }

    private now = () => performance.now();
}
