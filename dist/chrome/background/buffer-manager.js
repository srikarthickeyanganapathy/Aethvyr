/**
 * Velostream - Buffer Manager
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
 *
 * Concurrency model (several prefetch workers store at once):
 *   - Every operation that changes the size accounting outside of a plain write (init,
 *     admission/eviction, clearStream, clearAll) runs through one serialized lock.
 *   - A write is "admitted" inside the lock: the bytes still missing are computed there from
 *     the up-to-date state (committed bytes + bytes reserved by writes still in flight + the
 *     incoming size), eviction runs only for that shortfall, then the size is reserved. The
 *     reservation is released when the write commits (and turns into currentSize) or fails.
 *   - Segments with a write in flight are never chosen as eviction victims.
 *   - IndexedDB transactions never span an `await`: every multi-request transaction is
 *     driven from request callbacks, so it cannot auto-commit half way (Firefox and older
 *     Chromium do not keep a transaction active across promise continuations reliably).
 */

const DB_NAME = 'VelostreamDB';
const DB_VERSION = 2;
const META = 'meta';
const DATA = 'data';

let dbPromise = null;

function txDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        // A failed request aborts the transaction, so `abort` always follows `error`.
        tx.onabort = () => reject(tx.error || abortError());
    });
}

function abortError() {
    const err = new Error('Transaction aborted');
    err.name = 'AbortError';
    return err;
}

function isQuotaError(err) {
    return !!err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22);
}

/** Shared DB connection for the whole background context. */
export function openDB() {
    if (dbPromise) return dbPromise;
    const p = new Promise((resolve, reject) => {
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
            const forget = () => { if (dbPromise === p) dbPromise = null; };
            db.onversionchange = () => { db.close(); forget(); };
            // Connection closed abnormally (storage cleared by the user, disk error...):
            // reopen on the next call instead of failing every transaction forever.
            db.onclose = forget;
            resolve(db);
        };
        request.onerror = () => { if (dbPromise === p) dbPromise = null; reject(request.error); };
        request.onblocked = () => console.warn('[BufferManager] DB upgrade blocked by another connection');
    });
    dbPromise = p;
    return p;
}

/** Key range covering every record of a tab (or of one stream in that tab). */
function prefixRange(tabId, streamId) {
    // Array keys sort after strings/numbers, so [..., []] is an upper bound for any id.
    return streamId === undefined
        ? IDBKeyRange.bound([tabId], [tabId, []])
        : IDBKeyRange.bound([tabId, streamId], [tabId, streamId, []]);
}

/** All meta records in `range` (one readonly transaction, callback driven). */
function scanMeta(db, range) {
    return new Promise((resolve, reject) => {
        const out = [];
        const tx = db.transaction(META, 'readonly');
        const req = tx.objectStore(META).openCursor(range);
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            out.push(cursor.value);
            cursor.continue();
        };
        tx.oncomplete = () => resolve(out);
        tx.onabort = () => reject(tx.error || abortError());
    });
}

/**
 * Delete every record in `range` from both stores, in one transaction. Resolves with the
 * meta records that were deleted, so callers can adjust their accounting exactly.
 */
function deleteRange(db, range) {
    return new Promise((resolve, reject) => {
        const deleted = [];
        const tx = db.transaction([META, DATA], 'readwrite');
        const req = tx.objectStore(META).openCursor(range);
        req.onsuccess = () => {
            const cursor = req.result;
            if (cursor) {
                deleted.push(cursor.value);
                cursor.continue();
                return;
            }
            tx.objectStore(META).delete(range);
            tx.objectStore(DATA).delete(range); // also drops data rows whose meta row is missing
        };
        tx.oncomplete = () => resolve(deleted);
        tx.onabort = () => reject(tx.error || abortError());
    });
}

/**
 * Delete records belonging to tabs that no longer exist (orphans left behind when the
 * service worker / event page was killed before it could clean up).
 * @param {Set<number>} liveTabIds
 */
