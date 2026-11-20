/**
 * Velostream - GPU video shader pipeline (WebGL2), runs in the player extension page.
 *
 * Draws the <video> through WebGL2 into a <canvas> laid exactly over it:
 *   cas        - Contrast Adaptive Sharpening (1 pass, replaces the CPU SVG convolution)
 *   anime4k    - Anime4K v4 CNN Restore (S) + Upscale x2 (S), from player/anime4k.js; falls back
 *                to Anime4K-lite (Lanczos-2 + gradient "push") without float render targets
 *   anime4k-hq - Anime4K v4 CNN Restore (M) + Upscale x2 (M), same fallback
 *   deblock    - removes 8x8 block edges on the source pixel grid, then a light CAS (2 passes)
 * plus optional colour grading (gamma, vibrance, temperature, tint, shadows, highlights) as one
 * final pass; with preset 'off' and non-neutral colour the pipeline runs colour-only.
 *
 * Orientation: the <video> texture has the top of the picture at v = 0; a texture rendered by an
 * earlier pass has it at v = 1 (GL framebuffer origin is bottom-left). The vertex shader's uFbo
 * uniform picks the mapping per pass so every pass, and the canvas, stay upright.
 *
 * The canvas is sized min(maxRenderRes, displayed size x devicePixelRatio). Frames are driven by
 * requestVideoFrameCallback (falls back to requestAnimationFrame), so nothing runs while the
 * video is paused, hidden or audio-only; seeks and setting changes render one frame on demand.
 * A thermal guard steps the preset down (STEP_DOWN) when the GPU cannot keep up; colour grading
 * is cheap and is never stepped down.
 *
 * Exposes window.VelostreamShaders = { VideoShaderPipeline, PRESETS, COLOR_NEUTRAL, STEP_DOWN,
 * isSupported }. Load player/anime4k.js (window.VelostreamAnime4K) before this file for the CNN
 * presets; without it they use Anime4K-lite.
 */
