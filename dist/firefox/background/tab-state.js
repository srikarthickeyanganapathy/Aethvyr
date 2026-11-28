const SUBS_PERSIST_BUDGET = 1_500_000;
export const tabKey = (tabId) => `tab_${tabId}`;
export const tabSubsKey = (tabId) => `tabsubs_${tabId}`;

function newTabState(tabId) {
    return {
        tabId,
        streams: new Map(),
        byUrl: new Map(),
        children: new Set(),       // variant/rendition playlists of a known master (hidden in popup)
        mseFrames: new Map(),      // frameId -> last MSE_INIT timestamp
        videoFrames: new Set(),    // frames with a <video> element
        pageUrl: '',
        pageMeta: null,
        routeVersion: 0,
        subtitles: [],             // captured sidecar / in-memory subtitle tracks (bounded)
        drm: null,                 // { keySystem, frameId } once a frame requested EME keys
        autoLaunched: false,       // auto-replace already ran for this page load
        mountFrameId: null,        // frame the player iframe was mounted in
        playerSessionId: null,
        probing: 0
    };
}

/** Rehydrate data written by an earlier worker into fresh per-tab collections. */
export function restoreTab(tabId, stored, storedSubs) {
    const tab = newTabState(tabId);
    if (stored) {
        for (const s of stored.streams || []) {
            tab.streams.set(s.id, s);
            tab.byUrl.set(s.url, s.id);
        }
        (stored.children || []).forEach(u => tab.children.add(u));
        tab.playerSessionId = stored.playerSessionId || null;
        for (const e of stored.mseFrames || []) {
            if (Array.isArray(e) && typeof e[0] === 'number') tab.mseFrames.set(e[0], +e[1] || 0);
        }
        (stored.videoFrames || []).forEach(f => { if (typeof f === 'number') tab.videoFrames.add(f); });
        tab.pageUrl = stored.pageUrl || '';
        tab.pageMeta = stored.pageMeta || null;
        tab.staleStreamId = stored.staleStreamId || null;
        tab.activeStreamId = stored.activeStreamId || null;
        tab.drm = stored.drm || null;
        tab.autoLaunched = !!stored.autoLaunched;
        tab.mountFrameId = typeof stored.mountFrameId === 'number' ? stored.mountFrameId : null;
    }
    if (Array.isArray(storedSubs)) tab.subtitles = storedSubs.slice(-32);
    return tab;
}

export function snapshotTab(tab) {
    return {
        streams: [...tab.streams.values()],
        children: [...tab.children].slice(-200),
        playerSessionId: tab.playerSessionId,
        activeStreamId: tab.activeStreamId || null,
        mseFrames: [...tab.mseFrames.entries()].slice(-32),
        videoFrames: [...tab.videoFrames].slice(-32),
        pageUrl: tab.pageUrl,
        pageMeta: tab.pageMeta,
        staleStreamId: tab.staleStreamId || null,
        drm: tab.drm || null,
        autoLaunched: !!tab.autoLaunched,
        mountFrameId: tab.mountFrameId ?? null
    };
}

/** Subtitles to persist: newest first within the inline-text budget (URL tracks keep their URL). */
export function subtitlesForStorage(list) {
    const out = [];
    let used = 0;
    for (let i = list.length - 1; i >= 0; i--) {
        const t = list[i];
        const cost = (t.vtt || '').length;
        if (used + cost <= SUBS_PERSIST_BUDGET) {
            used += cost;
            out.unshift(t);
        } else if (t.url) {
            out.unshift({ ...t, vtt: '' });
        }
    }
    return out;
}

export function visibleStreams(tab) {
    const list = [...tab.streams.values()].filter(s => !tab.children.has(s.url) && s.id !== tab.staleStreamId);
    const score = s => {
        let v = 0;
        if (s.probe && s.probe.isMaster) v += 4;
        if (s.type === 'hls' || s.type === 'dash') v += 2;
        if (tab.mseFrames.has(s.frameId) || tab.videoFrames.has(s.frameId)) v += 2;
        if (s.isAd) v -= 6;
        if (s.probe && s.probe.error) v -= 1;
        return v;
    };
    return list.sort((a, b) => score(b) - score(a) || b.detectedAt - a.detectedAt);
}
