/**
 * Velostream - MP4 export muxer (runs in the player extension page).
 *
 * Turns exported HLS segments into ONE playable .mp4:
 *   - MPEG-TS segments (muxed or video-only / audio-only) are transmuxed to fragmented MP4 with
 *     Shaka's own TsTransmuxer (already loaded by the player, no extra library or CDN);
 *   - fMP4 (EXT-X-MAP) segments are passed through;
 *   - a separate audio rendition (EXT-X-MEDIA TYPE=AUDIO) is merged as a second track.
 *
 * The result is a fragmented MP4: ftyp + moov (all tracks, mvex/trex) + moof/mdat fragments.
 * Track ids are rewritten so video and audio never collide, mfhd sequence numbers are made
 * globally increasing, and sidx/styp/emsg boxes (whose offsets would be wrong) are dropped.
 *
 * Exposes window.VelostreamMux = { ExportMuxer, isTs, mergeInits }.
 */
/* global shaka */
(function () {
    'use strict';

    const CONTAINERS = new Set(['moov', 'trak', 'mvex', 'moof', 'traf', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);
    const enc = new TextEncoder();

    function u8(x) {
        if (x instanceof Uint8Array) return x;
        if (x instanceof ArrayBuffer) return new Uint8Array(x);
        if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
        return new Uint8Array(0);
    }

    function concat(parts) {
        let len = 0;
        for (const p of parts) len += p.byteLength;
        const out = new Uint8Array(len);
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.byteLength; }
        return out;
    }

    /** Top-level (or [start,end) range) box list: [{type, start, end, hdr}]. */
    function boxes(buf, start = 0, end = buf.byteLength) {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const out = [];
        let p = start;
        while (p + 8 <= end) {
            let size = dv.getUint32(p);
            const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
            let hdr = 8;
            if (size === 1) {
                if (p + 16 > end) break;
                size = Number(dv.getBigUint64(p + 8));
                hdr = 16;
            } else if (size === 0) {
                size = end - p;
            }
            if (size < hdr || p + size > end) break;
            out.push({ type, start: p, end: p + size, hdr });
            p += size;
        }
        return out;
    }

    function box(type, ...payloads) {
        const body = concat(payloads.map(u8));
        const out = new Uint8Array(8 + body.byteLength);
        new DataView(out.buffer).setUint32(0, out.byteLength);
        out.set(enc.encode(type), 4);
        out.set(body, 8);
        return out;
    }

    /** Walk every box recursively and call fn(box, buf). */
    function walk(buf, fn, start = 0, end = buf.byteLength) {
        for (const b of boxes(buf, start, end)) {
            fn(b, buf);
            if (CONTAINERS.has(b.type)) walk(buf, fn, b.start + b.hdr, b.end);
        }
    }

    /** Offset of track_ID inside tkhd / trex / tfhd (all are full boxes). */
    function trackIdOffset(b, buf) {
        const body = b.start + b.hdr;
        if (b.type === 'tkhd') return body + 4 + (buf[body] === 1 ? 16 : 8);
        if (b.type === 'trex' || b.type === 'tfhd') return body + 4;
        return -1;
    }

    function trackIds(init) {
        const ids = [];
        walk(init, (b, buf) => {
            if (b.type !== 'tkhd') return;
            ids.push(new DataView(buf.buffer, buf.byteOffset).getUint32(trackIdOffset(b, buf)));
        });
        return ids;
    }

    /** Rewrites track ids in place (tkhd, trex, tfhd) using map: oldId -> newId. */
    function remapTrackIds(buf, map) {
        if (!map || !map.size) return buf;
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        walk(buf, (b) => {
            const off = trackIdOffset(b, buf);
            if (off < 0) return;
            const id = dv.getUint32(off);
            if (map.has(id)) dv.setUint32(off, map.get(id));
        });
        return buf;
    }

    /** Merge several init segments (ftyp + moov) into one moov with every track. */
    function mergeInits(inits) {
        let ftyp = null;
        let mvhd = null;
        const traks = [];
        const trex = [];
        let maxId = 0;
        for (const init of inits) {
            for (const b of boxes(init)) {
                if (b.type === 'ftyp' && !ftyp) ftyp = init.slice(b.start, b.end);
                if (b.type !== 'moov') continue;
                for (const c of boxes(init, b.start + b.hdr, b.end)) {
                    if (c.type === 'mvhd' && !mvhd) mvhd = init.slice(c.start, c.end);
                    if (c.type === 'trak') traks.push(init.slice(c.start, c.end));
                    if (c.type === 'mvex') {
                        for (const d of boxes(init, c.start + c.hdr, c.end)) if (d.type === 'trex') trex.push(init.slice(d.start, d.end));
                    }
                }
            }
            for (const id of trackIds(init)) maxId = Math.max(maxId, id);
        }
        if (!mvhd || !traks.length) throw new Error('Init segment has no movie header');
        // next_track_ID is the last field of mvhd (v0 and v1).
        new DataView(mvhd.buffer, mvhd.byteOffset).setUint32(mvhd.byteLength - 4, maxId + 1);
        if (!ftyp) ftyp = box('ftyp', enc.encode('isom'), new Uint8Array([0, 0, 2, 0]), enc.encode('isomiso6mp41'));
        return concat([ftyp, box('moov', mvhd, ...traks, box('mvex', ...trex))]);
    }

    /** trackId -> media timescale (mdhd) of an init segment. */
    function timescales(init) {
        const map = new Map();
        const dv = new DataView(init.buffer, init.byteOffset, init.byteLength);
        for (const top of boxes(init)) {
            if (top.type !== 'moov') continue;
            for (const trak of boxes(init, top.start + top.hdr, top.end)) {
                if (trak.type !== 'trak') continue;
                let id = 0;
                let ts = 0;
                walk(init, (b) => {
                    if (b.type === 'tkhd') id = dv.getUint32(trackIdOffset(b, init));
                    if (b.type === 'mdhd') { const body = b.start + b.hdr; ts = dv.getUint32(body + 4 + (init[body] === 1 ? 16 : 8)); }
                }, trak.start + trak.hdr, trak.end);
                if (id && ts) map.set(id, ts);
            }
        }
        return map;
    }

    /** {id, off, v1, base} of the first traf's tfhd/tfdt in a fragment. */
    function fragTiming(frag) {
        const dv = new DataView(frag.buffer, frag.byteOffset, frag.byteLength);
        const r = { id: -1, off: -1, v1: false, base: 0 };
        walk(frag, (b) => {
            if (b.type === 'tfhd' && r.id < 0) r.id = dv.getUint32(b.start + b.hdr + 4);
            if (b.type === 'tfdt' && r.off < 0) {
                r.v1 = frag[b.start + b.hdr] === 1;
                r.off = b.start + b.hdr + 4;
                r.base = r.v1 ? Number(dv.getBigUint64(r.off)) : dv.getUint32(r.off);
            }
        });
        return r;
    }

    function isTs(buf) {
        return buf.byteLength >= 376 && buf[0] === 0x47 && buf[188] === 0x47;
    }

    /** One transmuxed track (video or audio) of an MPEG-TS / raw AAC source. */
    class TsTrack {
        constructor(contentType, id) {
            this.type = contentType;
            this.t = new shaka.transmuxer.TsTransmuxer('video/mp2t');
            this.stream = {
                id, type: contentType, mimeType: 'video/mp2t', codecs: contentType === 'video' ? 'avc1.64001f' : 'mp4a.40.2',
                width: 0, height: 0, audioSamplingRate: null, channelsCount: null, language: 'und',
                drmInfos: [], encrypted: false
            };
            this.init = null;
        }

        async push(data, info) {
            const ref = {
                startTime: info.start || 0, endTime: info.end || (info.start || 0) + 6,
                discontinuitySequence: 0, getUris: () => [info.url || 'segment']
            };
            const out = await this.t.transmux(data, this.stream, ref, ref.endTime - ref.startTime, this.type);
            if (!out || out instanceof Uint8Array || !out.data) return null;
            if (out.init && !this.init) this.init = u8(out.init).slice();
            const frag = u8(out.data);
            return frag.byteLength ? frag.slice() : null;
        }
    }

    /**
     * ExportMuxer: feed it the engine's export chunks, it writes one .mp4 to `sink`.
     *  sources: 1 (single playlist) streams straight to the sink;
     *           2 (video + separate audio) buffers fragments as Blobs until both inits are known.
     */
    class ExportMuxer {
        constructor(sink, sourceCount) {
            this.sink = sink;
            this.sourceCount = sourceCount;
            this.src = [];          // per source: { kind:'ts'|'fmp4', tracks:[TsTrack], init, frags:[Blob] }
            this.seq = 0;
            this.wroteInit = false;
            this.idMaps = [];
            this.failedSegments = 0;
            this.included = new Set();   // TsTracks whose init is in the written moov
            this.pending = [];           // single-source fragments held until every track has an init
            this.pendingSegs = 0;
        }

        async addInit(srcIndex, data) {
            const s = this.source(srcIndex);
            s.kind = 'fmp4';
            if (!s.init) s.init = u8(data).slice();
        }

        source(i) {
            if (!this.src[i]) this.src[i] = { kind: null, tracks: [], init: null, frags: [] };
            return this.src[i];
        }

        async addSegment(srcIndex, data, info) {
            const s = this.source(srcIndex);
            const buf = u8(data);
            const frags = [];
            if (s.kind === 'fmp4') {
                for (const b of boxes(buf)) if (b.type === 'moof' || b.type === 'mdat') frags.push(buf.slice(b.start, b.end));
            } else {
                if (!s.kind) {
                    s.kind = 'ts';
                    // Separate audio renditions are always one audio track; a TS main playlist
                    // gets a video track plus an audio track when the stream carries audio.
                    let codecs = { video: null, audio: null };
                    if (isTs(buf)) {
                        try { codecs = new shaka.util.TsParser().parse(buf).getCodecs() || codecs; } catch (_) { /* probe below */ }
                    } else {
                        codecs = { video: null, audio: 'aac' }; // raw ADTS / ID3 + AAC
                    }
                    if (srcIndex === 0 && codecs.video) s.tracks.push(new TsTrack('video', 1));
                    if (codecs.audio) s.tracks.push(new TsTrack('audio', srcIndex === 0 ? 2 : 3));
                    if (!s.tracks.length) throw new Error('Unsupported segment format for MP4 export');
                }
                for (const t of s.tracks) {
                    try {
                        const f = await t.push(buf, info);
                        // A track whose init arrived after the moov was written cannot be added.
                        if (f && (!this.wroteInit || this.included.has(t))) frags.push(f);
                    } catch (err) {
                        if (!t.init) throw err; // the very first segment failed: let the caller fall back
                        this.failedSegments++;
                    }
                }
            }
            this.noteTiming(srcIndex, frags);
            await this.emit(srcIndex, frags);
        }

        initOf(s) {
            if (s.kind === 'fmp4') return s.init ? [s.init] : [];
            return s.tracks.map(t => t.init).filter(Boolean);
        }

        /** Renumber tracks of source 1 (and up) so they never collide with source 0. */
        buildIdMaps() {
            const used = new Set();
            this.src.forEach((s, i) => {
                const map = new Map();
                for (const init of this.initOf(s)) {
                    for (const id of trackIds(init)) {
                        let n = id;
                        while (used.has(n)) n++;
                        used.add(n);
                        if (n !== id) map.set(id, n);
                    }
                }
                this.idMaps[i] = map;
            });
        }

        async writeInit() {
            this.buildIdMaps();
            this.computeOffset();
            const inits = [];
            this.src.forEach((s, i) => { for (const init of this.initOf(s)) inits.push(remapTrackIds(init.slice(), this.idMaps[i])); });
            this.src.forEach(s => s.tracks.forEach(t => { if (t.init) this.included.add(t); }));
            await this.sink.write(mergeInits(inits));
            this.wroteInit = true;
        }

        async flushPending() {
            await this.writeInit();
            const included = new Set();
            for (const init of this.initOf(this.src[0])) trackIds(init).forEach(id => included.add(id));
            for (const f of this.pending) {
                // Drop fragments of a track that never produced an init.
                let id = -1;
                walk(f, (b, buf) => { if (b.type === 'tfhd' && id < 0) id = new DataView(buf.buffer, buf.byteOffset).getUint32(b.start + b.hdr + 4); });
                if (id < 0 || included.has(id)) await this.sink.write(this.fixFragment(0, f));
            }
            this.pending = [];
        }

        /** Remember each track's first decode time (seconds) so the file can start at 0. */
        noteTiming(srcIndex, frags) {
            const s = this.src[srcIndex];
            if (!s.first) s.first = new Map();
            let scales = null;
            for (const f of frags) {
                const t = fragTiming(f);
                if (t.id < 0 || t.off < 0 || s.first.has(t.id)) continue;
                if (!scales) { scales = new Map(); for (const init of this.initOf(s)) for (const [k, v] of timescales(init)) scales.set(k, v); }
                const ts = scales.get(t.id);
                if (ts) s.first.set(t.id, t.base / ts);
            }
        }

        /** One shared offset for every track keeps A/V sync while moving the start to 0. */
        computeOffset() {
            let min = Infinity;
            for (const s of this.src) if (s && s.first) for (const v of s.first.values()) min = Math.min(min, v);
            this.offsetSec = Number.isFinite(min) ? min : 0;
            this.scales = this.src.map(s => {
                const m = new Map();
                if (s) for (const init of this.initOf(s)) for (const [k, v] of timescales(init)) m.set(k, v);
                return m;
            });
        }

        fixFragment(srcIndex, frag) {
            const dv = new DataView(frag.buffer, frag.byteOffset, frag.byteLength);
            if (this.offsetSec) {
                const t = fragTiming(frag);
                const ts = this.scales && this.scales[srcIndex] && this.scales[srcIndex].get(t.id);
                if (t.off >= 0 && ts) {
                    const base = Math.max(0, t.base - Math.round(this.offsetSec * ts));
                    if (t.v1) dv.setBigUint64(t.off, BigInt(base)); else dv.setUint32(t.off, base >>> 0);
                }
            }
            remapTrackIds(frag, this.idMaps[srcIndex]);
            walk(frag, (b) => { if (b.type === 'mfhd') dv.setUint32(b.start + b.hdr + 4, ++this.seq); });
            return frag;
        }

        async emit(srcIndex, frags) {
            if (!frags.length) return;
            if (this.sourceCount === 1) {
                if (!this.wroteInit) {
                    // Wait (up to 4 segments) until every track has its init: audio can start late.
                    this.pending.push(...frags);
                    this.pendingSegs++;
                    const s = this.src[0];
                    const allInit = s.kind === 'fmp4' ? !!s.init : s.tracks.every(t => t.init);
                    if (allInit || this.pendingSegs >= 4) await this.flushPending();
                    return;
                }
                for (const f of frags) await this.sink.write(this.fixFragment(0, f));
                return;
            }
            // Several sources: keep fragments (Blobs may be disk-backed) until every init is known.
            this.src[srcIndex].frags.push(new Blob(frags));
        }

        async finish() {
            if (this.sourceCount === 1 && !this.wroteInit && this.pending.length && this.initOf(this.src[0]).length) await this.flushPending();
            if (this.sourceCount > 1) {
                if (!this.src.length || this.src.some(s => !s || !this.initOf(s).length)) throw new Error('A track produced no media');
                await this.writeInit();
                for (let i = 0; i < this.src.length; i++) {
                    for (const blob of this.src[i].frags) {
                        const buf = new Uint8Array(await blob.arrayBuffer());
                        for (const b of boxes(buf)) {
                            const part = buf.slice(b.start, b.end);
                            await this.sink.write(b.type === 'moof' ? this.fixFragment(i, part) : part);
                        }
                    }
                    this.src[i].frags = [];
                }
            }
            if (!this.wroteInit) throw new Error('Nothing could be converted to MP4');
            await this.sink.close();
        }
    }

    window.VelostreamMux = Object.freeze({ ExportMuxer, isTs, mergeInits, boxes });
})();
