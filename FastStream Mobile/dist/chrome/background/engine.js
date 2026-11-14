/**
 * FastStream Mobile - Background Engine
 *
 * Control plane for stream detection, player launch, network proxying, prefetching, ABR,
 * telemetry and lifecycle. Runs as an MV3 service worker (Chromium) or event page (Firefox).
 *
 *   player-overlay.js (MAIN, top frame)
 *        ⇅ MessagePort (ArrayBuffers transferred)
 *   sniffer.js (ISOLATED, top frame)  ── runtime port "faststream-player" ──>  engine.js
 *                                                                               │
 *   sniffer.js (ISOLATED, frame that owns the stream)  <── FETCH_PROXY {frameId} ┘
 *        ⇅ window.postMessage (transfer)
 *   interceptor.js (MAIN, same frame: page cookies, Referer, CORS context)
 */

import '../common/shared.js';
import { BufferManager, sweepOrphans } from './buffer-manager.js';
import { SegmentDownloader } from './downloader.js';
import { ABRController } from './abr-controller.js';
import { parsePlaylist, ivForSegment, decryptAes128 } from './hls-parser.js';

const S = globalThis.FastStreamShared;
const api = S.api;

const MAX_STREAMS_PER_TAB = 40;
const PROXY_TIMEOUT_MS = 60000;
const RECONNECT_GRACE_MS = 20000;
const ICONS_IDLE = { 16: '/icons/icon-16.png', 48: '/icons/icon-48.png', 128: '/icons/icon-128.png' };
const ICONS_ACTIVE = { 16: '/icons/icon-active-16.png', 48: '/icons/icon-active-48.png', 128: '/icons/icon-active-128.png' };

// ============================================================================
// SETTINGS
// ============================================================================
let settings = S.mergeSettings(null);
const settingsReady = api.storage.local.get(S.SETTINGS_KEY).then(res => {
    settings = S.mergeSettings(res[S.SETTINGS_KEY]);
}).catch(() => { /* defaults */ });

api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[S.SETTINGS_KEY]) return;
    settings = S.mergeSettings(changes[S.SETTINGS_KEY].newValue);
    for (const session of sessions.values()) {
        session.buffer.setCapacity(settings.cacheSizeMB);
        session.abr.setMaxHeight(session.qualityCap ?? settings.qualityCap);
        session.downloader.schedulePump();
    }
});

// ============================================================================
// TAB / STREAM STATE (multiple streams per tab, deduplicated by normalized URL)
// ============================================================================
/** @type {Map<number, {tabId:number, streams:Map<string,object>, byUrl:Map<string,string>, children:Set<string>, mseFrames:Map<number,number>, videoFrames:Set<number>, playerSessionId:string|null, probing:number}>} */
const tabs = new Map();
const sessions = new Map(); // sessionId -> Session
const persistTimers = new Map();

function newTabState(tabId) {
    return {
        tabId,
        streams: new Map(),
        byUrl: new Map(),
        children: new Set(),       // variant/rendition playlists of a known master (hidden in popup)
        mseFrames: new Map(),      // frameId -> last MSE_INIT timestamp
        videoFrames: new Set(),    // frames with a <video> element
        playerSessionId: null,
        probing: 0
    };
}

async function getTab(tabId, { create = true } = {}) {
    let tab = tabs.get(tabId);
    if (tab) return tab;
    // Restore after a service-worker / event-page restart.
    const key = `tab_${tabId}`;
    const stored = (await api.storage.session.get(key).catch(() => ({})))[key];
    tab = tabs.get(tabId); // re-check after await
    if (tab) return tab;
    if (!stored && !create) return null;
    tab = newTabState(tabId);
    if (stored) {
        for (const s of stored.streams || []) {
            tab.streams.set(s.id, s);
            tab.byUrl.set(s.url, s.id);
        }
        (stored.children || []).forEach(u => tab.children.add(u));
        tab.playerSessionId = stored.playerSessionId || null;
    }
    tabs.set(tabId, tab);
    return tab;
}

function persistTab(tabId) {
    clearTimeout(persistTimers.get(tabId));
    persistTimers.set(tabId, setTimeout(() => {
        persistTimers.delete(tabId);
        const tab = tabs.get(tabId);
        if (!tab) return;
        api.storage.session.set({
            [`tab_${tabId}`]: {
                streams: [...tab.streams.values()],
                children: [...tab.children].slice(-200),
                playerSessionId: tab.playerSessionId
            }
        }).catch(() => { /* quota / unsupported */ });
    }, 250));
}

function visibleStreams(tab) {
    const list = [...tab.streams.values()].filter(s => !tab.children.has(s.url));
    const score = s => {
        let v = 0;
        if (s.probe && s.probe.isMaster) v += 4;
        if (s.type === 'hls' || s.type === 'dash') v += 2;
        if (tab.mseFrames.has(s.frameId) || tab.videoFrames.has(s.frameId)) v += 2;
        if (s.isAd) v -= 6;
        if (s.probe && s.probe.error) v -= 1;
        return v;
    };
    return list.sort((a, b) => score(b) - score(a) || b.detectedAt - a.detectedAt);
}

async function updateIcon(tabId) {
    const tab = tabs.get(tabId);
    const count = tab ? visibleStreams(tab).length : 0;
    try {
        await api.action.setIcon({ tabId, path: count ? ICONS_ACTIVE : ICONS_IDLE });
        await api.action.setBadgeText({ tabId, text: count ? String(Math.min(count, 99)) : '' });
        if (count) await api.action.setBadgeBackgroundColor({ tabId, color: '#0B6E4F' });
    } catch (_) { /* tab closed */ }
}

// ----------------------------------------------------------------------------
// On-page quick-launch badge: tell every frame how many playable streams exist,
// which frames own a <video>, and whether the player is already open.
// ----------------------------------------------------------------------------
const notifyTimers = new Map();
function notifyFrames(tabId) {
    clearTimeout(notifyTimers.get(tabId));
    notifyTimers.set(tabId, setTimeout(() => {
        notifyTimers.delete(tabId);
        const tab = tabs.get(tabId);
        const list = tab ? visibleStreams(tab).filter(s => !s.isAd) : [];
        const best = list[0];
        api.tabs.sendMessage(tabId, {
            action: 'STREAMS_AVAILABLE',
            count: list.length,
            playerOpen: !!(tab && tab.playerSessionId && sessions.has(tab.playerSessionId)),
            videoFrames: tab ? [...tab.videoFrames] : [],
            label: best && best.probe && best.probe.maxHeight ? `${best.probe.maxHeight}p` : (best ? ({ hls: 'HLS', dash: 'DASH', progressive: 'MP4' }[best.type]) : '')
        }).catch(() => { /* no content script (restricted page) */ });
    }, 300));
}

