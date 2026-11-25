/** Session-owned cache. Private media never enters the extension's persistent database. */
export class PrivateBuffer {
    constructor(capacityMB) {
        this.entries = new Map();
        this.currentSize = 0;
        this.reserved = 0;
        this.setCapacity(capacityMB);
    }

    get keys() { return this.entries; }
    async init() {}
    has(key) { return this.entries.has(key); }
    markServed() {} // FIFO eviction needs no persistent playback markers.
    setCapacity(mb) {
        this.capBytes = Math.floor(Math.max(0, Math.min(16, mb ?? 16)) * 1024 * 1024);
        this.trim(this.capBytes);
    }
    trim(limit) {
        for (const [key, entry] of this.entries) {
            if (this.currentSize <= limit) break;
            this.entries.delete(key);
            this.currentSize -= entry.data.byteLength;
        }
    }
    async storeSegment(key, data, mime, limit = this.capBytes) {
        const capacity = Math.min(limit, this.capBytes);
        if (!data.byteLength || data.byteLength > capacity) return false;
        if (this.entries.has(key)) return true;
        this.trim(capacity - data.byteLength);
        this.entries.set(key, { data, mime });
        this.currentSize += data.byteLength;
        return true;
    }
    async getSegment(key) { return this.entries.get(key) || null; }
    async clearStream() {
        this.entries.clear();
        this.currentSize = 0;
    }
}
