import assert from 'node:assert/strict';
import test from 'node:test';
import { captureKey, mediaHeaders, mediaUrl, sameMediaOrigin, allowedAction } from '../background/security-policy.js';
import { sanitizeHistEntry, syncPageUrl } from '../background/sync.js';

const runtime = { id: 'fixture', getURL: path => 'moz-extension://fixture/' + path };
const frame = { id: runtime.id, tab: { id: 4 }, frameId: 2, url: 'https://page.invalid/' };
const popup = { id: runtime.id, url: runtime.getURL('popup/popup.html') };

test('popup actions require the popup identity and a valid destination tab', () => {
    const request = { action: 'LAUNCH_URL', tabId: 4 };
    assert.ok(allowedAction(request, popup, runtime));
    for (const sender of [frame, { ...popup, id: 'other' }, { ...popup, url: popup.url + '.other' }]) {
        assert.equal(allowedAction(request, sender, runtime), false);
    }
    for (const tabId of [null, '4', -1, 2.5]) assert.equal(allowedAction({ ...request, tabId }, popup, runtime), false);
    assert.equal(allowedAction({ action: 'STREAM_FOUND' }, frame, runtime), true);
    assert.equal(allowedAction({ action: 'SETTINGS_PATCH', patch: [] }, popup, runtime), false);
    assert.equal(allowedAction({ action: 'BACKUP_RESTORE', json: 5 }, popup, runtime), false);
});

test('capture scope includes tab, frame, both origins and the exact signed resource', () => {
    const args = [1, 2, 'https://page.invalid', 'https://cdn.invalid/movie?key=test'];
    const original = captureKey(...args);
    for (const [index, value] of [[0, 2], [1, 1], [2, 'https://sub.page.invalid'], [3, 'https://cdn.invalid:8443/movie?key=test'], [3, 'https://cdn.invalid/movie?key=other']]) {
        const changed = [...args];
        changed[index] = value;
        assert.notEqual(captureKey(...changed), original);
    }
    assert.equal(captureKey(-1, ...args.slice(1)), null);
    assert.equal(sameMediaOrigin('https://cdn.invalid:444/s', args[3]), false);
    assert.equal(mediaUrl('https://name:password@fixture.invalid/media'), null);
    assert.equal(mediaUrl('file:///fixture'), null);
});

test('only bounded media request headers are forwarded', () => {
    assert.deepEqual(mediaHeaders({ Range: 'bytes=0-31', Cookie: 'test', Authorization: 'test' }), { Range: 'bytes=0-31' });
    assert.equal(mediaHeaders({ Range: 'all' }), null);
    assert.equal(mediaHeaders({ Accept: 'text/plain\r\nextra' }), null);
    assert.equal(mediaHeaders({ Accept: 'x'.repeat(513) }), null);
});

test('sync omits private navigation and redacts embedded credentials from display text', () => {
    for (const url of ['https://nas/video', 'http://127.0.0.1/watch', 'https://example.invalid/media.m3u8?key=test',
        'https://example.invalid/%2574oken/test']) assert.equal(syncPageUrl(url), '');
    const entry = sanitizeHistEntry(['key', '', 'https://fixture.invalid/watch?id=private', 'Clip token=fixture bearer synthetic', 5, 9, false, 100]);
    assert.equal(entry[2], 'https://fixture.invalid/watch');
    assert.equal(entry[3], 'Clip [redacted] [redacted]');
});
