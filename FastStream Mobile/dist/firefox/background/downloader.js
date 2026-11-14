/**
 * FastStream Mobile - Segment Downloader
 *
 * One instance per player session. Responsibilities:
 *  - On-demand loads for the player (manifest / segment / key requests) with cache lookup,
 *    in-flight de-duplication and exponential-backoff retries.
 *  - Continuous parallel prefetching of upcoming HLS segments into the IndexedDB ring
 *    buffer, from the player's current position up to `maxBufferSec` ahead (backpressure).
 *  - Dynamic concurrency (2..maxWorkers, max 8) driven by buffer health and latency.
 *  - Seek handling: time -> segment index, abort out-of-window requests, refill from target.
 *  - Feeding real network throughput samples into the ABRController.
 *
 * Network I/O goes through an injected `transport(url, {method, headers, signal})` that
 * proxies through the frame that owns the stream (cookies/Referer) with a direct fallback.
 */

import { parsePlaylist, segmentKey, segmentIndexForTime } from './hls-parser.js';

const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 400;
const MIN_WORKERS = 2;

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(t);
                reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        }
    });
}

function isRetryable(err) {
    if (!err || err.name === 'AbortError') return false;
    if (typeof err.status === 'number' && err.status > 0) {
        return err.status === 408 || err.status === 429 || err.status >= 500;
    }
    return true; // network errors / timeouts
}

export class HttpError extends Error {
    constructor(status, url) {
        super(`HTTP ${status} for ${url}`);
        this.name = 'HttpError';
        this.status = status;
    }
}

export class SegmentDownloader {
    /**
     * @param {object} deps
     * @param {(url:string, opts:{method?:string, headers?:object, signal?:AbortSignal}) =>
     *          Promise<{status:number, headers:object, data:ArrayBuffer, url:string}>} deps.transport
     * @param {import('./buffer-manager.js').BufferManager} deps.buffer
     * @param {import('./abr-controller.js').ABRController} deps.abr
     * @param {() => {maxBufferSec:number, maxWorkers:number}} deps.getSettings
     */
    constructor({ transport, buffer, abr, getSettings }) {
        this.transport = transport;
        this.buffer = buffer;
        this.abr = abr;
        this.getSettings = getSettings;

        this.playlists = new Map();     // playlistUrl -> {url, parsed, role, cursor, lastUsed}
        this.segmentIndex = new Map();  // segmentKey -> {playlistUrl, index}
        this.masters = new Map();       // masterUrl -> parsed master
        this.roles = new Map();         // media playlist url -> 'main' | 'audio' | 'subtitles'

        this.inflight = new Map();      // segmentKey -> {promise, controller, prefetch, playlistUrl, index}
        this.queue = [];                // pending prefetch tasks (ordered)
        this.concurrency = 3;
        this.activePrefetch = 0;
        this.activeOnDemand = 0;
        this.paused = false;
        this.destroyed = false;

        this.playback = { currentTime: 0, bufferAhead: 0, paused: true, updatedAt: 0 };
        this.stats = {
            bytesDownloaded: 0, segmentsDownloaded: 0, cacheHits: 0, cacheMisses: 0,
            errors: 0, lastLatencyMs: 0
        };
        this._pumpScheduled = false;
    }

    // ------------------------------------------------------------------
    // Playlist knowledge
    // ------------------------------------------------------------------

    /** Learn from any playlist text the player loaded (master or media). */
    ingestPlaylist(url, text) {
        const parsed = parsePlaylist(text, url);
        if (!parsed) return null;
        if (parsed.type === 'master') {
            this.masters.set(url, parsed);
            for (const v of parsed.variants) if (!this.roles.has(v.uri)) this.roles.set(v.uri, 'main');
            for (const m of parsed.media) {
                if (!m.uri) continue;
                this.roles.set(m.uri, m.type === 'AUDIO' ? 'audio' : m.type === 'SUBTITLES' ? 'subtitles' : 'main');
            }
            return parsed;
        }
        const prev = this.playlists.get(url);
        const entry = {
            url,
            parsed,
            role: this.roles.get(url) || 'main',
            cursor: prev ? prev.cursor : -1,
            lastUsed: prev ? prev.lastUsed : 0
        };
        // Live refresh: keep the cursor aligned by media sequence number.
        if (prev && prev.parsed.mediaSequence !== parsed.mediaSequence && prev.cursor >= 0) {
            const seq = prev.parsed.mediaSequence + prev.cursor;
            entry.cursor = Math.max(-1, seq - parsed.mediaSequence);
        }
        this.playlists.set(url, entry);
        for (const seg of parsed.segments) {
            this.segmentIndex.set(segmentKey(seg.uri, seg.range), { playlistUrl: url, index: seg.index });
        }
        this.schedulePump();
        return parsed;
    }

