import { PLAYER_PORT } from '../common/ports.js';

/** Owns one player session connection and its outstanding media requests across worker restarts. */
export class EnginePort {
    constructor({ sessionId, streamId, local = false, shared = globalThis.VelostreamShared }) {
        this.sessionId = sessionId;
        this.streamId = streamId;
        this.shared = shared;
        this.api = shared.api;
        this.reconnectTimer = null;
        this.onmessage = null;
        this.port = null;
        this.closed = false;
        this.privateBookmarks = this.api.extension?.inIncognitoContext ? new Map() : null;
        this.reconnects = 0;
        this.pending = new Map(); // reqId -> REQUEST message awaiting its RESPONSE
        this.storageListener = (changes, area) => {
            if (area === 'local' && changes[this.shared.SETTINGS_KEY]) {
                this.deliver({ type: 'SETTINGS_CHANGED', settings: this.shared.mergeSettings(changes[this.shared.SETTINGS_KEY].newValue) });
            }
        };
        this.api.storage.onChanged.addListener(this.storageListener);
        if (!local) this.connect(false);
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
            port = this.api.runtime.connect({ name: PLAYER_PORT });
        } catch (_) {
            this.deliver({ type: 'FATAL', error: 'The extension was updated or reloaded. Close the player and try again.' });
            return;
        }
        this.port = port;
        port.onMessage.addListener((msg) => {
            if (!msg || this.port !== port) return;
            this.reconnects = 0;
            if (msg.type === 'RESPONSE') this.pending.delete(msg.reqId);
            if (msg.type === 'FATAL') this.failPending(msg.error);
            if (msg.type === 'INIT' && resumed) {
                // The engine has the session again: resend what was in flight when it went away.
                for (const m of this.pending.values()) { try { port.postMessage(m); } catch (_) { /* gone again */ } }
            }
            if (msg.data && (msg.data.kind === 'b64' || msg.data.kind === 'ab')) {
                this.deliver({ ...msg, data: this.shared.unpackBinary(msg.data) });
            } else {
                this.deliver(msg);
            }
        });
        port.onDisconnect.addListener(() => {
            if (this.port !== port || this.closed) return;
            this.port = null;
            this.deliver({ type: 'ENGINE_DISCONNECTED' });
            // Engine restarted (MV3 service workers are stopped by the browser): keep the
            // in-flight requests and resend them once the session is back, instead of failing
            // them (that surfaced as Shaka HTTP_ERROR 1002). Reconnect with the same session id
            // so the segment cache is reused.
            if (this.reconnects++ < 8) {
                this.reconnectTimer = setTimeout(() => this.connect(true), Math.min(4000, 250 * Math.pow(2, this.reconnects)));
            } else {
                this.failPending('Lost connection to the Aethvyr engine');
                this.deliver({ type: 'FATAL', error: 'Lost connection to the Aethvyr engine.' });
            }
        });
        port.postMessage({ type: 'HELLO', sessionId: this.sessionId, streamId: this.streamId, resumed: !!resumed });
    }

    /** Runs storage read-modify-write steps one at a time (concurrent ones lost updates). */
    serial(fn) {
        const run = (this.writeChain || Promise.resolve()).then(fn);
        this.writeChain = run.catch(() => { /* keep the chain alive */ });
        return run;
    }

    async readSettings() {
        const res = await this.api.storage.local.get(this.shared.SETTINGS_KEY);
        return this.shared.mergeSettings(res[this.shared.SETTINGS_KEY]);
    }

    async handleLocal(msg) {
        switch (msg.type) {
            case 'SETTINGS_GET':
                this.deliver({ type: 'SETTINGS', reqId: msg.reqId, settings: await this.readSettings() });
                return true;
            case 'SETTINGS_SET':
                // The player sends only the fields the user edited; sub-objects arrive as
                // partial objects and are merged field by field (keymap: null = defaults).
                await this.serial(() => this.api.runtime.sendMessage({ action: 'SETTINGS_PATCH', patch: msg.patch }));
                return true;
            case 'STORE_GET': {
                if (typeof msg.key !== 'string' || !msg.key.startsWith('fs_bm_')) return true;
                if (this.privateBookmarks) {
                    this.deliver({ type: 'STORE_VALUE', reqId: msg.reqId, value: this.privateBookmarks.get(msg.key) ?? null });
                    return true;
                }
                const res = await this.api.storage.local.get(msg.key);
                this.deliver({ type: 'STORE_VALUE', reqId: msg.reqId, value: res[msg.key] ?? null });
                return true;
            }
            case 'STORE_SET':
                if (this.privateBookmarks) {
                    if (/^fs_bm_[\w-]{1,64}$/.test(msg.key) && Array.isArray(msg.value)) this.privateBookmarks.set(msg.key, msg.value);
                    return true;
                }
                return false;
            case 'HISTORY_GET': {
                if (this.api.extension?.inIncognitoContext) {
                    this.deliver({ type: 'STORE_VALUE', reqId: msg.reqId, value: null });
                    return true;
                }
                const all = (await this.api.storage.local.get(this.shared.HISTORY_KEY))[this.shared.HISTORY_KEY] || {};
                this.deliver({ type: 'STORE_VALUE', reqId: msg.reqId, value: all[msg.key] || null });
                return true;
            }
            case 'HISTORY_SAVE': {
                const result = await this.api.runtime.sendMessage({ action: 'HISTORY_SAVE', key: msg.key, legacyKey: msg.legacyKey, entry: msg.entry });
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
            console.warn('[Aethvyr] Local storage request failed:', err);
            if (msg.type === 'SETTINGS_GET') this.deliver({ type: 'SETTINGS', reqId: msg.reqId, settings: this.shared.mergeSettings(undefined) });
            else if (msg.type === 'STORE_GET' || msg.type === 'HISTORY_GET') this.deliver({ type: 'STORE_VALUE', reqId: msg.reqId, value: null });
            else if (msg.type === 'HISTORY_SAVE' && msg.reqId) this.deliver({ type: 'HISTORY_SAVED', reqId: msg.reqId, ok: false });
            return true;
        }).then(handled => {
            if (handled || this.closed) return;
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
        clearTimeout(this.reconnectTimer);
        this.pending.clear();
        this.api.storage.onChanged.removeListener(this.storageListener);
        const port = this.port;
        this.port = null;
        if (port) setTimeout(() => { try { port.disconnect(); } catch (_) { /* gone */ } }, 50);
    }
}
