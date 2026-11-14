/**
 * Velostream - Segment Downloader
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

import { parsePlaylist, segmentKey, segmentIndexForTime, serializeMedia } from './hls-parser.js';

const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 400;
const MIN_WORKERS = 2;
const ACCEL_MIN_BYTES = 1.5 * 1024 * 1024;  // only split downloads expected to be this large
const ACCEL_CHUNK_MIN = 512 * 1024;
const ACCEL_PARTS = 4;

function hostOf(url) {
    try { return new URL(url).host; } catch (_) { return ''; }
}

function parseTotal(contentRange) {
    // "bytes 0-524287/4194304"
    const m = /\/(\d+)\s*$/.exec(contentRange || '');
    return m ? parseInt(m[1], 10) : 0;
}

const MP4_BOXES = new Set(['ftyp', 'styp', 'moof', 'moov', 'sidx', 'emsg', 'prft', 'free', 'skip', 'mdat']);

function boxTypeAt(b, o) {
    if (o + 8 > b.length) return null;
    const size = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    return MP4_BOXES.has(type) && (size === 1 || size >= 8) ? type : null;
}

function tsSyncAt(b, o) {
    // MPEG-TS: 0x47 every 188 bytes. Require 4 consecutive packets (or the end of the data).
    for (let k = 0; k < 4; k++) {
        const p = o + k * 188;
        if (p >= b.length) return k > 0;
        if (b[p] !== 0x47) return false;
    }
    return true;
}

/**
 * Identify the real container of a media payload and where it starts.
 * @returns {{mime:string, offset:number}|null}
 */
export function sniffMedia(buf) {
    if (!buf || !buf.byteLength) return null;
    const b = new Uint8Array(buf, 0, Math.min(buf.byteLength, 262144));
    const ascii = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
    if (ascii(0, 7) === '#EXTM3U') return { mime: 'application/x-mpegurl', offset: 0 };
    if (ascii(0, 6) === 'WEBVTT') return { mime: 'text/vtt', offset: 0 };
    if (tsSyncAt(b, 0)) return { mime: 'video/mp2t', offset: 0 };
    if (boxTypeAt(b, 0)) return { mime: 'video/mp4', offset: 0 };
    if (ascii(0, 3) === 'ID3') {
        // ID3-tagged packed audio (HLS .aac) or ID3 in front of TS.
        const tagLen = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
        if (tsSyncAt(b, tagLen)) return { mime: 'video/mp2t', offset: tagLen };
        return { mime: 'audio/aac', offset: 0 };
    }
    if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return { mime: 'audio/aac', offset: 0 };
    // Disguised payload: skip whatever header was glued in front (PNG/JPEG/GIF/HTML...).
    for (let o = 1; o < b.length - 8; o++) {
        if (b[o] === 0x47 && tsSyncAt(b, o) && o + 188 < b.length) return { mime: 'video/mp2t', offset: o };
        if ((b[o + 4] === 0x66 || b[o + 4] === 0x6d || b[o + 4] === 0x73) && boxTypeAt(b, o)) {
            const t = boxTypeAt(b, o);
            if (t === 'ftyp' || t === 'moof' || t === 'styp') return { mime: 'video/mp4', offset: o };
        }
    }
    return null;
}

/** Trim junk in front of a segment and report its real container (cache stores clean data). */
export function normalizeSegment(data, mime) {
    const sniff = sniffMedia(data);
    if (!sniff) return { data, mime: mime || '' };
    return { data: sniff.offset ? data.slice(sniff.offset) : data, mime: sniff.mime };
}