async function handleDetection(tabId, frameId, frameUrl, payload) {
    if (tabId === undefined || tabId < 0 || !payload) return null;
    const tab = await getTab(tabId);

    if (payload.type === 'mse') {
        tab.mseFrames.set(frameId, Date.now());
        return null;
    }
    if (payload.type === 'video-present') {
        if (!tab.videoFrames.has(frameId)) {
            tab.videoFrames.add(frameId);
            notifyFrames(tabId);
        }
        return null;
    }

    const url = S.normalizeUrl(payload.url, frameUrl);
    if (!url || !/^https?:/i.test(url)) return null;
    const type = S.classifyStream(url, payload.mime) || payload.type;
    if (!['hls', 'dash', 'progressive'].includes(type)) return null;

    const existingId = tab.byUrl.get(url);
    if (existingId) {
        const existing = tab.streams.get(existingId);
        // Prefer a real frame id over an unknown (-1) one reported by webRequest for workers.
        if (existing && existing.frameId < 0 && frameId >= 0) {
            existing.frameId = frameId;
            existing.frameUrl = frameUrl || existing.frameUrl;
            persistTab(tabId);
        }
        if (existing && payload.method === 'manual') tab.children.delete(url);
        return existing || null;
    }

    if (tab.streams.size >= MAX_STREAMS_PER_TAB) {
        // Drop the oldest non-playing stream.
        const oldest = [...tab.streams.values()].sort((a, b) => a.detectedAt - b.detectedAt)
            .find(s => !tab.playerSessionId || sessions.get(tab.playerSessionId)?.stream.id !== s.id);
        if (oldest) { tab.streams.delete(oldest.id); tab.byUrl.delete(oldest.url); }
    }

    const stream = {
        id: crypto.randomUUID(),
        url,
        type,
        frameId: typeof frameId === 'number' ? frameId : 0,
        frameUrl: frameUrl || '',
        method: payload.method || 'unknown',
        mime: payload.mime || '',
        title: payload.title || '',
        detectedAt: Date.now(),
        isAd: S.looksLikeAd(url),
        probe: null
    };
    tab.streams.set(stream.id, stream);
    tab.byUrl.set(url, stream.id);
    if (payload.method === 'manual') tab.children.delete(url);
    persistTab(tabId);
    updateIcon(tabId);
    notifyFrames(tabId);
    if (type !== 'progressive') probeStream(tab, stream);
    return stream;
}

/** Sniff the first bytes of an extension-less URL to decide hls / dash / progressive. */
async function detectTypeByContent(tabId, url, frameUrl) {
    const transport = makeTransport(tabId, () => ({ frameId: 0, frameUrl }));
    const res = await transport(url, { method: 'GET', headers: { Range: 'bytes=0-2047' } });
    if (res.status >= 400) throw new Error(`The server answered HTTP ${res.status}`);
    const ct = (res.headers['content-type'] || '').toLowerCase();
    const head = new TextDecoder().decode(res.data.slice(0, 2048)).trimStart();
    if (/mpegurl/.test(ct) || head.startsWith('#EXTM3U')) return 'hls';
    if (/dash\+xml/.test(ct) || /<MPD[\s>]/i.test(head)) return 'dash';
    if (/^(video|audio)\//.test(ct) || /application\/octet-stream/.test(ct)) return 'progressive';
    throw new Error('That address does not look like a video stream (expected .m3u8, .mpd or a media file).');
}

// ============================================================================
// TRANSPORT: proxy through the owning frame (page cookies / Referer), direct fallback
// ============================================================================
const refererByHost = new Map(); // host -> {referer, origin}
const dnrRulesByHost = new Map();
let nextDnrRuleId = 1000;

function pickFrameId(tab, stream) {
    if (stream && stream.frameId >= 0) return stream.frameId;
    // Unknown frame (e.g. request issued by a worker): prefer the most recent MSE frame.
    let best = 0;
    let bestTs = 0;
    for (const [fid, ts] of tab.mseFrames) if (ts > bestTs) { best = fid; bestTs = ts; }
    return best;
}

function proxyViaFrame(tabId, frameId, url, { method = 'GET', headers = {}, signal }) {
    return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        let settled = false;
        const finish = (fn, val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            fn(val);
        };
        const onAbort = () => {
            api.tabs.sendMessage(tabId, { action: 'FETCH_ABORT', id }, { frameId }).catch(() => { });
            finish(reject, new DOMException('Aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
            api.tabs.sendMessage(tabId, { action: 'FETCH_ABORT', id }, { frameId }).catch(() => { });
            const err = new Error(`Proxy fetch timeout (${PROXY_TIMEOUT_MS}ms)`);
            err.proxyUnavailable = true;
            finish(reject, err);
        }, PROXY_TIMEOUT_MS);
        if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
        }
        api.tabs.sendMessage(tabId, { action: 'FETCH_PROXY', id, url, method, headers }, { frameId })
            .then(res => {
                if (!res) {
                    const err = new Error('No proxy in frame');
                    err.proxyUnavailable = true;
                    return finish(reject, err);
                }
                if (!res.ok) {
                    const err = new Error(res.error || 'Proxy fetch failed');
                    err.status = res.status || 0;
                    err.proxyUnavailable = !res.status; // network/CORS failure -> try direct
                    return finish(reject, err);
                }
                finish(resolve, {
                    status: res.status,
                    headers: res.headers || {},
                    url: res.url || url,
                    data: S.unpackBinary(res.data) || new ArrayBuffer(0)
                });
            })
            .catch(e => {
                const err = new Error(`Frame unreachable: ${e && e.message}`);
                err.proxyUnavailable = true;
                finish(reject, err);
            });
    });
}

const EXT_HOST = (() => { try { return new URL(api.runtime.getURL('')).hostname; } catch (_) { return ''; } })();

