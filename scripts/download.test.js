import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpoint, validateExportRange } from '../background/download-store.js';
import { exportMediaType, retryAfterDeadline, SegmentDownloader } from '../background/downloader.js';
import { parseMedia, segmentKey } from '../background/hls-parser.js';

const signal = new AbortController().signal;
const bytes = (...values) => Uint8Array.from(values).buffer;

test('Retry-After accepts seconds and HTTP dates and ignores unusable values', () => {
    const now = Date.UTC(2026, 0, 1);
    assert.equal(retryAfterDeadline(' 12 ', now), now + 12000);
    assert.equal(retryAfterDeadline(new Date(now + 5000).toUTCString(), now), now + 5000);
    for (const header of [undefined, '', '-2', 'later', '1.5', new Date(now - 5000).toUTCString()]) {
        assert.equal(retryAfterDeadline(header, now), 0);
    }
});

test('a long server cooldown blocks range fallback and same-origin requests while another origin proceeds', async () => {
    const requests = [];
    const downloader = new SegmentDownloader({
        getSettings: () => ({ rangeAccel: true }), abr: { reportSegmentDownload() {} },
        transport: async (url, options) => {
            requests.push({ url, range: options.headers.Range });
            return url.startsWith('https://busy.test/')
                ? { status: 503, headers: { 'retry-after': '90' } }
                : { status: 200, headers: {}, data: bytes(7) };
        }
    });
    await assert.rejects(downloader._fetchWithRetry('https://busy.test/a', {
        method: 'GET', headers: { Range: 'bytes=0-2097151' }
    }, signal, true, true), { status: 503 });
    const issued = requests.length;
    assert.ok(issued > 0 && requests.every(req => req.range));
    await assert.rejects(downloader.fetchProgressiveRange('https://busy.test/b', {}, signal), { status: 503 });
    assert.equal(requests.length, issued);
    assert.equal((await downloader.fetchProgressiveRange('https://ready.test/b', {}, signal)).status, 200);
});

test('429 delays a retry until the server deadline and allows cancellation while waiting', async () => {
    const calls = [];
    const downloader = new SegmentDownloader({
        abr: { reportSegmentDownload() {} },
        transport: async () => {
            calls.push(Date.now());
            return calls.length === 1 ? { status: 429, headers: { 'retry-after': '1' } } : { status: 200 };
        }
    });
    const result = downloader.fetchProgressiveRange('https://busy.test/one', {}, signal);
    await new Promise(resolve => setImmediate(resolve));
    const controller = new AbortController();
    const cancelled = downloader.fetchProgressiveRange('https://busy.test/two', {}, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    await result;
    assert.equal(calls.length, 2);
    assert.ok(calls[1] - calls[0] >= 1000);
});

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

test('paused prefetch stops at the disk budget and resumes after playback starts', () => {
    const mb = 1024 * 1024;
    const buffer = { capBytes: 4 * mb, currentSize: mb - 1, reserved: 1 };
    const downloader = new SegmentDownloader({ buffer, getSettings: () => ({ pausedBufferMB: 1 }) });
    downloader._bufferReady = true;
    let starts = 0;
    downloader._buildQueue = () => [{ key: 'test' }];
    downloader._startPrefetch = () => { starts++; };
    downloader._pump();
    assert.equal(starts, 0);
    downloader.playback.paused = false;
    downloader._pump();
    assert.equal(starts, 1);
});

test('download format detection rejects text responses and identifies actual media', () => {
    const encode = text => new TextEncoder().encode(text);
    const html = encode('<!doctype html><html><title>Access denied</title></html>');
    for (const text of ['#EXTM3U\n#EXTINF:5', 'WEBVTT\n', '{"error":"expired"}', '<MPD></MPD>']) {
        assert.equal(exportMediaType(encode(text)), null);
    }
    assert.equal(exportMediaType(html), null);
    const mp4 = Uint8Array.from([0, 0, 0, 16, ...encode('ftypisom'), 0, 0, 0, 0]);
    assert.deepEqual(exportMediaType(mp4), { mime: 'video/mp4', offset: 0 });
    assert.deepEqual(exportMediaType(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x81, 0)), { mime: 'video/webm', offset: 0 });
    const cluster = bytes(0x1f, 0x43, 0xb6, 0x75, 0x81, 0);
    assert.equal(exportMediaType(cluster), null);
    assert.equal(exportMediaType(cluster, { webmFragment: true }).mime, 'video/webm');
});
