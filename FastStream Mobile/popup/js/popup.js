/**
 * FastStream Mobile - Popup
 *
 * - Lists every detected stream of the active tab (ranked, ads flagged, metadata from probes).
 * - Launches the player through the background engine (LAUNCH_PLAYER), which injects into the
 *   top frame and proxies through the frame that owns the stream. The old flow sent
 *   INJECT_PLAYER to all frames and closed on the first (wrong) frame's "skipped" reply.
 * - Live engine telemetry (active downloads, bandwidth, cache, look-ahead) every second.
 * - Persistent settings in chrome.storage.local (shared with the in-page player).
 */
(function () {
    'use strict';

    const S = globalThis.FastStreamShared;
    const api = S.api;

    const $ = (id) => document.getElementById(id);
    let tabId = null;
    let settings = S.mergeSettings(null);
    let lastListSig = '';
    let playerStreamId = null;
    let timers = [];

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
        el.textContent = `${ok ? '✓' : '✕'} ${text}`;
        el.classList.toggle('ok', !!ok);
        el.hidden = false;
    }

    function streamName(stream) {
        try {
            const u = new URL(stream.url);
            const file = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
            return `${u.hostname}${file ? ` · ${file}` : ''}`;
        } catch (_) {
            return stream.url;
        }
    }

    function fmtDuration(sec) {
        if (!sec) return '';
        const h = Math.floor(sec / 3600);
        const m = Math.floor(sec / 60) % 60;
        const s = Math.floor(sec % 60);
        return h ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, '0')}s`;
    }

    /** Text-only metadata: state is never conveyed by colour alone. */
    function streamMeta(stream) {
        const parts = [];
        const p = stream.probe;
        if (stream.isAd) parts.push('<span class="warn">⚠ Likely an advert</span>');
        if (!p || p.status === 'pending') {
            if (stream.type !== 'progressive') parts.push('… Checking stream');
        } else if (p.status === 'error') {
            parts.push(`<span class="err">✕ ${escapeHtml(p.error)}</span>`);
        } else {
            if (p.isMaster) {
                parts.push(`<span class="ok">✓ ${p.variants || 0} qualit${p.variants === 1 ? 'y' : 'ies'}</span>`);
                if (p.maxHeight) parts.push(`up to ${p.maxHeight}p`);
                if (p.audioTracks > 1) parts.push(`${p.audioTracks} audio tracks`);
                if (p.subtitleTracks) parts.push(`${p.subtitleTracks} subtitle tracks`);
            } else {
                parts.push('<span class="ok">✓ Single quality</span>');
            }
            if (p.live) parts.push('🔴 Live');
            else if (p.duration) parts.push(fmtDuration(p.duration));
            if (p.encrypted) parts.push('AES-128');
        }
        if (stream.frameId > 0 && stream.frameUrl) {
            try { parts.push(`in embedded frame: ${new URL(stream.frameUrl).hostname}`); } catch (_) { /* ignore */ }
        }
        return parts.join(' · ');
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function typeLabel(type) {
        return { hls: 'HLS', dash: 'DASH', progressive: 'FILE' }[type] || type.toUpperCase();
    }

    function renderStreams(streams) {
        const list = $('stream-list');
        const sig = JSON.stringify(streams.map(s => [s.id, s.probe && s.probe.status, s.probe && s.probe.variants, s.isAd])) + playerStreamId;
        $('stream-count').textContent = String(streams.length);
        $('empty-state').hidden = streams.length > 0;
        if (sig === lastListSig) return;
        lastListSig = sig;

        const focusedId = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.action + ':' + document.activeElement.dataset.id : null;
        list.innerHTML = '';
        streams.forEach((stream, i) => {
            const li = document.createElement('li');
            const playing = stream.id === playerStreamId;
            li.className = `stream-item${playing ? ' is-playing' : ''}${stream.isAd ? ' is-ad' : ''}`;
            const name = streamName(stream);
            li.innerHTML = `
                <div class="stream-head">
                    <span class="stream-type ${escapeHtml(stream.type)}">${typeLabel(stream.type)}</span>
                    <span class="stream-name" title="${escapeHtml(stream.url)}">${escapeHtml(name)}</span>
                </div>
                <p class="stream-meta">${playing ? '<span class="ok">▶ Playing now</span> · ' : ''}${streamMeta(stream)}</p>
                <div class="btn-row">
                    <button type="button" class="btn btn-primary" data-action="play" data-id="${escapeHtml(stream.id)}"
                        aria-label="Play stream ${i + 1}, ${escapeHtml(typeLabel(stream.type))}, ${escapeHtml(name)}, in FastStream">▶ Play</button>
                    <button type="button" class="btn" data-action="copy" data-id="${escapeHtml(stream.id)}"
                        aria-label="Copy address of stream ${i + 1}">Copy URL</button>
                </div>`;
            li.querySelector('[data-action="play"]').addEventListener('click', (e) => launch(stream, e.currentTarget));
            li.querySelector('[data-action="copy"]').addEventListener('click', () => copyUrl(stream));
            list.appendChild(li);
        });
        if (focusedId) {
            const [action, id] = focusedId.split(':');
            const el = list.querySelector(`[data-action="${action}"][data-id="${CSS.escape(id)}"]`);
            if (el) el.focus();
        }
    }

    async function refreshStreams() {
        if (tabId === null) return;
        const res = await send({ action: 'GET_STREAMS', tabId });
        if (!res || !res.ok) return;
        playerStreamId = res.player ? res.player.streamId : null;
        const playerSection = $('player-section');
        playerSection.hidden = !res.player;
        if (res.player) {
            const s = (res.streams || []).find(x => x.id === res.player.streamId);
            $('player-stream').textContent = s ? streamName(s) : 'Stream';
            $('export-btn').disabled = !!res.player.exporting || (s && s.type === 'dash');
            $('export-btn').textContent = res.player.exporting ? 'Export in progress…' : 'Export / download stream';
        }
        renderStreams(res.streams || []);
    }

    async function refreshStats() {
        if (tabId === null) return;
        const res = await send({ action: 'GET_STATS', tabId });
        if (!res || !res.ok) return;
        const g = res.global || {};
        const sess = res.session;
        $('stat-active').textContent = String(sess ? sess.activeWorkers : g.activeDownloads || 0);
        $('stat-bandwidth').textContent = S.formatBitrate(sess ? sess.bandwidth : g.bandwidth);
        $('stat-ahead').textContent = sess ? `${(sess.bufferAhead + sess.cachedAhead).toFixed(0)} s` : '—';
        $('stat-cache').textContent = sess ? `${S.formatBytes(sess.cacheBytes)} / ${S.formatBytes(sess.cacheCapBytes)}` : '—';
    }

    async function launch(stream, button) {
        button.disabled = true;
        button.textContent = '… Starting';
        showMessage('');
        announce('Starting the FastStream player');
        const res = await send({ action: 'LAUNCH_PLAYER', tabId, streamId: stream.id });
        if (res && res.ok) {
            button.textContent = '✓ Playing';
            window.close();
        } else {
            button.disabled = false;
            button.textContent = '▶ Play';
            const msg = (res && res.error) || 'Could not start the player on this page.';
            showMessage(/Cannot access|chrome:|about:|extensions gallery|missing host permission/i.test(msg)
                ? 'This page cannot be scripted by extensions (browser or store page).' : msg);
            button.focus();
        }
    }

    async function copyUrl(stream) {
        try {
            await navigator.clipboard.writeText(stream.url);
            showMessage('Stream address copied', true);
            announce('Stream address copied');
        } catch (_) {
            showMessage('Copy failed. Long-press the stream name to select its address.');
        }
    }

    // -------------------------------------------------------------------
    // Settings
    // -------------------------------------------------------------------
    function applyPopupTheme() {
        $('app').dataset.theme = settings.theme;
        document.body.classList.toggle('hc', !!settings.highContrast);
        document.body.classList.toggle('reduce-motion', settings.reducedMotion === 'on');
        document.documentElement.style.setProperty('--scale', String(Math.min(settings.uiScale || 1, 1.25)));
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
    }

    async function saveField(el) {
        let value = el.type === 'checkbox' ? el.checked : el.value;
        if (el.dataset.type === 'number') value = Number(value);
        const next = JSON.parse(JSON.stringify(settings));
        const keys = el.name.split('.');
        let o = next;
        for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
        o[keys[keys.length - 1]] = value;
        settings = S.mergeSettings(next);
        await api.storage.local.set({ [S.SETTINGS_KEY]: settings });
        applyPopupTheme();
        const label = el.labels && el.labels[0] ? el.labels[0].textContent.trim() : el.name;
        announce(`${label} saved`);
    }

    async function loadSettings() {
        const res = await api.storage.local.get(S.SETTINGS_KEY);
        settings = S.mergeSettings(res[S.SETTINGS_KEY]);
        applyPopupTheme();
        fillForm();
    }

    // -------------------------------------------------------------------
    // Permissions (Firefox MV3 makes <all_urls> opt-in)
    // -------------------------------------------------------------------
    async function checkPermissions() {
        if (!api.permissions || !api.permissions.contains) return;
        try {
            const has = await api.permissions.contains({ origins: ['<all_urls>'] });
            $('permission-banner').hidden = has;
        } catch (_) { /* unsupported */ }
    }

    // -------------------------------------------------------------------
    // Init
    // -------------------------------------------------------------------
    document.addEventListener('DOMContentLoaded', async () => {
        $('version').textContent = `v${api.runtime.getManifest().version}`;
        const [tab] = await api.tabs.query({ active: true, currentWindow: true });
        tabId = tab ? tab.id : null;

        await loadSettings();
        checkPermissions();

        $('settings-form').addEventListener('change', (e) => { if (e.target.name) saveField(e.target); });
        $('reset-settings').addEventListener('click', async () => {
            settings = S.mergeSettings(null);
            await api.storage.local.set({ [S.SETTINGS_KEY]: settings });
            fillForm();
            applyPopupTheme();
            announce('All settings reset to defaults');
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
            if (res && res.ok) { announce('Player closed'); setTimeout(refreshStreams, 400); }
            else showMessage(res && res.error);
        });
        $('export-btn').addEventListener('click', async () => {
            const res = await send({ action: 'EXPORT_STREAM', tabId });
            if (res && res.ok) {
                showMessage('Export started in the player. Keep the tab open until it finishes.', true);
                announce('Export started');
            } else {
                showMessage(res && res.error);
            }
        });
        api.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[S.SETTINGS_KEY]) {
                settings = S.mergeSettings(changes[S.SETTINGS_KEY].newValue);
                applyPopupTheme();
                if (!$('settings-form').contains(document.activeElement)) fillForm();
            }
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
