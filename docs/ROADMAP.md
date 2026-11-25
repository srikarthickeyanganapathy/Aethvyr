# Aethvyr roadmap

| Phase | Focus |
| --- | --- |
| 1. Foundation — complete | Branding, shared design tokens, CI, private storage protections, desktop upgrades and the installed-player lifecycle are documented in the [foundation checklist](FOUNDATION.md). |
| 2. Intelligence (complete) | Unified profiles, shared resource budgets, adaptive buffering, GPU fallback, diagnostics, failure handling and [desktop benchmark results](FOUNDATION.md#phase-2-completion-report). |
| 3. Experience | Lightweight and native enhancement modes, reversible cinema controls, accessibility and unified playback controls. |
| 4. Library and Vault | Episode matching, playback queues and persistent download management. |
| 5. Whisper | Subtitle learning controls, optional translation and local transcription. |
| 6. Experimental research | Evaluate WebGPU, HDR processing and motion interpolation against measured playback and quality budgets. |

## Benchmark protocol

Compare the site's native player with Aethvyr using the same browser version, device, media,
resolution, and network conditions. Record the Aethvyr version and profile. Run cold-cache and
warm-cache tests separately and repeat each case at least five times.

Measure startup, stalls, seek response, dropped frames and transferred bytes. Record CPU, GPU,
memory and battery where the platform exposes comparable measurements. Use Aethvyr's
diagnostics JSON for its playback timings and browser tooling for native playback and resource
measurements. Publish medians, the test conditions, and regressions alongside improvements.
