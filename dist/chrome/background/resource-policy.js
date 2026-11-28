const PROFILES = Object.freeze({
    eco: { windowSeconds: 60, workers: 2 },
    balanced: { windowSeconds: 180, workers: 4 },
    max: { windowSeconds: 900, workers: 8 }
});

/** The profile supplies ceilings. User and device settings can always lower them. */
export function prefetchPolicy(settings, sessions = 1, hidden = false, conserve = false) {
    const profile = PROFILES[settings.resourceProfile] || PROFILES.balanced;
    const custom = settings.resourceProfile === 'custom';
    const share = Math.max(1, Math.floor(8 / Math.max(1, sessions)));
    return {
        windowSeconds: Math.min(settings.maxBufferSec || 90, custom ? 86400 : profile.windowSeconds, hidden || conserve ? 30 : Infinity),
        workers: Math.min(settings.maxWorkers || 6, custom ? 8 : profile.workers, share, hidden || conserve ? 1 : Infinity)
    };
}

export class PrefetchBudget {
    constructor(limit, onRelease) {
        this.limit = limit;
        this.active = 0;
        this.onRelease = onRelease;
        this.resumeAt = 0;
        this.nextPriorityAt = 0;
    }

    take() {
        if (this.active >= this.limit || Date.now() < this.resumeAt) return null;
        this.active++;
        let returned = false;
        return () => {
            if (returned) return;
            returned = true;
            this.active--;
            this.onRelease();
        };
    }

    /** At most one priority window per second and a half, even during repeated scrubbing. */
    prioritizeSeek() {
        const now = Date.now();
        if (now < this.nextPriorityAt) return () => {};
        this.resumeAt = now + 750;
        this.nextPriorityAt = now + 1500;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (this.resumeAt !== now + 750) return;
            this.resumeAt = 0;
            this.onRelease();
        };
        const timer = setTimeout(finish, 750);
        return finish;
    }
}

/** FIFO among eligible origins. Account for each actual fetch, including range parts. */
export class NetworkBudget {
    constructor(total = 12, perOrigin = 8) {
        this.total = total;
        this.perOrigin = perOrigin;
        this.active = 0;
        this.byOrigin = new Map();
        this.queue = new Set();
    }

    async run(url, signal, fetchResource, speculative = false) {
        const origin = new URL(url).origin;
        signal?.throwIfAborted();
        await new Promise((resolve, reject) => {
            const entry = { origin, speculative, start: () => {
                signal?.removeEventListener('abort', abort);
                resolve();
            } };
            const abort = () => {
                this.queue.delete(entry);
                reject(new DOMException('Aborted', 'AbortError'));
            };
            signal?.addEventListener('abort', abort, { once: true });
            this.queue.add(entry);
            this.drain();
        });
        try {
            signal?.throwIfAborted();
            return await fetchResource();
        } finally {
            this.active--;
            const n = this.byOrigin.get(origin) - 1;
            if (n) this.byOrigin.set(origin, n);
            else this.byOrigin.delete(origin);
            this.drain();
        }
    }

    drain() {
        for (const entry of this.queue) {
            if (this.active >= this.total) break;
            const n = this.byOrigin.get(entry.origin) || 0;
            if (n >= this.perOrigin) continue;
            // Keep a slot available for playback even when all speculation targets one CDN.
            if (entry.speculative && (this.active >= Math.max(1, this.total - 1) ||
                n >= Math.max(1, this.perOrigin - 1))) continue;
            this.queue.delete(entry);
            this.active++;
            this.byOrigin.set(entry.origin, n + 1);
            entry.start();
        }
    }
}

export function cacheShareMB(settings, count, availableMB = Infinity) {
    const profileCap = { eco: 128, balanced: 512 }[settings.resourceProfile] ?? Infinity;
    return Math.min(settings.cacheSizeMB, profileCap, availableMB) / Math.max(1, count);
}
