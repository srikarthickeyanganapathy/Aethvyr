# Settings reference

All settings live in `storage.local` under the key **`fs_settings`** and are edited through the
popup and the player's Studio panel. `mergeSettings()` in `common/shared.js` merges what is stored
over the defaults below, so new keys always exist, and clamps every value to its range. Unknown
values fall back to the default.

Other storage keys:

| Key | Area | Contents |
|-----|------|----------|
| `fs_settings` | `storage.local` | Everything on this page |
| `fs_history` | `storage.local` | Per-video position history (newest 200) for *Continue watching* |
| `fs_bm_*` | `storage.local` | Bookmarks per video |
| `fs_library` | `storage.local` | Library: `{favorites: [historyKey], collections: [{id, name, keys, createdAt}]}` (max 500 favorites, 50 collections × 500 videos) |
| `fs_sync_state`, `fs_sync_status` | `storage.local` | Sync bookkeeping (device id, change times, tombstones) and the status line shown in the popup; not part of backups |
| `vs_meta`, `vs_set_*`, `vs_hist_*`, `vs_lib_*`, `vs_bm_*` | `storage.sync` | Only with sync on: chunked, compressed copies of synced settings, history, library and bookmarks (about 90 KB budget) |
| `tab_<id>` | `storage.session` | Detected streams, subtitles and DRM flags of a tab (survives service-worker restarts, cleared when the tab closes) |
| `VelostreamDB` | IndexedDB | Segment cache, cleared when a player session ends |

## Appearance and accessibility

| Setting | Default | Values |
|---------|---------|--------|
| `theme` | `blue` | Accent colour: `blue`, `green`, `indigo`, `amber`, `rose` |
| `uiScale` | `1` | `0.85`, `1`, `1.25`, `1.5` |
| `highContrast` | `false` | |
| `reducedMotion` | `system` | `system`, `on`, `off` |
| `simpleMode` | `false` | Hides advanced controls |
| `autoHideMs` | `3000` | Controls auto-hide delay; `0` never hides |
| `showStats` | `false` | *Stats for nerds* overlay |
| `ambientMode` | `false` | Ambient glow from the video behind the letterbox bars |
| `syncEnabled` | `false` | Opt-in sync through the browser account. Not synced: `syncEnabled`, `settingsVersion`, `uiScale`, `maxWorkers`, `cacheSizeMB`, `maxBufferSec`, `mseBufferAhead`, `mseBufferBehind`, `rebufferingGoal`, `rangeAccel`, `dvrMinutes`, `maxRenderRes`, `shader`, `shaderStrength`, `qualityCap`, `memory.volume`, `memory.muted`, `memory.qualityHeight` (device-specific) |
| `quickLaunchBadge` | `true` | On-page *Play in Velostream* pill |

## Playback

| Setting | Default | Values |
|---------|---------|--------|
| `defaultSpeed` | `1` | Speed for the next video (the last chosen speed is saved here) |
| `qualityCap` | `0` | Maximum height in pixels; `0` = unlimited |
| `seekStep` | `10` | Seconds for arrows and double-tap |
| `autoFullscreen` | `false` | Enter full screen on the first tap/key in the player |
| `longPressRate` | `2` | Long-press speed: `1.5`, `2`, `3`, `4` |
| `autoResume` | `always` | `always`, `ask`, `off` |
| `skipSeconds` | `85` | *Skip intro* length: `30`, `60`, `85`, `90` |
| `smartSkip` | `false` | Fast-forward through black and silent stretches |
| `autoSites` | `[]` | Hostnames where detected video opens automatically (max 500) |
| `memory` | see below | The last-used player state, restored for every video |

`memory`: `volume` (0–1, default 1), `muted` (false), `subsOn` (false), `subLang` (''),
`audioLang` (''), `qualityHeight` (0 = Auto).

## Engine (pre-buffer)

| Setting | Default | Range | Meaning |
|---------|---------|-------|---------|
| `maxBufferSec` | `86400` | 10–86400 | Seconds to download ahead; 86400 = the whole video |
| `cacheSizeMB` | `2048` | 32–8192 | IndexedDB budget per tab |
| `maxWorkers` | `6` | 2–8 | Parallel segment downloads |
| `rangeAccel` | `true` | | Split large downloads into parallel range requests |
| `dvrMinutes` | `30` | 0–180 | Live rewind window; `0` disables the DVR |

## Player buffer (Shaka MSE, in RAM)

| Setting | Default | Range |
|---------|---------|-------|
| `mseBufferAhead` | `45` | 15–300 s |
| `mseBufferBehind` | `30` | 10–300 s |
| `rebufferingGoal` | `0.5` | 0.5–5 s of media needed to start or resume |

## GPU enhancement and export

| Setting | Default | Values |
|---------|---------|--------|
| `shader` | `off` | `off`, `cas`, `fsr`, `anime4k`, `deband` |
| `shaderStrength` | `50` | 0–100 |
| `maxRenderRes` | `2160` | Cap for the canvas height in pixels |
| `exportFormat` | `mp4` | `mp4` (remux into one file) or `original` |

