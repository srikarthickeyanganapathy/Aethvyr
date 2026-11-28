# Phase 6 · Aethvyr Vision

## Production paths

Studio and the popup share the same eight preset IDs and labels. Existing CAS, Anime4K and deblock selections retain their storage IDs. Natural uses 35% of the selected CAS strength with a 1080-line ceiling. Fast Sharpen uses normal CAS strength. Compression Cleanup smooths block boundaries then sharpens. Animation and Animation HQ use the bundled Anime4K small and medium networks where supported, with the existing lite fallback. Custom Color Studio uses the saved grade. Auto suppresses preset processing in Eco or on detected software rendering, then selects the device/source budget. Off leaves independent picture settings available.

The former FSR-labelled spatial upscale added a resampling pass and migrated to CAS. Bilateral denoise and debanding migrated to Off. Their smoothing can also suppress intentional grain and fine detail. These are reasons to keep them retired; the repository does not establish the original removal decision for each effect.

The frame guard uses GPU timer queries when available, otherwise CPU submission timing plus decoder drop counts. Two consecutive overloaded measurement windows reduce resolution above 1080 lines before simplifying the shader. At the last step the original video can take over even for colour-only work. Saved preferences survive session fallback. Context loss hides the canvas and restoration rebuilds its resources. Encrypted-media events stop the pipeline and attached media keys prevent setup. The renderer has no temperature input.

## Fixture results

Headless Edge 158 on Windows, bundled local video, one paused decoded frame, four synchronized CAS draws per sample. Elapsed wall time includes a one-pixel readback per draw. The output allocation column measures RGBA readback bytes. Driver memory and total VRAM consumption were unavailable.

| Target height | CAS strength | Mean ms/draw | Output bytes | Mean absolute red-channel difference from browser-scaled original (0–255) |
|---|---:|---:|---:|---:|
| 720 | 15 | 1.75 | 2,764,800 | 0.64 |
| 720 | 75 | 0.55 | 2,764,800 | 4.65 |
| 2160 | 15 | 3.95 | 24,883,200 | 0.66 |
| 2160 | 75 | 2.73 | 24,883,200 | 4.68 |

The sampled differences demonstrate strength-dependent processing. Four draws on a still frame cannot establish relative preset speed or perceptual quality. A separate playback/seek check reported 0 dropped frames out of 105 and five waiting events during five seeks. Simulated WebGL context loss and restoration passed. Automated device-budget tests cover low, mobile, standard and high tiers. Sustained physical low-end playback, native 4K decoding, HDR displays and Firefox GPU execution still need hardware coverage.

Reproduce with the Chromium foundation fixture and the flag `--vision` after building. See [isolated playback research](PHASE6.md) for WebGPU transfer, HDR curves, restoration and interpolation. Advanced super-resolution beyond the existing animation networks and new neural models remain research candidates pending motion-sequence quality, model licensing, memory and sustained frame-budget measurements. No experimental backend is enabled.
