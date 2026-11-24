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

import { parsePlaylist, segmentKey, segmentIndexForTime, serializeMedia, alignLiveTimeline } from './hls-parser.js';

const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 400;
const MIN_WORKERS = 2;
const ACCEL_MIN_BYTES = 1.5 * 1024 * 1024;  // only split downloads expected to be this large
const ACCEL_CHUNK_MIN = 512 * 1024;
const ACCEL_PARTS = 4;
const ACCEL_STRIKES = 3;                     // consecutive transient accel failures before a host is downgraded
const RANGE_REJECT_STATUS = new Set([400, 416, 501]); // the server refuses Range itself

// Prefetch failure cooldown: a segment whose prefetch failed (404/403, retries exhausted) or that
// could not be cached is not re-queued until its cooldown ends (exponential per key).
const FAIL_COOLDOWN_MS = 2000;
const FAIL_COOLDOWN_MAX_MS = 60000;
const FAIL_TRACK_MAX = 512;

// Playlist timeline -> player (presentation) timeline offset learning.
const TELEMETRY_FRESH_MS = 2500;             // telemetry arrives ~1/s
const TIMELINE_SAMPLES = 9;
const TIMELINE_MIN_SAMPLES = 3;

function median(values) {
    const s = values.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Any EXT-X-KEY other than NONE: the bytes are ciphertext (or SAMPLE-AES) and must not be touched. */
export function isEncryptedSegment(seg) {
    return !!(seg && seg.key && seg.key.method && seg.key.method !== 'NONE');
}

function hostOf(url) {
    try { return new URL(url).host; } catch (_) { return ''; }
}

function parseTotal(contentRange) {
    // "bytes 0-524287/4194304"
    const m = /\/(\d+)\s*$/.exec(contentRange || '');
    return m ? parseInt(m[1], 10) : 0;
}

const SNIFF_WINDOW = 262144;   // how far into a payload we look for the real container start
const TS_PACKET = 188;

const MP4_BOXES = new Set(['ftyp', 'styp', 'moof', 'moov', 'sidx', 'emsg', 'prft', 'free', 'skip', 'mdat']);
// Top-level boxes that may follow another one (used to confirm a box found mid-buffer).
const MP4_NEXT_BOXES = new Set([...MP4_BOXES, 'uuid', 'pssh', 'meta', 'mfra', 'ssix']);

function u32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function asBytes(buf) {
    if (!buf) return null;
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return null;
}

/** Header at `o` has a known type and a size field that can belong to a real box. */
function plausibleHeader(b, o, allowed) {
    if (o < 0 || o + 8 > b.length) return null;
    const raw = u32(b, o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    return allowed.has(type) && (raw === 1 || raw >= 8) ? type : null;
}

/**
 * MP4 box type at `o` (b = the whole payload). Offset 0 keeps the lenient check used for real
 * files. Mid-buffer (scanning past a disguise header) a 4-char match alone is a 1-in-~2^28 event
 * per position over 256 KB, so the box must also be self-consistent: its size fits in the data
 * and it either ends exactly at the end of the payload or is followed by another valid header.
 */
function boxTypeAt(b, o) {
    const type = plausibleHeader(b, o, MP4_BOXES);
    if (!type || o === 0) return type;
    let size = u32(b, o);
    if (size === 1) {
        if (o + 16 > b.length) return null;
        size = u32(b, o + 8) * 4294967296 + u32(b, o + 12);
        if (size < 16) return null;
    }
    const end = o + size;
    if (end > b.length) return null;
    if (end === b.length) return type;
    return plausibleHeader(b, end, MP4_NEXT_BOXES) ? type : null;
}

/**
 * MPEG-TS: 0x47 every 188 bytes. Every checked packet start must lie inside the data (the old
 * "end of data counts as a match" rule let two stray 0x47 bytes near the tail pass, ~0.3% of
 * random/encrypted segments). Offset 0 needs 4 packets, or - for payloads shorter than 4 packets -
 * every packet start that exists (at least one full packet). Mid-buffer needs 4..8 packets.
 */
function tsSyncAt(b, o) {
    const n = b.length;
    if (o < 0 || o >= n) return false;
    const available = Math.floor((n - 1 - o) / TS_PACKET) + 1; // packet starts inside the data
    let need;
    if (o === 0 && n < 4 * TS_PACKET) {
        if (n < TS_PACKET) return false;
        need = available;
    } else {
        if (available < 4) return false;
        need = o === 0 ? 4 : Math.min(8, available);
    }
    for (let k = 0; k < need; k++) if (b[o + k * TS_PACKET] !== 0x47) return false;
    return true;
}

/**
 * Identify the real container of a (plaintext) media payload and where it starts.
 * Never call this on encrypted segment bytes: ciphertext is random and any match is bogus.
 * @param {ArrayBuffer|ArrayBufferView} buf
 * @returns {{mime:string, offset:number}|null}
 */
export function sniffMedia(buf) {
    const u = asBytes(buf);
    if (!u || !u.length) return null;
    const scanEnd = Math.min(u.length, SNIFF_WINDOW);
    const ascii = (o, n) => (o + n <= u.length ? String.fromCharCode(...u.subarray(o, o + n)) : '');
    // Text formats may start with a UTF-8 BOM; TextDecoder/Shaka strip it, so report offset 0.
    const t = u.length >= 3 && u[0] === 0xef && u[1] === 0xbb && u[2] === 0xbf ? 3 : 0;
    if (ascii(t, 7) === '#EXTM3U') return { mime: 'application/x-mpegurl', offset: 0 };
    if (ascii(t, 6) === 'WEBVTT') return { mime: 'text/vtt', offset: 0 };
    if (tsSyncAt(u, 0)) return { mime: 'video/mp2t', offset: 0 };
    if (boxTypeAt(u, 0)) return { mime: 'video/mp4', offset: 0 };
    if (u.length >= 10 && ascii(0, 3) === 'ID3') {
        // ID3-tagged packed audio (HLS .aac) or ID3 in front of TS.
        let tagLen = 10 + ((u[6] & 0x7f) << 21 | (u[7] & 0x7f) << 14 | (u[8] & 0x7f) << 7 | (u[9] & 0x7f));
        if (u[5] & 0x10) tagLen += 10; // ID3v2.4 footer
        if (tsSyncAt(u, tagLen)) return { mime: 'video/mp2t', offset: tagLen };
        return { mime: 'audio/aac', offset: 0 };
    }
    if (u.length > 1 && u[0] === 0xff && (u[1] & 0xf6) === 0xf0) return { mime: 'audio/aac', offset: 0 };
    // Disguised payload: skip whatever header was glued in front (PNG/JPEG/GIF/HTML...).
    for (let o = 1; o + 8 < scanEnd; o++) {
        if (u[o] === 0x47 && tsSyncAt(u, o)) return { mime: 'video/mp2t', offset: o };
        const c = u[o + 4];
        if (c === 0x66 || c === 0x6d || c === 0x73) {
            const ty = boxTypeAt(u, o);
            if (ty === 'ftyp' || ty === 'moof' || ty === 'styp') return { mime: 'video/mp4', offset: o };
        }
    }
    return null;
}

/** Trim junk in front of a (plaintext) segment and report its real container. */
export function normalizeSegment(data, mime) {
    const sniff = sniffMedia(data);
    if (!sniff) return { data, mime: mime || '' };
    return { data: sniff.offset ? data.slice(sniff.offset) : data, mime: sniff.mime };
}

/** Plaintext segment bytes with any disguise header removed (export: call after decrypting). */
export function stripMediaPrefix(data) {
    const sniff = sniffMedia(data);
    return sniff && sniff.offset ? data.slice(sniff.offset) : data;
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
        const abort = () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, ms);
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
    });
}

