const PROFILES = Object.freeze({
    eco: { windowSeconds: 60, workers: 2 },
    balanced: { windowSeconds: 180, workers: 4 },
    max: { windowSeconds: 900, workers: 8 }
});

/** The profile supplies ceilings. User and device settings can always lower them. */
export function prefetchPolicy(settings, sessions = 1) {
    const profile = PROFILES[settings.resourceProfile] || PROFILES.balanced;
    const custom = settings.resourceProfile === 'custom';
    const share = Math.max(1, Math.floor(8 / Math.max(1, sessions)));
    return {
        windowSeconds: Math.min(settings.maxBufferSec || 90, custom ? 86400 : profile.windowSeconds),
        workers: Math.min(settings.maxWorkers || 6, custom ? 8 : profile.workers, share)
    };
}

export class PrefetchBudget {
    constructor(limit, onRelease) {
        this.limit = limit;
        this.active = 0;
        this.onRelease = onRelease;
    }

    take() {
        if (this.active >= this.limit) return null;
        this.active++;
        let returned = false;
        return () => {
            if (returned) return;
            returned = true;
            this.active--;
            this.onRelease();
        };
    }
}
