/**
 * Velostream - Player UI
 *
 * Runs inside the extension page player/player.html, which the content script mounts as an
 * <iframe> exactly over the site's own <video> (or over the page when no video element exists).
 * Extension pages are not subject to the site's CSP or Trusted Types and page scripts cannot
 * reach them, so the player works on every site. Shaka Player is loaded locally (lib/).
 *
 * Network: Shaka scheme plugin -> EnginePort (player.js) -> background engine
 * (IndexedDB cache, parallel prefetch, range accelerator, ABR, live DVR) -> frame that owns
 * the stream (page cookies / Referer), with a direct-fetch fallback.
 *
 * UI: Shadow DOM (#velostream-host). Glass design system (frosted capsules, 4/8px grid,
 * 1.8px-stroke SVG icons, tabular numerals), WCAG 2.2: roles, labels, live announcements,
 * focus trapping, >=44px targets, high contrast, reduced motion, UI scaling.
 */
(function () {
    'use strict';

    const shaka = window.shaka;

    // =====================================================================
    // Constants
    // =====================================================================
    const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
    const SEEK_STEPS = [5, 10, 15, 30];
    const SKIP_STEPS = [30, 60, 85, 90];
    const SLEEP_OPTIONS = [[0, 'Off'], [15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '60 minutes'], ['eov', 'End of video']];
    const ACCENTS = {
        blue: { label: 'System Blue', fill: '#0A84FF', strong: '#0058D0' },
        green: { label: 'Green', fill: '#30D158', strong: '#1E7A36' },
        indigo: { label: 'Indigo', fill: '#5E5CE6', strong: '#4643C9' },
        amber: { label: 'Amber', fill: '#FF9F0A', strong: '#9A5B00' },
        rose: { label: 'Rose', fill: '#FF375F', strong: '#C21E45' }
    };
    const UI_SCALES = [[0.85, '85%'], [1, '100%'], [1.25, '125%'], [1.5, '150%']];
    const AUTOHIDE = [[2000, '2 seconds'], [3000, '3 seconds'], [5000, '5 seconds'], [0, 'Never']];
    const EXTERNAL_APPS = [['potplayer', 'PotPlayer', 'Windows'], ['vlc', 'VLC', 'needs vlc:// handler on desktop'], ['mpv', 'mpv', 'needs mpv:// handler'], ['iina', 'IINA', 'macOS'], ['android', 'Android video app', 'MX Player, VLC…']];
    const GPU_PRESETS = window.VelostreamShared.GRAPHICS_PRESETS;
    const PREBUFFER_WINDOWS = [[30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [900, '15 minutes'], [1800, '30 minutes'], [86400, 'Whole video']];
    const CACHE_CAPS = [[256, '256 MB'], [512, '512 MB'], [1024, '1 GB'], [2048, '2 GB'], [4096, '4 GB'], [5120, '5 GB']];
    /** Settings sub-objects that are merged field by field (never replaced wholesale). */
    const DEEP_SETTINGS = ['audio', 'subtitles', 'gestures', 'mouse', 'memory'];
    const TAP_ACTIONS = [['seekBack', 'Seek back'], ['seekFwd', 'Seek forward'], ['playPause', 'Play / pause'], ['fullscreen', 'Full screen'], ['pip', 'Picture in Picture'], ['none', 'Nothing']];
    const QUALITY_CAPS = [[0, 'No limit'], [2160, '2160p'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [480, '480p'], [360, '360p']];
    const FONTS = {
        system: { label: 'San Francisco / System', css: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif' },
        serif: { label: 'Serif', css: '"New York", Georgia, "Times New Roman", serif' },
        mono: { label: 'Monospace', css: '"SF Mono", ui-monospace, Menlo, Consolas, monospace' },
        dyslexic: { label: 'Dyslexia-friendly', css: 'OpenDyslexic, "OpenDyslexic3", Lexend, "Comic Neue", "Comic Sans MS", sans-serif' },
        hyperlegible: { label: 'Hyperlegible', css: '"Atkinson Hyperlegible", Verdana, Tahoma, sans-serif' }
    };
    const SUB_COLORS = [['#ffffff', 'White'], ['#ffd60a', 'Yellow'], ['#64d2ff', 'Cyan'], ['#30d158', 'Green'], ['#ff9f0a', 'Amber']];
    const EQ_BANDS = [
        { type: 'lowshelf', f: 60, label: '60' }, { type: 'peaking', f: 230, label: '230' }, { type: 'peaking', f: 910, label: '910' },
        { type: 'peaking', f: 3600, label: '3.6k' }, { type: 'highshelf', f: 14000, label: '14k' }
    ];
    const AUDIO_PRESETS = {
        normal: { label: 'Normal', meta: 'Flat', eq: [0, 0, 0, 0, 0], compress: false },
        voice: { label: 'Voice clarity', meta: '+5 dB', eq: [-4, -2, 3, 5, 1], compress: true },
        bass: { label: 'Bass boost', meta: '+7 dB', eq: [7, 4, 0, -1, 0], compress: false },
        night: { label: 'Night mode', meta: 'Compressor', eq: [1, 0, 1, 2, 0], compress: true },
        custom: { label: 'Custom EQ', meta: '5-band', eq: null, compress: false }
    };
    const FIT_MODES = [['contain', 'Fit', 'Default'], ['cover', 'Fill', 'Crop edges'], ['fill', 'Stretch', 'Distort'], ['16:9', '16:9', 'Force'], ['4:3', '4:3', 'Force'], ['21:9', '21:9', 'Ultrawide crop']];
    const DEFAULT_FILTERS = { brightness: 100, contrast: 100, saturate: 100, hue: 0, warmth: 0, sharpness: 0 };
    const ACTIONS = {
        playPause: 'Play / pause', playPauseAlt: 'Play / pause (alt)', seekBack: 'Seek back',
        seekBackAlt: 'Seek back (alt)', seekFwd: 'Seek forward', seekFwdAlt: 'Seek forward (alt)',
        volUp: 'Volume up', volDown: 'Volume down', mute: 'Mute', fullscreen: 'Fullscreen',
        pip: 'Picture in Picture', captions: 'Subtitles', speedDown: 'Slower', speedUp: 'Faster',
        loopA: 'Loop point A', loopB: 'Loop point B', screenshot: 'Screenshot',
        frameBack: 'Previous frame', frameFwd: 'Next frame', help: 'Shortcut help', transcript: 'Transcript'
    };
    const LOOK_ORDERABLE = window.VelostreamShared.LOOK_ORDERABLE;
    const LOOK_BUTTONS = window.VelostreamShared.LOOK_BUTTONS;
    const LOOK_LABELS = {
        back: 'Seek back', fwd: 'Seek forward', volume: 'Volume', speed: 'Speed', cc: 'Subtitles & audio', studio: 'Studio',
        pip: 'Picture in Picture', fs: 'Full screen', lock: 'Lock touch controls', info: 'Stream statistics', dl: 'Download',
        audioOnly: 'Audio-only', mini: 'Mini player', frameBack: 'Previous frame', frameFwd: 'Next frame', loop: 'A–B loop',
        snapshot: 'Snapshot', eq: 'Audio & EQ', gpu: 'Picture & GPU'
    };
    const LOOK_PRO = ['frameBack', 'frameFwd', 'loop', 'snapshot', 'eq', 'gpu'];
    const SKINS = [
        ['glass', 'Glass', 'Frosted floating islands (the original look).'],
        ['cinema', 'Cinema', 'Edge-to-edge bar on a soft gradient, play button first.'],
        ['theater', 'Theater', 'Docked like Cinema, darker, with big icons and a heavy seek bar.'],
        ['pill', 'Floating pill', 'A small bar you can drag anywhere; drag its handle or use the arrow keys on it.'],
        ['compact', 'Compact', 'Opaque one-line toolbar docked at the bottom, square corners, no blur.']
    ];
    const STUDIO_TABS = [['quality', 'Quality'], ['audio', 'Audio'], ['display', 'Display'], ['tools', 'Tools'], ['prefs', 'Prefs']];

    // 24px grid, 1.8px rounded strokes. Play/pause use filled glyphs for optical weight.
    const ICONS = {
        close: '<path d="M6 6l12 12M18 6 6 18"/>',
        play: '<path fill="currentColor" d="M7.5 5.2v13.6a.9.9 0 0 0 1.37.77l10.9-6.8a.9.9 0 0 0 0-1.54l-10.9-6.8a.9.9 0 0 0-1.37.77z"/>',
        pause: '<rect fill="currentColor" stroke="none" x="6" y="4.8" width="4" height="14.4" rx="1.3"/><rect fill="currentColor" stroke="none" x="14" y="4.8" width="4" height="14.4" rx="1.3"/>',
        volume: '<path d="M4 9.6h3.1L11.4 6v12l-4.3-3.6H4z"/><path d="M15.2 9.4a3.6 3.6 0 0 1 0 5.2"/><path d="M17.9 6.8a7.3 7.3 0 0 1 0 10.4"/>',
        volumeLow: '<path d="M4 9.6h3.1L11.4 6v12l-4.3-3.6H4z"/><path d="M15.2 9.4a3.6 3.6 0 0 1 0 5.2"/>',
        mute: '<path d="M4 9.6h3.1L11.4 6v12l-4.3-3.6H4z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
        captions: '<rect x="3" y="5" width="18" height="13.5" rx="3.2"/><path d="M7 10.5h4M13.5 10.5H17M7 14h7"/>',
        studio: '<path d="M4 7h9M17.5 7H20M4 17h2.5M11 17h9"/><circle cx="15.3" cy="7" r="2.2"/><circle cx="8.8" cy="17" r="2.2"/>',
        pip: '<rect x="3" y="5" width="18" height="14" rx="2.6"/><rect x="12" y="11.3" width="6.5" height="5" rx="1.2"/>',
        fullscreen: '<path d="M4 9V5.6A1.6 1.6 0 0 1 5.6 4H9M15 4h3.4A1.6 1.6 0 0 1 20 5.6V9M20 15v3.4a1.6 1.6 0 0 1-1.6 1.6H15M9 20H5.6A1.6 1.6 0 0 1 4 18.4V15"/>',
        exitFullscreen: '<path d="M9 4v3.4A1.6 1.6 0 0 1 7.4 9H4M20 9h-3.4A1.6 1.6 0 0 1 15 7.4V4M15 20v-3.4a1.6 1.6 0 0 1 1.6-1.6H20M4 15h3.4A1.6 1.6 0 0 1 9 16.6V20"/>',
        lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.6"/><path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9"/>',
        unlock: '<rect x="5" y="10.5" width="14" height="10" rx="2.6"/><path d="M8 10.5V7.6a4 4 0 0 1 7.7-1.6"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.7v.1"/>',
        download: '<path d="M12 4.5v10.5M7.6 10.8 12 15.2l4.4-4.4M5.5 19.5h13"/>',
        record: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
        stop: '<rect x="7.5" y="7.5" width="9" height="9" rx="1.8" fill="currentColor" stroke="none"/>',
        mini: '<rect x="3" y="5" width="18" height="14" rx="2.6"/><path d="M9.5 9.5 14.5 14.5M14.5 10.5v4h-4"/>',
        expand: '<rect x="3" y="5" width="18" height="14" rx="2.6"/><path d="M14.5 9.5l-5 5M9.5 13.5v-4h4"/>',
        headphones: '<path d="M4 15.5V12a8 8 0 0 1 16 0v3.5"/><rect x="3.5" y="14" width="4.2" height="6.5" rx="1.6"/><rect x="16.3" y="14" width="4.2" height="6.5" rx="1.6"/>',
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v1.8M12 19.4v1.8M2.8 12h1.8M19.4 12h1.8M5.5 5.5l1.3 1.3M17.2 17.2l1.3 1.3M5.5 18.5l1.3-1.3M17.2 6.8l1.3-1.3"/>',
        speed: '<path d="M5 7l5 5-5 5M12.5 7l5 5-5 5"/>',
        check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
        camera: '<path d="M4 8.6A1.6 1.6 0 0 1 5.6 7h2.2l1.6-2.2h5.2L16.2 7h2.2A1.6 1.6 0 0 1 20 8.6v9a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 17.6z"/><circle cx="12" cy="12.8" r="3.4"/>',
        burst: '<rect x="3" y="7" width="13" height="11" rx="2"/><path d="M7 4.5h11.5a2 2 0 0 1 2 2V15"/><circle cx="9.5" cy="12.5" r="2.4"/>',
        moon: '<path d="M19.5 14.6A7.6 7.6 0 0 1 9.4 4.5a7.6 7.6 0 1 0 10.1 10.1z"/>',
        bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.8L6 20V5.5a1 1 0 0 1 1-1z"/>',
        loop: '<path d="M4 12a6 6 0 0 1 6-6h9M16 3l3 3-3 3M20 12a6 6 0 0 1-6 6H5M8 21l-3-3 3-3"/>',
        skip: '<path d="M5 6.5l7 5.5-7 5.5zM12.5 6.5l7 5.5-7 5.5z"/>',
        wave: '<path d="M4 10v4M8 7v10M12 4.5v15M16 8v8M20 10.5v3"/>',
        help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.1-2.4 3.7M12 17.2v.1"/>',
        rotate: '<path d="M19.5 11.5a7.5 7.5 0 1 0-2.2 5.3"/><path d="M19.5 5v6.5H13"/>',
        flip: '<path d="M12 3v18M8.5 7 3.5 17h5zM15.5 7l5 10h-5z"/>',
        frameBack: '<path d="M7 5.5v13M18 6.8v10.4a.7.7 0 0 1-1.1.6L9.8 12.6a.7.7 0 0 1 0-1.2l7.1-5.2a.7.7 0 0 1 1.1.6z"/>',
        frameFwd: '<path d="M17 5.5v13M6 6.8v10.4a.7.7 0 0 0 1.1.6l7.1-5.2a.7.7 0 0 0 0-1.2L7.1 6.2a.7.7 0 0 0-1.1.6z"/>',
        trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7"/>',
        upload: '<path d="M12 19.5V9M7.6 13.4 12 9l4.4 4.4M5.5 4.5h13"/>',
        bolt: '<path fill="currentColor" stroke="none" d="M13 2 4.5 13.2a.6.6 0 0 0 .5 1H11l-1 7.8 8.5-11.2a.6.6 0 0 0-.5-1H12z"/>',
        warn: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17v.1"/>',
        external: '<path d="M13.5 4.5h6v6"/><path d="M19.5 4.5 11 13"/><path d="M17.5 13.5v4.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 6 6.5h4.5"/>',
        copy: '<rect x="8" y="8" width="11.5" height="11.5" rx="2.5"/><path d="M16 8V6.5A2 2 0 0 0 14 4.5H6.5a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2H8"/>'
    };

    // =====================================================================
    // Helpers
    // =====================================================================
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    /** Escaped text with case-insensitive matches of q wrapped in <mark>. */
    const highlight = (text, q) => {
        if (!q) return esc(text);
        const lower = text.toLowerCase();
        let out = '';
        let i = 0;
        for (let j = lower.indexOf(q); j !== -1; j = lower.indexOf(q, i)) {
            out += `${esc(text.slice(i, j))}<mark>${esc(text.slice(j, j + q.length))}</mark>`;
            i = j + q.length;
        }
        return out + esc(text.slice(i));
    };
    /** RFC 6381 codec string -> readable name for the stats panel. */
    const codecName = (c) => {
        const s = String(c || '').toLowerCase();
        if (/^avc[13]/.test(s)) return 'H.264';
        if (/^(hvc1|hev1)/.test(s)) return 'HEVC';
        if (/^(dvh1|dvhe)/.test(s)) return 'Dolby Vision';
        if (/^av01/.test(s)) return 'AV1';
        if (/^vp0?9/.test(s)) return 'VP9';
        if (/^vp0?8/.test(s)) return 'VP8';
        if (/^mp4a\.40\.(5|29)/.test(s)) return 'HE-AAC';
        if (/^mp4a\.6b|^mp3/.test(s)) return 'MP3';
        if (/^mp4a/.test(s)) return 'AAC';
        if (/^ac-?3/.test(s)) return 'Dolby Digital';
        if (/^ec-?3/.test(s)) return 'Dolby Digital Plus';
        return s.toUpperCase();
    };
    /**
     * Chapter title -> skip label. "OP"/"ED" only count as a whole title (optionally numbered) or
     * as an upper-case word, so names like "Ed's story" or "Operation" are not matched.
     */
    const skipKind = (title) => {
        const s = String(title || '').trim();
        if (!s) return null;
        if (/\b(intro|opening|theme\s*song)\b/i.test(s) || /^op\s*\d*$/i.test(s) || /\bOP\d*\b/.test(s)) return 'Intro';
        if (/\b(recap|previously)\b/i.test(s)) return 'Recap';
        if (/\b(ending|outro|credits)\b/i.test(s) || /^ed\s*\d*$/i.test(s) || /\bED\d*\b/.test(s)) return 'Credits';
        if (/\b(preview|next\s+episode)\b/i.test(s)) return 'Preview';
        return null;
    };
    /** True while a user gesture allows fullscreen/popup APIs (unknown -> assume yes). */
    const hasActivation = () => !navigator.userActivation || navigator.userActivation.isActive;

    function icon(name, size = 20) {
        return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
    }

    /** Circular skip arrow with the step number inside (e.g. "10"). */
    function skipIcon(dir, seconds) {
        const arc = dir < 0
            ? '<path d="M4.6 12a7.4 7.4 0 1 0 2.3-5.4"/><path d="M5 3.8v3.9h3.9"/>'
            : '<path d="M19.4 12a7.4 7.4 0 1 1-2.3-5.4"/><path d="M19 3.8v3.9h-3.9"/>';
        return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${arc}<text x="12" y="15.2" text-anchor="middle" font-size="7.4" font-weight="700" fill="currentColor" stroke="none" font-family="-apple-system, system-ui, sans-serif">${seconds}</text></svg>`;
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function fmtTime(sec) {
        if (!Number.isFinite(sec) || sec < 0) sec = 0;
        const s = Math.floor(sec % 60);
        const m = Math.floor(sec / 60) % 60;
        const h = Math.floor(sec / 3600);
        const pad = n => String(n).padStart(2, '0');
        return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }

    function fmtSpoken(sec) {
        if (!Number.isFinite(sec) || sec < 0) sec = 0;
        const h = Math.floor(sec / 3600);
        const m = Math.floor(sec / 60) % 60;
        const s = Math.floor(sec % 60);
        const parts = [];
        if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
        if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
        if (s || !parts.length) parts.push(`${s} second${s === 1 ? '' : 's'}`);
        return parts.join(' ');
    }

    function fmtDelta(sec) {
        return (sec < 0 ? '−' : '+') + fmtTime(Math.abs(sec));
    }

    function fmtBitrate(bps) {
        if (!bps) return '—';
        return bps < 1e6 ? `${Math.round(bps / 1e3)} kbps` : `${(bps / 1e6).toFixed(1)} Mbps`;
    }

    function fmtBytes(b) {
        if (!b) return '0 B';
        const u = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
        return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
    }

    function fmtRate(r) {
        const v = Math.round(r * 100) / 100;
        return `${Number.isInteger(v * 10) ? v.toFixed(1) : v.toFixed(2)}×`;
    }

    function hashKey(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(16);
    }

    function parseTimestamp(t) {
        const m = /^(?:(\d+):)?(\d{1,2}):([0-5]?\d)[.,](\d{1,3})$/.exec(t.trim());
        if (!m) return NaN;
        return (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
    }

    const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
    /** Code point -> string; NUL, surrogates and anything beyond U+10FFFF become U+FFFD. */
    function safeCodePoint(cp) {
        if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
        return String.fromCodePoint(cp);
    }

    /** Single pass, so "&amp;lt;" stays the literal text "&lt;". Unknown names are kept as is. */
    function decodeEntities(s) {
        return String(s).replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (m, dec, hex, name) => {
            if (dec) return safeCodePoint(dec.length > 8 ? Infinity : parseInt(dec, 10));
            if (hex) return safeCodePoint(hex.length > 6 ? Infinity : parseInt(hex, 16));
            return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m;
        });
    }

    /** Parse SRT or WebVTT text into [{start, end, text}]. */
    /** SubStation Alpha (.ass/.ssa): "Dialogue:" lines of the [Events] section; styling is dropped. */
    function parseAss(text) {
        const cues = [];
        let fields = null;
        for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
            const line = raw.trim();
            if (/^Format:/i.test(line) && !fields) {
                const f = line.slice(7).split(',').map(x => x.trim().toLowerCase());
                if (f.includes('text')) fields = f;
                continue;
            }
            if (!/^Dialogue:/i.test(line)) continue;
            const f = fields || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
            const parts = line.slice(9).split(',');
            const textIdx = f.indexOf('text');
            const val = k => (parts[f.indexOf(k)] || '').trim();
            // {\...} override blocks, \N / \n line breaks, \h hard space; then inline HTML-ish
            // tags (some encoders emit <i>), and finally entities on the plain text.
            const body = decodeEntities(parts.slice(textIdx).join(',')
                .replace(/\{[^}]*\}/g, '')
                .replace(/\\[Nn]/g, '\n')
                .replace(/\\h/g, ' ')
                .replace(/<[^>]+>/g, ''))
                .split('\n').map(l => l.replace(/^[ \t]+|[ \t]+$/g, '')).join('\n');
            const start = parseTimestamp(val('start'));
            const end = parseTimestamp(val('end'));
            if (Number.isFinite(start) && Number.isFinite(end) && body.trim()) cues.push({ start, end, text: body.trim() });
        }
        return cues.sort((x, y) => x.start - y.start);
    }

    function parseSubtitleFile(text) {
        if (/^\s*\[Script Info\]/i.test(text.replace(/^\uFEFF/, '')) || /\n\[Events\]/i.test(text)) return parseAss(text);
        const cues = [];
        const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
        for (const block of blocks) {
            const lines = block.split('\n').filter(l => l.length);
            const idx = lines.findIndex(l => l.includes('-->'));
            if (idx < 0) continue;
            const [a, b] = lines[idx].split('-->');
            const start = parseTimestamp(a);
            const end = parseTimestamp(b.trim().split(/\s+/)[0]);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            const body = lines.slice(idx + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '');
            if (body.trim()) cues.push({ start, end, text: decodeEntities(body) });
        }
        return cues.sort((x, y) => x.start - y.start);
    }

    function cueText(cue) {
        if (cue.nestedCues && cue.nestedCues.length) {
            return cue.nestedCues.map(n => (n.lineBreak ? '\n' : cueText(n))).join('');
        }
        return cue.payload || '';
    }

    const extApi = (window.VelostreamShared && window.VelostreamShared.api) || null;
    /** Sanitized markup insertion (common/shared.js); never assign innerHTML directly. */
    const setHTML = (el, markup) => window.VelostreamShared.setHTML(el, markup);

    function safeFilename(name) {
        // eslint-disable-next-line no-control-regex -- control characters are invalid in file names
        return String(name || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 180) || 'video';
    }

    /**
     * Save a Blob. Uses chrome.downloads (Save As dialog) when available and revokes the object
     * URL only once the download completes or is interrupted; falls back to an <a download>.
     */
    function downloadBlob(container, blob, filename, saveAs = true) {
        const url = URL.createObjectURL(blob);
        const name = safeFilename(filename);
        const viaAnchor = () => {
            const a = document.createElement('a');
            a.href = url;
            a.download = name;
            a.style.display = 'none';
            container.appendChild(a);
            a.click();
            a.remove();
            // An <a download> gives no completion signal: keep the URL alive long enough.
            setTimeout(() => URL.revokeObjectURL(url), 10 * 60000);
        };
        if (!extApi || !extApi.downloads || !extApi.downloads.download) { viaAnchor(); return Promise.resolve(false); }
        return new Promise((resolve, reject) => {
            let id = null;
            const done = (error) => {
                try { extApi.downloads.onChanged.removeListener(onChanged); } catch (_) { /* ignore */ }
                URL.revokeObjectURL(url);
                if (error) reject(new Error(error));
                else resolve(true);
            };
            const onChanged = (delta) => {
                if (delta.id !== id || !delta.state) return;
                if (delta.state.current === 'complete') done();
                if (delta.state.current === 'interrupted') done('Browser download interrupted.');
            };
            extApi.downloads.onChanged.addListener(onChanged);
            Promise.resolve(extApi.downloads.download({ url, filename: name, saveAs })).then((dlId) => {
                id = dlId;
                if (id == null) done('Browser download cancelled.');
                else extApi.downloads.search({ id }).then(([item]) => {
                    if (item?.state === 'complete') done();
                    else if (!item || item.state === 'interrupted') done('Browser download interrupted.');
                }).catch(() => { });
            }, () => {
                try { extApi.downloads.onChanged.removeListener(onChanged); } catch (_) { /* ignore */ }
                viaAnchor();
                resolve(false);
            });
        });
    }

    /**
     * Destination of an export. Prefers File System Access (streams straight to disk, no RAM
     * growth); Chrome only allows its picker in top-level / same-origin frames and with a user
     * gesture, so most in-page sessions fall back to collecting Blob parts (which the browser
     * may back with disk) and handing them to downloadBlob() at the end.
     */
    class ExportSink {
        constructor(container, filename, mime) {
            this.container = container;
            this.filename = safeFilename(filename);
            this.mime = mime;
            this.parts = [];
            this.writable = null;
            this.temp = null;
            this.bytes = 0;
        }

        static async pick(container, filename, mime) {
            const sink = new ExportSink(container, filename, mime);
            // The picker needs transient user activation in this frame. A remote "Download"
            // (popup -> engine -> COMMAND 'export') has none: go straight to the downloads sink
            // instead of letting the picker throw (or, worse, hang waiting for a gesture).
            if (typeof window.showSaveFilePicker === 'function' && hasActivation()) {
                try {
                    const ext = (/\.([a-z0-9]+)$/i.exec(sink.filename) || ['', 'mp4'])[1];
                    const handle = await window.showSaveFilePicker({
                        suggestedName: sink.filename,
                        types: [{ description: 'Video', accept: { [mime || 'video/mp4']: [`.${ext}`] } }]
                    });
                    sink.writable = await handle.createWritable();
                } catch (err) {
                    if (err && err.name === 'AbortError') return null; // the user cancelled the picker
                    sink.writable = null;                              // SecurityError in a cross-origin frame etc.
                }
            }
            return sink;
        }

        async openTemporaryFile() {
            const dir = await navigator.storage?.getDirectory?.().catch(() => null);
            if (!dir) return;
            const key = 'export-' + crypto.randomUUID();
            try {
                const handle = await dir.getFileHandle(key, { create: true });
                if (!handle.createWritable) { await dir.removeEntry(key); return; }
                this.writable = await handle.createWritable();
                this.temp = { dir, key, handle };
            } catch (_) { await dir.removeEntry(key).catch(() => {}); }
        }

        async write(chunk) {
            if (!this.writable && !this.bytes) await this.openTemporaryFile();
            this.bytes += chunk.byteLength || chunk.size || 0;
            if (!this.writable && this.bytes > 128 * 1024 * 1024) throw new Error('This browser can only save up to 128 MB per export without a file picker.');
            if (this.writable) await this.writable.write(chunk);
            else this.parts.push(chunk instanceof Blob ? chunk : new Blob([chunk]));
        }

        async close() {
            if (this.writable) {
                await this.writable.close();
                this.writable = null;
                if (this.temp) {
                    let finished = true;
                    try { finished = await downloadBlob(this.container, await this.temp.handle.getFile(), this.filename); }
                    finally {
                        if (finished) await this.removeTemporaryFile();
                        else {
                            const { dir, key } = this.temp;
                            this.temp = null;
                            setTimeout(() => dir.removeEntry(key).catch(() => {}), 10 * 60000);
                        }
                    }
                }
                return;
            }
            const blob = new Blob(this.parts, { type: this.mime });
            this.parts = [];
            await downloadBlob(this.container, blob, this.filename);
        }

        async removeTemporaryFile() {
            if (!this.temp) return;
            const { dir, key } = this.temp;
            this.temp = null;
            await dir.removeEntry(key).catch(() => {});
        }

        async abort() {
            this.parts = [];
            if (this.writable) { try { await this.writable.abort(); } catch (_) { /* ignore */ } this.writable = null; }
            await this.removeTemporaryFile();
        }
    }

    // ---- Settings layering: raw (storage) -> site profile -> session overrides ----
    const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
    const cloneValue = v => (Array.isArray(v) ? v.slice() : isPlainObject(v) ? { ...v } : v);
    const sameValue = (a, b) => a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
    const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

    /** Copy whose sub-objects (and their arrays, e.g. audio.eq) are not shared with the source. */
    function cloneSettings(s) {
        const out = { ...(s || {}) };
        for (const k of DEEP_SETTINGS) {
            if (!isPlainObject(out[k])) continue;
            const sub = {};
            for (const [sk, sv] of Object.entries(out[k])) sub[sk] = cloneValue(sv);
            out[k] = sub;
        }
        return out;
    }

    /** Overlay a partial settings object; sub-objects of DEEP_SETTINGS merge per field. */
    function overlaySettings(target, partial, only) {
        for (const [k, v] of Object.entries(partial || {})) {
            if (DEEP_SETTINGS.includes(k) && isPlainObject(v)) {
                const sub = { ...(target[k] || {}) };
                for (const [sk, sv] of Object.entries(v)) {
                    if (!only || (only[k] && hasOwn(only[k], sk))) sub[sk] = cloneValue(sv);
                }
                target[k] = sub;
            } else if (!only || hasOwn(only, k)) {
                target[k] = cloneValue(v);
            }
        }
        return target;
    }

    /** The fields a site profile controls, as a partial settings object. */
    function profileFields(p) {
        const out = {};
        if (!p) return out;
        if (Number.isFinite(p.defaultSpeed)) out.defaultSpeed = p.defaultSpeed;
        if (Number.isFinite(p.qualityCap)) out.qualityCap = p.qualityCap;
        if (typeof p.shader === 'string') out.shader = window.VelostreamShared.normalizeGraphicsPreset(p.shader);
        if (Number.isFinite(p.shaderStrength)) out.shaderStrength = p.shaderStrength;
        if (typeof p.audioPreset === 'string') out.audio = { preset: p.audioPreset };
        if (Number.isFinite(p.subSize)) out.subtitles = { size: p.subSize };
        return out;
    }

    /** Options for a <select>, plus the stored value when it is not one of them (never blank). */
    function withCurrentOption(pairs, value, label) {
        if (value == null || value === '' || pairs.some(([v]) => String(v) === String(value))) return pairs;
        return pairs.concat([[value, label(value)]]);
    }

    const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
    const wait = ms => new Promise(r => setTimeout(r, ms));

    // =====================================================================
    // Port client (MAIN world side of the private MessagePort)
    // =====================================================================
    class PortClient {
        constructor(port, handler) {
            this.port = port;
            this.waiters = new Map();
            this.seq = 0;
            port.onmessage = (e) => {
                const m = e.data;
                if (!m) return;
                if (m.reqId && this.waiters.has(m.reqId) && (m.type === 'SETTINGS' || m.type === 'STORE_VALUE' || m.type === 'HISTORY_SAVED')) {
                    const w = this.waiters.get(m.reqId);
                    this.waiters.delete(m.reqId);
                    w(m);
                    return;
                }
                handler(m);
            };
        }

        send(msg, transfer) {
            try { this.port.postMessage(msg, transfer || []); } catch (_) { /* closed */ }
        }

        request(type, extra = {}, timeoutMs = 8000) {
            const reqId = `q${++this.seq}`;
            return new Promise((resolve, reject) => {
                const t = setTimeout(() => { this.waiters.delete(reqId); reject(new Error(`${type} timed out`)); }, timeoutMs);
                this.waiters.set(reqId, (m) => { clearTimeout(t); resolve(m); });
                this.send({ type, reqId, ...extra });
            });
        }

        close() {
            try { this.port.onmessage = null; this.port.close(); } catch (_) { /* ignore */ }
        }
    }

    // =====================================================================
    // Audio engine: Web Audio booster, 5-band EQ, compressor, delay, analyser
    // =====================================================================
    class AudioFx {
        constructor(video) {
            this.video = video;
            this.ctx = null;
            this.nodes = null;
            this.levels = null;
            /** Set by the player once a crossorigin="anonymous" file loaded its metadata with CORS. */
            this.corsOk = false;
        }

        get active() { return !!this.ctx; }

        /**
         * Web Audio taps a cross-origin, non-CORS media element as silence: only allow when safe.
         * MSE (blob:) is always same-origin; a direct file is safe when it was fetched with CORS
         * (the engine adds Access-Control-Allow-Origin for media requests from the extension).
         */
        allowed() {
            const v = this.video;
            const src = v.currentSrc || '';
            if (!src) return false;
            if (src.startsWith('blob:')) return true;
            if (this.corsOk && v.getAttribute('crossorigin') !== null) return true;
            try { return new URL(src).origin === location.origin; } catch (_) { return false; }
        }

        /** Must run inside a user-activation event, otherwise the context starts suspended. */
        ensure() {
            if (this.ctx) {
                if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => { });
                return true;
            }
            if (this.sourceBound || !this.allowed()) return false;
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return false;
            let context;
            try {
                context = new AC({ latencyHint: 'playback' });
                const ctx = context;
                const delay = ctx.createDelay(2);
                const eq = EQ_BANDS.map(b => {
                    const f = ctx.createBiquadFilter();
                    f.type = b.type;
                    f.frequency.value = b.f;
                    if (b.type === 'peaking') f.Q.value = 1.1;
                    return f;
                });
                const comp = ctx.createDynamicsCompressor();
                const gain = ctx.createGain();
                const analyser = ctx.createAnalyser();
                analyser.fftSize = 512;
                analyser.smoothingTimeConstant = 0.75;
                // Loudness normalizer: slow auto-gain (driven from tickLoudness) + a peak limiter
                // after it, so lifted quiet dialogue never clips and explosions are tamed.
                const normGain = ctx.createGain();
                const normLimit = ctx.createDynamicsCompressor();
                normLimit.threshold.value = -12;
                normLimit.knee.value = 8;
                normLimit.ratio.value = 6;
                normLimit.attack.value = 0.004;
                normLimit.release.value = 0.3;
                const out = ctx.createGain(); // processing exit; the spatial stage reads from it
                const post = ctx.createGain(); // after the spatial stage; channel routing hangs off it
                const source = ctx.createMediaElementSource(this.video);
                this.sourceBound = true;
                this.ctx = ctx;
                this.nodes = { source, delay, eq, comp, gain, analyser, normGain, normLimit, out, post, compressing: null, normalizing: null, spatialKey: null };
                source.connect(delay);
                delay.connect(eq[0]);
                for (let i = 0; i < eq.length - 1; i++) eq[i].connect(eq[i + 1]);
                gain.connect(analyser);           // measured before the normalizer (no feedback)
                normGain.connect(normLimit);
                this._routeNorm(false);
                this._routeSpatial({ width: 100, crossfeed: false, dialogue: 0 });
                this.loud = { energy: 0, primed: false };
                this.channels = null;
                this._routeChannels('stereo');
                this._route(false);
                if (ctx.state === 'suspended') ctx.resume().catch(() => { });
                return true;
            } catch (e) {
                console.warn('[Velostream] Audio graph unavailable:', e);
                context?.close().catch(() => { });
                this.ctx = null;
                return false;
            }
        }

        _route(compress) {
            const n = this.nodes;
            if (n.compressing === compress) return;
            const last = n.eq[n.eq.length - 1];
            try { last.disconnect(); } catch (_) { /* first time */ }
            try { n.comp.disconnect(); } catch (_) { /* first time */ }
            if (compress) { last.connect(n.comp); n.comp.connect(n.gain); } else { last.connect(n.gain); }
            n.compressing = compress;
        }

        /** gain -> out directly, or gain -> normGain -> normLimit -> out. */
        _routeNorm(on) {
            const n = this.nodes;
            if (!n || n.normalizing === on) return;
            try { n.gain.disconnect(n.out); } catch (_) { /* not connected */ }
            try { n.gain.disconnect(n.normGain); } catch (_) { /* not connected */ }
            try { n.normLimit.disconnect(); } catch (_) { /* not connected */ }
            if (on) {
                n.gain.connect(n.normGain);
                n.normLimit.connect(n.out);
            } else {
                n.gain.connect(n.out);
                n.normGain.gain.value = 1;
                if (this.loud) this.loud.primed = false;
            }
            n.normalizing = on;
        }

        /**
         * Smart loudness, called ~4×/s: track the programme level (energy average over ~3 s, gated
         * below -45 dBFS so silence and pauses do not pull the gain up) and steer normGain toward a
         * -20 dBFS RMS target (≈ -16 LUFS for typical dialogue), within ±12 dB, with a slow time
         * constant so speech does not "pump". The limiter after it catches transients.
         */
        tickLoudness() {
            const n = this.nodes;
            if (!n || !n.normalizing || !this.ctx || this.video.paused) return;
            const level = this.rms();
            const db = 20 * Math.log10(Math.max(level, 1e-6));
            if (!Number.isFinite(db) || db < -45) return; // silence / pause: hold the current gain
            const L = this.loud;
            const e = level * level;
            L.energy = L.primed ? L.energy * 0.92 + e * 0.08 : e;
            L.primed = true;
            const progDb = 10 * Math.log10(Math.max(L.energy, 1e-12));
            const wantDb = clamp(-20 - progDb, -12, 12);
            n.normGain.gain.setTargetAtTime(Math.pow(10, wantDb / 20), this.ctx.currentTime, 1.2);
        }

        /**
         * Spatial stage between `out` and `post`:
         *   width     L' = a·L + b·R, R' = a·R + b·L with a = (1+w)/2, b = (1-w)/2 (mid/side scaling;
         *             w = 0 mono, 1 as recorded, 2 extra wide);
         *   dialogue  the centre (mid = (L+R)/2) band-passed around 2 kHz and added back to both
         *             sides, so voices lift without touching music/effects panned to the sides;
         *   crossfeed each side delayed 0.3 ms, low-passed at 700 Hz and mixed into the other at
         *             -9 dB (Bauer-style), so hard-panned headphone mixes stop sounding "inside the head".
         * Neutral settings bypass the stage entirely (out -> post), costing nothing.
         */
        _routeSpatial(a) {
            const n = this.nodes;
            if (!n) return;
            const w = clamp((+a.width || 100) / 100, 0, 2);
            const dlg = clamp(+a.dialogue || 0, 0, 100) / 100;
            const cf = !!a.crossfeed;
            const neutral = Math.abs(w - 1) < 0.005 && !dlg && !cf;
            const key = neutral ? 'bypass' : 'spatial';
            const ctx = this.ctx;
            if (n.spatialKey !== key) {
                try { n.out.disconnect(n.post); } catch (_) { /* not connected */ }
                if (n.sp) { for (const node of Object.values(n.sp)) { try { node.disconnect(); } catch (_) { /* ignore */ } } }
                n.sp = null;
                if (neutral) {
                    n.out.connect(n.post);
                } else {
                    const up = ctx.createGain(); // upmix mono sources to L=R before splitting
                    up.channelCount = 2;
                    up.channelCountMode = 'explicit';
                    up.channelInterpretation = 'speakers';
                    const split = ctx.createChannelSplitter(2);
                    const merge = ctx.createChannelMerger(2);
                    const ll = ctx.createGain();
                    const rl = ctx.createGain();
                    const rr = ctx.createGain();
                    const lr = ctx.createGain();
                    const midL = ctx.createGain();
                    const midR = ctx.createGain();
                    const mid = ctx.createGain();
                    mid.channelCount = 1;
                    mid.channelCountMode = 'explicit';
                    const band = ctx.createBiquadFilter();
                    band.type = 'bandpass';
                    band.frequency.value = 2000;
                    band.Q.value = 0.8;
                    const dGain = ctx.createGain();
                    const dL = ctx.createDelay(0.01);
                    const dR = ctx.createDelay(0.01);
                    dL.delayTime.value = 0.0003;
                    dR.delayTime.value = 0.0003;
                    const lpL = ctx.createBiquadFilter();
                    const lpR = ctx.createBiquadFilter();
                    lpL.type = lpR.type = 'lowpass';
                    lpL.frequency.value = lpR.frequency.value = 700;
                    const cfL = ctx.createGain();
                    const cfR = ctx.createGain();
                    n.out.connect(up);
                    up.connect(split);
                    split.connect(ll, 0); split.connect(rl, 1); ll.connect(merge, 0, 0); rl.connect(merge, 0, 0);
                    split.connect(rr, 1); split.connect(lr, 0); rr.connect(merge, 0, 1); lr.connect(merge, 0, 1);
                    split.connect(midL, 0); split.connect(midR, 1); midL.connect(mid); midR.connect(mid);
                    mid.connect(band); band.connect(dGain); dGain.connect(merge, 0, 0); dGain.connect(merge, 0, 1);
                    split.connect(dL, 0); dL.connect(lpL); lpL.connect(cfL); cfL.connect(merge, 0, 1);
                    split.connect(dR, 1); dR.connect(lpR); lpR.connect(cfR); cfR.connect(merge, 0, 0);
                    merge.connect(n.post);
                    n.sp = { up, split, merge, ll, rl, rr, lr, midL, midR, mid, band, dGain, dL, dR, lpL, lpR, cfL, cfR };
                }
                n.spatialKey = key;
            }
            if (!n.sp) return;
            const t = ctx.currentTime;
            const sp = n.sp;
            const A = (1 + w) / 2;
            const B = (1 - w) / 2;
            sp.ll.gain.setTargetAtTime(A, t, 0.05);
            sp.rr.gain.setTargetAtTime(A, t, 0.05);
            sp.rl.gain.setTargetAtTime(B, t, 0.05);
            sp.lr.gain.setTargetAtTime(B, t, 0.05);
            sp.midL.gain.value = 0.5;
            sp.midR.gain.value = 0.5;
            sp.dGain.gain.setTargetAtTime(dlg * 2.5, t, 0.05); // up to about +9 dB at 2 kHz on the centre
            const c = cf ? 0.35 : 0;
            sp.cfL.gain.setTargetAtTime(c, t, 0.05);
            sp.cfR.gain.setTargetAtTime(c, t, 0.05);
        }

        /** Frequency magnitudes (0-255) for the visualizer, or null without an audio graph. */
        spectrum() {
            if (!this.nodes) return null;
            const a = this.nodes.analyser;
            if (!this.freq || this.freq.length !== a.frequencyBinCount) this.freq = new Uint8Array(a.frequencyBinCount);
            a.getByteFrequencyData(this.freq);
            return this.freq;
        }

        /** Output channel mode: stereo (as is), mono (downmix), left / right only (on both speakers). */
        _routeChannels(mode) {
            const n = this.nodes;
            if (!n || this.channels === mode) return;
            const ctx = this.ctx;
            try { n.post.disconnect(ctx.destination); } catch (_) { /* not connected */ }
            if (n.chan) { for (const node of Object.values(n.chan)) { try { node.disconnect(); } catch (_) { /* ignore */ } } }
            n.chan = null;
            if (mode === 'mono') {
                const down = ctx.createGain();
                down.channelCount = 1;
                down.channelCountMode = 'explicit';
                down.channelInterpretation = 'speakers';
                n.post.connect(down);
                down.connect(ctx.destination);
                n.chan = { down };
            } else if (mode === 'left' || mode === 'right') {
                const split = ctx.createChannelSplitter(2);
                const merge = ctx.createChannelMerger(2);
                const ch = mode === 'left' ? 0 : 1;
                n.post.connect(split);
                split.connect(merge, ch, 0);
                split.connect(merge, ch, 1);
                merge.connect(ctx.destination);
                n.chan = { split, merge };
            } else {
                n.post.connect(ctx.destination);
            }
            this.channels = mode;
        }

        apply(audio) {
            if (!this.ctx) return;
            this._routeChannels(audio.channels || 'stereo');
            this._routeNorm(!!audio.loudnessNorm);
            this._routeSpatial({ width: audio.width ?? 100, crossfeed: !!audio.crossfeed, dialogue: audio.dialogue || 0 });
            const preset = AUDIO_PRESETS[audio.preset] || AUDIO_PRESETS.normal;
            const gains = audio.preset === 'custom' ? (audio.eq || [0, 0, 0, 0, 0]) : preset.eq;
            const n = this.nodes;
            const t = this.ctx.currentTime;
            gains.forEach((db, i) => n.eq[i].gain.setTargetAtTime(clamp(+db || 0, -12, 12), t, 0.05));
            const boost = audio.boost / 100;
            const compress = preset.compress || boost > 1.5;
            if (compress) {
                n.comp.threshold.value = audio.preset === 'night' ? -45 : -28;
                n.comp.knee.value = 30;
                n.comp.ratio.value = audio.preset === 'night' ? 10 : 4;
                n.comp.attack.value = 0.003;
                n.comp.release.value = 0.25;
            }
            this._route(compress);
            n.gain.gain.setTargetAtTime(boost * (audio.preset === 'night' ? 1.6 : 1), t, 0.05);
            n.delay.delayTime.setTargetAtTime(clamp(audio.delayMs, 0, 1000) / 1000, t, 0.02);
        }

        /** Root-mean-square output level (0..1), used by smart skip to detect silence. */
        rms() {
            if (!this.nodes) return 1;
            const a = this.nodes.analyser;
            if (!this.levels) this.levels = new Float32Array(a.fftSize);
            a.getFloatTimeDomainData(this.levels);
            let sum = 0;
            for (let i = 0; i < this.levels.length; i++) sum += this.levels[i] * this.levels[i];
            return Math.sqrt(sum / this.levels.length);
        }

        destroy() {
            if (this.ctx) this.ctx.close().catch(() => { });
            this.ctx = null;
            this.nodes = null;
        }
    }

    // =====================================================================
    // Subtitle engine (Shaka text displayer + external SRT/VTT)
    // =====================================================================
    class SubtitleEngine {
        constructor(layer, topLayer) {
            this.layer = layer;
            this.topLayer = topLayer;     // secondary (dual) subtitles, shown at the top
            this.shakaCues = [];
            this.shakaKeys = new Set();
            this.externalCues = null;
            this.externalName = '';
            this.secondaryCues = null;
            this.secondaryName = '';
            this.secondaryIndex = null;
            this.source = 'off';  // off | shaka | external
            this.offset = 0;
            this.speed = 1;       // cue timing scale (0.9-1.1) for frame-rate mismatched files
            this.shakaVisible = false;
            this.lastHtml = '';
            this.lastTopHtml = '';
        }

        clearExternal() {
            this.externalCues = null;
            this.externalName = '';
            this.capturedIndex = null;
            this.secondaryCues = null;
            this.secondaryName = '';
            this.secondaryIndex = null;
            this.lastHtml = this.lastTopHtml = null;
            if (this.source === 'external') this.source = 'off';
        }

        activeCues() {
            return this.source === 'external' ? this.externalCues : this.source === 'shaka' ? this.shakaCues : null;
        }

        /** Media time -> subtitle file time. */
        cueTime(time) { return (time - this.offset) / (this.speed || 1); }

        /** The next cue that has not started yet (for "sync to current voice"). */
        nextCueStart(time) {
            const cues = this.activeCues();
            if (!cues || !cues.length) return null;
            const t = this.cueTime(time);
            for (const c of cues) if (c.start > t - 0.2) return c.start;
            return null;
        }

        static linesHtml(texts) {
            return texts.join('\n').split('\n').map(line => `<span class="cue-line">${esc(line)}</span>`).join('');
        }

        static activeAt(cues, t) {
            const active = [];
            if (!cues) return active;
            for (const c of cues) {
                if (c.start > t) break;
                if (t < c.end) active.push(c.text);
            }
            return active;
        }

        createDisplayer() {
            const self = this;
            const keyOf = c => `${c.start.toFixed(3)}|${c.end.toFixed(3)}|${c.text}`;
            return {
                configure() { },
                setTextLanguage() { },
                enableTextDisplayer() { },
                append(cues) {
                    for (const c of cues) {
                        const text = cueText(c).trim();
                        if (!text) continue;
                        const cue = { start: c.startTime, end: c.endTime, text };
                        const key = keyOf(cue);
                        if (self.shakaKeys.has(key)) continue;
                        self.shakaKeys.add(key);
                        self.shakaCues.push(cue);
                    }
                    self.shakaCues.sort((a, b) => a.start - b.start);
                },
                remove(start, end) {
                    self.shakaCues = self.shakaCues.filter(c => c.end <= start || c.start >= end);
                    self.shakaKeys = new Set(self.shakaCues.map(keyOf));
                    return true;
                },
                isTextVisible() { return self.shakaVisible; },
                setTextVisibility(on) { self.shakaVisible = !!on; },
                destroy() {
                    self.shakaCues = [];
                    self.shakaKeys.clear();
                    return Promise.resolve();
                }
            };
        }

        clearShaka() {
            this.shakaCues = [];
            this.shakaKeys.clear();
        }

        render(time) {
            const t = this.cueTime(time);
            const active = SubtitleEngine.activeAt(this.activeCues(), t);
            const html = active.length ? SubtitleEngine.linesHtml(active) : '';
            if (html !== this.lastHtml) {
                this.lastHtml = html;
                setHTML(this.layer, html);
            }
            if (this.topLayer) {
                const top = this.secondaryCues ? SubtitleEngine.activeAt(this.secondaryCues, t) : [];
                const topHtml = top.length ? SubtitleEngine.linesHtml(top) : '';
                if (topHtml !== this.lastTopHtml) {
                    this.lastTopHtml = topHtml;
                    setHTML(this.topLayer, topHtml);
                }
            }
        }
    }

    // =====================================================================
    // Styles - glass design system
    // =====================================================================


    // =====================================================================
    // Player
    // =====================================================================
    function positionPopover(trigger, popover, container) {
        const margin = 12;
        const bounds = container.getBoundingClientRect();
        const dock = container.querySelector('.deck').getBoundingClientRect();
        const anchor = trigger?.getBoundingClientRect();
        const width = popover.offsetWidth;
        const preferredHeight = Math.min(bounds.height * .7, 560);
        const above = dock.top - bounds.top - margin * 2;
        const below = bounds.bottom - (anchor?.bottom ?? bounds.bottom) - margin * 2;
        const centered = !anchor || Math.max(above, below) < 96;
        const placeAbove = !centered && above >= below;
        const height = Math.max(0, Math.min(preferredHeight, centered ? bounds.height - margin * 2 : placeAbove ? above : below));
        popover.style.maxHeight = height + 'px';
        const actualHeight = popover.offsetHeight;
        const x = clamp((anchor ? (anchor.left + anchor.right) / 2 - bounds.left : bounds.width / 2) - width / 2,
            margin, Math.max(margin, bounds.width - width - margin));
        const y = centered ? (bounds.height - actualHeight) / 2 :
            placeAbove ? dock.top - bounds.top - margin - actualHeight : anchor.bottom - bounds.top + margin;
        popover.style.setProperty('--popover-left', x + 'px');
        popover.style.setProperty('--popover-top', Math.max(margin, y) + 'px');
        popover.style.left = 'var(--popover-left)';
        popover.style.top = 'var(--popover-top)';
        popover.style.bottom = 'auto';
    }

    class VelostreamPlayer {
        /**
         * @param {{postMessage:Function, onmessage:Function, close:Function}} rawPort EnginePort
         * @param {{layout:Function, mountMode:string, startTime:number|null, pageTitle:string}} host
         */
        constructor(rawPort, host = {}) {
            this.hostApi = { layout: () => { }, mountMode: 'inline', startTime: null, pageTitle: '', ...host };
            this.disposers = [];
            this.timers = new Set();
            this.net = new Map();
            this.netSeq = 0;
            this.settings = null;          // effective: rawSettings + site profile + session overrides
            this.rawSettings = null;       // exactly what storage holds (plus our unsent edits)
            this.sessionOverrides = {};    // in-session edits of profile-controlled fields
            this.profileValues = {};
            this.pendingPatch = null;
            this.loadGen = 0;
            this.corsUnavailable = false;  // direct file refused CORS once: load it without for this session
            this.stream = null;
            this.player = null;
            this.mode = 'mse';
            this.abrAuto = true;
            this.lockedVariantId = null;
            this.engineStats = null;
            this.variantsSig = '';
            this.lastVariantsSentAt = 0;
            this.loop = { a: null, b: null };
            this.clip = { start: null, end: null };
            this.bookmarks = [];
            this.filters = { ...DEFAULT_FILTERS };
            this.xf = { zoom: 1, panX: 0, panY: 0, rotate: 0, flip: false };
            this.fit = 'contain';
            this.locked = false;
            this.audioOnly = false;
            this.mini = false;
            this.lookOpen = { buttons: false, order: false };
            this.qualityCap = 0;
            this.exportState = null;
            this.recordingSince = 0;
            this.showRemaining = false;
            this.popKind = null;
            this.studioTab = 'quality';
            this.sleep = null;
            this.sleepPausedPrefetch = false;
            this.smart = { darkSince: 0, boostFrom: null, blocked: false };
            this.closed = false;
            this.errorShown = false;
            this.secondTick = 0;
            this.lastQuality = { total: 0, at: 0 };
            this.statusPersistent = null;
            this.resolveInit = null;
            this.initPromise = new Promise(res => { this.resolveInit = res; });
            this.prevFocus = document.activeElement;

            this.port = new PortClient(rawPort, msg => this.onMessage(msg));
            this.buildDom();
            this.bindUi();
            this.localPlayback = !!host.local;
            if (host.local) {
                this.resolveInit({ stream: { id: 'local', type: 'progressive', title: 'Open Local File', url: '' } });
                this.resolveInit = null;
            }
            this.ready = this.start();
            this.ready.catch(err => this.showError('Could not start the player', String((err && err.message) || err)));
            bindLocalFiles(this, host.fileId, !!host.local);
        }

        // -----------------------------------------------------------------
        // Lifecycle
        // -----------------------------------------------------------------
        async start() {
            this.setStatus('loading');
            const [settingsMsg, init] = await Promise.all([this.port.request('SETTINGS_GET'), this.initPromise]);
            this.pageUrl = init.pageUrl || '';
            this.playbackPageUrl = this.pageUrl;
            this.pageMeta = this.playbackPageMeta = init.pageMeta || null;
            this.stream = init.stream;
            this.rawSettings = cloneSettings(this.bootSettings || settingsMsg.settings);
            this.bootSettings = null;
            this.recomputeSettings();
            if (!this.settings.hwTier) this.applyHardwareTier(false); // first run on this device
            if (this.profile) this.island('studio', `Site profile · ${this.profile.host}`, null, 2500);
            this.tabId = init.tabId;
            this.sessionId = init.sessionId;
            this.cacheReady = typeof init.tabId === 'number' && !!init.sessionId;
            this.qualityCap = this.settings.qualityCap || 0;
            const title = this.hostApi.pageTitle || this.stream.title || this.titleFromUrl(this.stream.url);
            this.$('.title').textContent = title;
            this.$('.title').title = title;
            let domain = '';
            try { domain = new URL(this.stream.url).hostname; } catch (_) { domain = location.hostname; }
            this.$('.domain').textContent = domain;
            this.root.setAttribute('aria-label', `Velostream player: ${title}`);
            this.applySettings();
            if (this.hostApi.local) {
                this.setStatus('paused');
                this.showControls(true);
                this.updateDownloadButton();
                return;
            }
            await this.loadBookmarks();
            // Continue from where the site's own player was (handed over by the content script).
            this.setCaptured(init.subtitles);
            this.drmInfo = init.drm || null;
            await this.load(this.hostApi.startTime || undefined);
            // Position (unless the site's own player handed one over) + per-video subtitle offset / loop.
            this.checkResume();
            this.autoSelectCaptured();
            this.loadChapters();
        }

        /**
         * Rough device class from CPU cores, memory (Chromium only), touch + screen size and the
         * WebGL renderer. Low: phones/tablets with little memory, software or weak mobile GPUs.
         * High: desktops with many cores, plenty of memory and a discrete-class GPU.
         */
        detectHardwareTier() {
            const cores = navigator.hardwareConcurrency || 4;
            const mem = navigator.deviceMemory || 0; // 0 = unknown (Firefox)
            const coarse = matchMedia('(pointer: coarse)').matches;
            const small = Math.min(screen.width || 0, screen.height || 0) < 600;
            let gpu = 1;
            let renderer = '';
            let webgl = false;
            try {
                const gl = document.createElement('canvas').getContext('webgl2');
                if (!gl) gpu = 0;
                else {
                    webgl = true;
                    const ext = gl.getExtension('WEBGL_debug_renderer_info');
                    renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
                    if (/SwiftShader|llvmpipe|Microsoft Basic Render|Mali-[T4]|Adreno \(TM\) [3-5]\d\d|PowerVR/i.test(renderer)) gpu = 0;
                    else if (/RTX|GTX 1[6-9]|Radeon RX|Radeon Pro|Arc A|Apple M\d/i.test(renderer)) gpu = 2;
                    const lose = gl.getExtension('WEBGL_lose_context');
                    if (lose) lose.loseContext();
                }
            } catch (_) { gpu = 0; }
            let tier = 'standard';
            if ((mem && mem <= 2) || cores <= 2 || gpu === 0 || (coarse && small && (cores <= 4 || (mem && mem <= 4)))) tier = 'low';
            else if (!coarse && cores >= 8 && (!mem || mem >= 8) && gpu === 2) tier = 'high';
            return { tier, cores, mem, coarse, renderer, webgl };
        }

        /**
         * Tune the engine/player buffers to the device. On first run only settings still at their
         * defaults are changed (never a value the user picked); `force` (Prefs › Re-detect) applies
         * the tier's values regardless.
         */
        applyHardwareTier(force) {
            const info = this.detectHardwareTier();
            this.graphicsHardware = info;
            const D = window.VelostreamShared.DEFAULT_SETTINGS;
            const TUNE = {
                low: { maxWorkers: 3, cacheSizeMB: 512, mseBufferAhead: 30, mseBufferBehind: 15, maxRenderRes: 1080 },
                standard: {},
                high: { maxWorkers: 8, cacheSizeMB: 4096, mseBufferAhead: 60 }
            }[info.tier];
            const patch = { hwTier: info.tier };
            const raw = this.rawSettings || {};
            for (const [k, v] of Object.entries(TUNE)) if (force || raw[k] === D[k]) patch[k] = v;
            this.saveSettings(patch);
            this.hwInfo = info;
            if (force) this.announce(`Device tier: ${info.tier}${Object.keys(patch).length > 1 ? ' · settings re-tuned' : ''}`, 'studio');
        }

        /** Splits captured site tracks into subtitles and chapters; true when chapters changed. */
        setCaptured(list) {
            const all = Array.isArray(list) ? list : [];
            this.subs.capturedTracks = all.filter(t => t.kind !== 'chapters');
            const ch = all.filter(t => t.kind === 'chapters');
            const changed = ch.length !== (this.capturedChapters || []).length;
            this.capturedChapters = ch;
            return changed;
        }

        // -----------------------------------------------------------------
        // Captured subtitles (the site's own sidecar files / in-memory cues)
        // -----------------------------------------------------------------
        capturedLabel(t, i) {
            if (t.label) return t.label;
            if (t.language) return t.language.toUpperCase();
            let name = '';
            try { name = decodeURIComponent(new URL(t.url).pathname.split('/').pop() || ''); } catch (_) { /* inline */ }
            return name || `Site track ${i + 1}`;
        }

        /** Fetches text through the engine (site cookies / Referer); resolves '' on failure. */
        fetchText(url) {
            return new Promise(resolve => {
                const reqId = `n${++this.netSeq}`;
                this.net.set(reqId, {
                    resolve: (res) => {
                        if (!res || !res.ok || !res.data) { resolve(''); return; }
                        try { resolve(new TextDecoder().decode(res.data)); } catch (_) { resolve(''); }
                    },
                    reject: () => resolve('')
                });
                this.port.send({ type: 'REQUEST', reqId, url, method: 'GET', headers: {}, kind: 'other' });
                this.later(20000, () => { if (this.net.has(reqId)) { this.net.delete(reqId); resolve(''); } });
            });
        }

        async loadCapturedTrack(i, announce = true) {
            const t = (this.subs.capturedTracks || [])[i];
            if (!t) return false;
            const text = t.vtt || (t.url ? await this.fetchText(t.url) : '');
            if (this.closed || this.subs.capturedTracks[i] !== t) return false;
            const cues = text ? parseSubtitleFile(text) : [];
            if (!cues.length) {
                if (announce) this.announce('Could not load that subtitle track', 'warn');
                return false;
            }
            this.subs.externalCues = cues;
            this.subs.externalName = this.capturedLabel(t, i);
            this.subs.capturedIndex = i;
            this.selectSubtitle('external', undefined, announce);
            if (announce) this.remember({ subsOn: true, subLang: t.language || '' });
            return true;
        }

        /** Pick the site's default (or the remembered language) when the stream has no own tracks. */
        async autoSelectCaptured() {
            const list = this.subs.capturedTracks || [];
            if (!list.length || this.subs.source !== 'off' || this.textTracks().length) return;
            const m = (this.settings && this.settings.memory) || {};
            let i = m.subLang ? list.findIndex(t => t.language === m.subLang) : -1;
            if (i < 0 && m.subsOn) i = 0;
            if (i < 0) i = list.findIndex(t => t.isDefault);
            if (i >= 0) await this.loadCapturedTrack(i, false);
        }

        // -----------------------------------------------------------------
        // Per-site profiles and external player hand-off
        // -----------------------------------------------------------------
        siteHost() {
            for (const u of [this.pageUrl, this.stream && this.stream.frameUrl]) {
                try { const h = new URL(u).hostname; if (h) return h.replace(/^www\./, ''); } catch (_) { /* opaque */ }
            }
            return '';
        }

        /** The site profile matching this page (most specific host wins), or null. */
        findProfile(settings) {
            const host = this.stream ? this.siteHost() : '';
            const list = ((settings && settings.siteProfiles) || []).filter(x => x && typeof x.host === 'string' && x.host);
            if (!host) return null;
            return list.filter(x => host === x.host || host.endsWith(`.${x.host}`))
                .sort((a, b) => b.host.length - a.host.length)[0] || null;
        }

        /**
         * this.settings = rawSettings, overlaid with the matching site profile (speed, quality
         * cap, shader, EQ preset, subtitle size), overlaid with this session's explicit edits of
         * those profile-controlled fields. The profile layer is never written back to storage.
         */
        recomputeSettings() {
            if (!this.rawSettings) return null;
            const out = cloneSettings(this.rawSettings);
            this.profile = this.findProfile(this.rawSettings);
            this.profileValues = profileFields(this.profile);
            overlaySettings(out, this.profileValues);
            // Overrides only matter for fields a profile still controls.
            overlaySettings(out, this.sessionOverrides, this.profileValues);
            this.settings = out;
            return out;
        }

        async exportBackup() {
            const S = window.VelostreamShared;
            if (!extApi || !S || !S.buildBackup) { this.announce('Backup is not available here', 'warn'); return; }
            try {
                this.flushSettings(); // unsent edits first, so the file has them
                const data = await S.buildBackup(extApi);
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                downloadBlob(this.shadow, blob, S.backupFilename(), true);
                this.announce('Settings backup saved', 'download');
            } catch (e) {
                this.announce(`Backup failed: ${(e && e.message) || e}`, 'warn');
            }
        }

        async importBackup(file) {
            const S = window.VelostreamShared;
            if (!extApi || !S || !S.restoreBackup) { this.announce('Restore is not available here', 'warn'); return; }
            if (file.size > 5 * 1024 * 1024) { this.announce('That file is too large to be a Velostream backup', 'warn'); return; }
            try {
                // Drop unsent edits: the backup replaces the settings they were made against.
                clearTimeout(this.saveTimer);
                this.saveTimer = null;
                this.pendingPatch = null;
                const res = await extApi.runtime.sendMessage({ action: 'BACKUP_RESTORE', json: await file.text() });
                if (!res?.ok) throw new Error(res?.error || 'Could not restore backup.');
                // storage.onChanged brings SETTINGS_CHANGED; bookmarks of this video reload here.
                await this.loadBookmarks();
                this.renderMarks();
                this.announce(`Settings & profiles restored · ${res.profiles} profiles, ${res.bookmarks} bookmarked videos`, 'check');
                this.refreshPopover();
            } catch (e) {
                this.announce(`Import failed: ${(e && e.message) || e}`, 'warn');
            }
        }

        saveSiteProfile() {
            const host = this.siteHost();
            if (!host) { this.announce('This page has no site address to attach a profile to', 'warn'); return; }
            const p = {
                host, defaultSpeed: this.rate(), qualityCap: this.qualityCap || 0,
                shader: this.settings.shader || 'off', shaderStrength: this.settings.shaderStrength,
                audioPreset: this.settings.audio.preset, subSize: this.settings.subtitles.size, savedAt: Date.now()
            };
            const list = (this.rawSettings.siteProfiles || []).filter(x => x.host !== host).concat([p]).slice(-200);
            // The profile now holds the session's values: they no longer need to be overrides.
            this.sessionOverrides = {};
            this.saveSettings({ siteProfiles: list });
            this.announce(`Saved profile for ${host}`, 'check');
            this.refreshPopover();
        }

        removeSiteProfile() {
            const host = this.profile ? this.profile.host : this.siteHost();
            this.sessionOverrides = {};
            this.saveSettings({ siteProfiles: (this.rawSettings.siteProfiles || []).filter(x => x.host !== host) });
            this.announce(`Removed profile for ${host}`, 'check');
            this.refreshPopover();
        }

        handoffInfo() {
            const url = this.stream.url;
            const referer = this.stream.frameUrl || this.pageUrl || '';
            let origin = '';
            try { origin = new URL(referer).origin; } catch (_) { /* none */ }
            const title = safeFilename(this.$('.title').textContent || 'video').replace(/\.(m3u8|mpd|mp4|ts)$/i, '');
            return { url, referer, origin, ua: navigator.userAgent, title };
        }

        externalUrl(app) {
            const { url, title } = this.handoffInfo();
            switch (app) {
                case 'potplayer': return `potplayer://${url}`;
                case 'vlc': return `vlc://${url}`;
                case 'mpv': return `mpv://${url}`;
                case 'iina': return `iina://weblink?url=${encodeURIComponent(url)}`;
                case 'android': return `intent:${url}#Intent;action=android.intent.action.VIEW;type=${this.stream.type === 'hls' ? 'application/x-mpegURL' : this.stream.type === 'dash' ? 'application/dash+xml' : 'video/*'};S.title=${encodeURIComponent(title)};end`;
                default: return url;
            }
        }

        openExternal(app) {
            if (this.drmInfo) this.announce('DRM-protected streams will not play in other apps either', 'warn');
            const a = document.createElement('a');
            a.href = this.externalUrl(app);
            a.rel = 'noopener';
            a.style.display = 'none';
            this.shadow.appendChild(a);
            a.click();
            a.remove();
            this.island('external', `Opening in ${EXTERNAL_APPS.find(x => x[0] === app)[1]}…`, null, 2500);
            this.announceOnly('If nothing happens, that app is not installed or has no link handler. Use Copy command instead.');
        }

        copyCommand(tool) {
            const { url, referer, origin, ua, title } = this.handoffInfo();
            const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
            let cmd;
            if (tool === 'ytdlp') {
                cmd = ['yt-dlp', referer && `--referer ${q(referer)}`, origin && `--add-header ${q(`Origin: ${origin}`)}`, `--user-agent ${q(ua)}`, `-o ${q(`${title}.%(ext)s`)}`, q(url)].filter(Boolean).join(' ');
            } else if (tool === 'ffmpeg') {
                cmd = ['ffmpeg', `-user_agent ${q(ua)}`, referer && `-referer ${q(referer)}`, origin && `-headers ${q(`Origin: ${origin}\r\n`)}`, `-i ${q(url)}`, '-c copy', `${q(`${title}.mp4`)}`].filter(Boolean).join(' ');
            } else {
                cmd = url;
            }
            this.copyText(cmd, tool === 'link' ? 'Stream link copied' : `${tool === 'ytdlp' ? 'yt-dlp' : 'ffmpeg'} command copied`);
        }

        titleFromUrl(url) {
            try {
                const u = new URL(url);
                return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
            } catch (_) {
                return 'Video';
            }
        }

        async load(startTime) {
            const v = this.video;
            const type = this.stream.type;
            const gen = ++this.loadGen;
            this.hideError();
            if (type === 'progressive') {
                this.mode = 'native';
                // Request the file with CORS so Web Audio, WebGL shaders, snapshots and smart skip
                // can read it (an untainted element). The engine answers media requests from the
                // extension with Access-Control-Allow-Origin; if the file still fails before its
                // metadata (no CORS, or the server needs cookies), the 'error' handler reloads it
                // once without crossorigin and remembers that for this session.
                this.audio.corsOk = false;
                this.nativeMetaOk = false;
                this.nativeStart = startTime || 0;
                if (this.localPlayback || this.corsUnavailable) v.removeAttribute('crossorigin');
                else v.crossOrigin = 'anonymous';
                v.src = this.stream.url;
                if (startTime && !this.localPlayback) v.currentTime = startTime;
            } else {
                this.mode = 'mse';
                if (!shaka || !shaka.Player.isBrowserSupported()) throw new Error('This browser does not support Media Source Extensions.');
                if (!this.player) {
                    this.registerScheme();
                    this.player = new shaka.Player();
                    await this.player.attach(v);
                    this.player.addEventListener('error', e => this.onShakaError(e.detail));
                    this.player.addEventListener('buffering', e => this.setBuffering(e.buffering));
                    this.player.addEventListener('trackschanged', () => this.onTracksChanged());
                    this.player.addEventListener('variantchanged', () => this.onTracksChanged(true));
                    this.player.addEventListener('adaptation', () => this.onTracksChanged(true));
                    this.player.addEventListener('textchanged', () => this.onTracksChanged());
                    // HLS EXT-X-DATERANGE attributes arrive as metadata frames (chapter titles).
                    this.player.addEventListener('metadata', e => this.onDateRangeMetadata(e));
                }
                this.configureShaka();
                const mime = type === 'hls' ? 'application/x-mpegurl' : type === 'dash' ? 'application/dash+xml' : null;
                try {
                    await this.player.load(this.stream.url, startTime ?? null, mime);
                } catch (err) {
                    if (this.closed || (err && (err.code === 7000 || err.code === 7001 || err.code === 7002))) return;
                    if (err && typeof err.code === 'number') { this.onShakaError({ code: err.code, data: err.data, severity: 2 }); return; }
                    throw err;
                }
                if (gen !== this.loadGen || this.closed) return; // superseded by a newer load()
                this.onTracksChanged();
            }
            v.playbackRate = this.settings.defaultSpeed || 1;
            this.restoreRememberedState();
            this.setupMediaSession();
            await this.startPlayback(gen);
        }

        /**
         * Autoplay: try with sound; if the browser's policy refuses (NotAllowedError), retry muted
         * without overwriting the remembered mute state, and unmute on the first tap or key press.
         * Only when muted playback also fails does the player wait paused for a press on Play.
         */
        async startPlayback(gen = this.loadGen) {
            const v = this.video;
            // A newer load() (retry, CORS fallback, fresh link) replaced the source: its own
            // startPlayback() decides; this one must not show "Press play" or mute anything.
            const stale = () => this.closed || gen !== this.loadGen;
            try {
                await v.play();
                return;
            } catch (e) {
                if (stale() || (e && e.name === 'AbortError')) return;
                if (!e || e.name !== 'NotAllowedError' || v.muted) { this.waitForPlay(); return; }
            }
            this.autoMuted = true;          // volumechange must not remember this mute
            v.muted = true;
            try {
                await v.play();
            } catch (_) {
                this.autoMuted = false;
                this.restoreRememberedState();
                if (!stale()) this.waitForPlay();
                return;
            }
            if (stale()) return;
            this.showMutedNotice();
            this.announceOnly('Autoplaying muted. Tap or press any key to unmute.');
            this.removeUnmuteListeners();
            const unmute = (e) => {
                this.removeUnmuteListeners();
                if (!this.autoMuted || this.closed) return;
                // The unmuting tap must not also pause playback, but it must still reach the
                // gesture layer (first swipe / pinch / double-tap work immediately): handleTap()
                // skips play/pause for this one tap instead of the event being swallowed here.
                if (e && e.type === 'pointerdown' && e.target && e.target.classList && e.target.classList.contains('gesture')) {
                    this.justUnmuted = true;
                    clearTimeout(this.justUnmutedTimer);
                    this.justUnmutedTimer = setTimeout(() => { this.justUnmuted = false; }, 1500);
                }
                const m = (this.settings && this.settings.memory) || {};
                v.muted = !!m.muted;
                if (!m.muted && !v.volume) v.volume = 1;
                // Let the resulting volumechange pass before memory tracking resumes.
                setTimeout(() => { this.autoMuted = false; }, 0);
                this.island(v.muted ? 'mute' : 'volume', v.muted ? 'Muted' : `Sound on · ${Math.round(v.volume * 100)}%`);
            };
            this.unmuteHandler = unmute;
            this.root.addEventListener('pointerdown', unmute, true);
            this.root.addEventListener('keydown', unmute, true);
        }

        removeUnmuteListeners() {
            const h = this.unmuteHandler;
            if (!h) return;
            this.unmuteHandler = null;
            this.root.removeEventListener('pointerdown', h, true);
            this.root.removeEventListener('keydown', h, true);
        }

        waitForPlay() {
            // Autoplay policy: the launch click may have happened outside this page.
            this.setStatus('paused');
            this.showControls(true);
            this.announce('Ready. Press play to start.', 'play');
            this.$('.btn-play').focus();
        }

        configureShaka() {
            const retry = { maxAttempts: 4, baseDelay: 500, backoffFactor: 2, fuzzFactor: 0.5, timeout: 75000, stallTimeout: 0, connectionTimeout: 0 };
            const dvr = this.settings.dvrMinutes || 0;
            this.player.configure({
                abr: { enabled: false },               // the background ABRController decides
                streaming: {
                    // Segments come from the local pre-buffer, so start/resume after 0.5 s of
                    // media instead of 2 s, and keep a modest MSE buffer (mobile memory limits).
                    bufferingGoal: this.settings.mseBufferAhead || 45,
                    rebufferingGoal: this.settings.rebufferingGoal || 0.5,
                    bufferBehind: this.settings.mseBufferBehind || 30,                  // continuous SourceBuffer.remove() of played media
                    retryParameters: retry,
                    segmentPrefetchLimit: 0,            // prefetching is done by the engine workers
                    ignoreTextStreamFailures: true
                },
                manifest: {
                    retryParameters: retry,
                    // Live DVR: the engine extends live playlists with cached history; let the
                    // seek range follow it (clamped to what is really retained, see liveRange()).
                    availabilityWindowOverride: dvr > 0 ? dvr * 60 : NaN
                },
                restrictions: { maxHeight: this.qualityCap || Infinity },
                // Shaka validates the factory's arity: it is called with the player instance.
                textDisplayFactory: (shakaPlayer) => this.subs.createDisplayer(shakaPlayer)
            });
        }

        registerScheme() {
            const NE = shaka.net.NetworkingEngine;
            const plugin = (uri, request, requestType, progressUpdated, headersReceived) => this.schemeRequest(uri, request, requestType, headersReceived);
            NE.registerScheme('http', plugin, NE.PluginPriority.APPLICATION, false);
            NE.registerScheme('https', plugin, NE.PluginPriority.APPLICATION, false);
        }

        /**
         * Read a cached segment straight from the extension's IndexedDB (same origin as the
         * background engine). Key: [tabId, sessionId, segmentKey] - see background/buffer-manager.js.
         */
        readCache(segmentKey) {
            if (!this.cacheDb) {
                this.cacheDb = new Promise((resolve, reject) => {
                    const req = indexedDB.open('VelostreamDB');
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
            }
            return this.cacheDb.then(db => new Promise((resolve, reject) => {
                if (!db.objectStoreNames.contains('data')) { resolve(null); return; }
                const req = db.transaction('data', 'readonly').objectStore('data').get([this.tabId, this.sessionId, segmentKey]);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            }));
        }

        /** HTTP status of a URL as seen through the engine (page cookies/Referer); 0 = network error. */
        probeStatus(url) {
            return new Promise(resolve => {
                const reqId = `n${++this.netSeq}`;
                this.net.set(reqId, { resolve: (res) => resolve((res && res.status) || 0), reject: () => resolve(0) });
                this.port.send({ type: 'REQUEST', reqId, url, method: 'GET', headers: { Range: 'bytes=0-1' }, kind: 'other' });
                this.later(15000, () => { if (this.net.has(reqId)) { this.net.delete(reqId); resolve(0); } });
            });
        }

        /** Newest same-path stream URL the page requested after ours (fresh token), or null. */
        findFreshUrl(url) {
            return new Promise(resolve => {
                const reqId = `n${++this.netSeq}`;
                this.net.set(reqId, { resolve: (m) => resolve((m && m.url) || null), reject: () => resolve(null) });
                this.port.send({ type: 'FIND_FRESH', reqId, url, since: this.stream.detectedAt || 0 });
                this.later(5000, () => { if (this.net.has(reqId)) { this.net.delete(reqId); resolve(null); } });
            });
        }

        schemeRequest(uri, request, requestType, headersReceived) {
            const RT = shaka.net.NetworkingEngine.RequestType;
            const E = shaka.util.Error;
            const kind = requestType === RT.SEGMENT ? 'segment'
                : (requestType === RT.MANIFEST || requestType === RT.PLAYLIST) ? 'manifest'
                    : requestType === RT.KEY ? 'key' : 'other';
            const reqId = `n${++this.netSeq}`;
            const started = performance.now();
            let entry = null;
            let cancelled = false;
            const abortError = () => new E(E.Severity.RECOVERABLE, E.Category.PLAYER, E.Code.OPERATION_ABORTED);
            const send = (zeroCopy) => new Promise((resolve, reject) => {
                entry = { resolve, reject };
                this.net.set(reqId, entry);
                this.port.send({ type: 'REQUEST', reqId, url: uri, method: request.method || 'GET', headers: { ...(request.headers || {}) }, kind, zeroCopy });
            });
            const promise = send(kind === 'segment' && this.cacheReady).then(async res => {
                if (res.ok && res.inCache) {
                    // Zero-copy: the engine stored the segment; read it from IndexedDB directly.
                    const rec = await this.readCache(res.cacheKey).catch(() => null);
                    if (cancelled) throw abortError();
                    if (rec && rec.data) {
                        res = { ...res, data: rec.data, headers: { ...(res.headers || {}), ...(rec.mime ? { 'content-type': rec.mime } : {}) } };
                    } else {
                        res = await send(false); // evicted in between: ask for the bytes inline
                    }
                }
                if (!res.ok) {
                    if (res.status >= 400) throw new E(E.Severity.RECOVERABLE, E.Category.NETWORK, E.Code.BAD_HTTP_STATUS, uri, res.status, res.error || '', res.headers || {}, requestType, uri);
                    throw new E(E.Severity.RECOVERABLE, E.Category.NETWORK, E.Code.HTTP_ERROR, uri, new Error(res.error || 'Network error'), requestType);
                }
                const headers = res.headers || {};
                if (headersReceived) { try { headersReceived(headers); } catch (_) { /* ignore */ } }
                return {
                    uri: res.url || uri, originalUri: uri, data: res.data || new ArrayBuffer(0), headers,
                    status: res.status, timeMs: performance.now() - started, fromCache: !!res.fromCache, originalRequest: request
                };
            });
            return new shaka.util.AbortableOperation(promise, () => {
                cancelled = true;
                if (this.net.has(reqId)) {
                    this.net.delete(reqId);
                    this.port.send({ type: 'ABORT', reqId });
                    entry.reject(abortError());
                }
                return Promise.resolve();
            });
        }

        destroy({ notify = true } = {}) {
            if (this.closed) return;
            const saved = this.saveHistory(true, true);
            this.closed = true;
            for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
            this.timers.clear();
            clearTimeout(this.hideTimer);
            clearTimeout(this.islandTimer);
            clearTimeout(this.saveTimer);
            clearTimeout(this.justUnmutedTimer);
            clearInterval(this.sleepFadeTimer);
            this.removeUnmuteListeners();
            // Flush debounced saves (remembered volume/quality/subtitles and speed). Everything
            // goes through stageSettings(), so only edited fields reach storage - never the
            // site profile's values.
            if (this.speedTimer && this.pendingSpeed) this.stageSettings({ defaultSpeed: this.pendingSpeed });
            clearTimeout(this.speedTimer);
            this.speedTimer = null;
            this.flushSettings();
            for (const d of this.disposers.splice(0)) { try { d(); } catch (_) { /* ignore */ } }
            for (const e of this.net.values()) { try { e.reject(new Error('closed')); } catch (_) { /* ignore */ } }
            this.net.clear();
            if (this.resizeObserver) this.resizeObserver.disconnect();
            this.destroyGpu();
            this.resetFileThumbs();
            this.clearThumbCache();
            this.stopSubsPip();
            const exportState = this.exportState;
            if (exportState?.running) {
                this.port.send({ type: 'EXPORT_CANCEL' });
                this.onExportMessage({ type: 'EXPORT_ERROR', error: 'Export paused.' });
            }
            try { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => { }); } catch (_) { /* ignore */ }
            try { if (document.fullscreenElement) document.exitFullscreen().catch(() => { }); } catch (_) { /* ignore */ }
            try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch (_) { /* ignore */ }
            this.audio.destroy();
            const v = this.video;
            const finish = async () => {
                await saved;
                if (notify) this.port.send({ type: 'CLOSE' });
                try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) { /* ignore */ }
                this.host.remove();
                // The content script removes this iframe and restores the site's own player.
                this.hostApi.layout({ cmd: 'close' });
                this.port.close();
            };
            if (this.player) {
                // shaka.destroy() revokes its MediaSource object URL and detaches SourceBuffers.
                this.player.destroy().catch(() => { }).finally(finish);
                this.player = null;
            } else {
                finish();
            }
            if ('mediaSession' in navigator) {
                for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto']) {
                    try { navigator.mediaSession.setActionHandler(a, null); } catch (_) { /* unsupported */ }
                }
            }
        }

        every(ms, fn) { const t = setInterval(fn, ms); this.timers.add(t); return t; }
        later(ms, fn) { const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms); this.timers.add(t); return t; }
        listen(target, type, fn, opts) {
            target.addEventListener(type, fn, opts);
            this.disposers.push(() => target.removeEventListener(type, fn, opts));
        }

        // -----------------------------------------------------------------
        // Engine / bridge messages
        // -----------------------------------------------------------------
        updatePageMeta(msg) {
            this.pageUrl = msg.pageUrl || '';
            this.pageMeta = msg.pageMeta || null;
            if (window.VelostreamShared.withoutResumeTime(this.playbackPageUrl) === window.VelostreamShared.withoutResumeTime(this.pageUrl) || !this.playbackPageUrl) {
                this.playbackPageUrl = this.pageUrl;
                this.playbackPageMeta = this.pageMeta;
            }
        }

        onMessage(msg) {
            if (this.closed) return;
            if (this.localPlayback && !['RESPONSE', 'SETTINGS_CHANGED', 'COMMAND'].includes(msg.type)) return;
            switch (msg.type) {
                case 'RESPONSE':
                case 'FRESH': {
                    const e = this.net.get(msg.reqId);
                    if (e) { this.net.delete(msg.reqId); e.resolve(msg); }
                    break;
                }
                case 'ENGINE_DISCONNECTED':
                    if (this.exportState?.running) this.onExportMessage({ type: 'EXPORT_ERROR', error: 'Export paused. Resume it from the library.' });
                    break;
                case 'INIT':
                    if (Array.isArray(msg.streams)) this.tabStreams = msg.streams;
                    if (this.resolveInit) { this.resolveInit(msg); this.resolveInit = null; }
                    else {
                        this.updatePageMeta(msg);
                        this.drmInfo = msg.drm || null;
                        if (msg.stream && this.stream?.id !== msg.stream.id) this.finishStreamSwitch(msg);
                        else if (this.setCaptured(msg.subtitles)) { this.loadChapters(); this.autoSelectCaptured(); }
                    }
                    break;
                case 'ROUTE_CHANGE':
                    this.updatePageMeta(msg);
                    this.drmInfo = null;
                    this.setCaptured([]);
                    if (this.subs.capturedIndex != null || this.subs.secondaryIndex != null) {
                        this.subs.clearExternal();
                        this.subs.render(this.video.currentTime);
                        this.updateCcButton();
                    }
                    this.refreshPopover();
                    break;
                case 'PAGE_META':
                    this.updatePageMeta(msg);
                    break;
                case 'DRM':
                    this.drmInfo = msg.drm || null;
                    break;
                case 'STREAMS': {
                    const before = (this.tabStreams || []).map(s => s.id).join();
                    this.tabStreams = Array.isArray(msg.streams) ? msg.streams : [];
                    if (this.popKind === 'studio' && before !== this.tabStreams.map(s => s.id).join()) this.refreshPopover();
                    break;
                }
                case 'STREAM_SWITCHED':
                    this.finishStreamSwitch(msg);
                    break;
                case 'SWITCH_FAILED':
                    this.switching = false;
                    this.hideIsland();
                    this.setStatus(this.video.paused ? 'paused' : 'playing');
                    this.announce(msg.error || 'Could not switch stream', 'warn');
                    break;
                case 'STATS':
                    this.engineStats = msg.stats;
                    break;
                case 'SUBTITLES':
                    if (this.setCaptured(msg.subtitles)) this.loadChapters();
                    this.refreshPopover();
                    this.autoSelectCaptured();
                    break;
                case 'ABR_SWITCH':
                    this.applyAbrSwitch(msg.variantId);
                    break;
                case 'SETTINGS_CHANGED':
                    if (!this.rawSettings) { this.bootSettings = msg.settings; break; }
                    if (this.rawSettings.shader !== msg.settings.shader) {
                        this.gpuOverride = this.gpuBlocked = null;
                        this.graphicsOriginal = false;
                        if (this.gpu?.failed) this.destroyGpu();
                    }
                    this.rawSettings = cloneSettings(msg.settings);
                    // Edits still waiting in the debounce are not in storage yet: keep them.
                    if (this.pendingPatch) overlaySettings(this.rawSettings, this.pendingPatch);
                    this.recomputeSettings();
                    this.applySettings();
                    this.refreshPopover();
                    break;
                case 'FATAL':
                    this.showError('Connection problem', msg.error);
                    break;
                case 'COMMAND':
                    if (msg.command === 'close') this.destroy();
                    else if (msg.command === 'export') this.onDownloadButton();
                    break;
                case 'RECORD_STARTED':
                    this.recordingSince = msg.startedAt || Date.now();
                    this.updateDownloadButton();
                    this.announce('Recording live stream', 'record');
                    this.refreshPopover();
                    break;
                default:
                    if (msg.type && msg.type.startsWith('EXPORT_')) this.onExportMessage(msg);
            }
        }

        // -----------------------------------------------------------------
        // DOM
        // -----------------------------------------------------------------
        $(sel) { return this.shadow.querySelector(sel); }
        $$(sel) { return Array.from(this.shadow.querySelectorAll(sel)); }

        buildDom() {
            const old = document.getElementById('velostream-host');
            if (old) old.remove();
            const host = document.createElement('div');
            host.id = 'velostream-host';
            this.host = host;
            this.applyHostRect();
            this.shadow = host.attachShadow({ mode: 'open' });
            const spinner = '<svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="3.5"/><path d="M22 4a18 18 0 0 1 18 18" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/></svg>';
            setHTML(this.shadow, `
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <filter id="fs-sharpen"><feConvolveMatrix id="fs-kernel" order="3" kernelMatrix="0 0 0 0 1 0 0 0 0" preserveAlpha="true"/></filter>
</svg>
<div class="root" role="dialog" aria-modal="true" aria-label="Velostream player" tabindex="-1" data-rm="system">
  <div class="stage">
    <canvas class="ambient-canvas" width="32" height="18" aria-hidden="true"></canvas>
    <div class="vbox"><video playsinline webkit-playsinline preload="auto" aria-label="Video"></video><canvas class="gl-canvas" hidden aria-hidden="true"></canvas></div>
    <div class="audio-poster" aria-hidden="true">${icon('headphones', 64)}<span>Audio-only mode</span><canvas class="audio-viz" width="280" height="80" hidden></canvas></div>
    <div class="subs" aria-hidden="true"></div>
    <div class="subs subs-top" aria-hidden="true"></div>
    <div class="gesture" aria-hidden="true"></div>
  </div>
  <div class="ripple left" aria-hidden="true"></div>
  <div class="ripple right" aria-hidden="true"></div>
  <div class="spinner" aria-hidden="true">${spinner}</div>
  <div class="sr-only" aria-live="polite" aria-atomic="true" id="fs-live"></div>
  <div class="island" aria-hidden="true"><span class="i-icon"></span><span class="i-text"></span><span class="i-bar"><i></i></span></div>
  <div class="stats glass elevated" role="group" aria-label="Stream statistics"><dl></dl></div>
  <aside class="transcript glass elevated" hidden aria-labelledby="tr-title">
    <div class="tr-head">
      <h2 id="tr-title">Transcript</h2>
      <span class="tr-count num" aria-live="polite"></span>
      <button type="button" class="ib tr-close" aria-label="Close transcript">${icon('close', 18)}</button>
    </div>
    <div class="tr-tools">
      <label class="sr-only" for="tr-search">Search transcript</label>
      <input type="search" id="tr-search" class="tr-search" placeholder="Search transcript…" autocomplete="off" spellcheck="false">
      <button type="button" class="pillbtn tr-follow" aria-pressed="true">Follow</button>
      <button type="button" class="ib tr-copy" aria-label="Copy transcript text">${icon('copy', 18)}</button>
      <button type="button" class="ib tr-export" aria-label="Save transcript as .srt">${icon('download', 18)}</button>
    </div>
    <ol class="tr-list" aria-label="Transcript lines"></ol>
    <p class="tr-empty hint" hidden></p>
  </aside>

  <div class="chrome">
    <header class="topgrid">
      <div class="pill-left glass">
        <button type="button" class="ib btn-close" aria-label="Close player">${icon('close', 18)}</button>
        <span class="vdiv" aria-hidden="true"></span>
        <div class="titles"><span class="title">Velostream</span><span class="domain"></span></div>
        <span class="chip abr num" aria-hidden="true" hidden></span>
        <span class="chip sleep-chip num" hidden>${icon('moon')}<span></span></span>
      </div>
      <span aria-hidden="true"></span>
      <div class="capsule-right glass" role="toolbar" aria-label="Player tools">
        <button type="button" class="ib btn-lock" data-look="lock" aria-label="Lock touch controls">${icon('lock')}</button>
        <button type="button" class="ib btn-info adv narrow-hide" data-look="info" aria-pressed="false" aria-label="Stream statistics">${icon('info')}</button>
        <button type="button" class="ib ring-host btn-dl adv" data-look="dl" aria-label="Download stream">${icon('download')}<svg class="ring" viewBox="0 0 44 44" aria-hidden="true" hidden><circle class="track" cx="22" cy="22" r="19"/><circle class="prog" cx="22" cy="22" r="19" stroke-dasharray="119.38" stroke-dashoffset="119.38"/></svg></button>
        <button type="button" class="ib btn-audio-only adv narrow-hide" data-look="audioOnly" aria-pressed="false" aria-label="Audio-only battery saver">${icon('headphones')}</button>
        <button type="button" class="ib btn-mini" data-look="mini" aria-label="Collapse to mini player">${icon('mini')}</button>
      </div>
    </header>

    <div class="card resume glass elevated" role="group" aria-label="Resume playback">
      <span class="resume-text num">Resume from 00:00?</span>
      <button type="button" class="pillbtn primary btn-resume">Resume</button>
      <button type="button" class="pillbtn btn-restart">Start over</button>
    </div>

    <section class="deck glass" aria-label="Playback controls">
      <button type="button" class="deck-grip" aria-label="Move controls (arrow keys or drag)" hidden><span aria-hidden="true"></span></button>
      <div class="row1">
        <span class="t-left num" aria-hidden="true">00:00</span>
        <div class="timeline" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="0 seconds of 0 seconds">
          <div class="track">
            <div class="layers-cache"></div>
            <div class="layers-mse"></div>
            <div class="loop-range" hidden></div>
            <div class="layer played"></div>
            <div class="marks"></div>
            <div class="thumb"></div>
          </div>
          <canvas class="scrub-heat" aria-hidden="true" hidden></canvas>
          <div class="tip glass elevated" aria-hidden="true"><div class="tip-thumb" hidden></div><span class="tip-chapter" hidden></span><span class="tip-text">00:00</span></div>
        </div>
        <button type="button" class="t-right num" aria-label="Show remaining time">00:00</button>
      </div>
      <div class="row2">
        <div class="zone-left">
          <div class="vol" data-look="volume">
            <button type="button" class="ib btn-mute" aria-label="Mute">${icon('volume')}</button>
            <input type="range" class="vol-slider" min="0" max="100" step="1" value="100" aria-label="Volume" aria-valuetext="100%">
          </div>
          <div class="pro-group" role="group" aria-label="Pro tools">
            <button type="button" class="ib pro btn-frame-back" data-look="frameBack" aria-label="Previous frame">${icon('frameBack')}</button>
            <button type="button" class="ib pro btn-frame-fwd" data-look="frameFwd" aria-label="Next frame">${icon('frameFwd')}</button>
            <button type="button" class="ib pro btn-ab" data-look="loop" aria-pressed="false" aria-label="A–B loop: set point A">${icon('loop')}</button>
            <button type="button" class="ib pro btn-snap" data-look="snapshot" aria-label="Save snapshot">${icon('camera')}</button>
            <button type="button" class="ib pro btn-eq narrow-hide" data-look="eq" aria-haspopup="dialog" aria-expanded="false" aria-label="Audio and equalizer">${icon('wave')}</button>
            <button type="button" class="ib pro btn-gpu narrow-hide" data-look="gpu" aria-haspopup="dialog" aria-expanded="false" aria-label="Picture, GPU enhancement and colour">${icon('bolt')}</button>
          </div>
          <button type="button" class="pillbtn skip-intro" hidden>${icon('skip')}<span class="num">+85s</span></button>
        </div>
        <div class="zone-center">
          <button type="button" class="ib btn-back" data-look="back" aria-label="Seek back 10 seconds">${skipIcon(-1, 10)}</button>
          <button type="button" class="ib btn-play" aria-label="Play">${icon('play')}</button>
          <button type="button" class="ib btn-fwd" data-look="fwd" aria-label="Seek forward 10 seconds">${skipIcon(1, 10)}</button>
        </div>
        <div class="zone-right">
          <button type="button" class="pillbtn speed-pill adv narrow-hide" data-look="speed" aria-haspopup="menu" aria-expanded="false" aria-label="Playback speed 1.0×"><span class="num">1.0×</span></button>
          <button type="button" class="ib btn-cc" data-look="cc" aria-haspopup="dialog" aria-expanded="false" aria-label="Subtitles and audio tracks">${icon('captions')}</button>
          <button type="button" class="ib btn-studio" data-look="studio" aria-haspopup="dialog" aria-expanded="false" aria-label="Studio settings">${icon('studio')}</button>
          <button type="button" class="ib btn-pip adv narrow-hide" data-look="pip" aria-label="Picture in Picture">${icon('pip')}</button>
          <button type="button" class="ib btn-fs" data-look="fs" aria-label="Enter full screen">${icon('fullscreen')}</button>
        </div>
      </div>
    </section>
  </div>

  <button type="button" class="pillbtn glass unlock-pill" aria-label="Unlock controls">${icon('unlock')}<span>Unlock</span></button>
  <div class="mini-bar glass">
    <button type="button" class="ib mini-play" aria-label="Play">${icon('play')}</button>
    <button type="button" class="ib mini-expand" aria-label="Expand player">${icon('expand')}</button>
    <button type="button" class="ib mini-close" aria-label="Close player">${icon('close')}</button>
  </div>
  <div class="mini-resize" aria-hidden="true"></div>
  <div class="popover glass elevated" aria-hidden="true"></div>
  <div class="card error glass elevated" role="alertdialog" aria-modal="true" aria-labelledby="fs-err-title" aria-describedby="fs-err-msg">
    <h2 id="fs-err-title">${icon('warn')}<span>Playback error</span></h2>
    <p id="fs-err-msg"></p>
    <div class="btns"><button type="button" class="pillbtn primary btn-retry">Retry</button><button type="button" class="pillbtn btn-err-close">Close player</button></div>
  </div>
</div>`);
            document.body.appendChild(host);
            this.root = this.$('.root');
            const stylesheet = document.querySelector('#player-stylesheet').cloneNode();
            stylesheet.removeAttribute('id');
            this.shadow.prepend(stylesheet);
            this.video = this.$('video');
            this.vbox = this.$('.vbox');
            this.glCanvas = this.$('.gl-canvas');
            this.stage = this.$('.stage');
            this.deck = this.$('.deck');
            this.pop = this.$('.popover');
            this.subs = new SubtitleEngine(this.$('.subs:not(.subs-top)'), this.$('.subs-top'));
            this.audio = new AudioFx(this.video);
            this.live = this.$('#fs-live');
            this.root.focus({ preventScroll: true });
            // Only full-page mode is a modal dialog; in place it is a region of the site.
            if (this.hostApi.mountMode !== 'page') {
                this.root.setAttribute('role', 'region');
                this.root.removeAttribute('aria-modal');
            }
        }

        /** The host fills this iframe; the content script sizes/positions the iframe itself. */
        applyHostRect() {
            this.host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; display: block;';
        }

        /** Page scroll-lock / inertness is handled by the content script around the iframe. */
        setPageModal() { }

        // -----------------------------------------------------------------
        // Settings
        // -----------------------------------------------------------------
        applyPitch(on) {
            const v = this.video;
            v.preservesPitch = on;
            if ('mozPreservesPitch' in v) v.mozPreservesPitch = on;
            if ('webkitPreservesPitch' in v) v.webkitPreservesPitch = on;
        }

        applySettings() {
            const s = this.settings;
            if (!s) return;
            const r = this.root;
            this.applyPitch(!s.audio || s.audio.preservesPitch !== false);
            // GPU shader / colour filters follow the saved settings from the first frame on.
            if (this.filters && this.video) this.applyFilters();
            const st0 = s.subtitles || {};
            r.classList.toggle('subs-interactive', !!(st0.pauseOnHover || st0.clickToCopy));
            const accent = ACCENTS[s.theme] || ACCENTS.blue;
            r.style.setProperty('--fs-accent', accent.fill);
            r.style.setProperty('--fs-accent-strong', accent.strong);
            r.dataset.hc = String(!!s.highContrast);
            r.dataset.rm = s.reducedMotion;
            r.dataset.simple = String(!!s.simpleMode);
            r.style.setProperty('--fs-scale', String(s.uiScale || 1));
            this.applyLook();
            this.$('.stats').classList.toggle('show', !!s.showStats);
            this.$('.btn-info').setAttribute('aria-pressed', String(!!s.showStats));
            setHTML(this.$('.btn-back'), skipIcon(-1, s.seekStep));
            setHTML(this.$('.btn-fwd'), skipIcon(1, s.seekStep));
            this.$('.btn-back').setAttribute('aria-label', `Seek back ${s.seekStep} seconds`);
            this.$('.btn-fwd').setAttribute('aria-label', `Seek forward ${s.seekStep} seconds`);
            this.root.classList.toggle('ambient', !!s.ambientMode);
            if (s.ambientMode) this.later(0, () => this.updateAmbient(true));
            const skip = this.$('.skip-intro');
            if (!skip.dataset.mode) { // a chapter skip ("Skip intro") owns the label while shown
                skip.querySelector('span').textContent = `+${s.skipSeconds}s`;
                skip.setAttribute('aria-label', `Skip intro, forward ${s.skipSeconds} seconds`);
            }
            this.applySubtitleStyle();
            if (this.audio.active) this.audio.apply(s.audio);
            if (s.autoHideMs === 0) this.showControls(true);
            this.later(0, () => this.layoutVideo());
        }

        /**
         * Player look: skin, density, scrubber, background darkness, hidden buttons and the order
         * of the right-hand buttons. Zones and buttons are moved in the DOM (not with CSS `order`)
         * so keyboard focus always follows what is on screen; nodes are only moved when the order
         * really changed, so a focused button keeps focus on unrelated setting changes.
         */
        applyLook() {
            const r = this.root;
            const lk = this.settings.look;
            r.dataset.skin = lk.skin;
            r.dataset.density = lk.density;
            r.dataset.scrub = lk.scrubber;
            r.style.setProperty('--scrub-h', `${lk.scrubHeight}px`);
            if (lk.scrim >= 0) {
                r.dataset.scrim = '';
                r.style.setProperty('--scrim-a', String(lk.scrim / 100));
            } else {
                delete r.dataset.scrim;
                r.style.removeProperty('--scrim-a');
            }
            r.style.setProperty('--pill-x', String(lk.pillX));
            r.style.setProperty('--pill-y', String(lk.pillY));
            const hidden = new Set(lk.hidden);
            for (const el of this.$$('[data-look]')) el.classList.toggle('look-off', hidden.has(el.dataset.look));
            this.$('.deck-grip').hidden = lk.skin !== 'pill';

            const zr = this.$('.zone-right');
            const order = [...new Set(lk.order.concat(LOOK_ORDERABLE))];
            const now = Array.from(zr.children).map(el => el.dataset.look).filter(Boolean);
            if (now.join() !== order.filter(id => now.includes(id)).join()) {
                for (const id of order) { const el = zr.querySelector(`[data-look="${id}"]`); if (el) zr.appendChild(el); }
            }
            // Docked skins put play / seek at the start of the row, like most video sites.
            const row2 = this.$('.row2');
            const zc = this.$('.zone-center');
            const zl = this.$('.zone-left');
            const centreFirst = ['cinema', 'theater', 'compact'].includes(lk.skin);
            if (centreFirst && row2.firstElementChild !== zc) row2.insertBefore(zc, zl);
            else if (!centreFirst && row2.firstElementChild === zc) row2.insertBefore(zl, zc);

            this.updateAbButton();
            if (this.video) { this.renderMarks(); this.tickHeat(true); }
        }

        /** The Pro A–B button cycles: set A, set B, clear. */
        cycleAbLoop() {
            if (this.loop.a == null) this.setLoopPoint('a');
            else if (this.loop.b == null) this.setLoopPoint('b');
            else this.clearLoop();
        }

        updateAbButton() {
            const b = this.$('.btn-ab');
            if (!b) return;
            const { a, b: pb } = this.loop;
            b.setAttribute('aria-pressed', String(a != null));
            b.setAttribute('aria-label', a == null ? 'A–B loop: set point A' : pb == null ? 'A–B loop: set point B' : 'A–B loop: clear loop');
        }

        /** Pro EQ / GPU buttons open Studio straight on their tab (a second click closes it). */
        openStudioTab(tab, btn) {
            if (this.popKind === 'studio' && this.popButton === btn && this.studioTab === tab) { this.closePopover(true); return; }
            this.studioTab = tab;
            this.openPopover('studio', btn);
        }

        /**
         * Floating-pill skin: drag the deck by its grip or any empty part of it, or move it with the
         * arrow keys on the grip (Shift = bigger steps, Home = back to the default spot). The centre
         * point is stored as a fraction of the player, so it survives resizes and full screen.
         */
        bindDeckDrag() {
            const deck = this.deck;
            const grip = this.$('.deck-grip');
            let drag = null;
            const usable = () => this.settings.look.skin === 'pill' && getComputedStyle(grip).display !== 'none';
            const place = (x, y, save) => {
                const rect = this.root.getBoundingClientRect();
                const hw = deck.offsetWidth / 2 / Math.max(1, rect.width);
                const hh = deck.offsetHeight / 2 / Math.max(1, rect.height);
                x = clamp(x, Math.min(0.5, hw), Math.max(0.5, 1 - hw));
                y = clamp(y, Math.min(0.5, hh), Math.max(0.5, 1 - hh));
                this.root.style.setProperty('--pill-x', String(x));
                this.root.style.setProperty('--pill-y', String(y));
                if (save) this.saveSettings({ look: { ...this.settings.look, pillX: Math.round(x * 1000) / 1000, pillY: Math.round(y * 1000) / 1000 } });
                return [x, y];
            };
            this.listen(deck, 'pointerdown', (e) => {
                if (!usable() || e.button > 0) return;
                if (!grip.contains(e.target) && e.target.closest('button, input, select, .timeline')) return;
                const d = deck.getBoundingClientRect();
                drag = { id: e.pointerId, dx: e.clientX - (d.left + d.width / 2), dy: e.clientY - (d.top + d.height / 2), x: 0, y: 0 };
                try { deck.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
                deck.classList.add('dragging');
                e.preventDefault();
                e.stopPropagation();
            });
            this.listen(deck, 'pointermove', (e) => {
                if (!drag || e.pointerId !== drag.id) return;
                const rect = this.root.getBoundingClientRect();
                [drag.x, drag.y] = place((e.clientX - drag.dx - rect.left) / rect.width, (e.clientY - drag.dy - rect.top) / rect.height, false);
                this.showControls();
            });
            const end = (e) => {
                if (!drag || e.pointerId !== drag.id) return;
                deck.classList.remove('dragging');
                if (drag.x || drag.y) place(drag.x, drag.y, true);
                drag = null;
            };
            this.listen(deck, 'pointerup', end);
            this.listen(deck, 'pointercancel', end);
            this.listen(grip, 'keydown', (e) => {
                if (!usable()) return;
                const lk = this.settings.look;
                const step = e.shiftKey ? 0.1 : 0.02;
                const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
                let xy = null;
                if (moves[e.key]) xy = [lk.pillX + moves[e.key][0], lk.pillY + moves[e.key][1]];
                else if (e.key === 'Home') xy = [0.5, 0.85];
                if (!xy) return;
                e.preventDefault();
                e.stopPropagation();
                const [x, y] = place(xy[0], xy[1], true);
                this.announceOnly(`Controls moved to ${Math.round(x * 100)}% across, ${Math.round(y * 100)}% down`);
            });
        }

        /**
         * Heatmap scrubber: a strip above the seek bar. Bar height is the loudness heard in that
         * slice of the video (measured while it plays, once the audio graph is running); colour
         * shows what is played (accent), buffered (dim accent) or not loaded yet (grey).
         */
        tickHeat(force) {
            const c = this.$('.scrub-heat');
            const on = this.settings.look.scrubber === 'heatmap' && !this.isLive() && !this.mini;
            c.hidden = !on;
            if (!on) return;
            const v = this.video;
            const r = this.seekRange();
            const span = r.end - r.start;
            if (!(span > 1)) return;
            const N = 120;
            if (!this.heat || this.heat.span !== Math.round(span)) this.heat = { span: Math.round(span), lv: new Float32Array(N) };
            const lv = this.heat.lv;
            if (!v.paused && this.audio.active) {
                const i = clamp(Math.floor((v.currentTime - r.start) / span * N), 0, N - 1);
                const level = Math.min(1, Math.sqrt(this.audio.rms()) * 1.6);
                lv[i] = lv[i] ? lv[i] * 0.6 + level * 0.4 : Math.max(level, 0.05);
            }
            if (!force && (this.tickCount || 0) % 2) return; // draw at 2 Hz
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const W = Math.round(c.clientWidth * dpr);
            const H = Math.round(18 * dpr);
            if (!W) return;
            if (c.width !== W) c.width = W;
            if (c.height !== H) c.height = H;
            const g = c.getContext('2d');
            g.clearRect(0, 0, W, H);
            const ranges = [];
            for (let i = 0; i < v.buffered.length; i++) ranges.push([v.buffered.start(i), v.buffered.end(i)]);
            if (this.engineStats && this.stream && this.stream.type === 'hls') for (const cr of this.engineStats.cachedRanges || []) ranges.push([cr.start, cr.end]);
            const accent = getComputedStyle(this.root).getPropertyValue('--fs-accent').trim() || '#0a84ff';
            const bw = W / N;
            const gap = Math.max(1, Math.round(dpr));
            for (let i = 0; i < N; i++) {
                const t = r.start + (i + 0.5) / N * span;
                const h = Math.max(0.14, lv[i]) * H;
                const played = t <= v.currentTime;
                const buffered = played || ranges.some(([s, e]) => t >= s && t <= e);
                g.fillStyle = buffered ? accent : 'rgba(255,255,255,0.28)';
                g.globalAlpha = played ? 0.95 : buffered ? 0.5 : 1;
                g.fillRect(Math.round(i * bw), H - h, Math.max(1, Math.round(bw) - gap), h);
            }
            g.globalAlpha = 1;
        }

        /** Apply a user edit now and persist it (debounced). */
        saveSettings(patch) {
            if (!this.rawSettings) return;
            this.stageSettings(patch);
            this.applySettings();
            this.scheduleSettingsFlush(250);
        }

        /**
         * Merge an edit into rawSettings / sessionOverrides and recompute this.settings.
         * Callers often pass a whole sub-object ({ audio: { ...this.settings.audio, boost } }) that
         * also carries the site profile's values, so only fields that really changed count:
         *   - a profile-controlled field counts when it differs from what the session showed
         *     (override if any, else the profile value). It then wins for this session only (session
         *     override) and is NOT written to the global settings: on a profiled site, speed,
         *     quality cap, GPU preset/strength, EQ preset and subtitle size are site-specific.
         *     "Update profile with current setup" stores them in the profile;
         *   - any other field counts when it differs from the stored value.
         * Changed fields are queued in pendingPatch (sub-objects as partial objects; the bridge
         * deep-merges them), so a profile's values never reach the global settings.
         */
        stageSettings(patch) {
            const raw = this.rawSettings;
            if (!raw || !patch) return false;
            const pv = this.profileValues || {};
            const ov = this.sessionOverrides;
            const pend = this.pendingPatch || {};
            let changed = false;
            const queue = (k, sk, val) => {
                if (sk == null) { pend[k] = cloneValue(val); raw[k] = cloneValue(val); } else {
                    pend[k] = { ...(isPlainObject(pend[k]) ? pend[k] : {}), [sk]: cloneValue(val) };
                    raw[k] = { ...(raw[k] || {}), [sk]: cloneValue(val) };
                }
                changed = true;
            };
            for (const [k, val] of Object.entries(patch)) {
                if (DEEP_SETTINGS.includes(k) && isPlainObject(val)) {
                    for (const [sk, sv] of Object.entries(val)) {
                        if (pv[k] && hasOwn(pv[k], sk)) {
                            const shown = ov[k] && hasOwn(ov[k], sk) ? ov[k][sk] : pv[k][sk];
                            if (sameValue(sv, shown)) continue;           // carried along, not edited
                            ov[k] = { ...(ov[k] || {}), [sk]: cloneValue(sv) };
                            changed = true;
                            continue;                                     // session-only
                        }
                        if (!sameValue(sv, (raw[k] || {})[sk])) queue(k, sk, sv);
                    }
                } else if (hasOwn(pv, k)) {
                    const shown = hasOwn(ov, k) ? ov[k] : pv[k];
                    if (sameValue(val, shown)) continue;
                    ov[k] = cloneValue(val);                              // session-only
                    changed = true;
                } else if (!sameValue(val, raw[k])) {
                    queue(k, null, val);
                }
            }
            if (changed) this.pendingPatch = pend;
            this.recomputeSettings();
            return changed;
        }

        scheduleSettingsFlush(ms) {
            clearTimeout(this.saveTimer);
            this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flushSettings(); }, ms);
        }

        flushSettings() {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
            const patch = this.pendingPatch;
            this.pendingPatch = null;
            if (patch && Object.keys(patch).length) this.port.send({ type: 'SETTINGS_SET', patch });
        }

        applySubtitleStyle() {
            const st = this.settings.subtitles;
            const font = (FONTS[st.font] || FONTS.system).css;
            const size = clamp(st.size, 50, 300);
            this.$('.subs:not(.subs-top)').style.bottom = `${clamp(st.position, 0, 80)}%`;
            const edge = st.edge === 'outline'
                ? '-1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000'
                : st.edge === 'shadow' ? '0 2px 6px rgba(0,0,0,.9), 0 0 2px #000' : 'none';
            const bg = `rgba(0,0,0,${clamp(st.bgOpacity, 0, 100) / 100})`;
            let sheet = this.shadow.getElementById('fs-sub-style');
            if (!sheet) {
                sheet = document.createElement('style');
                sheet.id = 'fs-sub-style';
                this.shadow.appendChild(sheet);
            }
            const rule = `font-family:${font};font-size:${(size / 100) * 1.45}em;color:${st.color};background:${bg};text-shadow:${edge};font-weight:600;line-height:1.3;letter-spacing:0;`;
            sheet.textContent = `.subs .cue-line, .sub-preview .cue-line { ${rule} } .subs { font-size: calc(clamp(12px, 3.4vmin, 22px) * var(--fs-scale)); }`;
        }

        // -----------------------------------------------------------------
        // UI wiring
        // -----------------------------------------------------------------
        bindUi() {
            const v = this.video;
            const on = (sel, ev, fn) => { const el = this.$(sel); if (el) this.listen(el, ev, fn); };

            on('.btn-close', 'click', () => this.destroy());
            on('.mini-close', 'click', () => this.destroy());
            on('.btn-err-close', 'click', () => this.destroy());
            on('.btn-retry', 'click', () => this.retry());
            on('.btn-play', 'click', () => this.togglePlay());
            on('.mini-play', 'click', () => this.togglePlay());
            on('.mini-expand', 'click', () => this.setMini(false));
            on('.btn-mini', 'click', () => this.setMini(true));
            on('.btn-back', 'click', (e) => { this.spin(e.currentTarget); this.seekBy(-this.settings.seekStep, true); });
            on('.btn-fwd', 'click', (e) => { this.spin(e.currentTarget); this.seekBy(this.settings.seekStep, true); });
            on('.btn-mute', 'click', () => this.toggleMute());
            on('.vol-slider', 'input', (e) => this.setVolume(+e.target.value / 100, false));
            on('.btn-fs', 'click', () => this.toggleFullscreen());
            on('.btn-pip', 'click', () => this.togglePip());
            on('.btn-lock', 'click', () => this.setLocked(true));
            on('.unlock-pill', 'click', () => this.setLocked(false));
            on('.btn-info', 'click', () => this.saveSettings({ showStats: !this.settings.showStats }));
            on('.btn-dl', 'click', () => this.onDownloadButton());
            on('.btn-audio-only', 'click', () => this.setAudioOnly(!this.audioOnly));
            on('.speed-pill', 'click', (e) => this.togglePopover('speed', e.currentTarget));
            on('.btn-cc', 'click', (e) => this.togglePopover('captions', e.currentTarget));
            on('.btn-studio', 'click', (e) => this.togglePopover('studio', e.currentTarget));
            on('.btn-frame-back', 'click', () => this.stepFrame(-1));
            on('.btn-frame-fwd', 'click', () => this.stepFrame(1));
            on('.btn-ab', 'click', () => this.cycleAbLoop());
            on('.btn-snap', 'click', (e) => this.screenshot(e.shiftKey));
            on('.btn-eq', 'click', (e) => this.openStudioTab('audio', e.currentTarget));
            on('.btn-gpu', 'click', (e) => this.openStudioTab('display', e.currentTarget));
            this.bindDeckDrag();
            on('.skip-intro', 'click', () => {
                const target = this.smartSkip;
                if (target && this.smartSkipChapter(this.video.currentTime)) {
                    this.seekTo(target.end + 0.05, false);
                    this.island('skip', `Skipped ${target.kind.toLowerCase()}`);
                    this.announceOnly(`Skipped ${target.kind.toLowerCase()}`);
                    this.updateSkipIntro();
                    return;
                }
                const s = this.settings.skipSeconds;
                this.seekBy(s, false);
                this.island('skip', `Skipped +${s}s`);
                this.announceOnly(`Skipped ${s} seconds`);
            });
            on('.t-right', 'click', () => {
                if (this.isLive()) { this.goLive(); return; }
                this.showRemaining = !this.showRemaining;
                this.$('.t-right').setAttribute('aria-label', this.showRemaining ? 'Show total duration' : 'Show remaining time');
                this.renderTimeline();
            });
            on('.btn-resume', 'click', () => this.acceptResume());
            on('.btn-restart', 'click', () => this.dismissResume(true));

            const media = (ev, fn) => this.listen(v, ev, fn);
            media('play', () => {
                this.updatePlayButtons();
                if (this.audio.active) this.audio.ensure();
                if (this.sleepPausedPrefetch && !this.localPlayback) { this.sleepPausedPrefetch = false; this.port.send({ type: 'PREFETCH', enabled: true }); }
            });
            media('playing', () => { if (this.gpu && this.gpu.active && !this.audioOnly) this.gpu.start(); });
            media('pause', () => { if (this.gpu) { this.gpu.stop(); this.gpu.renderOnce(); } });
            media('playing', () => { this.setBuffering(false); this.setStatus('playing'); this.scheduleHide(); });
            media('pause', () => { this.updatePlayButtons(); if (!v.ended) this.setStatus('paused'); this.showControls(true); this.saveHistory(true); });
            media('waiting', () => this.setBuffering(true));
            media('canplay', () => this.setBuffering(false));
            media('ended', () => {
                this.setStatus('ended');
                this.showControls(true);
                this.updatePlayButtons();
                this.saveHistory(true);
                if (this.sleep && this.sleep.mode === 'eov') this.finishSleep();
            });
            media('ratechange', () => this.updateSpeedUi());
            media('volumechange', () => {
                this.updateVolumeUi();
                // Remember volume/mute, but not the sleep timer's fade-out or a restore in progress.
                if (!this.restoring && !this.autoMuted && !(this.sleep && this.sleep.fading)) this.remember({ volume: v.volume, muted: v.muted });
            });
            media('loadedmetadata', () => {
                if (this.mode === 'native') {
                    if (this.localPlayback && this.nativeStart) {
                        v.currentTime = Math.min(this.nativeStart, v.duration);
                        this.nativeStart = 0;
                    }
                    this.nativeMetaOk = true;
                    // Metadata arrived through a CORS request: the element is untainted.
                    this.audio.corsOk = v.getAttribute('crossorigin') !== null;
                    // The Audio tab's "blocked by CORS" hint / disabled controls depend on it.
                    if (this.popKind === 'studio' && this.studioTab === 'audio') this.refreshPopover();
                }
                if (this.settings?.shader === 'auto') this.applyFilters();
                this.layoutVideo(); this.updateQualityBadge(); this.renderMarks();
            });
            media('durationchange', () => this.renderMarks());
            media('resize', () => { this.layoutVideo(); this.updateQualityBadge(); });
            media('seeked', () => { this.subs.render(v.currentTime); if (this.gpu) this.gpu.renderOnce(); this.updateAmbient(true); this.saveHistory(true); });
            media('loadeddata', () => { if (this.gpu) this.gpu.renderOnce(); });
            this.listen(document, 'visibilitychange', () => { if (!document.hidden && this.gpu && this.gpu.active && !v.paused && !this.audioOnly) this.gpu.start(); });
            media('enterpictureinpicture', () => this.$('.btn-pip').setAttribute('aria-pressed', 'true'));
            media('leavepictureinpicture', () => this.$('.btn-pip').setAttribute('aria-pressed', 'false'));
            media('error', () => {
                if (this.mode !== 'native' || !v.error || this.closed) return;
                if (this.localPlayback) {
                    this.showError('Cannot play this file', 'This browser could not read the file or its codec.');
                    return;
                }
                // The CORS request failed before any metadata (no Access-Control-Allow-Origin,
                // or the server needs the cookies an anonymous CORS request does not send):
                // reload once without crossorigin from the same position. Web Audio / WebGL
                // / snapshots stay unavailable for this session (allowed() is false).
                if (!this.nativeMetaOk && !this.corsUnavailable && v.getAttribute('crossorigin') !== null) {
                    this.corsUnavailable = true;
                    console.warn('[Velostream] Direct file failed with CORS; reloading without it');
                    this.load(this.nativeStart || undefined).catch(err => this.showError('Could not load this file', String((err && err.message) || err)));
                    return;
                }
                // <video> only reports "format error"; ask the engine what the server really said.
                this.probeStatus(this.stream.url).then(status => {
                    if (status === 401 || status === 403) {
                        this.showError('Access denied', `The server refused the file (HTTP ${status}). The link may have expired. Reload the page, start the video there briefly, then open Velostream again.`);
                    } else if (status >= 400) {
                        this.showError('Cannot load this file', `The server returned HTTP ${status}.`);
                    } else if (!status) {
                        this.showError('Cannot load this file', 'The file could not be downloaded. Check your connection and retry.');
                    } else {
                        this.showError('Unsupported format', `This browser cannot decode this file (media error ${v.error.code}).`);
                    }
                });
            });

            this.listen(document, 'fullscreenchange', () => this.onFullscreenChange());
            if (!document.pictureInPictureEnabled) this.$('.btn-pip').hidden = true;

            this.bindTimeline();
            this.bindTranscript();
            this.bindGestures();
            this.bindSubtitleInteraction();
            this.bindKeyboard();
            this.bindMiniResize();

            this.listen(this.root, 'pointermove', (e) => { if (e.pointerType === 'mouse' && !this.locked && !this.mini) this.showControls(); });
            this.listen(this.root, 'focusin', () => { if (!this.locked && !this.mini) this.showControls(true); });
            // Tapping outside an open popover closes it.
            this.listen(this.root, 'pointerdown', (e) => {
                if (!this.popKind) return;
                const path = e.composedPath();
                if (path.includes(this.pop) || (this.popButton && path.includes(this.popButton))) return;
                this.closePopover(false);
            });

            // Web Audio must be created/resumed inside a user-activation event (pointerup/keydown),
            // otherwise the AudioContext starts suspended and the rerouted audio goes silent.
            const activation = () => {
                if (!this.settings || this.closed) return;
                if (this.audio.allowed() && this.audio.ensure()) this.audio.apply(this.settings.audio);
                // Only on an input the browser counts as a gesture (not Shift/Ctrl, not a drag that
                // started outside the player); otherwise wait for the next one.
                if (this.settings.autoFullscreen && !this.autoFsDone && !this.mini && hasActivation()) {
                    this.autoFsDone = true;
                    if (!document.fullscreenElement) this.toggleFullscreen();
                }
            };
            this.listen(this.root, 'pointerup', activation);
            this.listen(this.root, 'keydown', activation);

            this.resizeObserver = new ResizeObserver(() => {
                this.layoutVideo();
                if (this.popKind) this.positionPopover();
            });
            this.resizeObserver.observe(this.stage);
            this.resizeObserver.observe(this.deck);

            this.every(250, () => this.onTick());
            this.every(1000, () => this.onSecond());
        }

        spin(btn) {
            btn.classList.add('spin');
            this.later(260, () => btn.classList.remove('spin'));
        }

        // -----------------------------------------------------------------
        // Dynamic Island, announcements, status, controls visibility
        // -----------------------------------------------------------------
        /** Morph the island open with an icon, text and optional level bar, then collapse. */
        island(iconName, text, ratio = null, holdMs = 1200) {
            const el = this.$('.island');
            setHTML(this.$('.i-icon'), iconName ? icon(iconName, 18) : '');
            this.$('.i-text').textContent = text;
            const bar = this.$('.i-bar');
            bar.style.display = ratio == null ? 'none' : '';
            if (ratio != null) bar.firstElementChild.style.width = `${clamp(ratio, 0, 1) * 100}%`;
            el.classList.remove('pulse');
            el.classList.add('show');
            clearTimeout(this.islandTimer);
            if (holdMs > 0) {
                this.islandTimer = setTimeout(() => {
                    if (this.statusPersistent) this.showPersistentStatus();
                    else if (this.autoMuted) this.showMutedNotice();
                    else el.classList.remove('show');
                }, holdMs);
            }
        }

        hideIsland() {
            clearTimeout(this.islandTimer);
            if (this.statusPersistent) this.showPersistentStatus();
            else if (this.autoMuted) this.showMutedNotice();
            else this.$('.island').classList.remove('show', 'pulse');
        }

        /** Stays up (after other notices) until the first tap or key press unmutes. */
        showMutedNotice() {
            this.island('mute', 'Autoplaying muted · Tap or press any key to unmute', null, 0);
        }

        showPersistentStatus() {
            const st = this.statusPersistent;
            if (!st) return;
            this.island(st === 'error' ? 'warn' : 'wave', st === 'error' ? 'Playback error' : 'Buffering', null, 0);
            if (st === 'buffering') this.$('.island').classList.add('pulse');
        }

        announceOnly(text) {
            const el = this.live;
            el.textContent = '';
            this.later(60, () => { el.textContent = text; });
        }

        announce(text, iconName = 'info') {
            this.announceOnly(text);
            this.island(iconName, text);
        }

        setStatus(state) {
            if (this.status === state) return;
            this.status = state;
            const persistent = state === 'error' ? 'error' : (state === 'buffering' || state === 'loading') ? 'buffering' : null;
            this.statusPersistent = persistent;
            if (persistent) {
                this.showPersistentStatus();
                if (state !== 'loading') this.announceOnly(state === 'error' ? 'Playback error' : 'Buffering');
            } else {
                this.hideIsland();
                if (state === 'ended') this.announceOnly('Ended');
            }
        }

        setBuffering(on) {
            this.root.classList.toggle('buffering', !!on);
            if (on) this.setStatus('buffering');
            else this.setStatus(this.video.ended ? 'ended' : this.video.paused ? 'paused' : 'playing');
        }

        showControls(sticky) {
            this.root.classList.remove('controls-hidden');
            if (!sticky) this.scheduleHide(); else clearTimeout(this.hideTimer);
        }

        scheduleHide() {
            clearTimeout(this.hideTimer);
            const ms = this.settings ? this.settings.autoHideMs : 3000;
            if (!ms) return;
            this.hideTimer = setTimeout(() => {
                const busy = this.video.paused || this.popKind || this.deck.matches(':hover') || this.$('.timeline').classList.contains('dragging') || this.$('.resume').classList.contains('show');
                const a = this.shadow.activeElement;
                const kbFocus = a && this.$('.chrome').contains(a) && a.matches(':focus-visible');
                if (!busy && !kbFocus) this.root.classList.add('controls-hidden');
            }, ms);
        }

        toggleControls() {
            if (this.root.classList.contains('controls-hidden')) this.showControls();
            else { clearTimeout(this.hideTimer); if (!this.video.paused) this.root.classList.add('controls-hidden'); }
        }

        // -----------------------------------------------------------------
        // Playback
        // -----------------------------------------------------------------
        togglePlay() {
            if (this.pausedByHover) {
                this.pausedByHover = false;
                return;
            }
            const v = this.video;
            if (v.paused || v.ended) {
                const p = v.play();
                if (p && p.catch) p.catch(err => this.announce(`Cannot start playback: ${err.message}`, 'warn'));
            } else {
                v.pause();
            }
            this.later(30, () => this.announceOnly(v.paused ? 'Paused' : 'Playing'));
        }

        updatePlayButtons() {
            const paused = this.video.paused;
            for (const b of this.$$('.btn-play, .mini-play')) {
                setHTML(b, icon(paused ? 'play' : 'pause'));
                b.setAttribute('aria-label', paused ? 'Play' : 'Pause');
            }
        }

        seekRange() {
            const v = this.video;
            if (this.player && this.mode === 'mse') {
                try {
                    const r = this.player.seekRange();
                    if (Number.isFinite(r.end) && r.end > r.start) return this.isLive() ? this.liveRange(r) : r;
                } catch (_) { /* not loaded */ }
            }
            return { start: 0, end: Number.isFinite(v.duration) ? v.duration : 0 };
        }

        /** Live DVR: never let the seekable window exceed what the engine really retained. */
        liveRange(r) {
            const avail = this.engineStats && this.engineStats.dvrSeconds;
            if (avail && avail > 0) return { start: Math.max(r.start, r.end - avail), end: r.end };
            return r;
        }

        isLive() {
            try { return !!(this.player && this.player.isLive()); } catch (_) { return false; }
        }

        goLive() {
            this.seekTo(this.seekRange().end, false);
            this.island('wave', 'Live');
            this.announceOnly('Jumped to live');
        }

        seekTo(t, announce) {
            const r = this.seekRange();
            const target = clamp(t, r.start, Math.max(r.start, r.end - 0.25));
            this.video.currentTime = target;
            this.port.send({ type: 'SEEK', time: target });
            if (announce) this.announceOnly(`${fmtSpoken(target - r.start)} of ${fmtSpoken(r.end - r.start)}`);
        }

        seekBy(delta, announce) {
            const from = this.video.currentTime;
            this.seekTo(from + delta, false);
            if (announce) {
                const r = this.seekRange();
                this.island(delta < 0 ? 'frameBack' : 'frameFwd', `${delta < 0 ? '−' : '+'}${Math.abs(delta)}s → ${fmtTime(clamp(from + delta, r.start, r.end) - r.start)}`);
                this.announceOnly(`${delta < 0 ? 'Back' : 'Forward'} ${Math.abs(delta)} seconds`);
            }
        }

        setRate(rate, announce = true) {
            const r = Math.round(clamp(rate, 0.25, 4) * 100) / 100;
            this.video.playbackRate = r;
            if (announce) this.announce(`Speed ${fmtRate(r)}`, 'speed');
            // The chosen speed becomes the starting speed of the next video.
            if (this.settings && this.settings.defaultSpeed !== r) {
                this.pendingSpeed = r;
                clearTimeout(this.speedTimer);
                this.speedTimer = setTimeout(() => { this.speedTimer = null; this.saveSettings({ defaultSpeed: r }); }, 400);
            }
        }

        /** User-facing rate. Shaka parks video.playbackRate at 0 while buffering; ignore that. */
        rate() {
            if (this.player) {
                try { const r = this.player.getPlaybackRate(); if (r > 0) return r; } catch (_) { /* not loaded */ }
            }
            return this.video.playbackRate || this.lastRate || 1;
        }

        updateSpeedUi() {
            const r = this.rate();
            if (!(r > 0)) return;
            this.lastRate = r;
            const label = fmtRate(r);
            this.$('.speed-pill span').textContent = label;
            this.$('.speed-pill').setAttribute('aria-label', `Playback speed ${label}`);
            if (this.popKind === 'speed') this.refreshPopover();
        }

        setVolume(vol, announce = true) {
            const v = this.video;
            v.volume = clamp(vol, 0, 1);
            if (v.volume > 0) v.muted = false;
            if (announce) {
                this.island(v.volume ? 'volume' : 'mute', `${Math.round(v.volume * 100)}%`, v.volume);
                this.announceOnly(`Volume ${Math.round(v.volume * 100)}%`);
            }
        }

        toggleMute() {
            this.video.muted = !this.video.muted;
            this.announce(this.video.muted ? 'Muted' : 'Unmuted', this.video.muted ? 'mute' : 'volume');
        }

        updateVolumeUi() {
            const v = this.video;
            const pct = Math.round((v.muted ? 0 : v.volume) * 100);
            const s = this.$('.vol-slider');
            s.value = pct;
            s.style.setProperty('--p', `${pct}%`);
            s.setAttribute('aria-valuetext', `${pct}%${v.muted ? ', muted' : ''}`);
            const b = this.$('.btn-mute');
            setHTML(b, icon(v.muted || v.volume === 0 ? 'mute' : v.volume < 0.5 ? 'volumeLow' : 'volume'));
            b.setAttribute('aria-label', v.muted ? 'Unmute' : 'Mute');
        }

        stepFrame(dir, announce = true) {
            const v = this.video;
            if (!v.paused) v.pause();
            this.seekTo(v.currentTime + dir / (this.currentFps() || 30), false);
            if (announce) this.announce(dir > 0 ? 'Next frame' : 'Previous frame', dir > 0 ? 'frameFwd' : 'frameBack');
        }

        currentFps() {
            if (!this.player) return 0;
            try {
                const t = this.player.getVariantTracks().find(x => x.active);
                return (t && t.frameRate) || 0;
            } catch (_) { return 0; }
        }

        async toggleFullscreen() {
            if (this.mini) this.setMini(false);
            if (this.viewportFill) {
                this.viewportFill = false;
                this.hostApi.layout({ cmd: 'unfill' });
                this.onFullscreenChange();
                return;
            }
            // requestFullscreen() needs a live user gesture; without one it fails (and Chrome logs
            // "API can only be initiated by a user gesture"). That is not a reason to fill the window.
            if (!document.fullscreenElement && !hasActivation()) {
                this.announce('Press F or the full-screen button', 'fullscreen');
                return;
            }
            try {
                if (document.fullscreenElement) {
                    await document.exitFullscreen();
                } else {
                    // Fullscreens this player iframe (it is mounted with allow="fullscreen").
                    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
                    const v = this.video;
                    if (screen.orientation && screen.orientation.lock && v.videoWidth > v.videoHeight && matchMedia('(pointer: coarse)').matches) {
                        screen.orientation.lock('landscape').catch(() => { });
                    }
                }
            } catch (e) {
                // The site's own embed iframe forbids fullscreen: fill the browser viewport instead.
                this.viewportFill = true;
                this.hostApi.layout({ cmd: 'fill' });
                this.onFullscreenChange();
            }
        }

        onFullscreenChange() {
            const fs = !!document.fullscreenElement || !!this.viewportFill;
            const b = this.$('.btn-fs');
            setHTML(b, icon(fs ? 'exitFullscreen' : 'fullscreen'));
            b.setAttribute('aria-label', fs ? 'Exit full screen' : 'Enter full screen');
            if (!fs) { try { screen.orientation.unlock(); } catch (_) { /* ignore */ } }
        }

        async togglePip() {
            try {
                if (document.pictureInPictureElement) await document.exitPictureInPicture();
                else if (this.wantsSubsPip()) await this.startSubsPip();
                else await this.video.requestPictureInPicture();
            } catch (e) {
                this.stopSubsPip();
                this.announce(`Picture in Picture unavailable: ${e.message}`, 'warn');
            }
        }

        /** Subtitles in PiP need a showing subtitle track and a frame the page may read. */
        wantsSubsPip() {
            if (this.settings.pipSubtitles === false || this.audioOnly || !HTMLCanvasElement.prototype.captureStream) return false;
            const s = this.subs;
            if (!((s.source !== 'off' && s.activeCues() && s.activeCues().length) || (s.secondaryCues && s.secondaryCues.length))) return false;
            const v = this.video;
            if (!v.videoWidth) return false;
            try {
                const c = document.createElement('canvas');
                c.width = c.height = 1;
                const x = c.getContext('2d');
                x.drawImage(v, 0, 0, 1, 1);
                x.getImageData(0, 0, 1, 1); // throws for a cross-origin file without CORS
                return true;
            } catch (_) {
                return false;
            }
        }

        /**
         * Picture-in-Picture with subtitles: browsers do not draw the page's subtitle layer in the
         * PiP window, so the frame and the current lines are drawn into a canvas whose stream plays
         * in a hidden proxy <video>, and that proxy goes into PiP. A worker clocks the drawing so
         * it keeps going while the tab is in the background. Sound stays on the real video;
         * the PiP play/pause buttons reach it through the Media Session handlers (and, where a
         * browser toggles the proxy itself, through its play/pause events).
         */
        async startSubsPip() {
            const v = this.video;
            const W = Math.min(1280, v.videoWidth);
            const H = Math.max(2, Math.round(W * v.videoHeight / v.videoWidth / 2) * 2);
            const c = document.createElement('canvas');
            c.width = W;
            c.height = H;
            const ctx = c.getContext('2d');
            const draw = () => {
                try {
                    ctx.drawImage(v, 0, 0, W, H);
                    this.drawSubtitlesOnto(ctx, W, H, { pip: true });
                } catch (_) { /* frame not ready */ }
            };
            draw();
            const stream = c.captureStream(30);
            const pv = document.createElement('video');
            pv.className = 'pip-proxy';
            pv.muted = true;
            pv.playsInline = true;
            pv.setAttribute('aria-hidden', 'true');
            pv.srcObject = stream;
            this.root.appendChild(pv);
            const sp = { pv, stream, c, ticker: null, offs: [] };
            this.subsPip = sp;
            await pv.play();
            await pv.requestPictureInPicture();
            if (this.subsPip !== sp) return;
            try {
                sp.ticker = new Worker('pip-ticker.js');
                sp.ticker.onmessage = () => { if (this.subsPip === sp) draw(); };
                sp.ticker.postMessage({ fps: 30 });
            } catch (_) {
                // No worker: fall back to page timers (slower while the tab is hidden).
                const id = setInterval(() => { if (this.subsPip === sp) draw(); }, 33);
                sp.offs.push(() => clearInterval(id));
            }
            const on = (target, type, fn) => { target.addEventListener(type, fn); sp.offs.push(() => target.removeEventListener(type, fn)); };
            on(pv, 'leavepictureinpicture', () => this.stopSubsPip());
            on(pv, 'pause', () => { if (this.subsPip === sp && !v.paused) v.pause(); });
            on(pv, 'play', () => { if (this.subsPip === sp && v.paused) v.play().catch(() => { }); });
            on(v, 'play', () => { if (pv.paused) pv.play().catch(() => { }); this.setPipPlaybackState('playing'); });
            on(v, 'pause', () => { this.setPipPlaybackState('paused'); });
            this.setPipPlaybackState(v.paused ? 'paused' : 'playing');
            this.$('.btn-pip').setAttribute('aria-pressed', 'true');
            this.announce('Picture in Picture with subtitles', 'pip');
        }

        setPipPlaybackState(state) {
            try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state; } catch (_) { /* unsupported */ }
        }

        stopSubsPip() {
            const sp = this.subsPip;
            if (!sp) return;
            this.subsPip = null;
            for (const off of sp.offs) { try { off(); } catch (_) { /* ignore */ } }
            if (sp.ticker) { try { sp.ticker.terminate(); } catch (_) { /* ignore */ } }
            try { if (document.pictureInPictureElement === sp.pv) document.exitPictureInPicture().catch(() => { }); } catch (_) { /* ignore */ }
            for (const t of sp.stream.getTracks()) t.stop();
            sp.pv.srcObject = null;
            sp.pv.remove();
            const btn = this.$('.btn-pip');
            if (btn) btn.setAttribute('aria-pressed', 'false');
        }

        setLocked(on) {
            this.locked = on;
            this.root.classList.toggle('locked', on);
            this.closePopover(false);
            const pill = this.$('.unlock-pill');
            if (on) {
                this.announce('Touch controls locked', 'lock');
                pill.classList.add('show');
                this.later(2500, () => pill.classList.remove('show'));
                pill.focus({ preventScroll: true });
            } else {
                pill.classList.remove('show');
                this.announce('Controls unlocked', 'unlock');
                this.showControls();
                this.$('.btn-lock').focus({ preventScroll: true });
            }
        }

        setAudioOnly(on) {
            this.audioOnly = on;
            this.root.classList.toggle('audio-only', on);
            if (this.gpu) { if (on) this.gpu.stop(); else if (this.gpu.active && !this.video.paused) this.gpu.start(); }
            this.$('.btn-audio-only').setAttribute('aria-pressed', String(on));
            if (this.player && this.mode === 'mse') {
                // Switching to / from an audio-only rendition makes Shaka rebuild its media
                // pipeline, which can leave the element paused: resume if it was playing.
                const v = this.video;
                if (!v.paused) {
                    const gen = (this.audioOnlyGen = (this.audioOnlyGen || 0) + 1);
                    const resume = () => { if (gen === this.audioOnlyGen && !this.closed && v.paused && !v.ended) v.play().catch(() => { }); };
                    v.addEventListener('canplay', resume, { once: true });
                    this.later(600, resume);
                }
                if (on) {
                    this.prevAbr = { auto: this.abrAuto, id: this.lockedVariantId };
                    const tracks = this.currentVariants();
                    const audioOnlyTrack = tracks.find(t => !t.videoCodec && !t.height);
                    const lowest = audioOnlyTrack || tracks.slice().sort((a, b) => a.bandwidth - b.bandwidth)[0];
                    // No buffer flush: audio-only saves data from the next segment on, without a stall.
                    if (lowest) this.selectQuality(lowest.id, false, false);
                } else if (this.prevAbr) {
                    if (this.prevAbr.auto) this.selectQuality('auto', false);
                    else if (this.prevAbr.id != null) this.selectQuality(this.prevAbr.id, false, false);
                }
            }
            this.announce(on ? 'Audio-only battery saver on' : 'Audio-only mode off', 'headphones');
            this.refreshPopover();
        }

        // -----------------------------------------------------------------
        // Mini player (in-page floating dock)
        // -----------------------------------------------------------------
        setMini(on) {
            if (this.mini === on) return;
            this.closePopover(false);
            if (on && document.fullscreenElement) document.exitFullscreen().catch(() => { });
            this.mini = on;
            this.root.classList.toggle('mini', on);
            const v = this.video;
            // The content script moves the iframe into a floating corner window (and back).
            this.hostApi.layout({ cmd: on ? 'mini' : 'restore', ratio: v.videoWidth && v.videoHeight ? v.videoHeight / v.videoWidth : 9 / 16 });
            if (on) {
                this.announceOnly('Mini player. The page is usable again.');
                this.$('.mini-expand').focus({ preventScroll: true });
            } else {
                this.announceOnly('Full player');
                this.showControls();
                this.$('.btn-mini').focus({ preventScroll: true });
            }
            this.later(80, () => this.layoutVideo());
        }

        /**
         * Mini-window drag/resize. Screen coordinates are used because the iframe itself moves
         * under the pointer; deltas are rAF-throttled and applied by the content script.
         */
        dragLayout(kind, e, phase) {
            if (phase === 'start') {
                this.dragOrigin = { x: e.screenX, y: e.screenY };
                this.hostApi.layout({ cmd: `${kind}-start` });
                return;
            }
            if (!this.dragOrigin) return;
            this.dragDelta = { dx: e.screenX - this.dragOrigin.x, dy: e.screenY - this.dragOrigin.y };
            if (phase === 'end') {
                this.hostApi.layout({ cmd: kind, ...this.dragDelta });
                this.hostApi.layout({ cmd: `${kind}-end` });
                this.dragOrigin = null;
                this.later(80, () => this.layoutVideo());
                return;
            }
            if (this.dragRaf) return;
            this.dragRaf = requestAnimationFrame(() => {
                this.dragRaf = 0;
                if (this.dragOrigin) this.hostApi.layout({ cmd: kind, ...this.dragDelta });
            });
        }

        bindMiniResize() {
            const handle = this.$('.mini-resize');
            let active = false;
            this.listen(handle, 'pointerdown', (e) => {
                e.preventDefault();
                handle.setPointerCapture(e.pointerId);
                active = true;
                this.dragLayout('resize', e, 'start');
            });
            this.listen(handle, 'pointermove', (e) => { if (active) this.dragLayout('resize', e, 'move'); });
            const end = (e) => { if (!active) return; active = false; this.dragLayout('resize', e, 'end'); };
            this.listen(handle, 'pointerup', end);
            this.listen(handle, 'pointercancel', end);
        }

        retry() {
            this.hideError();
            const t = this.video.currentTime || 0;
            this.load(t).catch(err => this.showError('Retry failed', String(err.message || err)));
        }

        showError(title, message) {
            if (this.closed) return;
            if (this.mini) this.setMini(false);
            this.setStatus('error');
            this.root.classList.remove('buffering');
            this.$('#fs-err-title span').textContent = title;
            this.$('#fs-err-msg').textContent = message || '';
            this.$('.error').classList.add('show');
            this.errorShown = true;
            this.$('.btn-retry').focus({ preventScroll: true });
        }

        hideError() {
            this.$('.error').classList.remove('show');
            this.errorShown = false;
            if (this.status === 'error') this.setStatus('loading');
        }

        onShakaError(err) {
            if (!err) return;
            const code = err.code;
            const data = Array.isArray(err.data) ? err.data : [];
            const netUrl = code >= 1000 && code < 2000 && typeof data[0] === 'string' ? data[0] : '';
            const reason = code === 1002 && data[1] ? String(data[1].message || data[1]) : '';
            const httpStatus = code === 1001 && typeof data[1] === 'number' ? ` HTTP ${data[1]}` : '';
            console.warn(`[Velostream] Shaka error ${code}${httpStatus} (severity ${err.severity})${netUrl ? ` ${netUrl.slice(0, 300)}` : ''}${reason ? ` - ${reason}` : ''}`);
            if (code === 3017) {
                // QUOTA_EXCEEDED_ERROR: mobile SourceBuffer limits. Shrink buffers and keep going.
                this.player.configure({ streaming: { bufferBehind: 8, bufferingGoal: 15 } });
                this.announce('Low memory: buffer reduced', 'warn');
                return;
            }
            if (err.severity !== 2 || code === 7000 || code === 7001 || code === 7002) return;
            // Expired / single-use signed link: switch to a newer link for the same video if the
            // page has requested one since; otherwise explain (below).
            if (code === 1001 && (data[1] === 401 || data[1] === 403 || data[1] === 410) && this.mode === 'mse' && !this.freshTried) {
                this.freshTried = true;
                this.findFreshUrl(netUrl || this.stream.url).then(url => {
                    if (this.closed) return;
                    if (url) {
                        this.stream = { ...this.stream, url, detectedAt: Date.now() };
                        this.island('wave', 'Link expired · Switching to the page\'s new link');
                        this.retry();
                        this.later(30000, () => { this.freshTried = false; });
                    } else {
                        this.onShakaError(err);
                    }
                });
                return;
            }
            // Transient network failures (dropped connection, CDN hiccup, server 5xx): reload
            // silently from the current position a couple of times before showing an error.
            const status = code === 1001 ? data[1] : 0;
            const transient = code === 1002 || code === 1003 || (code === 1001 && (status >= 500 || status === 408 || status === 429));
            if (transient && this.mode === 'mse' && !this.closed) {
                const now = Date.now();
                this.netRecoveries = (this.netRecoveries || []).filter(t => now - t < 60000);
                if (this.netRecoveries.length < 2) {
                    this.netRecoveries.push(now);
                    this.island('wave', 'Connection hiccup · reconnecting…');
                    this.later(1500 * this.netRecoveries.length, () => { if (!this.closed && !this.errorShown) this.retry(); });
                    return;
                }
            }
            let host = '';
            try { host = netUrl ? new URL(netUrl).hostname : ''; } catch (_) { /* opaque */ }
            const from = host ? ` from ${host}` : '';
            let msg = `Error code ${code}.`;
            if (code === 1001) {
                msg = status === 403 || status === 401 || status === 410
                    ? `The server${from} refused access (HTTP ${status}). Sites like this sign their video links and the signature expires after a while. Reload the page and open Velostream again to get a fresh link.`
                    : `The server${from} returned HTTP ${status}.`;
            } else if (code === 1002 || code === 1003) {
                msg = `${code === 1003 ? 'Timed out' : 'Network error'} while loading the stream${from}${reason ? ` (${reason})` : ''}. Check your connection, or that an ad or content blocker is not blocking ${host || 'the video server'}, then retry.`;
            } else if (code >= 6000 && code < 7000 || (this.drmInfo && (code === 3016 || code === 4032))) {
                const ks = this.drmInfo && this.drmInfo.keySystem ? ` (${this.drmInfo.keySystem.replace(/^com\./, '')})` : '';
                msg = `This stream is protected by DRM${ks} and can only be decrypted by the website's own player. Close Velostream to keep watching there, or use Studio › Tools › Open in external player for non-DRM copies.`;
            } else if (code === 4032 || code === 4012 || code === 3016 || code === 4001) {
                msg = 'This browser cannot decode the stream\'s format or codecs.';
            } else if (code === 4000 || code === 4030) {
                msg = 'The stream manifest could not be understood.';
            }
            this.showError('Playback error', msg);
        }

        // -----------------------------------------------------------------
        // Tracks / quality
        // -----------------------------------------------------------------
        currentVariants() {
            if (!this.player || this.mode !== 'mse') return [];
            let tracks = [];
            try { tracks = this.player.getVariantTracks(); } catch (_) { return []; }
            const active = tracks.find(t => t.active);
            if (active) {
                tracks = tracks.filter(t => t.language === active.language &&
                    (active.audioId == null || t.audioId == null || t.audioId === active.audioId || t.audioGroupId === active.audioGroupId));
            }
            return tracks;
        }

        uniqueQualities() {
            const tracks = this.currentVariants().slice().sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth);
            const seen = new Set();
            return tracks.filter(t => { const k = `${t.height}|${t.bandwidth}`; if (seen.has(k)) return false; seen.add(k); return true; });
        }

        qualityName(t) {
            if (!t.height) return 'Audio only';
            const tag = t.height >= 2160 ? ' 4K' : t.height >= 1440 ? ' QHD' : t.height >= 720 ? ' HD' : '';
            return `${t.height}p${t.frameRate && t.frameRate > 30 ? Math.round(t.frameRate) : ''}${tag}`;
        }

        onTracksChanged(switched) {
            const prevH = this.lastHeight;
            this.updateQualityBadge();
            const tracks = this.currentVariants();
            const sig = tracks.map(t => `${t.id}:${t.bandwidth}`).join(',');
            if (sig !== this.variantsSig) {
                this.variantsSig = sig;
                this.sendTelemetry(true);
            }
            const active = tracks.find(t => t.active);
            if (switched && active && active.height && prevH && active.height !== prevH && !this.audioOnly) {
                this.island('studio', `Switched to ${active.height}p (${fmtBitrate(active.bandwidth)})`);
            }
            if (active) this.lastHeight = active.height;
            this.updateCcButton();
            if (this.popKind) this.refreshPopover();
        }

        updateQualityBadge() {
            const chip = this.$('.chip.abr');
            const active = this.currentVariants().find(t => t.active);
            const h = (active && active.height) || this.video.videoHeight;
            chip.textContent = this.mode !== 'mse' ? (h ? `${h}p` : '') : `${h ? `${h}p` : '—'} • ${this.abrAuto ? 'Auto' : 'Locked'}`;
            chip.hidden = !chip.textContent;
        }

        /** @param {boolean} [clearBuffer] false: switch from the next segment (no rebuffer). */
        selectQuality(id, announce = true, clearBuffer = true) {
            if (!this.player) return;
            if (id === 'auto') {
                this.abrAuto = true;
                this.lockedVariantId = null;
                this.port.send({ type: 'SET_QUALITY', mode: 'auto' });
                if (announce) this.announce('Quality: Auto', 'studio');
            } else {
                const t = this.player.getVariantTracks().find(x => x.id === id);
                if (!t) return;
                this.abrAuto = false;
                this.lockedVariantId = id;
                // Re-selecting the playing track with clearBuffer would only throw the buffer away.
                if (!t.active) this.player.selectVariantTrack(t, clearBuffer);
                this.port.send({ type: 'SET_QUALITY', mode: 'lock', variantId: id });
                if (announce) this.announce(`${this.qualityName(t)} (${fmtBitrate(t.bandwidth)})`, 'studio');
            }
            // User choices are remembered for the next video (audio-only's temporary lock is not).
            if (announce) {
                const t = id === 'auto' ? null : this.player.getVariantTracks().find(x => x.id === id);
                this.remember({ qualityHeight: t ? (t.height || 0) : 0 });
            }
            this.updateQualityBadge();
            this.sendTelemetry(true);
            this.refreshPopover();
        }

        applyAbrSwitch(variantId) {
            if (!this.player || !this.abrAuto || this.audioOnly) return;
            const t = this.player.getVariantTracks().find(x => x.id === variantId);
            if (t && !t.active) this.player.selectVariantTrack(t, false);
        }

        setQualityCap(height) {
            this.qualityCap = height;
            if (this.player) this.player.configure({ restrictions: { maxHeight: height || Infinity } });
            this.sendTelemetry(true);
        }

        audioTracks() {
            if (!this.player || this.mode !== 'mse') return [];
            try { return this.player.getAudioTracks(); } catch (_) { return []; }
        }

        selectAudioTrack(index, remember = true) {
            const t = this.audioTracks()[index];
            if (!t) return;
            this.player.selectAudioTrack(t);
            if (remember) {
                this.announce(`Audio: ${t.label || t.language || `Track ${index + 1}`}`, 'wave');
                this.remember({ audioLang: t.language || '' });
            }
            this.later(300, () => this.onTracksChanged());
        }

        textTracks() {
            if (!this.player || this.mode !== 'mse') return [];
            try { return this.player.getTextTracks(); } catch (_) { return []; }
        }

        selectSubtitle(source, trackId, remember = true) {
            if (source === 'off') {
                this.subs.source = 'off';
                if (this.player) { try { this.player.selectTextTrack(null); } catch (_) { /* ignore */ } }
                if (remember) { this.announce('Subtitles off', 'captions'); this.remember({ subsOn: false }); }
            } else if (source === 'external') {
                if (!this.subs.externalCues) return;
                this.subs.source = 'external';
                this.subs.lastSource = 'external';
                if (this.player) { try { this.player.selectTextTrack(null); } catch (_) { /* ignore */ } }
                if (remember) this.announce(`Subtitles: ${this.subs.externalName}`, 'captions');
            } else {
                const t = this.textTracks().find(x => x.id === trackId);
                if (!t) return;
                this.subs.clearShaka();
                this.subs.source = 'shaka';
                this.subs.lastSource = 'shaka';
                this.player.selectTextTrack(t);
                this.lastShakaText = t.id;
                if (remember) {
                    this.announce(`Subtitles: ${t.label || t.language || 'on'}`, 'captions');
                    this.remember({ subsOn: true, subLang: t.language || '' });
                }
            }
            this.subs.lastHtml = null;
            this.subs.render(this.video.currentTime);
            this.updateCcButton();
            this.refreshPopover();
        }

        toggleCaptions() {
            if (this.subs.source !== 'off') return this.selectSubtitle('off');
            const tracks = this.textTracks();
            const pick = tracks.find(t => t.id === this.lastShakaText) || tracks[0];
            // Restore what was used last; without history, external cues first (as before).
            const order = this.subs.lastSource === 'shaka' ? ['shaka', 'external'] : ['external', 'shaka'];
            for (const src of order) {
                if (src === 'external' && this.subs.externalCues) return this.selectSubtitle('external');
                if (src === 'shaka' && pick) return this.selectSubtitle('shaka', pick.id);
            }
            this.announce('No subtitles. Load a file from the captions menu.', 'captions');
        }

        updateCcButton() {
            const on = this.subs.source !== 'off';
            const b = this.$('.btn-cc');
            b.setAttribute('aria-pressed', String(on));
            b.setAttribute('aria-label', `Subtitles and audio tracks (subtitles ${on ? 'on' : 'off'})`);
        }

        async loadSubtitleFile(file) {
            if (!file) return;
            if (file.size > 5 * 1024 * 1024) { this.announce('Subtitle file is too large', 'warn'); return; }
            const cues = parseSubtitleFile(await file.text());
            if (!cues.length) { this.announce('No subtitles found in that file', 'warn'); return; }
            this.subs.externalCues = cues;
            this.subs.externalName = file.name;
            this.subs.capturedIndex = null;
            this.selectSubtitle('external');
        }

        // -----------------------------------------------------------------
        // Subtitle extras: hover pause, click-to-copy, voice sync, speed, dual subtitles
        // -----------------------------------------------------------------
        bindSubtitleInteraction() {
            this.pausedByHover = false;
            for (const layer of this.$$('.subs')) {
                this.listen(layer, 'pointerover', (e) => {
                    const st = this.settings && this.settings.subtitles;
                    if (!st || !st.pauseOnHover || e.pointerType !== 'mouse' || !e.target.classList.contains('cue-line')) return;
                    if (!this.video.paused) { this.pausedByHover = true; this.video.pause(); }
                });
                this.listen(layer, 'pointerout', (e) => {
                    if (!this.pausedByHover || (e.relatedTarget && layer.contains(e.relatedTarget))) return;
                    this.pausedByHover = false;
                    this.video.play().catch(() => { });
                });
                this.listen(layer, 'pointerdown', (e) => { if (e.target.classList.contains('cue-line')) e.stopPropagation(); });
                this.listen(layer, 'click', (e) => {
                    const st = this.settings && this.settings.subtitles;
                    if (!st || !st.clickToCopy || !e.target.classList.contains('cue-line')) return;
                    e.stopPropagation();
                    const text = Array.from(layer.querySelectorAll('.cue-line')).map(n => n.textContent).join('\n');
                    this.copyText(text, 'Subtitle copied');
                });
            }
        }

        async copyText(text, done) {
            try {
                await navigator.clipboard.writeText(text);
            } catch (_) {
                // Clipboard API refused (no focus / permission): legacy copy through a textarea.
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
                this.shadow.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); } catch (__) { /* ignore */ }
                ta.remove();
            }
            this.island('check', done);
        }

        /** "Sync to current voice": the next subtitle line starts right now. */
        syncSubsToVoice() {
            const next = this.subs.nextCueStart(this.video.currentTime);
            if (next == null) { this.announce('No upcoming subtitle line to sync', 'warn'); return; }
            this.setSubOffset(this.video.currentTime - next * (this.subs.speed || 1));
        }

        setSubSpeed(v) {
            this.subs.speed = Math.round(clamp(v, 0.9, 1.1) * 1000) / 1000;
            this.subs.lastHtml = null;
            this.subs.lastTopHtml = null;
            this.subs.render(this.video.currentTime);
            this.island('captions', `Subtitle speed ${this.subs.speed.toFixed(3)}×`);
            this.refreshPopover();
        }

        async loadSecondary(kind, value) {
            if (kind === 'off') {
                this.subs.secondaryCues = null;
                this.subs.secondaryIndex = null;
                this.announce('Secondary subtitles off', 'captions');
            } else {
                let cues = [];
                let name = '';
                if (kind === 'cap') {
                    const t = (this.subs.capturedTracks || [])[value];
                    if (!t) return;
                    const text = t.vtt || (t.url ? await this.fetchText(t.url) : '');
                    cues = text ? parseSubtitleFile(text) : [];
                    name = this.capturedLabel(t, value);
                    this.subs.secondaryIndex = value;
                } else if (kind === 'file' && value) {
                    if (value.size > 5 * 1024 * 1024) { this.announce('Subtitle file is too large', 'warn'); return; }
                    cues = parseSubtitleFile(await value.text());
                    name = value.name;
                    this.subs.secondaryIndex = -1;
                }
                if (!cues.length) { this.announce('No subtitles found for the secondary track', 'warn'); return; }
                this.subs.secondaryCues = cues;
                this.subs.secondaryName = name;
                this.announce(`Secondary subtitles: ${name}`, 'captions');
            }
            this.subs.lastTopHtml = null;
            this.subs.render(this.video.currentTime);
            this.refreshPopover();
        }

        /** Drops the engine's disk cache for this stream and rebuilds it from the playhead. */
        purgeBuffer() {
            const t = this.video.currentTime;
            this.port.send({ type: 'PURGE_CACHE', time: t });
            if (this.player && this.mode === 'mse') {
                // Flush decoded media ahead too, so Shaka refetches from the fresh cache.
                try { this.video.currentTime = t; } catch (_) { /* ignore */ }
            }
            this.island('rotate', 'Buffer purged · Rebuilding from here');
            this.announceOnly('Buffer purged, rebuilding');
        }

        setSubOffset(value) {
            this.subs.offset = Math.round(value * 10) / 10;
            this.subs.lastHtml = null;
            this.subs.render(this.video.currentTime);
            this.island('captions', `Subtitle delay ${this.subs.offset >= 0 ? '+' : ''}${this.subs.offset.toFixed(1)}s`);
            this.announceOnly(`Subtitle delay ${this.subs.offset.toFixed(1)} seconds`);
            this.refreshPopover();
        }

        // -----------------------------------------------------------------
        // Video transforms & filters
        // -----------------------------------------------------------------
        layoutVideo() {
            if (!this.deck) return;
            this.root.style.setProperty('--deck-h', `${this.deck.offsetHeight + 24}px`);
            const W = this.stage.clientWidth;
            const H = this.stage.clientHeight;
            if (!W || !H) return;
            const rot = this.xf.rotate % 180 !== 0;
            const availW = rot ? H : W;
            const availH = rot ? W : H;
            let bw = availW;
            let bh = availH;
            let fit = 'contain';
            const ratios = { '16:9': 16 / 9, '4:3': 4 / 3, '21:9': 21 / 9 };
            if (this.fit === 'cover') fit = 'cover';
            else if (this.fit === 'fill') fit = 'fill';
            else if (ratios[this.fit]) {
                const r = ratios[this.fit];
                bw = Math.min(availW, availH * r);
                bh = bw / r;
                fit = this.fit === '21:9' ? 'cover' : 'fill';
            }
            const vb = this.vbox;
            vb.style.width = `${bw}px`;
            vb.style.height = `${bh}px`;
            vb.style.left = `${(W - bw) / 2}px`;
            vb.style.top = `${(H - bh) / 2}px`;
            this.video.style.objectFit = fit;
            const { zoom, panX, panY, rotate, flip } = this.xf;
            vb.style.transform = `translate(${panX}px, ${panY}px) rotate(${rotate}deg) scale(${zoom * (flip ? -1 : 1)}, ${zoom})`;
            // Always keep the canvas rect current (also while the GL context is lost, so a restore
            // renders in the right place); layout() only renders when the pipeline is active.
            if (this.gpu) this.gpu.layout(bw, bh, fit);
        }

        setZoom(z, announce) {
            this.xf.zoom = clamp(z, 1, 4);
            if (this.xf.zoom === 1) { this.xf.panX = 0; this.xf.panY = 0; }
            this.clampPan();
            this.layoutVideo();
            if (announce) this.announce(`Zoom ${Math.round(this.xf.zoom * 100)}%`, 'expand');
        }

        clampPan() {
            const rotated = this.xf.rotate % 180 !== 0;
            const width = rotated ? this.stage.clientHeight : this.stage.clientWidth;
            const height = rotated ? this.stage.clientWidth : this.stage.clientHeight;
            const maxX = width * (this.xf.zoom - 1) / 2;
            const maxY = height * (this.xf.zoom - 1) / 2;
            this.xf.panX = clamp(this.xf.panX, -maxX, maxX);
            this.xf.panY = clamp(this.xf.panY, -maxY, maxY);
        }

        applyFilters() {
            const f = this.filters;
            this.applyGpu();
            if (this.graphicsOriginal) {
                this.video.style.filter = '';
                if (this.glCanvas) this.glCanvas.style.filter = '';
                return;
            }
            const gpuOn = !!(this.gpu && this.gpu.active);
            const parts = [`brightness(${f.brightness}%)`, `contrast(${f.contrast}%)`, `saturate(${f.saturate}%)`, `hue-rotate(${f.hue}deg)`, `sepia(${f.warmth}%)`];
            // Sharpness: GPU CAS when WebGL2 works (applyGpu), CPU SVG convolution otherwise.
            if (f.sharpness > 0 && !gpuOn && this.gpuOverride !== 'off') {
                const a = (f.sharpness / 100) * 0.9;
                this.shadow.getElementById('fs-kernel').setAttribute('kernelMatrix', `0 ${-a} 0 ${-a} ${1 + 4 * a} ${-a} 0 ${-a} 0`);
                parts.push('url(#fs-sharpen)');
            }
            const isDefault = Object.keys(DEFAULT_FILTERS).every(k => k === 'sharpness' ? (gpuOn || !f.sharpness) : f[k] === DEFAULT_FILTERS[k]);
            const css = isDefault ? '' : parts.join(' ');
            // Colour filters go on whatever is visible: the GPU canvas or the video element.
            this.video.style.filter = gpuOn ? '' : css;
            if (this.glCanvas) this.glCanvas.style.filter = gpuOn ? css : '';
        }

        /** The GPU preset in effect: the Studio choice, or CAS when only the sharpness slider is used. */
        effectiveShader() {
            if (!this.settings || this.gpuBlocked || this.graphicsOriginal) return { preset: 'off', strength: 0 };
            if (this.gpuOverride === 'off') return { preset: 'off', strength: 0 };
            const chosen = this.gpuOverride || this.settings.shader || 'off';
            const mobile = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 700;
            if (chosen === 'auto') {
                const hardware = this.graphicsHardware ||= this.detectHardwareTier();
                if (!hardware.webgl || /SwiftShader|llvmpipe|Microsoft Basic Render/i.test(hardware.renderer)) return { preset: 'off', strength: 0 };
                const budget = window.VelostreamShared.graphicsBudget(hardware.tier, mobile, this.video.videoHeight);
                return { preset: budget.preset, strength: this.settings.shaderStrength, maxHeight: budget.maxHeight, mobile };
            }
            if (chosen !== 'off') {
                const maxHeight = mobile ? (this.settings.hwTier === 'low' ? 720 : 1080) : undefined;
                return { preset: chosen, strength: this.settings.shaderStrength, maxHeight };
            }
            if (this.filters.sharpness > 0) return { preset: 'cas', strength: this.filters.sharpness };
            return { preset: 'off', strength: 0 };
        }

        destroyGpu() {
            if (!this.gpu) return;
            try { this.gpu.destroy(); } catch (_) { /* already gone */ }
            this.gpu = null;
            if (this.vbox) this.vbox.classList.remove('gl-on');
        }

        /** Color Studio values in pipeline units (gamma as a factor), or null when neutral. */
        gpuColor() {
            const c = (this.settings && this.settings.color) || {};
            const v = {
                gamma: (c.gamma ?? 100) / 100, vibrance: c.vibrance || 0, temperature: c.temperature || 0,
                tint: c.tint || 0, shadows: c.shadows || 0, highlights: c.highlights || 0
            };
            const neutral = Math.abs(v.gamma - 1) < 0.005 && !v.vibrance && !v.temperature && !v.tint && !v.shadows && !v.highlights;
            return neutral ? null : v;
        }

        applyGpu() {
            const want = this.effectiveShader();
            const color = this.gpuBlocked || this.graphicsOriginal ? null : this.gpuColor();
            if (want.preset === 'off' && !color && !this.gpu) return;
            if (!this.gpu) {
                if (!window.VelostreamShaders || !this.glCanvas) { this.gpuBlocked = 'unavailable'; return; }
                // A destroyed pipeline called WEBGL_lose_context on its canvas, and getContext()
                // keeps returning that dead context: start the new pipeline on a fresh canvas.
                if (this.glCanvasUsed) {
                    const c = this.glCanvas.cloneNode(false);
                    c.hidden = true;
                    c.style.filter = this.glCanvas.style.filter;
                    this.glCanvas.replaceWith(c);
                    this.glCanvas = c;
                }
                this.glCanvasUsed = true;
                this.gpu =new window.VelostreamShaders.VideoShaderPipeline(this.video, this.glCanvas, {
                    onStepDown: (to) => {
                        const names = { cas: 'Fast Sharpen', off: 'Off', anime4k: 'Anime4K (fast)' };
                        this.gpuOverride = to;   // this session only; the saved choice is kept
                        this.island('studio', `GPU load high · Stepped down to ${names[to] || to}`, null, 3500);
                        this.applyFilters();
                        this.refreshPopover();
                    },
                    onUnavailable: (reason) => {
                        this.gpuBlocked = reason;
                        this.island('warn', 'GPU enhancement unavailable', null, 3000);
                        this.announceOnly(`GPU enhancement unavailable: ${reason}`);
                        this.vbox.classList.remove('gl-on');
                        this.applyFilters();
                        this.refreshPopover();
                    }
                });
            }
            const on = this.gpu.configure({ preset: want.preset, strength: want.strength, maxRenderRes: Math.min(this.settings.maxRenderRes || 2160, want.maxHeight || Infinity), color: color || {} });
            this.vbox.classList.toggle('gl-on', on);
            if (on) {
                this.layoutVideo();
                if (!this.video.paused && !this.audioOnly) this.gpu.start();
            }
        }

        // -----------------------------------------------------------------
        // Loop, bookmarks, watch history / auto-resume
        // -----------------------------------------------------------------
        setLoopPoint(which) {
            const t = this.video.currentTime;
            const r = this.seekRange();
            if (which === 'a') {
                this.loop.a = t;
                if (this.loop.b != null && this.loop.b <= t) this.loop.b = null;
                this.announce(`Loop A at ${fmtTime(t - r.start)}`, 'loop');
            } else {
                if (this.loop.a == null || t <= this.loop.a) { this.announce('Set point A before point B', 'warn'); return; }
                this.loop.b = t;
                this.announce(`Looping ${fmtTime(this.loop.a - r.start)} – ${fmtTime(t - r.start)}`, 'loop');
            }
            this.renderMarks();
            this.refreshPopover();
        }

        clearLoop() {
            this.loop = { a: null, b: null };
            this.renderMarks();
            this.refreshPopover();
            this.announce('A–B loop cleared', 'loop');
        }

        mediaKey() {
            if (this.localPlayback) return 'local-' + hashKey(this.stream.id);
            const page = window.VelostreamShared.withoutResumeTime(this.playbackPageUrl);
            const value = JSON.stringify([page, this.stream.url.split('#')[0]]);
            let hash = 0xcbf29ce484222325n;
            for (let i = 0; i < value.length; i++) {
                hash = BigInt.asUintN(64, (hash ^ BigInt(value.charCodeAt(i))) * 0x100000001b3n);
            }
            return hash.toString(16).padStart(16, '0');
        }

        legacyMediaKey() {
            let base = this.stream.url;
            try { const u = new URL(base); base = u.origin + u.pathname; } catch (_) { /* raw */ }
            return hashKey(base);
        }

        async legacyHistory() {
            const legacy = await this.port.request('HISTORY_GET', { key: this.legacyMediaKey() }).catch(() => null);
            const entry = legacy?.value;
            return entry?.url === this.stream.url && (!entry.page || !this.playbackPageUrl || entry.page === window.VelostreamShared.withoutResumeTime(this.playbackPageUrl)) ? entry : null;
        }

        async loadBookmarks() {
            try {
                let res = await this.port.request('STORE_GET', { key: `fs_bm_${this.mediaKey()}` });
                if (res.value == null && await this.legacyHistory()) res = await this.port.request('STORE_GET', { key: `fs_bm_${this.legacyMediaKey()}` });
                this.bookmarks = Array.isArray(res.value) ? res.value.filter(b => Number.isFinite(b.t)).slice(0, 200) : [];
            } catch (_) {
                this.bookmarks = [];
            }
            this.renderMarks();
        }

        saveBookmarks() {
            this.port.send({ type: 'STORE_SET', key: `fs_bm_${this.mediaKey()}`, value: this.bookmarks });
            this.renderMarks();
            this.refreshPopover();
        }

        addBookmark(label) {
            const t = this.video.currentTime;
            const r = this.seekRange();
            this.bookmarks.push({ t, label: (label || '').trim().slice(0, 80) || `Bookmark ${fmtTime(t - r.start)}` });
            this.bookmarks.sort((a, b) => a.t - b.t);
            this.saveBookmarks();
            this.announce(`Bookmark at ${fmtTime(t - r.start)}`, 'bookmark');
        }

        // -----------------------------------------------------------------
        // Remembered state
        //   Global (settings.memory): volume, mute, quality, audio language, subtitles on/off +
        //   language; speed via settings.defaultSpeed. Per video (history entry): position,
        //   subtitle offset, A-B loop.
        // -----------------------------------------------------------------
        remember(patch) {
            if (!this.rawSettings) return;
            // Staged at once (so a SETTINGS_CHANGED in between cannot drop it); written after a
            // pause so dragging the volume slider does not hammer storage. No applySettings():
            // memory has no visual effect.
            if (this.stageSettings({ memory: patch })) this.scheduleSettingsFlush(400);
        }

        /** Re-apply the last-used volume, quality, audio language and subtitles to this video. */
        restoreRememberedState() {
            const m = this.settings && this.settings.memory;
            if (!m) return;
            const v = this.video;
            this.restoring = true;
            v.volume = clamp(m.volume, 0, 1);
            v.muted = !!m.muted;
            this.restoring = false;
            if (this.mode !== 'mse' || !this.player) return;
            if (m.qualityHeight) {
                const t = this.uniqueQualities().find(x => x.height === m.qualityHeight) ||
                    this.uniqueQualities().filter(x => x.height && x.height <= m.qualityHeight).sort((a, b) => b.height - a.height)[0];
                if (t) this.selectQuality(t.id, false);
            }
            if (m.audioLang) {
                const tracks = this.audioTracks();
                const i = tracks.findIndex(t => t.language === m.audioLang);
                if (i >= 0 && !tracks[i].active) this.selectAudioTrack(i, false);
            }
            if (m.subsOn) {
                const texts = this.textTracks();
                const t = texts.find(x => m.subLang && x.language === m.subLang) || texts[0];
                if (t) this.selectSubtitle('shaka', t.id, false);
            }
        }

        saveHistory(force, confirm = false) {
            if (this.localPlayback) return this.saveLocalPosition?.();
            if (!this.stream || !this.settings || this.closed || this.changingMedia || this.isLive()) return;
            const v = this.video;
            const d = Number.isFinite(v.duration) ? v.duration : 0;
            if (!force && v.paused) return;
            if (v.currentTime < 5 && !force) return;
            if (!d && !v.currentTime) return;
            // The site page the video plays on (Continue Watching opens it), never this
            // chrome-extension:// iframe.
            const page = window.VelostreamShared.withoutResumeTime([this.playbackPageUrl, this.stream.frameUrl].find(u => typeof u === 'string' && /^https?:\/\//i.test(u)));
            const payload = {
                key: this.mediaKey(),
                legacyKey: this.legacyMediaKey(),
                entry: {
                    url: this.stream.url, title: this.$('.title').textContent, page, t: v.currentTime, d,
                    pageMeta: this.playbackPageMeta,
                    done: d > 0 && (v.ended || v.currentTime / d >= 0.8),
                    subOffset: this.subs.offset, loopA: this.loop.a, loopB: this.loop.b
                }
            };
            if (confirm) return this.port.request('HISTORY_SAVE', payload, 2000).catch(() => { });
            this.port.send({ type: 'HISTORY_SAVE', ...payload });
        }

        async checkResume() {
            if (!this.settings || this.isLive() || this.closed) return;
            let entry = null;
            try { entry = (await this.port.request('HISTORY_GET', { key: this.mediaKey() })).value; } catch (_) { return; }
            if (!entry) entry = await this.legacyHistory();
            if (!entry) return;
            // Per-video memory is restored even when the position itself is not.
            if (Number.isFinite(entry.subOffset) && entry.subOffset) { this.subs.offset = entry.subOffset; this.subs.lastHtml = null; }
            if (Number.isFinite(entry.loopA)) { this.loop = { a: entry.loopA, b: Number.isFinite(entry.loopB) ? entry.loopB : null }; this.renderMarks(); }
            if (this.settings.autoResume === 'off' || this.hostApi.explicitStart) return;
            if (entry.done && !(entry.d > 0 && entry.d <= 20 && entry.t / entry.d < 0.8) || entry.t < Math.min(15, entry.d * 0.2 || 15)) return;
            // The site's own player may hand over its (often stale, paused) position; the
            // furthest point actually reached wins.
            if (this.hostApi.startTime && entry.t <= this.hostApi.startTime + 5) return;
            const d = Number.isFinite(this.video.duration) ? this.video.duration : entry.d;
            if (d && entry.t > d - 20) return;
            this.resumeAt = entry.t;
            if (this.settings.autoResume === 'always') {
                this.seekTo(entry.t, false);
                this.announce(`Resumed at ${fmtTime(entry.t)}`, 'play');
                return;
            }
            this.$('.resume-text').textContent = `Resume from ${fmtTime(entry.t)}?`;
            this.$('.resume').classList.add('show');
            this.showControls(true);
            this.announceOnly(`You stopped at ${fmtSpoken(entry.t)}. Resume, or start over.`);
            this.later(12000, () => this.dismissResume(false));
        }

        acceptResume() {
            if (this.resumeAt) this.seekTo(this.resumeAt, false);
            this.announce(`Resumed at ${fmtTime(this.resumeAt || 0)}`, 'play');
            this.dismissResume(false);
            if (this.video.paused) this.video.play().catch(() => { });
        }

        dismissResume(restart) {
            const card = this.$('.resume');
            if (!card.classList.contains('show')) return;
            card.classList.remove('show');
            if (restart) { this.seekTo(0, false); this.announceOnly('Starting from the beginning'); }
            if (this.root.contains(this.shadow.activeElement) || this.shadow.activeElement === null) this.$('.btn-play').focus({ preventScroll: true });
            this.scheduleHide();
        }

        // -----------------------------------------------------------------
        // Sleep timer & smart skip
        // -----------------------------------------------------------------
        setSleep(mode) {
            clearInterval(this.sleepFadeTimer);
            if (!mode) {
                this.sleep = null;
                this.announce('Sleep timer off', 'moon');
            } else if (mode === 'eov') {
                this.sleep = { mode: 'eov' };
                this.announce('Sleep at end of video', 'moon');
            } else {
                this.sleep = { mode, endsAt: Date.now() + mode * 60000 };
                this.announce(`Sleep in ${mode} minutes`, 'moon');
            }
            this.updateSleepChip();
            this.refreshPopover();
        }

        updateSleepChip() {
            const chip = this.$('.sleep-chip');
            if (!this.sleep) { chip.hidden = true; return; }
            chip.hidden = false;
            const text = this.sleep.endsAt ? `${Math.max(0, Math.ceil((this.sleep.endsAt - Date.now()) / 60000))}m` : 'End';
            chip.querySelector('span').textContent = text;
            chip.setAttribute('aria-label', `Sleep timer ${text === 'End' ? 'at end of video' : text}`);
        }

        checkSleep() {
            if (!this.sleep || this.sleep.fading) return;
            const v = this.video;
            let remaining;
            if (this.sleep.mode === 'eov') {
                if (!Number.isFinite(v.duration) || this.isLive()) return;
                remaining = (v.duration - v.currentTime) / this.rate();
            } else {
                remaining = (this.sleep.endsAt - Date.now()) / 1000;
            }
            this.updateSleepChip();
            if (remaining <= 8 && !v.paused) this.fadeOutForSleep();
            else if (remaining <= 0 && v.paused) this.finishSleep();
        }

        /** Gentle 8 s fade, then pause playback and stop the engine's prefetching. */
        fadeOutForSleep() {
            const v = this.video;
            this.sleep.fading = true;
            const startVol = v.volume;
            const steps = 40;
            let i = 0;
            this.announce('Sleep timer: fading out', 'moon');
            this.sleepFadeTimer = setInterval(() => {
                i++;
                v.volume = Math.max(0, startVol * (1 - i / steps));
                if (i >= steps) {
                    clearInterval(this.sleepFadeTimer);
                    v.pause();
                    v.volume = startVol;
                    this.finishSleep();
                }
            }, 200);
        }

        finishSleep() {
            this.sleep = null;
            this.sleepPausedPrefetch = true;
            this.port.send({ type: 'PREFETCH', enabled: false });
            this.updateSleepChip();
            this.announce('Sleep timer: paused, downloads stopped', 'moon');
        }

        frameLuma() {
            const v = this.video;
            if (!v.videoWidth) return null;
            if (!this.lumaCanvas) {
                this.lumaCanvas = document.createElement('canvas');
                this.lumaCanvas.width = 32;
                this.lumaCanvas.height = 18;
                this.lumaCtx = this.lumaCanvas.getContext('2d', { willReadFrequently: true });
            }
            try {
                this.lumaCtx.drawImage(v, 0, 0, 32, 18);
                const d = this.lumaCtx.getImageData(0, 0, 32, 18).data;
                let sum = 0;
                for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
                return sum / (d.length / 4) / 255;
            } catch (_) {
                return null; // cross-origin frame (tainted canvas)
            }
        }

        /** Smart skip: fast-forward at 4x through black + silent stretches (credit gaps, breaks). */
        checkSmartSkip() {
            const v = this.video;
            const sm = this.smart;
            const restore = () => {
                if (sm.boostFrom != null) { v.playbackRate = sm.boostFrom; sm.boostFrom = null; this.hideIsland(); }
                sm.darkSince = 0;
            };
            if (!this.settings.smartSkip || v.paused || sm.blocked || this.isLive() || this.loop.b != null) { restore(); return; }
            const luma = this.frameLuma();
            if (luma === null) {
                if (v.videoWidth) { sm.blocked = true; this.announce('Smart skip is unavailable for this video', 'warn'); }
                return;
            }
            const silent = this.audio.active ? this.audio.rms() < 0.012 : true;
            const remaining = Number.isFinite(v.duration) ? v.duration - v.currentTime : Infinity;
            if (luma < 0.06 && silent && remaining > 6) {
                if (!sm.darkSince) sm.darkSince = Date.now();
                if (sm.boostFrom == null && Date.now() - sm.darkSince > 1000) {
                    sm.boostFrom = this.rate();
                    v.playbackRate = 4;
                    this.island('speed', 'Skipping black & silence · 4.0×', null, 0);
                }
            } else {
                restore();
            }
        }

        // -----------------------------------------------------------------
        // Screenshot, burst, export, recording
        // -----------------------------------------------------------------
        /**
         * PNG of the current frame at the video's resolution. With `withSubs` the picture is the one
         * on screen - GPU enhancement output and colour filters included - with the visible primary
         * and secondary subtitle lines drawn in the user's subtitle style.
         */
        screenshot(withSubs = false) {
            const v = this.video;
            if (!v.videoWidth) { this.announce('No video frame yet', 'warn'); return; }
            const c = document.createElement('canvas');
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            try {
                const ctx = c.getContext('2d');
                if (withSubs) {
                    const gpuOn = !!(this.gpu && this.gpu.active && this.glCanvas && !this.glCanvas.hidden);
                    // CSS filters (minus the SVG sharpen, which canvas cannot resolve in a shadow root).
                    const css = ((gpuOn ? this.glCanvas.style.filter : v.style.filter) || '').replace(/url\([^)]*\)/g, '').trim();
                    if (css) ctx.filter = css;
                    if (gpuOn) {
                        // The WebGL canvas does not preserve its buffer: draw a fresh frame and copy it
                        // in the same task.
                        this.gpu.draw();
                        ctx.drawImage(this.glCanvas, 0, 0, c.width, c.height);
                    } else {
                        ctx.drawImage(v, 0, 0);
                    }
                    ctx.filter = 'none';
                    this.drawSubtitlesOnto(ctx, c.width, c.height);
                } else {
                    ctx.drawImage(v, 0, 0);
                }
                ctx.getImageData(0, 0, 1, 1); // throws now (not inside toBlob) on a tainted canvas
                c.toBlob(blob => {
                    if (!blob) { this.announce('Screenshot failed', 'warn'); return; }
                    downloadBlob(this.shadow, blob, `velostream-${fmtTime(v.currentTime).replace(/:/g, '-')}${withSubs ? '-subs' : ''}.png`, false);
                    this.announce(withSubs ? 'Screenshot with subtitles saved' : 'Screenshot saved', 'camera');
                }, 'image/png');
            } catch (e) {
                this.announce('Screenshot blocked: cross-origin video without CORS', 'warn');
            }
        }

        /** Burn the currently visible subtitle lines into a W×H frame, scaled from the on-screen size. */
        drawSubtitlesOnto(ctx, W, H, opts = {}) {
            const t = this.subs.cueTime(this.video.currentTime);
            const primary = this.subs.source !== 'off' ? SubtitleEngine.activeAt(this.subs.activeCues(), t) : [];
            const top = this.subs.secondaryCues ? SubtitleEngine.activeAt(this.subs.secondaryCues, t) : [];
            if (!primary.length && !top.length) return;
            const st = this.settings.subtitles;
            // On-screen line height relative to the displayed video height, mapped onto the frame.
            const shown = this.gpu && this.gpu.contentRect && this.gpu.contentRect.h ? this.gpu.contentRect.h : this.vbox.clientHeight || H;
            const layerPx = parseFloat(getComputedStyle(this.$('.subs')).fontSize) || 18;
            const scale = H / Math.max(1, shown);
            // PiP windows are small: size the text to the frame (about 5.5% of its height at 100%).
            const fontPx = opts.pip
                ? Math.max(14, Math.round(H * 0.055 * clamp(st.size, 50, 300) / 100))
                : Math.max(12, Math.round(layerPx * (clamp(st.size, 50, 300) / 100) * 1.45 * scale));
            ctx.font = `600 ${fontPx}px ${(FONTS[st.font] || FONTS.system).css}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const lineH = Math.round(fontPx * 1.3);
            const padX = Math.round(fontPx * 0.35);
            const drawBlock = (texts, yOf) => {
                const lines = texts.join('\n').split('\n').map(l => l.trim()).filter(Boolean);
                lines.forEach((line, i) => {
                    const y = yOf(i, lines.length);
                    const w = ctx.measureText(line).width;
                    const alpha = clamp(st.bgOpacity, 0, 100) / 100;
                    if (alpha > 0) {
                        ctx.fillStyle = `rgba(0,0,0,${alpha})`;
                        ctx.fillRect(Math.round(W / 2 - w / 2 - padX), Math.round(y - lineH / 2), Math.round(w + padX * 2), lineH);
                    }
                    if (st.edge === 'outline') {
                        ctx.lineJoin = 'round';
                        ctx.lineWidth = Math.max(2, fontPx / 10);
                        ctx.strokeStyle = '#000';
                        ctx.strokeText(line, W / 2, y);
                    }
                    ctx.save();
                    if (st.edge === 'shadow') { ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = fontPx / 4; ctx.shadowOffsetY = fontPx / 12; }
                    ctx.fillStyle = st.color || '#fff';
                    ctx.fillText(line, W / 2, y);
                    ctx.restore();
                });
            };
            const bottomGap = H * clamp(st.position, 0, 80) / 100;
            if (primary.length) drawBlock(primary, (i, n) => H - bottomGap - (n - i - 0.5) * lineH - lineH * 0.2);
            if (top.length) drawBlock(top, (i) => Math.max(H * 0.09, lineH) + (i + 0.5) * lineH);
        }

        /** Snapshot burst: 6 consecutive moments composed into one contact-sheet PNG. */
        async snapshotBurst() {
            const v = this.video;
            if (!v.videoWidth) { this.announce('No video frame yet', 'warn'); return; }
            if (this.bursting) return;
            this.bursting = true;
            const cols = 3;
            const rows = 2;
            const cw = Math.min(960, v.videoWidth);
            const ch = Math.round(cw * v.videoHeight / v.videoWidth);
            const c = document.createElement('canvas');
            c.width = cw * cols;
            c.height = ch * rows;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, c.width, c.height);
            const wasPaused = v.paused;
            const r = this.seekRange();
            try {
                for (let i = 0; i < cols * rows; i++) {
                    if (i > 0) {
                        if (wasPaused) {
                            const target = v.currentTime + 1 / (this.currentFps() || 30);
                            await new Promise(res => { v.addEventListener('seeked', res, { once: true }); v.currentTime = target; setTimeout(res, 1500); });
                        } else {
                            await wait(250);
                        }
                        await nextFrame();
                    }
                    const x = (i % cols) * cw;
                    const y = Math.floor(i / cols) * ch;
                    ctx.drawImage(v, x, y, cw, ch);
                    ctx.getImageData(x, y, 1, 1); // throws on a tainted (cross-origin) canvas
                    const label = fmtTime(v.currentTime - r.start);
                    const fs = Math.max(14, Math.round(ch / 14));
                    ctx.font = `600 ${fs}px -apple-system, system-ui, sans-serif`;
                    const tw = ctx.measureText(label).width;
                    ctx.fillStyle = 'rgba(0,0,0,0.6)';
                    ctx.fillRect(x + 12, y + ch - fs * 1.8 - 12, tw + 20, fs * 1.8);
                    ctx.fillStyle = '#fff';
                    ctx.fillText(label, x + 22, y + ch - 12 - fs * 0.55);
                    this.island('burst', `Capturing ${i + 1}/6`, (i + 1) / 6, 0);
                }
                const blob = await new Promise(res => c.toBlob(res, 'image/png'));
                if (!blob) throw new Error('encode failed');
                downloadBlob(this.shadow, blob, `velostream-burst-${fmtTime(v.currentTime).replace(/:/g, '-')}.png`, false);
                this.announce('Burst contact sheet saved', 'burst');
            } catch (e) {
                this.announce('Burst blocked: cross-origin video without CORS', 'warn');
            } finally {
                this.bursting = false;
            }
        }

        /** Top-right download button: export VOD, start/stop live recording, or cancel. */
        onDownloadButton() {
            if (this.localPlayback) { this.openLocalPicker(); return; }
            // A save picker is open (or being opened): ignore repeat presses / remote commands.
            if (this.pickingSink) return;
            if (this.exportState && this.exportState.running) {
                this.port.send({ type: 'EXPORT_CANCEL' });
                return;
            }
            if (this.isLive()) {
                if (this.recordingSince) this.stopRecording();
                else this.port.send({ type: 'RECORD_START' });
                return;
            }
            this.startExport();
        }

        /**
         * Stop the live recording and save it. With MP4 output the destination is asked for
         * first (ExportSink.pick: File System Access with a gesture, else the downloads sink).
         * Cancelling the picker leaves the recording running - nothing is stopped or lost - and
         * the next press asks again; RECORD_STOP is only sent once there is somewhere to save.
         */
        async stopRecording() {
            const toMp4 = (this.settings.exportFormat || 'mp4') === 'mp4' && !!window.VelostreamMux && !!(window.shaka && shaka.transmuxer && shaka.transmuxer.TsTransmuxer);
            const name = `${safeFilename(this.$('.title').textContent || 'live')}-recording.mp4`;
            let sink = null;
            if (toMp4) {
                this.pickingSink = true;
                try {
                    sink = await ExportSink.pick(this.shadow, name, 'video/mp4');
                } catch (_) {
                    sink = new ExportSink(this.shadow, name, 'video/mp4');
                } finally {
                    this.pickingSink = false;
                }
                if (!sink) {
                    this.announce('Save cancelled · Still recording', 'record');
                    return;
                }
                // Closed, recording ended elsewhere, or another export took over meanwhile.
                if (this.closed || !this.recordingSince || (this.exportState && this.exportState.running)) {
                    await sink.abort();
                    return;
                }
            }
            this.recordingSince = 0;
            this.exportState = { running: true, files: {}, status: 'Saving recording…', pct: 0, toMp4, sink, outName: sink ? sink.filename : name, chain: Promise.resolve() };
            this.port.send({ type: 'RECORD_STOP' });
            this.updateDownloadButton();
            this.refreshPopover();
        }

        supportsClip() {
            return this.stream && !this.isLive() && ['hls', 'dash'].includes(this.stream.type);
        }

        clipRange() {
            const { start, end } = this.clip;
            return this.supportsClip() && start != null && end != null ? { start, end } : null;
        }

        setClipPoint(point) {
            const time = this.video.currentTime;
            if (!this.supportsClip() || !Number.isFinite(time)) return;
            if (point === 'start') {
                this.clip.start = time;
                if (this.clip.end != null && this.clip.end - time < 0.5) this.clip.end = null;
            } else {
                if (this.clip.start == null || time - this.clip.start < 0.5) {
                    this.announce('Set In at least half a second before Out.', 'warn');
                    return;
                }
                this.clip.end = time;
            }
            this.announce(`Clip ${point === 'start' ? 'In' : 'Out'} set at ${fmtTime(time)}`, 'check');
            this.renderMarks();
            this.refreshPopover();
        }

        /**
         * DASH export plan from the manifest Shaka already parsed (every addressing mode:
         * SegmentTemplate, SegmentTimeline, SegmentList, SegmentBase byte ranges). Picks the best
         * MP4 video within the quality cap and the audio language being played, unencrypted only.
         * Returns [{role, segs:[{uri, range, start, duration, map}]}] in the engine's HLS segment
         * shape, so the engine fetches it through the site's headers and the existing fMP4 export.
         */
        async dashExportPlan(clip) {
            const p = this.player;
            if (!p || typeof p.getManifest !== 'function' || !p.getManifest()) throw new Error('The stream is not loaded yet.');
            if (this.isLive()) throw new Error('Saving live DASH streams is not supported.');
            const m = p.getManifest();
            const isMp4 = s => !!s && /mp4/i.test(s.mimeType || '');
            const clear = v => !(v.drmInfos && v.drmInfos.length) && !(v.video && v.video.encrypted) && !(v.audio && v.audio.encrypted);
            let cands = (m.variants || []).filter(clear);
            if (!cands.length) throw new Error('This DASH stream is DRM-protected and cannot be saved.');
            // MP4 variants merge into one .mp4. Shaka keeps one codec family per manifest, so a
            // stream played as VP9/WebM has only WebM left: those are saved as the original files.
            cands = cands.filter(v => v.video || v.audio);
            const mp4Only = cands.filter(v => (!v.video || isMp4(v.video)) && (!v.audio || isMp4(v.audio)));
            const active = (p.getVariantTracks() || []).find(t => t.active);
            const playing = active && cands.find(v => v.id === active.id);
            if (clip) {
                if (!playing) throw new Error('The active DASH quality is unavailable.');
                cands = [playing];
            }
            const mp4 = clip ? (!playing.video || isMp4(playing.video)) && (!playing.audio || isMp4(playing.audio)) : mp4Only.length > 0;
            if (mp4 && !clip) cands = mp4Only;
            const cap = this.qualityCap || Infinity;
            const capped = cands.filter(v => !v.video || (v.video.height || 0) <= cap);
            if (capped.length) cands = capped;
            const lang = playing && playing.audio ? playing.audio.language : null;
            const sameLang = cands.filter(v => !lang || !v.audio || v.audio.language === lang);
            if (sameLang.length) cands = sameLang;
            const bw = s => (s ? s.bandwidth || 0 : 0);
            cands.sort((a, b) => (bw(b.video) - bw(a.video)) || (bw(b.audio) - bw(a.audio)));
            const best = cands[0];
            const streams = [];
            if (best.video) streams.push([best.video, 'main']);
            if (best.audio && best.audio !== best.video && !best.video?.isAudioMuxedInVideo) streams.push([best.audio, 'audio']);
            // The init reference has no exported getUris(): find its URI getter by shape.
            const initUri = (init) => {
                for (const val of Object.values(init)) {
                    if (typeof val !== 'function' || val.length) continue;
                    try {
                        const out = val.call(init);
                        if (Array.isArray(out) && out.length && typeof out[0] === 'string' && /^https?:/i.test(out[0])) return out[0];
                    } catch (_) { /* not the getter */ }
                }
                return null;
            };
            const parts = [];
            for (const [s, role] of streams) {
                if (!s.segmentIndex) await s.createSegmentIndex();
                const segs = [];
                for (const ref of s.segmentIndex) {
                    if (!ref) continue;
                    const start = ref.getStartTime();
                    const end = ref.getEndTime();
                    if (clip && !(start < clip.end && end > clip.start)) continue;
                    const uri = (ref.getUris() || [])[0];
                    if (!uri) continue;
                    const sb = ref.getStartByte() || 0;
                    const eb = ref.getEndByte();
                    const range = eb != null ? `bytes=${sb}-${eb}` : sb ? `bytes=${sb}-` : null;
                    let map = null;
                    const init = ref.initSegmentReference;
                    if (init) {
                        const iu = initUri(init);
                        if (!iu) throw new Error('Could not read the DASH init segment.');
                        const isb = init.getStartByte() || 0;
                        const ieb = init.getEndByte();
                        map = { uri: iu, byteRange: ieb != null ? { offset: isb, length: ieb - isb + 1 } : null };
                    }
                    segs.push({ uri, range, start, duration: Math.max(0, end - start), map });
                }
                if (!segs.length) throw new Error(clip ? 'No segments in the A–B range.' : 'This DASH stream has no segments to save.');
                const webm = /webm/i.test(s.mimeType || '');
                const audio = role === 'audio';
                parts.push({ role, segs, ext: webm ? (audio ? 'weba' : 'webm') : (audio ? 'm4a' : 'mp4'), mime: s.mimeType || (audio ? 'audio/mp4' : 'video/mp4') });
            }
            if (!parts.length) throw new Error('This DASH stream has nothing to save.');
            return { parts, mp4, height: best.video ? best.video.height || 0 : 0 };
        }

        /** @param {{clip?: {start:number,end:number}}} [opts] save only the A–B range (HLS / DASH). */
        async startExport(opts = {}) {
            if (this.localPlayback) return;
            if (this.pickingSink || (this.exportState && this.exportState.running)) return;
            const clip = opts.clip || null;
            const hls = this.stream.type === 'hls';
            const dash = this.stream.type === 'dash';
            // DASH: build the plan first (it decides between one merged .mp4 and original files).
            let dashPlan = null;
            if (dash) {
                try {
                    this.pickingSink = true;
                    dashPlan = await this.dashExportPlan(clip);
                } catch (err) {
                    this.announce(err.message || String(err), 'warn');
                    return;
                } finally {
                    this.pickingSink = false;
                }
                if (this.closed) return;
            }
            const toMp4 = dash ? dashPlan.mp4 && !!window.VelostreamMux
                : hls && (this.settings.exportFormat || 'mp4') === 'mp4' && !!window.VelostreamMux && !!(window.shaka && shaka.transmuxer && shaka.transmuxer.TsTransmuxer);
            let title = safeFilename(this.$('.title').textContent || 'video').replace(/\.(m3u8|mpd|mp4|ts)$/i, '');
            if (clip) {
                const r0 = this.seekRange().start;
                const stamp = t => fmtTime(t - r0).replace(/:/g, '-');
                title = `${title}-clip-${stamp(clip.start)}-${stamp(clip.end)}`;
            }
            const st = { running: true, files: {}, status: 'Starting…', pct: 0, toMp4, sink: null, muxer: null, chain: Promise.resolve() };
            this.exportState = st;
            // Ask for the destination while the click's user activation is still valid.
            if (toMp4 || (!hls && !dash) || (dash && dashPlan.parts.length === 1)) {
                const ext = toMp4 ? 'mp4' : dash ? dashPlan.parts[0].ext : ((/\.(mp4|m4v|webm|mkv|mov|ogv)(\?|$)/i.exec(this.stream.url) || ['', 'mp4'])[1]);
                this.pickingSink = true;
                try {
                    st.sink = await ExportSink.pick(this.shadow, `${title}.${ext}`, toMp4 ? 'video/mp4' : '');
                } finally {
                    this.pickingSink = false;
                }
                if (this.exportState !== st || this.closed) { if (st.sink) await st.sink.abort(); return; }
                if (!st.sink) { this.exportState = null; this.announce('Download cancelled', 'download'); this.refreshPopover(); return; }
                st.outName = st.sink.filename;
            }
            st.isClip = !!clip;
            if (dash) {
                if (!toMp4 && dashPlan.parts.length > 1) this.announce('WebM stream: saving the original video and audio files', 'download');
                this.port.send({ type: 'EXPORT_START', dash: { parts: dashPlan.parts }, clip: !!clip });
            } else {
                this.port.send(clip ? { type: 'EXPORT_START', clip } : { type: 'EXPORT_START' });
            }
            this.announce(clip ? `Saving A–B clip (${fmtTime(clip.end - clip.start)})` : this.isLive() ? 'Saving live DVR buffer' : 'Download started', 'download');
            this.updateDownloadButton();
            this.refreshPopover();
        }

        updateDownloadButton() {
            const b = this.$('.btn-dl');
            const ring = b.querySelector('.ring');
            if (this.localPlayback) {
                window.VelostreamShared.replaceWithHTML(b.firstElementChild, icon('upload', 20));
                ring.hidden = true;
                b.setAttribute('aria-label', 'Open Local File');
                return;
            }
            const st = this.exportState;
            const live = this.isLive();
            b.classList.toggle('recording', !!this.recordingSince);
            const glyph = st && st.running ? 'stop' : live ? (this.recordingSince ? 'stop' : 'record') : 'download';
            window.VelostreamShared.replaceWithHTML(b.firstElementChild, icon(glyph));
            if (st && st.running) {
                ring.hidden = false;
                ring.querySelector('.prog').style.strokeDashoffset = String(119.38 * (1 - (st.pct || 0) / 100));
                b.setAttribute('aria-label', `Saving ${st.pct || 0}%. Activate to cancel.`);
            } else {
                ring.hidden = true;
                b.setAttribute('aria-label', live ? (this.recordingSince ? 'Stop recording and save' : 'Record live stream') : 'Download stream');
            }
        }

        /** Export messages are handled strictly in order (muxing and disk writes are async). */
        onExportMessage(msg) {
            const st = this.exportState || (this.exportState = { running: true, files: {}, status: '', pct: 0 });
            if (!st.chain) st.chain = Promise.resolve();
            st.chain = st.chain.then(async () => {
                if (!st.running && msg.type !== 'EXPORT_ERROR') return;
                await this.handleExportMessage(st, msg);
                if (msg.sequence != null) this.port.send({ type: 'EXPORT_ACK', jobId: msg.jobId, sequence: msg.sequence });
            }).catch((err) => {
                console.warn('[Velostream] Export failed', err);
                this.port.send({ type: 'EXPORT_CANCEL' });
                return this.handleExportMessage(st, { type: 'EXPORT_ERROR', error: `Saving failed: ${(err && err.message) || err}` });
            });
        }

        /** MP4 conversion failed on the first segment: save the original segments instead. */
        async exportFallbackToRaw(st, err) {
            console.warn('[Velostream] MP4 remux unavailable, saving original format', err);
            st.toMp4 = false;
            await st.muxer?.discardFragments();
            st.muxer = null;
            if (st.sink) { await st.sink.abort(); st.sink = null; }
            for (const f of Object.values(st.files)) {
                f.sink = new ExportSink(this.shadow, f.filename, f.mime);
                for (const chunk of f.raw || []) await f.sink.write(chunk);
                f.raw = null;
            }
            this.announce('MP4 conversion is not possible for this stream; saving the original format', 'warn');
        }

        async handleExportMessage(st, msg) {
            if (this.exportState !== st && msg.type !== 'EXPORT_ERROR') return;
            switch (msg.type) {
                case 'EXPORT_BEGIN': {
                    st.running = true;
                    const f = { filename: msg.filename, mime: msg.mime, raw: [], muxOk: false, sink: null };
                    st.files[msg.fileIndex] = f;
                    if (st.toMp4) {
                        if (!st.muxer) st.muxer = new window.VelostreamMux.ExportMuxer(st.sink, msg.fileCount || 1);
                    } else if (st.sink && (msg.fileCount || 1) === 1) {
                        f.sink = st.sink;                 // direct file: the destination picked on click
                    } else {
                        f.sink = new ExportSink(this.shadow, msg.filename, msg.mime);
                    }
                    st.status = `Saving ${st.toMp4 ? st.outName : msg.filename}`;
                    break;
                }
                case 'EXPORT_CHUNK': {
                    const f = st.files[msg.fileIndex];
                    if (!f || !msg.data) return;
                    if (st.toMp4 && st.muxer) {
                        // Keep the raw bytes until this file's first segment converted, for the fallback.
                        if (!f.muxOk) f.raw.push(new Uint8Array(msg.data).slice());
                        try {
                            if (msg.kind === 'init') await st.muxer.addInit(msg.fileIndex, msg.data);
                            else {
                                await st.muxer.addSegment(msg.fileIndex, msg.data, { start: msg.start, end: msg.end, url: msg.url });
                                f.muxOk = true;
                                f.raw = null;
                            }
                        } catch (err) {
                            if (f.muxOk) throw err;
                            await this.exportFallbackToRaw(st, err);
                        }
                        return;
                    }
                    if (f.sink) await f.sink.write(new Uint8Array(msg.data));
                    return;
                }
                case 'EXPORT_PROGRESS': {
                    const frac = msg.total ? msg.done / msg.total : 0;
                    st.pct = Math.round(((msg.fileIndex + frac) / msg.fileCount) * 100);
                    st.status = `${st.pct}% · ${fmtBytes(msg.bytes)}`;
                    if (st.pct % 25 === 0 && st.pct !== st.lastAnnounced) { st.lastAnnounced = st.pct; this.announceOnly(`Download ${st.pct}%`); }
                    break;
                }
                case 'EXPORT_FILE_DONE': {
                    const f = st.files[msg.fileIndex];
                    if (f && f.sink) {
                        st.status = `Finishing ${f.filename}…`;
                        this.updateDownloadButton();
                        await f.sink.close();
                        f.sink = null;
                        this.announce(`Saved ${f.filename}`, 'check');
                    }
                    break;
                }
                case 'EXPORT_COMPLETE':
                    if (st.toMp4 && st.muxer) {
                        st.status = 'Writing MP4…';
                        this.updateDownloadButton();
                        await st.muxer.finish();
                        const skipped = st.muxer.failedSegments;
                        this.announce(`Saved ${st.outName}${skipped ? ` (${skipped} damaged segment${skipped === 1 ? '' : 's'} skipped)` : ''}`, 'check');
                    }
                    st.running = false;
                    st.pct = 100;
                    st.status = 'Saved';
                    break;
                case 'EXPORT_ERROR':
                    st.running = false;
                    st.status = msg.error;
                    for (const f of Object.values(st.files)) { if (f.sink && f.sink !== st.sink) await f.sink.abort(); }
                    if (st.sink) await st.sink.abort();
                    st.files = {};
                    await st.muxer?.discardFragments();
                    st.muxer = null;
                    this.announce(msg.error, 'warn');
                    break;
                default:
                    break;
            }
            this.updateDownloadButton();
            if (this.popKind === 'studio' && this.studioTab === 'tools') this.refreshPopover();
        }

        // -----------------------------------------------------------------
        // Periodic updates
        // -----------------------------------------------------------------
        bufferAhead() {
            const v = this.video;
            const b = v.buffered;
            for (let i = 0; i < b.length; i++) {
                if (b.start(i) <= v.currentTime + 0.1 && b.end(i) >= v.currentTime) return b.end(i) - v.currentTime;
            }
            return 0;
        }

        onTick() {
            const v = this.video;
            // Self-heal the status: events from Shaka and <video> can arrive in an order that
            // leaves "Buffering" up while the playhead is clearly moving.
            const moving = !v.paused && v.readyState >= 3 && this.lastTickTime !== undefined && v.currentTime !== this.lastTickTime;
            this.lastTickTime = v.currentTime;
            if (moving && (this.status === 'buffering' || this.status === 'loading')) this.setBuffering(false);
            if (this.loop.a != null && this.loop.b != null && v.currentTime >= this.loop.b) {
                v.currentTime = this.loop.a;
                this.port.send({ type: 'SEEK', time: this.loop.a });
            }
            this.subs.render(v.currentTime);
            if (!this.dragging) this.renderTimeline();
            this.updateAmbient(false);
            if (this.audio.active) this.audio.tickLoudness();
            if (this.settings) this.tickHeat(false);
            this.updateViz();
            if (this.transcriptOpen) { this.renderTranscript(false); this.updateTranscriptActive(false); }
            this.tickCount = (this.tickCount || 0) + 1;
            if (this.tickCount % 2 === 0 && this.settings) this.checkSmartSkip();
        }

        /**
         * Ambient glow: sample the frame into a 32×18 canvas that sits behind the video, blurred and
         * scaled up by CSS. Runs at the 4 Hz tick, only while playing and visible (force: one frame
         * after a seek, pause or setting change). Drawing a cross-origin frame only taints this
         * canvas, which is fine: it is displayed, never read.
         */
        updateAmbient(force) {
            if (!this.settings || !this.settings.ambientMode || this.audioOnly || document.hidden) return;
            const v = this.video;
            if (!force && v.paused) return;
            if (v.readyState < 2 || !v.videoWidth) return;
            const c = this.ambientCanvas || (this.ambientCanvas = this.$('.ambient-canvas'));
            if (!c) return;
            try {
                const ctx = this.ambientCtx || (this.ambientCtx = c.getContext('2d', { alpha: false }));
                ctx.drawImage(v, 0, 0, c.width, c.height);
            } catch (_) { /* frame not ready */ }
        }

        // -----------------------------------------------------------------
        // Transcript drawer: every cue of the active subtitle track, live highlight, search, export
        // -----------------------------------------------------------------
        bindTranscript() {
            const d = this.$('.transcript');
            if (!d) return;
            this.trFollow = true;
            this.listen(d.querySelector('.tr-close'), 'click', () => this.toggleTranscript(false));
            const search = d.querySelector('.tr-search');
            let timer = 0;
            this.listen(search, 'input', () => { clearTimeout(timer); timer = setTimeout(() => this.renderTranscript(true), 120); });
            this.listen(search, 'keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const first = d.querySelector('.tr-row');
                if (first) first.focus();
            });
            const follow = d.querySelector('.tr-follow');
            this.listen(follow, 'click', () => this.setTranscriptFollow(!this.trFollow, true));
            this.listen(d.querySelector('.tr-copy'), 'click', () => {
                const cues = this.subs.activeCues() || [];
                if (!cues.length) return;
                this.copyText(cues.map(c => `[${fmtTime(this.cueMediaTime(c.start) - this.seekRange().start)}] ${c.text.replace(/\n/g, ' ')}`).join('\n'), 'Transcript copied');
            });
            this.listen(d.querySelector('.tr-export'), 'click', () => this.exportTranscriptSrt());
            const list = d.querySelector('.tr-list');
            // A manual scroll pauses following the spoken line; "Follow" resumes it.
            const manual = () => { if (this.trFollow) this.setTranscriptFollow(false, false); };
            this.listen(list, 'wheel', manual, { passive: true });
            this.listen(list, 'touchmove', manual, { passive: true });
            this.listen(list, 'keydown', (e) => { if (/^(Arrow(Up|Down)|Page(Up|Down)|Home|End)$/.test(e.key)) manual(); });
            this.listen(list, 'click', (e) => {
                const row = e.target.closest && e.target.closest('.tr-row');
                if (!row) return;
                const cues = this.subs.activeCues() || [];
                const c = cues[+row.dataset.i];
                if (!c) return;
                this.seekTo(this.cueMediaTime(c.start) + 0.01, true);
                if (this.video.paused) this.subs.render(this.video.currentTime);
            });
            // Keep page shortcuts out of the drawer (typing in search, arrowing the list).
            this.listen(d, 'keydown', (e) => { if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation(); });
        }

        /** Subtitle-file time -> media time (inverse of SubtitleEngine.cueTime). */
        cueMediaTime(t) { return t * (this.subs.speed || 1) + this.subs.offset; }

        setTranscriptFollow(on, announce) {
            this.trFollow = on;
            const b = this.$('.tr-follow');
            if (b) b.setAttribute('aria-pressed', String(on));
            if (announce) this.announceOnly(on ? 'Following the spoken line' : 'Stopped following');
            if (on) this.updateTranscriptActive(true);
        }

        toggleTranscript(on = !this.transcriptOpen) {
            const d = this.$('.transcript');
            if (!d) return;
            this.transcriptOpen = !!on;
            d.hidden = !on;
            if (on) {
                this.trSig = '';
                this.renderTranscript(true);
                this.setTranscriptFollow(true, false);
                this.showControls(true);
                d.querySelector('.tr-search').focus({ preventScroll: true });
                this.announceOnly('Transcript opened');
            } else {
                this.announceOnly('Transcript closed');
                if (this.root.contains(this.shadow.activeElement) || d.contains(this.shadow.activeElement)) this.$('.btn-cc').focus({ preventScroll: true });
                this.scheduleHide();
            }
            if (this.popKind === 'captions') this.refreshPopover();
        }

        renderTranscript(force) {
            if (!this.transcriptOpen) return;
            const d = this.$('.transcript');
            const cues = this.subs.source !== 'off' ? (this.subs.activeCues() || []) : [];
            const q = d.querySelector('.tr-search').value.trim().toLowerCase();
            const last = cues[cues.length - 1];
            const sig = `${this.subs.source}|${cues.length}|${cues[0] ? cues[0].start : ''}|${last ? last.end : ''}|${this.subs.offset}|${this.subs.speed}|${q}`;
            if (!force && sig === this.trSig) return;
            this.trSig = sig;
            const list = d.querySelector('.tr-list');
            const empty = d.querySelector('.tr-empty');
            const count = d.querySelector('.tr-count');
            if (!cues.length) {
                setHTML(list, '');
                empty.hidden = false;
                empty.textContent = this.subs.source === 'off' ? 'Turn on subtitles (C) to see the transcript.' : 'No subtitle lines loaded yet.';
                count.textContent = '';
                this.trActive = -1;
                return;
            }
            empty.hidden = true;
            const r0 = this.seekRange().start;
            const parts = [];
            let matches = 0;
            for (let i = 0; i < cues.length; i++) {
                const text = cues[i].text.replace(/\n/g, ' ');
                if (q && !text.toLowerCase().includes(q)) continue;
                matches++;
                parts.push(`<li><button type="button" class="tr-row" data-i="${i}"><span class="tr-time">${fmtTime(Math.max(0, this.cueMediaTime(cues[i].start) - r0))}</span><span class="tr-text">${highlight(text, q)}</span></button></li>`);
            }
            setHTML(list, parts.join(''));
            count.textContent = q ? `${matches} / ${cues.length}` : `${cues.length} lines`;
            if (q && !matches) { empty.hidden = false; empty.textContent = `No lines contain “${d.querySelector('.tr-search').value.trim()}”.`; }
            this.trActive = -1;
            this.updateTranscriptActive(true);
        }

        /** Highlight the line being spoken (or the last one before now) and keep it in view. */
        updateTranscriptActive(force) {
            if (!this.transcriptOpen) return;
            const cues = this.subs.activeCues() || [];
            if (!cues.length) return;
            const t = this.subs.cueTime(this.video.currentTime);
            let lo = 0;
            let hi = cues.length - 1;
            let idx = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (cues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
            }
            if (idx === this.trActive && !force) return;
            const list = this.$('.tr-list');
            const prev = list.querySelector('.tr-row.active');
            if (prev) { prev.classList.remove('active'); prev.removeAttribute('aria-current'); }
            this.trActive = idx;
            if (idx < 0) return;
            const row = list.querySelector(`.tr-row[data-i="${idx}"]`);
            if (!row) return;
            row.classList.add('active');
            row.setAttribute('aria-current', 'true');
            if (!this.trFollow) return;
            // Scroll the list only (scrollIntoView could also scroll the page around the player).
            const top = row.offsetTop - list.offsetTop;
            if (top < list.scrollTop + 8 || top + row.offsetHeight > list.scrollTop + list.clientHeight - 8) {
                list.scrollTop = Math.max(0, top - list.clientHeight / 3);
            }
        }

        exportTranscriptSrt() {
            const cues = this.subs.activeCues() || [];
            if (!cues.length) { this.announce('No subtitle lines to save', 'warn'); return; }
            const ts = (s) => {
                const ms = Math.max(0, Math.round(s * 1000));
                const p = (n, w) => String(n).padStart(w, '0');
                return `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor(ms / 60000) % 60, 2)}:${p(Math.floor(ms / 1000) % 60, 2)},${p(ms % 1000, 3)}`;
            };
            // Times as heard in this video: the subtitle offset and speed are baked in.
            const srt = cues.map((c, i) => `${i + 1}\n${ts(this.cueMediaTime(c.start))} --> ${ts(this.cueMediaTime(c.end))}\n${c.text}\n`).join('\n');
            const name = `${safeFilename(this.$('.title').textContent || 'video')}.srt`;
            downloadBlob(this.shadow, new Blob([srt], { type: 'application/x-subrip' }), name, true);
            this.announce('Transcript saved as .srt', 'download');
        }

        /**
         * Audio-only visualizer: 24 mirrored pill bars from the analyser spectrum. Runs on rAF only
         * while audio-only + playing + visible + the Web Audio graph exists; with reduced motion it
         * redraws at the 4 Hz tick instead. Hidden when there is no audio graph (non-CORS file or
         * before the first tap), since then there is nothing to measure.
         */
        updateViz() {
            const c = this.vizCanvas || (this.vizCanvas = this.$('.audio-viz'));
            if (!c) return;
            const run = this.audioOnly && this.audio.active && !this.video.paused && !document.hidden;
            c.hidden = !(this.audioOnly && this.audio.active);
            if (!run) { if (this.vizRaf) { cancelAnimationFrame(this.vizRaf); this.vizRaf = 0; } return; }
            const s = this.settings || {};
            const reduced = s.reducedMotion === 'on' || (s.reducedMotion !== 'off' && matchMedia('(prefers-reduced-motion: reduce)').matches);
            if (reduced) { if (this.vizRaf) { cancelAnimationFrame(this.vizRaf); this.vizRaf = 0; } this.drawViz(); return; }
            if (this.vizRaf) return;
            const loop = () => {
                this.vizRaf = 0;
                if (this.closed || !(this.audioOnly && this.audio.active && !this.video.paused && !document.hidden)) return;
                this.drawViz();
                this.vizRaf = requestAnimationFrame(loop);
            };
            this.vizRaf = requestAnimationFrame(loop);
        }

        drawViz() {
            const c = this.vizCanvas;
            const spec = this.audio.spectrum();
            if (!c || !spec) return;
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const W = Math.round(c.clientWidth * dpr) || 280;
            const H = Math.round(c.clientHeight * dpr) || 80;
            if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
            const ctx = this.vizCtx || (this.vizCtx = c.getContext('2d'));
            ctx.clearRect(0, 0, W, H);
            if (!this.vizColor || this.vizColorAt !== this.settings.theme) {
                this.vizColor = getComputedStyle(this.root).getPropertyValue('--fs-accent').trim() || '#0A84FF';
                this.vizColorAt = this.settings.theme;
            }
            ctx.fillStyle = this.vizColor;
            const bars = 24;
            const gap = W / bars * 0.35;
            const bw = W / bars - gap;
            // Log-spaced bins from ~60 Hz to ~12 kHz (bin width = sampleRate / fftSize).
            const n = spec.length;
            const lo = 2;
            const hi = Math.max(lo + bars, Math.floor(n * 0.55));
            for (let i = 0; i < bars; i++) {
                const a = Math.floor(lo * Math.pow(hi / lo, i / bars));
                const b = Math.max(a + 1, Math.floor(lo * Math.pow(hi / lo, (i + 1) / bars)));
                let m = 0;
                for (let k = a; k < b && k < n; k++) m = Math.max(m, spec[k]);
                const h = Math.max(bw, (m / 255) * H * 0.92);
                const x = i * (bw + gap) + gap / 2;
                const y = (H - h) / 2; // mirrored around the centre line
                const r = Math.min(bw / 2, h / 2);
                ctx.beginPath();
                if (ctx.roundRect) ctx.roundRect(x, y, bw, h, r); else ctx.rect(x, y, bw, h);
                ctx.fill();
            }
        }

        onSecond() {
            this.secondTick++;
            this.sendTelemetry(Date.now() - this.lastVariantsSentAt > 10000);
            this.renderStats();
            this.checkSleep();
            this.updateSkipIntro();
            if (this.secondTick % 5 === 0) this.saveHistory(false);
            const live = this.isLive();
            if (live !== this.wasLive) { this.wasLive = live; this.updateDownloadButton(); }
        }

        /**
         * Chapter-aware skip: inside a chapter titled like an opening, recap, ending or preview
         * (10 s – 4 min long) the pill offers to jump to that chapter's end. Otherwise the plain
         * "+N s" skip is offered in the opening stretch of longer on-demand videos.
         */
        updateSkipIntro() {
            const v = this.video;
            const d = Number.isFinite(v.duration) ? v.duration : 0;
            const pill = this.$('.skip-intro');
            const target = this.smartSkipChapter(v.currentTime);
            this.smartSkip = target;
            if (target) {
                const text = `Skip ${target.kind}`;
                if (pill.dataset.mode !== text) {
                    pill.dataset.mode = text;
                    pill.querySelector('span').textContent = text;
                    pill.setAttribute('aria-label', `${text}, jump to ${fmtSpoken(target.end - this.seekRange().start)}`);
                }
                pill.hidden = false;
                return;
            }
            if (pill.dataset.mode) {
                delete pill.dataset.mode;
                const s = this.settings.skipSeconds;
                pill.querySelector('span').textContent = `+${s}s`;
                pill.setAttribute('aria-label', `Skip intro, forward ${s} seconds`);
            }
            pill.hidden = !(!this.isLive() && d > 300 && v.currentTime < Math.min(900, d * 0.25));
        }

        /** {kind, end} when t is inside a skippable chapter, else null. */
        smartSkipChapter(t) {
            const list = this.chapters;
            if (!list || !list.length || this.isLive()) return null;
            const c = this.chapterAt(t);
            if (!c) return null;
            const kind = skipKind(c.title);
            if (!kind) return null;
            const i = list.indexOf(c);
            const next = list[i + 1];
            const end = next ? next.start : this.seekRange().end;
            const len = end - c.start;
            if (!(len >= 10 && len <= 240) || end - t < 2) return null;
            return { kind, end };
        }

        sendTelemetry(withVariants) {
            if (this.localPlayback) return;
            const v = this.video;
            const msg = { type: 'TELEMETRY', currentTime: v.currentTime, bufferAhead: this.bufferAhead(), paused: v.paused, qualityCap: this.qualityCap, seekRangeStart: this.seekRange().start, seeking: v.seeking };
            if (this.player && this.mode === 'mse') {
                const tracks = this.currentVariants();
                const active = tracks.find(t => t.active);
                msg.activeVariantId = active ? active.id : null;
                if (withVariants) {
                    msg.variants = tracks.map(t => ({ id: t.id, bandwidth: t.bandwidth, height: t.height || 0 }));
                    this.lastVariantsSentAt = Date.now();
                }
            }
            this.port.send(msg);
        }

        renderTimeline() {
            const v = this.video;
            const r = this.seekRange();
            const span = Math.max(0.001, r.end - r.start);
            const cur = clamp(v.currentTime - r.start, 0, span);
            const pct = (cur / span) * 100;
            this.$('.played').style.width = `${pct}%`;
            this.$('.thumb').style.left = `${pct}%`;
            const live = this.isLive();
            this.$('.t-left').textContent = fmtTime(cur);
            const tr = this.$('.t-right');
            if (live) {
                const behind = span - cur;
                tr.classList.add('live');
                tr.classList.toggle('behind', behind > 6);
                tr.textContent = behind > 6 ? `−${fmtTime(behind)}` : 'LIVE';
                tr.setAttribute('aria-label', behind > 6 ? `${fmtSpoken(behind)} behind live. Jump to live.` : 'At live edge');
            } else {
                tr.classList.remove('live', 'behind');
                tr.textContent = this.showRemaining ? `−${fmtTime(span - cur)}` : fmtTime(span);
            }
            const tl = this.$('.timeline');
            tl.setAttribute('aria-valuemax', String(Math.round(span)));
            tl.setAttribute('aria-valuenow', String(Math.round(cur)));
            tl.setAttribute('aria-valuetext', `${fmtSpoken(cur)} of ${live ? 'live window' : fmtSpoken(span)}`);

            const mse = [];
            for (let i = 0; i < v.buffered.length; i++) {
                const s = clamp((v.buffered.start(i) - r.start) / span * 100, 0, 100);
                const e = clamp((v.buffered.end(i) - r.start) / span * 100, 0, 100);
                mse.push(`<div class="layer buf-mse" style="left:${s}%;width:${e - s}%"></div>`);
            }
            const mseHtml = mse.join('');
            if (mseHtml !== this.lastMseHtml) { this.lastMseHtml = mseHtml; setHTML(this.$('.layers-mse'), mseHtml); }

            // Velostream IndexedDB prefetch (engine timeline == presentation time for VOD HLS)
            let cacheHtml = '';
            if (this.engineStats && !live && this.stream && this.stream.type === 'hls') {
                cacheHtml = (this.engineStats.cachedRanges || []).map(cr => {
                    const s = clamp((cr.start - r.start) / span * 100, 0, 100);
                    const e = clamp((cr.end - r.start) / span * 100, 0, 100);
                    return `<div class="layer buf-cache" style="left:${s}%;width:${e - s}%"></div>`;
                }).join('');
            }
            if (cacheHtml !== this.lastCacheHtml) { this.lastCacheHtml = cacheHtml; setHTML(this.$('.layers-cache'), cacheHtml); }
        }

        // -----------------------------------------------------------------
        // Chapters (HLS DATERANGE, Shaka chapter tracks, site WebVTT chapters) & thumbnails
        // -----------------------------------------------------------------
        addChapters(list) {
            const map = new Map((this.chapters || []).map(c => [Math.round(c.start * 10), c]));
            for (const c of list) {
                if (!c || !Number.isFinite(c.start) || !c.title) continue;
                map.set(Math.round(c.start * 10), { start: c.start, title: String(c.title).slice(0, 120) });
            }
            this.chapters = [...map.values()].sort((a, b) => a.start - b.start);
            this.renderMarks();
        }

        chapterAt(t) {
            const list = this.chapters;
            if (!list || !list.length) return null;
            let cur = null;
            for (const c of list) { if (c.start <= t + 0.05) cur = c; else break; }
            return cur;
        }

        onDateRangeMetadata(e) {
            const p = e && e.payload;
            if (!p || typeof p.key !== 'string' || typeof p.data !== 'string') return;
            if (!/^(X-)?(TITLE|CHAPTER|COM-[A-Z-]*TITLE|NAME)$/i.test(p.key) && !/chapter/i.test(e.metadataType || '')) return;
            if (/^ID$/i.test(p.key)) return;
            this.addChapters([{ start: e.startTime, title: p.data }]);
        }

        async loadChapters() {
            // Shaka chapter tracks (DASH/HLS manifests that declare them).
            if (this.player && this.mode === 'mse' && this.player.getChaptersTracks) {
                try {
                    const tracks = this.player.getChaptersTracks();
                    if (tracks.length) {
                        const lang = (tracks.find(t => t.language) || tracks[0]).language;
                        const chs = await this.player.getChaptersAsync(lang);
                        this.addChapters(chs.map(c => ({ start: c.startTime, title: c.title })));
                    }
                } catch (_) { /* no chapters */ }
            }
            // Captured site <track kind="chapters">.
            for (const t of this.capturedChapters || []) {
                const text = t.vtt || (t.url ? await this.fetchText(t.url) : '');
                const cues = text ? parseSubtitleFile(text) : [];
                this.addChapters(cues.map(c => ({ start: c.start, title: c.text.replace(/\n/g, ' ') })));
            }
        }

        /** Thumbnail preview from an image track (EXT-X-IMAGE-STREAM-INF / DASH thumbnails). */
        updateTipThumb(t) {
            const box = this.$('.tip-thumb');
            if (this.mode === 'native') { this.fileThumb(t, box); return; }
            if (!this.player || this.mode !== 'mse' || !this.player.getImageTracks) { box.hidden = true; return; }
            if (this.imageTrackId === undefined) {
                try {
                    const tracks = this.player.getImageTracks();
                    const best = tracks.sort((a, b) => (b.width || 0) - (a.width || 0)).find(x => (x.width || 0) <= 480) || tracks[0];
                    this.imageTrackId = best ? best.id : null;
                } catch (_) { this.imageTrackId = null; }
            }
            if (this.imageTrackId == null) { box.hidden = true; return; }
            const key = Math.floor(t);
            if (this.thumbKey === key) return;
            this.thumbKey = key;
            clearTimeout(this.thumbTimer);
            this.thumbTimer = setTimeout(async () => {
                try {
                    const th = await this.player.getThumbnails(this.imageTrackId, t);
                    if (!th || !th.uris || !th.uris.length || this.thumbKey !== key) return;
                    const url = await this.thumbImage(th.uris[0], th.startByte, th.endByte);
                    if (!url || this.thumbKey !== key) return;
                    const w = Math.min(160, th.width || 160);
                    const scale = w / (th.width || w);
                    box.style.width = `${w}px`;
                    box.style.height = `${Math.round((th.height || 90) * scale)}px`;
                    const stale = box.querySelector('canvas'); // a file preview from an earlier stream
                    if (stale) stale.remove();
                    box.style.backgroundImage = `url("${url}")`;
                    box.style.backgroundSize = th.imageWidth ? `${th.imageWidth * scale}px ${th.imageHeight * scale}px` : 'cover';
                    box.style.backgroundPosition = `-${(th.positionX || 0) * scale}px -${(th.positionY || 0) * scale}px`;
                    box.hidden = false;
                } catch (_) { box.hidden = true; }
            }, 60);
        }

        /**
         * Seek previews for direct video files (which carry no thumbnail track): a hidden, muted
         * second <video> on the same URL seeks to the hovered time and the frame is copied into a
         * small canvas, about 200 per video (one per 1/200 of the duration, at least 1 s apart).
         * Only the most recent hover is generated (older requests are dropped), a stuck seek
         * times out after 4 s, and the nearest finished preview is shown meanwhile. The helper
         * element loads without CORS: its frames are only displayed, never read back.
         */
        fileThumb(t, box) {
            const v = this.video;
            const dur = v.duration;
            if (this.settings.fileThumbnails === false || !Number.isFinite(dur) || dur <= 0 || !this.stream) { box.hidden = true; return; }
            const T = this.thumbGen || (this.thumbGen = { cache: new Map(), want: null, busy: false, el: null, failed: false, step: 1, box: null });
            if (T.failed) { box.hidden = true; return; }
            T.step = Math.max(1, dur / 200);
            T.box = box;
            const key = clamp(Math.round(t / T.step), 0, Math.floor(dur / T.step));
            T.want = key;
            let near = T.cache.get(key);
            for (let d = 1; !near && d <= 4; d++) near = T.cache.get(key - d) || T.cache.get(key + d);
            if (near) this.drawFileThumb(box, near); else box.hidden = true;
            this.pumpFileThumbs();
        }

        pumpFileThumbs() {
            const T = this.thumbGen;
            if (!T || T.busy || T.failed || this.closed || T.want == null || T.cache.has(T.want)) return;
            if (!T.el) {
                const el = document.createElement('video');
                el.muted = true;
                el.playsInline = true;
                el.preload = 'auto';
                el.addEventListener('error', () => { T.failed = true; });
                el.src = this.stream.url;
                T.el = el;
            }
            const el = T.el;
            const key = T.want;
            T.busy = true;
            const done = () => {
                el.removeEventListener('seeked', done);
                clearTimeout(T.timer);
                if (this.thumbGen !== T) return;
                try {
                    if (el.videoWidth) {
                        const c = document.createElement('canvas');
                        c.width = 160;
                        c.height = Math.max(1, Math.round(160 * el.videoHeight / el.videoWidth));
                        c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
                        T.cache.set(key, c);
                        if (T.cache.size > 240) T.cache.delete(T.cache.keys().next().value);
                        if (T.want === key && T.box) this.drawFileThumb(T.box, c);
                    }
                } catch (_) { /* frame not decodable: leave this one out */ }
                T.busy = false;
                this.pumpFileThumbs();
            };
            el.addEventListener('seeked', done);
            T.timer = setTimeout(done, 4000);
            el.currentTime = Math.max(0, key * T.step);
        }

        drawFileThumb(box, src) {
            let c = box.querySelector('canvas');
            if (!c) {
                c = document.createElement('canvas');
                c.setAttribute('aria-hidden', 'true');
                c.style.display = 'block';
                c.style.borderRadius = '8px';
                box.appendChild(c);
            }
            if (c.width !== src.width || c.height !== src.height) { c.width = src.width; c.height = src.height; }
            c.getContext('2d').drawImage(src, 0, 0);
            box.style.backgroundImage = 'none';
            box.style.width = `${src.width}px`;
            box.style.height = `${src.height}px`;
            box.hidden = false;
        }

        resetFileThumbs() {
            const T = this.thumbGen;
            this.thumbGen = null;
            if (!T) return;
            clearTimeout(T.timer);
            if (T.el) { T.el.removeAttribute('src'); try { T.el.load(); } catch (_) { /* ignore */ } }
            T.cache.clear();
        }

        /** Thumbnail sprites are fetched through the engine (site Referer) and cached as blob URLs. */
        clearThumbCache() {
            if (!this.thumbCache) return;
            for (const url of this.thumbCache.values()) url.then(u => { if (u) URL.revokeObjectURL(u); });
            this.thumbCache.clear();
        }

        async thumbImage(uri, startByte, endByte) {
            if (!this.thumbCache) this.thumbCache = new Map();
            const key = `${uri}|${startByte || 0}|${endByte || 0}`;
            if (this.thumbCache.has(key)) return this.thumbCache.get(key);
            const p = new Promise(resolve => {
                const reqId = `n${++this.netSeq}`;
                const headers = endByte ? { Range: `bytes=${startByte || 0}-${endByte}` } : {};
                this.net.set(reqId, {
                    resolve: (res) => resolve(res && res.ok && res.data ? URL.createObjectURL(new Blob([res.data])) : null),
                    reject: () => resolve(null)
                });
                this.port.send({ type: 'REQUEST', reqId, url: uri, method: 'GET', headers, kind: 'other' });
            });
            this.thumbCache.set(key, p);
            if (this.thumbCache.size > 60) {
                const [firstKey, firstVal] = this.thumbCache.entries().next().value;
                this.thumbCache.delete(firstKey);
                Promise.resolve(firstVal).then(u => { if (u) URL.revokeObjectURL(u); });
            }
            return p;
        }

        renderMarks() {
            const r = this.seekRange();
            const span = Math.max(0.001, r.end - r.start);
            const pos = t => clamp((t - r.start) / span * 100, 0, 100);
            let html = '';
            for (const c of this.chapters || []) if (c.start > r.start + 0.5) html += `<div class="mark chapter" style="left:${pos(c.start)}%"></div>`;
            for (const b of this.bookmarks) html += `<div class="mark" style="left:${pos(b.t)}%"></div>`;
            if (this.loop.a != null) html += `<div class="mark" style="left:${pos(this.loop.a)}%"></div>`;
            if (this.loop.b != null) html += `<div class="mark" style="left:${pos(this.loop.b)}%"></div>`;
            for (const t of [this.clip.start, this.clip.end]) {
                if (t != null) html += `<div class="mark clip-mark" style="left:${pos(t)}%"></div>`;
            }
            setHTML(this.$('.marks'), html);
            // Chapters scrubber: cut a 3 px gap into the bar at every chapter start.
            const track = this.$('.track');
            const cuts = this.settings && this.settings.look.scrubber === 'chapters'
                ? (this.chapters || []).filter(c => c.start > r.start + 0.5 && c.start < r.end - 0.5).map(c => pos(c.start).toFixed(3)) : [];
            const mask = cuts.length
                ? `linear-gradient(to right, #000 0, ${cuts.map(p => `#000 calc(${p}% - 1.5px), transparent calc(${p}% - 1.5px), transparent calc(${p}% + 1.5px), #000 calc(${p}% + 1.5px)`).join(', ')}, #000 100%)`
                : '';
            if (track.dataset.mask !== mask) {
                track.dataset.mask = mask;
                track.style.setProperty('-webkit-mask-image', mask || 'none');
                track.style.setProperty('mask-image', mask || 'none');
            }
            this.updateAbButton();
            const lr = this.$('.loop-range');
            if (this.loop.a != null && this.loop.b != null) {
                lr.hidden = false;
                lr.style.left = `${pos(this.loop.a)}%`;
                lr.style.width = `${pos(this.loop.b) - pos(this.loop.a)}%`;
            } else {
                lr.hidden = true;
            }
        }

        /** Ask the browser once per codec/size whether decoding is smooth and hardware-backed. */
        probeDecoder(codec, w, h, bitrate, fps) {
            if (!codec || !w || !navigator.mediaCapabilities || !navigator.mediaCapabilities.decodingInfo) return;
            const key = `${codec}|${w}x${h}`;
            if (this.decoderKey === key) return;
            this.decoderKey = key;
            this.decoderInfo = 'Checking…';
            navigator.mediaCapabilities.decodingInfo({
                type: 'media-source',
                video: { contentType: `video/mp4; codecs="${codec}"`, width: w, height: h, bitrate: Math.max(1, Math.round(bitrate || 1e6)), framerate: Math.max(1, Math.round(fps || 30)) }
            }).then(r => {
                if (this.decoderKey !== key) return;
                this.decoderInfo = !r.supported ? 'Not supported' : `${r.smooth ? 'Smooth' : 'May stutter'} · ${r.powerEfficient ? 'hardware (power efficient)' : 'software'}`;
            }, () => { if (this.decoderKey === key) this.decoderInfo = 'Unknown'; });
        }

        renderStats() {
            if (!this.settings || !this.settings.showStats) return;
            const v = this.video;
            let fps = 0;
            let dropped = 0;
            if (v.getVideoPlaybackQuality) {
                const q = v.getVideoPlaybackQuality();
                const now = performance.now();
                if (this.lastQuality.at) fps = ((q.totalVideoFrames - this.lastQuality.total) * 1000) / (now - this.lastQuality.at);
                dropped = q.droppedVideoFrames;
                this.lastQuality = { total: q.totalVideoFrames, at: now };
            }
            const e = this.engineStats || {};
            let codecs = '';
            let streamBw = 0;
            if (this.player) {
                try { const st = this.player.getStats(); codecs = st.currentCodecs || ''; streamBw = st.streamBandwidth; } catch (_) { /* ignore */ }
            }
            const total = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : 0;
            const parts = String(codecs).split(',').map(x => x.trim()).filter(Boolean);
            const vCodec = parts.find(c => /^(avc|hvc|hev|av01|vp0?[89]|dvh)/i.test(c)) || '';
            const aCodec = parts.find(c => /^(mp4a|opus|ac-?3|ec-?3|flac|vorbis|mp3)/i.test(c)) || '';
            this.probeDecoder(vCodec, v.videoWidth, v.videoHeight, streamBw, fps);
            const gpu = this.gpu && this.gpu.active ? this.gpu : null;
            let gpuText = 'Off';
            if (gpu) {
                const g = gpu.guard || {};
                const ms = g.gpuN ? g.gpu / g.gpuN : (g.frames ? g.cpu / g.frames : 0);
                const eff = this.effectiveShader().preset;
                const preset = eff === 'off' ? 'Colour grading only' : (GPU_PRESETS.find(p => p[0] === eff) || ['', 'On'])[1];
                // The pipeline reports what really ran (e.g. the Anime4K-lite fallback, "+ colour").
                const pathNote = gpu.path && eff !== 'off' && !/^colour only$/.test(gpu.path) ? ` (${gpu.path})` : '';
                gpuText = `${preset}${pathNote} · ${this.glCanvas.width}×${this.glCanvas.height}${ms ? ` · ${ms.toFixed(1)} ms/frame` : ''}`;
            } else if (this.gpuBlocked) {
                gpuText = 'Unavailable';
            }
            const fx = [];
            const a = this.settings.audio || {};
            if (this.rate() !== 1) fx.push(fmtRate(this.rate()));
            if (a.boost > 100) fx.push(`boost ${a.boost}%`);
            if (a.preset && a.preset !== 'normal') fx.push(`EQ ${a.preset}`);
            if (a.channels && a.channels !== 'stereo') fx.push(a.channels);
            if (a.delayMs) fx.push(`delay ${a.delayMs} ms`);
            if (a.loudnessNorm) fx.push(this.audio.active ? 'smart loudness' : 'smart loudness (waiting for first tap)');
            if ((a.width ?? 100) !== 100) fx.push(`width ${a.width}%`);
            if (a.dialogue) fx.push(`dialogue +${a.dialogue}%`);
            if (a.crossfeed) fx.push('crossfeed');
            if (Object.keys(DEFAULT_FILTERS).some(k => this.filters[k] !== DEFAULT_FILTERS[k])) fx.push('colour filters');
            if (this.settings.ambientMode) fx.push('ambient glow');
            if (this.gpuColor()) {
                const cp = window.VelostreamShared.COLOR_PRESETS[(this.settings.color || {}).preset];
                fx.push(`look ${cp ? cp.label : 'custom'}`);
            }
            const rows = [
                ['Stream', `${String(this.stream.type || '').toUpperCase()} · ${this.mode === 'mse' ? 'MSE' : `direct${this.audio && this.audio.corsOk ? ' · CORS' : ''}`}`],
                ['Resolution', v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '—'],
                ['Frame rate', fps ? `${fps.toFixed(1)} fps` : '—'],
                ['Dropped frames', total ? `${dropped} (${((dropped / total) * 100).toFixed(1)}%)` : String(dropped)],
                ['Variant', fmtBitrate(streamBw)],
                ['Video codec', vCodec ? `${codecName(vCodec)} · ${vCodec}` : '—'],
                ['Audio codec', aCodec ? `${codecName(aCodec)} · ${aCodec}` : '—'],
                ['Decoder', this.decoderInfo || '—'],
                ['GPU enhancement', gpuText],
                ['Effects', fx.length ? fx.join(', ') : 'None'],
                ['Bandwidth', fmtBitrate(e.bandwidth)],
                ['Workers', `${e.activeWorkers || 0} / ${e.concurrency || 0}${e.accelerated ? ' · range ×4' : ''}`],
                ['Queued', String(e.queued || 0)],
                ['Player buffer', `${this.bufferAhead().toFixed(1)} s`],
                ['Prefetched', `${(e.cachedAhead || 0).toFixed(1)} s`],
                ['IndexedDB', `${fmtBytes(e.cacheBytes)} · ${e.cachedSegments || 0} seg`],
                ['Hits / misses', `${e.cacheHits || 0} / ${e.cacheMisses || 0}`]
            ];
            if (this.isLive()) rows.push(['Live DVR', fmtTime(e.dvrSeconds || 0)]);
            setHTML(this.$('.stats dl'), rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join(''));
        }

        // -----------------------------------------------------------------
        // Timeline interaction
        // -----------------------------------------------------------------
        bindTimeline() {
            const tl = this.$('.timeline');
            const tip = this.$('.tip');
            const timeAt = (clientX) => {
                const rect = tl.getBoundingClientRect();
                const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
                const r = this.seekRange();
                return { t: r.start + ratio * (r.end - r.start), ratio, r };
            };
            const tipText = tip.querySelector('.tip-text');
            const tipChapter = tip.querySelector('.tip-chapter');
            const showTip = (clientX) => {
                const { t, ratio, r } = timeAt(clientX);
                tipText.textContent = fmtTime(t - r.start);
                tipText.title = fmtDelta(t - this.video.currentTime);
                const ch = this.chapterAt(t);
                tipChapter.hidden = !ch;
                if (ch) tipChapter.textContent = ch.title;
                this.updateTipThumb(t);
                const rect = tl.getBoundingClientRect();
                const bounds = this.root.getBoundingClientRect();
                const half = Math.min(tip.offsetWidth / 2, Math.max(0, bounds.width / 2 - 12));
                const x = clamp(rect.left + ratio * rect.width, bounds.left + 12 + half, bounds.right - 12 - half);
                tip.style.left = (x - rect.left) + 'px';
                return t;
            };
            this.listen(tl, 'pointermove', (e) => { if (!this.dragging) showTip(e.clientX); });
            this.listen(tl, 'pointerdown', (e) => {
                if (this.locked) return;
                e.preventDefault();
                e.stopPropagation();
                tl.setPointerCapture(e.pointerId);
                this.dragging = true;
                tl.classList.add('dragging');
                this.dragTime = showTip(e.clientX);
                this.previewTimeline(this.dragTime);
            });
            this.listen(tl, 'pointermove', (e) => {
                if (!this.dragging) return;
                this.dragTime = showTip(e.clientX);
                this.previewTimeline(this.dragTime);
            });
            const end = (e) => {
                if (!this.dragging) return;
                this.dragging = false;
                tl.classList.remove('dragging');
                try { tl.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
                this.seekTo(this.dragTime, false);
                this.scheduleHide();
            };
            this.listen(tl, 'pointerup', end);
            this.listen(tl, 'pointercancel', end);
            this.listen(tl, 'keydown', (e) => {
                const r = this.seekRange();
                const span = r.end - r.start;
                let handled = true;
                switch (e.key) {
                    case 'ArrowLeft': case 'ArrowDown': this.seekBy(-5, false); break;
                    case 'ArrowRight': case 'ArrowUp': this.seekBy(5, false); break;
                    case 'PageDown': this.seekBy(-Math.max(30, span / 10), false); break;
                    case 'PageUp': this.seekBy(Math.max(30, span / 10), false); break;
                    case 'Home': this.seekTo(r.start, false); break;
                    case 'End': this.seekTo(r.end, false); break;
                    default: handled = false;
                }
                if (handled) { e.preventDefault(); e.stopPropagation(); this.later(50, () => this.renderTimeline()); }
            });
        }

        previewTimeline(t) {
            const r = this.seekRange();
            const pct = clamp((t - r.start) / Math.max(0.001, r.end - r.start), 0, 1) * 100;
            this.$('.played').style.width = `${pct}%`;
            this.$('.thumb').style.left = `${pct}%`;
        }

        // -----------------------------------------------------------------
        // Gestures (touch + mouse) and mini-player dragging
        // -----------------------------------------------------------------
        bindGestures() {
            const layer = this.$('.gesture');
            const pointers = new Map();
            let g = null;
            let lastTap = null;
            let tapTimer = null;
            let boostRestore = null;
            const gs = () => (this.settings ? this.settings.gestures : { enabled: false });
            const side = (x) => {
                const rect = layer.getBoundingClientRect();
                const rel = (x - rect.left) / rect.width;
                const zone = clamp(Number(gs().doubleTapZoneWidth) || 0.35, 0.2, 0.45);
                return rel < zone ? 'left' : rel > 1 - zone ? 'right' : 'center';
            };

            this.listen(layer, 'pointerdown', (e) => {
                if (this.errorShown || !this.settings || this.popKind) return;
                if (this.locked) {
                    const u = this.$('.unlock-pill');
                    u.classList.add('show');
                    this.later(2500, () => u.classList.remove('show'));
                    return;
                }
                layer.setPointerCapture(e.pointerId);
                pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
                this.lastPointerType = e.pointerType;
                if (this.mini) {
                    g = { mode: 'mini', sx: e.screenX, sy: e.screenY, type: e.pointerType, moved: false };
                    return;
                }
                const settings = gs();
                if (pointers.size === 2 && settings.enabled && settings.pinchZoom) {
                    clearTimeout(g && g.longTimer);
                    const [a, b] = [...pointers.values()];
                    g = { mode: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.xf.zoom };
                    return;
                }
                if (pointers.size > 1) return;
                g = {
                    mode: null, x: e.clientX, y: e.clientY, type: e.pointerType,
                    startTime: this.video.currentTime, startBright: this.filters.brightness,
                    startVol: this.video.volume, startBoost: this.settings.audio.boost,
                    panX: this.xf.panX, panY: this.xf.panY, longTimer: null
                };
                if (e.pointerType !== 'mouse' && settings.enabled && settings.longPressSpeed) {
                    g.longTimer = setTimeout(() => {
                        if (!g || g.mode) return;
                        g.mode = 'boost';
                        boostRestore = this.rate();
                        this.video.playbackRate = this.settings.longPressRate || 2;
                        this.island('speed', `${fmtRate(this.video.playbackRate)} Speed Active`, null, 0);
                        this.$('.island').classList.add('pulse');
                    }, 500);
                }
            });

            this.listen(layer, 'pointermove', (e) => {
                if (!pointers.has(e.pointerId) || !g) return;
                pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (g.mode === 'mini') {
                    if (!g.moved) {
                        if (Math.hypot(e.screenX - g.sx, e.screenY - g.sy) < (g.type === 'mouse' ? 8 : 22)) return;
                        g.moved = true;
                        this.dragOrigin = { x: g.sx, y: g.sy };
                        this.hostApi.layout({ cmd: 'move-start' });
                    }
                    this.dragLayout('move', e, 'move');
                    return;
                }
                const settings = gs();
                if (g.mode === 'pinch') {
                    const [a, b] = [...pointers.values()];
                    if (!b) return;
                    this.setZoom(g.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, g.dist)), false);
                    this.island('expand', `Zoom ${Math.round(this.xf.zoom * 100)}%`, (this.xf.zoom - 1) / 3, 0);
                    return;
                }
                const dx = e.clientX - g.x;
                const dy = e.clientY - g.y;
                const rect = layer.getBoundingClientRect();
                if (!g.mode) {
                    const slop = g.type === 'mouse' ? 10 : 22;
                    if (Math.hypot(dx, dy) < slop) return;
                    g.moved = true;
                    clearTimeout(g.longTimer);
                    if (this.xf.zoom <= 1 && Math.abs(dx) < Math.abs(dy) * 1.25 && Math.abs(dy) < Math.abs(dx) * 1.25) return;
                    // Mouse: panning a zoomed picture always works; swipe gestures only when opted in.
                    if (this.xf.zoom > 1) g.mode = 'pan';
                    else if (g.type === 'mouse' && !settings.allowMouseDrag) g.mode = 'none';
                    else if (!settings.enabled) g.mode = 'none';
                    else if (Math.abs(dy) > Math.abs(dx)) {
                        const left = g.x - rect.left < rect.width / 2;
                        g.mode = left ? (settings.brightnessSwipe ? 'bright' : 'none') : (settings.volumeSwipe ? 'volume' : 'none');
                    } else {
                        g.mode = settings.scrubSwipe ? 'scrub' : 'none';
                    }
                }
                switch (g.mode) {
                    case 'pan':
                        this.xf.panX = g.panX + dx;
                        this.xf.panY = g.panY + dy;
                        this.clampPan();
                        this.layoutVideo();
                        break;
                    case 'bright': {
                        const val = clamp(Math.round(g.startBright - (dy / rect.height) * 150), 20, 200);
                        this.filters.brightness = val;
                        this.applyFilters();
                        this.island('sun', `${val}%`, (val - 20) / 180, 0);
                        break;
                    }
                    case 'volume': {
                        // 0-100% = element volume; 100-300% = Web Audio boost (graph created on activation events only).
                        const start = g.startVol * 100 + (g.startVol >= 1 ? g.startBoost - 100 : 0);
                        let val = clamp(Math.round(start - (dy / rect.height) * 200), 0, 300);
                        if (val > 100 && !this.audio.active) val = 100;
                        // g.boost is the source of truth: this.settings may be recomputed mid-swipe
                        // (volumechange -> remember()), which would drop an in-place edit.
                        if (val <= 100) {
                            this.video.volume = val / 100;
                            this.video.muted = val === 0;
                            g.boost = 100;
                        } else {
                            this.video.volume = 1;
                            this.video.muted = false;
                            g.boost = val;
                        }
                        if (this.settings.audio.boost !== g.boost) {
                            this.settings.audio.boost = g.boost;
                            this.audio.apply(this.settings.audio);
                        }
                        this.island(val ? 'volume' : 'mute', val > 100 ? `${val}% Boost` : `${val}%`, val / 300, 0);
                        break;
                    }
                    case 'scrub': {
                        const r = this.seekRange();
                        const span = Math.min(r.end - r.start, 240);
                        g.scrubDelta = (dx / rect.width) * span;
                        g.scrubTarget = clamp(g.startTime + g.scrubDelta, r.start, r.end);
                        this.previewTimeline(g.scrubTarget);
                        this.island(g.scrubDelta < 0 ? 'frameBack' : 'frameFwd', `${fmtDelta(g.scrubDelta)} → ${fmtTime(g.scrubTarget - r.start)}`, null, 0);
                        break;
                    }
                    default:
                        break;
                }
            });

            const finish = (e) => {
                if (!pointers.has(e.pointerId)) return;
                pointers.delete(e.pointerId);
                try { layer.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
                if (!g) return;
                const unmuteTap = this.justUnmuted;
                if (g.mode === 'mini') {
                    this.justUnmuted = false;
                    if (g.moved) this.dragLayout('move', e, 'end');
                    else if (e.type !== 'pointercancel' && !unmuteTap) this.togglePlay();
                    g = null;
                    return;
                }
                // Swipes, pinches, long-presses: the unmuting pointer cycle is over either way
                // (a tap clears the flag in handleTap). Pinch keeps it until its last pointer.
                if (g.mode && g.mode !== 'pinch') this.justUnmuted = false;
                if (g.mode === 'pinch') {
                    if (pointers.size === 0) { this.justUnmuted = false; this.hideIsland(); this.announceOnly(`Zoom ${Math.round(this.xf.zoom * 100)}%`); g = null; }
                    return;
                }
                clearTimeout(g.longTimer);
                const mode = g.mode;
                const cancelled = e.type === 'pointercancel';
                if (cancelled) { clearTimeout(tapTimer); lastTap = null; this.justUnmuted = false; }
                if (mode === 'boost') {
                    this.video.playbackRate = boostRestore || 1;
                    this.hideIsland();
                } else if (mode === 'scrub' && !cancelled) {
                    this.seekTo(g.scrubTarget, false);
                    this.announceOnly(`Seeked ${fmtDelta(g.scrubDelta)}`);
                    this.later(600, () => this.hideIsland());
                } else if (mode === 'bright') {
                    this.announceOnly(`Brightness ${this.filters.brightness}%`);
                    this.later(600, () => this.hideIsland());
                } else if (mode === 'volume') {
                    if (g.boost != null) this.saveSettings({ audio: { boost: g.boost } });
                    this.announceOnly(`Volume ${Math.round(this.video.volume * 100)}%`);
                    this.later(600, () => this.hideIsland());
                } else if (!mode && !cancelled && !g.moved) {
                    this.handleTap(g, side(e.clientX), () => lastTap, (val) => { lastTap = val; }, () => tapTimer, (val) => { tapTimer = val; });
                } else {
                    this.hideIsland();
                }
                g = null;
            };
            this.listen(layer, 'pointerup', finish);
            this.listen(layer, 'pointercancel', finish);
            this.listen(layer, 'contextmenu', (e) => e.preventDefault());
            // Double-click / double-tap is handled by handleTap for both mouse and touch.
            this.listen(layer, 'wheel', (e) => {
                if (this.locked || this.mini || !this.settings) return;
                e.preventDefault();
                const up = e.deltaY < 0;
                const mouse = this.settings.mouse || {};
                if (e.ctrlKey) this.setZoom(this.xf.zoom * (up ? 1.1 : 0.9), false);
                else if (e.shiftKey) {
                    if (this.video.paused) this.stepFrame(up ? 1 : -1);
                    else this.seekBy(up ? 1 : -1, true);
                } else if (e.altKey) this.setSubOffset(this.subs.offset + (up ? 0.1 : -0.1));
                else this.wheelAction(mouse.wheel || 'volume', up);
                this.showControls();
            }, { passive: false });
            // Middle click (auxclick button 1) runs the configured action.
            this.listen(layer, 'mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
            this.listen(layer, 'auxclick', (e) => {
                if (e.button !== 1 || this.locked || this.mini || !this.settings) return;
                e.preventDefault();
                this.runAction((this.settings.mouse || {}).middleClick || 'playPause', 'center');
            });
        }

        wheelAction(kind, up) {
            switch (kind) {
                case 'seek': this.seekBy(up ? this.settings.seekStep : -this.settings.seekStep, true); break;
                case 'speed': this.setRate(this.rate() + (up ? 0.25 : -0.25)); break;
                case 'zoom': this.setZoom(this.xf.zoom * (up ? 1.1 : 0.9), false); break;
                case 'none': break;
                default: this.setVolume(this.video.volume + (up ? 0.05 : -0.05), true);
            }
        }

        /** Runs a configurable tap / click action. Seeks show the ripple on their side. */
        runAction(action, side) {
            switch (action) {
                case 'seekBack':
                case 'seekFwd': {
                    const step = this.settings.seekStep;
                    const delta = action === 'seekBack' ? -step : step;
                    this.seekBy(delta, true);
                    const rip = this.$(`.ripple.${delta < 0 ? 'left' : 'right'}`);
                    if (rip) {
                        setHTML(rip, `${skipIcon(delta < 0 ? -1 : 1, step)}<span>${delta < 0 ? '−' : '+'}${step}s</span>`);
                        rip.classList.remove('show');
                        void rip.offsetWidth;
                        rip.classList.add('show');
                    }
                    break;
                }
                case 'fullscreen': this.toggleFullscreen(); break;
                case 'pip': this.togglePip(); break;
                case 'mute': this.toggleMute(); break;
                case 'resetZoom':
                    this.xf = { zoom: 1, panX: 0, panY: 0, rotate: 0, flip: false };
                    this.fit = 'contain';
                    this.layoutVideo();
                    this.announce('Transform reset', 'expand');
                    if (this.popKind) this.refreshPopover();
                    break;
                case 'none': break;
                default: this.togglePlay(); this.showControls();
            }
            void side;
        }

        handleTap(g, side, getLast, setLast, getTimer, setTimer) {
            const now = Date.now();
            const settings = this.settings.gestures;
            const last = getLast();
            const isTouch = g.type !== 'mouse';
            if (last && now - last.t < 300 && last.side === side) {
                clearTimeout(getTimer());
                setLast(null);
                // Unified double-click / double-tap: one action per zone, same for mouse and touch.
                const key = side === 'left' ? 'doubleTapLeft' : side === 'right' ? 'doubleTapRight' : 'doubleTapCenter';
                let action = settings[key] || (side === 'center' ? 'playPause' : side === 'left' ? 'seekBack' : 'seekFwd');
                if ((action === 'seekBack' || action === 'seekFwd') && (!settings.enabled || !settings.doubleTapSeek)) action = 'playPause';
                this.runAction(action, side);
                return;
            }
            // The tap that just unmuted autoplay only shows the controls (it must not pause);
            // a quick second tap still makes it a double-tap above.
            const unmuteTap = this.justUnmuted;
            this.justUnmuted = false;
            setLast({ t: now, side });
            clearTimeout(getTimer());
            setTimer(setTimeout(() => {
                if (unmuteTap) this.showControls();
                else if (isTouch) this.toggleControls();
                else { this.togglePlay(); this.showControls(); }
            }, isTouch ? 280 : 220));
        }

        // -----------------------------------------------------------------
        // Keyboard
        // -----------------------------------------------------------------
        bindKeyboard() {
            // Keys typed inside the player never bubble to the page's own shortcut handlers.
            this.listen(this.root, 'keydown', (e) => { this.onKeyDown(e); e.stopPropagation(); });
            this.listen(this.root, 'keyup', (e) => e.stopPropagation());
            this.listen(this.root, 'keypress', (e) => e.stopPropagation());
        }

        focusables(container) {
            return Array.from(container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
                .filter(el => !el.disabled && !el.hidden && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
        }

        trapFocus(e, container) {
            const list = this.focusables(container);
            if (!list.length) return;
            const first = list[0];
            const last = list[list.length - 1];
            const active = this.shadow.activeElement;
            if (e.shiftKey && (active === first || !container.contains(active))) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && (active === last || !container.contains(active))) { e.preventDefault(); first.focus(); }
        }

        onKeyDown(e) {
            if (this.closed || !this.settings) return;
            const target = e.composedPath()[0];
            const tag = target && target.tagName;

            if (e.key === 'Tab' && this.locked) {
                e.preventDefault();
                const u = this.$('.unlock-pill');
                u.classList.add('show');
                u.focus();
                return;
            }
            if (e.key === 'Tab') {
                if (this.mini) return; // non-modal: focus may leave to the page
                this.showControls();
                this.trapFocus(e, this.popKind ? this.pop : this.errorShown ? this.$('.error') : this.root);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                if (this.capturingKey) { this.capturingKey = null; this.refreshPopover(); }
                else if (this.popKind) this.closePopover(true);
                else if (this.transcriptOpen) this.toggleTranscript(false);
                else if (this.$('.resume').classList.contains('show')) this.dismissResume(false);
                else if (this.locked) this.$('.unlock-pill').classList.add('show');
                else if (this.mini) this.setMini(false);
                else this.destroy();
                return;
            }
            if (this.capturingKey) {
                e.preventDefault();
                const action = this.capturingKey;
                this.capturingKey = null;
                this.saveSettings({ keymap: { ...this.settings.keymap, [action]: e.key } });
                this.announce(`${ACTIONS[action]}: ${e.key === ' ' ? 'Space' : e.key}`, 'check');
                this.refreshPopover();
                return;
            }
            if (this.locked) return;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            if ((e.key === ' ' || e.key === 'Enter') && tag === 'BUTTON') return;
            const role = target && target.getAttribute ? target.getAttribute('role') : null;
            if (role === 'slider' && /^(Arrow|Page|Home|End)/.test(e.key)) return;
            if ((role === 'tab' || role === 'radio' || (role && role.startsWith('menuitem'))) && /^(Arrow|Home|End)/.test(e.key)) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (this.popKind && e.key !== '?') return;

            const km = this.settings.keymap;
            const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            const match = Object.keys(km).find(a => { const k = km[a]; return (k.length === 1 ? k.toLowerCase() : k) === key; });
            if (!match) return;
            e.preventDefault();
            if (!this.mini) this.showControls();
            const step = this.settings.seekStep;
            switch (match) {
                case 'playPause': case 'playPauseAlt': this.togglePlay(); break;
                case 'seekBack': case 'seekBackAlt': this.seekBy(-step, true); break;
                case 'seekFwd': case 'seekFwdAlt': this.seekBy(step, true); break;
                case 'volUp': this.setVolume(this.video.volume + 0.05); break;
                case 'volDown': this.setVolume(this.video.volume - 0.05); break;
                case 'mute': this.toggleMute(); break;
                case 'fullscreen': this.toggleFullscreen(); break;
                case 'pip': this.togglePip(); break;
                case 'captions': this.toggleCaptions(); break;
                case 'transcript': this.toggleTranscript(); break;
                case 'speedDown': this.setRate(this.nextPreset(-1)); break;
                case 'speedUp': this.setRate(this.nextPreset(1)); break;
                case 'loopA': this.setLoopPoint('a'); break;
                case 'loopB': this.setLoopPoint('b'); break;
                case 'screenshot': this.screenshot(e.shiftKey); break; // Shift+S: with subtitles
                case 'frameBack': this.stepFrame(-1); break;
                case 'frameFwd': this.stepFrame(1); break;
                case 'help': if (this.popKind === 'help') this.closePopover(true); else this.openPopover('help', this.$('.btn-studio')); break;
                default: break;
            }
        }

        nextPreset(dir) {
            const r = this.rate();
            if (dir > 0) return SPEED_PRESETS.find(p => p > r + 0.001) || 4;
            return [...SPEED_PRESETS].reverse().find(p => p < r - 0.001) || 0.25;
        }

        // -----------------------------------------------------------------
        // Popovers (Component C)
        // -----------------------------------------------------------------
        togglePopover(kind, button) {
            if (this.popKind === kind) this.closePopover(true);
            else this.openPopover(kind, button);
        }

        openPopover(kind, button) {
            this.closePopover(false);
            this.popKind = kind;
            this.popButton = button;
            const p = this.pop;
            p.className = `popover glass elevated open${kind === 'studio' || kind === 'captions' ? ' wide' : ''}${kind === 'studio' ? ' studio' : ''}${kind === 'help' ? ' center' : ''}`;
            p.setAttribute('aria-hidden', 'false');
            if (button) button.setAttribute('aria-expanded', 'true');
            this.renderPopover();
            this.positionPopover();
            const first = p.querySelector('[aria-checked="true"]') || p.querySelector('[role="tab"][aria-selected="true"]') || this.focusables(p)[0];
            if (first) first.focus({ preventScroll: true });
            this.showControls(true);
        }

        closePopover(returnFocus) {
            if (!this.popKind) return;
            const btn = this.popButton;
            this.popKind = null;
            this.popButton = null;
            this.capturingKey = null;
            this.pop.className = 'popover glass elevated';
            this.pop.setAttribute('aria-hidden', 'true');
            this.pop.replaceChildren();
            if (btn) {
                btn.setAttribute('aria-expanded', 'false');
                if (returnFocus) btn.focus({ preventScroll: true });
            }
            this.scheduleHide();
        }

        positionPopover() {
            positionPopover(this.popKind === 'help' ? null : (this.popButton || this.deck), this.pop, this.root);
        }

        refreshPopover() {
            if (!this.popKind) return;
            const a = this.shadow.activeElement;
            const focusId = a && this.pop.contains(a) ? a.id : null;
            const body = this.pop.querySelector('.pop-body');
            const scroll = body ? body.scrollTop : 0;
            this.renderPopover();
            const nb = this.pop.querySelector('.pop-body');
            if (nb) nb.scrollTop = scroll;
            if (focusId) { const el = this.shadow.getElementById(focusId); if (el) el.focus({ preventScroll: true }); }
            this.positionPopover();
        }

        row({ id, label, meta = '', checked = null, role = 'menuitemradio', lead = '', data = '' }) {
            const first = checked === null ? (lead ? `<span class="lead">${icon(lead, 18)}</span>` : '<span></span>') : `<span class="ck">${icon('check', 18)}</span>`;
            const aria = checked === null ? '' : ` aria-checked="${!!checked}"`;
            return `<button type="button" class="row" role="${role}" id="${id}"${aria} ${data}>${first}<span class="lbl">${esc(label)}</span><span class="meta">${esc(meta)}</span></button>`;
        }

        rangeField(id, label, min, max, step, value, text) {
            const p = ((value - min) / (max - min)) * 100;
            return `<div class="field stack"><div class="flabel"><label for="${id}">${esc(label)}</label><output id="out-${id}">${esc(text)}</output></div><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" style="--p:${p}%" aria-valuetext="${esc(text)}"></div>`;
        }

        switchField(id, label, checked) {
            return `<label class="field" for="${id}"><span>${esc(label)}</span><input type="checkbox" role="switch" id="${id}"${checked ? ' checked' : ''}></label>`;
        }

        selectField(id, label, pairs, value) {
            const opts = pairs.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`).join('');
            return `<div class="field select-field"><label for="${id}">${esc(label)}</label><select id="${id}">${opts}</select></div>`;
        }

        renderPopover() {
            const kind = this.popKind;
            const titles = { speed: 'Playback Speed', captions: 'Subtitles & Audio', studio: 'Studio', help: 'Shortcuts & Gestures' };
            const body = {
                speed: () => this.popSpeed(),
                captions: () => this.popCaptions(),
                studio: () => this.popStudio(),
                help: () => this.popHelp()
            }[kind]();
            const role = kind === 'speed' ? 'menu' : 'dialog';
            this.pop.setAttribute('role', role);
            this.pop.setAttribute('aria-labelledby', 'fs-pop-title');
            setHTML(this.pop, `<div class="pop-head"><h2 id="fs-pop-title">${titles[kind]}</h2><button type="button" class="ib pop-close" aria-label="Close ${titles[kind]}">${icon('close', 18)}</button></div><div class="pop-body">${body}</div>`);
            this.pop.querySelector('.pop-close').addEventListener('click', () => this.closePopover(true));
            this.bindPopover(kind);
            for (const section of this.pop.querySelectorAll('[data-display-section]')) {
                section.addEventListener('toggle', () => {
                    if (!section.isConnected) return;
                    this.displaySections = new Set([...this.pop.querySelectorAll('[data-display-section][open]')].map(el => el.dataset.displaySection));
                    this.positionPopover();
                });
            }
        }

        popSpeed() {
            const r = this.rate();
            return `<div class="stepper" role="group" aria-label="Fine adjust">
  <button type="button" class="ib" id="sp-minus" aria-label="Slower by 0.05">${icon('frameBack', 18)}</button>
  <output class="num">${fmtRate(r)}</output>
  <button type="button" class="ib" id="sp-plus" aria-label="Faster by 0.05">${icon('frameFwd', 18)}</button>
</div><div class="sep" role="separator"></div>${SPEED_PRESETS.map(p => this.row({ id: `sp-${String(p).replace('.', '_')}`, label: p === 1 ? 'Normal' : fmtRate(p), meta: p === 1 ? '1.0×' : '', checked: Math.abs(p - r) < 0.001, data: `data-speed="${p}"` })).join('')}`;
        }

        popCaptions() {
            const st = this.settings.subtitles;
            const tracks = this.textTracks();
            let html = '<div class="section-label" id="lbl-subs">Subtitles</div><div role="menu" aria-labelledby="lbl-subs">';
            html += this.row({ id: 'cc-off', label: 'Off', checked: this.subs.source === 'off', data: 'data-sub="off"' });
            tracks.forEach(t => {
                html += this.row({ id: `cc-${t.id}`, label: t.label || t.language || `Track ${t.id}`, meta: `${t.language || ''}${t.kind === 'caption' ? ' · CC' : ''}`, checked: this.subs.source === 'shaka' && t.active, data: `data-sub="shaka:${t.id}"` });
            });
            const captured = this.subs.capturedTracks || [];
            captured.forEach((t, i) => {
                html += this.row({ id: `cc-cap-${i}`, label: this.capturedLabel(t, i), meta: `${t.language || ''}${t.language ? ' · ' : ''}Site`, checked: this.subs.source === 'external' && this.subs.capturedIndex === i, data: `data-sub="cap:${i}"` });
            });
            if (this.subs.externalCues && this.subs.capturedIndex == null) html += this.row({ id: 'cc-ext', label: this.subs.externalName, meta: 'File', checked: this.subs.source === 'external', data: 'data-sub="external"' });
            html += this.row({ id: 'cc-load', label: 'Load .srt, .vtt or .ass file…', role: 'menuitem', lead: 'upload' });
            html += this.row({ id: 'cc-transcript', label: this.transcriptOpen ? 'Hide transcript' : 'Transcript & search', meta: 'T', role: 'menuitem', lead: 'captions' });
            html += '</div><input type="file" id="cc-file" accept=".srt,.vtt,.ass,.ssa,text/vtt,application/x-subrip" hidden>';
            const off = this.subs.offset;
            html += `<div class="section-label">Sync offset</div><div class="stepper"><button type="button" class="ib" id="cc-off-minus" aria-label="Subtitles earlier by 0.1 seconds">${icon('frameBack', 18)}</button><output class="num">${off >= 0 ? '+' : ''}${off.toFixed(1)} s</output><button type="button" class="ib" id="cc-off-plus" aria-label="Subtitles later by 0.1 seconds">${icon('frameFwd', 18)}</button></div>`;
            html += `<div role="menu" aria-label="Subtitle sync">${this.row({ id: 'cc-sync-voice', label: 'Sync next line to now', meta: 'when you hear it', role: 'menuitem', lead: 'captions' })}</div>`;
            html += this.rangeField('cc-speed', 'Subtitle speed', 900, 1100, 1, Math.round(this.subs.speed * 1000), `${this.subs.speed.toFixed(3)}×`);
            const captured2 = this.subs.capturedTracks || [];
            html += '<div class="section-label" id="lbl-subs2">Secondary subtitles (top)</div><div role="menu" aria-labelledby="lbl-subs2">';
            html += this.row({ id: 'cc2-off', label: 'Off', checked: !this.subs.secondaryCues, data: 'data-sub2="off"' });
            captured2.forEach((t, i) => { html += this.row({ id: `cc2-cap-${i}`, label: this.capturedLabel(t, i), meta: t.language || 'Site', checked: !!this.subs.secondaryCues && this.subs.secondaryIndex === i, data: `data-sub2="cap:${i}"` }); });
            if (this.subs.secondaryCues && this.subs.secondaryIndex === -1) html += this.row({ id: 'cc2-file-cur', label: this.subs.secondaryName, meta: 'File', checked: true, data: 'data-sub2="keep"' });
            html += this.row({ id: 'cc2-load', label: 'Load secondary file…', role: 'menuitem', lead: 'upload' });
            html += '</div><input type="file" id="cc2-file" accept=".srt,.vtt,.ass,.ssa,text/vtt,application/x-subrip" hidden>';
            html += `${this.switchField('cc-hover', 'Pause while pointing at a subtitle', !!st.pauseOnHover)}${this.switchField('cc-copy', 'Click a subtitle to copy it', st.clickToCopy !== false)}`;
            const audio = this.audioTracks();
            if (audio.length > 1) {
                html += '<div class="section-label" id="lbl-audio">Audio track</div><div role="menu" aria-labelledby="lbl-audio">';
                audio.forEach((t, i) => {
                    html += this.row({ id: `at-${i}`, label: t.label || t.language || `Track ${i + 1}`, meta: `${t.language || ''}${t.channelsCount ? ` · ${t.channelsCount}ch` : ''}`, checked: t.active, data: `data-atrack="${i}"` });
                });
                html += '</div>';
            }
            html += `<div class="section-label">Subtitle style</div>
${this.selectField('cc-font', 'Font', Object.entries(FONTS).map(([k, f]) => [k, f.label]), st.font)}
${this.rangeField('cc-size', 'Size', 50, 300, 10, st.size, `${st.size}%`)}
${this.selectField('cc-color', 'Colour', SUB_COLORS, st.color)}
${this.rangeField('cc-bg', 'Background', 0, 100, 5, st.bgOpacity, `${st.bgOpacity}%`)}
${this.selectField('cc-edge', 'Edge', [['none', 'None'], ['shadow', 'Drop shadow'], ['outline', 'Outline']], st.edge)}
${this.rangeField('cc-pos', 'Vertical position', 0, 80, 1, st.position, `${st.position}%`)}
<div class="sub-preview" aria-hidden="true"><span class="cue-line">The quick brown fox</span></div>`;
            return html;
        }

        popStudio() {
            const idx = Math.max(0, STUDIO_TABS.findIndex(t => t[0] === this.studioTab));
            const tabs = STUDIO_TABS.map(([k, l], i) => `<button type="button" role="tab" id="st-tab-${k}" aria-controls="st-panel" aria-selected="${i === idx}" tabindex="${i === idx ? 0 : -1}" data-tab="${k}">${l}</button>`).join('');
            const panel = { quality: () => this.tabQuality(), audio: () => this.tabAudio(), display: () => this.tabDisplay(), tools: () => this.tabTools(), prefs: () => this.tabPrefs() }[STUDIO_TABS[idx][0]]();
            return `<div class="segmented" role="tablist" aria-label="Studio sections">${tabs}</div><div id="st-panel" role="tabpanel" aria-labelledby="st-tab-${STUDIO_TABS[idx][0]}">${panel}</div>`;
        }

        tabQuality() {
            if (this.localPlayback) return `<div role="menu" aria-label="Local files">${this.row({ id: 'local-open', label: 'Open Local File', role: 'menuitem', lead: 'upload' })}${this.row({ id: 'local-folder', label: 'Open Folder', role: 'menuitem', lead: 'upload' })}</div>`;
            const streams = this.streamsSection();
            if (this.mode !== 'mse') return `${streams}<p class="hint">Quality selection is available for HLS and DASH streams. This is a direct media file.</p>${this.bufferSection()}`;
            return streams + this.qualitySection() + this.bufferSection();
        }

        /** Other playable streams detected on this page (only when there is more than one). */
        streamsSection() {
            const list = this.tabStreams || [];
            if (list.length < 2) return '';
            const cur = this.stream ? this.stream.id : null;
            const label = s => [s.type === 'progressive' ? 'File' : s.type.toUpperCase(), s.maxHeight ? `${s.maxHeight}p` : '', s.live ? 'Live' : s.duration ? fmtTime(s.duration) : ''].filter(Boolean).join(' · ');
            let html = '<div class="section-label" id="lbl-streams">Streams on this page</div><div role="menu" aria-labelledby="lbl-streams">';
            list.forEach((s, i) => {
                html += this.row({ id: `qs-${i}`, label: s.title || label(s), meta: s.title ? label(s) : s.host, checked: s.id === cur, data: `data-stream="${esc(s.id)}"` });
            });
            return `${html}</div>`;
        }

        /** Ask the engine to switch this session to another stream of the page (no iframe reload). */
        switchToStream(id) {
            if (!id || (this.stream && this.stream.id === id) || this.switching) return;
            if (this.exportState && this.exportState.running) { this.announce('Finish or cancel the download first', 'warn'); return; }
            this.saveHistory(true);
            this.switching = true;
            this.closePopover(false);
            this.setStatus('loading');
            this.island('studio', 'Switching stream…', null, 0);
            this.port.send({ type: 'SWITCH_STREAM', streamId: id });
            this.later(15000, () => { if (this.switching) { this.switching = false; this.hideIsland(); this.announce('Switching timed out', 'warn'); } });
        }

        async finishStreamSwitch(msg) {
            if (!msg.stream || (this.localPlayback && !msg.local)) return;
            if (!msg.local) this.saveHistory(true);
            this.changingMedia = true;
            this.switching = false;
            if (msg.pageUrl !== undefined) this.updatePageMeta(msg);
            if (msg.subtitles) this.setCaptured(msg.subtitles);
            if (msg.drm !== undefined) this.drmInfo = msg.drm;
            const v = this.video;
            const prevType = this.stream ? this.stream.type : '';
            this.stream = msg.stream;
            this.playbackPageUrl = this.pageUrl;
            this.playbackPageMeta = this.pageMeta;
            this.subs.offset = 0;
            this.subs.speed = 1;
            this.subs.lastHtml = null;
            this.clearThumbCache();
            if (Array.isArray(msg.streams)) this.tabStreams = msg.streams;
            // Per-stream state starts over.
            this.loop = { a: null, b: null };
            this.clip = { start: null, end: null };
            this.chapters = [];
            this.imageTrackId = undefined;
            this.thumbKey = null;
            this.resetFileThumbs();
            this.exportState = null;
            this.freshTried = false;
            this.netRecoveries = [];
            this.corsUnavailable = false;
            this.variantsSig = '';
            this.lastHeight = 0;
            this.decoderKey = null;
            this.smartSkip = null;
            this.lastQuality = {};
            this.subs.clearShaka();
            this.subs.clearExternal();
            this.subs.source = 'off';
            this.subs.render(v.currentTime);
            this.updateCcButton();
            // Unload the old media. Shaka is torn down when the next stream is a plain file (it
            // must not keep the element), and reused for the next HLS/DASH stream.
            if (this.player && (this.stream.type === 'progressive' || prevType === 'progressive')) {
                try { await this.player.destroy(); } catch (_) { /* ignore */ }
                this.player = null;
            } else if (this.player) {
                try { await this.player.unload(); } catch (_) { /* ignore */ }
            }
            if (prevType === 'progressive') { v.removeAttribute('src'); v.removeAttribute('crossorigin'); v.load(); }
            let domain = msg.local ? 'Local file' : '';
            if (!msg.local) try { domain = new URL(this.stream.url).hostname; } catch (_) { /* opaque */ }
            this.$('.domain').textContent = domain;
            const title = this.stream.title || this.playbackPageMeta?.showTitle || this.titleFromUrl(this.stream.url);
            this.$('.title').textContent = this.$('.title').title = title;
            this.root.setAttribute('aria-label', `Velostream player: ${title}`);
            await this.loadBookmarks();
            this.renderMarks();
            this.hideIsland();
            try {
                await this.load(msg.startTime);
            } catch (e) {
                this.showError('Cannot play this stream', String((e && e.message) || e));
                return;
            } finally {
                this.changingMedia = false;
            }
            if (!msg.local) {
                this.checkResume();
                this.loadChapters();
                this.autoSelectCaptured();
            }
            this.updateDownloadButton();
            this.announce(`Now playing ${this.stream.title || (this.stream.type === 'progressive' ? 'the file' : `the ${this.stream.type.toUpperCase()} stream`)}`, 'play');
            this.refreshPopover();
        }

        bufferSection() {
            const s = this.settings;
            const st = this.engineStats || {};
            const ahead = st.cachedAhead != null ? fmtTime(st.cachedAhead) : '—';
            const workers = clamp(Math.round(Number(s.maxWorkers) || 4), 2, 8);
            return `<div class="section-label">Buffer &amp; network</div>
${this.selectField('bf-paused-limit', 'Prefetch while paused', withCurrentOption([[0, 'Off'], [128, '128 MB'], [256, '256 MB'], [512, '512 MB'], [1024, '1 GB']], s.pausedBufferMB, v => `${v} MB`), s.pausedBufferMB)}
${this.selectField('bf-window', 'Pre-buffer window', withCurrentOption(PREBUFFER_WINDOWS, s.maxBufferSec, v => `${v >= 60 && v % 60 === 0 ? `${v / 60} min` : `${v} s`} (custom)`), s.maxBufferSec ?? 86400)}
${this.rangeField('bf-ahead', 'RAM buffer ahead', 15, 180, 5, s.mseBufferAhead, `${s.mseBufferAhead} s`)}
${this.rangeField('bf-behind', 'Back-buffer kept', 10, 180, 5, s.mseBufferBehind, `${s.mseBufferBehind} s`)}
${this.rangeField('bf-workers', 'Parallel workers', 2, 8, 1, workers, `${workers}`)}
${this.selectField('bf-cache', 'Disk cache cap', withCurrentOption(CACHE_CAPS, s.cacheSizeMB, v => `${v >= 1024 && v % 1024 === 0 ? `${v / 1024} GB` : `${v} MB`} (custom)`), s.cacheSizeMB ?? 2048)}
${this.switchField('bf-range', 'Range accelerator (parallel chunks)', s.rangeAccel !== false)}
${this.switchField('bf-pause', 'Pause background prefetch', !!this.prefetchPaused)}
<div role="menu" aria-label="Buffer actions">${this.row({ id: 'bf-purge', label: 'Purge & rebuild buffer', meta: `${ahead} ahead`, role: 'menuitem', lead: 'rotate' })}</div>
<p class="hint">The pre-buffer lives on disk (IndexedDB); RAM ahead/behind is what the video element keeps decoded.</p>`;
        }

        qualitySection() {
            const est = this.engineStats ? fmtBitrate(this.engineStats.bandwidth) : '—';
            let html = `<div role="menu" aria-label="Quality">${this.row({ id: 'q-auto', label: 'Auto (Smart ABR)', meta: this.abrAuto && this.video.videoHeight ? `${this.video.videoHeight}p` : '', checked: this.abrAuto, data: 'data-q="auto"' })}`;
            for (const t of this.uniqueQualities()) {
                html += this.row({ id: `q-${t.id}`, label: this.qualityName(t), meta: fmtBitrate(t.bandwidth), checked: !this.abrAuto && this.lockedVariantId === t.id, data: `data-q="${t.id}"` });
            }
            html += `</div><div class="sep"></div>${this.selectField('q-cap', 'Resolution cap', QUALITY_CAPS, this.qualityCap)}<p class="hint">Measured bandwidth ${esc(est)}. Auto mode is driven by the background ABR engine.</p>`;
            return html;
        }

        tabAudio() {
            const a = this.settings.audio;
            const allowed = this.audio.allowed();
            const vol = Math.round(this.video.volume * 100);
            let html = allowed ? '' : '<p class="hint">This file comes from another site without CORS, so the browser blocks audio processing. Boost, EQ and delay are unavailable.</p>';
            html += this.rangeField('au-vol', 'Volume', 0, 100, 1, vol, `${vol}%`);
            html += this.rangeField('au-boost', 'Boost', 100, 300, 5, a.boost, `${a.boost}%`);
            html += '<div class="section-label" id="lbl-eq">Equalizer</div><div role="menu" aria-labelledby="lbl-eq">';
            for (const [k, p] of Object.entries(AUDIO_PRESETS)) {
                html += this.row({ id: `au-p-${k}`, label: p.label, meta: p.meta, checked: a.preset === k, data: `data-preset="${k}"${allowed ? '' : ' disabled'}` });
            }
            html += '</div>';
            if (a.preset === 'custom') {
                html += `<div class="eq" role="group" aria-label="5-band equalizer">${EQ_BANDS.map((b, i) => {
                    const val = a.eq[i] || 0;
                    return `<label><span class="num" id="au-eq-lbl-${i}">${val > 0 ? '+' : ''}${val} dB</span><input type="range" id="au-eq-${i}" min="-12" max="12" step="1" value="${val}" style="--p:${((val + 12) / 24) * 100}%" aria-label="${b.label} hertz" aria-valuetext="${val} decibels"><span>${b.label}</span></label>`;
                }).join('')}</div>`;
            }
            html += `<div class="section-label">Audio delay (lip sync)</div><div class="stepper"><button type="button" class="ib" id="au-d-minus" aria-label="Less audio delay, 50 milliseconds"${allowed ? '' : ' disabled'}>${icon('frameBack', 18)}</button><output class="num">${a.delayMs} ms</output><button type="button" class="ib" id="au-d-plus" aria-label="More audio delay, 50 milliseconds"${allowed ? '' : ' disabled'}>${icon('frameFwd', 18)}</button></div><p class="hint">Delays sound when it arrives before the picture (0–1000 ms).</p>`;
            html += `<div class="section-label">Output</div>
${this.selectField('au-ch', 'Channels', [['stereo', 'Stereo'], ['mono', 'Mono (downmix)'], ['left', 'Left channel only'], ['right', 'Right channel only']], a.channels || 'stereo')}
${this.switchField('au-pitch', 'Keep voice pitch when speeding up', a.preservesPitch !== false)}
${this.switchField('au-norm', 'Smart loudness normalization', !!a.loudnessNorm)}
<p class="hint">Keeps the volume even: lifts quiet dialogue slowly and limits sudden loud peaks, without the pumping of Night mode.</p>
<div class="section-label">Spatial &amp; dialogue</div>
${this.rangeField('au-width', 'Stereo width', 0, 200, 5, a.width ?? 100, `${a.width ?? 100}%`)}
${this.rangeField('au-dialogue', 'Dialogue boost', 0, 100, 5, a.dialogue || 0, `${a.dialogue || 0}%`)}
${this.switchField('au-crossfeed', 'Headphone crossfeed', !!a.crossfeed)}
<p class="hint">Width: 0% is mono, 100% as recorded, 200% extra wide. Dialogue boost lifts voices in the centre of the mix. Crossfeed blends the sides a little for a more natural sound on headphones.</p>`;
            return html;
        }

        displaySection(id, title, caption) {
            const open = this.displaySections?.has(id) || (!this.displaySections && id === 'picture');
            return `<details class="display-section" data-display-section="${id}"${open ? ' open' : ''}><summary><span>${title}<small>${caption}</small></span></summary><div class="display-controls">`;
        }

        tabDisplay() {
            const f = this.filters;
            let html = this.displaySection('picture', 'Picture', 'Light, contrast and detail') + this.rangeField('dp-brightness', 'Brightness', 20, 200, 5, f.brightness, `${f.brightness}%`)
                + this.rangeField('dp-contrast', 'Contrast', 50, 200, 5, f.contrast, `${f.contrast}%`)
                + this.rangeField('dp-saturate', 'Saturation', 0, 300, 5, f.saturate, `${f.saturate}%`)
                + this.rangeField('dp-sharpness', 'Sharpness', 0, 100, 5, f.sharpness, `${f.sharpness}%`)
                + this.rangeField('dp-hue', 'Hue', -180, 180, 5, f.hue, `${f.hue}°`)
                + this.rangeField('dp-warmth', 'Eye-care warmth', 0, 100, 5, f.warmth, `${f.warmth}%`);
            const s = this.settings;
            const activePreset = this.gpu?.preset || 'off';
            const path = this.gpu?.path;
            const gpuState = this.graphicsOriginal ? 'Showing the original video.' : this.gpuBlocked ? `Unavailable: ${this.gpuBlocked}.`
                : this.gpu && this.gpu.active ? `Active: ${activePreset === 'off' ? 'colour grading only' : ((GPU_PRESETS.find(p => p[0] === activePreset) || ['', activePreset])[1])} at ${this.glCanvas.width}×${this.glCanvas.height}${this.gpuOverride ? ' (stepped down for GPU load)' : ''}.${path?.includes('lite') ? ' Using the lighter Anime4K fallback.' : ''}`
                    : s.shader === 'auto' && this.graphicsHardware && (!this.graphicsHardware.webgl || /SwiftShader|llvmpipe|Microsoft Basic Render/i.test(this.graphicsHardware.renderer))
                        ? 'Auto is using original playback because hardware WebGL2 is unavailable.' : 'Off.';
            const showStrength = ['auto', 'cas', 'deblock'].includes(s.shader);
            html += `</div></details>${this.displaySection('graphics', 'Graphics', 'Enhancement and original preview')}
${this.selectField('dp-shader', 'Enhancement', GPU_PRESETS, s.shader)}
${showStrength ? this.rangeField('dp-shader-str', 'Strength', 0, 100, 5, s.shaderStrength, `${s.shaderStrength}%`) : ''}
<div class="graphics-compare"><button type="button" class="pillbtn" id="dp-original" aria-pressed="${!!this.graphicsOriginal}">${this.graphicsOriginal ? 'Show enhanced' : 'Show original'}</button></div>
${this.selectField('dp-maxres', 'Max render resolution', [[1080, '1080p'], [1440, '1440p'], [2160, '2160p (4K)']], s.maxRenderRes)}
<p class="hint">${esc(gpuState)} Auto adjusts rendering cost for your device. Try Detail sharpening for soft footage, Compression cleanup for blocky video, or Anime4K for animation. Heavy presets step down if playback struggles.</p>`;
            const cs = s.color || {};
            const CP = window.VelostreamShared.COLOR_PRESETS;
            html += `</div></details>${this.displaySection('color', 'Color Studio', 'Looks and fine color adjustments')}
${this.selectField('dp-cpreset', 'Look', Object.entries(CP).map(([k, p]) => [k, p.label]).concat([['custom', 'Custom']]), cs.preset || 'neutral')}
${this.rangeField('dp-c-gamma', 'Gamma', 50, 200, 5, cs.gamma ?? 100, `${((cs.gamma ?? 100) / 100).toFixed(2)}`)}
${this.rangeField('dp-c-vibrance', 'Vibrance', -100, 100, 5, cs.vibrance || 0, `${cs.vibrance || 0}`)}
${this.rangeField('dp-c-temperature', 'Temperature', -100, 100, 5, cs.temperature || 0, `${cs.temperature || 0}`)}
${this.rangeField('dp-c-tint', 'Tint', -100, 100, 5, cs.tint || 0, `${cs.tint || 0}`)}
${this.rangeField('dp-c-shadows', 'Shadows', -100, 100, 5, cs.shadows || 0, `${cs.shadows || 0}`)}
${this.rangeField('dp-c-highlights', 'Highlights', -100, 100, 5, cs.highlights || 0, `${cs.highlights || 0}`)}
<p class="hint">${this.gpuBlocked ? `Needs GPU enhancement, which is unavailable here (${esc(this.gpuBlocked)}).` : 'Graded on the GPU, on top of the colour sliders above. Vibrance boosts dull colours more than vivid ones; Temperature warms or cools; Shadows and Highlights lift or recover the dark and bright parts.'}</p>`;
            html += this.switchField('dp-ambient', 'Ambient glow behind the video', !!s.ambientMode);
            html += '<div class="inline"><label class="sr-only" for="dp-preset-name">Preset name</label><input type="text" id="dp-preset-name" placeholder="Preset name" maxlength="40"><button type="button" class="pillbtn primary" id="dp-preset-save">Save</button><button type="button" class="pillbtn" id="dp-reset">Reset</button></div>';
            (this.settings.filterPresets || []).forEach((p, i) => {
                html += `<div class="list-row"><span>${esc(p.name)}</span><button type="button" class="pillbtn" id="dp-apply-${i}" data-fp-apply="${i}">Apply</button><button type="button" class="ib" id="dp-del-${i}" data-fp-del="${i}" aria-label="Delete preset ${esc(p.name)}">${icon('trash', 18)}</button></div>`;
            });
            html += `</div></details>${this.displaySection('frame', 'Framing', 'Aspect ratio, zoom and rotation')}<div role="menu" aria-label="Aspect ratio">`;
            for (const [k, l, m] of FIT_MODES) html += this.row({ id: `dp-fit-${k.replace(':', '-')}`, label: l, meta: m, checked: this.fit === k, data: `data-fit="${k}"` });
            html += '</div>';
            html += this.rangeField('dp-zoom', 'Zoom', 100, 400, 5, Math.round(this.xf.zoom * 100), `${Math.round(this.xf.zoom * 100)}%`);
            html += `<div role="menu" aria-label="Transform">${this.row({ id: 'dp-rotate', label: 'Rotate 90°', meta: `${this.xf.rotate}°`, role: 'menuitem', lead: 'rotate' })}${this.row({ id: 'dp-flip', label: 'Mirror', meta: this.xf.flip ? 'On' : 'Off', role: 'menuitem', lead: 'flip' })}${this.row({ id: 'dp-xreset', label: 'Reset transform', role: 'menuitem', lead: 'expand' })}</div>`;
            return html + '</div></details>';
        }

        tabTools() {
            const r = this.seekRange();
            const loopMeta = this.loop.a == null ? 'Not set' : this.loop.b == null ? `A ${fmtTime(this.loop.a - r.start)}` : `${fmtTime(this.loop.a - r.start)}–${fmtTime(this.loop.b - r.start)}`;
            let html = `<div class="section-label">A–B loop &amp; bookmarks</div><div role="menu" aria-label="Loop and bookmarks">
${this.row({ id: 'tl-a', label: 'Set point A', meta: loopMeta, role: 'menuitem', lead: 'loop' })}
${this.row({ id: 'tl-b', label: 'Set point B', role: 'menuitem', lead: 'loop' })}
${this.row({ id: 'tl-clear', label: 'Clear loop', role: 'menuitem', lead: 'close' })}
${this.row({ id: 'tl-bm', label: `Bookmark ${fmtTime(this.video.currentTime - r.start)}`, role: 'menuitem', lead: 'bookmark' })}</div>`;
            this.bookmarks.forEach((b, i) => {
                html += `<div class="list-row"><span>${esc(fmtTime(b.t - r.start))} · ${esc(b.label)}</span><button type="button" class="pillbtn" id="bm-go-${i}" data-bm-go="${i}" aria-label="Jump to ${esc(b.label)}">Go</button><button type="button" class="ib" id="bm-del-${i}" data-bm-del="${i}" aria-label="Delete ${esc(b.label)}">${icon('trash', 18)}</button></div>`;
            });
            html += `<div class="section-label">Capture</div><div role="menu" aria-label="Capture">
${this.row({ id: 'tl-shot', label: 'Snapshot (.png)', meta: 'S', role: 'menuitem', lead: 'camera' })}
${this.row({ id: 'tl-shot-subs', label: 'Snapshot with subtitles & effects', meta: 'Shift S', role: 'menuitem', lead: 'camera' })}
${this.row({ id: 'tl-burst', label: 'Snapshot burst', meta: '6 frames', role: 'menuitem', lead: 'burst' })}
${this.row({ id: 'tl-fb', label: 'Previous frame', meta: ',', role: 'menuitem', lead: 'frameBack' })}
${this.row({ id: 'tl-ff', label: 'Next frame', meta: '.', role: 'menuitem', lead: 'frameFwd' })}</div>`;
            const st = this.exportState;
            const live = this.isLive();
            if (!this.localPlayback) {
                html += `<div class="section-label">${live ? 'Record &amp; DVR' : 'Download'}</div>`;
                if (st && (st.running || st.status)) {
                    html += `<div class="progress" role="progressbar" aria-label="Download progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${st.pct || 0}"><i style="width:${st.pct || 0}%"></i></div><p class="hint num">${esc(st.status || '')}</p>`;
                }
                html += '<div role="menu" aria-label="Download">';
                if (st && st.running) {
                    html += this.row({ id: 'tl-cancel', label: st.isClip ? 'Cancel clip export' : 'Pause download', role: 'menuitem', lead: 'stop' });
                } else if (live) {
                    html += this.row({ id: 'tl-rec', label: this.recordingSince ? 'Stop & save recording' : 'Record from now', role: 'menuitem', lead: this.recordingSince ? 'stop' : 'record' });
                    html += this.row({ id: 'tl-export', label: 'Save DVR buffer', meta: fmtTime((this.engineStats && this.engineStats.dvrSeconds) || 0), role: 'menuitem', lead: 'download' });
                } else {
                    const dash = this.stream.type === 'dash';
                    let dashWebm = false;
                    if (dash) { try { const a = this.player.getVariantTracks().find(t => t.active); dashWebm = !!a && /webm/i.test(a.mimeType || ''); } catch (_) { /* not loaded */ } }
                    html += this.row({ id: 'tl-export', label: dashWebm ? 'Save original files (WebM video + audio)' : dash ? 'Save as .mp4' : this.stream.type === 'hls' ? ((this.settings.exportFormat || 'mp4') === 'mp4' ? 'Save as .mp4' : 'Save original segments') : 'Save file', role: 'menuitem', lead: 'download' });
                }
                html += '</div>';
                if (this.supportsClip()) {
                    const { start, end } = this.clip;
                    html += `<div class="section-label">Clip from buffer</div><div role="menu" aria-label="Clip from buffer">
${this.row({ id: 'tl-clip-in', label: 'Set In at playhead', meta: start == null ? '' : fmtTime(start), role: 'menuitem', lead: 'frameBack' })}
${this.row({ id: 'tl-clip-out', label: 'Set Out at playhead', meta: end == null ? '' : fmtTime(end), role: 'menuitem', lead: 'frameFwd' })}`;
                    if (start != null) html += this.row({ id: 'tl-clip-clear', label: 'Clear clip marks', role: 'menuitem', lead: 'close' });
                    const clip = this.clipRange();
                    if (clip && !st?.running) html += this.row({ id: 'tl-export-clip', label: 'Export cached clip', meta: fmtTime(clip.end - clip.start), role: 'menuitem', lead: 'download' });
                    html += '</div><p class="hint">Play through the range to cache it. Cuts follow segment boundaries.</p>';
                }
                if (this.stream.type === 'dash' && !live) html += '<p class="hint">DASH saves the best quality within your quality cap, with the audio language you are listening to: MP4 streams as one .mp4, WebM (VP9) streams as the original video and audio files. DRM-protected streams cannot be saved.</p>';
                if (this.stream.type === 'hls' || live) html += this.selectField('tl-format', 'Save format', [['mp4', 'MP4 (video + audio in one file)'], ['original', 'Original (.ts / .m4s as served)']], this.settings.exportFormat || 'mp4');
            }
            const sleepMode = this.sleep ? this.sleep.mode : 0;
            html += `<div class="section-label" id="lbl-sleep">Sleep timer</div><div role="menu" aria-labelledby="lbl-sleep">${SLEEP_OPTIONS.map(([m, l]) => this.row({ id: `sl-${m}`, label: l, meta: m && sleepMode === m && this.sleep.endsAt ? `${Math.max(0, Math.ceil((this.sleep.endsAt - Date.now()) / 60000))}m left` : '', checked: sleepMode === m, data: `data-sleep="${m}"` })).join('')}</div>`;
            if (!this.localPlayback) {
                const android = /Android/i.test(navigator.userAgent);
                const mac = /Mac OS X/i.test(navigator.userAgent) && !/Mobile/i.test(navigator.userAgent);
                html += '<div class="section-label" id="lbl-ext">Open in external player</div><div role="menu" aria-labelledby="lbl-ext">';
                for (const [k, l, m] of EXTERNAL_APPS) {
                    if ((k === 'android' && !android) || (k === 'iina' && !mac) || ((k === 'potplayer') && (android || mac))) continue;
                    html += this.row({ id: `ex-${k}`, label: l, meta: m, role: 'menuitem', lead: 'external', data: `data-ext="${k}"` });
                }
                html += this.row({ id: 'ex-ytdlp', label: 'Copy yt-dlp command', meta: 'with Referer / UA', role: 'menuitem', lead: 'copy' });
                html += this.row({ id: 'ex-ffmpeg', label: 'Copy ffmpeg command', meta: 'with Referer / UA', role: 'menuitem', lead: 'copy' });
                html += this.row({ id: 'ex-link', label: 'Copy stream link', role: 'menuitem', lead: 'copy' });
                html += '</div>';
            }
            html += `<div class="section-label">Skip</div>${this.selectField('tl-skip', 'Skip intro button', SKIP_STEPS.map(s => [s, `+${s} s`]), this.settings.skipSeconds)}${this.switchField('tl-smart', 'Smart skip black & silence', this.settings.smartSkip)}`;
            html += `<div class="section-label">Modes</div><div role="menu" aria-label="Modes">
${this.row({ id: 'tl-mini', label: 'Mini player', role: 'menuitem', lead: 'mini' })}
${this.row({ id: 'tl-audio', label: 'Audio-only battery saver', meta: this.audioOnly ? 'On' : 'Off', role: 'menuitem', lead: 'headphones' })}
${document.pictureInPictureEnabled ? this.row({ id: 'tl-pip', label: 'Picture in Picture', role: 'menuitem', lead: 'pip' }) : ''}
${this.row({ id: 'tl-lock', label: 'Lock touch controls', role: 'menuitem', lead: 'lock' })}</div>`;
            return html;
        }

        tabPrefs() {
            const s = this.settings;
            const host = this.siteHost();
            const g = s.gestures;
            const swatches = Object.entries(ACCENTS).map(([k, a]) => `<button type="button" class="swatch" role="radio" id="pf-acc-${k}" aria-checked="${s.theme === k}" aria-label="${a.label} accent" data-accent="${k}"><span style="background:${a.fill}"></span></button>`).join('');
            const scaleIdx = Math.max(0, UI_SCALES.findIndex(([v]) => v === s.uiScale));
            const scales = UI_SCALES.map(([v, l], i) => `<button type="button" class="seg" role="radio" id="pf-scale-${i}" aria-checked="${i === scaleIdx}" data-scale="${v}">${l}</button>`).join('');
            const keyName = k => (k === ' ' ? 'Space' : k);
            const keys = Object.keys(ACTIONS).map(a => `<div class="list-row"><span>${esc(ACTIONS[a])}</span><span class="kbd">${esc(this.capturingKey === a ? 'Press key…' : keyName(s.keymap[a] || ''))}</span><button type="button" class="pillbtn" id="pf-key-${a}" data-key="${a}" aria-label="Change shortcut for ${esc(ACTIONS[a])}">Edit</button></div>`).join('');
            return `<div class="section-label" id="lbl-accent">Accent</div><div class="swatches" role="radiogroup" aria-labelledby="lbl-accent">${swatches}</div>
<div class="section-label" id="lbl-scale">Interface size</div><div class="segmented" role="radiogroup" aria-labelledby="lbl-scale"><span class="seg-ind" style="width:calc((100% - 4px) / ${UI_SCALES.length});transform:translateX(${scaleIdx * 100}%)"></span>${scales}</div>
${this.switchField('pf-hc', 'High contrast', s.highContrast)}
${this.selectField('pf-rm', 'Reduce motion', [['system', 'System'], ['on', 'Always'], ['off', 'Never']], s.reducedMotion)}
${this.switchField('pf-simple', 'Simple mode (fewer buttons)', s.simpleMode)}
${this.selectField('pf-autohide', 'Auto-hide controls', AUTOHIDE, s.autoHideMs)}
${this.switchField('pf-stats', 'Stats for nerds', s.showStats)}
${this.lookSection()}
<div class="section-label">Playback</div>
${this.selectField('pf-resume', 'Resume where I left off', [['ask', 'Ask'], ['always', 'Always'], ['off', 'Off']], s.autoResume)}
${this.selectField('pf-seek', 'Seek step', SEEK_STEPS.map(v => [v, `${v} s`]), s.seekStep)}
${this.selectField('pf-defspeed', 'Default speed', SPEED_PRESETS.map(p => [p, fmtRate(p)]), s.defaultSpeed)}
${this.selectField('pf-defcap', 'Default resolution cap', QUALITY_CAPS, s.qualityCap)}
${this.switchField('pf-autofs', 'Full screen on first tap', s.autoFullscreen)}
${this.switchField('pf-filethumbs', 'Seek previews for video files', s.fileThumbnails)}
${this.switchField('pf-pipsubs', 'Subtitles in Picture-in-Picture', s.pipSubtitles)}
${this.switchField('pf-badge', 'On-page Play in Velostream button', s.quickLaunchBadge)}
<div class="section-label">Gestures</div>
${this.switchField('pf-g-enabled', 'Touch gestures', g.enabled)}
${this.switchField('pf-g-doubleTapSeek', 'Double-tap to seek', g.doubleTapSeek)}
${this.switchField('pf-g-longPressSpeed', 'Long-press speed boost', g.longPressSpeed)}
${this.selectField('pf-lprate', 'Long-press speed', [[1.5, '1.5×'], [2, '2.0×'], [3, '3.0×'], [4, '4.0×']], s.longPressRate)}
${this.switchField('pf-g-brightnessSwipe', 'Swipe left side: brightness', g.brightnessSwipe)}
${this.switchField('pf-g-volumeSwipe', 'Swipe right side: volume', g.volumeSwipe)}
${this.switchField('pf-g-scrubSwipe', 'Swipe across: scrub', g.scrubSwipe)}
${this.switchField('pf-g-pinchZoom', 'Pinch to zoom', g.pinchZoom)}
${this.switchField('pf-g-allowMouseDrag', 'Mouse drag uses swipe gestures', g.allowMouseDrag)}
${this.selectField('pf-dt-zone', 'Double-tap side zones', [[0.25, 'Narrow (25%)'], [0.35, 'Normal (35%)'], [0.45, 'Wide (45%)']], [0.25, 0.35, 0.45].reduce((a, b) => (Math.abs(b - g.doubleTapZoneWidth) < Math.abs(a - g.doubleTapZoneWidth) ? b : a)))}
${this.selectField('pf-dt-left', 'Double-tap left', TAP_ACTIONS, g.doubleTapLeft)}
${this.selectField('pf-dt-center', 'Double-tap centre', TAP_ACTIONS, g.doubleTapCenter)}
${this.selectField('pf-dt-right', 'Double-tap right', TAP_ACTIONS, g.doubleTapRight)}
<div class="section-label">Mouse</div>
${this.selectField('pf-wheel', 'Scroll wheel', [['volume', 'Volume'], ['seek', 'Seek'], ['speed', 'Speed'], ['zoom', 'Zoom'], ['none', 'Nothing']], (s.mouse || {}).wheel || 'volume')}
${this.selectField('pf-middle', 'Middle click', TAP_ACTIONS.concat([['mute', 'Mute'], ['resetZoom', 'Reset zoom']]), (s.mouse || {}).middleClick || 'playPause')}
<p class="hint">Ctrl + wheel zooms, Shift + wheel fine-seeks (frame steps when paused), Alt + wheel shifts subtitles.</p>
<div class="section-label">Site profile${host ? ` · ${esc(host)}` : ''}</div>
<p class="hint">${this.profile ? `Active: ${esc(fmtRate(this.profile.defaultSpeed || 1))}, ${this.profile.qualityCap ? `${this.profile.qualityCap}p cap` : 'no quality cap'}, GPU ${esc(this.profile.shader || 'off')}, EQ ${esc(this.profile.audioPreset || 'normal')}.` : 'Remember the current speed, quality cap, GPU shader, EQ preset and subtitle size for this site only.'}</p>
<div role="menu" aria-label="Site profile">${this.row({ id: 'pf-site-save', label: this.profile ? 'Update profile with current setup' : 'Save current setup for this site', role: 'menuitem', lead: 'bookmark' })}${this.profile ? this.row({ id: 'pf-site-del', label: 'Remove site profile', role: 'menuitem', lead: 'trash' }) : ''}</div>
<div class="section-label">Keyboard</div>${keys}
<div role="menu" aria-label="Keyboard actions">${this.row({ id: 'pf-keys-reset', label: 'Reset shortcuts', role: 'menuitem', lead: 'rotate' })}${this.row({ id: 'pf-help', label: 'Show all shortcuts', meta: '?', role: 'menuitem', lead: 'help' })}</div>
<div class="section-label">Device</div>
<p class="hint">Detected as a ${esc({ low: 'low-end device (smaller buffers, fewer downloads, saves memory and battery)', standard: 'standard device', high: 'high-end device (more parallel downloads, bigger cache)' }[s.hwTier] || 'device not detected yet')}. Only settings you had not changed were adjusted.</p>
<div role="menu" aria-label="Device">${this.row({ id: 'pf-hw', label: 'Re-detect and re-tune for this device', meta: s.hwTier || '', role: 'menuitem', lead: 'rotate' })}</div>
<div class="section-label">Backup &amp; restore</div>
<p class="hint">Settings, site profiles, presets, shortcuts, bookmarks and watch history in one .json file.</p>
<div role="menu" aria-label="Backup and restore">${this.row({ id: 'pf-backup-export', label: 'Export settings (.json)', role: 'menuitem', lead: 'download' })}${this.row({ id: 'pf-backup-import', label: 'Import settings (.json)', role: 'menuitem', lead: 'rotate' })}</div>
<input type="file" id="pf-backup-file" accept=".json,application/json" hidden>`;
        }

        /** Prefs → Player look: skin, density, scrubber, darkness, button visibility and order. */
        lookSection() {
            const lk = this.settings.look;
            const skin = SKINS.find(k => k[0] === lk.skin) || SKINS[0];
            const scrimText = lk.scrim < 0 ? 'Skin default' : `${lk.scrim}%`;
            const shows = LOOK_BUTTONS.map(id => this.switchField(`pf-lb-${id}`, `${LOOK_LABELS[id]}${LOOK_PRO.includes(id) ? ' (Pro)' : ''}`, !lk.hidden.includes(id))).join('');
            const order = [...new Set(lk.order.concat(LOOK_ORDERABLE))];
            const rows = order.map((id, i) => `<div class="list-row"><span>${esc(LOOK_LABELS[id])}</span><button type="button" class="pillbtn" id="pf-lo-up-${id}" data-move="${id}" data-dir="-1"${i === 0 ? ' disabled' : ''} aria-label="Move ${esc(LOOK_LABELS[id])} left">Left</button><button type="button" class="pillbtn" id="pf-lo-dn-${id}" data-move="${id}" data-dir="1"${i === order.length - 1 ? ' disabled' : ''} aria-label="Move ${esc(LOOK_LABELS[id])} right">Right</button></div>`).join('');
            return `<div class="section-label">Player look</div>
${this.selectField('pf-skin', 'Skin', SKINS.map(k => [k[0], k[1]]), lk.skin)}
<p class="hint" id="pf-skin-hint">${esc(skin[2])}</p>
${this.selectField('pf-density', 'Controls', [['minimal', 'Minimal'], ['standard', 'Standard'], ['pro', 'Pro (frame step, A–B, snapshot, EQ, GPU)']], lk.density)}
${this.selectField('pf-scrubber', 'Seek bar', [['classic', 'Classic'], ['chapters', 'Chapter segments'], ['heatmap', 'Loudness & buffer heatmap']], lk.scrubber)}
${this.rangeField('pf-scrubh', 'Seek bar thickness', 3, 10, 1, lk.scrubHeight, `${lk.scrubHeight} px`)}
${this.rangeField('pf-scrim', 'Control background darkness', -5, 95, 5, lk.scrim < 0 ? -5 : lk.scrim, scrimText)}
<details class="look-more" data-sec="buttons"${this.lookOpen.buttons ? ' open' : ''}><summary>Show or hide buttons</summary>${shows}<p class="hint">Studio and Play are always shown. Hidden buttons keep their keyboard shortcuts.</p></details>
<details class="look-more" data-sec="order"${this.lookOpen.order ? ' open' : ''}><summary>Order of the right-hand buttons</summary>${rows}</details>
<div role="menu" aria-label="Player look">${this.row({ id: 'pf-look-reset', label: 'Reset player look', role: 'menuitem', lead: 'rotate' })}</div>`;
        }

        bindLook(byId, select, range) {
            const set = (patch, say) => { this.saveSettings({ look: { ...this.settings.look, ...patch } }); if (say) this.announceOnly(say); };
            select('pf-skin', v => {
                const name = (SKINS.find(k => k[0] === v) || SKINS[0])[1];
                // Compact is built around one-click tools: turn Pro on unless the user chose Minimal.
                const patch = { skin: v };
                if (v === 'compact' && this.settings.look.density === 'standard') patch.density = 'pro';
                set(patch, `Skin: ${name}${patch.density ? ', Pro controls on' : ''}`);
                this.refreshPopover();
            });
            // Remember which collapsible sections are open, so re-renders of the panel keep them open.
            this.pop.querySelectorAll('details.look-more').forEach(d => d.addEventListener('toggle', () => { this.lookOpen[d.dataset.sec] = d.open; }));
            select('pf-density', v => set({ density: v }, `Controls: ${v}`));
            select('pf-scrubber', v => set({ scrubber: v }));
            range('pf-scrubh', v => set({ scrubHeight: v }), v => `${v} px`);
            range('pf-scrim', v => set({ scrim: v < 0 ? -1 : v }), v => (v < 0 ? 'Skin default' : `${v}%`));
            for (const id of LOOK_BUTTONS) {
                const el = byId(`pf-lb-${id}`);
                if (el) el.addEventListener('change', () => {
                    const hidden = new Set(this.settings.look.hidden);
                    if (el.checked) hidden.delete(id); else hidden.add(id);
                    set({ hidden: [...hidden] });
                });
            }
            this.pop.querySelectorAll('[data-move]').forEach(btn => btn.addEventListener('click', () => {
                const order = [...new Set(this.settings.look.order.concat(LOOK_ORDERABLE))];
                const i = order.indexOf(btn.dataset.move);
                const j = i + +btn.dataset.dir;
                if (i < 0 || j < 0 || j >= order.length) return;
                [order[i], order[j]] = [order[j], order[i]];
                set({ order }, `${LOOK_LABELS[order[j]]} moved to position ${j + 1} of ${order.length}`);
                const keep = btn.id;
                this.refreshPopover();
                const again = byId(keep);
                const target = again && !again.disabled ? again : byId(keep.replace(/-(up|dn)-/, (m, d) => (d === 'up' ? '-dn-' : '-up-')));
                if (target) target.focus();
            }));
            const reset = byId('pf-look-reset');
            if (reset) reset.addEventListener('click', () => {
                this.saveSettings({ look: { ...window.VelostreamShared.DEFAULT_SETTINGS.look, hidden: [], order: [] } });
                this.announceOnly('Player look reset');
                this.refreshPopover();
            });
        }

        popHelp() {
            const km = this.settings.keymap;
            const keyName = k => (k === ' ' ? 'Space' : k.replace('Arrow', '') + (k.startsWith('Arrow') ? ' arrow' : ''));
            const keys = Object.keys(ACTIONS).map(a => `<span class="kbd">${esc(keyName(km[a] || ''))}</span><span>${esc(ACTIONS[a])}</span>`).join('');
            const gestures = [
                ['Double-tap edge', `Seek ${this.settings.seekStep} s`], ['Long-press', `${fmtRate(this.settings.longPressRate)} while held`],
                ['Swipe left side', 'Brightness'], ['Swipe right side', 'Volume & boost to 300%'], ['Swipe across', 'Scrub with preview'],
                ['Pinch', 'Zoom to 400%, drag to pan'], ['Tap', 'Show / hide controls'], ['Escape', 'Close menu or player']
            ].map(([k, d]) => `<span class="kbd">${esc(k)}</span><span>${esc(d)}</span>`).join('');
            return `<div class="section-label">Keyboard</div><div class="help-grid">${keys}</div><div class="section-label">Touch${this.settings.gestures.enabled ? '' : ' (disabled)'}</div><div class="help-grid">${gestures}</div>`;
        }

        bindPopover(kind) {
            const p = this.pop;
            const byId = id => this.shadow.getElementById(id);
            const click = (id, fn) => { const el = byId(id); if (el) el.addEventListener('click', fn); };
            const each = (sel, fn) => p.querySelectorAll(sel).forEach(el => el.addEventListener('click', () => fn(el)));
            const range = (id, fn, fmt) => {
                const el = byId(id);
                if (!el) return;
                el.addEventListener('input', () => {
                    const val = +el.value;
                    el.style.setProperty('--p', `${((val - +el.min) / (+el.max - +el.min)) * 100}%`);
                    fn(val);
                    const text = fmt(val);
                    el.setAttribute('aria-valuetext', text);
                    const out = byId(`out-${id}`);
                    if (out) out.textContent = text;
                });
            };
            const select = (id, fn) => { const el = byId(id); if (el) el.addEventListener('change', () => fn(el.value)); };
            const sw = (id, fn) => { const el = byId(id); if (el) el.addEventListener('change', () => fn(el.checked)); };

            // Arrow-key roving between items of the same menu / radio group.
            p.querySelectorAll('[role="menu"], [role="radiogroup"], .pop-body').forEach(group => {
                group.addEventListener('keydown', (e) => {
                    if (!/^(ArrowDown|ArrowUp|ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) return;
                    const items = Array.from(group.querySelectorAll('[role^="menuitem"], [role="radio"]')).filter(el => !el.disabled);
                    const i = items.indexOf(this.shadow.activeElement);
                    if (i < 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight';
                    const n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (fwd ? 1 : -1) + items.length) % items.length;
                    items[n].focus();
                });
            });

            if (kind === 'speed') {
                click('sp-minus', () => this.setRate(this.rate() - 0.05));
                click('sp-plus', () => this.setRate(this.rate() + 0.05));
                each('[data-speed]', el => { this.setRate(+el.dataset.speed); this.closePopover(true); });
            } else if (kind === 'captions') {
                each('[data-sub]', el => {
                    const v = el.dataset.sub;
                    if (v === 'off' || v === 'external') this.selectSubtitle(v);
                    else if (v.startsWith('cap:')) this.loadCapturedTrack(+v.split(':')[1]);
                    else this.selectSubtitle('shaka', +v.split(':')[1]);
                });
                const file = byId('cc-file');
                click('cc-load', () => file.click());
                click('cc-transcript', () => { this.closePopover(false); this.toggleTranscript(); });
                file.addEventListener('change', () => this.loadSubtitleFile(file.files[0]));
                click('cc-off-minus', () => this.setSubOffset(this.subs.offset - 0.1));
                click('cc-off-plus', () => this.setSubOffset(this.subs.offset + 0.1));
                click('cc-sync-voice', () => this.syncSubsToVoice());
                range('cc-speed', v => this.setSubSpeed(v / 1000), v => `${(v / 1000).toFixed(3)}×`);
                each('[data-sub2]', el => {
                    const v = el.dataset.sub2;
                    if (v === 'off') this.loadSecondary('off');
                    else if (v.startsWith('cap:')) this.loadSecondary('cap', +v.split(':')[1]);
                });
                const file2 = byId('cc2-file');
                click('cc2-load', () => file2.click());
                if (file2) file2.addEventListener('change', () => this.loadSecondary('file', file2.files[0]));
                sw('cc-hover', v => sub({ pauseOnHover: v }));
                sw('cc-copy', v => sub({ clickToCopy: v }));
                each('[data-atrack]', el => this.selectAudioTrack(+el.dataset.atrack));
                const sub = patch => this.saveSettings({ subtitles: { ...this.settings.subtitles, ...patch } });
                select('cc-font', v => sub({ font: v }));
                range('cc-size', v => sub({ size: v }), v => `${v}%`);
                select('cc-color', v => sub({ color: v }));
                range('cc-bg', v => sub({ bgOpacity: v }), v => `${v}%`);
                select('cc-edge', v => sub({ edge: v }));
                range('cc-pos', v => sub({ position: v }), v => `${v}%`);
            } else if (kind === 'studio') {
                const tabs = Array.from(p.querySelectorAll('[role="tab"]'));
                const go = (k) => { this.studioTab = k; this.refreshPopover(); const t = byId(`st-tab-${k}`); if (t) t.focus(); };
                tabs.forEach((t, i) => {
                    t.addEventListener('click', () => go(t.dataset.tab));
                    t.addEventListener('keydown', (e) => {
                        let n = -1;
                        if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
                        else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
                        else if (e.key === 'Home') n = 0;
                        else if (e.key === 'End') n = tabs.length - 1;
                        if (n < 0) return;
                        e.preventDefault();
                        go(tabs[n].dataset.tab);
                    });
                });
                this.bindStudioTab(byId, click, each, range, select, sw);
            }
        }

        bindStudioTab(byId, click, each, range, select, sw) {
            const tab = this.studioTab;
            if (tab === 'quality') {
                click('local-open', () => this.openLocalPicker());
                click('local-folder', () => this.openLocalFolder());
                each('[data-stream]', el => this.switchToStream(el.dataset.stream));
                each('[data-q]', el => this.selectQuality(el.dataset.q === 'auto' ? 'auto' : +el.dataset.q));
                select('q-cap', v => { this.setQualityCap(+v); this.announce(`Resolution cap ${+v ? `${v}p` : 'off'}`, 'studio'); });
                const shakaBuf = () => { if (this.player) { try { this.configureShaka(); } catch (_) { /* player gone */ } } };
                select('bf-window', v => {
                    this.saveSettings({ maxBufferSec: +v });
                    const w = PREBUFFER_WINDOWS.find(x => x[0] === +v);
                    this.announce(`Pre-buffer ${w ? w[1] : fmtSpoken(+v)}`, 'studio');
                });
                range('bf-ahead', v => { this.saveSettings({ mseBufferAhead: v }); this.settings.mseBufferAhead = v; shakaBuf(); }, v => `${v} s`);
                range('bf-behind', v => { this.saveSettings({ mseBufferBehind: v }); this.settings.mseBufferBehind = v; shakaBuf(); }, v => `${v} s`);
                range('bf-workers', v => this.saveSettings({ maxWorkers: v }), v => `${v}`);
                select('bf-paused-limit', v => this.saveSettings({ pausedBufferMB: +v }));
                select('bf-cache', v => this.saveSettings({ cacheSizeMB: +v }));
                sw('bf-range', v => this.saveSettings({ rangeAccel: v }));
                sw('bf-pause', v => {
                    this.prefetchPaused = v;
                    this.port.send({ type: 'PREFETCH', enabled: !v });
                    this.announce(v ? 'Background prefetch paused' : 'Background prefetch resumed', 'studio');
                });
                click('bf-purge', () => this.purgeBuffer());
            } else if (tab === 'audio') {
                const audio = patch => {
                    const next = { ...this.settings.audio, ...patch };
                    if (this.audio.ensure()) this.audio.apply(next);
                    this.saveSettings({ audio: next });
                };
                range('au-vol', v => this.setVolume(v / 100, false), v => `${v}%`);
                range('au-boost', v => { audio({ boost: v }); this.island('volume', `${v}% Boost`, v / 300); }, v => `${v}%`);
                each('[data-preset]', el => { audio({ preset: el.dataset.preset }); this.announce(AUDIO_PRESETS[el.dataset.preset].label, 'wave'); this.refreshPopover(); });
                EQ_BANDS.forEach((b, i) => range(`au-eq-${i}`, v => {
                    const eq = this.settings.audio.eq.slice();
                    eq[i] = v;
                    audio({ eq });
                    const lbl = byId(`au-eq-lbl-${i}`);
                    if (lbl) lbl.textContent = `${v > 0 ? '+' : ''}${v} dB`;
                }, v => `${v} decibels`));
                const delay = d => { const val = clamp(this.settings.audio.delayMs + d, 0, 1000); audio({ delayMs: val }); this.island('wave', `Audio delay ${val} ms`); this.refreshPopover(); };
                select('au-ch', v => { audio({ channels: v }); this.announce({ stereo: 'Stereo', mono: 'Mono', left: 'Left channel', right: 'Right channel' }[v], 'wave'); });
                sw('au-pitch', v => { audio({ preservesPitch: v }); this.applyPitch(v); });
                sw('au-norm', v => { audio({ loudnessNorm: v }); this.announce(v ? 'Smart loudness on' : 'Smart loudness off', 'wave'); });
                range('au-width', v => audio({ width: v }), v => `${v}%`);
                range('au-dialogue', v => audio({ dialogue: v }), v => `${v}%`);
                sw('au-crossfeed', v => { audio({ crossfeed: v }); this.announce(v ? 'Headphone crossfeed on' : 'Headphone crossfeed off', 'headphones'); });
                click('au-d-minus', () => delay(-50));
                click('au-d-plus', () => delay(50));
            } else if (tab === 'display') {
                const filt = (key, suffix) => range(`dp-${key}`, v => { this.filters[key] = v; this.applyFilters(); }, v => `${v}${suffix}`);
                filt('brightness', '%'); filt('contrast', '%'); filt('saturate', '%'); filt('sharpness', '%'); filt('hue', '°'); filt('warmth', '%');
                click('dp-original', () => {
                    this.graphicsOriginal = !this.graphicsOriginal;
                    this.applyFilters();
                    this.refreshPopover();
                });
                select('dp-shader', v => {
                    this.graphicsOriginal = false;
                    this.gpuOverride = null;
                    this.gpuBlocked = null;
                    if (this.gpu && this.gpu.failed) this.destroyGpu();
                    this.settings.shader = v;
                    this.saveSettings({ shader: v });
                    this.applyFilters();
                    this.announce(`GPU: ${GPU_PRESETS.find(p => p[0] === v)[1]}`, 'studio');
                    this.refreshPopover();
                });
                range('dp-shader-str', v => { this.settings.shaderStrength = v; this.saveSettings({ shaderStrength: v }); this.applyFilters(); }, v => `${v}%`);
                select('dp-maxres', v => { this.settings.maxRenderRes = +v; this.saveSettings({ maxRenderRes: +v }); this.applyFilters(); });
                select('dp-cpreset', v => {
                    const p = window.VelostreamShared.COLOR_PRESETS[v];
                    const next = { ...this.settings.color, preset: v };
                    if (p) { const { label, ...vals } = p; Object.assign(next, vals); void label; }
                    this.saveSettings({ color: next });
                    this.applyFilters();
                    this.announce(`Look: ${p ? p.label : 'Custom'}`, 'sun');
                    this.refreshPopover();
                });
                for (const k of ['gamma', 'vibrance', 'temperature', 'tint', 'shadows', 'highlights']) {
                    range(`dp-c-${k}`, v => {
                        this.saveSettings({ color: { ...this.settings.color, [k]: v, preset: 'custom' } });
                        this.applyFilters();
                        const sel = byId('dp-cpreset');
                        if (sel) sel.value = 'custom';
                    }, v => (k === 'gamma' ? (v / 100).toFixed(2) : String(v)));
                }
                sw('dp-ambient', v => { this.saveSettings({ ambientMode: v }); this.announce(v ? 'Ambient glow on' : 'Ambient glow off', 'sun'); });
                click('dp-reset', () => { this.filters = { ...DEFAULT_FILTERS }; this.applyFilters(); this.refreshPopover(); this.announce('Display reset', 'sun'); });
                click('dp-preset-save', () => {
                    const name = byId('dp-preset-name').value.trim() || `Preset ${(this.settings.filterPresets || []).length + 1}`;
                    this.saveSettings({ filterPresets: (this.settings.filterPresets || []).concat([{ name: name.slice(0, 40), values: { ...this.filters } }]).slice(-20) });
                    this.refreshPopover();
                    this.announce(`Saved ${name}`, 'check');
                });
                each('[data-fp-apply]', el => {
                    const pr = this.settings.filterPresets[+el.dataset.fpApply];
                    if (pr) { this.filters = { ...DEFAULT_FILTERS, ...pr.values }; this.applyFilters(); this.refreshPopover(); this.announce(`Applied ${pr.name}`, 'sun'); }
                });
                each('[data-fp-del]', el => {
                    const list = this.settings.filterPresets.slice();
                    list.splice(+el.dataset.fpDel, 1);
                    this.saveSettings({ filterPresets: list });
                    this.refreshPopover();
                });
                each('[data-fit]', el => { this.fit = el.dataset.fit; this.layoutVideo(); this.announce(`Aspect: ${FIT_MODES.find(f => f[0] === this.fit)[1]}`, 'expand'); this.refreshPopover(); });
                range('dp-zoom', v => this.setZoom(v / 100, false), v => `${v}%`);
                click('dp-rotate', () => { this.xf.rotate = (this.xf.rotate + 90) % 360; this.layoutVideo(); this.announce(`Rotated ${this.xf.rotate}°`, 'rotate'); this.refreshPopover(); });
                click('dp-flip', () => { this.xf.flip = !this.xf.flip; this.layoutVideo(); this.announce(this.xf.flip ? 'Mirrored' : 'Mirror off', 'flip'); this.refreshPopover(); });
                click('dp-xreset', () => { this.xf = { zoom: 1, panX: 0, panY: 0, rotate: 0, flip: false }; this.fit = 'contain'; this.layoutVideo(); this.announce('Transform reset', 'expand'); this.refreshPopover(); });
            } else if (tab === 'tools') {
                click('tl-a', () => this.setLoopPoint('a'));
                click('tl-b', () => this.setLoopPoint('b'));
                click('tl-clear', () => this.clearLoop());
                click('tl-bm', () => this.addBookmark(''));
                each('[data-bm-go]', el => { const bm = this.bookmarks[+el.dataset.bmGo]; if (bm) this.seekTo(bm.t, true); });
                each('[data-bm-del]', el => { this.bookmarks.splice(+el.dataset.bmDel, 1); this.saveBookmarks(); });
                click('tl-shot', () => this.screenshot());
                click('tl-shot-subs', () => this.screenshot(true));
                click('tl-burst', () => this.snapshotBurst());
                click('tl-fb', () => this.stepFrame(-1));
                click('tl-ff', () => this.stepFrame(1));
                click('tl-cancel', () => this.port.send({ type: 'EXPORT_CANCEL' }));
                click('tl-rec', () => this.onDownloadButton());
                click('tl-export', () => this.startExport());
                click('tl-clip-in', () => this.setClipPoint('start'));
                click('tl-clip-out', () => this.setClipPoint('end'));
                click('tl-clip-clear', () => {
                    this.clip = { start: null, end: null };
                    this.renderMarks();
                    this.refreshPopover();
                    this.announce('Clip marks cleared', 'check');
                });
                click('tl-export-clip', () => { const clip = this.clipRange(); if (clip) this.startExport({ clip }); });
                select('tl-format', v => { this.saveSettings({ exportFormat: v }); this.refreshPopover(); });
                each('[data-sleep]', el => { const m = el.dataset.sleep; this.setSleep(m === 'eov' ? 'eov' : +m); });
                select('tl-skip', v => this.saveSettings({ skipSeconds: +v }));
                sw('tl-smart', v => { this.smart.blocked = false; this.saveSettings({ smartSkip: v }); this.announce(v ? 'Smart skip on' : 'Smart skip off', 'skip'); });
                click('tl-mini', () => this.setMini(true));
                click('tl-audio', () => this.setAudioOnly(!this.audioOnly));
                click('tl-pip', () => this.togglePip());
                click('tl-lock', () => this.setLocked(true));
                each('[data-ext]', el => this.openExternal(el.dataset.ext));
                click('ex-ytdlp', () => this.copyCommand('ytdlp'));
                click('ex-ffmpeg', () => this.copyCommand('ffmpeg'));
                click('ex-link', () => this.copyCommand('link'));
            } else if (tab === 'prefs') {
                each('[data-accent]', el => { this.saveSettings({ theme: el.dataset.accent }); this.refreshPopover(); });
                each('[data-scale]', el => { this.saveSettings({ uiScale: +el.dataset.scale }); this.refreshPopover(); });
                sw('pf-hc', v => this.saveSettings({ highContrast: v }));
                select('pf-rm', v => this.saveSettings({ reducedMotion: v }));
                sw('pf-simple', v => this.saveSettings({ simpleMode: v }));
                select('pf-autohide', v => { this.saveSettings({ autoHideMs: +v }); this.scheduleHide(); });
                sw('pf-stats', v => this.saveSettings({ showStats: v }));
                this.bindLook(byId, select, range);
                select('pf-resume', v => this.saveSettings({ autoResume: v }));
                select('pf-seek', v => this.saveSettings({ seekStep: +v }));
                select('pf-defspeed', v => this.saveSettings({ defaultSpeed: +v }));
                select('pf-defcap', v => this.saveSettings({ qualityCap: +v }));
                sw('pf-autofs', v => this.saveSettings({ autoFullscreen: v }));
                sw('pf-filethumbs', v => { this.saveSettings({ fileThumbnails: v }); if (!v) this.resetFileThumbs(); });
                sw('pf-pipsubs', v => this.saveSettings({ pipSubtitles: v }));
                sw('pf-badge', v => this.saveSettings({ quickLaunchBadge: v }));
                select('pf-lprate', v => this.saveSettings({ longPressRate: +v }));
                for (const k of ['enabled', 'doubleTapSeek', 'longPressSpeed', 'brightnessSwipe', 'volumeSwipe', 'scrubSwipe', 'pinchZoom', 'allowMouseDrag']) {
                    sw(`pf-g-${k}`, v => this.saveSettings({ gestures: { ...this.settings.gestures, [k]: v } }));
                }
                const gest = patch => this.saveSettings({ gestures: { ...this.settings.gestures, ...patch } });
                select('pf-dt-zone', v => gest({ doubleTapZoneWidth: +v }));
                select('pf-dt-left', v => gest({ doubleTapLeft: v }));
                select('pf-dt-center', v => gest({ doubleTapCenter: v }));
                select('pf-dt-right', v => gest({ doubleTapRight: v }));
                const mouse = patch => this.saveSettings({ mouse: { ...this.settings.mouse, ...patch } });
                select('pf-wheel', v => mouse({ wheel: v }));
                select('pf-middle', v => mouse({ middleClick: v }));
                each('[data-key]', el => {
                    this.capturingKey = el.dataset.key;
                    this.refreshPopover();
                    this.announceOnly(`Press the new key for ${ACTIONS[el.dataset.key]}, or Escape to cancel`);
                });
                // keymap:null makes the bridge restore defaults; SETTINGS_CHANGED re-renders.
                click('pf-keys-reset', () => {
                    // A queued keymap edit must not land after (and undo) the reset.
                    if (this.pendingPatch) delete this.pendingPatch.keymap;
                    this.flushSettings();
                    this.port.send({ type: 'SETTINGS_SET', patch: { keymap: null } });
                    this.announce('Shortcuts reset', 'check');
                });
                click('pf-help', () => this.openPopover('help', this.$('.btn-studio')));
                click('pf-hw', () => { this.applyHardwareTier(true); this.refreshPopover(); });
                click('pf-backup-export', () => this.exportBackup());
                click('pf-backup-import', () => { const f = byId('pf-backup-file'); if (f) f.click(); });
                { const f = byId('pf-backup-file'); if (f) f.addEventListener('change', () => { const file = f.files && f.files[0]; f.value = ''; if (file) this.importBackup(file); }); }
                click('pf-site-save', () => this.saveSiteProfile());
                click('pf-site-del', () => this.removeSiteProfile());
            }
        }

        // -----------------------------------------------------------------
        // Media Session (lock-screen controls on mobile)
        // -----------------------------------------------------------------
        setupMediaSession() {
            if (!('mediaSession' in navigator)) return;
            try {
                navigator.mediaSession.metadata = new MediaMetadata({ title: this.$('.title').textContent, artist: 'Velostream' });
                const ms = navigator.mediaSession;
                ms.setActionHandler('play', () => this.video.play());
                ms.setActionHandler('pause', () => this.video.pause());
                ms.setActionHandler('seekbackward', () => this.seekBy(-this.settings.seekStep));
                ms.setActionHandler('seekforward', () => this.seekBy(this.settings.seekStep));
                ms.setActionHandler('seekto', (d) => this.seekTo(d.seekTime));
            } catch (_) { /* partial support */ }
        }
    }

    async function localFilesFromHandle(handle) {
        if (handle.kind === 'file') return [{ file: await handle.getFile(), handle }];
        const files = [];
        for await (const child of handle.values()) files.push(...await localFilesFromHandle(child));
        return files;
    }

    async function filesFromDrop(transfer) {
        const readEntry = async entry => {
            if (entry.isFile) return [{ file: await new Promise((ok, fail) => entry.file(ok, fail)) }];
            const reader = entry.createReader();
            const files = [];
            for (;;) {
                const entries = await new Promise((ok, fail) => reader.readEntries(ok, fail));
                if (!entries.length) return files;
                for (const child of entries) files.push(...await readEntry(child));
            }
        };
        const items = [...transfer.items].filter(item => item.kind === 'file');
        if (!items.length) return [...transfer.files].map(file => ({ file }));
        return (await Promise.all(items.map(async item => {
            const entry = item.webkitGetAsEntry?.();
            const file = item.getAsFile();
            const handle = await item.getAsFileSystemHandle?.().catch(() => null);
            if (handle) return localFilesFromHandle(handle);
            if (entry) return readEntry(entry);
            return file ? [{ file }] : [];
        }))).flat();
    }

    function applyStandaloneAppearance(root) {
        const S = globalThis.VelostreamShared;
        extApi.storage.local.get(S.SETTINGS_KEY).then(result => {
            const settings = S.mergeSettings(result[S.SETTINGS_KEY]);
            const accent = S.ACCENTS[settings.theme];
            root.style.setProperty('--player-accent', accent.fill);
            root.style.setProperty('--player-accent-strong', accent.strong);
            root.style.setProperty('--player-ui-scale', settings.uiScale);
            root.classList.toggle('high-contrast', settings.highContrast);
        }).catch(() => {});
    }

    function bindLocalFiles(player, resumeId, initiallyLocal) {
        const store = globalThis.VelostreamLocal;
        const subtitle = /\.(srt|vtt|ass|ssa)$/i;
        const media = /\.(mp4|m4v|mkv|webm|mov|ogv|avi|mpg|mpeg|ts|m2ts)$/i;
        const sort = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        const root = player.root;
        const video = player.video;
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = 'video/*,.mkv,.srt,.vtt,.ass,.ssa';
        input.hidden = true;
        const prompt = document.createElement('div');
        prompt.className = 'local-intake glass';
        prompt.hidden = !initiallyLocal;
        setHTML(prompt, '<p>Drop videos, folders, or subtitles here</p><div><button type="button" class="pillbtn primary" data-open>Open Local File</button><button type="button" class="pillbtn" data-folder>Open Folder</button></div>');
        const playlist = document.createElement('select');
        playlist.className = 'pillbtn local-playlist';
        playlist.setAttribute('aria-label', 'Local playlist');
        playlist.hidden = true;
        root.append(input, prompt);
        root.querySelector('.titles').after(playlist);
        let queue = [];
        let sidecars = [];
        let index = -1;
        let source;
        let localTracks = [];
        let revision = 0;
        let lastSave = 0;
        let active;

        function save() {
            if (!active || !Number.isFinite(video.currentTime) || video.readyState < 1) return;
            active.time = video.ended ? 0 : video.currentTime;
            if (active.id) store.save({ id: active.id, name: active.file.name, handle: active.handle, time: active.time }).catch(() => {});
        }
        function release() {
            if (!source) return;
            video.pause();
            video.removeAttribute('src');
            video.load();
            if (source) URL.revokeObjectURL(source);
            source = null;
            localTracks = [];
        }
        async function addSubtitles(files, token) {
            const tracks = [];
            for (const { file } of files) {
                if (file.size > 5 * 1024 * 1024) continue;
                const vtt = await file.text();
                if (token !== revision) return;
                if (parseSubtitleFile(vtt).length) tracks.push({ kind: 'subtitles', label: file.name, vtt });
            }
            if (!tracks.length || token !== revision) return;
            localTracks = localTracks.concat(tracks);
            player.setCaptured(localTracks);
            await player.loadCapturedTrack(localTracks.length - tracks.length, false);
            player.refreshPopover();
        }
        const stem = name => name.replace(/\.[^.]+$/, '').toLowerCase();
        let switching = Promise.resolve();
        function play(i) {
            if (!queue[i]) return;
            const entry = queue[i];
            const token = ++revision;
            switching = switching.catch(() => {}).then(async () => {
                await player.ready;
                if (token !== revision || player.closed) return;
                if (!player.localPlayback) {
                    player.saveHistory(true);
                    player.port.send({ type: 'PREFETCH', enabled: false });
                    if (player.exportState?.running) {
                        player.port.send({ type: 'EXPORT_CANCEL' });
                        const state = player.exportState;
                        await state.chain;
                        await player.handleExportMessage(state, { type: 'EXPORT_ERROR', error: 'Download paused.' });
                    }
                } else save();
                player.localPlayback = true;
                active = null;
                release();
                active = entry;
                index = i;
                playlist.selectedIndex = i;
                prompt.hidden = true;
                source = URL.createObjectURL(entry.file);
                await player.finishStreamSwitch({
                    local: true, drm: null, subtitles: [], startTime: entry.time || undefined,
                    stream: { id: entry.id || source, type: 'progressive', title: entry.file.name, url: source }
                });
                const base = stem(entry.file.name);
                const matching = sidecars.filter(({ file }) => stem(file.name) === base || stem(file.name).startsWith(base + '.'));
                await addSubtitles(queue.length === 1 ? sidecars : matching, token);
            }).catch(showError);
        }
        function showError(error) { player.announce(error.message || String(error), 'warn'); }
        player.saveLocalPosition = save;
        let selection = 0;
        async function accept(entries, current) {
            if (current !== selection) return;
            const videos = entries.filter(({ file }) => file.type.startsWith('video/') || media.test(file.name));
            const subs = entries.filter(({ file }) => subtitle.test(file.name));
            if (!videos.length) {
                if (active && subs.length) addSubtitles(subs, revision).catch(showError);
                else if (subs.length && player.stream?.url) await player.loadSubtitleFile(subs[0].file);
                else showError(new Error('Choose a video file first.'));
                return;
            }
            const handles = videos.filter(entry => entry.handle && !entry.id);
            if (handles.length) {
                const known = await store.list().catch(() => []);
                for (const entry of handles) {
                    const sameName = known.filter(prior => prior.name === entry.file.name);
                    for (const prior of sameName) {
                        if (!await entry.handle.isSameEntry(prior.handle).catch(() => false)) continue;
                        entry.id = prior.id;
                        entry.time = prior.time;
                        break;
                    }
                    if (!entry.id) {
                        entry.id = crypto.randomUUID();
                        store.save({ id: entry.id, name: entry.file.name, handle: entry.handle, time: 0 }).catch(() => {});
                    }
                }
            }
            if (current !== selection) return;
            queue = videos.sort((a, b) => sort.compare(a.file.name, b.file.name));
            sidecars = subs;
            playlist.replaceChildren(...queue.map(({ file }) => new Option(file.name)));
            playlist.hidden = queue.length < 2;
            play(0);
        }
        input.onchange = () => {
            accept([...input.files].map(file => ({ file })), ++selection).catch(showError);
            input.value = '';
        };
        player.openLocalPicker = async () => {
            const current = ++selection;
            if (!window.showOpenFilePicker) { input.click(); return; }
            try {
                const handles = await window.showOpenFilePicker({ multiple: true });
                await accept(await Promise.all(handles.map(async handle => ({ handle, file: await handle.getFile() }))), current);
            } catch (error) {
                if (error.name === 'SecurityError') input.click();
                else if (error.name !== 'AbortError') showError(error);
            }
        };
        prompt.querySelector('[data-open]').onclick = player.openLocalPicker;
        const folder = document.createElement('input');
        folder.type = 'file';
        folder.webkitdirectory = true;
        folder.multiple = true;
        folder.hidden = true;
        root.append(folder);
        folder.onchange = () => { accept([...folder.files].map(file => ({ file })), ++selection).catch(showError); folder.value = ''; };
        player.openLocalFolder = async () => {
            const current = ++selection;
            if (!window.showDirectoryPicker) { folder.click(); return; }
            try {
                const directory = await window.showDirectoryPicker();
                await accept(await localFilesFromHandle(directory), current);
            } catch (error) {
                if (error.name === 'SecurityError') folder.click();
                else if (error.name !== 'AbortError') showError(error);
            }
        };
        prompt.querySelector('[data-folder]').onclick = player.openLocalFolder;
        playlist.onchange = () => play(playlist.selectedIndex);
        player.listen(video, 'ended', () => play(index + 1));
        player.listen(video, 'timeupdate', () => {
            if (Date.now() - lastSave >= 3000) { lastSave = Date.now(); save(); }
        });
        player.disposers.push(() => { selection++; revision++; release(); });
        player.listen(window, 'dragover', event => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            root.classList.add('is-dropping');
        });
        player.listen(window, 'dragleave', event => {
            if (!event.relatedTarget) root.classList.remove('is-dropping');
        });
        player.listen(window, 'drop', event => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            root.classList.remove('is-dropping');
            const current = ++selection;
            filesFromDrop(event.dataTransfer).then(entries => accept(entries, current)).catch(error => {
                if (current === selection) showError(error);
            });
        });
        player.listen(window, 'pagehide', event => {
            save();
            if (!event.persisted) { selection++; revision++; release(); }
        });
        if (initiallyLocal && window.top !== window) {
            player.listen(window, 'message', event => {
                const message = event.data;
                if (event.source !== window.parent || message?.type !== 'VELOSTREAM_LOCAL_FILES' ||
                    !Array.isArray(message.files) || !message.files.every(file => file instanceof File)) return;
                accept(message.files.map(file => ({ file })), ++selection).catch(showError);
            });
        }
        if (resumeId) {
            const savedEntry = store.get(resumeId).catch(() => null);
            const resume = document.createElement('button');
            resume.type = 'button';
            resume.className = 'pillbtn primary';
            resume.textContent = 'Resume Local File';
            prompt.querySelector('div').prepend(resume);
            resume.onclick = async () => {
                const current = ++selection;
                try {
                    const entry = await savedEntry;
                    if (!entry) throw new Error('This local file is no longer in the library.');
                    if (await entry.handle.requestPermission({ mode: 'read' }) !== 'granted') {
                        throw new Error('Read access is required to resume the file.');
                    }
                    await accept([{ ...entry, file: await entry.handle.getFile() }], current);
                    resume.remove();
                } catch (error) { showError(error); }
            };
        }
    }

    function mountVaultExport(id) {
        const root = document.createElement('main');
        root.className = 'local-player vault-player';
        setHTML(root, `<section class="vault-panel" aria-labelledby="vault-title">
          <header class="local-heading"><h1 id="vault-title">Offline download</h1><a class="local-control" href="../popup/library.html#offline">Offline / Cached</a></header>
          <p class="local-status" role="status">Ready to open the cached download.</p>
          <progress aria-label="Download progress" max="100" hidden></progress>
          <div class="local-actions">
            <button class="local-control primary" type="button" data-resume>Resume / Export</button>
            <button class="local-control" type="button" data-pause disabled>Pause</button>
          </div>
        </section>`);
        document.body.append(root);
        applyStandaloneAppearance(root);
        const start = root.querySelector('[data-resume]');
        const pause = root.querySelector('[data-pause]');
        const status = root.querySelector('[role="status"]');
        const progress = root.querySelector('progress');
        let port;
        const exportUi = Object.create(VelostreamPlayer.prototype);
        Object.assign(exportUi, {
            shadow: root,
            port: { send: msg => { try { port?.postMessage(msg); } catch (_) {} } },
            announce: message => { status.textContent = message; },
            announceOnly() {},
            updateDownloadButton() {
                const state = this.exportState;
                status.textContent = state.pausing && state.running ? 'Pausing…' : state.status || 'Preparing download…';
                start.disabled = state.running;
                pause.disabled = !state.running || !!state.pausing;
                progress.hidden = !state.running && state.status !== 'Saved';
                if (state.pct || !state.running) progress.value = state.pct;
                else progress.removeAttribute('value');
                if (!state.running) { port?.disconnect(); port = null; }
            }
        });
        start.onclick = async () => {
            start.disabled = true;
            try {
                port = extApi.runtime.connect({ name: 'velostream-vault' });
                const st = exportUi.exportState = { running: true, files: {}, status: '', pct: 0 };
                exportUi.updateDownloadButton();
                port.onMessage.addListener(msg => {
                    if (exportUi.exportState !== st) return;
                    if (msg.type === 'EXPORT_BEGIN' && msg.fileIndex === 0 &&
                        ['ts', 'aac', 'fmp4'].includes(msg.container) && window.VelostreamMux) {
                        st.toMp4 = true;
                        st.outName = msg.filename.replace(/\.[^.]+$/, '.mp4');
                        st.sink = new ExportSink(root, st.outName, 'video/mp4');
                    }
                    exportUi.onExportMessage(msg.data ? { ...msg, data: window.VelostreamShared.unpackBinary(msg.data) } : msg);
                });
                port.onDisconnect.addListener(() => {
                    if (exportUi.exportState === st && st.running) {
                        exportUi.onExportMessage({ type: 'EXPORT_ERROR', error: 'Export paused. Resume to continue.' });
                    }
                });
                port.postMessage({ type: 'EXPORT_RESUME', id });
            } catch (error) {
                if (exportUi.exportState) exportUi.exportState.running = false;
                port?.disconnect();
                port = null;
                status.textContent = error.message;
                start.disabled = false;
                pause.disabled = true;
            }
        };
        pause.onclick = () => {
            exportUi.port.send({ type: 'EXPORT_CANCEL' });
            exportUi.exportState.pausing = true;
            pause.disabled = true;
            status.textContent = 'Pausing…';
        };
        window.addEventListener('pagehide', () => port?.disconnect());
    }

    window.VelostreamVaultExport = mountVaultExport;

    // Started by player.js with an EnginePort and the host layout bridge.
    window.VelostreamPlayer = VelostreamPlayer;
})();
