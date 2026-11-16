/**
 * Velostream - opt-in cross-device sync.
 *
 * Uses the browser's own account sync (chrome.storage.sync / browser.storage.sync): the data goes to
 * the user's Google / Mozilla account sync, never to a server of ours. Does nothing unless the stored
 * `fs_settings.syncEnabled === true`.
 *
 * WHAT SYNCS (storage.sync keys, all prefixed `vs_`)
 *   vs_meta          {v, dev, at, s: {<section>: {n, h, e}}}  - version, random device id, write time,
 *                    and per section: chunk count, hash of the canonical JSON, encoding (j = JSON,
 *                    z = deflate + base64).
 *   vs_set_<i>       settings minus DEVICE_SPECIFIC_SETTINGS, with the time they were last changed.
 *   vs_hist_<i>      the newest (up to 200, as many as fit) watch positions in compact form plus
 *                    deletion tombstones.
 *   vs_lib_<i>       fs_library (favorites / collections) with per-item change times + tombstones.
 *   vs_bm_<i>        bookmarks (fs_bm_<key>) of the synced history videos, as many as fit.
 *   Each section's JSON is split into string chunks of < 8000 bytes (key + JSON value), the whole set
 *   is kept under ~90 KB (QUOTA_BYTES is 102400). Priority: settings > history > library > bookmarks;
 *   history drops its oldest entries first.
 *
 * WRITE RATE: pushes are coalesced (10 s after the last local change, at most 60 s after the first
 * one) and spaced >= 30 s apart; a push only writes chunks whose content changed (one set() call,
 * plus one remove() call when stale chunks remain). A local rolling cap (10/min, 300/h) sits far
 * under MAX_WRITE_OPERATIONS_PER_MINUTE (120) / PER_HOUR (1800).
 *
 * MERGE: settings - last writer wins by the local change time (tracked here); history - per entry,
 * newest updatedAt wins, union, newest 200 kept locally, deletions travel as tombstones, and a shared
 * cutoff (`c`) keeps budget-dropped old entries from being re-added by devices that still hold them;
 * bookmarks - per video newest change wins (union by t when a side has no recorded change time);
 * library - favorites and collections merged per item by change time vs tombstone time, kept as a
 * "view" in fs_sync_state and projected onto the local history (see the library section below).
 * Every merge is deterministic (ties broken by content) so devices converge and never ping-pong.
 */

const VERSION = 1;
const PREFIX = 'vs_';
const META_KEY = 'vs_meta';
const SECTIONS = ['set', 'hist', 'lib', 'bm'];
const STATE_KEY = 'fs_sync_state';     // storage.local: device id + change times + tombstones
const STATUS_KEY = 'fs_sync_status';   // storage.local: {state, lastSyncAt, error} for the popup
const SESSION_KEY = 'fs_sync_session'; // storage.session (local fallback): dirty flag, write log
const LIBRARY_KEY = 'fs_library';
const BM_PREFIX = 'fs_bm_';
const KEY_RE = /^[\w-]{1,64}$/;

const QUOTA_BYTES = 102400;
const ITEM_BUDGET = 8000;              // QUOTA_BYTES_PER_ITEM is 8192
const TOTAL_BUDGET = 90 * 1024;
const META_RESERVE = 700;
const SET_MAX = 24 * 1024;
const HIST_MAX = 56 * 1024;
const LIB_MAX = 16 * 1024;
const MAX_CHUNKS_PER_SECTION = 64;

const HISTORY_LOCAL_MAX = 200;
const HISTORY_SYNC_MAX = 200;
const TOMB_MAX = 200;
const BM_MAX = 500;
const URL_MAX = 2048;

const DEBOUNCE_MS = 10000;
const MAX_WAIT_MS = 60000;
const MIN_SPACING_MS = 30000;
const PULL_DEBOUNCE_MS = 2000;
const WRITES_PER_MIN_CAP = 10;
const WRITES_PER_HOUR_CAP = 300;
const QUOTA_BACKOFF_MS = 5 * 60 * 1000;
const HOURLY_BACKOFF_MS = 60 * 60 * 1000;
const ERROR_BACKOFF_MS = 2 * 60 * 1000;
const RECENT_SYNC_MS = 60 * 1000;
const INCOMPLETE_GRACE_MS = 5 * 60 * 1000;
const MAX_DECODED_CHARS = 1024 * 1024;

/**
 * Settings that stay on this device (hardware, screen, network, storage or per-session state).
 * Everything else mergeSettings returns is synced.
 */
export const DEVICE_SPECIFIC_SETTINGS = Object.freeze([
    'syncEnabled',
    'settingsVersion',
    'hwTier', // each device detects its own hardware tier
    'uiScale',
    'maxWorkers',
    'cacheSizeMB',
    'maxBufferSec',
    'mseBufferAhead',
    'mseBufferBehind',
    'rebufferingGoal',
    'rangeAccel',
    'dvrMinutes',
    'maxRenderRes',
    'shader',
    'shaderStrength',
    'qualityCap',
    'memory.volume',
    'memory.muted',
    'memory.qualityHeight'
]);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (n) => typeof n === 'number' && Number.isFinite(n);
const str = (s, max) => (typeof s === 'string' ? s.slice(0, max) : '');
const httpUrl = (u) => (typeof u === 'string' && u.length <= URL_MAX && /^https?:\/\//i.test(u) ? u : '');
const round1 = (n) => Math.round(n * 10) / 10;

/** JSON with object keys sorted, so equal content always gives the same string. */
function canon(v) {
    if (Array.isArray(v)) return `[${v.map(x => (x === undefined ? 'null' : canon(x))).join(',')}]`;
    if (isObj(v)) {
        return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v === undefined ? null : v);
}

/** cyrb53: fast 53-bit string hash. */
function hash(s) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
        const ch = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const hashOf = (v) => hash(canon(v));

function utf8len(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
        else n += 3;
    }
    return n;
}
/** chrome.storage.sync counts key length + JSON.stringify(value) length. */
const itemBytes = (key, value) => utf8len(key) + utf8len(JSON.stringify(value));

function getPath(o, path) {
    return path.split('.').reduce((v, k) => (isObj(v) ? v[k] : undefined), o);
}
function setPath(o, path, value) {
    const parts = path.split('.');
    let cur = o;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!isObj(cur[parts[i]])) return;
        cur = cur[parts[i]];
    }
    if (value === undefined) delete cur[parts[parts.length - 1]];
    else cur[parts[parts.length - 1]] = value;
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Keep the newest `max` entries of a {key: time} map (deterministic: time desc, key asc). */
function capTimes(map, max) {
    const entries = Object.entries(map).filter(([k, t]) => typeof k === 'string' && fin(t));
    if (entries.length <= max) return Object.fromEntries(entries);
    entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return Object.fromEntries(entries.slice(0, max));
}
function maxTimes(a, b) {
    const out = { ...a };
    for (const [k, t] of Object.entries(b || {})) if (fin(t) && !(out[k] >= t)) out[k] = t;
    return out;
}

