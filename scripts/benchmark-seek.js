import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { SegmentDownloader } from '../background/downloader.js';
import { segmentKey } from '../background/hls-parser.js';
import { PrefetchBudget } from '../background/resource-policy.js';

const bytes = await readFile(new URL('./fixtures/seek-video.mp4', import.meta.url));
const profiles = ['eco', 'max'];
const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n' +
    Array.from({ length: 120 }, (_, i) => `#EXTINF:2,\n${i}.mp4\n`).join('') + '#EXT-X-ENDLIST';
const targetIndex = 90;

const compare = process.argv.includes('--compare-priority');
const observationMs = 2000;

async function trial(seeker, competing, deferPrefetch) {
    const downloads = [];
    const transfers = new Map();
    const requests = new Map();
    let observePeer;
    const server = createServer((req, res) => {
        requests.set(req.url, (requests.get(req.url) || 0) + 1);
        transfers.set(res, 0);
        res.once('close', () => transfers.delete(res));
        res.writeHead(200, { 'content-length': bytes.length, 'content-type': 'video/mp4' });
    });
    // One shared budget across all responses. Discard unused capacity each tick.
    const tick = setInterval(() => {
        const allowance = Math.floor(2500 / transfers.size);
        for (const [res, sent] of transfers) {
            const end = Math.min(bytes.length, sent + allowance);
            res.write(bytes.subarray(sent, end));
            if (end === bytes.length) {
                transfers.delete(res);
                res.end();
            } else transfers.set(res, end);
        }
    }, 10);
    const budget = new PrefetchBudget(8, () => downloads.forEach(d => d.schedulePump()));
    try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const origin = 'http://127.0.0.1:' + server.address().port;
        for (const profile of profiles) {
            const cache = new Map();
            const downloader = new SegmentDownloader({
                transport: async (url, opts) => {
                    const res = await fetch(url, opts);
                    return { url, status: res.status, headers: {}, data: await res.arrayBuffer() };
                },
                buffer: {
                    has: key => cache.has(key),
                    getSegment: async key => cache.get(key),
                    async storeSegment(key, data, mime) {
                        if (profile !== seeker) observePeer?.();
                        cache.set(key, { data, mime });
                        return true;
                    },
                    markServed() {}
                },
                abr: { reportSegmentDownload() {} },
                getSettings: () => ({ resourceProfile: profile, maxWorkers: 8, maxBufferSec: 120 }),
                sessionCount: () => 2,
                takePrefetchSlot: () => budget.take(),
                prioritizeSeek: deferPrefetch ? () => budget.prioritizeSeek() : undefined
            });
            downloads.push(downloader);
            if (!competing && profile !== seeker) downloader.pause();
            downloader.ingestPlaylist(origin + '/' + profile + '/index.m3u8', playlist);
            downloader.noteRequest(segmentKey(origin + '/' + profile + '/0.mp4'));
            downloader.updatePlayback({ paused: false });
        }
        const expected = competing ? 6 : seeker === 'eco' ? 2 : 4;
        const deadline = performance.now() + 5000;
        while (transfers.size !== expected) {
            assert.ok(performance.now() < deadline, 'Initial prefetch load did not stabilize');
            await delay(2);
        }
        const downloader = downloads[profiles.indexOf(seeker)];
        const targetPath = '/' + seeker + '/' + targetIndex + '.mp4';
        assert.ok(!requests.has(targetPath), 'Seek target must be cold');
        const start = performance.now();
        // Model a peer playing at 1x with half a second already decoded. Only
        // contiguous completed segments can extend its playable timeline.
        const peer = downloads[1 - profiles.indexOf(seeker)];
        let last = start;
        let playedMs = 0;
        let stalledMs = 0;
        let minAheadMs = Infinity;
        let finalAheadMs;
        if (compare) observePeer = () => {
            if (finalAheadMs !== undefined) return;
            const now = Math.min(performance.now(), start + observationMs);
            const available = Math.max(0, 500 + peer.cachedAheadSeconds() * 1000 - playedMs);
            const interval = now - last;
            const played = Math.min(interval, available);
            playedMs += played;
            stalledMs += interval - played;
            minAheadMs = Math.min(minAheadMs, available - played);
            if (now >= start + observationMs) finalAheadMs = available - played;
            last = now;
        };
        downloader.seek(targetIndex * 2);
        const res = await downloader.load({ url: origin + targetPath, kind: 'segment', signal: AbortSignal.timeout(5000) });
        const elapsed = Math.round(performance.now() - start);
        assert.deepEqual(Buffer.from(res.data), bytes);
        assert.equal(requests.get(targetPath), 1);
        if (!compare) return elapsed;
        while (finalAheadMs === undefined) {
            await delay(Math.max(1, Math.ceil(start + observationMs - performance.now())));
            observePeer();
        }
        observePeer = null;
        return { seekMs: elapsed, minPeerAheadMs: Math.round(minAheadMs), peerStallMs: Math.round(stalledMs),
            finalPeerAheadMs: Math.round(finalAheadMs) };
    } finally {
        downloads.forEach(d => d.destroy());
        clearInterval(tick);
        const closed = once(server, 'close');
        server.close();
        server.closeAllConnections();
        await closed;
    }
}

const cases = profiles.flatMap(seeker => [false, true].map(toggle => ({
    seeker, competing: compare || toggle, deferPrefetch: compare && toggle, samples: []
})));
for (let round = 0; round < 5; round++) {
    for (let i = 0; i < cases.length; i++) {
        const scenario = cases[(i + round) % cases.length];
        scenario.samples.push(await trial(scenario.seeker, scenario.competing, scenario.deferPrefetch));
    }
}
for (const scenario of cases) {
    const times = scenario.samples.map(s => compare ? s.seekMs : s);
    console.log(JSON.stringify({ ...scenario, medianMs: times.sort((a, b) => a - b)[2] }));
}
