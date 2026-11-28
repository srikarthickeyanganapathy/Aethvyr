export class PortClient {
    constructor(port, handler) {
        this.port = port;
        this.waiters = new Map();
        this.seq = 0;
        port.onmessage = (e) => {
            const m = e.data;
            if (!m) return;
            if (m.reqId && this.waiters.has(m.reqId) && (m.type === 'SETTINGS' || m.type === 'STORE_VALUE' || m.type === 'HISTORY_SAVED')) {
                const w = this.waiters.get(m.reqId);
                this.waiters.delete(m.reqId);
                w.resolve(m);
                return;
            }
            handler(m);
        };
    }

    send(msg, transfer) {
        try { this.port.postMessage(msg, transfer || []); } catch (_) { /* closed */ }
    }

    request(type, extra = {}, timeoutMs = 8000) {
        const reqId = `q${++this.seq}`;
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => { this.waiters.delete(reqId); reject(new Error(`${type} timed out`)); }, timeoutMs);
            this.waiters.set(reqId, { resolve: m => { clearTimeout(t); resolve(m); }, reject, timer: t });
            this.send({ type, reqId, ...extra });
        });
    }

    close() {
        for (const waiter of this.waiters.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error('Player closed'));
        }
        this.waiters.clear();
        try { this.port.onmessage = null; this.port.close(); } catch (_) { /* ignore */ }
    }
}
