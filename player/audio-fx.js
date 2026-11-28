import { clamp } from './numbers.js';

export const EQ_BANDS = [
    { type: 'lowshelf', f: 60, label: '60' }, { type: 'peaking', f: 230, label: '230' }, { type: 'peaking', f: 910, label: '910' },
    { type: 'peaking', f: 3600, label: '3.6k' }, { type: 'highshelf', f: 14000, label: '14k' }
];
export const AUDIO_PRESETS = {
    normal: { label: 'Flat', meta: 'Neutral', eq: [0, 0, 0, 0, 0], compress: false },
    cinema: { label: 'Cinema', meta: 'Gentle contour', eq: [2, 0, 0, 2, 1], compress: true },
    music: { label: 'Music', meta: 'Light presence', eq: [1, 0, 0, 1, 1], compress: false },
    voice: { label: 'Voice clarity', meta: '+5 dB', eq: [-4, -2, 3, 5, 1], compress: true },
    bass: { label: 'Bass boost', meta: '+7 dB', eq: [7, 4, 0, -1, 0], compress: false },
    night: { label: 'Night mode', meta: 'Compressor', eq: [1, 0, 1, 2, 0], compress: true },
    custom: { label: 'Custom EQ', meta: '5-band', eq: null, compress: false }
};

/** Update the session-owned silence detector and return any media-clock adjustments. */
export function lectureSilenceStep(state, settings, video, level, now) {
    if (level < 10 ** (settings.silenceDb / 20)) {
        if (!state.darkSince) state.darkSince = now;
        state.lastQuiet = video.currentTime;
        if (state.boostFrom == null && now - state.darkSince >= settings.silenceMs + settings.speechPadMs &&
            video.playbackRate > 0 && video.playbackRate < 2) {
            state.boostFrom = video.playbackRate;
            return { rate: 2 };
        }
        return;
    }
    state.darkSince = 0;
    if (state.boostFrom == null) return;
    const adjustment = { rate: state.boostFrom };
    state.boostFrom = null;
    if (state.lastQuiet <= video.currentTime && video.currentTime - state.lastQuiet < 1.5) {
        adjustment.seek = Math.max(0, state.lastQuiet - settings.speechPadMs / 1000);
    }
    return adjustment;
}

export class AudioFx {
    constructor(video, Context = window.AudioContext || window.webkitAudioContext) {
        this.Context = Context;
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
        const AC = this.Context;
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
            normLimit.threshold.value = -3;
            normLimit.knee.value = 0;
            normLimit.ratio.value = 20;
            normLimit.attack.value = 0.001;
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
            const output = ctx.createGain();
            const ceiling = ctx.createWaveShaper();
            ceiling.curve = new Float32Array([-0.99, 0, 0.99]);
            normLimit.connect(ceiling);
            ceiling.connect(ctx.destination);
            output.connect(ctx.destination);
            this.nodes.output = output;
            this.nodes.ceiling = ceiling;
            this._routeNorm(false);
            this._routeSpatial({ width: 100, crossfeed: false, dialogue: 0 });
            this.loud = { energy: 0, primed: false };
            this.channels = null;
            this._routeChannels('stereo');
            this._route(false);
            if (ctx.state === 'suspended') ctx.resume().catch(() => { });
            return true;
        } catch (e) {
            console.warn('[Aethvyr] Audio graph unavailable:', e);
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

    /** Gain feeds the spatial stage directly or through the normalization gain. */
    _routeNorm(on) {
        const n = this.nodes;
        if (!n || n.normalizing === on) return;
        try { n.gain.disconnect(n.out); } catch (_) { /* not connected */ }
        try { n.gain.disconnect(n.normGain); } catch (_) { /* not connected */ }
        try { n.normGain.disconnect(); } catch (_) { /* not connected */ }
        if (on) {
            n.gain.connect(n.normGain);
            n.normGain.connect(n.out);
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
        const w = clamp((a.width ?? 100) / 100, 0, 2);
        const dlg = clamp(+a.dialogue || 0, 0, 100) / 100;
        const cf = !!a.crossfeed;
        const neutral = Math.abs(w - 1) < 0.005 && !dlg && !cf;
        const key = neutral ? 'bypass' : 'spatial';
        const ctx = this.ctx;
        if (n.spatialKey !== key) {
            try { n.out.disconnect(n.post); } catch (_) { /* not connected */ }
            if (n.sp) { n.out.disconnect(n.sp.up); for (const node of Object.values(n.sp)) { try { node.disconnect(); } catch (_) { /* ignore */ } } }
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
        try { n.post.disconnect(n.output); } catch (_) { /* not connected */ }
        if (n.chan) { n.post.disconnect(n.chan.down || n.chan.split); for (const node of Object.values(n.chan)) { try { node.disconnect(); } catch (_) { /* ignore */ } } }
        n.chan = null;
        if (mode === 'mono') {
            const down = ctx.createGain();
            down.channelCount = 1;
            down.channelCountMode = 'explicit';
            down.channelInterpretation = 'speakers';
            n.post.connect(down);
            down.connect(n.output);
            n.chan = { down };
        } else if (mode === 'left' || mode === 'right') {
            const split = ctx.createChannelSplitter(2);
            const merge = ctx.createChannelMerger(2);
            const ch = mode === 'left' ? 0 : 1;
            n.post.connect(split);
            split.connect(merge, ch, 0);
            split.connect(merge, ch, 1);
            merge.connect(n.output);
            n.chan = { split, merge };
        } else {
            n.post.connect(n.output);
        }
        this.channels = mode;
    }

    apply(audio) {
        if (!this.ctx) return;
        this._routeChannels(audio.channels || 'stereo');
        this._routeNorm(!!audio.loudnessNorm);
        this._routeSpatial({ width: audio.width ?? 100, crossfeed: !!audio.crossfeed, dialogue: audio.dialogue || 0 });
        const preset = Object.hasOwn(AUDIO_PRESETS, audio.preset) ? AUDIO_PRESETS[audio.preset] : AUDIO_PRESETS.normal;
        const gains = audio.preset === 'custom' ? (audio.eq || [0, 0, 0, 0, 0]) : preset.eq;
        const n = this.nodes;
        const t = this.ctx.currentTime;
        gains.forEach((db, i) => n.eq[i].gain.setTargetAtTime(clamp(+db || 0, -12, 12), t, 0.05));
        const boost = clamp(Number(audio.boost) || 100, 100, 300) / 100;
        const protect = boost > 1 || preset.compress || gains.some(db => db > 0) || audio.loudnessNorm ||
            audio.crossfeed || audio.dialogue > 0 || audio.width > 100;
        if (!!n.protectedOutput !== !!protect) {
            n.output.disconnect();
            n.output.connect(protect ? n.normLimit : this.ctx.destination);
            n.protectedOutput = !!protect;
        }
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
        if (this.nodes) this.nodes.source.disconnect();
        this.freq = this.levels = null;
        if (this.ctx) this.ctx.close().catch(() => { });
        this.ctx = null;
        this.nodes = null;
    }
}
