export function mediaUrl(value) {
    if (typeof value !== 'string' || value.length > 16384) return null;
    try {
        const url = new URL(value);
        return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
    } catch (_) { return null; }
}

// Query strings are part of the identity of a signed media resource.
export function captureKey(tabId, frameId, page, destination) {
    const source = mediaUrl(page);
    const target = mediaUrl(destination);
    if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(frameId) || frameId < 0 || !source || !target) return null;
    target.hash = '';
    return JSON.stringify([tabId, frameId, source.origin, target.href]);
}

export function mediaHeaders(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const headers = {};
    for (const [name, text] of Object.entries(value)) {
        if (typeof text !== 'string' || text.length > 512 || /[\r\n]/.test(text)) return null;
        if (/^range$/i.test(name)) {
            if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(text)) return null;
            headers.Range = text;
        } else if (/^accept$/i.test(name)) headers.Accept = text;
    }
    return headers;
}

export function sameMediaOrigin(resource, selected) {
    const dest = mediaUrl(resource);
    return !!dest && dest.origin === mediaUrl(selected)?.origin;
}

const popupTabActions = new Set(['GET_STREAMS','GET_STATS','LAUNCH_PLAYER','OPEN_LOCAL_PLAYER','LAUNCH_URL',
    'PLAYER_CONTROL','CLOSE_PLAYER','EXPORT_STREAM','RESCAN','CLEAR_STREAMS']);
const frameActions = new Set(['ROUTE_CHANGE','PAGE_META','STREAM_FOUND','MSE_INIT','VIDEO_PRESENT',
    'SUBTITLE_FOUND','DRM_DETECTED','LAUNCH_FROM_PAGE','GET_BADGE_STATE']);

export function allowedAction(message, sender, runtime) {
    if (!message || sender?.id !== runtime.id || typeof message.action !== 'string') return false;
    const page = sender.url?.split(/[?#]/, 1)[0];
    const popup = page === runtime.getURL('popup/popup.html');
    const library = page === runtime.getURL('popup/library.html');
    const player = page === runtime.getURL('player/player.html');
    const validId = id => Number.isInteger(id) && id >= 0;
    if (popupTabActions.has(message.action)) return popup && validId(message.tabId);
    if (frameActions.has(message.action)) return validId(sender.tab?.id) && validId(sender.frameId) &&
        (!!mediaUrl(sender.url) || /^about:(blank|srcdoc)$/.test(sender.url));
    switch (message.action) {
        case 'CLEAR_BOOKMARKS': case 'CLEAR_LIBRARY': return popup && !sender.tab?.incognito;
        case 'PLAYBACK_SESSIONS': case 'HISTORY_CLEAR': return popup;
        case 'HISTORY_REMOVE': return popup || library;
        case 'HISTORY_SAVE': return player;
        case 'BACKUP_RESTORE': return (popup || player) && typeof message.json === 'string' && message.json.length <= 5 * 1024 * 1024;
        case 'SETTINGS_PATCH': return (popup || player || library) && !!message.patch && typeof message.patch === 'object' && !Array.isArray(message.patch);
        case 'VAULT_LIST': case 'VAULT_DELETE': case 'VAULT_PAUSE': case 'WATCH_STATS': case 'WATCH_QUEUE':
        case 'LIBRARY_WRITE': case 'LIBRARY_RESUME': return library && !sender.tab?.incognito;
        default: return false;
    }
}