export async function sweepOrphans(liveTabIds) {
    const db = await openDB();
    const tabIds = await new Promise((resolve, reject) => {
        const ids = [];
        const tx = db.transaction(META, 'readonly');
        const req = tx.objectStore(META).index('byTab').openKeyCursor(null, 'nextunique');
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            ids.push(cursor.key);
            cursor.continue();
        };
        tx.oncomplete = () => resolve(ids);
        tx.onabort = () => reject(tx.error || abortError());
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
        this.currentSize = 0;           // committed bytes of this tab (all streams), as last known
        this.reserved = 0;              // bytes admitted for writes that have not committed yet
        this.writing = 0;               // number of admitted writes not yet finished
        this.pending = new Map();       // segmentId -> count of writes in flight (never evicted)
        this.keys = new Set();          // segmentIds known to be stored (fast "has")
        this.ready = null;
        this.lock = Promise.resolve();
    }

    /** Run `fn` after every previously queued locked operation (failures do not break the chain). */
    _serialize(fn) {
        const result = this.lock.then(fn, fn);
        this.lock = result.catch(() => { /* surfaced to the caller of this operation */ });
        return result;
    }

    /** Load size accounting + key set for this stream (survives SW restarts). */
    init() {
        if (this.ready) return this.ready;
        this.ready = this._serialize(async () => {
            const db = await openDB();
            const recs = await scanMeta(db, prefixRange(this.tabId));
            let total = 0;
            for (const rec of recs) {
                total += rec.size || 0;
                if (rec.streamId === this.streamId) this.keys.add(rec.segmentId);
            }
            // Assign (not accumulate) so a retried init after a failure cannot double count.
            this.currentSize = total;
        }).catch(err => {
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

    _isProtected(segmentId) {
        try { return !!this.isProtected(segmentId); } catch (_) { return false; }
    }

    _pin(segmentId) {
        this.pending.set(segmentId, (this.pending.get(segmentId) || 0) + 1);
        this.writing++;
    }

    _unpin(segmentId) {
        const n = (this.pending.get(segmentId) || 1) - 1;
        if (n > 0) this.pending.set(segmentId, n); else this.pending.delete(segmentId);
        this.writing--;
    }

    /** Bytes that must be freed before `incoming` more bytes fit under the cap. */
    _shortfall(incoming) {
        return this.currentSize + this.reserved + incoming - this.capBytes;
    }

    /**
     * Admit a write of `size` bytes: inside the lock, evict exactly the current shortfall
     * (taking writes still in flight into account), then reserve the bytes.
     */
    _admit(segmentId, size) {
        return this._serialize(async () => {
            if (this._shortfall(size) > 0) await this._evictLocked(() => this._shortfall(size));
            this.reserved += size;
            this._pin(segmentId);
        });
    }

    /** One write transaction (meta + data). Resolves with the size of the record it replaced. */
    async _put(segmentId, data, mime, size) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([META, DATA], 'readwrite');
            const id = { tabId: this.tabId, streamId: this.streamId, segmentId };
            const metaStore = tx.objectStore(META);
            let prevSize = 0;
            tx.objectStore(DATA).put({ ...id, data, mime });
            const req = metaStore.get([this.tabId, this.streamId, segmentId]);
            req.onsuccess = () => {
                if (req.result) prevSize = req.result.size || 0;
                metaStore.put({ ...id, size, timestamp: Date.now(), served: false });
            };
            tx.oncomplete = () => resolve(prevSize);
            tx.onabort = () => reject(tx.error || abortError());
        });
    }

    /**
     * Store a segment. Evicts first when the cap would be exceeded; retries once on
     * QuotaExceededError after an aggressive eviction.
     *
     * The cap is soft in one case only: when every stored segment is protected and unserved
     * (look-ahead window larger than the cap) the write still goes through, otherwise the
     * downloader would re-fetch the same segment forever.
     */
    async storeSegment(segmentId, data, mime = '') {
        await this.init();
        const size = data.byteLength;
        if (size > this.capBytes / 2) return false; // never let one blob evict the whole ring
        await this._admit(segmentId, size);
        try {
            let prevSize;
            try {
                prevSize = await this._put(segmentId, data, mime, size);
            } catch (err) {
                if (!isQuotaError(err)) throw err;
                // Browser/origin quota (not our cap): free a good chunk, then retry once.
                const aggressive = Math.max(size * 4, this.capBytes * 0.25);
                await this._serialize(() => this._evictLocked(() => aggressive));
                prevSize = await this._put(segmentId, data, mime, size);
            }
            // Commit and release the reservation in the same synchronous step.
            this.currentSize = Math.max(0, this.currentSize + size - prevSize);
            this.keys.add(segmentId);
        } finally {
            this.reserved = Math.max(0, this.reserved - size);
            this._unpin(segmentId);
        }
        return true;
    }

    /**
     * Retrieve a segment and mark it as served (eligible for early eviction).
     * @returns {Promise<{data:ArrayBuffer, mime:string}|null>}
     */
    async getSegment(segmentId, { markServed = true } = {}) {
        await this.init(); // before the key check: after an SW restart the key set loads here
        if (!this.keys.has(segmentId)) return null;
        const db = await openDB();
        const key = [this.tabId, this.streamId, segmentId];
        const rec = await new Promise((resolve, reject) => {
            const tx = db.transaction([META, DATA], markServed ? 'readwrite' : 'readonly');
            const req = tx.objectStore(DATA).get(key);
            req.onsuccess = () => {
                const found = req.result || null;
                if (found && markServed) {
                    const store = tx.objectStore(META);
                    const m = store.get(key);
                    m.onsuccess = () => {
                        const meta = m.result;
                        if (meta && !meta.served) store.put({ ...meta, served: true, timestamp: Date.now() });
                    };
                }
                resolve(found); // the served flag commits in the background (best effort)
            };
            req.onerror = () => reject(req.error);
            tx.onabort = () => reject(tx.error || abortError()); // no-op once resolved
        });
        if (!rec) {
            if (!this.pending.has(segmentId)) this.keys.delete(segmentId);
            return null;
        }
        return { data: rec.data, mime: rec.mime || '' };
    }

    /** Mark a segment as played (metadata only - the data is read by the player directly). */
    markServed(segmentId) {
        if (!this.keys.has(segmentId)) return;
        openDB().then(db => {
            const tx = db.transaction(META, 'readwrite');
            const store = tx.objectStore(META);
            const key = [this.tabId, this.streamId, segmentId];
            const req = store.get(key);
            req.onsuccess = () => {
                const meta = req.result;
                if (meta && !meta.served) store.put({ ...meta, served: true, timestamp: Date.now() });
            };
        }).catch(() => { /* best effort */ });
    }

    /** Evict at least `bytesNeeded` bytes for this tab (served-first, then unprotected). */
    _evict(bytesNeeded) {
        return this._serialize(() => this._evictLocked(() => bytesNeeded));
    }

    /**
     * Eviction body - must run inside the lock. `needFn` is evaluated against the state at
     * that moment (after earlier evictions and commits), so concurrent stores never each
     * evict their own stale estimate.
     */
    async _evictLocked(needFn) {
        if (needFn() <= 0) return 0;
        const db = await openDB();
        const recs = await scanMeta(db, prefixRange(this.tabId));
        if (this.writing === 0) {
            // Nothing of ours is in flight: re-sync with the DB. This corrects drift caused by
            // other BufferManagers of the same tab (e.g. an old session's clearStream, or
            // BufferManager.clearTab) that this instance cannot see.
            let total = 0;
            const keys = new Set();
            for (const rec of recs) {
                total += rec.size || 0;
                if (rec.streamId === this.streamId) keys.add(rec.segmentId);
            }
            this.currentSize = total;
            for (const k of this.keys) if (!keys.has(k)) this.keys.delete(k);
            for (const k of keys) this.keys.add(k);
        }
        const bytesNeeded = needFn();
        if (bytesNeeded <= 0) return 0;

        recs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)); // oldest first
        const victims = [];
        const chosen = new Set();
        let freed = 0;
        const own = rec => rec.streamId === this.streamId;
        const collect = (predicate) => {
            for (const rec of recs) {
                if (freed >= bytesNeeded) return;
                const id = `${rec.streamId}\u0000${rec.segmentId}`;
                if (chosen.has(id)) continue;
                if (own(rec) && this.pending.has(rec.segmentId)) continue; // write in flight
                if (!predicate(rec)) continue;
                chosen.add(id);
                victims.push(rec);
                freed += rec.size || 0;
            }
        };
        // Pass 1: segments of other (stale) streams, and played ones outside the protected
        // set (look-ahead window + live DVR history).
        collect(rec => !own(rec) || (rec.served && !this._isProtected(rec.segmentId)));
        // Pass 2: anything not protected.
        if (freed < bytesNeeded) collect(rec => !own(rec) || !this._isProtected(rec.segmentId));
        // Pass 3: cap reached with everything protected - shrink the oldest played DVR history.
        if (freed < bytesNeeded) collect(rec => rec.served);
        if (!victims.length) return 0;

        const tx = db.transaction([META, DATA], 'readwrite');
        for (const v of victims) {
            const key = [v.tabId, v.streamId, v.segmentId];
            tx.objectStore(META).delete(key);
            tx.objectStore(DATA).delete(key);
        }
        // On abort nothing was deleted, so the in-memory index is left untouched.
        await txDone(tx);
        for (const v of victims) {
            this.currentSize = Math.max(0, this.currentSize - (v.size || 0));
            if (own(v)) this.keys.delete(v.segmentId);
        }
        return freed;
    }

    /** Delete every record of this stream (stream switch / player close). */
    clearStream() {
        return this._serialize(async () => {
            const db = await openDB();
            const deleted = await deleteRange(db, prefixRange(this.tabId, this.streamId));
            this._forget(deleted);
        });
    }

    /** Delete every record of this tab (tab closed / navigated). */
    clearAll() {
        return this._serialize(async () => {
            const db = await openDB();
            const deleted = await deleteRange(db, prefixRange(this.tabId));
            this._forget(deleted);
        });
    }

    /** Subtract exactly the deleted records (other streams of the tab keep their bytes). */
    _forget(deleted) {
        let bytes = 0;
        for (const rec of deleted) {
            bytes += rec.size || 0;
            if (rec.streamId === this.streamId) this.keys.delete(rec.segmentId);
        }
        this.currentSize = Math.max(0, this.currentSize - bytes);
    }

    static async clearTab(tabId) {
        const db = await openDB();
        await deleteRange(db, prefixRange(tabId));
    }
}
