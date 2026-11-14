/**
 * FastStream Mobile - Content Sniffer & Bridge (ISOLATED world, every frame)
 *
 * Roles:
 *  1. Relay interceptor detections (MAIN world) to the engine - de-duplicated.
 *  2. Debounced DOM scan for <video>/<audio> (+ <source> children, open shadow roots).
 *  3. FETCH_PROXY executor: the engine asks THIS frame to fetch with the page's identity;
 *     bodies come back from the MAIN world as transferred ArrayBuffers and are packed
 *     (ArrayBuffer on Firefox, base64 on Chromium) for runtime messaging.
 *  4. SUSPEND_MEDIA / RESTORE_MEDIA: pause + mute native players while FastStream plays.
 *  5. Top frame only: BRIDGE between the MAIN-world player (private MessagePort) and the
 *     engine (runtime port "faststream-player"), plus chrome.storage access for settings.
 */
(function () {
    'use strict';
    if (globalThis.__FASTSTREAM_SNIFFER__) return;
    globalThis.__FASTSTREAM_SNIFFER__ = true;

    const S = globalThis.FastStreamShared;
    const api = S.api;
    const IS_TOP = window === window.top;
    const TAG_FROM_PAGE = 'faststream-interceptor';
    const TAG_TO_PAGE = 'faststream-sniffer';
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
        // Walk open shadow roots (custom player elements) except FastStream's own host.
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        let budget = 5000; // bound the cost on huge DOMs
        while (node && budget-- > 0) {
            if (node.shadowRoot && node.id !== 'faststream-host') collectMedia(node.shadowRoot, out);
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
            const candidates = [el.currentSrc, el.getAttribute('src')];
            el.querySelectorAll('source[src]').forEach(s => candidates.push(s.src || s.getAttribute('src')));
            for (const raw of candidates) {
                if (!raw) continue;
                const url = S.normalizeUrl(raw, location.href);
                const type = S.classifyStream(url);
                if (type) reportStream({ url, type, method: 'dom_scan' });
            }
        }
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

    // ------------------------------------------------------------------
    // 4. Native media suspension while FastStream plays
    // ------------------------------------------------------------------
    let suspended = null; // Map<HTMLMediaElement, {muted:boolean}>

    function suspendElement(el) {
        if (!suspended || !(el instanceof HTMLMediaElement)) return;
        if (!suspended.has(el)) suspended.set(el, { muted: el.muted });
        try { el.pause(); } catch (_) { /* ignore */ }
        el.muted = true;
    }

    function onNativePlay(e) {
        // Media events do not escape shadow roots, so FastStream's own <video> never lands here.
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
    // 5. Bridge (top frame only)
    // ------------------------------------------------------------------
    const bridge = {
        playerPort: null,     // MessagePort to MAIN-world player
        enginePort: null,     // runtime port to background
        sessionId: null,
        streamId: null,
        closed: true,
        reconnects: 0,
        storageListener: null
    };

    async function readSettings() {
        const res = await api.storage.local.get(S.SETTINGS_KEY);
        return S.mergeSettings(res[S.SETTINGS_KEY]);
    }

    function toPlayer(msg, transfer) {
        if (!bridge.playerPort) return;
        try { bridge.playerPort.postMessage(msg, transfer || []); } catch (_) { /* closed */ }
    }

    function connectEngine(resumed) {
        if (bridge.closed) return;
        let port;
        try {
            port = api.runtime.connect({ name: 'faststream-player' });
        } catch (err) {
            toPlayer({ type: 'FATAL', error: 'Extension was reloaded. Close the player and reload the page.' });
            return;
        }
        bridge.enginePort = port;
        port.onMessage.addListener((msg) => {
            if (!msg) return;
            bridge.reconnects = 0;
            if (msg.data && (msg.data.kind === 'b64' || msg.data.kind === 'ab')) {
                const buf = S.unpackBinary(msg.data);
                toPlayer({ ...msg, data: buf }, buf ? [buf] : []);
            } else {
                toPlayer(msg);
            }
        });
        port.onDisconnect.addListener(() => {
            if (bridge.enginePort === port) bridge.enginePort = null;
            if (bridge.closed) return;
            // Service worker restarted / event page suspended: fail in-flight requests so the
            // player retries them, then reconnect with the same session id (cache is reused).
            toPlayer({ type: 'ENGINE_RESET' });
            if (bridge.reconnects++ < 8) {
                setTimeout(() => connectEngine(true), Math.min(4000, 250 * Math.pow(2, bridge.reconnects)));
            } else {
                toPlayer({ type: 'FATAL', error: 'Lost connection to the FastStream engine.' });
            }
        });
        port.postMessage({ type: 'HELLO', sessionId: bridge.sessionId, streamId: bridge.streamId, resumed: !!resumed });
    }

    async function onPlayerMessage(event) {
        const msg = event.data;
        if (!msg || typeof msg.type !== 'string') return;
        switch (msg.type) {
            case 'SETTINGS_GET':
                toPlayer({ type: 'SETTINGS', reqId: msg.reqId, settings: await readSettings() });
                return;
            case 'SETTINGS_SET': {
                const current = await readSettings();
                const next = S.mergeSettings({ ...current, ...(msg.patch || {}) });
                await api.storage.local.set({ [S.SETTINGS_KEY]: next });
                return;
            }
            case 'STORE_GET': {
                if (typeof msg.key !== 'string' || !msg.key.startsWith('fs_bm_')) return;
                const res = await api.storage.local.get(msg.key);
                toPlayer({ type: 'STORE_VALUE', reqId: msg.reqId, value: res[msg.key] ?? null });
                return;
            }
            case 'STORE_SET':
                // The port is reachable from page JS in principle: only the bookmark namespace,
                // bounded size, so a hostile page cannot fill extension storage.
                if (typeof msg.key !== 'string' || !/^fs_bm_[\w-]{1,64}$/.test(msg.key)) return;
                if (JSON.stringify(msg.value || null).length > 64 * 1024) return;
                await api.storage.local.set({ [msg.key]: msg.value });
                return;
            case 'CLOSE':
                if (bridge.enginePort) bridge.enginePort.postMessage({ type: 'CLOSE' });
                teardownBridge();
                return;
            default:
                if (bridge.enginePort) {
                    try { bridge.enginePort.postMessage(msg); } catch (_) { /* reconnecting */ }
                } else if (msg.type === 'REQUEST') {
                    toPlayer({ type: 'RESPONSE', reqId: msg.reqId, ok: false, status: 0, error: 'Engine reconnecting' });
                }
        }
    }

    function teardownBridge({ restore = true } = {}) {
        bridge.closed = true;
        if (bridge.storageListener) api.storage.onChanged.removeListener(bridge.storageListener);
        bridge.storageListener = null;
        try { bridge.playerPort && bridge.playerPort.close(); } catch (_) { /* ignore */ }
        bridge.playerPort = null;
        const port = bridge.enginePort;
        bridge.enginePort = null;
        if (port) setTimeout(() => { try { port.disconnect(); } catch (_) { /* ignore */ } }, 50);
        if (restore) restoreMedia();
    }

    function attachBridge(message) {
        if (!IS_TOP) return { ok: false, error: 'Bridge must run in the top frame' };
        // Stream switch: media was just suspended for the new session, keep it suspended.
        if (!bridge.closed) teardownBridge({ restore: false });
        const channel = new MessageChannel();
        bridge.playerPort = channel.port1;
        bridge.sessionId = message.sessionId;
        bridge.streamId = message.streamId;
        bridge.closed = false;
        bridge.reconnects = 0;
        channel.port1.onmessage = onPlayerMessage;
        bridge.storageListener = (changes, area) => {
            if (area === 'local' && changes[S.SETTINGS_KEY]) {
                toPlayer({ type: 'SETTINGS_CHANGED', settings: S.mergeSettings(changes[S.SETTINGS_KEY].newValue) });
            }
        };
        api.storage.onChanged.addListener(bridge.storageListener);
        // The MAIN-world boot function only accepts the port carrying its one-time nonce.
        window.postMessage({ source: 'faststream-bridge', type: 'FS_BRIDGE_PORT', nonce: message.nonce }, '*', [channel.port2]);
        connectEngine(false);
        return { ok: true };
    }

    // ------------------------------------------------------------------
    // Engine -> frame commands
    // ------------------------------------------------------------------
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || typeof message.action !== 'string') return false;
        switch (message.action) {
            case 'PING':
                if (!IS_TOP) return false;
                sendResponse({ ok: true });
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
                restoreMedia();
                return false;
            case 'RESCAN':
                reportedUrls.clear();
                mseReported = false;
                videoReported = false;
                scanMedia();
                return false;
            case 'BRIDGE_ATTACH':
                if (!IS_TOP) return false;
                sendResponse(attachBridge(message));
                return false;
            default:
                return false;
        }
    });
})();
