import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PrivateBuffer } from '../background/private-buffer.js';

test('private segment bytes stay within the session capacity and clear on close', async () => {
    const cache = new PrivateBuffer(1);
    const other = new PrivateBuffer(1);
    const data = new ArrayBuffer(700000);
    assert.equal(await cache.storeSegment('first', data, 'video/mp4'), true);
    assert.equal(await cache.storeSegment('second', data, 'video/mp4'), true);
    assert.equal(await cache.getSegment('first'), null);
    assert.equal(await other.getSegment('second'), null);
    assert.equal(cache.currentSize, data.byteLength);
    assert.equal(await cache.storeSegment('large', new ArrayBuffer(2000000)), false);
    assert.equal((await cache.getSegment('second')).mime, 'video/mp4');
    await cache.clearStream();
    assert.equal(cache.currentSize, 0);
    assert.equal(cache.keys.size, 0);
});

test('foundation text and accent tokens meet normal-text contrast on panel backgrounds', () => {
    const css = readFileSync(new URL('../common/tokens.css', import.meta.url), 'utf8');
    const tokens = new Map([...css.matchAll(/--([\w-]+):\s*#([\da-f]{6});/gi)].map(m => [m[1], m[2]]));
    function luminance(name) {
        const channels = tokens.get(name).match(/../g).map(value => parseInt(value, 16) / 255)
            .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    }
    for (const bg of ['bg-base', 'bg-elevated']) {
        for (const fg of ['text-primary', 'text-secondary', 'text-tertiary', 'accent-default', 'accent-secondary']) {
            assert.ok((luminance(fg) + 0.05) / (luminance(bg) + 0.05) >= 4.5, fg + ' on ' + bg);
        }
    }
});
