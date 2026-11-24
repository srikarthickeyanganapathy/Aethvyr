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
import { checkpoint, downloadStore, validateExportRange } from './download-store.js';
import { ABRController } from './abr-controller.js';
import { parsePlaylist, ivForSegment, decryptAes128 } from './hls-parser.js';
import { initSync } from './sync.js';

const S = globalThis.VelostreamShared;
const api = S.api;
let storageWrites = Promise.resolve();
function writeStorage(operation) {
    const run = storageWrites.then(operation);
    storageWrites = run.catch(() => { });
    return run;
}

// Opt-in cross-device sync (browser account storage.sync). Started synchronously so its
// storage/message listeners exist on every service-worker wake; it is inert unless
// settings.syncEnabled is true and never throws into the engine.
try { initSync({ api, S, writeStorage }); } catch (e) { console.warn('[Engine] sync unavailable:', e && e.message); }

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
const closedTabs = new Set();
const activeExports = new Set();
const sessions = new Map(); // sessionId -> Session
const persistTimers = new Map();
const tabClears = new Map();
const resumeRequests = new Map();

function newTabState(tabId) {
    return {
        tabId,
        streams: new Map(),
        byUrl: new Map(),
        children: new Set(),       // variant/rendition playlists of a known master (hidden in popup)
        mseFrames: new Map(),      // frameId -> last MSE_INIT timestamp
        videoFrames: new Set(),    // frames with a <video> element
        pageUrl: '',
        pageMeta: null,
        routeVersion: 0,
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
    if (tabClears.has(tabId)) await tabClears.get(tabId);
    let tab = tabs.get(tabId);
    if (tab) return tab;
    // Restore after a service-worker / event-page restart.
    const key = tabKey(tabId);
    const subsKey = tabSubsKey(tabId);
    const res = await api.storage.session.get([key, subsKey]).catch(() => ({}));
    if (tabClears.has(tabId)) {
        await tabClears.get(tabId);
        return getTab(tabId, { create });
    }
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
        tab.pageUrl = stored.pageUrl || '';
        tab.pageMeta = stored.pageMeta || null;
        tab.staleStreamId = stored.staleStreamId || null;
        tab.activeStreamId = stored.activeStreamId || null;
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
                activeStreamId: tab.activeStreamId || null,
                mseFrames: [...tab.mseFrames.entries()].slice(-32),
                videoFrames: [...tab.videoFrames].slice(-32),
                pageUrl: tab.pageUrl,
                pageMeta: tab.pageMeta,
                staleStreamId: tab.staleStreamId || null,
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
    const list = [...tab.streams.values()].filter(s => !tab.children.has(s.url) && s.id !== tab.staleStreamId);
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

// Chromium's callback reads runtime.lastError even if the tab closes during the API call.
function setTabAction(method, options) {
    if (S.IS_FIREFOX) return api.action[method](options);
    const chromium = globalThis.chrome || api;
    return new Promise(resolve => chromium.action[method](options, () => {
        resolve(!chromium.runtime.lastError);
    }));
}

async function updateIcon(tabId) {
    if (closedTabs.has(tabId)) return;
    const tab = tabs.get(tabId);
    const count = tab ? visibleStreams(tab).length : 0;
    try {
        const icon = await setTabAction('setIcon', { tabId, path: count ? ICONS_ACTIVE : ICONS_IDLE });
        if (icon === false || closedTabs.has(tabId)) return;
        const badge = await setTabAction('setBadgeText', { tabId, text: count ? String(Math.min(count, 99)) : '' });
        if (count && badge !== false && !closedTabs.has(tabId)) await setTabAction('setBadgeBackgroundColor', { tabId, color: '#0B6E4F' });
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
    if (closedTabs.has(tabId)) return;
    clearTimeout(notifyTimers.get(tabId));
    notifyTimers.set(tabId, setTimeout(() => {
        notifyTimers.delete(tabId);
        if (closedTabs.has(tabId)) return;
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
    if (closedTabs.has(tabId) || !sub || (!sub.url && !sub.vtt)) return;
    const tab = await getTab(tabId);
    if (closedTabs.has(tabId)) { if (tabs.get(tabId) === tab) tabs.delete(tabId); return; }
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
    if (tabId === undefined || tabId < 0 || closedTabs.has(tabId) || !payload) return null;
    const tab = await getTab(tabId);
    if (closedTabs.has(tabId)) { if (tabs.get(tabId) === tab) tabs.delete(tabId); return null; }

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
        if (existingId !== tab.staleStreamId || payload.method === 'dom_scan') {
            if (resumeRequests.has(tabId)) scheduleLibraryResume(tabId);
            return existing || null;
        }
        // A fresh network request can reuse the exact same manifest URL on a new episode.
        tab.byUrl.delete(url);
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
    if (!stream.isAd && payload.method !== 'manual') {
        if (tab.staleStreamId) scheduleEpisodeSwitch(tab);
        else if (resumeRequests.has(tabId)) scheduleLibraryResume(tabId);
        else maybeAutoLaunch(tab, stream);
    }
    return stream;
}

/**
 * Auto-replace (per-site opt-in from the popup): the first real stream detected on an enabled
 * site opens in Velostream automatically, once per page load. Waits briefly so the master
 * playlist probe can win over its variant playlists.
 */
function scheduleEpisodeSwitch(tab) {
    if (tab.episodeTimer) return;
    const version = tab.routeVersion;
    tab.episodeTimer = setTimeout(() => {
        tab.episodeTimer = null;
        const session = sessions.get(tab.playerSessionId);
        if (tabs.get(tab.tabId) !== tab || tab.routeVersion !== version || !tab.staleStreamId || !session?.port) return;
        const next = visibleStreams(tab).find(s => !s.isAd && (s.frameId === session.stream.frameId || session.stream.frameId < 0));
        if (next) switchEpisode(session, tab, next).catch(() => { });
    }, 600);
}

async function switchEpisode(session, tab, next) {
    if (session.switching || session.closing) return;
    session.switching = true;
    const version = tab.routeVersion;
    const previous = session.stream;
    try {
        await session.switchStream(next);
        if (session.closing || tab.routeVersion !== version) return;
        if (tab.staleStreamId === previous.id) {
            tab.streams.delete(previous.id);
            if (tab.byUrl.get(previous.url) === previous.id) tab.byUrl.delete(previous.url);
            tab.staleStreamId = null;
            api.tabs.sendMessage(tab.tabId, { action: 'SUSPEND_MEDIA' }).catch(() => { });
        }
        tab.activeStreamId = next.id;
        session.post({
            type: 'STREAM_SWITCHED', stream: next, streams: streamSummaries(tab), pageUrl: tab.pageUrl,
            pageMeta: tab.pageMeta, subtitles: tab.subtitles, drm: tab.drm
        });
        persistTab(tab.tabId);
        notifyFrames(tab.tabId);
    } finally {
        session.switching = false;
        if (tab.routeVersion !== version && !session.closing) scheduleEpisodeSwitch(tab);
    }
}

async function maybeAutoLaunch(tab, stream) {
    // autoLaunchPending: several streams are usually detected in the same burst; only the first
    // may run the (async) host check, or two launches would race and end each other's session.
    if (tab.autoLaunched || tab.autoLaunchPending || tab.playerSessionId || !settings.autoSites.length) return;
    const routeVersion = tab.routeVersion;
    const current = () => tabs.get(tab.tabId) === tab && tab.routeVersion === routeVersion;
    tab.autoLaunchPending = true;
    try {
        // Match the top page's host *and* the embedding frame's host: the stream is often found
        // inside a third-party player iframe while the user enabled the outer site (or vice versa).
        const hosts = new Set();
        try { hosts.add(new URL((await api.tabs.get(tab.tabId)).url).hostname); } catch (_) { /* tab gone */ }
        try { if (stream && stream.frameUrl) hosts.add(new URL(stream.frameUrl).hostname); } catch (_) { /* opaque */ }
        const sites = settings.autoSites.map(h => String(h).toLowerCase());
        const match = [...hosts].some(h => sites.some(s => h === s || h.endsWith(`.${s}`)));
        if (!current() || !match || tab.autoLaunched || tab.playerSessionId) return;
        tab.autoLaunched = true;
        persistTab(tab.tabId);
    } finally {
        if (current()) tab.autoLaunchPending = false;
    }
    setTimeout(() => {
        if (!current()) return;
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

const MAX_CAPTURES = 300;
const CAPTURE_KEY = 'fs_request_captures';
const CAPTURE_TTL = 15 * 60 * 1000;
const captureReady = api.storage.session.get(CAPTURE_KEY).then(res => {
    for (const [key, info] of res[CAPTURE_KEY] || []) {
        if (!capturedByHostSite.has(key) && Date.now() - info.at < CAPTURE_TTL) capturedByHostSite.set(key, info);
    }
}).catch(() => { });
let captureTimer;

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

/** Return a fresh capture from the site that owns the stream. */
function lookupCapture(host, frameUrl) {
    const site = httpOrigin(frameUrl) ? siteOf(frameUrl) : '';
    const capture = site && capturedByHostSite.get(`${host}|${site}`);
    return capture && Date.now() - capture.at < CAPTURE_TTL ? capture : null;
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
        signal?.removeEventListener('abort', onAbort);
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
const pageOnlyHosts = new Map();

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
        await captureReady;
        // Replay auth/token headers the site's player used for this host (Range stays ours).
        // Only headers captured from the same site as the stream's frame (never another site's).
        const directOptions = { ...opts, headers: { ...capturedHeaders(url, frameUrl), ...(opts.headers || {}) } };
        const pageHeaders = Object.fromEntries(Object.entries(opts.headers || {}).filter(([name]) => /^(range|accept|content-type)$/i.test(name)));
        let host = '';
        try { host = new URL(url).host; } catch (_) { /* opaque */ }

        const viaPage = async () => {
            try {
                return await proxyViaFrame(tabId, frameId, url, { ...opts, headers: pageHeaders });
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                if (err.status) return { status: err.status, headers: {}, url, data: new ArrayBuffer(0) };
                throw err;
            }
        };

        if ((pageOnlyHosts.get(host) || 0) <= Date.now()) {
            let direct = null;
            let directErr = null;
            try {
                direct = await directFetch(url, directOptions, frameUrl);
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                directErr = err;
            }
            if (direct && (direct.status < 400 || ![401, 403, 407, 451].includes(direct.status))) return direct;
            // Refused or blocked outside the page: retry inside it.
            try {
                const res = await viaPage();
                if (res.status < 400) {
                    pageOnlyHosts.delete(host);
                    pageOnlyHosts.set(host, Date.now() + 5 * 60 * 1000);
                    if (pageOnlyHosts.size > 100) pageOnlyHosts.delete(pageOnlyHosts.keys().next().value);
                }
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
    const routeVersion = tab.routeVersion;
    stream.probe = { status: 'pending' };
    tab.probing++;
    try {
        const transport = makeTransport(tab.tabId, () => stream);
        const res = await transport(stream.url, { method: 'GET', headers: {} });
        if (tab.routeVersion !== routeVersion || tabs.get(tab.tabId) !== tab) return;
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
    const info = { headers: {}, at: Date.now() };
    // Standard / browser-controlled headers are left alone; anything else (Authorization,
    // X-Playback-Session-Id, custom token headers...) is replayed on our requests to this host.
    const STANDARD = /^(host|cookie|origin|referer|user-agent|accept(-.*)?|connection|content-(length|type)|sec-.*|range|pragma|cache-control|if-.*|dnt|upgrade-insecure-requests|priority|te|keep-alive|proxy-.*)$/i;
    for (const h of details.requestHeaders || []) {
        const n = h.name.toLowerCase();
        if (n === 'referer') info.referer = h.value;
        else if (n === 'origin') info.origin = h.value;
        else if (!STANDARD.test(n) && h.value && h.value.length < 4096 && Object.keys(info.headers).length < 12) info.headers[h.name] = h.value;
    }
    if (info.referer || info.origin || Object.keys(info.headers).length) {
        // Site that issued the request: Chromium reports `initiator` (origin), Firefox
        // `originUrl`/`documentUrl`; the Referer is the last resort.
        info.site = siteOf(details.initiator && details.initiator !== 'null' ? details.initiator
            : (details.originUrl || details.documentUrl || info.referer || ''));
        if (!info.site) return;
        const key = `${host}|${info.site}`;
        capturedByHostSite.delete(key); // refresh LRU position
        capturedByHostSite.set(key, info);
        while (capturedByHostSite.size > MAX_CAPTURES) capturedByHostSite.delete(capturedByHostSite.keys().next().value);
        if (!captureTimer) captureTimer = setTimeout(async () => {
            await captureReady;
            captureTimer = null;
            const entries = [...capturedByHostSite].filter(([, value]) => Date.now() - value.at < CAPTURE_TTL).slice(-MAX_CAPTURES);
            api.storage.session.set({ [CAPTURE_KEY]: entries }).catch(() => { });
        }, 250);
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
        tab.activeStreamId = null;
        if (tab.staleStreamId === session.stream.id) {
            tab.streams.delete(session.stream.id);
            if (tab.byUrl.get(session.stream.url) === session.stream.id) tab.byUrl.delete(session.stream.url);
            tab.staleStreamId = null;
        }
        persistTab(session.tabId);
    }
    // Remove the player iframe if it is still mounted (closed from the popup, tab navigation...).
    api.tabs.sendMessage(session.tabId, { action: 'UNMOUNT_PLAYER', sessionId: session.id }).catch(() => { });
    if (restoreMedia) api.tabs.sendMessage(session.tabId, { action: 'RESTORE_MEDIA' }).catch(() => { });
    try { session.port && session.port.disconnect(); } catch (_) { /* already closed */ }
    if (tabs.has(session.tabId)) notifyFrames(session.tabId);
}

async function handleRequest(session, msg) {
    const controller = new AbortController();
    session.requests.get(msg.reqId)?.abort();
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
        if (session.requests.get(msg.reqId) === controller) session.requests.delete(msg.reqId);
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

/**
 * Validate a DASH export plan from the player: at most 2 parts (video, audio), http(s) URLs only,
 * finite times, well-formed byte ranges. Returns segments in the HLS export shape or null.
 */
function sanitizeDashPlan(plan) {
    const httpUrl = (u) => {
        if (typeof u !== 'string' || u.length > 4096) return null;
        try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch (_) { return null; }
    };
    const parts = Array.isArray(plan && plan.parts) ? plan.parts.slice(0, 2) : [];
    const out = [];
    for (const part of parts) {
        const role = part && part.role === 'audio' ? 'audio' : 'main';
        const list = Array.isArray(part && part.segs) ? part.segs : [];
        if (!list.length || list.length > 50000) return null;
        const segs = [];
        for (const s of list) {
            const uri = httpUrl(s && s.uri);
            if (!uri) return null;
            const range = typeof s.range === 'string' && /^bytes=\d+-\d*$/.test(s.range) ? s.range : null;
            let map = null;
            if (s.map) {
                const mu = httpUrl(s.map.uri);
                if (!mu) return null;
                const br = s.map.byteRange;
                const okRange = br && Number.isInteger(br.offset) && Number.isInteger(br.length) && br.offset >= 0 && br.length > 0;
                map = { uri: mu, byteRange: okRange ? { offset: br.offset, length: br.length } : null };
            }
            const start = Number.isFinite(+s.start) ? +s.start : 0;
            const duration = Number.isFinite(+s.duration) && +s.duration >= 0 ? +s.duration : 0;
            segs.push({ uri, range, start, duration, map });
        }
        const ext = ['mp4', 'm4a', 'webm', 'weba'].includes(part.ext) ? part.ext : (role === 'audio' ? 'm4a' : 'mp4');
        const mime = /^(video|audio)\/(mp4|webm)$/.test(part.mime) ? part.mime : (ext === 'webm' ? 'video/webm' : ext === 'weba' ? 'audio/webm' : role === 'audio' ? 'audio/mp4' : 'video/mp4');
        out.push({ role, segs, ext, mime });
    }
    return out.length ? out : null;
}

async function runExport(session, opts = {}, saved = null) {
    if (session.exportJob || (saved && activeExports.has(saved.id))) {
        session.post({ type: 'EXPORT_ERROR', error: 'An export is already running.' });
        return;
    }
    const controller = new AbortController();
    const jobId = saved?.id || crypto.randomUUID();
    session.exportJob = { id: jobId, controller };
    activeExports.add(jobId);
    const signal = controller.signal;
    const post = m => session.post({ ...m, jobId });
    let job = saved;
    try {
        const base = saved?.base || fileBaseName(session.stream);
        const progressive = session.stream.type === 'progressive';
        const parts = saved?.parts || exportParts(session, opts, base);
        if (!job && !opts.clip) {
            job = { id: jobId, stream: session.stream, tabId: session.tabId, base, parts,
                totalSegments: parts.reduce((count, part) => count + part.segs.length, 0),
                qualityUrl: parts[0]?.url || session.stream.url,
                bytes: 0, completedCount: 0, byteOffset: 0, status: 'paused' };
            await downloadStore.save(job);
        }
        const checkpointId = job?.id;
        if (progressive) await exportProgressive(session, post, signal, base, checkpointId);
        else {
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                await exportHlsPlaylist(session, part, part.segs, post, signal, part.name, i, parts.length, checkpointId, !!opts.clip);
            }
        }
        if (job) {
            const current = await downloadStore.get(job.id);
            await downloadStore.save({ ...current, status: 'cached' });
        }
        post({ type: 'EXPORT_COMPLETE' });
    } catch (err) {
        post({ type: 'EXPORT_ERROR', error: err.name === 'AbortError' ? (opts.clip ? 'Clip export cancelled' : 'Download paused. Resume from Offline / Cached.') : String(err.message || err) });
    } finally {
        controller.abort();
        activeExports.delete(jobId);
        session.exportJob = null;
    }
}

function exportParts(session, opts, base) {
    if (session.stream.type === 'progressive') return [];
    if (session.stream.type === 'dash' && opts.dash) {
        return opts.dash.map(part => ({ ...part,
            name: base + (opts.clip ? '-clip' : '') + (opts.dash.length > 1 ? (part.role === 'audio' ? '-audio' : '-video') : '')
        }));
    }
    if (session.stream.type !== 'hls') throw new Error('This stream cannot be saved.');
    const d = session.downloader;
    const main = d.mainPlaylist();
    if (!main) throw new Error('Playlist not loaded yet. Start playback first.');
    const playlists = [main];
    const audio = d.activePlaylists().find(p => p.role === 'audio' && p !== main);
    if (audio) playlists.push(audio);
    return playlists.map((playlist, i) => {
        let segs = d.exportSegments(playlist);
        if (opts.recording) segs = recordingSegments(opts.recording, playlist, segs);
        if (opts.clip) {
            const off = d.timelineOffset(playlist) || 0;
            const { start, end } = opts.clip;
            segs = segs.filter(s => Number.isFinite(s.start) && s.start + off < end && s.start + off + s.duration > start);
            if (!segs.length) throw new Error('No segments in the A–B range. Play through it once, then try again.');
        }
        const suffix = (opts.recording ? '-recording' : '') + (opts.clip ? '-clip' : '') +
            (playlists.length > 1 ? (i === 0 ? '-video' : '-audio') : '');
        return { role: playlist.role, url: playlist.url, name: base + suffix, segs };
    });
}

async function exportHlsPlaylist(session, playlist, segs, post, signal, name, fileIndex, fileCount, checkpointId, cacheOnly) {
    if (!segs.length) throw new Error('Nothing to save yet');
    if (segs.some(s => s.key && !['NONE', 'AES-128'].includes(s.key.method))) {
        throw new Error('This stream uses SAMPLE-AES/DRM encryption and cannot be exported.');
    }
    const isFmp4 = segs.some(s => s.map);
    const firstPath = (() => { try { return new URL(segs[0].uri).pathname; } catch (_) { return ''; } })();
    let ext = isFmp4 ? (playlist.role === 'audio' ? 'm4a' : 'mp4') : 'ts';
    let mime = isFmp4 ? (playlist.role === 'audio' ? 'audio/mp4' : 'video/mp4') : 'video/mp2t';
    if (!isFmp4 && /\.aac$/i.test(firstPath)) { ext = 'aac'; mime = 'audio/aac'; }
    if (playlist.ext) { ext = playlist.ext; mime = playlist.mime || mime; } // DASH: the player knows the container
    const webm = /^web/.test(ext);

    const keyCache = new Map();
    const getKey = async (uri) => {
        if (!keyCache.has(uri)) {
            keyCache.set(uri, session.downloader.fetchExportKey(uri, signal, cacheOnly));
        }
        return keyCache.get(uri);
    };

    post({ type: 'EXPORT_BEGIN', fileIndex, fileCount, filename: `${name}.${ext}`, mime, container: /^web/.test(ext) ? 'webm' : isFmp4 ? 'fmp4' : (ext === 'aac' ? 'aac' : 'ts'), role: playlist.role || 'main' });
    let lastMap = null;
    const LOOKAHEAD = 4;
    const pending = new Map();
    const startFetch = (i) => {
        if (i >= segs.length || pending.has(i)) return;
        const seg = segs[i];
        const p = checkpoint(downloadStore, checkpointId, `seg:${fileIndex}:${i}`, signal, async () => {
            // Encrypted segments come back as raw ciphertext (the downloader must not sniff or
            // trim them): decrypt first, then strip any disguise header from the plaintext.
            let data = await session.downloader.fetchForExport(seg, signal, { cacheOnly });
            if (seg.key && seg.key.method === 'AES-128') {
                data = await decryptAes128(data, await getKey(seg.key.uri), ivForSegment(seg));
            }
            const sniff = webm ? null : sniffMedia(data);
            return { data: sniff && sniff.offset ? data.slice(sniff.offset) : data };
        }).then(chunk => chunk.data);
        p.catch(() => { }); // awaited in order below; avoid unhandled rejections past a failure
        pending.set(i, p);
    };
    let bytes = 0;
    try {
        for (let i = 0; i < segs.length; i++) {
            for (let k = i; k < i + LOOKAHEAD; k++) startFetch(k);
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            const seg = segs[i];
            if (seg.map && (!lastMap || lastMap.uri !== seg.map.uri || JSON.stringify(lastMap.byteRange) !== JSON.stringify(seg.map.byteRange))) {
                const { data: initData } = await checkpoint(downloadStore, checkpointId, `init:${fileIndex}:${i}`, signal, async () => {
                    const range = seg.map.byteRange;
                    const data = await session.downloader.fetchForExport({
                        uri: seg.map.uri, range: range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : null
                    }, signal, { cacheOnly, keepOriginal: webm });
                    return { data };
                });
                await sendExportChunk(session, post, { fileIndex, kind: 'init', data: S.packBinary(initData) }, signal);
                bytes += initData.byteLength;
                lastMap = seg.map;
            }
            const data = await pending.get(i);
            pending.delete(i);
            bytes += data.byteLength;
            await sendExportChunk(session, post, { fileIndex, kind: 'seg', start: seg.start || 0, end: (seg.start || 0) + (seg.duration || 0), url: seg.uri, data: S.packBinary(data) }, signal);
            post({ type: 'EXPORT_PROGRESS', fileIndex, fileCount, done: i + 1, total: segs.length, bytes });
        }
    } catch (error) {
        session.exportJob.controller.abort();
        await Promise.allSettled(pending.values());
        throw error;
    }
    post({ type: 'EXPORT_FILE_DONE', fileIndex });
}

async function exportProgressive(session, post, signal, name, checkpointId) {
    const url = session.stream.url;
    const CHUNK = 4 * 1024 * 1024;
    let ext = 'mp4';
    const m = /\.(mp4|m4v|webm|mkv|mov|ogv)(\?|$)/i.exec(url);
    if (m) ext = m[1].toLowerCase();
    const mime = { webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', ogv: 'video/ogg' }[ext] || 'video/mp4';
    post({ type: 'EXPORT_BEGIN', fileIndex: 0, fileCount: 1, filename: `${name}.${ext}`, mime });
    let offset = 0;
    let total;
    let validator;
    for (;;) {
        const chunk = await checkpoint(downloadStore, checkpointId, `byte:${offset}`, signal, async () => {
            const headers = { Range: `bytes=${offset}-${offset + CHUNK - 1}` };
            if (validator) headers['If-Range'] = validator;
            const res = await session.downloader.fetchProgressiveRange(url, headers, signal);
            const reportedTotal = validateExportRange(res, offset, CHUNK, total);
            const etag = res.headers.etag;
            const identity = etag && !etag.startsWith('W/') ? etag : res.headers['last-modified'];
            if (validator && validator !== identity) throw new Error('The source file changed during export.');
            return { data: res.data, offset, total: reportedTotal, validator: identity };
        });
        total = chunk.total;
        validator ||= chunk.validator;
        await sendExportChunk(session, post, { fileIndex: 0, data: S.packBinary(chunk.data) }, signal);
        offset += chunk.data.byteLength;
        post({ type: 'EXPORT_PROGRESS', fileIndex: 0, fileCount: 1, done: offset, total, bytes: offset });
        if (offset >= total) break;
    }
    post({ type: 'EXPORT_FILE_DONE', fileIndex: 0 });
}

// ----------------------------------------------------------------------------
// Player port
// ----------------------------------------------------------------------------
function connectVaultExport(port) {
    let disconnected = false;
    let session;
    port.onDisconnect.addListener(() => {
        disconnected = true;
        session?.exportJob?.controller.abort();
    });
    port.onMessage.addListener(msg => {
        if (msg?.type === 'EXPORT_CANCEL') session?.exportJob?.controller.abort();
        else if (msg?.type === 'EXPORT_ACK') acknowledgeExport(session, msg);
        else if (msg?.type === 'EXPORT_RESUME' && !session && typeof msg.id === 'string') {
            session = { post: message => { if (!disconnected) port.postMessage(message); } };
            prepare(msg.id).catch(err => session.post({ type: 'EXPORT_ERROR', error: err.message }));
        }
    });

    async function prepare(id) {
        const job = await downloadStore.get(id);
        if (disconnected) return;
        if (!job) throw new Error('This download was removed.');
        const live = [...sessions.values()].find(s => s.tabId === job.tabId && s.stream.id === job.stream.id && s.stream.url === job.stream.url);
        const tab = live ? null : await getTab(job.tabId, { create: false });
        if (disconnected) return;
        const originalTab = tab?.streams.get(job.stream.id)?.url === job.stream.url;
        session.stream = job.stream;
        session.downloader = live?.downloader || new SegmentDownloader({
            transport: originalTab ? makeTransport(job.tabId, () => job.stream) :
                (url, opts) => directFetch(url, opts, job.stream.frameUrl || ''),
            buffer: originalTab ? new BufferManager(job.tabId, job.stream.id) : { getSegment: async () => null },
            abr: new ABRController(),
            getSettings: () => settings
        });
        try { await runExport(session, {}, job); }
        finally { if (!live) session.downloader.destroy(); }
    }
}

function acknowledgeExport(session, msg) {
    const job = session?.exportJob;
    if (job?.id === msg.jobId && job.ack?.sequence === msg.sequence) job.ack.resolve();
}

function sendExportChunk(session, post, message, signal) {
    return new Promise((resolve, reject) => {
        const job = session.exportJob;
        const abort = () => finish(new DOMException('Aborted', 'AbortError'));
        const finish = error => {
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
            job.ack = null;
            if (error) reject(error);
            else resolve();
        };
        const timeout = setTimeout(() => finish(new Error('The export output stopped responding. Resume from the library.')), 30000);
        const sequence = job.sequence = (job.sequence || 0) + 1;
        job.ack = { sequence, resolve: () => finish() };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        try { post({ type: 'EXPORT_CHUNK', ...message, sequence }); }
        catch (error) { finish(error); }
    });
}

api.runtime.onConnect.addListener((port) => {
    if (port.name === 'velostream-vault' && port.sender?.url?.startsWith(api.runtime.getURL('player/player.html?mode=offline&'))) {
        connectVaultExport(port);
        return;
    }
    if (port.name !== 'velostream-player' || !port.sender?.url?.startsWith(api.runtime.getURL('player/player.html?'))) return;
    const tabId = port.sender && port.sender.tab ? port.sender.tab.id : -1;
    let session = null;
    // Messages that arrive while HELLO is still attaching the session (the player resends its
    // in-flight requests right after a reconnect) wait for it instead of being dropped.
    let hello = null;

    port.onMessage.addListener(async (msg) => {
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'HELLO') {
            hello = attach(msg).catch(async e => {
                console.warn('[Engine] attach failed:', e && e.message);
                if (session && (!session.port || session.port === port)) await endSession(session);
            });
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
                    session.disconnectTimer = setTimeout(() => { if (!session.port) endSession(session); }, RECONNECT_GRACE_MS);
                }
                return;
            }
            clearTimeout(session.disconnectTimer);
            session.port = port;
            // Direct media files are loaded by the player page's <video>: give those requests
            // the site's Referer/Origin so hot-link protection accepts them.
            if (session.stream.type === 'progressive') await ensureRefererRule(session.stream.url, session.stream.frameUrl || '');
            const pageUrl = await api.tabs.get(tabId).then(t => (t && t.url) || '', () => '');
            if (disconnected || session.closing || session.port !== port) return;
            tab.pageUrl ||= pageUrl;
            if (tab.staleStreamId) scheduleEpisodeSwitch(tab);
            session.post({ type: 'INIT', sessionId: session.id, tabId: session.tabId, stream: session.stream, resumed: !!msg.resumed, subtitles: tab.subtitles || [], drm: tab.drm || null, pageUrl: tab.pageUrl, pageMeta: tab.pageMeta, streams: streamSummaries(tab) });
        }
    }

    async function handle(msg) {
        if (!session || session.port !== port) return;

        switch (msg.type) {
            case 'REQUEST':
                if (!session.switching && !session.closing) handleRequest(session, msg);
                else session.post({ type: 'RESPONSE', reqId: msg.reqId, ok: false, status: 0, error: 'Stream is switching' });
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
                const downloader = session.downloader;
                downloader.reset();
                await session.buffer.clearStream().catch(() => { });
                if (session.downloader !== downloader || session.closing) break;
                downloader.seek(+msg.time || (session.telemetry && session.telemetry.currentTime) || 0);
                session.post({ type: 'PURGED', time: +msg.time || 0 });
                break;
            }
            case 'SWITCH_STREAM': {
                const tab = await getTab(session.tabId);
                const next = tab.streams.get(msg.streamId);
                if (!next) { session.post({ type: 'SWITCH_FAILED', error: 'That stream is no longer available. Rescan the page.' }); break; }
                await switchEpisode(session, tab, next);
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
                if (msg.dash) {
                    const parts = session.stream.type === 'dash' ? sanitizeDashPlan(msg.dash) : null;
                    if (!parts) {
                        session.post({ type: 'EXPORT_ERROR', error: 'This DASH stream cannot be saved.' });
                        break;
                    }
                    runExport(session, { dash: parts, clip: !!msg.clip });
                    break;
                }
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
            case 'EXPORT_ACK':
                acknowledgeExport(session, msg);
                break;
            case 'EXPORT_CANCEL':
                if (session.exportJob) session.exportJob.controller.abort();
                break;
            case 'STORE_SET':
                if (/^fs_bm_[\w-]{1,64}$/.test(msg.key || '') && Array.isArray(msg.value)) {
                    await writeStorage(() => api.storage.local.set({ [msg.key]: msg.value }));
                }
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
        session.exportJob?.controller.abort();
        // Give the bridge a moment to reconnect (navigation within bfcache, SW hiccup).
        session.disconnectTimer = setTimeout(() => {
            if (!session.port) endSession(session);
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
async function launchPlayer(tabId, streamId, preferFrameId, explicitTime = null) {
    const tab = await getTab(tabId);
    const version = tab.routeVersion;
    const current = () => tabs.get(tabId) === tab && tab.routeVersion === version;
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
    const page = await api.tabs.get(tabId).then(t => t.url || '', () => '');
    if (!current()) throw new Error('The page changed before the player could open.');
    const timestamp = /[#&?]velostream-t=(\d+(?:\.\d+)?)$/.exec(page);
    const startTime = explicitTime ?? (timestamp ? Number(timestamp[1]) : null);
    const url = api.runtime.getURL(`player/player.html?session=${encodeURIComponent(sessionId)}&stream=${encodeURIComponent(streamId)}`);
    // Registered before mounting: the player page says HELLO as soon as it loads.
    tab.playerSessionId = sessionId;
    tab.activeStreamId = stream.id;
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
        if (!current()) break;
        if (!ping || !ping.hasVideo) continue;
        const res = await api.tabs.sendMessage(tabId, { action: 'MOUNT_PLAYER', sessionId, url, streamUrl: stream.url, startTime }, { frameId }).catch(() => null);
        if (res && res.ok) { mounted = { frameId, mode: res.mode }; break; }
    }
    if (!current()) {
        if (tab.playerSessionId === sessionId) {
            tab.playerSessionId = null;
            tab.activeStreamId = null;
            api.tabs.sendMessage(tabId, { action: 'UNMOUNT_PLAYER', sessionId }).catch(() => { });
            api.tabs.sendMessage(tabId, { action: 'RESTORE_MEDIA' }).catch(() => { });
        }
        throw new Error('The page changed before the player could open.');
    }
    if (!mounted) {
        // No <video> element anywhere (stream found on the network only): cover the page.
        const ping = await pingFrame(tabId, 0);
        if (!ping) {
            tab.playerSessionId = null;
            persistTab(tabId);
            api.tabs.sendMessage(tabId, { action: 'RESTORE_MEDIA' }).catch(() => { });
            throw new Error('This page cannot be scripted by extensions (browser or store page).');
        }
        const res = await api.tabs.sendMessage(tabId, { action: 'MOUNT_PLAYER', sessionId, url, streamUrl: stream.url, startTime, forcePage: true }, { frameId: 0 }).catch(() => null);
        if (!res || !res.ok) {
            tab.playerSessionId = null;
            persistTab(tabId);
            api.tabs.sendMessage(tabId, { action: 'RESTORE_MEDIA' }).catch(() => { });
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
const validMediaKey = key => typeof key === 'string' && /^[\w-]{1,64}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key);

function saveSettingsPatch(patch) {
    return writeStorage(async () => {
        const settings = S.mergeSettings((await api.storage.local.get(S.SETTINGS_KEY))[S.SETTINGS_KEY]);
        for (const [key, value] of Object.entries(patch || {})) {
            if (!Object.hasOwn(settings, key)) continue;
            if (['audio', 'subtitles', 'gestures', 'mouse', 'memory'].includes(key) && value && typeof value === 'object') {
                settings[key] = { ...settings[key], ...value };
            } else settings[key] = value;
        }
        const next = S.mergeSettings(settings);
        await api.storage.local.set({ [S.SETTINGS_KEY]: next });
        return { ok: true, settings: next };
    });
}

function saveHistoryEntry({ key, legacyKey, entry }) {
    if (!validMediaKey(key) || !entry || typeof entry.url !== 'string') throw new Error('Invalid history entry.');
    return writeStorage(async () => {
        const bmKey = 'fs_bm_' + key;
        const legacyBmKey = 'fs_bm_' + legacyKey;
        const data = await api.storage.local.get([S.HISTORY_KEY, 'fs_library', bmKey, legacyBmKey]);
        const history = data[S.HISTORY_KEY] || {};
        const legacy = validMediaKey(legacyKey) && legacyKey !== key ? history[legacyKey] : null;
        const migrate = legacy?.url === entry.url && (!legacy.page || legacy.page === entry.page);
        const previous = history[key] || (migrate ? legacy : null);
        const previousDone = previous?.done && !(migrate && previous.d > 0 && previous.d <= 20 && previous.t / previous.d < 0.8);
        history[key] = { ...previous, ...entry, done: !!(entry.done || previousDone), updatedAt: Date.now() };
        const write = { [S.HISTORY_KEY]: history };
        if (migrate) {
            delete history[legacyKey];
            if (!Array.isArray(data[bmKey]) && Array.isArray(data[legacyBmKey])) write[bmKey] = data[legacyBmKey];
            const lib = data.fs_library;
            if (lib && Array.isArray(lib.favorites) && Array.isArray(lib.collections)) {
                const replaceKey = keys => [...new Set(keys.map(k => k === legacyKey ? key : k))];
                write.fs_library = {
                    ...lib, favorites: replaceKey(lib.favorites),
                    collections: lib.collections.map(c => Array.isArray(c?.keys) ? { ...c, keys: replaceKey(c.keys) } : c)
                };
            }
        }
        const keys = Object.keys(history).sort((a, b) => history[b].updatedAt - history[a].updatedAt);
        const evicted = keys.slice(200);
        for (const k of evicted) delete history[k];
        await api.storage.local.set(write);
        if (migrate) evicted.push(legacyKey);
        if (evicted.length) await api.storage.local.remove(evicted.map(k => 'fs_bm_' + k));
        return { ok: true };
    });
}

function pruneLibrary(raw, history) {
    const library = S.sanitizeLibrary(raw);
    const live = key => Object.hasOwn(history, key);
    library.favorites = library.favorites.filter(live);
    for (const collection of library.collections) collection.keys = collection.keys.filter(live);
    return library;
}

function commitLibrary({ base, library }) {
    return writeStorage(async () => {
        const stored = await api.storage.local.get([S.HISTORY_KEY, 'fs_library']);
        if (JSON.stringify(S.sanitizeLibrary(stored.fs_library)) !== JSON.stringify(S.sanitizeLibrary(base))) {
            return { ok: false, conflict: true };
        }
        const next = pruneLibrary(library, stored[S.HISTORY_KEY] || {});
        await api.storage.local.set({ fs_library: next });
        return { ok: true, library: next };
    });
}

function clearLibraryResume(tabId) {
    const pending = resumeRequests.get(tabId);
    if (!pending) return;
    clearTimeout(pending.timer);
    clearTimeout(pending.expiry);
    resumeRequests.delete(tabId);
}

function scheduleLibraryResume(tabId) {
    const pending = resumeRequests.get(tabId);
    if (!pending || pending.timer) return;
    pending.timer = setTimeout(async () => {
        pending.timer = null;
        try {
            const [tab, browserTab] = await Promise.all([getTab(tabId, { create: false }), api.tabs.get(tabId)]);
            if (resumeRequests.get(tabId) !== pending || !tab) return;
            if (S.withoutResumeTime(browserTab.url) !== pending.page || tab.playerSessionId) {
                clearLibraryResume(tabId);
                return;
            }
            const list = visibleStreams(tab).filter(s => !s.isAd);
            const stream = list.find(s => s.url === pending.streamUrl) || list[0];
            if (!stream) return;
            clearLibraryResume(tabId);
            await launchPlayer(tabId, stream.id, stream.frameId, pending.time);
        } catch (_) { clearLibraryResume(tabId); }
    }, 800);
}

async function openLibraryResume(message) {
    const page = new URL(S.withoutResumeTime(message.page));
    if (!/^https?:$/.test(page.protocol) || page.username || page.password) throw new Error('Invalid website link.');
    const browserTab = await api.tabs.create({ url: page.href });
    const tabId = browserTab.id;
    if (Number.isInteger(tabId)) {
        resumeRequests.set(tabId, {
            page: page.href,
            streamUrl: S.normalizeUrl(message.streamUrl, page.href),
            time: Number.isFinite(message.time) && message.time >= 0 ? message.time : null,
            expiry: setTimeout(clearLibraryResume, 30000, tabId)
        });
        scheduleLibraryResume(tabId);
    }
    return { ok: true };
}

function respondAsync(promise, sendResponse) {
    promise.then(sendResponse, err => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.action !== 'string') return false;
    if (message.action === 'VAULT_LIST' || message.action === 'VAULT_DELETE') {
        if (sender.url?.split('#', 1)[0] !== api.runtime.getURL('popup/library.html')) return false;
        if (message.action === 'VAULT_LIST') return respondAsync(downloadStore.list().then(jobs => ({
            ok: true, jobs: jobs.map(job => ({
                id: job.id, name: job.base, bytes: job.bytes, total: job.totalSegments,
                completed: job.completedCount, status: activeExports.has(job.id) ? 'running' : job.status
            }))
        })), sendResponse);
        if (typeof message.id !== 'string' || activeExports.has(message.id)) {
            sendResponse({ ok: false, error: 'Pause the download before deleting it.' });
            return false;
        }
        activeExports.add(message.id);
        return respondAsync(downloadStore.remove(message.id).then(() => ({ ok: true })).finally(() => activeExports.delete(message.id)), sendResponse);
    }
    const fromTab = sender.tab ? sender.tab.id : undefined;

    switch (message.action) {
        // ---- From sniffer.js ------------------------------------------------
        case 'ROUTE_CHANGE':
            if (fromTab !== undefined && sender.frameId === 0 && /^https?:\/\//i.test(message.pageUrl || '')) {
                updateRoute(fromTab, message.pageUrl).catch(() => { });
            }
            return false;
        case 'PAGE_META':
            if (fromTab !== undefined && sender.frameId === 0 && message.pageMeta?.pageUrl) {
                getTab(fromTab).then(tab => {
                    const { pageUrl } = message.pageMeta;
                    if (tab.pageUrl && tab.pageUrl !== pageUrl) return;
                    if (!/^https?:\/\//i.test(pageUrl)) return;
                    tab.pageUrl = pageUrl;
                    tab.pageMeta = S.sanitizePageMeta(message.pageMeta);
                    persistTab(fromTab);
                    sessions.get(tab.playerSessionId)?.post({ type: 'PAGE_META', pageUrl, pageMeta: tab.pageMeta });
                }).catch(() => { });
            }
            return false;
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
                sessions.get(tab.playerSessionId)?.post({ type: 'DRM', drm: tab.drm });
                notifyFrames(fromTab);
            }).catch(() => { });
            return false;

        case 'LIBRARY_RESUME':
            if (sender.url !== api.runtime.getURL('popup/library.html') && !sender.url?.startsWith(api.runtime.getURL('popup/library.html#'))) return false;
            return respondAsync(openLibraryResume(message), sendResponse);
        case 'HISTORY_SAVE':
            if (!sender.url?.startsWith(api.runtime.getURL('player/player.html'))) return false;
            return respondAsync(Promise.resolve().then(() => saveHistoryEntry(message)), sendResponse);
        case 'LIBRARY_WRITE':
            if (!sender.url?.startsWith(api.runtime.getURL('popup/library.html'))) return false;
            return respondAsync(commitLibrary(message), sendResponse);
        case 'HISTORY_CLEAR':
            if (!sender.url?.startsWith(api.runtime.getURL('popup/popup.html'))) return false;
            return respondAsync(writeStorage(async () => {
                await api.storage.local.remove(S.HISTORY_KEY);
                return { ok: true };
            }), sendResponse);
        case 'HISTORY_REMOVE':
            if (!sender.url?.startsWith(api.runtime.getURL(''))) return false;
            return respondAsync(writeStorage(async () => {
                const key = message.key;
                if (!validMediaKey(key)) throw new Error('Invalid history key.');
                const all = await api.storage.local.get([S.HISTORY_KEY, 'fs_library']);
                const history = all[S.HISTORY_KEY] || {};
                delete history[key];
                const library = pruneLibrary(all.fs_library, history);
                await api.storage.local.set({ [S.HISTORY_KEY]: history, fs_library: library });
                if (message.removeBookmarks) await api.storage.local.remove('fs_bm_' + key);
                return { ok: true, history, library };
            }), sendResponse);
        case 'BACKUP_RESTORE':
            if (!sender.url?.startsWith(api.runtime.getURL(''))) return false;
            return respondAsync(writeStorage(async () => ({ ok: true, ...await S.restoreBackup(api, message.json) })), sendResponse);
        case 'SETTINGS_PATCH':
            if (!sender.url?.startsWith(api.runtime.getURL(''))) return false;
            return respondAsync(saveSettingsPatch(message.patch), sendResponse);

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
    const active = [...sessions.values()].filter(s => s.tabId === tabId);
    const session = active.find(s => s.id === tab?.playerSessionId);
    clearTimeout(notifyTimers.get(tabId));
    notifyTimers.delete(tabId);
    clearTimeout(tab?.episodeTimer);
    const ending = active.filter(s => !keepPlayer || s !== session)
        .map(s => endSession(s, { clearCache: true, restoreMedia: false }));
    if (keepPlayer && tab && session) {
        // Keep only the stream being played.
        for (const [id, s] of tab.streams) if (s.id !== session.stream.id) { tab.streams.delete(id); tab.byUrl.delete(s.url); }
        tab.children.clear();
        resetRouteState(tab);
        persistTab(tabId, { subtitles: true });
    } else {
        tabs.delete(tabId);
        clearTimeout(persistTimers.get(tabId));
        persistTimers.delete(tabId);
        subsDirty.delete(tabId);
        const clearing = Promise.allSettled([
            api.storage.session.remove([tabKey(tabId), tabSubsKey(tabId)]),
            ...(!keepPlayer ? [BufferManager.clearTab(tabId)] : [])
        ]);
        tabClears.set(tabId, clearing);
        await clearing;
        if (tabClears.get(tabId) === clearing) tabClears.delete(tabId);
    }
    await Promise.all(ending);
    if (!removed) {
        updateIcon(tabId);
        notifyFrames(tabId);
    }
}

api.tabs.onRemoved.addListener((tabId) => {
    closedTabs.add(tabId);
    if (closedTabs.size > 256) closedTabs.delete(closedTabs.values().next().value);
    clearLibraryResume(tabId);
    teardownTab(tabId, { removed: true }).catch(() => { });
});

function resetRouteState(tab) {
    tab.routeVersion++;
    clearTimeout(tab.episodeTimer);
    tab.episodeTimer = null;
    tab.subtitles = [];
    tab.drm = null;
    tab.mseFrames.clear();
    tab.videoFrames.clear();
    tab.autoLaunched = false;
    tab.autoLaunchPending = false;
}

async function updateRoute(tabId, pageUrl) {
    const tab = await getTab(tabId, { create: false });
    if (!tab || tab.pageUrl === pageUrl) return;
    if (tab.pageUrl && S.withoutResumeTime(tab.pageUrl) === S.withoutResumeTime(pageUrl)) { tab.pageUrl = pageUrl; return; }
    tab.pageUrl = pageUrl;
    tab.pageMeta = null;
    const session = sessions.get(tab.playerSessionId);
    tab.staleStreamId = session?.stream.id || (tab.playerSessionId ? tab.activeStreamId : null) || null;
    for (const [id, stream] of tab.streams) {
        if (id === tab.staleStreamId) continue;
        tab.streams.delete(id);
        tab.byUrl.delete(stream.url);
    }
    tab.children.clear();
    resetRouteState(tab);
    persistTab(tabId, { subtitles: true });
    session?.post({ type: 'ROUTE_CHANGE', pageUrl });
    api.tabs.sendMessage(tabId, { action: 'ROUTE_RESET', pageUrl }).catch(() => { });
    updateIcon(tabId);
    notifyFrames(tabId);
}

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
        teardownTab(tabId).catch(() => { });
    } else if (changeInfo.url !== undefined) {
        updateRoute(tabId, changeInfo.url).catch(() => { });
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
