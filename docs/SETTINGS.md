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
| `fileThumbnails` | `true` | Seek-bar previews generated from direct video files |
| `pipSubtitles` | `true` | Picture-in-Picture shows the subtitles (drawn into the PiP picture) |
| `look.skin` | `glass` | `glass`, `cinema`, `theater`, `pill`, `compact` |
| `look.density` | `standard` | `minimal`, `standard`, `pro` (adds frame step, A–B loop, snapshot, EQ and GPU buttons) |
| `look.scrubber` | `classic` | `classic`, `chapters`, `heatmap` |
| `look.scrubHeight` | `6` | Seek bar thickness, 4–10 px |
| `look.scrim` | `-1` | Control background darkness 0–95 %; `-1` uses the skin's own |
| `look.hidden` | `[]` | Hidden buttons: `back`, `fwd`, `volume`, `speed`, `cc`, `pip`, `fs`, `lock`, `info`, `dl`, `audioOnly`, `mini`, `frameBack`, `frameFwd`, `loop`, `snapshot`, `eq`, `gpu` (unknown ids are dropped) |
| `look.order` | `[]` | Order of the right-hand buttons (`speed`, `cc`, `studio`, `pip`, `fs`); missing ids follow in the default order |
| `look.pillX`, `look.pillY` | `0.5`, `0.85` | Floating-pill centre as a fraction of the player (0–1); clamped on screen |
| `syncEnabled` | `false` | Opt-in sync through the browser account. Not synced: `syncEnabled`, `settingsVersion`, `uiScale`, `maxWorkers`, `resourceProfile`, `prefetchMbps`, `cacheSizeMB`, `pausedBufferMB`, `maxBufferSec`, `mseBufferAhead`, `mseBufferBehind`, `rebufferingGoal`, `rangeAccel`, `dvrMinutes`, `maxRenderRes`, `shader`, `shaderStrength`, `qualityCap`, `memory.volume`, `memory.muted`, `memory.qualityHeight` (device-specific) |
| `quickLaunchBadge` | `true` | On-page *Play in Aethvyr* pill |

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
| `resourceProfile` | `balanced` | eco / balanced / max / custom | Background prefetch ceilings of 60 s / 2 workers, 180 s / 4 workers, and 900 s / 8 workers. Custom uses the limits below. All profiles share an eight-request background budget. |
| `maxBufferSec` | `86400` | 10–86400 | User ceiling. Custom allows prefetch up to the whole video, subject to cache and scheduling limits. |
| `prefetchMbps` | `0` | 0–1000 | Custom profile average speculative bandwidth in Mbit/s, divided among active sessions. Zero disables pacing. Playback requests can use the full connection. |
| `pausedBufferMB` | `256` | 0–8192 | Disk prefetch budget while paused. Zero disables speculative prefetch while paused. |
| `cacheSizeMB` | `2048` | 32–8192 | Shared session cache ceiling. Eco also caps the total at 128 MiB and Balanced at 512 MiB. Sessions split the available budget equally. |
| `maxWorkers` | `6` | 2–8 | Parallel segment downloads |
| `rangeAccel` | `true` | | Split eligible on-demand segment requests into parallel ranges |
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
| Audio preset | Flat (stored as normal) | Flat, Cinema, Voice, Night, Music, Bass or Custom |
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

Lecture acceleration is session-only. Studio retains the silence threshold (default -48 dBFS), minimum silence (1500 ms) and speech padding (250 ms).
