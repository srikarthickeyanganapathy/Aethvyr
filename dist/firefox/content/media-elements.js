// Loaded synchronously in the isolated world before sniffer.js, including reinjection.
(function (root) {
    'use strict';
    function collectMedia(root, out) {
        root.querySelectorAll('video, audio').forEach(el => out.push(el));
        // Walk open shadow roots (custom player elements) except Velostream's own host.
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        let budget = 5000; // bound the cost on huge DOMs
        while (node && budget-- > 0) {
            if (node.shadowRoot && node.id !== 'velostream-host') collectMedia(node.shadowRoot, out);
            node = walker.nextNode();
        }
        return out;
    }

    function pickVideo(videos, streamUrl) {
        let best = null;
        let bestScore = 0;
        for (const v of videos) {
            if (v.tagName !== 'VIDEO') continue;
            const r = v.getBoundingClientRect();
            if (r.width < 120 || r.height < 68) continue;
            let score = r.width * r.height;
            if (!v.paused) score *= 2;
            if (streamUrl && (v.currentSrc === streamUrl || v.src === streamUrl)) score *= 4;
            if (score > bestScore) { bestScore = score; best = v; }
        }
        return best;
    }

    function largestVideo(videos) {
        let best = null;
        let bestArea = 0;
        for (const el of videos) {
            if (el.tagName !== 'VIDEO') continue;
            const r = el.getBoundingClientRect();
            const visW = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
            const visH = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
            if (visW < 160 || visH < 90) continue;
            const area = visW * visH;
            if (area > bestArea) { bestArea = area; best = el; }
        }
        return best;
    }

    root.AethvyrMediaElements = Object.freeze({ collectMedia, pickVideo, largestVideo });
})(globalThis);