## Mouse and gestures

| Setting | Default | Values |
|---------|---------|--------|
| `mouse.wheel` | `volume` | `volume`, `seek`, `speed`, `zoom`, `none` |
| `mouse.middleClick` | `playPause` | `playPause`, `fullscreen`, `pip`, `mute`, `resetZoom`, `none` |
| `gestures.enabled` | `true` | Master switch for touch gestures |
| `gestures.allowMouseDrag` | `false` | Mouse drags act as swipes |
| `gestures.doubleTapSeek` | `true` | Allow seek actions on double-tap |
| `gestures.doubleTapZoneWidth` | `0.35` | 0.20–0.45 of the width for each side zone |
| `gestures.doubleTapLeft` / `Center` / `Right` | `seekBack` / `playPause` / `seekFwd` | `seekBack`, `seekFwd`, `playPause`, `fullscreen`, `pip`, `none` |
| `gestures.longPressSpeed`, `brightnessSwipe`, `volumeSwipe`, `scrubSwipe`, `pinchZoom` | `true` | |

## Subtitles

| Setting | Default | Values |
|---------|---------|--------|
| `subtitles.font` | `system` | `system`, `serif`, `mono`, `dyslexic`, `hyperlegible` |
| `subtitles.size` | `100` | Percent |
| `subtitles.color` | `#ffffff` | |
| `subtitles.bgOpacity` | `75` | Percent |
| `subtitles.edge` | `shadow` | `none`, `shadow`, `outline` |
| `subtitles.position` | `8` | Percent from the bottom |
| `subtitles.pauseOnHover` | `false` | |
| `subtitles.clickToCopy` | `true` | |

## Audio

| Setting | Default | Values |
|---------|---------|--------|
| `audio.boost` | `100` | 100–300 % |
| `audio.preset` | `normal` | `normal`, `voice`, `bass`, `night`, `custom` |
| `audio.eq` | `[0,0,0,0,0]` | dB at 60 Hz, 230 Hz, 910 Hz, 3.6 kHz, 14 kHz |
| `audio.delayMs` | `0` | 0–1000 |
| `audio.preservesPitch` | `true` | |
| `audio.channels` | `stereo` | `stereo`, `mono`, `left`, `right` |
| `audio.loudnessNorm` | `false` | Smart loudness: auto-gain toward -20 dBFS RMS (±12 dB, gated below -45 dBFS) plus a peak limiter |
| `audio.width` | `100` | 0–200 % stereo width (mid/side scaling; 0 = mono) |
| `audio.dialogue` | `0` | 0–100: centre-channel 2 kHz band boost, up to about +9 dB |
| `audio.crossfeed` | `false` | Headphone crossfeed (0.3 ms delay, 700 Hz low-pass, -9 dB into the other side) |

## Color Studio and device

| Setting | Default | Values |
|---------|---------|--------|
| `color.preset` | `neutral` | `neutral`, `anime`, `cinema`, `natural`, `night`, `custom` |
| `color.gamma` | `100` | 50–200 (%, 100 = neutral) |
| `color.vibrance`, `color.temperature`, `color.tint`, `color.shadows`, `color.highlights` | `0` | −100…100 |
| `hwTier` | `''` | `low`, `standard`, `high` once detected on first run (not synced between devices) |

## Profiles, presets and keys

- `siteProfiles`: up to 200 entries `{host, defaultSpeed, qualityCap, shader, shaderStrength,
  audioPreset, subSize, savedAt}`. A matching profile overrides those settings on its site.
- `filterPresets`: saved colour-filter presets.
- `keymap`: action → key. Defaults: `playPause` Space, `playPauseAlt` k, `seekBack` ←,
  `seekBackAlt` j, `seekFwd` →, `seekFwdAlt` l, `volUp` ↑, `volDown` ↓, `mute` m, `fullscreen` f,
  `pip` p, `captions` c, `speedDown` <, `speedUp` >, `loopA` [, `loopB` ], `screenshot` s,
  `frameBack` `,`, `frameFwd` `.`, `help` ?, `transcript` t.

## Migrations

`settingsVersion` is currently **3**.

| From | To | Change |
|------|----|--------|
| none / 1 | 2 | Older builds pre-buffered 90 s in 300 MB and asked before resuming. Existing installs are moved to whole-video pre-buffer (`maxBufferSec` 86400), at least 2048 MB cache and `autoResume: always`. |
| 2 | 3 | Adds the buffer, GPU, export, mouse, gesture-zone, site-profile, subtitle-interaction and audio-routing keys. Defaults fill them in; nothing is rewritten. |

Legacy theme names (`emerald`, `amethyst`, `crimson`, `hc-yellow`, `amoled`, `glass`) are mapped
to accents.

To add a setting: add it to `DEFAULT_SETTINGS`, clamp or validate it in `mergeSettings()`, and
bump `settingsVersion` only when stored values must be rewritten.