/**
 * Session-scoped DNR rules so requests made by the extension itself carry the site's
 * Referer/Origin: direct fallback fetches from the engine (no tab) and media requests the
 * player page makes (e.g. a progressive MP4 in <video src>, initiated by the extension origin).
 * Many CDNs reject hot-linked media without the right Referer.
 */
async function ensureRefererRule(url, frameUrl) {
    let host;
    let origin;
    try {
        host = new URL(url).hostname;
        origin = new URL(frameUrl).origin;
    } catch (_) {
        return;
    }
    if (!origin || origin === 'null' || dnrRulesByHost.has(host)) return;
    const captured = refererByHost.get(host);
    const referer = (captured && captured.referer) || frameUrl;
    const action = {
        type: 'modifyHeaders',
        requestHeaders: [
            { header: 'Referer', operation: 'set', value: referer },
            { header: 'Origin', operation: 'set', value: (captured && captured.origin) || origin }
        ]
    };
    const resourceTypes = ['xmlhttprequest', 'media', 'other'];
    const id = nextDnrRuleId;
    nextDnrRuleId += 2;
    dnrRulesByHost.set(host, id);
    const addRules = [{ id, priority: 2, action, condition: { requestDomains: [host], tabIds: [api.tabs.TAB_ID_NONE], resourceTypes } }];
    if (EXT_HOST) addRules.push({ id: id + 1, priority: 2, action, condition: { requestDomains: [host], initiatorDomains: [EXT_HOST], resourceTypes } });
    try {
        await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id, id + 1], addRules });
    } catch (e) {
        // Retry without the initiator rule (older engines reject extension initiators).
        try {
            await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id, id + 1], addRules: addRules.slice(0, 1) });
        } catch (e2) {
            dnrRulesByHost.delete(host);
            console.warn('[Engine] Could not add Referer rule:', e2 && e2.message);
        }
    }
}

/** Custom request headers the site's own player sent to this host (auth tokens etc.). */
function capturedHeaders(url) {
    try {
        const c = refererByHost.get(new URL(url).hostname);
        return (c && c.headers) || {};
    } catch (_) {
        return {};
    }
}

async function directFetch(url, { method = 'GET', headers = {}, signal }, frameUrl) {
    await ensureRefererRule(url, frameUrl);
    const h = {};
    for (const [k, v] of Object.entries(headers)) {
        if (!/^(referer|origin|cookie|host)$/i.test(k)) h[k] = v;
    }
    const res = await fetch(url, { method, headers: h, credentials: 'include', signal, cache: 'no-store' });
    const data = method === 'HEAD' ? new ArrayBuffer(0) : await res.arrayBuffer();
    const outHeaders = {};
    res.headers.forEach((v, k) => { outHeaders[k] = v; });
    return { status: res.status, headers: outHeaders, url: res.url || url, data };
}

function makeTransport(tabId, getStream) {
    return async (url, opts) => {
        const tab = await getTab(tabId);
        const stream = getStream();
        const frameId = pickFrameId(tab, stream);
        // Replay auth/token headers the site's player used for this host (Range stays ours).
        opts = { ...opts, headers: { ...capturedHeaders(url), ...(opts.headers || {}) } };
        try {
            return await proxyViaFrame(tabId, frameId, url, opts);
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            if (!err.proxyUnavailable) {
                if (err.status) return { status: err.status, headers: {}, url, data: new ArrayBuffer(0) };
                throw err;
            }
            // Frame gone or CORS refused in page context: fetch directly from the extension.
            return directFetch(url, opts, (stream && stream.frameUrl) || '');
        }
    };
}

// ============================================================================
// PROBING (stream metadata for the popup)
// ============================================================================
async function probeStream(tab, stream) {
    if (stream.probe || tab.probing >= 3) return;
    stream.probe = { status: 'pending' };
    tab.probing++;
    try {
        const transport = makeTransport(tab.tabId, () => stream);
        const res = await transport(stream.url, { method: 'GET', headers: {} });
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        const text = new TextDecoder().decode(res.data.byteLength > 2_000_000 ? res.data.slice(0, 2_000_000) : res.data);
        if (stream.type === 'hls') {
            const parsed = parsePlaylist(text, res.url || stream.url);
            if (!parsed) throw new Error('Not an M3U8 playlist');
            if (parsed.type === 'master') {
                parsed.variants.forEach(v => tab.children.add(v.uri));
                parsed.media.forEach(m => m.uri && tab.children.add(m.uri));
                const heights = parsed.variants.map(v => v.height).filter(Boolean);
                stream.probe = {
                    status: 'done',
                    isMaster: true,
                    variants: parsed.variants.length,
                    maxHeight: heights.length ? Math.max(...heights) : 0,
                    audioTracks: parsed.media.filter(m => m.type === 'AUDIO').length,
                    subtitleTracks: parsed.media.filter(m => m.type === 'SUBTITLES').length
                };
            } else {
                stream.probe = {
                    status: 'done',
                    isMaster: false,
                    duration: parsed.live ? 0 : Math.round(parsed.totalDuration),
                    live: parsed.live,
                    encrypted: parsed.encrypted,
                    segments: parsed.segments.length
                };
            }
        } else if (stream.type === 'dash') {
            const heights = [...text.matchAll(/\bheight="(\d+)"/g)].map(m => parseInt(m[1], 10));
            const dur = /mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?"/.exec(text);
            stream.probe = {
                status: 'done',
                isMaster: true,
                maxHeight: heights.length ? Math.max(...heights) : 0,
                variants: heights.length,
                live: /type="dynamic"/.test(text),
                duration: dur ? (+dur[1] || 0) * 3600 + (+dur[2] || 0) * 60 + (+dur[3] || 0) : 0
            };
        }
    } catch (e) {
        stream.probe = { status: 'error', error: String(e && e.message || e) };
    } finally {
        tab.probing--;
        persistTab(tab.tabId);
        updateIcon(tab.tabId);
        notifyFrames(tab.tabId);
    }
}

