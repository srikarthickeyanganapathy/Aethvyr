/**
 * Velostream - Popup (Control Center style)
 *
 * - Lists every detected stream of the active tab (ranked, ads flagged, probe metadata).
 * - Launches through the background engine (LAUNCH_PLAYER / LAUNCH_URL), which injects the
 *   player into the top frame and proxies through the frame that owns the stream.
 * - Live engine telemetry every second (bandwidth + sparkline, cache size, workers, look-ahead).
 * - Paste-and-play bar for any .m3u8 / .mpd / media URL.
 * - "Continue watching" list from the per-video watch history.
 * - Persistent settings in chrome.storage.local, shared with the in-page player.
 */
(function () {
    'use strict';

    const S = globalThis.VelostreamShared;
    const api = S.api;
    const $ = (id) => document.getElementById(id);

    let tabId = null;
    let settings = S.mergeSettings(null);
    let lastListSig = '';
    let lastHistorySig = '';
    let playerStreamId = null;
    const spark = [];
    const timers = [];

    function send(message) {
        return api.runtime.sendMessage(message).catch(err => ({ ok: false, error: err && err.message }));
    }

    function announce(text) {
        const el = $('announcer');
        el.textContent = '';
        setTimeout(() => { el.textContent = text; }, 50);
    }

    function showMessage(text, ok) {
        const el = $('message');
        if (!text) { el.hidden = true; return; }
        el.textContent = text;
        el.classList.toggle('ok', !!ok);
        el.hidden = false;
    }

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
        if (!Number.isFinite(ts)) return 'earlier';
        const d = (Date.now() - ts) / 1000;
        if (d < 90) return 'just now';
        if (d < 3600) return `${Math.round(d / 60)} min ago`;
        if (d < 86400) return `${Math.round(d / 3600)} h ago`;
        return `${Math.round(d / 86400)} d ago`;
    }

    function streamName(stream) {
        try {
            const u = new URL(stream.url);
            const file = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
            return file || u.hostname;
        } catch (_) {
            return stream.url;
        }
    }

    function hostOf(url) {
        try { return new URL(url).hostname; } catch (_) { return ''; }
    }

    const TYPE_LABEL = { hls: 'HLS', dash: 'DASH', progressive: 'MP4' };

    /** Text-only metadata: state is never conveyed by colour alone. */
    function streamMeta(stream) {
        const p = stream.probe;
        const parts = [];
        if (!p || p.status === 'pending') {
            if (stream.type !== 'progressive') parts.push('Checking…');
        } else if (p.status === 'error') {
            parts.push(`Unavailable (${p.error})`);
        } else {
            if (p.isMaster) parts.push(`${p.variants || 0} qualit${p.variants === 1 ? 'y' : 'ies'}`);
            if (p.audioTracks > 1) parts.push(`${p.audioTracks} audio`);
            if (p.subtitleTracks) parts.push(`${p.subtitleTracks} subs`);
            if (p.live) parts.push('Live');
            else if (p.duration) parts.push(fmtTime(p.duration));
            if (p.encrypted) parts.push('AES-128');
        }
        return parts.join(' · ') || hostOf(stream.url);
    }

    function renderStreams(streams) {
        const list = $('stream-list');
        // Everything the row renders goes into the signature, so late probe results (resolution,
        // duration, live, errors) and frame changes are not left stale on screen.
        const sig = JSON.stringify(streams.map(s => {
            const p = s.probe || {};
            return [s.id, s.url, s.type, s.isAd, s.frameId, s.frameUrl, p.status, p.error, p.variants, p.maxHeight, p.duration, p.live, p.encrypted, p.audioTracks, p.subtitleTracks, p.isMaster];
        })) + playerStreamId;
        $('empty-state').hidden = streams.length > 0;
        const pill = $('status-pill');
        pill.classList.toggle('active', streams.length > 0);
        // role="status": only touch the text when it changes, or screen readers re-announce it every poll.
        const statusText = playerStreamId ? 'Playing' : streams.length ? `${streams.length} stream${streams.length === 1 ? '' : 's'}` : 'Ready';
        if ($('status-text').textContent !== statusText) $('status-text').textContent = statusText;
        if (sig === lastListSig) return;
        lastListSig = sig;

        const active = document.activeElement;
        const focus = active && list.contains(active) && active.dataset && active.dataset.id ? { action: active.dataset.action, id: active.dataset.id } : null;
        list.replaceChildren();
        streams.forEach((stream, i) => {
            const li = document.createElement('li');
            const playing = stream.id === playerStreamId;
            li.className = `card stream-item${playing ? ' is-playing' : ''}`;
            const name = streamName(stream);
            const res = stream.probe && stream.probe.maxHeight ? `${stream.probe.maxHeight}p` : '';
            const frame = stream.isAd ? '<span class="frame warn">Likely an ad</span>'
                : `<span class="frame">${stream.frameId > 0 ? `Embedded player · ${esc(hostOf(stream.frameUrl))}` : 'Main frame'}</span>`;
            const label = `${TYPE_LABEL[stream.type] || stream.type}${res ? ` ${res}` : ''}, ${name}`;
            S.setHTML(li, `
                <div class="badges"><span class="type ${esc(stream.type)}">${TYPE_LABEL[stream.type] || esc(stream.type)}</span>${res ? `<span class="res">${res}</span>` : ''}</div>
                <div class="info">
                    <div class="name" title="${esc(stream.url)}">${playing ? 'Playing · ' : ''}${esc(name)}</div>
                    <div class="meta">${esc(streamMeta(stream))}</div>
                    ${frame}
                </div>
                <div class="actions">
                    <button type="button" class="btn play-pill" data-action="play" data-id="${esc(stream.id)}" aria-label="Play stream ${i + 1}: ${esc(label)}">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="M7.5 5.2v13.6a.9.9 0 0 0 1.37.77l10.9-6.8a.9.9 0 0 0 0-1.54l-10.9-6.8a.9.9 0 0 0-1.37.77z"/></svg>Play
                    </button>
                    <button type="button" class="icon-btn" data-action="copy" data-id="${esc(stream.id)}" aria-label="Copy link of stream ${i + 1}">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/></svg>
                    </button>
                </div>`);
            li.querySelector('[data-action="play"]').addEventListener('click', (e) => launch(stream, e.currentTarget));
            li.querySelector('[data-action="copy"]').addEventListener('click', () => copyUrl(stream));
            list.appendChild(li);
        });
        if (focus) {
            // Stream ids may contain ':' — keep action and id separate (the old "a:b".split broke them).
            const el = list.querySelector(`[data-action="${CSS.escape(focus.action)}"][data-id="${CSS.escape(focus.id)}"]`);
            if (el) el.focus();
        }
    }

    // Polls run on intervals; a slow background reply must not let calls pile up or land out of order.
    let streamsBusy = false;
    let statsBusy = false;

    async function refreshStreams() {
        if (tabId === null || streamsBusy) return;
        streamsBusy = true;
        try { await doRefreshStreams(); } finally { streamsBusy = false; }
    }

    async function doRefreshStreams() {
        const res = await send({ action: 'GET_STREAMS', tabId });
        if (!res || !res.ok) return;
        playerStreamId = res.player ? res.player.streamId : null;
        $('player-section').hidden = !res.player;
        if (res.player) {
            const s = (res.streams || []).find(x => x.id === res.player.streamId);
            $('player-stream').textContent = s ? streamName(s) : 'Stream';
            const live = s && s.probe && s.probe.live;
            $('export-btn').disabled = !!res.player.exporting || (s && s.type === 'dash');
            $('export-btn').textContent = res.player.exporting ? 'Saving…' : live ? 'Record / save' : 'Download';
        }
        renderStreams(res.streams || []);
        // Explain why nothing is playable on DRM / proprietary-protocol sites (YouTube, Netflix…).
        const empty = $('empty-copy');
        if (!(res.streams || []).length) {
            const copy = res.drm
                ? `This site uses DRM (${(res.drm.keySystem || 'encrypted media').replace(/^com\./, '')}). Protected video can only be decrypted by the site's own player.`
                : res.proprietaryMse
                    ? 'This site streams with its own protocol (no HLS/DASH link on the network), so only its own player can drive it. Try a site that serves .m3u8, .mpd or MP4.'
                    : 'Looking for videos… Start the video on the page if nothing appears.';
            if (empty.textContent !== copy) empty.textContent = copy;
        }
    }

    function drawSpark(mbps) {
        spark.push(mbps);
        if (spark.length > 30) spark.shift();
        const max = Math.max(1, ...spark);
        const pts = spark.map((v, i) => `${(i / 29) * 120},${26 - (v / max) * 24}`).join(' ');
        $('spark').querySelector('polyline').setAttribute('points', pts);
    }

    async function refreshStats() {
        if (tabId === null || statsBusy) return;
        statsBusy = true;
        try { await doRefreshStats(); } finally { statsBusy = false; }
    }

    async function doRefreshStats() {
        const res = await send({ action: 'GET_STATS', tabId });
        if (!res || !res.ok) return;
        const g = res.global || {};
        const sess = res.session;
        const bw = sess ? sess.bandwidth : g.bandwidth;
        const workers = sess ? sess.activeWorkers : g.activeDownloads || 0;
        $('stat-bandwidth').textContent = S.formatBitrate(bw);
        $('stat-active').textContent = String(workers);
        drawSpark((bw || 0) / 1e6);
        if (sess) {
            $('stat-cache').textContent = `${S.formatBytes(sess.cacheBytes)} • ${workers}×`;
            const ahead = Math.round((sess.bufferAhead || 0) + (sess.cachedAhead || 0));
            $('stat-ahead').textContent = `${ahead} s ahead${sess.accelerated ? ' · range ×4' : ''}${sess.dvrSeconds ? ` · DVR ${fmtTime(sess.dvrSeconds)}` : ''}`;
        } else {
            $('stat-cache').textContent = `— • ${workers}×`;
            $('stat-ahead').textContent = 'Idle';
        }
    }

    async function launch(stream, button) {
        button.disabled = true;
        showMessage('');
        announce('Opening the Velostream player');
        const res = await send({ action: 'LAUNCH_PLAYER', tabId, streamId: stream.id });
        if (res && res.ok) {
            window.close();
            return;
        }
        button.disabled = false;
        showMessage(friendlyError(res && res.error));
        // The list may have been re-rendered while waiting: focus the live button for this stream.
        const live = button.isConnected ? button
            : $('stream-list').querySelector(`[data-action="play"][data-id="${CSS.escape(String(stream.id))}"]`);
        if (live) live.focus();
    }

    function friendlyError(msg) {
        msg = msg || 'Could not start the player on this page.';
        return /Cannot access|chrome:|about:|extensions gallery|missing host permission|cannot be scripted/i.test(msg)
            ? 'This page cannot be scripted by extensions (browser or store page).'
            : msg;
    }

    async function copyUrl(stream) {
        try {
            await navigator.clipboard.writeText(stream.url);
            showMessage('Link copied', true);
            announce('Link copied');
        } catch (_) {
            showMessage('Copy failed. Hover the stream name to see its link.');
        }
    }

    // -------------------------------------------------------------------
    // Watch history ("Continue watching")
    // -------------------------------------------------------------------
    /** Returns url only if it is a web page we may open in a tab (http/https). */
    function webUrl(url) {
        if (typeof url !== 'string' || !url) return null;
        try {
            const u = new URL(url);
            return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
        } catch (_) {
            return null;
        }
    }

    /**
     * Where "Open" goes: the page the video was watched on, else the media URL itself. Older builds
     * stored the player's own chrome-extension:// / moz-extension:// page as `page`, which must never
     * be opened from here (it is not resumable and is not a web page).
     */
    function resumeTarget(e) {
        return webUrl(e.page) || webUrl(e.url);
    }

    let historySeq = 0;

    async function renderHistory() {
        // The player writes history every few seconds; only the newest read may render.
        const seq = ++historySeq;
        const res = await api.storage.local.get(S.HISTORY_KEY);
        if (seq !== historySeq) return;
        const all = res[S.HISTORY_KEY] || {};
        const entries = Object.entries(all).filter(([, e]) => e && !e.done && e.t > 15)
            .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).slice(0, 15);
        const sig = JSON.stringify(entries.map(([k, e]) => [k, Math.round(e.t), Math.round(e.d || 0), e.title, e.page, e.url]));
        $('history-count').textContent = String(entries.length);
        $('history-empty').hidden = entries.length > 0;
        $('history-clear').hidden = entries.length === 0;
        if (sig === lastHistorySig) return;
        lastHistorySig = sig;
        const list = $('history-list');
        const active = document.activeElement;
        const focus = active && list.contains(active) ? { open: active.dataset.open, del: active.dataset.del } : null;
        list.replaceChildren();
        for (const [key, e] of entries) {
            const li = document.createElement('li');
            li.className = 'history-item';
            const pct = e.d ? Math.min(100, Math.round((e.t / e.d) * 100)) : 0;
            const target = resumeTarget(e);
            const title = e.title || hostOf(e.url) || 'this video';
            S.setHTML(li, `
                <div class="info">
                    <div class="name" title="${esc(e.url)}">${esc(e.title || hostOf(e.url))}</div>
                    <div class="meta num">${fmtTime(e.t)}${e.d ? ` / ${fmtTime(e.d)}` : ''} · ${esc(fmtAgo(e.updatedAt))}</div>
                    <div class="bar" role="progressbar" aria-label="Watched" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-valuetext="${pct}% watched"><i style="width:${pct}%"></i></div>
                </div>
                ${target ? `<button type="button" class="btn small" data-open="${esc(key)}" title="${esc(target)}" aria-label="${e.page ? 'Resume' : 'Direct stream'} for ${esc(title)}">${e.page ? 'Resume' : 'Direct stream'}</button>` : '<span aria-hidden="true"></span>'}
                <button type="button" class="icon-btn" data-del="${esc(key)}" aria-label="Remove ${esc(title)} from history">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
                </button>`);
            const open = li.querySelector('[data-open]');
            if (open) open.addEventListener('click', () => { api.tabs.create({ url: target }); });
            li.querySelector('[data-del]').addEventListener('click', async () => {
                // Move focus to a neighbour first so keyboard users are not dropped to <body>.
                const next = li.nextElementSibling || li.previousElementSibling;
                const nextKey = next && next.querySelector('[data-del]') ? next.querySelector('[data-del]').dataset.del : null;
                const result = await api.runtime.sendMessage({ action: 'HISTORY_REMOVE', key }).catch(() => null);
                if (!result?.ok) { showMessage('Could not remove history.'); return; }
                lastHistorySig = '';
                await renderHistory();
                const el = nextKey && list.querySelector(`[data-del="${CSS.escape(nextKey)}"]`);
                (el || $('history').querySelector('summary')).focus();
                announce('Removed from history');
            });
            list.appendChild(li);
        }
        if (focus) {
            const sel = focus.open ? `[data-open="${CSS.escape(focus.open)}"]` : focus.del ? `[data-del="${CSS.escape(focus.del)}"]` : null;
            const el = sel && list.querySelector(sel);
            if (el) el.focus();
        }
    }

    // -------------------------------------------------------------------
    // Settings
    // -------------------------------------------------------------------
    function applyPopupTheme() {
        $('app').dataset.accent = settings.theme;
        document.body.classList.toggle('hc', !!settings.highContrast);
        document.body.classList.toggle('reduce-motion', settings.reducedMotion === 'on');
        document.documentElement.style.setProperty('--scale', String(Math.min(settings.uiScale || 1, 1.25)));
        // Radio group: one tab stop (the checked swatch); arrow keys move within the group.
        const swatches = [...document.querySelectorAll('.swatch')];
        const anyChecked = swatches.some(b => b.dataset.accent === settings.theme);
        swatches.forEach((b, i) => {
            const checked = b.dataset.accent === settings.theme;
            b.setAttribute('aria-checked', String(checked));
            b.tabIndex = checked || (!anyChecked && i === 0) ? 0 : -1;
        });
        syncSiteToggle();
    }

    function readPath(obj, path) {
        return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
    }

    /** Human label for a stored value that is not one of a select's options. */
    function customLabel(name, v) {
        const n = Number(v);
        switch (name) {
            case 'cacheSizeMB': return n >= 1024 ? `${+(n / 1024).toFixed(1)} GB` : `${n} MB`;
            case 'maxBufferSec': return n >= 60 ? `${+(n / 60).toFixed(1)} min` : `${n} s`;
            case 'defaultSpeed': return `${n}×`;
            case 'uiScale': return `${Math.round(n * 100)}%`;
            case 'autoHideMs': return `${+(n / 1000).toFixed(1)} seconds`;
            case 'qualityCap': return `${n}p`;
            case 'seekStep': return `${n} s`;
            case 'skipSeconds': return `+${n} s`;
            case 'dvrMinutes': return `${n} min`;
            default: return String(v);
        }
    }

    /**
     * Shows `value` in a select. A value saved elsewhere (the player's panel, an older build, a
     * synced profile) that is not among the options is added as a "(custom)" option instead of
     * rendering the select blank; such options are dropped again once no longer needed.
     */
    function setSelectValue(el, value) {
        const str = String(value);
        el.querySelectorAll('option[data-custom]').forEach(o => { if (o.value !== str) o.remove(); });
        const match = [...el.options].find(o => o.value === str || (el.dataset.type === 'number' && Number(o.value) === Number(value)));
        if (!match && value !== undefined && value !== null && str !== '') {
            const opt = document.createElement('option');
            opt.value = str;
            opt.dataset.custom = '1';
            opt.textContent = `${customLabel(el.name, value)} (custom)`;
            // Keep numeric lists ordered.
            const after = el.dataset.type === 'number' ? [...el.options].find(o => !o.dataset.custom && Number(o.value) > Number(value) && Number(o.value) !== 0) : null;
            el.insertBefore(opt, after || null);
            el.value = str;
            return;
        }
        el.value = match ? match.value : str;
    }

    /** Writes settings into the form; `skip` (the control being edited) is left alone. */
    function fillForm(skip) {
        for (const el of $('settings-form').elements) {
            if (!el.name || el === skip) continue;
            const v = readPath(settings, el.name);
            if (el.type === 'checkbox') el.checked = !!v;
            else if (el.tagName === 'SELECT') setSelectValue(el, v);
            else el.value = String(v);
        }
        applyPopupTheme();
    }

    // Saves are serialized and applied to the freshest stored copy, so two quick changes in the popup
    // (or one here while the player writes settings) do not overwrite each other.
    let saveChain = Promise.resolve();

    function saveSettings(mutate, label) {
        const run = async () => {
            let base = settings;
            try {
                const res = await api.storage.local.get(S.SETTINGS_KEY);
                base = S.mergeSettings(res[S.SETTINGS_KEY]);
            } catch (_) { /* fall back to the in-memory copy */ }
            const next = JSON.parse(JSON.stringify(base));
            mutate(next);
            const patch = {};
            for (const [key, value] of Object.entries(next)) {
                if (JSON.stringify(value) === JSON.stringify(base[key])) continue;
                if (['audio', 'subtitles', 'gestures', 'mouse', 'memory'].includes(key) && value && typeof value === 'object') {
                    patch[key] = Object.fromEntries(Object.entries(value).filter(([field, v]) =>
                        JSON.stringify(v) !== JSON.stringify(base[key]?.[field])));
                } else patch[key] = value;
            }
            const result = await api.runtime.sendMessage({ action: 'SETTINGS_PATCH', patch });
            if (!result?.ok) throw new Error(result?.error || 'Settings write failed');
            settings = result.settings;
            applyPopupTheme();
            if (label) announce(`${label} saved`);
        };
        saveChain = saveChain.then(run, run);
        return saveChain.catch(() => showMessage('Could not save settings.'));
    }

    function saveField(el) {
        let value = el.type === 'checkbox' ? el.checked : el.value;
        if (el.dataset.type === 'number') value = Number(value);
        const keys = el.name.split('.');
        const label = el.labels && el.labels[0] ? el.labels[0].textContent.trim() : (el.closest('.field') ? el.closest('.field').textContent.trim() : el.name);
        saveSettings(next => {
            let o = next;
            for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
            o[keys[keys.length - 1]] = value;
        }, label);
    }

    async function loadSettings() {
        const res = await api.storage.local.get(S.SETTINGS_KEY);
        settings = S.mergeSettings(res[S.SETTINGS_KEY]);
        fillForm();
    }

    /** Per-site auto-replace: detected videos on this site open in Velostream automatically. */
    let siteHost = '';

    /** Keeps the per-site switch in step with settings changed elsewhere (reset, the player). */
    function syncSiteToggle() {
        if (!siteHost) return;
        const box = $('site-auto');
        if (document.activeElement !== box) box.checked = settings.autoSites.includes(siteHost);
    }

    function setupSiteToggle(tab) {
        let host = '';
        try { const u = new URL(tab && tab.url); if (/^https?:$/.test(u.protocol)) host = u.hostname; } catch (_) { /* no url */ }
        if (!host) return;
        siteHost = host;
        $('site-card').hidden = false;
        $('site-host').textContent = host;
        const box = $('site-auto');
        box.checked = settings.autoSites.includes(host);
        box.addEventListener('change', () => {
            saveSettings(next => {
                const set = new Set(next.autoSites);
                if (box.checked) set.add(host); else set.delete(host);
                next.autoSites = [...set];
            }, box.checked ? `Auto-play on ${host} on` : `Auto-play on ${host} off`);
        });
    }

    // Firefox MV3 makes <all_urls> opt-in.
    async function checkPermissions() {
        if (!api.permissions || !api.permissions.contains) return;
        try {
            $('permission-banner').hidden = await api.permissions.contains({ origins: ['<all_urls>'] });
        } catch (_) { /* unsupported */ }
    }

    // -------------------------------------------------------------------
    // Init
    // -------------------------------------------------------------------
    document.addEventListener('DOMContentLoaded', async () => {
        $('version').textContent = `Velostream v${api.runtime.getManifest().version}`;
        const [tab] = await api.tabs.query({ active: true, currentWindow: true }).catch(() => []);
        tabId = tab ? tab.id : null;

        for (const [value, label] of S.GRAPHICS_PRESETS) $('s-shader').add(new Option(label, value));
        await loadSettings();
        setupSiteToggle(tab); // needs the loaded settings
        checkPermissions();
        renderHistory();

        $('empty-rescan').addEventListener('click', () => $('rescan-btn').click());
        $('settings-form').addEventListener('change', (e) => { if (e.target.name) saveField(e.target); });
        document.querySelectorAll('.swatch').forEach((b, i, all) => {
            b.addEventListener('click', () => saveSettings(next => { next.theme = b.dataset.accent; }, `${b.getAttribute('aria-label')} accent`));
            b.addEventListener('keydown', (e) => {
                const n = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
                if (!n) return;
                e.preventDefault();
                const next = all[(i + n + all.length) % all.length];
                next.focus();
                next.click();
            });
        });
        // Backup / restore. A toolbar popup closes as soon as a file picker or save dialog takes
        // focus (always on Firefox), so: export saves straight to Downloads without a dialog, and
        // import continues in this same page opened as a tab.
        const inTab = new URLSearchParams(location.search).has('tab');
        const panelButtons = [...document.querySelectorAll('[data-panel]')];
        function showPanel(id) {
            for (const button of panelButtons) {
                const active = button.dataset.panel === id;
                button.setAttribute('aria-pressed', String(active));
                $(button.dataset.panel).hidden = !active;
            }
            document.querySelector('.popup-main').scrollTop = 0;
        }
        for (const button of panelButtons) button.addEventListener('click', () => showPanel(button.dataset.panel));
        document.querySelector('.skip-link').addEventListener('click', () => showPanel('streams-panel'));
        if (inTab && location.hash === '#settings') { showPanel('settings-panel'); $('backup-import').focus(); }
        $('backup-export').addEventListener('click', async () => {
            try {
                const json = JSON.stringify(await S.buildBackup(api), null, 2);
                // Chromium: a data: URL survives the popup closing; Firefox's downloads API refuses
                // data: URLs, so it gets a blob: URL (revoked once the download finishes).
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
            } catch (e) {
                showMessage(`Export failed: ${(e && e.message) || e}`);
            }
        });
        $('backup-import').addEventListener('click', () => {
            if (!inTab) {
                api.tabs.create({ url: api.runtime.getURL('popup/popup.html?tab=1#settings') });
                window.close();
                return;
            }
            $('backup-file').click();
        });
        $('backup-file').addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            e.target.value = '';
            if (!file) return;
            if (file.size > 5 * 1024 * 1024) { showMessage('That file is too large to be a Velostream backup.'); return; }
            try {
                const res = await api.runtime.sendMessage({ action: 'BACKUP_RESTORE', json: await file.text() });
                if (!res?.ok) throw new Error(res?.error || 'Could not restore backup.');
                const fresh = await api.storage.local.get(S.SETTINGS_KEY);
                settings = S.mergeSettings(fresh[S.SETTINGS_KEY]);
                fillForm();
                showMessage(`Settings & profiles restored (${res.profiles} site profiles, ${res.bookmarks} bookmarked videos, ${res.history} history entries).`, true);
                announce('Settings and profiles restored');
            } catch (err) {
                showMessage(`Import failed: ${(err && err.message) || err}`);
            }
        });
        $('reset-settings').addEventListener('click', async () => {
            // Through the save queue, so a pending field save cannot land after the reset.
            await saveSettings(next => {
                for (const k of Object.keys(next)) delete next[k];
                Object.assign(next, JSON.parse(JSON.stringify(S.DEFAULT_SETTINGS)));
            });
            fillForm();
            announce('All settings reset');
        });
        $('grant-permission').addEventListener('click', async () => {
            const ok = await api.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
            if (ok) {
                $('permission-banner').hidden = true;
                showMessage('Access granted. Reload the page with the video.', true);
            } else {
                showMessage('Access was not granted. Velostream cannot detect videos without it.');
            }
        });
        $('rescan-btn').addEventListener('click', async () => {
            await send({ action: 'RESCAN', tabId });
            announce('Rescanning page');
            setTimeout(refreshStreams, 700);
        });
        $('clear-btn').addEventListener('click', async () => {
            await send({ action: 'CLEAR_STREAMS', tabId });
            lastListSig = '';
            await refreshStreams();
            announce('Stream list cleared');
        });
        $('close-player-btn').addEventListener('click', async () => {
            const res = await send({ action: 'CLOSE_PLAYER', tabId });
            if (res && res.ok) { announce('Player closed'); setTimeout(refreshStreams, 400); } else showMessage((res && res.error) || 'Could not close the player.');
        });
        $('export-btn').addEventListener('click', async () => {
            const res = await send({ action: 'EXPORT_STREAM', tabId });
            if (res && res.ok) { showMessage('Saving in the player. Keep the tab open until it finishes.', true); announce('Saving started'); } else showMessage((res && res.error) || 'Could not start saving.');
        });
        $('paste-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const input = $('paste-url');
            const url = input.value.trim();
            if (!url) { input.focus(); return; }
            const go = $('paste-form').querySelector('.go');
            go.disabled = true;
            showMessage('');
            announce('Opening link');
            const res = await send({ action: 'LAUNCH_URL', tabId, url });
            go.disabled = false;
            if (res && res.ok) { window.close(); return; }
            showMessage(friendlyError(res && res.error));
            input.focus();
        });
        $('history-clear').addEventListener('click', async () => {
            const res = await send({ action: 'HISTORY_CLEAR' });
            if (!res?.ok) { showMessage(res?.error || 'Could not clear history.'); return; }
            lastHistorySig = '';
            renderHistory();
            announce('History cleared');
        });
        $('open-library').addEventListener('click', () => {
            api.tabs.create({ url: api.runtime.getURL('popup/library.html') });
            window.close();
        });
        // Sync status line (written by background/sync.js).
        const renderSyncStatus = (st) => {
            const el = $('sync-status');
            if (!el) return;
            const base = "Uses your browser account's sync (Google or Mozilla). Off by default.";
            if (!settings.syncEnabled || !st || st.state === 'off') { el.textContent = base; return; }
            if (st.state === 'error') { el.textContent = `Sync problem: ${st.error || 'unknown error'}`; return; }
            const ago = st.lastSyncAt ? Math.max(0, Math.round((Date.now() - st.lastSyncAt) / 60000)) : null;
            el.textContent = ago === null ? 'Sync is on. Waiting for the first sync…' : `Sync is on · last synced ${ago < 1 ? 'just now' : `${ago} min ago`}.`;
        };
        api.storage.local.get('fs_sync_status').then(r => renderSyncStatus(r.fs_sync_status)).catch(() => { });
        $('sync-now').addEventListener('click', async () => {
            if (!settings.syncEnabled) { showMessage('Turn on "Sync across my devices" first.'); return; }
            const res = await api.runtime.sendMessage({ action: 'SYNC_NOW' }).catch(e => ({ ok: false, error: e && e.message }));
            if (res && res.ok) { announce('Synced'); showMessage('Synced with your browser account.', true); } else showMessage(`Sync failed: ${(res && res.error) || 'unknown error'}`);
        });
        $('sync-clear').addEventListener('click', async () => {
            // Another device with sync on would upload its copy again on its next change.
            const msg = settings.syncEnabled
                ? 'Delete Velostream data from your browser account? Sync stays on here, so this device uploads its data again. Turn sync off on all devices first to remove it for good.'
                : 'Delete Velostream data from your browser account? Devices that still have sync on will upload theirs again.';
            if (!window.confirm(msg)) return;
            const res = await api.runtime.sendMessage({ action: 'SYNC_CLEAR' }).catch(e => ({ ok: false, error: e && e.message }));
            if (res && res.ok) { announce('Synced data deleted'); showMessage('Velostream data deleted from your browser account.', true); } else showMessage(`Could not delete: ${(res && res.error) || 'unknown error'}`);
        });
        api.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            if (changes.fs_sync_status || changes[S.SETTINGS_KEY]) {
                api.storage.local.get('fs_sync_status').then(r => renderSyncStatus(r.fs_sync_status)).catch(() => { });
            }
            if (changes[S.SETTINGS_KEY]) {
                settings = S.mergeSettings(changes[S.SETTINGS_KEY].newValue);
                // Refresh every control except the one being edited (it used to leave the whole form stale).
                fillForm();
            }
            if (changes[S.HISTORY_KEY]) renderHistory();
        });

        if (!tab || !/^https?:\/\//i.test(tab.url || '')) {
            $('status-text').textContent = 'Site needed';
            $('empty-copy').textContent = 'Open a website with a video to find streams.';
            for (const id of ['rescan-btn', 'empty-rescan', 'clear-btn']) $(id).disabled = true;
            return;
        }
        await Promise.all([refreshStreams(), refreshStats()]);
        timers.push(setInterval(refreshStreams, 1500));
        timers.push(setInterval(refreshStats, 1000));
    });

    window.addEventListener('pagehide', () => timers.forEach(clearInterval));
})();
