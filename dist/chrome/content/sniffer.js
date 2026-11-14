/**
 * Velostream - Content Sniffer & Bridge (ISOLATED world, every frame)
 *
 * Roles:
 *  1. Relay interceptor detections (MAIN world) to the engine - de-duplicated.
 *  2. Debounced DOM scan for <video>/<audio> (+ <source> children, open shadow roots).
 *  3. FETCH_PROXY executor: the engine asks THIS frame to fetch with the page's identity;
 *     bodies come back from the MAIN world as transferred ArrayBuffers and are packed
 *     (ArrayBuffer on Firefox, base64 on Chromium) for runtime messaging.
 *  4. SUSPEND_MEDIA / RESTORE_MEDIA: pause + mute native players while Velostream plays.
 *  5. Top frame only: BRIDGE between the MAIN-world player (private MessagePort) and the
 *     engine (runtime port "velostream-player"), plus chrome.storage access for settings.
 */
(function () {
    'use strict';
    if (globalThis.__VELOSTREAM_SNIFFER__) return;
    globalThis.__VELOSTREAM_SNIFFER__ = true;

    const S = globalThis.VelostreamShared;
    const api = S.api;
    const IS_TOP = window === window.top;
    const TAG_FROM_PAGE = 'velostream-interceptor';
    const TAG_TO_PAGE = 'velostream-sniffer';
    const PROXY_TIMEOUT_MS = 55000;

    let contextValid = true;
    function send(message) {
        if (!contextValid) return;
        try {
            const p = api.runtime.sendMessage(message);
            if (p && p.catch) p.catch(err => {
                if (/context invalidated/i.test(String(err && err.message))) contextValid = false;
            });
        } catch (_) {
            contextValid = false; // extension reloaded/updated: stop talking to a dead runtime
        }
    }

    // ------------------------------------------------------------------
    // 1. Detection relay (de-duplicated)
    // ------------------------------------------------------------------
    const reportedUrls = new Set();
    let mseReported = false;
    let videoReported = false;

    function reportStream(payload) {
        if (!payload || !payload.url) return;
        const key = S.normalizeUrl(payload.url, location.href);
        if (!key || reportedUrls.has(key)) return;
        reportedUrls.add(key);
        send({ action: 'STREAM_FOUND', payload: { ...payload, url: key, title: IS_TOP ? document.title : '' } });
    }

    // Subtitles: sidecar files seen on the network or as <track>, and in-memory cues that a
    // site player added with addTextTrack()/addCue() (serialized to WebVTT text, capped).
    const reportedSubs = new Set();
    let drmReported = false;
    function reportSubtitle(sub) {
        if (!sub) return;
        const url = sub.url ? S.normalizeUrl(sub.url, location.href) : '';
        // A <track> report may follow a network report of the same file: it carries the label,
        // language and default flag, so it gets its own dedup slot (the engine merges them).
        const key = url ? `${url}|${sub.method === 'track' ? 'track' : 'net'}` : `inline:${sub.label || ''}:${sub.language || ''}:${(sub.vtt || '').length}`;
        if ((sub.url && !url) || reportedSubs.has(key) || reportedSubs.size >= 64) return;
        reportedSubs.add(key);
        send({ action: 'SUBTITLE_FOUND', payload: { ...sub, url } });
    }

    function vttTime(t) {
        const ms = Math.max(0, Math.round(t * 1000));
        const h = Math.floor(ms / 3600000);
        const m = Math.floor(ms / 60000) % 60;
        const s = Math.floor(ms / 1000) % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
    }

    function scanSubtitleTracks(video) {
        if (!video || video.tagName !== 'VIDEO') return;
        video.querySelectorAll('track[src]').forEach(tr => {
            const kind = (tr.getAttribute('kind') || 'subtitles').toLowerCase();
            if (kind !== 'subtitles' && kind !== 'captions' && kind !== 'chapters') return;
            reportSubtitle({ url: tr.src || tr.getAttribute('src'), label: tr.label || '', language: tr.srclang || '', isDefault: tr.default, kind: kind === 'chapters' ? 'chapters' : 'subtitles', method: 'track' });
        });
        // TextTracks that belong to a <track src> element were reported above by URL.
        const backed = new Set(Array.from(video.querySelectorAll('track[src]')).map(tr => tr.track));
        let tracks;
        try { tracks = Array.from(video.textTracks || []); } catch (_) { return; }
        for (const t of tracks) {
            if (t.kind !== 'subtitles' && t.kind !== 'captions' && t.kind !== 'chapters') continue;
            if (backed.has(t)) continue;
            // Only in-memory cue lists (addTextTrack()/addCue()) are serialized.
            let cues = null;
            try {
                if (t.mode === 'disabled') continue; // cues are not readable while disabled
                cues = t.cues;
            } catch (_) { continue; }
            if (!cues || cues.length < (t.kind === 'chapters' ? 1 : 3)) continue;
            let out = 'WEBVTT\n\n';
            const n = Math.min(cues.length, 5000);
            for (let i = 0; i < n; i++) {
                const c = cues[i];
                const text = typeof c.text === 'string' ? c.text : '';
                if (!text) continue;
                out += `${vttTime(c.startTime)} --> ${vttTime(c.endTime)}\n${text.replace(/\n{2,}/g, '\n')}\n\n`;
                if (out.length > 1500000) break;
            }
            reportSubtitle({ vtt: out, label: t.label || '', language: t.language || '', kind: t.kind === 'chapters' ? 'chapters' : 'subtitles', method: 'textTracks' });
        }
    }

    // ------------------------------------------------------------------
    // 3. Proxy fetch bookkeeping (single listener, id -> pending map)
    // ------------------------------------------------------------------
    const pendingFetches = new Map();

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.source !== TAG_FROM_PAGE) return;
        switch (msg.type) {
            case 'STREAM_FOUND':
                reportStream(msg.payload);
                break;
            case 'MSE_INIT':
                if (!mseReported) {
                    mseReported = true;
                    send({ action: 'MSE_INIT', payload: { mimeType: msg.payload && msg.payload.mimeType } });
                }
                break;
            case 'SUBTITLE_FOUND':
                if (msg.payload && typeof msg.payload.url === 'string') reportSubtitle({ url: msg.payload.url, mime: msg.payload.mime || '', method: 'network' });
                break;
            case 'DRM_DETECTED':
                if (!drmReported) {
                    drmReported = true;
                    send({ action: 'DRM_DETECTED', payload: { keySystem: String((msg.payload && msg.payload.keySystem) || '') } });
                }
                break;
            case 'FETCH_RESULT': {
                const pending = pendingFetches.get(msg.id);
                if (pending) pending(msg);
                break;
            }
            default:
                break;
        }
    });

    function proxyFetch(message, sendResponse) {
        const id = message.id || crypto.randomUUID();
        const timer = setTimeout(() => {
            if (!pendingFetches.has(id)) return;
            pendingFetches.delete(id);
            window.postMessage({ source: TAG_TO_PAGE, type: 'FS_ABORT', id }, '*');
            sendResponse({ ok: false, status: 0, error: `Page fetch timeout (${PROXY_TIMEOUT_MS}ms)` });
        }, PROXY_TIMEOUT_MS);

        pendingFetches.set(id, (result) => {
            pendingFetches.delete(id);
            clearTimeout(timer);
            if (!result.ok) {
                sendResponse({ ok: false, status: result.status || 0, error: result.error || 'Page fetch failed', aborted: !!result.aborted });
                return;
            }
            try {
                sendResponse({
                    ok: true,
                    status: result.status,
                    headers: result.headers || {},
                    url: result.url,
                    data: S.packBinary(result.buffer)
                });
            } catch (err) {
                sendResponse({ ok: false, status: 0, error: `Encode failed: ${err.message}` });
            }
        });

        window.postMessage({
            source: TAG_TO_PAGE,
            type: 'FS_FETCH',
            id,
            url: message.url,
            method: message.method || 'GET',
            headers: message.headers || {}
        }, '*');
    }

    // ------------------------------------------------------------------
    // 2. Debounced DOM scan
    // ------------------------------------------------------------------
    let scanTimer = null;

    function collectMedia(root, out) {
        root.querySelectorAll('video, audio').forEach(el => out.push(el));
        // Walk open shadow roots (custom player elements) except Velostream's own host.
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        let budget = 5000; // bound the cost on huge DOMs
        while (node && budget-- > 0) {
            if (node.shadowRoot && node.id !== 'velostream-host') collectMedia(node.shadowRoot, out);
            node = walker.nextNode();
        }
        return out;
    }

    function scanMedia() {
        scanTimer = null;
        if (!document.documentElement) return;
        const media = collectMedia(document, []);
        for (const el of media) {
            if (el.tagName === 'VIDEO' && !videoReported) {
                videoReported = true;
                send({ action: 'VIDEO_PRESENT' });
            }
            if (el.tagName === 'VIDEO') scanSubtitleTracks(el);
            const candidates = [el.currentSrc, el.getAttribute('src')];
            el.querySelectorAll('source[src]').forEach(s => candidates.push(s.src || s.getAttribute('src')));
            for (const raw of candidates) {
                if (!raw) continue;
                const url = S.normalizeUrl(raw, location.href);
                const type = S.classifyStream(url);
                if (type) reportStream({ url, type, method: 'dom_scan' });
            }
        }
        // A player element may have appeared/resized: re-evaluate the quick-launch pill.
        if (badge.state.count) renderBadge();
    }

    function scheduleScan() {
        if (scanTimer) return;
        scanTimer = setTimeout(scanMedia, 400);
    }

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type === 'attributes') { scheduleScan(); return; }
            for (const n of m.addedNodes) {
                if (n.nodeType === 1 && (n.tagName === 'VIDEO' || n.tagName === 'AUDIO' || n.tagName === 'SOURCE' ||
                    (n.querySelector && n.querySelector('video, audio, source')))) {
                    scheduleScan();
                    return;
                }
            }
        }
    });

    function startObserving() {
        if (!document.documentElement) return;
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src']
        });
        scheduleScan();
    }
    if (document.documentElement) startObserving();
    else document.addEventListener('readystatechange', startObserving, { once: true });
    window.addEventListener('load', scheduleScan, { once: true });
    // Native players set src late; catch the actual load.
    document.addEventListener('loadstart', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'VIDEO' || t.tagName === 'AUDIO')) scheduleScan();
    }, true);
    // A video that actually loads or starts playing is a strong signal even when it was
    // created detached / inside a closed shadow root that the DOM scan cannot reach: report it
    // (capture phase sees the event before the page can stop it) and move the badge to it.
    let lastLiveVideo = null;
    const onMediaLive = (e) => {
        const t = e.target;
        if (!t || t.tagName !== 'VIDEO') return;
        if (!videoReported || e.type === 'playing') {
            videoReported = true;
            send({ action: 'VIDEO_PRESENT' });
        }
        lastLiveVideo = t;
        scanSubtitleTracks(t);
        scheduleScan();
    };
    document.addEventListener('loadedmetadata', onMediaLive, true);
    document.addEventListener('playing', onMediaLive, true);

    // ------------------------------------------------------------------
    // 4. Native media suspension while Velostream plays
    // ------------------------------------------------------------------
    let suspended = null; // Map<HTMLMediaElement, {muted:boolean}>

    function suspendElement(el) {
        if (!suspended || !(el instanceof HTMLMediaElement)) return;
        if (!suspended.has(el)) suspended.set(el, { muted: el.muted });
        try { el.pause(); } catch (_) { /* ignore */ }
        el.muted = true;
    }

    function onNativePlay(e) {
        // Media events do not escape shadow roots, so Velostream's own <video> never lands here.
        suspendElement(e.target);
    }

    function suspendMedia() {
        if (!suspended) {
            suspended = new Map();
            document.addEventListener('play', onNativePlay, true);
        }
        collectMedia(document, []).forEach(suspendElement);
    }

    function restoreMedia() {
        if (!suspended) return;
        document.removeEventListener('play', onNativePlay, true);
        for (const [el, state] of suspended) {
            try { el.muted = state.muted; } catch (_) { /* detached */ }
        }
        suspended = null;
    }

    // ------------------------------------------------------------------
    // 5. In-place player mount
    //    The player is an extension page (player/player.html) shown in an <iframe> placed
    //    exactly over the site's own <video>: it is inserted into the site's player container
    //    (so it scrolls, resizes and stacks with it) and re-synced on every layout change. The
    //    original video is paused, muted and hidden; its controls are covered. When no usable
    //    <video> exists in this frame the iframe covers the viewport instead ("page" mode).
    // ------------------------------------------------------------------
    const mount = {
        frame: null, session: null, video: null, mode: null, prevMode: null,
        videoStyle: null, timer: null, ro: null, rect: null, dragStart: null, pageLock: null
    };
    const FRAME_Z = '2147483647';

    /** Every video in the frame, plus one seen playing inside a closed shadow root. */
    function allVideos() {
        const list = collectMedia(document, []);
        if (lastLiveVideo && lastLiveVideo.isConnected && !list.includes(lastLiveVideo)) list.push(lastLiveVideo);
        return list;
    }

    function pickVideo(streamUrl) {
        let best = null;
        let bestScore = 0;
        for (const v of allVideos()) {
            if (v.tagName !== 'VIDEO') continue;
            const r = v.getBoundingClientRect();
            if (r.width < 120 || r.height < 68) continue;
            let score = r.width * r.height;
            if (!v.paused) score *= 2;
            if (streamUrl && (v.currentSrc === streamUrl || v.src === streamUrl)) score *= 4;
            if (score > bestScore) { bestScore = score; best = v; }
        }
        return best;
    }

    /** Outermost ancestor with (almost) the same box as the video = the site's player container. */
    function playerContainer(video) {
        const vr = video.getBoundingClientRect();
        const same = (r) => Math.abs(r.left - vr.left) < 4 && Math.abs(r.top - vr.top) < 4 &&
            Math.abs(r.width - vr.width) < 4 && Math.abs(r.height - vr.height) < 4;
        let container = null;
        let node = video.parentNode;
        while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
            if (!same(node.getBoundingClientRect())) break;
            container = node;
            node = node.parentNode;
        }
        return container || video.parentNode;
    }

    function setFrameStyle(css) {
        const f = mount.frame;
        if (!f) return;
        f.style.cssText = `all: initial; display: block; border: 0; margin: 0; padding: 0; background: #000; color-scheme: normal; z-index: ${FRAME_Z}; ${css}`;
    }

    /** Keep the iframe exactly on top of the original video (in its containing block). */
    function syncInline() {
        if (mount.mode !== 'inline' || !mount.frame) return;
        const v = mount.video;
        if (!v || !v.isConnected) {
            // The site replaced its <video> (SPA re-render): follow the new one, else go full page.
            const next = pickVideo(null);
            if (next) { attachToVideo(next); return; }
            setMode('page');
            return;
        }
        const vr = v.getBoundingClientRect();
        if (vr.width < 2 || vr.height < 2) return; // temporarily hidden by the site: keep last box
        const cb = mount.frame.offsetParent;
        let left;
        let top;
        if (!cb || (cb === document.body && getComputedStyle(cb).position === 'static')) {
            left = vr.left + scrollX;
            top = vr.top + scrollY;
        } else {
            const cr = cb.getBoundingClientRect();
            left = vr.left - cr.left - cb.clientLeft + cb.scrollLeft;
            top = vr.top - cr.top - cb.clientTop + cb.scrollTop;
        }
        const key = `${left}|${top}|${vr.width}|${vr.height}`;
        if (key === mount.rect) return;
        mount.rect = key;
        setFrameStyle(`position: absolute; left: ${left}px; top: ${top}px; width: ${vr.width}px; height: ${vr.height}px;`);
    }

    function hideVideo(v) {
        mount.videoStyle = { el: v, visibility: v.style.getPropertyValue('visibility'), priority: v.style.getPropertyPriority('visibility') };
        v.style.setProperty('visibility', 'hidden', 'important');
    }

    function unhideVideo() {
        const s = mount.videoStyle;
        if (!s) return;
        try {
            if (s.visibility) s.el.style.setProperty('visibility', s.visibility, s.priority);
            else s.el.style.removeProperty('visibility');
        } catch (_) { /* detached */ }
        mount.videoStyle = null;
    }

    function attachToVideo(video) {
        unhideVideo();
        mount.video = video;
        const container = playerContainer(video);
        if (container === video.parentNode) video.parentNode.insertBefore(mount.frame, video.nextSibling);
        else container.appendChild(mount.frame);
        hideVideo(video);
        suspendElement(video);
        if (mount.ro) mount.ro.disconnect();
        mount.ro = new ResizeObserver(() => syncInline());
        mount.ro.observe(video);
        mount.rect = null;
        syncInline();
    }

    function lockPage(on) {
        if (on && !mount.pageLock) {
            mount.pageLock = { overflow: document.documentElement.style.overflow, inert: document.body ? document.body.inert : false };
            document.documentElement.style.overflow = 'hidden';
            if (document.body && mount.frame.parentNode !== document.body) document.body.inert = true;
        } else if (!on && mount.pageLock) {
            document.documentElement.style.overflow = mount.pageLock.overflow;
            if (document.body) document.body.inert = mount.pageLock.inert;
            mount.pageLock = null;
        }
    }

    function miniRect(ratio) {
        const w = Math.round(Math.min(360, innerWidth * 0.6));
        const h = Math.round(w * (ratio || 9 / 16));
        return { x: innerWidth - w - 16, y: innerHeight - h - 16, w, h };
    }

    function clampRect(r) {
        r.w = Math.min(Math.max(r.w, 200), innerWidth - 16);
        r.h = Math.min(Math.max(r.h, 112), innerHeight - 16);
        r.x = Math.min(Math.max(r.x, 8), innerWidth - r.w - 8);
        r.y = Math.min(Math.max(r.y, 8), innerHeight - r.h - 8);
        return r;
    }

    function applyFloating() {
        const r = mount.float;
        setFrameStyle(`position: fixed; left: ${r.x}px; top: ${r.y}px; width: ${r.w}px; height: ${r.h}px; border-radius: 16px; overflow: hidden; box-shadow: 0 16px 40px rgba(0,0,0,.55), 0 2px 10px rgba(0,0,0,.3);`);
    }

    function setMode(mode, opts = {}) {
        if (!mount.frame) return;
        const prev = mount.mode;
        if (prev === mode) return;
        if (mode === 'mini' || mode === 'fill') mount.prevMode = prev;
        mount.mode = mode;
        mount.rect = null;
        if (mode === 'inline') {
            lockPage(false);
            if (mount.video && mount.video.isConnected) attachToVideo(mount.video);
            else setMode('page');
            return;
        }
        if (mode === 'page' || mode === 'fill') {
            if (mount.frame.parentNode !== document.documentElement) document.documentElement.appendChild(mount.frame);
            setFrameStyle('position: fixed; inset: 0; width: 100vw; height: 100vh;');
            lockPage(true);
        } else if (mode === 'mini') {
            lockPage(false);
            if (mount.frame.parentNode !== document.documentElement) document.documentElement.appendChild(mount.frame);
            mount.float = clampRect(mount.float || miniRect(opts.ratio));
            applyFloating();
        }
    }

    function unmountPlayer() {
        if (!mount.frame) return;
        if (mount.ro) mount.ro.disconnect();
        clearInterval(mount.timer);
        window.removeEventListener('resize', syncInline);
        lockPage(false);
        mount.frame.remove();
        unhideVideo();
        restoreMedia();
        Object.assign(mount, { frame: null, session: null, video: null, mode: null, prevMode: null, ro: null, rect: null, timer: null, float: null });
    }

    function onLayoutMessage(e) {
        const d = e.data;
        if (!mount.frame || e.source !== mount.frame.contentWindow || !d || d.__velostream !== 'layout' || d.session !== mount.session) return;
        switch (d.cmd) {
            case 'close':
                unmountPlayer();
                break;
            case 'mini':
                setMode('mini', { ratio: d.ratio });
                break;
            case 'restore':
            case 'unfill':
                setMode(mount.prevMode && mount.prevMode !== 'mini' && mount.prevMode !== 'fill' ? mount.prevMode : (mount.video ? 'inline' : 'page'));
                break;
            case 'fill':
                setMode('fill');
                break;
            case 'move-start':
            case 'resize-start':
                if (mount.mode === 'mini') mount.dragStart = { ...mount.float };
                break;
            case 'move':
                if (mount.mode === 'mini' && mount.dragStart) {
                    mount.float = clampRect({ ...mount.dragStart, x: mount.dragStart.x + (+d.dx || 0), y: mount.dragStart.y + (+d.dy || 0) });
                    applyFloating();
                }
                break;
            case 'resize':
                if (mount.mode === 'mini' && mount.dragStart) {
                    // Handle sits in the top-left corner: keep the bottom-right corner anchored.
                    const s = mount.dragStart;
                    const w = Math.min(Math.max(s.w - (+d.dx || 0), 200), innerWidth - 16);
                    const h = Math.round(w * (s.h / s.w));
                    mount.float = clampRect({ x: s.x + s.w - w, y: s.y + s.h - h, w, h });
                    applyFloating();
                }
                break;
            case 'move-end':
            case 'resize-end':
                mount.dragStart = null;
                break;
            default:
                break;
        }
    }
    window.addEventListener('message', onLayoutMessage);

    function mountPlayer(message) {
        const base = api.runtime.getURL('player/player.html');
        if (typeof message.url !== 'string' || !message.url.startsWith(base)) return { ok: false, error: 'Bad player URL' };
        if (mount.frame) unmountPlayer();
        const video = message.forcePage ? null : pickVideo(message.streamUrl);
        if (!video && !IS_TOP && !message.allowPageInFrame) return { ok: false, reason: 'no-video' };

        suspendMedia();
        const url = new URL(message.url);
        if (video && Number.isFinite(video.currentTime) && video.currentTime > 1 && Number.isFinite(video.duration)) {
            url.searchParams.set('t', String(Math.floor(video.currentTime)));
        }
        if (IS_TOP && document.title) url.searchParams.set('title', document.title.slice(0, 200));
        url.searchParams.set('mode', video ? 'inline' : 'page');

        const frame = document.createElement('iframe');
        frame.src = url.href;
        frame.title = 'Velostream player';
        // `allow` covers fullscreen; adding `allowfullscreen` too only triggers a console warning.
        frame.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture; encrypted-media; clipboard-write');
        mount.frame = frame;
        mount.session = message.sessionId;
        setFrameStyle('position: absolute; width: 0; height: 0;');
        if (video) {
            mount.mode = 'inline';
            attachToVideo(video);
        } else {
            mount.mode = null;
            setMode('page');
        }
        frame.addEventListener('load', () => { try { frame.focus(); } catch (_) { /* ignore */ } }, { once: true });
        window.addEventListener('resize', syncInline);
        mount.timer = setInterval(() => {
            if (!mount.frame) return;
            if (!mount.frame.isConnected) {
                // The site's framework re-rendered its player and dropped our iframe: put it back.
                // (Re-inserting reloads the player page; it resumes via the saved history.)
                if (mount.mode === 'inline' && mount.video && mount.video.isConnected) attachToVideo(mount.video);
                else { document.documentElement.appendChild(mount.frame); mount.rect = null; }
            }
            if (mount.mode === 'inline') syncInline();
        }, 500);
        return { ok: true, mode: video ? 'inline' : 'page' };
    }

    // ------------------------------------------------------------------
    // 6. On-page "Play in Velostream" glass pill
    //    Shown over the largest visible <video> of this frame (or bottom-right of the top
    //    frame when no frame reports a <video>). Draggable, dismissible, keyboard accessible.
    //    Closed shadow root: page CSS cannot restyle it, page JS cannot read it.
    // ------------------------------------------------------------------
    const badge = {
        state: { count: 0, playerOpen: false, videoFrames: [], label: '' },
        enabled: true,
        dismissed: false,
        host: null,
        shadow: null,
        offset: { x: 0, y: 0 },
        target: null,
        timer: null,
        busy: false
    };

    const BADGE_CSS = `
:host { all: initial; }
.pill {
  position: fixed; z-index: 2147483646; display: inline-flex; align-items: center; height: 44px; padding: 0 4px 0 0;
  border-radius: 9999px; background: rgba(28, 28, 30, 0.78); color: #fff;
  -webkit-backdrop-filter: blur(28px) saturate(190%); backdrop-filter: blur(28px) saturate(190%);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 16px 40px rgba(0, 0, 0, 0.55), 0 2px 10px rgba(0, 0, 0, 0.3);
  font: 500 13px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif;
  letter-spacing: -0.01em; transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms; touch-action: none; user-select: none;
}
.pill[hidden] { display: none; }
button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: inherit; height: 44px; border-radius: 9999px; }
.play { gap: 8px; padding: 0 12px 0 14px; font-weight: 600; }
.play:active { transform: scale(0.96); }
.meta { color: rgba(235, 235, 245, 0.82); font-variant-numeric: tabular-nums; font-weight: 500; }
.divider { width: 1px; height: 20px; background: rgba(255, 255, 255, 0.12); }
.close { width: 36px; height: 36px; margin-left: 4px; }
.close:hover, .play:hover { background: rgba(255, 255, 255, 0.10); }
button:focus-visible { outline: 2px solid #0A84FF; outline-offset: 2px; }
svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.bolt { color: #0A84FF; stroke: none; fill: currentColor; }
@media (prefers-reduced-motion: reduce) { .pill { transition: none; } }
`;

    function largestVideo() {
        let best = null;
        let bestArea = 0;
        for (const el of allVideos()) {
            if (el.tagName !== 'VIDEO') continue;
            const r = el.getBoundingClientRect();
            const visW = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
            const visH = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
            if (visW < 160 || visH < 90) continue;
            const area = visW * visH;
            if (area > bestArea) { bestArea = area; best = el; }
        }
        return best;
    }

    function ensureBadge() {
        if (badge.host || !document.documentElement) return;
        const host = document.createElement('velostream-badge');
        host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646;';
        const shadow = host.attachShadow({ mode: 'closed' });
        S.setHTML(shadow, `<style>${BADGE_CSS}</style>
<div class="pill" role="group" aria-label="Velostream" hidden>
  <button type="button" class="play" aria-label="Play this video in Velostream">
    <svg class="bolt" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4.5 13.2a.6.6 0 0 0 .5 1H11l-1 7.8 8.5-11.2a.6.6 0 0 0-.5-1H12z"/></svg>
    <span class="label">Velostream</span><span class="meta" aria-hidden="true"></span>
  </button>
  <span class="divider" aria-hidden="true"></span>
  <button type="button" class="close" aria-label="Hide the Velostream button on this page">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
  </button>
</div>`);
        badge.host = host;
        badge.shadow = shadow;
        const pill = shadow.querySelector('.pill');
        const play = shadow.querySelector('.play');
        let drag = null;
        play.addEventListener('pointerdown', (e) => {
            drag = { x: e.clientX, y: e.clientY, ox: badge.offset.x, oy: badge.offset.y, moved: false };
            play.setPointerCapture(e.pointerId);
        });
        play.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            if (!drag.moved && Math.hypot(dx, dy) < 6) return;
            drag.moved = true;
            badge.offset = { x: drag.ox + dx, y: drag.oy + dy };
            positionBadge();
        });
        play.addEventListener('pointerup', () => { if (drag) setTimeout(() => { drag = null; }, 0); });
        play.addEventListener('click', (e) => {
            if (drag && drag.moved) { e.preventDefault(); return; }
            launchFromBadge();
        });
        shadow.querySelector('.close').addEventListener('click', () => {
            badge.dismissed = true;
            renderBadge();
        });
        pill.addEventListener('keydown', (e) => { if (e.key === 'Escape') { badge.dismissed = true; renderBadge(); } });
        document.documentElement.appendChild(host);
    }

    function positionBadge() {
        if (!badge.shadow) return;
        const pill = badge.shadow.querySelector('.pill');
        if (pill.hidden) return;
        const w = pill.offsetWidth || 220;
        const h = pill.offsetHeight || 44;
        let x;
        let y;
        if (badge.target && badge.target.isConnected) {
            const r = badge.target.getBoundingClientRect();
            x = Math.min(r.right, innerWidth) - w - 12;
            y = Math.max(r.top, 0) + 12;
        } else {
            x = innerWidth - w - 16;
            y = innerHeight - h - 16;
        }
        x = Math.min(Math.max(8, x + badge.offset.x), innerWidth - w - 8);
        y = Math.min(Math.max(8, y + badge.offset.y), innerHeight - h - 8);
        pill.style.left = `${Math.round(x)}px`;
        pill.style.top = `${Math.round(y)}px`;
    }

    let rafPending = false;
    function schedulePosition() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; positionBadge(); });
    }

    function renderBadge() {
        const s = badge.state;
        badge.target = largestVideo();
        const fallbackTop = IS_TOP && !s.videoFrames.length;
        const show = badge.enabled && !badge.dismissed && !s.playerOpen && s.count > 0 && (badge.target || fallbackTop);
        if (!show) {
            if (badge.shadow) badge.shadow.querySelector('.pill').hidden = true;
            clearInterval(badge.timer);
            badge.timer = null;
            return;
        }
        ensureBadge();
        if (!badge.shadow) return;
        const pill = badge.shadow.querySelector('.pill');
        badge.shadow.querySelector('.meta').textContent = s.label ? `• ${s.label}` : '';
        badge.shadow.querySelector('.play').setAttribute('aria-label', `Play this video in Velostream${s.label ? `, ${s.label}` : ''}`);
        pill.hidden = false;
        positionBadge();
        if (!badge.timer) badge.timer = setInterval(() => { badge.target = largestVideo() || badge.target; positionBadge(); }, 1000);
    }

    async function launchFromBadge() {
        if (badge.busy) return;
        badge.busy = true;
        const label = badge.shadow.querySelector('.label');
        label.textContent = 'Opening…';
        try {
            const res = await api.runtime.sendMessage({ action: 'LAUNCH_FROM_PAGE' });
            if (!res || !res.ok) throw new Error((res && res.error) || 'Could not open the player');
            label.textContent = 'Velostream';
        } catch (err) {
            label.textContent = 'Can\'t play here';
            badge.shadow.querySelector('.play').title = String(err && err.message || err);
            setTimeout(() => { label.textContent = 'Velostream'; }, 3000);
        } finally {
            badge.busy = false;
        }
    }

    function loadBadgeSetting() {
        api.storage.local.get(S.SETTINGS_KEY).then(res => {
            badge.enabled = S.mergeSettings(res[S.SETTINGS_KEY]).quickLaunchBadge;
            renderBadge();
        }).catch(() => { });
    }
    loadBadgeSetting();
    api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[S.SETTINGS_KEY]) {
            badge.enabled = S.mergeSettings(changes[S.SETTINGS_KEY].newValue).quickLaunchBadge;
            renderBadge();
        }
    });
    window.addEventListener('scroll', schedulePosition, { passive: true, capture: true });
    window.addEventListener('resize', schedulePosition, { passive: true });
    send({ action: 'GET_BADGE_STATE' });

    // ------------------------------------------------------------------
    // Engine -> frame commands
    // ------------------------------------------------------------------
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || typeof message.action !== 'string') return false;
        switch (message.action) {
            case 'PING':
                // Lets the engine choose the frame that really shows the video.
                sendResponse({ ok: true, top: IS_TOP, hasVideo: !!pickVideo(null) });
                return false;
            case 'FETCH_PROXY':
                proxyFetch(message, sendResponse);
                return true;
            case 'FETCH_ABORT':
                if (pendingFetches.has(message.id)) {
                    window.postMessage({ source: TAG_TO_PAGE, type: 'FS_ABORT', id: message.id }, '*');
                }
                return false;
            case 'SUSPEND_MEDIA':
                suspendMedia();
                return false;
            case 'RESTORE_MEDIA':
                if (!mount.frame) restoreMedia();
                return false;
            case 'RESCAN':
                reportedUrls.clear();
                mseReported = false;
                videoReported = false;
                scanMedia();
                return false;
            case 'MOUNT_PLAYER':
                sendResponse(mountPlayer(message));
                return false;
            case 'UNMOUNT_PLAYER':
                if (!message.sessionId || message.sessionId === mount.session) unmountPlayer();
                return false;
            case 'STREAMS_AVAILABLE':
                badge.state = {
                    count: message.count | 0,
                    playerOpen: !!message.playerOpen,
                    videoFrames: Array.isArray(message.videoFrames) ? message.videoFrames : [],
                    label: String(message.label || '')
                };
                renderBadge();
                return false;
            default:
                return false;
        }
    });
})();
