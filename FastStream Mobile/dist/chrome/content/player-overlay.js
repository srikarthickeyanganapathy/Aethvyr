/**
 * FastStream Mobile - Player Overlay
 *
 * Runs in the top frame's MAIN world (needed for MediaSource) and is injected by the engine
 * with chrome.scripting.executeScript, which is not subject to the page's CSP. The build
 * (scripts/build.js) concatenates this file with the locally bundled Shaka Player inside one
 * closure that provides `__FS_SHAKA__`; nothing is loaded from a CDN.
 *
 * All network traffic goes through a Shaka scheme plugin -> private MessagePort -> sniffer
 * bridge -> background engine (cache / prefetch / ABR) -> frame that owns the stream.
 *
 * UI: Shadow DOM (#faststream-host), WCAG 2.2 oriented: roles, labels, live announcements,
 * focus trapping, 48px targets, themes, high contrast, reduced motion, UI scaling.
 */
/* global __FS_SHAKA__ */
(function () {
    'use strict';

    const shaka = (typeof __FS_SHAKA__ !== 'undefined' && __FS_SHAKA__) || window.shaka;
    let current = null;

    // =====================================================================
    // Constants
    // =====================================================================
    const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
    const SEEK_STEPS = [5, 10, 15, 30];
    const THEMES = {
        emerald: 'Emerald', blue: 'Electric Blue', amethyst: 'Amethyst', crimson: 'Crimson',
        'hc-yellow': 'High-contrast Yellow/Black', amoled: 'AMOLED Pitch Black', glass: 'Glassmorphic'
    };
    // Arrays (not objects) so integer-like keys keep their display order.
    const UI_SCALES = [[0.85, 'Small (85%)'], [1, 'Default (100%)'], [1.25, 'Large (125%)'], [1.5, 'Extra large (150%)']];
    const AUTOHIDE = [[2000, '2 seconds'], [3000, '3 seconds'], [5000, '5 seconds'], [0, 'Never (keep visible)']];
    const QUALITY_CAPS = [[0, 'No limit'], [2160, '2160p'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [480, '480p'], [360, '360p']];
    const FONTS = {
        system: { label: 'System sans-serif', css: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif' },
        serif: { label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
        mono: { label: 'Monospace', css: 'ui-monospace, Menlo, Consolas, monospace' },
        dyslexic: { label: 'Dyslexia-friendly (OpenDyslexic or Comic, if installed)', css: 'OpenDyslexic, "OpenDyslexic3", "Comic Neue", "Comic Sans MS", sans-serif' },
        hyperlegible: { label: 'Hyperlegible (Atkinson if installed, else Verdana)', css: '"Atkinson Hyperlegible", Verdana, Tahoma, sans-serif' }
    };
    const SUB_COLORS = { '#ffffff': 'White', '#ffff00': 'Yellow', '#00ffff': 'Cyan', '#7CFC00': 'Green', '#ffb000': 'Amber' };
    const AUDIO_PRESETS = {
        normal: { label: 'Normal', eq: [0, 0, 0, 0, 0], compress: false },
        voice: { label: 'Voice / dialogue clarity', eq: [-4, -2, 3, 5, 1], compress: true },
        bass: { label: 'Bass boost', eq: [7, 4, 0, -1, 0], compress: false },
        night: { label: 'Night / loudness normalization', eq: [1, 0, 1, 2, 0], compress: true }
    };
    const EQ_BANDS = [
        { type: 'lowshelf', f: 60 }, { type: 'peaking', f: 230 }, { type: 'peaking', f: 910 },
        { type: 'peaking', f: 3600 }, { type: 'highshelf', f: 14000 }
    ];
    const FIT_MODES = {
        contain: 'Fit (default)', cover: 'Fill / crop', fill: 'Stretch',
        '16:9': 'Force 16:9', '4:3': 'Force 4:3', '21:9': 'Crop to 21:9'
    };
    const DEFAULT_FILTERS = { brightness: 100, contrast: 100, saturate: 100, hue: 0, warmth: 0, sharpness: 0 };
    const ACTIONS = {
        playPause: 'Play / pause', playPauseAlt: 'Play / pause (alt)', seekBack: 'Seek back',
        seekBackAlt: 'Seek back (alt)', seekFwd: 'Seek forward', seekFwdAlt: 'Seek forward (alt)',
        volUp: 'Volume up', volDown: 'Volume down', mute: 'Mute', fullscreen: 'Fullscreen',
        pip: 'Picture-in-picture', captions: 'Subtitles on/off', speedDown: 'Slower', speedUp: 'Faster',
        loopA: 'Set loop point A', loopB: 'Set loop point B', screenshot: 'Screenshot',
        frameBack: 'Previous frame', frameFwd: 'Next frame', help: 'Shortcut help'
    };
    const STATUS = {
        loading: { icon: '…', text: 'Loading' },
        buffering: { icon: '⚠', text: 'Buffering' },
        playing: { icon: '✓', text: 'Playing' },
        paused: { icon: '⏸', text: 'Paused' },
        ended: { icon: '■', text: 'Ended' },
        error: { icon: '✕', text: 'Error' }
    };

    const ICONS = {
        play: 'M8 5v14l11-7z',
        pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
        back: 'M11 18V6l-8.5 6 8.5 6zm.5-6 8.5 6V6l-8.5 6z',
        fwd: 'M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z',
        volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z',
        mute: 'M16.5 12A4.5 4.5 0 0 0 14 8v2.18l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a9 9 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z',
        fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
        exitFullscreen: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
        settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z',
        cc: 'M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1z',
        speed: 'M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z',
        quality: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
        pip: 'M19 7h-8v6h8V7zm2-4H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16.01H3V4.98h18v14.03z',
        lock: 'M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 0 1 6 0v2H9V6zm9 14H6V10h12v10zm-6-3a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
        unlock: 'M12 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm6-9h-1V6A5 5 0 0 0 7.1 5h2.02A3 3 0 0 1 15 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm0 12H6V10h12v10z',
        help: 'M11 18h2v-2h-2v2zm1-16a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm0-14a4 4 0 0 0-4 4h2a2 2 0 1 1 4 0c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5a4 4 0 0 0-4-4z',
        camera: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM9 2 7.17 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3.17L15 2H9zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z',
        close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
        headphones: 'M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h3v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h3a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z',
        download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
        brightness: 'M20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69L23.31 12 20 8.69zM12 18a6 6 0 1 1 0-12 6 6 0 0 1 0 12zm0-10a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'
    };

    // =====================================================================
    // Helpers
    // =====================================================================
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    function icon(name) {
        return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICONS[name]}"/></svg>`;
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
        return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
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
        const sign = sec < 0 ? '−' : '+';
        return sign + fmtTime(Math.abs(sec)).padStart(5, '0');
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

    /** Parse SRT or WebVTT text into [{start, end, text}]. */
    function parseSubtitleFile(text) {
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

    function decodeEntities(s) {
        return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: '\u00a0' }[e]));
    }

    function cueText(cue) {
        if (cue.nestedCues && cue.nestedCues.length) {
            return cue.nestedCues.map(n => (n.lineBreak ? '\n' : cueText(n))).join('');
        }
        return cue.payload || '';
    }

    function downloadBlob(container, blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        container.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    // =====================================================================
    // Port client (MAIN world side of the private MessagePort)
    // =====================================================================
    class PortClient {
        constructor(port, handler) {
            this.port = port;
            this.handler = handler;
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
                const t = setTimeout(() => {
                    this.waiters.delete(reqId);
                    reject(new Error(`${type} timed out`));
                }, timeoutMs);
                this.waiters.set(reqId, (m) => { clearTimeout(t); resolve(m); });
                this.send({ type, reqId, ...extra });
            });
        }

        close() {
            try { this.port.onmessage = null; this.port.close(); } catch (_) { /* ignore */ }
        }
    }

    // =====================================================================
    // Audio engine: Web Audio booster, 5-band EQ, compressor, delay
    // =====================================================================
    class AudioFx {
        constructor(video) {
            this.video = video;
            this.ctx = null;
            this.nodes = null;
            this.swipeBoost = 1;
        }

        get active() {
            return !!this.ctx;
        }

        /** Web Audio taps a cross-origin non-CORS media element as silence: only allow when safe. */
        allowed() {
            const src = this.video.currentSrc || '';
            if (!src) return false;
            if (src.startsWith('blob:')) return true;
            try { return new URL(src).origin === location.origin; } catch (_) { return false; }
        }

        /** Must be called from a user gesture (autoplay policy). */
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
                this.ctx = ctx;
                this.nodes = { source, delay, eq, comp, gain, compressing: null };
                source.connect(delay);
                delay.connect(eq[0]);
                for (let i = 0; i < eq.length - 1; i++) eq[i].connect(eq[i + 1]);
                gain.connect(ctx.destination);
                this._route(false);
                if (ctx.state === 'suspended') ctx.resume().catch(() => { });
                return true;
            } catch (e) {
                console.warn('[FastStream] Audio graph unavailable:', e);
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
            if (compress) {
                last.connect(n.comp);
                n.comp.connect(n.gain);
            } else {
                last.connect(n.gain);
            }
            n.compressing = compress;
        }

        apply(audio) {
            if (!this.ctx) return;
            const preset = AUDIO_PRESETS[audio.preset] || AUDIO_PRESETS.normal;
            const n = this.nodes;
            const t = this.ctx.currentTime;
            preset.eq.forEach((db, i) => n.eq[i].gain.setTargetAtTime(db, t, 0.05));
            const boost = (audio.boost / 100) * this.swipeBoost;
            const compress = preset.compress || boost > 1.5;
            if (compress) {
                n.comp.threshold.value = audio.preset === 'night' ? -45 : -28;
                n.comp.knee.value = 30;
                n.comp.ratio.value = audio.preset === 'night' ? 10 : 4;
                n.comp.attack.value = 0.003;
                n.comp.release.value = 0.25;
            }
            this._route(compress);
            const makeup = audio.preset === 'night' ? 1.6 : 1;
            n.gain.gain.setTargetAtTime(boost * makeup, t, 0.05);
            n.delay.delayTime.setTargetAtTime(clamp(audio.delayMs, 0, 1000) / 1000, t, 0.02);
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
        constructor(layer) {
            this.layer = layer;
            this.shakaCues = [];
            this.shakaKeys = new Set();
            this.externalCues = null;
            this.externalName = '';
            this.source = 'off';  // off | shaka | external
            this.offset = 0;
            this.shakaVisible = false;
            this.lastHtml = '';
        }

        /** Factory handed to Shaka's `textDisplayFactory`. */
        createDisplayer() {
            const self = this;
            return {
                configure() { },
                setTextLanguage() { },
                enableTextDisplayer() { },
                append(cues) {
                    for (const c of cues) {
                        const text = cueText(c).trim();
                        if (!text) continue;
                        const key = `${c.startTime.toFixed(3)}|${c.endTime.toFixed(3)}|${text}`;
                        if (self.shakaKeys.has(key)) continue;
                        self.shakaKeys.add(key);
                        self.shakaCues.push({ start: c.startTime, end: c.endTime, text });
                    }
                    self.shakaCues.sort((a, b) => a.start - b.start);
                },
                remove(start, end) {
                    self.shakaCues = self.shakaCues.filter(c => c.end <= start || c.start >= end);
                    self.shakaKeys = new Set(self.shakaCues.map(c => `${c.start.toFixed(3)}|${c.end.toFixed(3)}|${c.text}`));
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
            let cues = null;
            if (this.source === 'external') cues = this.externalCues;
            else if (this.source === 'shaka') cues = this.shakaCues;
            let html = '';
            if (cues && cues.length) {
                const t = time - this.offset;
                const active = [];
                for (const c of cues) {
                    if (c.start > t) break;
                    if (t < c.end) active.push(c.text);
                }
                if (active.length) {
                    html = active.join('\n').split('\n').map(line => `<span class="cue-line">${esc(line)}</span>`).join('');
                }
            }
            if (html !== this.lastHtml) {
                this.lastHtml = html;
                this.layer.innerHTML = html;
            }
        }
    }

    // =====================================================================
    // Styles
    // =====================================================================
    const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.root {
  --scale: 1; --accent: #3ddc97; --accent-ink: #00110a; --panel: rgba(8,10,12,.94); --panel-solid: #0a0c0f;
  --scrim: rgba(0,0,0,.82); --text: #ffffff; --muted: #e2e6ea; --focus: #ffd60a; --border: rgba(255,255,255,.22);
  --danger: #ff8a8a; --warn: #ffd166;
  position: fixed; inset: 0; z-index: 2147483647; background: #000; color: var(--text);
  font: 400 calc(16px * var(--scale))/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none; overflow: hidden;
  outline: none;
}
.root[data-theme="blue"] { --accent: #4cc2ff; --accent-ink: #001421; }
.root[data-theme="amethyst"] { --accent: #c9a7ff; --accent-ink: #160030; }
.root[data-theme="crimson"] { --accent: #ff8a9b; --accent-ink: #2b0009; }
.root[data-theme="hc-yellow"] { --accent: #ffff00; --accent-ink: #000; --panel: #000; --panel-solid: #000; --scrim: #000; --border: #ffff00; --focus: #00e5ff; }
.root[data-theme="amoled"] { --accent: #f2f2f2; --accent-ink: #000; --panel: #000; --panel-solid: #000; --scrim: rgba(0,0,0,.92); }
.root[data-theme="glass"] { --accent: #7fe7ff; --accent-ink: #001a22; --panel: rgba(18,22,30,.80); }
.root[data-theme="glass"] .panel, .root[data-theme="glass"] .bar, .root[data-theme="glass"] .menu { backdrop-filter: blur(18px) saturate(140%); -webkit-backdrop-filter: blur(18px) saturate(140%); }
.root[data-hc="true"] { --panel: #000; --panel-solid: #000; --scrim: #000; --text: #fff; --muted: #fff; --border: #fff; --focus: #ffff00; }
.root[data-hc="true"] button, .root[data-hc="true"] select, .root[data-hc="true"] input { border: 2px solid #fff !important; }
.root[data-rm="on"] *, .root[data-rm="on"] *::before, .root[data-rm="on"] *::after { transition: none !important; animation: none !important; }
@media (prefers-reduced-motion: reduce) {
  .root[data-rm="system"] *, .root[data-rm="system"] *::before, .root[data-rm="system"] *::after { transition: none !important; animation: none !important; }
}
.sr-only { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
svg { width: 1.5em; height: 1.5em; fill: currentColor; flex: none; }
button, select, input, textarea { font: inherit; color: inherit; }
button {
  min-width: max(48px, 3em); min-height: max(48px, 3em); padding: 0 .6em; border: 1px solid transparent; border-radius: .6em;
  background: transparent; color: var(--text); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: .4em;
  transition: background .15s;
}
button:hover { background: rgba(255,255,255,.14); }
button[aria-pressed="true"], button.on { background: var(--accent); color: var(--accent-ink); }
button:disabled { opacity: .5; cursor: not-allowed; }
:focus { outline: none; }
:focus-visible { outline: 3px solid var(--focus) !important; outline-offset: 2px !important; box-shadow: 0 0 0 5px #000 !important; }
.btn-primary { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
.btn-primary:hover { background: var(--accent); filter: brightness(1.08); }
.btn-outline { border-color: var(--border); }

/* ---------- stage ---------- */
.stage { position: absolute; inset: 0; overflow: hidden; background: #000; }
.vbox { position: absolute; transform-origin: 50% 50%; will-change: transform; }
.vbox video { width: 100%; height: 100%; display: block; background: #000; object-fit: contain; }
.root.audio-only .vbox video { visibility: hidden; }
.audio-poster { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; flex-direction: column; gap: .5em; color: var(--muted); }
.audio-poster svg { width: 5em; height: 5em; color: var(--accent); }
.root.audio-only .audio-poster { display: flex; }
.gesture { position: absolute; inset: 0; touch-action: none; }
.root:not(.controls-hidden):not(.locked) .subs { transform: translateY(calc(-1 * var(--bar-h, 0px))); }
.subs { position: absolute; left: 4%; right: 4%; display: flex; flex-direction: column; align-items: center; gap: .15em; pointer-events: none; text-align: center; z-index: 4; transition: transform .2s; }
.cue-line { display: inline-block; padding: .08em .45em; border-radius: .2em; white-space: pre-wrap; max-width: 100%; }

/* ---------- chrome (controls) ---------- */
.chrome { position: absolute; inset: 0; pointer-events: none; transition: opacity .25s, visibility .25s; z-index: 3; }
.chrome > * { pointer-events: auto; }
.root.controls-hidden .chrome { opacity: 0; visibility: hidden; }
.root.controls-hidden { cursor: none; }
.bar { position: absolute; left: 0; right: 0; display: flex; align-items: center; gap: .25em; padding: .35em max(.6em, env(safe-area-inset-left)); background: var(--scrim); }
.topbar { top: 0; padding-top: max(.35em, env(safe-area-inset-top)); }
.bottom { bottom: 0; flex-direction: column; align-items: stretch; padding-bottom: max(.35em, env(safe-area-inset-bottom)); gap: .1em; }
.row { display: flex; align-items: center; gap: .2em; min-width: 0; flex-wrap: wrap; row-gap: 0; }
.spacer { flex: 1; min-width: .5em; }
.title { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; padding: 0 .3em; }
.status { display: inline-flex; align-items: center; gap: .35em; padding: .25em .7em; border-radius: 1em; border: 1px solid var(--border); background: #000; font-size: .85em; font-weight: 700; white-space: nowrap; }
.status[data-state="error"] { color: var(--danger); border-color: var(--danger); }
.status[data-state="buffering"], .status[data-state="loading"] { color: var(--warn); border-color: var(--warn); }
.status[data-state="playing"] { color: var(--accent); border-color: var(--accent); }
.badge { font-size: .75em; font-weight: 800; padding: .15em .45em; border-radius: .35em; background: #000; border: 1px solid var(--border); color: var(--text); white-space: nowrap; }
.badge.live { background: #b00020; border-color: #ff8a8a; color: #fff; }
.time { font-variant-numeric: tabular-nums; white-space: nowrap; padding: 0 .4em; font-size: .95em; }
.vol { display: flex; align-items: center; }
.vol input { width: 6em; }
.root[data-simple="true"] .adv, .root[data-simple="true"] .vol input { display: none !important; }
@media (max-width: 560px) {
  .narrow-hide { display: none !important; } .vol input { display: none; }
  .bar { gap: 0; padding-left: max(.25em, env(safe-area-inset-left)); padding-right: max(.25em, env(safe-area-inset-right)); }
  .row .spacer { min-width: 0; } .time { padding: 0 .25em; font-size: .9em; }
}

/* ---------- timeline ---------- */
.timeline { position: relative; height: max(48px, 3em); display: flex; align-items: center; cursor: pointer; touch-action: none; margin: 0 .4em; }
.track { position: relative; width: 100%; height: .4em; border-radius: .3em; background: rgba(255,255,255,.28); overflow: visible; transition: height .15s; }
.timeline:hover .track, .timeline.dragging .track, .timeline:focus-visible .track { height: .65em; }
.layer { position: absolute; top: 0; bottom: 0; border-radius: .3em; }
.buf-cache { background: repeating-linear-gradient(45deg, rgba(255,255,255,.35) 0 4px, rgba(255,255,255,.18) 4px 8px); }
.buf-mse { background: rgba(255,255,255,.62); }
.played { background: var(--accent); left: 0; }
.thumb { position: absolute; top: 50%; width: 1.1em; height: 1.1em; margin: -.55em 0 0 -.55em; border-radius: 50%; background: var(--accent); border: 2px solid #000; box-shadow: 0 0 0 2px #fff; }
.mark { position: absolute; top: -.35em; bottom: -.35em; width: 3px; background: #fff; border-radius: 2px; }
.mark.loop { background: var(--warn); width: 4px; }
.mark.bm { background: #9ad1ff; }
.loop-range { position: absolute; top: 0; bottom: 0; background: rgba(255,209,102,.35); }
.tip { position: absolute; bottom: calc(100% + .2em); transform: translateX(-50%); background: #000; color: #fff; border: 1px solid var(--border); padding: .2em .5em; border-radius: .4em; font-variant-numeric: tabular-nums; font-weight: 700; display: none; white-space: nowrap; pointer-events: none; }
.timeline:hover .tip, .timeline.dragging .tip { display: block; }

/* ---------- center ---------- */
.center { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; gap: 1.5em; align-items: center; }
.center button { min-width: max(64px, 4.2em); min-height: max(64px, 4.2em); border-radius: 50%; background: rgba(0,0,0,.72); border: 2px solid rgba(255,255,255,.5); }
.center button.big svg { width: 2.4em; height: 2.4em; }
.spinner { position: absolute; left: 50%; top: 50%; width: 3.5em; height: 3.5em; margin: -1.75em; border-radius: 50%; border: .35em solid rgba(255,255,255,.25); border-top-color: var(--accent); animation: spin 1s linear infinite; display: none; z-index: 2; pointer-events: none; }
.root.buffering .spinner { display: block; }
@keyframes spin { to { transform: rotate(360deg); } }
.hud { position: absolute; left: 50%; top: 18%; transform: translateX(-50%); background: rgba(0,0,0,.85); border: 1px solid var(--border); border-radius: 1em; padding: .6em 1em; display: none; align-items: center; gap: .6em; z-index: 4; font-weight: 700; font-variant-numeric: tabular-nums; pointer-events: none; }
.hud.show { display: flex; }
.hud .meter { width: 8em; height: .5em; background: rgba(255,255,255,.25); border-radius: .3em; overflow: hidden; }
.hud .meter i { display: block; height: 100%; background: var(--accent); }
.ripple { position: absolute; top: 0; bottom: 0; width: 38%; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 2; opacity: 0; font-weight: 800; font-size: 1.2em; }
.ripple.left { left: 0; border-radius: 0 50% 50% 0; } .ripple.right { right: 0; border-radius: 50% 0 0 50%; }
.ripple.show { animation: ripple .6s ease-out; }
@keyframes ripple { 0% { opacity: 0; background: rgba(255,255,255,.0); } 20% { opacity: 1; background: rgba(255,255,255,.18); } 100% { opacity: 0; background: rgba(255,255,255,0); } }
.root.locked .chrome, .root.locked .center { display: none !important; }
.unlock { position: absolute; left: 50%; bottom: 12%; transform: translateX(-50%); z-index: 6; display: none; background: rgba(0,0,0,.85); border: 2px solid var(--accent); }
.root.locked .unlock.show, .root.locked .unlock:focus-visible { display: inline-flex; }
.toast { pointer-events: none; position: absolute; left: 50%; top: 5.5em; transform: translateX(-50%); background: rgba(0,0,0,.9); border: 1px solid var(--border); padding: .5em 1em; border-radius: .7em; font-weight: 600; z-index: 7; display: none; max-width: 90%; text-align: center; }
.toast.show { display: block; }
.error { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(92%, 30em); background: var(--panel-solid); border: 2px solid var(--danger); border-radius: 1em; padding: 1.2em; z-index: 8; display: none; }
.error.show { display: block; }
.error h2 { margin: 0 0 .4em; font-size: 1.15em; color: var(--danger); }
.error p { margin: 0 0 1em; color: var(--muted); word-break: break-word; }
.stats { position: absolute; left: .75em; top: 4.2em; background: rgba(0,0,0,.88); border: 1px solid var(--border); padding: .5em .75em; border-radius: .6em; font: 600 .8em/1.5 ui-monospace, Menlo, Consolas, monospace; z-index: 5; display: none; pointer-events: none; min-width: 16em; }
.root.show-stats .stats { display: block; }
.stats dt { float: left; clear: left; color: var(--muted); margin-right: 1em; }
.stats dd { margin: 0; text-align: right; }

/* ---------- menus & panels ---------- */
.menu { touch-action: pan-y; position: absolute; z-index: 9; width: max-content; max-width: min(92vw, 24em); background: var(--panel); border: 1px solid var(--border); border-radius: .8em; padding: .35em; min-width: 12em; max-height: 60vh; overflow: auto; display: none; box-shadow: 0 10px 30px rgba(0,0,0,.6); }
.menu.open { display: block; }
.menu [role^="menuitem"] { width: 100%; justify-content: flex-start; border-radius: .5em; padding: 0 .8em; }
.menu [aria-checked="true"] { font-weight: 800; box-shadow: inset 4px 0 0 var(--accent); }
.menu [aria-checked="true"]::before { content: "✓"; }
.menu [aria-checked="false"]::before { content: "✓"; visibility: hidden; }
.menu .menu-label { padding: .4em .8em; font-size: .85em; color: var(--muted); font-weight: 700; }
.menu .menu-row { display: flex; gap: .3em; }
.menu .menu-row button { flex: 1; }
.panel { position: absolute; z-index: 10; background: var(--panel); border: 1px solid var(--border); display: none; flex-direction: column; box-shadow: 0 -10px 40px rgba(0,0,0,.6); }
.panel.open { display: flex; }
.drawer { left: 0; right: 0; bottom: 0; max-height: 78vh; border-radius: 1.2em 1.2em 0 0; padding-bottom: env(safe-area-inset-bottom); }
@media (min-width: 900px) { .drawer { left: auto; top: 0; bottom: 0; width: 28em; max-height: none; border-radius: 0; } }
.panel-head { display: flex; align-items: center; gap: .5em; padding: .4em .6em; border-bottom: 1px solid var(--border); }
.panel-head h2 { margin: 0; font-size: 1.1em; flex: 1; }
.tabs { display: flex; overflow-x: auto; gap: .2em; padding: .3em .4em; border-bottom: 1px solid var(--border); scrollbar-width: thin; }
.tabs [role="tab"] { white-space: nowrap; font-weight: 600; }
.tabs [role="tab"][aria-selected="true"] { background: var(--accent); color: var(--accent-ink); }
.tabpanel { overflow-y: auto; padding: .6em .9em 1.2em; flex: 1; user-select: text; -webkit-user-select: text; touch-action: pan-y; }
.tabpanel[hidden] { display: none; }
fieldset { border: 1px solid var(--border); border-radius: .7em; margin: 0 0 .9em; padding: .5em .7em .7em; }
legend { font-weight: 800; padding: 0 .3em; }
.field { display: flex; align-items: center; justify-content: space-between; gap: .6em; min-height: 48px; flex-wrap: wrap; }
.field label { flex: 1 1 10em; }
.field output { font-variant-numeric: tabular-nums; font-weight: 700; min-width: 4.5em; text-align: right; }
.hint { color: var(--muted); font-size: .85em; margin: .2em 0 .4em; }
.btn-row { display: flex; flex-wrap: wrap; gap: .35em; margin: .3em 0; }
select { min-height: 48px; background: #000; color: #fff; border: 1px solid var(--border); border-radius: .5em; padding: 0 .5em; max-width: 100%; }
input[type="text"] { min-height: 48px; background: #000; color: #fff; border: 1px solid var(--border); border-radius: .5em; padding: 0 .6em; flex: 1; min-width: 6em; }
input[type="range"] { -webkit-appearance: none; appearance: none; height: 48px; background: transparent; flex: 1 1 10em; min-width: 8em; accent-color: var(--accent); cursor: pointer; }
input[type="range"]::-webkit-slider-runnable-track { height: .45em; background: rgba(255,255,255,.3); border-radius: .3em; }
input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 1.4em; height: 1.4em; margin-top: -.48em; border-radius: 50%; background: var(--accent); border: 2px solid #000; box-shadow: 0 0 0 2px #fff; }
input[type="range"]::-moz-range-track { height: .45em; background: rgba(255,255,255,.3); border-radius: .3em; }
input[type="range"]::-moz-range-thumb { width: 1.3em; height: 1.3em; border-radius: 50%; background: var(--accent); border: 2px solid #000; }
input[type="checkbox"], input[type="radio"] { width: 1.4em; height: 1.4em; accent-color: var(--accent); margin: 0 .4em 0 0; flex: none; }
.check { display: flex; align-items: center; min-height: 48px; cursor: pointer; }
.list { list-style: none; margin: 0; padding: 0; }
.list li { display: flex; align-items: center; gap: .3em; min-height: 48px; border-bottom: 1px solid rgba(255,255,255,.08); }
.list li span { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.progress { height: .8em; background: rgba(255,255,255,.2); border-radius: .4em; overflow: hidden; margin: .5em 0; }
.progress i { display: block; height: 100%; width: 0; background: var(--accent); }
.kbd { font: 700 .9em ui-monospace, Menlo, Consolas, monospace; background: #000; border: 1px solid var(--border); border-radius: .3em; padding: .1em .45em; min-width: 2em; text-align: center; display: inline-block; }
.dialog { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(94%, 40em); max-height: 88vh; border-radius: 1em; }
.help-grid { display: grid; grid-template-columns: auto 1fr; gap: .3em 1em; align-items: center; }
.sub-preview { margin-top: .5em; padding: 1em; background: linear-gradient(135deg, #4a6, #36a); border-radius: .6em; text-align: center; }
`;

    // =====================================================================
    // Player
    // =====================================================================
    class FastStreamPlayer {
        constructor(rawPort) {
            this.disposers = [];
            this.timers = new Set();
            this.net = new Map();
            this.netSeq = 0;
            this.settings = null;
            this.stream = null;
            this.player = null;            // shaka.Player
            this.mode = 'mse';             // mse | native
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
            this.qualityCap = 0;
            this.exportState = null;
            this.closed = false;
            this.errorShown = false;
            this.lastQuality = { total: 0, dropped: 0, at: 0, fps: 0 };
            this.resolveInit = null;
            this.initPromise = new Promise(res => { this.resolveInit = res; });
            this.prevFocus = document.activeElement;

            this.port = new PortClient(rawPort, msg => this.onMessage(msg));
            this.buildDom();
            this.bindUi();
            this.start().catch(err => this.showError('Could not start the player', String(err && err.message || err)));
        }

        // -----------------------------------------------------------------
        // Lifecycle
        // -----------------------------------------------------------------
        async start() {
            this.setStatus('loading');
            const [settingsMsg, init] = await Promise.all([
                this.port.request('SETTINGS_GET'),
                this.initPromise
            ]);
            this.settings = settingsMsg.settings;
            this.stream = init.stream;
            this.qualityCap = this.settings.qualityCap || 0;
            this.subs.offset = 0;
            this.$('.title').textContent = this.stream.title || this.titleFromUrl(this.stream.url);
            this.root.setAttribute('aria-label', `FastStream player: ${this.$('.title').textContent}`);
            this.applySettings();
            this.renderAllPanels();
            await this.loadBookmarks();
            await this.load();
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
                if (!shaka || !shaka.Player.isBrowserSupported()) {
                    throw new Error('This browser does not support Media Source Extensions.');
                }
                if (!this.player) {
                    this.registerScheme();
                    this.player = new shaka.Player();
                    await this.player.attach(v);
                    this.player.addEventListener('error', e => this.onShakaError(e.detail));
                    this.player.addEventListener('buffering', e => this.setBuffering(e.buffering));
                    this.player.addEventListener('trackschanged', () => this.onTracksChanged());
                    this.player.addEventListener('variantchanged', () => this.onTracksChanged());
                    this.player.addEventListener('adaptation', () => this.onTracksChanged());
                    this.player.addEventListener('textchanged', () => this.onTracksChanged());
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
            this.setupMediaSession();
            try {
                await v.play();
            } catch (_) {
                // Autoplay policy: the launch click happened in the popup, not in this page.
                this.setStatus('paused');
                this.showControls(true);
                this.announce('Ready. Press play to start.');
                this.$('.btn-center-play').focus();
            }
        }

        configureShaka() {
            const retry = { maxAttempts: 4, baseDelay: 500, backoffFactor: 2, fuzzFactor: 0.5, timeout: 75000, stallTimeout: 0, connectionTimeout: 0 };
            this.player.configure({
                abr: { enabled: false },               // the background ABRController decides
                streaming: {
                    bufferingGoal: 30,
                    rebufferingGoal: 2,
                    bufferBehind: 30,                   // continuous SourceBuffer.remove() of played media
                    retryParameters: retry,
                    segmentPrefetchLimit: 0,            // prefetching is done by the engine workers
                    ignoreTextStreamFailures: true
                },
                manifest: { retryParameters: retry },
                restrictions: { maxHeight: this.qualityCap || Infinity },
                textDisplayFactory: () => this.subs.createDisplayer()
            });
        }

        registerScheme() {
            const NE = shaka.net.NetworkingEngine;
            const plugin = (uri, request, requestType, progressUpdated, headersReceived) => this.schemeRequest(uri, request, requestType, headersReceived);
            NE.registerScheme('http', plugin, NE.PluginPriority.APPLICATION, false);
            NE.registerScheme('https', plugin, NE.PluginPriority.APPLICATION, false);
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
            const promise = new Promise((resolve, reject) => {
                entry = { resolve, reject };
                this.net.set(reqId, entry);
                this.port.send({
                    type: 'REQUEST', reqId, url: uri, method: request.method || 'GET',
                    headers: { ...(request.headers || {}) }, kind
                });
            }).then(res => {
                if (!res.ok) {
                    if (res.status >= 400) {
                        throw new E(E.Severity.RECOVERABLE, E.Category.NETWORK, E.Code.BAD_HTTP_STATUS, uri, res.status, res.error || '', res.headers || {}, requestType, uri);
                    }
                    throw new E(E.Severity.RECOVERABLE, E.Category.NETWORK, E.Code.HTTP_ERROR, uri, new Error(res.error || 'Network error'), requestType);
                }
                const headers = res.headers || {};
                if (headersReceived) { try { headersReceived(headers); } catch (_) { /* ignore */ } }
                return {
                    uri: res.url || uri,
                    originalUri: uri,
                    data: res.data || new ArrayBuffer(0),
                    headers,
                    status: res.status,
                    timeMs: performance.now() - started,
                    fromCache: !!res.fromCache,
                    originalRequest: request
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
            this.closed = true;
            for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
            this.timers.clear();
            for (const d of this.disposers.splice(0)) { try { d(); } catch (_) { /* ignore */ } }
            for (const e of this.net.values()) { try { e.reject(new Error('closed')); } catch (_) { /* ignore */ } }
            this.net.clear();
            if (this.resizeObserver) this.resizeObserver.disconnect();
            try { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => { }); } catch (_) { /* ignore */ }
            try { if (document.fullscreenElement === this.host) document.exitFullscreen().catch(() => { }); } catch (_) { /* ignore */ }
            try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch (_) { /* ignore */ }
            this.audio.destroy();
            const v = this.video;
            const finish = () => {
                try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) { /* ignore */ }
                this.host.remove();
                if (this.restorePage) this.restorePage();
                if (this.prevFocus && this.prevFocus.focus) { try { this.prevFocus.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
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
            if (current === this) current = null;
        }

        every(ms, fn) {
            const t = setInterval(fn, ms);
            this.timers.add(t);
            return t;
        }

        later(ms, fn) {
            const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
            this.timers.add(t);
            return t;
        }

        listen(target, type, fn, opts) {
            target.addEventListener(type, fn, opts);
            this.disposers.push(() => target.removeEventListener(type, fn, opts));
        }

        // -----------------------------------------------------------------
        // Messages from the engine / bridge
        // -----------------------------------------------------------------
        onMessage(msg) {
            if (this.closed) return;
            switch (msg.type) {
                case 'RESPONSE': {
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
                case 'ABR_SWITCH':
                    this.applyAbrSwitch(msg.variantId);
                    break;
                case 'SETTINGS_CHANGED':
                    this.settings = msg.settings;
                    this.applySettings();
                    this.renderAllPanels();
                    break;
                case 'ENGINE_RESET':
                    for (const [id, e] of this.net) { this.net.delete(id); e.resolve({ ok: false, status: 0, error: 'Engine restarted' }); }
                    break;
                case 'FATAL':
                    this.showError('Connection problem', msg.error);
                    break;
                case 'COMMAND':
                    if (msg.command === 'close') this.destroy();
                    else if (msg.command === 'export') { this.openDrawer('download'); this.startExport(); }
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
            const old = document.getElementById('faststream-host');
            if (old) old.remove();
            const host = document.createElement('div');
            host.id = 'faststream-host';
            host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; display: block;';
            this.host = host;
            this.shadow = host.attachShadow({ mode: 'open' });
            this.shadow.innerHTML = `
<style>${CSS}</style>
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <filter id="fs-sharpen"><feConvolveMatrix id="fs-kernel" order="3" kernelMatrix="0 0 0 0 1 0 0 0 0" preserveAlpha="true"/></filter>
</svg>
<div class="root controls-visible" role="dialog" aria-modal="true" aria-label="FastStream player" tabindex="-1" data-theme="emerald" data-rm="system">
  <div class="stage">
    <div class="vbox"><video playsinline webkit-playsinline preload="auto" aria-label="Video"></video></div>
    <div class="audio-poster" aria-hidden="true">${icon('headphones')}<span>Audio-only mode</span></div>
    <div class="subs" aria-hidden="true"></div>
    <div class="gesture" aria-hidden="true"></div>
  </div>
  <div class="ripple left" aria-hidden="true"></div>
  <div class="ripple right" aria-hidden="true"></div>
  <div class="spinner" aria-hidden="true"></div>
  <div class="hud" aria-hidden="true"><span class="hud-icon"></span><span class="hud-text"></span><span class="meter"><i></i></span></div>
  <div class="toast" aria-hidden="true"></div>
  <div class="sr-only" aria-live="polite" aria-atomic="true" id="fs-live"></div>
  <dl class="stats" role="group" aria-label="Stream statistics"></dl>

  <div class="chrome">
    <div class="bar topbar" role="toolbar" aria-label="Player">
      <button type="button" class="btn-close" aria-label="Close player">${icon('close')}</button>
      <span class="title">FastStream</span>
      <span class="status" role="status" data-state="loading"><span aria-hidden="true" class="status-icon">…</span><span class="status-text">Loading</span></span>
      <span class="badge live" hidden>LIVE</span>
      <button type="button" class="btn-audio-only adv narrow-hide" aria-pressed="false" aria-label="Background audio-only mode">${icon('headphones')}</button>
      <button type="button" class="btn-shot adv narrow-hide" aria-label="Take screenshot">${icon('camera')}</button>
      <button type="button" class="btn-lock" aria-label="Lock screen controls">${icon('lock')}</button>
      <button type="button" class="btn-help" aria-label="Keyboard and gesture help" aria-haspopup="dialog">${icon('help')}</button>
    </div>
    <div class="center">
      <button type="button" class="btn-center-back" aria-label="Seek back">${icon('back')}</button>
      <button type="button" class="btn-center-play big" aria-label="Play">${icon('play')}</button>
      <button type="button" class="btn-center-fwd" aria-label="Seek forward">${icon('fwd')}</button>
    </div>
    <div class="bar bottom" role="region" aria-label="Playback controls">
      <div class="timeline" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="0 seconds of 0 seconds">
        <div class="track">
          <div class="layers-cache"></div>
          <div class="layers-mse"></div>
          <div class="loop-range" hidden></div>
          <div class="layer played"></div>
          <div class="marks"></div>
          <div class="thumb"></div>
        </div>
        <div class="tip" aria-hidden="true">0:00</div>
      </div>
      <div class="row">
        <button type="button" class="btn-play" aria-label="Play">${icon('play')}</button>
        <button type="button" class="btn-back narrow-hide" aria-label="Seek back">${icon('back')}</button>
        <button type="button" class="btn-fwd narrow-hide" aria-label="Seek forward">${icon('fwd')}</button>
        <div class="vol">
          <button type="button" class="btn-mute" aria-label="Mute">${icon('volume')}</button>
          <input type="range" class="vol-slider" min="0" max="100" step="1" value="100" aria-label="Volume" aria-valuetext="100%">
        </div>
        <span class="time" aria-hidden="true">0:00 / 0:00</span>
        <span class="spacer"></span>
        <span class="badge quality-badge adv narrow-hide" aria-hidden="true"></span>
        <button type="button" class="btn-speed adv narrow-hide" aria-haspopup="menu" aria-expanded="false" aria-label="Playback speed: 1×">${icon('speed')}<span class="speed-label" aria-hidden="true">1×</span></button>
        <button type="button" class="btn-quality adv narrow-hide" aria-haspopup="menu" aria-expanded="false" aria-label="Quality: Auto">${icon('quality')}</button>
        <button type="button" class="btn-cc" aria-haspopup="menu" aria-expanded="false" aria-label="Subtitles: off">${icon('cc')}</button>
        <button type="button" class="btn-settings" aria-haspopup="dialog" aria-expanded="false" aria-label="Settings and tools">${icon('settings')}</button>
        <button type="button" class="btn-pip adv narrow-hide" aria-label="Picture-in-picture">${icon('pip')}</button>
        <button type="button" class="btn-fs" aria-label="Enter fullscreen">${icon('fullscreen')}</button>
      </div>
    </div>
  </div>

  <button type="button" class="unlock" aria-label="Unlock controls">${icon('unlock')}<span>Unlock</span></button>
  <div class="menu" role="menu" aria-hidden="true"></div>

  <div class="panel drawer" role="dialog" aria-modal="true" aria-labelledby="fs-drawer-title">
    <div class="panel-head"><h2 id="fs-drawer-title">Settings &amp; tools</h2><button type="button" class="btn-drawer-close" aria-label="Close settings">${icon('close')}</button></div>
    <div class="tabs" role="tablist" aria-label="Settings sections">
      <button type="button" role="tab" id="tab-playback" aria-controls="panel-playback" data-tab="playback">Playback</button>
      <button type="button" role="tab" id="tab-tracks" aria-controls="panel-tracks" data-tab="tracks">Quality &amp; audio</button>
      <button type="button" role="tab" id="tab-subtitles" aria-controls="panel-subtitles" data-tab="subtitles">Subtitles</button>
      <button type="button" role="tab" id="tab-sound" aria-controls="panel-sound" data-tab="sound">Sound</button>
      <button type="button" role="tab" id="tab-video" aria-controls="panel-video" data-tab="video">Video</button>
      <button type="button" role="tab" id="tab-interface" aria-controls="panel-interface" data-tab="interface">Interface</button>
      <button type="button" role="tab" id="tab-download" aria-controls="panel-download" data-tab="download">Download</button>
    </div>
    <div class="tabpanel" role="tabpanel" id="panel-playback" aria-labelledby="tab-playback" tabindex="0"></div>
    <div class="tabpanel" role="tabpanel" id="panel-tracks" aria-labelledby="tab-tracks" tabindex="0" hidden></div>
    <div class="tabpanel" role="tabpanel" id="panel-subtitles" aria-labelledby="tab-subtitles" tabindex="0" hidden></div>
    <div class="tabpanel" role="tabpanel" id="panel-sound" aria-labelledby="tab-sound" tabindex="0" hidden></div>
    <div class="tabpanel" role="tabpanel" id="panel-video" aria-labelledby="tab-video" tabindex="0" hidden></div>
    <div class="tabpanel" role="tabpanel" id="panel-interface" aria-labelledby="tab-interface" tabindex="0" hidden></div>
    <div class="tabpanel" role="tabpanel" id="panel-download" aria-labelledby="tab-download" tabindex="0" hidden></div>
  </div>

  <div class="panel dialog help" role="dialog" aria-modal="true" aria-labelledby="fs-help-title">
    <div class="panel-head"><h2 id="fs-help-title">Keyboard shortcuts &amp; gestures</h2><button type="button" class="btn-help-close" aria-label="Close help">${icon('close')}</button></div>
    <div class="tabpanel help-body" tabindex="0"></div>
  </div>

  <div class="error" role="alertdialog" aria-modal="true" aria-labelledby="fs-err-title" aria-describedby="fs-err-msg">
    <h2 id="fs-err-title">Playback error</h2>
    <p id="fs-err-msg"></p>
    <div class="btn-row"><button type="button" class="btn-primary btn-retry">Retry</button><button type="button" class="btn-outline btn-err-close">Close player</button></div>
  </div>
</div>`;
            document.documentElement.appendChild(host);
            this.root = this.$('.root');
            this.video = this.$('video');
            this.vbox = this.$('.vbox');
            this.stage = this.$('.stage');
            this.subs = new SubtitleEngine(this.$('.subs'));
            this.audio = new AudioFx(this.video);
            this.live = this.$('#fs-live');
            this.menu = this.$('.menu');
            this.drawer = this.$('.drawer');
            this.help = this.$('.help');

            // Make the page inert (screen readers + focus) and stop it scrolling underneath.
            const body = document.body;
            const prevInert = body ? body.inert : false;
            const prevOverflow = document.documentElement.style.overflow;
            if (body) body.inert = true;
            document.documentElement.style.overflow = 'hidden';
            this.restorePage = () => {
                if (body) body.inert = prevInert;
                document.documentElement.style.overflow = prevOverflow;
            };
            this.root.focus({ preventScroll: true });
        }

        // -----------------------------------------------------------------
        // Settings application
        // -----------------------------------------------------------------
        applySettings() {
            const s = this.settings;
            if (!s) return;
            const r = this.root;
            r.dataset.theme = THEMES[s.theme] ? s.theme : 'emerald';
            r.dataset.hc = String(!!s.highContrast);
            r.dataset.rm = s.reducedMotion;
            r.dataset.simple = String(!!s.simpleMode);
            r.style.setProperty('--scale', String(s.uiScale || 1));
            r.classList.toggle('show-stats', !!s.showStats);
            this.applySubtitleStyle();
            if (this.audio.active) this.audio.apply(s.audio);
            const label = `Seek back ${s.seekStep} seconds`;
            const labelF = `Seek forward ${s.seekStep} seconds`;
            this.$$('.btn-back, .btn-center-back').forEach(b => b.setAttribute('aria-label', label));
            this.$$('.btn-fwd, .btn-center-fwd').forEach(b => b.setAttribute('aria-label', labelF));
            if (s.autoHideMs === 0) this.showControls(true);
            this.renderHelp();
        }

        saveSettings(patch) {
            Object.assign(this.settings, patch);
            this.applySettings();
            clearTimeout(this.saveTimer);
            this.saveTimer = setTimeout(() => this.port.send({ type: 'SETTINGS_SET', patch }), 250);
        }

        applySubtitleStyle() {
            const st = this.settings.subtitles;
            const layer = this.$('.subs');
            const font = (FONTS[st.font] || FONTS.system).css;
            const size = clamp(st.size, 50, 300);
            layer.style.bottom = `${clamp(st.position, 0, 80)}%`;
            const edge = st.edge === 'outline'
                ? '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 0 4px #000'
                : st.edge === 'shadow' ? '2px 2px 4px rgba(0,0,0,.95), 0 0 2px #000' : 'none';
            const bg = `rgba(0,0,0,${clamp(st.bgOpacity, 0, 100) / 100})`;
            let sheet = this.shadow.getElementById('fs-sub-style');
            if (!sheet) {
                sheet = document.createElement('style');
                sheet.id = 'fs-sub-style';
                this.shadow.appendChild(sheet);
            }
            const rule = `font-family:${font};font-size:${(size / 100) * 1.45}em;color:${st.color};background:${bg};text-shadow:${edge};font-weight:600;line-height:1.35;`;
            sheet.textContent = `.subs .cue-line, .sub-preview .cue-line { ${rule} } .subs { font-size: calc(clamp(12px, 3.4vmin, 22px) * var(--scale)); }`;
        }

        // -----------------------------------------------------------------
        // UI wiring
        // -----------------------------------------------------------------
        bindUi() {
            const v = this.video;
            const on = (sel, ev, fn) => { const el = this.$(sel); if (el) this.listen(el, ev, fn); };

            on('.btn-close', 'click', () => this.destroy());
            on('.btn-err-close', 'click', () => this.destroy());
            on('.btn-retry', 'click', () => this.retry());
            on('.btn-play', 'click', () => this.togglePlay());
            on('.btn-center-play', 'click', () => this.togglePlay());
            on('.btn-back', 'click', () => this.seekBy(-this.settings.seekStep, true));
            on('.btn-fwd', 'click', () => this.seekBy(this.settings.seekStep, true));
            on('.btn-center-back', 'click', () => this.seekBy(-this.settings.seekStep, true));
            on('.btn-center-fwd', 'click', () => this.seekBy(this.settings.seekStep, true));
            on('.btn-mute', 'click', () => this.toggleMute());
            on('.vol-slider', 'input', (e) => this.setVolume(+e.target.value / 100, false));
            on('.btn-fs', 'click', () => this.toggleFullscreen());
            on('.btn-pip', 'click', () => this.togglePip());
            on('.btn-lock', 'click', () => this.setLocked(true));
            on('.unlock', 'click', () => this.setLocked(false));
            on('.btn-help', 'click', () => this.openHelp());
            on('.btn-help-close', 'click', () => this.closeHelp());
            on('.btn-settings', 'click', () => (this.drawer.classList.contains('open') ? this.closeDrawer() : this.openDrawer()));
            on('.btn-drawer-close', 'click', () => this.closeDrawer());
            on('.btn-speed', 'click', (e) => this.openSpeedMenu(e.currentTarget));
            on('.btn-quality', 'click', (e) => this.openQualityMenu(e.currentTarget));
            on('.btn-cc', 'click', (e) => this.openCaptionsMenu(e.currentTarget));
            on('.btn-shot', 'click', () => this.screenshot());
            on('.btn-audio-only', 'click', () => this.setAudioOnly(!this.audioOnly));
            this.$$('[role="tab"]').forEach(tab => {
                this.listen(tab, 'click', () => this.selectTab(tab.dataset.tab, true));
                this.listen(tab, 'keydown', (e) => this.onTabKey(e));
            });

            // Media events
            const media = (ev, fn) => this.listen(v, ev, fn);
            media('play', () => { this.updatePlayButtons(); if (this.audio.active) this.audio.ensure(); });
            media('playing', () => { this.setBuffering(false); this.setStatus('playing'); this.scheduleHide(); });
            media('pause', () => { this.updatePlayButtons(); if (!v.ended) this.setStatus('paused'); this.showControls(true); });
            media('waiting', () => this.setBuffering(true));
            media('canplay', () => this.setBuffering(false));
            media('ended', () => { this.setStatus('ended'); this.showControls(true); this.updatePlayButtons(); });
            media('ratechange', () => this.updateSpeedUi());
            media('volumechange', () => this.updateVolumeUi());
            media('loadedmetadata', () => { this.layoutVideo(); this.updateQualityBadge(); this.renderMarks(); });
            media('durationchange', () => this.renderMarks());
            media('resize', () => { this.layoutVideo(); this.updateQualityBadge(); });
            media('seeked', () => this.subs.render(v.currentTime));
            media('enterpictureinpicture', () => this.$('.btn-pip').setAttribute('aria-pressed', 'true'));
            media('leavepictureinpicture', () => this.$('.btn-pip').setAttribute('aria-pressed', 'false'));
            media('error', () => {
                if (this.mode === 'native' && v.error) this.showError('Cannot play this file', `Media error ${v.error.code}: ${v.error.message || 'the format may be unsupported by this browser.'}`);
            });

            this.listen(document, 'fullscreenchange', () => this.onFullscreenChange());
            this.listen(document, 'webkitfullscreenchange', () => this.onFullscreenChange());
            if (!document.pictureInPictureEnabled) this.$('.btn-pip').hidden = true;

            this.bindTimeline();
            this.bindGestures();
            this.bindKeyboard();

            // Activity -> show controls
            const activity = () => { if (!this.locked) this.showControls(); };
            this.listen(this.root, 'pointermove', (e) => { if (e.pointerType === 'mouse') activity(); });
            this.listen(this.root, 'focusin', () => { if (!this.locked) this.showControls(true); });

            // Web Audio must be created/resumed inside a user-activation event (pointerup/keydown),
            // otherwise the AudioContext starts suspended and the rerouted audio goes silent.
            const activation = () => {
                if (!this.settings || this.closed) return;
                if (this.audio.allowed()) {
                    if (this.audio.ensure()) this.audio.apply(this.settings.audio);
                }
                if (this.settings.autoFullscreen && !this.autoFsDone) {
                    this.autoFsDone = true;
                    if (!document.fullscreenElement) this.toggleFullscreen();
                }
            };
            this.listen(this.root, 'pointerup', activation);
            this.listen(this.root, 'keydown', activation);

            this.resizeObserver = new ResizeObserver(() => this.layoutVideo());
            this.resizeObserver.observe(this.stage);
            this.resizeObserver.observe(this.$(".bar.bottom"));

            this.every(250, () => this.onTick());
            this.every(1000, () => this.onSecond());
        }

        // -----------------------------------------------------------------
        // Status, announcements, controls visibility
        // -----------------------------------------------------------------
        announce(text) {
            const el = this.live;
            el.textContent = '';
            this.later(60, () => { el.textContent = text; });
            const toast = this.$('.toast');
            toast.textContent = text;
            toast.classList.add('show');
            clearTimeout(this.toastTimer);
            this.toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
        }

        setStatus(state) {
            const s = STATUS[state];
            const el = this.$('.status');
            if (el.dataset.state === state) return;
            el.dataset.state = state;
            this.$('.status-icon').textContent = s.icon;
            this.$('.status-text').textContent = s.text;
            if (state === 'buffering' || state === 'error' || state === 'ended') this.announce(s.text);
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
                const v = this.video;
                const busy = v.paused || this.menu.classList.contains('open') || this.drawer.classList.contains('open') ||
                    this.help.classList.contains('open') || this.$('.timeline').classList.contains('dragging');
                const focusInControls = this.shadow.activeElement && this.$('.chrome').contains(this.shadow.activeElement) &&
                    this.shadow.activeElement.matches(':focus-visible');
                if (!busy && !focusInControls) this.root.classList.add('controls-hidden');
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
                if (p && p.catch) p.catch(err => this.announce(`Cannot start playback: ${err.message}`));
            } else {
                v.pause();
            }
            this.later(30, () => this.announce(v.paused ? 'Paused' : 'Playing'));
        }

        updatePlayButtons() {
            const paused = this.video.paused;
            for (const b of this.$$('.btn-play, .btn-center-play')) {
                b.innerHTML = icon(paused ? 'play' : 'pause');
                b.setAttribute('aria-label', paused ? 'Play' : 'Pause');
            }
        }

        seekRange() {
            const v = this.video;
            if (this.player && this.mode === 'mse') {
                try {
                    const r = this.player.seekRange();
                    if (Number.isFinite(r.end) && r.end > r.start) return r;
                } catch (_) { /* not loaded */ }
            }
            const d = Number.isFinite(v.duration) ? v.duration : 0;
            return { start: 0, end: d };
        }

        isLive() {
            try { return !!(this.player && this.player.isLive()); } catch (_) { return false; }
        }

        seekTo(t, announce) {
            const r = this.seekRange();
            const target = clamp(t, r.start, Math.max(r.start, r.end - 0.25));
            this.video.currentTime = target;
            this.port.send({ type: 'SEEK', time: target });
            if (announce) this.announce(`${fmtSpoken(target - r.start)} of ${fmtSpoken(r.end - r.start)}`);
        }

        seekBy(delta, announce) {
            this.seekTo(this.video.currentTime + delta, false);
            if (announce) this.announce(`${delta < 0 ? 'Back' : 'Forward'} ${Math.abs(delta)} seconds`);
        }

        setRate(rate, announce = true) {
            const r = Math.round(clamp(rate, 0.25, 4) * 100) / 100;
            this.video.playbackRate = r;
            if (announce) this.announce(`Speed ${r}×`);
        }

        updateSpeedUi() {
            const r = this.video.playbackRate;
            const label = `${+r.toFixed(2)}×`;
            this.$('.speed-label').textContent = label;
            this.$('.btn-speed').setAttribute('aria-label', `Playback speed: ${label}`);
            const out = this.shadow.getElementById('out-speed');
            if (out) out.textContent = label;
            const range = this.shadow.getElementById('in-speed');
            if (range && document.activeElement !== range) { range.value = r; range.setAttribute('aria-valuetext', label); }
        }

        setVolume(vol, announce = true) {
            const v = this.video;
            v.volume = clamp(vol, 0, 1);
            if (v.volume > 0) v.muted = false;
            if (announce) this.announce(`Volume ${Math.round(v.volume * 100)}%`);
        }

        toggleMute() {
            this.video.muted = !this.video.muted;
            this.announce(this.video.muted ? 'Muted' : 'Unmuted');
        }

        updateVolumeUi() {
            const v = this.video;
            const pct = Math.round((v.muted ? 0 : v.volume) * 100);
            const s = this.$('.vol-slider');
            s.value = pct;
            s.setAttribute('aria-valuetext', `${pct}%${v.muted ? ', muted' : ''}`);
            const b = this.$('.btn-mute');
            b.innerHTML = icon(v.muted || v.volume === 0 ? 'mute' : 'volume');
            b.setAttribute('aria-label', v.muted ? 'Unmute' : 'Mute');
        }

        stepFrame(dir) {
            const v = this.video;
            if (!v.paused) v.pause();
            const fps = this.currentFps() || 30;
            this.seekTo(v.currentTime + dir / fps, false);
            this.announce(dir > 0 ? 'Next frame' : 'Previous frame');
        }

        currentFps() {
            if (!this.player) return 0;
            try {
                const t = this.player.getVariantTracks().find(x => x.active);
                return (t && t.frameRate) || 0;
            } catch (_) { return 0; }
        }

        async toggleFullscreen() {
            try {
                if (document.fullscreenElement) {
                    await document.exitFullscreen();
                } else {
                    await this.host.requestFullscreen({ navigationUI: 'hide' });
                    const v = this.video;
                    if (screen.orientation && screen.orientation.lock && v.videoWidth > v.videoHeight && matchMedia('(pointer: coarse)').matches) {
                        screen.orientation.lock('landscape').catch(() => { });
                    }
                }
            } catch (e) {
                this.announce('Fullscreen is not available here');
            }
        }

        onFullscreenChange() {
            const fs = document.fullscreenElement === this.host;
            const b = this.$('.btn-fs');
            b.innerHTML = icon(fs ? 'exitFullscreen' : 'fullscreen');
            b.setAttribute('aria-label', fs ? 'Exit fullscreen' : 'Enter fullscreen');
            if (!fs) { try { screen.orientation.unlock(); } catch (_) { /* ignore */ } }
        }

        async togglePip() {
            try {
                if (document.pictureInPictureElement) await document.exitPictureInPicture();
                else await this.video.requestPictureInPicture();
            } catch (e) {
                this.announce(`Picture-in-picture unavailable: ${e.message}`);
            }
        }

        setLocked(on) {
            this.locked = on;
            this.root.classList.toggle('locked', on);
            this.closeMenu();
            const unlock = this.$('.unlock');
            if (on) {
                this.announce('Controls locked. Tap the screen, then the Unlock button to unlock.');
                unlock.classList.add('show');
                this.later(2500, () => unlock.classList.remove('show'));
                unlock.focus({ preventScroll: true });
            } else {
                unlock.classList.remove('show');
                this.announce('Controls unlocked');
                this.showControls();
                this.$('.btn-lock').focus({ preventScroll: true });
            }
        }

        setAudioOnly(on) {
            this.audioOnly = on;
            this.root.classList.toggle('audio-only', on);
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
            this.announce(on ? 'Audio-only mode on. Video hidden, lowest quality selected to save battery.' : 'Audio-only mode off');
            this.renderPanel('playback');
        }

        retry() {
            this.hideError();
            const t = this.video.currentTime || 0;
            this.load(t).catch(err => this.showError('Retry failed', String(err.message || err)));
        }

        showError(title, message) {
            if (this.closed) return;
            this.setStatus('error');
            this.setBuffering(false);
            const box = this.$('.error');
            this.$('#fs-err-title').textContent = title;
            this.$('#fs-err-msg').textContent = message || '';
            box.classList.add('show');
            this.errorShown = true;
            this.$('.btn-retry').focus({ preventScroll: true });
        }

        hideError() {
            this.$('.error').classList.remove('show');
            this.errorShown = false;
        }

        onShakaError(err) {
            if (!err) return;
            const code = err.code;
            console.warn('[FastStream] Shaka error', code, err);
            if (code === 3017) {
                // QUOTA_EXCEEDED_ERROR: mobile SourceBuffer limits. Shrink buffers and keep going.
                this.player.configure({ streaming: { bufferBehind: 8, bufferingGoal: 15 } });
                this.announce('Low memory: reduced buffer size');
                return;
            }
            if (err.severity !== 2 || code === 7000 || code === 7001 || code === 7002) return; // recoverable / aborted
            let msg = `Error code ${code}.`;
            if (code === 1001) {
                const status = err.data && err.data[1];
                msg = status === 403 || status === 401
                    ? `The server refused access (HTTP ${status}). The link may have expired - reload the page, start the video there briefly, and relaunch FastStream.`
                    : `The server returned HTTP ${status}.`;
            } else if (code === 1002) {
                msg = 'Network error while loading the stream. Check your connection and retry.';
            } else if (code >= 6000 && code < 7000) {
                msg = 'This stream is protected by DRM and can only be played by the website\'s own player.';
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
            // Only variants that share the active audio (language/rendition) are switchable qualities.
            if (active) {
                tracks = tracks.filter(t => t.language === active.language &&
                    (active.audioId == null || t.audioId == null || t.audioId === active.audioId || t.audioGroupId === active.audioGroupId));
            }
            return tracks;
        }

        qualityLabel(t) {
            const res = t.height ? `${t.height}p${t.frameRate && t.frameRate > 30 ? Math.round(t.frameRate) : ''}` : 'Audio only';
            return `${res} (${fmtBitrate(t.bandwidth)})`;
        }

        onTracksChanged() {
            this.updateQualityBadge();
            this.updateCcButton();
            const tracks = this.currentVariants();
            const sig = tracks.map(t => `${t.id}:${t.bandwidth}`).join(',');
            if (sig !== this.variantsSig) {
                this.variantsSig = sig;
                this.sendTelemetry(true);
            }
            if (this.drawer.classList.contains('open')) this.renderPanel('tracks');
            const live = this.isLive();
            this.$('.badge.live').hidden = !live;
        }

        updateQualityBadge() {
            const v = this.video;
            const badge = this.$('.quality-badge');
            const h = v.videoHeight;
            const text = h ? `${h}p` : '';
            badge.textContent = this.abrAuto && this.mode === 'mse' ? (text ? `Auto · ${text}` : 'Auto') : text;
            this.$('.btn-quality').setAttribute('aria-label', `Quality: ${badge.textContent || 'Auto'}`);
            if (this.mode !== 'mse') this.$('.btn-quality').hidden = true;
        }

        selectQuality(id, announce = true) {
            if (!this.player) return;
            if (id === 'auto') {
                this.abrAuto = true;
                this.lockedVariantId = null;
                this.port.send({ type: 'SET_QUALITY', mode: 'auto' });
                if (announce) this.announce('Quality: automatic');
            } else {
                const t = this.player.getVariantTracks().find(x => x.id === id);
                if (!t) return;
                this.abrAuto = false;
                this.lockedVariantId = id;
                this.player.selectVariantTrack(t, true);
                this.port.send({ type: 'SET_QUALITY', mode: 'lock', variantId: id });
                if (announce) this.announce(`Quality: ${this.qualityLabel(t)}`);
            }
            this.updateQualityBadge();
            this.sendTelemetry(true);
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

        selectAudioTrack(index) {
            const t = this.audioTracks()[index];
            if (!t) return;
            this.player.selectAudioTrack(t);
            this.announce(`Audio: ${t.label || t.language || 'track ' + (index + 1)}`);
            this.later(300, () => this.onTracksChanged());
        }

        textTracks() {
            if (!this.player || this.mode !== 'mse') return [];
            try { return this.player.getTextTracks(); } catch (_) { return []; }
        }

        selectSubtitle(source, trackId) {
            if (source === 'off') {
                this.subs.source = 'off';
                if (this.player) { try { this.player.selectTextTrack(null); } catch (_) { /* old API */ } }
                this.announce('Subtitles off');
            } else if (source === 'external') {
                if (!this.subs.externalCues) return;
                this.subs.source = 'external';
                if (this.player) { try { this.player.selectTextTrack(null); } catch (_) { /* ignore */ } }
                this.announce(`Subtitles: ${this.subs.externalName}`);
            } else {
                const t = this.textTracks().find(x => x.id === trackId);
                if (!t) return;
                this.subs.clearShaka();
                this.subs.source = 'shaka';
                this.player.selectTextTrack(t);
                this.lastShakaText = t.id;
                this.announce(`Subtitles: ${t.label || t.language || 'track'}`);
            }
            this.subs.lastHtml = null;
            this.subs.render(this.video.currentTime);
            this.updateCcButton();
            if (this.drawer.classList.contains('open')) this.renderPanel('subtitles');
        }

        toggleCaptions() {
            if (this.subs.source !== 'off') return this.selectSubtitle('off');
            if (this.subs.externalCues) return this.selectSubtitle('external');
            const tracks = this.textTracks();
            const pick = tracks.find(t => t.id === this.lastShakaText) || tracks[0];
            if (pick) this.selectSubtitle('shaka', pick.id);
            else this.announce('No subtitles available. Load a file from Settings, Subtitles.');
        }

        updateCcButton() {
            const b = this.$('.btn-cc');
            const on = this.subs.source !== 'off';
            b.classList.toggle('on', on);
            b.setAttribute('aria-label', `Subtitles: ${on ? 'on' : 'off'}`);
        }

        async loadSubtitleFile(file) {
            if (!file) return;
            if (file.size > 5 * 1024 * 1024) { this.announce('Subtitle file is too large'); return; }
            const text = await file.text();
            const cues = parseSubtitleFile(text);
            if (!cues.length) { this.announce('No subtitles found in that file'); return; }
            this.subs.externalCues = cues;
            this.subs.externalName = file.name;
            this.selectSubtitle('external');
        }

        setSubOffset(value) {
            this.subs.offset = Math.round(value * 10) / 10;
            this.subs.lastHtml = null;
            this.subs.render(this.video.currentTime);
            const out = this.shadow.getElementById('out-suboffset');
            if (out) out.textContent = `${this.subs.offset >= 0 ? '+' : ''}${this.subs.offset.toFixed(1)} s`;
            this.announce(`Subtitle delay ${this.subs.offset.toFixed(1)} seconds`);
        }

        // -----------------------------------------------------------------
        // Video transforms & filters
        // -----------------------------------------------------------------
        layoutVideo() {
            // Lift subtitles above the bottom control bar while it is visible.
            const bar = this.$(".bar.bottom");
            if (bar) this.root.style.setProperty("--bar-h", `${bar.offsetHeight}px`);
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
        }

        setZoom(z, announce) {
            this.xf.zoom = clamp(z, 1, 4);
            if (this.xf.zoom === 1) { this.xf.panX = 0; this.xf.panY = 0; }
            this.clampPan();
            this.layoutVideo();
            if (announce) this.announce(`Zoom ${Math.round(this.xf.zoom * 100)}%`);
        }

        clampPan() {
            const W = this.stage.clientWidth;
            const H = this.stage.clientHeight;
            const maxX = (W * (this.xf.zoom - 1)) / 2;
            const maxY = (H * (this.xf.zoom - 1)) / 2;
            this.xf.panX = clamp(this.xf.panX, -maxX, maxX);
            this.xf.panY = clamp(this.xf.panY, -maxY, maxY);
        }

        applyFilters() {
            const f = this.filters;
            const parts = [
                `brightness(${f.brightness}%)`, `contrast(${f.contrast}%)`, `saturate(${f.saturate}%)`,
                `hue-rotate(${f.hue}deg)`, `sepia(${f.warmth}%)`
            ];
            if (f.sharpness > 0) {
                const a = (f.sharpness / 100) * 0.9;
                const k = this.shadow.getElementById('fs-kernel');
                k.setAttribute('kernelMatrix', `0 ${-a} 0 ${-a} ${1 + 4 * a} ${-a} 0 ${-a} 0`);
                parts.push('url(#fs-sharpen)');
            }
            const isDefault = Object.keys(DEFAULT_FILTERS).every(key => f[key] === DEFAULT_FILTERS[key]);
            this.video.style.filter = isDefault ? '' : parts.join(' ');
        }

        // -----------------------------------------------------------------
        // Loop & bookmarks
        // -----------------------------------------------------------------
        setLoopPoint(which) {
            const t = this.video.currentTime;
            if (which === 'a') {
                this.loop.a = t;
                if (this.loop.b != null && this.loop.b <= t) this.loop.b = null;
                this.announce(`Loop start A at ${fmtSpoken(t)}`);
            } else {
                if (this.loop.a == null || t <= this.loop.a) { this.announce('Set point A before point B'); return; }
                this.loop.b = t;
                this.announce(`Looping from ${fmtTime(this.loop.a)} to ${fmtTime(t)}`);
            }
            this.renderMarks();
            this.renderPanel('playback');
        }

        clearLoop() {
            this.loop = { a: null, b: null };
            this.renderMarks();
            this.renderPanel('playback');
            this.announce('A-B loop cleared');
        }

        bookmarkKey() {
            let base = this.stream.url;
            try { const u = new URL(base); base = u.origin + u.pathname; } catch (_) { /* raw */ }
            return `fs_bm_${hashKey(base)}`;
        }

        async loadBookmarks() {
            try {
                const res = await this.port.request('STORE_GET', { key: this.bookmarkKey() });
                this.bookmarks = Array.isArray(res.value) ? res.value.filter(b => Number.isFinite(b.t)).slice(0, 200) : [];
            } catch (_) {
                this.bookmarks = [];
            }
            this.renderMarks();
        }

        saveBookmarks() {
            this.port.send({ type: 'STORE_SET', key: this.bookmarkKey(), value: this.bookmarks });
            this.renderMarks();
            this.renderPanel('playback');
        }

        addBookmark(label) {
            const t = this.video.currentTime;
            this.bookmarks.push({ t, label: (label || '').trim().slice(0, 80) || `Bookmark at ${fmtTime(t)}` });
            this.bookmarks.sort((a, b) => a.t - b.t);
            this.saveBookmarks();
            this.announce(`Bookmark added at ${fmtSpoken(t)}`);
        }

        // -----------------------------------------------------------------
        // Screenshot & export
        // -----------------------------------------------------------------
        screenshot() {
            const v = this.video;
            if (!v.videoWidth) { this.announce('No video frame to capture yet'); return; }
            const c = document.createElement('canvas');
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            try {
                c.getContext('2d').drawImage(v, 0, 0);
                c.toBlob(blob => {
                    if (!blob) { this.announce('Screenshot failed'); return; }
                    downloadBlob(this.shadow, blob, `faststream-${fmtTime(v.currentTime).replace(/:/g, '-')}.png`);
                    this.announce('Screenshot saved');
                }, 'image/png');
            } catch (e) {
                this.announce('Screenshot blocked: this video comes from another site without CORS permission');
            }
        }

        startExport() {
            if (this.exportState && this.exportState.running) return;
            this.exportState = { running: true, files: {}, status: 'Starting…', pct: 0 };
            this.renderPanel('download');
            this.port.send({ type: 'EXPORT_START' });
            this.announce('Export started');
        }

        cancelExport() {
            this.port.send({ type: 'EXPORT_CANCEL' });
        }

        onExportMessage(msg) {
            const st = this.exportState || (this.exportState = { running: true, files: {}, status: '', pct: 0 });
            switch (msg.type) {
                case 'EXPORT_BEGIN':
                    st.files[msg.fileIndex] = { parts: [], filename: msg.filename, mime: msg.mime };
                    st.status = `Downloading ${msg.filename} (${msg.fileIndex + 1} of ${msg.fileCount})`;
                    break;
                case 'EXPORT_CHUNK': {
                    const f = st.files[msg.fileIndex];
                    if (f && msg.data) f.parts.push(new Blob([msg.data]));
                    return; // no re-render per chunk
                }
                case 'EXPORT_PROGRESS': {
                    const pct = msg.total ? (msg.done / msg.total) : 0;
                    st.pct = Math.round(((msg.fileIndex + pct) / msg.fileCount) * 100);
                    st.status = `${st.pct}% · ${fmtBytes(msg.bytes)}`;
                    const bar = this.shadow.getElementById('export-bar');
                    if (bar) {
                        bar.firstElementChild.style.width = `${st.pct}%`;
                        bar.setAttribute('aria-valuenow', String(st.pct));
                        bar.setAttribute('aria-valuetext', st.status);
                        this.shadow.getElementById('export-status').textContent = st.status;
                        if (st.pct % 10 === 0 && st.pct !== st.lastAnnounced) { st.lastAnnounced = st.pct; this.announce(`Export ${st.pct}%`); }
                        return;
                    }
                    break;
                }
                case 'EXPORT_FILE_DONE': {
                    const f = st.files[msg.fileIndex];
                    if (f) {
                        downloadBlob(this.shadow, new Blob(f.parts, { type: f.mime }), f.filename);
                        f.parts = [];
                        this.announce(`Saved ${f.filename}`);
                    }
                    break;
                }
                case 'EXPORT_COMPLETE':
                    st.running = false;
                    st.pct = 100;
                    st.status = '✓ Export complete';
                    break;
                case 'EXPORT_ERROR':
                    st.running = false;
                    st.status = `✕ ${msg.error}`;
                    st.files = {};
                    this.announce(`Export failed: ${msg.error}`);
                    break;
                default:
                    break;
            }
            this.renderPanel('download');
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
            if (this.loop.a != null && this.loop.b != null && v.currentTime >= this.loop.b) {
                v.currentTime = this.loop.a;
                this.port.send({ type: 'SEEK', time: this.loop.a });
            }
            this.subs.render(v.currentTime);
            if (!this.dragging) this.renderTimeline();
        }

        onSecond() {
            this.sendTelemetry(Date.now() - this.lastVariantsSentAt > 10000);
            this.renderStats();
        }

        sendTelemetry(withVariants) {
            const v = this.video;
            const msg = {
                type: 'TELEMETRY',
                currentTime: v.currentTime,
                bufferAhead: this.bufferAhead(),
                paused: v.paused,
                qualityCap: this.qualityCap
            };
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
            this.$('.time').textContent = live ? `${fmtTime(cur)} / LIVE` : `${fmtTime(cur)} / ${fmtTime(span)}`;
            const tl = this.$('.timeline');
            tl.setAttribute('aria-valuemax', String(Math.round(span)));
            tl.setAttribute('aria-valuenow', String(Math.round(cur)));
            tl.setAttribute('aria-valuetext', `${fmtSpoken(cur)} of ${live ? 'live stream' : fmtSpoken(span)}`);

            // MSE buffered ranges (what the browser holds)
            const mse = [];
            for (let i = 0; i < v.buffered.length; i++) {
                const s = (v.buffered.start(i) - r.start) / span * 100;
                const e = (v.buffered.end(i) - r.start) / span * 100;
                mse.push(`<div class="layer buf-mse" style="left:${clamp(s, 0, 100)}%;width:${clamp(e - s, 0, 100)}%"></div>`);
            }
            const mseHtml = mse.join('');
            if (mseHtml !== this.lastMseHtml) { this.lastMseHtml = mseHtml; this.$('.layers-mse').innerHTML = mseHtml; }

            // FastStream IndexedDB prefetch cache (engine timeline == presentation time for VOD HLS)
            let cacheHtml = '';
            if (this.engineStats && !live && this.stream.type === 'hls') {
                cacheHtml = (this.engineStats.cachedRanges || []).map(cr => {
                    const s = (cr.start - r.start) / span * 100;
                    const e = (cr.end - r.start) / span * 100;
                    return `<div class="layer buf-cache" style="left:${clamp(s, 0, 100)}%;width:${clamp(e - s, 0, 100)}%"></div>`;
                }).join('');
            }
            if (cacheHtml !== this.lastCacheHtml) { this.lastCacheHtml = cacheHtml; this.$('.layers-cache').innerHTML = cacheHtml; }
        }

        renderMarks() {
            const r = this.seekRange();
            const span = Math.max(0.001, r.end - r.start);
            const pos = t => clamp((t - r.start) / span * 100, 0, 100);
            let html = '';
            for (const b of this.bookmarks) html += `<div class="mark bm" style="left:${pos(b.t)}%"></div>`;
            if (this.loop.a != null) html += `<div class="mark loop" style="left:${pos(this.loop.a)}%"></div>`;
            if (this.loop.b != null) html += `<div class="mark loop" style="left:${pos(this.loop.b)}%"></div>`;
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
                if (this.lastQuality.at) {
                    fps = ((q.totalVideoFrames - this.lastQuality.total) * 1000) / (now - this.lastQuality.at);
                }
                dropped = q.droppedVideoFrames;
                this.lastQuality = { total: q.totalVideoFrames, dropped, at: now, fps };
            }
            const e = this.engineStats || {};
            let codecs = '';
            let streamBw = 0;
            if (this.player) {
                try { const st = this.player.getStats(); codecs = st.currentCodecs || ''; streamBw = st.streamBandwidth; } catch (_) { /* ignore */ }
            }
            const rows = [
                ['Resolution', v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '—'],
                ['FPS', fps ? fps.toFixed(1) : '—'],
                ['Dropped frames', String(dropped)],
                ['Variant bitrate', fmtBitrate(streamBw)],
                ['Codecs', codecs || '—'],
                ['Bandwidth (est.)', fmtBitrate(e.bandwidth)],
                ['Active workers', `${e.activeWorkers || 0} / ${e.concurrency || 0}`],
                ['Queued segments', String(e.queued || 0)],
                ['Player buffer', `${this.bufferAhead().toFixed(1)} s`],
                ['Prefetched ahead', `${(e.cachedAhead || 0).toFixed(1)} s`],
                ['IndexedDB cache', `${fmtBytes(e.cacheBytes)} (${e.cachedSegments || 0} seg)`],
                ['Cache hits / misses', `${e.cacheHits || 0} / ${e.cacheMisses || 0}`]
            ];
            this.$('.stats').innerHTML = rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('');
        }

        // -----------------------------------------------------------------
        // Timeline interaction (pointer + keyboard)
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
            const showTip = (clientX) => {
                const { t, ratio, r } = timeAt(clientX);
                tip.textContent = fmtTime(t - r.start);
                tip.style.left = `${ratio * 100}%`;
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
                if (handled) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.later(50, () => this.renderTimeline());
                }
            });
        }

        previewTimeline(t) {
            const r = this.seekRange();
            const pct = clamp((t - r.start) / Math.max(0.001, r.end - r.start), 0, 1) * 100;
            this.$('.played').style.width = `${pct}%`;
            this.$('.thumb').style.left = `${pct}%`;
        }

        // -----------------------------------------------------------------
        // Touch & mouse gestures
        // -----------------------------------------------------------------
        bindGestures() {
            const layer = this.$('.gesture');
            const pointers = new Map();
            let g = null;            // active gesture state
            let lastTap = null;      // {t, x, side}
            let tapTimer = null;
            let boostRestore = null;

            const hud = (iconName, text, ratio) => {
                const el = this.$('.hud');
                this.$('.hud-icon').innerHTML = iconName ? icon(iconName) : '';
                this.$('.hud-text').textContent = text;
                const meter = this.$('.hud .meter');
                meter.style.display = ratio == null ? 'none' : '';
                if (ratio != null) meter.firstElementChild.style.width = `${clamp(ratio, 0, 1) * 100}%`;
                el.classList.add('show');
            };
            const hideHud = () => this.$('.hud').classList.remove('show');
            const gs = () => this.settings ? this.settings.gestures : { enabled: false };

            const side = (x) => {
                const rect = layer.getBoundingClientRect();
                const rel = (x - rect.left) / rect.width;
                return rel < 0.38 ? 'left' : rel > 0.62 ? 'right' : 'center';
            };

            this.listen(layer, 'pointerdown', (e) => {
                if (this.errorShown) return;
                if (this.locked) {
                    const u = this.$('.unlock');
                    u.classList.add('show');
                    this.later(2500, () => u.classList.remove('show'));
                    return;
                }
                layer.setPointerCapture(e.pointerId);
                pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
                const settings = gs();
                if (pointers.size === 2 && settings.enabled && settings.pinchZoom) {
                    clearTimeout(g && g.longTimer);
                    const [a, b] = [...pointers.values()];
                    g = { mode: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.xf.zoom };
                    return;
                }
                if (pointers.size > 1) return;
                this.lastPointerType = e.pointerType;
                g = {
                    mode: null, x: e.clientX, y: e.clientY, t: Date.now(), type: e.pointerType,
                    startTime: this.video.currentTime, startBright: this.filters.brightness,
                    startVol: this.video.volume, startBoost: this.settings.audio.boost,
                    panX: this.xf.panX, panY: this.xf.panY, longTimer: null
                };
                if (e.pointerType !== 'mouse' && settings.enabled && settings.longPressSpeed) {
                    g.longTimer = setTimeout(() => {
                        if (!g || g.mode) return;
                        g.mode = 'boost';
                        boostRestore = this.video.playbackRate;
                        this.video.playbackRate = this.settings.longPressRate || 2;
                        hud('speed', `${this.video.playbackRate}× while held`, null);
                    }, 500);
                }
            });

            this.listen(layer, 'pointermove', (e) => {
                if (!pointers.has(e.pointerId) || !g) return;
                pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
                const settings = gs();
                if (g.mode === 'pinch') {
                    const [a, b] = [...pointers.values()];
                    if (!b) return;
                    const d = Math.hypot(a.x - b.x, a.y - b.y);
                    this.setZoom(g.zoom * (d / Math.max(1, g.dist)), false);
                    hud(null, `Zoom ${Math.round(this.xf.zoom * 100)}%`, (this.xf.zoom - 1) / 3);
                    return;
                }
                const dx = e.clientX - g.x;
                const dy = e.clientY - g.y;
                const rect = layer.getBoundingClientRect();
                if (!g.mode) {
                    if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;
                    clearTimeout(g.longTimer);
                    if (g.type === 'mouse') { g.mode = 'none'; return; }
                    if (this.xf.zoom > 1) g.mode = 'pan';
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
                        hud('brightness', `Brightness ${val}%`, (val - 20) / 180);
                        break;
                    }
                    case 'volume': {
                        // 0-100% = element volume, 100-300% = Web Audio boost (when allowed).
                        const start = g.startVol * 100 + (g.startVol >= 1 ? g.startBoost - 100 : 0);
                        let val = clamp(Math.round(start - (dy / rect.height) * 200), 0, 300);
                        if (val > 100 && !this.audio.active) val = 100; // graph is only created on activation events
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
                        hud(val ? 'volume' : 'mute', `Volume ${val}%`, val / 300);
                        break;
                    }
                    case 'scrub': {
                        const r = this.seekRange();
                        const span = Math.min(r.end - r.start, 240);
                        g.scrubDelta = (dx / rect.width) * span;
                        g.scrubTarget = clamp(g.startTime + g.scrubDelta, r.start, r.end);
                        this.previewTimeline(g.scrubTarget);
                        hud(null, `${fmtDelta(g.scrubDelta)}  ·  ${fmtTime(g.scrubTarget - r.start)}`, null);
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
                if (g.mode === 'pinch') {
                    if (pointers.size === 0) { hideHud(); this.announce(`Zoom ${Math.round(this.xf.zoom * 100)}%`); g = null; }
                    return;
                }
                clearTimeout(g.longTimer);
                const mode = g.mode;
                const cancelled = e.type === 'pointercancel';
                if (mode === 'boost') {
                    this.video.playbackRate = boostRestore || 1;
                    hideHud();
                } else if (mode === 'scrub' && !cancelled) {
                    this.seekTo(g.scrubTarget, false);
                    this.announce(`Seeked ${fmtDelta(g.scrubDelta)}`);
                    hideHud();
                } else if (mode === 'bright') {
                    this.announce(`Brightness ${this.filters.brightness}%`);
                    hideHud();
                } else if (mode === 'volume') {
                    this.saveSettings({ audio: { ...this.settings.audio } });
                    hideHud();
                } else if (!mode && !cancelled) {
                    this.handleTap(e, g, side(e.clientX), () => lastTap, (v) => { lastTap = v; }, () => tapTimer, (v) => { tapTimer = v; });
                }
                g = null;
            };
            this.listen(layer, 'pointerup', finish);
            this.listen(layer, 'pointercancel', finish);
            this.listen(layer, 'contextmenu', (e) => e.preventDefault());
            this.listen(layer, 'dblclick', (e) => {
                if (this.locked) return;
                if (this.lastPointerType === 'mouse') this.toggleFullscreen();
            });
            this.listen(layer, 'wheel', (e) => {
                if (this.locked) return;
                e.preventDefault();
                if (e.ctrlKey) this.setZoom(this.xf.zoom * (e.deltaY < 0 ? 1.1 : 0.9), false);
                else this.setVolume(this.video.volume + (e.deltaY < 0 ? 0.05 : -0.05), false);
                this.showControls();
            }, { passive: false });
        }

        handleTap(e, g, side, getLast, setLast, getTimer, setTimer) {
            const now = Date.now();
            const settings = this.settings.gestures;
            const last = getLast();
            const isTouch = g.type !== 'mouse';
            if (last && now - last.t < 300 && last.side === side) {
                clearTimeout(getTimer());
                setLast(null);
                if (!isTouch) return; // mouse double-click -> fullscreen via the dblclick listener
                if (side === 'center' || !settings.enabled || !settings.doubleTapSeek) { this.togglePlay(); return; }
                const step = this.settings.seekStep;
                const delta = side === 'left' ? -step : step;
                this.seekBy(delta, false);
                const rip = this.$(`.ripple.${side}`);
                rip.textContent = `${delta < 0 ? '«' : '»'} ${step}s`;
                rip.classList.remove('show');
                void rip.offsetWidth;
                rip.classList.add('show');
                this.announce(`${delta < 0 ? 'Back' : 'Forward'} ${step} seconds`);
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

        trapFocus(e, container) {
            const focusables = Array.from(container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
                .filter(el => !el.disabled && !el.hidden && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
            if (!focusables.length) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = this.shadow.activeElement;
            if (e.shiftKey && (active === first || !container.contains(active))) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && (active === last || !container.contains(active))) { e.preventDefault(); first.focus(); }
        }

        onKeyDown(e) {
            if (this.closed) return;
            const target = e.composedPath()[0];
            const tag = target && target.tagName;

            // --- Focus trapping for the topmost open layer ---
            if (e.key === 'Tab' && this.locked) {
                e.preventDefault();
                const u = this.$('.unlock');
                u.classList.add('show');
                u.focus();
                return;
            }
            if (e.key === 'Tab') {
                this.showControls();
                const layer = this.menu.classList.contains('open') ? this.menu
                    : this.help.classList.contains('open') ? this.help
                        : this.drawer.classList.contains('open') ? this.drawer
                            : this.errorShown ? this.$('.error') : this.root;
                if (layer === this.menu) { e.preventDefault(); this.closeMenu(true); return; }
                this.trapFocus(e, layer);
                return;
            }

            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                if (this.menu.classList.contains('open')) this.closeMenu(true);
                else if (this.help.classList.contains('open')) this.closeHelp();
                else if (this.drawer.classList.contains('open')) this.closeDrawer();
                else if (this.capturingKey) this.capturingKey = null;
                else if (this.locked) this.$('.unlock').classList.add('show');
                else this.destroy();
                return;
            }

            if (this.capturingKey) {
                e.preventDefault();
                e.stopPropagation();
                const action = this.capturingKey;
                this.capturingKey = null;
                const keymap = { ...this.settings.keymap, [action]: e.key };
                this.saveSettings({ keymap });
                this.announce(`${ACTIONS[action]} is now ${e.key === ' ' ? 'Space' : e.key}`);
                this.renderPanel('interface');
                return;
            }

            if (this.locked || this.menu.classList.contains('open')) return;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            if ((e.key === ' ' || e.key === 'Enter') && tag === 'BUTTON') return;
            if (target && target.getAttribute && target.getAttribute('role') === 'slider' && /^(Arrow|Page|Home|End)/.test(e.key)) return;
            if (target && target.getAttribute && target.getAttribute('role') === 'tab' && /^Arrow/.test(e.key)) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (this.drawer.classList.contains('open') || this.help.classList.contains('open')) {
                if (e.key !== '?') return;
            }

            const km = this.settings.keymap;
            const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            const match = Object.keys(km).find(a => {
                const k = km[a];
                return (k.length === 1 ? k.toLowerCase() : k) === key;
            });
            if (!match) return;
            e.preventDefault();
            e.stopPropagation();
            this.showControls();
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
                case 'speedDown': this.setRate(this.prevPreset(-1)); break;
                case 'speedUp': this.setRate(this.prevPreset(1)); break;
                case 'loopA': this.setLoopPoint('a'); break;
                case 'loopB': this.setLoopPoint('b'); break;
                case 'screenshot': this.screenshot(); break;
                case 'frameBack': this.stepFrame(-1); break;
                case 'frameFwd': this.stepFrame(1); break;
                case 'help': this.help.classList.contains('open') ? this.closeHelp() : this.openHelp(); break;
                default: break;
            }
        }

        prevPreset(dir) {
            const r = this.video.playbackRate;
            if (dir > 0) return SPEED_PRESETS.find(p => p > r + 0.001) || 4;
            return [...SPEED_PRESETS].reverse().find(p => p < r - 0.001) || 0.25;
        }

        // -----------------------------------------------------------------
        // Popup menus (speed / quality / captions)
        // -----------------------------------------------------------------
        openMenu(button, label, items) {
            if (this.menu.classList.contains('open') && this.menuButton === button) { this.closeMenu(true); return; }
            this.closeMenu(false);
            const m = this.menu;
            m.innerHTML = `<div class="menu-label" id="fs-menu-label">${esc(label)}</div>` + items.map((it, i) => {
                if (it.row) {
                    return `<div class="menu-row">${it.row.map((r, j) => `<button type="button" role="menuitem" data-i="${i}" data-j="${j}" tabindex="-1">${esc(r.label)}</button>`).join('')}</div>`;
                }
                return `<button type="button" role="menuitemradio" aria-checked="${!!it.checked}" data-i="${i}" tabindex="-1">${esc(it.label)}</button>`;
            }).join('');
            m.setAttribute('aria-labelledby', 'fs-menu-label');
            m.setAttribute('aria-hidden', 'false');
            m.classList.add('open');
            button.setAttribute('aria-expanded', 'true');
            this.menuButton = button;
            // Position above the button, inside the viewport.
            const br = button.getBoundingClientRect();
            const rr = this.root.getBoundingClientRect();
            m.style.left = '0px';
            m.style.top = '0px';
            const mw = m.offsetWidth;
            const mh = m.offsetHeight;
            m.style.left = `${clamp(br.left - rr.left + br.width / 2 - mw / 2, 8, rr.width - mw - 8)}px`;
            m.style.top = `${clamp(br.top - rr.top - mh - 8, 8, rr.height - mh - 8)}px`;
            const buttons = Array.from(m.querySelectorAll('button'));
            buttons.forEach(b => {
                b.addEventListener('click', () => {
                    const it = items[+b.dataset.i];
                    const keep = it.row ? it.row[+b.dataset.j].keepOpen : it.keepOpen;
                    if (it.row) it.row[+b.dataset.j].action(); else it.action();
                    if (!keep) this.closeMenu(true);
                });
            });
            m.onkeydown = (e) => {
                const idx = buttons.indexOf(this.shadow.activeElement);
                if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); buttons[(idx + 1) % buttons.length].focus(); }
                else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); buttons[(idx - 1 + buttons.length) % buttons.length].focus(); }
                else if (e.key === 'Home') { e.preventDefault(); buttons[0].focus(); }
                else if (e.key === 'End') { e.preventDefault(); buttons[buttons.length - 1].focus(); }
            };
            const checked = buttons.find(b => b.getAttribute('aria-checked') === 'true') || buttons[0];
            if (checked) checked.focus();
            this.showControls(true);
        }

        closeMenu(returnFocus) {
            if (!this.menu.classList.contains('open')) return;
            this.menu.classList.remove('open');
            this.menu.setAttribute('aria-hidden', 'true');
            this.menu.innerHTML = '';
            if (this.menuButton) {
                this.menuButton.setAttribute('aria-expanded', 'false');
                if (returnFocus) this.menuButton.focus({ preventScroll: true });
            }
            this.menuButton = null;
            this.scheduleHide();
        }

        openSpeedMenu(button) {
            const r = this.video.playbackRate;
            const items = [{
                row: [
                    { label: '−0.05×', keepOpen: true, action: () => this.setRate(this.video.playbackRate - 0.05) },
                    { label: '+0.05×', keepOpen: true, action: () => this.setRate(this.video.playbackRate + 0.05) }
                ]
            }];
            SPEED_PRESETS.forEach(p => items.push({ label: p === 1 ? '1× (normal)' : `${p}×`, checked: Math.abs(p - r) < 0.001, action: () => this.setRate(p) }));
            this.openMenu(button, `Speed (current ${+r.toFixed(2)}×)`, items);
        }

        openQualityMenu(button) {
            const tracks = this.currentVariants().slice().sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth);
            const items = [{ label: `Auto (ABR)${this.abrAuto && this.video.videoHeight ? ` · ${this.video.videoHeight}p` : ''}`, checked: this.abrAuto, action: () => this.selectQuality('auto') }];
            const seen = new Set();
            for (const t of tracks) {
                const key = `${t.height}|${t.bandwidth}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({ label: this.qualityLabel(t), checked: !this.abrAuto && this.lockedVariantId === t.id, action: () => this.selectQuality(t.id) });
            }
            this.openMenu(button, 'Quality', items);
        }

        openCaptionsMenu(button) {
            const items = [{ label: 'Off', checked: this.subs.source === 'off', action: () => this.selectSubtitle('off') }];
            this.textTracks().forEach(t => items.push({
                label: t.label || t.language || `Track ${t.id}`,
                checked: this.subs.source === 'shaka' && t.active,
                action: () => this.selectSubtitle('shaka', t.id)
            }));
            if (this.subs.externalCues) items.push({ label: `File: ${this.subs.externalName}`, checked: this.subs.source === 'external', action: () => this.selectSubtitle('external') });
            items.push({ label: 'Load subtitle file / style…', action: () => this.openDrawer('subtitles') });
            this.openMenu(button, 'Subtitles', items);
        }

        // -----------------------------------------------------------------
        // Drawer & help dialog
        // -----------------------------------------------------------------
        openDrawer(tab) {
            this.closeMenu(false);
            this.drawer.classList.add('open');
            this.$('.btn-settings').setAttribute('aria-expanded', 'true');
            this.selectTab(tab || this.currentTab || 'playback', true);
            this.showControls(true);
        }

        closeDrawer() {
            this.drawer.classList.remove('open');
            const b = this.$('.btn-settings');
            b.setAttribute('aria-expanded', 'false');
            b.focus({ preventScroll: true });
            this.capturingKey = null;
            this.scheduleHide();
        }

        selectTab(name, focus) {
            this.currentTab = name;
            this.$$('[role="tab"]').forEach(t => {
                const sel = t.dataset.tab === name;
                t.setAttribute('aria-selected', String(sel));
                t.tabIndex = sel ? 0 : -1;
                if (sel && focus) t.focus({ preventScroll: true });
            });
            this.$$('.drawer [role="tabpanel"]').forEach(p => { p.hidden = p.id !== `panel-${name}`; });
            this.renderPanel(name);
        }

        onTabKey(e) {
            const tabs = this.$$('[role="tab"]');
            const i = tabs.indexOf(e.currentTarget);
            let n = -1;
            if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
            else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
            else if (e.key === 'Home') n = 0;
            else if (e.key === 'End') n = tabs.length - 1;
            if (n >= 0) { e.preventDefault(); this.selectTab(tabs[n].dataset.tab, true); }
        }

        openHelp() {
            this.closeMenu(false);
            this.renderHelp();
            this.help.classList.add('open');
            this.helpReturn = this.shadow.activeElement;
            this.$('.btn-help-close').focus();
        }

        closeHelp() {
            this.help.classList.remove('open');
            const r = this.helpReturn && this.helpReturn.isConnected ? this.helpReturn : this.$('.btn-help');
            r.focus({ preventScroll: true });
        }

        renderHelp() {
            if (!this.settings) return;
            const km = this.settings.keymap;
            const keyName = k => (k === ' ' ? 'Space' : k.replace('Arrow', '') + (k.startsWith('Arrow') ? ' arrow' : ''));
            const keys = Object.keys(ACTIONS).map(a => `<span class="kbd">${esc(keyName(km[a] || ''))}</span><span>${esc(ACTIONS[a])}</span>`).join('');
            const gestures = [
                ['Double-tap left / right edge', `Seek ${this.settings.seekStep}s back / forward`],
                ['Long-press video', `Play at ${this.settings.longPressRate}× while held`],
                ['Swipe up/down on left half', 'Brightness'],
                ['Swipe up/down on right half', 'Volume and boost up to 300%'],
                ['Swipe left / right', 'Fine scrubbing with time preview'],
                ['Pinch', 'Zoom up to 400% (drag to pan while zoomed)'],
                ['Single tap', 'Show / hide controls'],
                ['Escape', 'Close menu, panel, or the player']
            ].map(([g, d]) => `<span class="kbd">${esc(g)}</span><span>${esc(d)}</span>`).join('');
            this.$('.help-body').innerHTML = `<h3>Keyboard</h3><div class="help-grid">${keys}</div><h3>Touch gestures${this.settings.gestures.enabled ? '' : ' (currently disabled)'}</h3><div class="help-grid">${gestures}</div><p class="hint">Shortcuts can be changed in Settings → Interface.</p>`;
        }

        renderAllPanels() {
            if (this.drawer.classList.contains('open') && this.currentTab) this.renderPanel(this.currentTab);
            this.updateSpeedUi();
            this.updateVolumeUi();
        }

        /** Re-render one tab panel, preserving focus position by element id. */
        renderPanel(name) {
            if (!this.settings || !this.drawer.classList.contains('open')) return;
            const panel = this.shadow.getElementById(`panel-${name}`);
            if (!panel || panel.hidden) return;
            const focusedId = this.shadow.activeElement && panel.contains(this.shadow.activeElement) ? this.shadow.activeElement.id : null;
            const scroll = panel.scrollTop;
            const builder = {
                playback: () => this.panelPlayback(),
                tracks: () => this.panelTracks(),
                subtitles: () => this.panelSubtitles(),
                sound: () => this.panelSound(),
                video: () => this.panelVideo(),
                interface: () => this.panelInterface(),
                download: () => this.panelDownload()
            }[name];
            if (!builder) return;
            panel.innerHTML = builder();
            this.bindPanel(name, panel);
            panel.scrollTop = scroll;
            if (focusedId) {
                const el = this.shadow.getElementById(focusedId);
                if (el) el.focus({ preventScroll: true });
            }
        }

        // ---------- panel builders ----------
        rangeField(id, label, min, max, step, value, text) {
            return `<div class="field"><label for="${id}">${esc(label)}</label><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" aria-valuetext="${esc(text)}"><output id="out-${id.slice(3)}" for="${id}">${esc(text)}</output></div>`;
        }

        selectField(id, label, options, value) {
            const pairs = Array.isArray(options) ? options : Object.entries(options);
            const opts = pairs.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`).join('');
            return `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}">${opts}</select></div>`;
        }

        checkField(id, label, checked) {
            return `<label class="check" for="${id}"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}>${esc(label)}</label>`;
        }

        panelPlayback() {
            const r = this.video.playbackRate;
            const loopText = this.loop.a == null ? 'No loop set'
                : this.loop.b == null ? `A = ${fmtTime(this.loop.a)}, set B` : `Looping ${fmtTime(this.loop.a)} → ${fmtTime(this.loop.b)}`;
            const bms = this.bookmarks.map((b, i) => `<li><span>${esc(fmtTime(b.t))} — ${esc(b.label)}</span><button type="button" id="bm-go-${i}" data-bm-go="${i}" aria-label="Jump to ${esc(b.label)}">Go</button><button type="button" id="bm-del-${i}" data-bm-del="${i}" aria-label="Delete bookmark ${esc(b.label)}">${icon('close')}</button></li>`).join('');
            return `
<fieldset><legend>Speed</legend>
  ${this.rangeField('in-speed', 'Playback speed', 0.25, 4, 0.05, r, `${+r.toFixed(2)}×`)}
  <div class="btn-row"><button type="button" class="btn-outline" id="speed-minus" aria-label="Slower by 0.05">−0.05×</button><button type="button" class="btn-outline" id="speed-plus" aria-label="Faster by 0.05">+0.05×</button><button type="button" class="btn-outline" id="speed-reset">Reset 1×</button></div>
  <div class="btn-row" role="group" aria-label="Speed presets">${SPEED_PRESETS.map(p => `<button type="button" class="btn-outline" data-speed="${p}" aria-pressed="${Math.abs(p - r) < 0.001}">${p}×</button>`).join('')}</div>
</fieldset>
<fieldset><legend>Seeking</legend>
  ${this.selectField('in-seekstep', 'Seek step (buttons, keys, double-tap)', SEEK_STEPS.map(s => [s, `${s} seconds`]), this.settings.seekStep)}
  <div class="btn-row"><button type="button" class="btn-outline" id="frame-back" aria-label="Previous frame">⏮ Frame</button><button type="button" class="btn-outline" id="frame-fwd" aria-label="Next frame">Frame ⏭</button></div>
</fieldset>
<fieldset><legend>A–B repeat loop</legend>
  <p class="hint" id="loop-status">${esc(loopText)}</p>
  <div class="btn-row"><button type="button" class="btn-outline" id="loop-a">Set A</button><button type="button" class="btn-outline" id="loop-b">Set B</button><button type="button" class="btn-outline" id="loop-clear">Clear loop</button></div>
</fieldset>
<fieldset><legend>Bookmarks</legend>
  <div class="field"><label for="bm-label" class="sr-only">Bookmark label</label><input type="text" id="bm-label" placeholder="Label (optional)" maxlength="80"><button type="button" class="btn-primary" id="bm-add">Add at ${esc(fmtTime(this.video.currentTime))}</button></div>
  <ul class="list" aria-label="Saved bookmarks">${bms || '<li><span>No bookmarks yet</span></li>'}</ul>
</fieldset>
<fieldset><legend>Capture &amp; modes</legend>
  <div class="btn-row">
    <button type="button" class="btn-outline" id="act-shot">${icon('camera')} Screenshot (PNG)</button>
    ${document.pictureInPictureEnabled ? `<button type="button" class="btn-outline" id="act-pip">${icon('pip')} Picture-in-picture</button>` : ''}
    <button type="button" class="btn-outline" id="act-audio" aria-pressed="${this.audioOnly}">${icon('headphones')} Audio-only mode</button>
    <button type="button" class="btn-outline" id="act-lock">${icon('lock')} Lock screen</button>
  </div>
</fieldset>`;
        }

        panelTracks() {
            if (this.mode !== 'mse') return '<p class="hint">Quality and audio track selection are available for HLS and DASH streams. This is a direct media file.</p>';
            const tracks = this.currentVariants().slice().sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth);
            const seen = new Set();
            const qItems = [`<label class="check"><input type="radio" name="q" value="auto"${this.abrAuto ? ' checked' : ''}>Auto (adaptive bitrate)${this.abrAuto && this.video.videoHeight ? ` — now ${this.video.videoHeight}p` : ''}</label>`];
            for (const t of tracks) {
                const k = `${t.height}|${t.bandwidth}`;
                if (seen.has(k)) continue;
                seen.add(k);
                qItems.push(`<label class="check"><input type="radio" name="q" value="${t.id}"${!this.abrAuto && this.lockedVariantId === t.id ? ' checked' : ''}>${esc(this.qualityLabel(t))}${t.active ? ' — playing' : ''}</label>`);
            }
            const audio = this.audioTracks();
            const aItems = audio.map((t, i) => `<label class="check"><input type="radio" name="atrack" value="${i}"${t.active ? ' checked' : ''}>${esc(t.label || t.language || `Track ${i + 1}`)}${t.channelsCount ? ` (${t.channelsCount}ch)` : ''}${t.language ? ` [${esc(t.language)}]` : ''}</label>`).join('');
            const bw = this.engineStats ? fmtBitrate(this.engineStats.bandwidth) : '—';
            return `
<fieldset role="radiogroup" aria-labelledby="lg-quality"><legend id="lg-quality">Quality</legend>
  <p class="hint">Measured bandwidth: ${esc(bw)}. Auto mode is driven by FastStream's background ABR controller.</p>
  ${qItems.join('')}
</fieldset>
${this.selectField('in-cap', 'Maximum resolution', QUALITY_CAPS, this.qualityCap)}
<fieldset role="radiogroup" aria-labelledby="lg-audio"><legend id="lg-audio">Audio track</legend>
  ${aItems || '<p class="hint">This stream has a single audio track.</p>'}
</fieldset>`;
        }

        panelSubtitles() {
            const st = this.settings.subtitles;
            const tracks = this.textTracks();
            const srcItems = [`<label class="check"><input type="radio" name="sub" value="off"${this.subs.source === 'off' ? ' checked' : ''}>Off</label>`]
                .concat(tracks.map(t => `<label class="check"><input type="radio" name="sub" value="shaka:${t.id}"${this.subs.source === 'shaka' && t.active ? ' checked' : ''}>${esc(t.label || t.language || `Track ${t.id}`)}${t.kind === 'caption' ? ' (CC)' : ''}</label>`));
            if (this.subs.externalCues) srcItems.push(`<label class="check"><input type="radio" name="sub" value="external"${this.subs.source === 'external' ? ' checked' : ''}>File: ${esc(this.subs.externalName)}</label>`);
            const off = this.subs.offset;
            return `
<fieldset role="radiogroup" aria-labelledby="lg-subsrc"><legend id="lg-subsrc">Subtitle track</legend>${srcItems.join('')}
  <div class="btn-row"><button type="button" class="btn-primary" id="sub-load">Load .srt / .vtt file…</button><input type="file" id="sub-file" accept=".srt,.vtt,text/vtt,application/x-subrip" hidden></div>
</fieldset>
<fieldset><legend>Sync offset</legend>
  <div class="field"><span>Delay (positive = later)</span><output id="out-suboffset">${off >= 0 ? '+' : ''}${off.toFixed(1)} s</output></div>
  <div class="btn-row"><button type="button" class="btn-outline" data-suboff="-0.5">−0.5 s</button><button type="button" class="btn-outline" data-suboff="-0.1">−0.1 s</button><button type="button" class="btn-outline" data-suboff="0.1">+0.1 s</button><button type="button" class="btn-outline" data-suboff="0.5">+0.5 s</button><button type="button" class="btn-outline" data-suboff="reset">Reset</button></div>
</fieldset>
<fieldset><legend>Style</legend>
  ${this.selectField('in-subfont', 'Font', Object.fromEntries(Object.entries(FONTS).map(([k, f]) => [k, f.label])), st.font)}
  ${this.rangeField('in-subsize', 'Size', 50, 300, 10, st.size, `${st.size}%`)}
  ${this.selectField('in-subcolor', 'Text colour', SUB_COLORS, st.color)}
  ${this.rangeField('in-subbg', 'Background opacity', 0, 100, 5, st.bgOpacity, `${st.bgOpacity}%`)}
  ${this.selectField('in-subedge', 'Edge', { none: 'None', shadow: 'Drop shadow', outline: 'Outline' }, st.edge)}
  ${this.rangeField('in-subpos', 'Vertical position', 0, 80, 1, st.position, `${st.position}% from bottom`)}
  <div class="sub-preview" aria-hidden="true"><span class="cue-line">Subtitle preview — The quick brown fox</span></div>
</fieldset>`;
        }

        panelSound() {
            const a = this.settings.audio;
            const allowed = this.audio.allowed();
            return `
${allowed ? '' : '<p class="hint">⚠ This file is served from another site without CORS, so the browser does not allow audio processing. Boost, EQ and delay are unavailable.</p>'}
<fieldset><legend>Volume boost</legend>
  ${this.rangeField('in-boost', 'Boost', 100, 300, 5, a.boost, `${a.boost}%`)}
  <p class="hint">Above 150% a limiter is engaged automatically to prevent distortion.</p>
</fieldset>
<fieldset role="radiogroup" aria-labelledby="lg-preset"><legend id="lg-preset">Sound preset</legend>
  ${Object.entries(AUDIO_PRESETS).map(([k, p]) => `<label class="check"><input type="radio" name="apreset" value="${k}"${a.preset === k ? ' checked' : ''}${allowed ? '' : ' disabled'}>${esc(p.label)}</label>`).join('')}
</fieldset>
<fieldset><legend>Audio delay (lip-sync)</legend>
  <div class="field"><span>Audio is delayed by</span><output id="out-adelay">${a.delayMs} ms</output></div>
  <div class="btn-row"><button type="button" class="btn-outline" data-adelay="-50"${allowed ? '' : ' disabled'}>−50 ms</button><button type="button" class="btn-outline" data-adelay="50"${allowed ? '' : ' disabled'}>+50 ms</button><button type="button" class="btn-outline" data-adelay="reset"${allowed ? '' : ' disabled'}>Reset</button></div>
  <p class="hint">Use when sound arrives before the picture (0–1000 ms). Web Audio can only delay audio, not advance it.</p>
</fieldset>`;
        }

        panelVideo() {
            const f = this.filters;
            const presets = (this.settings.filterPresets || []).map((p, i) => `<li><span>${esc(p.name)}</span><button type="button" id="fp-apply-${i}" data-fp-apply="${i}">Apply</button><button type="button" id="fp-del-${i}" data-fp-del="${i}" aria-label="Delete preset ${esc(p.name)}">${icon('close')}</button></li>`).join('');
            return `
<fieldset><legend>Picture adjustments</legend>
  ${this.rangeField('in-f-brightness', 'Brightness', 20, 200, 5, f.brightness, `${f.brightness}%`)}
  ${this.rangeField('in-f-contrast', 'Contrast', 50, 200, 5, f.contrast, `${f.contrast}%`)}
  ${this.rangeField('in-f-saturate', 'Saturation', 0, 300, 5, f.saturate, `${f.saturate}%`)}
  ${this.rangeField('in-f-sharpness', 'Sharpness', 0, 100, 5, f.sharpness, `${f.sharpness}%`)}
  ${this.rangeField('in-f-hue', 'Hue', -180, 180, 5, f.hue, `${f.hue}°`)}
  ${this.rangeField('in-f-warmth', 'Warmth (eye care)', 0, 100, 5, f.warmth, `${f.warmth}%`)}
  <div class="btn-row"><button type="button" class="btn-outline" id="f-reset">Reset all</button></div>
  <div class="field"><label for="fp-name" class="sr-only">Preset name</label><input type="text" id="fp-name" placeholder="Preset name" maxlength="40"><button type="button" class="btn-primary" id="fp-save">Save preset</button></div>
  <ul class="list" aria-label="Saved picture presets">${presets || '<li><span>No saved presets</span></li>'}</ul>
</fieldset>
<fieldset role="radiogroup" aria-labelledby="lg-fit"><legend id="lg-fit">Aspect ratio &amp; fit</legend>
  ${Object.entries(FIT_MODES).map(([k, l]) => `<label class="check"><input type="radio" name="fit" value="${k}"${this.fit === k ? ' checked' : ''}>${esc(l)}</label>`).join('')}
</fieldset>
<fieldset><legend>Transform</legend>
  ${this.rangeField('in-zoom', 'Zoom', 100, 400, 5, Math.round(this.xf.zoom * 100), `${Math.round(this.xf.zoom * 100)}%`)}
  <div class="btn-row">
    <button type="button" class="btn-outline" id="xf-rotate">Rotate 90° (now ${this.xf.rotate}°)</button>
    <button type="button" class="btn-outline" id="xf-flip" aria-pressed="${this.xf.flip}">Mirror horizontally</button>
    <button type="button" class="btn-outline" id="xf-reset">Reset transform</button>
  </div>
</fieldset>`;
        }

        panelInterface() {
            const s = this.settings;
            const g = s.gestures;
            const speeds = SPEED_PRESETS.map(p => [p, `${p}×`]);
            const keyName = k => (k === ' ' ? 'Space' : k);
            const keys = Object.keys(ACTIONS).map(a => `<li><span>${esc(ACTIONS[a])}</span><span class="kbd">${esc(this.capturingKey === a ? 'Press a key…' : keyName(s.keymap[a] || ''))}</span><button type="button" id="key-${a}" data-key="${a}" aria-label="Change shortcut for ${esc(ACTIONS[a])}">Change</button></li>`).join('');
            return `
<fieldset><legend>Appearance</legend>
  ${this.selectField('in-theme', 'Theme & accent', THEMES, s.theme)}
  ${this.selectField('in-scale', 'UI size', UI_SCALES, s.uiScale)}
  ${this.checkField('in-hc', 'High-contrast mode', s.highContrast)}
  ${this.selectField('in-rm', 'Reduced motion', { system: 'Follow system setting', on: 'Always reduce motion', off: 'Allow animations' }, s.reducedMotion)}
  ${this.checkField('in-simple', 'Simple / clean mode (fewer buttons)', s.simpleMode)}
  ${this.selectField('in-autohide', 'Auto-hide controls', AUTOHIDE, s.autoHideMs)}
  ${this.checkField('in-stats', 'Show stats for nerds', s.showStats)}
</fieldset>
<fieldset><legend>Startup defaults</legend>
  ${this.selectField('in-defspeed', 'Default speed', speeds, s.defaultSpeed)}
  ${this.selectField('in-defcap', 'Preferred resolution cap', QUALITY_CAPS, s.qualityCap)}
  ${this.checkField('in-autofs', 'Enter fullscreen on first tap', s.autoFullscreen)}
</fieldset>
<fieldset><legend>Touch gestures</legend>
  ${this.checkField('in-g-enabled', 'Enable gestures', g.enabled)}
  ${this.checkField('in-g-doubleTapSeek', 'Double-tap edges to seek', g.doubleTapSeek)}
  ${this.checkField('in-g-longPressSpeed', 'Long-press for speed boost', g.longPressSpeed)}
  ${this.selectField('in-lprate', 'Long-press speed', [[1.5, '1.5×'], [2, '2×'], [3, '3×'], [4, '4×']], s.longPressRate)}
  ${this.checkField('in-g-brightnessSwipe', 'Swipe left half for brightness', g.brightnessSwipe)}
  ${this.checkField('in-g-volumeSwipe', 'Swipe right half for volume', g.volumeSwipe)}
  ${this.checkField('in-g-scrubSwipe', 'Swipe horizontally to scrub', g.scrubSwipe)}
  ${this.checkField('in-g-pinchZoom', 'Pinch to zoom', g.pinchZoom)}
</fieldset>
<fieldset><legend>Keyboard shortcuts</legend>
  <ul class="list">${keys}</ul>
  <div class="btn-row"><button type="button" class="btn-outline" id="keys-reset">Reset shortcuts</button></div>
</fieldset>`;
        }

        panelDownload() {
            const st = this.exportState;
            const supported = this.stream.type === 'hls' || this.stream.type === 'progressive';
            const running = st && st.running;
            return `
<fieldset><legend>Save stream</legend>
  <p class="hint">${supported
                ? (this.stream.type === 'hls'
                    ? 'Saves the current quality as a .ts (MPEG-TS) or .mp4 (fMP4) file. AES-128 encrypted streams are decrypted. Separate audio renditions are saved as a second file. Live streams save the current playlist window.'
                    : 'Saves the media file using the page\'s own network access.')
                : 'Export is available for HLS streams and direct media files. DASH export is not supported.'}</p>
  <p class="hint">Only download content you have the right to save.</p>
  <div class="progress" id="export-bar" role="progressbar" aria-label="Export progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${st ? st.pct : 0}"><i style="width:${st ? st.pct : 0}%"></i></div>
  <p id="export-status" class="hint">${esc(st ? st.status : 'Not started')}</p>
  <div class="btn-row">
    <button type="button" class="btn-primary" id="export-start"${!supported || running ? ' disabled' : ''}>${icon('download')} Export stream</button>
    <button type="button" class="btn-outline" id="export-cancel"${running ? '' : ' disabled'}>Cancel</button>
  </div>
</fieldset>`;
        }

        // ---------- panel event binding ----------
        bindPanel(name, panel) {
            const byId = id => this.shadow.getElementById(id);
            const click = (id, fn) => { const el = byId(id); if (el) el.addEventListener('click', fn); };
            const range = (id, fn, fmt) => {
                const el = byId(id);
                if (!el) return;
                el.addEventListener('input', () => {
                    const val = +el.value;
                    fn(val);
                    const text = fmt(val);
                    el.setAttribute('aria-valuetext', text);
                    const out = byId(`out-${id.slice(3)}`);
                    if (out) out.textContent = text;
                });
            };
            const select = (id, fn) => { const el = byId(id); if (el) el.addEventListener('change', () => fn(el.value)); };
            const check = (id, fn) => { const el = byId(id); if (el) el.addEventListener('change', () => fn(el.checked)); };
            const radios = (nm, fn) => panel.querySelectorAll(`input[name="${nm}"]`).forEach(r => r.addEventListener('change', () => r.checked && fn(r.value)));

            if (name === 'playback') {
                range('in-speed', v => this.setRate(v, false), v => `${v}×`);
                click('speed-minus', () => this.setRate(this.video.playbackRate - 0.05));
                click('speed-plus', () => this.setRate(this.video.playbackRate + 0.05));
                click('speed-reset', () => { this.setRate(1); this.renderPanel('playback'); });
                panel.querySelectorAll('[data-speed]').forEach(b => b.addEventListener('click', () => { this.setRate(+b.dataset.speed); this.renderPanel('playback'); }));
                select('in-seekstep', v => this.saveSettings({ seekStep: +v }));
                click('frame-back', () => this.stepFrame(-1));
                click('frame-fwd', () => this.stepFrame(1));
                click('loop-a', () => this.setLoopPoint('a'));
                click('loop-b', () => this.setLoopPoint('b'));
                click('loop-clear', () => this.clearLoop());
                click('bm-add', () => this.addBookmark(byId('bm-label').value));
                panel.querySelectorAll('[data-bm-go]').forEach(b => b.addEventListener('click', () => {
                    const bm = this.bookmarks[+b.dataset.bmGo];
                    if (bm) { this.seekTo(bm.t, true); }
                }));
                panel.querySelectorAll('[data-bm-del]').forEach(b => b.addEventListener('click', () => {
                    const removed = this.bookmarks.splice(+b.dataset.bmDel, 1)[0];
                    this.saveBookmarks();
                    if (removed) this.announce(`Deleted bookmark ${removed.label}`);
                }));
                click('act-shot', () => this.screenshot());
                click('act-pip', () => this.togglePip());
                click('act-audio', () => this.setAudioOnly(!this.audioOnly));
                click('act-lock', () => { this.closeDrawer(); this.setLocked(true); });
            } else if (name === 'tracks') {
                radios('q', v => this.selectQuality(v === 'auto' ? 'auto' : +v));
                select('in-cap', v => { this.setQualityCap(+v); this.announce(`Maximum resolution ${+v ? `${v}p` : 'unlimited'}`); });
                radios('atrack', v => this.selectAudioTrack(+v));
            } else if (name === 'subtitles') {
                radios('sub', v => {
                    if (v === 'off' || v === 'external') this.selectSubtitle(v);
                    else this.selectSubtitle('shaka', +v.split(':')[1]);
                });
                const file = byId('sub-file');
                click('sub-load', () => file.click());
                file.addEventListener('change', () => this.loadSubtitleFile(file.files[0]));
                panel.querySelectorAll('[data-suboff]').forEach(b => b.addEventListener('click', () => {
                    const d = b.dataset.suboff;
                    this.setSubOffset(d === 'reset' ? 0 : this.subs.offset + parseFloat(d));
                }));
                const sub = patch => this.saveSettings({ subtitles: { ...this.settings.subtitles, ...patch } });
                select('in-subfont', v => sub({ font: v }));
                range('in-subsize', v => sub({ size: v }), v => `${v}%`);
                select('in-subcolor', v => sub({ color: v }));
                range('in-subbg', v => sub({ bgOpacity: v }), v => `${v}%`);
                select('in-subedge', v => sub({ edge: v }));
                range('in-subpos', v => sub({ position: v }), v => `${v}% from bottom`);
            } else if (name === 'sound') {
                const audio = patch => {
                    const next = { ...this.settings.audio, ...patch };
                    if (this.audio.ensure()) this.audio.apply(next);
                    this.saveSettings({ audio: next });
                };
                range('in-boost', v => audio({ boost: v }), v => `${v}%`);
                radios('apreset', v => { audio({ preset: v }); this.announce(`Sound preset: ${AUDIO_PRESETS[v].label}`); });
                panel.querySelectorAll('[data-adelay]').forEach(b => b.addEventListener('click', () => {
                    const d = b.dataset.adelay;
                    const val = d === 'reset' ? 0 : clamp(this.settings.audio.delayMs + (+d), 0, 1000);
                    audio({ delayMs: val });
                    byId('out-adelay').textContent = `${val} ms`;
                    this.announce(`Audio delay ${val} milliseconds`);
                }));
            } else if (name === 'video') {
                const filt = (key, suffix) => range(`in-f-${key}`, v => { this.filters[key] = v; this.applyFilters(); }, v => `${v}${suffix}`);
                filt('brightness', '%'); filt('contrast', '%'); filt('saturate', '%'); filt('sharpness', '%'); filt('hue', '°'); filt('warmth', '%');
                click('f-reset', () => { this.filters = { ...DEFAULT_FILTERS }; this.applyFilters(); this.renderPanel('video'); this.announce('Picture reset'); });
                click('fp-save', () => {
                    const nameVal = byId('fp-name').value.trim() || `Preset ${(this.settings.filterPresets || []).length + 1}`;
                    const list = (this.settings.filterPresets || []).concat([{ name: nameVal.slice(0, 40), values: { ...this.filters } }]).slice(-20);
                    this.saveSettings({ filterPresets: list });
                    this.renderPanel('video');
                    this.announce(`Saved preset ${nameVal}`);
                });
                panel.querySelectorAll('[data-fp-apply]').forEach(b => b.addEventListener('click', () => {
                    const p = this.settings.filterPresets[+b.dataset.fpApply];
                    if (p) { this.filters = { ...DEFAULT_FILTERS, ...p.values }; this.applyFilters(); this.renderPanel('video'); this.announce(`Applied ${p.name}`); }
                }));
                panel.querySelectorAll('[data-fp-del]').forEach(b => b.addEventListener('click', () => {
                    const list = this.settings.filterPresets.slice();
                    list.splice(+b.dataset.fpDel, 1);
                    this.saveSettings({ filterPresets: list });
                    this.renderPanel('video');
                }));
                radios('fit', v => { this.fit = v; this.layoutVideo(); this.announce(FIT_MODES[v]); });
                range('in-zoom', v => this.setZoom(v / 100, false), v => `${v}%`);
                click('xf-rotate', () => { this.xf.rotate = (this.xf.rotate + 90) % 360; this.layoutVideo(); this.renderPanel('video'); this.announce(`Rotated ${this.xf.rotate} degrees`); });
                click('xf-flip', () => { this.xf.flip = !this.xf.flip; this.layoutVideo(); this.renderPanel('video'); this.announce(this.xf.flip ? 'Mirrored' : 'Mirror off'); });
                click('xf-reset', () => { this.xf = { zoom: 1, panX: 0, panY: 0, rotate: 0, flip: false }; this.fit = 'contain'; this.layoutVideo(); this.renderPanel('video'); this.announce('Transform reset'); });
            } else if (name === 'interface') {
                select('in-theme', v => this.saveSettings({ theme: v }));
                select('in-scale', v => this.saveSettings({ uiScale: +v }));
                check('in-hc', v => this.saveSettings({ highContrast: v }));
                select('in-rm', v => this.saveSettings({ reducedMotion: v }));
                check('in-simple', v => this.saveSettings({ simpleMode: v }));
                select('in-autohide', v => { this.saveSettings({ autoHideMs: +v }); this.scheduleHide(); });
                check('in-stats', v => this.saveSettings({ showStats: v }));
                select('in-defspeed', v => this.saveSettings({ defaultSpeed: +v }));
                select('in-defcap', v => this.saveSettings({ qualityCap: +v }));
                check('in-autofs', v => this.saveSettings({ autoFullscreen: v }));
                select('in-lprate', v => this.saveSettings({ longPressRate: +v }));
                for (const k of ['enabled', 'doubleTapSeek', 'longPressSpeed', 'brightnessSwipe', 'volumeSwipe', 'scrubSwipe', 'pinchZoom']) {
                    check(`in-g-${k}`, v => this.saveSettings({ gestures: { ...this.settings.gestures, [k]: v } }));
                }
                panel.querySelectorAll('[data-key]').forEach(b => b.addEventListener('click', () => {
                    this.capturingKey = b.dataset.key;
                    this.renderPanel('interface');
                    this.announce(`Press the new key for ${ACTIONS[b.dataset.key]}, or Escape to cancel`);
                }));
                // keymap:null makes the bridge fall back to defaults; SETTINGS_CHANGED re-renders.
                click('keys-reset', () => { this.port.send({ type: 'SETTINGS_SET', patch: { keymap: null } }); this.announce('Shortcuts reset'); });
            } else if (name === 'download') {
                click('export-start', () => this.startExport());
                click('export-cancel', () => this.cancelExport());
            }
        }

        // -----------------------------------------------------------------
        // Media Session (lock-screen / notification controls on mobile)
        // -----------------------------------------------------------------
        setupMediaSession() {
            if (!('mediaSession' in navigator)) return;
            try {
                navigator.mediaSession.metadata = new MediaMetadata({ title: this.$('.title').textContent, artist: 'FastStream' });
                const ms = navigator.mediaSession;
                ms.setActionHandler('play', () => this.video.play());
                ms.setActionHandler('pause', () => this.video.pause());
                ms.setActionHandler('seekbackward', () => this.seekBy(-this.settings.seekStep));
                ms.setActionHandler('seekforward', () => this.seekBy(this.settings.seekStep));
                ms.setActionHandler('seekto', (d) => this.seekTo(d.seekTime));
            } catch (_) { /* partial support */ }
        }
    }

    // =====================================================================
    // Boot: only accept the MessagePort carrying the one-time nonce
    // =====================================================================
    function boot(nonce) {
        const onMsg = (e) => {
            const d = e.data;
            if (e.source !== window || !d || d.source !== 'faststream-bridge' || d.type !== 'FS_BRIDGE_PORT' || d.nonce !== nonce) return;
            window.removeEventListener('message', onMsg, true);
            e.stopImmediatePropagation();
            const port = e.ports && e.ports[0];
            if (!port) return;
            if (current) current.destroy({ notify: false });
            current = new FastStreamPlayer(port);
        };
        window.addEventListener('message', onMsg, true);
        setTimeout(() => window.removeEventListener('message', onMsg, true), 20000);
    }

    Object.defineProperty(window, '__FASTSTREAM_BOOT__', { value: boot, configurable: false, writable: false });
})();
