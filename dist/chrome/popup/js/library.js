/**
 * Velostream - Personal video library (popup/library.html, opened in a tab).
 *
 * Reads the per-video watch history (fs_history), the per-video bookmarks (fs_bm_<key>) and the
 * library's own data (fs_library: favorites + collections), all in storage.local. Nothing leaves
 * the device. Every render builds one markup string for the current view and swaps it in with
 * S.setHTML (sanitized, no innerHTML); clicks are handled by delegation on the view container.
 */
(function () {
    'use strict';

    const S = globalThis.VelostreamShared;
    const api = S.api;
    const $ = (id) => document.getElementById(id);

    const LIBRARY_KEY = 'fs_library';
    const BM_PREFIX = 'fs_bm_';
    const MAX_COLLECTIONS = 50;
    const MAX_KEYS = 500;
    const NAME_MAX = 60;
    const VIEWS = {
        continue: { title: 'Continue watching', empty: 'Nothing in progress. Videos you stop partway through show up here so you can pick up where you left off.' },
        recent: { title: 'Recently watched', empty: 'No watch history yet. Play a video in Velostream and it appears here with its position.' },
        favorites: { title: 'Favorites', empty: 'No favorites yet. Select the star on any video to keep it here.' },
        collections: { title: 'Collections', empty: 'No collections yet. Create one above, then use “Collections” on any video to add it.' },
        bookmarked: { title: 'Bookmarked', empty: 'No bookmarks yet. While watching, add bookmarks from the player’s menu and they are listed here.' }
    };

    let settings = S.mergeSettings(null);
    let history = {};
    let library = { favorites: [], collections: [] };
    const bookmarks = new Map(); // history key -> [{t, label}]
    let view = 'recent';
    let query = '';
    let sort = 'recent';
    const openPanels = new Set(); // `${scope}|${key}|cols` / `${scope}|${key}|bms`
    let lastMarkup = '';
    let renderTimer = 0;
    let uid = 0;

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------
    const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
    const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function fmtTime(sec) {
        sec = Math.max(0, Math.floor(sec || 0));
        const h = Math.floor(sec / 3600);
        const m = Math.floor(sec / 60) % 60;
        const s = sec % 60;
        const pad = n => String(n).padStart(2, '0');
        return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }

    function fmtAgo(ts) {
        if (!Number.isFinite(ts) || !ts) return 'earlier';
        const d = (Date.now() - ts) / 1000;
        if (d < 90) return 'just now';
        if (d < 3600) return `${Math.round(d / 60)} min ago`;
        if (d < 86400) return `${Math.round(d / 3600)} h ago`;
        const days = Math.round(d / 86400);
        return `${days} day${days === 1 ? '' : 's'} ago`;
    }

    const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

    function hostOf(url) {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
    }

    /** Returns url only if it is a web page we may open in a tab (http/https). */
    function webUrl(url) {
        if (typeof url !== 'string' || !url || url.length > 4096) return null;
        try {
            const u = new URL(url);
            return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
        } catch (_) {
            return null;
        }
    }

    /** Same rule as the popup: the page the video was watched on, else the media URL, else nothing. */
    function resumeTarget(e) {
        return webUrl(e.page) || webUrl(e.url);
    }

    function cleanName(v) {
        // eslint-disable-next-line no-control-regex
        return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, NAME_MAX);
    }

    function cleanTitle(v) {
        return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    }

    function cleanKeys(arr) {
        const out = [];
        const seen = new Set();
        if (!Array.isArray(arr)) return out;
        for (const k of arr) {
            if (typeof k !== 'string' || !k || k.length > 512 || seen.has(k)) continue;
            seen.add(k);
            out.push(k);
            if (out.length >= MAX_KEYS) break;
        }
        return out;
    }

    /** Validate fs_library as read from storage (it may come from an older build or a hand edit). */
    function sanitizeLibrary(raw) {
        const src = isPlainObject(raw) ? raw : {};
        const ids = new Set();
        const collections = [];
        for (const c of Array.isArray(src.collections) ? src.collections : []) {
            if (!isPlainObject(c)) continue;
            const id = typeof c.id === 'string' && /^[\w-]{1,40}$/.test(c.id) ? c.id : null;
            const name = cleanName(c.name);
            if (!id || !name || ids.has(id)) continue;
            ids.add(id);
            collections.push({ id, name, keys: cleanKeys(c.keys), createdAt: finite(c.createdAt) });
            if (collections.length >= MAX_COLLECTIONS) break;
        }
        return { favorites: cleanKeys(src.favorites), collections };
    }

    function announce(text) {
        const el = $('announcer');
        el.textContent = '';
        setTimeout(() => { el.textContent = text; }, 50);
    }

    let messageTimer = 0;
    function showMessage(text, ok) {
        const el = $('message');
        clearTimeout(messageTimer);
        if (!text) { el.hidden = true; return; }
        el.textContent = text;
        el.classList.toggle('ok', !!ok);
        el.hidden = false;
        if (ok) messageTimer = setTimeout(() => { el.hidden = true; }, 6000);
    }

    function newId() {
        return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    }

    // -------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------
    async function loadBookmarks(keys) {
        const want = keys.filter(k => !bookmarks.has(k)).map(k => BM_PREFIX + k);
        if (!want.length) return;
        const res = await api.storage.local.get(want);
        for (const k of want) setBookmarks(k.slice(BM_PREFIX.length), res[k]);
    }

    function setBookmarks(key, list) {
        const clean = Array.isArray(list)
            ? list.filter(b => isPlainObject(b) && Number.isFinite(b.t) && b.t >= 0)
                .map(b => ({ t: b.t, label: String(b.label == null ? '' : b.label).slice(0, 120) }))
                .sort((a, b) => a.t - b.t).slice(0, 200)
            : [];
        bookmarks.set(key, clean);
    }

    function setHistory(raw) {
        history = {};
        if (!isPlainObject(raw)) return;
        for (const [k, e] of Object.entries(raw)) if (isPlainObject(e)) history[k] = e;
    }

    // Library writes are serialized and always applied to the freshest stored copy; keys whose
    // history entry is gone are pruned on every write.
    let writeChain = Promise.resolve();

    /**
     * mutate(lib, hist) edits `lib` in place. It may return { history } (a replacement fs_history)
     * and/or { removeKeys } (storage keys to delete), or false to cancel the write.
     */
    function commit(mutate) {
        const run = async () => {
            const res = await api.storage.local.get([S.HISTORY_KEY, LIBRARY_KEY]);
            const hist = isPlainObject(res[S.HISTORY_KEY]) ? res[S.HISTORY_KEY] : {};
            const lib = sanitizeLibrary(res[LIBRARY_KEY]);
            const extra = mutate(lib, hist);
            if (extra === false) return false;
            const histAfter = (extra && extra.history) || hist;
            const live = (k) => has(histAfter, k);
            lib.favorites = lib.favorites.filter(live);
            lib.collections.forEach(c => { c.keys = c.keys.filter(live); });
            const write = { [LIBRARY_KEY]: lib };
            if (extra && extra.history) write[S.HISTORY_KEY] = extra.history;
            await api.storage.local.set(write);
            if (extra && extra.removeKeys && extra.removeKeys.length) await api.storage.local.remove(extra.removeKeys);
            library = lib;
            setHistory(histAfter);
            if (extra && extra.removeKeys) extra.removeKeys.forEach(k => { if (k.startsWith(BM_PREFIX)) bookmarks.delete(k.slice(BM_PREFIX.length)); });
            render();
            return true;
        };
        writeChain = writeChain.then(run, run);
        return writeChain.catch((err) => {
            showMessage(`Could not save: ${(err && err.message) || err}`);
            return false;
        });
    }

    // -------------------------------------------------------------------
    // Model
    // -------------------------------------------------------------------
    function buildItems() {
        const fav = new Set(library.favorites);
        const items = [];
        for (const [key, e] of Object.entries(history)) {
            const t = Math.max(0, finite(e.t));
            const d = Math.max(0, finite(e.d));
            const target = resumeTarget(e);
            const host = hostOf(webUrl(e.page) || e.url) || hostOf(e.url);
            const title = cleanTitle(e.title);
            const done = !!e.done;
            const pct = done ? 100 : d ? Math.min(100, Math.round((t / d) * 100)) : 0;
            items.push({
                key, t, d, done, pct, target, host,
                title: title || host || 'Untitled video',
                updatedAt: finite(e.updatedAt),
                bms: bookmarks.get(key) || [],
                fav: fav.has(key),
                inProgress: t > 0 && d > 0 && t < d - 20 && !done
            });
        }
        return items;
    }

    function matches(item, tokens) {
        if (!tokens.length) return true;
        const hay = `${item.title} ${item.host}`.toLowerCase();
        return tokens.every(tok => hay.includes(tok));
    }

    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

    function sortItems(list) {
        const byRecent = (a, b) => b.updatedAt - a.updatedAt;
        if (sort === 'title') return list.sort((a, b) => collator.compare(a.title, b.title) || byRecent(a, b));
        if (sort === 'progress') return list.sort((a, b) => b.pct - a.pct || byRecent(a, b));
        return list.sort(byRecent);
    }

    // -------------------------------------------------------------------
    // Markup
    // -------------------------------------------------------------------
    const ICON = {
        star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.8 2.5 5.1 5.6.8-4.05 3.95.95 5.6L12 16.6l-5 2.65.95-5.6L3.9 9.7l5.6-.8z"/></svg>',
        folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h4l2 2h7A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/></svg>',
        bookmark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5h10v15l-5-3.5-5 3.5z"/></svg>',
        trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7"/></svg>',
        minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M8.5 12h7"/></svg>',
        open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="M7.5 5.2v13.6a.9.9 0 0 0 1.37.77l10.9-6.8a.9.9 0 0 0 0-1.54l-10.9-6.8a.9.9 0 0 0-1.37.77z"/></svg>',
        chevron: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg>'
    };

    /** data-* attributes shared by every control of a card, used to restore focus after a render. */
    function ctl(action, scope, key, extra) {
        let s = `data-action="${action}" data-scope="${esc(scope)}" data-key="${esc(key)}"`;
        if (extra) for (const [k, v] of Object.entries(extra)) s += ` data-${k}="${esc(v)}"`;
        return s;
    }

    function cardMarkup(item, scope, level, collection) {
        const n = ++uid;
        const title = item.title;
        const t = esc(title);
        const colsOpen = openPanels.has(`${scope}|${item.key}|cols`);
        const bmsOpen = item.bms.length > 0 && openPanels.has(`${scope}|${item.key}|bms`);
        const timeText = item.d ? `${fmtTime(item.t)} / ${fmtTime(item.d)}` : fmtTime(item.t);
        const status = item.done ? 'Finished' : `${item.pct}%`;
        const valueText = item.done ? 'Finished' : item.d ? `${item.pct}% watched, ${fmtTime(item.t)} of ${fmtTime(item.d)}` : `${fmtTime(item.t)} watched, length unknown`;
        const memberOf = library.collections.filter(c => c.keys.includes(item.key));

        const open = item.target
            ? `<a class="btn small btn-primary vc-open" href="${esc(item.target)}" target="_blank" rel="noopener noreferrer" ${ctl('open', scope, item.key)} aria-label="Open ${t} in a new tab" title="${esc(item.target)}">${ICON.open}Open</a>`
            : `<button type="button" class="btn small vc-open" disabled aria-label="Open ${t}: no web page was saved for this video">${ICON.open}Open</button>`;

        let colsPanel = '';
        if (colsOpen) {
            const boxes = library.collections.length
                ? library.collections.map(c => `<label class="lib-check"><input type="checkbox" ${ctl('toggle-col', scope, item.key, { col: c.id })}${c.keys.includes(item.key) ? ' checked' : ''}><span>${esc(c.name)}</span></label>`).join('')
                : '<p class="muted">No collections yet.</p>';
            colsPanel = `<fieldset class="vc-panel" id="p${n}c"><legend class="sr-only">Collections for ${t}</legend>${boxes}
                <button type="button" class="btn small btn-quiet" ${ctl('new-col-for', scope, item.key)}>+ New collection…</button></fieldset>`;
        }

        let bmsPanel = '';
        if (bmsOpen) {
            const rows = item.bms.map((b, i) => {
                const label = esc(b.label || `Bookmark ${i + 1}`);
                return item.target
                    ? `<li><a class="bm-link" href="${esc(item.target)}" target="_blank" rel="noopener noreferrer" ${ctl('bm-open', scope, item.key, { i })} aria-label="${esc(fmtTime(b.t))}, ${label}: open the page in a new tab"><span class="num bm-t">${fmtTime(b.t)}</span><span class="bm-label">${label}</span></a></li>`
                    : `<li><span class="bm-link is-static"><span class="num bm-t">${fmtTime(b.t)}</span><span class="bm-label">${label}</span></span></li>`;
            }).join('');
            bmsPanel = `<div class="vc-panel" id="p${n}b"><p class="muted vc-note">Opening a bookmark opens the page; the player resumes from your saved position, then use the bookmark marks on its timeline.</p><ol class="bm-list" aria-label="Bookmarks in ${t}">${rows}</ol></div>`;
        }

        const colNote = memberOf.length ? ` · <span class="vc-cols">${esc(memberOf.map(c => c.name).join(', '))}</span>` : '';
        return `<li class="card vcard${item.fav ? ' is-fav' : ''}">
            <h${level} class="vc-title name" title="${t}">${t}</h${level}>
            <p class="meta vc-meta"><span>${esc(item.host || 'Unknown site')}</span>${colNote}</p>
            <p class="meta num vc-meta">${timeText} · Watched ${esc(fmtAgo(item.updatedAt))}${item.bms.length ? ` · ${plural(item.bms.length, 'bookmark')}` : ''}</p>
            <div class="vc-progress">
                <div class="bar" role="progressbar" aria-label="Progress of ${t}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${item.pct}" aria-valuetext="${esc(valueText)}"><i style="width:${item.pct}%"></i></div>
                <span class="num vc-pct" aria-hidden="true">${status}</span>
            </div>
            <div class="vc-actions">
                ${open}
                <button type="button" class="icon-btn vc-star" ${ctl('star', scope, item.key)} aria-pressed="${item.fav}" aria-label="Favorite ${t}">${ICON.star}</button>
                <button type="button" class="btn small btn-quiet vc-toggle" ${ctl('cols', scope, item.key)} aria-expanded="${colsOpen}"${colsOpen ? ` aria-controls="p${n}c"` : ''} aria-label="Collections for ${t}">${ICON.folder}<span class="vc-tlabel">Collections</span>${ICON.chevron}</button>
                ${item.bms.length ? `<button type="button" class="btn small btn-quiet vc-toggle" ${ctl('bms', scope, item.key)} aria-expanded="${bmsOpen}"${bmsOpen ? ` aria-controls="p${n}b"` : ''} aria-label="${plural(item.bms.length, 'bookmark')} in ${t}">${ICON.bookmark}<span class="num">${item.bms.length}</span>${ICON.chevron}</button>` : ''}
                <span class="vc-spacer"></span>
                ${collection
                    // Inside a collection the "remove" action takes it out of the collection; removing
                    // from history stays available in the other views.
                    ? `<button type="button" class="icon-btn vc-remove" ${ctl('uncollect', scope, item.key, { col: collection.id })} aria-label="Remove ${t} from the collection ${esc(collection.name)}" title="Remove from collection">${ICON.minus}</button>`
                    : `<button type="button" class="icon-btn vc-remove" ${ctl('remove', scope, item.key)} aria-label="Remove ${t} from history" title="Remove from history">${ICON.trash}</button>`}
            </div>
            ${colsPanel}${bmsPanel}
        </li>`;
    }

    function listMarkup(items, scope, level, collection) {
        return `<ul class="lib-grid">${items.map(it => cardMarkup(it, scope, level, collection)).join('')}</ul>`;
    }

    function emptyMarkup(text, searching) {
        return `<div class="card lib-empty"><p class="muted">${esc(text)}</p>${searching ? '<button type="button" class="btn small" data-action="clear-search" data-scope="" data-key="">Clear search</button>' : ''}</div>`;
    }

    // -------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------
    function scheduleRender(delay) {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(render, delay == null ? 150 : delay);
    }

    function render() {
        clearTimeout(renderTimer);
        uid = 0;
        const items = buildItems();
        const byKey = new Map(items.map(i => [i.key, i]));
        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        const counts = {
            continue: items.filter(i => i.inProgress).length,
            recent: items.length,
            favorites: items.filter(i => i.fav).length,
            collections: library.collections.length,
            bookmarked: items.filter(i => i.bms.length).length
        };
        for (const [k, v] of Object.entries(counts)) {
            const el = document.querySelector(`[data-count="${k}"]`);
            if (el.textContent !== String(v)) el.textContent = String(v);
        }
        const summary = items.length
            ? `${plural(items.length, 'video')} · ${counts.continue} in progress · ${plural(counts.favorites, 'favorite')} · ${plural(counts.collections, 'collection')} · ${counts.bookmarked} with bookmarks`
            : 'Your library is empty.';
        if ($('summary').textContent !== summary) $('summary').textContent = summary;

        let markup;
        let countText;
        $('new-collection').hidden = view !== 'collections';
        if (view === 'collections') {
            if (!library.collections.length) {
                markup = emptyMarkup(VIEWS.collections.empty);
                countText = '';
            } else {
                let shown = 0;
                markup = library.collections.map((c, ci) => {
                    const all = c.keys.map(k => byKey.get(k)).filter(Boolean);
                    const list = sortItems(all.filter(i => matches(i, tokens)));
                    shown += list.length;
                    const body = list.length
                        ? listMarkup(list, c.id, 4, c)
                        : `<p class="muted lib-col-empty">${all.length ? 'No videos in this collection match your search.' : 'Empty. Open “Collections” on any video to add it here.'}</p>`;
                    return `<section class="lib-collection" aria-labelledby="col-h-${ci}">
                        <div class="lib-col-head">
                            <h3 id="col-h-${ci}" class="lib-col-title"><span class="ellipsis">${esc(c.name)}</span> <span class="count num">${plural(all.length, 'video')}</span></h3>
                            <div class="head-actions">
                                <button type="button" class="btn small btn-quiet" data-action="rename-col" data-scope="${esc(c.id)}" data-key="" data-col="${esc(c.id)}" aria-label="Rename the collection ${esc(c.name)}">Rename</button>
                                <button type="button" class="btn small btn-quiet lib-danger-text" data-action="delete-col" data-scope="${esc(c.id)}" data-key="" data-col="${esc(c.id)}" aria-label="Delete the collection ${esc(c.name)}">Delete</button>
                            </div>
                        </div>
                        ${body}
                    </section>`;
                }).join('');
                countText = `${plural(library.collections.length, 'collection')}${tokens.length ? ` · ${plural(shown, 'match', 'matches')}` : ''}`;
            }
        } else {
            const base = items.filter(i => view === 'continue' ? i.inProgress : view === 'favorites' ? i.fav : view === 'bookmarked' ? i.bms.length > 0 : true);
            const list = sortItems(base.filter(i => matches(i, tokens)));
            if (!base.length) markup = emptyMarkup(VIEWS[view].empty);
            else if (!list.length) markup = emptyMarkup(`No videos here match “${query.trim()}”.`, true);
            else markup = listMarkup(list, 'main', 3, null);
            countText = tokens.length ? `${list.length} of ${plural(base.length, 'video')} match` : plural(base.length, 'video');
        }
        if ($('result-count').textContent !== countText) $('result-count').textContent = countText;
        if ($('view-title').textContent !== VIEWS[view].title) $('view-title').textContent = VIEWS[view].title;
        if (markup === lastMarkup) return;
        lastMarkup = markup;

        const container = $('view');
        const focus = focusDescriptor(document.activeElement);
        const y = window.scrollY;
        S.setHTML(container, markup);
        // A live update can drop the focused card from this view (e.g. it finished playing):
        // keep keyboard users inside the main region instead of on <body>.
        if (focus) restoreFocus(focus, $('main'), true);
        if (window.scrollY !== y) window.scrollTo(0, y);
    }

    function focusDescriptor(el) {
        if (!el || !$('view').contains(el) || !el.dataset || !el.dataset.action) return null;
        const { action, scope, key, col, i } = el.dataset;
        return { action, scope, key, col, i };
    }

    function selectorFor(d) {
        let sel = `[data-action="${CSS.escape(d.action)}"][data-scope="${CSS.escape(d.scope || '')}"][data-key="${CSS.escape(d.key || '')}"]`;
        if (d.col) sel += `[data-col="${CSS.escape(d.col)}"]`;
        if (d.i != null) sel += `[data-i="${CSS.escape(String(d.i))}"]`;
        return sel;
    }

    /** Focus the control matching descriptor d (else fallback). quiet: keep the scroll position. */
    function restoreFocus(d, fallback, quiet) {
        const el = $('view').querySelector(selectorFor(d));
        const target = el || fallback;
        if (target && document.activeElement !== target) target.focus({ preventScroll: !!quiet });
        return !!el;
    }

    // -------------------------------------------------------------------
    // Dialog (confirm / name)
    // -------------------------------------------------------------------
    function ask(opts) {
        const dlg = $('dialog');
        if (typeof dlg.showModal !== 'function') {
            // Very old engines: native prompts keep the flow usable.
            if (opts.name !== undefined) {
                const v = window.prompt(opts.title, opts.name);
                const err = v == null ? null : opts.validate(cleanName(v));
                if (err) showMessage(err);
                return Promise.resolve({ ok: v != null && !err, name: cleanName(v), checked: false });
            }
            return Promise.resolve({ ok: window.confirm(`${opts.title}\n\n${opts.text || ''}`), checked: false });
        }
        const returnTo = document.activeElement;
        $('dialog-title').textContent = opts.title;
        $('dialog-text').textContent = opts.text || '';
        $('dialog-text').hidden = !opts.text;
        $('dialog-ok').textContent = opts.okLabel || 'OK';
        $('dialog-ok').classList.toggle('btn-danger', !!opts.danger);
        $('dialog-ok').classList.toggle('btn-primary', !opts.danger);
        const nameField = $('dialog-name-field');
        const input = $('dialog-name');
        const error = $('dialog-error');
        nameField.hidden = opts.name === undefined;
        input.value = opts.name || '';
        error.hidden = true;
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
        $('dialog-check-field').hidden = !opts.check;
        $('dialog-check').checked = false;
        $('dialog-check-label').textContent = opts.check || '';
        dlg.returnValue = '';
        return new Promise((resolve) => {
            $('dialog-form').onsubmit = (e) => {
                if (opts.name === undefined) return;
                const msg = opts.validate(cleanName(input.value));
                if (msg) {
                    e.preventDefault();
                    error.textContent = msg;
                    error.hidden = false;
                    input.setAttribute('aria-invalid', 'true');
                    input.setAttribute('aria-describedby', 'dialog-error');
                    input.focus();
                }
            };
            $('dialog-cancel').onclick = () => dlg.close('');
            dlg.onclose = () => {
                dlg.onclose = null;
                const ok = dlg.returnValue === 'ok';
                resolve({ ok, name: cleanName(input.value), checked: $('dialog-check').checked, returnTo });
                if (returnTo && returnTo.isConnected) returnTo.focus();
            };
            dlg.showModal();
            if (opts.name !== undefined) { input.focus(); input.select(); } else if (opts.danger) $('dialog-cancel').focus();
            else $('dialog-ok').focus();
        });
    }

    function nameValidator(exceptId) {
        return (name) => {
            if (!name) return 'Enter a name.';
            const clash = library.collections.find(c => c.id !== exceptId && c.name.toLowerCase() === name.toLowerCase());
            return clash ? `A collection named “${clash.name}” already exists.` : '';
        };
    }

    // -------------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------------
    const titleOf = (key) => {
        const e = history[key];
        if (!e) return 'this video';
        return cleanTitle(e.title) || hostOf(webUrl(e.page) || e.url) || 'this video';
    };
    const collectionById = (id) => library.collections.find(c => c.id === id);

    function toggleFavorite(key) {
        const title = titleOf(key);
        let nowFav = false;
        commit((lib) => {
            const i = lib.favorites.indexOf(key);
            if (i >= 0) lib.favorites.splice(i, 1);
            else {
                if (lib.favorites.length >= MAX_KEYS) { showMessage(`You can keep up to ${MAX_KEYS} favorites.`); return false; }
                lib.favorites.unshift(key);
                nowFav = true;
            }
        }).then(ok => { if (ok) announce(nowFav ? `Added ${title} to favorites` : `Removed ${title} from favorites`); });
    }

    function setMembership(colId, key, member) {
        const title = titleOf(key);
        const c = collectionById(colId);
        const name = c ? c.name : 'the collection';
        commit((lib) => {
            const col = lib.collections.find(x => x.id === colId);
            if (!col) return false;
            const i = col.keys.indexOf(key);
            if (member && i < 0) {
                if (col.keys.length >= MAX_KEYS) { showMessage(`“${col.name}” is full (${MAX_KEYS} videos).`); return false; }
                col.keys.unshift(key);
            } else if (!member && i >= 0) col.keys.splice(i, 1);
            else return false;
        }).then(ok => { if (ok) announce(member ? `Added ${title} to ${name}` : `Removed ${title} from ${name}`); });
    }

    async function createCollection(name, firstKey) {
        let created = null;
        const ok = await commit((lib) => {
            if (lib.collections.length >= MAX_COLLECTIONS) { showMessage(`You can have up to ${MAX_COLLECTIONS} collections. Delete one first.`); return false; }
            if (lib.collections.some(c => c.name.toLowerCase() === name.toLowerCase())) { showMessage(`A collection named “${name}” already exists.`); return false; }
            created = { id: newId(), name, keys: firstKey ? [firstKey] : [], createdAt: Date.now() };
            lib.collections.push(created);
        });
        return ok ? created : null;
    }

    /** Returns the data-* descriptor of the same control on the neighbouring card, for focus. */
    function neighbourDescriptor(el, action) {
        const li = el.closest('li.vcard');
        const next = li && (li.nextElementSibling || li.previousElementSibling);
        const ctlEl = next && next.querySelector(`[data-action="${action}"]`);
        return ctlEl ? focusDescriptor(ctlEl) : null;
    }

    async function removeFromHistory(el, key) {
        const title = titleOf(key);
        const desc = focusDescriptor(el);
        const n = (bookmarks.get(key) || []).length;
        const res = await ask({
            title: `Remove “${title}” from history?`,
            text: 'Its saved position, favorite and collection entries are removed. You cannot undo this.',
            check: n ? `Also delete its ${plural(n, 'bookmark')}` : '',
            okLabel: 'Remove',
            danger: true
        });
        if (!res.ok) return;
        // A live update may have re-rendered the list while the dialog was open.
        const live = (desc && $('view').querySelector(selectorFor(desc))) || el;
        const next = live.isConnected ? neighbourDescriptor(live, 'remove') : null;
        const ok = await commit((lib, hist) => {
            if (!has(hist, key)) return { history: hist };
            const copy = { ...hist };
            delete copy[key];
            return { history: copy, removeKeys: res.checked ? [BM_PREFIX + key] : [] };
        });
        if (!ok) return;
        openPanels.forEach(p => { if (p.split('|')[1] === key) openPanels.delete(p); });
        if (!next || !restoreFocus(next)) $('main').focus();
        announce(`Removed ${title} from history${res.checked ? ' with its bookmarks' : ''}`);
    }

    async function onViewClick(e) {
        const el = e.target.closest('[data-action]');
        if (!el || !$('view').contains(el)) return;
        const { action, key, scope, col } = el.dataset;
        switch (action) {
            case 'star': toggleFavorite(key); break;
            case 'remove': await removeFromHistory(el, key); break;
            case 'cols':
            case 'bms': {
                const id = `${scope}|${key}|${action}`;
                const opening = !openPanels.has(id);
                if (opening) openPanels.add(id); else openPanels.delete(id);
                render();
                break;
            }
            case 'uncollect': {
                const next = neighbourDescriptor(el, 'uncollect');
                setMembership(col, key, false);
                await writeChain;
                if (!next || !restoreFocus(next)) {
                    const rename = $('view').querySelector(`[data-action="rename-col"][data-col="${CSS.escape(col)}"]`);
                    (rename || $('main')).focus();
                }
                break;
            }
            case 'new-col-for': {
                const res = await ask({ title: 'New collection', text: `“${titleOf(key)}” will be added to it.`, name: '', okLabel: 'Create', validate: nameValidator(null) });
                if (!res.ok) return;
                const c = await createCollection(res.name, key);
                if (c) announce(`Created ${c.name} and added ${titleOf(key)}`);
                break;
            }
            case 'rename-col': {
                const c = collectionById(col);
                if (!c) return;
                const res = await ask({ title: 'Rename collection', name: c.name, okLabel: 'Rename', validate: nameValidator(c.id) });
                if (!res.ok || res.name === c.name) return;
                const ok = await commit((lib) => {
                    const x = lib.collections.find(y => y.id === col);
                    if (!x) return false;
                    x.name = res.name;
                });
                if (ok) {
                    restoreFocus({ action: 'rename-col', scope: col, key: '', col });
                    announce(`Renamed to ${res.name}`);
                }
                break;
            }
            case 'delete-col': {
                const c = collectionById(col);
                if (!c) return;
                const res = await ask({ title: `Delete the collection “${c.name}”?`, text: 'The videos stay in your history; only the collection is removed.', okLabel: 'Delete', danger: true });
                if (!res.ok) return;
                const idx = library.collections.findIndex(x => x.id === col);
                const ok = await commit((lib) => {
                    const i = lib.collections.findIndex(x => x.id === col);
                    if (i < 0) return false;
                    lib.collections.splice(i, 1);
                });
                if (!ok) return;
                const neighbour = library.collections[Math.min(idx, library.collections.length - 1)];
                if (!neighbour || !restoreFocus({ action: 'delete-col', scope: neighbour.id, key: '', col: neighbour.id })) $('new-collection-name').focus();
                announce(`Deleted the collection ${c.name}`);
                break;
            }
            case 'clear-search':
                $('search').value = '';
                query = '';
                render();
                $('search').focus();
                announce('Search cleared');
                break;
            case 'open':
            case 'bm-open':
                announce('Opened in a new tab');
                break;
            default:
                break;
        }
    }

    function onViewChange(e) {
        const el = e.target;
        if (!el.dataset || el.dataset.action !== 'toggle-col') return;
        setMembership(el.dataset.col, el.dataset.key, el.checked);
    }

    // -------------------------------------------------------------------
    // Views, settings, export
    // -------------------------------------------------------------------
    function setView(next, fromUser) {
        view = VIEWS[next] ? next : 'recent';
        document.querySelectorAll('.lib-tabs a').forEach(a => {
            if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
        });
        document.title = `${VIEWS[view].title} · Velostream Library`;
        render();
        if (fromUser) announce(`${VIEWS[view].title}: ${$('result-count').textContent || 'empty'}`);
    }

    function applyTheme() {
        const app = $('app');
        const accent = S.ACCENTS[settings.theme] || S.ACCENTS.blue;
        app.dataset.accent = settings.theme;
        app.style.setProperty('--accent', accent.fill);
        app.style.setProperty('--accent-strong', accent.strong);
        document.body.classList.toggle('hc', !!settings.highContrast);
        document.body.classList.toggle('reduce-motion', settings.reducedMotion === 'on');
        const scale = Math.min(1.5, Math.max(0.85, Number(settings.uiScale) || 1));
        document.documentElement.style.setProperty('--scale', String(scale));
    }

    async function exportBackup() {
        const btn = $('export-backup');
        btn.disabled = true;
        try {
            const backup = await S.buildBackup(api);
            // fs_library is not part of the shared backup format yet; it rides along so a future
            // restore can pick it up (sanitizeBackup ignores unknown fields today).
            const raw = await api.storage.local.get(LIBRARY_KEY);
            backup.library = sanitizeLibrary(raw[LIBRARY_KEY]);
            const json = JSON.stringify(backup, null, 2);
            // Chromium: a data: URL; Firefox's downloads API refuses data: URLs, so it gets a blob:
            // URL (revoked once the download finishes).
            let url;
            let blobUrl = null;
            if (S.IS_FIREFOX) url = blobUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
            else url = `data:application/json;base64,${S.toBase64(new TextEncoder().encode(json))}`;
            const id = await api.downloads.download({ url, filename: S.backupFilename(), saveAs: false });
            if (blobUrl) {
                const done = (d) => {
                    if (d.id !== id || !d.state || d.state.current === 'in_progress') return;
                    api.downloads.onChanged.removeListener(done);
                    URL.revokeObjectURL(blobUrl);
                };
                api.downloads.onChanged.addListener(done);
            }
            showMessage('Backup saved to your Downloads folder.', true);
            announce('Backup saved to your Downloads folder');
        } catch (e) {
            showMessage(`Export failed: ${(e && e.message) || e}`);
        } finally {
            btn.disabled = false;
        }
    }

    // -------------------------------------------------------------------
    // Init
    // -------------------------------------------------------------------
    document.addEventListener('DOMContentLoaded', async () => {
        try { $('version').textContent = `Velostream v${api.runtime.getManifest().version}`; } catch (_) { /* no manifest */ }

        const res = await api.storage.local.get([S.HISTORY_KEY, LIBRARY_KEY, S.SETTINGS_KEY]);
        settings = S.mergeSettings(res[S.SETTINGS_KEY]);
        applyTheme();
        setHistory(res[S.HISTORY_KEY]);
        library = sanitizeLibrary(res[LIBRARY_KEY]);
        try { await loadBookmarks(Object.keys(history)); } catch (_) { /* render without bookmarks */ }

        const hash = location.hash.slice(1);
        const initial = VIEWS[hash] ? hash : (buildItems().some(i => i.inProgress) ? 'continue' : 'recent');
        setView(initial, false);

        window.addEventListener('hashchange', () => setView(location.hash.slice(1), true));
        $('view').addEventListener('click', onViewClick);
        $('view').addEventListener('change', onViewChange);

        let searchTimer = 0;
        $('search').addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                query = $('search').value;
                render();
            }, 120);
        });
        $('search').addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && $('search').value) {
                e.preventDefault();
                $('search').value = '';
                query = '';
                render();
                announce('Search cleared');
            }
        });
        $('sort').addEventListener('change', () => {
            sort = $('sort').value;
            render();
            announce(`Sorted by ${$('sort').selectedOptions[0].textContent.toLowerCase()}`);
        });
        $('new-collection').addEventListener('submit', async (e) => {
            e.preventDefault();
            const input = $('new-collection-name');
            const name = cleanName(input.value);
            if (!name) { showMessage('Enter a name for the collection.'); input.focus(); return; }
            const c = await createCollection(name, null);
            if (c) {
                input.value = '';
                showMessage('');
                announce(`Created the collection ${c.name}`);
            }
            input.focus();
        });
        $('export-backup').addEventListener('click', exportBackup);

        // Live updates from the player / popup / another library tab, coalesced.
        api.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            let dirty = false;
            if (changes[S.SETTINGS_KEY]) {
                settings = S.mergeSettings(changes[S.SETTINGS_KEY].newValue);
                applyTheme();
            }
            if (changes[LIBRARY_KEY]) { library = sanitizeLibrary(changes[LIBRARY_KEY].newValue); dirty = true; }
            for (const [k, ch] of Object.entries(changes)) {
                if (k.startsWith(BM_PREFIX)) { setBookmarks(k.slice(BM_PREFIX.length), ch.newValue); dirty = true; }
            }
            if (changes[S.HISTORY_KEY]) {
                setHistory(changes[S.HISTORY_KEY].newValue);
                dirty = true;
                loadBookmarks(Object.keys(history)).then(() => scheduleRender(), () => {});
            }
            if (dirty) scheduleRender();
        });
        // "Watched x ago" labels; the markup comparison makes this a no-op when nothing changed.
        setInterval(() => { if (!document.hidden) render(); }, 60000);
    });
})();