function matchesRange(response, start, end) {
    const value = response.headers['content-range'];
    const match = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(value || '');
    return response.status === 206 && response.data?.byteLength === end - start + 1 &&
        (!value || (match && +match[1] === start && +match[2] === end));
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
        this.rangeStrikes = new Map();  // host -> consecutive transient accelerated failures
        this._abrMs = new WeakMap();    // response -> connection-time to report to ABR (accelerator)
        this.dvrKeys = new Set();       // live segments retained for rewind (protected from eviction)
        this.failures = new Map();      // segmentKey -> {count, until}: failed prefetches cooling down
        this._retryTimer = null;

        // Per media playlist: offset = player presentation time - playlist time (see _learnTimeline).
        this.timeline = new Map();      // playlistUrl -> {offset:number|null, samples:number[], learnedAt}
        this._seekAt = 0;

        // Bumped by reset(): downloads started before a purge must not re-insert cache rows.
        this.generation = 0;
        this._bufferReady = false;
        this._bufferInit = null;

        this.playback = { currentTime: 0, bufferAhead: 0, paused: true, updatedAt: 0 };
        this.stats = {
            bytesDownloaded: 0, segmentsDownloaded: 0, cacheHits: 0, cacheMisses: 0,
            errors: 0, lastLatencyMs: 0
        };
        this._pumpScheduled = false;
    }

    /**
     * The ring buffer's key set is loaded asynchronously (and again after a service-worker
     * restart); until then has() is false for everything and we would re-download cached media.
     * Resolves once init() settled (a failed init leaves the cache empty but usable).
     */
    _bufferInitPromise() {
        if (this._bufferReady) return Promise.resolve();
        if (!this._bufferInit) {
            const init = this.buffer && typeof this.buffer.init === 'function'
                ? Promise.resolve().then(() => this.buffer.init())
                : Promise.resolve();
            this._bufferInit = init.catch(err => {
                console.warn('[Downloader] Cache init failed:', err && err.message);
            }).then(() => {
                this._bufferReady = true;
                this._bufferInit = null;
                this.schedulePump();
            });
        }
        return this._bufferInit;
    }

    /** Is the segment behind this cache key encrypted (per its playlist's EXT-X-KEY)? */
    isEncrypted(key) {
        let loc = this.segmentIndex.get(key);
        if (!loc || !loc.seg) {
            // Not indexed (e.g. playlists restored straight into this.playlists after a
            // service-worker restart): look it up once and index it.
            for (const p of this.playlists.values()) {
                const segs = (p.parsed && p.parsed.segments) || [];
                const seg = segs.find(s => segmentKey(s.uri, s.range) === key) ||
                    (p.dvr ? [...p.dvr.values()].find(s => segmentKey(s.uri, s.range) === key) : null);
                if (seg) {
                    loc = { playlistUrl: p.url, index: seg.index, seg };
                    if (!this.segmentIndex.has(key)) this.segmentIndex.set(key, loc);
                    break;
                }
            }
        }
        return !!(loc && isEncryptedSegment(loc.seg));
    }

    /** Container repair for bytes about to be cached/served; encrypted segments pass untouched. */
    _normalize(key, data, mime) {
        if (this.isEncrypted(key)) return { data, mime: mime || '' };
        return normalizeSegment(data, mime);
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
        const role = this.roles.get(url) || 'main';
        if (parsed.live) {
            // parseMedia() restarts every refresh at 0: keep one stable timeline per playlist
            // (same media sequence => same start) so learned timeline offsets survive refreshes.
            // A brand-new rendition is lined up with a sibling of the same role when they share
            // media sequence numbers, so the sibling's learned offset applies to it as well.
            if (prev) {
                const how = alignLiveTimeline(parsed, prev.parsed, { bridgeGap: true });
                if (!how) this.timeline.delete(url); // sequence went backwards: stream restarted
            } else {
                for (const other of this.playlists.values()) {
                    if (other.url !== url && other.role === role && other.parsed.live &&
                        alignLiveTimeline(parsed, other.parsed)) break;
                }
            }
        }
        const entry = {
            url,
            parsed,
            role,
            cursor: prev ? prev.cursor : -1,
            lastUsed: prev ? prev.lastUsed : 0,
            retired: prev && prev.retired ? prev.retired : new Map() // seq -> key of slid-out segments
        };
        // Live refresh: keep the cursor aligned by media sequence number. When the cursor's
        // segment slid out of the window (paused, or watching DVR history that never moves the
        // cursor) the playlist is still the one in use: clamp to the window start instead of -1,
        // which would mark it inactive and stop look-ahead and DVR capture of new segments.
        if (prev && prev.parsed.mediaSequence !== parsed.mediaSequence && prev.cursor >= 0) {
            const seq = prev.parsed.mediaSequence + prev.cursor;
            entry.cursor = Math.max(0, seq - parsed.mediaSequence);
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
                const old = dvr.get(q);
                total -= old.duration;
                dvr.delete(q);
                entry.retired.set(q, segmentKey(old.uri, old.range));
            }
            entry.dvr = dvr;
        }
        this.playlists.set(url, entry);
        const current = new Set();
        for (const seg of parsed.segments) {
            const key = segmentKey(seg.uri, seg.range);
            current.add(key);
            this.segmentIndex.set(key, { playlistUrl: url, index: seg.index, seg });
        }
        this._pruneSegmentIndex(entry, prev, current);
        this._rebuildDvrKeys();
        this.schedulePump();
        return parsed;
    }

    /**
     * Live playlists slide forever: forget index entries of segments that left the window long
     * ago (one full window of grace, so late player requests still find their EXT-X-KEY and are
     * not sniffed as plaintext). DVR-retained segments stay indexed until they leave the DVR.
     */
    _pruneSegmentIndex(entry, prev, current) {
        const segs = entry.parsed.segments;
        if (prev) {
            for (const s of prev.parsed.segments) {
                const key = segmentKey(s.uri, s.range);
                if (!current.has(key) && !(entry.dvr && entry.dvr.has(s.seq))) entry.retired.set(s.seq, key);
            }
        }
        if (!segs.length || !entry.retired.size) return;
        const horizon = segs[0].seq - Math.max(segs.length, 30);
        for (const [seq, key] of entry.retired) {
            if (current.has(key)) { entry.retired.delete(seq); continue; }
            if (seq >= horizon) continue; // grace period
            entry.retired.delete(seq);
            const loc = this.segmentIndex.get(key);
            if (loc && loc.playlistUrl === entry.url) this.segmentIndex.delete(key);
        }
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
            // Telemetry from before the jump describes the old position: no timeline samples
            // until a fresh report arrives.
            this._seekAt = Date.now();
        } else {
            this._learnTimeline(p, seg);
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
        const seg = segs[loc.index];
        // Stale index (live window slid past this segment): not part of the look-ahead.
        if (!seg || segmentKey(seg.uri, seg.range) !== key) return false;
        const limit = (segs[p.cursor] ? segs[p.cursor].start : 0) + this._windowSeconds();
        return seg.start <= limit;
    }

    // ------------------------------------------------------------------
    // Playlist timeline <-> player timeline
    // ------------------------------------------------------------------
    //
    // seg.start is on the playlist's own timeline (sum of EXTINF from the first parse), but
    // video.currentTime is Shaka's presentation time: for live streams (and VOD with a non-zero
    // start) the two differ by a constant, e.g. currentTime 3600 for playlist time 30. We learn
    // offset = presentationTime - playlistTime per playlist from the player's own requests:
    // Shaka (segmentPrefetchLimit 0) requests the segment that starts at its buffered end, and
    // telemetry tells us buffered end = currentTime + bufferAhead. Samples are only taken while
    // telemetry is fresh, not seeking and after the last seek, with data buffered (startup and
    // post-seek telemetry are not trustworthy). The median of the last samples is used, offsets
    // within ~1.5 segment durations snap to 0 (sampling noise) and the estimate only moves when
    // the median leaves that tolerance (hysteresis). Accuracy is about one segment.

    _timelineTolerance(p) {
        const segs = p.parsed.segments;
        const dur = p.parsed.targetDuration || (segs.length ? segs[0].duration : 0) || 6;
        return Math.max(2, dur * 1.5);
    }

    _learnTimeline(p, seg) {
        const pb = this.playback;
        const now = Date.now();
        if (!pb.updatedAt || now - pb.updatedAt > TELEMETRY_FRESH_MS) return;
        if (pb.seeking || pb.updatedAt <= this._seekAt) return;
        const ct = Number(pb.currentTime);
        const ahead = Number(pb.bufferAhead);
        if (!Number.isFinite(ct) || !Number.isFinite(ahead) || ahead < 0.25) return;
        const sample = ct + Math.min(ahead, 600) - seg.start;
        if (!Number.isFinite(sample)) return;
        let tl = this.timeline.get(p.url);
        if (!tl) { tl = { offset: null, samples: [], learnedAt: 0 }; this.timeline.set(p.url, tl); }
        tl.samples.push(sample);
        if (tl.samples.length > TIMELINE_SAMPLES) tl.samples.shift();
        if (tl.samples.length < TIMELINE_MIN_SAMPLES) return;
        const tol = this._timelineTolerance(p);
        const est = median(tl.samples);
        const next = Math.abs(est) <= tol ? 0 : est;
        if (tl.offset === null || Math.abs(next - tl.offset) > tol) {
            tl.offset = next;
            tl.learnedAt = now;
        }
    }

    /** Player time - playlist time for a media playlist (0 when unknown). */
    timelineOffset(p = this.mainPlaylist()) {
        if (!p) return 0;
        const own = this.timeline.get(p.url);
        if (own && own.offset !== null) return own.offset;
        // A rendition we have not sampled yet: VOD renditions share the same 0-based timeline and
        // live ones are aligned by media sequence on ingest, so a sibling's offset applies.
        let best = null;
        for (const [url, tl] of this.timeline) {
            if (tl.offset === null) continue;
            const q = this.playlists.get(url);
            if (!q || q.parsed.live !== p.parsed.live) continue;
            const score = (q.role === p.role ? 2e15 : 0) + tl.learnedAt;
            if (!best || score > best.score) best = { score, offset: tl.offset };
        }
        if (best) return best.offset;
        // Optional hint from the player: Shaka's seekRange().start is the first segment we expose.
        const hint = this.playback.seekRangeStart;
        const segs = p.parsed.segments;
        if (typeof hint === 'number' && Number.isFinite(hint) && segs.length) {
            const older = p.dvr ? this._dvrOlderCached(p) : [];
            const first = older.length ? older[0].start : segs[0].start;
            const off = hint - first;
            return Math.abs(off) <= this._timelineTolerance(p) ? 0 : off;
        }
        return 0;
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
        const reqHeaders = req.headers || {};
        const key = segmentKey(req.url, reqHeaders.Range || reqHeaders.range || null);
        if (req.method === 'HEAD') {
            const res = await this._load({ ...req, method: 'GET', kind: 'probe', headers: { ...reqHeaders, Range: 'bytes=0-262143' } });
            // Ciphertext says nothing about the container: keep the server's headers.
            const sniff = this.isEncrypted(key) || this.isEncrypted(req.url) ? null : sniffMedia(res.data);
            const outHeaders = { ...res.headers };
            if (sniff) outHeaders['content-type'] = sniff.mime;
            return { ...res, status: res.status === 206 ? 200 : res.status, headers: outHeaders, data: new ArrayBuffer(0) };
        }
        const res = await this._load(req);
        if ((req.kind === 'segment' || req.kind === 'other') && res.data && res.data.byteLength && res.status < 400 &&
            !this.isEncrypted(key)) {
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

        const generation = this.generation;
        if (cacheable) {
            this.noteRequest(key);
            await this._bufferInitPromise(); // has() is meaningless until the key set is loaded
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
                        const norm = this._normalize(key, res.data, res.headers['content-type']);
                        const headers = norm.mime ? { ...res.headers, 'content-type': norm.mime } : res.headers;
                        return { ...res, data: norm.data, headers, fromCache: true };
                    }
                } catch (_) { /* prefetch failed or aborted - fall through to a direct load */ }
            }
            this.stats.cacheMisses++;
        }

        this.activeOnDemand++;
        try {
            let res = await this._fetchWithRetry(url, { method, headers }, signal, true, cacheable);
            if (cacheable && res.data && res.data.byteLength && res.status < 400) {
                const norm = this._normalize(key, res.data, res.headers['content-type']);
                if (norm.mime) res = { ...res, data: norm.data, headers: { ...res.headers, 'content-type': norm.mime } };
                else res = { ...res, data: norm.data };
                // A purge (reset + clearStream) happened meanwhile: do not resurrect the row.
                const stored = generation === this.generation && !this.destroyed
                    ? await this.buffer.storeSegment(key, norm.data, norm.mime).catch(() => false)
                    : false;
                if (stored) {
                    this.failures.delete(key);
                    // Already served to the player: eligible for early eviction.
                    this.buffer.markServed(key);
                    if (zeroCopy) return cachedReply();
                }
            }
            if (kind === 'key' && method === 'GET' && res.data?.byteLength === 16 &&
                generation === this.generation && !this.destroyed) {
                await this.buffer.storeSegment('key:' + url, res.data).catch(() => {});
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

    /**
     * Time ranges currently stored in the ring buffer for the main playlist, on the player's
     * timeline (playlist time + learned timeline offset) so they line up with video.currentTime.
     */
    cachedRanges() {
        const p = this.mainPlaylist();
        if (!p) return [];
        const off = this.timelineOffset(p);
        const ranges = [];
        let cur = null;
        for (const seg of p.parsed.segments) {
            const has = this.buffer.has(segmentKey(seg.uri, seg.range));
            if (has) {
                const start = seg.start + off;
                const end = start + seg.duration;
                if (cur && Math.abs(cur.end - start) < 0.01) cur.end = end;
                else { cur = { start, end }; ranges.push(cur); }
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
        const queued = new Set();
        const windowSec = this._prefetchWindow();
        const now = Date.now();
        let nextRetry = Infinity;
        // Failed recently: skip (and wake up the pump when the first cooldown ends).
        const coolingDown = (key) => {
            const f = this.failures.get(key);
            if (!f || now >= f.until) return false;
            nextRetry = Math.min(nextRetry, f.until - now);
            return true;
        };
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
                if (this.buffer.has(key) || this.inflight.has(key) || queued.has(key) || coolingDown(key)) continue;
                queued.add(key);
                tasks.push({ key, url: seg.uri, range: seg.range, playlistUrl: p.url, index: i, order: seg.start - startTime });
            }
        }
        // Live DVR: capture every segment of the live window (even while paused) so it can be
        // rewound to later; ordered after the look-ahead tasks.
        for (const p of this.activePlaylists()) {
            if (!p.dvr) continue;
            for (const seg of p.parsed.segments) {
                const key = segmentKey(seg.uri, seg.range);
                if (this.buffer.has(key) || this.inflight.has(key) || queued.has(key) || coolingDown(key)) continue;
                queued.add(key);
                tasks.push({ key, url: seg.uri, range: seg.range, playlistUrl: p.url, index: seg.index, order: 1e6 + seg.index });
            }
        }
        if (nextRetry !== Infinity && !this._retryTimer && !this.destroyed) {
            this._retryTimer = setTimeout(() => {
                this._retryTimer = null;
                this.schedulePump();
            }, nextRetry + 20);
        }
        // Interleave roles by timeline position so audio and video stay balanced.
        tasks.sort((a, b) => a.order - b.order);
        return tasks;
    }

    /**
     * A prefetch failed (or its bytes could not be cached): without a cooldown the next pump
     * re-queues the same key at once - a 403/404 segment (expired token, missing file) or one
     * the cache refuses (larger than half the cap) would be downloaded in a tight loop forever.
     */
    _noteFailure(key, hard = false) {
        const prev = this.failures.get(key);
        const count = hard ? Math.max(6, prev ? prev.count + 1 : 0) : (prev ? prev.count + 1 : 1);
        const delay = Math.min(FAIL_COOLDOWN_MAX_MS, FAIL_COOLDOWN_MS * Math.pow(2, count - 1));
        this.failures.delete(key); // refresh insertion order (oldest entries are dropped first)
        this.failures.set(key, { count, until: Date.now() + delay });
        while (this.failures.size > FAIL_TRACK_MAX) this.failures.delete(this.failures.keys().next().value);
    }

    _pausedCacheLimit() {
        return this.playback.paused ? Math.min(this.buffer.capBytes, this.getSettings().pausedBufferMB * 1024 * 1024) : undefined;
    }

    _pump() {
        if (this.paused || this.destroyed) return;
        // Wait for the cache key set (re-pumps when ready) or we would refetch cached segments.
        if (!this._bufferReady) { this._bufferInitPromise(); return; }
        const limit = this._pausedCacheLimit();
        if (limit != null && this.buffer.currentSize + this.buffer.reserved >= limit) return;
        this.queue = this._buildQueue();
        const slots = Math.max(0, this.concurrency - this.activePrefetch - this.activeOnDemand);
        for (let i = 0; i < slots && this.queue.length; i++) {
            this._startPrefetch(this.queue.shift());
        }
    }

    _startPrefetch(task) {
        const controller = new AbortController();
        const entry = { controller, prefetch: true, playlistUrl: task.playlistUrl, index: task.index, promise: null };
        const generation = this.generation;
        this.activePrefetch++;
        entry.promise = (async () => {
            try {
                const headers = task.range ? { Range: task.range } : {};
                let res;
                try {
                    res = await this._fetchWithRetry(task.url, { method: 'GET', headers }, controller.signal, false, true);
                } catch (err) {
                    // Recorded before `finally` re-pumps, or the pump would restart this key at once.
                    if (err && err.name !== 'AbortError' && !controller.signal.aborted &&
                        generation === this.generation) this._noteFailure(task.key);
                    throw err;
                }
                // Purged (reset) while downloading: never re-insert into the cleared cache.
                if (res.data && res.data.byteLength && res.status < 400 &&
                    generation === this.generation && !this.destroyed) {
                    // Encrypted segments are cached byte-exact (sniffing ciphertext corrupts it).
                    const norm = this._normalize(task.key, res.data, res.headers['content-type']);
                    const stored = await this.buffer.storeSegment(task.key, norm.data, norm.mime, this._pausedCacheLimit()).catch(err => {
                        console.warn('[Downloader] Cache store failed:', err && err.message);
                        return false;
                    });
                    if (stored) this.failures.delete(task.key);
                    else if (generation === this.generation && !this.destroyed) this._noteFailure(task.key, true);
                }
                return res;
            } finally {
                this.activePrefetch--;
                // An aborted task may already have been replaced by a new one for the same key.
                if (this.inflight.get(task.key) === entry) this.inflight.delete(task.key);
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

    /** One Range request; adds its own duration to timing.connMs (connection-time for ABR). */
    async _timedRange(url, o, e, signal, timing) {
        const t0 = Date.now();
        const r = await this.transport(url, { method: 'GET', headers: { Range: `bytes=${o}-${e}` }, signal });
        timing.connMs += Date.now() - t0;
        return r;
    }

    async _rangeParts(url, start, end, parts, signal, timing) {
        const size = Math.max(ACCEL_CHUNK_MIN, Math.ceil((end - start + 1) / parts));
        const jobs = [];
        for (let o = start; o <= end; o += size) {
            const e = Math.min(end, o + size - 1);
            jobs.push(this._timedRange(url, o, e, signal, timing).then(r => {
                if (!matchesRange(r, o, e)) {
                    const err = new Error(`Range ${o}-${e} failed (HTTP ${r.status})`);
                    err.status = r.status;
                    // 200 = Range ignored, 206 with the wrong length = Range mis-honoured,
                    // 400/416/501 = Range refused. Anything else (5xx, 403, 0) is not a Range verdict.
                    err.rangeUnsupported = r.status === 200 || r.status === 206 || RANGE_REJECT_STATUS.has(r.status);
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
     * until a short chunk / 416 marks the end).
     *
     * Hosts are downgraded to plain requests permanently only on a Range verdict (200 to a Range
     * request, a wrong-length 206, or 400/416/501), or after ACCEL_STRIKES consecutive transient
     * failures. A single transient failure (network error, timeout, 5xx) just falls back to one
     * plain request for this download.
     *
     * ABR: the response is tagged (this._abrMs) with its *connection-time* - the sum of every
     * part's own request duration - instead of the wall time, so ABR sees bytes per
     * connection-second, i.e. the throughput a single connection sustains. That matches the
     * samples of non-accelerated downloads (each prefetch worker reports its own connection), so
     * on per-connection-throttled CDNs ABR no longer sees ~ACCEL_PARTS x the bandwidth and picks
     * bitrates that smaller, non-split segments then cannot sustain. On a link-limited network
     * this underestimates the aggregate (conservative), never overestimates it.
     */
    async _accelFetch(url, headers, signal) {
        const host = hostOf(url);
        const range = headers.Range || headers.range;
        // Own controller so a failed part cancels its still-running siblings.
        const ctl = new AbortController();
        const onAbort = () => ctl.abort();
        if (signal) {
            if (signal.aborted) ctl.abort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
        const timing = { connMs: 0 };
        try {
            const res = await this._accelBody(url, range, ctl.signal, timing, host);
            this.rangeStrikes.delete(host);
            if (timing.connMs > 0) this._abrMs.set(res, timing.connMs);
            return res;
        } catch (err) {
            ctl.abort();
            if (signal && signal.aborted) throw err && err.name === 'AbortError' ? err : new DOMException('Aborted', 'AbortError');
            if (err && (err.rangeUnsupported || RANGE_REJECT_STATUS.has(err.status))) {
                this.noRangeHosts.add(host);
                this.rangeStrikes.delete(host);
            } else if (isRetryable(err) || (err && err.name === 'AbortError')) {
                const strikes = (this.rangeStrikes.get(host) || 0) + 1;
                if (strikes >= ACCEL_STRIKES) { this.noRangeHosts.add(host); this.rangeStrikes.delete(host); }
                else this.rangeStrikes.set(host, strikes);
            }
            // This download only: one plain request (its errors go to _fetchWithRetry's retries).
            const t0 = Date.now();
            const res = await this.transport(url, { method: 'GET', headers, signal });
            this._abrMs.set(res, Math.max(1, Date.now() - t0));
            return res;
        } finally {
            if (signal) signal.removeEventListener('abort', onAbort);
        }
    }

    async _accelBody(url, range, signal, timing, host) {
        if (range) {
            const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range);
            const parts = await this._rangeParts(url, +a, +b, ACCEL_PARTS, signal, timing);
            return { status: 206, headers: { ...parts[0].headers, 'content-range': `bytes ${a}-${b}/*` }, url: parts[0].url, data: concatBuffers(parts.map(p => p.data)) };
        }
        const chunk = Math.max(ACCEL_CHUNK_MIN, Math.ceil(this.avgSegBytes / ACCEL_PARTS));
        const first = await this._timedRange(url, 0, chunk - 1, signal, timing);
        if (first.status === 200) { this.noRangeHosts.add(host); return first; }
        if (RANGE_REJECT_STATUS.has(first.status)) {
            // The server refuses Range itself (previously surfaced as a hard HttpError).
            throw Object.assign(new Error(`Range refused (HTTP ${first.status})`), { status: first.status, rangeUnsupported: true });
        }
        if (first.status !== 206) return first; // other error statuses are handled by the caller
        const got = first.data.byteLength;
        const total = parseTotal(first.headers['content-range']);
        const outHeaders = { ...first.headers };
        delete outHeaders['content-range'];
        if (got < chunk || (total && total <= got)) return { ...first, status: 200, headers: outHeaders };
        const buffers = [first.data];
        if (total) {
            const rest = await this._rangeParts(url, got, total - 1, ACCEL_PARTS - 1, signal, timing);
            rest.forEach(r => buffers.push(r.data));
        } else {
            let offset = got;
            for (let done = false; !done;) {
                const batch = [];
                for (let i = 0; i < ACCEL_PARTS; i++) {
                    const o = offset + i * chunk;
                    batch.push(this._timedRange(url, o, o + chunk - 1, signal, timing));
                }
                const results = await Promise.all(batch);
                for (const r of results) {
                    if (done) break;
                    if (r.status === 416) { done = true; break; } // past the end
                    if (r.status !== 206) {
                        throw Object.assign(new Error(`HTTP ${r.status}`), {
                            status: r.status,
                            rangeUnsupported: r.status === 200 || RANGE_REJECT_STATUS.has(r.status)
                        });
                    }
                    buffers.push(r.data);
                    offset += r.data.byteLength;
                    if (r.data.byteLength < chunk) done = true;
                }
            }
        }
        return { status: 200, headers: outHeaders, url: first.url, data: concatBuffers(buffers) };
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
                // Accelerated downloads report connection-time (single-connection throughput,
                // see _accelFetch); everything else reports its wall time.
                const abrMs = this._abrMs.get(res);
                this.abr.reportSegmentDownload(bytes, abrMs > 0 ? abrMs : elapsed);
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
     * @param {number} time player (presentation) time, i.e. video.currentTime
     */
    seek(time) {
        time = Number(time);
        if (!Number.isFinite(time)) time = 0;
        this._seekAt = Date.now();
        const windowSec = this._windowSeconds();
        for (const p of this.activePlaylists()) {
            const segs = p.parsed.segments;
            if (!segs.length) continue;
            const target = segmentIndexForTime(segs, time, this.timelineOffset(p));
            const endTime = segs[target].start + windowSec;
            // segs[t.index] can be missing when a live refresh shrank the window meanwhile.
            this._abortWhere(t => t.playlistUrl === p.url && (t.index < target || !segs[t.index] || segs[t.index].start > endTime));
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
        // Downloads still finishing (prefetch or on-demand) belong to the old generation and will
        // not write into a cache that is about to be cleared (PURGE_CACHE: reset + clearStream).
        this.generation++;
        this._abortWhere(() => true);
        this.queue = [];
        this.failures.clear();
    }

    destroy() {
        this.destroyed = true;
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
        this.reset();
        this.playlists.clear();
        this.segmentIndex.clear();
        this.masters.clear();
        this.roles.clear();
        this.timeline.clear();
        this.dvrKeys.clear();
        this.rangeStrikes.clear();
    }

    snapshot() {
        return {
            activeWorkers: this.activePrefetch + this.activeOnDemand,
            concurrency: this.concurrency,
            queued: this.queue.length,
            cachedAhead: this.cachedAheadSeconds(),
            dvrSeconds: this.dvrSeconds(),
            accelerated: this.getSettings().rangeAccel && this.avgSegBytes >= ACCEL_MIN_BYTES,
            timelineOffset: this.timelineOffset(),
            ...this.stats
        };
    }

    // ------------------------------------------------------------------
    // Export helpers
    // ------------------------------------------------------------------

    /**
     * Fetch a segment for export, preferring the cache.
     *
     * Plaintext segments come back with any disguise header removed. Encrypted segments
     * (EXT-X-KEY METHOD != NONE) are never sniffed or sliced here - trimming ciphertext breaks
     * AES-CBC block alignment:
     *  - with `opts.decrypt(data, seg) => Promise<ArrayBuffer>` the ciphertext is decrypted
     *    first and the plaintext is then stripped of its disguise header;
     *  - without it, the ciphertext is returned byte-exact and the caller must decrypt and then
     *    call stripMediaPrefix(plaintext) itself.
     */
    async fetchExportKey(url, signal, cacheOnly) {
        const cached = await this.buffer.getSegment('key:' + url, { markServed: false }).catch(() => null);
        if (cached?.data?.byteLength === 16) return cached.data;
        if (cacheOnly) throw new Error('The encryption key for this clip is no longer cached.');
        const res = await this._fetchWithRetry(url, { method: 'GET', headers: {} }, signal, false);
        if (res.data.byteLength !== 16) throw new Error('Could not load AES-128 key.');
        return res.data;
    }

    fetchProgressiveRange(url, headers, signal) {
        return this._fetchWithRetry(url, { method: 'GET', headers }, signal, false);
    }

    async exportPrefetch(key, signal) {
        const request = this.inflight.get(key);
        if (!request?.prefetch) return null;
        signal.throwIfAborted();
        let abort;
        const aborted = new Promise((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
        });
        try {
            return await Promise.race([request.promise.catch(() => null), aborted]);
        } finally {
            signal.removeEventListener('abort', abort);
        }
    }

    async fetchForExport(seg, signal, opts = {}) {
        const key = segmentKey(seg.uri, seg.range);
        const encrypted = isEncryptedSegment(seg);
        let cached = await this.buffer.getSegment(key, { markServed: false }).catch(() => null);
        // A copy an older build trimmed (sniffed ciphertext): AES-CBC needs whole 16-byte blocks.
        if (cached && encrypted && seg.key.method === 'AES-128' && (!cached.data || cached.data.byteLength % 16 !== 0)) cached = null;
        if (!cached && opts.cacheOnly) throw new Error("Part of this clip is no longer cached. Play through the range and try again.");
        let data = cached?.data;
        if (!data) {
            const prefetched = await this.exportPrefetch(key, signal);
            const response = prefetched || await this._fetchWithRetry(seg.uri, {
                method: 'GET', headers: seg.range ? { Range: seg.range } : {}
            }, signal, false, true);
            const range = /^bytes=(\d+)-(\d+)$/.exec(seg.range || '');
            if (range && !matchesRange(response, +range[1], +range[2])) {
                throw new Error(`The source returned the wrong segment byte range (${seg.range}).`);
            }
            data = response.data;
        }
        if (encrypted) {
            if (typeof opts.decrypt !== 'function') return data;
            data = await opts.decrypt(data, seg);
        }
        // Exported files must not contain the fake image headers some CDNs prepend.
        return opts.keepOriginal ? data : stripMediaPrefix(data);
    }
}
