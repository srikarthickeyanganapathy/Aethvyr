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
            channels: 'stereo'       // stereo | mono | left | right
        },
        filterPresets: [],
        keymap: DEFAULT_KEYMAP,
        settingsVersion: 3
    });

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
                out[key] = (val === undefined || val === null || typeof val !== typeof def) ? def : val;
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
        if (!['off', 'cas', 'fsr', 'anime4k', 'deband'].includes(out.shader)) out.shader = 'off';
        if (!['mp4', 'original'].includes(out.exportFormat)) out.exportFormat = 'mp4';
        out.gestures.doubleTapZoneWidth = Math.min(0.45, Math.max(0.2, out.gestures.doubleTapZoneWidth));
        out.siteProfiles = out.siteProfiles.filter(p => isPlainObject(p) && typeof p.host === 'string').slice(0, 200);
        out.cacheSizeMB = Math.min(8192, Math.max(32, out.cacheSizeMB));
        out.memory.volume = Math.min(1, Math.max(0, out.memory.volume));
        out.autoSites = out.autoSites.filter(h => typeof h === 'string' && h.length < 256).slice(0, 500);
        out.audio.boost = Math.min(300, Math.max(100, out.audio.boost));
        out.audio.delayMs = Math.min(1000, Math.max(0, out.audio.delayMs));
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

    root.VelostreamShared = Object.freeze({
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
