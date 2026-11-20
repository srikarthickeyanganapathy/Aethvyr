/**
 * Velostream - Player page bootstrap
 *
 * player.html is an extension page that the content script mounts as an <iframe> exactly over
 * the site's own <video> (or over the whole page when no video element exists). Running here
 * instead of in the page means the site's CSP, Trusted Types and scripts cannot break playback.
 *
 * EnginePort exposes the same small interface the player UI already uses (postMessage /
 * onmessage / close) and implements it with:
 *   - a runtime port to the background engine ("velostream-player"), with auto-reconnect when
 *     the MV3 service worker / Firefox event page restarts,
 *   - direct chrome.storage access for settings, bookmarks and watch history,
 *   - unpacking of binary payloads (base64 on Chromium, ArrayBuffer on Firefox).
 */
(function () {
    'use strict';

    const S = globalThis.VelostreamShared;
    const api = S.api;
    const params = new URLSearchParams(location.search);
    const sessionId = params.get('session');
    const streamId = params.get('stream');

    class EnginePort {
        constructor() {
            this.onmessage = null;
            this.port = null;
            this.closed = false;
            this.reconnects = 0;
            this.pending = new Map(); // reqId -> REQUEST message awaiting its RESPONSE
            this.storageListener = (changes, area) => {
                if (area === 'local' && changes[S.SETTINGS_KEY]) {
                    this.deliver({ type: 'SETTINGS_CHANGED', settings: S.mergeSettings(changes[S.SETTINGS_KEY].newValue) });
                }
            };
            api.storage.onChanged.addListener(this.storageListener);
            this.connect(false);
        }

        deliver(msg) {
            if (this.closed || typeof this.onmessage !== 'function') return;
            // Same shape as a MessagePort event.
            this.onmessage({ data: msg });
        }

        connect(resumed) {
            if (this.closed) return;
            let port;
            try {
                port = api.runtime.connect({ name: 'velostream-player' });
            } catch (_) {
                this.deliver({ type: 'FATAL', error: 'The extension was updated or reloaded. Close the player and try again.' });
                return;
            }
            this.port = port;
            port.onMessage.addListener((msg) => {
                if (!msg) return;
                this.reconnects = 0;
                if (msg.type === 'RESPONSE') this.pending.delete(msg.reqId);
                if (msg.type === 'FATAL') this.failPending(msg.error);
                if (msg.type === 'INIT' && resumed) {
                    // The engine has the session again: resend what was in flight when it went away.
                    for (const m of this.pending.values()) { try { port.postMessage(m); } catch (_) { /* gone again */ } }
                }
                if (msg.data && (msg.data.kind === 'b64' || msg.data.kind === 'ab')) {
                    this.deliver({ ...msg, data: S.unpackBinary(msg.data) });
                } else {
                    this.deliver(msg);
                }
            });
            port.onDisconnect.addListener(() => {
                if (this.port === port) this.port = null;
                if (this.closed) return;
                // Engine restarted (MV3 service workers are stopped by the browser): keep the
                // in-flight requests and resend them once the session is back, instead of failing
                // them (that surfaced as Shaka HTTP_ERROR 1002). Reconnect with the same session id
                // so the segment cache is reused.
                if (this.reconnects++ < 8) {
                    setTimeout(() => this.connect(true), Math.min(4000, 250 * Math.pow(2, this.reconnects)));
                } else {
                    this.failPending('Lost connection to the Velostream engine');
                    this.deliver({ type: 'FATAL', error: 'Lost connection to the Velostream engine.' });
                }
            });
            port.postMessage({ type: 'HELLO', sessionId, streamId, resumed: !!resumed });
        }

        /** Runs storage read-modify-write steps one at a time (concurrent ones lost updates). */
        serial(fn) {
            const run = (this.writeChain || Promise.resolve()).then(fn);
            this.writeChain = run.catch(() => { /* keep the chain alive */ });
            return run;
        }

        async readSettings() {
            const res = await api.storage.local.get(S.SETTINGS_KEY);
            return S.mergeSettings(res[S.SETTINGS_KEY]);
        }

        async handleLocal(msg) {
            switch (msg.type) {
                case 'SETTINGS_GET':
                    this.deliver({ type: 'SETTINGS', reqId: msg.reqId, settings: await this.readSettings() });
                    return true;
                case 'SETTINGS_SET':
                    // The player sends only the fields the user edited; sub-objects arrive as
                    // partial objects and are merged field by field (keymap: null = defaults).
                    await this.serial(() => api.runtime.sendMessage({ action: 'SETTINGS_PATCH', patch: msg.patch }));
                    return true;
                case 'STORE_GET': {
                    if (typeof msg.key !== 'string' || !msg.key.startsWith('fs_bm_')) return true;
                    const res = await api.storage.local.get(msg.key);
                    this.deliver({ type: 'STORE_VALUE', reqId: msg.reqId, value: res[msg.key] ?? null });
                    return true;
                }
                case 'STORE_SET':
                    return false;
                case 'HISTORY_GET': {
                    const all = (await api.storage.local.get(S.HISTORY_KEY))[S.HISTORY_KEY] || {};
                    this.deliver({ type: 'STORE_VALUE', reqId: msg.reqId, value: all[msg.key] || null });
                    return true;
                }
                case 'HISTORY_SAVE': {
                    const result = await api.runtime.sendMessage({ action: 'HISTORY_SAVE', key: msg.key, legacyKey: msg.legacyKey, entry: msg.entry });
                    if (msg.reqId) this.deliver({ type: 'HISTORY_SAVED', reqId: msg.reqId, ok: !!result?.ok });
                    return true;
                }
                default:
                    return false;
            }
        }

        postMessage(msg) {
            if (this.closed || !msg) return;
            this.handleLocal(msg).catch((err) => {
                // Storage failure: answer requests so the UI does not wait for its timeout.
                console.warn('[Velostream] Local storage request failed:', err);
                if (msg.type === 'SETTINGS_GET') this.deliver({ type: 'SETTINGS', reqId: msg.reqId, settings: S.mergeSettings(undefined) });
                else if (msg.type === 'STORE_GET' || msg.type === 'HISTORY_GET') this.deliver({ type: 'STORE_VALUE', reqId: msg.reqId, value: null });
                else if (msg.type === 'HISTORY_SAVE' && msg.reqId) this.deliver({ type: 'HISTORY_SAVED', reqId: msg.reqId, ok: false });
                return true;
            }).then(handled => {
                if (handled) return;
                if (msg.type === 'REQUEST') this.pending.set(msg.reqId, msg);
                else if (msg.type === 'ABORT') this.pending.delete(msg.reqId);
                if (this.port) {
                    try { this.port.postMessage(msg); return; } catch (_) { /* reconnecting */ }
                }
                // Disconnected: REQUESTs stay pending and are resent after the reconnect.
            });
        }

        failPending(error) {
            for (const reqId of this.pending.keys()) this.deliver({ type: 'RESPONSE', reqId, ok: false, status: 0, error: error || 'Engine unavailable' });
            this.pending.clear();
        }

        close() {
            if (this.closed) return;
            this.closed = true;
            api.storage.onChanged.removeListener(this.storageListener);
            const port = this.port;
            this.port = null;
            if (port) setTimeout(() => { try { port.disconnect(); } catch (_) { /* gone */ } }, 50);
        }
    }

    /** Layout commands go straight to the content script that mounted this iframe. */
    function layout(cmd) {
        try { window.parent.postMessage({ __velostream: 'layout', session: sessionId, ...cmd }, '*'); } catch (_) { /* detached */ }
    }

    if (!sessionId || !streamId || !globalThis.VelostreamPlayer) {
        document.body.textContent = 'Velostream: missing session.';
        return;
    }
    const startTime = parseFloat(params.get('t'));
    // eslint-disable-next-line no-new
    new globalThis.VelostreamPlayer(new EnginePort(), {
        layout,
        mountMode: params.get('mode') || 'inline',
        startTime: Number.isFinite(startTime) && startTime >= 0 ? startTime : null,
        explicitStart: params.get('explicitStart') === '1',
        pageTitle: params.get('title') || ''
    });
})();
