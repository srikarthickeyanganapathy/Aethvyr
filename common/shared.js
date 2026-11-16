/**
 * Velostream - Shared constants & helpers.
 *
 * Classic script (no import/export) so the SAME file can be loaded by:
 *   - the background service worker / event page (`import '../common/shared.js'`),
 *   - the popup (`<script src>`),
 *   - the ISOLATED-world content script (listed before sniffer.js in the manifest).
 * Everything is exposed on `globalThis.VelostreamShared`.
 */
(function (root) {
    'use strict';
    if (root.VelostreamShared) return;

    const api = (typeof root.browser !== 'undefined' && root.browser.runtime) ? root.browser : root.chrome;

    /** Firefox passes structured clones through runtime messaging; Chromium serializes to JSON. */
    const IS_FIREFOX = !!(api && api.runtime && typeof api.runtime.getBrowserInfo === 'function');

    const DEFAULT_KEYMAP = Object.freeze({
        playPause: ' ',
        playPauseAlt: 'k',
        seekBack: 'ArrowLeft',
        seekBackAlt: 'j',
        seekFwd: 'ArrowRight',
        seekFwdAlt: 'l',
        volUp: 'ArrowUp',
        volDown: 'ArrowDown',
        mute: 'm',
        fullscreen: 'f',
        pip: 'p',
        captions: 'c',
        transcript: 't',
        speedDown: '<',
        speedUp: '>',
        loopA: '[',
        loopB: ']',
        screenshot: 's',
        frameBack: ',',
        frameFwd: '.',
        help: '?'
    });

    const DEFAULT_SETTINGS = Object.freeze({
        // Appearance & accessibility
        theme: 'blue',               // accent: blue | green | indigo | amber | rose
        uiScale: 1,                  // 0.85 | 1 | 1.25 | 1.5
        highContrast: false,
        reducedMotion: 'system',     // system | on | off
        simpleMode: false,
        autoHideMs: 3000,            // 0 = never hide
        showStats: false,
        ambientMode: false,          // soft colour glow from the video behind letterbox bars
        // Player look (skins and control layout). 'glass' + 'standard' is the original design.
        look: {
            skin: 'glass',           // glass | cinema | theater | pill | compact
            density: 'standard',     // minimal | standard | pro (pro adds frame step, A-B loop, snapshot, EQ, GPU)
            scrubber: 'classic',     // classic | chapters (gaps at chapter starts) | heatmap (loudness + buffer strip)
            scrubHeight: 6,          // seek bar thickness, px (4-10)
            scrim: -1,               // control background darkness %, 0-95; -1 = the skin's own
            hidden: [],              // ids from LOOK_BUTTONS the user hid
            order: [],               // ids of the right-hand buttons in the user's order (missing ids keep default order)
            pillX: 0.5,              // floating-pill position, fraction of the player (centre point)
            pillY: 0.85
        },
        syncEnabled: false,          // opt-in: sync settings, positions, bookmarks, library via the browser account (storage.sync)
        // Playback defaults
        defaultSpeed: 1,
        qualityCap: 0,               // max height, 0 = unlimited
        seekStep: 10,
        autoFullscreen: false,
        longPressRate: 2,
        autoResume: 'always',        // always | ask | off  (resume each video where you left it)
        skipSeconds: 85,             // "Skip intro" pill: 30 | 60 | 85 | 90
        smartSkip: false,            // fast-forward through black + silent stretches
        quickLaunchBadge: true,      // on-page "Play in Velostream" pill
        autoSites: [],               // hostnames where detected videos open in Velostream automatically
        // Last-used player state, restored for every video (like a native app remembers it)
        memory: {
            volume: 1,
            muted: false,
            subsOn: false,
            subLang: '',
            audioLang: '',
            qualityHeight: 0         // 0 = Auto (ABR)
        },
        // Engine: pre-buffer the whole video in the background (bounded by the cache size)
        maxBufferSec: 86400,         // seconds ahead to pre-download; 86400 = whole video
        cacheSizeMB: 2048,           // IndexedDB ring buffer per tab
        maxWorkers: 6,               // parallel segment downloads (2-8)
        rangeAccel: true,            // split large downloads into parallel Range sub-requests
        dvrMinutes: 30,              // live rewind window kept in the ring buffer (0 = off)
        // Player (Shaka) RAM buffer - separate from the IndexedDB pre-buffer above
        mseBufferAhead: 45,          // forward MSE buffer goal, seconds (15-300)
        mseBufferBehind: 30,         // back-buffer kept in RAM, seconds (10-300)
        rebufferingGoal: 0.5,        // media needed before (re)starting, seconds (0.5-5)
        // GPU video pipeline (WebGL2): off | cas | fsr | anime4k | deband
        exportFormat: 'mp4',          // 'mp4' (remux, one file) | 'original'
        shader: 'off',
        shaderStrength: 50,          // 0-100
        maxRenderRes: 2160,          // cap for the canvas' longest side, px
        // Mouse
        mouse: {
            wheel: 'volume',         // volume | seek | speed | zoom
            middleClick: 'playPause' // playPause | fullscreen | pip | mute | resetZoom | none
        },
        // Per-site profiles: [{host, defaultSpeed, shader, fit, audioPreset, skipSeconds}]
        siteProfiles: [],
        // Gestures
        gestures: {
            enabled: true,
            allowMouseDrag: false,   // mouse drag = swipe gestures (panning while zoomed always works)
            doubleTapSeek: true,
            doubleTapZoneWidth: 0.35, // left/right zone width (0.20-0.45); centre = the rest
            doubleTapLeft: 'seekBack',   // seekBack | seekFwd | playPause | fullscreen | pip | none
            doubleTapCenter: 'playPause',
            doubleTapRight: 'seekFwd',
            longPressSpeed: true,
            brightnessSwipe: true,
            volumeSwipe: true,
            scrubSwipe: true,
            pinchZoom: true
        },
        // Subtitles
        subtitles: {
            font: 'system',          // system | serif | mono | dyslexic | hyperlegible
            size: 100,               // percent
            color: '#ffffff',
            bgOpacity: 75,           // percent
            edge: 'shadow',          // none | shadow | outline
            position: 8,             // % from bottom
            pauseOnHover: false,     // pause while the pointer is over a subtitle line
            clickToCopy: true        // click a subtitle line to copy its text
        },
        // Audio
        audio: {
            boost: 100,              // percent, 100-300
            preset: 'normal',        // normal | voice | bass | night | custom
            eq: [0, 0, 0, 0, 0],     // custom 5-band gains in dB (60Hz, 230Hz, 910Hz, 3.6kHz, 14kHz)
            delayMs: 0,              // 0-1000ms, delays audio relative to video
            preservesPitch: true,    // keep voice pitch when changing speed
            channels: 'stereo',      // stereo | mono | left | right
            loudnessNorm: false,     // smart loudness: slow auto-gain toward a target level + peak limiter
            width: 100,              // stereo width %, 0 (mono) - 200 (extra wide); 100 = as recorded
            crossfeed: false,        // headphone crossfeed: a little of each side, delayed + low-passed, into the other
            dialogue: 0              // dialogue boost 0-100: lifts the centre (voice) band 1-4 kHz
        },
        // Color Studio (GPU colour grading on top of the CSS colour filters; needs WebGL2)
        color: {
            preset: 'neutral',       // neutral | anime | cinema | natural | night | custom
            gamma: 100,              // percent; 100 = neutral (50-200)
            vibrance: 0,             // -100..100
            temperature: 0,          // -100..100, warm > 0
            tint: 0,                 // -100..100, magenta > 0
            shadows: 0,              // -100..100
            highlights: 0            // -100..100
        },
        // Hardware tier detected on first run ('' = not yet): low | standard | high
        hwTier: '',
        filterPresets: [],
        keymap: DEFAULT_KEYMAP,
        settingsVersion: 3
    });

    /** Option lists shared by the popup and the player's settings panel. */
    const PREBUFFER_SECONDS = Object.freeze([30, 60, 300, 900, 1800, 86400]);
    const CACHE_SIZES_MB = Object.freeze([256, 512, 1024, 2048, 4096, 5120]);
    const LEGACY_CACHE_MB = Object.freeze({ 300: 256, 1000: 1024 });
    /** Player look: skins, buttons the user may hide, and the right-hand buttons they may reorder. */
    const LOOK_SKINS = Object.freeze(['glass', 'cinema', 'theater', 'pill', 'compact']);
    const LOOK_BUTTONS = Object.freeze(['back', 'fwd', 'volume', 'speed', 'cc', 'pip', 'fs', 'lock', 'info', 'dl', 'audioOnly', 'mini',
        'frameBack', 'frameFwd', 'loop', 'snapshot', 'eq', 'gpu']);
    const LOOK_ORDERABLE = Object.freeze(['speed', 'cc', 'studio', 'pip', 'fs']);

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && !Array.isArray(v);
    }

    function deepMerge(stored, defaults) {
        const out = {};
        for (const key of Object.keys(defaults)) {
            const def = defaults[key];
            const val = stored ? stored[key] : undefined;
            if (isPlainObject(def)) {
                out[key] = deepMerge(isPlainObject(val) ? val : {}, def);
            } else if (Array.isArray(def)) {
                out[key] = Array.isArray(val) ? val.slice() : def.slice();
            } else {
                // NaN / Infinity (e.g. Number('') from a form) would survive Math.min/max clamps.
                const bad = val === undefined || val === null || typeof val !== typeof def || (typeof def === 'number' && !Number.isFinite(val));
                out[key] = bad ? def : val;
            }
        }
        return out;
    }

    /** Deep-merge stored settings over defaults so new keys always exist, then clamp ranges. */
    function mergeSettings(stored) {
        const out = deepMerge(isPlainObject(stored) ? stored : {}, DEFAULT_SETTINGS);
        out.maxWorkers = Math.min(8, Math.max(2, out.maxWorkers | 0));
        // v2 migration: older builds stored a 90 s / 300 MB prefetch and "ask" resume.
        if (!isPlainObject(stored) || !(stored.settingsVersion >= 2)) {
            if (isPlainObject(stored) && Object.keys(stored).length) {
                out.maxBufferSec = 86400;
                out.cacheSizeMB = Math.max(out.cacheSizeMB, 2048);
                out.autoResume = 'always';
            }
            out.settingsVersion = 2;
        }
        out.settingsVersion = 3; // v3 only adds keys; defaults fill them in
        out.maxBufferSec = Math.min(86400, Math.max(10, out.maxBufferSec));
        out.mseBufferAhead = Math.min(300, Math.max(15, out.mseBufferAhead));
        out.mseBufferBehind = Math.min(300, Math.max(10, out.mseBufferBehind));
        out.rebufferingGoal = Math.min(5, Math.max(0.5, out.rebufferingGoal));
        out.shaderStrength = Math.min(100, Math.max(0, out.shaderStrength));
        if (!['off', 'cas', 'fsr', 'anime4k', 'anime4k-hq', 'deblock', 'denoise', 'deband'].includes(out.shader)) out.shader = 'off';
        if (!['mp4', 'original'].includes(out.exportFormat)) out.exportFormat = 'mp4';
        out.gestures.doubleTapZoneWidth = Math.min(0.45, Math.max(0.2, out.gestures.doubleTapZoneWidth));
        out.siteProfiles = out.siteProfiles.filter(p => isPlainObject(p) && typeof p.host === 'string').slice(0, 200);
        // Older popups offered 300 MB / 1000 MB; the popup and the player now share CACHE_SIZES_MB.
        // Snap those legacy values onto the list (idempotent, so no settingsVersion bump is needed).
        // Any other value inside the 32-8192 clamp is kept as is (the UIs show it as a custom option).
        if (LEGACY_CACHE_MB[out.cacheSizeMB]) out.cacheSizeMB = LEGACY_CACHE_MB[out.cacheSizeMB];
        out.cacheSizeMB = Math.min(8192, Math.max(32, out.cacheSizeMB));
        out.memory.volume = Math.min(1, Math.max(0, out.memory.volume));
        out.autoSites = out.autoSites.filter(h => typeof h === 'string' && h.length < 256).slice(0, 500);
        out.audio.boost = Math.min(300, Math.max(100, out.audio.boost));
        out.audio.delayMs = Math.min(1000, Math.max(0, out.audio.delayMs));
        out.audio.width = Math.min(200, Math.max(0, out.audio.width));
        out.audio.dialogue = Math.min(100, Math.max(0, out.audio.dialogue));
        const c = out.color;
        if (!['neutral', 'anime', 'cinema', 'natural', 'night', 'custom'].includes(c.preset)) c.preset = 'custom';
        c.gamma = Math.min(200, Math.max(50, c.gamma));
        for (const k of ['vibrance', 'temperature', 'tint', 'shadows', 'highlights']) c[k] = Math.min(100, Math.max(-100, c[k]));
        if (!['', 'low', 'standard', 'high'].includes(out.hwTier)) out.hwTier = '';
        const lk = out.look;
        if (!LOOK_SKINS.includes(lk.skin)) lk.skin = 'glass';
        if (!['minimal', 'standard', 'pro'].includes(lk.density)) lk.density = 'standard';
        if (!['classic', 'chapters', 'heatmap'].includes(lk.scrubber)) lk.scrubber = 'classic';
        lk.scrubHeight = Math.round(Math.min(10, Math.max(4, lk.scrubHeight)));
        lk.scrim = lk.scrim < 0 ? -1 : Math.round(Math.min(95, lk.scrim));
        lk.hidden = [...new Set(lk.hidden.filter(id => LOOK_BUTTONS.includes(id)))];
        lk.order = [...new Set(lk.order.filter(id => LOOK_ORDERABLE.includes(id)))];
        lk.pillX = Math.min(1, Math.max(0, lk.pillX));
        lk.pillY = Math.min(1, Math.max(0, lk.pillY));
        out.dvrMinutes = Math.min(180, Math.max(0, out.dvrMinutes));
        // Settings saved by older builds used theme names; map them onto accents.
        const legacy = { emerald: 'green', amethyst: 'indigo', crimson: 'rose', 'hc-yellow': 'amber', amoled: 'blue', glass: 'blue' };
        if (legacy[out.theme]) out.theme = legacy[out.theme];
        if (!['blue', 'green', 'indigo', 'amber', 'rose'].includes(out.theme)) out.theme = 'blue';
        return out;
    }

    // ---------------------------------------------------------------------
    // Binary <-> Base64 (Chromium runtime messaging is JSON-only).
    // Chunked String.fromCharCode avoids the "argument list too long" crash
    // and is ~4x smaller on the wire than Array.from(Uint8Array) JSON arrays.
    // ---------------------------------------------------------------------
    function toBase64(buffer) {
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(binary);
    }

    function fromBase64(b64) {
        if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64).buffer;
        const binary = atob(b64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }

    /** Encode binary for a runtime message (ArrayBuffer on Firefox, base64 on Chromium). */
    function packBinary(buffer) {
        if (!buffer) return null;
        if (IS_FIREFOX) return { kind: 'ab', value: buffer };
        return { kind: 'b64', value: toBase64(buffer) };
    }

    /** Decode a packed binary back into an ArrayBuffer. */
    function unpackBinary(packed) {
        if (!packed) return null;
        if (packed.kind === 'b64') return fromBase64(packed.value);
        const v = packed.value;
        if (v instanceof ArrayBuffer) return v;
        if (ArrayBuffer.isView(v)) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
        // Some Firefox versions hand back a cross-compartment wrapper; copy defensively.
        if (v && typeof v.byteLength === 'number') return new Uint8Array(v).buffer;
        return null;
    }

    /** Normalize a URL for de-duplication (drop hash, keep query - tokens matter). */
    function normalizeUrl(url, base) {
        try {
            const u = new URL(url, base);
            u.hash = '';
            return u.href;
        } catch (_) {
            return null;
        }
    }

    const MANIFEST_MIME = /mpegurl|dash\+xml|vnd\.apple\.mpegurl/i;
    // .m3u8/.mpd anywhere in the path or query, plus common format/mime query hints.
    const HLS_RE = /\.m3u8(\?|#|&|\/|$)|[?&](format|type|ext|output)=(m3u8|hls)\b|[?&]mime(type)?=(application|audio)(%2f|\/)(x-mpegurl|vnd\.apple\.mpegurl|mpegurl)/i;
    const DASH_RE = /\.mpd(\?|#|&|\/|$)|[?&](format|type|ext|output)=(mpd|dash)\b|[?&]mime(type)?=application(%2f|\/)dash(%2b|\+)xml/i;
    const SEGMENT_RE = /\.(ts|m4s|m4f|cmfv|cmfa|aac|vtt|webvtt|key|jpe?g|png|js|css)$/i;
    const PROGRESSIVE_RE = /\.(mp4|m4v|webm|mkv|mov|ogv)(\?|#|$)/i;
    const AD_RE = /(^|[/._-])(ads?|adserver|adservice|advert|preroll|midroll|vast|vmap|ima3?|imasdk|doubleclick|googlesyndication|freewheel|springserve|spotx)([/._?-]|$)/i;

    /** Classify a URL (+ optional Content-Type) as hls | dash | progressive | null. */
    function classifyStream(url, mime) {
        if (!url || typeof url !== 'string' || url.startsWith('blob:') || url.startsWith('data:')) return null;
        if (mime) {
            // application/x-mpegurl, application/vnd.apple.mpegurl, audio/mpegurl, audio/x-mpegurl
            if (/mpegurl/i.test(mime)) return 'hls';
            if (/dash\+xml|vnd\.mpeg\.dash\.mpd/i.test(mime)) return 'dash';
        }
        let path = url;
        try { path = new URL(url).pathname; } catch (_) { /* relative/invalid */ }
        // A segment that merely lives under a .m3u8/.mpd directory is not a manifest.
        if (SEGMENT_RE.test(path)) return null;
        if (HLS_RE.test(path) || HLS_RE.test(url)) return 'hls';
        if (DASH_RE.test(path) || DASH_RE.test(url)) return 'dash';
        if (PROGRESSIVE_RE.test(path)) return 'progressive';
        return null;
    }

    function looksLikeAd(url) {
        try {
            const u = new URL(url);
            return AD_RE.test(u.hostname) || AD_RE.test(u.pathname);
        } catch (_) {
            return false;
        }
    }

    function formatBytes(bytes) {
        if (!bytes) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        let v = bytes;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
    }

    function formatBitrate(bps) {
        if (!bps) return '0 Mbps';
        if (bps < 1e6) return `${Math.round(bps / 1e3)} kbps`;
        return `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mbps`;
    }

    // ---------------------------------------------------------------------
    // Safe markup insertion. All UI markup (popup rows, the on-page pill, the player's controls,
    // menus and subtitle lines - which can contain text from the site) goes through here instead of
    // innerHTML: it is parsed in an inert document (scripts never run, images never load there),
    // stripped of anything executable, then moved into place.
    // ---------------------------------------------------------------------
    const BLOCKED_TAGS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link', 'meta', 'base', 'foreignobject', 'noscript']);
    const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'srcdoc', 'poster', 'data']);
    const SAFE_URL = /^(?:\s*(?:https?:|blob:|data:image\/(?:png|jpe?g|gif|webp);|#|\/|\.{0,2}\/|[\w-]+\.))/i;

    // SVG animation elements can rewrite an attribute after sanitizing (<animate attributeName="href"
    // values="javascript:…">), so the ones that target a URL attribute are dropped.
    const ANIMATION_TAGS = new Set(['animate', 'set', 'animatemotion', 'animatetransform']);
    // Inline styles cannot run script in current engines, but legacy expression()/-moz-binding and
    // javascript: inside url() are stripped anyway (cheap test; normal UI styles never contain them).
    const UNSAFE_STYLE = /expression\s*\(|-moz-binding|behavior\s*:|url\s*\(\s*['"]?\s*(?:javascript|vbscript|data:(?!image\/(?:png|jpe?g|gif|webp)))/i;

    function sanitizeTree(node) {
        const walker = (node.ownerDocument || node).createTreeWalker(node, 1 /* NodeFilter.SHOW_ELEMENT */);
        const remove = [];
        for (let el = walker.nextNode(); el; el = walker.nextNode()) {
            const tag = el.localName.toLowerCase();
            if (BLOCKED_TAGS.has(tag)) { remove.push(el); continue; }
            if (ANIMATION_TAGS.has(tag)) {
                const target = (el.getAttribute('attributeName') || el.getAttribute('attributename') || '').toLowerCase();
                if (URL_ATTRS.has(target) || target.endsWith(':href') || target.startsWith('on')) { remove.push(el); continue; }
            }
            // <template> content lives in its own fragment that the walker does not enter.
            if (tag === 'template' && el.content) sanitizeTree(el.content);
            for (const attr of [...el.attributes]) {
                const name = attr.name.toLowerCase();
                const local = (attr.localName || name).toLowerCase();
                if (name.startsWith('on') || name === 'srcdoc') el.removeAttribute(attr.name);
                else if ((URL_ATTRS.has(name) || URL_ATTRS.has(local)) && attr.value && !SAFE_URL.test(attr.value)) el.removeAttribute(attr.name);
                else if (name === 'style' && UNSAFE_STYLE.test(attr.value)) el.removeAttribute(attr.name);
            }
        }
        remove.forEach(el => el.remove());
    }

    function parseHTML(markup) {
        const doc = new DOMParser().parseFromString(String(markup == null ? '' : markup), 'text/html');
        const frag = doc.createDocumentFragment();
        // A leading <style> is parsed into <head>; keep it, in order, ahead of the body content.
        for (const n of [...doc.head.childNodes, ...doc.body.childNodes]) frag.appendChild(n);
        sanitizeTree(frag);
        return frag;
    }

    /** Replace el's children (element or shadow root) with sanitized markup. */
    function setHTML(el, markup) {
        el.replaceChildren(parseHTML(markup));
    }

    /** Replace el itself with sanitized markup. */
    function replaceWithHTML(el, markup) {
        el.replaceWith(parseHTML(markup));
    }

    // ---------------------------------------------------------------------
    // Backup / restore (settings incl. site profiles, presets, keymap and auto sites; bookmarks;
    // watch history) as one portable JSON document.
    // ---------------------------------------------------------------------
    const BACKUP_APP = 'velostream';
    const BACKUP_VERSION = 2;
    const BOOKMARK_KEY_RE = /^fs_bm_[\w-]{1,64}$/;

    async function buildBackup(storageApi) {
        const all = await storageApi.storage.local.get(null);
        const bookmarks = {};
        for (const [k, v] of Object.entries(all || {})) if (BOOKMARK_KEY_RE.test(k) && Array.isArray(v)) bookmarks[k] = v;
        return {
            app: BACKUP_APP,
            version: BACKUP_VERSION,
            exportedAt: new Date().toISOString(),
            settings: mergeSettings(all && all.fs_settings),
            bookmarks,
            history: isPlainObject(all && all.fs_history) ? all.fs_history : {},
            library: sanitizeLibrary(all && all.fs_library)
        };
    }

    /**
     * Library (favorites + collections, written by popup/library.html). Same rules as the library
     * page: unique keys (string, <= 512 chars, max 500 each), up to 50 collections with
     * /^[\w-]{1,40}$/ ids and 1-60 character names.
     */
    function sanitizeLibrary(raw) {
        const src = isPlainObject(raw) ? raw : {};
        const cleanKeys = (arr) => {
            const out = [];
            const seen = new Set();
            for (const k of Array.isArray(arr) ? arr : []) {
                if (typeof k !== 'string' || !k || k.length > 512 || seen.has(k)) continue;
                seen.add(k);
                out.push(k);
                if (out.length >= 500) break;
            }
            return out;
        };
        const ids = new Set();
        const collections = [];
        for (const c of Array.isArray(src.collections) ? src.collections : []) {
            if (!isPlainObject(c)) continue;
            const id = typeof c.id === 'string' && /^[\w-]{1,40}$/.test(c.id) ? c.id : null;
            // eslint-disable-next-line no-control-regex
            const name = String(c.name == null ? '' : c.name).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 60);
            if (!id || !name || ids.has(id)) continue;
            ids.add(id);
            collections.push({ id, name, keys: cleanKeys(c.keys), createdAt: typeof c.createdAt === 'number' && Number.isFinite(c.createdAt) ? c.createdAt : 0 });
            if (collections.length >= 50) break;
        }
        return { favorites: cleanKeys(src.favorites), collections };
    }

    const httpUrl = (u) => typeof u === 'string' && u.length < 4096 && /^https?:\/\//i.test(u) ? u : '';
    const finiteNum = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

    /** Validate + clean a parsed backup. Throws with a readable message when it is not one. */
    function sanitizeBackup(data) {
        if (!isPlainObject(data) || data.app !== BACKUP_APP || !isPlainObject(data.settings)) {
            throw new Error('This file is not a Velostream backup.');
        }
        if (!(data.version >= 1 && data.version <= BACKUP_VERSION)) throw new Error('This backup was made by a newer Velostream. Update the extension first.');
        const bookmarks = {};
        for (const [k, list] of Object.entries(isPlainObject(data.bookmarks) ? data.bookmarks : {})) {
            if (!BOOKMARK_KEY_RE.test(k) || !Array.isArray(list)) continue;
            const clean = list.filter(b => isPlainObject(b) && finiteNum(b.t) !== null && b.t >= 0)
                .slice(0, 500).map(b => ({ t: b.t, label: String(b.label == null ? '' : b.label).slice(0, 120) }));
            if (clean.length) bookmarks[k] = clean;
        }
        const history = {};
        const entries = Object.entries(isPlainObject(data.history) ? data.history : {})
            .filter(([k, e]) => typeof k === 'string' && k.length <= 512 && isPlainObject(e) && httpUrl(e.url))
            .sort((a, b) => (finiteNum(b[1].updatedAt) || 0) - (finiteNum(a[1].updatedAt) || 0))
            .slice(0, 200);
        for (const [k, e] of entries) {
            history[k] = {
                url: httpUrl(e.url),
                page: httpUrl(e.page),
                title: String(e.title == null ? '' : e.title).slice(0, 200),
                t: Math.max(0, finiteNum(e.t) || 0),
                d: Math.max(0, finiteNum(e.d) || 0),
                done: !!e.done,
                subOffset: finiteNum(e.subOffset) || 0,
                loopA: finiteNum(e.loopA),
                loopB: finiteNum(e.loopB),
                updatedAt: finiteNum(e.updatedAt) || Date.now()
            };
        }
        // Library entries only for videos that are in the restored history.
        const lib = sanitizeLibrary(data.library);
        const known = (k) => Object.prototype.hasOwnProperty.call(history, k);
        const library = {
            favorites: lib.favorites.filter(known),
            collections: lib.collections.map(c => ({ ...c, keys: c.keys.filter(known) }))
        };
        return { settings: mergeSettings(data.settings), bookmarks, history, library, hasLibrary: isPlainObject(data.library) };
    }

    /** Parse, validate and write a backup. Returns counts for the confirmation message. */
    async function restoreBackup(storageApi, jsonText) {
        let data;
        try { data = JSON.parse(jsonText); } catch (_) { throw new Error('This file is not valid JSON.'); }
        const clean = sanitizeBackup(data);
        const write = { fs_settings: clean.settings, fs_history: clean.history, ...clean.bookmarks };
        // Older backups have no library: keep the current one instead of wiping it.
        if (clean.hasLibrary) write.fs_library = clean.library;
        await storageApi.storage.local.set(write);
        return { bookmarks: Object.keys(clean.bookmarks).length, history: Object.keys(clean.history).length, profiles: clean.settings.siteProfiles.length, collections: clean.library.collections.length };
    }

    const backupFilename = () => `velostream-backup-${new Date().toISOString().slice(0, 10)}.json`;

    /** Color Studio presets (values in settings units: gamma %, others -100..100). */
    const COLOR_PRESETS = Object.freeze({
        neutral: { label: 'Neutral', gamma: 100, vibrance: 0, temperature: 0, tint: 0, shadows: 0, highlights: 0 },
        anime: { label: 'Anime', gamma: 100, vibrance: 35, temperature: 0, tint: 0, shadows: 10, highlights: -5 },
        cinema: { label: 'Cinema', gamma: 105, vibrance: -10, temperature: 10, tint: 3, shadows: -10, highlights: -15 },
        natural: { label: 'Natural', gamma: 100, vibrance: 12, temperature: 0, tint: 0, shadows: 5, highlights: -5 },
        night: { label: 'Night', gamma: 95, vibrance: -10, temperature: 45, tint: 0, shadows: 10, highlights: -25 }
    });

    root.VelostreamShared = Object.freeze({
        COLOR_PRESETS,
        setHTML,
        replaceWithHTML,
        buildBackup,
        restoreBackup,
        sanitizeBackup,
        sanitizeLibrary,
        backupFilename,
        api,
        IS_FIREFOX,
        DEFAULT_SETTINGS,
        DEFAULT_KEYMAP,
        SETTINGS_KEY: 'fs_settings',
        HISTORY_KEY: 'fs_history',
        ACCENTS: Object.freeze({
            blue: { label: 'System Blue', fill: '#0A84FF', strong: '#0058D0' },
            green: { label: 'Green', fill: '#30D158', strong: '#1E7A36' },
            indigo: { label: 'Indigo', fill: '#5E5CE6', strong: '#4643C9' },
            amber: { label: 'Amber', fill: '#FF9F0A', strong: '#9A5B00' },
            rose: { label: 'Rose', fill: '#FF375F', strong: '#C21E45' }
        }),
        mergeSettings,
        PREBUFFER_SECONDS,
        CACHE_SIZES_MB,
        LOOK_SKINS,
        LOOK_BUTTONS,
        LOOK_ORDERABLE,
        toBase64,
        fromBase64,
        packBinary,
        unpackBinary,
        normalizeUrl,
        classifyStream,
        looksLikeAd,
        formatBytes,
        formatBitrate,
        MANIFEST_MIME
    });
})(typeof globalThis !== 'undefined' ? globalThis : self);
