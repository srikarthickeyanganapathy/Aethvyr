# Aethvyr foundation audit and development checklist

## Starting point

The local baseline on 25 November 2026 was commit `c965a63` on `feature/local-playback-and-media-exports`, two commits ahead of its remote-tracking branch, with a clean tracked worktree. Manifest, package and lockfile identify version 2.7.1. The release includes Shaka Player 5.3.3, Anime4K shader notices, two tracked unpacked distributions and locally generated ZIPs. Existing CI installs the lockfile, lints, runs Node tests, builds and packages both targets, checks version tags, uploads artifacts and audits production dependencies. Dependabot, a playback issue template and a PR template already exist.

## Capability inventory

The inventory and prioritized findings below describe the starting checkout. See **Status by phase** for completed fixes and validation.

“Tested” below means a named behavior has an automated regression in this checkout. Browser interactions listed as implemented were identified in source. They still need installed-extension verification on the supported devices.

| Area and source | Existing implementation and evidence | Gap or disposition |
|---|---|---|
| Detection and mounting, `content/interceptor.js`, `content/sniffer.js`, `background/engine.js` | MAIN-world fetch, XHR, Worker and MSE observation, network detection, subtitle discovery, isolated-world relay, all-frame mounting, native media suspension and restoration | Security- and browser-sensitive. Exercise detection, signed-link refresh, permission revocation and restoration on an embedded fixture. |
| Playback, `player/player.js`, `player/player-ui.js` | Bundled Shaka, progressive and local playback, quality, speed, resume, PiP, gestures, shortcuts, transforms, A–B, chapters and chapter-aware skip | Full player exists. Native enhancement and lightweight execution modes need distinct lifecycle and resource tests. A cinema skin already ships. Page dimming and reversible page focus are separate work. |
| Streaming, `background/{hls-parser,downloader,abr-controller,resource-policy,buffer-manager}.js` | HLS parsing, prefetch, byte ranges, ABR, DVR, IndexedDB, backoff, cache eviction, an eight-slot shared prefetch policy, Eco/Balanced/Max/Custom ceilings. Range validation, deduplication and paused prefetch budgets have tests. | Partial coordinated scheduling. Measure demand traffic and exports alongside prefetch. Add origin fairness and rate-limit handling. Preserve the stored Max profile identifier. |
| Vision, `player/shader-pipeline.js`, `player/anime4k.js` | Device/source-aware Auto, sharpening, cleanup, Anime4K chains, color processing, comparison and context-loss handling. Tests cover device budgets and retired-preset migration. | Performance-sensitive. Benchmark frame pacing, context recovery and fallback on real GPUs. Keep retired choices as migration inputs. |
| Audio, captions and Studio, `player/player-ui.js` | EQ, boost, normalization, dialogue, width, crossfeed, routing, A/V delay, captured and imported subtitles, styling, dual captions, searchable transcript, control ordering, keymap and site settings | Verify audible transitions, caption timing, keyboard focus and scaling. Evaluate sentence repetition and independent subtitle styling before adding AI. |
| Library and local playback, `popup/js/library.js`, `common/{shared,local-files}.js` | Favorites, collections, artwork, format and animation classification, season/episode grouping, bookmarks, local selection, sidecars and playlists. Tests distinguish format from animation medium. | Improve episode matching and editable series progress. A cross-site playback queue and confirmed next-episode transitions extend the existing local playlist. File-handle permissions need browser-specific tests. |
| Vault, `background/download-store.js`, `player/mp4-mux.js` and export paths in engine/player | Persistent jobs, cached segment reuse, cancellation, resume, HLS/DASH export, MP4 mux, clips, DVR, snapshots and external handoff. Fixture tests verify audio/video indexing and duration. | Test worker loss, full storage and cancelled exports end to end. Extend existing job records for queue UX. |
| Sync and backups, `background/sync.js`, `common/shared.js` | Opt-in browser sync v2, sanitized navigation, omitted stream URLs, per-section budgets, device-setting exclusions, timestamps and tombstones. Tests exercise signed URLs and a two-device merge. | Security-sensitive. Cover private contexts, mixed-version clients, deletion and quota interruption before changing storage. Portable local backups contain viewing data. |
| Insight, `player/diagnostics.js` | Local export allowlists fields, reports startup, buffering, frames, network and cache metrics, and caps history. Redaction has a regression test. | Add measurements only where an API supplies them. Capture matching native-player baselines. |
| Accessibility and design, `common/tokens.css`, popup and player styles | Shared semantic tokens, reduced-motion rules, keyboard controls, screen-reader labels, scaling and simpler control layouts exist. | Replace the old V artwork and remaining hardcoded colors. Verify contrast, focus restoration, high contrast and 16 px legibility before taking release screenshots. |
| Proposed research | Global multi-session control, optional local transcription/translation, WebGPU, HDR processing, interpolation and local automatic skip analysis | Gate each on explicit user value, capability detection, privacy and measured cost. Existing Media Session integration and chapter skip are starting points. |

