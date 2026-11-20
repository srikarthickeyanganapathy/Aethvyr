import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import '../common/shared.js';

const S = globalThis.VelostreamShared;

test('retired graphics choices migrate without enabling a new effect', () => {
    assert.equal(S.mergeSettings({ shader: 'fsr' }).shader, 'cas');
    assert.equal(S.mergeSettings({ shader: 'deband' }).shader, 'off');
    assert.equal(S.mergeSettings({ shader: 'denoise' }).shader, 'off');
    assert.equal(S.mergeSettings({ shader: 'anime4k-hq', shaderStrength: 'bad' }).shaderStrength, 50);
    for (const [shader] of S.GRAPHICS_PRESETS) {
        assert.equal(S.mergeSettings({ shader }).shader, shader);
    }
});

test('Auto selects an appropriate processing budget for the device and source', () => {
    assert.deepEqual(S.graphicsBudget('low', true, 480), { preset: 'cas', maxHeight: 720 });
    assert.deepEqual(S.graphicsBudget('high', true, 2160), { preset: 'cas', maxHeight: 1080 });
    assert.deepEqual(S.graphicsBudget('standard', false, 360), { preset: 'deblock', maxHeight: 1080 });
    assert.deepEqual(S.graphicsBudget('standard', false, 720), { preset: 'cas', maxHeight: 1080 });
    assert.deepEqual(S.graphicsBudget('high', false, 2160), { preset: 'cas', maxHeight: 1440 });
});

test('a Chromium badge error from a closing tab is consumed and stops further updates', async () => {
    const source = readFileSync(new URL('../background/engine.js', import.meta.url), 'utf8');
    const start = source.indexOf('function setTabAction(');
    const end = source.indexOf('async function updateIcon(', start);
    let lastErrorRead = false;
    const api = {
        action: { setIcon(_options, callback) { callback(); } },
        runtime: { get lastError() { lastErrorRead = true; return { message: 'No tab with id: 42' }; } }
    };
    const setTabAction = vm.runInNewContext(source.slice(start, end) + '\nsetTabAction', {
        api, S: { IS_FIREFOX: false }
    });
    assert.equal(await setTabAction('setIcon', { tabId: 42 }), false);
    assert.equal(lastErrorRead, true);
});