// ============================================================================
// WEBREQUEST: header capture + network-level detection (sees worker/native requests too)
// ============================================================================
function rememberReferer(details) {
    // Our own player iframe's requests come from the extension origin: never learn from those.
    if (details.tabId < 0 || (details.initiator && details.initiator.includes(EXT_HOST)) || (details.originUrl && details.originUrl.includes(EXT_HOST))) return;
    // Any data request may be an extension-less manifest; the per-host map is capped at 200.
    if (!S.classifyStream(details.url) && !['xmlhttprequest', 'media', 'other'].includes(details.type)) return;
    let host;
    try { host = new URL(details.url).hostname; } catch (_) { return; }
    const info = { headers: {} };
    // Standard / browser-controlled headers are left alone; anything else (Authorization,
    // X-Playback-Session-Id, custom token headers...) is replayed on our requests to this host.
    const STANDARD = /^(host|cookie|origin|referer|user-agent|accept(-.*)?|connection|content-(length|type)|sec-.*|range|pragma|cache-control|if-.*|dnt|upgrade-insecure-requests|priority|te|keep-alive|proxy-.*)$/i;
    for (const h of details.requestHeaders || []) {
        const n = h.name.toLowerCase();
        if (n === 'referer') info.referer = h.value;
        else if (n === 'origin') info.origin = h.value;
        else if (!STANDARD.test(n) && h.value && h.value.length < 4096) info.headers[h.name] = h.value;
    }
    if (info.referer || info.origin || Object.keys(info.headers).length) {
        refererByHost.set(host, info);
        if (refererByHost.size > 200) refererByHost.delete(refererByHost.keys().next().value);
    }
}

try {
    api.webRequest.onBeforeSendHeaders.addListener(rememberReferer, { urls: ['<all_urls>'] }, ['requestHeaders', 'extraHeaders']);
} catch (_) {
    // Firefox does not know 'extraHeaders' (and does not need it).
    api.webRequest.onBeforeSendHeaders.addListener(rememberReferer, { urls: ['<all_urls>'] }, ['requestHeaders']);
}

api.webRequest.onHeadersReceived.addListener((details) => {
    if (details.tabId < 0 || details.statusCode >= 400) return;
    const ct = ((details.responseHeaders || []).find(h => h.name.toLowerCase() === 'content-type') || {}).value || '';
    const type = S.classifyStream(details.url, ct);
    if (type !== 'hls' && type !== 'dash') return;
    handleDetection(details.tabId, details.frameId, details.documentUrl || details.initiator || '', {
        url: details.url, type, method: 'network', mime: ct
    });
}, { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] }, ['responseHeaders']);

// ============================================================================
// PLAYER SESSIONS
// ============================================================================
class Session {
    constructor({ id, tabId, stream }) {
        this.id = id;
        this.tabId = tabId;
        this.stream = stream;
        this.port = null;
        this.requests = new Map();
        this.telemetry = { currentTime: 0, bufferAhead: 0, paused: true };
        this.abrAuto = true;
        this.activeVariantId = null;
        this.qualityCap = null;
        this.exportJob = null;
        this.closing = false;
        this.disconnectTimer = null;

        this.abr = new ABRController();
        this.abr.setMaxHeight(settings.qualityCap);
        this.buffer = new BufferManager(tabId, id, {
            capBytes: settings.cacheSizeMB * 1024 * 1024,
            isProtected: key => this.downloader.isProtected(key)
        });
        this.downloader = new SegmentDownloader({
            transport: makeTransport(tabId, () => this.stream),
            buffer: this.buffer,
            abr: this.abr,
            getSettings: () => settings
        });
        this.buffer.init().catch(err => console.warn('[Engine] Buffer init failed:', err));

        this.statsTimer = setInterval(() => this.pushStats(), 1000);
        this.abrTimer = setInterval(() => this.runAbr(), 2000);
    }

    post(msg) {
        if (!this.port) return;
        try { this.port.postMessage(msg); } catch (_) { /* port closed */ }
    }

    snapshot() {
        const d = this.downloader.snapshot();
        return {
            ...d,
            bandwidth: this.abr.estimate,
            cacheBytes: this.buffer.currentSize,
            cacheCapBytes: this.buffer.capBytes,
            cachedSegments: this.buffer.keys.size,
            cachedRanges: this.downloader.cachedRanges(),
            bufferAhead: this.telemetry.bufferAhead,
            currentTime: this.telemetry.currentTime,
            abrAuto: this.abrAuto,
            recording: this.recording ? this.recording.startedAt : 0,
            exporting: !!this.exportJob
        };
    }

    pushStats() {
        this.post({ type: 'STATS', stats: this.snapshot() });
    }

    runAbr() {
        if (!this.abrAuto || this.abr.profiles.length < 2) return;
        const level = this.telemetry.bufferAhead + this.downloader.cachedAheadSeconds();
        const choice = this.abr.getNextQuality(level);
        if (choice && choice.id !== this.activeVariantId) {
            this.post({ type: 'ABR_SWITCH', variantId: choice.id, bandwidth: this.abr.estimate });
        }
    }

    destroy() {
        clearInterval(this.statsTimer);
        clearInterval(this.abrTimer);
        clearTimeout(this.disconnectTimer);
        for (const c of this.requests.values()) c.abort();
        this.requests.clear();
        if (this.exportJob) this.exportJob.controller.abort();
        this.downloader.destroy();
    }
}

async function endSession(session, { clearCache = true, restoreMedia = true } = {}) {
    if (!sessions.has(session.id)) return;
    session.closing = true;
    sessions.delete(session.id);
    session.destroy();
    if (clearCache) await session.buffer.clearStream().catch(() => { });
    const tab = tabs.get(session.tabId);
    if (tab && tab.playerSessionId === session.id) {
        tab.playerSessionId = null;
        persistTab(session.tabId);
    }
    // Remove the player iframe if it is still mounted (closed from the popup, tab navigation...).
    api.tabs.sendMessage(session.tabId, { action: 'UNMOUNT_PLAYER', sessionId: session.id }).catch(() => { });
    if (restoreMedia) api.tabs.sendMessage(session.tabId, { action: 'RESTORE_MEDIA' }).catch(() => { });
    try { session.port && session.port.disconnect(); } catch (_) { /* already closed */ }
    notifyFrames(session.tabId);
}

