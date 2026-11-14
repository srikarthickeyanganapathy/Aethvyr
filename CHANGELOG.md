# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.0.0] - Unreleased

First public release as **Velostream** (previously developed as *FastStream Mobile*).

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

- Firefox minimum versions: **140** on desktop and **142** on Android, the first versions that
  support the required `data_collection_permissions` manifest key (declared as `none`).
- New icon: a forward-leaning V with a red dot. A heavier variant is used at 16/32 px, and the
  tile turns red when a video is found.
