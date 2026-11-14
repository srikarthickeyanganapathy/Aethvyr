/**
 * FastStream Mobile - Buffer Manager
 *
 * IndexedDB ring buffer for prefetched segments. Two object stores share the compound
 * primary key [tabId, streamId, segmentId]:
 *   - `meta`: small records {size, timestamp, served} scanned for eviction (cheap cursors),
 *   - `data`: the actual ArrayBuffer + content type (only read on cache hits).
 * Indexes: meta.byTime (timestamp), meta.byTab (tabId), meta.byTabStream ([tabId, streamId]).
 *
 * Eviction policy when the per-tab cap is exceeded: oldest segments that were already
 * served to the player go first; if that is not enough, oldest unserved segments that are
 * not protected (i.e. not inside the downloader's look-ahead window).
 */

const DB_NAME = 'FastStreamDB';
const DB_VERSION = 2;
const META = 'meta';
const DATA = 'data';

let dbPromise = null;

function promisify(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function txDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        tx.onerror = () => reject(tx.error);
    });
}

/** Shared DB connection for the whole background context. */
export function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            // v1 used a single store with string keys and no indexes: drop it.
            for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
            const meta = db.createObjectStore(META, { keyPath: ['tabId', 'streamId', 'segmentId'] });
            meta.createIndex('byTime', 'timestamp');
            meta.createIndex('byTab', 'tabId');
            meta.createIndex('byTabStream', ['tabId', 'streamId']);
            db.createObjectStore(DATA, { keyPath: ['tabId', 'streamId', 'segmentId'] });
        };
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => { db.close(); dbPromise = null; };
            resolve(db);
        };
        request.onerror = () => { dbPromise = null; reject(request.error); };
        request.onblocked = () => console.warn('[BufferManager] DB upgrade blocked by another connection');
    });
    return dbPromise;
}

/** Key range covering every record of a tab (or of one stream in that tab). */
function prefixRange(tabId, streamId) {
    // Array keys sort after strings/numbers, so [..., []] is an upper bound for any id.
    return streamId === undefined
        ? IDBKeyRange.bound([tabId], [tabId, []])
        : IDBKeyRange.bound([tabId, streamId], [tabId, streamId, []]);
}

/**
 * Delete records belonging to tabs that no longer exist (orphans left behind when the
 * service worker / event page was killed before it could clean up).
 * @param {Set<number>} liveTabIds
 */
export async function sweepOrphans(liveTabIds) {
    const db = await openDB();
    const tabIds = [];
    await new Promise((resolve, reject) => {
        const req = db.transaction(META, 'readonly').objectStore(META).index('byTab').openKeyCursor(null, 'nextunique');
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return resolve();
            tabIds.push(cursor.key);
            cursor.continue();
        };
        req.onerror = () => reject(req.error);
    });
    const dead = tabIds.filter(id => !liveTabIds.has(id));
    if (!dead.length) return 0;
    const tx = db.transaction([META, DATA], 'readwrite');
    for (const tabId of dead) {
        tx.objectStore(META).delete(prefixRange(tabId));
        tx.objectStore(DATA).delete(prefixRange(tabId));
    }
    await txDone(tx);
    return dead.length;
}

export class BufferManager {
    /**
     * @param {number} tabId
     * @param {string} streamId
     * @param {{capBytes?:number, isProtected?:(segmentId:string)=>boolean}} [opts]
     */
    constructor(tabId, streamId, opts = {}) {
        this.tabId = tabId;
        this.streamId = streamId;
        this.capBytes = opts.capBytes || 300 * 1024 * 1024;
        this.isProtected = opts.isProtected || (() => false);
        this.currentSize = 0;
        this.keys = new Set();          // segmentIds known to be stored (fast "has")
        this.ready = null;
        this.evicting = null;
    }

    /** Load size accounting + key set for this stream (survives SW restarts). */
    init() {
        if (this.ready) return this.ready;
        this.ready = (async () => {
            const db = await openDB();
            await new Promise((resolve, reject) => {
                const req = db.transaction(META, 'readonly').objectStore(META).openCursor(prefixRange(this.tabId));
                req.onsuccess = () => {
                    const cursor = req.result;
                    if (!cursor) return resolve();
                    const rec = cursor.value;
                    this.currentSize += rec.size;
                    if (rec.streamId === this.streamId) this.keys.add(rec.segmentId);
                    cursor.continue();
                };
                req.onerror = () => reject(req.error);
            });
        })().catch(err => {
            this.ready = null;
            throw err;
        });
        return this.ready;
    }

    setCapacity(mb) {
        this.capBytes = Math.max(32, mb) * 1024 * 1024;
    }

    has(segmentId) {
        return this.keys.has(segmentId);
    }

