# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Feature updates raise the minor version (2.1, 2.2, ...),
bug-fix-only updates the patch version.

## [2.2.0] - 2026-11-16

### Added

- **Real Anime4K**: the Anime4K v4.0.1 neural networks (MIT, bloc97) run on the GPU. *Anime4K
  (fast)* uses Restore S + Upscale ×2 S, *Anime4K HQ* Restore M + Upscale ×2 M. Falls back to the
  previous Anime4K-lite shader on GPUs without half-float render targets.
- **De-block + sharpen** and **Denoise** (edge-preserving, optional grain) GPU presets.
- **Color Studio**: GPU colour grading with looks (Neutral, Anime, Cinema, Natural, Night) and
  gamma, vibrance, temperature, tint, shadows and highlights; works with or without an enhancement
  preset.
- **Spatial audio**: stereo width (0–200 %), dialogue boost for the centre of the mix, and
  headphone crossfeed.
- **Hardware-aware defaults**: low / standard / high device tier detected on first run, tuning
  buffers, cache, parallel downloads and the GPU render cap (only settings not changed by the
  user); *Re-detect and re-tune* in Prefs. The tier is not synced between devices.

### Changed

- GPU thermal guard steps down Anime4K HQ → Anime4K → Fast Sharpen → Off; new presets step to Off;
  colour grading is never stepped down.

## [2.1.0] - 2026-11-16

### Added

- **Transcript & search** (T): side panel with every subtitle line, live highlight that follows the
  speech, search with highlighted matches, click-to-seek, copy and `.srt` export.
- **Smart loudness normalization** (Audio tab) and an **audio-only visualizer**.
- **Opt-in sync across devices** through the browser account's `storage.sync` (no server):
  settings (minus device-specific ones), recent watch positions, bookmarks and the library, with
  *Sync now* and *Delete synced data*. Privacy policy updated.
- **Stream switcher**: other streams detected on the page, switchable inside the same player
  (Studio → Quality), with the switch surviving a background-worker restart.
- **Video library** page (popup → Continue watching → Open library): continue watching, recent,
  favorites, collections, bookmarked videos, search and sort. Backups include favorites and
  collections.
- **A–B clip export**: save just the looped range of an HLS video as an `.mp4`.
- **Chapter-aware skip**: *Skip Intro / Recap / Credits / Preview* jumps to the end of matching
  chapters; the +N s skip remains the fallback.
- **Snapshot with subtitles & effects** (Shift+S): GPU enhancement, colour filters and the visible
  subtitle lines burned into the PNG.
- **Ambient glow** behind the video (Display tab and popup).
- **Diagnostics** in Stats for nerds: video/audio codec names, hardware-decoding check, dropped-frame
  percentage, GPU enhancement cost and active effects.
- **Backup & restore**: settings, site profiles, presets, shortcuts, bookmarks and history as one
  validated `.json` file (player Prefs and popup).

### Fixed

- Turning on audio-only mode paused playback, and on single-quality streams stalled it at 0:00
  (the buffer was flushed for a switch to the track already playing).
- Player no longer reloads when switching to the mini player, fill or page mode: the frame stays in
  one place in the DOM and follows the video with fixed positioning and scroll-container clipping.
  It is also placed correctly on pages that use zoom, scaling or transforms, and a site element in
  full screen no longer hides it.
- Detection: relative URLs in `blob:`/`data:` workers, `setAttribute('src')` and `<source src>`,
  late in-memory subtitle tracks. Wrapped workers no longer break on strict-CSP sites, and
  streaming responses are no longer copied in full.
- Engine: tab state, subtitles and the session's playlists survive service-worker restarts; per-site
  Referer/Origin rules on shared CDNs; per-playlist sequence numbers for live recordings with separate
  audio; CORS for direct files, so audio effects, GPU enhancement and snapshots work on MP4/WebM.
  Sessions no longer leak when the player closes while connecting; reloads after an idle restart
  reset the tab; recordings without live rewind are refused instead of being cut short; direct
  fetches time out.
- Downloader: encrypted (AES-128) segments are never sniffed or trimmed; stricter TS/MP4 detection;
  BOM-prefixed WebVTT/playlists; per-connection throughput reported to ABR from the range
  accelerator; transient errors no longer disable range requests; live timeline offset learned.
  Failed prefetches no longer retry in a tight loop; live rewind keeps capturing after a long pause;
  AES-128 IVs are correct for sequence numbers above 2^32.
