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

import { SegmentManager } from "./segment-manager";
import type { LoaderCallbacks, LoaderConfiguration, LoaderContext, LoaderStats } from "hls.js";
import { Events, Segment } from "@peertube/p2p-media-loader-core";
import { byteRangeToString, getByteRange } from "./byte-range"

export class HlsJsLoader {
    private isLoaded = false;
    private segmentManager: SegmentManager;
    public stats: LoaderStats = {
        loaded: 0,
        total: 0,
        aborted: false,
        retry: 0,
        chunkCount: 0,
        bwEstimate: 0,
        loading: {
            start: 0,
            end: 0,
            first: 0,
        },
        parsing: {
            start: 0,
            end: 0,
        },
        buffering: {
            start: 0,
            end: 0,
            first: 0,
        },
    };

    public constructor(segmentManager: SegmentManager) {
        this.segmentManager = segmentManager;
    }

    public async load(
        context: LoaderContext,
        _config: LoaderConfiguration,
        callbacks: LoaderCallbacks<LoaderContext>
    ): Promise<void> {
        HlsJsLoader.updateStatsToStartLoading(this.stats)

        if (((context as unknown) as { type: unknown }).type) {
            try {
                const result = await this.segmentManager.loadPlaylist(context.url);
                this.isLoaded = true;
                this.successPlaylist(result, context, callbacks);
            } catch (e) {
                this.error(e, context, callbacks);
            }
        } else if (((context as unknown) as { frag: unknown }).frag) {
            const { loader } = this.segmentManager;
            const byteRange = getByteRange(context)

            const isSegment = (segment: Segment) => {
                return segment.url === context.url && segment.range === byteRangeToString(byteRange)
            }

            // We may be downloading the segment by P2P, so we don't care about the stats sent to HLS ABR
            let updateStart: NodeJS.Timeout | undefined = setInterval(() => {
                HlsJsLoader.updateStatsToStartLoading(this.stats)
            }, 200)

            const onUpdateSegmentSize = (segment: Segment, size: number) => {
                if (!isSegment(segment)) return

                this.stats.total = size
            };
            loader.on(Events.SegmentSize, onUpdateSegmentSize)

            const onUpdateLoaded = (_type: unknown, segment: Segment, bytes: number) => {
                if (!isSegment(segment)) return

                this.stats.loaded += bytes
            };

            const onSegmentStartLoad = (method: "http" | "p2p", segment: Segment) => {
                if (!updateStart || method !== "http" || !isSegment(segment)) return

                clearInterval(updateStart)
                updateStart = undefined

                HlsJsLoader.updateStatsToStartLoading(this.stats)

                loader.on(Events.PieceBytesDownloaded, onUpdateLoaded)
            };

            loader.on(Events.SegmentStartLoad, onSegmentStartLoad)

            try {
                const result = await this.segmentManager.loadSegment(context.url, byteRange);
                const { content } = result;
                if (content) {
                    this.isLoaded = true;
                    setTimeout(() => this.successSegment(content, context, callbacks), 0);
                }
            } catch (e) {
                setTimeout(() => this.error(e, context, callbacks), 0);
            } finally {
                clearInterval(updateStart)
                loader.off(Events.SegmentStartLoad, onSegmentStartLoad)
                loader.off(Events.SegmentSize, onUpdateSegmentSize)
                loader.off(Events.PieceBytesDownloaded, onUpdateLoaded)
            }
        } else {
            console.warn("Unknown load request", context);
        }
    }

    public abort(context: LoaderContext, callbacks?: LoaderCallbacks<LoaderContext>): void {
        if (this.isLoaded) return;

        this.segmentManager.abortSegment(context.url, getByteRange(context));
        this.stats.aborted = true;

        const onAbort = callbacks?.onAbort;
        if (onAbort) {
            onAbort(this.stats, context, undefined);
        }
    }

    private successPlaylist(
        xhr: { response: string; responseURL: string },
        context: LoaderContext,
        callbacks: LoaderCallbacks<LoaderContext>
    ): void {
        const now = performance.now();

        this.stats.loading.end = now;
        this.stats.loaded = xhr.response.length;
        this.stats.total = xhr.response.length;

        callbacks.onSuccess(
            {
                url: xhr.responseURL,
                data: xhr.response,
            },
            this.stats,
            context,
            undefined
        );
    }

    private successSegment(
        content: ArrayBuffer,
        context: LoaderContext,
        callbacks: LoaderCallbacks<LoaderContext>
    ): void {
        const now = performance.now();

        this.stats.loading.end = now;
        this.stats.loaded = content.byteLength;
        this.stats.total = content.byteLength;

        if (callbacks.onProgress) {
            callbacks.onProgress(this.stats, context, content, undefined);
        }

        callbacks.onSuccess(
            {
                url: context.url,
                data: content,
            },
            this.stats,
            context,
            undefined
        );
    }

    private error(
        error: { code: number; text: string },
        context: LoaderContext,
        callbacks: LoaderCallbacks<LoaderContext>
    ): void {
        callbacks.onError(error, context, undefined);
    }

    private static updateStatsToStartLoading (stats: LoaderStats) {
        const start = performance.now();
        stats.loading.start = start;
        stats.loading.first = start;
    }
}