    /** Playlists the player is currently pulling segments from (one per role). */
    activePlaylists() {
        const byRole = new Map();
        for (const p of this.playlists.values()) {
            if (p.cursor < 0 || p.role === 'subtitles') continue;
            const cur = byRole.get(p.role);
            if (!cur || p.lastUsed > cur.lastUsed) byRole.set(p.role, p);
        }
        return [...byRole.values()];
    }

    /** Main (video) playlist currently in use, or the only one we know. */
    mainPlaylist() {
        const active = this.activePlaylists();
        return active.find(p => p.role === 'main') || active[0] || [...this.playlists.values()][0] || null;
    }

    /** Mark a player request: advances the cursor for its playlist (drives the prefetch window). */
    noteRequest(key) {
        const loc = this.segmentIndex.get(key);
        if (!loc) return;
        const p = this.playlists.get(loc.playlistUrl);
        if (!p) return;
        p.cursor = loc.index;
        p.lastUsed = Date.now();
        // A different rendition of the same role became active: drop prefetches for the old one.
        for (const other of this.playlists.values()) {
            if (other !== p && other.role === p.role && other.cursor >= 0 && other.lastUsed < p.lastUsed) {
                other.cursor = -1;
                this._abortWhere(t => t.playlistUrl === other.url);
            }
        }
    }

    /** Look-ahead protection used by the ring buffer's eviction pass. */
    isProtected(key) {
        const loc = this.segmentIndex.get(key);
        if (!loc) return false;
        const p = this.playlists.get(loc.playlistUrl);
        if (!p || p.cursor < 0) return false;
        if (loc.index < p.cursor) return false;
        const segs = p.parsed.segments;
        const limit = (segs[p.cursor] ? segs[p.cursor].start : 0) + this._windowSeconds();
        return segs[loc.index].start <= limit;
    }

    // ------------------------------------------------------------------
    // Player-facing loads
    // ------------------------------------------------------------------

    /**
     * Load a resource for the player.
     * @returns {Promise<{status:number, headers:object, data:ArrayBuffer, url:string, fromCache:boolean}>}
     */
    async load({ url, method = 'GET', headers = {}, kind = 'segment', signal }) {
        const range = headers.Range || headers.range || null;
        const key = segmentKey(url, range);
        const cacheable = kind === 'segment' && method === 'GET';

        if (cacheable) {
            this.noteRequest(key);
            const cached = await this.buffer.getSegment(key).catch(() => null);
            if (cached) {
                this.stats.cacheHits++;
                this.schedulePump();
                return { status: range ? 206 : 200, headers: cached.mime ? { 'content-type': cached.mime } : {}, data: cached.data, url, fromCache: true };
            }
            const pending = this.inflight.get(key);
            if (pending) {
                // Promote a running prefetch: the player waits on the same network request.
                try {
                    const res = await pending.promise;
                    if (res) {
                        this.stats.cacheHits++;
                        return { ...res, fromCache: true };
                    }
                } catch (_) { /* prefetch failed or aborted - fall through to a direct load */ }
            }
            this.stats.cacheMisses++;
        }

        this.activeOnDemand++;
        try {
            const res = await this._fetchWithRetry(url, { method, headers }, signal, true);
            if (cacheable && res.data && res.data.byteLength) {
                this.buffer.storeSegment(key, res.data, res.headers['content-type'] || '').then(() => {
                    // Already served to the player: mark as eligible for early eviction.
                    return this.buffer.getSegment(key, { markServed: true });
                }).catch(() => { /* cache is best-effort */ });
            }
            if ((kind === 'manifest') && res.data) {
                try {
                    const text = new TextDecoder().decode(res.data);
                    this.ingestPlaylist(res.url || url, text);
                    if (res.url && res.url !== url) this.ingestPlaylist(url, text);
                } catch (_) { /* not text */ }
            }
            return { ...res, fromCache: false };
        } finally {
            this.activeOnDemand--;
            this.schedulePump();
        }
    }

