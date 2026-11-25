(function () {
    'use strict';

    let opening;
    if (globalThis.VelostreamShared?.api.extension?.inIncognitoContext) {
        const files = new Map();
        globalThis.VelostreamLocal = Object.freeze({
            list: async () => [...files.values()],
            get: async id => files.get(id),
            save: async entry => { files.set(entry.id, entry); },
            remove: async id => { files.delete(id); }
        });
        return;
    }
    async function request(mode, action) {
        opening ||= new Promise((resolve, reject) => {
            const open = indexedDB.open('VelostreamLocal', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('files', { keyPath: 'id' });
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => reject(open.error);
        }).catch(err => { opening = null; throw err; });
        const db = await opening;
        return new Promise((resolve, reject) => {
            const tx = db.transaction('files', mode);
            const result = action(tx.objectStore('files'));
            tx.oncomplete = () => resolve(result.result);
            tx.onabort = () => reject(tx.error);
        });
    }

    globalThis.VelostreamLocal = Object.freeze({
        list: () => request('readonly', store => store.getAll()),
        get: id => request('readonly', store => store.get(id)),
        save: entry => request('readwrite', store => store.put(entry)),
        remove: id => request('readwrite', store => store.delete(id))
    });
})();
