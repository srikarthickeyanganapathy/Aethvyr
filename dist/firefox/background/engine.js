/**
 * Velostream - Background Engine
 *
 * Control plane for stream detection, player launch, network proxying, prefetching, ABR,
 * telemetry and lifecycle. Runs as an MV3 service worker (Chromium) or event page (Firefox).
 *
 *   player-overlay.js (MAIN, top frame)
 *        ⇅ MessagePort (ArrayBuffers transferred)
 *   sniffer.js (ISOLATED, top frame)  ── runtime port "velostream-player" ──>  engine.js
 *                                                                               │
 *   sniffer.js (ISOLATED, frame that owns the stream)  <── FETCH_PROXY {frameId} ┘
 *        ⇅ window.postMessage (transfer)
 *   interceptor.js (MAIN, same frame: page cookies, Referer, CORS context)
 */

import '../common/shared.js';
import { BufferManager, sweepOrphans } from './buffer-manager.js';
import { SegmentDownloader, sniffMedia } from './downloader.js';
import { ABRController } from './abr-controller.js';
import { parsePlaylist, ivForSegment, decryptAes128 } from './hls-parser.js';
import { initSync } from './sync.js';

const S = globalThis.VelostreamShared;
const api = S.api;

// Opt-in cross-device sync (browser account storage.sync). Started synchronously so its
// storage/message listeners exist on every service-worker wake; it is inert unless
// settings.syncEnabled is true and never throws into the engine.
try { initSync({ api, S }); } catch (e) { console.warn('[Engine] sync unavailable:', e && e.message); }

const MAX_STREAMS_PER_TAB = 40;
const PROXY_TIMEOUT_MS = 60000;
const RECONNECT_GRACE_MS = 20000;
// 16/32 px use a heavier variant of the mark (see assets/brand/*-small.svg) so it stays legible.
const ICONS_IDLE = { 16: '/icons/icon-16.png', 32: '/icons/icon-32.png', 48: '/icons/icon-48.png', 128: '/icons/icon-128.png' };
const ICONS_ACTIVE = { 16: '/icons/icon-active-16.png', 32: '/icons/icon-active-32.png', 48: '/icons/icon-active-48.png', 128: '/icons/icon-active-128.png' };

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
        subtitles: [],             // captured sidecar / in-memory subtitle tracks (bounded)
        drm: null,                 // { keySystem, frameId } once a frame requested EME keys
        autoLaunched: false,       // auto-replace already ran for this page load
        mountFrameId: null,        // frame the player iframe was mounted in
        playerSessionId: null,
        probing: 0
    };
}

// storage.session is small (Chromium: 10 MB for the whole extension). Subtitles live under their
// own key (written only when they change) and inline cue text is budgeted; sidecar tracks keep
// their URL and are simply re-fetched by the player.
const SUBS_PERSIST_BUDGET = 1_500_000;
const subsDirty = new Set();
const tabKey = (tabId) => `tab_${tabId}`;
const tabSubsKey = (tabId) => `tabsubs_${tabId}`;

async function getTab(tabId, { create = true } = {}) {
    let tab = tabs.get(tabId);
    if (tab) return tab;
    // Restore after a service-worker / event-page restart.
    const key = tabKey(tabId);
    const subsKey = tabSubsKey(tabId);
    const res = await api.storage.session.get([key, subsKey]).catch(() => ({}));
    const stored = res && res[key];
    const storedSubs = res && res[subsKey];
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
        for (const e of stored.mseFrames || []) {
            if (Array.isArray(e) && typeof e[0] === 'number') tab.mseFrames.set(e[0], +e[1] || 0);
        }
        (stored.videoFrames || []).forEach(f => { if (typeof f === 'number') tab.videoFrames.add(f); });
        tab.drm = stored.drm || null;
        tab.autoLaunched = !!stored.autoLaunched;
        tab.mountFrameId = typeof stored.mountFrameId === 'number' ? stored.mountFrameId : null;
    }
    if (Array.isArray(storedSubs)) tab.subtitles = storedSubs.slice(-32);
    tabs.set(tabId, tab);
    return tab;
}

/** Subtitles to persist: newest first within the inline-text budget (URL tracks keep their URL). */
function subtitlesForStorage(list) {
    const out = [];
    let used = 0;
    for (let i = list.length - 1; i >= 0; i--) {
        const t = list[i];
        const cost = (t.vtt || '').length;
        if (used + cost <= SUBS_PERSIST_BUDGET) {
            used += cost;
            out.unshift(t);
        } else if (t.url) {
            out.unshift({ ...t, vtt: '' });
        }
    }
    return out;
}

