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
    const GPU_PRESETS = [['off', 'Off'], ['cas', 'Fast Sharpen (CAS)'], ['fsr', 'Upscale + sharpen (FSR-style)'], ['anime4k', 'Anime line reconstruction'], ['deband', 'Deband (smooth gradients)']];
    const PREBUFFER_WINDOWS = [[30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [900, '15 minutes'], [1800, '30 minutes'], [86400, 'Whole video']];
    const CACHE_CAPS = [[256, '256 MB'], [512, '512 MB'], [1024, '1 GB'], [2048, '2 GB'], [4096, '4 GB']];
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
        frameBack: 'Previous frame', frameFwd: 'Next frame', help: 'Shortcut help'
    };
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
        const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(t.trim());
        if (!m) return NaN;
        return (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
    }

    function decodeEntities(s) {
        return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: '\u00a0' }[e]));
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
            const body = parts.slice(textIdx).join(',').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ');
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
        if (!extApi || !extApi.downloads || !extApi.downloads.download) { viaAnchor(); return Promise.resolve(); }
        return new Promise(resolve => {
            let id = null;
            const done = () => {
                try { extApi.downloads.onChanged.removeListener(onChanged); } catch (_) { /* ignore */ }
                URL.revokeObjectURL(url);
                resolve();
            };
            const onChanged = (delta) => {
                if (delta.id !== id || !delta.state) return;
                if (delta.state.current === 'complete' || delta.state.current === 'interrupted') done();
            };
            extApi.downloads.onChanged.addListener(onChanged);
            Promise.resolve(extApi.downloads.download({ url, filename: name, saveAs })).then((dlId) => {
                id = dlId;
                if (id == null) done(); // cancelled before it started
            }, () => {
                try { extApi.downloads.onChanged.removeListener(onChanged); } catch (_) { /* ignore */ }
                viaAnchor();
                resolve();
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
            this.bytes = 0;
        }

        static async pick(container, filename, mime) {
            const sink = new ExportSink(container, filename, mime);
            if (typeof window.showSaveFilePicker === 'function') {
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

        async write(chunk) {
            this.bytes += chunk.byteLength || chunk.size || 0;
            if (this.writable) await this.writable.write(chunk);
            else this.parts.push(chunk instanceof Blob ? chunk : new Blob([chunk]));
        }

        async close() {
            if (this.writable) { await this.writable.close(); this.writable = null; return; }
            const blob = new Blob(this.parts, { type: this.mime });
            this.parts = [];
            await downloadBlob(this.container, blob, this.filename);
        }

        async abort() {
            this.parts = [];
            if (this.writable) { try { await this.writable.abort(); } catch (_) { /* ignore */ } this.writable = null; }
        }
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
                if (m.reqId && this.waiters.has(m.reqId) && (m.type === 'SETTINGS' || m.type === 'STORE_VALUE')) {
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
        }

        get active() { return !!this.ctx; }

        /** Web Audio taps a cross-origin, non-CORS media element as silence: only allow when safe. */
        allowed() {
            const src = this.video.currentSrc || '';
            if (!src) return false;
            if (src.startsWith('blob:')) return true;
            try { return new URL(src).origin === location.origin; } catch (_) { return false; }
        }

        /** Must run inside a user-activation event, otherwise the context starts suspended. */
        ensure() {
            if (this.ctx) {
                if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => { });
                return true;
            }
            if (!this.allowed()) return false;
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return false;
            try {
                const ctx = new AC({ latencyHint: 'playback' });
                const source = ctx.createMediaElementSource(this.video);
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
                this.ctx = ctx;
                this.nodes = { source, delay, eq, comp, gain, analyser, compressing: null };
                source.connect(delay);
                delay.connect(eq[0]);
                for (let i = 0; i < eq.length - 1; i++) eq[i].connect(eq[i + 1]);
                gain.connect(analyser);
                this.channels = null;
                this._routeChannels('stereo');
                this._route(false);
                if (ctx.state === 'suspended') ctx.resume().catch(() => { });
                return true;
            } catch (e) {
                console.warn('[Velostream] Audio graph unavailable:', e);
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

        /** Output channel mode: stereo (as is), mono (downmix), left / right only (on both speakers). */
        _routeChannels(mode) {
            const n = this.nodes;
            if (!n || this.channels === mode) return;
            const ctx = this.ctx;
            try { n.gain.disconnect(ctx.destination); } catch (_) { /* not connected */ }
            if (n.chan) { for (const node of Object.values(n.chan)) { try { node.disconnect(); } catch (_) { /* ignore */ } } }
            n.chan = null;
            if (mode === 'mono') {
                const down = ctx.createGain();
                down.channelCount = 1;
                down.channelCountMode = 'explicit';
                down.channelInterpretation = 'speakers';
                n.gain.connect(down);
                down.connect(ctx.destination);
                n.chan = { down };
            } else if (mode === 'left' || mode === 'right') {
                const split = ctx.createChannelSplitter(2);
                const merge = ctx.createChannelMerger(2);
                const ch = mode === 'left' ? 0 : 1;
                n.gain.connect(split);
                split.connect(merge, ch, 0);
                split.connect(merge, ch, 1);
                merge.connect(ctx.destination);
                n.chan = { split, merge };
            } else {
                n.gain.connect(ctx.destination);
            }
            this.channels = mode;
        }

        apply(audio) {
            if (!this.ctx) return;
            this._routeChannels(audio.channels || 'stereo');
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
                this.layer.innerHTML = html;
            }
            if (this.topLayer) {
                const top = this.secondaryCues ? SubtitleEngine.activeAt(this.secondaryCues, t) : [];
                const topHtml = top.length ? SubtitleEngine.linesHtml(top) : '';
                if (topHtml !== this.lastTopHtml) {
                    this.lastTopHtml = topHtml;
                    this.topLayer.innerHTML = topHtml;
                }
            }
        }
    }

    // =====================================================================
    // Styles - glass design system
    // =====================================================================
    const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.root {
  --fs-scale: 1;
  --u: calc(1px * var(--fs-scale));
  --fs-glass-bg: rgba(28, 28, 30, 0.65);
  --fs-glass-elevated: rgba(44, 44, 46, 0.78);
  --fs-glass-blur: blur(28px) saturate(190%);
  --fs-glass-border: 1px solid rgba(255, 255, 255, 0.14);
  --fs-glass-highlight: inset 0 1px 0 rgba(255, 255, 255, 0.22);
  --fs-shadow-floating: 0 16px 40px rgba(0, 0, 0, 0.55), 0 2px 10px rgba(0, 0, 0, 0.3);
  --fs-accent: #0A84FF;
  --fs-accent-strong: #0058D0;
  --fs-spring: cubic-bezier(0.22, 1, 0.36, 1);
  --fs-text: #ffffff;
  --fs-text-2: rgba(235, 235, 245, 0.82);
  --fs-sep: rgba(255, 255, 255, 0.12);
  --fs-fill: rgba(255, 255, 255, 0.12);
  --fs-fill-hover: rgba(255, 255, 255, 0.2);
  --fs-amber: #FF9F0A;
  --fs-red: #FF453A;
  position: absolute; inset: 0; background: #000; color: var(--fs-text); overflow: hidden; outline: none;
  font: 400 calc(var(--u) * 13)/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", Roboto, system-ui, sans-serif;
  letter-spacing: -0.01em; -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none;
}
.root[data-hc="true"] { --fs-glass-bg: rgba(18, 18, 20, 0.92); --fs-glass-elevated: rgba(28, 28, 30, 0.96); --fs-glass-border: 1px solid rgba(255, 255, 255, 0.45); --fs-text-2: #fff; --fs-sep: rgba(255, 255, 255, 0.45); }
.root[data-rm="on"] *, .root[data-rm="on"] *::before, .root[data-rm="on"] *::after { transition-duration: 0s !important; animation: none !important; }
@media (prefers-reduced-motion: reduce) { .root[data-rm="system"] *, .root[data-rm="system"] *::before, .root[data-rm="system"] *::after { transition-duration: 0s !important; animation: none !important; } }
.sr-only { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.num { font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.glass { background: var(--fs-glass-bg); -webkit-backdrop-filter: var(--fs-glass-blur); backdrop-filter: var(--fs-glass-blur); border: var(--fs-glass-border); box-shadow: var(--fs-glass-highlight), var(--fs-shadow-floating); }
.glass.elevated { background: var(--fs-glass-elevated); }

/* ---------- buttons: exact geometric hit targets, optically centred icons ---------- */
button { font: inherit; color: inherit; letter-spacing: inherit; margin: 0; }
.ib {
  position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: max(44px, calc(var(--u) * 44)); height: max(44px, calc(var(--u) * 44)); padding: 0; border: 0; border-radius: 9999px;
  background: transparent; color: var(--fs-text); cursor: pointer; transition: background 160ms, transform 240ms var(--fs-spring);
}
.ib svg { width: calc(var(--u) * 20); height: calc(var(--u) * 20); }
.ib:hover { background: var(--fs-fill); }
.ib:active { transform: scale(0.92); }
.ib[aria-pressed="true"] { background: var(--fs-fill-hover); color: var(--fs-accent); }
.ib.ring-host svg.ring { position: absolute; inset: 2px; width: calc(100% - 4px); height: calc(100% - 4px); transform: rotate(-90deg); pointer-events: none; }
.ring circle { fill: none; stroke-width: 2.4; }
.ring .track { stroke: rgba(255,255,255,0.18); }
.ring .prog { stroke: var(--fs-accent); stroke-linecap: round; transition: stroke-dashoffset 300ms linear; }
.ib.recording { color: var(--fs-red); }
.ib.recording::after { content: ""; position: absolute; inset: 4px; border-radius: 50%; border: 2px solid var(--fs-red); animation: pulse 1.6s var(--fs-spring) infinite; }
@keyframes pulse { 0% { transform: scale(0.9); opacity: 1; } 100% { transform: scale(1.15); opacity: 0; } }
.pillbtn {
  display: inline-flex; align-items: center; justify-content: center; gap: calc(var(--u) * 6); height: max(44px, calc(var(--u) * 44));
  min-width: max(44px, calc(var(--u) * 44)); padding: 0 calc(var(--u) * 14); border: 0; border-radius: 9999px; cursor: pointer;
  background: var(--fs-fill); color: var(--fs-text); font-weight: 600; transition: background 160ms, transform 240ms var(--fs-spring); white-space: nowrap;
}
.pillbtn:hover { background: var(--fs-fill-hover); }
.pillbtn:active { transform: scale(0.96); }
.pillbtn svg { width: calc(var(--u) * 18); height: calc(var(--u) * 18); }
.pillbtn.primary { background: var(--fs-accent-strong); color: #fff; }
button:focus { outline: none; }
:focus-visible { outline: 2px solid var(--fs-accent) !important; outline-offset: 2px !important; }
.root[data-hc="true"] :focus-visible { outline: 3px solid #fff !important; box-shadow: 0 0 0 6px var(--fs-accent) !important; }
button:disabled { opacity: 0.4; cursor: default; }

/* ---------- stage ---------- */
.stage { position: absolute; inset: 0; overflow: hidden; background: #000; }
.vbox { position: absolute; transform-origin: 50% 50%; will-change: transform; overflow: hidden; }
.vbox video { width: 100%; height: 100%; display: block; background: #000; object-fit: contain; }
.root.audio-only .vbox video { visibility: hidden; }
.vbox .gl-canvas { position: absolute; left: 0; top: 0; pointer-events: none; display: block; }
.vbox .gl-canvas[hidden], .root.audio-only .vbox .gl-canvas { display: none; }
.vbox.gl-on { overflow: hidden; }
.audio-poster { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; flex-direction: column; gap: 12px; color: var(--fs-text-2); }
.audio-poster svg { width: 64px; height: 64px; color: var(--fs-accent); }
.root.audio-only .audio-poster { display: flex; }
.gesture { position: absolute; inset: 0; touch-action: none; }
.subs { position: absolute; left: 6%; right: 6%; display: flex; flex-direction: column; align-items: center; gap: 4px; pointer-events: none; text-align: center; z-index: 4; transition: transform 300ms var(--fs-spring); }
.subs.subs-top { top: max(56px, 9%); bottom: auto !important; transform: none !important; }
.subs.subs-top .cue-line { opacity: 0.92; font-size: 0.86em; }
.root.subs-interactive .subs .cue-line { pointer-events: auto; cursor: copy; }
.root.subs-interactive .subs .cue-line:hover { outline: 2px solid rgba(255, 255, 255, 0.35); outline-offset: 2px; }
.root:not(.controls-hidden):not(.locked):not(.mini) .subs { transform: translateY(calc(-1 * var(--deck-h, 0px))); }
.cue-line { display: inline-block; padding: 2px 10px; border-radius: 8px; white-space: pre-wrap; max-width: 100%; }

/* ---------- chrome visibility ---------- */
.chrome { position: absolute; inset: 0; pointer-events: none; z-index: 5; transition: opacity 280ms var(--fs-spring), visibility 280ms; }
.root.controls-hidden .chrome { opacity: 0; visibility: hidden; }
.root.controls-hidden { cursor: none; }
.root.locked .chrome, .root.mini .chrome { display: none; }

/* ---------- Component A: floating header islands ---------- */
.topgrid {
  position: absolute; top: max(calc(var(--u) * 20), env(safe-area-inset-top)); left: max(calc(var(--u) * 20), env(safe-area-inset-left));
  right: max(calc(var(--u) * 20), env(safe-area-inset-right)); display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; pointer-events: none;
}
.pill-left { justify-self: start; pointer-events: auto; display: flex; align-items: center; gap: calc(var(--u) * 8); padding: 4px calc(var(--u) * 12) 4px 4px; border-radius: 9999px; min-width: 0; max-width: 100%; }
.btn-close { isolation: isolate; }
.btn-close::before { content: ""; position: absolute; width: calc(var(--u) * 36); height: calc(var(--u) * 36); border-radius: 50%; background: var(--fs-fill); z-index: -1; }
.vdiv { width: 1px; height: calc(var(--u) * 24); background: var(--fs-sep); flex: none; }
.titles { display: flex; flex-direction: column; min-width: 0; }
.title { font-size: calc(var(--u) * 13); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: calc(var(--u) * 280); }
.domain { font-size: calc(var(--u) * 11); color: var(--fs-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: calc(var(--u) * 280); }
.chip { display: inline-flex; align-items: center; gap: 4px; height: calc(var(--u) * 24); padding: 0 calc(var(--u) * 8); border-radius: 9999px; background: var(--fs-fill); font-size: calc(var(--u) * 11); font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; flex: none; }
.chip[hidden] { display: none; }
.chip svg { width: calc(var(--u) * 12); height: calc(var(--u) * 12); }
.capsule-right { justify-self: end; pointer-events: auto; display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 9999px; }

/* Dynamic Island HUD */
.island {
  position: absolute; left: 50%; top: max(calc(var(--u) * 20), env(safe-area-inset-top)); z-index: 7; pointer-events: none;
  display: flex; align-items: center; gap: calc(var(--u) * 10); min-height: calc(var(--u) * 44); padding: calc(var(--u) * 8) calc(var(--u) * 16);
  border-radius: 9999px; background: rgba(0, 0, 0, 0.82); color: #fff; font-weight: 600; font-variant-numeric: tabular-nums;
  -webkit-backdrop-filter: var(--fs-glass-blur); backdrop-filter: var(--fs-glass-blur); border: var(--fs-glass-border); box-shadow: var(--fs-shadow-floating);
  transform: translateX(-50%) scale(0.6); opacity: 0; transition: transform 420ms var(--fs-spring), opacity 200ms; white-space: nowrap; max-width: calc(100% - 32px);
}
.island.show { transform: translateX(-50%) scale(1); opacity: 1; }
.island svg { width: 18px; height: 18px; flex: none; }
.island .i-text { overflow: hidden; text-overflow: ellipsis; }
.island .i-bar { width: calc(var(--u) * 96); height: 6px; border-radius: 9999px; background: rgba(255, 255, 255, 0.2); overflow: hidden; flex: none; }
.island .i-bar i { display: block; height: 100%; background: #fff; border-radius: 9999px; transition: width 120ms linear; }
.island.pulse { animation: islandPulse 1.4s ease-in-out infinite; }
@keyframes islandPulse { 50% { box-shadow: 0 0 0 6px rgba(10, 132, 255, 0.25), var(--fs-shadow-floating); } }
@media (max-width: 640px) { .island { top: calc(max(calc(var(--u) * 20), env(safe-area-inset-top)) + 60px); } }

/* ---------- Component B: floating bottom control deck ---------- */
.deck {
  position: absolute; left: 50%; bottom: max(calc(var(--u) * 24), env(safe-area-inset-bottom)); transform: translateX(-50%);
  width: min(calc(var(--u) * 780), calc(100% - 32px)); border-radius: calc(var(--u) * 26); padding: calc(var(--u) * 14) calc(var(--u) * 20) calc(var(--u) * 10); pointer-events: auto;
}
.row1 { display: grid; grid-template-columns: calc(var(--u) * 56) 1fr calc(var(--u) * 56); align-items: center; gap: calc(var(--u) * 12); }
.t-left, .t-right { font-size: calc(var(--u) * 12); color: rgba(255, 255, 255, 0.85); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.t-left { text-align: right; }
.t-right { justify-self: start; background: none; border: 0; padding: 0 4px; height: 32px; min-width: 44px; border-radius: 8px; cursor: pointer; text-align: left; white-space: nowrap; }
.t-right:hover { background: var(--fs-fill); }
.t-right.live { color: #fff; font-weight: 700; display: inline-flex; align-items: center; gap: 6px; }
.t-right.live::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--fs-red); flex: none; }
.t-right.live.behind::before { background: rgba(255, 255, 255, 0.5); }
.timeline { position: relative; height: 32px; display: flex; align-items: center; cursor: pointer; touch-action: none; }
.track { position: relative; width: 100%; height: 6px; border-radius: 999px; background: rgba(255, 255, 255, 0.16); transition: height 180ms var(--fs-spring); }
.timeline:hover .track, .timeline.dragging .track, .timeline:focus-visible .track { height: 10px; }
.layer { position: absolute; top: 0; bottom: 0; border-radius: 999px; }
.buf-cache { background: rgba(10, 132, 255, 0.35); box-shadow: 0 0 8px rgba(10, 132, 255, 0.35); }
.buf-mse { background: rgba(255, 255, 255, 0.42); }
.played { left: 0; background: #fff; }
.thumb { position: absolute; top: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45); transform: scale(0); transition: transform 240ms var(--fs-spring); }
.timeline:hover .thumb, .timeline:focus-visible .thumb { transform: scale(1); }
.timeline.dragging .thumb { transform: scale(1.4); }
.mark { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 2px; background: var(--fs-amber); }
.loop-range { position: absolute; top: 0; bottom: 0; background: rgba(255, 159, 10, 0.3); border-radius: 999px; }
.loop-range[hidden] { display: none; }
.tip {
  position: absolute; bottom: calc(100% + 14px); transform: translateX(-50%); padding: 6px 10px; border-radius: 9999px; white-space: nowrap; pointer-events: none;
  font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; opacity: 0; transition: opacity 160ms;
}
.timeline:hover .tip, .timeline.dragging .tip { opacity: 1; }
.tip { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.tip:has(.tip-thumb:not([hidden])) { border-radius: 14px; padding: 6px; }
.tip-thumb { border-radius: 8px; background-repeat: no-repeat; background-color: #000; }
.tip-thumb[hidden], .tip-chapter[hidden] { display: none; }
.tip-chapter { max-width: 220px; overflow: hidden; text-overflow: ellipsis; font-weight: 600; opacity: 0.9; }
.mark.chapter { background: rgba(255, 255, 255, 0.7); width: 3px; top: 0; bottom: 0; }
.row2 { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; margin-top: calc(var(--u) * 8); gap: 8px; }
.zone-left { justify-self: start; display: flex; align-items: center; gap: 6px; min-width: 0; }
.zone-center { justify-self: center; display: flex; align-items: center; gap: calc(var(--u) * 16); }
.zone-right { justify-self: end; display: flex; align-items: center; gap: 6px; }
.ib.btn-play { width: max(52px, calc(var(--u) * 52)); height: max(52px, calc(var(--u) * 52)); background: rgba(255, 255, 255, 0.18); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35); }
.ib.btn-play svg { width: calc(var(--u) * 24); height: calc(var(--u) * 24); }
.ib.btn-play:hover { background: rgba(255, 255, 255, 0.26); }
.btn-back svg, .btn-fwd svg { width: calc(var(--u) * 24); height: calc(var(--u) * 24); transition: transform 420ms var(--fs-spring); }
.btn-back.spin svg { transform: rotate(-25deg); }
.btn-fwd.spin svg { transform: rotate(25deg); }
.vol { display: flex; align-items: center; border-radius: 9999px; }
.vol input { width: 0; opacity: 0; transition: width 320ms var(--fs-spring), opacity 200ms; }
.vol:hover input, .vol:focus-within input { width: calc(var(--u) * 88); opacity: 1; margin-right: 8px; }
.speed-pill { min-width: calc(var(--u) * 56); padding: 0 12px; font-variant-numeric: tabular-nums; }
.skip-intro { background: rgba(255, 255, 255, 0.92); color: #000; }
.skip-intro:hover { background: #fff; }
.skip-intro[hidden] { display: none; }
.root[data-simple="true"] .adv { display: none !important; }
@media (max-width: 600px) {
  .deck { padding: 12px 12px 8px; border-radius: 22px; }
  .row1 { grid-template-columns: 44px 1fr 56px; gap: 8px; }
  .narrow-hide, .vol { display: none !important; }
  /* Portrait phones: centred transport row, tools spread evenly underneath. */
  .row2 { grid-template-columns: 1fr; row-gap: 4px; }
  .zone-left { display: contents; }
  .zone-center { gap: 24px; }
  .zone-right { justify-self: stretch; justify-content: space-evenly; gap: 0; border-top: 1px solid var(--fs-sep); padding-top: 4px; }
  .skip-intro { position: absolute; right: 0; bottom: calc(100% + 12px); box-shadow: var(--fs-shadow-floating); }
  .title, .domain { max-width: 34vw; }
  .chip.abr { display: none; }
}

/* ---------- spinner, ripples, cards ---------- */
.spinner { position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; margin: -22px; z-index: 4; pointer-events: none; display: none; }
.spinner svg { width: 44px; height: 44px; animation: spin 0.9s linear infinite; }
.root.buffering .spinner { display: block; }
@keyframes spin { to { transform: rotate(360deg); } }
.ripple { position: absolute; top: 18%; bottom: 18%; width: 36%; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 3; opacity: 0; font-weight: 700; font-variant-numeric: tabular-nums; font-size: 15px; gap: 6px; }
.ripple.left { left: 0; border-radius: 0 9999px 9999px 0; } .ripple.right { right: 0; border-radius: 9999px 0 0 9999px; }
.ripple.show { animation: ripple 700ms var(--fs-spring); }
@keyframes ripple { 0% { opacity: 0; background: rgba(255, 255, 255, 0); } 25% { opacity: 1; background: rgba(255, 255, 255, 0.12); } 100% { opacity: 0; background: rgba(255, 255, 255, 0); } }
.unlock-pill { position: absolute; left: 50%; bottom: max(32px, env(safe-area-inset-bottom)); transform: translateX(-50%) scale(0.8); opacity: 0; pointer-events: none; z-index: 9; transition: transform 360ms var(--fs-spring), opacity 200ms; }
.root:not(.locked) .unlock-pill { display: none; }
.root.locked .unlock-pill.show, .root.locked .unlock-pill:focus-visible { transform: translateX(-50%) scale(1); opacity: 1; pointer-events: auto; }
.card { position: absolute; z-index: 10; border-radius: 20px; padding: 16px; }
.error { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(380px, calc(100% - 32px)); display: none; }
.error.show { display: block; }
.error h2 { margin: 0 0 4px; font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.error h2 svg { color: var(--fs-red); width: 20px; height: 20px; }
.error p { margin: 0 0 16px; color: var(--fs-text-2); word-break: break-word; }
.btns { display: flex; gap: 8px; flex-wrap: wrap; }
.resume { left: 50%; top: calc(max(20px, env(safe-area-inset-top)) + 64px); transform: translateX(-50%); display: none; align-items: center; gap: 8px; padding: 6px 6px 6px 16px; border-radius: 9999px; pointer-events: auto; }
.resume.show { display: flex; }
.resume span { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }

/* ---------- Component C: popovers ---------- */
.popover { position: absolute; z-index: 11; width: min(calc(var(--u) * 320), calc(100% - 32px)); max-height: min(70vh, 560px); display: none; flex-direction: column; border-radius: 20px; padding: 12px; touch-action: pan-y; }
.popover.wide { width: min(calc(var(--u) * 360), calc(100% - 32px)); }
/* Fixed height so switching Studio tabs never moves the tab bar under the user's finger. */
.popover.studio { height: min(70vh, 560px, calc(100% - 140px)); }
.popover.studio .pop-body { flex: 1; }
.popover.open { display: flex; animation: popIn 360ms var(--fs-spring); }
.popover.center { left: 50% !important; top: 50% !important; bottom: auto !important; transform: translate(-50%, -50%); width: min(520px, calc(100% - 32px)); }
.popover.center.open { animation: none; }
@keyframes popIn { from { opacity: 0; transform: translateY(8px) scale(0.97); } to { opacity: 1; transform: none; } }
.pop-head { display: flex; align-items: center; justify-content: space-between; padding: 0 0 4px 8px; }
.pop-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
.pop-body { overflow-y: auto; overscroll-behavior: contain; margin: 0 -4px; padding: 0 4px; user-select: text; -webkit-user-select: text; }
.section-label { padding: 12px 10px 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fs-text-2); }
.row {
  display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 8px; width: 100%; height: 40px; padding: 0 10px; border-radius: 10px;
  border: 0; background: transparent; color: var(--fs-text); text-align: left; cursor: pointer; font-variant-numeric: tabular-nums;
}
@media (pointer: coarse) { .row { height: 44px; } }
.row:hover { background: var(--fs-fill); }
.row .ck { width: 18px; height: 18px; color: var(--fs-accent); visibility: hidden; display: inline-flex; }
.row[aria-checked="true"] .ck { visibility: visible; }
.row[aria-checked="true"] .lbl { font-weight: 600; }
.row .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .meta { color: var(--fs-text-2); font-size: 12px; white-space: nowrap; }
.row .lead { width: 18px; height: 18px; color: var(--fs-text-2); display: inline-flex; }
.sep { height: 1px; background: var(--fs-sep); margin: 6px 10px; }
.stepper { display: grid; grid-template-columns: 44px 1fr 44px; align-items: center; gap: 8px; padding: 2px 6px; }
.stepper output { text-align: center; font-weight: 600; font-variant-numeric: tabular-nums; }
.segmented { position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; padding: 2px; border-radius: 10px; background: rgba(118, 118, 128, 0.24); margin: 0 4px 8px; }
.segmented .seg-ind { position: absolute; top: 2px; bottom: 2px; left: 2px; border-radius: 8px; background: rgba(255, 255, 255, 0.22); box-shadow: 0 3px 8px rgba(0, 0, 0, 0.2); transition: transform 360ms var(--fs-spring); pointer-events: none; }
.segmented [role="tab"], .segmented .seg { position: relative; z-index: 1; height: 32px; border: 0; background: none; color: var(--fs-text); border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; padding: 0 4px; white-space: nowrap; }
@media (pointer: coarse) { .segmented [role="tab"], .segmented .seg { height: 40px; } }
.field { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; min-height: 44px; padding: 0 10px; }
.field.stack { grid-template-columns: 1fr; gap: 2px; padding-top: 6px; padding-bottom: 6px; }
.field .flabel { display: flex; justify-content: space-between; gap: 8px; }
.field output { color: var(--fs-text-2); font-variant-numeric: tabular-nums; }
input[type="range"] { -webkit-appearance: none; appearance: none; width: 100%; height: 28px; background: transparent; cursor: pointer; margin: 0; --p: 50%; }
input[type="range"]::-webkit-slider-runnable-track { height: 4px; border-radius: 9999px; background: linear-gradient(to right, #fff var(--p), rgba(255, 255, 255, 0.2) var(--p)); }
input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 22px; height: 22px; margin-top: -9px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4); border: 0; }
input[type="range"]::-moz-range-track { height: 4px; border-radius: 9999px; background: rgba(255, 255, 255, 0.2); }
input[type="range"]::-moz-range-progress { height: 4px; border-radius: 9999px; background: #fff; }
input[type="range"]::-moz-range-thumb { width: 22px; height: 22px; border-radius: 50%; background: #fff; border: 0; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4); }
input[type="checkbox"][role="switch"] { -webkit-appearance: none; appearance: none; position: relative; width: 51px; height: 31px; border-radius: 9999px; background: rgba(120, 120, 128, 0.32); cursor: pointer; margin: 0; transition: background 240ms; flex: none; }
input[type="checkbox"][role="switch"]::after { content: ""; position: absolute; top: 2px; left: 2px; width: 27px; height: 27px; border-radius: 50%; background: #fff; box-shadow: 0 3px 8px rgba(0, 0, 0, 0.3); transition: transform 320ms var(--fs-spring); }
input[type="checkbox"][role="switch"]:checked { background: #1E7A36; }
input[type="checkbox"][role="switch"]:checked::after { transform: translateX(20px); }
.root[data-hc="true"] input[type="checkbox"][role="switch"] { outline: 2px solid #fff; }
select, input[type="text"] { height: 36px; border-radius: 10px; border: var(--fs-glass-border); background: rgba(0, 0, 0, 0.35); color: #fff; font: inherit; padding: 0 10px; max-width: 100%; }
input[type="text"] { width: 100%; min-width: 0; }
.inline { display: flex; gap: 8px; align-items: center; padding: 4px 10px; }
.swatches { display: flex; gap: 4px; padding: 0 6px 8px; }
.swatch { width: 44px; height: 44px; border-radius: 50%; border: 0; padding: 0; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; position: relative; background: none; }
.swatch span { width: 28px; height: 28px; border-radius: 50%; display: block; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25); }
.swatch[aria-checked="true"]::after { content: ""; position: absolute; inset: 4px; border-radius: 50%; border: 2px solid #fff; }
.eq { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; padding: 4px 10px; }
.eq label { display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 11px; color: var(--fs-text-2); font-variant-numeric: tabular-nums; }
.eq input[type="range"] { writing-mode: vertical-lr; direction: rtl; width: 28px; height: 96px; }
.eq input[type="range"]::-webkit-slider-runnable-track { width: 4px; height: 100%; background: linear-gradient(to top, #fff var(--p), rgba(255, 255, 255, 0.2) var(--p)); }
.eq input[type="range"]::-webkit-slider-thumb { margin-top: 0; margin-left: -9px; }
.kbd { font: 600 12px "SF Mono", ui-monospace, Menlo, Consolas, monospace; background: var(--fs-fill); border-radius: 6px; padding: 2px 8px; min-width: 28px; text-align: center; display: inline-block; }
.help-grid { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; align-items: center; padding: 4px 10px; }
.progress { height: 6px; background: rgba(255, 255, 255, 0.16); border-radius: 9999px; overflow: hidden; margin: 8px 10px; }
.progress i { display: block; height: 100%; width: 0; background: var(--fs-accent); border-radius: 9999px; transition: width 300ms linear; }
.hint { color: var(--fs-text-2); font-size: 12px; padding: 2px 10px 6px; margin: 0; }
.sub-preview { margin: 8px 10px; padding: 16px; border-radius: 12px; background: linear-gradient(135deg, #5b6b7d, #2c3e50); text-align: center; }
.list-row { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 4px; padding: 0 0 0 10px; min-height: 44px; border-radius: 10px; }
.list-row:hover { background: var(--fs-fill); }
.list-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }

/* Nerd telemetry popover */
.stats { position: absolute; z-index: 8; right: max(20px, env(safe-area-inset-right)); top: calc(max(20px, env(safe-area-inset-top)) + 64px); width: min(280px, calc(100% - 32px)); border-radius: 20px; padding: 12px 16px; display: none; pointer-events: none; }
.stats.show { display: block; }
.stats dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12px; }
.stats dt { color: var(--fs-text-2); }
.stats dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- mini player ---------- */
.root.mini { border-radius: 16px; border: var(--fs-glass-border); }
.mini-bar { position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); z-index: 9; display: none; align-items: center; gap: 2px; padding: 2px; border-radius: 9999px; }
.root.mini .mini-bar { display: flex; }
.mini-resize { position: absolute; top: 0; left: 0; width: 44px; height: 44px; z-index: 9; display: none; cursor: nwse-resize; touch-action: none; }
.mini-resize::before { content: ""; position: absolute; top: 8px; left: 8px; width: 12px; height: 12px; border-top: 2px solid rgba(255, 255, 255, 0.85); border-left: 2px solid rgba(255, 255, 255, 0.85); border-top-left-radius: 4px; }
.root.mini .mini-resize { display: block; }
.root.mini .popover, .root.mini .stats, .root.mini .resume, .root.mini .island { display: none !important; }
`;

    // =====================================================================
    // Player
    // =====================================================================
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
            this.settings = null;
            this.stream = null;
            this.player = null;
            this.mode = 'mse';
            this.abrAuto = true;
            this.lockedVariantId = null;
            this.engineStats = null;
            this.variantsSig = '';
            this.lastVariantsSentAt = 0;
            this.loop = { a: null, b: null };
            this.bookmarks = [];
            this.filters = { ...DEFAULT_FILTERS };
            this.xf = { zoom: 1, panX: 0, panY: 0, rotate: 0, flip: false };
            this.fit = 'contain';
            this.locked = false;
            this.audioOnly = false;
            this.mini = false;
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
            this.start().catch(err => this.showError('Could not start the player', String((err && err.message) || err)));
        }

        // -----------------------------------------------------------------
        // Lifecycle
        // -----------------------------------------------------------------
        async start() {
            this.setStatus('loading');
            const [settingsMsg, init] = await Promise.all([this.port.request('SETTINGS_GET'), this.initPromise]);
            this.pageUrl = init.pageUrl || '';
            this.stream = init.stream;
            this.settings = this.withProfile(settingsMsg.settings);
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

        /** Overlay the matching site profile (speed, quality cap, shader, EQ, subtitle size) on settings. */
        withProfile(settings) {
            const host = this.stream ? this.siteHost() : '';
            const list = (settings && settings.siteProfiles) || [];
            const p = host ? list.find(x => host === x.host || host.endsWith(`.${x.host}`)) : null;
            this.profile = p || null;
            if (!p) return settings;
            const out = { ...settings };
            if (Number.isFinite(p.defaultSpeed)) out.defaultSpeed = p.defaultSpeed;
            if (Number.isFinite(p.qualityCap)) out.qualityCap = p.qualityCap;
            if (typeof p.shader === 'string') out.shader = p.shader;
            if (Number.isFinite(p.shaderStrength)) out.shaderStrength = p.shaderStrength;
            if (typeof p.audioPreset === 'string') out.audio = { ...out.audio, preset: p.audioPreset };
            if (Number.isFinite(p.subSize)) out.subtitles = { ...out.subtitles, size: p.subSize };
            return out;
        }

        saveSiteProfile() {
            const host = this.siteHost();
            if (!host) { this.announce('This page has no site address to attach a profile to', 'warn'); return; }
            const p = {
                host, defaultSpeed: this.rate(), qualityCap: this.qualityCap || 0,
                shader: this.settings.shader || 'off', shaderStrength: this.settings.shaderStrength,
                audioPreset: this.settings.audio.preset, subSize: this.settings.subtitles.size, savedAt: Date.now()
            };
            const list = (this.settings.siteProfiles || []).filter(x => x.host !== host).concat([p]).slice(-200);
            this.saveSettings({ siteProfiles: list });
            this.profile = p;
            this.announce(`Saved profile for ${host}`, 'check');
            this.refreshPopover();
        }

        removeSiteProfile() {
            const host = this.profile ? this.profile.host : this.siteHost();
            this.saveSettings({ siteProfiles: (this.settings.siteProfiles || []).filter(x => x.host !== host) });
            this.profile = null;
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
            this.hideError();
            if (type === 'progressive') {
                this.mode = 'native';
                v.src = this.stream.url;
                if (startTime) v.currentTime = startTime;
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
                this.onTracksChanged();
            }
            v.playbackRate = this.settings.defaultSpeed || 1;
            this.restoreRememberedState();
            this.setupMediaSession();
            await this.startPlayback();
        }

        /**
         * Autoplay: try with sound; if the browser's policy refuses (NotAllowedError), retry muted
         * without overwriting the remembered mute state, and unmute on the first tap or key press.
         * Only when muted playback also fails does the player wait paused for a press on Play.
         */
        async startPlayback() {
            const v = this.video;
            try {
                await v.play();
                return;
            } catch (e) {
                if (!e || e.name !== 'NotAllowedError' || v.muted) { this.waitForPlay(); return; }
            }
            this.autoMuted = true;          // volumechange must not remember this mute
            v.muted = true;
            try {
                await v.play();
            } catch (_) {
                this.autoMuted = false;
                this.restoreRememberedState();
                this.waitForPlay();
                return;
            }
            this.showMutedNotice();
            this.announceOnly('Autoplaying muted. Tap or press any key to unmute.');
            const unmute = (e) => {
                // The unmuting tap on the video is consumed: it must not also pause playback.
                if (e && e.type === 'pointerdown' && e.target && e.target.classList && e.target.classList.contains('gesture')) e.stopPropagation();
                this.root.removeEventListener('pointerdown', unmute, true);
                this.root.removeEventListener('keydown', unmute, true);
                if (!this.autoMuted) return;
                const m = (this.settings && this.settings.memory) || {};
                v.muted = !!m.muted;
                if (!m.muted && !v.volume) v.volume = 1;
                // Let the resulting volumechange pass before memory tracking resumes.
                setTimeout(() => { this.autoMuted = false; }, 0);
                this.island(v.muted ? 'mute' : 'volume', v.muted ? 'Muted' : `Sound on · ${Math.round(v.volume * 100)}%`);
            };
            this.root.addEventListener('pointerdown', unmute, true);
            this.root.addEventListener('keydown', unmute, true);
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
            const send = (zeroCopy) => new Promise((resolve, reject) => {
                entry = { resolve, reject };
                this.net.set(reqId, entry);
                this.port.send({ type: 'REQUEST', reqId, url: uri, method: request.method || 'GET', headers: { ...(request.headers || {}) }, kind, zeroCopy });
            });
            const promise = send(kind === 'segment' && this.cacheReady).then(async res => {
                if (res.ok && res.inCache) {
                    // Zero-copy: the engine stored the segment; read it from IndexedDB directly.
                    const rec = await this.readCache(res.cacheKey).catch(() => null);
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
                if (this.net.has(reqId)) {
                    this.net.delete(reqId);
                    this.port.send({ type: 'ABORT', reqId });
                    entry.reject(new E(E.Severity.RECOVERABLE, E.Category.PLAYER, E.Code.OPERATION_ABORTED));
                }
                return Promise.resolve();
            });
        }

        destroy({ notify = true } = {}) {
            if (this.closed) return;
            this.saveHistory(true);
            this.closed = true;
            for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
            this.timers.clear();
            clearTimeout(this.hideTimer);
            clearTimeout(this.islandTimer);
            clearTimeout(this.saveTimer);
            clearInterval(this.sleepFadeTimer);
            // Flush debounced saves (remembered volume/quality/subtitles and speed).
            const flush = { ...(this.pendingPatch || {}) };
            if (this.memoryTimer && this.settings) flush.memory = { ...this.settings.memory };
            if (this.speedTimer && this.pendingSpeed) flush.defaultSpeed = this.pendingSpeed;
            clearTimeout(this.memoryTimer);
            clearTimeout(this.speedTimer);
            if (Object.keys(flush).length) this.port.send({ type: 'SETTINGS_SET', patch: flush });
            for (const d of this.disposers.splice(0)) { try { d(); } catch (_) { /* ignore */ } }
            for (const e of this.net.values()) { try { e.reject(new Error('closed')); } catch (_) { /* ignore */ } }
            this.net.clear();
            if (this.resizeObserver) this.resizeObserver.disconnect();
            if (this.gpu) { this.gpu.destroy(); this.gpu = null; }
            try { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => { }); } catch (_) { /* ignore */ }
            try { if (document.fullscreenElement) document.exitFullscreen().catch(() => { }); } catch (_) { /* ignore */ }
            try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch (_) { /* ignore */ }
            this.audio.destroy();
            const v = this.video;
            const finish = () => {
                try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) { /* ignore */ }
                this.host.remove();
                // The content script removes this iframe and restores the site's own player.
                this.hostApi.layout({ cmd: 'close' });
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
            if (notify) this.port.send({ type: 'CLOSE' });
            setTimeout(() => this.port.close(), 100);
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
        onMessage(msg) {
            if (this.closed) return;
            switch (msg.type) {
                case 'RESPONSE':
                case 'FRESH': {
                    const e = this.net.get(msg.reqId);
                    if (e) { this.net.delete(msg.reqId); e.resolve(msg); }
                    break;
                }
                case 'INIT':
                    if (this.resolveInit) { this.resolveInit(msg); this.resolveInit = null; }
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
                    this.settings = this.withProfile(msg.settings);
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
            this.shadow.innerHTML = `
<style>${CSS}</style>
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <filter id="fs-sharpen"><feConvolveMatrix id="fs-kernel" order="3" kernelMatrix="0 0 0 0 1 0 0 0 0" preserveAlpha="true"/></filter>
</svg>
<div class="root" role="dialog" aria-modal="true" aria-label="Velostream player" tabindex="-1" data-rm="system">
  <div class="stage">
    <div class="vbox"><video playsinline webkit-playsinline preload="auto" aria-label="Video"></video><canvas class="gl-canvas" hidden aria-hidden="true"></canvas></div>
    <div class="audio-poster" aria-hidden="true">${icon('headphones', 64)}<span>Audio-only mode</span></div>
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
        <button type="button" class="ib btn-lock" aria-label="Lock touch controls">${icon('lock')}</button>
        <button type="button" class="ib btn-info adv narrow-hide" aria-pressed="false" aria-label="Stream statistics">${icon('info')}</button>
        <button type="button" class="ib ring-host btn-dl adv" aria-label="Download stream">${icon('download')}<svg class="ring" viewBox="0 0 44 44" aria-hidden="true" hidden><circle class="track" cx="22" cy="22" r="19"/><circle class="prog" cx="22" cy="22" r="19" stroke-dasharray="119.38" stroke-dashoffset="119.38"/></svg></button>
        <button type="button" class="ib btn-audio-only adv narrow-hide" aria-pressed="false" aria-label="Audio-only battery saver">${icon('headphones')}</button>
        <button type="button" class="ib btn-mini" aria-label="Collapse to mini player">${icon('mini')}</button>
      </div>
    </header>

    <div class="card resume glass elevated" role="group" aria-label="Resume playback">
      <span class="resume-text num">Resume from 00:00?</span>
      <button type="button" class="pillbtn primary btn-resume">Resume</button>
      <button type="button" class="pillbtn btn-restart">Start over</button>
    </div>

    <section class="deck glass" aria-label="Playback controls">
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
          <div class="tip glass elevated" aria-hidden="true"><div class="tip-thumb" hidden></div><span class="tip-chapter" hidden></span><span class="tip-text">00:00</span></div>
        </div>
        <button type="button" class="t-right num" aria-label="Show remaining time">00:00</button>
      </div>
      <div class="row2">
        <div class="zone-left">
          <div class="vol">
            <button type="button" class="ib btn-mute" aria-label="Mute">${icon('volume')}</button>
            <input type="range" class="vol-slider" min="0" max="100" step="1" value="100" aria-label="Volume" aria-valuetext="100%">
          </div>
          <button type="button" class="pillbtn skip-intro" hidden>${icon('skip')}<span class="num">+85s</span></button>
        </div>
        <div class="zone-center">
          <button type="button" class="ib btn-back" aria-label="Seek back 10 seconds">${skipIcon(-1, 10)}</button>
          <button type="button" class="ib btn-play" aria-label="Play">${icon('play')}</button>
          <button type="button" class="ib btn-fwd" aria-label="Seek forward 10 seconds">${skipIcon(1, 10)}</button>
        </div>
        <div class="zone-right">
          <button type="button" class="pillbtn speed-pill adv narrow-hide" aria-haspopup="menu" aria-expanded="false" aria-label="Playback speed 1.0×"><span class="num">1.0×</span></button>
          <button type="button" class="ib btn-cc" aria-haspopup="dialog" aria-expanded="false" aria-label="Subtitles and audio tracks">${icon('captions')}</button>
          <button type="button" class="ib btn-studio" aria-haspopup="dialog" aria-expanded="false" aria-label="Studio settings">${icon('studio')}</button>
          <button type="button" class="ib btn-pip adv narrow-hide" aria-label="Picture in Picture">${icon('pip')}</button>
          <button type="button" class="ib btn-fs" aria-label="Enter full screen">${icon('fullscreen')}</button>
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
</div>`;
            document.body.appendChild(host);
            this.root = this.$('.root');
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
            this.$('.stats').classList.toggle('show', !!s.showStats);
            this.$('.btn-info').setAttribute('aria-pressed', String(!!s.showStats));
            this.$('.btn-back').innerHTML = skipIcon(-1, s.seekStep);
            this.$('.btn-fwd').innerHTML = skipIcon(1, s.seekStep);
            this.$('.btn-back').setAttribute('aria-label', `Seek back ${s.seekStep} seconds`);
            this.$('.btn-fwd').setAttribute('aria-label', `Seek forward ${s.seekStep} seconds`);
            const skip = this.$('.skip-intro');
            skip.querySelector('span').textContent = `+${s.skipSeconds}s`;
            skip.setAttribute('aria-label', `Skip intro, forward ${s.skipSeconds} seconds`);
            this.applySubtitleStyle();
            if (this.audio.active) this.audio.apply(s.audio);
            if (s.autoHideMs === 0) this.showControls(true);
            this.later(0, () => this.layoutVideo());
        }

        saveSettings(patch) {
            Object.assign(this.settings, patch);
            this.applySettings();
            clearTimeout(this.saveTimer);
            this.pendingPatch = { ...(this.pendingPatch || {}), ...patch };
            this.saveTimer = setTimeout(() => { this.port.send({ type: 'SETTINGS_SET', patch: this.pendingPatch }); this.pendingPatch = null; }, 250);
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
            on('.skip-intro', 'click', () => {
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
                if (this.sleepPausedPrefetch) { this.sleepPausedPrefetch = false; this.port.send({ type: 'PREFETCH', enabled: true }); }
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
            media('loadedmetadata', () => { this.layoutVideo(); this.updateQualityBadge(); this.renderMarks(); });
            media('durationchange', () => this.renderMarks());
            media('resize', () => { this.layoutVideo(); this.updateQualityBadge(); });
            media('seeked', () => { this.subs.render(v.currentTime); if (this.gpu) this.gpu.renderOnce(); });
            media('loadeddata', () => { if (this.gpu) this.gpu.renderOnce(); });
            this.listen(document, 'visibilitychange', () => { if (!document.hidden && this.gpu && this.gpu.active && !v.paused && !this.audioOnly) this.gpu.start(); });
            media('enterpictureinpicture', () => this.$('.btn-pip').setAttribute('aria-pressed', 'true'));
            media('leavepictureinpicture', () => this.$('.btn-pip').setAttribute('aria-pressed', 'false'));
            media('error', () => {
                if (this.mode !== 'native' || !v.error || this.closed) return;
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

            this.resizeObserver = new ResizeObserver(() => this.layoutVideo());
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
            this.$('.i-icon').innerHTML = iconName ? icon(iconName, 18) : '';
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
                const busy = this.video.paused || this.popKind || this.$('.timeline').classList.contains('dragging') || this.$('.resume').classList.contains('show');
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
                b.innerHTML = icon(paused ? 'play' : 'pause');
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
            b.innerHTML = icon(v.muted || v.volume === 0 ? 'mute' : v.volume < 0.5 ? 'volumeLow' : 'volume');
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
            b.innerHTML = icon(fs ? 'exitFullscreen' : 'fullscreen');
            b.setAttribute('aria-label', fs ? 'Exit full screen' : 'Enter full screen');
            if (!fs) { try { screen.orientation.unlock(); } catch (_) { /* ignore */ } }
        }

        async togglePip() {
            try {
                if (document.pictureInPictureElement) await document.exitPictureInPicture();
                else await this.video.requestPictureInPicture();
            } catch (e) {
                this.announce(`Picture in Picture unavailable: ${e.message}`, 'warn');
            }
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
                if (on) {
                    this.prevAbr = { auto: this.abrAuto, id: this.lockedVariantId };
                    const tracks = this.currentVariants();
                    const audioOnlyTrack = tracks.find(t => !t.videoCodec && !t.height);
                    const lowest = audioOnlyTrack || tracks.slice().sort((a, b) => a.bandwidth - b.bandwidth)[0];
                    if (lowest) this.selectQuality(lowest.id, false);
                } else if (this.prevAbr) {
                    if (this.prevAbr.auto) this.selectQuality('auto', false);
                    else if (this.prevAbr.id != null) this.selectQuality(this.prevAbr.id, false);
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

        selectQuality(id, announce = true) {
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
                this.player.selectVariantTrack(t, true);
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
                if (this.player) { try { this.player.selectTextTrack(null); } catch (_) { /* ignore */ } }
                this.announce(`Subtitles: ${this.subs.externalName}`, 'captions');
            } else {
                const t = this.textTracks().find(x => x.id === trackId);
                if (!t) return;
                this.subs.clearShaka();
                this.subs.source = 'shaka';
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
            if (this.subs.externalCues) return this.selectSubtitle('external');
            const tracks = this.textTracks();
            const pick = tracks.find(t => t.id === this.lastShakaText) || tracks[0];
            if (pick) this.selectSubtitle('shaka', pick.id);
            else this.announce('No subtitles. Load a file from the captions menu.', 'captions');
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
            let pausedByHover = false;
            for (const layer of this.$$('.subs')) {
                this.listen(layer, 'pointerover', (e) => {
                    const st = this.settings && this.settings.subtitles;
                    if (!st || !st.pauseOnHover || e.pointerType !== 'mouse' || !e.target.classList.contains('cue-line')) return;
                    if (!this.video.paused) { pausedByHover = true; this.video.pause(); }
                });
                this.listen(layer, 'pointerout', (e) => {
                    if (!pausedByHover || (e.relatedTarget && layer.contains(e.relatedTarget))) return;
                    pausedByHover = false;
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
            if (this.gpu && this.gpu.active) this.gpu.layout(bw, bh, fit);
        }

        setZoom(z, announce) {
            this.xf.zoom = clamp(z, 1, 4);
            if (this.xf.zoom === 1) { this.xf.panX = 0; this.xf.panY = 0; }
            this.clampPan();
            this.layoutVideo();
            if (announce) this.announce(`Zoom ${Math.round(this.xf.zoom * 100)}%`, 'expand');
        }

        clampPan() {
            const maxX = (this.stage.clientWidth * (this.xf.zoom - 1)) / 2;
            const maxY = (this.stage.clientHeight * (this.xf.zoom - 1)) / 2;
            this.xf.panX = clamp(this.xf.panX, -maxX, maxX);
            this.xf.panY = clamp(this.xf.panY, -maxY, maxY);
        }

        applyFilters() {
            const f = this.filters;
            this.applyGpu();
            const gpuOn = !!(this.gpu && this.gpu.active);
            const parts = [`brightness(${f.brightness}%)`, `contrast(${f.contrast}%)`, `saturate(${f.saturate}%)`, `hue-rotate(${f.hue}deg)`, `sepia(${f.warmth}%)`];
            // Sharpness: GPU CAS when WebGL2 works (applyGpu), CPU SVG convolution otherwise.
            if (f.sharpness > 0 && !gpuOn) {
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
            if (!this.settings || this.gpuBlocked) return { preset: 'off', strength: 0 };
            const chosen = this.gpuOverride || this.settings.shader || 'off';
            if (chosen !== 'off') return { preset: chosen, strength: this.settings.shaderStrength };
            if (this.filters.sharpness > 0) return { preset: 'cas', strength: this.filters.sharpness };
            return { preset: 'off', strength: 0 };
        }

        applyGpu() {
            const want = this.effectiveShader();
            if (want.preset === 'off' && !this.gpu) return;
            if (!this.gpu) {
                if (!window.VelostreamShaders || !this.glCanvas) { this.gpuBlocked = 'unavailable'; return; }
                this.gpu = new window.VelostreamShaders.VideoShaderPipeline(this.video, this.glCanvas, {
                    onStepDown: (to) => {
                        const names = { cas: 'Fast Sharpen', off: 'Off' };
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
            const on = this.gpu.configure({ preset: want.preset, strength: want.strength, maxRenderRes: this.settings.maxRenderRes || 2160 });
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
            let base = this.stream.url;
            try { const u = new URL(base); base = u.origin + u.pathname; } catch (_) { /* raw */ }
            return hashKey(base);
        }

        async loadBookmarks() {
            try {
                const res = await this.port.request('STORE_GET', { key: `fs_bm_${this.mediaKey()}` });
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
            if (!this.settings) return;
            this.settings.memory = { ...this.settings.memory, ...patch };
            clearTimeout(this.memoryTimer);
            this.memoryTimer = setTimeout(() => { this.memoryTimer = null; this.saveSettings({ memory: { ...this.settings.memory } }); }, 400);
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

        saveHistory(force) {
            if (!this.stream || !this.settings || this.closed || this.isLive()) return;
            const v = this.video;
            const d = Number.isFinite(v.duration) ? v.duration : 0;
            if (!force && v.paused) return;
            if (v.currentTime < 5 && !force) return;
            if (!d && !v.currentTime) return;
            this.port.send({
                type: 'HISTORY_SAVE',
                key: this.mediaKey(),
                entry: {
                    url: this.stream.url, title: this.$('.title').textContent, page: location.href, t: v.currentTime, d,
                    done: d > 0 && v.currentTime > d - 20,
                    subOffset: this.subs.offset, loopA: this.loop.a, loopB: this.loop.b
                }
            });
        }

        async checkResume() {
            if (!this.settings || this.isLive() || this.closed) return;
            let entry = null;
            try { entry = (await this.port.request('HISTORY_GET', { key: this.mediaKey() })).value; } catch (_) { return; }
            if (!entry) return;
            // Per-video memory is restored even when the position itself is not.
            if (Number.isFinite(entry.subOffset) && entry.subOffset) { this.subs.offset = entry.subOffset; this.subs.lastHtml = null; }
            if (Number.isFinite(entry.loopA)) { this.loop = { a: entry.loopA, b: Number.isFinite(entry.loopB) ? entry.loopB : null }; this.renderMarks(); }
            if (this.settings.autoResume === 'off') return;
            if (entry.done || entry.t < 15) return;
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
        screenshot() {
            const v = this.video;
            if (!v.videoWidth) { this.announce('No video frame yet', 'warn'); return; }
            const c = document.createElement('canvas');
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            try {
                c.getContext('2d').drawImage(v, 0, 0);
                c.toBlob(blob => {
                    if (!blob) { this.announce('Screenshot failed', 'warn'); return; }
                    downloadBlob(this.shadow, blob, `velostream-${fmtTime(v.currentTime).replace(/:/g, '-')}.png`, false);
                    this.announce('Screenshot saved', 'camera');
                }, 'image/png');
            } catch (e) {
                this.announce('Screenshot blocked: cross-origin video without CORS', 'warn');
            }
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
            if (this.exportState && this.exportState.running) {
                this.port.send({ type: 'EXPORT_CANCEL' });
                return;
            }
            if (this.isLive()) {
                if (this.recordingSince) {
                    this.recordingSince = 0;
                    const toMp4 = (this.settings.exportFormat || 'mp4') === 'mp4' && !!window.VelostreamMux && !!(window.shaka && shaka.transmuxer && shaka.transmuxer.TsTransmuxer);
                    const name = `${safeFilename(this.$('.title').textContent || 'live')}-recording.mp4`;
                    this.exportState = { running: true, files: {}, status: 'Saving recording…', pct: 0, toMp4, sink: toMp4 ? new ExportSink(this.shadow, name, 'video/mp4') : null, outName: name, chain: Promise.resolve() };
                    this.port.send({ type: 'RECORD_STOP' });
                    this.updateDownloadButton();
                    this.refreshPopover();
                } else {
                    this.port.send({ type: 'RECORD_START' });
                }
                return;
            }
            this.startExport();
        }

        async startExport() {
            if (this.exportState && this.exportState.running) return;
            if (this.stream.type === 'dash') { this.announce('DASH export is not supported', 'warn'); return; }
            const hls = this.stream.type === 'hls';
            const toMp4 = hls && (this.settings.exportFormat || 'mp4') === 'mp4' && !!window.VelostreamMux && !!(window.shaka && shaka.transmuxer && shaka.transmuxer.TsTransmuxer);
            const title = safeFilename(this.$('.title').textContent || 'video').replace(/\.(m3u8|mpd|mp4|ts)$/i, '');
            const st = { running: true, files: {}, status: 'Starting…', pct: 0, toMp4, sink: null, muxer: null, chain: Promise.resolve() };
            this.exportState = st;
            // Ask for the destination while the click's user activation is still valid.
            if (toMp4 || !hls) {
                const ext = toMp4 ? 'mp4' : ((/\.(mp4|m4v|webm|mkv|mov|ogv)(\?|$)/i.exec(this.stream.url) || ['', 'mp4'])[1]);
                st.sink = await ExportSink.pick(this.shadow, `${title}.${ext}`, toMp4 ? 'video/mp4' : '');
                if (!st.sink) { this.exportState = null; this.announce('Download cancelled', 'download'); return; }
                st.outName = st.sink.filename;
            }
            this.port.send({ type: 'EXPORT_START' });
            this.announce(this.isLive() ? 'Saving live DVR buffer' : 'Download started', 'download');
            this.updateDownloadButton();
            this.refreshPopover();
        }

        updateDownloadButton() {
            const b = this.$('.btn-dl');
            const ring = b.querySelector('.ring');
            const st = this.exportState;
            const live = this.isLive();
            b.classList.toggle('recording', !!this.recordingSince);
            const glyph = st && st.running ? 'stop' : live ? (this.recordingSince ? 'stop' : 'record') : 'download';
            b.firstElementChild.outerHTML = icon(glyph);
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
            st.chain = st.chain.then(() => this.handleExportMessage(st, msg)).catch((err) => {
                console.warn('[Velostream] Export failed', err);
                this.handleExportMessage(st, { type: 'EXPORT_ERROR', error: `Saving failed: ${(err && err.message) || err}` });
                this.port.send({ type: 'EXPORT_CANCEL' });
            });
        }

        /** MP4 conversion failed on the first segment: save the original segments instead. */
        async exportFallbackToRaw(st, err) {
            console.warn('[Velostream] MP4 remux unavailable, saving original format', err);
            st.toMp4 = false;
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
            this.tickCount = (this.tickCount || 0) + 1;
            if (this.tickCount % 2 === 0 && this.settings) this.checkSmartSkip();
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

        updateSkipIntro() {
            const v = this.video;
            const d = Number.isFinite(v.duration) ? v.duration : 0;
            // Offer "skip intro" in the opening stretch of longer on-demand videos.
            this.$('.skip-intro').hidden = !(!this.isLive() && d > 300 && v.currentTime < Math.min(900, d * 0.25));
        }

        sendTelemetry(withVariants) {
            const v = this.video;
            const msg = { type: 'TELEMETRY', currentTime: v.currentTime, bufferAhead: this.bufferAhead(), paused: v.paused, qualityCap: this.qualityCap };
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
            if (mseHtml !== this.lastMseHtml) { this.lastMseHtml = mseHtml; this.$('.layers-mse').innerHTML = mseHtml; }

            // Velostream IndexedDB prefetch (engine timeline == presentation time for VOD HLS)
            let cacheHtml = '';
            if (this.engineStats && !live && this.stream && this.stream.type === 'hls') {
                cacheHtml = (this.engineStats.cachedRanges || []).map(cr => {
                    const s = clamp((cr.start - r.start) / span * 100, 0, 100);
                    const e = clamp((cr.end - r.start) / span * 100, 0, 100);
                    return `<div class="layer buf-cache" style="left:${s}%;width:${e - s}%"></div>`;
                }).join('');
            }
            if (cacheHtml !== this.lastCacheHtml) { this.lastCacheHtml = cacheHtml; this.$('.layers-cache').innerHTML = cacheHtml; }
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
                    box.style.backgroundImage = `url("${url}")`;
                    box.style.backgroundSize = th.imageWidth ? `${th.imageWidth * scale}px ${th.imageHeight * scale}px` : 'cover';
                    box.style.backgroundPosition = `-${(th.positionX || 0) * scale}px -${(th.positionY || 0) * scale}px`;
                    box.hidden = false;
                } catch (_) { box.hidden = true; }
            }, 60);
        }

        /** Thumbnail sprites are fetched through the engine (site Referer) and cached as blob URLs. */
        async thumbImage(uri, startByte, endByte) {
            if (!this.thumbCache) this.thumbCache = new Map();
            const key = `${uri}|${startByte || 0}`;
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
            this.$('.marks').innerHTML = html;
            const lr = this.$('.loop-range');
            if (this.loop.a != null && this.loop.b != null) {
                lr.hidden = false;
                lr.style.left = `${pos(this.loop.a)}%`;
                lr.style.width = `${pos(this.loop.b) - pos(this.loop.a)}%`;
            } else {
                lr.hidden = true;
            }
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
            const rows = [
                ['Resolution', v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '—'],
                ['Frame rate', fps ? `${fps.toFixed(1)} fps` : '—'],
                ['Dropped frames', String(dropped)],
                ['Variant', fmtBitrate(streamBw)],
                ['Codecs', codecs || '—'],
                ['Bandwidth', fmtBitrate(e.bandwidth)],
                ['Workers', `${e.activeWorkers || 0} / ${e.concurrency || 0}${e.accelerated ? ' · range ×4' : ''}`],
                ['Queued', String(e.queued || 0)],
                ['Player buffer', `${this.bufferAhead().toFixed(1)} s`],
                ['Prefetched', `${(e.cachedAhead || 0).toFixed(1)} s`],
                ['IndexedDB', `${fmtBytes(e.cacheBytes)} · ${e.cachedSegments || 0} seg`],
                ['Hits / misses', `${e.cacheHits || 0} / ${e.cacheMisses || 0}`]
            ];
            if (this.isLive()) rows.push(['Live DVR', fmtTime(e.dvrSeconds || 0)]);
            this.$('.stats dl').innerHTML = rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('');
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
                tipText.textContent = `${fmtTime(t - r.start)} • ${fmtDelta(t - this.video.currentTime)}`;
                const ch = this.chapterAt(t);
                tipChapter.hidden = !ch;
                if (ch) tipChapter.textContent = ch.title;
                tip.style.left = `${clamp(ratio * 100, 8, 92)}%`;
                this.updateTipThumb(t);
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
                if (this.errorShown || !this.settings) return;
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
                    g = { mode: 'mini', sx: e.screenX, sy: e.screenY, moved: false };
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
                        if (Math.hypot(e.screenX - g.sx, e.screenY - g.sy) < 6) return;
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
                    if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;
                    clearTimeout(g.longTimer);
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
                        if (val <= 100) {
                            this.video.volume = val / 100;
                            this.video.muted = val === 0;
                            if (this.settings.audio.boost !== 100) { this.settings.audio.boost = 100; this.audio.apply(this.settings.audio); }
                        } else {
                            this.video.volume = 1;
                            this.video.muted = false;
                            this.settings.audio.boost = val;
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
                if (g.mode === 'mini') {
                    if (g.moved) this.dragLayout('move', e, 'end');
                    else if (e.type !== 'pointercancel') this.togglePlay();
                    g = null;
                    return;
                }
                if (g.mode === 'pinch') {
                    if (pointers.size === 0) { this.hideIsland(); this.announceOnly(`Zoom ${Math.round(this.xf.zoom * 100)}%`); g = null; }
                    return;
                }
                clearTimeout(g.longTimer);
                const mode = g.mode;
                const cancelled = e.type === 'pointercancel';
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
                    this.saveSettings({ audio: { ...this.settings.audio } });
                    this.announceOnly(`Volume ${Math.round(this.video.volume * 100)}%`);
                    this.later(600, () => this.hideIsland());
                } else if (!mode && !cancelled) {
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
                        rip.innerHTML = `${skipIcon(delta < 0 ? -1 : 1, step)}<span>${delta < 0 ? '−' : '+'}${step}s</span>`;
                        rip.classList.remove('show');
                        void rip.offsetWidth;
                        rip.classList.add('show');
                    }
                    break;
                }
                case 'fullscreen': this.toggleFullscreen(); break;
                case 'pip': this.togglePip(); break;
                case 'mute': this.toggleMute(); break;
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
            setLast({ t: now, side });
            clearTimeout(getTimer());
            setTimer(setTimeout(() => {
                if (isTouch) this.toggleControls();
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
                case 'speedDown': this.setRate(this.nextPreset(-1)); break;
                case 'speedUp': this.setRate(this.nextPreset(1)); break;
                case 'loopA': this.setLoopPoint('a'); break;
                case 'loopB': this.setLoopPoint('b'); break;
                case 'screenshot': this.screenshot(); break;
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
            this.pop.innerHTML = '';
            if (btn) {
                btn.setAttribute('aria-expanded', 'false');
                if (returnFocus) btn.focus({ preventScroll: true });
            }
            this.scheduleHide();
        }

        positionPopover() {
            const p = this.pop;
            if (this.popKind === 'help') { p.style.left = ''; p.style.top = ''; p.style.bottom = ''; return; }
            const rr = this.root.getBoundingClientRect();
            const dr = this.deck.getBoundingClientRect();
            const br = (this.popButton || this.deck).getBoundingClientRect();
            const w = p.offsetWidth;
            p.style.top = 'auto';
            p.style.bottom = `${rr.bottom - dr.top + 12}px`;
            p.style.left = `${clamp(br.left - rr.left + br.width / 2 - w / 2, 16, Math.max(16, rr.width - w - 16))}px`;
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
            return `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}">${opts}</select></div>`;
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
            this.pop.innerHTML = `<div class="pop-head"><h2 id="fs-pop-title">${titles[kind]}</h2><button type="button" class="ib pop-close" aria-label="Close ${titles[kind]}">${icon('close', 18)}</button></div><div class="pop-body">${body}</div>`;
            this.pop.querySelector('.pop-close').addEventListener('click', () => this.closePopover(true));
            this.bindPopover(kind);
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
            html += this.row({ id: 'cc-load', label: 'Load .srt or .vtt file…', role: 'menuitem', lead: 'upload' });
            html += '</div><input type="file" id="cc-file" accept=".srt,.vtt,text/vtt,application/x-subrip" hidden>';
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
            return `<div class="segmented" role="tablist" aria-label="Studio sections"><span class="seg-ind" style="width:calc((100% - 4px) / ${STUDIO_TABS.length});transform:translateX(${idx * 100}%)"></span>${tabs}</div><div id="st-panel" role="tabpanel" aria-labelledby="st-tab-${STUDIO_TABS[idx][0]}">${panel}</div>`;
        }

        tabQuality() {
            if (this.mode !== 'mse') return `<p class="hint">Quality selection is available for HLS and DASH streams. This is a direct media file.</p>${this.bufferSection()}`;
            return this.qualitySection() + this.bufferSection();
        }

        bufferSection() {
            const s = this.settings;
            const st = this.engineStats || {};
            const ahead = st.cachedAhead != null ? fmtTime(st.cachedAhead) : '—';
            return `<div class="section-label">Buffer &amp; network</div>
${this.selectField('bf-window', 'Pre-buffer window', PREBUFFER_WINDOWS, PREBUFFER_WINDOWS.some(([v]) => v === s.maxBufferSec) ? s.maxBufferSec : 86400)}
${this.rangeField('bf-ahead', 'RAM buffer ahead', 15, 180, 5, s.mseBufferAhead, `${s.mseBufferAhead} s`)}
${this.rangeField('bf-behind', 'Back-buffer kept', 10, 180, 5, s.mseBufferBehind, `${s.mseBufferBehind} s`)}
${this.rangeField('bf-workers', 'Parallel workers', 2, 8, 1, s.maxWorkers, `${s.maxWorkers}`)}
${this.selectField('bf-cache', 'Disk cache cap', CACHE_CAPS, CACHE_CAPS.some(([v]) => v === s.cacheSizeMB) ? s.cacheSizeMB : 2048)}
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
${this.switchField('au-pitch', 'Keep voice pitch when speeding up', a.preservesPitch !== false)}`;
            return html;
        }

        tabDisplay() {
            const f = this.filters;
            let html = this.rangeField('dp-brightness', 'Brightness', 20, 200, 5, f.brightness, `${f.brightness}%`)
                + this.rangeField('dp-contrast', 'Contrast', 50, 200, 5, f.contrast, `${f.contrast}%`)
                + this.rangeField('dp-saturate', 'Saturation', 0, 300, 5, f.saturate, `${f.saturate}%`)
                + this.rangeField('dp-sharpness', 'Sharpness', 0, 100, 5, f.sharpness, `${f.sharpness}%`)
                + this.rangeField('dp-hue', 'Hue', -180, 180, 5, f.hue, `${f.hue}°`)
                + this.rangeField('dp-warmth', 'Eye-care warmth', 0, 100, 5, f.warmth, `${f.warmth}%`);
            const s = this.settings;
            const eff = this.effectiveShader();
            const gpuState = this.gpuBlocked ? `Unavailable: ${this.gpuBlocked}.`
                : this.gpu && this.gpu.active ? `Active: ${GPU_PRESETS.find(p => p[0] === eff.preset)[1]} at ${this.glCanvas.width}×${this.glCanvas.height}${this.gpuOverride ? ' (stepped down for GPU load)' : ''}.`
                    : 'Off.';
            html += `<div class="section-label">GPU enhancement</div>
${this.selectField('dp-shader', 'Shader', GPU_PRESETS, s.shader)}
${this.rangeField('dp-shader-str', 'Strength', 0, 100, 5, s.shaderStrength, `${s.shaderStrength}%`)}
${this.selectField('dp-maxres', 'Max render resolution', [[1080, '1080p'], [1440, '1440p'], [2160, '2160p (4K)']], s.maxRenderRes)}
<p class="hint">${esc(gpuState)} WebGL2 shaders run on the graphics chip and pause while the video is paused or hidden. Heavy presets step down automatically if the device cannot keep up.</p>`;
            html += '<div class="inline"><label class="sr-only" for="dp-preset-name">Preset name</label><input type="text" id="dp-preset-name" placeholder="Preset name" maxlength="40"><button type="button" class="pillbtn primary" id="dp-preset-save">Save</button><button type="button" class="pillbtn" id="dp-reset">Reset</button></div>';
            (this.settings.filterPresets || []).forEach((p, i) => {
                html += `<div class="list-row"><span>${esc(p.name)}</span><button type="button" class="pillbtn" id="dp-apply-${i}" data-fp-apply="${i}">Apply</button><button type="button" class="ib" id="dp-del-${i}" data-fp-del="${i}" aria-label="Delete preset ${esc(p.name)}">${icon('trash', 18)}</button></div>`;
            });
            html += '<div class="section-label" id="lbl-fit">Aspect ratio</div><div role="menu" aria-labelledby="lbl-fit">';
            for (const [k, l, m] of FIT_MODES) html += this.row({ id: `dp-fit-${k.replace(':', '-')}`, label: l, meta: m, checked: this.fit === k, data: `data-fit="${k}"` });
            html += '</div>';
            html += this.rangeField('dp-zoom', 'Zoom', 100, 400, 5, Math.round(this.xf.zoom * 100), `${Math.round(this.xf.zoom * 100)}%`);
            html += `<div role="menu" aria-label="Transform">${this.row({ id: 'dp-rotate', label: 'Rotate 90°', meta: `${this.xf.rotate}°`, role: 'menuitem', lead: 'rotate' })}${this.row({ id: 'dp-flip', label: 'Mirror', meta: this.xf.flip ? 'On' : 'Off', role: 'menuitem', lead: 'flip' })}${this.row({ id: 'dp-xreset', label: 'Reset transform', role: 'menuitem', lead: 'expand' })}</div>`;
            return html;
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
${this.row({ id: 'tl-burst', label: 'Snapshot burst', meta: '6 frames', role: 'menuitem', lead: 'burst' })}
${this.row({ id: 'tl-fb', label: 'Previous frame', meta: ',', role: 'menuitem', lead: 'frameBack' })}
${this.row({ id: 'tl-ff', label: 'Next frame', meta: '.', role: 'menuitem', lead: 'frameFwd' })}</div>`;
            const st = this.exportState;
            const live = this.isLive();
            html += `<div class="section-label">${live ? 'Record &amp; DVR' : 'Download'}</div>`;
            if (st && (st.running || st.status)) {
                html += `<div class="progress" role="progressbar" aria-label="Download progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${st.pct || 0}"><i style="width:${st.pct || 0}%"></i></div><p class="hint num">${esc(st.status || '')}</p>`;
            }
            html += '<div role="menu" aria-label="Download">';
            if (st && st.running) {
                html += this.row({ id: 'tl-cancel', label: 'Cancel', role: 'menuitem', lead: 'stop' });
            } else if (live) {
                html += this.row({ id: 'tl-rec', label: this.recordingSince ? 'Stop & save recording' : 'Record from now', role: 'menuitem', lead: this.recordingSince ? 'stop' : 'record' });
                html += this.row({ id: 'tl-export', label: 'Save DVR buffer', meta: fmtTime((this.engineStats && this.engineStats.dvrSeconds) || 0), role: 'menuitem', lead: 'download' });
            } else if (this.stream.type !== 'dash') {
                html += this.row({ id: 'tl-export', label: this.stream.type === 'hls' ? ((this.settings.exportFormat || 'mp4') === 'mp4' ? 'Save as .mp4' : 'Save original segments') : 'Save file', role: 'menuitem', lead: 'download' });
            }
            html += '</div>';
            if (this.stream.type === 'dash') html += '<p class="hint">DASH export is not supported.</p>';
            if (this.stream.type === 'hls' || live) html += this.selectField('tl-format', 'Save format', [['mp4', 'MP4 (video + audio in one file)'], ['original', 'Original (.ts / .m4s as served)']], this.settings.exportFormat || 'mp4');
            const sleepMode = this.sleep ? this.sleep.mode : 0;
            html += `<div class="section-label" id="lbl-sleep">Sleep timer</div><div role="menu" aria-labelledby="lbl-sleep">${SLEEP_OPTIONS.map(([m, l]) => this.row({ id: `sl-${m}`, label: l, meta: m && sleepMode === m && this.sleep.endsAt ? `${Math.max(0, Math.ceil((this.sleep.endsAt - Date.now()) / 60000))}m left` : '', checked: sleepMode === m, data: `data-sleep="${m}"` })).join('')}</div>`;
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
<div class="section-label">Playback</div>
${this.selectField('pf-resume', 'Resume where I left off', [['ask', 'Ask'], ['always', 'Always'], ['off', 'Off']], s.autoResume)}
${this.selectField('pf-seek', 'Seek step', SEEK_STEPS.map(v => [v, `${v} s`]), s.seekStep)}
${this.selectField('pf-defspeed', 'Default speed', SPEED_PRESETS.map(p => [p, fmtRate(p)]), s.defaultSpeed)}
${this.selectField('pf-defcap', 'Default resolution cap', QUALITY_CAPS, s.qualityCap)}
${this.switchField('pf-autofs', 'Full screen on first tap', s.autoFullscreen)}
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
${this.selectField('pf-middle', 'Middle click', TAP_ACTIONS.concat([['mute', 'Mute']]), (s.mouse || {}).middleClick || 'playPause')}
<p class="hint">Ctrl + wheel zooms, Shift + wheel fine-seeks (frame steps when paused), Alt + wheel shifts subtitles.</p>
<div class="section-label">Site profile${host ? ` · ${esc(host)}` : ''}</div>
<p class="hint">${this.profile ? `Active: ${esc(fmtRate(this.profile.defaultSpeed || 1))}, ${this.profile.qualityCap ? `${this.profile.qualityCap}p cap` : 'no quality cap'}, GPU ${esc(this.profile.shader || 'off')}, EQ ${esc(this.profile.audioPreset || 'normal')}.` : 'Remember the current speed, quality cap, GPU shader, EQ preset and subtitle size for this site only.'}</p>
<div role="menu" aria-label="Site profile">${this.row({ id: 'pf-site-save', label: this.profile ? 'Update profile with current setup' : 'Save current setup for this site', role: 'menuitem', lead: 'bookmark' })}${this.profile ? this.row({ id: 'pf-site-del', label: 'Remove site profile', role: 'menuitem', lead: 'trash' }) : ''}</div>
<div class="section-label">Keyboard</div>${keys}
<div role="menu" aria-label="Keyboard actions">${this.row({ id: 'pf-keys-reset', label: 'Reset shortcuts', role: 'menuitem', lead: 'rotate' })}${this.row({ id: 'pf-help', label: 'Show all shortcuts', meta: '?', role: 'menuitem', lead: 'help' })}</div>`;
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
                each('[data-q]', el => this.selectQuality(el.dataset.q === 'auto' ? 'auto' : +el.dataset.q));
                select('q-cap', v => { this.setQualityCap(+v); this.announce(`Resolution cap ${+v ? `${v}p` : 'off'}`, 'studio'); });
                const shakaBuf = () => { if (this.player) { try { this.configureShaka(); } catch (_) { /* player gone */ } } };
                select('bf-window', v => { this.saveSettings({ maxBufferSec: +v }); this.announce(`Pre-buffer ${PREBUFFER_WINDOWS.find(w => w[0] === +v)[1]}`, 'studio'); });
                range('bf-ahead', v => { this.saveSettings({ mseBufferAhead: v }); this.settings.mseBufferAhead = v; shakaBuf(); }, v => `${v} s`);
                range('bf-behind', v => { this.saveSettings({ mseBufferBehind: v }); this.settings.mseBufferBehind = v; shakaBuf(); }, v => `${v} s`);
                range('bf-workers', v => this.saveSettings({ maxWorkers: v }), v => `${v}`);
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
                click('au-d-minus', () => delay(-50));
                click('au-d-plus', () => delay(50));
            } else if (tab === 'display') {
                const filt = (key, suffix) => range(`dp-${key}`, v => { this.filters[key] = v; this.applyFilters(); }, v => `${v}${suffix}`);
                filt('brightness', '%'); filt('contrast', '%'); filt('saturate', '%'); filt('sharpness', '%'); filt('hue', '°'); filt('warmth', '%');
                select('dp-shader', v => {
                    this.gpuOverride = null;
                    this.gpuBlocked = null;
                    if (this.gpu && this.gpu.failed) { this.gpu.destroy(); this.gpu = null; }
                    this.settings.shader = v;
                    this.saveSettings({ shader: v });
                    this.applyFilters();
                    this.announce(`GPU: ${GPU_PRESETS.find(p => p[0] === v)[1]}`, 'studio');
                    this.refreshPopover();
                });
                range('dp-shader-str', v => { this.settings.shaderStrength = v; this.saveSettings({ shaderStrength: v }); this.applyFilters(); }, v => `${v}%`);
                select('dp-maxres', v => { this.settings.maxRenderRes = +v; this.saveSettings({ maxRenderRes: +v }); this.applyFilters(); });
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
                click('tl-burst', () => this.snapshotBurst());
                click('tl-fb', () => this.stepFrame(-1));
                click('tl-ff', () => this.stepFrame(1));
                click('tl-cancel', () => this.port.send({ type: 'EXPORT_CANCEL' }));
                click('tl-rec', () => this.onDownloadButton());
                click('tl-export', () => this.startExport());
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
                select('pf-resume', v => this.saveSettings({ autoResume: v }));
                select('pf-seek', v => this.saveSettings({ seekStep: +v }));
                select('pf-defspeed', v => this.saveSettings({ defaultSpeed: +v }));
                select('pf-defcap', v => this.saveSettings({ qualityCap: +v }));
                sw('pf-autofs', v => this.saveSettings({ autoFullscreen: v }));
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
                click('pf-keys-reset', () => { this.port.send({ type: 'SETTINGS_SET', patch: { keymap: null } }); this.announce('Shortcuts reset', 'check'); });
                click('pf-help', () => this.openPopover('help', this.$('.btn-studio')));
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

    // Started by player.js with an EnginePort and the host layout bridge.
    window.VelostreamPlayer = VelostreamPlayer;
})();
