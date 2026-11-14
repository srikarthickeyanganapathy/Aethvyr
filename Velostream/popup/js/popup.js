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
        const sig = JSON.stringify(streams.map(s => [s.id, s.probe && s.probe.status, s.probe && s.probe.variants, s.isAd])) + playerStreamId;
        $('empty-state').hidden = streams.length > 0;
        const pill = $('status-pill');
        pill.classList.toggle('active', streams.length > 0);
        $('status-text').textContent = playerStreamId ? 'Playing' : streams.length ? `${streams.length} stream${streams.length === 1 ? '' : 's'}` : 'Ready';
        if (sig === lastListSig) return;
        lastListSig = sig;

        const active = document.activeElement;
        const focusKey = active && active.dataset && active.dataset.id ? `${active.dataset.action}:${active.dataset.id}` : null;
        list.innerHTML = '';
        streams.forEach((stream, i) => {
            const li = document.createElement('li');
            const playing = stream.id === playerStreamId;
            li.className = `card stream-item${playing ? ' is-playing' : ''}`;
            const name = streamName(stream);
            const res = stream.probe && stream.probe.maxHeight ? `${stream.probe.maxHeight}p` : '';
            const frame = stream.isAd ? '<span class="frame warn">Likely an ad</span>'
                : `<span class="frame">${stream.frameId > 0 ? `Embedded player · ${esc(hostOf(stream.frameUrl))}` : 'Main frame'}</span>`;
            const label = `${TYPE_LABEL[stream.type] || stream.type}${res ? ` ${res}` : ''}, ${name}`;
            li.innerHTML = `
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
                </div>`;
            li.querySelector('[data-action="play"]').addEventListener('click', (e) => launch(stream, e.currentTarget));
            li.querySelector('[data-action="copy"]').addEventListener('click', () => copyUrl(stream));
            list.appendChild(li);
        });
        if (focusKey) {
            const [action, id] = focusKey.split(':');
            const el = list.querySelector(`[data-action="${action}"][data-id="${CSS.escape(id)}"]`);
            if (el) el.focus();
        }
    }

    async function refreshStreams() {
        if (tabId === null) return;
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
    }

    function drawSpark(mbps) {
        spark.push(mbps);
        if (spark.length > 30) spark.shift();
        const max = Math.max(1, ...spark);
        const pts = spark.map((v, i) => `${(i / 29) * 120},${26 - (v / max) * 24}`).join(' ');
        $('spark').querySelector('polyline').setAttribute('points', pts);
    }

    async function refreshStats() {
        if (tabId === null) return;
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
        button.focus();
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
    async function renderHistory() {
        const res = await api.storage.local.get(S.HISTORY_KEY);
        const all = res[S.HISTORY_KEY] || {};
        const entries = Object.entries(all).filter(([, e]) => e && !e.done && e.t > 15)
            .sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 15);
        const sig = JSON.stringify(entries.map(([k, e]) => [k, Math.round(e.t)]));
        $('history-count').textContent = String(entries.length);
        $('history-empty').hidden = entries.length > 0;
        $('history-clear').hidden = entries.length === 0;
        if (sig === lastHistorySig) return;
        lastHistorySig = sig;
        const list = $('history-list');
        list.innerHTML = '';
        for (const [key, e] of entries) {
            const li = document.createElement('li');
            li.className = 'history-item';
            const pct = e.d ? Math.min(100, Math.round((e.t / e.d) * 100)) : 0;
            li.innerHTML = `
                <div class="info">
                    <div class="name" title="${esc(e.url)}">${esc(e.title || hostOf(e.url))}</div>
                    <div class="meta num">${fmtTime(e.t)}${e.d ? ` / ${fmtTime(e.d)}` : ''} · ${esc(fmtAgo(e.updatedAt))}</div>
                    <div class="bar" role="progressbar" aria-label="Watched" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
                </div>
                <button type="button" class="btn small" data-open="${esc(key)}" ${e.page ? '' : 'disabled'} aria-label="Open the page of ${esc(e.title || 'this video')} to resume">Open</button>
                <button type="button" class="icon-btn" data-del="${esc(key)}" aria-label="Remove ${esc(e.title || 'this video')} from history">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
                </button>`;
            li.querySelector('[data-open]').addEventListener('click', () => {
                if (e.page && /^https?:/i.test(e.page)) api.tabs.create({ url: e.page });
            });
            li.querySelector('[data-del]').addEventListener('click', async () => {
                const cur = (await api.storage.local.get(S.HISTORY_KEY))[S.HISTORY_KEY] || {};
                delete cur[key];
                await api.storage.local.set({ [S.HISTORY_KEY]: cur });
                lastHistorySig = '';
                renderHistory();
                announce('Removed from history');
            });
            list.appendChild(li);
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
        document.querySelectorAll('.swatch').forEach(b => b.setAttribute('aria-checked', String(b.dataset.accent === settings.theme)));
    }

    function readPath(obj, path) {
        return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
    }

    function fillForm() {
        for (const el of $('settings-form').elements) {
            if (!el.name) continue;
            const v = readPath(settings, el.name);
            if (el.type === 'checkbox') el.checked = !!v;
            else el.value = String(v);
        }
        applyPopupTheme();
    }

    async function saveSettings(mutate, label) {
        const next = JSON.parse(JSON.stringify(settings));
        mutate(next);
        settings = S.mergeSettings(next);
        await api.storage.local.set({ [S.SETTINGS_KEY]: settings });
        applyPopupTheme();
        if (label) announce(`${label} saved`);
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
    function setupSiteToggle(tab) {
        let host = '';
        try { const u = new URL(tab && tab.url); if (/^https?:$/.test(u.protocol)) host = u.hostname; } catch (_) { /* no url */ }
        if (!host) return;
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
        const [tab] = await api.tabs.query({ active: true, currentWindow: true });
        tabId = tab ? tab.id : null;

        await loadSettings();
        setupSiteToggle(tab); // needs the loaded settings
        checkPermissions();
        renderHistory();

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
        $('reset-settings').addEventListener('click', async () => {
            settings = S.mergeSettings(null);
            await api.storage.local.set({ [S.SETTINGS_KEY]: settings });
            fillForm();
            announce('All settings reset');
        });
        $('grant-permission').addEventListener('click', async () => {
            const ok = await api.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
            if (ok) {
                $('permission-banner').hidden = true;
                showMessage('Access granted. Reload the page with the video.', true);
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
            if (res && res.ok) { announce('Player closed'); setTimeout(refreshStreams, 400); } else showMessage(res && res.error);
        });
        $('export-btn').addEventListener('click', async () => {
            const res = await send({ action: 'EXPORT_STREAM', tabId });
            if (res && res.ok) { showMessage('Saving in the player. Keep the tab open until it finishes.', true); announce('Saving started'); } else showMessage(res && res.error);
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
            await api.storage.local.remove(S.HISTORY_KEY);
            lastHistorySig = '';
            renderHistory();
            announce('History cleared');
        });
        api.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            if (changes[S.SETTINGS_KEY]) {
                settings = S.mergeSettings(changes[S.SETTINGS_KEY].newValue);
                if (!$('settings-form').contains(document.activeElement)) fillForm(); else applyPopupTheme();
            }
            if (changes[S.HISTORY_KEY]) renderHistory();
        });

        if (tabId === null) {
            showMessage('No active tab.');
            return;
        }
        await Promise.all([refreshStreams(), refreshStats()]);
        timers.push(setInterval(refreshStreams, 1500));
        timers.push(setInterval(refreshStats, 1000));
    });

    window.addEventListener('pagehide', () => timers.forEach(clearInterval));
})();