// ---------------------------------------------------------------------------
// Encoding (deflate + base64 when CompressionStream exists)
// ---------------------------------------------------------------------------
const HAS_Z = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

async function deflate(text, S) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate'));
    return S.toBase64(await new Response(stream).arrayBuffer());
}

async function inflate(b64, S) {
    const bytes = new Uint8Array(S.fromBase64(b64));
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    const decoder = new TextDecoder();
    let out = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
        if (out.length > MAX_DECODED_CHARS) { try { reader.cancel(); } catch (_) { } throw new Error('remote section too large'); }
    }
    return out + decoder.decode();
}

function splitChunks(sec, body) {
    const out = [];
    let i = 0;
    while (i < body.length) {
        const key = `${PREFIX}${sec}_${out.length}`;
        let len = Math.min(body.length - i, ITEM_BUDGET);
        let piece;
        for (;;) {
            let end = i + len;
            // Never split a surrogate pair across two items.
            if (end < body.length && end > i + 1) {
                const c = body.charCodeAt(end);
                if (c >= 0xdc00 && c <= 0xdfff) end--;
            }
            piece = body.slice(i, end);
            if (itemBytes(key, piece) <= ITEM_BUDGET || len <= 8) break;
            len = Math.floor(len * 0.85);
        }
        out.push(piece);
        i += piece.length;
    }
    return out;
}

async function encodeSection(sec, payload, S) {
    const json = canon(payload);
    const h = hash(json);
    let e = 'j';
    let body = json;
    if (HAS_Z && json.length > 512) {
        try { body = await deflate(json, S); e = 'z'; } catch (_) { body = json; e = 'j'; }
    }
    const chunks = splitChunks(sec, body);
    const bytes = chunks.reduce((n, c, i) => n + itemBytes(`${PREFIX}${sec}_${i}`, c), 0);
    return { e, h, chunks, bytes };
}

// ---------------------------------------------------------------------------
// Validation of remote data (another device's, possibly corrupt or from a newer build)
// ---------------------------------------------------------------------------
function parseMeta(m) {
    if (!isObj(m) || !Number.isInteger(m.v) || m.v < 1) return null;
    if (m.v > VERSION) return { v: m.v, newer: true };
    const s = {};
    let total = 0;
    for (const sec of SECTIONS) {
        const e = isObj(m.s) ? m.s[sec] : null;
        if (!isObj(e)) continue;
        if (!Number.isInteger(e.n) || e.n < 1 || e.n > MAX_CHUNKS_PER_SECTION) continue;
        if (typeof e.h !== 'string' || e.h.length > 20 || (e.e !== 'j' && e.e !== 'z')) continue;
        s[sec] = { n: e.n, h: e.h, e: e.e };
        total += e.n;
    }
    if (total > 500) return null;
    return { v: m.v, dev: str(m.dev, 64), at: fin(m.at) ? m.at : 0, s };
}

function sanitizeHistEntry(a) {
    if (!Array.isArray(a) || a.length < 8) return null;
    const [k, url, page, title, t, d, done, updatedAt, subOffset, loopA, loopB] = a;
    if (typeof k !== 'string' || !KEY_RE.test(k) || !httpUrl(url) || !fin(updatedAt) || updatedAt <= 0) return null;
    const num = (n, lo, hi) => (fin(n) && n >= lo && n <= hi ? n : null);
    return [
        k, url, httpUrl(page), str(title, 200),
        num(t, 0, 1e7) ?? 0, num(d, 0, 1e7) ?? 0, done ? 1 : 0, updatedAt,
        num(subOffset, -1e4, 1e4) ?? 0, num(loopA, 0, 1e7), num(loopB, 0, 1e7)
    ];
}

function sanitizeTimes(m, max) {
    const out = {};
    if (!isObj(m)) return out;
    for (const [k, t] of Object.entries(m)) if (KEY_RE.test(k) && fin(t) && t >= 0) out[k] = t;
    return capTimes(out, max);
}

function sanitizeBookmarkList(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const b of list) {
        if (out.length >= BM_MAX) break;
        const t = Array.isArray(b) ? b[0] : (isObj(b) ? b.t : null);
        const label = Array.isArray(b) ? b[1] : (isObj(b) ? b.label : '');
        if (!fin(t) || t < 0 || t > 1e7) continue;
        out.push([round1(t), str(label == null ? '' : String(label), 120)]);
    }
    return out;
}

// Same limits as popup/js/library.js (sanitizeLibrary).
const COL_ID_RE = /^[\w-]{1,40}$/;
const LIB_FAV_MAX = 500;
const LIB_COL_MAX = 50;
const LIB_KEYS_MAX = 500;
const LIB_NAME_MAX = 60;

function cleanKeyList(arr, max) {
    if (!Array.isArray(arr)) return [];
    return [...new Set(arr.filter(k => typeof k === 'string' && KEY_RE.test(k)))].slice(0, max);
}

function sanitizeCollection(id, c) {
    if (!COL_ID_RE.test(id) || !isObj(c)) return null;
    const n = str(c.n, LIB_NAME_MAX).trim();
    if (!n) return null;
    return { n, k: cleanKeyList(c.k, LIB_KEYS_MAX), c: fin(c.c) ? c.c : 0, at: fin(c.at) && c.at >= 0 ? c.at : 0 };
}

/** Library "synced view": {fav:{key:addedAt}, fd:{key:removedAt}, col:{id:{n,k,c,at}}, cd:{id:deletedAt}}. */
function normalizeLibView(p) {
    const v = { fav: sanitizeTimes(isObj(p) ? p.fav : null, LIB_FAV_MAX), fd: sanitizeTimes(isObj(p) ? p.fd : null, TOMB_MAX), col: {}, cd: {} };
    if (!isObj(p)) return v;
    if (isObj(p.col)) {
        for (const [id, c] of Object.entries(p.col).slice(0, LIB_COL_MAX * 2)) {
            const clean = sanitizeCollection(id, c);
            if (clean) v.col[id] = clean;
        }
    }
    const cd = {};
    if (isObj(p.cd)) for (const [id, t] of Object.entries(p.cd)) if (COL_ID_RE.test(id) && fin(t) && t >= 0) cd[id] = t;
    v.cd = capTimes(cd, TOMB_MAX);
    return v;
}

