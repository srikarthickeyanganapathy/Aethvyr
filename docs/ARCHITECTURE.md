# Architecture

Velostream is a Manifest V3 extension with three execution contexts that cooperate through
messages: **content scripts** in every frame detect streams and act on the page's behalf, the
**engine** (service worker on Chromium, event page on Firefox) owns detection state, downloading
and caching, and the **player** is an extension page mounted as an iframe over the site's video.

```
 Site page (every frame)                         Extension
┌──────────────────────────────────┐          ┌────────────────────────────────────────────┐
│ interceptor.js  (MAIN world)      │          │ background/engine.js  (service worker)     │
│  fetch / XHR / Worker / MSE /     │  window  │  tabs → streams, subtitles, DRM flags      │
│  EME hooks, page-identity fetch   │◄──msg───►│  sessions → downloader, ABR, cache         │
│                                   │          │  transport (direct ⇄ in-page proxy)        │
│ sniffer.js  (ISOLATED world)      │ runtime  │  export / recording                        │
│  relay, DOM + <track> scan,       │◄──msg───►│                                            │
│  on-page pill, mounts the player  │          │   downloader.js  abr-controller.js         │
│  iframe, suspends site media      │          │   buffer-manager.js (IndexedDB)            │
└───────────────┬──────────────────┘          │   hls-parser.js                            │
                │ <iframe src=player.html>     └───────────────▲────────────────────────────┘
┌───────────────▼──────────────────┐   runtime port            │
│ player/player.html               │   "velostream-player"     │
│  player.js   (EnginePort)        ├───────────────────────────┘
│  player-ui.js (UI + Shaka)       │   IndexedDB read (zero-copy segments)
│  shader-pipeline.js, mp4-mux.js  │
└──────────────────────────────────┘
```

## Components

### `content/interceptor.js` (MAIN world, every frame, `document_start`)

Runs in the page's own JavaScript world so it can see what the site's player does.

- Wraps `fetch`, `XMLHttpRequest`, `MediaSource`/`SourceBuffer` and `Worker`. Manifest URLs
  (by extension, query hints such as `format=m3u8`, `mime=` hints and response MIME type) and
  subtitle files are reported. A response body that starts with `#EXTM3U`, `<MPD` or `WEBVTT` is
  recognized even when the URL gives no hint.
- **Workers:** `blob:`/`data:` workers are wrapped with a prelude that reports their requests over
  a `BroadcastChannel` (`importScripts` for classic workers, `import` for module workers).
- **DRM:** `navigator.requestMediaKeySystemAccess` is observed; any key system other than Clear Key
  marks the tab as DRM-protected.
- **Fetch proxy:** executes `FS_FETCH` requests from the engine with the page's cookies, Referer
  and origin. Cross-origin requests are tried without credentials first (CDNs that answer
  `Access-Control-Allow-Origin: *` reject credentialed requests), then with them.

It communicates only through `window.postMessage` with tagged messages; it has no extension APIs.

### `content/sniffer.js` (ISOLATED world, every frame)

- Relays interceptor reports to the engine (`STREAM_FOUND`, `SUBTITLE_FOUND`, `DRM_DETECTED`,
  `MSE_INIT`) and forwards engine `FETCH_PROXY` requests to the interceptor.
- Scans the DOM for `<video>`/`<source>`, `<track>` elements and in-memory text tracks (serialized
  to VTT), and listens in the capture phase for `loadedmetadata`/`playing` to know which video is
  live.
- Draws the on-page **Play in Velostream** pill.
- **Mounts the player:** creates the `player/player.html` iframe absolutely positioned over the
  chosen `<video>` (or full-page), tracks scroll/resize, and handles layout commands from the
  player (mini player, drag/resize, viewport fill, close). The site's media is paused and muted
  while the player is open (`SUSPEND_MEDIA` / `RESTORE_MEDIA`).

### `background/engine.js`

The coordinator. State is kept per tab and persisted to `storage.session`, so a service-worker
restart does not lose detected streams.