async function handleRequest(session, msg) {
    const controller = new AbortController();
    session.requests.set(msg.reqId, controller);
    try {
        const res = await session.downloader.load({
            url: msg.url,
            method: msg.method || 'GET',
            headers: msg.headers || {},
            kind: msg.kind || 'segment',
            signal: controller.signal
        });
        if (controller.signal.aborted) return;
        session.post({
            type: 'RESPONSE',
            reqId: msg.reqId,
            ok: res.status < 400,
            status: res.status,
            headers: res.headers,
            url: res.url,
            fromCache: res.fromCache,
            data: S.packBinary(res.data)
        });
    } catch (err) {
        if (controller.signal.aborted || (err && err.name === 'AbortError')) return;
        session.post({
            type: 'RESPONSE',
            reqId: msg.reqId,
            ok: false,
            status: (err && err.status) || 0,
            error: String((err && err.message) || err)
        });
    } finally {
        session.requests.delete(msg.reqId);
    }
}

// ----------------------------------------------------------------------------
// Export / recording (HLS + progressive). Chunks are streamed to the player, which
// assembles a Blob in page memory (service workers cannot create object URLs).
// ----------------------------------------------------------------------------
function fileBaseName(stream) {
    try {
        const u = new URL(stream.url);
        const last = u.pathname.split('/').filter(Boolean).pop() || 'stream';
        return last.replace(/\.(m3u8|mpd|mp4|webm|mkv|mov|m4v)$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'stream';
    } catch (_) {
        return 'stream';
    }
}

/** Live recording: remember the media sequence at "record" time; export from there on stop. */
function startRecording(session) {
    const main = session.downloader.mainPlaylist();
    if (!main || !main.parsed.live) {
        session.post({ type: 'EXPORT_ERROR', error: 'Recording is for live streams. Use Export for on-demand video.' });
        return;
    }
    const segs = main.parsed.segments;
    const cur = segs[Math.max(0, main.cursor)] || segs[segs.length - 1];
    session.recording = { fromSeq: cur ? cur.seq : main.parsed.mediaSequence, startedAt: Date.now() };
    session.post({ type: 'RECORD_STARTED', startedAt: session.recording.startedAt });
}

async function runExport(session, opts = {}) {
    if (session.exportJob) return;
    const controller = new AbortController();
    const jobId = crypto.randomUUID();
    session.exportJob = { id: jobId, controller };
    const signal = controller.signal;
    const post = (m) => session.post({ ...m, jobId });
    const base = fileBaseName(session.stream);

    try {
        if (session.stream.type === 'progressive') {
            await exportProgressive(session, post, signal, base);
        } else if (session.stream.type === 'hls') {
            const d = session.downloader;
            const main = d.mainPlaylist();
            if (!main) throw new Error('Playlist not loaded yet - start playback first.');
            const parts = [main];
            const audio = d.activePlaylists().find(p => p.role === 'audio' && p !== main);
            if (audio) parts.push(audio);
            for (let i = 0; i < parts.length; i++) {
                let segs = d.exportSegments(parts[i]);
                if (opts.fromSeq !== undefined) segs = segs.filter(s => s.seq >= opts.fromSeq);
                const suffix = `${opts.fromSeq !== undefined ? '-recording' : ''}${parts.length > 1 ? (i === 0 ? '-video' : '-audio') : ''}`;
                await exportHlsPlaylist(session, parts[i], segs, post, signal, `${base}${suffix}`, i, parts.length);
            }
        } else {
            throw new Error('Export supports HLS and direct media files. DASH export is not available.');
        }
        post({ type: 'EXPORT_COMPLETE' });
    } catch (err) {
        post({ type: 'EXPORT_ERROR', error: err.name === 'AbortError' ? 'Export cancelled' : String(err.message || err) });
    } finally {
        session.exportJob = null;
    }
}

async function exportHlsPlaylist(session, playlist, segs, post, signal, name, fileIndex, fileCount) {
    if (!segs.length) throw new Error('Nothing to save yet');
    if (segs.some(s => s.key && s.key.method !== 'AES-128')) {
        throw new Error('This stream uses SAMPLE-AES/DRM encryption and cannot be exported.');
    }
    const isFmp4 = segs.some(s => s.map);
    const firstPath = (() => { try { return new URL(segs[0].uri).pathname; } catch (_) { return ''; } })();
    let ext = isFmp4 ? (playlist.role === 'audio' ? 'm4a' : 'mp4') : 'ts';
    let mime = isFmp4 ? (playlist.role === 'audio' ? 'audio/mp4' : 'video/mp4') : 'video/mp2t';
    if (!isFmp4 && /\.aac$/i.test(firstPath)) { ext = 'aac'; mime = 'audio/aac'; }

    const transport = session.downloader.transport;
    const keyCache = new Map();
    const getKey = async (uri) => {
        if (!keyCache.has(uri)) {
            keyCache.set(uri, transport(uri, { method: 'GET', headers: {}, signal }).then(r => {
                if (r.status >= 400 || r.data.byteLength !== 16) throw new Error('Could not load AES-128 key');
                return r.data;
            }));
        }
        return keyCache.get(uri);
    };

    post({ type: 'EXPORT_BEGIN', fileIndex, fileCount, filename: `${name}.${ext}`, mime });
    let lastMap = null;
    const LOOKAHEAD = 4;
    const pending = new Map();
    const startFetch = (i) => {
        if (i >= segs.length || pending.has(i)) return;
        const seg = segs[i];
        pending.set(i, (async () => {
            let data = await session.downloader.fetchForExport(seg, signal);
            if (seg.key && seg.key.method === 'AES-128') {
                data = await decryptAes128(data, await getKey(seg.key.uri), ivForSegment(seg));
            }
            return data;
        })());
    };
    let bytes = 0;
    for (let i = 0; i < segs.length; i++) {
        for (let k = i; k < i + LOOKAHEAD; k++) startFetch(k);
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const seg = segs[i];
        if (seg.map && (!lastMap || lastMap.uri !== seg.map.uri || JSON.stringify(lastMap.byteRange) !== JSON.stringify(seg.map.byteRange))) {
            const headers = seg.map.byteRange ? { Range: `bytes=${seg.map.byteRange.offset}-${seg.map.byteRange.offset + seg.map.byteRange.length - 1}` } : {};
            const init = await transport(seg.map.uri, { method: 'GET', headers, signal });
            if (init.status >= 400) throw new Error(`Init segment HTTP ${init.status}`);
            post({ type: 'EXPORT_CHUNK', fileIndex, data: S.packBinary(init.data) });
            bytes += init.data.byteLength;
            lastMap = seg.map;
        }
        const data = await pending.get(i);
        pending.delete(i);
        bytes += data.byteLength;
        post({ type: 'EXPORT_CHUNK', fileIndex, data: S.packBinary(data) });
        post({ type: 'EXPORT_PROGRESS', fileIndex, fileCount, done: i + 1, total: segs.length, bytes });
    }
    post({ type: 'EXPORT_FILE_DONE', fileIndex });
}

async function exportProgressive(session, post, signal, name) {
    const transport = session.downloader.transport;
    const url = session.stream.url;
    const CHUNK = 4 * 1024 * 1024;
    let ext = 'mp4';
    const m = /\.(mp4|m4v|webm|mkv|mov|ogv)(\?|$)/i.exec(url);
    if (m) ext = m[1].toLowerCase();
    const mime = { webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', ogv: 'video/ogg' }[ext] || 'video/mp4';
    post({ type: 'EXPORT_BEGIN', fileIndex: 0, fileCount: 1, filename: `${name}.${ext}`, mime });
    const fetchChunk = async (offset) => {
        const res = await transport(url, { method: 'GET', headers: { Range: `bytes=${offset}-${offset + CHUNK - 1}` }, signal });
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        return res;
    };
    const first = await fetchChunk(0);
    post({ type: 'EXPORT_CHUNK', fileIndex: 0, data: S.packBinary(first.data) });
    let offset = first.data.byteLength;
    const cr = first.headers['content-range'];
    const total = cr ? parseInt(cr.split('/')[1], 10) : NaN;
    post({ type: 'EXPORT_PROGRESS', fileIndex: 0, fileCount: 1, done: offset, total: Number.isFinite(total) ? total : offset, bytes: offset });
    // 200 = server ignored Range and sent the whole file; short read = end of file.
    if (first.status === 200 || first.data.byteLength < CHUNK) {
        post({ type: 'EXPORT_FILE_DONE', fileIndex: 0 });
        return;
    }
    if (Number.isFinite(total)) {
        // Known size: 4 chunks in flight (range accelerator), emitted strictly in order.
        const pending = new Map();
        const offsets = [];
        for (let o = offset; o < total; o += CHUNK) offsets.push(o);
        for (let i = 0; i < offsets.length; i++) {
            for (let k = i; k < Math.min(i + 4, offsets.length); k++) if (!pending.has(k)) pending.set(k, fetchChunk(offsets[k]));
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const res = await pending.get(i);
            pending.delete(i);
            post({ type: 'EXPORT_CHUNK', fileIndex: 0, data: S.packBinary(res.data) });
            offset += res.data.byteLength;
            post({ type: 'EXPORT_PROGRESS', fileIndex: 0, fileCount: 1, done: offset, total, bytes: offset });
        }
    } else {
        // Content-Range not readable: sequential until a short chunk.
        for (;;) {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const res = await fetchChunk(offset);
            post({ type: 'EXPORT_CHUNK', fileIndex: 0, data: S.packBinary(res.data) });
            offset += res.data.byteLength;
            post({ type: 'EXPORT_PROGRESS', fileIndex: 0, fileCount: 1, done: offset, total: offset, bytes: offset });
            if (res.status === 200 || res.data.byteLength < CHUNK) break;
        }
    }
    post({ type: 'EXPORT_FILE_DONE', fileIndex: 0 });
}

// ----------------------------------------------------------------------------
// Player port
// ----------------------------------------------------------------------------
api.runtime.onConnect.addListener((port) => {
    if (port.name !== 'faststream-player') return;
    const tabId = port.sender && port.sender.tab ? port.sender.tab.id : -1;
    let session = null;

    port.onMessage.addListener(async (msg) => {
        if (!msg || typeof msg.type !== 'string') return;

        if (msg.type === 'HELLO') {
            await settingsReady;
            const tab = await getTab(tabId);
            // Reattach (bridge reconnect after SW restart or transient disconnect).
            session = sessions.get(msg.sessionId) || null;
            if (!session) {
                const stream = tab.streams.get(msg.streamId);
                if (!stream || (tab.playerSessionId && tab.playerSessionId !== msg.sessionId)) {
                    port.postMessage({ type: 'FATAL', error: 'Stream session not found. Re-open the player from the popup.' });
                    return;
                }
                session = new Session({ id: msg.sessionId, tabId, stream });
                sessions.set(session.id, session);
                tab.playerSessionId = session.id;
                persistTab(tabId);
            }
            clearTimeout(session.disconnectTimer);
            session.port = port;
            // Direct media files are loaded by the player page's <video>: give those requests
            // the site's Referer/Origin so hot-link protection accepts them.
            if (session.stream.type === 'progressive') await ensureRefererRule(session.stream.url, session.stream.frameUrl || '');
            session.post({ type: 'INIT', sessionId: session.id, stream: session.stream, resumed: !!msg.resumed });
            return;
        }

        if (!session || session.port !== port) return;

        switch (msg.type) {
            case 'REQUEST':
                handleRequest(session, msg);
                break;
            case 'ABORT': {
                const c = session.requests.get(msg.reqId);
                if (c) { c.abort(); session.requests.delete(msg.reqId); }
                break;
            }
            case 'TELEMETRY': {
                session.telemetry = {
                    currentTime: +msg.currentTime || 0,
                    bufferAhead: +msg.bufferAhead || 0,
                    paused: !!msg.paused
                };
                session.downloader.updatePlayback(session.telemetry);
                if (Array.isArray(msg.variants)) session.abr.setProfiles(msg.variants);
                if (msg.activeVariantId !== undefined) {
                    session.activeVariantId = msg.activeVariantId;
                    session.abr.setActive(msg.activeVariantId);
                }
                if (typeof msg.qualityCap === 'number') {
                    session.qualityCap = msg.qualityCap;
                    session.abr.setMaxHeight(msg.qualityCap);
                }
                break;
            }
            case 'SEEK':
                session.downloader.seek(+msg.time || 0);
                break;
            case 'SET_QUALITY':
                if (msg.mode === 'auto') {
                    session.abrAuto = true;
                    session.abr.unlockQuality();
                    session.runAbr();
                } else {
                    session.abrAuto = false;
                    session.abr.lockQuality(msg.variantId);
                }
                break;
            case 'PREFETCH':
                if (msg.enabled) session.downloader.resume(); else session.downloader.pause();
                break;
            case 'EXPORT_START':
                runExport(session);
                break;
            case 'RECORD_START':
                startRecording(session);
                break;
            case 'RECORD_STOP': {
                const rec = session.recording;
                session.recording = null;
                if (rec) runExport(session, { fromSeq: rec.fromSeq });
                break;
            }
            case 'EXPORT_CANCEL':
                if (session.exportJob) session.exportJob.controller.abort();
                break;
            case 'CLOSE':
                endSession(session, { clearCache: true, restoreMedia: true });
                break;
            case 'HEARTBEAT':
            default:
                break;
        }
    });

    port.onDisconnect.addListener(() => {
        if (!session || session.closing || session.port !== port) return;
        session.port = null;
        // Give the bridge a moment to reconnect (navigation within bfcache, SW hiccup).
        session.disconnectTimer = setTimeout(() => {
            if (!session.port) endSession(session, { clearCache: true, restoreMedia: false });
        }, RECONNECT_GRACE_MS);
    });
});

// ============================================================================
// LAUNCH
// ============================================================================
/** Make sure the content script runs in a frame (frames opened before install/update lack it). */
async function pingFrame(tabId, frameId) {
    let res = await api.tabs.sendMessage(tabId, { action: 'PING' }, { frameId }).catch(() => null);
    if (!res) {
        try {
            await api.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['common/shared.js', 'content/sniffer.js'] });
            res = await api.tabs.sendMessage(tabId, { action: 'PING' }, { frameId }).catch(() => null);
        } catch (_) {
            res = null; // restricted frame (browser pages, store, PDF viewer)
        }
    }
    return res;
}