    // ------------------------------------------------------------------
    // Prefetch scheduling
    // ------------------------------------------------------------------

    updatePlayback(state) {
        this.playback = { ...this.playback, ...state, updatedAt: Date.now() };
        this.adjustConcurrency();
        this.schedulePump();
    }

    _windowSeconds() {
        const s = this.getSettings();
        return Math.max(10, s.maxBufferSec || 90);
    }

    /**
     * Dynamic concurrency: more workers when the buffer is thin or latency is high
     * (parallelism hides per-request latency), fewer when the buffer is healthy (battery).
     */
    adjustConcurrency() {
        const maxWorkers = Math.min(8, Math.max(MIN_WORKERS, this.getSettings().maxWorkers || 6));
        const ahead = this.playback.bufferAhead + this.cachedAheadSeconds();
        const latency = this.stats.lastLatencyMs;
        let target = this.concurrency;
        if (ahead < 10 || latency > 600) target = maxWorkers;
        else if (ahead < 30 || latency > 250) target = Math.min(maxWorkers, Math.max(this.concurrency, 4));
        else if (ahead > this._windowSeconds() * 0.75) target = MIN_WORKERS;
        else target = Math.max(MIN_WORKERS, Math.min(maxWorkers, 3));
        this.concurrency = target;
    }

    /** Seconds of contiguous cached/in-flight media after the cursor of the main playlist. */
    cachedAheadSeconds() {
        const p = this.mainPlaylist();
        if (!p || p.cursor < 0) return 0;
        const segs = p.parsed.segments;
        let secs = 0;
        for (let i = p.cursor + 1; i < segs.length; i++) {
            const key = segmentKey(segs[i].uri, segs[i].range);
            if (!this.buffer.has(key)) break;
            secs += segs[i].duration;
        }
        return secs;
    }

    /** Time ranges (playlist timeline) currently stored in the ring buffer for the main playlist. */
    cachedRanges() {
        const p = this.mainPlaylist();
        if (!p) return [];
        const ranges = [];
        let cur = null;
        for (const seg of p.parsed.segments) {
            const has = this.buffer.has(segmentKey(seg.uri, seg.range));
            if (has) {
                if (cur && Math.abs(cur.end - seg.start) < 0.01) cur.end = seg.start + seg.duration;
                else { cur = { start: seg.start, end: seg.start + seg.duration }; ranges.push(cur); }
            } else {
                cur = null;
            }
        }
        return ranges;
    }

    schedulePump() {
        if (this._pumpScheduled || this.destroyed) return;
        this._pumpScheduled = true;
        queueMicrotask(() => {
            this._pumpScheduled = false;
            this._pump();
        });
    }

    _buildQueue() {
        const tasks = [];
        const windowSec = this._windowSeconds();
        for (const p of this.activePlaylists()) {
            const segs = p.parsed.segments;
            if (!segs.length) continue;
            const from = Math.max(0, p.cursor + 1);
            const startTime = segs[Math.min(from, segs.length - 1)].start;
            // Count what the player already holds in MSE so we do not over-fetch.
            const budget = Math.max(0, windowSec - Math.max(0, this.playback.bufferAhead - (segs[p.cursor] ? segs[p.cursor].duration : 0)));
            for (let i = from; i < segs.length; i++) {
                const seg = segs[i];
                if (seg.start - startTime >= budget) break;
                const key = segmentKey(seg.uri, seg.range);
                if (this.buffer.has(key) || this.inflight.has(key)) continue;
                tasks.push({ key, url: seg.uri, range: seg.range, playlistUrl: p.url, index: i, order: seg.start - startTime });
            }
        }
        // Interleave roles by timeline position so audio and video stay balanced.
        tasks.sort((a, b) => a.order - b.order);
        return tasks;
    }

    _pump() {
        if (this.paused || this.destroyed) return;
        this.queue = this._buildQueue();
        const slots = Math.max(0, this.concurrency - this.activePrefetch - this.activeOnDemand);
        for (let i = 0; i < slots && this.queue.length; i++) {
            this._startPrefetch(this.queue.shift());
        }
    }

