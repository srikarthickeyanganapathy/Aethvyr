<div align="center">

<img src="icons/icon-128.png" width="96" height="96" alt="Velostream logo">

# Velostream

**A fast, accessible video player for the web: plays a site's HLS, DASH or MP4 stream in its own
player, pre-buffers it in the background, enhances it on the GPU and saves it as a single MP4.**

![Manifest V3](https://img.shields.io/badge/manifest-v3-4c8bf5)
![Chrome 111+](https://img.shields.io/badge/Chrome%20%2F%20Edge%20%2F%20Kiwi-111%2B-34a853)
![Firefox 140+ / Android 142+](https://img.shields.io/badge/Firefox-140%2B%20%C2%B7%20Android%20142%2B-ff7139)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

[Features](#features) · [Install](#install) · [Usage](#usage) · [Docs](#documentation) ·
[Build from source](#build-from-source) · [Privacy](PRIVACY.md) · [Contributing](CONTRIBUTING.md)

</div>

---

## What it does

Most sites play video through their own players, often with ads, small buffers and few controls.
Velostream detects the stream the site is playing and opens it in its own player, **mounted exactly
over the site's video** (or full-page). From there:

- the **whole video is pre-downloaded in the background** with parallel connections, so seeking
  is instant and a flaky connection does not stall playback;
- you get a **premium player**: gestures, keyboard shortcuts, subtitles styling and dual subtitles,
  audio boost / EQ, speed with pitch correction, chapters, A-B loop, mini player, sleep timer;
- an optional **WebGL2 GPU pipeline** sharpens, upscales (FSR-style, Anime4K-style) or debands the
  picture in real time;
- the **downloader** saves on-demand video as one MP4 (TS segments are remuxed, separate audio
  is merged), records live streams and keeps a rewindable live DVR buffer.

Everything runs locally in your browser. Velostream has no servers, no accounts, no analytics and
no remote code. See [PRIVACY.md](PRIVACY.md).

## Features

| Area | Highlights |
|------|-----------|
| **Detection** | HLS (`.m3u8`), DASH (`.mpd`) and direct files (MP4/WebM/…) found via network sniffing, `fetch`/XHR hooks, Web Workers (including `blob:` workers), `<video>`/`<source>` scanning and MSE detection, in every frame including cross-origin embeds. Ads and segment playlists are filtered out. |
| **Playback** | Shaka Player 5 (bundled, never loaded from a CDN). Starts after 0.5 s of media, muted-autoplay fallback with one-tap unmute, auto-resume per video, remembered volume/speed/quality/audio and subtitle language, per-site profiles, auto-replace on chosen sites. |
| **Pre-buffer engine** | Background service worker downloads ahead with 2–8 adaptive workers, a byte-range accelerator, retries with backoff, an IndexedDB cache read zero-copy by the player, its own ABR, and a live DVR (default 30 min). |
| **GPU enhancement** | WebGL2 presets: **Fast Sharpen** (CAS), **FSR-style upscale** (Lanczos-2 + RCAS), **Anime4K-lite** line reconstruction, **Deband**. Strength and render-resolution cap, plus a thermal guard that steps down when the GPU cannot keep up. |
| **Controls** | Configurable double-tap zones (left/centre/right), swipe for volume, brightness and scrubbing, long-press 2×, pinch zoom, mouse wheel and middle click, remappable keyboard shortcuts, frame stepping, A-B loop, zoom/pan/rotate/mirror, aspect presets. |
| **Subtitles** | Site subtitles captured automatically (network, `<track>`, in-memory text tracks), SRT/VTT/ASS files, dual subtitles, sync to the next spoken line, timing speed, pause on hover, click to copy, full styling including dyslexia-friendly fonts. |
| **Audio** | Boost up to 300 %, presets (voice, bass, night) and 5-band EQ, A/V delay, pitch-preserving speed, mono/left/right channel routing, audio-only battery saver. |
| **Downloads** | VOD to a single **MP4** (TS→fMP4 remux, audio merged) or the original format, live recording, DVR save, PNG snapshots and frame-burst contact sheets. External handoff to PotPlayer, VLC, mpv, IINA or an Android app, or copy a ready `yt-dlp`/`ffmpeg` command with the right headers. |
| **Accessibility** | Full keyboard operation, screen-reader announcements, focus management, high-contrast mode, reduced motion, interface scaling (85–150 %), simple mode. |

The full tour is in **[docs/USER_GUIDE.md](docs/USER_GUIDE.md)**.

## Install

| Browser | How |
|---------|-----|
| Chrome, Edge, Brave, Kiwi (Chromium 111+) | Chrome Web Store *(link added on release)*, or load `dist/chrome` unpacked (see below) |
| Firefox desktop 140+ and Firefox for Android 142+ | addons.mozilla.org *(link added on release)*, or load `dist/firefox` as a temporary add-on |

**Load unpacked (Chromium):** `chrome://extensions` → enable *Developer mode* → *Load unpacked* →
choose `dist/chrome`.

**Temporary add-on (Firefox):** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…*
→ choose `dist/firefox/manifest.json`. Firefox asks you to grant site access for MV3 add-ons: use
**Allow access to websites** in the Velostream popup.

## Usage

1. Open a page with a video and start it once if it does not autoplay.
2. Click the **"Play in Velostream"** pill on the video, or open the toolbar popup and pick a stream.
3. The player opens over the site's video. Press <kbd>?</kbd> for all shortcuts and open
   **Studio** (the sliders button) for quality, audio, display, tools and preferences.
4. **Close** restores the site's own player.

Want a site to always open in Velostream? Turn on **Always play in Velostream** for that site in the popup.

## Documentation

| Document | Contents |
|----------|----------|
| [User guide](docs/USER_GUIDE.md) | Every feature, gesture and shortcut, Studio tabs, downloads, GPU presets |
| [Settings reference](docs/SETTINGS.md) | Every stored setting with defaults, ranges and migrations |
| [Architecture](docs/ARCHITECTURE.md) | Components, message protocol, transport, cache, ABR, export and GPU pipelines |
| [Development](docs/DEVELOPMENT.md) | Build, lint, debug, test and the Chrome Web Store / AMO release checklist |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Error codes (1001, 1002, 3016, 6xxx…), DRM, fullscreen, detection problems |
| [Permissions](docs/PERMISSIONS.md) | Why each permission is needed (store justification text) |
| [Privacy policy](PRIVACY.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) | |

## Build from source

Requirements: **Node.js 18+**.

```bash
npm install          # dev tools + shaka-player (copied into the build, never fetched at runtime)
npm run build        # dist/chrome and dist/firefox
npm run lint         # ESLint
npm run package      # store zips: dist/velostream-<browser>-<version>.zip
```

Other scripts: `npm run build:chrome`, `npm run build:firefox`, `npm run watch` (rebuild on save).
Always load the **built** folder; the sources need the build step to get Shaka and the
browser-specific manifest. Details in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Project layout

```
playerstreamextension/   (repository root)
├── manifest.json            MV3 manifest (the build derives the Chrome and Firefox variants)
├── background/              Service worker / event page: the engine
│   ├── engine.js            detection, sessions, launch, transport, export, message router
│   ├── downloader.js        on-demand + prefetch loads, workers, retries, range accelerator
│   ├── abr-controller.js    throughput + buffer adaptive bitrate
│   ├── buffer-manager.js    IndexedDB segment cache (ring buffer, eviction)
│   └── hls-parser.js        M3U8 parser, AES-128 helpers
├── content/
│   ├── interceptor.js       MAIN world: fetch/XHR/Worker/MSE/DRM hooks, page-identity fetch proxy
│   └── sniffer.js           ISOLATED world: relay, DOM scan, subtitles, badge, player mounting
├── player/                  Extension page mounted as an iframe over the site's video
│   ├── player.html / player.js   bootstrap + engine port (auto-reconnect, request replay)
│   ├── player-ui.js         the player: UI, Shaka integration, gestures, subtitles, audio, tools
│   ├── shader-pipeline.js   WebGL2 enhancement presets + thermal guard
│   └── mp4-mux.js           TS→fMP4 remux and audio/video merge for downloads
├── popup/                   Toolbar popup: streams, telemetry, site settings
├── common/shared.js         Settings schema/migration, URL classification, binary codec
├── rules/stream_rules.json  Static DNR rule exposing range headers to the page proxy
└── scripts/                 build.js, package.js
```

## Limitations

- **DRM** (Widevine, PlayReady, FairPlay) cannot be played or saved. Velostream detects it and says
  so instead of failing silently. YouTube and most paid services fall in this group.
- **Signed links expire.** Many sites sign stream URLs for minutes. Velostream switches to a newer
  link when the page requests one; otherwise reload the page and open the player again.
- **DASH download** is not supported (HLS and direct files are).
- A site's **Content Security Policy** or a sandboxed embed can forbid full screen; Velostream then
  fills the browser window instead.
- **GPU enhancement** needs WebGL2 and cannot read cross-origin direct files served without CORS.

## Responsible use

Velostream is a player and a personal download tool. Only download content you have the right to
keep, and respect each site's terms of service and your local copyright law. Velostream does not
circumvent DRM and never will.

## License

[MIT](LICENSE). Bundled [Shaka Player](https://github.com/shaka-project/shaka-player) is Apache-2.0;
its license ships in every build as `lib/SHAKA-LICENSE.txt`.
