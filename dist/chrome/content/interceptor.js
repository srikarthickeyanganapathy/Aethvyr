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
    let signalled = false;
    let drmSignalled = false;
    let route = window.location.href;
    let generation = 0;

    function resetDetection() {
        generation++;
        reported.clear();
        reportedSubs.clear();
        sniffed.clear();
        signalled = drmSignalled = false;
    }

    // Capture pristine references before any page script can monkey-patch them.
    const origFetch = window.fetch;
    const OrigXHR = window.XMLHttpRequest;
    const xhrOpen = OrigXHR.prototype.open;
    const postMessage = window.postMessage.bind(window);
    const OrigAbortController = window.AbortController;
    const OrigHeaders = window.Headers;
    const location = window.location;
    const frameOrigin = window.origin;

    function emit(type, payload, transfer) {
        try {
            if (frameOrigin !== 'null') postMessage({ source: TAG_OUT, type, pageUrl: location.href, ...payload }, frameOrigin, transfer || []);
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
        if (reported.size >= 256) reported.delete(reported.values().next().value);
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
    function rememberSniff(url) {
        if (sniffed.size >= 512) sniffed.delete(sniffed.values().next().value);
        sniffed.add(url);
    }
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
    // Reads only the first bytes of a CLONE of the response, then cancels the clone. Reading the
    // whole clone (res.clone().text()) buffered the entire body a second time, and never finished
    // for endless octet-stream bodies without Content-Length (live FLV/ts over fetch), so memory
    // grew for the lifetime of the stream. Cancelling one tee branch never affects the page's.
    const SNIFF_HEAD_BYTES = 1024;
    function sniffHead(res, onText) {
        let reader;
        try {
            const body = res.clone().body;
            if (!body || typeof body.getReader !== 'function' || typeof TextDecoder !== 'function') return;
            reader = body.getReader();
        } catch (_) { return; }
        const chunks = [];
        let size = 0;
        const finish = () => {
            try { reader.cancel().catch(() => { }); } catch (_) { /* ignore */ }
            try {
                const buf = new Uint8Array(Math.min(size, SNIFF_HEAD_BYTES));
                let off = 0;
                for (const c of chunks) {
                    const n = Math.min(c.byteLength, buf.length - off);
                    buf.set(c.subarray(0, n), off);
                    off += n;
                    if (off >= buf.length) break;
                }
                onText(new TextDecoder().decode(buf));
            } catch (_) { /* never break the page */ }
        };
        const pump = () => reader.read().then(r => {
            if (r.value && r.value.byteLength) { chunks.push(r.value); size += r.value.byteLength; }
            if (r.done || size >= SNIFF_HEAD_BYTES) finish(); else pump();
        }, () => { });
        pump();
    }

    window.fetch = function (resource, init) {
        const requestGeneration = generation;
        const url = urlOf(resource);
        if (url) { report(url, 'fetch'); reportSubtitle(url); }
        const p = origFetch.apply(this, arguments);
        if (url && !MANIFEST_RE.test(url)) {
            p.then(res => {
                if (generation !== requestGeneration) return;
                try {
                    const ct = res.headers.get('content-type');
                    const final = res.url || url;
                    if (ct && MANIFEST_MIME.test(ct)) { report(final, 'fetch', ct); return; }
                    if (ct && SUB_MIME.test(ct)) { reportSubtitle(final, ct); return; }
                    if (res.ok && res.type !== 'opaque' && shouldSniff(final, ct, res.headers.get('content-length'))) {
                        rememberSniff(final);
                        sniffHead(res, t => {
                            if (generation !== requestGeneration) return;
                            const k = sniffKind(t);
                            if (k === 'text/vtt') reportSubtitle(final, k); else if (k) report(final, 'fetch', k);
                        });
                    }
                } catch (_) { /* opaque */ }
            }, () => { });
        }
        return p;
    };
    try { Object.defineProperty(window.fetch, 'name', { value: 'fetch' }); } catch (_) { /* ignore */ }

    OrigXHR.prototype.open = function (method, url) {
        const requestGeneration = generation;
        try {
            const u = urlOf(url);
            if (u) {
                report(u, 'xhr');
                reportSubtitle(u);
                if (!MANIFEST_RE.test(u)) {
                    this.addEventListener('load', function onLoad() {
                        if (generation !== requestGeneration) return;
                        try {
                            const ct = this.getResponseHeader('content-type');
                            const final = this.responseURL || u;
                            if (ct && MANIFEST_MIME.test(ct)) { report(final, 'xhr', ct); return; }
                            if (ct && SUB_MIME.test(ct)) { reportSubtitle(final, ct); return; }
                            if ((this.responseType === '' || this.responseType === 'text') && shouldSniff(final, ct, this.getResponseHeader('content-length'))) {
                                rememberSniff(final);
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
    //     Relative URLs are resolved against the page's document URL (__BASE__): a blob:/data:
    //     URL cannot be a base, so resolving against the worker's own URL always threw.
    //     The wrapper is one Blob made of [prelude, the site's own Blob (tracked via
    //     createObjectURL) or decoded data: bytes, "loaded" ping], so a site that revokes its URL
    //     right after `new Worker(url)` (a common inline-worker pattern) does not break it, and no
    //     second script load (subject to the page's script-src) is needed. Our object URL is
    //     revoked once the worker reports that the original script ran (or after a timeout).
    //     Known trade-off: a classic worker whose source starts with a top-level "use strict"
    //     directive runs sloppy, since the prelude now precedes it.
    // ------------------------------------------------------------------
    const OrigWorker = window.Worker;
    const OrigBlob = window.Blob;
    const OrigURL = window.URL;
    const origCreateObjectURL = OrigURL && OrigURL.createObjectURL;
    const origRevokeObjectURL = OrigURL && OrigURL.revokeObjectURL;
    const rApply = Reflect.apply;
    const rConstruct = Reflect.construct;
    const WORKER_PRELUDE = "(function(){try{\nvar B=__BASE__;var bc=new BroadcastChannel(__CH__);\nvar RE=/\\.(m3u8|mpd|vtt|srt)(\\?|#|&|\\/|$)|[?&](format|type)=(m3u8|mpd|hls|dash)\\b|mpegurl/i;\nvar MT=/mpegurl|dash\\+xml|text\\/vtt|x-subrip/i;\nvar post=function(u,ct){try{u=String(u&&u.url||u);if(RE.test(u)||(ct&&MT.test(ct)))bc.postMessage({url:new URL(u,B).href,ct:ct||''});}catch(_){}};\nif(self.fetch){var of=self.fetch;self.fetch=function(r){var u=r&&r.url||r;post(u);var p=of.apply(this,arguments);p.then(function(res){try{post(res.url||u,res.headers.get('content-type'));}catch(_){}},function(){});return p;};}\nif(self.XMLHttpRequest){var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){post(u);var x=this;x.addEventListener('load',function(){try{post(x.responseURL||u,x.getResponseHeader('content-type'));}catch(_){}});return xo.apply(this,arguments);};}\n}catch(_){}})();\n";
    // Tells the page the original script was loaded, so our object URLs can be revoked.
    const WORKER_LOADED = "(function(){try{var c=new BroadcastChannel(__CH__);c.postMessage({loaded:__TOKEN__});c.close();}catch(_){}})();\n";
    const WORKER_URL_TTL_MS = 60000; // fallback revoke if the worker never reports in

    /** JSON string literal that is also a valid JS literal on every engine (U+2028/2029). */
    const LINE_SEP = String.fromCharCode(0x2028);
    const PARA_SEP = String.fromCharCode(0x2029);
    function jsStr(s) {
        return JSON.stringify(String(s)).split(LINE_SEP).join('\\u2028').split(PARA_SEP).join('\\u2029');
    }
    /** Replace EVERY __TOKEN__ (function replacer: `$` in values is never special). */
    function fill(tpl, values) {
        return tpl.replace(/__([A-Z]+)__/g, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? values[k] : m));
    }

    // Blob behind each live object URL the page creates (script-like types only), so a
    // worker's source can be re-exposed under a URL that the page cannot revoke.
    const scriptBlobs = new Map();
    const SCRIPT_BLOB_TYPE = /javascript|ecmascript|^text\/plain/i;
    function trackObjectUrls() {
        if (typeof origCreateObjectURL !== 'function' || typeof origRevokeObjectURL !== 'function' || !OrigBlob) return;
        const createObjectURL = {
            createObjectURL(obj) {
                const url = rApply(origCreateObjectURL, this, arguments);
                try {
                    if (obj instanceof OrigBlob && SCRIPT_BLOB_TYPE.test(obj.type) && obj.size <= 4 * 1024 * 1024) {
                        scriptBlobs.set(url, obj);
                        if (scriptBlobs.size > 16) scriptBlobs.delete(scriptBlobs.keys().next().value);
                    }
                } catch (_) { /* never break the page */ }
                return url;
            }
        }.createObjectURL;
        const revokeObjectURL = {
            revokeObjectURL(url) {
                try { scriptBlobs.delete(String(url)); } catch (_) { /* ignore */ }
                return rApply(origRevokeObjectURL, this, arguments);
            }
        }.revokeObjectURL;
        try {
            const dc = Object.getOwnPropertyDescriptor(OrigURL, 'createObjectURL');
            const dr = Object.getOwnPropertyDescriptor(OrigURL, 'revokeObjectURL');
            if (!dc || !dr || !dc.configurable || !dr.configurable) return;
            Object.defineProperty(OrigURL, 'createObjectURL', { ...dc, value: createObjectURL });
            Object.defineProperty(OrigURL, 'revokeObjectURL', { ...dr, value: revokeObjectURL });
        } catch (_) { /* ignore */ }
    }

    if (OrigWorker && typeof BroadcastChannel === 'function' && typeof Proxy === 'function' &&
        typeof origCreateObjectURL === 'function' && OrigBlob) {
        try {
            const channel = 'velostream-worker-sniff-' + Math.random().toString(36).slice(2);
            const bc = new BroadcastChannel(channel);
            const owned = new Map(); // token -> { urls, timer }
            const release = (token) => {
                const o = owned.get(token);
                if (!o) return;
                owned.delete(token);
                clearTimeout(o.timer);
                for (const u of o.urls) { try { origRevokeObjectURL.call(OrigURL, u); } catch (_) { /* ignore */ } }
            };
            window.addEventListener('pagehide', event => {
                if (event.persisted) return;
                bc.close();
                for (const token of owned.keys()) release(token);
            });
            bc.onmessage = (e) => {
                const d = e.data;
                if (!d) return;
                if (typeof d.loaded === 'string') { release(d.loaded); return; }
                if (typeof d.url !== 'string') return;
                report(d.url, 'worker', d.ct || '');
                reportSubtitle(d.url, d.ct || '');
            };
            trackObjectUrls();
            const mkUrl = (parts) => origCreateObjectURL.call(OrigURL, new OrigBlob(parts, { type: 'text/javascript' }));
            // Bytes of a `data:[<mime>][;base64],<payload>` URL, or null when it is malformed.
            const dataUrlBytes = (u) => {
                try {
                    const comma = u.indexOf(',');
                    if (comma < 0) return null;
                    const meta = u.slice(5, comma);
                    const payload = u.slice(comma + 1);
                    if (/;base64$/i.test(meta)) {
                        const bin = atob(payload.replace(/\s+/g, ''));
                        const out = new Uint8Array(bin.length);
                        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
                        return out;
                    }
                    return decodeURIComponent(payload);
                } catch (_) { return null; }
            };
            window.Worker = new Proxy(OrigWorker, {
                construct(target, args, newTarget) {
                    if (args[1]?.type === 'module') return rConstruct(target, args, newTarget);
                    const urls = [];
                    try {
                        const raw = args[0];
                        const src = raw instanceof OrigURL ? raw.href : String(raw);
                        // The site's source as a Blob part: a tracked blob: URL, or a decoded data: URL.
                        // Unknown blob: URLs (revoked, or a non-script MIME type) are left alone.
                        const part = /^blob:/i.test(src) ? scriptBlobs.get(src) : (/^data:/i.test(src) ? dataUrlBytes(src) : null);
                        if (part) {
                            const token = Math.random().toString(36).slice(2);
                            const vals = { CH: jsStr(channel), BASE: jsStr(location.href), TOKEN: jsStr(token) };
                            // ONE self-contained script: prelude + the site's own bytes + "loaded" ping.
                            // Loading the original through importScripts()/import of a second blob:
                            // URL was checked against the page's script-src (blob workers inherit the
                            // page CSP), so on pages with `worker-src blob:` but a script-src without
                            // blob: the site's worker died while the unwrapped one ran fine. Blob
                            // concatenation needs no read of the site's Blob and no extra load. Each
                            // added piece is a self-contained `;(function(){..})()` so it cannot
                            // collide with the site's top-level bindings or join its last statement.
                            const wrappedUrl = mkUrl([fill(WORKER_PRELUDE, vals), part, '\n;' + fill(WORKER_LOADED, vals)]);
                            urls.push(wrappedUrl);
                            let worker = null;
                            try {
                                worker = rConstruct(target, [wrappedUrl, ...args.slice(1)], newTarget);
                            } catch (_) { /* CSP / Trusted Types refused the wrapper: fall through */ }
                            if (worker) {
                                owned.set(token, { urls, timer: setTimeout(release, WORKER_URL_TTL_MS, token) });
                                return worker;
                            }
                        }
                    } catch (_) { /* never break the page */ }
                    for (const u of urls) { try { origRevokeObjectURL.call(OrigURL, u); } catch (_) { /* ignore */ } }
                    return rConstruct(target, args, newTarget);
                }
            });
        } catch (_) { /* BroadcastChannel blocked (sandboxed frame) */ }
    }

    // ------------------------------------------------------------------
    // 2. MediaSource signal (URL-less - only marks this frame as an MSE player)
    // ------------------------------------------------------------------
    if (window.MediaSource && window.MediaSource.prototype.addSourceBuffer) {
        const origAdd = window.MediaSource.prototype.addSourceBuffer;
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
    //    Covers `media.src = …`, `source.src = …` and `setAttribute('src', …)` on both. Parser-
    //    created elements are found by the sniffer's DOM scan. Each URL is reported once
    //    (report() de-duplicates), and reporting never throws into the page.
    const OrigMedia = window.HTMLMediaElement;
    const OrigSource = window.HTMLSourceElement;

    function reportSrc(value) {
        try {
            // Only plain strings / URL objects: never call a page object's toString() twice.
            if (typeof value === 'string') report(value, 'video.src');
            else if (OrigURL && value instanceof OrigURL) report(value.href, 'video.src');
        } catch (_) { /* never break the page */ }
    }

    function hookSrcSetter(proto) {
        const d = proto && Object.getOwnPropertyDescriptor(proto, 'src');
        if (!d || typeof d.set !== 'function' || !d.configurable) return;
        const origSet = d.set;
        // Accessor from an object literal: named "set src", length 1, not constructible - like the native one.
        const set = Object.getOwnPropertyDescriptor({
            set src(value) {
                reportSrc(value);
                rApply(origSet, this, [value]);
            }
        }, 'src').set;
        try {
            Object.defineProperty(proto, 'src', { configurable: true, enumerable: d.enumerable, get: d.get, set });
        } catch (_) { /* ignore */ }
    }
    if (OrigMedia) hookSrcSetter(OrigMedia.prototype);
    if (OrigSource) hookSrcSetter(OrigSource.prototype);

    const setAttrDesc = window.Element && Object.getOwnPropertyDescriptor(window.Element.prototype, 'setAttribute');
    if (setAttrDesc && typeof setAttrDesc.value === 'function' && setAttrDesc.configurable) {
        const origSetAttribute = setAttrDesc.value;
        // Method shorthand: named "setAttribute", length 2, not constructible - like the native one.
        const setAttribute = {
            setAttribute(name, value) {
                try {
                    if (typeof name === 'string' && name.length === 3 && name.toLowerCase() === 'src' &&
                        ((OrigMedia && this instanceof OrigMedia) || (OrigSource && this instanceof OrigSource))) {
                        reportSrc(value);
                    }
                } catch (_) { /* never break the page */ }
                return rApply(origSetAttribute, this, arguments);
            }
        }.setAttribute;
        try {
            Object.defineProperty(window.Element.prototype, 'setAttribute', { ...setAttrDesc, value: setAttribute });
        } catch (_) { /* ignore */ }
    }

    // ------------------------------------------------------------------
    // 4. Proxy fetch on behalf of the extension (page network identity)
    // ------------------------------------------------------------------
    const controllers = new Map();

    async function doFetch(url, method, headers, signal, credentials) {
        const h = new OrigHeaders();
        for (const [k, v] of Object.entries(headers || {})) {
            if (!/^(range|accept|content-type)$/i.test(k)) continue;
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
        controllers.set(id, { controller, nonce: msg.nonce });
        try {
            const res = await doFetch(url, method, headers, controller.signal, 'same-origin');
            const outHeaders = {};
            res.headers.forEach((v, k) => { outHeaders[k] = v; });
            const buffer = (method === 'HEAD') ? new ArrayBuffer(0) : await res.arrayBuffer();
            emit('FETCH_RESULT', { id, nonce: msg.nonce, ok: true, status: res.status, headers: outHeaders, url: res.url || url, buffer }, [buffer]);
        } catch (err) {
            emit('FETCH_RESULT', {
                id,
                nonce: msg.nonce,
                ok: false,
                aborted: !!(err && err.name === 'AbortError'),
                status: 0,
                error: `${(err && err.name) || 'Error'}: ${(err && err.message) || err}`
            });
        } finally {
            controllers.delete(id);
        }
    }

    function routeChanged() {
        if (location.href === route) return;
        route = location.href;
        resetDetection();
        emit('ROUTE_CHANGE', { pageUrl: route });
    }

    for (const method of ['pushState', 'replaceState']) {
        const original = history[method];
        history[method] = function (...args) {
            const result = Reflect.apply(original, this, args);
            routeChanged();
            return result;
        };
    }
    window.addEventListener('popstate', routeChanged);
    window.addEventListener('hashchange', routeChanged);

    window.addEventListener('message', (event) => {
        if (!event.isTrusted || event.source !== window || event.origin !== frameOrigin) return;
        const msg = event.data;
        if (!msg || msg.source !== TAG_IN || typeof msg.nonce !== 'string' || !/^[0-9a-f]{32}$/i.test(msg.nonce)) return;
        if (msg.type === 'RESCAN') { resetDetection(); return; }
        if (typeof msg.id !== 'string') return;
        if (msg.type === 'FS_FETCH' && typeof msg.url === 'string' && /^https?:\/\//i.test(msg.url) && ['GET', 'HEAD'].includes(msg.method) && !controllers.has(msg.id)) {
            handleFetch(msg);
        } else if (msg.type === 'FS_ABORT') {
            const c = controllers.get(msg.id);
            if (c?.nonce === msg.nonce) c.controller.abort();
        }
    });

})();
