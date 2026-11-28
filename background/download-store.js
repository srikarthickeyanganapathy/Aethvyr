/** Durable download checkpoints. Chunk writes and their progress update commit together. */
let connection;
export const VAULT_LIMIT = 4 * 1024 ** 3;
export function hasVaultSpace(used, extra) {
    return Number.isSafeInteger(used) && Number.isSafeInteger(extra) && extra >= 0 && used >= 0 && used + extra <= VAULT_LIMIT;
}

function database() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
        const request = indexedDB.open('VelostreamDownloads', 2);
        request.onupgradeneeded = event => {
            if (event.oldVersion < 1) {
            request.result.createObjectStore('jobs', { keyPath: 'id' });
            request.result.createObjectStore('chunks', { keyPath: ['streamId', 'segmentIndex'] });
            }
            const totals = request.result.createObjectStore('usage');
            let used = 0;
            const rows = request.transaction.objectStore('jobs').openCursor();
            rows.onsuccess = () => {
                const row = rows.result;
                if (row) { used += row.value.bytes || 0; row.continue(); }
                else totals.put(used, 'bytes');
            };
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
        tx.onabort = () => reject(tx.vaultError || tx.error || new Error('Download transaction aborted.'));
    });
}

export const downloadStore = {
    async listSummaries() {
        const summaries = [];
        await transaction('jobs', 'readonly', tx => {
            const request = tx.objectStore('jobs').openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                const job = cursor.value;
                summaries.push({
                    id: job.id, name: job.base, bytes: job.bytes, totalBytes: job.totalBytes,
                    total: job.totalSegments, completed: job.completedCount, status: job.status, savedAt: job.savedAt, failure: job.failure
                });
                cursor.continue();
            };
        });
        return summaries;
    },
    get: id => transaction('jobs', 'readonly', tx => tx.objectStore('jobs').get(id)),
    save: job => transaction('jobs', 'readwrite', tx => tx.objectStore('jobs').put(job)),
    update: (id, patch) => transaction('jobs', 'readwrite', tx => {
        const store = tx.objectStore('jobs');
        const row = store.get(id);
        row.onsuccess = () => { if (row.result) store.put({ ...row.result, ...patch }); };
    }),
    read: (id, index) => transaction('chunks', 'readonly', tx => tx.objectStore('chunks').get([id, index])),
    commit: (id, index, chunk) => transaction(['jobs', 'chunks','usage'], 'readwrite', tx => {
        const jobs = tx.objectStore('jobs');
        const chunks = tx.objectStore('chunks');
        const req = jobs.get(id);
        req.onsuccess = () => {
            if (!req.result) { tx.abort(); return; }
            const job = req.result;
            const existing = chunks.getKey([id, index]);
            existing.onsuccess = () => {
                if (existing.result) return;
                const usage = tx.objectStore('usage');
                const size = usage.get('bytes');
                size.onsuccess = () => {
                    if (!hasVaultSpace(size.result, chunk.data.byteLength)) {
                        tx.vaultError = new Error('Vault storage limit reached. Delete cached jobs before retrying.');
                        tx.abort();
                        return;
                    }
                    usage.put(size.result + chunk.data.byteLength, 'bytes');
                };
                chunks.put({ ...chunk, streamId: id, segmentIndex: index });
                job.bytes = (job.bytes || 0) + chunk.data.byteLength;
                if (index.startsWith('seg:')) job.completedCount = (job.completedCount || 0) + 1;
                if (index.startsWith('byte:')) {
                    job.byteOffset = chunk.offset + chunk.data.byteLength;
                    job.totalBytes = chunk.total;
                }
                jobs.put(job);
            };
        };
    }),
    remove: id => transaction(['jobs', 'chunks','usage'], 'readwrite', tx => {
        tx.objectStore('chunks').delete(IDBKeyRange.bound([id], [id, []]));
        const jobs = tx.objectStore('jobs');
        const row = jobs.get(id);
        row.onsuccess = () => {
            if (!row.result) return;
            const usage = tx.objectStore('usage');
            const size = usage.get('bytes');
            size.onsuccess = () => usage.put(Math.max(0, size.result - (row.result.bytes || 0)), 'bytes');
            jobs.delete(id);
        };
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
