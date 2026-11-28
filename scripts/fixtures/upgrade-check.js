/* eslint-env browser */
// Test-only module appended to the player page of disposable Firefox packages.
import { downloadStore } from '../background/download-store.js';

const options = new URL(import.meta.url).searchParams;
const report = value => fetch(options.get('result'), { method: 'POST', body: JSON.stringify(value) });
const expect = (value, message) => { if (!value) throw new Error(message); };
const fixture = {
    fs_settings: { syncEnabled: options.get('sync') === 'on', autoSites: ['fixture.invalid'] },
    fs_history: { fixture: { t: 17, title: 'Fixture', url: 'https://fixture.invalid/movie.mp4', updatedAt: 1 } },
    fs_bm_fixture: [{ t: 17, label: 'Bookmark' }],
    fs_library: { favorites: ['fixture'], collections: [{ id: 'collection', name: 'Test', keys: ['fixture'] }] }
};

async function run() {
    const { storage, runtime } = browser;
    if (location.hash === '#private-check') {
        expect(browser.extension.inIncognitoContext, 'Expected a private window');
        await globalThis.VelostreamLocal.save({ id: 'private-file', name: 'private.mp4', time: 4 });
        expect((await globalThis.VelostreamLocal.get('private-file')).time === 4, 'Private local position unavailable');
        const response = await runtime.sendMessage({ action: 'HISTORY_SAVE', key: 'privatefixture',
            entry: { url: 'https://fixture.invalid/private.mp4', t: 9 } });
        expect(response?.ok, 'The private history request was not handled');
        return 'private-request-complete';
    }
    expect(!browser.extension.inIncognitoContext, 'Expected a regular window');
    if (options.get('stage') === 'seed') {
        expect(runtime.getManifest().short_name === 'Velostream', 'Expected Velostream baseline');
        await storage.local.set(fixture);
        await downloadStore.save({ id: 'fixture', base: 'Fixture', bytes: 0, completedCount: 0 });
        await downloadStore.commit('fixture', 'seg:0', { data: new Uint8Array([7, 13]).buffer });
        return 'seeded';
    }
    expect(runtime.getManifest().short_name === 'Aethvyr', 'Expected Aethvyr upgrade');
    const stored = await storage.local.get(Object.keys(fixture));
    expect(stored.fs_settings.autoSites.includes('fixture.invalid') &&
        stored.fs_settings.syncEnabled === fixture.fs_settings.syncEnabled, 'Site or sync setting lost');
    expect(stored.fs_history.fixture.t === 17 && stored.fs_bm_fixture[0].t === 17, 'Position or bookmark lost');
    expect(stored.fs_library.collections[0].keys[0] === 'fixture' && stored.fs_library.favorites[0] === 'fixture', 'Library lost');
    const job = await downloadStore.get('fixture');
    const chunk = await downloadStore.read('fixture', 'seg:0');
    expect(job.completedCount === 1 && String(new Uint8Array(chunk.data)) === '7,13', 'Download checkpoint lost');
    if (options.get('stage') === 'verify') {
        if (Number(runtime.getManifest().version.split('.')[1]) >= 9) {
            const frame = document.createElement('iframe');
            frame.src = runtime.getURL('popup/library.html#recent');
            document.body.append(frame);
            const find = async selector => {
                for (let i=0;i<100;i++) {
                    const el = frame.contentDocument?.querySelector(selector);
                    if (el) return el;
                    await new Promise(resolve=>setTimeout(resolve,50));
                }
                throw Error('Library control missing: '+selector);
            }
            (await find('[data-action="queue-add"][data-key="fixture"]')).click();
            (await find('[data-view="queue"]')).click();
            await find('[data-action="queue-remove"][data-key="fixture"]');
            (await find('[data-view="statistics"]')).click();
            (await find('[data-action="stats-toggle"]')).click();
            (await find('[data-view="offline"]')).click();
            (await find('[data-batch="fixture"]')).click();
            await find('[data-batch-start]:enabled');
            frame.remove();
        }
        return 'upgrade-verified';
    }
    const regular = await runtime.sendMessage({ action: 'HISTORY_SAVE', key: 'regularfixture',
        entry: { url: 'https://fixture.invalid/regular.mp4', t: 11 } });
    expect(regular?.ok, 'Regular history request failed');
    expect(await browser.extension.isAllowedIncognitoAccess(), 'Private window access was not granted');
    const finished = new Promise(resolve => {
        browser.runtime.onMessage.addListener(function onMessage(message, sender) {
            if (message.fixture !== 'private-finished' || !sender.tab?.incognito) return;
            browser.runtime.onMessage.removeListener(onMessage);
            resolve(message);
        });
    });
    const win = await browser.windows.create({ incognito: true, url: runtime.getURL('player/player.html#private-check') });
    const result = await finished;
    await browser.windows.remove(win.id);
    expect(!result.error, result.error);
    const history = (await storage.local.get('fs_history')).fs_history;
    expect(history.regularfixture?.t === 11, 'Regular watch position was not saved');
    expect(!Object.hasOwn(history, 'privatefixture'), 'Private player history persisted in the regular profile');
    expect(!await globalThis.VelostreamLocal.get('private-file'), 'Private local file reached regular storage');
    return 'repeat-upgrade-and-private-history-verified';
}

if (location.hash === '#upgrade-check') {
    run().then(value => report({ value }), error => report({ error: String(error) }));
} else if (location.hash === '#private-check') {
    run().then(() => browser.runtime.sendMessage({ fixture: 'private-finished' }),
        error => browser.runtime.sendMessage({ fixture: 'private-finished', error: String(error) }));
}