/**
 * Launch: the player is an extension page mounted as an iframe over the site's own <video>.
 * Frame choice: the frame the user clicked in (badge) -> the frame that requested the stream
 * -> any frame known to contain a <video> -> the top frame in full-page mode.
 */
async function launchPlayer(tabId, streamId, preferFrameId) {
    const tab = await getTab(tabId);
    const stream = tab.streams.get(streamId);
    if (!stream) throw new Error('Stream no longer available. Reload the page.');

    // Stream switch: end any previous session in this tab (clears its cache, removes its iframe).
    if (tab.playerSessionId) {
        const prev = sessions.get(tab.playerSessionId);
        if (prev) await endSession(prev, { clearCache: true, restoreMedia: false });
        tab.playerSessionId = null;
    }
    await api.tabs.sendMessage(tabId, { action: 'UNMOUNT_PLAYER' }).catch(() => { });

    const sessionId = crypto.randomUUID();
    const url = api.runtime.getURL(`player/player.html?session=${encodeURIComponent(sessionId)}&stream=${encodeURIComponent(streamId)}`);
    // Registered before mounting: the player page says HELLO as soon as it loads.
    tab.playerSessionId = sessionId;
    persistTab(tabId);

    const candidates = [];
    const add = (f) => { if (typeof f === 'number' && f >= 0 && !candidates.includes(f)) candidates.push(f); };
    add(preferFrameId);
    add(stream.frameId);
    [...tab.videoFrames].forEach(add);
    add(0);

    // Pause & mute native media in every frame of the tab.
    await api.tabs.sendMessage(tabId, { action: 'SUSPEND_MEDIA' }).catch(() => { });

    let mounted = null;
    for (const frameId of candidates) {
        const ping = await pingFrame(tabId, frameId);
        if (!ping || !ping.hasVideo) continue;
        const res = await api.tabs.sendMessage(tabId, { action: 'MOUNT_PLAYER', sessionId, url, streamUrl: stream.url }, { frameId }).catch(() => null);
        if (res && res.ok) { mounted = { frameId, mode: res.mode }; break; }
    }
    if (!mounted) {
        // No <video> element anywhere (stream found on the network only): cover the page.
        const ping = await pingFrame(tabId, 0);
        if (!ping) {
            tab.playerSessionId = null;
            persistTab(tabId);
            throw new Error('This page cannot be scripted by extensions (browser or store page).');
        }
        const res = await api.tabs.sendMessage(tabId, { action: 'MOUNT_PLAYER', sessionId, url, streamUrl: stream.url, forcePage: true }, { frameId: 0 });
        if (!res || !res.ok) {
            tab.playerSessionId = null;
            persistTab(tabId);
            throw new Error((res && res.error) || 'Could not open the player on this page.');
        }
        mounted = { frameId: 0, mode: 'page' };
    }
    tab.mountFrameId = mounted.frameId;
    notifyFrames(tabId);
    return { ok: true, sessionId, frameId: mounted.frameId, mode: mounted.mode };
}