function concatBuffers(buffers) {
    const total = buffers.reduce((n, b) => n + b.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const b of buffers) { out.set(new Uint8Array(b), offset); offset += b.byteLength; }
    return out.buffer;
}

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

        this.avgSegBytes = 0;           // EMA of segment sizes (drives the range accelerator)
        this.noRangeHosts = new Set();  // hosts that ignore Range: never split there again
        this.dvrKeys = new Set();       // live segments retained for rewind (protected from eviction)

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
        // Live DVR: remember every segment we have seen (by media sequence) for N minutes so the
        // player can rewind past the origin's sliding window using the cached copies.
        const dvrMin = this.getSettings().dvrMinutes || 0;
        if (parsed.live && dvrMin > 0 && !parsed.lowLatency) {
            const dvr = prev && prev.dvr ? prev.dvr : new Map();
            for (const seg of parsed.segments) dvr.set(seg.seq, seg);
            const seqs = [...dvr.keys()].sort((a, b) => a - b);
            let total = seqs.reduce((t, q) => t + dvr.get(q).duration, 0);
            while (seqs.length > parsed.segments.length && total > dvrMin * 60) {
                const q = seqs.shift();
                total -= dvr.get(q).duration;
                dvr.delete(q);
            }
            entry.dvr = dvr;
        }
        this.playlists.set(url, entry);
        for (const seg of parsed.segments) {
            this.segmentIndex.set(segmentKey(seg.uri, seg.range), { playlistUrl: url, index: seg.index });
        }
        this._rebuildDvrKeys();
        this.schedulePump();
        return parsed;
    }

    _rebuildDvrKeys() {
        this.dvrKeys.clear();
        for (const p of this.playlists.values()) {
            if (!p.dvr) continue;
            for (const seg of p.dvr.values()) this.dvrKeys.add(segmentKey(seg.uri, seg.range));
        }
    }

    /** Retained segments older than the origin's window that are cached, oldest first. */
    _dvrOlderCached(entry) {
        const first = entry.parsed.segments[0];
        if (!first || !entry.dvr) return [];
        const older = [];
        for (let q = first.seq - 1; entry.dvr.has(q); q--) {
            const seg = entry.dvr.get(q);
            if (!this.buffer.has(segmentKey(seg.uri, seg.range))) break; // must be contiguous
            older.unshift(seg);
        }
        return older;
    }

    /**
     * Playlist text to hand the player: the origin's live window extended backwards with the
     * cached DVR segments. Returns null when there is nothing to add (original text is used).
     */
    dvrPlaylistText(url) {
        const entry = this.playlists.get(url);
        if (!entry || !entry.dvr) return null;
        const older = this._dvrOlderCached(entry);
        if (!older.length) return null;
        return serializeMedia([...older, ...entry.parsed.segments], { targetDuration: entry.parsed.targetDuration });
    }

    /** Seconds of rewindable live media (cached history + current window) of the main playlist. */
    dvrSeconds() {
        const p = this.mainPlaylist();
        if (!p || !p.dvr) return 0;
        return this._dvrOlderCached(p).reduce((t, s) => t + s.duration, 0) + p.parsed.totalDuration;
    }

    /** Segments for export/recording: full DVR history for live, the playlist for VOD. */
    exportSegments(playlist) {
        if (playlist.dvr) return [...playlist.dvr.values()].sort((a, b) => a.seq - b.seq);
        return playlist.parsed.segments;
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
        // Live playlists slide: a stale index (e.g. a DVR rewind segment) must not move the cursor.
        const seg = p.parsed.segments[loc.index];
        if (!seg || segmentKey(seg.uri, seg.range) !== key) return;
        // A jump (seek from any source - our UI, the site, a chapter link) shows up as a request
        // far from the cursor: stop downloads behind the new position so the jump gets the
        // full bandwidth, and let the queue refill from there.
        if (p.cursor >= 0 && (loc.index < p.cursor || loc.index > p.cursor + 3)) {
            this._abortWhere(t => t.playlistUrl === p.url && t.index < loc.index);
            this.concurrency = Math.min(8, Math.max(MIN_WORKERS, this.getSettings().maxWorkers || 6));
        }
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
        if (this.dvrKeys.has(key)) return true;
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
    /**
     * Player-facing load with container repair:
     *  - HEAD (Shaka's container probe for unknown extensions such as disguised ".jpg"/".html"
     *    segments) is answered from the first bytes of the real body, not the server's lying
     *    Content-Type, so Shaka picks the right demuxer/transmuxer.
     *  - Segments with junk in front of the media (fake PNG/JPEG headers some CDNs prepend to
     *    dodge hot-link filters) are trimmed to the first real TS / MP4 / ADTS byte.
     */
    async load(req) {
        if (req.method === 'HEAD') {
            const res = await this._load({ ...req, method: 'GET', kind: 'probe', headers: { ...(req.headers || {}), Range: 'bytes=0-262143' } });
            const sniff = sniffMedia(res.data);
            const outHeaders = { ...res.headers };
            if (sniff) outHeaders['content-type'] = sniff.mime;
            return { ...res, status: res.status === 206 ? 200 : res.status, headers: outHeaders, data: new ArrayBuffer(0) };
        }
        const res = await this._load(req);
        if ((req.kind === 'segment' || req.kind === 'other') && res.data && res.data.byteLength && res.status < 400) {
            const sniff = sniffMedia(res.data);
            if (sniff) {
                const data = sniff.offset ? res.data.slice(sniff.offset) : res.data;
                return { ...res, data, headers: { ...res.headers, 'content-type': sniff.mime } };
            }
        }
        return res;
    }

    /**
     * @param {boolean} zeroCopy the caller can read the IndexedDB cache itself (the player page
     *   shares the extension origin): answer "it is cached under <key>" instead of shipping bytes.
     */
    async _load({ url, method = 'GET', headers = {}, kind = 'segment', signal, zeroCopy = false }) {
        const range = headers.Range || headers.range || null;
        const key = segmentKey(url, range);
        const cacheable = kind === 'segment' && method === 'GET';
        const cachedReply = () => ({ status: range ? 206 : 200, headers: {}, data: null, url, fromCache: true, inCache: true, cacheKey: key });

        if (cacheable) {
            this.noteRequest(key);
            if (zeroCopy && this.buffer.has(key)) {
                this.stats.cacheHits++;
                this.buffer.markServed(key);
                this.schedulePump();
                return cachedReply();
            }
            const cached = zeroCopy ? null : await this.buffer.getSegment(key).catch(() => null);
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
                        if (zeroCopy && this.buffer.has(key)) { this.buffer.markServed(key); return cachedReply(); }
                        return { ...res, ...normalizeSegment(res.data, res.headers['content-type']), fromCache: true };
                    }
                } catch (_) { /* prefetch failed or aborted - fall through to a direct load */ }
            }
            this.stats.cacheMisses++;
        }

        this.activeOnDemand++;
        try {
            let res = await this._fetchWithRetry(url, { method, headers }, signal, true, cacheable);
            if (cacheable && res.data && res.data.byteLength && res.status < 400) {
                const norm = normalizeSegment(res.data, res.headers['content-type']);
                res = { ...res, data: norm.data, headers: { ...res.headers, 'content-type': norm.mime } };
                const stored = await this.buffer.storeSegment(key, norm.data, norm.mime).catch(() => false);
                if (stored) {
                    // Already served to the player: eligible for early eviction.
                    this.buffer.markServed(key);
                    if (zeroCopy) return cachedReply();
                }
            }
            if ((kind === 'manifest') && res.data && res.status < 400) {
                try {
                    const text = new TextDecoder().decode(res.data);
                    const finalUrl = res.url || url;
                    const parsed = this.ingestPlaylist(finalUrl, text);
                    if (finalUrl !== url) this.ingestPlaylist(url, text);
                    if (parsed && parsed.type === 'media' && parsed.live) {
                        const extended = this.dvrPlaylistText(finalUrl);
                        if (extended) return { ...res, data: new TextEncoder().encode(extended).buffer, fromCache: false };
                    }
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
        // Whole-video pre-buffering: keep every worker busy until the target is nearly reached,
        // then idle down to save battery. Latency only matters while the buffer is thin.
        let target;
        if (ahead >= this._prefetchWindow() * 0.95) target = MIN_WORKERS;
        else if (ahead < 30 || latency > 250) target = maxWorkers;
        else target = Math.max(MIN_WORKERS, maxWorkers - 1);
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

    /** Look-ahead for new downloads: the full target, or 60 s once the cache cap is reached. */
    _prefetchWindow() {
        const full = this.buffer.capBytes && this.buffer.currentSize >= this.buffer.capBytes * 0.95;
        return full ? Math.min(60, this._windowSeconds()) : this._windowSeconds();
    }

    _buildQueue() {
        const tasks = [];
        const windowSec = this._prefetchWindow();
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
        // Live DVR: capture every segment of the live window (even while paused) so it can be
        // rewound to later; ordered after the look-ahead tasks.
        for (const p of this.activePlaylists()) {
            if (!p.dvr) continue;
            for (const seg of p.parsed.segments) {
                const key = segmentKey(seg.uri, seg.range);
                if (this.buffer.has(key) || this.inflight.has(key) || tasks.some(t => t.key === key)) continue;
                tasks.push({ key, url: seg.uri, range: seg.range, playlistUrl: p.url, index: seg.index, order: 1e6 + seg.index });
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
                const res = await this._fetchWithRetry(task.url, { method: 'GET', headers }, controller.signal, false, true);
                if (res.data && res.data.byteLength && res.status < 400) {
                    const norm = normalizeSegment(res.data, res.headers['content-type']);
                    await this.buffer.storeSegment(task.key, norm.data, norm.mime).catch(err => {
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

    /** Should this download be split into parallel Range sub-requests? */
    _canAccelerate(url, method, headers, isSegment) {
        if (!isSegment || method !== 'GET' || !this.getSettings().rangeAccel) return false;
        if (this.noRangeHosts.has(hostOf(url))) return false;
        const range = headers.Range || headers.range;
        if (range) {
            const m = /^bytes=(\d+)-(\d+)$/.exec(range);
            return !!m && (+m[2] - +m[1] + 1) >= ACCEL_MIN_BYTES;
        }
        return this.avgSegBytes >= ACCEL_MIN_BYTES;
    }

    async _rangeParts(url, start, end, parts, signal) {
        const size = Math.max(ACCEL_CHUNK_MIN, Math.ceil((end - start + 1) / parts));
        const jobs = [];
        for (let o = start; o <= end; o += size) {
            const e = Math.min(end, o + size - 1);
            jobs.push(this.transport(url, { method: 'GET', headers: { Range: `bytes=${o}-${e}` }, signal }).then(r => {
                if (r.status !== 206 || r.data.byteLength !== e - o + 1) {
                    const err = new Error(`Range ${o}-${e} not honoured (HTTP ${r.status})`);
                    err.rangeUnsupported = true;
                    throw err;
                }
                return r;
            }));
        }
        return Promise.all(jobs);
    }

    /**
     * Multi-chunk byte-range accelerator. CDNs that throttle per connection are downloaded with
     * ACCEL_PARTS parallel `Range` requests and the parts are merged into one ArrayBuffer.
     * Open-ended downloads start with a first chunk; its Content-Range total sizes the rest
     * (or, when the header is not exposed, further chunks are fetched speculatively in batches
     * until a short chunk / 416 marks the end). Servers that ignore Range are remembered.
     */
    async _accelFetch(url, headers, signal) {
        const host = hostOf(url);
        const range = headers.Range || headers.range;
        try {
            if (range) {
                const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range);
                const parts = await this._rangeParts(url, +a, +b, ACCEL_PARTS, signal);
                return { status: 206, headers: { ...parts[0].headers, 'content-range': `bytes ${a}-${b}/*` }, url: parts[0].url, data: concatBuffers(parts.map(p => p.data)) };
            }
            const chunk = Math.max(ACCEL_CHUNK_MIN, Math.ceil(this.avgSegBytes / ACCEL_PARTS));
            const first = await this.transport(url, { method: 'GET', headers: { Range: `bytes=0-${chunk - 1}` }, signal });
            if (first.status === 200) { this.noRangeHosts.add(host); return first; }
            if (first.status !== 206) return first; // error statuses are handled by the caller
            const got = first.data.byteLength;
            const total = parseTotal(first.headers['content-range']);
            const outHeaders = { ...first.headers };
            delete outHeaders['content-range'];
            if (got < chunk || (total && total <= got)) return { ...first, status: 200, headers: outHeaders };
            const buffers = [first.data];
            if (total) {
                const rest = await this._rangeParts(url, got, total - 1, ACCEL_PARTS - 1, signal);
                rest.forEach(r => buffers.push(r.data));
            } else {
                let offset = got;
                for (let done = false; !done;) {
                    const batch = [];
                    for (let i = 0; i < ACCEL_PARTS; i++) {
                        const o = offset + i * chunk;
                        batch.push(this.transport(url, { method: 'GET', headers: { Range: `bytes=${o}-${o + chunk - 1}` }, signal }));
                    }
                    const results = await Promise.all(batch);
                    for (const r of results) {
                        if (done) break;
                        if (r.status === 416) { done = true; break; }
                        if (r.status !== 206) throw Object.assign(new Error(`HTTP ${r.status}`), { rangeUnsupported: r.status === 200 });
                        buffers.push(r.data);
                        offset += r.data.byteLength;
                        if (r.data.byteLength < chunk) done = true;
                    }
                }
            }
            return { status: 200, headers: outHeaders, url: first.url, data: concatBuffers(buffers) };
        } catch (err) {
            if (err && err.name === 'AbortError') throw err;
            // Range unsupported, or a parallel part failed (CORS-preflighted Range through the page,
            // a CDN that rejects out-of-range chunks, ...): this host gets plain whole-file requests.
            this.noRangeHosts.add(host);
            return this.transport(url, { method: 'GET', headers, signal });
        }
    }

    async _fetchWithRetry(url, { method, headers }, signal, onDemand, isSegment = false) {
        let attempt = 0;
        for (;;) {
            if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const started = Date.now();
            try {
                const res = this._canAccelerate(url, method, headers, isSegment)
                    ? await this._accelFetch(url, headers, signal)
                    : await this.transport(url, { method, headers, signal });
                if (res.status >= 400) throw new HttpError(res.status, url);
                const elapsed = Date.now() - started;
                const bytes = res.data ? res.data.byteLength : 0;
                this.stats.lastLatencyMs = elapsed;
                this.stats.bytesDownloaded += bytes;
                if (bytes) this.stats.segmentsDownloaded++;
                if (isSegment && bytes) this.avgSegBytes = this.avgSegBytes ? this.avgSegBytes * 0.7 + bytes * 0.3 : bytes;
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
            dvrSeconds: this.dvrSeconds(),
            accelerated: this.getSettings().rangeAccel && this.avgSegBytes >= ACCEL_MIN_BYTES,
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
        const data = cached ? cached.data
            : (await this._fetchWithRetry(seg.uri, { method: 'GET', headers: seg.range ? { Range: seg.range } : {} }, signal, false, true)).data;
        // Exported files must not contain the fake image headers some CDNs prepend.
        const sniff = sniffMedia(data);
        return sniff && sniff.offset ? data.slice(sniff.offset) : data;
    }
}
