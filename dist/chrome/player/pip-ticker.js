// Frame clock for Picture-in-Picture with subtitles. requestAnimationFrame stops and page timers
// are throttled to about once a second when the tab is hidden, which is exactly when PiP is used;
// a dedicated worker's timer keeps running, and its messages still reach the player's page.
let timer = 0;
self.onmessage = (e) => {
    clearInterval(timer);
    const fps = Math.min(60, Math.max(1, Number(e.data && e.data.fps) || 30));
    if (e.data && e.data.stop) return;
    timer = setInterval(() => self.postMessage(0), 1000 / fps);
};
