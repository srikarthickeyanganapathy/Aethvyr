import assert from 'node:assert/strict';
import test from 'node:test';
import '../common/shared.js';
import '../content/media-elements.js';
import { cloneSettings, overlaySettings } from '../player/settings-overlay.js';
import { fileBaseName, recordingSegments } from '../background/export-plan.js';
import { restoreTab, snapshotTab, subtitlesForStorage, visibleStreams } from '../background/tab-state.js';
import { parseSubtitleFile } from '../player/subtitle-parser.js';
import { SubtitleEngine } from '../player/subtitle-engine.js';
import { EnginePort } from '../player/engine-port.js';
import { PortClient } from '../player/port-client.js';
import { parseMaster } from '../background/hls-parser.js';
import { PrivateBuffer } from '../background/private-buffer.js';
import { HttpError, retryAfterDeadline } from '../background/downloader.js';

test('master playlists resolve variant URLs and preserve quoted codec pairs', () => {
    const master = parseMaster('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=512000,CODECS="avc1.42E01E,mp4a.40.2",RESOLUTION=640x360\n../video.m3u8', 'https://fixture.invalid/a/master.m3u8');
    const [variant] = master.variants;
    assert.equal(variant.uri, 'https://fixture.invalid/video.m3u8');
    assert.equal(variant.codecs, 'avc1.42E01E,mp4a.40.2');
    assert.equal(variant.height, 360);
});

test('reducing private cache capacity evicts oldest bytes and counts duplicate keys once', async () => {
    const cache = new PrivateBuffer(2);
    const bytes = new ArrayBuffer(700000);
    for (const key of ['first', 'first', 'second']) await cache.storeSegment(key, bytes, 'video/mp4');
    assert.equal(cache.currentSize, 1400000);
    cache.setCapacity(1);
    assert.deepEqual([...cache.keys.keys()], ['second']);
    assert.equal(cache.currentSize, bytes.byteLength);
});

test('legacy cache, graphics and nested settings normalize idempotently', () => {
    const legacy = { settingsVersion: 2, cacheSizeMB: 1000, shader: 'fsr', audio: { boost: 170 } };
    const { mergeSettings } = globalThis.VelostreamShared;
    const settings = mergeSettings(legacy);
    assert.equal(settings.cacheSizeMB, 1024);
    assert.equal(settings.shader, 'cas');
    assert.equal(settings.audio.boost, 170);
    assert.deepEqual(mergeSettings(settings), settings);
    assert.equal(legacy.cacheSizeMB, 1000);
});

test('HTTP errors retain status and extreme retry delays saturate without wrapping', () => {
    assert.equal(new HttpError(503, 'fixture').status, 503);
    assert.equal(retryAfterDeadline('9'.repeat(40), 1000), Number.MAX_SAFE_INTEGER);
    assert.equal(retryAfterDeadline('Thu, 01 Jan 1970 00:00:01 GMT', 2000), 0);
});

test('worker restart rehydrates stream indexes, selected session and bounded subtitles', () => {
    const legacy = { streams: [{ id: 'one', url: 'one' }, { id: 'variant', url: 'two' }],
        children: ['two'], mountFrameId: 0, playerSessionId: 'session', mseFrames: [[0, 1]], videoFrames: [0] };
    const subs = subtitlesForStorage([{ url: 'sidecar', vtt: 'x'.repeat(1500001) }, { vtt: 'cue' }]);
    const tab = restoreTab(17, legacy, subs);
    const restored = restoreTab(17, structuredClone(snapshotTab(tab)), subs);
    assert.equal(restored.byUrl.get('one'), 'one');
    assert.equal(restored.playerSessionId, 'session');
    assert.equal(restored.mountFrameId, 0);
    assert.deepEqual(visibleStreams(restored).map(s => s.id), ['one']);
    assert.deepEqual(restored.subtitles, [{ url: 'sidecar', vtt: '' }, { vtt: 'cue' }]);
});

