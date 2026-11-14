/**
 * Velostream - In-Page Interceptor
 *
 * Registered in manifest.json as a `"world": "MAIN"` content script at document_start in all
 * frames, so it runs before page scripts, is immune to the page's CSP, and inherits the
 * page's cookies / Referer / CORS identity for proxy fetches.
 *
 * 1. Detects HLS/DASH manifests requested via fetch/XHR (URL or Content-Type) and media
 *    elements whose src points at a stream, reporting each URL once.
 * 2. Signals (URL-less) MSE usage so the engine can rank the frame - never as a stream.
 * 3. Performs proxy fetches for the extension (FS_FETCH) and returns the body as a
 *    transferred ArrayBuffer (zero-copy) instead of a JSON array of numbers.
 */
(function () {
    'use strict';
    if (window.__VELOSTREAM_INTERCEPTOR__) return;
    Object.defineProperty(window, '__VELOSTREAM_INTERCEPTOR__', { value: true });

    const TAG_OUT = 'velostream-interceptor';
    const TAG_IN = 'velostream-sniffer';
    const MANIFEST_RE = /\.(m3u8|mpd)(\?|#|$)/i;
    const MANIFEST_MIME = /mpegurl|dash\+xml/i;
    const reported = new Set();

    // Capture pristine references before any page script can monkey-patch them.
    const origFetch = window.fetch;
    const OrigXHR = window.XMLHttpRequest;
    const xhrOpen = OrigXHR.prototype.open;
    const postMessage = window.postMessage.bind(window);
    const OrigAbortController = window.AbortController;
    const OrigHeaders = window.Headers;
    const location = window.location;

    function emit(type, payload, transfer) {
        try {
            postMessage({ source: TAG_OUT, type, ...payload }, '*', transfer || []);
        } catch (_) { /* detached frame */ }
    }

    function absolute(url) {
        try {
            return new URL(url, location.href).href;
        } catch (_) {
            return null;
        }
    }

    function report(rawUrl, method, mime) {
        const url = absolute(rawUrl);
        if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
        const byExt = MANIFEST_RE.test(url.split('#')[0]);
        const byMime = mime && MANIFEST_MIME.test(mime);
        if (!byExt && !byMime) return;
        const key = url.split('#')[0];
        if (reported.has(key)) return;
        reported.add(key);
        const isHls = /m3u8/i.test(url) || /mpegurl/i.test(mime || '');
        emit('STREAM_FOUND', { payload: { url: key, method, mime: mime || '', type: isHls ? 'hls' : 'dash' } });
    }

    function urlOf(resource) {
        if (!resource) return null;
        if (typeof resource === 'string') return resource;
        if (resource instanceof URL) return resource.href;
        if (typeof Request !== 'undefined' && resource instanceof Request) return resource.url;
        try { return String(resource); } catch (_) { return null; }
    }

    // ------------------------------------------------------------------
    // 1. Network hooks (detection only - requests are never altered)
    // ------------------------------------------------------------------
    // Manifests served without .m3u8/.mpd and with a generic Content-Type (text/plain,
    // octet-stream, ...) are recognised by their first bytes. Only small, text-like responses
    // are inspected, never images/scripts/media, and never more than once per URL.
    const SNIFF_SKIP = /\.(js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|ts|m4s|mp4|m4a|aac|webm|vtt|json)(\?|#|$)/i;
    const SNIFF_TYPES = /^(text\/plain|application\/octet-stream|binary\/octet-stream|application\/x-mpegurl|audio\/mpegurl|application\/xml|text\/xml|)$/i;
    const sniffed = new Set();
    function sniffKind(text) {
        const head = text.slice(0, 512).replace(/^\uFEFF/, '').trimStart();
        if (head.startsWith('#EXTM3U')) return 'application/vnd.apple.mpegurl';
        if (/^(<\?xml[^>]*>\s*)?<MPD[\s>]/i.test(head)) return 'application/dash+xml';
        return null;
    }
    function shouldSniff(url, ct, len) {
        if (!url || sniffed.has(url) || SNIFF_SKIP.test(url.split('#')[0])) return false;
        if (len && +len > 2 * 1024 * 1024) return false;
        return SNIFF_TYPES.test(String(ct || '').split(';')[0].trim());
    }

    window.fetch = function (resource, init) {
        const url = urlOf(resource);
        if (url) report(url, 'fetch');
        const p = origFetch.apply(this, arguments);
        if (url && !MANIFEST_RE.test(url)) {
            p.then(res => {
                try {
                    const ct = res.headers.get('content-type');
                    const final = res.url || url;
                    if (ct && MANIFEST_MIME.test(ct)) { report(final, 'fetch', ct); return; }
                    if (res.ok && res.type !== 'opaque' && shouldSniff(final, ct, res.headers.get('content-length'))) {
                        sniffed.add(final);
                        res.clone().text().then(t => { const k = sniffKind(t); if (k) report(final, 'fetch', k); }, () => { });
                    }
                } catch (_) { /* opaque */ }
            }, () => { });
        }
        return p;
    };
    try { Object.defineProperty(window.fetch, 'name', { value: 'fetch' }); } catch (_) { /* ignore */ }

    OrigXHR.prototype.open = function (method, url) {
        try {
            const u = urlOf(url);
            if (u) {
                report(u, 'xhr');
                if (!MANIFEST_RE.test(u)) {
                    this.addEventListener('load', function onLoad() {
                        try {
                            const ct = this.getResponseHeader('content-type');
                            const final = this.responseURL || u;
                            if (ct && MANIFEST_MIME.test(ct)) { report(final, 'xhr', ct); return; }
                            if ((this.responseType === '' || this.responseType === 'text') && shouldSniff(final, ct, this.getResponseHeader('content-length'))) {
                                sniffed.add(final);
                                const k = sniffKind(this.responseText || '');
                                if (k) report(final, 'xhr', k);
                            }
                        } catch (_) { /* ignore */ }
                    }, { once: true });
                }
            }
        } catch (_) { /* never break the page */ }
        return xhrOpen.apply(this, arguments);
    };

    // ------------------------------------------------------------------
    // 2. MediaSource signal (URL-less - only marks this frame as an MSE player)
    // ------------------------------------------------------------------
    if (window.MediaSource && window.MediaSource.prototype.addSourceBuffer) {
        const origAdd = window.MediaSource.prototype.addSourceBuffer;
        let signalled = false;
        window.MediaSource.prototype.addSourceBuffer = function (mimeType) {
            // Ignore Velostream's own player (its host element lives in the top document).
            if (!signalled && !document.getElementById('velostream-host')) {
                signalled = true;
                emit('MSE_INIT', { payload: { mimeType: String(mimeType || '') } });
            }
            return origAdd.apply(this, arguments);
        };
    }

    // ------------------------------------------------------------------
    // 3. Media element src hook
    // ------------------------------------------------------------------
    const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (srcDesc && srcDesc.set) {
        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
            configurable: true,
            enumerable: srcDesc.enumerable,
            get: srcDesc.get,
            set(value) {
                try { if (typeof value === 'string') report(value, 'video.src'); } catch (_) { /* ignore */ }
                srcDesc.set.call(this, value);
            }
        });
    }

    // ------------------------------------------------------------------
    // 4. Proxy fetch on behalf of the extension (page network identity)
    // ------------------------------------------------------------------
    const controllers = new Map();

    function sameOrigin(url) {
        try { return new URL(url).origin === location.origin; } catch (_) { return false; }
    }

    async function doFetch(url, method, headers, signal, credentials) {
        const h = new OrigHeaders();
        for (const [k, v] of Object.entries(headers || {})) {
            if (/^(host|cookie|origin|referer|content-length|connection)$/i.test(k)) continue;
            try { h.set(k, v); } catch (_) { /* forbidden header */ }
        }
        return origFetch.call(window, url, {
            method: method || 'GET',
            headers: h,
            credentials,
            signal,
            cache: 'no-store',
            redirect: 'follow',
            referrerPolicy: 'strict-origin-when-cross-origin'
        });
    }

    async function handleFetch(msg) {
        const { id, url, method, headers } = msg;
        const controller = new OrigAbortController();
        controllers.set(id, controller);
        try {
            let res;
            const firstCreds = sameOrigin(url) ? 'include' : 'same-origin';
            try {
                // Cross-origin CDNs typically answer with ACAO:* which forbids credentials,
                // so try without cookies first and retry with them on a CORS failure.
                res = await doFetch(url, method, headers, controller.signal, firstCreds);
            } catch (err) {
                if (err && err.name === 'AbortError') throw err;
                if (firstCreds === 'include') throw err;
                res = await doFetch(url, method, headers, controller.signal, 'include');
            }
            const outHeaders = {};
            res.headers.forEach((v, k) => { outHeaders[k] = v; });
            const buffer = (method === 'HEAD') ? new ArrayBuffer(0) : await res.arrayBuffer();
            emit('FETCH_RESULT', { id, ok: true, status: res.status, headers: outHeaders, url: res.url || url, buffer }, [buffer]);
        } catch (err) {
            emit('FETCH_RESULT', {
                id,
                ok: false,
                aborted: !!(err && err.name === 'AbortError'),
                status: 0,
                error: `${(err && err.name) || 'Error'}: ${(err && err.message) || err}`
            });
        } finally {
            controllers.delete(id);
        }
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.source !== TAG_IN || typeof msg.id !== 'string') return;
        if (msg.type === 'FS_FETCH' && typeof msg.url === 'string' && /^https?:/i.test(msg.url)) {
            handleFetch(msg);
        } else if (msg.type === 'FS_ABORT') {
            const c = controllers.get(msg.id);
            if (c) c.abort();
        }
    });

})();
