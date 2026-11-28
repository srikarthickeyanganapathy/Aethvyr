/* Publisher-specific adapters can precede the generic adapters and supply a host matcher. */
(function (root) {
    'use strict';
    const adapters = [
        { selector: 'a[data-next-episode][href],a[itemprop="nextEpisode"][href]', explicit: true },
        { selector: 'link[rel~="next"][href],a[rel~="next"][href]' },
        { selector: 'a[href]', accepts: a => a.getClientRects().length && /\bnext episode\b/i.test([a.textContent, a.title, a.getAttribute('aria-label')].join(' ')) }
    ];

    function findNext(doc, page, rules = adapters) {
        const current = new URL(page);
        current.hash = '';
        for (const rule of rules) {
            if (rule.host && rule.host !== current.hostname) continue;
            for (const link of doc.querySelectorAll(rule.selector)) {
                if (rule.accepts && !rule.accepts(link)) continue;
                const raw = link.getAttribute('href')?.trim();
                if (!raw || raw.startsWith('#')) continue;
                let url;
                try { url = new URL(raw, doc.baseURI || page); } catch (_) { continue; }
                if (!/^https?:$/.test(url.protocol) || url.username || url.password) continue;
                const destination = url.href;
                url.hash = '';
                if (url.href === current.href) continue;
                const label = (link.textContent.trim() || link.title || 'Next episode').slice(0,180);
                return {url:destination,title:label + ' (' + url.host + ')',certain:!!rule.explicit && url.origin === current.origin};
            }
        }
        return null;
    }
    root.AethvyrEpisodes = Object.freeze({findNext});
})(globalThis);
