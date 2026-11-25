import assert from 'node:assert/strict';
import test from 'node:test';
import '../common/shared.js';
import '../player/diagnostics.js';
import { compactEntry, expandEntry, initSync, sanitizeHistEntry, syncPageUrl } from '../background/sync.js';
import { PrefetchBudget, prefetchPolicy } from '../background/resource-policy.js';

test('account sync keeps stable page navigation and drops stream URLs and page credentials', () => {
    const signed = 'https://cdn.example/video.m3u8?token=private-token';
    const page = 'https://example.test/watch/episode-4?auth=private-token#private';
    const old = ['entry', signed, page, 'Episode 4', 20, 120, 0, 1000];
    assert.deepEqual(sanitizeHistEntry(old).slice(0, 4), ['entry', '', 'https://example.test/watch/episode-4', 'Episode 4']);
    assert.equal(syncPageUrl('https://you:pass@example.test/watch'), '');
    assert.equal(syncPageUrl('https://example.test/token/secret'), '');
    assert.equal(syncPageUrl('https://example.test/watch;token=secret'), '');
    assert.equal(syncPageUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=token'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const synced = compactEntry('entry', { url: signed, page, t: 30, d: 120, updatedAt: 1001, title: 'Episode' });
    assert.equal(expandEntry(synced).url, '');
    assert.equal(expandEntry(synced, { url: signed, page }).url, signed);
    assert.equal(expandEntry(synced, { url: signed, page }).t, 30);
    assert.equal(compactEntry('direct', { url: signed, title: 'Direct media', updatedAt: 1001 })[2], '');
});

function memoryStorage(values = {}) {
    const data = structuredClone(values);
    return {
        data,
        async get(keys) {
            if (keys == null) return structuredClone(data);
            return Object.fromEntries([keys].flat().filter(key => key in data).map(key => [key, structuredClone(data[key])]));
        },
        async set(patch) { Object.assign(data, structuredClone(patch)); },
        async remove(keys) { for (const key of [keys].flat()) delete data[key]; }
    };
}

test('Aethvyr restores and re-exports a Velostream backup with its original storage identity', async () => {
    const local = memoryStorage();
    const api = { storage: { local } };
    const legacy = {
        app: 'velostream', version: 2, settings: { maxWorkers: 3 },
        bookmarks: { fs_bm_episode: [{ t: 17, label: 'Return here' }] },
        history: { episode: { title: 'Episode', url: 'https://example.test/video.mp4', t: 17, updatedAt: 10 } },
        library: { favorites: ['episode'], collections: [] }
    };
    const shared = globalThis.VelostreamShared;
    await shared.restoreBackup(api, JSON.stringify(legacy));
    assert.equal(local.data.fs_settings.maxWorkers, 3);
    assert.equal(local.data.fs_history.episode.t, 17);
    assert.deepEqual(local.data.fs_bm_episode, legacy.bookmarks.fs_bm_episode);
    assert.deepEqual(local.data.fs_library.favorites, ['episode']);
    const exported = await shared.buildBackup(api);
    assert.equal(exported.app, legacy.app);
    assert.equal(exported.version, legacy.version);
    assert.deepEqual(exported.bookmarks, legacy.bookmarks);
    assert.match(shared.backupFilename(), /^aethvyr-backup-/);
});

test('sync round trip merges newer positions without replacing local stream URLs', async () => {
    const S = globalThis.VelostreamShared;
    const signed = 'https://cdn.example/playlist.m3u8?token=must-stay-local';
    const remote = memoryStorage();
    const clock = { now: () => 600000, setTimeout: () => 1, clearTimeout() {} };
    const local = (time, updatedAt) => memoryStorage({
        [S.SETTINGS_KEY]: { syncEnabled: true },
        [S.HISTORY_KEY]: { episode: { title: 'Episode', url: signed, page: 'https://example.test/show/1?token=private', t: time, d: 100, updatedAt } }
    });
    const start = async localArea => {
        const ctl = initSync({ api: { storage: { local: localArea, sync: remote, session: memoryStorage(), onChanged: { addListener() {} } } }, S, clock });
        await ctl.ready;
        await ctl.whenIdle();
        return ctl;
    };
    const source = await start(local(25, 3000));
    await source.syncNow();
    assert.equal(remote.data.vs_meta.v, 2);
    assert.equal(remote.data.vs_meta.s.hist.n, 1);
    const target = local(10, 1000);
    await start(target);
    assert.equal(target.data[S.HISTORY_KEY].episode.t, 25);
    assert.equal(target.data[S.HISTORY_KEY].episode.url, signed);
    const freshDevice = memoryStorage({ [S.SETTINGS_KEY]: { syncEnabled: true } });
    await start(freshDevice);
    assert.equal(freshDevice.data[S.HISTORY_KEY].episode.url, '');
    assert.equal(freshDevice.data[S.HISTORY_KEY].episode.page, 'https://example.test/show/1');
});

test('diagnostics export contains numeric media metrics and omits arbitrary strings and URLs', () => {
    const report = globalThis.VelostreamDiagnostics.build({
        version: '2.7.0', userAgent: 'Mozilla/5.0 Firefox/128.1', transport: 'hls',
        media: { width: 1920, codecs: 'avc1.640028, https://cdn.example/private?secret=1' },
        network: { lastLatencyMs: 25.15, url: 'https://cdn.example/private' },
        errors: { shakaCode: 1001, message: 'private-token' },
        history: Array.from({ length: 80 }, () => ({ bufferSeconds: 8, url: 'https://cdn.example' }))
    });
    assert.deepEqual(report.browser, { family: 'Firefox', version: '128.1' });
    assert.deepEqual(report.media.codecs, ['avc1.640028']);
    assert.equal(report.network.lastLatencyMs, 25.2);
    assert.equal(report.bufferHistory.length, 60);
    assert.doesNotMatch(JSON.stringify(report), /cdn\.example|https?:|private-token/);
});

test('adaptive prefetch respects user ceilings and shares a hard budget across sessions', () => {
    const settings = { maxBufferSec: 86400, maxWorkers: 8 };
    assert.deepEqual(prefetchPolicy({ ...settings, resourceProfile: 'eco' }), { windowSeconds: 60, workers: 2 });
    assert.deepEqual(prefetchPolicy({ ...settings, resourceProfile: 'balanced' }, 3), { windowSeconds: 180, workers: 2 });
    assert.deepEqual(prefetchPolicy({ ...settings, resourceProfile: 'max', maxBufferSec: 50, maxWorkers: 3 }), { windowSeconds: 50, workers: 3 });
    assert.deepEqual(prefetchPolicy({ ...settings, resourceProfile: 'custom' }), { windowSeconds: 86400, workers: 8 });
    let released = 0;
    const budget = new PrefetchBudget(2, () => { released++; });
    const releaseOne = budget.take();
    const releaseTwo = budget.take();
    assert.equal(budget.take(), null);
    releaseOne();
    releaseOne();
    assert.equal(released, 1);
    assert.equal(typeof budget.take(), 'function');
    releaseTwo();
    assert.equal(budget.active, 1);
});
