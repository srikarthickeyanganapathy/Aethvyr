import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const script = readFileSync(new URL('../player/mp4-mux.js', import.meta.url), 'utf8');
const context = createContext({ window: {}, TextEncoder, Uint8Array, ArrayBuffer, DataView, Blob, navigator: {} });
runInContext(script, context);
const { ExportMuxer, boxes } = context.window.VelostreamMux;
const decoder = new TextDecoder();

const body = box => box.start + box.hdr;
const children = (bytes, box) => boxes(bytes, body(box), box.end);
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

async function muxFixtures(files) {
    const parts = [];
    let patched = false;
    const sink = {
        write: bytes => { parts.push(Buffer.from(bytes)); },
        rewriteHeader: bytes => {
            assert.equal(bytes.byteLength, parts[0].byteLength);
            parts[0] = Buffer.from(bytes);
            patched = true;
        },
        close: () => assert.ok(patched, 'the movie header must be finalized before the file closes')
    };
    const mux = new ExportMuxer(sink, files.length);
    for (const [index, name] of files.entries()) {
        const input = readFileSync(new URL('fixtures/' + name, import.meta.url));
        const top = boxes(input);
        const firstFragment = top.find(box => box.type === 'moof');
        const init = input.slice(0, firstFragment.start);
        const moov = boxes(init).find(box => box.type === 'moov');
        const mvhd = children(init, moov).find(box => box.type === 'mvhd');
        view(init).setUint32(body(mvhd) + 16, 4 * view(init).getUint32(body(mvhd) + 12));
        await mux.addInit(index, init);
        for (let i = 0; i < top.length - 1; i++) {
            if (top[i].type === 'moof') await mux.addSegment(index, input.subarray(top[i].start, top[i + 1].end), {});
        }
    }
    await mux.finish();
    return Buffer.concat(parts);
}

function assertSeekable(bytes, expectedTracks) {
    const top = boxes(bytes);
    const dv = view(bytes);
    const movie = children(bytes, top.find(box => box.type === 'moov'));
    const header = body(movie.find(box => box.type === 'mvhd'));
    const seconds = dv.getUint32(header + 16) / dv.getUint32(header + 12);
    assert.ok(seconds >= 12 && seconds < 12.2, 'duration must reflect all fragments: ' + seconds);
    assert.equal(movie.filter(box => box.type === 'trak').length, expectedTracks);
    const mvex = movie.find(box => box.type === 'mvex');
    const mehd = children(bytes, mvex).find(box => box.type === 'mehd');
    assert.equal(Number(dv.getBigUint64(body(mehd) + 4)), dv.getUint32(header + 16));
    const mfra = top.at(-1);
    assert.equal(mfra.type, 'mfra');
    const tables = children(bytes, mfra);
    const ids = new Set();
    for (const tfra of tables.filter(box => box.type === 'tfra')) {
        const offset = body(tfra);
        ids.add(dv.getUint32(offset + 4));
        assert.ok(dv.getUint32(offset + 12) >= 3, 'seek index covers later fragments');
        for (let i = 0; i < dv.getUint32(offset + 12); i++) {
            const position = Number(dv.getBigUint64(offset + 16 + i * 28 + 8));
            assert.equal(decoder.decode(bytes.subarray(position + 4, position + 8)), 'moof');
        }
    }
    assert.equal(ids.size, expectedTracks, 'audio and video use distinct remapped track IDs');
    assert.equal(dv.getUint32(body(tables.at(-1)) + 4), mfra.end - mfra.start);
}

test('MP4 finalization replaces a stale four-second header and indexes 12 seconds of video', async () => {
    assertSeekable(await muxFixtures(['seek-video.mp4']), 1);
});

test('separate audio and video are indexed and contribute to the complete movie duration', async () => {
    assertSeekable(await muxFixtures(['seek-video.mp4', 'seek-audio.m4a']), 2);
});

export { muxFixtures };
