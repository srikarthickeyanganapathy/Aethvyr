import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpoint, validateExportRange } from '../background/download-store.js';
import { SegmentDownloader } from '../background/downloader.js';
import { parseMedia, segmentKey } from '../background/hls-parser.js';

const signal = new AbortController().signal;
const bytes = (...values) => Uint8Array.from(values).buffer;

test('harvests an exact ranged segment without fetching or marking it played', async () => {
    const segment = { uri: 'https://example.test/video.mp4', range: 'bytes=20-21' };
    const data = bytes(1, 2);
    const downloader = new SegmentDownloader({
        buffer: { getSegment: async (id, options) => {
            assert.equal(id, segmentKey(segment.uri, segment.range));
            assert.equal(options.markServed, false);
            return { data };
        } },
        transport: () => assert.fail('cache hit fetched over the network')
    });
    assert.deepEqual(await downloader.fetchForExport(segment, signal), data);
});

test('a cache-only clip fails on a miss without touching the network', async () => {
    const downloader = new SegmentDownloader({
        buffer: { getSegment: async () => null },
        transport: () => assert.fail('clip miss fetched over the network')
    });
    await assert.rejects(downloader.fetchForExport({ uri: 'https://example.test/missing' }, signal, { cacheOnly: true }), /no longer cached/);
});

function memoryStore(rows = new Map()) {
    return {
        read: async (jobId, index) => rows.get(jobId + '/' + index),
        commit: async (jobId, index, chunk) => { rows.set(jobId + '/' + index, chunk); }
    };
}

test('replays committed segments and fetches only gaps after reconstructing a job', async () => {
    const rows = new Map();
    const oldWorker = memoryStore(rows);
    await checkpoint(oldWorker, 'job', 'seg:0:0', signal, () => ({ data: bytes(0) }));
    await checkpoint(oldWorker, 'job', 'seg:0:2', signal, () => ({ data: bytes(2) }));
    const newWorker = memoryStore(rows);
    const fetched = [];
    const emitted = [];
    for (let i = 0; i < 3; i++) {
        const chunk = await checkpoint(newWorker, 'job', 'seg:0:' + i, signal, () => {
            fetched.push(i);
            return { data: bytes(i) };
        });
        emitted.push(...new Uint8Array(chunk.data));
    }
    assert.deepEqual(fetched, [1]);
    assert.deepEqual(emitted, [0, 1, 2]);
});

test('pausing during a fetch leaves the index missing for the next run', async () => {
    const controller = new AbortController();
    const store = memoryStore();
    await assert.rejects(checkpoint(store, 'job', 'byte:4', controller.signal, () => {
        controller.abort();
        return { data: bytes(1) };
    }), { name: 'AbortError' });
    assert.equal(await store.read('job', 'byte:4'), undefined);
    assert.deepEqual(await checkpoint(store, 'job', 'byte:4', signal, () => ({ data: bytes(2) })), { data: bytes(2) });
});

test('validates exact progressive range offsets, size and total', () => {
    const result = (status, contentRange, length) => ({
        status, headers: { 'content-range': contentRange }, data: new ArrayBuffer(length)
    });
    assert.equal(validateExportRange(result(200, undefined, 10), 0, 4), 10);
    assert.equal(validateExportRange(result(206, 'bytes 4-7/10', 4), 4, 4, 10), 10);
    assert.equal(validateExportRange(result(206, 'bytes 8-9/10', 2), 8, 4, 10), 10);
    assert.throws(() => validateExportRange(result(200, undefined, 10), 4, 4, 10), /Invalid download range/);
    assert.throws(() => validateExportRange(result(206, 'bytes 0-3/10', 4), 4, 4, 10), /Invalid download range/);
    assert.throws(() => validateExportRange(result(206, 'bytes 4-7/11', 4), 4, 4, 10), /Invalid download range/);
    assert.throws(() => validateExportRange(result(206, 'bytes 4-5/10', 2), 4, 4, 10), /Invalid download range/);
});

test('HLS implicit byte ranges only continue the immediately preceding resource', () => {
    const base = 'https://example.test/source.m3u8';
    const continuations = '#EXTM3U\n#EXTINF:4,\n#EXT-X-BYTERANGE:12@10\nfile.mp4\n';
    const next = '#EXTINF:4,\n#EXT-X-BYTERANGE:5\nfile.mp4\n';
    assert.equal(parseMedia(continuations + next, base).segments[1].range, 'bytes=22-26');
    assert.throws(() => parseMedia(continuations + '#EXTINF:4,\nother.mp4\n' + next, base), /Invalid HLS media byte range/);
});

test('an export joins an in-flight prefetch for the same segment', async () => {
    const segment = { uri: 'https://example.test/segment.m4s' };
    const downloader = new SegmentDownloader({
        buffer: { getSegment: async () => null },
        transport: () => assert.fail('started a duplicate network request')
    });
    const data = bytes(3, 4);
    downloader.inflight.set(segmentKey(segment.uri), {
        prefetch: true, promise: Promise.resolve({ status: 200, headers: {}, data })
    });
    assert.deepEqual(await downloader.fetchForExport(segment, signal), data);
});

test('pausing an export stops waiting without aborting playback prefetch', async () => {
    const controller = new AbortController();
    const downloader = new SegmentDownloader({ buffer: { getSegment: async () => null } });
    const url = 'https://example.test/pending.m4s';
    let finish;
    const prefetch = new Promise(resolve => { finish = resolve; });
    downloader.inflight.set(segmentKey(url), { prefetch: true, promise: prefetch });
    const result = downloader.fetchForExport({ uri: url }, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
    finish({ data: bytes(5) });
    assert.deepEqual((await prefetch).data, bytes(5));
});
