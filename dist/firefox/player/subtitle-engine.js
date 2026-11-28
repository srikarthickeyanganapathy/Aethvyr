import { esc } from './escape-html.js';
import { cueText } from './subtitle-parser.js';

const setHTML = (el, markup) => globalThis.VelostreamShared.setHTML(el, markup);

export class SubtitleEngine {
    constructor(layer, topLayer) {
        this.layer = layer;
        this.topLayer = topLayer;     // secondary (dual) subtitles, shown at the top
        this.shakaCues = [];
        this.shakaKeys = new Set();
        this.externalCues = null;
        this.externalName = '';
        this.secondaryCues = null;
        this.secondaryName = '';
        this.secondaryIndex = null;
        this.source = 'off';  // off | shaka | external
        this.offset = 0;
        this.speed = 1;       // cue timing scale (0.9-1.1) for frame-rate mismatched files
        this.shakaVisible = false;
        this.lastHtml = '';
        this.lastTopHtml = '';
    }

    clearExternal() {
        this.externalCues = null;
        this.externalName = '';
        this.capturedIndex = null;
        this.secondaryCues = null;
        this.secondaryName = '';
        this.secondaryIndex = null;
        this.lastHtml = this.lastTopHtml = null;
        if (this.source === 'external') this.source = 'off';
    }

    activeCues() {
        return this.source === 'external' ? this.externalCues : this.source === 'shaka' ? this.shakaCues : null;
    }

    /** Media time -> subtitle file time. */
    cueTime(time) { return (time - this.offset) / (this.speed || 1); }

    /** The next cue that has not started yet (for "sync to current voice"). */
    nextCueStart(time) {
        const cues = this.activeCues();
        if (!cues || !cues.length) return null;
        const t = this.cueTime(time);
        for (const c of cues) if (c.start > t - 0.2) return c.start;
        return null;
    }

    static linesHtml(texts) {
        return texts.join('\n').split('\n').map(line => `<span class="cue-line">${esc(line)}</span>`).join('');
    }

    static activeAt(cues, t) {
        const active = [];
        if (!cues) return active;
        for (const c of cues) {
            if (c.start > t) break;
            if (t < c.end) active.push(c.text);
        }
        return active;
    }

    createDisplayer() {
        const self = this;
        const keyOf = c => `${c.start.toFixed(3)}|${c.end.toFixed(3)}|${c.text}`;
        return {
            configure() { },
            setTextLanguage() { },
            enableTextDisplayer() { },
            append(cues) {
                for (const c of cues) {
                    const text = cueText(c).trim();
                    if (!text) continue;
                    const cue = { start: c.startTime, end: c.endTime, text };
                    const key = keyOf(cue);
                    if (self.shakaKeys.has(key)) continue;
                    self.shakaKeys.add(key);
                    self.shakaCues.push(cue);
                }
                self.shakaCues.sort((a, b) => a.start - b.start);
            },
            remove(start, end) {
                self.shakaCues = self.shakaCues.filter(c => c.end <= start || c.start >= end);
                self.shakaKeys = new Set(self.shakaCues.map(keyOf));
                return true;
            },
            isTextVisible() { return self.shakaVisible; },
            setTextVisibility(on) { self.shakaVisible = !!on; },
            destroy() {
                self.shakaCues = [];
                self.shakaKeys.clear();
                return Promise.resolve();
            }
        };
    }

    clearShaka() {
        this.shakaCues = [];
        this.shakaKeys.clear();
    }

    render(time) {
        const t = this.cueTime(time);
        const active = SubtitleEngine.activeAt(this.activeCues(), t);
        const html = active.length ? SubtitleEngine.linesHtml(active) : '';
        if (html !== this.lastHtml) {
            this.lastHtml = html;
            setHTML(this.layer, html);
        }
        if (this.topLayer) {
            const top = this.secondaryCues ? SubtitleEngine.activeAt(this.secondaryCues, t) : [];
            const topHtml = top.length ? SubtitleEngine.linesHtml(top) : '';
            if (topHtml !== this.lastTopHtml) {
                this.lastTopHtml = topHtml;
                setHTML(this.topLayer, topHtml);
            }
        }
    }
}
