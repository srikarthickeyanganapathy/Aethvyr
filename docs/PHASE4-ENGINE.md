# Phase 4 streaming engine

The existing ABR controller, downloader, IndexedDB ring cache and shared resource budgets remain the production path. ABR estimates sustainable throughput and considers buffer health. The downloader owns range acceleration, deduplication, cancellation, retry cooldowns and live DVR. The engine owns session recovery, signed-link refresh coordination and disk allocation. GPU overload monitoring remains local to the renderer. No new storage schema is required.

## Scheduling

| Profile | Prefetch window ceiling | Per-session worker ceiling | Aggregate cache ceiling |
|---|---:|---:|---|
| Eco | 60 s | 2 | 128 MiB |
| Balanced (default) | 180 s | 4 | 512 MiB |
| Performance (stored as max) | 900 s | 8 | Configured cache |
| Custom | Configured, up to 86,400 s | Configured, up to 8 | Configured cache |

Lower user settings, device tuning, current session count and available storage can reduce these ceilings. Hidden playback outside PiP caps speculative work at one worker and 30 seconds. The same ceiling now applies when the browser reports Save-Data or a discharging battery at 20% or below. Only a boolean travels with playback telemetry. Unsupported battery APIs leave normal policy in effect.

Global transport concurrency is 12, capped at eight per origin. Speculative reads now leave one slot free at both boundaries for other work. Queued speculation cannot consume that reserved slot. Existing in-flight reads finish normally. The regression suite exercises a demand request arriving behind blocked speculation. The existing seek grace window and stale-segment cancellation continue to apply.

## Measurements

Windows, Edge 158, local generated media. Five mixed Eco/Performance trials per configuration before and after the change gave these medians:

| Two sessions | Before | After |
|---|---:|---:|
| Shared origin, prefetch completion | 398 ms | 396 ms |
| Separate origins, prefetch completion | 397 ms | 395 ms |

Each session transferred 745,536 bytes in every run. Peak active prefetches were two for Eco and four for Performance. This fixture exercises downloader sharing. The reserved network slot is tested separately under saturation.

In the installed-browser benchmark, median cold startup was 164 ms for Aethvyr and 109 ms for native playback. Warm startup was 158 ms and 110 ms respectively. The earlier Phase 2 run recorded 158 ms cold and 146 ms warm for Aethvyr. Warm seek remained 4 ms for the overlay. Each overlay launch fetched 31,064 bytes. Native warm launches reused cached bytes. Five seeks produced five waiting events on each player. The overlay dropped zero of 103 sampled frames. Startup was slower than the earlier fixture run; these samples do not establish a speedup.

A Node memory fixture inserted 100 separate 64 KiB buffers into a 1 MiB PrivateBuffer. The retained cache was 1,048,576 bytes. The process ArrayBuffer counter increased by 4,194,304 bytes after explicit GC in one run. Clearing and storing the first replacement took 0.046 ms. Process allocation counters include transient allocations. This measurement does not quantify browser RSS, GPU memory or IndexedDB overhead.

Reproduce network measurements with `node scripts/benchmark-prefetch.js --mixed` and `node scripts/benchmark-seek.js --compare-priority`. Use the Chromium foundation runner with the legacy ZIP and `--benchmark --security` for the browser measurements. Both packages validated, ESLint passed and all 55 Node tests passed. Edge exercised context-loss recovery, private playback and header-scoped HLS/DASH. Physical low-battery devices, Android and forced worker termination during a live transfer remain unmeasured.

On the nominal 2 Mbit/s link, five trials per cell exercised the existing bounded seek-priority policy. Median time to recover the requested bytes for Eco was 1,202 ms with priority disabled and 1,057 ms enabled. Modeled peer stall was 686 ms and 541 ms respectively. For Performance the corresponding seeks were 1,203 ms and 610 ms, with peer stalls of 687 ms and 93 ms. All targets matched the fixture and were fetched once. These comparisons isolate the existing seek-priority switch; they do not measure the incremental effect of the new transport reservation.
