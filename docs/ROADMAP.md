# Velostream roadmap

| Stage | Focus |
| --- | --- |
| Shipped in 2.7 | Safer account sync, adaptive prefetch profiles, private diagnostics, and CI that builds both packages. |
| Stability and performance | Automate browser playback, worker restart and real MP4 export tests. Measure startup, seeks and resource use on Chromium desktop, Firefox desktop, and supported Android builds. Continue extracting well-bounded player and engine modules. |
| Library and playback | Improve episode identity and navigation, watch queues, download management, and reversible cinema mode. Validate episode matches before enabling automatic transitions. |
| Experiments | Evaluate local transcription, subtitle translation and language learning, enhancement-only playback, HDR and frame interpolation behind opt-in controls. |

## Benchmark protocol

Compare the site's native player with Velostream using the same browser version, device, media,
resolution, and network conditions. Record the Velostream version and profile. Run cold-cache and
warm-cache tests separately and repeat each case at least five times.

Measure startup, stalls, seek response, dropped frames and transferred bytes. Record CPU, GPU,
memory and battery where the platform exposes comparable measurements. Use Velostream's
diagnostics JSON for its playback timings and browser tooling for native playback and resource
measurements. Publish medians, the test conditions, and regressions alongside improvements.
