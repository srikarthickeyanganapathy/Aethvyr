# Aethvyr roadmap

| Phase | Focus |
| --- | --- |
| 1. Foundation — complete | Branding, shared design tokens, CI, private storage protections, desktop upgrades and the installed-player lifecycle are documented in the [foundation checklist](FOUNDATION.md). |
| 2. Intelligence (complete) | Unified profiles, shared resource budgets, adaptive buffering, GPU fallback, diagnostics, failure handling and [desktop benchmark results](FOUNDATION.md#phase-2-completion-report). |
| 3. Experience (complete) | Full, lightweight and enhancement-only playback, reversible cinema dimming, keyboard-accessible help and unified session controls. |
| 4. Library and Vault (complete) | Episode identity, confirmed next links, persistent playback queue, Library layouts, local statistics and batch download management. See the [browser verification report](FOUNDATION.md#phase-4-library-and-vault). |
| 5. Whisper (implemented) | Sentence practice, vocabulary exports and capability-gated browser-local language tools. See [desktop verification and model limits](FOUNDATION.md#phase-5-whisper). |
| 6. Experimental research (complete) | Six browser experiments evaluated. Production release decisions, raw measurements and reproduction commands are in the [research report](PHASE6.md). |

## Benchmark protocol

Compare the site's native player with Aethvyr using the same browser version, device, media,
resolution, and network conditions. Record the Aethvyr version and profile. Run cold-cache and
warm-cache tests separately and repeat each case at least five times.

Measure startup, stalls, seek response, dropped frames and transferred bytes. Record CPU, GPU,
memory and battery where the platform exposes comparable measurements. Use Aethvyr's
diagnostics JSON for its playback timings and browser tooling for native playback and resource
measurements. Publish medians, the test conditions, and regressions alongside improvements.