## Prioritized work and acceptance criteria

| Order | Issue | Smallest deliverable and verification |
|---|---|---|
| 1 · Privacy | Firefox testing confirmed that private watch positions reached regular extension storage. The background history writer now checks the browser-provided private context. | Extend the private-window suite to bookmarks, local-file handles, prefetch cache, export metadata and Chromium. Inspect each store after closing the private session. |
| 2 · Security | The engine handles request headers, frame messages and privileged fetches. The static DNR response rule matches HTTP(S) XHR, media and other requests broadly. | Document the owner and allowed origin for each session and redirect. Test rejected destinations, unrelated frames, oversized messages and teardown with synthetic data. Narrow the rule only after authorized playback succeeds with the narrower scope. |
| 3 · Reliability and architecture | Engine orchestration and player UI combine session lifetime, transport, exports and persistence. Node tests exercise individual paths but CI lacks an installed-extension lifecycle suite. | Add a controlled media page and a test for open, play, seek, close and native restoration. Extend to worker restart, tab closure and denial of site access. Extract one lifecycle owner after those tests pass. |
| 4 · Performance | Two equally loaded sessions shared the eight prefetch slots evenly in the loopback benchmark. Per-session Retry-After handling is implemented. Aggregate bandwidth under constrained links and contention with exports still need measurement. | Extend the benchmark to asymmetric workloads, demand requests, exports and a bandwidth-limited origin. Test storage exhaustion and background tabs before changing profile defaults. |
| 5 · Usability and accessibility | Display names now span the main user journey. The toolbar artwork, palette and screenshots still reflect Velostream. | Produce a small-size mark first, then active/inactive and monochrome variants. Apply the palette through existing tokens, validate normal/high-contrast themes and keyboard operation, then capture real screenshots and a short demo. |
| 6 · Documentation and distribution | Build targets have version floors. Current browser support, release-store acceptance and performance figures require separate evidence. | Record tested device/browser versions, fixture results and limitations. Keep tracked unpacked builds while README installation uses them. Add a feature-request template and code of conduct. Review labels, milestones and store policy before external release work. |

## Compatibility and migration

This display-name increment requires zero storage writes on upgrade. Keep the Firefox ID, unpacked installation path, `VelostreamDB`, `VelostreamDownloads`, `VelostreamLocal`, `VelostreamShared`, runtime ports, page message tags, resume fragments, `fs_*` and `vs_*` keys. A backup has a new suggested filename and the original `app: "velostream"` discriminator. The importer reads the payload independently of the filename.

For release qualification, seed a disposable 2.7.1 profile with a site preference, watch position, bookmark, collection, cached download and local-file handle. Upgrade in place using the same extension identity, reopen each item and repeat the upgrade. Repeat with sync enabled and disabled. Any future schema change needs a versioned, retry-safe migration and fixtures for older data.

## Verification and performance baseline

Firefox desktop 160.0 on Windows passed an in-place temporary add-on upgrade from Velostream 2.7.1, followed by a second Aethvyr install using the same ID. Separate disposable profiles exercised sync enabled and disabled without a signed-in account. Both retained the seeded site setting, position, bookmark, favorite, collection, download checkpoint and its bytes. A private player history write reproduced the leak before the fix. After the fix, a normal player write succeeded and the private entry was absent after closing the private window. This check exercises the player-to-engine history message. Signed store updates, cross-device delivery and real file-picker handles require separate tests.

Windows, Node 24.22.0, installed lockfile dependencies. Before the edit, 22 Node tests and ESLint passed. Afterward, 23 tests and ESLint passed, including a new restore/re-export test using a Velostream backup. Both target builds passed manifest asset validation. Both ZIPs opened and contained the expected Aethvyr manifest and Shaka and Anime4K notices. The Firefox ZIP retained the Gecko ID. These checks cover packaging and portable backup compatibility.

The local dual-target copy/build took 120 ms on one run. This measures developer tooling. Playback startup, seek latency, rebuffering, frames, transfer size, memory, GPU use and battery do not yet have a measured comparison for this increment. Use the five-run cold/warm protocol in [the roadmap](ROADMAP.md) with identical source and quality, first on desktop Chromium and Firefox, then integrated GPU and Android. Include 480p through 4K where supported, live media, multiple sessions and repeated open/close cycles. Preserve raw reports and record unavailable metrics explicitly.