/** On-page badge click: prefer a stream detected in the frame that showed the badge. */
async function launchFromPage(tabId, frameId) {
    const tab = await getTab(tabId);
    const list = visibleStreams(tab);
    const pick = list.find(s => s.frameId === frameId && !s.isAd) || list.find(s => !s.isAd) || list[0];
    if (!pick) throw new Error('No playable stream found yet. Start the video on the page first.');
    return launchPlayer(tabId, pick.id, frameId);
}

/** Popup "paste a link" bar: register the URL as a stream of the active tab and play it. */
async function launchManualUrl(tabId, rawUrl, typeHint) {
    let url;
    try { url = new URL(String(rawUrl).trim()); } catch (_) { throw new Error('That is not a valid web address.'); }
    if (!/^https?:$/.test(url.protocol)) throw new Error('Only http:// and https:// links can be played.');
    const tabInfo = await api.tabs.get(tabId).catch(() => null);
    const frameUrl = (tabInfo && tabInfo.url) || '';
    let type = ['hls', 'dash', 'progressive'].includes(typeHint) ? typeHint : S.classifyStream(url.href);
    if (!type) type = await detectTypeByContent(tabId, url.href, frameUrl);
    const stream = await handleDetection(tabId, 0, frameUrl, { url: url.href, type, method: 'manual', title: '' });
    if (!stream) throw new Error('Could not register that stream.');
    return launchPlayer(tabId, stream.id);
}