test('runtime reconnect replays only outstanding requests after resumed INIT', async () => {
    const ports = [];
    let connected;
    const reconnected = new Promise(resolve => { connected = resolve; });
    const listeners = new Set();
    const event = () => {
        let listener;
        return { addListener(fn) { listener = fn; }, fire(msg) { listener(msg); } };
    };
    const shared = { api: { storage: { onChanged: {
        addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn)
    } }, runtime: { connect({ name }) {
        assert.equal(name, 'velostream-player');
        const port = { sent: [], onMessage: event(), onDisconnect: event(),
            postMessage(msg) { this.sent.push(msg); }, disconnect() {} };
        ports.push(port);
        if (ports.length === 2) connected();
        return port;
    } } } };
    const client = new EnginePort({ sessionId: 's', streamId: 'v', shared });
    try {
        for (const reqId of ['completed', 'cancelled', 'pending']) client.postMessage({ type: 'REQUEST', reqId });
        client.postMessage({ type: 'ABORT', reqId: 'cancelled' });
        await new Promise(resolve => setImmediate(resolve));
        ports[0].onMessage.fire({ type: 'RESPONSE', reqId: 'completed' });
        ports[0].onDisconnect.fire();
        await reconnected;
        assert.deepEqual(ports[1].sent, [{ type: 'HELLO', sessionId: 's', streamId: 'v', resumed: true }]);
        ports[1].onMessage.fire({ type: 'INIT' });
        assert.deepEqual(ports[1].sent[1], { type: 'REQUEST', reqId: 'pending' });
        assert.equal(ports[1].sent.length, 2);
    } finally {
        client.close();
    }
    assert.equal(listeners.size, 0);
    assert.equal(client.pending.size, 0);
});

test('player close settles unanswered UI requests and releases their timers', async () => {
    const client = new PortClient({ postMessage() {}, close() {} }, () => {});
    const pending = client.request('SETTINGS_GET');
    client.close();
    await assert.rejects(pending, /Player closed/);
    assert.equal(client.waiters.size, 0);
});

test('subtitle parsing and displayer keep cue timing, escaped text and deduplication', async () => {
    const cues = parseSubtitleFile('WEBVTT\n\n00:01.0 --> 00:02.500\n<i>A &amp; B</i>');
    assert.deepEqual(cues, [{ start: 1, end: 2.5, text: 'A & B' }]);
    assert.deepEqual(SubtitleEngine.activeAt(cues, 2.5), []);
    assert.match(SubtitleEngine.linesHtml(['A & B']), /A &amp; B/);
    const engine = new SubtitleEngine(null, null);
    const displayer = engine.createDisplayer();
    const cue = { startTime: 1, endTime: 2, payload: 'text' };
    displayer.append([cue, cue]);
    assert.equal(engine.shakaCues.length, 1);
    await displayer.destroy();
    assert.equal(engine.shakaKeys.size, 0);
});

test('partial settings overlays retain sibling fields and isolate EQ arrays', () => {
    const original = { audio: { boost: 140, eq: [0, 1] }, theme: 'rose' };
    const settings = cloneSettings(original);
    overlaySettings(settings, { audio: { boost: 180, eq: [2, 3] }, theme: 'blue' }, { audio: { boost: true } });
    settings.audio.eq[0] = 7;
    assert.deepEqual(original.audio.eq, [0, 1]);
    assert.deepEqual(settings, { audio: { boost: 180, eq: [7, 1] }, theme: 'rose' });
});

test('recording selection honors rendition sequence and export naming preserves titles', () => {
    const segments = [{ seq: 10 }, { seq: 11 }, { seq: 12 }];
    assert.deepEqual(recordingSegments({ fromSeqByUrl: { audio: 11 } }, { url: 'audio' }, segments), segments.slice(1));
    assert.equal(fileBaseName({}, ' Episode 2.mp4'), 'Episode 2');
});

test('mount candidate selection weights a playing video and matching media URL', () => {
    const candidate = (src, paused, width) => ({ tagName: 'VIDEO', src, paused, getBoundingClientRect: () => ({ width, height: 100 }) });
    const big = candidate('large', true, 350);
    const playing = candidate('small', false, 200);
    const { pickVideo } = globalThis.AethvyrMediaElements;
    assert.equal(pickVideo([big, playing], null), playing);
    assert.equal(pickVideo([big, playing], 'large'), big);
});
