/**
 * Velostream - HLS playlist parser (RFC 8216 subset used by real-world players).
 *
 * The background engine uses this to understand what the player is streaming so it can
 * prefetch ahead, map a seek time to a segment index, probe stream metadata for the popup
 * and export/decrypt a stream. Playback parsing itself is done by the bundled Shaka Player.
 *
 * Supported: master playlists (EXT-X-STREAM-INF with BANDWIDTH/AVERAGE-BANDWIDTH/
 * RESOLUTION/CODECS/FRAME-RATE/AUDIO/SUBTITLES), EXT-X-MEDIA (AUDIO/SUBTITLES/CLOSED-CAPTIONS),
 * EXT-X-I-FRAME-STREAM-INF (ignored for playback), media playlists with EXTINF,
 * EXT-X-MEDIA-SEQUENCE, EXT-X-DISCONTINUITY(-SEQUENCE), EXT-X-BYTERANGE (incl. implicit
 * offsets), EXT-X-MAP (with BYTERANGE), EXT-X-KEY (METHOD/URI/IV), EXT-X-ENDLIST,
 * EXT-X-PLAYLIST-TYPE, EXT-X-TARGETDURATION, EXT-X-PROGRAM-DATE-TIME.
 */

/** Parse an attribute list such as `BANDWIDTH=1,CODECS="a,b",URI="x"`. */
export function parseAttributes(input) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(input)) !== null) {
        let value = m[2];
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        attrs[m[1]] = value;
    }
    return attrs;
}

function resolve(uri, base) {
    try {
        return new URL(uri, base).href;
    } catch (_) {
        return uri;
    }
}

function parseByteRange(value, lastEnd) {
    const match = /^(\d+)(?:@(\d+))?$/.exec(value);
    if (!match) return null;
    const length = Number(match[1]);
    const offset = match[2] == null ? lastEnd : Number(match[2]);
    if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset) ||
        offset < 0 || !Number.isSafeInteger(offset + length)) return null;
    return { offset, length };
}

