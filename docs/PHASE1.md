# Aethvyr visual identity and upgrade report

26 November 2026 · Windows desktop · extension version 2.10.0

The foundation audit identified existing Aethvyr display names alongside unfinished artwork and legacy-facing copy. This pass finishes the identity on the working branch, which already contains playback, library and Whisper work. The build uses the branch's existing version.

## Identity and surfaces

Use **Aethvyr** in ordinary text, titles, accessible names, tooltips and diagnostics. Use **A E T H V Y R** for the tracked display wordmark and **Experience the unseen.** for promotional copy. The angular A forms a prism around the point of vision. The circular orbit frames the full-size mark. The 16 px and 32 px versions omit the ring and enlarge the point.

| Use | Artwork or implementation |
| --- | --- |
| GitHub README on light and dark backgrounds | [Light mark](../assets/brand/icon-light.svg) and [dark primary mark](../assets/brand/icon.svg), selected by the README picture element |
| Single-color and promotional use | [Monochrome mark](../assets/brand/icon-mono.svg) using currentColor and [440 × 280 promotional artwork](../assets/brand/promo.svg) with the wordmark and tagline |
| Browser toolbar and extension pages | [PNG icons](../icons/) in idle and active states at 16, 32, 48 and 128 px. A dark tile identifies idle state and a filled cyan tile identifies active state. The popup, guide and library use the idle artwork. |
| On-page launch badge | Compact prism, cyan focus ring, solid dark surface and a spoken play action. The badge defines its colors inside its isolated shadow root. |
| Player and Studio | Aethvyr player title, media-session artist, Studio dialog title, tooltip and settings label. Diagnostic logs use the same prefix documented for contributors. |
| Distribution and support | Manifest and package descriptions, README, privacy and security policies, contribution guide, troubleshooting, changelog and store copy use Aethvyr. Support links retain the established repository URLs and the listing retains its existing add-on slug. |

The [feature guide capture](media/feature-guide.png), [player capture](media/playback-diagnostics.png) and [playback demo](media/playback-demo.webm) were refreshed from the final Chromium build.

## Palette and accessibility

The popup, library and player load [shared semantic tokens](../common/tokens.css). Backgrounds are midnight `#070B14`, secondary `#0C1424` and surface `#131E30`. The decorative border is `#25364A`. The table gives the lowest measured contrast across those three backgrounds.

| Role | Color | Minimum text contrast |
| --- | --- | ---: |
| Primary text | #EAF6FF | 15.23:1 |
| Secondary text | #91A4BA | 6.55:1 |
| Primary accent | #74D6EE | 10.03:1 |
| Secondary accent | #8B7CFF | 5.12:1 |
| Success | #42D3A2 | 8.81:1 |
| Warning | #F5BF65 | 9.97:1 |
| Error | #F87171 | 6.04:1 |

The automated contrast test requires 4.5:1 for these text pairs and the primary text on the darker selected-button fill. Transcript search highlights use dark lettering on the accent fill. Edge checked the guide's focused skip link in standard and high-contrast modes. These checks cover the specified palette and focus behavior. They do not certify every control against every video frame, custom theme or assistive technology.

## Storage and migration

This branding pass requires **zero migration writes**. New and returning users use the same stores, schemas, runtime identifiers and key prefixes. Installing the build a second time requires no special handling.

| Boundary | Retained identifiers |
| --- | --- |
| IndexedDB and shared API | `VelostreamDB`, `VelostreamDownloads`, `VelostreamLocal`, `VelostreamShared` |
| Local settings and viewing data | `fs_settings`, `fs_history`, `fs_library`, `fs_bm_*`, watch queue and stats, series/category and Whisper word keys |
| Sync and session state | `fs_sync_state`, `fs_sync_status`, `fs_sync_session`, `vs_meta` and the `vs_set_*`, `vs_hist_*`, `vs_lib_*`, `vs_bm_*` chunks. Tab and capture keys keep their existing names. |
| Runtime and page integration | `velostream-player`, `velostream-vault`, page/worker message tags, host and badge identifiers and the `velostream-t` resume fragment |
| Backups and installation | Backup payload discriminator `app: "velostream"`, existing schema version, and Gecko ID `velostream@srikarthickeyanganapathy.github.io`. Existing unpacked Chromium users should reload from the same directory. |

Old backup files import under their original filenames. New exports suggest an Aethvyr filename. Historical release names and example baseline ZIPs identify the earlier builds used for upgrade testing.

## Verification

| Check | Result |
| --- | --- |
| ESLint and Node regression suite | Passed. All 37 tests passed, including legacy backup import/re-export, sync merge, contrast, playback, downloads and library behavior. |
| Dual-target build and packaging | Both builds passed manifest resource validation. Both ZIPs passed CRC checks and file-content comparison with their unpacked targets. Each contained eight PNGs with the correct signatures and dimensions. All brand SVGs parsed successfully. |
| Edge 158.0.4370.33 | In-place upgrade from the Velostream 2.7.1 fixture retained a file handle, bookmark, collection, watch position and download bytes. Detection, overlay launch, play, seek, close, native-player restoration, session controls and private-session isolation passed. |
| Firefox 160.0 | In separate disposable profiles with sync off and on, the legacy fixture was seeded, upgraded to the candidate, then reinstalled under the original Gecko ID. Both runs passed their stored-data and private-history checks. |

Outputs are `dist/aethvyr-chrome-2.10.0.zip` and `dist/aethvyr-firefox-2.10.0.zip`. These are local packages. Android device testing, store-signed updates and live cross-device account sync remain release qualification items.
