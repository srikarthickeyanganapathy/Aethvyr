# Phase 6 playback research

Completed on 26 November 2026 using real headless Edge 158 and Firefox 160 on Windows. The standalone loopback research page is excluded from extension packages. Production remains at 2.10.0.

| Experiment | Measurement | Decision |
|---|---|---|
| WebGPU frame transfer | Edge copied a decoded 64 × 48 frame into a GPU texture and read back nonblank pixel data. Five round trips took 3.2, 66.1, 3.4, 3.0 and 3.0 ms. Firefox returned no adapter in this profile. | Retain the current renderer. One small-frame transfer exceeded a 60 Hz frame budget. Screen rendering without readback needs a separate measurement before choosing a backend. |
| Video restoration | On 320 × 180 synthetic frames, a spatial median filter reduced impulse-noise error from 9.877 to 0.644 but damaged clean thin strokes (41.765 error). On a moving texture, three-frame motion-compensated median filtering reduced error from 10.304 to 1.119, compared with 10.077 for the spatial filter. A clean one-frame flash incurred 71.004 error. | Keep temporal restoration experimental. Correct handling of scene changes and preservation of fine detail are prerequisites for a player setting. Neural restoration was not benchmarked. |
| HDR tone mapping | Both browsers mapped all 1,024 PQ grayscale codes monotonically onto 255 distinct 8-bit SDR values. Approximately 990 nits mapped to 244 and 10,000 nits to 254. Neither browser reported an HDR display. | Keep native color handling. The numeric curve shows highlight compression. Visual quality, wide-gamut color and actual HDR output require calibrated display and media tests. |
| Motion interpolation | A global translation estimate reconstructed a known midpoint exactly on a single pan. Opposing motion produced 41.36 error, versus 71.846 for blending and 82.825 for holding the previous frame. | Keep interpolation experimental. A single displacement cannot represent multiple moving subjects. The test used known synthetic middle frames and did not establish perceived quality or sustained real-time performance. |
| Local media | Both browsers decoded a 31,064-byte MP4 from a File object URL. All five seeks reached the requested time within 100 ms of media position. Median seek-event latency was 1 ms in Edge and 7 ms in Firefox. | Keep browser-native local decoding. The fixture does not qualify large files, unusual codecs, audio sync or frame-presentation latency. |
| Watch together | Two same-origin documents exchanged position and pause state over a random local BroadcastChannel. The receiving video paused, sought and acknowledged each target. Median command-to-ack time was 0.8 ms in Edge and 7 ms in Firefox. | Local coordination is feasible. Remote rooms remain outside the production player. This experiment covers neither remote identity and consent nor network drift and reconnects. |

Error denotes mean absolute difference from known reference pixels, on a 0–255 grayscale scale. CPU algorithms had one warm-up and five timed trials. Local seek and coordination timings use five targets. Browser clock precision, the small fixtures and headless execution limit timing comparisons. The HDR probe uses the PQ electro-optical transfer function followed by a simple luminance compression curve and SDR encoding. [ITU-R BT.2100](https://www.itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.2100-2-201807-S%21%21PDF-E.pdf)

## Installed-player regression check

In a separate Edge run with Aethvyr installed, native and overlay playback each recorded a 4 ms median warm seek and zero dropped frames across 100 counted frames. Cold-start medians were 109 ms native and 154 ms overlay. Warm starts were 109 ms native and 153 ms overlay. The overlay fetched 31,064 bytes per warm launch and the native player reused its cached media. Context loss and WebGL restoration passed, along with closing the overlay, restoring native playback and private export isolation.

## Reproduce

Run from the repository root with the local browser executable path. Each research command starts a temporary profile and a loopback server. Run browsers separately when comparing timings.

```powershell
node scripts/run-playback-research.mjs 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
node scripts/run-playback-research.mjs 'C:/Program Files/Mozilla Firefox/firefox.exe'
node scripts/chromium-foundation.mjs 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' dist/velostream-chrome-2.7.1.zip --benchmark
```

[Edge measurements](media/phase6-edge.json) · [Firefox measurements](media/phase6-firefox.json)
