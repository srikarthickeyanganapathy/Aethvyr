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
 * increasing in file order, and sidx/styp/emsg/prft/free boxes (whose offsets would be wrong)
 * are dropped. Each moof is written immediately followed by its own mdat; trun data offsets and
 * explicit tfhd base offsets are rewritten so they still point at the sample data. With several
 * sources the fragments are interleaved by decode time.
 *
 * Internal invariant: every stored fragment is ONE moof at offset 0 directly followed by its
 * mdat; an explicit tfhd base_data_offset inside it is relative to the fragment start and is
 * made absolute (output-file position) when the fragment is written.
 *
 * Exposes window.VelostreamMux = { ExportMuxer, isTs, mergeInits, boxes }.
 */
/* global shaka */
(function () {
    'use strict';

    const CONTAINERS = new Set(['moov', 'trak', 'mvex', 'moof', 'traf', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);
    const enc = new TextEncoder();

    const TFHD_BASE_DATA_OFFSET = 0x000001;
    const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;
    const TRUN_DATA_OFFSET = 0x000001;

    function u8(x) {
        if (x instanceof Uint8Array) return x;
        if (x instanceof ArrayBuffer) return new Uint8Array(x);
        if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
        return new Uint8Array(0);
    }

    function view(buf) {
        return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
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
        const dv = view(buf);
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

    /**
     * Copy of one box. A size==0 ("extends to end of file") header is only valid for the last
     * box of a file, so it is replaced by the explicit size before the box is re-packed.
     */
    function copyBox(buf, b) {
        const out = buf.slice(b.start, b.end);
        if (b.hdr === 8 && view(buf).getUint32(b.start) === 0) {
            const len = b.end - b.start;
            if (len > 0xFFFFFFFF) throw new Error('Box too large to re-pack');
            view(out).setUint32(0, len);
        }
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
            ids.push(view(buf).getUint32(trackIdOffset(b, buf)));
        });
        return ids;
    }

    /** Rewrites track ids in place (tkhd, trex, tfhd, tref entries) using map: oldId -> newId. */
    function remapTrackIds(buf, map) {
        if (!map || !map.size) return buf;
        const dv = view(buf);
        const fix = (off) => { const id = dv.getUint32(off); if (map.has(id)) dv.setUint32(off, map.get(id)); };
        walk(buf, (b) => {
            if (b.type === 'tref') {
                // tref children ('chap', 'sync', 'hint', ...) are plain arrays of track ids.
                for (const r of boxes(buf, b.start + b.hdr, b.end)) {
                    for (let p = r.start + r.hdr; p + 4 <= r.end; p += 4) fix(p);
                }
                return;
            }
            const off = trackIdOffset(b, buf);
            if (off >= 0) fix(off);
        });
        return buf;
    }

    function trexBox(trackId) {
        const body = new Uint8Array(24);
        const dv = new DataView(body.buffer);
        dv.setUint32(4, trackId);
        dv.setUint32(8, 1); // default_sample_description_index
        return box('trex', body);
    }

    /** Merge several init segments (ftyp + moov) into one moov with every track. */
    function mergeInits(inits) {
        let ftyp = null;
        let mvhd = null;
        const traks = [];
        const trex = [];
        const trexIds = new Set();
        const trakIds = [];
        let maxId = 0;
        for (const init of inits) {
            for (const b of boxes(init)) {
                if (b.type === 'ftyp' && !ftyp) ftyp = init.slice(b.start, b.end);
                if (b.type !== 'moov') continue;
                for (const c of boxes(init, b.start + b.hdr, b.end)) {
                    if (c.type === 'mvhd' && !mvhd) mvhd = init.slice(c.start, c.end);
                    if (c.type === 'trak') {
                        const t = init.slice(c.start, c.end);
                        traks.push(t);
                        trakIds.push(...trackIds(t));
                    }
                    if (c.type === 'mvex') {
                        for (const d of boxes(init, c.start + c.hdr, c.end)) {
                            if (d.type !== 'trex') continue;
                            const t = init.slice(d.start, d.end);
                            const id = view(t).getUint32(trackIdOffset({ type: 'trex', start: 0, hdr: 8 }, t));
                            if (trexIds.has(id)) continue;
                            trexIds.add(id);
                            trex.push(t);
                        }
                    }
                }
            }
            for (const id of trackIds(init)) maxId = Math.max(maxId, id);
        }
        if (!mvhd || !traks.length) throw new Error('Init segment has no movie header');
        // Every track of a fragmented file needs a trex; some inits omit it.
        for (const id of trakIds) if (!trexIds.has(id)) { trexIds.add(id); trex.push(trexBox(id)); }
        // next_track_ID is the last field of mvhd (v0 and v1).
        view(mvhd).setUint32(mvhd.byteLength - 4, maxId + 1);
        if (!ftyp) ftyp = box('ftyp', enc.encode('isom'), new Uint8Array([0, 0, 2, 0]), enc.encode('isomiso6mp41'));
        return concat([ftyp, box('moov', mvhd, ...traks, box('mvex', ...trex))]);
    }

    /** trackId -> media timescale (mdhd) of an init segment. */
    function timescales(init) {
        const map = new Map();
        const dv = view(init);
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

    /** Every traf of every moof in a fragment: [{id, off, v1, base(BigInt)}] (off -1: no tfdt). */
    function fragTimings(frag) {
        const dv = view(frag);
        const out = [];
        for (const moof of boxes(frag)) {
            if (moof.type !== 'moof') continue;
            for (const traf of boxes(frag, moof.start + moof.hdr, moof.end)) {
                if (traf.type !== 'traf') continue;
                const r = { id: -1, off: -1, v1: false, base: 0n };
                for (const b of boxes(frag, traf.start + traf.hdr, traf.end)) {
                    if (b.type === 'tfhd' && r.id < 0) r.id = dv.getUint32(b.start + b.hdr + 4);
                    if (b.type === 'tfdt' && r.off < 0) {
                        r.v1 = frag[b.start + b.hdr] === 1;
                        r.off = b.start + b.hdr + 4;
                        r.base = r.v1 ? dv.getBigUint64(r.off) : BigInt(dv.getUint32(r.off));
                    }
                }
                if (r.id >= 0) out.push(r);
            }
        }
        return out;
    }

    /** Track id of the first traf of a fragment (-1 if none). */
    function firstTrackId(frag) {
        const t = fragTimings(frag);
        return t.length ? t[0].id : -1;
    }

    /**
     * Rewrites the data offsets of moof (a standalone copy, moof at offset 0) for its new home:
     * directly followed by its mdat, `gap` bytes that used to sit between them removed.
     *   - trafs whose base is the moof (default-base-is-moof, or the first traf without an
     *     explicit base): every trun data_offset loses `gap`;
     *   - later trafs without either flag: their base is the end of the previous traf's data,
     *     which already moved along, so nothing changes;
     *   - trafs with an explicit base_data_offset (absolute position in the source resource):
     *     the base is made relative to the moof start (minus `gap`); the writer adds the moof's
     *     output-file position. Their trun data_offsets are relative to that base and stay.
     * `srcMoofStart` / `payloadStart` / `payloadEnd` are positions in the segment buffer.
     */
    function fixDataOffsets(moof, gap, srcMoofStart, payloadStart, payloadEnd) {
        const dv = view(moof);
        const root = boxes(moof)[0];
        if (!root) return;
        const trafs = [];
        for (const traf of boxes(moof, root.start + root.hdr, root.end)) {
            if (traf.type !== 'traf') continue;
            const t = { tfhdFlags: 0, baseOff: -1, truns: [] };
            for (const b of boxes(moof, traf.start + traf.hdr, traf.end)) {
                const body = b.start + b.hdr;
                if (b.type === 'tfhd') {
                    t.tfhdFlags = dv.getUint32(body) & 0xFFFFFF;
                    if (t.tfhdFlags & TFHD_BASE_DATA_OFFSET) t.baseOff = body + 8;
                } else if (b.type === 'trun' && (dv.getUint32(body) & TRUN_DATA_OFFSET)) {
                    t.truns.push(body + 8); // after version/flags + sample_count
                }
            }
            trafs.push(t);
        }
        // Explicit bases are absolute in the original resource, whose origin is unknown when the
        // segment was a byte range. Origin 0 (segment start) if that lands inside the mdat
        // payload, else infer it from the earliest sample position = start of the mdat payload.
        let minAbs = null;
        let originZeroOk = true;
        for (const t of trafs) {
            if (t.baseOff < 0) continue;
            const base = dv.getBigUint64(t.baseOff);
            const first = t.truns.length ? BigInt(dv.getInt32(t.truns[0])) : 0n;
            const abs = base + first;
            if (minAbs === null || abs < minAbs) minAbs = abs;
            if (abs < BigInt(payloadStart) || abs >= BigInt(Math.max(payloadEnd, payloadStart + 1))) originZeroOk = false;
        }
        const origin = minAbs === null || originZeroOk ? 0n : minAbs - BigInt(payloadStart);
        trafs.forEach((t, i) => {
            if (t.baseOff >= 0) {
                const rel = dv.getBigUint64(t.baseOff) - origin - BigInt(srcMoofStart) - BigInt(gap);
                dv.setBigUint64(t.baseOff, BigInt.asUintN(64, rel));
                return;
            }
            if (!gap || !(i === 0 || (t.tfhdFlags & TFHD_DEFAULT_BASE_IS_MOOF))) return;
            for (const off of t.truns) dv.setInt32(off, dv.getInt32(off) - gap);
        });
    }

    /**
     * Split an fMP4 media buffer into self-contained fragments (moof immediately followed by
     * its mdat). Boxes between a moof and its mdat (emsg, prft, free, sidx, ...) are dropped and
     * the offsets are fixed for the removed bytes; a moof without an mdat is dropped.
     */
    function repackFragments(buf) {
        const top = boxes(buf);
        const out = [];
        for (let i = 0; i < top.length; i++) {
            if (top[i].type !== 'moof') continue;
            let j = i + 1;
            while (j < top.length && top[j].type !== 'mdat' && top[j].type !== 'moof') j++;
            if (j >= top.length || top[j].type !== 'mdat') continue;
            const moofB = top[i];
            const mdatB = top[j];
            const moof = buf.slice(moofB.start, moofB.end);
            fixDataOffsets(moof, mdatB.start - moofB.end, moofB.start, mdatB.start + mdatB.hdr, mdatB.end);
            out.push(concat([moof, copyBox(buf, mdatB)]));
            i = j;
        }
        return out;
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
            if (!out || out instanceof Uint8Array || !out.data) return [];
            if (out.init && !this.init) this.init = u8(out.init).slice();
            const frag = u8(out.data);
            return frag.byteLength ? repackFragments(frag) : [];
        }
    }

    /**
     * ExportMuxer: feed it the engine's export chunks, it writes one .mp4 to `sink`.
     *  sources: 1 (single playlist) streams straight to the sink;
     *           2 (video + separate audio) buffers fragments as Blobs until both inits are known,
     *           then writes them interleaved in decode-time order.
     */
    class ExportMuxer {
        constructor(sink, sourceCount) {
            this.sink = sink;
            this.sourceCount = sourceCount;
            this.src = [];          // per source: { kind:'ts'|'fmp4', tracks:[TsTrack], init, frags:[{blob,start,end,t}] }
            this.seq = 0;
            this.outPos = 0;        // bytes written to the sink so far
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
            const next = u8(data);
            if (!s.init) s.init = next.slice();
            else if (s.init.length !== next.length || s.init.some((value, i) => value !== next[i])) {
                throw new Error('This stream changes MP4 initialization data mid-export.');
            }
        }

        source(i) {
            if (!this.src[i]) this.src[i] = { kind: null, tracks: [], init: null, frags: [] };
            return this.src[i];
        }

        async addSegment(srcIndex, data, info) {
            const s = this.source(srcIndex);
            const buf = u8(data);
            let frags = [];
            if (!s.kind && !isTs(buf) && boxes(buf).some(b => b.type === 'moof')) s.kind = 'fmp4'; // fMP4 without EXT-X-MAP
            if (s.kind === 'fmp4') {
                if (!s.init) {
                    // Self-initializing segment: take its ftyp + moov as the init.
                    const top = boxes(buf);
                    const moov = top.find(b => b.type === 'moov');
                    const ftyp = top.find(b => b.type === 'ftyp');
                    if (moov) s.init = concat([ftyp ? buf.slice(ftyp.start, ftyp.end) : new Uint8Array(0), buf.slice(moov.start, moov.end)]);
                }
                frags = repackFragments(buf);
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
                        if (f.length && (!this.wroteInit || this.included.has(t))) frags.push(...f);
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
            if (!s) return [];
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

        async out(bytes) {
            await this.sink.write(bytes);
            this.outPos += bytes.byteLength;
        }

        async writeInit() {
            this.buildIdMaps();
            this.computeOffset();
            const inits = [];
            this.src.forEach((s, i) => { for (const init of this.initOf(s)) inits.push(remapTrackIds(init.slice(), this.idMaps[i])); });
            this.src.forEach(s => s && s.tracks.forEach(t => { if (t.init) this.included.add(t); }));
            await this.out(mergeInits(inits));
            this.wroteInit = true;
        }

        /** Fix one stored fragment (timing, ids, sequence number, base offsets) and write it. */
        async writeFragment(srcIndex, frag) {
            await this.out(this.fixFragment(srcIndex, frag));
        }

        async flushPending() {
            await this.writeInit();
            const included = new Set();
            for (const init of this.initOf(this.src[0])) trackIds(init).forEach(id => included.add(id));
            for (const f of this.pending) {
                // Drop fragments of a track that never produced an init.
                const id = firstTrackId(f);
                if (id < 0 || included.has(id)) await this.writeFragment(0, f);
            }
            this.pending = [];
        }

        /** Remember each track's first decode time (seconds) so the file can start at 0. */
        noteTiming(srcIndex, frags) {
            const s = this.src[srcIndex];
            if (!s.first) s.first = new Map();
            let scales = null;
            for (const f of frags) {
                for (const t of fragTimings(f)) {
                    if (t.off < 0 || s.first.has(t.id)) continue;
                    if (!scales) { scales = new Map(); for (const init of this.initOf(s)) for (const [k, v] of timescales(init)) scales.set(k, v); }
                    const ts = scales.get(t.id);
                    if (ts) s.first.set(t.id, Number(t.base) / ts);
                }
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

        /**
         * Normalizes every traf's tfdt by the shared offset, remaps track ids, numbers mfhd in
         * file order and makes explicit (fragment-relative) tfhd base offsets absolute. Must be
         * called right before the fragment is written: it uses the current output position.
         */
        fixFragment(srcIndex, frag) {
            const dv = view(frag);
            const scales = this.scales && this.scales[srcIndex];
            if (this.offsetSec && scales) {
                for (const t of fragTimings(frag)) {
                    const ts = scales.get(t.id);
                    if (t.off < 0 || !ts) continue;
                    let base = t.base - BigInt(Math.round(this.offsetSec * ts));
                    if (base < 0n) base = 0n;
                    if (t.v1) dv.setBigUint64(t.off, base);
                    else dv.setUint32(t.off, Number(base & 0xFFFFFFFFn)); // only ever decreases: fits
                }
            }
            remapTrackIds(frag, this.idMaps[srcIndex]);
            const pos = BigInt(this.outPos);
            for (const moof of boxes(frag)) {
                if (moof.type !== 'moof') continue;
                walk(frag, (b) => {
                    const body = b.start + b.hdr;
                    if (b.type === 'mfhd') dv.setUint32(body + 4, ++this.seq);
                    if (b.type === 'tfhd' && (dv.getUint32(body) & TFHD_BASE_DATA_OFFSET)) {
                        dv.setBigUint64(body + 8, BigInt.asUintN(64, dv.getBigUint64(body + 8) + pos + BigInt(moof.start)));
                    }
                }, moof.start + moof.hdr, moof.end);
            }
            return frag;
        }

        async openSpool(s) {
            if (s.spool !== undefined) return s.spool;
            s.spool = null;
            const dir = await navigator.storage?.getDirectory?.().catch(() => null);
            if (!dir) return null;
            const name = 'export-mux-' + crypto.randomUUID();
            try {
                const handle = await dir.getFileHandle(name, { create: true });
                if (!handle.createWritable) { await dir.removeEntry(name); return null; }
                const writable = await handle.createWritable();
                s.spool = { dir, name, handle, writable, size: 0 };
            } catch (_) { await dir.removeEntry(name).catch(() => {}); }
            return s.spool;
        }

        async discardFragments() {
            for (const s of this.src) {
                if (!s) continue;
                s.frags = [];
                const spool = s.spool;
                if (!spool) continue;
                s.spool = null;
                if (spool.writable) await spool.writable.abort().catch(() => {});
                await spool.dir.removeEntry(spool.name).catch(() => {});
            }
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
                for (const f of frags) await this.writeFragment(0, f);
                return;
            }
            // Keep interleaving metadata in memory and spool media to disk where supported.
            const source = this.src[srcIndex];
            const spool = await this.openSpool(source);
            const blob = spool ? null : new Blob(frags);
            let p = spool?.size || 0;
            for (const f of frags) {
                if (spool) await spool.writable.write(f);
                const t = fragTimings(f).filter(x => x.off >= 0).map(x => [x.id, x.base]);
                source.frags.push({ blob, start: p, end: p + f.byteLength, t });
                p += f.byteLength;
            }
            if (spool) spool.size = p;
        }

        /** Decode time (seconds, before the shared offset) of a stored fragment, or NaN. */
        fragTime(srcIndex, item) {
            let min = Infinity;
            const scales = this.scales[srcIndex];
            for (const [id, base] of item.t) {
                const ts = scales && scales.get(id);
                if (ts) min = Math.min(min, Number(base) / ts);
            }
            return Number.isFinite(min) ? min : NaN;
        }

        /** Write every source's fragments merged in ascending decode time (ties: lower source). */
        async writeInterleaved() {
            const queues = await Promise.all(this.src.map(async (s, i) => {
                let file;
                if (s.spool) {
                    await s.spool.writable.close();
                    s.spool.writable = null;
                    file = await s.spool.handle.getFile();
                }
                let last = -Infinity; // untimed fragments follow the previous one of their source
                const times = s.frags.map(item => {
                    const t = this.fragTime(i, item);
                    if (!Number.isNaN(t)) last = t;
                    return last;
                });
                return { items: s.frags, times, file, k: 0 };
            }));
            for (;;) {
                let best = -1;
                for (let i = 0; i < queues.length; i++) {
                    const q = queues[i];
                    if (q.k >= q.items.length) continue;
                    if (best < 0 || q.times[q.k] < queues[best].times[queues[best].k]) best = i;
                }
                if (best < 0) break;
                const q = queues[best];
                const item = q.items[q.k];
                q.items[q.k++] = null; // let the Blob go once every fragment of it is written
                const buf = new Uint8Array(await (item.blob || q.file).slice(item.start, item.end).arrayBuffer());
                await this.writeFragment(best, buf);
            }
            for (const s of this.src) s.frags = [];
        }

        async finish() {
            if (this.sourceCount === 1 && !this.wroteInit && this.pending.length && this.initOf(this.src[0]).length) await this.flushPending();
            if (this.sourceCount > 1) {
                if (!this.src.length || this.src.some(s => !s || !this.initOf(s).length)) throw new Error('A track produced no media');
                await this.writeInit();
                try { await this.writeInterleaved(); }
                finally { await this.discardFragments(); }
            }
            if (!this.wroteInit) throw new Error('Nothing could be converted to MP4');
            await this.sink.close();
        }
    }

    window.VelostreamMux = Object.freeze({ ExportMuxer, isTs, mergeInits, boxes });
})();
