import '../common/shared.js';

const { DEEP_SETTINGS, normalizeGraphicsPreset } = globalThis.VelostreamShared;

export const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
export const cloneValue = v => (Array.isArray(v) ? v.slice() : isPlainObject(v) ? { ...v } : v);
export const sameValue = (a, b) => a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
export const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

/** Copy whose sub-objects (and their arrays, e.g. audio.eq) are not shared with the source. */
export function cloneSettings(s) {
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
export function overlaySettings(target, partial, only) {
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
export function profileFields(p) {
    const out = {};
    if (!p) return out;
    if (Number.isFinite(p.defaultSpeed)) out.defaultSpeed = p.defaultSpeed;
    if (Number.isFinite(p.qualityCap)) out.qualityCap = p.qualityCap;
    if (typeof p.shader === 'string') out.shader = normalizeGraphicsPreset(p.shader);
    if (Number.isFinite(p.shaderStrength)) out.shaderStrength = p.shaderStrength;
    if (typeof p.audioPreset === 'string') out.audio = { preset: p.audioPreset };
    if (Number.isFinite(p.subSize)) out.subtitles = { size: p.subSize };
    return out;
}
