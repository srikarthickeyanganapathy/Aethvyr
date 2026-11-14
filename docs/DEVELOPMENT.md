# Development

## Setup

Requirements: **Node.js 18+** and npm. Development uses Chromium 111+ or Firefox 140+ (Firefox for Android 142+).

```bash
git clone https://github.com/srikarthickeyanganapathy/playerstreamextension.git
cd playerstreamextension
npm install
npm run build
```

| Script | What it does |
|--------|--------------|
| `npm run build` | Builds `dist/chrome` and `dist/firefox` |
| `npm run build:chrome` / `build:firefox` | One target |
| `npm run watch` | Rebuilds on every source change |
| `npm run lint` | ESLint over all sources (must pass with zero warnings before a PR) |
| `npm run package` | Zips each built target into `dist/velostream-<browser>-<version>.zip` |
| `npm test` | Placeholder: there is no automated test suite in the repository yet (see [Testing](#testing)) |

### What the build does

`scripts/build.js` copies `background/`, `common/`, `content/`, `player/`, `popup/`, `icons/` and
`rules/` into each target, and copies `node_modules/shaka-player/dist/shaka-player.compiled-es2021.js`
to `lib/shaka-player.compiled.js` with its license. It then writes the browser-specific
`manifest.json`, with the version taken from `package.json`:

- **Chrome:** `minimum_chrome_version: "111"`.
- **Firefox:** `browser_specific_settings.gecko` (id, `strict_min_version` 140, Android 142, `data_collection_permissions`), and
  the background becomes an event page (`background.scripts`).

Finally it verifies that every file the manifest references exists and that the DNR rules parse.

Always load the **built** folder; the source folder has no `lib/`.

## Loading and reloading

- **Chromium:** `chrome://extensions` → Developer mode → *Load unpacked* → `dist/chrome`. After a
  rebuild press the reload icon on the card, then reload the test page: content scripts are
  injected at page load.
- **Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* →
  `dist/firefox/manifest.json`; *Reload* after a rebuild. Grant site access from the popup.
- **Firefox for Android:** use `web-ext run -t firefox-android` with USB debugging, or a custom
  add-on collection.
- **Kiwi:** copy `dist/chrome` (or the zip) to the device and load it from `kiwi://extensions`.

## Debugging

| Context | Where to look |
|---------|---------------|
| Engine | `chrome://extensions` → *Inspect views: service worker* (Firefox: *Inspect* in about:debugging). The global `VelostreamEngine` exposes `tabs`, `sessions` and `launchPlayer(tabId, streamId)`. |
| Player | DevTools on the page → frame selector → `player.html`. Errors are logged as `[Velostream] Shaka error <code> [HTTP status] <url> - <reason>`. |
| Content scripts | Page DevTools; the interceptor runs in the page's world, the sniffer under the extension's content-script context. |
| Popup | Right-click the popup → *Inspect*. |

Useful engine snippets (service-worker console):

```js
[...VelostreamEngine.tabs.values()].map(t => [...t.streams.values()])   // detected streams
[...VelostreamEngine.sessions.values()][0].downloader.snapshot()        // prefetch state
```

To simulate a service-worker restart (the player must reconnect and resend its requests):

```js
for (const s of VelostreamEngine.sessions.values()) { const p = s.port; s.port = null; VelostreamEngine.sessions.delete(s.id); p.disconnect(); }
```

## Code style

- Plain ES2021, no framework and no bundler. Each player file is an IIFE that exports one global
  (`VelostreamShaders`, `VelostreamMux`, `VelostreamPlayer`); the background uses ES modules.
- ESLint config in `.eslintrc.json`. Keep `npm run lint` clean.
- **Never load remote code.** No CDN, no `eval`/`new Function`, no remote config. Both stores
  reject it and it breaks the privacy promise.
- **Never assign `innerHTML`/`outerHTML`.** Insert markup with `S.setHTML(el, markup)` (popup,
  content scripts) or `setHTML(el, markup)` (player), and `replaceWithHTML` instead of
  `outerHTML`. They parse in an inert document and strip scripts, frames, event-handler
  attributes and unsafe URLs. Still escape dynamic text with `esc()` inside templates. AMO's
  linter flags any direct assignment.
- UI changes keep the existing glass design language and stay keyboard and screen-reader
  accessible (labels, focus order, `announce()` for state changes).
- New settings: see [SETTINGS.md](SETTINGS.md#migrations).
- Comments explain *why* (browser quirks, protocol constraints), not *what*.

## Testing

There is no automated suite in the repository yet. Contributions of a `puppeteer-core` end-to-end
harness are welcome; the current release was verified with an ad-hoc one (headless Edge + the
built extension + a local test site). The scenarios below are what it covered and what to
re-check before a release.

**Local test pages** to recreate with a tiny Node server:

| Page | Exercises |
|------|-----------|
| Shaka-player page with a public HLS stream | Detection, master/variant grouping, in-place mounting, playback |
| Same page with a strict CSP header | The player iframe works under a site CSP |
| Cross-origin embed (`127.0.0.1` embedding `localhost`) | Frame selection, in-iframe mounting, proxy through the right frame |
| Disguised segments (TS behind a JPEG header) | Segment normalization |
| Custom-header protected manifest | Header capture and replay |
| Expiring signed link (`?exp=` checked by the server) | `FIND_FRESH` recovery and the expired-link message |
| Direct MP4 | Progressive mode, Referer rule |
| `<track>` subtitles and chapters | Subtitle capture, auto-select, chapter marks |
| Manifest fetched only by a `blob:` Worker | Worker sniffing |
| Autoplay policy `document-user-activation-required` | Muted autoplay and one-tap unmute |

**Checks per release:**

1. Every page above detects and plays in place.
2. Seek into buffered and unbuffered regions; seek latency stays near 0.5 s when cached.
3. Engine restart mid-playback (snippet above): playback continues without an error.
4. Export a 3-segment HLS clip as MP4: one file, `ftyp, moov, moof, mdat…`, plays from 0:00 with
   audio.
5. GPU presets: render each preset and compare with the video drawn to a 2D canvas. The output
   must match **upright** (not flipped or mirrored) with `gl.getError() === 0`.
6. Real sites on Chrome desktop, Firefox desktop, Firefox for Android and Kiwi.

## Release checklist

### Before the first public release

- [ ] **Gecko add-on ID.** `scripts/build.js` uses `velostream@antigravity.dev`. Change it to an
      ID you control (an e-mail-style ID on your own domain, or a `{uuid}`) **before the first AMO
      upload**: AMO ties the listing to it permanently.
- [ ] **Name.** `manifest.json` says `Velostream 2.0`. Store listings usually use the bare name;
      the version is shown separately.
- [ ] Fill `author` and `homepage_url` (in `manifest.json` and `package.json`).
- [ ] Publish [PRIVACY.md](../PRIVACY.md) at a public URL; both stores ask for one.
- [ ] Screenshots (1280×800 or 640×400) and a 440×280 promo tile for the Chrome Web Store.

### Every release

1. Update `version` in `package.json` (the build copies it into the manifests) and
   [CHANGELOG.md](../CHANGELOG.md).
2. `npm ci && npm run lint && npm run build && npm run package`.
3. Run the [testing checks](#testing).
4. Tag: `git tag v<version> && git push --tags`.

### Chrome Web Store

- Upload `dist/velostream-chrome-<version>.zip` in the developer dashboard.
- **Single purpose:** "Play web video streams in an enhanced, accessible player."
- **Permission justifications:** copy them from [PERMISSIONS.md](PERMISSIONS.md). Broad host
  access plus `webRequest` triggers an in-depth review, so expect a few extra days.
- **Data usage:** no data collected; certify the limited-use policy.
- Policy notes:
  - The store does not allow extensions that download from YouTube. Velostream cannot (YouTube
    uses its own MSE pipeline and DRM) and should not be marketed for it.
  - Describe downloads as saving video "you have the right to save".

### Firefox Add-ons (AMO)

- Upload `dist/velostream-firefox-<version>.zip`; mark it compatible with Firefox for Android.
- **Data collection:** the build writes
  `browser_specific_settings.gecko.data_collection_permissions = { "required": ["none"] }`
  (Firefox's built-in data consent; AMO rejects new add-ons without it). Keep it at `none` unless
  a future feature sends data off the device; then declare the categories and update
  [PRIVACY.md](../PRIVACY.md).
- **Source code:** AMO asks for sources when a package contains minified code. Shaka Player is a
  third-party library: state *"lib/shaka-player.compiled.js is the unmodified
  shaka-player@5.3.3 dist/shaka-player.compiled-es2021.js from npm"* in the reviewer notes. Your
  own code is not minified, so no other source upload is needed.
- Reviewer notes: explain the MAIN-world content script (stream detection in the page's own
  `fetch`/XHR) and that no remote code is loaded.
- **Expected linter result:** 0 errors and 8 warnings, all `UNSUPPORTED_API` inside
  `lib/shaka-player.compiled.js` (`cast.*` and `webview.hostObjects`). These are Shaka's
  feature-detection checks for Chromecast and Windows WebView2: they test whether the API exists
  and are skipped when it does not, so they never run in Firefox. They cannot be removed without
  modifying the library, which would break source verification. Paste this into the reviewer
  notes:

  > The remaining UNSUPPORTED_API warnings (cast.*, webview.hostObjects) come from the
  > unmodified Shaka Player 5.3.3 library. They are guarded feature checks for Chromecast and
  > WebView2 and are never executed in Firefox.

  Check locally with `npx addons-linter dist/firefox` before uploading.
