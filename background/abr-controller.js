/**
 * Velostream - ABR Controller
 *
 * Throughput + buffer hybrid bitrate selection. Bandwidth samples come from the
 * SegmentDownloader (real network fetches only - cache hits are excluded), the buffer
 * level comes from the player's telemetry, and the profile list from the player's parsed
 * variant tracks. The engine asks for a decision every couple of seconds and forwards
 * changes to the player, which applies them with `selectVariantTrack`.
 */

export class ABRController {
    constructor() {
        this.config = {
            fastAlpha: 0.5,          // fast EMA reacts quickly to drops
            slowAlpha: 0.12,         // slow EMA gives stable upgrades
            upgradeSafety: 0.75,     // only use 75% of estimate for upgrades
            downgradeSafety: 0.9,
            switchInterval: 8000,    // min ms between non-emergency switches
            minSampleBytes: 32 * 1024,
            buffer: { panic: 4, low: 10, rich: 45 }
        };
        this.reset();
    }

    reset() {
        this.fastEstimate = 0;
        this.slowEstimate = 0;
        this.samples = [];
        this.profiles = [];
        this.currentIndex = -1;
        this.isLocked = false;
        this.lockedId = null;
        this.maxHeight = 0;
        this.lastSwitchTime = 0;
    }

    /** Current bandwidth estimate in bits/second (conservative of the two EMAs). */
    get estimate() {
        if (!this.fastEstimate) return 0;
        return Math.min(this.fastEstimate, this.slowEstimate);
    }

    /**
     * Report a completed network download.
     * @param {number} bytes
     * @param {number} durationMs
     */
    reportSegmentDownload(bytes, durationMs) {
        if (durationMs <= 0 || bytes < this.config.minSampleBytes) return;
        const bps = (bytes * 8) / (durationMs / 1000);
        if (!this.fastEstimate) {
            this.fastEstimate = this.slowEstimate = bps;
        } else {
            this.fastEstimate = this.config.fastAlpha * bps + (1 - this.config.fastAlpha) * this.fastEstimate;
            this.slowEstimate = this.config.slowAlpha * bps + (1 - this.config.slowAlpha) * this.slowEstimate;
        }
        this.samples.push({ t: Date.now(), bps });
        if (this.samples.length > 30) this.samples.shift();
    }

    /**
     * @param {Array<{id:number,bandwidth:number,height:number}>} profiles
     */
    setProfiles(profiles) {
        const prevId = this.currentIndex >= 0 && this.profiles[this.currentIndex] ? this.profiles[this.currentIndex].id : null;
        this.profiles = (profiles || []).slice().sort((a, b) => a.bandwidth - b.bandwidth);
        this.currentIndex = prevId === null ? -1 : this.profiles.findIndex(p => p.id === prevId);
    }

    /** Restrict selection to profiles at or below a height (0 = no cap). */
    setMaxHeight(height) {
        this.maxHeight = height || 0;
    }

    setActive(id) {
        const idx = this.profiles.findIndex(p => p.id === id);
        if (idx >= 0) this.currentIndex = idx;
    }

    lockQuality(id) {
        this.isLocked = true;
        this.lockedId = id;
        this.setActive(id);
    }

    unlockQuality() {
        this.isLocked = false;
        this.lockedId = null;
        this.lastSwitchTime = 0;
    }

    _allowedIndices() {
        const idx = [];
        this.profiles.forEach((p, i) => {
            if (!this.maxHeight || !p.height || p.height <= this.maxHeight) idx.push(i);
        });
        if (!idx.length && this.profiles.length) idx.push(0);
        return idx;
    }

    /**
     * Decide the next profile.
     * @param {number} bufferLevel seconds buffered ahead of the playhead (player + cache)
     * @returns {object|null} chosen profile or null when nothing should change
     */
    getNextQuality(bufferLevel) {
        if (!this.profiles.length) return null;
        if (this.isLocked) {
            const locked = this.profiles.find(p => p.id === this.lockedId);
            return locked || null;
        }

        const allowed = this._allowedIndices();
        const now = Date.now();
        const cfg = this.config;
        const est = this.estimate;

        // No measurement yet: start conservatively at the second-lowest allowed rung.
        if (!est) {
            const startIdx = allowed[Math.min(1, allowed.length - 1)];
            if (this.currentIndex === -1) {
                this.currentIndex = startIdx;
                this.lastSwitchTime = now;
            }
            return this.profiles[this.currentIndex];
        }

        let ideal = allowed[0];
        for (const i of allowed) {
            if (this.profiles[i].bandwidth <= est * cfg.upgradeSafety) ideal = i;
        }

        const cur = this.currentIndex === -1 ? allowed[0] : this.currentIndex;

        if (!allowed.includes(cur)) {
            // Quality cap changed under us: obey it immediately.
            this.currentIndex = ideal;
            this.lastSwitchTime = now;
            return this.profiles[ideal];
        }

        if (bufferLevel < cfg.buffer.panic) {
            // Emergency: drop to the lowest allowed rung immediately.
            ideal = allowed[0];
        } else if (ideal < cur) {
            // Only downgrade if the current rung is really unsustainable or buffer is draining.
            const sustainable = this.profiles[cur].bandwidth <= est * cfg.downgradeSafety;
            if (sustainable && bufferLevel > cfg.buffer.low) ideal = cur;
        } else if (ideal > cur) {
            // Upgrade one rung at a time, and only with a healthy buffer.
            if (bufferLevel < cfg.buffer.low) ideal = cur;
            else if (bufferLevel < cfg.buffer.rich) ideal = allowed[Math.min(allowed.indexOf(cur) + 1, allowed.length - 1)] ?? cur;
        }

        const emergency = bufferLevel < cfg.buffer.panic;
        if (ideal !== cur && !emergency && now - this.lastSwitchTime < cfg.switchInterval) {
            ideal = cur;
        }

        if (ideal !== this.currentIndex) {
            this.currentIndex = ideal;
            this.lastSwitchTime = now;
        }
        return this.profiles[this.currentIndex];
    }
}