## Development checklist

### Phase 2 concurrent prefetch baseline

Run `node scripts/benchmark-prefetch.js` with loopback networking available. On Windows with Node 24.22.0, two Balanced downloaders started together with empty in-memory caches. Each prefetched 24 copies of the 31,064-byte video fixture. Each server delayed responses by 20 ms. Five trials per configuration alternated execution order.

| Loopback origins | Elapsed times in trial order (ms) | Median (ms) | Peak active requests per session | Completed segments per session at halfway |
|---|---|---:|---|---|
| One shared origin | 214, 196, 192, 190, 192 | 192 | 4 / 4 | 12 / 12 in all trials |
| Two separate origins | 185, 186, 190, 197, 191 | 190 | 4 / 4 | 12 / 12 in all trials |

Each session received 745,536 bytes. Both scenarios peaked at eight requests overall. The fixture exercises the production HLS prefetch scheduler with a loopback transport and an in-memory cache index. Browser decoding, IndexedDB latency and bandwidth-constrained playback require separate measurements.

### Mixed performance profiles

Run `node scripts/benchmark-prefetch.js --mixed` to pair Eco with Max using two-second fixture segments. In five trials per configuration, Eco peaked at two active requests and Max at four. All ten runs reached the halfway point with eight Eco segments and sixteen Max segments complete. Median completion time was 339 ms with one origin and 319 ms with two. The shared pool had two unused slots at peak. Test a constrained link and competing demand requests before changing the allocation policy.

### Phase 2 seek latency under a shared bandwidth limit

On Windows with Node 24.22.0, `node scripts/benchmark-seek.js` used the production downloader, two registered sessions, an in-memory cache and one loopback HTTP server. The server divided 2,500 payload bytes equally among active responses every 10 ms (nominal ceiling 2 Mbit/s). Each run waited for the initial prefetch requests to reach the server, then sought to an uncached segment at 180 seconds. Each target was requested once and its 31,064 returned bytes matched the source fixture. Four scenarios ran in rotating order over five rounds.

| Seeking profile | Other session's prefetch | Five times from seek to complete target segment (ms) | Median (ms) |
|---|---|---|---:|
| Eco | Paused | 389, 399, 385, 398, 284 | 389 |
| Eco | Max active | 1091, 897, 1189, 1209, 1083 | 1091 |
| Max | Paused | 909, 811, 795, 644, 626 | 795 |
| Max | Eco active | 1119, 1211, 1224, 1191, 991 | 1191 |

The competing session added 702 ms to Eco's median and 396 ms to Max's median. The seeking session's own prefetch remained enabled in every run. These measurements end when the downloader returns the target bytes. Browser decoding, rendering, and time to the first displayed frame are outside the fixture. Next, compare the current scheduler with temporarily deferring new speculative requests while a seek is waiting for media. Measure both seek latency and buffer health in the other session.

### Historical Phase 2 seek-priority experiment

The original scheduler comparison used an unbounded prototype. The current harness tests the bounded production policy below. Both sessions prefetch on the same simulated link. The experimental policy stops issuing new prefetch slots from the seek until the target bytes arrive. Requests already underway can finish. The existing downloader still cancels obsolete prefetches when seeking. Both sessions resume scheduling immediately after the target returns.

The peer starts with 500 ms of playable media. Its modeled playhead advances at normal speed while contiguous completed segments are available, then stalls until the next segment arrives. The observation ends two seconds after the seek starts in both policies. The harness verifies the target bytes and a single target request on every trial. These timings apply to a single cold seek and synthetic two-second segments. A browser decode stall, repeated scrubbing, slow servers, and failed target requests require separate tests.

Medians on Windows, Node 24.22.0, five trials per cell in rotating order:

| Seeking profile | Policy | Seek to target bytes | Modeled peer stall | Peer buffer at two seconds |
|---|---|---:|---:|---:|
| Eco | Current | 1,042 ms | 531 ms | 7,103 ms |
| Eco | Defer new prefetch | 889 ms | 379 ms | 14,879 ms |
| Max | Current | 1,018 ms | 501 ms | 3,001 ms |
| Max | Defer new prefetch | 582 ms | 66 ms | 6,566 ms |

All 20 trials exhausted the peer's initial half-second buffer at least briefly. The candidate reduced median stall duration for both profiles. These historical results motivated a bounded deferral and cancellation tests.

### Phase 2 completion report

Verified on Windows on 25 November 2026 with 35 automated tests, lint, both browser builds and both ZIP packages. Edge 158 passed upgrade, overlay playback, native restoration and private export checks. Firefox 160 passed upgrade and private-history checks with sync enabled and disabled.