    _startPrefetch(task) {
        const controller = new AbortController();
        const entry = { controller, prefetch: true, playlistUrl: task.playlistUrl, index: task.index, promise: null };
        this.activePrefetch++;
        entry.promise = (async () => {
            try {
                const headers = task.range ? { Range: task.range } : {};
                const res = await this._fetchWithRetry(task.url, { method: 'GET', headers }, controller.signal, false);
                if (res.data && res.data.byteLength) {
                    await this.buffer.storeSegment(task.key, res.data, res.headers['content-type'] || '').catch(err => {
                        console.warn('[Downloader] Cache store failed:', err && err.message);
                    });
                }
                return res;
            } finally {
                this.activePrefetch--;
                this.inflight.delete(task.key);
                this.schedulePump();
            }
        })();
        entry.promise.catch(err => {
            if (err && err.name !== 'AbortError') {
                this.stats.errors++;
                console.warn('[Downloader] Prefetch failed:', task.url, err.message);
            }
        });
        this.inflight.set(task.key, entry);
    }

    async _fetchWithRetry(url, { method, headers }, signal, onDemand) {
        let attempt = 0;
        for (;;) {
            if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const started = Date.now();
            try {
                const res = await this.transport(url, { method, headers, signal });
                if (res.status >= 400) throw new HttpError(res.status, url);
                const elapsed = Date.now() - started;
                const bytes = res.data ? res.data.byteLength : 0;
                this.stats.lastLatencyMs = elapsed;
                this.stats.bytesDownloaded += bytes;
                if (bytes) this.stats.segmentsDownloaded++;
                this.abr.reportSegmentDownload(bytes, elapsed);
                return res;
            } catch (err) {
                attempt++;
                if (!isRetryable(err) || attempt > MAX_RETRIES || this.destroyed) throw err;
                // Exponential backoff with jitter; on-demand loads retry faster.
                const base = onDemand ? BASE_BACKOFF_MS / 2 : BASE_BACKOFF_MS;
                const delay = base * Math.pow(2, attempt - 1) * (0.75 + Math.random() * 0.5);
                await sleep(delay, signal);
            }
        }
    }

    _abortWhere(predicate) {
        for (const [key, entry] of this.inflight) {
            if (entry.prefetch && predicate(entry)) {
                entry.controller.abort();
                this.inflight.delete(key);
            }
        }
    }

    /**
     * Seek: map time -> segment index in every active playlist, abort prefetches outside the
     * new window, move cursors and immediately refill from the target.
     */
    seek(time) {
        const windowSec = this._windowSeconds();
        for (const p of this.activePlaylists()) {
            const segs = p.parsed.segments;
            if (!segs.length) continue;
            const target = segmentIndexForTime(segs, time);
            const endTime = segs[target].start + windowSec;
            this._abortWhere(t => t.playlistUrl === p.url && (t.index < target || segs[t.index].start > endTime));
            p.cursor = Math.max(-1, target - 1);
            p.lastUsed = Date.now();
        }
        this.queue = [];
        this.playback.bufferAhead = 0;
        this.concurrency = Math.min(8, Math.max(MIN_WORKERS, this.getSettings().maxWorkers || 6));
        this.schedulePump();
    }

    pause() {
        this.paused = true;
    }

    resume() {
        this.paused = false;
        this.schedulePump();
    }

    /** Abort everything and forget the queue (stream switch / close). */
    reset() {
        this._abortWhere(() => true);
        this.queue = [];
    }

    destroy() {
        this.destroyed = true;
        this.reset();
        this.playlists.clear();
        this.segmentIndex.clear();
    }

    snapshot() {
        return {
            activeWorkers: this.activePrefetch + this.activeOnDemand,
            concurrency: this.concurrency,
            queued: this.queue.length,
            cachedAhead: this.cachedAheadSeconds(),
            ...this.stats
        };
    }

    // ------------------------------------------------------------------
    // Export helpers
    // ------------------------------------------------------------------

    /** Fetch a segment for export, preferring the cache. */
    async fetchForExport(seg, signal) {
        const key = segmentKey(seg.uri, seg.range);
        const cached = await this.buffer.getSegment(key, { markServed: false }).catch(() => null);
        if (cached) return cached.data;
        const res = await this._fetchWithRetry(seg.uri, { method: 'GET', headers: seg.range ? { Range: seg.range } : {} }, signal, false);
        return res.data;
    }
}