- Cache: concurrent stores no longer over-evict or overshoot the cap; per-stream accounting.
- MP4 export: video and audio fragments interleaved by time; `trun.data_offset` fixed when boxes
  between `moof` and `mdat` are dropped; multi-track fragments, size-0 boxes, missing `trex`.
- Player: save picker for live-recording stop and only with user activation; Continue Watching
  saves the page URL; site profiles no longer leak into global settings (profile-controlled edits
  are session-only); the unmuting tap no longer blocks the first gesture; middle-click *Reset zoom*;
  `.ass` in the subtitle picker; numeric HTML entities; captions toggle restores the last source;
  GPU resources freed, the canvas recreated, and enhancement recovers after a GPU context loss.
- Popup/settings: identical option lists in popup and player, legacy cache sizes mapped, stale
  stream and history rows, settings save races.
- DNR rule exposes range headers for extension-less and disguised segments.

### Changed

- Firefox minimum version **128** (desktop and Android), with the `data_collection_permissions`
  key declared as `none` (Firefox 140+ / Android 142+ read it; older versions ignore it).

## [2.0.0] - 2026-11-15

First public release as **Velostream** (previously developed as *FastStream Mobile*). Uploaded to
Firefox Add-ons (unlisted).

### Added

- **Player as an extension page** mounted exactly over the site's video (or full-page), with the
  glass UI, Dynamic Island HUD, Studio panel, mini player, lock, audio-only mode and sleep timer.
- **Background pre-buffer engine**: whole-video prefetch with 2–8 adaptive workers, a byte-range
  accelerator, an IndexedDB cache read zero-copy by the player, its own ABR, and a live DVR.
- **Detection** in Web Workers (including `blob:` workers), broader manifest and MIME matching,
  capture-phase media events, and DRM / proprietary-player detection with explanations.
- **Subtitles captured from sites** (network, `<track>`, in-memory text tracks) with
  auto-selection, dual subtitles, sync to the next spoken line, subtitle speed, pause on hover,
  click to copy, and ASS support.
- **GPU enhancement** (WebGL2): Fast Sharpen (CAS), FSR-style upscale, Anime4K-lite and deband,
  with a thermal guard.
- **Downloads as one MP4**: TS → fragmented MP4 remux with audio merged, or the original format.
  Save dialog through the downloads API; live recording and DVR save.
- **Controls**: configurable double-tap zones and actions, mouse drag, wheel and middle-click
  actions, Ctrl/Shift/Alt wheel modifiers, per-site profiles, channel routing (mono/left/right),
  pitch-preserving speed, chapters and timeline thumbnails.
- **External handoff** to PotPlayer, VLC, mpv, IINA and Android apps, plus copyable `yt-dlp` and
  `ffmpeg` commands with the right headers.
- Muted-autoplay fallback with one-tap unmute; buffer controls with *Purge & rebuild buffer*.
- Settings schema v3 with automatic migration.

### Fixed

- FSR and Anime4K presets drew the picture upside down (it looked rotated and mirrored). The GPU
  canvas no longer flashes black on start and no longer tears.
- Playback failed with Shaka error **1002** after the browser restarted the extension's
  background worker. In-flight requests are now kept and resent after reconnecting.
- A failed parallel range download no longer fails the whole segment.
- Transient network errors reload silently from the current position before an error is shown.
  Error messages name the server and the reason.
- Expired signed links (HTTP 401/403/410) switch to a newer link requested by the page.
- Full screen is only requested during a real user gesture: no more "can only be initiated by a
  user gesture" failure, and no wrong fallback to filling the window.
- Removed the redundant `allowfullscreen` attribute from the player frame (console warning).
- All UI markup is inserted through a sanitizing helper (`setHTML`) instead of `innerHTML`.
  Subtitle text and titles coming from sites can no longer inject markup or scripts, and AMO
  linter warnings are cleared.

### Changed

- New icon: a forward-leaning V with a red dot. A heavier variant is used at 16/32 px, and the
  tile turns red when a video is found.
- Firefox manifest declares `data_collection_permissions: none`.