| Requirement | Delivered behavior |
|---|---|
| Unified profiles | Eco, Balanced, Performance and Custom share settings between the popup and player. Existing Performance selections retain the storage key `max`. Eco disables automatic GPU effects. |
| Resource budgets | Eight shared speculative segment slots, twelve concurrent engine transport requests and eight per origin. Session cache shares respond to profile, session count and estimated free storage, reserving 32 MiB when the browser reports a quota. Custom can pace speculative bytes across active sessions. |
| Adaptive buffering | Buffer health and latency adjust worker count. Hidden players outside picture-in-picture use at most one speculative worker and 30 seconds of look-ahead. Cache pressure shortens the prefetch window. |
| GPU safeguards | Frame-time and dropped-frame monitoring can reduce effects and fall back to the original video. Automated tests cover sustained overload. Edge exercised context loss and restoration. |
| Diagnostics | Playback diagnostics include frame drops, rendering dimensions, shader CPU submission time, GPU timing when exposed, failed attempts and retries. The export excludes media URLs. |
| Failure handling | Rate-limited requests honor available Retry-After headers. Cancellation releases queued transport slots. A seek can defer new speculative work for up to 750 ms, at most once per 1.5 seconds. |

#### Contended seeks

The two-session, nominal 2 Mbit/s loopback fixture above ran five trials per cell using the production scheduling policy. The baseline disables seek priority. The peer started with 500 ms buffered. Every trial returned the correct target bytes.

| Seeking profile | Median seek before | Median seek with priority | Median modeled peer stall before | Median modeled peer stall with priority |
|---|---:|---:|---:|---:|
| Eco | 1,193 ms | 916 ms | 678 ms | 405 ms |
| Performance | 1,192 ms | 609 ms | 676 ms | 92 ms |

#### Native and overlay playback

Headless Edge 158.0.4370.33, Balanced defaults, identical local 31,064-byte progressive MP4, five trials per cell. Startup includes test control and frame observation overhead, plus player mounting for the overlay. Cold runs clear the HTTP cache and verify media transfer. Warm runs allow browser cache reuse. Measured bytes are server media payload only.

| Metric (median) | Native | Aethvyr |
|---|---:|---:|
| Cold playback start | 110 ms | 158 ms |
| Warm playback start | 108 ms | 151 ms |
| Cold media payload per start | 31,064 bytes | 31,064 bytes |
| Warm media payload per start | 0 bytes | 31,064 bytes |
| Warm seek to presented frame | 5 ms | 4 ms |

Both players reported five waiting events over five warm seeks and zero dropped frames across the 100 frames counted by the browser. On this fixture the overlay added 48 ms to median cold startup and fetched the media again on warm starts. The one-millisecond seek difference is too small to establish a user-visible advantage. Android, battery draw, physical GPU utilization and sustained high-resolution playback remain unmeasured.

Reproduce the scheduler run with `node scripts/benchmark-seek.js --compare-priority`. For playback and WebGL recovery, build the extension and run `node scripts/chromium-foundation.mjs "<Edge executable>" dist/velostream-chrome-2.7.1.zip --benchmark` with the legacy upgrade fixture.

### Status by phase

- **Completed** — repository and version inventory, local test baseline, display-name changes, package naming, CI artifact glob, current documentation copy, backup round trip and browser-specific packages.
- **Completed · Phase 1** — shared celestial palette, contrast regression, toolbar states at 16/32/48/128 px, monochrome mark, promotional artwork, real screenshots and a short demo. Edge 158 preserved the same unpacked identity, a real origin-private file handle, bookmarks, history, collection and cached download bytes across an upgrade. A generated progressive MP4 exercised detection, mounting, playback, seeking, closing and native playback restoration. Edge InPrivate checks covered a session-only bookmark, local-file record, media cache and export. Firefox 160 passed both upgrade scenarios, private watch history and local-file isolation. Store-signed delivery, Android and live browser-account sync remain release qualification work.
- **Completed (Phase 2)**. All seven implementation areas and local checks are recorded in the [completion report](#phase-2-completion-report).
- **Proposed · Phase 3** — test native restoration, then implement lightweight and enhancement-only modes, reversible cinema controls and global session controls.
- **Proposed · Phase 4** — improve episode identity, next-episode confirmation, watch queues and persistent download management.
- **Proposed · Phases 5–6** — subtitle learning controls first, opt-in local language processing and graphics experiments after core reliability gates.
- **Blocked on external prerequisites** — repository rename, store listing changes, signing and publication need owner access and explicit approval. Device-specific benchmark claims need corresponding hardware and test runs.