const SANITIZE = {
    set(p, S) {
        if (!isObj(p) || !isObj(p.d)) return null;
        return { at: fin(p.at) && p.at >= 0 ? p.at : 0, d: syncedSubset(S.mergeSettings(p.d)) };
    },
    hist(p) {
        if (!isObj(p) || !Array.isArray(p.e)) return null;
        const seen = new Set();
        const e = [];
        for (const raw of p.e.slice(0, HISTORY_SYNC_MAX * 2)) {
            const x = sanitizeHistEntry(raw);
            if (x && !seen.has(x[0])) { seen.add(x[0]); e.push(x); }
        }
        return { e, x: sanitizeTimes(p.x, TOMB_MAX), c: fin(p.c) && p.c >= 0 ? p.c : 0 };
    },
    bm(p) {
        if (!isObj(p)) return null;
        const out = {};
        for (const [k, v] of Object.entries(p).slice(0, HISTORY_SYNC_MAX * 2)) {
            if (!KEY_RE.test(k) || !Array.isArray(v) || !fin(v[0])) continue;
            const list = sanitizeBookmarkList(v[1]);
            if (list) out[k] = [v[0], list];
        }
        return out;
    },
    lib(p) {
        return isObj(p) ? normalizeLibView(p) : null;
    }
};

// ---------------------------------------------------------------------------
// Settings subset
// ---------------------------------------------------------------------------
function syncedSubset(merged) {
    const o = clone(merged) || {};
    for (const p of DEVICE_SPECIFIC_SETTINGS) setPath(o, p, undefined);
    return o;
}

// ---------------------------------------------------------------------------
// History / bookmark / library compact forms
// ---------------------------------------------------------------------------
function compactEntry(k, e) {
    if (!KEY_RE.test(k) || !isObj(e) || !httpUrl(e.url) || !fin(e.updatedAt)) return null;
    return sanitizeHistEntry([
        k, e.url, e.page, e.title,
        fin(e.t) ? round1(e.t) : 0, fin(e.d) ? round1(e.d) : 0, e.done ? 1 : 0, e.updatedAt,
        fin(e.subOffset) ? round1(e.subOffset) : 0, fin(e.loopA) ? round1(e.loopA) : null, fin(e.loopB) ? round1(e.loopB) : null
    ]);
}

function expandEntry(a) {
    return {
        url: a[1], title: a[3], page: a[2], t: a[4], d: a[5], done: !!a[6],
        subOffset: a[8], loopA: a[9], loopB: a[10], updatedAt: a[7]
    };
}

const byNewest = (a, b) => b[7] - a[7] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** Local bookmark array -> compact [[t,label]] (same rules as remote). */
const compactBookmarks = (list) => sanitizeBookmarkList(list) || [];

function unionBookmarks(a, b) {
    const map = new Map();
    for (const [t, label] of [...a, ...b]) {
        const prev = map.get(t);
        if (prev === undefined || label > prev) map.set(t, label);
    }
    return [...map.entries()].sort((x, y) => x[0] - y[0]).slice(0, BM_MAX);
}

/** fs_library -> syncable parts (favorites / collections with valid ids, keys and names). */
function libFromLocal(raw) {
    const lib = isObj(raw) ? raw : {};
    const favorites = Array.isArray(lib.favorites) ? lib.favorites.filter(k => typeof k === 'string') : [];
    const collections = Array.isArray(lib.collections)
        ? lib.collections.filter(c => isObj(c) && typeof c.id === 'string' && COL_ID_RE.test(c.id) && str(c.name, LIB_NAME_MAX).trim())
        : [];
    return { favorites, collections };
}

/** Comparable form of a local library (what the projection below produces). */
function libShape(raw) {
    const lib = isObj(raw) ? raw : {};
    return canon({
        f: Array.isArray(lib.favorites) ? lib.favorites : [],
        c: (Array.isArray(lib.collections) ? lib.collections : []).map(c => (isObj(c) ? [c.id, c.name, c.keys, c.createdAt] : c))
    });
}

// ---------------------------------------------------------------------------
// The sync engine (one instance per initSync call)
// ---------------------------------------------------------------------------
const defaultClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id)
};

class SyncError extends Error {
    constructor(message, code) { super(message); this.code = code; }
}

