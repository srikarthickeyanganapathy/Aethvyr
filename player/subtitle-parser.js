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

/** @returns {Array<{start: number, end: number, text: string}>} Cues in media seconds. */
export function parseSubtitleFile(text) {
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
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const body = lines.slice(idx + 1).join('\n').replace(/<rt>([^<]*)<\/rt>/gi,'（$1）').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '');
        if (body.trim()) cues.push({ start, end, text: decodeEntities(body) });
    }
    return cues.sort((x, y) => x.start - y.start);
}

export function cueText(cue) {
    if (cue.nestedCues && cue.nestedCues.length) {
        return cue.nestedCues.map(n => (n.lineBreak ? '\n' : cueText(n))).join('');
    }
    return cue.payload || '';
}
