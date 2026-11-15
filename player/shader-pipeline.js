/**
 * Velostream - GPU video shader pipeline (WebGL2), runs in the player extension page.
 *
 * Draws the <video> through WebGL2 into a <canvas> laid exactly over it:
 *   cas      - Contrast Adaptive Sharpening (1 pass, replaces the CPU SVG convolution)
 *   fsr      - Lanczos-2 upscale with anti-ringing + RCAS sharpening (2 passes, FSR 1-style)
 *   anime4k  - Lanczos-2 upscale + gradient "push" line reconstruction (2 passes, Anime4K-lite)
 *   deband   - randomized 4-tap gradient smoothing with dither (1 pass)
 *
 * The canvas is sized min(maxRenderRes, displayed size x devicePixelRatio). Frames are driven by
 * requestVideoFrameCallback (falls back to requestAnimationFrame), so nothing runs while the
 * video is paused, hidden or audio-only; seeks and setting changes render one frame on demand.
 * A thermal guard steps the preset down (fsr/anime4k -> cas -> off) when the GPU cannot keep up.
 *
 * Exposes window.VelostreamShaders = { VideoShaderPipeline, PRESETS, isSupported }.
 */
(function () {
    'use strict';

    const PRESETS = ['off', 'cas', 'fsr', 'anime4k', 'deband'];
    const STEP_DOWN = { fsr: 'cas', anime4k: 'cas', deband: 'off', cas: 'off' };

    const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
// Video textures are uploaded top row first (v = 0 is the top of the picture), while a texture
// rendered by an earlier pass stores the top of the picture at v = 1 (GL framebuffer origin is
// bottom-left). uFbo selects the matching mapping so every pass keeps the picture upright.
uniform float uFbo;
void main() {
    vUv = vec2(aPos.x * 0.5 + 0.5, uFbo > 0.5 ? aPos.y * 0.5 + 0.5 : 0.5 - aPos.y * 0.5);
    gl_Position = vec4(aPos, 0.0, 1.0);
}`;

    const HEADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uInSize;     // input texture size in pixels
uniform vec2 uOutSize;    // output size in pixels
uniform float uStrength;  // 0..1
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 px(vec2 uv, vec2 d) { return texture(uTex, uv + d / uInSize).rgb; }
`;

    // AMD FidelityFX CAS (simplified, cross-shaped 5-tap variant) at source-texel spacing.
    const FS_CAS = HEADER + `
void main() {
    vec3 b = px(vUv, vec2(0.0, -1.0));
    vec3 d = px(vUv, vec2(-1.0, 0.0));
    vec3 e = px(vUv, vec2(0.0, 0.0));
    vec3 f = px(vUv, vec2(1.0, 0.0));
    vec3 h = px(vUv, vec2(0.0, 1.0));
    vec3 mn = min(min(min(d, e), min(f, b)), h);
    vec3 mx = max(max(max(d, e), max(f, b)), h);
    vec3 amp = sqrt(clamp(min(mn, 2.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
    float peak = -1.0 / mix(8.0, 4.5, uStrength);
    vec3 w = amp * peak;
    vec3 col = (e + (b + d + f + h) * w) / (1.0 + 4.0 * w);
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    // Lanczos-2 (4x4 taps) with anti-ringing clamp to the nearest 2x2 texels.
    const FS_LANCZOS = HEADER + `
float lanczos2(float x) {
    x = abs(x);
    if (x < 1e-5) return 1.0;
    if (x >= 2.0) return 0.0;
    float px = 3.14159265 * x;
    return 2.0 * sin(px) * sin(px * 0.5) / (px * px);
}
void main() {
    vec2 pos = vUv * uInSize - 0.5;
    vec2 base = floor(pos);
    vec2 fr = pos - base;
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    vec3 mn = vec3(1.0);
    vec3 mx = vec3(0.0);
    for (int j = -1; j <= 2; j++) {
        float wy = lanczos2(float(j) - fr.y);
        for (int i = -1; i <= 2; i++) {
            float w = lanczos2(float(i) - fr.x) * wy;
            vec3 c = texture(uTex, (base + vec2(float(i), float(j)) + 0.5) / uInSize).rgb;
            if (i >= 0 && i <= 1 && j >= 0 && j <= 1) { mn = min(mn, c); mx = max(mx, c); }
            sum += c * w;
            wsum += w;
        }
    }
    outColor = vec4(clamp(sum / wsum, mn, mx), 1.0);
}`;

    // FSR 1 RCAS (robust contrast adaptive sharpening) on the upscaled image.
    const FS_RCAS = HEADER + `
void main() {
    vec3 b = px(vUv, vec2(0.0, -1.0));
    vec3 d = px(vUv, vec2(-1.0, 0.0));
    vec3 e = px(vUv, vec2(0.0, 0.0));
    vec3 f = px(vUv, vec2(1.0, 0.0));
    vec3 h = px(vUv, vec2(0.0, 1.0));
    vec3 mn4 = min(min(b, d), min(f, h));
    vec3 mx4 = max(max(b, d), max(f, h));
    vec3 hitMin = mn4 / max(4.0 * mx4, vec3(1e-4));
    vec3 hitMax = (1.0 - mx4) / min(4.0 * mn4 - 4.0, vec3(-1e-4));
    vec3 lobeRGB = max(-hitMin, hitMax);
    float sharp = exp2(-mix(2.0, 0.0, uStrength));
    float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * sharp;
    vec3 col = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    // Anime4K-lite: push each pixel toward the brighter side of strong luma gradients, which
    // thins and straightens dark line art after upscaling, then lightly re-darkens the lines.
    const FS_A4K = HEADER + `
void main() {
    float tl = luma(px(vUv, vec2(-1.0, -1.0)));
    float t  = luma(px(vUv, vec2(0.0, -1.0)));
    float tr = luma(px(vUv, vec2(1.0, -1.0)));
    float l  = luma(px(vUv, vec2(-1.0, 0.0)));
    vec3  cc = px(vUv, vec2(0.0));
    float r  = luma(px(vUv, vec2(1.0, 0.0)));
    float bl = luma(px(vUv, vec2(-1.0, 1.0)));
    float b  = luma(px(vUv, vec2(0.0, 1.0)));
    float br = luma(px(vUv, vec2(1.0, 1.0)));
    vec2 g = vec2(tr + 2.0 * r + br - tl - 2.0 * l - bl, bl + 2.0 * b + br - tl - 2.0 * t - tr);
    float mag = length(g);
    vec3 col = cc;
    if (mag > 0.04) {
        vec2 dir = g / mag;
        vec3 bright = px(vUv, dir * 0.75);
        float k = uStrength * smoothstep(0.04, 0.45, mag);
        col = mix(cc, bright, k * 0.65);
        float avg = (t + l + r + b) * 0.25;
        if (luma(cc) < avg - 0.05) col *= mix(1.0, 0.9, k);
    }
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    // Deband: compare 4 randomized taps at a radius; smooth only where they agree (flat areas).
    const FS_DEBAND = HEADER + `
uniform float uFrame;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uFrame * 0.618) * 43758.5453); }
void main() {
    vec3 c = px(vUv, vec2(0.0));
    float ang = hash(vUv * uOutSize) * 6.2831853;
    float rad = mix(6.0, 16.0, hash(vUv * uOutSize + 3.1));
    vec2 o = vec2(cos(ang), sin(ang)) * rad;
    vec3 a1 = px(vUv, o);
    vec3 a2 = px(vUv, -o);
    vec3 a3 = px(vUv, vec2(-o.y, o.x));
    vec3 a4 = px(vUv, vec2(o.y, -o.x));
    vec3 avg = (a1 + a2 + a3 + a4) * 0.25;
    float thr = mix(0.012, 0.035, uStrength);
    vec3 diff = max(max(abs(a1 - c), abs(a2 - c)), max(abs(a3 - c), abs(a4 - c)));
    vec3 col = c;
    if (max(diff.r, max(diff.g, diff.b)) < thr) col = avg;
    col += (hash(vUv * uOutSize + 7.7) - 0.5) / 255.0;
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    // Plain bilinear blit (used to present an intermediate texture).
    const FS_COPY = HEADER + `
void main() { outColor = vec4(texture(uTex, vUv).rgb, 1.0); }`;

    function isSupported() {
        try {
            const c = document.createElement('canvas');
            return !!c.getContext('webgl2');
        } catch (_) {
            return false;
        }
    }

    class VideoShaderPipeline {
        /**
         * @param {HTMLVideoElement} video
         * @param {HTMLCanvasElement} canvas
         * @param {{onStepDown?:(preset:string, reason:string)=>void, onUnavailable?:(reason:string)=>void}} hooks
         */
        constructor(video, canvas, hooks = {}) {
            this.video = video;
            this.canvas = canvas;
            this.hooks = hooks;
            this.preset = 'off';
            this.strength = 0.5;
            this.maxRenderRes = 2160;
            this.gl = null;
            this.programs = {};
            this.running = false;
            this.rvfc = typeof video.requestVideoFrameCallback === 'function';
            this.handle = 0;
            this.frame = 0;
            this.failed = false;
            this.contentRect = { x: 0, y: 0, w: 0, h: 0 };
            this.guard = { start: 0, frames: 0, cpu: 0, gpu: 0, gpuN: 0, dropped0: 0, total0: 0 };
            this.query = null;
            this.pendingQuery = null;
            this.vao = null;
            this.vbo = null;
            this.videoTex = null;
            this.fbo = null;
            this.destroyed = false;
            this.boundRender = (now, meta) => this.onFrame(now, meta);
            // preventDefault() asks the browser to restore the context (GPU reset, driver update,
            // mobile tab backgrounded). Until then the plain <video> shows through; on restore every
            // GL object is rebuilt. (Failing for good here, as before, left enhancement off for the
            // rest of the session although the browser handed the context back moments later.)
            this.lost = false;
            this.resumeOnRestore = false;
            this.onContextLost = (e) => {
                e.preventDefault();
                this.resumeOnRestore = this.running;
                this.stop();
                this.lost = true;
                this.drawn = false;
                this.canvas.hidden = true;
            };
            this.onContextRestored = () => this.restore();
        }

        get active() { return this.preset !== 'off' && !this.failed && !this.lost && !!this.gl; }

        init() {
            // After destroy() the canvas' context has been lost on purpose; getContext() would hand
            // back that same dead context, so a destroyed pipeline never re-initialises.
            if (this.destroyed) return false;
            if (this.gl || this.failed) return !!this.gl;
            const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
            // (No `desynchronized`: low-latency canvases bypass the compositor and can tear/flicker.)
            if (!gl) { this.fail('WebGL2 is not available'); return false; }
            // A canvas whose context was lost (e.g. by an earlier pipeline's destroy()) keeps returning
            // that dead context: report it plainly instead of a misleading "Shader compile failed".
            if (gl.isContextLost()) { this.fail('GPU context lost'); return false; }
            this.gl = gl;
            this.canvas.addEventListener('webglcontextlost', this.onContextLost);
            this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
            try {
                this.setupGl();
            } catch (err) {
                this.fail(`Shader compile failed: ${err.message}`);
                return false;
            }
            return true;
        }

        /** (Re)creates every GL object: on init and after a context restore (all objects died). */
        setupGl() {
            const gl = this.gl;
            this.programs = {};
            this.fbo = null;
            this.pendingQuery = null;
            const buf = gl.createBuffer();
            this.vbo = buf;
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
            this.vao = gl.createVertexArray();
            gl.bindVertexArray(this.vao);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            this.videoTex = this.makeTexture();
            this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
            const src = { cas: FS_CAS, lanczos: FS_LANCZOS, rcas: FS_RCAS, a4k: FS_A4K, deband: FS_DEBAND, copy: FS_COPY };
            for (const [k, fs] of Object.entries(src)) this.programs[k] = this.link(fs);
        }

        restore() {
            if (this.destroyed || this.failed || !this.lost || !this.gl) return;
            if (this.gl.isContextLost()) return;
            this.lost = false;
            try {
                this.setupGl();
            } catch (err) {
                this.fail(`Shader compile failed: ${err.message}`);
                return;
            }
            this.resetGuard();
            if (!this.active) return;
            this.resize();
            this.renderOnce();
            if (this.resumeOnRestore && !this.video.paused) this.start();
            this.resumeOnRestore = false;
        }

        makeTexture() {
            const gl = this.gl;
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        }

        link(fsSource) {
            const gl = this.gl;
            const shaders = [];
            const p = gl.createProgram();
            const sh = (type, src) => {
                const s = gl.createShader(type);
                shaders.push(s);
                gl.shaderSource(s, src);
                gl.compileShader(s);
                if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'compile error');
                return s;
            };
            try {
                gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
                gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSource));
                gl.bindAttribLocation(p, 0, 'aPos');
                gl.linkProgram(p);
                if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link error');
            } catch (err) {
                // Do not leak the half-built program on a compile/link failure.
                this.deleteProgram({ p, shaders });
                throw err;
            }
            const u = n => gl.getUniformLocation(p, n);
            return { p, shaders, uTex: u('uTex'), uIn: u('uInSize'), uOut: u('uOutSize'), uStr: u('uStrength'), uFrame: u('uFrame'), uFbo: u('uFbo') };
        }

        /** Detaches and deletes a program's shaders, then the program itself. */
        deleteProgram(prog) {
            const gl = this.gl;
            if (!gl || !prog) return;
            const attached = (prog.p && !gl.isContextLost() && gl.getAttachedShaders(prog.p)) || [];
            for (const s of prog.shaders || []) {
                if (!s) continue;
                if (attached.includes(s)) gl.detachShader(prog.p, s);
                gl.deleteShader(s);
            }
            if (prog.p) gl.deleteProgram(prog.p);
        }

        fail(reason) {
            this.failed = true;
            this.stop();
            this.canvas.hidden = true;
            if (this.hooks.onUnavailable) this.hooks.onUnavailable(reason);
        }

        /** Applies settings; returns true if the GPU path is now active. */
        configure({ preset, strength, maxRenderRes }) {
            if (typeof strength === 'number') this.strength = Math.min(1, Math.max(0, strength / 100));
            if (typeof maxRenderRes === 'number' && maxRenderRes > 0) this.maxRenderRes = maxRenderRes;
            const next = PRESETS.includes(preset) ? preset : 'off';
            if (next !== 'off' && !this.init()) { this.preset = 'off'; return false; }
            const wasActive = this.active;
            this.preset = next;
            // Stay hidden (the <video> shows through) until a real frame has been drawn: no black flash.
            if (!this.active) { this.canvas.hidden = true; this.drawn = false; } else if (!wasActive) this.drawn = false;
            this.canvas.hidden = !this.active || !this.drawn;
            this.resetGuard();
            // (While the context is lost nothing runs, and stop() would drop the resume intent.)
            if (this.active) { this.resize(); this.renderOnce(); } else if (!this.lost) this.stop();
            return this.active;
        }

        /** Places the canvas over the video's content box (object-fit aware) and sizes the buffer. */
        layout(boxW, boxH, fit) {
            const vw = this.video.videoWidth || 16;
            const vh = this.video.videoHeight || 9;
            let w = boxW;
            let h = boxH;
            if (fit === 'contain' || fit === 'cover') {
                const s = fit === 'contain' ? Math.min(boxW / vw, boxH / vh) : Math.max(boxW / vw, boxH / vh);
                w = vw * s;
                h = vh * s;
            }
            this.contentRect = { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
            const st = this.canvas.style;
            st.left = `${this.contentRect.x}px`;
            st.top = `${this.contentRect.y}px`;
            st.width = `${w}px`;
            st.height = `${h}px`;
            if (this.active) { this.resize(); this.renderOnce(); }
        }

        resize() {
            const dpr = Math.min(3, window.devicePixelRatio || 1);
            let w = Math.max(2, Math.round(this.contentRect.w * dpr));
            let h = Math.max(2, Math.round(this.contentRect.h * dpr));
            const cap = this.maxRenderRes;
            if (h > cap) { w = Math.round(w * cap / h); h = cap; }
            // Never render below the source: sharpening at a lower resolution wastes detail.
            const vw = this.video.videoWidth;
            const vh = this.video.videoHeight;
            if (vh && h < vh && this.preset === 'cas') { w = Math.round(w * vh / h); h = vh; }
            if (this.canvas.width !== w || this.canvas.height !== h) {
                this.canvas.width = w;
                this.canvas.height = h;
                // The intermediate target is reallocated lazily by ensureFbo() (it compares sizes and
                // deletes the old framebuffer + texture). Nulling it here used to leak both on resize.
            }
            void vw;
        }

        ensureFbo(w, h) {
            const gl = this.gl;
            if (this.fbo && this.fbo.w === w && this.fbo.h === h) return this.fbo;
            if (this.fbo) { gl.deleteFramebuffer(this.fbo.fb); gl.deleteTexture(this.fbo.tex); }
            const tex = this.makeTexture();
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            const fb = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            this.fbo = { fb, tex, w, h };
            return this.fbo;
        }

        pass(prog, tex, inW, inH, target, outW, outH) {
            const gl = this.gl;
            gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
            gl.viewport(0, 0, outW, outH);
            gl.useProgram(prog.p);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.uniform1i(prog.uTex, 0);
            gl.uniform2f(prog.uIn, inW, inH);
            gl.uniform2f(prog.uOut, outW, outH);
            gl.uniform1f(prog.uStr, this.strength);
            gl.uniform1f(prog.uFbo, tex === this.videoTex ? 0 : 1);
            if (prog.uFrame) gl.uniform1f(prog.uFrame, this.frame % 1000);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }

        /** Uploads the current video frame and runs the preset's passes. */
        draw() {
            if (!this.active) return;
            const v = this.video;
            const vw = v.videoWidth;
            const vh = v.videoHeight;
            if (!vw || !vh || v.readyState < 2) return;
            const gl = this.gl;
            const W = this.canvas.width;
            const H = this.canvas.height;
            gl.bindVertexArray(this.vao);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
            try {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
            } catch (err) {
                // A cross-origin file without CORS taints the frame: WebGL may not read it.
                this.fail(err && err.name === 'SecurityError' ? 'This video comes from another site without CORS, so the GPU may not read its pixels' : `Frame upload failed: ${err && err.message}`);
                return;
            }
            const P = this.programs;
            this.frame++;
            switch (this.preset) {
                case 'cas':
                    this.pass(P.cas, this.videoTex, vw, vh, null, W, H);
                    break;
                case 'deband':
                    this.pass(P.deband, this.videoTex, vw, vh, null, W, H);
                    break;
                case 'fsr':
                case 'anime4k': {
                    // Displayed at or below the source size there is nothing to upscale: one
                    // sharpening/line pass straight from the video (half the GPU work, no resampling).
                    if (W <= vw * 1.05 && H <= vh * 1.05) {
                        this.pass(this.preset === 'fsr' ? P.cas : P.a4k, this.videoTex, vw, vh, null, W, H);
                        break;
                    }
                    const up = this.ensureFbo(W, H);
                    this.pass(P.lanczos, this.videoTex, vw, vh, up, W, H);
                    this.pass(this.preset === 'fsr' ? P.rcas : P.a4k, up.tex, W, H, null, W, H);
                    break;
                }
                default:
                    break;
            }
            if (!this.drawn) { this.drawn = true; this.canvas.hidden = false; }
        }

        renderOnce() {
            if (!this.active) return;
            this.draw();
        }

        start() {
            // While the context is lost, remember the caller's intent (play / pause / audio-only
            // toggles keep arriving) and honour it on restore.
            if (this.lost) { this.resumeOnRestore = true; return; }
            if (this.running || !this.active) return;
            this.running = true;
            this.resetGuard();
            this.schedule();
        }

        stop() {
            if (this.lost) this.resumeOnRestore = false;
            this.running = false;
            if (this.handle) {
                if (this.rvfc) { try { this.video.cancelVideoFrameCallback(this.handle); } catch (_) { /* ignore */ } } else cancelAnimationFrame(this.handle);
            }
            this.handle = 0;
        }

        schedule() {
            if (!this.running) return;
            this.handle = this.rvfc ? this.video.requestVideoFrameCallback(this.boundRender) : requestAnimationFrame(this.boundRender);
        }

        onFrame() {
            this.handle = 0;
            if (!this.running || !this.active) return;
            if (this.video.paused || document.hidden) { this.running = false; return; }
            const t0 = performance.now();
            const q = this.beginQuery();
            this.draw();
            this.endQuery(q);
            this.watch(performance.now() - t0);
            this.schedule();
        }

        // ---- thermal guard -------------------------------------------------------
        /** warm: discard the next 3 s window (decoder warm-up, seeks and preset switches drop frames). */
        resetGuard(warm = true) {
            const q = this.video.getVideoPlaybackQuality ? this.video.getVideoPlaybackQuality() : null;
            this.guard = { start: performance.now(), frames: 0, cpu: 0, gpu: 0, gpuN: 0, dropped0: q ? q.droppedVideoFrames : 0, total0: q ? q.totalVideoFrames : 0, strikes: 0, warm };
        }

        beginQuery() {
            const ext = this.timerExt;
            if (!ext || this.pendingQuery) return null;
            const gl = this.gl;
            const q = gl.createQuery();
            gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
            return q;
        }

        endQuery(q) {
            if (!q) { this.pollQuery(); return; }
            this.gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
            this.pendingQuery = q;
        }

        pollQuery() {
            const q = this.pendingQuery;
            if (!q) return;
            const gl = this.gl;
            if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return;
            if (!gl.getParameter(this.timerExt.GPU_DISJOINT_EXT)) {
                this.guard.gpu += gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
                this.guard.gpuN++;
            }
            gl.deleteQuery(q);
            this.pendingQuery = null;
        }

        watch(cpuMs) {
            const g = this.guard;
            g.frames++;
            g.cpu += cpuMs;
            const elapsed = performance.now() - g.start;
            if (elapsed < 3000) return;
            if (g.warm) { this.resetGuard(false); return; }
            const q = this.video.getVideoPlaybackQuality ? this.video.getVideoPlaybackQuality() : null;
            const dropped = q ? q.droppedVideoFrames - g.dropped0 : 0;
            const total = q ? Math.max(1, q.totalVideoFrames - g.total0) : 1;
            const frameMs = g.gpuN ? g.gpu / g.gpuN : g.cpu / Math.max(1, g.frames);
            const dropRatio = dropped / total;
            const overloaded = frameMs > 14 || (dropped > 6 && dropRatio > 0.08);
            const strikes = overloaded ? (g.strikes || 0) + 1 : 0;
            this.resetGuard(false);
            this.guard.strikes = strikes;
            // Two overloaded windows in a row (6 s) before stepping down: no reaction to one spike.
            if (strikes >= 2 && STEP_DOWN[this.preset] !== undefined) {
                const from = this.preset;
                const to = STEP_DOWN[from];
                const reason = frameMs > 14 ? `${frameMs.toFixed(1)} ms per frame` : `${dropped} dropped frames`;
                this.configure({ preset: to });
                if (this.hooks.onStepDown) this.hooks.onStepDown(to, reason, from);
            }
        }

        /** Frees every GPU object and loses the context. Idempotent; safe before init() or after a context loss. */
        destroy() {
            this.stop();
            if (this.destroyed) return;
            this.destroyed = true;
            this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
            this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
            const gl = this.gl;
            if (gl) {
                // On a lost context the objects are already gone and delete* calls are no-ops.
                if (!gl.isContextLost()) {
                    try {
                        gl.bindVertexArray(null);
                        gl.bindBuffer(gl.ARRAY_BUFFER, null);
                        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                        gl.bindTexture(gl.TEXTURE_2D, null);
                        gl.useProgram(null);
                        if (this.pendingQuery) gl.deleteQuery(this.pendingQuery);
                        if (this.videoTex) gl.deleteTexture(this.videoTex);
                        if (this.fbo) { gl.deleteFramebuffer(this.fbo.fb); gl.deleteTexture(this.fbo.tex); }
                        for (const prog of Object.values(this.programs)) this.deleteProgram(prog);
                        if (this.vao) gl.deleteVertexArray(this.vao);
                        if (this.vbo) gl.deleteBuffer(this.vbo);
                    } catch (_) { /* best effort: the context is lost next anyway */ }
                }
                const lose = gl.getExtension('WEBGL_lose_context');
                if (lose && !gl.isContextLost()) lose.loseContext();
            }
            this.pendingQuery = null;
            this.videoTex = null;
            this.fbo = null;
            this.programs = {};
            this.vao = null;
            this.vbo = null;
            this.timerExt = null;
            this.gl = null;
        }
    }

    window.VelostreamShaders = Object.freeze({ VideoShaderPipeline, PRESETS, isSupported });
})();