(function () {
    'use strict';

    const PRESETS = ['off', 'cas', 'deblock', 'anime4k', 'anime4k-hq'];
    const STEP_DOWN = Object.freeze({ 'anime4k-hq': 'anime4k', anime4k: 'cas', cas: 'off', deblock: 'cas' });

    /** Neutral colour grading values (configure({ color }) units). */
    const COLOR_NEUTRAL = Object.freeze({ gamma: 1, vibrance: 0, temperature: 0, tint: 0, shadows: 0, highlights: 0 });
    const COLOR_RANGE = { gamma: [0.5, 2], vibrance: [-100, 100], temperature: [-100, 100], tint: [-100, 100], shadows: [-100, 100], highlights: [-100, 100] };

    /** Missing / invalid keys are neutral; values are clamped to their range. */
    function normalizeColor(c) {
        const out = Object.assign({}, COLOR_NEUTRAL);
        if (!c || typeof c !== 'object') return out;
        for (const k of Object.keys(COLOR_NEUTRAL)) {
            if (c[k] === undefined || c[k] === null) continue;
            const v = Number(c[k]);
            if (Number.isFinite(v)) out[k] = Math.min(COLOR_RANGE[k][1], Math.max(COLOR_RANGE[k][0], v));
        }
        return out;
    }

    function colorIsNeutral(c) {
        return Math.abs(c.gamma - 1) < 0.005 && ['vibrance', 'temperature', 'tint', 'shadows', 'highlights'].every(k => Math.abs(c[k]) < 0.5);
    }

    const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
// Video textures are uploaded top row first (v = 0 is the top of the picture), while a texture
// rendered by an earlier pass stores the top of the picture at v = 1 (GL framebuffer origin is
// bottom-left). uFbo selects the matching mapping so every pass keeps the picture upright.
// (With uFbo = 0, vUv is the picture coordinate: (0,0) top-left, +y down - the Anime4K passes use that.)
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
    float peak = -0.22 * uStrength;
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

    // Anime4K-lite (fallback for the CNN presets): push each pixel toward the brighter side of
    // strong luma gradients, which thins and straightens dark line art after upscaling, then
    // lightly re-darkens the lines.
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

    // Deblock, pass 1 of 2 (source size, reads the <video> texture, so texel row 0 is the top of
    // the picture). H.264 / VP9 code 8x8 (and 16x16) transform blocks whose edges lie on multiples
    // of 8 in the SOURCE pixel grid. For the 3 pixels on each side of such an edge: when the step
    // across it is small (a coding artefact, not a real edge) and both sides are flat, spread the
    // step linearly over those 6 pixels, much like H.264's in-loop filter.
    const FS_DEBLOCK = HEADER + `
vec3 T(ivec2 p) { return texelFetch(uTex, clamp(p, ivec2(0), ivec2(uInSize) - 1), 0).rgb; }
vec3 fixEdge(ivec2 p, ivec2 dir, int x, int size) {
    int m = x % 8;
    int k;       // distance from the block boundary (0 = touching it)
    int b;       // index of the last pixel before the boundary (p0)
    float side;  // +1 before the boundary, -1 after it
    if (m >= 5) { k = 7 - m; b = x + k; side = 1.0; }
    else if (m <= 2) { k = m; b = x - k - 1; side = -1.0; }
    else return vec3(0.0);
    if (b < 2 || b + 3 >= size) return vec3(0.0);
    ivec2 o = p + dir * (b - x);
    vec3 p2 = T(o - 2 * dir);
    vec3 p1 = T(o - dir);
    vec3 p0 = T(o);
    vec3 q0 = T(o + dir);
    vec3 q1 = T(o + 2 * dir);
    vec3 q2 = T(o + 3 * dir);
    float jump = abs(luma(q0) - luma(p0));
    float flatness = max(max(abs(luma(p1) - luma(p0)), abs(luma(p2) - luma(p1))),
                         max(abs(luma(q1) - luma(q0)), abs(luma(q2) - luma(q1))));
    float alpha = mix(0.04, 0.18, uStrength);   // larger steps are real edges: keep them
    float beta = mix(0.008, 0.024, uStrength);  // in-block variation allowed on each side
    float w = (1.0 - smoothstep(alpha * 0.5, alpha, jump))
            * (1.0 - smoothstep(beta, beta * 2.0, flatness))
            * smoothstep(flatness, flatness * 2.0 + 0.004, jump);
    return (q0 - p0) * (side * float(3 - k) / 7.0 * w);
}
void main() {
    ivec2 p = ivec2(floor(vUv * uInSize));
    ivec2 size = ivec2(uInSize);
    vec3 c = T(p) + fixEdge(p, ivec2(1, 0), p.x, size.x) + fixEdge(p, ivec2(0, 1), p.y, size.y);
    outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

    // Colour grading (final pass): white balance, shadows / highlights, gamma, vibrance.
    const FS_COLOR = HEADER + `
uniform vec4 uColorA;  // gamma (0.5..2), vibrance, temperature, tint (-1..1)
uniform vec2 uColorB;  // shadows, highlights (-1..1)
void main() {
    vec3 c = texture(uTex, vUv).rgb;
    float t = uColorA.z;
    float m = uColorA.w;
    // temperature > 0 warmer (more red, less blue), tint > 0 magenta (less green); luma-neutral
    vec3 gain = vec3(1.0 + 0.12 * t + 0.04 * m, 1.0 - 0.08 * m, 1.0 - 0.12 * t + 0.04 * m);
    c *= gain / dot(gain, vec3(0.299, 0.587, 0.114));
    // shadows / highlights: tone curve bumps that keep black and white points (peak at 1/3, 2/3)
    float l = clamp(luma(c), 0.0, 1.0);
    c += 0.9 * (uColorB.x * l * (1.0 - l) * (1.0 - l) + uColorB.y * l * l * (1.0 - l));
    // gamma > 1 brightens the mid-tones
    c = pow(max(c, vec3(0.0)), vec3(1.0 / uColorA.x));
    // vibrance: saturate the dull colours more than the already-saturated ones
    float v = uColorA.y;
    float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    float k = v >= 0.0 ? 1.0 + v * (1.0 - clamp(sat, 0.0, 1.0)) : 1.0 + v;
    c = mix(vec3(luma(c)), c, k);
    outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

    // Plain bilinear blit (used to present an intermediate texture).
    const FS_COPY = HEADER + `
void main() { outColor = vec4(texture(uTex, vUv).rgb, 1.0); }`;

    const BUILTIN = { cas: FS_CAS, lanczos: FS_LANCZOS, a4k: FS_A4K, copy: FS_COPY, deblock: FS_DEBLOCK, color: FS_COLOR };

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
         * @param {{onStepDown?:(preset:string, reason:string, from:string)=>void, onUnavailable?:(reason:string)=>void}} hooks
         */
        constructor(video, canvas, hooks = {}) {
            this.video = video;
            this.canvas = canvas;
            this.hooks = hooks;
            this.preset = 'off';
            this.strength = 0.5;
            this.color = Object.assign({}, COLOR_NEUTRAL);
            this.maxRenderRes = 2160;
            this.gl = null;
            this.programs = {};
            this.targets = new Map();   // name -> { fb, tex, w, h, float, used }
            this.a4k = {};              // shader chain id -> { status, list, progs, error }
            this.a4kPlanCache = null;
            this.a4kTimer = 0;
            this.floatRT = false;
            this.parallelExt = null;
            /** What the last draw actually ran, e.g. "anime4k CNN (restore + upscale x2) + colour". */
            this.path = '';
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

        /** True when colour grading is not neutral (the pipeline then runs even with preset 'off'). */
        get colorOn() { return !colorIsNeutral(this.color); }

        get active() { return (this.preset !== 'off' || this.colorOn) && !this.failed && !this.lost && !!this.gl; }

        init() {
            // After destroy() the canvas' context has been lost on purpose; getContext() would hand
            // back that same dead context, so a destroyed pipeline never re-initialises.
            if (this.destroyed) return false;
            if (this.gl || this.failed) return !!this.gl;
            const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'default' });
            // (No `desynchronized`: low-latency canvases bypass the compositor and can tear/flicker.)
            if (!gl) { this.fail('WebGL2 is not available'); return false; }
            // A canvas whose context was lost (e.g. by an earlier pipeline's destroy()) keeps returning
            // that dead context: report it plainly instead of a misleading "Shader compile failed".
            if (gl.isContextLost()) { this.fail('GPU context lost'); return false; }
            this.gl = gl;
            this.textureLimit = 0;
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
            this.targets = new Map();
            this.a4k = {};
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
            this.uploadWidth = this.uploadHeight = 0;
            this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
            this.parallelExt = gl.getExtension('KHR_parallel_shader_compile');
            this.floatRT = this.probeFloatTargets();
            for (const [k, fs] of Object.entries(BUILTIN)) this.programs[k] = this.link(fs);
        }

        /** Whether RGBA16F textures can be rendered to (needed by the Anime4K CNN passes). */
        probeFloatTargets() {
            const gl = this.gl;
            if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return false;
            const tex = this.makeTexture();
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
            const fb = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(fb);
            gl.deleteTexture(tex);
            gl.getError(); // a driver that rejects the format must not leave an error behind
            return ok;
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

        /** Compiles and links without waiting (KHR_parallel_shader_compile can finish it in the background). */
        startProgram(fsSource) {
            const gl = this.gl;
            const p = gl.createProgram();
            const shaders = [];
            for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fsSource]]) {
                const s = gl.createShader(type);
                shaders.push(s);
                gl.shaderSource(s, src);
                gl.compileShader(s);
                gl.attachShader(p, s);
            }
            gl.bindAttribLocation(p, 0, 'aPos');
            gl.linkProgram(p);
            return { p, shaders };
        }

        /** Checks a started program (throws with the compile/link log) and looks up its uniforms. */
        finishProgram(h, binds = []) {
            const gl = this.gl;
            if (!gl.getProgramParameter(h.p, gl.LINK_STATUS)) {
                const log = h.shaders.map(s => (gl.getShaderParameter(s, gl.COMPILE_STATUS) ? '' : gl.getShaderInfoLog(s))).filter(Boolean).join('\n')
                    || gl.getProgramInfoLog(h.p) || 'link error';
                // Do not leak the half-built program on a compile/link failure.
                this.deleteProgram(h);
                throw new Error(log);
            }
            const p = h.p;
            const u = n => gl.getUniformLocation(p, n);
            return {
                p, shaders: h.shaders, uTex: u('uTex'), uIn: u('uInSize'), uOut: u('uOutSize'), uStr: u('uStrength'), uFrame: u('uFrame'), uFbo: u('uFbo'),
                uColorA: u('uColorA'), uColorB: u('uColorB'),
                binds: binds.map(n => ({ raw: u(`${n}_raw`), size: u(`${n}_size`), pt: u(`${n}_pt`), flip: u(`${n}_flip`) }))
            };
        }

        link(fsSource) { return this.finishProgram(this.startProgram(fsSource)); }

        /** Detaches and deletes a program's shaders, then the program itself. Safe to call twice. */
        deleteProgram(prog) {
            const gl = this.gl;
            if (!gl || !prog || prog.deleted) return;
            prog.deleted = true;
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

        /**
         * Applies settings; returns true if the GPU path is now active.
         * @param {{preset?:string, strength?:number, maxRenderRes?:number,
         *   color?:{gamma?:number, vibrance?:number, temperature?:number, tint?:number, shadows?:number, highlights?:number}|null}} opts
         *   color: replaces the grading (missing keys neutral); leave it out to keep the current one.
         */
        configure({ preset, strength, maxRenderRes, color } = {}) {
            if (Number.isFinite(strength)) this.strength = Math.min(1, Math.max(0, strength / 100));
            if (typeof maxRenderRes === 'number' && maxRenderRes > 0) this.maxRenderRes = maxRenderRes;
            if (color !== undefined) this.color = normalizeColor(color);
            let next = PRESETS.includes(preset) ? preset : this.preset;
            if (this.strength === 0 && (next === 'cas' || next === 'deblock')) next = 'off';
            if ((next !== 'off' || this.colorOn) && !this.init()) { this.preset = 'off'; return false; }
            const wasActive = this.active;
            this.preset = next;
            // Stay hidden (the <video> shows through) until a real frame has been drawn: no black flash.
            if (!this.active) { this.canvas.hidden = true; this.drawn = false; } else if (!wasActive) this.drawn = false;
            this.canvas.hidden = !this.active || !this.drawn;
            this.resetGuard();
            // (While the context is lost nothing runs, and stop() would drop the resume intent.)
            if (this.active) { this.resize(); this.renderOnce(); } else if (!this.lost) { this.stop(); this.releaseTargets(); }
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
            const sourceHeight = this.preset === 'cas' ? this.video.videoHeight : 0;
            const textureLimit = this.textureLimit || (this.textureLimit = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE));
            const targetHeight = Math.min(Math.max(h, sourceHeight), this.maxRenderRes, textureLimit, textureLimit * h / w);
            w = Math.max(2, Math.round(w * targetHeight / h));
            h = Math.max(2, Math.round(targetHeight));
            if (this.canvas.width !== w || this.canvas.height !== h) {
                this.canvas.width = w;
                this.canvas.height = h;
                // Intermediate targets are reallocated lazily by target() (it compares sizes and
                // deletes the old framebuffer + texture); ones a frame no longer uses are freed by
                // sweepTargets() after that frame.
            }
        }

        // ---- render targets --------------------------------------------------------
        /** A named framebuffer + texture of the given size/format, (re)allocated on demand. */
        target(name, w, h, float) {
            const gl = this.gl;
            let t = this.targets.get(name);
            if (t && (t.w !== w || t.h !== h || t.float !== float)) { this.freeTarget(t); t = null; }
            if (!t) {
                const tex = this.makeTexture();
                if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
                else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                const fb = gl.createFramebuffer();
                gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                t = { fb, tex, w, h, float, used: 0 };
                this.targets.set(name, t);
            }
            t.used = this.frame;
            return t;
        }

        freeTarget(t) {
            const gl = this.gl;
            if (!gl || gl.isContextLost()) return;
            gl.deleteFramebuffer(t.fb);
            gl.deleteTexture(t.tex);
        }

        /** Frees targets the last frame did not use (preset switch, resize, upscale on/off). */
        sweepTargets() {
            for (const [k, t] of this.targets) {
                if (t.used !== this.frame) { this.freeTarget(t); this.targets.delete(k); }
            }
        }

        releaseTargets() {
            for (const t of this.targets.values()) this.freeTarget(t);
            this.targets.clear();
        }

        pass(prog, tex, inW, inH, target, outW, outH, strength = this.strength) {
            const gl = this.gl;
            gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
            gl.viewport(0, 0, outW, outH);
            gl.useProgram(prog.p);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.uniform1i(prog.uTex, 0);
            gl.uniform2f(prog.uIn, inW, inH);
            gl.uniform2f(prog.uOut, outW, outH);
            gl.uniform1f(prog.uStr, strength);
            gl.uniform1f(prog.uFbo, tex === this.videoTex ? 0 : 1);
            if (prog.uFrame) gl.uniform1f(prog.uFrame, this.frame % 1000);
            if (prog.uColorA) {
                const c = this.color;
                gl.uniform4f(prog.uColorA, c.gamma, c.vibrance / 100, c.temperature / 100, c.tint / 100);
                gl.uniform2f(prog.uColorB, c.shadows / 100, c.highlights / 100);
            }
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }

        /** Uploads the current video frame and runs the preset's passes (+ the colour pass). */
        draw() {
            if (!this.active) return;
            try { this.drawFrame(); }
            catch (err) { this.fail(`Could not render the graphics effect: ${err.message}`); }
        }

        drawFrame() {
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
                if (this.uploadWidth === vw && this.uploadHeight === vh) {
                    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, v);
                } else {
                    if (vw > this.textureLimit || vh > this.textureLimit) throw new Error('Video exceeds the GPU texture size limit');
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
                    this.uploadWidth = vw;
                    this.uploadHeight = vh;
                }
            } catch (err) {
                // A cross-origin file without CORS taints the frame: WebGL may not read it.
                this.fail(err && err.name === 'SecurityError' ? 'This video comes from another site without CORS, so the GPU may not read its pixels' : `Frame upload failed: ${err && err.message}`);
                return;
            }
            this.frame++;
            const grade = this.colorOn;
            // The preset renders straight to the canvas, or into a W x H target the colour pass reads.
            const out = grade && this.preset !== 'off' ? this.target('grade', W, H, this.floatRT) : null;
            let path = this.renderPreset(vw, vh, W, H, out);
            if (grade) {
                if (out) this.pass(this.programs.color, out.tex, W, H, null, W, H);
                else this.pass(this.programs.color, this.videoTex, vw, vh, null, W, H);
                path = path ? `${path} + colour` : 'colour only';
            }
            this.path = path;
            this.sweepTargets();
            if (!this.drawn) { this.drawn = true; this.canvas.hidden = false; }
        }

        /** Runs the preset into `out` (null = canvas); returns a short description of the path. */
        renderPreset(vw, vh, W, H, out) {
            const P = this.programs;
            const video = this.videoTex;
            switch (this.preset) {
                case 'cas':
                    this.pass(P.cas, video, vw, vh, out, W, H);
                    return 'cas';
                case 'deblock': {
                    const src = this.target('src', vw, vh, false);
                    this.pass(P.deblock, video, vw, vh, src, vw, vh);
                    this.pass(P.cas, src.tex, vw, vh, out, W, H, 0.45 * this.strength);
                    return 'deblock';
                }
                case 'anime4k':
                case 'anime4k-hq':
                    return this.drawAnime4K(vw, vh, W, H, out);
                default:
                    return '';
            }
        }

        // ---- Anime4K CNN -----------------------------------------------------------
        /** The Anime4K shader files the current preset runs (VelostreamAnime4K.CHAINS). */
        a4kChain() { return window.VelostreamAnime4K.CHAINS[this.preset]; }

        /** The chain's compiled pass programs, or null while compiling / when unavailable. */
        a4kPrograms(chain) {
            const A = window.VelostreamAnime4K;
            if (!A || !this.floatRT) return null;
            const id = chain.join('+');
            let e = this.a4k[id];
            if (!e) {
                // Compiled on first use only: the CNN shaders are large and most sessions never need them.
                e = this.a4k[id] = { status: 'compiling', list: [], progs: null, error: '' };
                try {
                    for (const p of A.passes(chain)) e.list.push({ key: p.key, binds: p.binds, h: this.startProgram(p.source) });
                } catch (err) {
                    this.a4kFailed(e, err);
                }
            }
            if (e.status !== 'compiling') return e.progs;
            const gl = this.gl;
            const ext = this.parallelExt;
            if (ext && !e.list.every(x => gl.getProgramParameter(x.h.p, ext.COMPLETION_STATUS_KHR))) {
                this.pollA4k();
                return null;
            }
            try {
                const progs = {};
                for (const x of e.list) progs[x.key] = this.finishProgram(x.h, x.binds);
                e.progs = progs;
                e.status = 'ready';
            } catch (err) {
                this.a4kFailed(e, err);
            }
            return e.progs;
        }

        a4kFailed(e, err) {
            for (const x of e.list) this.deleteProgram(x.h);
            e.list = [];
            e.progs = null;
            e.status = 'failed';
            e.error = (err && err.message) || String(err);
            console.warn('[Velostream] Anime4K CNN unavailable, using Anime4K-lite:', e.error);
        }

        /** While shaders compile in the background and no frame loop runs, re-render when ready. */
        pollA4k() {
            if (this.a4kTimer || this.running) return;
            this.a4kTimer = setTimeout(() => {
                this.a4kTimer = 0;
                if (this.active && !this.running) this.renderOnce();
            }, 50);
        }

        freeA4k() {
            for (const e of Object.values(this.a4k)) for (const x of e.list) this.deleteProgram(x.h);
            this.a4k = {};
        }

        drawAnime4K(vw, vh, W, H, out) {
            const chain = window.VelostreamAnime4K ? this.a4kChain() : null;
            const progs = chain && this.a4kPrograms(chain);
            if (!progs) {
                const e = chain && this.a4k[chain.join('+')];
                const why = !chain ? 'anime4k.js not loaded' : !this.floatRT ? 'no float render targets'
                    : e && e.status === 'failed' ? 'shader error' : 'compiling';
                this.drawA4kLite(vw, vh, W, H, out);
                return `anime4k-lite (${why})`;
            }
            const key = `${chain.join('+')}|${vw}x${vh}|${W}x${H}`;
            if (!this.a4kPlanCache || this.a4kPlanCache.key !== key) this.a4kPlanCache = { key, plan: window.VelostreamAnime4K.plan(chain, vw, vh, W, H) };
            const plan = this.a4kPlanCache.plan;
            const gl = this.gl;
            const slot = i => this.target(`a4k${i}`, plan.slots[i].w, plan.slots[i].h, true);
            for (const s of plan.steps) {
                const prog = progs[s.key];
                const t = slot(s.out);
                gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
                gl.viewport(0, 0, s.w, s.h);
                gl.useProgram(prog.p);
                gl.uniform1f(prog.uFbo, 0); // vUv = picture coordinate, (0,0) top-left as in mpv
                s.binds.forEach((b, i) => {
                    const loc = prog.binds[i];
                    const src = b.slot < 0 ? null : slot(b.slot);
                    const w = src ? src.w : vw;
                    const h = src ? src.h : vh;
                    gl.activeTexture(gl.TEXTURE0 + i);
                    gl.bindTexture(gl.TEXTURE_2D, src ? src.tex : this.videoTex);
                    gl.uniform1i(loc.raw, i);
                    gl.uniform2f(loc.size, w, h);
                    gl.uniform2f(loc.pt, 1 / w, 1 / h);
                    gl.uniform1f(loc.flip, src ? 1 : 0);
                });
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            }
            gl.activeTexture(gl.TEXTURE0);
            // Present: Lanczos-2 from the network's output (source size, or 2x) to the display size.
            const res = plan.result < 0 ? null : slot(plan.result);
            this.pass(this.programs.lanczos, res ? res.tex : this.videoTex, plan.resultW, plan.resultH, out, W, H);
            return `${this.preset} CNN (${plan.upscaled ? 'restore + upscale x2' : 'restore'})`;
        }

        /** Anime4K-lite: Lanczos-2 upscale + gradient push (no float targets needed). */
        drawA4kLite(vw, vh, W, H, out) {
            const P = this.programs;
            if (W <= vw * 1.05 && H <= vh * 1.05) {
                this.pass(P.a4k, this.videoTex, vw, vh, out, W, H);
                return;
            }
            const up = this.target('up', W, H, false);
            this.pass(P.lanczos, this.videoTex, vw, vh, up, W, H);
            this.pass(P.a4k, up.tex, W, H, out, W, H);
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
            if (!this.active) return;
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
            // 'off' has no entry: colour-only mode is never stepped down (it is one cheap pass).
            if (strikes >= 2 && STEP_DOWN[this.preset] !== undefined) {
                const from = this.preset;
                const to = STEP_DOWN[from];
                const reason = frameMs > 14 ? `${frameMs.toFixed(1)} ms per frame` : `${dropped} dropped frames`;
                this.configure({ preset: to }); // (colour grading is kept)
                if (this.hooks.onStepDown) this.hooks.onStepDown(to, reason, from);
            }
        }

        /** Frees every GPU object and loses the context. Idempotent; safe before init() or after a context loss. */
        destroy() {
            this.stop();
            if (this.a4kTimer) { clearTimeout(this.a4kTimer); this.a4kTimer = 0; }
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
                        this.releaseTargets();
                        this.freeA4k();
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
            this.targets = new Map();
            this.a4k = {};
            this.programs = {};
            this.vao = null;
            this.vbo = null;
            this.timerExt = null;
            this.gl = null;
        }
    }

    window.VelostreamShaders = Object.freeze({ VideoShaderPipeline, PRESETS, COLOR_NEUTRAL, STEP_DOWN, isSupported });
})();
