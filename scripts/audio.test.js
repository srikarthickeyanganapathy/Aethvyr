import assert from 'node:assert/strict';
import test from 'node:test';
import { lectureSilenceStep } from '../player/audio-fx.js';
import '../common/shared.js';

test('lecture pauses retain leading padding and replay speech onset at the previous rate', () => {
    const settings = globalThis.VelostreamShared.DEFAULT_SETTINGS.audio;
    const state = {};
    const video = { currentTime: 10, playbackRate: 1.25 };
    assert.equal(lectureSilenceStep(state, settings, video, 0, 100), undefined);
    assert.equal(lectureSilenceStep(state, settings, video, 0, 1800), undefined);
    assert.deepEqual(lectureSilenceStep(state, settings, video, 0, 1850), {rate: 2});
    video.currentTime = 10.5;
    assert.deepEqual(lectureSilenceStep(state, settings, video, 0.2, 2100), {rate: 1.25, seek: 9.75});
    assert.equal(lectureSilenceStep(state, settings, video, 0.2, 2350), undefined);
});

test('imported silence settings are bounded', () => {
    const audio = globalThis.VelostreamShared.mergeSettings({audio:{silenceDb:0,silenceMs:-1,speechPadMs:999}}).audio;
    assert.deepEqual([audio.silenceDb,audio.silenceMs,audio.speechPadMs],[-30,500,500]);
});
