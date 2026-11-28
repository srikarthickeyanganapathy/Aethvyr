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
import './player-ui.js';
import { EnginePort } from './engine-port.js';

(function () {
    'use strict';

    const params = new URLSearchParams(location.search);
    const sessionId = params.get('session');
    const streamId = params.get('stream');

    /** Layout commands go straight to the content script that mounted this iframe. */
    function layout(cmd) {
        try { window.parent.postMessage({ __velostream: 'layout', session: sessionId, ...cmd }, '*'); } catch (_) { /* detached */ }
    }

    if (params.get('mode') === 'offline') {
        if (window.top === window) globalThis.VelostreamVaultExport(params.get('id'));
        return;
    }
    if (params.get('local') === '1' || params.get('mode') === 'local') {
        // eslint-disable-next-line no-new
        new globalThis.VelostreamPlayer(new EnginePort({ local: true }), {
            local: true, fileId: params.get('file'), layout, mountMode: 'page'
        });
        return;
    }

    if (!sessionId || !streamId || !globalThis.VelostreamPlayer) {
        document.body.textContent = 'Aethvyr: missing session.';
        return;
    }
    const startTime = parseFloat(params.get('t'));
    // eslint-disable-next-line no-new
    new globalThis.VelostreamPlayer(new EnginePort({ sessionId, streamId }), {
        layout,
        mountMode: params.get('mode') || 'inline',
        startTime: Number.isFinite(startTime) && startTime >= 0 ? startTime : null,
        explicitStart: params.get('explicitStart') === '1',
        pageTitle: params.get('title') || ''
    });
})();