function createSync(api, S, clock) {
    const local = api.storage.local;
    const syncArea = api.storage && api.storage.sync && typeof api.storage.sync.get === 'function' ? api.storage.sync : null;
    const sessionArea = api.storage && api.storage.session && typeof api.storage.session.get === 'function' ? api.storage.session : local;

    let enabled = false;
    let state = null;               // persisted STATE_KEY
    let session = { dirty: false, firstDirtyAt: 0, lastChangeAt: 0, lastPushAt: 0, writes: [], backoffUntil: 0 };
    let pushTimer = null;
    let pullTimer = null;
    let chain = Promise.resolve();
    let status = null;
    const loggedErrors = new Set();
    const expectedLocal = new Map(); // key -> {h, at}: writes made by this module
    const expectedSync = new Map();
    const recentSyncKeys = new Map(); // history key -> time our merge wrote it (see onLocalChange)
    const recentLibKeys = new Map();  // favorite / collection member keys our projection just added

    // ---- infrastructure ---------------------------------------------------
    function queue(fn) {
        const p = chain.then(fn);
        chain = p.catch(handleError);
        return p;
    }

    function handleError(err) {
        const msg = String((err && err.message) || err || 'unknown error').slice(0, 300);
        if (!loggedErrors.has(msg)) {
            loggedErrors.add(msg);
            console.warn('[Velostream] Sync:', msg);
        }
        const now = clock.now();
        session.backoffKind = /quota|MAX_WRITE_OPERATIONS|MAX_ITEMS/i.test(msg) ? 'quota' : 'error';
        if (/MAX_WRITE_OPERATIONS_PER_HOUR/i.test(msg)) session.backoffUntil = now + HOURLY_BACKOFF_MS;
        else if (/quota|MAX_WRITE_OPERATIONS|MAX_ITEMS/i.test(msg)) session.backoffUntil = now + QUOTA_BACKOFF_MS;
        else session.backoffUntil = Math.max(session.backoffUntil || 0, now + ERROR_BACKOFF_MS);
        setStatus('error', msg).catch(() => { });
        if (session.dirty && enabled) schedulePush();
    }

    async function setStatus(st, error) {
        const now = clock.now();
        const next = { state: st, lastSyncAt: status ? status.lastSyncAt || 0 : 0, error: error || null };
        if (st === 'ok') next.lastSyncAt = now;
        if (status && status.state === next.state && status.error === next.error && (st !== 'ok' || now - (status.lastSyncAt || 0) < 60000)) return;
        status = next;
        try { await local.set({ [STATUS_KEY]: next }); } catch (_) { }
    }

    async function loadState() {
        let raw = null;
        try { raw = (await local.get(STATE_KEY))[STATE_KEY]; } catch (_) { }
        const s = isObj(raw) ? raw : {};
        state = {
            dev: typeof s.dev === 'string' && s.dev ? s.dev.slice(0, 64) : newDeviceId(),
            setAt: fin(s.setAt) ? s.setAt : 0,
            setHash: typeof s.setHash === 'string' ? s.setHash : '',
            bmAt: isObj(s.bmAt) ? sanitizeTimes(s.bmAt, 1000) : {},
            histDel: isObj(s.histDel) ? sanitizeTimes(s.histDel, TOMB_MAX) : {},
            histCut: fin(s.histCut) && s.histCut >= 0 ? s.histCut : 0,
            lib: isObj(s.lib) ? normalizeLibView(s.lib) : null
        };
        if (!s.dev) await saveState();
        try {
            const ss = (await sessionArea.get(SESSION_KEY))[SESSION_KEY];
            if (isObj(ss)) {
                session = {
                    dirty: !!ss.dirty,
                    firstDirtyAt: fin(ss.firstDirtyAt) ? ss.firstDirtyAt : 0,
                    lastChangeAt: fin(ss.lastChangeAt) ? ss.lastChangeAt : 0,
                    lastPushAt: fin(ss.lastPushAt) ? ss.lastPushAt : 0,
                    writes: Array.isArray(ss.writes) ? ss.writes.filter(fin).slice(-WRITES_PER_HOUR_CAP) : [],
                    backoffUntil: fin(ss.backoffUntil) ? ss.backoffUntil : 0,
                    backoffKind: ss.backoffKind === 'quota' ? 'quota' : 'error'
                };
            }
        } catch (_) { }
        try { status = (await local.get(STATUS_KEY))[STATUS_KEY] || null; } catch (_) { }
    }

    function newDeviceId() {
        try { if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) { }
        return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }

    async function saveState() {
        try { await local.set({ [STATE_KEY]: state }); } catch (_) { }
    }

    async function saveSession() {
        try { await sessionArea.set({ [SESSION_KEY]: session }); } catch (_) { }
    }

    /** Write to storage.local, remembering the values so our own onChanged echo is ignored. */
    async function writeLocal(obj) {
        const now = clock.now();
        for (const [k, v] of Object.entries(obj)) expectedLocal.set(k, { h: hashOf(v), at: now });
        await local.set(obj);
    }

    function isExpected(map, key, value) {
        const exp = map.get(key);
        if (!exp) return false;
        map.delete(key);
        return exp.h === hashOf(value === undefined ? null : value) && clock.now() - exp.at < 60000;
    }

    // ---- rate limiting ----------------------------------------------------
    function writeAllowedAt(ops, ignoreBackoff) {
        const now = clock.now();
        session.writes = session.writes.filter(t => now - t < 3600000);
        const lastMin = session.writes.filter(t => now - t < 60000);
        let at = now;
        if (lastMin.length + ops > WRITES_PER_MIN_CAP) at = Math.max(at, lastMin[lastMin.length + ops - WRITES_PER_MIN_CAP - 1] + 60000);
        if (session.writes.length + ops > WRITES_PER_HOUR_CAP) at = Math.max(at, session.writes[session.writes.length + ops - WRITES_PER_HOUR_CAP - 1] + 3600000);
        return ignoreBackoff ? at : Math.max(at, session.backoffUntil || 0);
    }

    function recordWrites(n) {
        const now = clock.now();
        for (let i = 0; i < n; i++) session.writes.push(now);
    }

    // ---- scheduling -------------------------------------------------------
    function markDirty(immediate) {
        const now = clock.now();
        const wasDirty = session.dirty;
        session.dirty = true;
        if (!session.firstDirtyAt || immediate) session.firstDirtyAt = immediate ? now - MAX_WAIT_MS : now;
        session.lastChangeAt = immediate ? 0 : now;
        if (!wasDirty || immediate) saveSession();
        schedulePush();
    }

    function schedulePush() {
        if (!enabled || !syncArea) return;
        const now = clock.now();
        let due = Math.min(session.lastChangeAt + DEBOUNCE_MS, session.firstDirtyAt + MAX_WAIT_MS);
        due = Math.max(due, session.lastPushAt + MIN_SPACING_MS, writeAllowedAt(2));
        if (pushTimer) clock.clearTimeout(pushTimer);
        pushTimer = clock.setTimeout(() => {
            pushTimer = null;
            queue(() => push(false));
        }, Math.max(0, due - now));
    }

    function schedulePull() {
        if (pullTimer) clock.clearTimeout(pullTimer);
        pullTimer = clock.setTimeout(() => {
            pullTimer = null;
            queue(async () => {
                await pull();
                // Converged data makes the following push a read-only no-op.
                markDirty(false);
            });
        }, PULL_DEBOUNCE_MS);
    }

    // ---- reading local ----------------------------------------------------
    async function readLocal() {
        const all = (await local.get(null)) || {};
        return all;
    }

    // ---- decoding remote --------------------------------------------------
    async function decodeSection(remote, meta, sec) {
        const m = meta.s[sec];
        if (!m) return { status: 'absent' };
        const parts = [];
        for (let i = 0; i < m.n; i++) {
            const c = remote[`${PREFIX}${sec}_${i}`];
            if (typeof c !== 'string') return { status: 'incomplete', meta: m };
            parts.push(c);
        }
        let json = parts.join('');
        if (m.e === 'z') {
            if (!HAS_Z) throw new SyncError('Synced data is compressed but this browser cannot decompress it.', 'unsupported');
            try { json = await inflate(json, S); } catch (_) { return { status: 'incomplete', meta: m }; }
        }
        if (json.length > MAX_DECODED_CHARS || hash(json) !== m.h) return { status: 'incomplete', meta: m };
        let payload;
        try { payload = JSON.parse(json); } catch (_) { return { status: 'corrupt', meta: m }; }
        const data = SANITIZE[sec](payload, S);
        if (!data) return { status: 'corrupt', meta: m };
        return { status: 'ok', meta: m, data };
    }

    // ---- merge ------------------------------------------------------------
    /** Merge a remote snapshot into storage.local. Returns the decoded sections. */
    async function mergeRemote(remote) {
        const meta = parseMeta(remote[META_KEY]);
        if (!meta) return { meta: null, sections: {} };
        if (meta.newer) throw new SyncError('Synced data comes from a newer Velostream. Update this device to keep syncing.', 'newer');
        const sections = {};
        for (const sec of SECTIONS) sections[sec] = await decodeSection(remote, meta, sec);

        const all = await readLocal();
        const writes = {};
        let stateChanged = false;

        // Settings: last writer wins.
        const rs = sections.set;
        if (rs.status === 'ok') {
            const localSubset = syncedSubset(S.mergeSettings(all[S.SETTINGS_KEY]));
            const lh = hashOf(localSubset);
            const rh = hashOf(rs.data.d);
            if (rs.data.at > state.setAt || state.setAt === 0) {
                if (lh !== rh) {
                    const localRaw = isObj(all[S.SETTINGS_KEY]) ? all[S.SETTINGS_KEY] : {};
                    writes[S.SETTINGS_KEY] = applyRemoteSettings(localRaw, rs.data.d);
                }
                state.setAt = rs.data.at;
                state.setHash = hashOf(syncedSubset(S.mergeSettings(writes[S.SETTINGS_KEY] || all[S.SETTINGS_KEY])));
                stateChanged = true;
            }
        }

        // History: per entry newest wins, union, tombstones.
        const rh = sections.hist;
        if (rh.status === 'ok') {
            const tomb = capTimes(maxTimes(state.histDel, rh.data.x), TOMB_MAX);
            if (canon(tomb) !== canon(state.histDel)) { state.histDel = tomb; stateChanged = true; }
            if (rh.data.c > state.histCut) { state.histCut = rh.data.c; stateChanged = true; }
            const localHist = isObj(all[S.HISTORY_KEY]) ? all[S.HISTORY_KEY] : {};
            const merged = { ...localHist };
            for (const r of rh.data.e) {
                const k = r[0];
                const cur = localHist[k];
                const lc = cur ? compactEntry(k, cur) : null;
                if (lc && canon(lc) === canon(r)) continue;
                if (!cur || !lc || r[7] > lc[7] || (r[7] === lc[7] && canon(r) > canon(lc))) {
                    merged[k] = expandEntry(r);
                    recentSyncKeys.set(k, clock.now());
                }
            }
            for (const [k, t] of Object.entries(tomb)) {
                if (merged[k] && !(fin(merged[k].updatedAt) && merged[k].updatedAt > t)) delete merged[k];
            }
            const keys = Object.keys(merged);
            if (keys.length > HISTORY_LOCAL_MAX) {
                keys.sort((a, b) => ((merged[b].updatedAt || 0) - (merged[a].updatedAt || 0)) || (a < b ? -1 : 1))
                    .slice(HISTORY_LOCAL_MAX).forEach(k => delete merged[k]);
            }
            if (canon(merged) !== canon(localHist)) writes[S.HISTORY_KEY] = merged;
        }

        // Bookmarks: newest change wins; union by t when a side has no recorded change time.
        const rb = sections.bm;
        if (rb.status === 'ok') {
            for (const [k, [rat, rlist]] of Object.entries(rb.data)) {
                const lkey = BM_PREFIX + k;
                const lraw = all[lkey];
                const llist = compactBookmarks(lraw);
                const lat = state.bmAt[k] || 0;
                let list, at;
                if (lat > 0 && rat > 0 && lat !== rat) {
                    [list, at] = lat > rat ? [llist, lat] : [rlist, rat];
                } else {
                    list = unionBookmarks(llist, rlist);
                    at = Math.max(lat, rat);
                }
                if (canon(list) !== canon(llist) || (lraw === undefined && list.length)) {
                    writes[lkey] = list.map(([t, label]) => ({ t, label }));
                }
                if (at && state.bmAt[k] !== at) { state.bmAt[k] = at; stateChanged = true; }
            }
        }

        // Library: per item change time vs tombstone time.
        const rl = sections.lib;
        if (rl.status === 'ok') {
            const before = canon(ensureLibView(all[LIBRARY_KEY]));
            state.lib = joinLibViews(state.lib, rl.data);
            if (canon(state.lib) !== before) stateChanged = true;
            const hist = writes[S.HISTORY_KEY] || (isObj(all[S.HISTORY_KEY]) ? all[S.HISTORY_KEY] : {});
            const next = projectLibrary(all[LIBRARY_KEY], state.lib, hist);
            if (next) {
                writes[LIBRARY_KEY] = next;
                const t = clock.now();
                const prev = libFromLocal(all[LIBRARY_KEY]);
                const had = new Set([...prev.favorites, ...prev.collections.flatMap(c => (Array.isArray(c.keys) ? c.keys : []))]);
                for (const k of next.favorites) if (!had.has(k)) recentLibKeys.set(k, t);
                for (const c of next.collections) if (isObj(c) && Array.isArray(c.keys)) c.keys.forEach(k => { if (!had.has(k)) recentLibKeys.set(k, t); });
            }
        }

        if (Object.keys(writes).length) await writeLocal(writes);
        if (stateChanged) {
            state.bmAt = capTimes(state.bmAt, 1000);
            await saveState();
        }
        return { meta, sections };
    }

    function applyRemoteSettings(localRaw, remoteSubset) {
        const localM = S.mergeSettings(localRaw);
        const out = clone(S.mergeSettings(remoteSubset));
        for (const p of DEVICE_SPECIFIC_SETTINGS) setPath(out, p, clone(getPath(localM, p)));
        const final = S.mergeSettings(out);
        final.syncEnabled = localRaw.syncEnabled === true;
        return final;
    }

    // ---- library ------------------------------------------------------------
    // The library page prunes favorites / collection members that have no local history entry, so a
    // device holding only part of the history would otherwise look like it deleted them. The synced
    // state therefore lives in state.lib (a "view"); fs_library is a projection of it onto the local
    // history. Only explicit removals (the video still has a history entry or a history tombstone)
    // become tombstones; prunes are ignored.

    /** Create state.lib from fs_library, or add local items it does not know yet (edits made while off). */
    function ensureLibView(localRaw) {
        if (!state.lib) state.lib = normalizeLibView(null);
        const v = state.lib;
        const { favorites, collections } = libFromLocal(localRaw);
        for (const k of favorites) if (KEY_RE.test(k) && !(k in v.fav) && !(k in v.fd)) v.fav[k] = 0;
        for (const c of collections) {
            if (v.col[c.id] || c.id in v.cd) continue;
            v.col[c.id] = { n: str(c.name, LIB_NAME_MAX).trim(), k: cleanKeyList(c.keys, LIB_KEYS_MAX), c: fin(c.createdAt) ? c.createdAt : 0, at: 0 };
        }
        state.lib = normalizeLibView(v);
        return state.lib;
    }

    /** Deterministic join of two views. */
    function joinLibViews(a, b) {
        const fd = capTimes(maxTimes(a.fd, b.fd), TOMB_MAX);
        const favAt = maxTimes(a.fav, b.fav);
        const fav = {};
        for (const [k, t] of Object.entries(favAt)) if (!(fd[k] >= t)) fav[k] = t;
        const cd = capTimes(maxTimes(a.cd, b.cd), TOMB_MAX);
        const col = {};
        for (const id of new Set([...Object.keys(a.col), ...Object.keys(b.col)])) {
            const x = a.col[id];
            const y = b.col[id];
            let w = x || y;
            if (x && y) w = x.at > y.at ? x : y.at > x.at ? y : (canon(x) >= canon(y) ? x : y);
            if (!(cd[id] >= w.at)) col[id] = w;
        }
        return normalizeLibView({ fav: capTimes(fav, LIB_FAV_MAX), fd, col, cd });
    }

    /** View -> fs_library for this device (only videos in the local history are shown). */
    function projectLibrary(localRaw, v, hist) {
        const live = (k) => isObj(hist[k]);
        const { favorites, collections } = libFromLocal(localRaw);
        const keep = (k) => !KEY_RE.test(k) || k in v.fav;
        const nextFav = favorites.filter(keep);
        const added = Object.keys(v.fav).filter(k => live(k) && !nextFav.includes(k))
            .sort((x, y) => v.fav[y] - v.fav[x] || (x < y ? -1 : 1));
        const favoritesOut = [...added, ...nextFav].slice(0, LIB_FAV_MAX);

        const projectKeys = (localKeys, viewKeys) => {
            const lk = Array.isArray(localKeys) ? localKeys.filter(k => typeof k === 'string') : [];
            const kept = lk.filter(k => !KEY_RE.test(k) || viewKeys.includes(k));
            return [...kept, ...viewKeys.filter(k => live(k) && !kept.includes(k))].slice(0, LIB_KEYS_MAX);
        };
        const rawCols = isObj(localRaw) && Array.isArray(localRaw.collections) ? localRaw.collections : [];
        const syncable = new Set(collections.map(c => c.id));
        const out = [];
        for (const c of rawCols) {
            if (!isObj(c) || !syncable.has(c.id)) { out.push(c); continue; } // not syncable: leave as is
            const w = v.col[c.id];
            if (!w) continue; // deleted elsewhere
            out.push({ ...c, name: w.n, keys: projectKeys(c.keys, w.k), createdAt: w.c });
        }
        Object.keys(v.col).filter(id => !syncable.has(id))
            .sort((x, y) => v.col[x].c - v.col[y].c || (x < y ? -1 : 1))
            .forEach(id => { const w = v.col[id]; out.push({ id, name: w.n, keys: projectKeys([], w.k), createdAt: w.c }); });
        const next = { ...(isObj(localRaw) ? localRaw : {}), favorites: favoritesOut, collections: out.slice(0, LIB_COL_MAX) };
        if (libShape(next) === libShape(localRaw)) return null;
        if (!isObj(localRaw) && !favoritesOut.length && !next.collections.length) return null;
        return next;
    }

    /** A local (non-sync) edit of fs_library: update the view. */
    function trackLibrary(oldRaw, newRaw, hist, now) {
        const v = ensureLibView(oldRaw);
        // A removal right after our projection added the key is a read-modify-write race, not the user.
        const explicit = (k) => (isObj(hist[k]) || k in state.histDel) && !(now - (recentLibKeys.get(k) || -Infinity) < RECENT_SYNC_MS);
        const a = libFromLocal(oldRaw);
        const b = libFromLocal(newRaw);
        for (const k of b.favorites) {
            if (KEY_RE.test(k) && !a.favorites.includes(k)) v.fav[k] = Math.max(now, (v.fd[k] || 0) + 1);
        }
        for (const k of a.favorites) {
            if (KEY_RE.test(k) && !b.favorites.includes(k) && explicit(k)) { delete v.fav[k]; v.fd[k] = now; }
        }
        const oldCols = new Map(a.collections.map(c => [c.id, c]));
        const newIds = new Set();
        for (const c of b.collections) {
            newIds.add(c.id);
            const name = str(c.name, LIB_NAME_MAX).trim();
            const vc = v.col[c.id];
            const newKeys = cleanKeyList(c.keys, LIB_KEYS_MAX);
            if (!vc) {
                v.col[c.id] = { n: name, k: newKeys, c: fin(c.createdAt) ? c.createdAt : 0, at: Math.max(now, (v.cd[c.id] || 0) + 1) };
                continue;
            }
            const oldKeys = oldCols.has(c.id) ? cleanKeyList(oldCols.get(c.id).keys, LIB_KEYS_MAX) : [];
            let keys = vc.k.slice();
            let changed = name !== vc.n;
            for (const k of newKeys) if (!oldKeys.includes(k) && !keys.includes(k)) { keys.push(k); changed = true; }
            for (const k of oldKeys) if (!newKeys.includes(k) && explicit(k) && keys.includes(k)) { keys = keys.filter(x => x !== k); changed = true; }
            if (changed) v.col[c.id] = { n: name, k: keys.slice(0, LIB_KEYS_MAX), c: vc.c, at: Math.max(now, vc.at + 1) };
        }
        for (const id of oldCols.keys()) if (!newIds.has(id) && v.col[id]) { delete v.col[id]; v.cd[id] = now; }
        state.lib = normalizeLibView(v);
    }


    // ---- building the local payloads ---------------------------------------
    async function fitList(sec, items, makePayload, budget) {
        if (!items.length) return null;
        let enc = await encodeSection(sec, makePayload(items.length), S);
        if (enc.bytes <= budget) return { enc, n: items.length };
        let lo = 0, hi = items.length - 1, best = null;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (mid === 0) { lo = 1; continue; }
            enc = await encodeSection(sec, makePayload(mid), S);
            if (enc.bytes <= budget) { best = { enc, n: mid }; lo = mid + 1; } else hi = mid - 1;
        }
        return best;
    }

    async function buildLocal(all, keep) {
        const out = {};
        let left = TOTAL_BUDGET - META_RESERVE;
        const take = (sec, enc) => { out[sec] = enc; left -= enc.bytes; };

        // Settings
        if (keep.set) take('set', keep.set);
        else {
            if (!state.setAt) { state.setAt = clock.now(); await saveState(); }
            const enc = await encodeSection('set', { at: state.setAt, d: syncedSubset(S.mergeSettings(all[S.SETTINGS_KEY])) }, S);
            if (enc.bytes <= Math.min(SET_MAX, left)) take('set', enc);
            else handleError(new Error('Settings are too large to sync.'));
        }

        // History (newest first) + tombstones
        const histObj = isObj(all[S.HISTORY_KEY]) ? all[S.HISTORY_KEY] : {};
        // Only entries newer than the shared cutoff `c` sync. When the budget (or the 200 cap) drops
        // entries, the cutoff moves up to the newest dropped one, so every device agrees on the synced
        // set even when they hold different old entries (otherwise one device keeps re-adding them).
        const all200 = Object.entries(histObj).map(([k, e]) => compactEntry(k, e)).filter(e => e && e[7] > state.histCut).sort(byNewest);
        const cand = all200.slice(0, HISTORY_SYNC_MAX);
        const x = capTimes(state.histDel, TOMB_MAX);
        const cutFor = (n) => (n < all200.length ? Math.max(state.histCut, all200[n][7]) : state.histCut);
        const trim = (n) => { const c = cutFor(n); let m = n; while (m > 0 && cand[m - 1][7] <= c) m--; return m; };
        const histPayload = (n) => ({ e: cand.slice(0, trim(n)), x, c: cutFor(n) });
        let histKeys = [];
        if (cand.length || Object.keys(x).length || state.histCut) {
            const fit = cand.length
                ? await fitList('hist', cand, histPayload, Math.min(HIST_MAX, left))
                : { enc: await encodeSection('hist', histPayload(0), S), n: 0 };
            if (fit && fit.enc.bytes <= left) {
                take('hist', fit.enc);
                histKeys = cand.slice(0, trim(fit.n)).map(e => e[0]);
                const c = cutFor(fit.n);
                if (c !== state.histCut) { state.histCut = c; await saveState(); }
            }
        }

        // Library
        const view = ensureLibView(all[LIBRARY_KEY]);
        if (Object.keys(view.fav).length || Object.keys(view.fd).length || Object.keys(view.col).length || Object.keys(view.cd).length) {
            const enc = await encodeSection('lib', view, S);
            if (enc.bytes <= Math.min(LIB_MAX, left)) take('lib', enc);
        }

        // Bookmarks of the synced videos
        const bmKeys = histKeys.filter(k => Array.isArray(all[BM_PREFIX + k]) && (all[BM_PREFIX + k].length || state.bmAt[k]));
        if (bmKeys.length && left > 200) {
            const items = bmKeys.map(k => [k, [state.bmAt[k] || 0, compactBookmarks(all[BM_PREFIX + k])]]);
            const fit = await fitList('bm', items, n => Object.fromEntries(items.slice(0, n)), left);
            if (fit) take('bm', fit.enc);
        }
        return out;
    }

    // ---- pull / push ------------------------------------------------------
    async function pull() {
        if (!enabled || !syncArea) return null;
        const remote = (await syncArea.get(null)) || {};
        const res = await mergeRemote(remote);
        await setStatus('ok', null);
        return { remote, ...res };
    }

    async function push(force) {
        if (!enabled || !syncArea) return;
        const now = clock.now();
        if (!force && (session.lastPushAt + MIN_SPACING_MS > now || writeAllowedAt(2) > now)) { schedulePush(); return; }
        if (force && writeAllowedAt(2) > now) { schedulePush(); return; }

        const pulled = await pull();
        const { remote, meta, sections } = pulled;
        const all = await readLocal();

        // Keep the remote settings unless this device changed them later.
        const keep = {};
        const rs = sections.set;
        const remoteSetUsable = rs && (rs.status === 'ok' || (rs.status === 'incomplete' && now - meta.at < INCOMPLETE_GRACE_MS));
        if (remoteSetUsable && !(rs.status === 'ok' && state.setAt > rs.data.at)) {
            const chunks = [];
            for (let i = 0; i < rs.meta.n; i++) chunks.push(remote[`${PREFIX}set_${i}`]);
            if (chunks.every(c => typeof c === 'string')) {
                keep.set = { e: rs.meta.e, h: rs.meta.h, chunks, bytes: chunks.reduce((n, c, i) => n + itemBytes(`${PREFIX}set_${i}`, c), 0) };
            }
        }

        const built = await buildLocal(all, keep);
        const nextS = {};
        const items = {};
        let retry = false;
        for (const sec of SECTIONS) {
            const b = built[sec];
            if (!b) continue;
            const r = meta && meta.s[sec];
            const rsec = sections[sec];
            // Same content already remote (maybe compressed by another engine): leave it untouched.
            if (r && r.h === b.h && rsec && rsec.status === 'ok') { nextS[sec] = r; continue; }
            // Another device's write still propagating: do not clobber it yet.
            if (rsec && rsec.status === 'incomplete' && meta && now - meta.at < INCOMPLETE_GRACE_MS && sec !== 'set') {
                nextS[sec] = r;
                retry = true;
                continue;
            }
            nextS[sec] = { n: b.chunks.length, h: b.h, e: b.e };
            b.chunks.forEach((c, i) => {
                const key = `${PREFIX}${sec}_${i}`;
                if (remote[key] !== c) items[key] = c;
            });
        }
        if (keep.set && !nextS.set) nextS.set = { n: keep.set.chunks.length, h: keep.set.h, e: keep.set.e };

        const sameMeta = meta && canon(meta.s) === canon(nextS) && parseMeta(remote[META_KEY]) && remote[META_KEY].v === VERSION;
        const wanted = new Set([META_KEY]);
        for (const [sec, m] of Object.entries(nextS)) for (let i = 0; i < m.n; i++) wanted.add(`${PREFIX}${sec}_${i}`);
        const stale = Object.keys(remote).filter(k => k.startsWith(PREFIX) && !wanted.has(k));

        const finish = async () => {
            session.dirty = false;
            session.firstDirtyAt = 0;
            await saveSession();
            await setStatus('ok', null);
            if (retry) markDirty(false);
        };
        if (!Object.keys(items).length && sameMeta && !stale.length) {
            await finish();
            return;
        }

        const newMeta = { v: VERSION, dev: state.dev, at: now, s: nextS };
        items[META_KEY] = newMeta;

        // Order: when the new items would push the total over the quota, remove stale chunks first.
        let total = 0;
        for (const [k, v] of Object.entries(remote)) total += itemBytes(k, v);
        let after = total;
        for (const [k, v] of Object.entries(items)) after += itemBytes(k, v) - (k in remote ? itemBytes(k, remote[k]) : 0);
        const removeFirst = stale.length && after > QUOTA_BYTES - 2048;

        for (const [k, v] of Object.entries(items)) expectedSync.set(k, { h: hashOf(v), at: now });
        for (const k of stale) expectedSync.set(k, { h: hashOf(null), at: now });

        const ops = 1 + (stale.length ? 1 : 0);
        recordWrites(ops);
        session.lastPushAt = now;
        try {
            if (removeFirst) await syncArea.remove(stale);
            await syncArea.set(items);
            if (stale.length && !removeFirst) await syncArea.remove(stale);
        } finally {
            await saveSession();
        }
        await finish();
    }

    // ---- local change tracking ----------------------------------------------
    async function onLocalChange(changes) {
        const now = clock.now();
        let dirty = false;
        let stateChanged = false;
        for (const [key, ch] of Object.entries(changes)) {
            if (key === S.SETTINGS_KEY) {
                // Compare the stored value (not the event's): a remote apply queued before this
                // event may already have replaced it, and that is not a local change.
                let cur = ch.newValue;
                try { cur = (await local.get(S.SETTINGS_KEY))[S.SETTINGS_KEY]; } catch (_) { }
                const h = hashOf(syncedSubset(S.mergeSettings(cur)));
                if (h !== state.setHash) {
                    state.setHash = h;
                    state.setAt = Math.max(now, state.setAt + 1);
                    stateChanged = dirty = true;
                }
            } else if (key === S.HISTORY_KEY) {
                const oldV = isObj(ch.oldValue) ? ch.oldValue : {};
                const newV = isObj(ch.newValue) ? ch.newValue : {};
                const newKeys = Object.keys(newV);
                const minKept = newKeys.reduce((m, k) => Math.min(m, fin(newV[k] && newV[k].updatedAt) ? newV[k].updatedAt : 0), Infinity);
                let lostSynced = false;
                for (const k of Object.keys(oldV)) {
                    if (k in newV || !KEY_RE.test(k)) continue;
                    const upd = fin(oldV[k] && oldV[k].updatedAt) ? oldV[k].updatedAt : 0;
                    // Eviction of the oldest entries past the 200 cap is not a deletion.
                    if (newKeys.length >= HISTORY_LOCAL_MAX && upd <= minKept) continue;
                    // An entry our merge just added that vanished is most likely a read-modify-write
                    // race with the player (stale read), not a user deletion: fetch it again instead.
                    if (now - (recentSyncKeys.get(k) || -Infinity) < RECENT_SYNC_MS) { lostSynced = true; continue; }
                    state.histDel[k] = Math.max(now, upd + 1);
                    stateChanged = true;
                }
                if (lostSynced) schedulePull();
                if (stateChanged) state.histDel = capTimes(state.histDel, TOMB_MAX);
                dirty = true;
            } else if (key === LIBRARY_KEY) {
                let hist = {};
                try { hist = (await local.get(S.HISTORY_KEY))[S.HISTORY_KEY] || {}; } catch (_) { }
                trackLibrary(ch.oldValue, ch.newValue, isObj(hist) ? hist : {}, now);
                stateChanged = dirty = true;
            } else if (key.startsWith(BM_PREFIX)) {
                const k = key.slice(BM_PREFIX.length);
                if (!KEY_RE.test(k)) continue;
                state.bmAt[k] = Math.max(now, (state.bmAt[k] || 0) + 1);
                stateChanged = dirty = true;
            }
        }
        if (stateChanged) await saveState();
        if (dirty) markDirty(false);
    }

    const TRACKED = (key) => key === S.SETTINGS_KEY || key === S.HISTORY_KEY || key === LIBRARY_KEY || key.startsWith(BM_PREFIX);

    function onStorageChanged(changes, area) {
        try {
            if (area === 'local') {
                if (changes[S.SETTINGS_KEY]) {
                    const on = isObj(changes[S.SETTINGS_KEY].newValue) && changes[S.SETTINGS_KEY].newValue.syncEnabled === true;
                    if (on !== enabled) {
                        if (on) start(true); else stop();
                    }
                }
                if (!enabled || !state) return;
                const foreign = {};
                for (const [k, ch] of Object.entries(changes)) {
                    if (!TRACKED(k)) continue;
                    if (isExpected(expectedLocal, k, ch.newValue)) continue;
                    foreign[k] = ch;
                }
                if (Object.keys(foreign).length) queue(() => onLocalChange(foreign));
            } else if (area === 'sync') {
                if (!enabled || !state) return;
                let foreign = false;
                for (const [k, ch] of Object.entries(changes)) {
                    if (!k.startsWith(PREFIX)) continue;
                    if (isExpected(expectedSync, k, ch.newValue)) continue;
                    foreign = true;
                }
                if (foreign) {
                    // New remote data: retry soon after a non-quota error (e.g. newer-version data was replaced).
                    if (session.backoffKind !== 'quota') session.backoffUntil = 0;
                    schedulePull();
                }
            }
        } catch (err) {
            handleError(err);
        }
    }

    // ---- lifecycle ----------------------------------------------------------
    function start(fromToggle) {
        enabled = true;
        if (!syncArea) {
            setStatus('error', 'Sync storage is not available in this browser.');
            return;
        }
        queue(async () => {
            if (!enabled) return;
            await pull();
            // Turning sync on pushes right away; a wake-up only checks (and writes if anything differs).
            markDirty(!!fromToggle);
        });
    }

    function stop() {
        enabled = false;
        if (pushTimer) { clock.clearTimeout(pushTimer); pushTimer = null; }
        if (pullTimer) { clock.clearTimeout(pullTimer); pullTimer = null; }
        queue(async () => {
            session.dirty = false;
            session.firstDirtyAt = 0;
            await saveSession();
            await setStatus('off', null);
        });
    }

    async function init() {
        await loadState();
        let raw = null;
        try { raw = (await local.get(S.SETTINGS_KEY))[S.SETTINGS_KEY]; } catch (_) { }
        if (!state.setHash) {
            state.setHash = hashOf(syncedSubset(S.mergeSettings(raw)));
            await saveState();
        }
        if (isObj(raw) && raw.syncEnabled === true) start(false);
        else if (!status || status.state !== 'off') await setStatus('off', null);
    }

    function onMessage(message, sender, sendResponse) {
        if (!message || (message.action !== 'SYNC_NOW' && message.action !== 'SYNC_CLEAR')) return false;
        // Only extension pages (popup / options / player), not content scripts in web pages.
        if (sender && (sender.id !== api.runtime.id || (sender.tab && !(sender.url || '').startsWith(api.runtime.getURL(''))))) return false;
        const work = message.action === 'SYNC_NOW' ? syncNow() : clearSync();
        work.then(() => sendResponse({ ok: true, status }), err => sendResponse({ ok: false, error: String((err && err.message) || err), status }));
        return true;
    }

    /** Pull + push now (still subject to the write-rate caps). */
    function syncNow() {
        if (!enabled) return Promise.resolve();
        return queue(() => push(true));
    }

    /** Delete every vs_* key from storage.sync (other devices keep their local data). */
    function clearSync() {
        if (!syncArea) return Promise.resolve();
        return queue(async () => {
            const remote = (await syncArea.get(null)) || {};
            const keys = Object.keys(remote).filter(k => k.startsWith(PREFIX));
            if (!keys.length) return;
            if (writeAllowedAt(1, true) > clock.now()) throw new Error('Too many sync writes; try again in a minute.');
            for (const k of keys) expectedSync.set(k, { h: hashOf(null), at: clock.now() });
            recordWrites(1);
            await syncArea.remove(keys);
            await saveSession();
        });
    }

    async function whenIdle() {
        let c;
        do { c = chain; await c; } while (c !== chain);
    }

    return { init, onStorageChanged, onMessage, syncNow, clearSync, whenIdle, getStatus: () => status };
}

/**
 * Start the sync module. Safe to call once per background start; never throws.
 * @param {{api: object, S: object, clock?: object}} deps  api = chrome/browser namespace,
 *        S = globalThis.VelostreamShared, clock = test hook ({now, setTimeout, clearTimeout}).
 */
export function initSync({ api, S, clock } = {}) {
    const noop = { syncNow: () => Promise.resolve(), clearSync: () => Promise.resolve(), getStatus: () => null, whenIdle: () => Promise.resolve(), ready: Promise.resolve() };
    try {
        if (!api || !api.storage || !api.storage.local || !S) return noop;
        const ctl = createSync(api, S, clock || defaultClock);
        api.storage.onChanged.addListener(ctl.onStorageChanged);
        if (api.runtime && api.runtime.onMessage) api.runtime.onMessage.addListener(ctl.onMessage);
        const ready = ctl.init().catch(err => { console.warn('[Velostream] Sync init failed:', err); });
        return { syncNow: ctl.syncNow, clearSync: ctl.clearSync, getStatus: ctl.getStatus, whenIdle: ctl.whenIdle, ready };
    } catch (err) {
        console.warn('[Velostream] Sync init failed:', err);
        return noop;
    }
}