    /**
     * Store a segment. Evicts first when the cap would be exceeded; retries once on
     * QuotaExceededError after an aggressive eviction.
     */
    async storeSegment(segmentId, data, mime = '') {
        await this.init();
        const size = data.byteLength;
        if (size > this.capBytes / 2) return false; // never let one blob evict the whole ring
        if (this.currentSize + size > this.capBytes) {
            await this._evict(this.currentSize + size - this.capBytes);
        }
        const write = async () => {
            const db = await openDB();
            const tx = db.transaction([META, DATA], 'readwrite');
            const key = { tabId: this.tabId, streamId: this.streamId, segmentId };
            const prev = await promisify(tx.objectStore(META).get([this.tabId, this.streamId, segmentId]));
            tx.objectStore(META).put({ ...key, size, timestamp: Date.now(), served: false });
            tx.objectStore(DATA).put({ ...key, data, mime });
            await txDone(tx);
            this.currentSize += size - (prev ? prev.size : 0);
            this.keys.add(segmentId);
        };
        try {
            await write();
        } catch (err) {
            if (err && err.name === 'QuotaExceededError') {
                await this._evict(Math.max(size * 4, this.capBytes * 0.25));
                await write();
            } else {
                throw err;
            }
        }
        return true;
    }

    /**
     * Retrieve a segment and mark it as served (eligible for early eviction).
     * @returns {Promise<{data:ArrayBuffer, mime:string}|null>}
     */
    async getSegment(segmentId, { markServed = true } = {}) {
        if (!this.keys.has(segmentId)) return null;
        await this.init();
        const db = await openDB();
        const key = [this.tabId, this.streamId, segmentId];
        const tx = db.transaction([META, DATA], markServed ? 'readwrite' : 'readonly');
        const rec = await promisify(tx.objectStore(DATA).get(key));
        if (rec && markServed) {
            const meta = await promisify(tx.objectStore(META).get(key));
            if (meta && !meta.served) tx.objectStore(META).put({ ...meta, served: true, timestamp: Date.now() });
        }
        await txDone(tx).catch(() => { /* read result already in hand */ });
        if (!rec) {
            this.keys.delete(segmentId);
            return null;
        }
        return { data: rec.data, mime: rec.mime || '' };
    }

    /** Evict at least `bytesNeeded` bytes for this tab (served-first, then unprotected). */
    _evict(bytesNeeded) {
        // Serialize evictions so two concurrent stores do not double-delete.
        const run = async () => {
            const db = await openDB();
            const victims = [];
            let freed = 0;
            const collect = (predicate) => new Promise((resolve, reject) => {
                const req = db.transaction(META, 'readonly').objectStore(META).index('byTime').openCursor();
                req.onsuccess = () => {
                    const cursor = req.result;
                    if (!cursor || freed >= bytesNeeded) return resolve();
                    const rec = cursor.value;
                    if (rec.tabId === this.tabId && predicate(rec) && !victims.some(v => v.segmentId === rec.segmentId && v.streamId === rec.streamId)) {
                        victims.push(rec);
                        freed += rec.size;
                    }
                    cursor.continue();
                };
                req.onerror = () => reject(req.error);
            });
            // Pass 1: already-played segments and segments of other (stale) streams.
            await collect(rec => rec.served || rec.streamId !== this.streamId);
            // Pass 2: anything not inside the look-ahead window.
            if (freed < bytesNeeded) await collect(rec => !this.isProtected(rec.segmentId));
            if (!victims.length) return 0;
            const tx = db.transaction([META, DATA], 'readwrite');
            for (const v of victims) {
                const key = [v.tabId, v.streamId, v.segmentId];
                tx.objectStore(META).delete(key);
                tx.objectStore(DATA).delete(key);
            }
            await txDone(tx);
            for (const v of victims) {
                this.currentSize = Math.max(0, this.currentSize - v.size);
                if (v.streamId === this.streamId) this.keys.delete(v.segmentId);
            }
            return freed;
        };
        this.evicting = (this.evicting || Promise.resolve()).then(run, run);
        return this.evicting;
    }

    /** Delete every record of this stream (stream switch / player close). */
    async clearStream() {
        const db = await openDB();
        const tx = db.transaction([META, DATA], 'readwrite');
        tx.objectStore(META).delete(prefixRange(this.tabId, this.streamId));
        tx.objectStore(DATA).delete(prefixRange(this.tabId, this.streamId));
        await txDone(tx);
        this.keys.clear();
        this.ready = null;
        this.currentSize = 0;
    }

    /** Delete every record of this tab (tab closed / navigated). */
    async clearAll() {
        await BufferManager.clearTab(this.tabId);
        this.keys.clear();
        this.currentSize = 0;
        this.ready = null;
    }

    static async clearTab(tabId) {
        const db = await openDB();
        const tx = db.transaction([META, DATA], 'readwrite');
        tx.objectStore(META).delete(prefixRange(tabId));
        tx.objectStore(DATA).delete(prefixRange(tabId));
        await txDone(tx);
    }
}