/** Header value shaka/our engine use for a byte range request. */
export function rangeHeader(byteRange) {
    if (!byteRange) return null;
    return `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
}

/** Cache key shared by player requests and prefetches: URL + optional Range. */
export function segmentKey(url, range) {
    return range ? `${url}|${range}` : url;
}

export function isPlaylist(text) {
    return typeof text === 'string' && text.trimStart().startsWith('#EXTM3U');
}

export function isMasterPlaylist(text) {
    return /#EXT-X-STREAM-INF/.test(text);
}

/**
 * Parse a master playlist.
 * @returns {{type:'master', variants:Array, media:Array}}
 */
export function parseMaster(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const variants = [];
    const media = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const a = parseAttributes(line.slice(18));
            let uri = null;
            for (let j = i + 1; j < lines.length; j++) {
                const next = lines[j].trim();
                if (next && !next.startsWith('#')) { uri = next; i = j; break; }
            }
            if (!uri) continue;
            const [w, h] = (a.RESOLUTION || '').split('x').map(n => parseInt(n, 10));
            variants.push({
                uri: resolve(uri, baseUrl),
                bandwidth: parseInt(a.BANDWIDTH, 10) || 0,
                averageBandwidth: parseInt(a['AVERAGE-BANDWIDTH'], 10) || 0,
                width: w || 0,
                height: h || 0,
                codecs: a.CODECS || '',
                frameRate: parseFloat(a['FRAME-RATE']) || 0,
                audio: a.AUDIO || null,
                subtitles: a.SUBTITLES || null
            });
        } else if (line.startsWith('#EXT-X-MEDIA:')) {
            const a = parseAttributes(line.slice(13));
            media.push({
                type: a.TYPE,
                groupId: a['GROUP-ID'],
                name: a.NAME || a.LANGUAGE || a.TYPE,
                language: a.LANGUAGE || '',
                uri: a.URI ? resolve(a.URI, baseUrl) : null,
                isDefault: a.DEFAULT === 'YES',
                autoselect: a.AUTOSELECT === 'YES',
                channels: a.CHANNELS || ''
            });
        }
    }
    variants.sort((x, y) => x.bandwidth - y.bandwidth);
    return { type: 'master', variants, media };
}

/**
 * Parse a media playlist into a segment table with absolute start times.
 * @returns {{type:'media', segments:Array, targetDuration:number, mediaSequence:number,
 *            endList:boolean, live:boolean, totalDuration:number, encrypted:boolean}}
 */
export function parseMedia(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const segments = [];
    let targetDuration = 0;
    let mediaSequence = 0;
    let discontinuitySeq = 0;
    let endList = false;
    let playlistType = '';
    let key = null;
    let map = null;
    let pendingDuration = null;
    let pendingTitle = '';
    let pendingRange = null;
    let pendingDiscontinuity = false;
    let pendingPdt = null;
    let start = 0;
    let encrypted = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (line.startsWith('#')) {
            if (line.startsWith('#EXTINF:')) {
                const body = line.slice(8);
                const comma = body.indexOf(',');
                pendingDuration = parseFloat(comma >= 0 ? body.slice(0, comma) : body) || 0;
                pendingTitle = comma >= 0 ? body.slice(comma + 1) : '';
            } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
                targetDuration = parseFloat(line.slice(22)) || 0;
            } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                mediaSequence = parseInt(line.slice(22), 10) || 0;
            } else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
                discontinuitySeq = parseInt(line.slice(30), 10) || 0;
            } else if (line === '#EXT-X-DISCONTINUITY') {
                pendingDiscontinuity = true;
            } else if (line === '#EXT-X-ENDLIST') {
                endList = true;
            } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
                playlistType = line.slice(21).trim();
            } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
                pendingRange = line.slice(17).trim();
            } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
                pendingPdt = Date.parse(line.slice(25)) || null;
            } else if (line.startsWith('#EXT-X-KEY:')) {
                const a = parseAttributes(line.slice(11));
                if (!a.METHOD || a.METHOD === 'NONE') {
                    key = null;
                } else {
                    key = {
                        method: a.METHOD,
                        uri: a.URI ? resolve(a.URI, baseUrl) : null,
                        iv: a.IV || null,
                        keyFormat: a.KEYFORMAT || 'identity'
                    };
                    encrypted = true;
                }
            } else if (line.startsWith('#EXT-X-MAP:')) {
                const a = parseAttributes(line.slice(11));
                if (a.URI) {
                    const uri = resolve(a.URI, baseUrl);
                    const byteRange = a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null;
                    if (a.BYTERANGE && !byteRange) throw new Error('Invalid HLS initialization byte range.');
                    map = { uri, byteRange };
                }
            }
            continue;
        }

        // URI line
        if (pendingDuration === null) continue; // stray URI (e.g. master playlist line)
        const uri = resolve(line, baseUrl);
        let byteRange = null;
        if (pendingRange) {
            const previous = segments.at(-1);
            const precedingEnd = previous?.uri === uri && previous.byteRange ?
                previous.byteRange.offset + previous.byteRange.length : undefined;
            byteRange = parseByteRange(pendingRange, precedingEnd);
            if (!byteRange) throw new Error('Invalid HLS media byte range.');
        }
        const seq = mediaSequence + segments.length;
        // A segment preceded by EXT-X-DISCONTINUITY starts the next discontinuity number.
        if (pendingDiscontinuity) discontinuitySeq++;
        segments.push({
            index: segments.length,
            seq,
            uri,
            duration: pendingDuration,
            title: pendingTitle,
            start,
            byteRange,
            range: rangeHeader(byteRange),
            key,
            map,
            discontinuity: pendingDiscontinuity,
            discontinuitySeq: discontinuitySeq,
            programDateTime: pendingPdt
        });
        start += pendingDuration;
        pendingDuration = null;
        pendingTitle = '';
        pendingRange = null;
        pendingDiscontinuity = false;
        pendingPdt = null;
    }

    return {
        type: 'media',
        segments,
        targetDuration,
        mediaSequence,
        endList,
        playlistType,
        live: !endList && playlistType !== 'VOD',
        totalDuration: start,
        encrypted,
        lowLatency: /#EXT-X-PART[:-]/.test(text)
    };
}

function byteRangeAttr(br) {
    return `${br.length}@${br.offset}`;
}

/**
 * Serialize parsed segments back into a live media playlist. Used by the live DVR to expose
 * retained (cached) segments that already slid out of the origin's playlist window.
 * Segment URIs are absolute, so the output does not depend on its own URL.
 */
export function serializeMedia(segments, { targetDuration = 0 } = {}) {
    if (!segments.length) return '#EXTM3U\n';
    const first = segments[0];
    const maxDur = Math.ceil(Math.max(targetDuration, ...segments.map(s => s.duration)));
    const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        `#EXT-X-TARGETDURATION:${maxDur}`,
        `#EXT-X-MEDIA-SEQUENCE:${first.seq}`,
        `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.max(0, first.discontinuitySeq - (first.discontinuity ? 1 : 0))}`
    ];
    let lastKey = null;
    let lastMap = null;
    for (const seg of segments) {
        if (seg.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
        const keySig = seg.key ? JSON.stringify(seg.key) : 'none';
        if (keySig !== lastKey) {
            if (seg.key) {
                let tag = `#EXT-X-KEY:METHOD=${seg.key.method}`;
                if (seg.key.uri) tag += `,URI="${seg.key.uri}"`;
                if (seg.key.iv) tag += `,IV=${seg.key.iv}`;
                if (seg.key.keyFormat && seg.key.keyFormat !== 'identity') tag += `,KEYFORMAT="${seg.key.keyFormat}"`;
                lines.push(tag);
            } else if (lastKey !== null) {
                lines.push('#EXT-X-KEY:METHOD=NONE');
            }
            lastKey = keySig;
        }
        const mapSig = seg.map ? JSON.stringify(seg.map) : null;
        if (mapSig && mapSig !== lastMap) {
            lines.push(`#EXT-X-MAP:URI="${seg.map.uri}"${seg.map.byteRange ? `,BYTERANGE="${byteRangeAttr(seg.map.byteRange)}"` : ''}`);
            lastMap = mapSig;
        }
        if (seg.programDateTime) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(seg.programDateTime).toISOString()}`);
        if (seg.byteRange) lines.push(`#EXT-X-BYTERANGE:${byteRangeAttr(seg.byteRange)}`);
        lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
        lines.push(seg.uri);
    }
    return lines.join('\n') + '\n';
}

