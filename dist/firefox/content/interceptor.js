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
    // Manifest URLs: .m3u8/.mpd anywhere in the path or query, or format/mime hints in the query.
    const MANIFEST_RE = /\.(m3u8|mpd)(\?|#|&|\/|$)|[?&](format|type|ext|output)=(m3u8|mpd|hls|dash)\b|[?&]mime(type)?=(application(%2f|\/)(x-mpegurl|vnd\.apple\.mpegurl|dash(%2b|\+)xml))/i;
    const MANIFEST_MIME = /mpegurl|dash\+xml|vnd\.mpeg\.dash\.mpd/i;
    // Subtitle files (sidecar captions loaded by the site's own player).
    const SUB_RE = /\.(vtt|srt|ass|ssa)(\?|#|$)/i;
    const SUB_MIME = /text\/vtt|x-subrip|text\/x-ssa|text\/x-ass/i;
    const MAX_SUBS = 24;
    const reportedSubs = new Set();
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
        const isHls = /m3u8|=hls(&|#|$)|mpegurl/i.test(url) || /mpegurl/i.test(mime || '');
        emit('STREAM_FOUND', { payload: { url: key, method, mime: mime || '', type: isHls ? 'hls' : 'dash' } });
    }

    function reportSubtitle(rawUrl, mime) {
        const url = absolute(rawUrl);
        if (!url || !/^https?:/i.test(url)) return;
        const key = url.split('#')[0];
        if (reportedSubs.has(key) || reportedSubs.size >= MAX_SUBS) return;
        if (!SUB_RE.test(key) && !(mime && SUB_MIME.test(mime))) return;
        // HLS WebVTT segments (numbered chunks) are handled by Shaka - only report sidecar files.
        if (/(seg|segment|chunk|frag)[-_]?\d+|\/\d{3,}\.vtt/i.test(key)) return;
        reportedSubs.add(key);
        emit('SUBTITLE_FOUND', { payload: { url: key, mime: mime || '' } });
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
    const SNIFF_SKIP = /\.(js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|ts|m4s|mp4|m4a|aac|webm|json)(\?|#|$)/i;
    const SNIFF_TYPES = /^(text\/plain|application\/octet-stream|binary\/octet-stream|application\/x-mpegurl|audio\/mpegurl|application\/xml|text\/xml|)$/i;
    const sniffed = new Set();
    function sniffKind(text) {
        const head = text.slice(0, 512).replace(/^\uFEFF/, '').trimStart();
        if (head.startsWith('#EXTM3U')) return 'application/vnd.apple.mpegurl';
        if (head.startsWith('WEBVTT')) return 'text/vtt';
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
        if (url) { report(url, 'fetch'); reportSubtitle(url); }
        const p = origFetch.apply(this, arguments);
        if (url && !MANIFEST_RE.test(url)) {
            p.then(res => {
                try {
                    const ct = res.headers.get('content-type');
                    const final = res.url || url;
                    if (ct && MANIFEST_MIME.test(ct)) { report(final, 'fetch', ct); return; }
                    if (ct && SUB_MIME.test(ct)) { reportSubtitle(final, ct); return; }
                    if (res.ok && res.type !== 'opaque' && shouldSniff(final, ct, res.headers.get('content-length'))) {
                        sniffed.add(final);
                        res.clone().text().then(t => { const k = sniffKind(t); if (k === 'text/vtt') reportSubtitle(final, k); else if (k) report(final, 'fetch', k); }, () => { });
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
                reportSubtitle(u);
                if (!MANIFEST_RE.test(u)) {
                    this.addEventListener('load', function onLoad() {
                        try {
                            const ct = this.getResponseHeader('content-type');
                            const final = this.responseURL || u;
                            if (ct && MANIFEST_MIME.test(ct)) { report(final, 'xhr', ct); return; }
                            if (ct && SUB_MIME.test(ct)) { reportSubtitle(final, ct); return; }
                            if ((this.responseType === '' || this.responseType === 'text') && shouldSniff(final, ct, this.getResponseHeader('content-length'))) {
                                sniffed.add(final);
                                const k = sniffKind(this.responseText || '');
                                if (k === 'text/vtt') reportSubtitle(final, k); else if (k) report(final, 'xhr', k);
                            }
                        } catch (_) { /* ignore */ }
                    }, { once: true });
                }
            }
        } catch (_) { /* never break the page */ }
        return xhrOpen.apply(this, arguments);
    };

    // ------------------------------------------------------------------
    // 1b. Worker sniffing: many players (hls.js, Shaka, custom) fetch manifests from a blob:
    //     Web Worker, which the hooks above cannot see. Blob/data workers are wrapped with a tiny
    //     prelude that hooks fetch/XHR inside the worker and reports manifest-looking URLs back
    //     over a BroadcastChannel (never through the worker's own message port, which belongs to
    //     the page). Same-origin http(s) workers are left alone because wrapping would change
    //     their base URL; webRequest catches their requests in the background instead.
    // ------------------------------------------------------------------
    const OrigWorker = window.Worker;
    const WORKER_PRELUDE = "(function(){try{\nvar bc=new BroadcastChannel(__CH__);\nvar RE=/\\.(m3u8|mpd|vtt|srt)(\\?|#|&|\\/|$)|[?&](format|type)=(m3u8|mpd|hls|dash)\\b|mpegurl/i;\nvar MT=/mpegurl|dash\\+xml|text\\/vtt|x-subrip/i;\nvar post=function(u,ct){try{u=String(u&&u.url||u);if(RE.test(u)||(ct&&MT.test(ct)))bc.postMessage({url:new URL(u,__SRC__).href,ct:ct||''});}catch(_){}};\nif(self.fetch){var of=self.fetch;self.fetch=function(r){var u=r&&r.url||r;post(u);var p=of.apply(this,arguments);p.then(function(res){try{post(res.url||u,res.headers.get('content-type'));}catch(_){}},function(){});return p;};}\nif(self.XMLHttpRequest){var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){post(u);var x=this;x.addEventListener('load',function(){try{post(x.responseURL||u,x.getResponseHeader('content-type'));}catch(_){}});return xo.apply(this,arguments);};}\n}catch(_){}})();\n";
    if (OrigWorker && typeof BroadcastChannel === 'function' && typeof Proxy === 'function') {
        try {
            const channel = 'velostream-worker-sniff-' + Math.random().toString(36).slice(2);
            const bc = new BroadcastChannel(channel);
            bc.onmessage = (e) => {
                const d = e.data;
                if (!d || typeof d.url !== 'string') return;
                report(d.url, 'worker', d.ct || '');
                reportSubtitle(d.url, d.ct || '');
            };
            window.Worker = new Proxy(OrigWorker, {
                construct(target, args, newTarget) {
                    try {
                        const raw = args[0];
                        const src = raw instanceof URL ? raw.href : String(raw);
                        if (/^(blob|data):/i.test(src)) {
                            const isModule = !!(args[1] && args[1].type === 'module');
                            const code = WORKER_PRELUDE.replace('__CH__', JSON.stringify(channel)).replace('__SRC__', JSON.stringify(src)) +
                                (isModule ? 'import ' + JSON.stringify(src) + ';' : 'importScripts(' + JSON.stringify(src) + ');');
                            const wrappedUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
                            try {
                                return Reflect.construct(target, [wrappedUrl, ...args.slice(1)], newTarget);
                            } catch (_) {
                                URL.revokeObjectURL(wrappedUrl); // CSP refused the wrapper: fall through
                            }
                        }
                    } catch (_) { /* never break the page */ }
                    return Reflect.construct(target, args, newTarget);
                }
            });
        } catch (_) { /* BroadcastChannel blocked (sandboxed frame) */ }
    }

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
    // 2b. DRM signal: a page that asks for a key system plays encrypted media (Widevine,
    //     PlayReady, FairPlay). Velostream cannot decrypt those; the engine flags the frame so
    //     the popup/badge can explain why and offer the external-player hand-off.
    // ------------------------------------------------------------------
    if (navigator.requestMediaKeySystemAccess) {
        const origRmksa = navigator.requestMediaKeySystemAccess;
        let drmSignalled = false;
        navigator.requestMediaKeySystemAccess = function (keySystem) {
            if (!drmSignalled && !/clearkey/i.test(String(keySystem))) {
                drmSignalled = true;
                emit('DRM_DETECTED', { payload: { keySystem: String(keySystem || '') } });
            }
            return origRmksa.apply(this, arguments);
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