- **Detection:** content-script reports plus `webRequest` (`onBeforeRequest`, `onHeadersReceived`
  for MIME types, `onBeforeSendHeaders` to remember each host's Referer, Origin and custom auth
  headers). `classifyStream` (in `common/shared.js`) decides HLS / DASH / progressive and rejects
  segments. Variant playlists of a known master are hidden as *children*. Ads are flagged.
- **Probing:** the first manifest of each stream is downloaded to show resolution, duration, live
  and encryption info in the popup.
- **Launch:** picks the frame (the one the user clicked in → the frame that requested the stream →
  any frame with a video → top frame in full-page mode), makes sure the content script is present,
  and sends `MOUNT_PLAYER`. *Always play in Velostream* (`maybeAutoLaunch`) waits 600 ms so the
  master playlist wins over its variants.
- **Sessions:** one per open player, holding the stream, a `SegmentDownloader`, an
  `ABRController` and a `BufferManager`.
- **Transport** (`makeTransport`): see [Network transport](#network-transport).

### `background/downloader.js`

- `load()` serves the player's requests: cache hit → in-flight prefetch promotion → network.
  Segments are stored in IndexedDB and, when *zero-copy* is possible, the player reads them
  directly from the database instead of receiving the bytes over the port.
- **Prefetch:** workers (2–8, adjusted to buffer health and latency) download ahead of the
  playhead in every active playlist, up to the pre-buffer window and the cache size. Seeking
  aborts out-of-window work and refills from the new position.
- **Range accelerator:** large segments and files are split into parallel `Range` requests. Hosts
  that ignore ranges, or where a part fails, are remembered and get whole-file requests.
- **Retries:** exponential backoff with jitter for network errors, 408, 429 and 5xx.
- **Segment normalization:** disguised segments (TS or MP4 data behind a fake image header) are
  located by sync byte or box signature and trimmed.
- **Live DVR:** live playlists are extended with cached history so a live stream can be rewound.

### `background/abr-controller.js`

Velostream turns Shaka's ABR off and decides itself, because the engine sees the real network
throughput, including prefetch. Decisions combine a throughput estimate with buffer level and
respect the quality cap and any locked quality. Switches are sent to the player as
`ABR_SWITCH`.

### `background/buffer-manager.js`

IndexedDB database `VelostreamDB`, store `data`, key `[tabId, sessionId, segmentKey]`. A ring
buffer bounded by *Cache size*. Played segments are marked *served* and evicted first. The cache
is cleared when the session ends.

### `player/player.js` + `player/player-ui.js`

- `player.js` owns the **EnginePort**: a runtime port named `velostream-player` with automatic
  reconnection. Requests in flight when the engine goes away (MV3 service workers are stopped by
  the browser) are **kept and resent** after reconnecting. Settings and history are read from
  `storage.local` directly.
- `player-ui.js` is the player: Shadow-DOM UI, Shaka Player integration, gestures, keyboard,
  subtitles engine, Web Audio graph, tools. Shaka's `http`/`https` schemes are replaced by a plugin
  (`schemeRequest`) that sends every request to the engine, so all traffic gets the pre-buffer, the
  transport fallbacks and the cache.

### `player/shader-pipeline.js`

See [GPU pipeline](#gpu-pipeline).

### `player/mp4-mux.js`

See [Export pipeline](#export-pipeline).

### `common/shared.js`

Loaded in every context. Settings defaults, deep merge and migrations (`settingsVersion` 3),
URL normalization and classification (`HLS_RE`, `DASH_RE`, `SEGMENT_RE`), ad heuristics and the
binary codec used to move `ArrayBuffer`s through extension messaging (base64 where structured
clone is not available).

## Message protocol

### Player ⇄ engine (runtime port `velostream-player`)

| Direction | Message | Purpose |
|-----------|---------|---------|
| P → E | `HELLO {sessionId, streamId, resumed}` | Attach to (or recreate) the session. Messages that arrive before the attach completes wait for it. |
| E → P | `INIT {stream, subtitles, drm, pageUrl, …}` | Session ready. After a reconnect, the player resends pending requests. |
| P → E | `REQUEST {reqId, url, method, headers, kind, zeroCopy}` | One Shaka network request (`kind`: manifest, segment, key, other). |
| E → P | `RESPONSE {reqId, ok, status, headers, data \| inCache+cacheKey, error}` | The answer; `inCache` means "read it from IndexedDB". |
| P → E | `ABORT {reqId}` | Shaka aborted the request. |
| P → E | `TELEMETRY {currentTime, bufferAhead, paused, variants, activeVariantId, qualityCap}` | Drives prefetch and ABR. |
| E → P | `STATS`, `ABR_SWITCH {variantId}`, `SUBTITLES`, `FATAL` | Engine → UI updates. |
| P → E | `SEEK`, `SET_QUALITY`, `PREFETCH {enabled}`, `PURGE_CACHE` | Playback control. |
| P → E / E → P | `FIND_FRESH {url, since}` / `FRESH {url}` | Find a newer signed link for the same video. |
| P → E | `EXPORT_START`, `RECORD_START`, `RECORD_STOP`, `EXPORT_CANCEL` | Downloads. |
| E → P | `EXPORT_BEGIN`, `EXPORT_CHUNK`, `EXPORT_PROGRESS`, `EXPORT_FILE_DONE`, `EXPORT_ERROR` | Download data and progress. |
| P → E | `CLOSE` | End the session and restore the site player. |

### Content scripts ⇄ engine (`runtime.sendMessage` / `tabs.sendMessage`)

`STREAM_FOUND`, `SUBTITLE_FOUND`, `DRM_DETECTED`, `MSE_INIT`, `VIDEO_PRESENT`,
`LAUNCH_FROM_PAGE`, `GET_BADGE_STATE` from frames, and `GET_STREAMS`, `GET_STATS` from the popup; `PING`, `FETCH_PROXY`, `FETCH_ABORT`,
`MOUNT_PLAYER`, `UNMOUNT_PLAYER`, `SUSPEND_MEDIA`, `RESTORE_MEDIA`, `RESCAN`, `STREAMS_AVAILABLE`
from the engine. Content scripts relay to and from the interceptor with `window.postMessage`
(`FS_FETCH`, `FS_ABORT`, `FETCH_RESULT`, report messages).

## Network transport

Every request (manifest, segment, key, subtitle) goes through `makeTransport` in the engine:

1. **Direct fetch from the extension.** Host permissions mean no CORS. The site's Referer and
   Origin are applied by a per-host session DNR rule (`ensureRefererRule`), and custom headers
   the site's player sent to that host (tokens) are replayed. This is the fastest path: no
   content-script hop and no base64 round trip.
2. **In-page proxy.** If the server refuses (401/403/407/451) or the request fails, it is retried
   through `FETCH_PROXY` in the frame that owns the stream, with the page's cookies and session. A
   host that only works this way is remembered (`pageOnlyHosts`) and goes straight to the proxy
   next time.
3. When both fail, the error carries both reasons (`direct: …; in page: …`) and the player shows
   it with the server name.

The static rule in `rules/stream_rules.json` appends `Access-Control-Expose-Headers` for media
responses so the proxy path can read `Content-Range` and `Content-Length`.

**Failure handling in the player:**

- transient errors (Shaka 1002/1003, HTTP 5xx/408/429) reload silently from the current position,
  up to twice a minute;
- HTTP 401/403/410 asks the engine for a **fresher signed link** (`FIND_FRESH`: same host and path,
  detected later) and switches to it;
- only then is an error shown.

## Export pipeline

1. The engine walks the playlist (variant chosen by the player, plus a separate audio
   rendition when there is one), downloads segments with the same transport, decrypts AES-128,
   and streams them to the player as `EXPORT_CHUNK {kind: 'init' | 'seg', start, end}`.
   Service workers cannot create object URLs, so assembly happens in the player page.
2. With *Save format = MP4*, `ExportMuxer` (`mp4-mux.js`) converts MPEG-TS to fragmented MP4 with
   Shaka's `TsTransmuxer`. It then merges the init segments into one `moov` (a `trak` per track,
   track IDs remapped in `tkhd`/`trex`/`tfhd`), renumbers `mfhd`, and normalizes `tfdt` by a shared
   offset so the file starts at 0 with audio and video in sync.
3. The output goes to an `ExportSink`: `showSaveFilePicker` when the browser allows it (written
   progressively), otherwise Blob parts saved with `chrome.downloads` (object URL revoked on
   completion).

Recording live streams uses the same path from the current media sequence. The DVR save
exports what the cache already holds.

## GPU pipeline

`VideoShaderPipeline` draws the `<video>` through WebGL2 into a `<canvas>` placed over the
video's content box (object-fit aware), inside the same transformed box as the video, so zoom,
rotation and mirroring apply identically.

- Frames are driven by `requestVideoFrameCallback` (falling back to `requestAnimationFrame`), so
  nothing runs while the video is paused or hidden. Seeks and setting changes render one frame on
  demand. The canvas stays hidden until its first frame is drawn, so there is no black flash.
- Each frame is uploaded with `texImage2D(video)`. Passes:
  - `cas`: 1 pass.
  - `deband`: 1 pass.
  - `fsr`: Lanczos-2 (with anti-ringing) into an FBO, then RCAS.
  - `anime4k`: Lanczos-2 into an FBO, then gradient push.
  - When the output is not larger than the source, `fsr` and `anime4k` run a single pass instead.
- **Orientation:** video textures have the picture's top at v = 0; FBO textures have it at v = 1.
  The vertex shader's `uFbo` uniform selects the matching mapping per pass.
- Canvas size: the displayed size × devicePixelRatio, capped by *max render resolution*. CAS never
  renders below the source resolution.
- **Thermal guard:** 3 s windows. The first window after start, seek or preset change is
  discarded. GPU time comes from `EXT_disjoint_timer_query_webgl2` (CPU time when it is missing),
  together with dropped-frame counts. Two overloaded windows in a row step the preset down
  (`fsr`/`anime4k` → `cas` → `off`) for the session.
- Cross-origin direct files without CORS make `texImage2D` throw `SecurityError`. The pipeline
  reports itself unavailable and the plain video is shown.

## Browser differences

| | Chromium | Firefox |
|---|---|---|
| Background | `service_worker` (module) | event page (`background.scripts`, module) |
| Manifest | `minimum_chrome_version: 111` (MAIN-world content scripts) | `browser_specific_settings.gecko` (min 140, Android 142) |
| Site access | granted at install | opt-in: popup shows **Allow access to websites** |
| API namespace | `chrome.*` | `browser.*` (`common/shared.js` exports whichever exists as `api`) |

The build generates both manifests from `manifest.json` (see `scripts/build.js`).

## Security model

- **No direct `innerHTML`.** Markup is inserted with `setHTML`/`replaceWithHTML` from
  `common/shared.js`. They parse in an inert `DOMParser` document, then remove `script`, `iframe`,
  `object`, `embed`, `link`, `meta`, `base`, `foreignObject` and `noscript` elements, every `on*`
  attribute, and `href`/`src`-style attributes whose URL is not http(s), blob, relative, a
  fragment or a raster `data:image`. Text from sites (titles, subtitle lines, labels) is also
  escaped with `esc()` inside the templates.
- The interceptor only executes `FS_FETCH` for `http(s)` URLs and only answers its own tagged
  messages. Pages can talk to it, but it only ever performs requests the page itself could make,
  with the page's own identity.
- The player is an extension origin; the page cannot script it. Messages from the page to the
  player iframe are limited to layout commands keyed by the session id.
- No remote code: Shaka is bundled, no `eval`, no CDN. No data leaves the browser except the
  requests to the sites you watch (see [PRIVACY.md](../PRIVACY.md)).
