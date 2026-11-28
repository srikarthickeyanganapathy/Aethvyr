# Phase 2 architectural modernization

26 November 2026 · Windows desktop · Aethvyr 2.10.0

This report covers the architecture request. The earlier “Phase 2” in the foundation audit records prefetch experiments. This increment builds on the existing working tree, including the Phase 1 identity and the later library and Whisper features.

## Refactoring batches

1. Added four regression tests against the original implementations before extraction. These cover quoted HLS codec lists and relative URLs, cache resize and duplicate accounting, idempotent settings normalization, and HTTP retry deadlines. All 41 baseline tests passed.
2. Moved subtitle parsing, text escaping, numeric clamping and HTTP retry classification into importable modules. The downloader continues to export the existing HTTP error class and deadline helper for its callers.
3. Moved profile overlays and settings copying into `player/settings-overlay.js`. The shared settings API defines the nested patch fields used by Studio, the popup and the engine. The existing schema and normalization code remain the authority for stored data.
4. Extracted the Web Audio graph and its presets into `player/audio-fx.js` and the Shaka text displayer into `player/subtitle-engine.js`. The player owns their lifetime. Converted the player bootstrap to a native ES module so these dependencies load before a player is constructed.
5. Separated player request/reply handling from browser port reconnection. Closing the player now cancels the reconnect timer, clears retained media requests and settles outstanding UI waiters. Messages from a superseded connection cannot clear the current connection's pending requests.
6. Extracted stream ranking, tab snapshots and recovery into `background/tab-state.js`. Export naming, recording selection and DASH plan validation moved into `background/export-plan.js`. The coordinator retains the live maps, storage write scheduling, sender checks and cancellation owners.
7. Centralized player and Vault port names. Isolated frame scripts now delegate media-element discovery and candidate selection to `content/media-elements.js`. Both initial injection and late injection load it before the sniffer. Classic-script loading at document start preserves timing on Chromium and Firefox.

The [architecture guide](ARCHITECTURE.md) describes entry points and ownership. No storage migration is required. The Firefox signing ID, storage namespaces, exported compatibility globals, port names and backup format remain the same.

## Resource ownership review

| Resource | Owner and cleanup path | Evidence or remaining limit |
| --- | --- | --- |
| Event listeners and timers | Player teardown drains registered disposers and timers. EnginePort removes its storage listener and cancels reconnect. PortClient clears each request timeout on reply or close. | Unit tests cover pending UI requests, port cleanup and resumed requests. Edge exercised close and native restoration. |
| Mutation and resize observers | Frame detection observes the document for its lifetime. Overlay mount/unmount manages its resize observer, layout polling and animation frame. Player teardown disconnects its resize observer. | Reviewed ownership in the sniffer and player. Long-running single-page navigation remains a soak-test item. |
| Workers | The player terminates its PiP ticker on teardown. The page interceptor observes site-created workers, which are owned by the site. | Reviewed source. Repeated PiP on physical devices remains unmeasured. |
| Network requests and runtime ports | A background session owns request abort controllers and its export controller. Downloader destruction stops session work. The player retains outstanding IDs across a disconnect and replays them after resumed initialization. | Recovery test covers acknowledged, cancelled and outstanding requests. Browser tests exercised actual exports and port-backed playback. |
| Audio and GPU | AudioFx closes its context on initialization failure or destruction. The player destroys its shader pipeline and Shaka instance. | Edge exercised WebGL context loss and restoration. Audible transitions and hardware-specific output remain device checks. |
| Object URLs | Local playback and thumbnail code revoke their own URLs. Export URLs have separate download lifetimes. Shaka releases its MediaSource during destruction. | Reviewed ownership paths. Edge verified downloaded bytes. Long-running memory retention was not profiled. |
| Sessions and caches | Engine session teardown removes the session, aborts work, clears timers and handles cache cleanup. Private caches are session-owned. Tab snapshots rebuild Maps and Sets after a worker wake. | Unit tests exercise snapshot round trips, cache pressure and subtitle persistence. Browser checks cover normal and private-session behavior. |

## CI and verification

The existing [GitHub Actions workflow](../.github/workflows/verify.yml) now builds Chromium and Firefox in separately named commands and validates the final archives before uploading artifacts. It retains lockfile installation, linting, unit tests, tag checks and the separate dependency audit. The build also checks relative module references and detects static dependency cycles. Package validation compares every file to its unpacked build and checks version, target entry point, Gecko identity and bundled notices.

| Local check | Result |
| --- | --- |
| Clean dependency installation | `npm ci` installed 145 packages from the lockfile in a disposable directory. npm retried cached tarballs and emitted deprecation warnings. |
| ESLint and Node tests | Lint passed. All 48 tests passed, including 11 added in this phase. Coverage includes request replay, tab rehydration, subtitle parsing/display, settings overlays, recording selection and mount selection. |
| Browser builds and packages | Both browser-specific build commands passed. Both version 2.10.0 ZIPs validated against their unpacked builds, 58 files each. |
| Edge 158.0.4370.33 | In-place fixture upgrade preserved the file handle, bookmark, collection, watch position and download bytes. Native and full-player controls, library queue, Vault pause/resume, subtitle import, seek, close, GPU context restoration and private isolation passed. Two exported MP4s matched the fixture byte for byte. Library and Whisper runners refreshed their four existing screenshots. |
| Firefox 160.0 | The 2.7.1 fixture upgraded to the candidate and repeated the installation in disposable profiles with sync enabled and disabled. Stored-data and private-history probes passed in both. |

The workflow steps were validated locally. Hosted Actions execution, store-signed upgrades, Android, live account sync and browser-forced termination mid-request were outside this run. The port recovery regression simulates the disconnect and resumed handshake.

## Technical debt inventory

| Priority | Remaining responsibility | Next independent verification |
| --- | --- | --- |
| High | The engine still coordinates session lifetime and network transport alongside browser listeners. | Before extracting either owner, add a browser-driven worker-termination fixture during an outstanding media request. Check one terminal response, cache reuse and session retirement. |
| High | The player still coordinates Shaka lifecycle, gestures, shortcuts and export sinks. | Exercise rapid close during load, source replacement, and keyboard focus after teardown before moving a controller. |
| Medium | Native-player integration and mounting share document state in the sniffer. | Exercise frame navigation and replacement of the native video while mounted before introducing a site adapter interface. |
| Medium | Some message families still use local string discriminators and response shapes. | Migrate one paired sender/receiver at a time with compatibility fixtures for older payloads. |
| Medium | Project import checks recognize literal relative imports. Future import conventions could outgrow this scanner. | Use parser-backed graph validation if build syntax expands. |
| Medium | The locked ESLint version and several development dependencies emit deprecation warnings. | Upgrade development tooling separately and compare the lint and packaging results. |
