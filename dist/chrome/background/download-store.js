/** Durable download checkpoints. Chunk writes and their progress update commit together. */
let connection;

function database() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
        const request = indexedDB.open('VelostreamDownloads', 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore('jobs', { keyPath: 'id' });
            request.result.createObjectStore('chunks', { keyPath: ['streamId', 'segmentIndex'] });
        };
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => { db.close(); connection = null; };
            db.onclose = () => { connection = null; };
            resolve(db);
        };
        request.onerror = () => reject(request.error);
    }).catch(err => { connection = null; throw err; });
    return connection;
}

async function transaction(stores, mode, body) {
    const db = await database();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        const result = body(tx);
        tx.oncomplete = () => resolve(result?.result);
        tx.onabort = () => reject(tx.error || new Error('Download transaction aborted.'));
    });
}

export const downloadStore = {
    list: () => transaction('jobs', 'readonly', tx => tx.objectStore('jobs').getAll()),
    get: id => transaction('jobs', 'readonly', tx => tx.objectStore('jobs').get(id)),
    save: job => transaction('jobs', 'readwrite', tx => tx.objectStore('jobs').put(job)),
    read: (id, index) => transaction('chunks', 'readonly', tx => tx.objectStore('chunks').get([id, index])),
    commit: (id, index, chunk) => transaction(['jobs', 'chunks'], 'readwrite', tx => {
        const jobs = tx.objectStore('jobs');
        const chunks = tx.objectStore('chunks');
        const req = jobs.get(id);
        req.onsuccess = () => {
            if (!req.result) { tx.abort(); return; }
            const job = req.result;
            const existing = chunks.getKey([id, index]);
            existing.onsuccess = () => {
                if (existing.result) return;
                chunks.put({ ...chunk, streamId: id, segmentIndex: index });
                job.bytes = (job.bytes || 0) + chunk.data.byteLength;
                if (index.startsWith('seg:')) job.completedCount = (job.completedCount || 0) + 1;
                if (index.startsWith('byte:')) job.byteOffset = chunk.offset + chunk.data.byteLength;
                jobs.put(job);
            };
        };
    }),
    remove: id => transaction(['jobs', 'chunks'], 'readwrite', tx => {
        tx.objectStore('chunks').delete(IDBKeyRange.bound([id], [id, []]));
        tx.objectStore('jobs').delete(id);
    })
};

export async function checkpoint(store, id, index, signal, load) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const saved = id ? await store.read(id, index) : null;
    if (saved) return saved;
    const chunk = await load();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (id) await store.commit(id, index, chunk);
    return chunk;
}

export function validateExportRange(res, offset, chunkSize, expectedTotal) {
    if (res.status === 200 && offset === 0 && res.data.byteLength) return res.data.byteLength;
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(res.headers['content-range'] || '');
    const total = Number(match?.[3]);
    if (res.status !== 206 || !match || !Number.isSafeInteger(total) || +match[1] !== offset ||
        +match[2] !== Math.min(offset + chunkSize, total) - 1 ||
        +match[2] - offset + 1 !== res.data.byteLength || !res.data.byteLength ||
        (expectedTotal != null && total !== expectedTotal)) {
        throw new Error(`Invalid download range at byte ${offset} (HTTP ${res.status})`);
    }
    return total;
}
