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
    const frameOrigin = window.origin;
    const bridgeNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    const postToPage = message => {
        if (frameOrigin !== 'null') window.postMessage({ source: TAG_TO_PAGE, ...message }, frameOrigin);
    };
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

    function serializeCues(cues) {
        let out = 'WEBVTT\n\n';
        const n = Math.min(cues.length, 5000);
        for (let i = 0; i < n; i++) {
            const c = cues[i];
            const text = c && typeof c.text === 'string' ? c.text : '';
            if (!text || !Number.isFinite(c.startTime) || !Number.isFinite(c.endTime) || c.endTime <= c.startTime) continue;
            out += `${vttTime(c.startTime)} --> ${vttTime(c.endTime)}\n${text.replace(/\n{2,}/g, '\n')}\n\n`;
            if (out.length > 1500000) break;
        }
        return out;
    }

    // In-memory tracks are often created late (addTextTrack() after `playing`) and filled
    // incrementally, so each one is re-checked until its cue count has been stable for a moment;
    // only then is it serialized. A track that keeps growing a lot afterwards is re-reported a
    // bounded number of times (the engine keys inline tracks by size, so every report is a new entry).
    const SUB_RECHECK_MS = 2000;   // re-check period while a track is pending
    const SUB_MAX_RUNS = 15;       // ~30 s of re-checks after the last real change
    const SUB_STABLE_MS = 1500;    // cue count must be unchanged this long before serializing
    const SUB_MAX_REPORTS = 3;     // per track (first report + 2 substantial growths)
    let trackState = new WeakMap(); // TextTrack -> { count, changedAt, reported, reports }
    const subWatch = new WeakMap();   // <video> -> { timer, runs, off: [], tracks: WeakSet }

    /** @returns {{pending: boolean, grew: boolean}} */
    function checkTrack(t) {
        let cues = null;
        try {
            if (t.mode === 'disabled') return { pending: false, grew: false }; // no cues while disabled; 'change' re-kicks
            cues = t.cues;
        } catch (_) { return { pending: false, grew: false }; }
        const count = cues ? cues.length : 0;
        const now = Date.now();
        let st = trackState.get(t);
        if (!st) { st = { count: -1, changedAt: now, reported: 0, reports: 0 }; trackState.set(t, st); }
        let grew = false;
        if (count !== st.count) {
            grew = st.count >= 0 && count > st.count;
            st.count = count;
            st.changedAt = now;
        }
        const min = 1;
        if (count < min) return { pending: true, grew };
        if (st.reports >= SUB_MAX_REPORTS || count <= st.reported) return { pending: false, grew };
        // After a first report, only substantial growth is worth another (size-keyed) entry.
        if (st.reported >= 5 && count < Math.max(st.reported + 5, st.reported * 1.25)) return { pending: true, grew };
        if (now - st.changedAt < SUB_STABLE_MS) return { pending: true, grew }; // still being filled
        st.reported = count;
        st.reports++;
        reportSubtitle({ vtt: serializeCues(cues), label: t.label || '', language: t.language || '', kind: t.kind === 'chapters' ? 'chapters' : 'subtitles', method: 'textTracks' });
        return { pending: false, grew };
    }

    function stopSubtitleWatch(video) {
        const w = subWatch.get(video);
        if (!w) return;
        clearTimeout(w.timer);
        for (const off of w.off) { try { off(); } catch (_) { /* ignore */ } }
        subWatch.delete(video); // re-watched if the element is inserted and scanned again
    }

    function runSubtitleWatch(video) {
        const w = subWatch.get(video);
        if (!w) return;
        w.timer = 0;
        // Removed from the page and not playing detached: drop timers and listeners.
        if (!video.isConnected && (video.paused || video.ended)) { stopSubtitleWatch(video); return; }
        w.runs++;
        const r = scanSubtitleTracks(video, true);
        if (r.grew) w.runs = 0; // cues still arriving: extend the watch window
        if (r.pending && w.runs < SUB_MAX_RUNS) w.timer = setTimeout(runSubtitleWatch, SUB_RECHECK_MS, video);
    }

    /** reset=true for real signals (new track, mode change, cue growth); false for opportunistic scans. */
    function kickSubtitleWatch(video, reset) {
        const w = subWatch.get(video);
        if (!w) return;
        if (reset) w.runs = 0;
        if (!w.timer && w.runs < SUB_MAX_RUNS) w.timer = setTimeout(runSubtitleWatch, SUB_RECHECK_MS, video);
    }

    function watchTextTracks(video) {
        if (subWatch.has(video)) return;
        let list;
        try { list = video.textTracks; } catch (_) { return; }
        if (!list || typeof list.addEventListener !== 'function') return;
        const w = { timer: 0, runs: 0, off: [], tracks: new WeakSet() };
        subWatch.set(video, w);
        const on = (target, type, fn) => {
            target.addEventListener(type, fn);
            w.off.push(() => target.removeEventListener(type, fn));
        };
        const watchTrack = (t) => {
            if (!t || w.tracks.has(t)) return;
            w.tracks.add(t);
            // cuechange fires on every active-cue change during playback: only react to growth.
            on(t, 'cuechange', () => {
                let n = 0;
                try { n = t.cues ? t.cues.length : 0; } catch (_) { return; }
                const st = trackState.get(t);
                if (!st || n !== st.count) kickSubtitleWatch(video, true);
            });
        };
        try { for (let i = 0; i < list.length; i++) watchTrack(list[i]); } catch (_) { /* ignore */ }
        on(list, 'addtrack', (e) => { watchTrack(e.track); kickSubtitleWatch(video, true); });
        on(list, 'change', () => kickSubtitleWatch(video, true));
    }

    /** @returns {{pending: boolean, grew: boolean}} whether some in-memory track still needs a re-check */
    function scanSubtitleTracks(video, fromWatch) {
        const result = { pending: false, grew: false };
        if (!video || video.tagName !== 'VIDEO') return result;
        video.querySelectorAll('track[src]').forEach(tr => {
            const kind = (tr.getAttribute('kind') || 'subtitles').toLowerCase();
            if (kind !== 'subtitles' && kind !== 'captions' && kind !== 'chapters') return;
            reportSubtitle({ url: tr.src || tr.getAttribute('src'), label: tr.label || '', language: tr.srclang || '', isDefault: tr.default, kind: kind === 'chapters' ? 'chapters' : 'subtitles', method: 'track' });
        });
        watchTextTracks(video);
        // TextTracks that belong to a <track src> element were reported above by URL.
        const backed = new Set(Array.from(video.querySelectorAll('track[src]')).map(tr => tr.track));
        let tracks;
        try { tracks = Array.from(video.textTracks || []); } catch (_) { return result; }
        for (const t of tracks) {
            if (t.kind !== 'subtitles' && t.kind !== 'captions' && t.kind !== 'chapters') continue;
            if (backed.has(t)) continue;
            // Only in-memory cue lists (addTextTrack()/addCue()) are serialized.
            const r = checkTrack(t);
            if (r.pending) result.pending = true;
            if (r.grew) result.grew = true;
        }
        if (!fromWatch && result.pending) kickSubtitleWatch(video, result.grew);
        return result;
    }

    // ------------------------------------------------------------------
    // 3. Proxy fetch bookkeeping (single listener, id -> pending map)
    // ------------------------------------------------------------------
    const pendingFetches = new Map();

    let routeUrl = location.href;
    let lastMeta = '';

    function reportPageMeta() {
        if (!IS_TOP) return;
        const meta = name => document.querySelector('meta[property="og:' + name + '"]')?.content || '';
        const titles = [meta('title'), document.querySelector('h1')?.textContent, document.title].map(v => (v || '').trim()).filter(Boolean);
        let path = location.pathname;
        try { path = decodeURIComponent(path); } catch (_) { /* malformed escape */ }
        const siteName = meta('site_name') || location.hostname;
        let structured;
        for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 6)) {
            if (!script.textContent || script.textContent.length > 65536) continue;
            try {
                const data = JSON.parse(script.textContent);
                const nodes = Array.isArray(data) ? data : Array.isArray(data?.['@graph']) ? data['@graph'] : [data];
                structured = nodes.find(node => ['Movie', 'TVSeries', 'TVEpisode'].includes(node?.['@type']));
                if (structured) break;
            } catch (_) { /* invalid structured metadata */ }
        }
        const tags = [...document.querySelectorAll('meta[property="video:tag"], meta[property="article:tag"], meta[name="genre"]')].slice(0, 12).map(m => m.content);
        const classification = S.classifyLibraryMedia({
            pageUrl: location.href, siteName, title: titles.join(' '),
            type: structured?.['@type'] || meta('type'), hints: [...tags, structured?.genre].join(' ')
        });
        const season = structured?.partOfSeason?.seasonNumber;
        const episode = structured?.episodeNumber;
        if (typeof season === 'number' && Number.isFinite(season)) classification.season = season;
        if (typeof episode === 'number' && Number.isFinite(episode)) classification.episode = episode;
        const titleFromPath = path.match(/\/(?:series|shows?|anime|donghua|cartoons?|movies?)\/([^/]+)/i)?.[1]?.replace(/[-_]/g, ' ') || '';
        const showTitle = [structured?.partOfSeries?.name, structured?.name, ...titles, titleFromPath].filter(title => typeof title === 'string').map(title => title.replace(/\s*(?:[-–—:|]\s*)?(?:\b(?:season|episodes?|ep)[\s._-]*\d|\bs\d+e\d).*$/i, '').trim()).find(Boolean) || '';
        const poster = meta('image') ? S.normalizeUrl(meta('image'), location.href) : '';
        const pageMeta = {
            pageUrl: location.href,
            siteName: siteName.slice(0, 200),
            showTitle: showTitle.slice(0, 200),
            ...classification,
            poster: /^https?:/i.test(poster || '') ? poster : ''
        };
        const snapshot = JSON.stringify(pageMeta);
        if (snapshot !== lastMeta) {
            lastMeta = snapshot;
            send({ action: 'PAGE_META', pageMeta });
        }
    }

    function resetDetection(rescan = false) {
        reportedUrls.clear();
        reportedSubs.clear();
        mseReported = videoReported = drmReported = false;
        trackState = new WeakMap();
        badge.dismissed = false;
        if (rescan) postToPage({ type: 'RESCAN', nonce: bridgeNonce() });
        else {
            restoreMedia(false);
            badge.state.count = 0;
            renderBadge();
            if (IS_TOP) send({ action: 'ROUTE_CHANGE', pageUrl: routeUrl });
        }
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scanMedia, 350);
    }

    window.addEventListener('message', (event) => {
        if (!event.isTrusted || event.source !== window || event.origin !== frameOrigin) return;
        const msg = event.data;
        if (!msg || msg.source !== TAG_FROM_PAGE) return;
        if (msg.type !== 'FETCH_RESULT' && msg.pageUrl !== location.href) return;
        switch (msg.type) {
            case 'ROUTE_CHANGE':
                if (msg.pageUrl === location.href && routeUrl !== location.href) {
                    routeUrl = location.href;
                    resetDetection();
                }
                break;
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
                if (pending?.nonce === msg.nonce) pending.complete(msg);
                break;
            }
            default:
                break;
        }
    });

    function proxyFetch(message, sendResponse) {
        if (frameOrigin === 'null') {
            sendResponse({ ok: false, status: 0, error: 'Page fetch is unavailable in an opaque frame.' });
            return;
        }
        const nonce = bridgeNonce();
        const id = message.id || nonce;
        const timer = setTimeout(() => {
            if (!pendingFetches.has(id)) return;
            pendingFetches.delete(id);
            postToPage({ type: 'FS_ABORT', id, nonce });
            sendResponse({ ok: false, status: 0, error: `Page fetch timeout (${PROXY_TIMEOUT_MS}ms)` });
        }, PROXY_TIMEOUT_MS);

        pendingFetches.set(id, { nonce, complete(result) {
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
        } });

        postToPage({
            type: 'FS_FETCH',
            id,
            nonce,
            url: message.url,
            method: message.method || 'GET',
            headers: message.headers || {}
        });
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
        if (routeUrl !== location.href) { routeUrl = location.href; resetDetection(); return; }
        reportPageMeta();
        if (suspended) for (const el of suspended.keys()) {
            if (!el.isConnected) { el.muted = suspended.get(el).muted; suspended.delete(el); }
        }
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
        // The mounted player may have lost / gained its target <video>.
        if (mount.mode === 'inline') scheduleSync();
    }

    function scheduleScan() {
        if (scanTimer) return;
        scanTimer = setTimeout(scanMedia, 400);
    }

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (IS_TOP && document.head?.contains(m.target)) { scheduleScan(); return; }
            for (const node of m.removedNodes) {
                if (node.nodeType === 1 && (node.matches('video, audio, source') || node.querySelector('video, audio, source'))) {
                    scheduleScan();
                    return;
                }
            }
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
            characterData: IS_TOP,
            attributeFilter: ['src', 'content']
        });
        scheduleScan();
    }
    if (document.documentElement) startObserving();
    else document.addEventListener('readystatechange', startObserving, { once: true });
    window.addEventListener('load', scheduleScan, { once: true });
    window.addEventListener('popstate', scheduleScan);
    window.addEventListener('hashchange', scheduleScan);
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
        if (!suspended.has(el)) suspended.set(el, { muted: el.muted, playing: !el.paused && !el.ended });
        try { el.pause(); } catch (_) { /* ignore */ }
        el.muted = true;
    }

    function onNativePlay(e) {
        // Media events do not escape shadow roots, so Velostream's own <video> never lands here.
        if (suspended?.has(e.target)) suspendElement(e.target);
    }

    function suspendMedia() {
        if (!suspended) {
            suspended = new Map();
            document.addEventListener('play', onNativePlay, true);
        }
        collectMedia(document, []).forEach(suspendElement);
    }

    function restoreMedia(resume = true) {
        if (!suspended) return;
        document.removeEventListener('play', onNativePlay, true);
        for (const [el, state] of suspended) {
            try {
                el.muted = state.muted;
                if (resume && state.playing && el.isConnected) el.play()?.catch(() => { });
            } catch (_) { /* detached */ }
        }
        suspended = null;
    }

    // ------------------------------------------------------------------
    // 5. In-place player mount
    //    The player is an extension page (player/player.html) shown in an <iframe>. The iframe
    //    is appended ONCE to <html> (outside <body>) and never moved again: re-parenting an
    //    iframe unloads and reloads its document (player, Shaka, runtime port, playback). Every
    //    mode is pure CSS on that one element:
    //      inline - position:fixed over the site's <video>, tracking its viewport box on scroll
    //               (any scroller), resize, ResizeObserver and layout changes, clipped by the
    //               video's scrolling ancestors; hidden while the video is detached/zero-size.
    //      mini   - fixed floating window (drag/resize driven by the player's layout messages).
    //      fill / page - fixed, covers the viewport; the page underneath is locked.
    //    The original video is paused, muted and hidden while the player is mounted.
    // ------------------------------------------------------------------
    const mount = {
        frame: null, session: null, video: null, mode: null, prevMode: null,
        videoStyle: null, timer: null, ro: null, rect: null, dragStart: null, pageLock: null,
        float: null, raf: 0, lostAt: 0, fix: { ax: 0, ay: 0, sx: 1, sy: 1 }, lastCss: ''
    };
    const FRAME_Z = '2147483647';
    const VIDEO_LOST_GRACE_MS = 1500; // a re-rendering site may swap its <video>: wait before going full page
    const MOUNT_POLL_MS = 250;        // fallback for layout changes no event reports

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

    function setFrameStyle(css) {
        const f = mount.frame;
        if (!f) return;
        f.style.cssText = `all: initial; display: block; border: 0; margin: 0; padding: 0; background: #000; color-scheme: normal; z-index: ${FRAME_Z}; ${css}`;
    }

    /**
     * position:fixed at viewport coordinates. A transform/filter on <html> makes it the containing
     * block of fixed boxes, and `zoom` / `transform: scale()` on <html> scales them, so the frame
     * is modelled as rendered = a + s * css per axis: the real box is measured and both the offset
     * (a) and the scale (s) are compensated. (Offset-only compensation, used before, put the frame
     * at the wrong place AND size on a page with `html { zoom: 1.25 }`: the error is multiplicative.)
     * `extra` may be a function of the current model (for lengths such as clip-path insets).
     */
    function placeFixed(x, y, w, h, extra) {
        const f = mount.frame;
        if (!f) return;
        const css = (m) => `position: fixed; left: ${(x - m.ax) / m.sx}px; top: ${(y - m.ay) / m.sy}px; width: ${w / m.sx}px; height: ${h / m.sy}px; ${(typeof extra === 'function' ? extra(m) : extra) || ''}`;
        const m = mount.fix;
        mount.lastCss = css(m);
        setFrameStyle(mount.lastCss);
        if (!f.isConnected) return;
        const fr = f.getBoundingClientRect();
        const sx = w >= 2 && fr.width > 0 ? fr.width / (w / m.sx) : m.sx;
        const sy = h >= 2 && fr.height > 0 ? fr.height / (h / m.sy) : m.sy;
        const ax = fr.left - sx * ((x - m.ax) / m.sx);
        const ay = fr.top - sy * ((y - m.ay) / m.sy);
        const sane = sx > 0.05 && sx < 20 && sy > 0.05 && sy < 20 && Math.abs(ax) < 1e5 && Math.abs(ay) < 1e5;
        if (sane && (Math.abs(ax - m.ax) > 0.5 || Math.abs(ay - m.ay) > 0.5 || Math.abs(sx - m.sx) > 0.002 || Math.abs(sy - m.sy) > 0.002)) {
            mount.fix = { ax, ay, sx, sy };
            mount.lastCss = css(mount.fix);
            setFrameStyle(mount.lastCss);
        }
    }

    /** page / fill: cover the viewport (measured like the other modes, see placeFixed). */
    function placePage() {
        placeFixed(0, 0, innerWidth, innerHeight);
    }

    /** Hide (not resize: the player keeps its layout) while the target video is unavailable. */
    function hideInline() {
        if (mount.rect === 'hidden') return;
        mount.rect = 'hidden';
        setFrameStyle(`${mount.lastCss || 'position: fixed; left: 0; top: 0; width: 0; height: 0;'} visibility: hidden;`);
    }

    /** Parent in the flattened tree (slots, open/closed shadow hosts). */
    function flatParent(node) {
        if (node.assignedSlot) return node.assignedSlot;
        if (node.parentElement) return node.parentElement;
        const p = node.parentNode;
        return p && p.nodeType === 11 && p.host ? p.host : null;
    }

    /**
     * The visible part of the video inside its scrolling ancestors (an inner scroller would have
     * clipped the old in-flow iframe too). Only containers that actually overflow are used, and
     * the walk stops at a position:fixed ancestor, so a non-scrolling overflow:hidden wrapper never
     * hides a visible video. Returns null when nothing is visible, '' when nothing is clipped, else the
     * [top, right, bottom, left] insets in viewport px (see clipCss).
     */
    function inlineClip(v, vr) {
        let l = vr.left;
        let t = vr.top;
        let r = vr.right;
        let b = vr.bottom;
        let node = flatParent(v);
        let budget = 64;
        while (node && node !== document.body && node !== document.documentElement && budget-- > 0) {
            const cs = getComputedStyle(node);
            if ((cs.overflowX !== 'visible' || cs.overflowY !== 'visible') &&
                (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)) {
                const nr = node.getBoundingClientRect();
                const cl = nr.left + node.clientLeft;
                const ct = nr.top + node.clientTop;
                l = Math.max(l, cl);
                t = Math.max(t, ct);
                r = Math.min(r, cl + node.clientWidth);
                b = Math.min(b, ct + node.clientHeight);
            }
            if (cs.position === 'fixed') break;
            node = flatParent(node);
        }
        if (r - l < 1 || b - t < 1) return null;
        const it = t - vr.top;
        const ir = vr.right - r;
        const ib = vr.bottom - b;
        const il = l - vr.left;
        if (it < 0.5 && ir < 0.5 && ib < 0.5 && il < 0.5) return '';
        return [it, ir, ib, il];
    }

    /** clip-path for inlineClip()'s insets (viewport px) in the frame's own (possibly scaled) px. */
    function clipCss(clip) {
        if (!clip) return '';
        return (m) => `clip-path: inset(${clip[0] / m.sy}px ${clip[1] / m.sx}px ${clip[2] / m.sy}px ${clip[3] / m.sx}px);`;
    }

    /** Keep the iframe exactly on top of the original video (viewport coordinates). */
    function syncInline() {
        if (mount.mode !== 'inline' || !mount.frame) return;
        const v = mount.video;
        if (!v || !v.isConnected) {
            // The site replaced its <video> (SPA re-render): follow the new one; give it a moment
            // to appear before falling back to full page.
            const next = pickVideo(null);
            if (next) { mount.lostAt = 0; attachToVideo(next); return; }
            if (!mount.lostAt) mount.lostAt = Date.now();
            if (Date.now() - mount.lostAt < VIDEO_LOST_GRACE_MS) { hideInline(); return; }
            mount.lostAt = 0;
            setMode('page');
            return;
        }
        mount.lostAt = 0;
        const vr = v.getBoundingClientRect();
        if (vr.width < 2 || vr.height < 2) { hideInline(); return; } // hidden/collapsed by the site
        const clip = inlineClip(v, vr);
        if (clip === null) { hideInline(); return; } // scrolled out of its scroller
        const key = `${vr.left}|${vr.top}|${vr.width}|${vr.height}|${clip}`;
        if (key === mount.rect) return;
        mount.rect = key;
        placeFixed(vr.left, vr.top, vr.width, vr.height, clipCss(clip));
    }

    /** rAF-throttled re-layout for scroll / resize / ResizeObserver / transitions. */
    function scheduleSync() {
        if (!mount.frame || mount.raf) return;
        mount.raf = requestAnimationFrame(() => {
            mount.raf = 0;
            if (mount.mode === 'inline') syncInline();
            // With a transformed <html> (containing block of fixed boxes) the frame scrolls with
            // the document, so the floating / full-page frame must be re-measured too.
            else if (mount.mode === 'mini' && mount.float && !mount.dragStart) applyFloating();
            else if (mount.mode === 'page' || mount.mode === 'fill') placePage();
        });
    }

    function onMountScroll() {
        scheduleSync();
    }

    function onMountResize() {
        if (mount.mode === 'mini' && mount.float && !mount.dragStart) {
            // Keep the floating window on screen when the viewport shrinks.
            mount.float = clampRect(mount.float);
        }
        scheduleSync();
    }

    function onMountLayoutEvent(e) {
        if (mount.mode !== 'inline' || !e.target || e.target === mount.frame) return;
        scheduleSync();
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

    /** Point the (already mounted, never moved) iframe at `video`. Pure bookkeeping + CSS. */
    function attachToVideo(video) {
        unhideVideo();
        mount.video = video;
        hideVideo(video);
        suspendElement(video);
        if (mount.ro) mount.ro.disconnect();
        mount.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleSync) : null;
        if (mount.ro) mount.ro.observe(video);
        mount.rect = null;
        syncInline();
    }

    function lockPage(on) {
        if (on && !mount.pageLock) {
            const body = document.body;
            // The frame lives on <html>, outside <body>, so an inert body never makes it inert.
            const canInert = !!(body && mount.frame && !body.contains(mount.frame));
            mount.pageLock = { overflow: document.documentElement.style.overflow, body: canInert ? body : null, inert: canInert ? body.inert : false };
            document.documentElement.style.overflow = 'hidden';
            if (canInert) body.inert = true;
        } else if (!on && mount.pageLock) {
            document.documentElement.style.overflow = mount.pageLock.overflow;
            // Restore the body that was locked (a site may have swapped <body> meanwhile).
            if (mount.pageLock.body) mount.pageLock.body.inert = mount.pageLock.inert;
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
        placeFixed(r.x, r.y, r.w, r.h, 'border-radius: 16px; overflow: hidden; box-shadow: 0 16px 40px rgba(0,0,0,.55), 0 2px 10px rgba(0,0,0,.3);');
    }

    /** Mode switches only restyle the iframe; it is never re-parented (that would reload it). */
    function setMode(mode, opts = {}) {
        if (!mount.frame) return;
        const prev = mount.mode;
        if (prev === mode) return;
        if (mode === 'mini' || mode === 'fill') mount.prevMode = prev;
        mount.mode = mode;
        mount.rect = null;
        mount.dragStart = null;
        if (mode === 'inline') {
            lockPage(false);
            let v = mount.video && mount.video.isConnected ? mount.video : null;
            if (!v) v = pickVideo(null); // the site re-rendered its player while we floated
            if (v) attachToVideo(v);
            else setMode('page');
            return;
        }
        if (mode === 'page' || mode === 'fill') {
            lockPage(true);
            placePage();
        } else if (mode === 'mini') {
            lockPage(false);
            mount.float = clampRect(mount.float || miniRect(opts.ratio));
            applyFloating();
        }
    }

    /**
     * The frame lives on <html>: while a SITE element is fullscreen (its own player container,
     * e.g. entered on rotation on mobile, or already fullscreen at mount) the top layer covers
     * the frame, and the user sees the paused, hidden original video: black. Leave that
     * fullscreen. The player's own fullscreen (fullscreenElement === the frame) and a fullscreen
     * <html> (which contains the frame) are left alone.
     */
    function onMountFullscreen() {
        if (!mount.frame) return;
        const fs = document.fullscreenElement || document.webkitFullscreenElement || null;
        if (fs && fs !== mount.frame && !fs.contains(mount.frame)) {
            try {
                const exit = document.exitFullscreen || document.webkitExitFullscreen;
                const p = exit && exit.call(document);
                if (p && p.catch) p.catch(() => { });
            } catch (_) { /* ignore */ }
        }
        mount.rect = null;
        scheduleSync();
    }

    function unmountPlayer() {
        if (!mount.frame) return;
        if (mount.ro) mount.ro.disconnect();
        clearInterval(mount.timer);
        if (mount.raf) cancelAnimationFrame(mount.raf);
        document.removeEventListener('fullscreenchange', onMountFullscreen);
        document.removeEventListener('webkitfullscreenchange', onMountFullscreen);
        window.removeEventListener('resize', onMountResize);
        window.removeEventListener('scroll', onMountScroll, true);
        document.removeEventListener('transitionend', onMountLayoutEvent, true);
        document.removeEventListener('animationend', onMountLayoutEvent, true);
        lockPage(false);
        mount.frame.remove();
        unhideVideo();
        restoreMedia();
        Object.assign(mount, {
            frame: null, session: null, video: null, mode: null, prevMode: null, ro: null, rect: null, timer: null,
            float: null, raf: 0, lostAt: 0, fix: { ax: 0, ay: 0, sx: 1, sy: 1 }, lastCss: '', dragStart: null
        });
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
                    const ratio = s.h / s.w;
                    // Cap by height too: clampRect() would otherwise cut h alone (short landscape
                    // viewport), breaking the aspect ratio and the bottom-right anchor.
                    const w = Math.min(Math.max(s.w - (+d.dx || 0), 200), innerWidth - 16, (innerHeight - 16) / ratio);
                    const h = Math.round(w * ratio);
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
        if (Number.isFinite(message.startTime) && message.startTime >= 0) {
            url.searchParams.set('t', String(message.startTime));
            url.searchParams.set('explicitStart', '1');
        } else if (video && Number.isFinite(video.currentTime) && video.currentTime > 1 && Number.isFinite(video.duration)) {
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
        // Styled before insertion (no flash), then parented to <html> once and for all: modes
        // below only restyle it. Inserted before positioning so placeFixed() can measure it.
        setFrameStyle('position: fixed; left: 0; top: 0; width: 0; height: 0; visibility: hidden;');
        frame.addEventListener('load', () => { try { frame.focus(); } catch (_) { /* ignore */ } }, { once: true });
        document.documentElement.appendChild(frame);
        if (video) {
            mount.mode = 'inline';
            attachToVideo(video);
        } else {
            mount.mode = null;
            setMode('page');
        }
        window.addEventListener('resize', onMountResize, { passive: true });
        // Capture phase: scrolling any ancestor scroller moves the video too.
        window.addEventListener('scroll', onMountScroll, { passive: true, capture: true });
        document.addEventListener('transitionend', onMountLayoutEvent, true);
        document.addEventListener('animationend', onMountLayoutEvent, true);
        document.addEventListener('fullscreenchange', onMountFullscreen);
        document.addEventListener('webkitfullscreenchange', onMountFullscreen);
        onMountFullscreen();
        mount.timer = setInterval(() => {
            if (!mount.frame) return;
            if (!mount.frame.isConnected && document.documentElement) {
                // The page wiped <html>'s children (document.open / framework root swap) and our
                // iframe with them. Re-inserting is the only option and reloads the player page
                // (it resumes via the saved history); never done for a mere mode change.
                document.documentElement.appendChild(mount.frame);
                mount.rect = null;
                if (mount.pageLock) { lockPage(false); lockPage(true); } // the old <body> may be gone
            }
            if (mount.mode === 'inline') syncInline(); // layout changes no event reported
        }, MOUNT_POLL_MS);
        return { ok: true, mode: video ? 'inline' : 'page' };
    }

    // ------------------------------------------------------------------
    // 6. On-page "Play in Velostream" glass pill
    //    The top frame anchors the badge to its largest video, or the viewport corner for embeds.
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
.close { width: 44px; height: 44px; margin-left: 4px; }
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
        S.setHTML(shadow, `
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
        const style = document.createElement('style');
        style.textContent = BADGE_CSS;
        shadow.prepend(style);
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
        // No pointerup follows a cancelled pointer (touch turned into a gesture, capture
        // stolen): without this, `drag` stayed set and later hover moves dragged the pill.
        play.addEventListener('pointercancel', () => { drag = null; });
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
        // `zoom` / transform on <html> scales and offsets fixed boxes (the host lives on <html>):
        // measure rendered = a + s * css, then compute in viewport px and convert back. Without
        // this, `html { zoom: 1.25 }` put the clamped pill entirely off-screen on the right.
        if (!pill.style.left) { pill.style.left = '0px'; pill.style.top = '0px'; }
        const pr = pill.getBoundingClientRect();
        const lw = pill.offsetWidth;
        const lh = pill.offsetHeight;
        let sx = lw && pr.width ? pr.width / lw : 1;
        let sy = lh && pr.height ? pr.height / lh : 1;
        if (!(sx > 0.05 && sx < 20)) sx = 1;
        if (!(sy > 0.05 && sy < 20)) sy = 1;
        const ax = pr.left - sx * (parseFloat(pill.style.left) || 0);
        const ay = pr.top - sy * (parseFloat(pill.style.top) || 0);
        const w = (lw || 220) * sx;
        const h = (lh || 44) * sy;
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
        pill.style.left = `${Math.round((x - ax) / sx)}px`;
        pill.style.top = `${Math.round((y - ay) / sy)}px`;
    }

    let rafPending = false;
    function schedulePosition() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; positionBadge(); });
    }

    function renderBadge() {
        const s = badge.state;
        const show = IS_TOP && badge.enabled && !badge.dismissed && !s.playerOpen && s.count > 0;
        badge.target = show ? largestVideo() : null;
        if (!show) {
            if (badge.shadow) badge.shadow.querySelector('.pill').hidden = true;
            return;
        }
        ensureBadge();
        if (!badge.shadow) return;
        // The page wiped <html>'s children (document.open, root swap): put the host back.
        if (!badge.host.isConnected && document.documentElement) document.documentElement.appendChild(badge.host);
        const pill = badge.shadow.querySelector('.pill');
        badge.shadow.querySelector('.meta').textContent = s.label ? `• ${s.label}` : '';
        badge.shadow.querySelector('.play').setAttribute('aria-label', `Play this video in Velostream${s.label ? `, ${s.label}` : ''}`);
        pill.hidden = false;
        positionBadge();
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
                    postToPage({ type: 'FS_ABORT', id: message.id, nonce: pendingFetches.get(message.id).nonce });
                }
                return false;
            case 'SUSPEND_MEDIA':
                suspendMedia();
                return false;
            case 'RESTORE_MEDIA':
                if (!mount.frame) restoreMedia();
                return false;
            case 'ROUTE_RESET':
                if (!IS_TOP) { restoreMedia(false); resetDetection(true); }
                return false;
            case 'RESCAN':
                resetDetection(true);
                sendResponse({ ok: true });
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