// ============================================================================
// RUNTIME MESSAGES (sniffer + popup)
// ============================================================================
function respondAsync(promise, sendResponse) {
    promise.then(sendResponse, err => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.action !== 'string') return false;
    const fromTab = sender.tab ? sender.tab.id : undefined;

    switch (message.action) {
        // ---- From sniffer.js ------------------------------------------------
        case 'STREAM_FOUND':
            handleDetection(fromTab, sender.frameId ?? 0, sender.url || '', message.payload);
            return false;
        case 'MSE_INIT':
            // URL-less signal: never becomes a stream entry, only boosts its frame's ranking.
            handleDetection(fromTab, sender.frameId ?? 0, sender.url || '', { type: 'mse' });
            return false;
        case 'VIDEO_PRESENT':
            handleDetection(fromTab, sender.frameId ?? 0, sender.url || '', { type: 'video-present' });
            return false;

        // ---- From popup -------------------------------------------------------
        case 'GET_STREAMS':
            return respondAsync((async () => {
                const tab = await getTab(message.tabId, { create: false });
                if (!tab) return { ok: true, streams: [], player: null };
                const list = visibleStreams(tab);
                list.forEach(s => { if (!s.probe && s.type !== 'progressive') probeStream(tab, s); });
                const session = tab.playerSessionId ? sessions.get(tab.playerSessionId) : null;
                return {
                    ok: true,
                    streams: list,
                    player: session ? { sessionId: session.id, streamId: session.stream.id, exporting: !!session.exportJob } : null
                };
            })(), sendResponse);
        case 'GET_STATS':
            return respondAsync((async () => {
                const tab = await getTab(message.tabId, { create: false });
                const session = tab && tab.playerSessionId ? sessions.get(tab.playerSessionId) : null;
                let activeDownloads = 0;
                let bandwidth = 0;
                for (const s of sessions.values()) {
                    activeDownloads += s.downloader.activePrefetch + s.downloader.activeOnDemand;
                    bandwidth = Math.max(bandwidth, s.abr.estimate);
                }
                return { ok: true, session: session ? session.snapshot() : null, global: { activeDownloads, bandwidth, sessions: sessions.size } };
            })(), sendResponse);
        case 'LAUNCH_PLAYER':
            return respondAsync(launchPlayer(message.tabId, message.streamId), sendResponse);
        case 'LAUNCH_FROM_PAGE':
            if (fromTab === undefined) return false;
            return respondAsync(launchFromPage(fromTab, sender.frameId ?? 0), sendResponse);
        case 'LAUNCH_URL':
            return respondAsync(launchManualUrl(message.tabId, message.url, message.typeHint), sendResponse);
        case 'GET_BADGE_STATE':
            if (fromTab !== undefined) notifyFrames(fromTab);
            return false;
        case 'CLOSE_PLAYER':
        case 'EXPORT_STREAM':
            return respondAsync((async () => {
                const tab = await getTab(message.tabId, { create: false });
                const session = tab && tab.playerSessionId ? sessions.get(tab.playerSessionId) : null;
                if (!session || !session.port) return { ok: false, error: 'Player is not open on this tab.' };
                session.post({ type: 'COMMAND', command: message.action === 'CLOSE_PLAYER' ? 'close' : 'export' });
                return { ok: true };
            })(), sendResponse);
        case 'RESCAN':
            return respondAsync(api.tabs.sendMessage(message.tabId, { action: 'RESCAN' }).then(() => ({ ok: true }), () => ({ ok: false })), sendResponse);
        case 'CLEAR_STREAMS':
            return respondAsync((async () => {
                await teardownTab(message.tabId, { keepPlayer: true });
                return { ok: true };
            })(), sendResponse);
        default:
            return false;
    }
});

// ============================================================================
// LIFECYCLE / CLEANUP
// ============================================================================
async function teardownTab(tabId, { keepPlayer = false, removed = false } = {}) {
    const tab = tabs.get(tabId);
    const session = tab && tab.playerSessionId ? sessions.get(tab.playerSessionId) : null;
    if (session && !keepPlayer) await endSession(session, { clearCache: true, restoreMedia: false });
    if (keepPlayer && tab && session) {
        // Keep only the stream being played.
        for (const [id, s] of tab.streams) if (s.id !== session.stream.id) { tab.streams.delete(id); tab.byUrl.delete(s.url); }
        tab.children.clear();
        persistTab(tabId);
    } else {
        tabs.delete(tabId);
        clearTimeout(persistTimers.get(tabId));
        persistTimers.delete(tabId);
        api.storage.session.remove(`tab_${tabId}`).catch(() => { });
        if (!keepPlayer) BufferManager.clearTab(tabId).catch(() => { });
    }
    if (!removed) {
        updateIcon(tabId);
        notifyFrames(tabId);
    }
}

api.tabs.onRemoved.addListener((tabId) => {
    teardownTab(tabId, { removed: true });
});

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // A new document is loading in the tab: every detected stream and cached segment is stale.
    if (changeInfo.status === 'loading' && changeInfo.url !== undefined) {
        // keepPlayer: SPA history navigations can also report a URL change; a real navigation
        // destroys the page, which disconnects the player port and ends the session anyway.
        teardownTab(tabId, { keepPlayer: true });
    } else if (changeInfo.status === 'loading') {
        // Same-URL reload: drop streams (they will be re-detected) and the cache.
        const tab = tabs.get(tabId);
        if (tab && !tab.playerSessionId) teardownTab(tabId);
    }
});

/** On (re)start: clean IndexedDB records and session keys of tabs that no longer exist. */
async function startupSweep() {
    try {
        const all = await api.tabs.query({});
        const live = new Set(all.map(t => t.id));
        const removed = await sweepOrphans(live);
        if (removed) console.log(`[Engine] Swept cache of ${removed} closed tab(s)`);
        const stored = await api.storage.session.get(null);
        const stale = Object.keys(stored).filter(k => k.startsWith('tab_') && !live.has(parseInt(k.slice(4), 10)));
        if (stale.length) await api.storage.session.remove(stale);
    } catch (e) {
        console.warn('[Engine] Startup sweep failed:', e && e.message);
    }
}

// Read-only diagnostics handle (inspect from the service-worker devtools console).
globalThis.FastStreamEngine = Object.freeze({ tabs, sessions, launchPlayer: (tabId, streamId, frameId) => launchPlayer(tabId, streamId, frameId) });

api.runtime.onStartup && api.runtime.onStartup.addListener(startupSweep);
api.runtime.onInstalled.addListener(startupSweep);
startupSweep();
