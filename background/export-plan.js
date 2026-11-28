export function fileBaseName(stream, title) {
    const clean = value => value.replace(/\.(m3u8|mpd|mp4|webm|mkv|mov|m4v)$/i, '')
        .replace(/[^\p{L}\p{N} ._-]+/gu, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100);
    const name = typeof title === 'string' ? clean(title) : '';
    if (name) return name;
    try {
        const u = new URL(stream.url);
        const last = u.pathname.split('/').filter(Boolean).pop() || 'stream';
        return last.replace(/\.(m3u8|mpd|mp4|webm|mkv|mov|m4v)$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'stream';
    } catch (_) {
        return 'stream';
    }
}

export function segmentPdts(segs) {
    const out = new Array(segs.length).fill(null);
    let t = null;
    for (let i = 0; i < segs.length; i++) {
        if (typeof segs[i].programDateTime === 'number') t = segs[i].programDateTime;
        out[i] = t;
        if (t !== null) t += (segs[i].duration || 0) * 1000;
    }
    return out;
}

/** Segments of one playlist that belong to the recording. */
export function recordingSegments(rec, playlist, segs) {
    const from = rec.fromSeqByUrl && rec.fromSeqByUrl[playlist.url];
    if (typeof from === 'number') return segs.filter(s => s.seq >= from);
    // Playlist unknown at "record" time: match by program-date-time when both sides have it...
    if (typeof rec.startPdt === 'number') {
        const pdts = segmentPdts(segs);
        if (pdts.some(t => t !== null)) {
            // Keep the segment that contains the start instant (ends after it).
            return segs.filter((s, i) => pdts[i] !== null && pdts[i] + (s.duration || 0) * 1000 > rec.startPdt + 100);
        }
    }
    // ...else approximate: the same amount of media back from the live edge as the main
    // playlist had at "record" time plus the wall-clock time recorded since.
    const want = (rec.behindEdgeSec || 0) + Math.max(0, (Date.now() - rec.startedAt) / 1000);
    let total = 0;
    let i = segs.length;
    while (i > 0 && total < want - 0.05) {
        i--;
        total += segs[i].duration || 0;
    }
    return segs.slice(i);
}

/**
 * Validate a DASH export plan from the player: at most 2 parts (video, audio), http(s) URLs only,
 * finite times, well-formed byte ranges. Returns segments in the HLS export shape or null.
 */
export function sanitizeDashPlan(plan) {
    const httpUrl = (u) => {
        if (typeof u !== 'string' || u.length > 4096) return null;
        try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch (_) { return null; }
    };
    const parts = Array.isArray(plan && plan.parts) ? plan.parts.slice(0, 2) : [];
    const out = [];
    for (const part of parts) {
        const role = part && part.role === 'audio' ? 'audio' : 'main';
        const list = Array.isArray(part && part.segs) ? part.segs : [];
        if (!list.length || list.length > 50000) return null;
        const segs = [];
        for (const s of list) {
            const uri = httpUrl(s && s.uri);
            if (!uri) return null;
            const range = typeof s.range === 'string' && /^bytes=\d+-\d*$/.test(s.range) ? s.range : null;
            let map = null;
            if (s.map) {
                const mu = httpUrl(s.map.uri);
                if (!mu) return null;
                const br = s.map.byteRange;
                const okRange = br && Number.isInteger(br.offset) && Number.isInteger(br.length) && br.offset >= 0 && br.length > 0;
                map = { uri: mu, byteRange: okRange ? { offset: br.offset, length: br.length } : null };
            }
            const start = Number.isFinite(+s.start) ? +s.start : 0;
            const duration = Number.isFinite(+s.duration) && +s.duration >= 0 ? +s.duration : 0;
            segs.push({ uri, range, start, duration, map });
        }
        const ext = ['mp4', 'm4a', 'webm', 'weba'].includes(part.ext) ? part.ext : (role === 'audio' ? 'm4a' : 'mp4');
        const mime = /^(video|audio)\/(mp4|webm)$/.test(part.mime) ? part.mime : (ext === 'webm' ? 'video/webm' : ext === 'weba' ? 'audio/webm' : role === 'audio' ? 'audio/mp4' : 'video/mp4');
        out.push({ role, segs, ext, mime });
    }
    return out.length ? out : null;
}
