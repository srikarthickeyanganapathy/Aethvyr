import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { SegmentDownloader } from '../background/downloader.js';
import { PrefetchBudget } from '../background/resource-policy.js';
import { segmentKey } from '../background/hls-parser.js';

const payload = await readFile(new URL('./fixtures/seek-video.mp4', import.meta.url));
const segments = 24;
const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n' +
    Array.from({ length: segments + 1 }, (_, i) => `#EXTINF:4,\n${i}.mp4\n`).join('') + '#EXT-X-ENDLIST';

const profiles = process.argv.includes('--mixed') ? ['eco', 'max'] : ['balanced', 'balanced'];

async function run(origins) {
    const servers = [];
    const sessions = [];
    const progress = [0, 0];
    const active = [0, 0];
    const peak = [0, 0];
    let peakTotal = 0;
    let halfway;
    const budget = new PrefetchBudget(8, () => sessions.forEach(d => d.schedulePump()));
    try {
        for (let i = 0; i < origins; i++) {
            const server = createServer((req, res) => {
                const session = Number(req.url.split('/')[1]);
                active[session]++;
                peak[session] = Math.max(peak[session], active[session]);
                peakTotal = Math.max(peakTotal, active[0] + active[1]);
                res.once('close', () => { active[session]--; });
                setTimeout(() => res.end(payload), 20);
            });
            server.listen(0, '127.0.0.1');
            await once(server, 'listening');
            servers.push(server);
        }
        const started = performance.now();
        for (let i = 0; i < 2; i++) {
            const base = `http://127.0.0.1:${servers[i % origins].address().port}/${i}/`;
            const cached = new Set();
            const downloader = new SegmentDownloader({
                transport: async (url, options) => {
                    const response = await fetch(url, options);
                    return { status: response.status, headers: {}, data: await response.arrayBuffer(), url };
                },
                buffer: {
                    has: key => cached.has(key),
                    async storeSegment(key, data) {
                        assert.equal(data.byteLength, payload.length);
                        assert.ok(!cached.has(key), 'Duplicate segment');
                        cached.add(key);
                        progress[i]++;
                        if (progress[0] + progress[1] === segments) halfway = [...progress];
                        return true;
                    }
                },
                abr: { reportSegmentDownload() {} },
                getSettings: () => ({ resourceProfile: profiles[i], maxWorkers: 8, maxBufferSec: 120 }),
                sessionCount: () => 2,
                takePrefetchSlot: () => budget.take()
            });
            sessions.push(downloader);
            // Keep all segments within the shorter Eco prefetch window.
            const playlist = profiles.includes('eco') ? manifest.replaceAll('#EXTINF:4,', '#EXTINF:2,') : manifest;
            downloader.ingestPlaylist(base + 'index.m3u8', playlist);
            downloader.noteRequest(segmentKey(base + '0.mp4'));
            downloader.updatePlayback({ paused: false });
        }
        while (progress.some(n => n < segments)) {
            assert.ok(performance.now() - started < 10000, 'Prefetch stalled');
            await delay(2);
        }
        assert.equal(budget.active, 0);
        assert.ok(peakTotal <= 8);
        assert.ok(peak.every((n,i) => n <= (profiles[i] === 'eco' ? 2 : 4)));
        return { origins, profiles, elapsedMs: Math.round(performance.now() - started), peak, peakTotal, halfway,
            bytesPerSession: sessions.map(d => d.stats.bytesDownloaded) };
    } finally {
        sessions.forEach(d => d.destroy());
        await Promise.all(servers.map(server => new Promise(resolve => {
            server.close(resolve);
            server.closeAllConnections();
        })));
    }
}

for (let trial = 1; trial <= 5; trial++) {
    for (const origins of trial % 2 ? [1, 2] : [2, 1]) {
        console.log(JSON.stringify({ trial, ...await run(origins) }));
    }
}