/** Parse either playlist flavour. Returns null when the text is not an M3U8. */
export function parsePlaylist(text, baseUrl) {
    if (!isPlaylist(text)) return null;
    return isMasterPlaylist(text) ? parseMaster(text, baseUrl) : parseMedia(text, baseUrl);
}

/**
 * Live playlists are re-parsed on every refresh and parseMedia() starts each parse at 0, so the
 * same segment (same media sequence number) would get a different `start` every refresh. Shift
 * `parsed`'s start times so that segments it shares with `ref` (an earlier parse of the same
 * playlist, or a sibling rendition with the same media sequence numbering) keep the start time
 * they had in `ref`. This gives every live playlist one stable timeline for its lifetime, which
 * is what a learned playlist->player timeline offset needs to stay valid across refreshes.
 *
 * With `bridgeGap`, a refresh that does not overlap `ref` (we missed some refreshes) is anchored
 * right after `ref`'s last segment plus targetDuration per missing sequence number.
 * Mutates `parsed.segments[*].start`.
 * @returns {'overlap'|'gap'|null} how it was aligned (null = left as parsed)
 */
export function alignLiveTimeline(parsed, ref, { bridgeGap = false } = {}) {
    const segs = parsed && parsed.segments;
    const refSegs = ref && ref.segments;
    if (!segs || !segs.length || !refSegs || !refSegs.length) return null;
    const refFirst = refSegs[0].seq;
    const refLast = refSegs[refSegs.length - 1].seq;
    let shift = null;
    let how = null;
    for (const s of segs) {
        if (s.seq < refFirst || s.seq > refLast) continue;
        const r = refSegs[s.seq - refFirst];
        if (r && r.seq === s.seq) { shift = r.start - s.start; how = 'overlap'; break; }
    }
    if (shift === null && bridgeGap && segs[0].seq > refLast) {
        const last = refSegs[refSegs.length - 1];
        const missing = segs[0].seq - refLast - 1;
        const per = parsed.targetDuration || last.duration || 0;
        shift = last.start + last.duration + missing * per - segs[0].start;
        how = 'gap';
    }
    if (shift === null) return null;
    if (shift) for (const s of segs) s.start += shift;
    return how;
}

/**
 * Binary search: index of the segment containing time t (clamped).
 * `t` is on the playlist's own timeline; pass `offset` (player time - playlist time) to look up
 * a player/presentation time instead.
 */
export function segmentIndexForTime(segments, t, offset = 0) {
    if (!segments || !segments.length) return 0;
    t = Number(t) - (Number(offset) || 0);
    if (!Number.isFinite(t)) return 0;
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (segments[mid].start <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
}

/** AES-128 IV: explicit hex IV or the media sequence number as a 128-bit big-endian int. */
export function ivForSegment(segment) {
    const iv = new Uint8Array(16);
    if (segment.key && segment.key.iv) {
        const hex = segment.key.iv.replace(/^0x/i, '').padStart(32, '0');
        for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    } else {
        // RFC 8216 5.2: the whole media sequence number, big-endian, in the 16-octet buffer.
        // (Sequence numbers above 2^32 occur with epoch/timestamp based numbering.)
        let seq = segment.seq;
        for (let i = 15; i >= 0 && seq > 0; i--) { iv[i] = seq % 256; seq = Math.floor(seq / 256); }
    }
    return iv;
}

/** Decrypt an AES-128 (CBC, PKCS7) HLS segment using Web Crypto. */
export async function decryptAes128(data, keyBytes, iv) {
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
    return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
}