function persistTab(tabId, { subtitles = false } = {}) {
    if (subtitles) subsDirty.add(tabId);
    clearTimeout(persistTimers.get(tabId));
    persistTimers.set(tabId, setTimeout(() => {
        persistTimers.delete(tabId);
        const tab = tabs.get(tabId);
        if (!tab) return;
        const data = {
            [tabKey(tabId)]: {
                streams: [...tab.streams.values()],
                children: [...tab.children].slice(-200),
                playerSessionId: tab.playerSessionId,
                mseFrames: [...tab.mseFrames.entries()].slice(-32),
                videoFrames: [...tab.videoFrames].slice(-32),
                drm: tab.drm || null,
                autoLaunched: !!tab.autoLaunched,
                mountFrameId: tab.mountFrameId ?? null
            }
        };
        api.storage.session.set(data).catch(() => { /* quota / unsupported */ });
        // Separate write: a quota failure on cue text must not lose the stream list.
        if (subsDirty.delete(tabId)) {
            api.storage.session.set({ [tabSubsKey(tabId)]: subtitlesForStorage(tab.subtitles || []) }).catch(() => { });
        }
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
/** What the in-player stream switcher needs about each playable stream of a tab. */
function streamSummaries(tab) {
    return visibleStreams(tab).filter(s => !s.isAd).slice(0, 20).map(s => {
        let host = '';
        try { host = new URL(s.frameUrl || s.url).hostname; } catch (_) { /* opaque */ }
        const p = s.probe && s.probe.status === 'done' ? s.probe : null;
        return {
            id: s.id, url: s.url, type: s.type, title: s.title || '', host, frameId: s.frameId,
            maxHeight: p ? p.maxHeight || 0 : 0, duration: p ? p.duration || 0 : 0, live: !!(p && p.live),
            isMaster: !!(p && p.isMaster), drm: !!(tab.drm), detectedAt: s.detectedAt
        };
    });
}

function notifyFrames(tabId) {
    clearTimeout(notifyTimers.get(tabId));
    notifyTimers.set(tabId, setTimeout(() => {
        notifyTimers.delete(tabId);
        const tab = tabs.get(tabId);
        // The open player's stream switcher follows newly detected / probed streams.
        const open = tab && tab.playerSessionId ? sessions.get(tab.playerSessionId) : null;
        if (open) open.post({ type: 'STREAMS', streams: streamSummaries(tab), current: open.stream.id });
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

/** Remember a subtitle track seen on the page (sidecar file or serialized in-memory cues). */
async function addSubtitle(tabId, frameId, frameUrl, sub) {
    if (!sub || (!sub.url && !sub.vtt)) return;
    const tab = await getTab(tabId);
    const url = sub.url ? S.normalizeUrl(sub.url, frameUrl) : '';
    if (url && !/^https?:/i.test(url)) return;
    const key = url || `inline:${sub.label || ''}:${sub.language || ''}:${String(sub.vtt).length}`;
    const known = tab.subtitles.find(t => t.key === key);
    if (known) {
        // Seen on the network first, then as <track>: keep the richer metadata.
        let changed = false;
        if (!known.label && sub.label) { known.label = String(sub.label).slice(0, 80); changed = true; }
        if (!known.language && sub.language) { known.language = String(sub.language).slice(0, 20); changed = true; }
        if (!known.isDefault && sub.isDefault) { known.isDefault = true; changed = true; }
        if (sub.kind === 'chapters' && known.kind !== 'chapters') { known.kind = 'chapters'; changed = true; }
        if (!changed) return;
        persistTab(tabId, { subtitles: true });
        const s0 = tab.playerSessionId ? sessions.get(tab.playerSessionId) : null;
        if (s0) s0.post({ type: 'SUBTITLES', subtitles: tab.subtitles });
        return;
    }
    // In-memory text tracks are re-reported as the site adds cues: update the existing entry
    // for the same track (frame + label + language + kind) instead of adding a duplicate that
    // would push other subtitles out of the 32-entry list.
    if (!url && sub.vtt && sub.method === 'textTracks') {
        const kind = sub.kind === 'chapters' ? 'chapters' : 'subtitles';
        const same = tab.subtitles.find(t => !t.url && t.method === 'textTracks' && t.frameId === frameId &&
            t.label === String(sub.label || '').slice(0, 80) && t.language === String(sub.language || '').slice(0, 20) && t.kind === kind);
        if (same) {
            const vtt = String(sub.vtt).slice(0, 2000000);
            if (vtt.length <= same.vtt.length) return;
            same.vtt = vtt;
            same.key = key;
            if (sub.isDefault) same.isDefault = true;
            persistTab(tabId, { subtitles: true });
            const s1 = tab.playerSessionId ? sessions.get(tab.playerSessionId) : null;
            if (s1) s1.post({ type: 'SUBTITLES', subtitles: tab.subtitles });
            return;
        }
    }
    if (tab.subtitles.length >= 32) tab.subtitles.shift();
    const mime = String(sub.mime || '');
    const format = /\.srt(\?|#|$)/i.test(url) || /subrip/i.test(mime) ? 'srt'
        : /\.(ass|ssa)(\?|#|$)/i.test(url) || /x-(ssa|ass)/i.test(mime) ? 'ass' : 'vtt';
    tab.subtitles.push({
        key, url, frameId, frameUrl, format,
        vtt: sub.vtt ? String(sub.vtt).slice(0, 2000000) : '',
        label: String(sub.label || '').slice(0, 80),
        language: String(sub.language || '').slice(0, 20),
        isDefault: !!sub.isDefault,
        kind: sub.kind === 'chapters' ? 'chapters' : 'subtitles',
        method: sub.method || 'network'
    });
    persistTab(tabId, { subtitles: true });
    // Tell an open player about late arrivals.
    const session = tab.playerSessionId ? sessions.get(tab.playerSessionId) : null;
    if (session) session.post({ type: 'SUBTITLES', subtitles: tab.subtitles });
}

async function handleDetection(tabId, frameId, frameUrl, payload) {
    if (tabId === undefined || tabId < 0 || !payload) return null;
    const tab = await getTab(tabId);

    if (payload.type === 'mse') {
        const known = tab.mseFrames.has(frameId);
        tab.mseFrames.set(frameId, Date.now());
        if (!known) persistTab(tabId); // timestamp refreshes alone are not worth a write
        return null;
    }
    if (payload.type === 'video-present') {
        if (!tab.videoFrames.has(frameId)) {
            tab.videoFrames.add(frameId);
            persistTab(tabId);
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
    if (!stream.isAd && payload.method !== 'manual') maybeAutoLaunch(tab, stream);
    return stream;
}

/**
 * Auto-replace (per-site opt-in from the popup): the first real stream detected on an enabled
 * site opens in Velostream automatically, once per page load. Waits briefly so the master
 * playlist probe can win over its variant playlists.
 */
async function maybeAutoLaunch(tab, stream) {
    // autoLaunchPending: several streams are usually detected in the same burst; only the first
    // may run the (async) host check, or two launches would race and end each other's session.
    if (tab.autoLaunched || tab.autoLaunchPending || tab.playerSessionId || !settings.autoSites.length) return;
    tab.autoLaunchPending = true;
    try {
        // Match the top page's host *and* the embedding frame's host: the stream is often found
        // inside a third-party player iframe while the user enabled the outer site (or vice versa).
        const hosts = new Set();
        try { hosts.add(new URL((await api.tabs.get(tab.tabId)).url).hostname); } catch (_) { /* tab gone */ }
        try { if (stream && stream.frameUrl) hosts.add(new URL(stream.frameUrl).hostname); } catch (_) { /* opaque */ }
        const sites = settings.autoSites.map(h => String(h).toLowerCase());
        const match = [...hosts].some(h => sites.some(s => h === s || h.endsWith(`.${s}`)));
        if (!match || tab.autoLaunched || tab.playerSessionId) return;
        tab.autoLaunched = true;
        persistTab(tab.tabId);
    } finally {
        tab.autoLaunchPending = false;
    }
    setTimeout(() => {
        const list = visibleStreams(tab).filter(s => !s.isAd);
        // Prefer a probed master playlist over its variants when both exist already.
        const best = list.find(s => s.probe && s.probe.isMaster) || list[0];
        if (!best || tab.playerSessionId) return;
        launchPlayer(tab.tabId, best.id).catch(err => {
            tab.autoLaunched = false;
            persistTab(tab.tabId);
            console.warn('[Engine] Auto-launch failed:', err && err.message);
        });
    }, 600);
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
// Headers the site's own player sent, keyed by `${requestHost}|${initiatorSite}` so two sites
// sharing a CDN host never see each other's Referer/Origin/auth headers.
const capturedByHostSite = new Map(); // key -> {referer, origin, headers, site}
const latestCaptureByHost = new Map(); // host -> key of the most recent capture (frame URL unknown)
const MAX_CAPTURES = 300;

function pickFrameId(tab, stream) {
    if (stream && stream.frameId >= 0) return stream.frameId;
    if (!tab) return 0;
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
// Built by hand: URL.origin of moz-extension:// URLs is not reliable on every Firefox version.
const EXT_ORIGIN = (() => { try { const u = new URL(api.runtime.getURL('')); return u.host ? `${u.protocol}//${u.host}` : ''; } catch (_) { return ''; } })();

// ----------------------------------------------------------------------------
// Site identity (registrable-domain heuristic; no public-suffix list in an extension)
// ----------------------------------------------------------------------------
const MULTI_PART_SLD = /^(co|com|net|org|gov|edu|ac|ne|or|go|gob|mil|nic|ltd|plc|sch)$/;

/** "a.b.example.co.uk" -> "example.co.uk"; IPs and single labels are returned as-is. */
function siteOf(urlOrHost) {
    if (!urlOrHost) return '';
    let host;
    try {
        host = String(urlOrHost).includes('://') ? new URL(urlOrHost).hostname : String(urlOrHost);
    } catch (_) {
        return '';
    }
    host = host.toLowerCase().replace(/\.$/, '');
    if (!host) return '';
    if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return host;
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const n = parts[parts.length - 1].length === 2 && MULTI_PART_SLD.test(parts[parts.length - 2]) ? 3 : 2;
    return parts.slice(-n).join('.');
}

/** http(s) origin of a frame URL, or '' when it is unknown/opaque (about:blank, data:...). */
function httpOrigin(frameUrl) {
    try {
        const u = new URL(frameUrl);
        return /^https?:$/.test(u.protocol) ? u.origin : '';
    } catch (_) {
        return '';
    }
}

/**
 * What the site's player sent to `host`, as seen from the frame that owns the stream. With a known
 * frame only a capture initiated from the same site is used; with an unknown frame, the latest.
 */
function lookupCapture(host, frameUrl) {
    const site = httpOrigin(frameUrl) ? siteOf(frameUrl) : '';
    if (site) return capturedByHostSite.get(`${host}|${site}`) || null;
    const k = latestCaptureByHost.get(host);
    return (k && capturedByHostSite.get(k)) || null;
}

/** Custom request headers the site's own player sent to this host (auth tokens etc.). */
function capturedHeaders(url, frameUrl) {
    try {
        const c = lookupCapture(new URL(url).hostname, frameUrl);
        return (c && c.headers) || {};
    } catch (_) {
        return {};
    }
}

// ----------------------------------------------------------------------------
// Session-scoped DNR rules so requests made by the extension itself carry the site's
// Referer/Origin: direct fallback fetches from the engine (no tab) and media requests the
// player page makes (e.g. a progressive MP4 in <video src>, initiated by the extension origin).
// Many CDNs reject hot-linked media without the right Referer.
//
// One group of 3 rule ids per CDN host:
//   id     engine fetches (tabId NONE)                      -> request Referer/Origin
//   id + 1 requests initiated by the extension origin        -> request Referer/Origin
//   id + 2 requests initiated by the extension origin        -> CORS response headers, so the
//          player's <video crossOrigin="anonymous"> can feed Web Audio / WebGL / snapshots.
// Page-initiated requests never match (tabId NONE / initiatorDomains = our own origin).
//
// A host's rule can only carry one Referer at a time, but several sites may use the same CDN:
// a host is "held" by the config of in-flight engine fetches (readers); a different config waits
// until they have sent their headers, then rewrites the rule (writer). All rule updates are
// serialized through one chain so removals/additions never interleave.
// ----------------------------------------------------------------------------
const DNR_BASE_ID = 1000;
const MAX_HOST_RULES = 300;
const SWITCH_MAX_WAIT_MS = 15000;
const hostRules = new Map(); // host -> {host, ids, cfgKey, users, waiters: Map<key,n>, idle: fn[], switching}
let nextDnrRuleId = DNR_BASE_ID;
let dnrChain = Promise.resolve();
const NOOP = () => { };

function dnrUpdate(opts) {
    const run = dnrChain.then(() => api.declarativeNetRequest.updateSessionRules(opts));
    dnrChain = run.catch(() => { });
    return run;
}

function newHostRule(host, baseId) {
    return { host, ids: [baseId, baseId + 1, baseId + 2], cfgKey: null, users: 0, waiters: new Map(), idle: [], switching: null };
}

// Session rules survive a service-worker restart (they are cleared on browser restart and on
// extension update/reload): rebuild the host map from them instead of colliding with their ids.
const dnrReady = (async () => {
    try {
        const rules = await api.declarativeNetRequest.getSessionRules();
        const groups = new Map();
        for (const r of rules || []) {
            if (r.id < DNR_BASE_ID) continue;
            const base = DNR_BASE_ID + Math.floor((r.id - DNR_BASE_ID) / 3) * 3;
            if (!groups.has(base)) groups.set(base, []);
            groups.get(base).push(r);
            nextDnrRuleId = Math.max(nextDnrRuleId, base + 3);
        }
        const orphans = [];
        for (const [base, list] of groups) {
            const head = list.find(r => r.id === base);
            const host = head && head.condition && head.condition.requestDomains && head.condition.requestDomains[0];
            if (!host || hostRules.has(host)) { orphans.push(...list.map(r => r.id)); continue; }
            const hdr = (n) => (((head.action && head.action.requestHeaders) || []).find(h => String(h.header).toLowerCase() === n) || {}).value || '';
            const st = newHostRule(host, base);
            st.cfgKey = `${hdr('referer')}\n${hdr('origin')}`;
            hostRules.set(host, st);
        }
        if (orphans.length) await dnrUpdate({ removeRuleIds: orphans });
    } catch (_) { /* DNR session rules unavailable: rules are simply (re)added on demand */ }
})();

/** Desired Referer/Origin for extension requests to `url` on behalf of the stream's frame. */
function refererConfig(url, frameUrl) {
    let host;
    try { host = new URL(url).hostname; } catch (_) { return null; }
    if (!host) return null;
    const frameOrigin = httpOrigin(frameUrl);
    const frameSite = frameOrigin ? siteOf(frameUrl) : '';
    const cap = lookupCapture(host, frameOrigin ? frameUrl : '');
    // A captured value is only trusted when it belongs to the same site as the stream's frame.
    const sameSite = (v) => !!v && (!frameSite || siteOf(v) === frameSite);
    const referer = cap && sameSite(cap.referer) ? cap.referer : (frameOrigin ? String(frameUrl).split('#')[0] : '');
    const origin = cap && sameSite(cap.origin) && cap.origin !== 'null' ? cap.origin : frameOrigin;
    if (!referer && !origin) return null;
    return { host, referer, origin, key: `${referer}\n${origin}` };
}

function wakeHost(st) {
    const list = st.idle.splice(0);
    list.forEach(fn => fn());
}

async function applyHostRule(st, cfg) {
    const requestHeaders = [];
    if (cfg.referer) requestHeaders.push({ header: 'Referer', operation: 'set', value: cfg.referer });
    if (cfg.origin) requestHeaders.push({ header: 'Origin', operation: 'set', value: cfg.origin });
    const action = { type: 'modifyHeaders', requestHeaders };
    const resourceTypes = ['xmlhttprequest', 'media', 'other'];
    const [a, b, c] = st.ids;
    const base = [{ id: a, priority: 2, action, condition: { requestDomains: [st.host], tabIds: [api.tabs.TAB_ID_NONE], resourceTypes } }];
    const ext = [];
    if (EXT_HOST) {
        ext.push({ id: b, priority: 2, action, condition: { requestDomains: [st.host], initiatorDomains: [EXT_HOST], resourceTypes } });
        if (EXT_ORIGIN) {
            ext.push({
                id: c,
                priority: 2,
                action: {
                    type: 'modifyHeaders',
                    responseHeaders: [
                        // Exact extension origin, never '*': only our own pages may read these bytes.
                        { header: 'Access-Control-Allow-Origin', operation: 'set', value: EXT_ORIGIN },
                        { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' },
                        { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Range, Content-Length, Accept-Ranges, Content-Type' }
                    ]
                },
                condition: { requestDomains: [st.host], initiatorDomains: [EXT_HOST], resourceTypes }
            });
        }
    }
    // Degrade step by step: engines that reject extension initiators or response-header
    // modification still get the engine-fetch Referer rule.
    const attempts = [[...base, ...ext], [...base, ...ext.slice(0, 1)], base];
    let lastErr = null;
    for (const addRules of attempts) {
        try {
            await dnrUpdate({ removeRuleIds: st.ids, addRules });
            st.cfgKey = cfg.key;
            return true;
        } catch (e) {
            lastErr = e;
        }
    }
    // A failed update changes nothing: drop the previous site's rule rather than keep sending it.
    try { await dnrUpdate({ removeRuleIds: st.ids }); st.cfgKey = null; } catch (_) { /* keep state */ }
    console.warn('[Engine] Could not add Referer rule:', lastErr && lastErr.message);
    return false;
}

function evictHostRules() {
    if (hostRules.size <= MAX_HOST_RULES) return;
    for (const [host, st] of hostRules) {
        if (hostRules.size <= MAX_HOST_RULES) break;
        if (st.users || st.switching || st.waiters.size) continue;
        hostRules.delete(host);
        dnrUpdate({ removeRuleIds: st.ids }).catch(() => { });
    }
}

/**
 * Make sure the host's rule carries this frame's Referer/Origin and hold it until release() is
 * called (after the request's headers went out). Never throws; resolves to a release function.
 */
async function acquireRefererRule(url, frameUrl) {
    const cfg = refererConfig(url, frameUrl);
    if (!cfg) return NOOP;
    await dnrReady;
    let st = hostRules.get(cfg.host);
    if (!st) {
        st = newHostRule(cfg.host, nextDnrRuleId);
        nextDnrRuleId += 3;
    }
    hostRules.delete(cfg.host); // LRU order
    hostRules.set(cfg.host, st);
    evictHostRules();
    const t0 = Date.now();
    for (;;) {
        if (st.switching) { await st.switching; continue; }
        const contended = [...st.waiters].some(([k, n]) => k !== cfg.key && n > 0);
        if (st.cfgKey === cfg.key && !contended) {
            st.users++;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                st.users--;
                if (st.users <= 0) { st.users = 0; wakeHost(st); }
            };
        }
        // Switch when nobody is using the current config (or a stuck request held it too long).
        if (st.cfgKey !== cfg.key && (st.users === 0 || Date.now() - t0 > SWITCH_MAX_WAIT_MS)) {
            st.switching = applyHostRule(st, cfg).catch(() => false).finally(() => {
                st.switching = null;
                wakeHost(st);
            });
            await st.switching;
            if (st.cfgKey !== cfg.key) return NOOP; // could not install: go without it
            continue;
        }
        st.waiters.set(cfg.key, (st.waiters.get(cfg.key) || 0) + 1);
        await new Promise(resolve => {
            const t = setTimeout(resolve, 2000); // safety net: re-evaluate periodically
            st.idle.push(() => { clearTimeout(t); resolve(); });
        });
        const n = (st.waiters.get(cfg.key) || 1) - 1;
        if (n > 0) st.waiters.set(cfg.key, n); else st.waiters.delete(cfg.key);
    }
}

/** Install (or switch) the host's rule for media the player page loads itself (<video src>). */
async function ensureRefererRule(url, frameUrl) {
    const release = await acquireRefererRule(url, frameUrl).catch(() => NOOP);
    release();
}

async function directFetch(url, { method = 'GET', headers = {}, signal }, frameUrl) {
    const h = {};
    for (const [k, v] of Object.entries(headers)) {
        if (!/^(referer|origin|cookie|host)$/i.test(k)) h[k] = v;
    }
    const release = await acquireRefererRule(url, frameUrl).catch(() => NOOP);
    // A stalled connection must not hold a prefetch slot forever: time out waiting for the
    // response (the body itself may legitimately take long for big files). A timeout is a
    // retryable network error, not an abort.
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, PROXY_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(url, { method, headers: h, credentials: 'include', signal: ctl.signal, cache: 'no-store' });
    } catch (err) {
        if (timedOut && !(signal && signal.aborted)) throw new Error(`Direct fetch timeout (${PROXY_TIMEOUT_MS}ms)`);
        throw err;
    } finally {
        clearTimeout(timer);
        release(); // request headers are on the wire once the response started
    }
    try {
        const data = method === 'HEAD' ? new ArrayBuffer(0) : await res.arrayBuffer();
        const outHeaders = {};
        res.headers.forEach((v, k) => { outHeaders[k] = v; });
        return { status: res.status, headers: outHeaders, url: res.url || url, data };
    } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

/** Hosts that only answer requests made from inside the page (cookie/session-bound CDNs). */
const pageOnlyHosts = new Set();

/**
 * Transport, fastest path first:
 *  1. Direct fetch from the extension (host permission: no CORS; the site's Referer/Origin and
 *     auth headers are applied) - no content-script hop, no base64 round trips.
 *  2. If the server refuses (401/403/network), fetch through the frame that owns the stream
 *     (page cookies / session) and remember that this host needs it.
 */
function makeTransport(tabId, getStream) {
    return async (url, opts) => {
        // No create: a late request for a closed tab must not resurrect its state.
        const tab = await getTab(tabId, { create: false });
        const stream = getStream();
        const frameId = pickFrameId(tab, stream);
        const frameUrl = (stream && stream.frameUrl) || '';
        // Replay auth/token headers the site's player used for this host (Range stays ours).
        // Only headers captured from the same site as the stream's frame (never another site's).
        opts = { ...opts, headers: { ...capturedHeaders(url, frameUrl), ...(opts.headers || {}) } };
        let host = '';
        try { host = new URL(url).host; } catch (_) { /* opaque */ }

        const viaPage = async () => {
            try {
                return await proxyViaFrame(tabId, frameId, url, opts);
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                if (err.status) return { status: err.status, headers: {}, url, data: new ArrayBuffer(0) };
                throw err;
            }
        };

        if (!pageOnlyHosts.has(host)) {
            let direct = null;
            let directErr = null;
            try {
                direct = await directFetch(url, opts, frameUrl);
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                directErr = err;
            }
            if (direct && (direct.status < 400 || ![401, 403, 407, 451].includes(direct.status))) return direct;
            // Refused or blocked outside the page: retry inside it.
            try {
                const res = await viaPage();
                if (res.status < 400) pageOnlyHosts.add(host);
                return res;
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                if (direct) return direct;
                // Both paths failed: report both reasons (shown in the player's error message).
                if (directErr) err.message = `direct: ${directErr.message}; in page: ${err.message}`;
                throw err;
            }
        }
        try {
            return await viaPage();
        } catch (err) {
            if (err.name === 'AbortError' || !err.proxyUnavailable) throw err;
            return directFetch(url, opts, frameUrl); // frame gone: last resort
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
    if (details.tabId < 0) return;
    if (EXT_HOST && ((details.initiator && details.initiator.includes(EXT_HOST)) || (details.originUrl && details.originUrl.includes(EXT_HOST)))) return;
    // Any data request may be an extension-less manifest; the capture map is capped (LRU).
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
        // Site that issued the request: Chromium reports `initiator` (origin), Firefox
        // `originUrl`/`documentUrl`; the Referer is the last resort.
        info.site = siteOf(details.initiator && details.initiator !== 'null' ? details.initiator
            : (details.originUrl || details.documentUrl || info.referer || ''));
        const key = `${host}|${info.site}`;
        capturedByHostSite.delete(key); // refresh LRU position
        capturedByHostSite.set(key, info);
        latestCaptureByHost.delete(host);
        latestCaptureByHost.set(host, key);
        while (capturedByHostSite.size > MAX_CAPTURES) capturedByHostSite.delete(capturedByHostSite.keys().next().value);
        while (latestCaptureByHost.size > MAX_CAPTURES) latestCaptureByHost.delete(latestCaptureByHost.keys().next().value);
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
    if (/text\/vtt|x-subrip/i.test(ct) && !/(seg|segment|chunk|frag)[-_]?\d+/i.test(details.url)) {
        addSubtitle(details.tabId, details.frameId, details.documentUrl || details.initiator || '', { url: details.url, mime: ct, method: 'network' });
        return;
    }
    const type = S.classifyStream(details.url, ct);
    if (type !== 'hls' && type !== 'dash') return;
    handleDetection(details.tabId, details.frameId, details.documentUrl || details.initiator || '', {
        url: details.url, type, method: 'network', mime: ct
    });
}, { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] }, ['responseHeaders']);

// ============================================================================
// PLAYER SESSIONS
// ============================================================================
const SESSION_PLAYLIST_TEXT_MAX = 1_000_000; // larger VOD playlists are stored as URL only
const SESSION_TEXT_BUDGET = 3_000_000;       // all stored playlist texts of one session
const SESSION_MAX_PLAYLISTS = 48;
const sessionKey = (id) => `session_${id}`;

function removeSessionState(id) {
    api.storage.session.remove([sessionKey(id), `${sessionKey(id)}_texts`]).catch(() => { });
}

/**
 * Worker restart with the player still open: the new Session's downloader knows nothing (Shaka
 * already has its playlists and will not reload VOD ones). Re-teach it from storage.session:
 * stored texts are ingested synchronously; live / oversized playlists are re-fetched by URL in
 * the background (a live playlist from before the restart would be stale anyway).
 */
async function restoreSessionState(session) {
    const key = sessionKey(session.id);
    const res = await api.storage.session.get([key, `${key}_texts`]).catch(() => ({}));
    const meta = res && res[key];
    if (!meta || session.closing) return false;
    const texts = (res && res[`${key}_texts`]) || {};
    const d = session.downloader;

    session.abrAuto = meta.abrAuto !== false;
    session.activeVariantId = meta.activeVariantId ?? null;
    if (typeof meta.qualityCap === 'number') {
        session.qualityCap = meta.qualityCap;
        session.abr.setMaxHeight(meta.qualityCap);
    }
    if (!session.abrAuto && session.activeVariantId !== null) session.abr.lockQuality(session.activeVariantId);
    if (meta.recording && typeof meta.recording.startedAt === 'number') session.recording = meta.recording;

    const list = Array.isArray(meta.playlists) ? meta.playlists : [];
    // Roles first: a media playlist is filed under the role known when it is ingested.
    // (roles / playlists are the downloader's own maps; guarded in case its internals change)
    if (d.roles instanceof Map) for (const p of list) if (p.role && !d.roles.has(p.url)) d.roles.set(p.url, p.role);
    const applyCursor = (p) => {
        const entry = d.playlists instanceof Map ? d.playlists.get(p.url) : null;
        if (!entry || typeof p.cursorSeq !== 'number') return;
        const n = entry.parsed.segments.length;
        if (!n) return;
        entry.cursor = Math.max(0, Math.min(n - 1, p.cursorSeq - entry.parsed.mediaSequence));
        entry.lastUsed = p.lastUsed || Date.now();
    };
    const ingest = (p, text) => {
        try {
            if (d.ingestPlaylist(p.url, text)) applyCursor(p);
        } catch (_) { /* corrupt entry */ }
    };
    const refetch = [];
    for (const p of list) {
        if (typeof texts[p.url] === 'string') ingest(p, texts[p.url]);
        else refetch.push(p);
    }
    if (refetch.length) {
        (async () => {
            const fetchOne = async (p) => {
                try {
                    const r = await d.transport(p.url, { method: 'GET', headers: {} });
                    if (session.closing || r.status >= 400 || !r.data) return;
                    ingest(p, new TextDecoder().decode(r.data));
                } catch (_) { /* the player will reload it (live) or prefetch stays off (VOD) */ }
            };
            // Masters first (roles of their renditions), then media playlists in parallel.
            for (const p of refetch.filter(x => x.type === 'master')) await fetchOne(p);
            await Promise.all(refetch.filter(x => x.type !== 'master').map(fetchOne));
            if (!session.closing) d.schedulePump();
        })();
    }
    d.schedulePump();
    return true;
}

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

        this.buffer = new BufferManager(tabId, id, {
            capBytes: settings.cacheSizeMB * 1024 * 1024,
            isProtected: key => this.downloader.isProtected(key)
        });
        this.buffer.init().catch(err => console.warn('[Engine] Buffer init failed:', err));
        this.persistTimer = null;
        this.lastPersistAt = 0;
        this.setupPipeline();

        this.statsTimer = setInterval(() => this.pushStats(), 1000);
        this.abrTimer = setInterval(() => this.runAbr(), 2000);
    }

    /** Fresh ABR + downloader for the current stream (construction and stream switches). */
    setupPipeline() {
        this.abr = new ABRController();
        this.abr.setMaxHeight(this.qualityCap ?? settings.qualityCap);
        this.downloader = new SegmentDownloader({
            transport: makeTransport(this.tabId, () => this.stream),
            buffer: this.buffer,
            abr: this.abr,
            getSettings: () => settings
        });
        // Observe every playlist the downloader learns (player manifest loads go through
        // downloader.load -> ingestPlaylist) so it can be re-taught after a worker restart.
        this.playlistLog = new Map(); // url -> {url, type, live, text|null}
        this.textsDirty = false;
        const ingest = this.downloader.ingestPlaylist.bind(this.downloader);
        this.downloader.ingestPlaylist = (url, text) => {
            const parsed = ingest(url, text);
            if (parsed && !this.closing) this.notePlaylist(url, text, parsed);
            return parsed;
        };
    }

    /**
     * Play another stream of the same tab in this session without remounting the player: stop
     * everything in flight, drop this session's cached segments and start a fresh pipeline.
     */
    async switchStream(stream) {
        if (this.exportJob) this.exportJob.controller.abort();
        this.recording = null;
        for (const c of this.requests.values()) { try { c.abort(); } catch (_) { /* gone */ } }
        this.requests.clear();
        this.downloader.destroy();
        await this.buffer.clearStream().catch(() => { });
        if (this.closing) return;
        this.stream = stream;
        this.abrAuto = true;
        this.activeVariantId = null;
        this.setupPipeline();
        this.persistState({ soon: true });
        if (stream.type === 'progressive') await ensureRefererRule(stream.url, stream.frameUrl || '').catch(() => { });
    }

    notePlaylist(url, text, parsed) {
        const live = parsed.type === 'media' && !!parsed.live;
        // Live playlists change every few seconds: store the URL only and re-fetch on restore.
        // Huge VOD playlists also go URL-only (storage.session is small and shared).
        const keepText = !live && typeof text === 'string' && text.length <= SESSION_PLAYLIST_TEXT_MAX;
        const entry = { url, type: parsed.type, live, text: keepText ? text : null };
        const prev = this.playlistLog.get(url);
        if (prev && prev.type === entry.type && prev.live === entry.live && prev.text === entry.text) {
            if (!live) return; // nothing new
        } else {
            this.playlistLog.delete(url);
            this.playlistLog.set(url, entry);
            while (this.playlistLog.size > SESSION_MAX_PLAYLISTS) this.playlistLog.delete(this.playlistLog.keys().next().value);
            this.textsDirty = true;
        }
        // First save right away: a worker restart in the first second must not lose the playlists.
        this.persistState({ soon: !this.lastPersistAt });
    }

    /** Debounced write of everything needed to rebuild this session after a worker restart. */
    persistState({ soon = false } = {}) {
        if (this.closing) return;
        clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            if (this.closing || !sessions.has(this.id)) return;
            this.lastPersistAt = Date.now();
            const d = this.downloader;
            const playlists = [];
            for (const p of this.playlistLog.values()) {
                const entry = d.playlists instanceof Map ? d.playlists.get(p.url) : null;
                playlists.push({
                    url: p.url,
                    type: p.type,
                    live: p.live,
                    role: (entry && entry.role) || (d.roles instanceof Map && d.roles.get(p.url)) || null,
                    cursorSeq: entry && entry.cursor >= 0 ? entry.parsed.mediaSequence + entry.cursor : null,
                    lastUsed: (entry && entry.lastUsed) || 0
                });
            }
            const key = sessionKey(this.id);
            const data = {
                [key]: {
                    tabId: this.tabId,
                    streamId: this.stream.id,
                    abrAuto: this.abrAuto,
                    activeVariantId: this.activeVariantId,
                    qualityCap: this.qualityCap,
                    recording: this.recording || null,
                    playlists
                }
            };
            if (this.textsDirty) {
                this.textsDirty = false;
                const texts = {};
                let used = 0;
                // Masters first (they carry the roles), then media, within the budget.
                const ordered = [...this.playlistLog.values()].sort((a, b) => (a.type === 'master' ? 0 : 1) - (b.type === 'master' ? 0 : 1));
                for (const p of ordered) {
                    if (!p.text || used + p.text.length > SESSION_TEXT_BUDGET) continue;
                    used += p.text.length;
                    texts[p.url] = p.text;
                }
                // Separate write: if the texts exceed the quota, the state above still lands
                // (restore then re-fetches those playlists by URL).
                api.storage.session.set({ [`${key}_texts`]: texts }).catch(() => { });
            }
            api.storage.session.set(data).catch(() => { });
        }, soon ? 50 : 1000);
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
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
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
    removeSessionState(session.id);
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
            signal: controller.signal,
            zeroCopy: !!msg.zeroCopy
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
            // Cached segments are read by the player straight from IndexedDB (no copy).
            inCache: !!res.inCache,
            cacheKey: res.cacheKey,
            data: res.inCache ? null : S.packBinary(res.data)
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

/**
 * Live recording: remember, for every playlist in use, the media sequence at "record" time
 * (audio and video renditions number their segments independently), plus wall-clock /
 * program-date-time anchors for playlists that only show up later (track switch).
 */
function startRecording(session) {
    const d = session.downloader;
    const main = d.mainPlaylist();
    if (!main || !main.parsed.live) {
        session.post({ type: 'EXPORT_ERROR', error: 'Recording is for live streams. Use Export for on-demand video.' });
        return;
    }
    if (!main.dvr) {
        // Without the DVR ring only the server's current window (often 30-60 s) is kept, so a
        // longer recording would be silently cut down to its last minute.
        session.post({ type: 'EXPORT_ERROR', error: 'Recording needs live rewind. Set "Live rewind (DVR)" in the popup settings to a duration; low-latency streams do not support it.' });
        return;
    }
    const fromSeqByUrl = {};
    let startPdt = null;
    let behindEdgeSec = 0;
    for (const p of new Set([main, ...d.activePlaylists()])) {
        if (!p.parsed.live) continue;
        const segs = p.parsed.segments;
        const idx = segs[Math.max(0, p.cursor)] ? Math.max(0, p.cursor) : segs.length - 1;
        const cur = segs[idx];
        fromSeqByUrl[p.url] = cur ? cur.seq : p.parsed.mediaSequence;
        if (p === main && cur) {
            startPdt = segmentPdts(segs)[idx];
            behindEdgeSec = segs.slice(idx).reduce((t, s) => t + (s.duration || 0), 0);
        }
    }
    session.recording = { fromSeqByUrl, startPdt, behindEdgeSec, startedAt: Date.now() };
    session.persistState({ soon: true });
    session.post({ type: 'RECORD_STARTED', startedAt: session.recording.startedAt });
}

/** Program-date-time (ms) of every segment, carried forward across segments without the tag. */
function segmentPdts(segs) {
    const out = new Array(segs.length).fill(null);
    let t = null;
    for (let i = 0; i < segs.length; i++) {
        if (typeof segs[i].programDateTime === 'number') t = segs[i].programDateTime;
        out[i] = t;
        if (t !== null) t += (segs[i].duration || 0) * 1000;
    }
    return out;
}

/** Segments of one playlist that belong to the recording. */
function recordingSegments(rec, playlist, segs) {
    const from = rec.fromSeqByUrl && rec.fromSeqByUrl[playlist.url];
    if (typeof from === 'number') return segs.filter(s => s.seq >= from);
    // Playlist unknown at "record" time: match by program-date-time when both sides have it...
    if (typeof rec.startPdt === 'number') {
        const pdts = segmentPdts(segs);
        if (pdts.some(t => t !== null)) {
            // Keep the segment that contains the start instant (ends after it).
            return segs.filter((s, i) => pdts[i] !== null && pdts[i] + (s.duration || 0) * 1000 > rec.startPdt + 100);
        }
    }
    // ...else approximate: the same amount of media back from the live edge as the main
    // playlist had at "record" time plus the wall-clock time recorded since.
    const want = (rec.behindEdgeSec || 0) + Math.max(0, (Date.now() - rec.startedAt) / 1000);
    let total = 0;
    let i = segs.length;
    while (i > 0 && total < want - 0.05) {
        i--;
        total += segs[i].duration || 0;
    }
    return segs.slice(i);
}

async function runExport(session, opts = {}) {
    if (session.exportJob) {
        session.post({ type: 'EXPORT_ERROR', error: 'An export is already running. Wait for it to finish or cancel it.' });
        return false;
    }
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
                if (opts.recording) segs = recordingSegments(opts.recording, parts[i], segs);
                if (opts.clip) {
                    // A-B clip: the range is in player time; segment starts are playlist time.
                    // Whole segments overlapping [start, end] are kept (cuts land on segment
                    // boundaries, which are keyframes, so no re-encoding is needed).
                    const off = typeof d.timelineOffset === 'function' ? (d.timelineOffset(parts[i]) || 0) : 0;
                    const { start, end } = opts.clip;
                    segs = segs.filter(s => Number.isFinite(s.start) && s.start + off < end && s.start + off + (s.duration || 0) > start);
                    if (!segs.length) throw new Error('No segments in the A–B range. Play through it once, then try again.');
                }
                const suffix = `${opts.recording ? '-recording' : ''}${opts.clip ? '-clip' : ''}${parts.length > 1 ? (i === 0 ? '-video' : '-audio') : ''}`;
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
    return true;
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

    post({ type: 'EXPORT_BEGIN', fileIndex, fileCount, filename: `${name}.${ext}`, mime, container: isFmp4 ? 'fmp4' : (ext === 'aac' ? 'aac' : 'ts'), role: playlist.role || 'main' });
    let lastMap = null;
    const LOOKAHEAD = 4;
    const pending = new Map();
    const startFetch = (i) => {
        if (i >= segs.length || pending.has(i)) return;
        const seg = segs[i];
        const p = (async () => {
            // Encrypted segments come back as raw ciphertext (the downloader must not sniff or
            // trim them): decrypt first, then strip any disguise header from the plaintext.
            let data = await session.downloader.fetchForExport(seg, signal);
            if (seg.key && seg.key.method === 'AES-128') {
                data = await decryptAes128(data, await getKey(seg.key.uri), ivForSegment(seg));
            }
            const sniff = sniffMedia(data);
            return sniff && sniff.offset ? data.slice(sniff.offset) : data;
        })();
        p.catch(() => { }); // awaited in order below; avoid unhandled rejections past a failure
        pending.set(i, p);
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
            const initSniff = sniffMedia(init.data);
            const initData = initSniff && initSniff.offset ? init.data.slice(initSniff.offset) : init.data;
            post({ type: 'EXPORT_CHUNK', fileIndex, kind: 'init', data: S.packBinary(initData) });
            bytes += initData.byteLength;
            lastMap = seg.map;
        }
        const data = await pending.get(i);
        pending.delete(i);
        bytes += data.byteLength;
        post({ type: 'EXPORT_CHUNK', fileIndex, kind: 'seg', start: seg.start || 0, end: (seg.start || 0) + (seg.duration || 0), url: seg.uri, data: S.packBinary(data) });
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
            for (let k = i; k < Math.min(i + 4, offsets.length); k++) {
                if (pending.has(k)) continue;
                const p = fetchChunk(offsets[k]);
                p.catch(() => { }); // awaited in order; no unhandled rejection after a failure
                pending.set(k, p);
            }
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
    if (port.name !== 'velostream-player') return;
    const tabId = port.sender && port.sender.tab ? port.sender.tab.id : -1;
    let session = null;
    // Messages that arrive while HELLO is still attaching the session (the player resends its
    // in-flight requests right after a reconnect) wait for it instead of being dropped.
    let hello = null;

    port.onMessage.addListener(async (msg) => {
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'HELLO') {
            hello = attach(msg).catch(e => console.warn('[Engine] attach failed:', e && e.message));
            return;
        }
        if (hello) await hello;
        // A throw (e.g. malformed TELEMETRY variants) must not become an unhandled rejection.
        handle(msg).catch(e => console.warn('[Engine] message failed:', msg.type, e && e.message));
    });
    // The port can die while attach() is still awaiting; attach must then not adopt it.
    let disconnected = false;

    async function attach(msg) {
        {
            await settingsReady;
            const tab = await getTab(tabId);
            // Reattach (bridge reconnect after SW restart or transient disconnect).
            session = sessions.get(msg.sessionId) || null;
            if (!session) {
                // The player's URL names the stream it opened with; after an in-place switch the
                // persisted session state knows the current one.
                let streamId = msg.streamId;
                if (msg.resumed) {
                    const key = sessionKey(msg.sessionId);
                    const meta = (await api.storage.session.get(key).catch(() => ({})))[key];
                    if (meta && meta.streamId && tab.streams.has(meta.streamId)) streamId = meta.streamId;
                }
                const stream = tab.streams.get(streamId);
                if (!stream || (tab.playerSessionId && tab.playerSessionId !== msg.sessionId)) {
                    port.postMessage({ type: 'FATAL', error: 'Stream session not found. Re-open the player from the popup.' });
                    return;
                }
                session = new Session({ id: msg.sessionId, tabId, stream });
                sessions.set(session.id, session);
                tab.playerSessionId = session.id;
                persistTab(tabId);
                // Worker restart: re-teach the downloader the playlists Shaka already holds.
                if (msg.resumed) await restoreSessionState(session).catch(e => console.warn('[Engine] Session restore failed:', e && e.message));
            }
            if (session.closing) return;
            if (disconnected) {
                // The player went away mid-attach: onDisconnect saw no port to clear, so start the
                // grace timer here (the session would otherwise leak with its timers running).
                if (!session.port) {
                    clearTimeout(session.disconnectTimer);
                    session.disconnectTimer = setTimeout(() => { if (!session.port) endSession(session, { clearCache: true, restoreMedia: false }); }, RECONNECT_GRACE_MS);
                }
                return;
            }
            clearTimeout(session.disconnectTimer);
            session.port = port;
            // Direct media files are loaded by the player page's <video>: give those requests
            // the site's Referer/Origin so hot-link protection accepts them.
            if (session.stream.type === 'progressive') await ensureRefererRule(session.stream.url, session.stream.frameUrl || '');
            const pageUrl = await api.tabs.get(tabId).then(t => (t && t.url) || '', () => '');
            session.post({ type: 'INIT', sessionId: session.id, tabId: session.tabId, stream: session.stream, resumed: !!msg.resumed, subtitles: tab.subtitles || [], drm: tab.drm || null, pageUrl, streams: streamSummaries(tab) });
        }
    }

    async function handle(msg) {
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
                    paused: !!msg.paused,
                    // Start of Shaka's seek range (live window / DVR): optional, used by the downloader.
                    seekRangeStart: Number.isFinite(+msg.seekRangeStart) && msg.seekRangeStart !== null ? +msg.seekRangeStart : undefined,
                    // Lets the downloader skip timeline-offset samples taken mid-seek (bug 12).
                    seeking: !!msg.seeking
                };
                session.downloader.updatePlayback(session.telemetry);
                if (Array.isArray(msg.variants)) session.abr.setProfiles(msg.variants);
                let stateChanged = false;
                if (msg.activeVariantId !== undefined) {
                    stateChanged = stateChanged || session.activeVariantId !== msg.activeVariantId;
                    session.activeVariantId = msg.activeVariantId;
                    session.abr.setActive(msg.activeVariantId);
                }
                if (typeof msg.qualityCap === 'number') {
                    stateChanged = stateChanged || session.qualityCap !== msg.qualityCap;
                    session.qualityCap = msg.qualityCap;
                    session.abr.setMaxHeight(msg.qualityCap);
                }
                // Keep the stored cursors reasonably fresh without writing every second.
                if (stateChanged || Date.now() - session.lastPersistAt > 10000) {
                    if (!session.persistTimer) session.persistState();
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
                    if (msg.variantId !== undefined) session.activeVariantId = msg.variantId;
                }
                session.persistState({ soon: true });
                break;
            case 'PREFETCH':
                if (msg.enabled) session.downloader.resume(); else session.downloader.pause();
                break;
            case 'PURGE_CACHE': {
                // Drop every cached segment of this stream and refill from the playhead.
                session.downloader.reset();
                await session.buffer.clearStream().catch(() => { });
                session.downloader.seek(+msg.time || (session.telemetry && session.telemetry.currentTime) || 0);
                session.post({ type: 'PURGED', time: +msg.time || 0 });
                break;
            }
            case 'SWITCH_STREAM': {
                const tab = await getTab(session.tabId);
                const next = tab.streams.get(msg.streamId);
                if (!next) { session.post({ type: 'SWITCH_FAILED', error: 'That stream is no longer available. Rescan the page.' }); break; }
                if (next.id !== session.stream.id) await session.switchStream(next);
                if (session.closing) break;
                session.post({ type: 'STREAM_SWITCHED', stream: session.stream, streams: streamSummaries(tab) });
                break;
            }
            case 'FIND_FRESH': {
                // Signed/expiring links: has the page requested the same video again since (new
                // token in the query)? Same host + path, different URL, detected later.
                const tab = await getTab(session.tabId);
                let fresh = null;
                try {
                    const want = new URL(msg.url);
                    for (const s of tab.streams.values()) {
                        if (s.url === msg.url || s.isAd) continue;
                        const u = new URL(s.url);
                        if (u.host !== want.host || u.pathname !== want.pathname) continue;
                        if (!fresh || s.detectedAt > fresh.detectedAt) fresh = s;
                    }
                } catch (_) { /* opaque URL */ }
                if (fresh && fresh.detectedAt <= (msg.since || 0)) fresh = null;
                session.post({ type: 'FRESH', reqId: msg.reqId, url: fresh ? fresh.url : null });
                break;
            }
            case 'EXPORT_START': {
                const clip = msg.clip && Number.isFinite(+msg.clip.start) && Number.isFinite(+msg.clip.end) && +msg.clip.end > +msg.clip.start
                    ? { start: +msg.clip.start, end: +msg.clip.end } : null;
                if (clip && session.stream.type !== 'hls') {
                    session.post({ type: 'EXPORT_ERROR', error: 'A–B clips can be saved from HLS streams only.' });
                    break;
                }
                runExport(session, clip ? { clip } : {});
                break;
            }
            case 'RECORD_START':
                startRecording(session);
                break;
            case 'RECORD_STOP': {
                const rec = session.recording;
                if (!rec) break;
                if (session.exportJob) {
                    // Keep recording: the user can stop again once the running export is done.
                    session.post({ type: 'EXPORT_ERROR', error: 'An export is already running. Stop the recording again when it has finished.' });
                    break;
                }
                session.recording = null;
                session.persistState({ soon: true });
                runExport(session, { recording: rec });
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
    }

    port.onDisconnect.addListener(() => {
        disconnected = true;
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
    persistTab(tabId);
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
        case 'SUBTITLE_FOUND':
            if (fromTab !== undefined) addSubtitle(fromTab, sender.frameId ?? 0, sender.url || '', message.payload);
            return false;
        case 'DRM_DETECTED':
            if (fromTab !== undefined) getTab(fromTab).then(tab => {
                tab.drm = { keySystem: String((message.payload && message.payload.keySystem) || '').slice(0, 80), frameId: sender.frameId ?? 0 };
                persistTab(fromTab);
                notifyFrames(fromTab);
            }).catch(() => { });
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
                    drm: tab.drm || null,
                    // MSE playback with no manifest on the wire: a proprietary protocol (YouTube's
                    // SABR/UMP, Netflix, ...) that only the site's own player can drive.
                    proprietaryMse: tab.mseFrames.size > 0 && !list.some(s => !s.isAd),
                    subtitles: (tab.subtitles || []).length,
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
        tab.autoLaunched = false; // new page: auto-replace may run again
        persistTab(tabId);
    } else {
        tabs.delete(tabId);
        clearTimeout(persistTimers.get(tabId));
        persistTimers.delete(tabId);
        subsDirty.delete(tabId);
        api.storage.session.remove([tabKey(tabId), tabSubsKey(tabId)]).catch(() => { });
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
        // Same-URL reload: drop streams (they will be re-detected) and the cache. getTab also
        // restores a tab the idle worker forgot, so a reload after a restart still resets it.
        getTab(tabId, { create: false }).then(tab => { if (tab && !tab.playerSessionId) teardownTab(tabId); }).catch(() => { });
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
        const tabIdOf = (k) => parseInt(k.slice(k.indexOf('_') + 1), 10);
        const stale = Object.keys(stored).filter(k => (k.startsWith('tab_') || k.startsWith('tabsubs_')) && !live.has(tabIdOf(k)));
        // Session state: keep only the session its (live) tab still points at. Sessions alive in
        // this worker are never touched (onInstalled/onStartup may run this again later).
        for (const k of Object.keys(stored)) {
            if (!k.startsWith('session_')) continue;
            const id = k.slice(8).replace(/_texts$/, '');
            if (sessions.has(id)) continue;
            const meta = stored[`session_${id}`];
            const tabState = meta && stored[`tab_${meta.tabId}`];
            if (!meta || !live.has(meta.tabId) || !tabState || tabState.playerSessionId !== id) stale.push(k);
        }
        if (stale.length) await api.storage.session.remove(stale);
    } catch (e) {
        console.warn('[Engine] Startup sweep failed:', e && e.message);
    }
}

// Read-only diagnostics handle (inspect from the service-worker devtools console).
globalThis.VelostreamEngine = Object.freeze({ tabs, sessions, launchPlayer: (tabId, streamId, frameId) => launchPlayer(tabId, streamId, frameId) });

api.runtime.onStartup && api.runtime.onStartup.addListener(startupSweep);
api.runtime.onInstalled.addListener(startupSweep);
startupSweep();
