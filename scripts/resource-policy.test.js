import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { cacheShareMB, NetworkBudget, PrefetchBudget, prefetchPolicy } from '../background/resource-policy.js';
import { BufferManager } from '../background/buffer-manager.js';
import { SegmentDownloader } from '../background/downloader.js';

test('custom bandwidth paces speculative requests across sessions and zero cache stops them', () => {
    const settings = { resourceProfile: 'custom', prefetchMbps: 1, maxWorkers: 4 };
    const buffer = { capBytes: 1000000, currentSize: 0, reserved: 0 };
    const d = new SegmentDownloader({ buffer, getSettings: () => settings, sessionCount: () => 2 });
    d._bufferReady = true;
    d._buildQueue = () => [1, 2, 3, 4];
    const issued = [];
    d._startPrefetch = task => issued.push(task);
    d.lastPrefetchStart = Date.now() - 1000;
    d.lastPrefetchBytes = 100000; // 0.8 seconds alone, 1.6 seconds with a peer
    try {
        d._pump();
        assert.equal(issued.length, 0);
        d.lastPrefetchStart -= 1000;
        d._pump();
        assert.equal(issued.length, 1);
        buffer.capBytes = 0;
        d._pump();
        assert.equal(issued.length, 1);
    } finally { d.destroy(); }
});

test('origin limits allow another origin to proceed and release slots after error or cancellation', async () => {
    const budget = new NetworkBudget(2, 1);
    let release;
    const held = budget.run('https://a.test/1', null, () => new Promise(r => { release = r; }));
    const controller = new AbortController();
    const queued = budget.run('https://a.test/2', controller.signal, () => assert.fail('cancelled request started'));
    const next = budget.run('https://a.test/3', null, () => { throw Error('offline'); });
    assert.equal(await budget.run('https://b.test/1', null, () => 'ready'), 'ready');
    controller.abort();
    await assert.rejects(queued, { name: 'AbortError' });
    release();
    await held;
    await assert.rejects(next, /offline/);
    assert.equal(budget.active, 0);
    assert.equal(budget.byOrigin.size, 0);
});

test('repeated seek signals cannot extend a slow seek indefinitely', async () => {
    const budget = new PrefetchBudget(2, () => {});
    const finish = budget.prioritizeSeek();
    assert.equal(budget.take(), null);
    budget.prioritizeSeek()();
    assert.equal(budget.take(), null);
    await delay(780);
    budget.prioritizeSeek();
    const slot = budget.take();
    assert.equal(typeof slot, 'function');
    finish();
    slot();
});

test('cancelled or failed seeks release prefetch immediately', () => {
    const budget = new PrefetchBudget(1, () => {});
    const finish = budget.prioritizeSeek();
    finish();
    finish();
    const slot = budget.take();
    assert.ok(slot);
    slot();
});

test('cache shares honor the local budget, low storage and hidden-tab ceilings', () => {
    const settings = { resourceProfile: 'eco', cacheSizeMB: 1024, maxBufferSec: 900, maxWorkers: 6 };
    assert.equal(cacheShareMB(settings, 2), 64);
    assert.equal(cacheShareMB(settings, 4, 10), 2.5);
    assert.equal(cacheShareMB(settings, 1, 0), 0);
    assert.deepEqual(prefetchPolicy(settings, 1, true), { workers: 1, windowSeconds: 30 });
});

test('admission cannot exceed the byte limit when every existing segment is protected', async () => {
    const buffer = new BufferManager(1, 'test', { capBytes: 1000 });
    buffer.currentSize = 900;
    buffer._evictLocked = async () => 0;
    assert.equal(await buffer._admit('large', 200), false);
    assert.equal(buffer.reserved, 0);
    assert.equal(await buffer._admit('small', 100), true);
    assert.equal(await buffer._admit('next', 1), false);
});
