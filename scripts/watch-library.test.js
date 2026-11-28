import test from 'node:test';
import assert from 'node:assert/strict';
import { changeStats, queueEdit } from '../background/watch-library.js';

function localStorageFixture() {
    const data = { fs_history: { a:{}, b:{}, c:{} } };
    return { data, storage:{ local:{
        get: async () => structuredClone(data),
        set: async values => Object.assign(data,structuredClone(values)),
        remove: async key => { delete data[key]; }
    } } };
}

test('queue serializes concurrent edits, rotates repeat and ignores stale consumption', async () => {
    const api = localStorageFixture();
    const edit = (op,key) => queueEdit(api,op,key);
    await Promise.all(['a','b','c'].map(k=>edit('add',k)));
    assert.deepEqual((await edit('first','c')).keys,['c','a','b']);
    await edit('repeat');
    assert.deepEqual((await edit('consume','a')).keys,['c','a','b']);
    assert.deepEqual((await edit('consume','c')).keys,['a','b','c']);
    assert.deepEqual((await edit('shuffle')).keys.sort(),['a','b','c']);
    await assert.rejects(edit('add','missing'),/history/);
    delete api.data.fs_history.b;
    assert.deepEqual((await edit('autoplay')).keys.sort(),['a','c']);
});

test('watch statistics aggregate active time, skip disabled samples and stay deleted', async () => {
    const api = localStorageFixture();
    const sample = {seconds:5,first:true,category:'anime',completed:'series'};
    await changeStats(api,'record',sample);
    assert.equal(api.data.fs_watch_stats,undefined);
    await changeStats(api,'toggle');
    await changeStats(api,'record',sample);
    await changeStats(api,'record',{...sample,first:false,completed:false});
    const s = api.data.fs_watch_stats;
    assert.equal(s.seconds,10);
    assert.equal(s.sessions,1);
    assert.equal(s.episodes,1);
    assert.equal(s.categories.anime,10);
    await changeStats(api,'toggle');
    await changeStats(api,'record',sample);
    assert.equal(api.data.fs_watch_stats.seconds,10);
    await changeStats(api,'clear');
    await changeStats(api,'record',sample);
    assert.equal(api.data.fs_watch_stats,undefined);
});

test('restore previous queue keeps later additions and omits deleted history', async () => {
    const api = localStorageFixture();
    const edit = (op,key) => queueEdit(api,op,key);
    await edit('add','a'); await edit('add','b');
    assert.deepEqual((await edit('clear')).keys,[]);
    await edit('add','c');
    delete api.data.fs_history.b;
    assert.deepEqual((await edit('restore')).keys,['a','c']);
    assert.deepEqual((await edit('restore')).keys,['a','c']);
});
