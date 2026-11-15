# User guide

This guide covers everything you can do in Velostream. For settings stored behind the UI see
[SETTINGS.md](SETTINGS.md); for errors see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

- [Opening a video](#opening-a-video)
- [The player](#the-player)
- [Gestures and mouse](#gestures-and-mouse)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Studio](#studio)
- [Subtitles and audio tracks](#subtitles-and-audio-tracks)
- [GPU enhancement](#gpu-enhancement)
- [Downloads, recording and snapshots](#downloads-recording-and-snapshots)
- [External players and command-line tools](#external-players-and-command-line-tools)
- [The popup](#the-popup)
- [Accessibility](#accessibility)

---

## Opening a video

Velostream watches the page for video streams: HLS playlists (`.m3u8`), DASH manifests (`.mpd`)
and direct media files. It finds them in network requests, in `fetch`/XHR calls, in Web Workers,
in `<video>` elements and through Media Source Extensions, in the page and in embedded frames.

There are four ways to open a detected stream:

| Way | How |
|-----|-----|
| **On-page pill** | A **Play in Velostream** pill appears over detected videos. Click it. (Turn it off in the popup with *On-page Play button*.) |
| **Popup** | Click the toolbar icon and pick a stream from **Detected streams**. The best candidate (master playlist, highest quality, not an ad) is listed first. |
| **Always play in Velostream** | Turn this on for a site in the popup. The first real stream on each page load then opens automatically. |
| **Play any stream link** | Paste an `.m3u8`, `.mpd` or media URL into the popup. |

If nothing is detected, start the video in the site's own player once, then press **Rescan** in
the popup. Streams protected by DRM are listed with an explanation; they cannot be played (see
[Troubleshooting](TROUBLESHOOTING.md#drm-protected-video)).

The player is mounted **exactly over the site's video**, so the page layout does not change. The
site's own player is paused and muted while Velostream plays and is restored when you close it.

### Autoplay

Browsers only allow sound after you have interacted with a page. If playback with sound is
refused, Velostream starts **muted** and shows *Autoplaying muted · Tap or press any key to
unmute*. Your first tap or key press restores your volume; that tap does not pause the video.

### Continue watching

Velostream remembers where you stopped in each video and resumes there (*Prefs → Playback →
Resume*: always, ask, or off). The popup lists recent videos under **Continue watching**.

---

## The player

The top bar shows the title, the quality chip and buttons for mini player, Picture-in-Picture,
lock, and close. The control deck at the bottom has play/pause, ±10 s, the timeline, volume,
speed, subtitles, **Studio**, download and full screen.

| Feature | Notes |
|---------|-------|
| **Timeline** | Hover or drag for a time tooltip with **thumbnail previews** (when the stream provides image tracks) and the **chapter** title. Chapter marks, bookmarks and A-B loop points are drawn on the bar. |
| **Dynamic island** | The pill at the top briefly shows what changed: volume, speed, seek target, quality switch, buffering, errors. |
| **Speed** | 0.25×–4×. The chosen speed becomes the default for the next video. Pitch is kept natural unless you turn *Keep voice pitch when speeding up* off. |
| **Mini player** | Docks the video in a corner of the page so you can keep browsing. Drag to move, drag the corner to resize. |
| **Lock** | Blocks touches (for pockets and kids). Tap the unlock pill to release. |
| **Audio-only** | Drops to the lowest-bitrate stream and stops video rendering to save battery and data. |
| **Sleep timer** | Stops after a time or at the end of the video, fading the volume out. |
| **Skip intro / recap / credits** | When the stream has chapters, the pill reads **Skip Intro**, **Skip Recap**, **Skip Credits** or **Skip Preview** inside a chapter named like an opening (*Opening*, *Intro*, *OP*), recap, ending (*Ending*, *Credits*, *ED*) or preview that is 10 s – 4 min long, and jumps to that chapter's end. Otherwise it offers +30/60/85/90 s near the start. *Smart skip* fast-forwards through black, silent stretches. |
| **Ambient glow** | Studio → Display (or the popup): a soft glow in the video's colours fills the letterbox bars. Updates about 4 times a second, only while playing. |
| **Live streams** | A **Live** button jumps to the edge. The DVR keeps the last 30 minutes (configurable) so you can pause and rewind even when the site does not offer it. |

---

## Gestures and mouse

All gestures can be turned on or off in **Studio → Prefs → Gestures**.

| Gesture | Action |
|---------|--------|
| **Tap** | Show or hide the controls (touch). A mouse click plays/pauses. |
| **Double-tap / double-click** | Depends on the zone. Defaults: **left** = back 10 s, **centre** = play/pause, **right** = forward 10 s. Each zone can be set to seek back, seek forward, play/pause, full screen, Picture-in-Picture or nothing. Zone width: 25 %, 35 % or 45 %. |
| **Long-press** | Plays at 2× (configurable to 1.5×, 3× or 4×) while held. |
| **Swipe up/down, left side** | Brightness. |
| **Swipe up/down, right side** | Volume, with boost up to 300 %. |
| **Swipe across** | Scrub with a time preview. |
| **Pinch** | Zoom up to 400 %; drag to pan while zoomed. |

Swipe gestures are touch-only by default. Turn on **Mouse drag uses swipe gestures** to use them
with a mouse; panning a zoomed video with the mouse always works.

**Mouse** (Studio → Prefs → Mouse):

| Input | Action |
|-------|--------|
| Wheel | Volume (default), seek, speed, zoom, or nothing |
| <kbd>Ctrl</kbd> + wheel | Zoom |
| <kbd>Shift</kbd> + wheel | Fine seek; steps frame by frame while paused |
| <kbd>Alt</kbd> + wheel | Shift subtitle timing |
| Middle click | Play/pause (default), full screen, Picture-in-Picture, mute, reset zoom, or nothing |

---

## Keyboard shortcuts

Press <kbd>?</kbd> in the player for this list. Every key can be remapped in **Studio → Prefs →
Keyboard**.

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| <kbd>Space</kbd> / <kbd>K</kbd> | Play / pause | <kbd>F</kbd> | Full screen |
| <kbd>←</kbd> / <kbd>J</kbd> | Back 10 s | <kbd>P</kbd> | Picture-in-Picture |
| <kbd>→</kbd> / <kbd>L</kbd> | Forward 10 s | <kbd>C</kbd> | Subtitles on/off |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Volume ±5 % | <kbd>M</kbd> | Mute |
| <kbd><</kbd> / <kbd>></kbd> | Slower / faster | <kbd>S</kbd> / <kbd>Shift</kbd>+<kbd>S</kbd> | Snapshot / with subtitles & effects |
| <kbd>,</kbd> / <kbd>.</kbd> | Previous / next frame | <kbd>[</kbd> / <kbd>]</kbd> | Set loop A / B |
| <kbd>?</kbd> | Shortcuts & gestures | <kbd>Esc</kbd> | Close menu, then the player |

Keys pressed inside the player never reach the site's own shortcut handlers.

---

## Studio

Studio is the settings panel inside the player (sliders button). It has five tabs.

### Quality

- **Quality**: Auto (Velostream's own adaptive bitrate) or a fixed resolution, and a quality cap
  (for example *never above 720p* on mobile data).
- **Buffer & network**:
  - *Pre-buffer window*: how far ahead to download in the background, up to the whole video.
  - *Player RAM buffer ahead / behind*: Shaka's MSE buffer. Lower it on low-memory phones.
  - *Parallel downloads*: 2–8 workers.
  - *Cache size*: the IndexedDB budget per tab.
  - *Range accelerator*: splits large files into parallel range requests.
  - *Pause background download*: stops pre-buffering to save data.
  - **Purge & rebuild buffer**: drops the cache and refills it from the current position.

### Audio

- **Equalizer** presets (Normal, Voice, Bass, Night) or a custom 5-band EQ, and **boost** up to
  300 %.
- **Audio delay (lip sync)**: 0–1000 ms.
- **Output**: stereo, mono downmix, left only or right only, and *Keep voice pitch when speeding up*.

### Display

- **GPU enhancement**: preset, strength and maximum render resolution (see below).
- **Ambient glow** behind the video.
- Colour: brightness, contrast, saturation, hue, warmth and sharpness, with saveable presets.
- **Aspect ratio**: fit, fill, cover, 16:9, 4:3 or 21:9. Zoom, **Rotate 90°**, **Mirror** and
  *Reset transform*.

### Tools

- **A–B loop & bookmarks**.
- **Capture**: PNG snapshot, snapshot with subtitles & effects, or a burst of 6 frames as a
  contact sheet.
- **Download** (on-demand video) or **Record & DVR** (live), and the **Save format** (MP4 or
  original). With both loop points set on an HLS video, **Save A–B clip** saves just that range.
- **Sleep timer** and **Skip** settings.
- **Open in external player**, and copy commands.

### Prefs

- **Modes**: simple mode, high contrast, reduced motion, stats for nerds (resolution, frame rate,
  dropped frames, video and audio codec, whether decoding is smooth and hardware-backed, GPU
  enhancement cost, active effects, network and buffer).
- **Accent** colour and **Interface size** (85–150 %).
- **Playback** defaults: speed, seek step, resume, auto full screen, controls auto-hide.
- **Gestures**, **Mouse**, **Keyboard** (see above).
- **Site profile**: remember speed, quality cap, GPU preset and strength, EQ preset and subtitle
  size for the current site only. While a profile is active, changing those settings affects only
  the current session; use *Update profile with current setup* to keep them for the site.
- **Backup & restore**: export everything (settings, site profiles, colour presets, shortcuts,
  auto-play sites, bookmarks and watch history) to one `.json` file, and import it on another
  browser or device. Also in the popup under Settings; in the popup, Import opens in a tab
  because a toolbar popup closes when a file picker opens.

---

## Subtitles and audio tracks

Open the **CC** button (*Subtitles & Audio*).

- **Captured subtitles.** Velostream collects the site's subtitles automatically: files the page
  downloads (`.vtt`, `.srt`, `.ass`), `<track>` elements, and text tracks the site player builds
  in memory. They are listed with the site's label (for example *English · Site*). The site's
  default track is selected automatically.
- **Load a file**: SRT, VTT or ASS/SSA from your device.
- **Secondary subtitles (top)**: show a second language at the top of the picture at the same
  time.
- **Sync offset**: shift timing in 0.1 s steps, or **Sync next line to now**: press it when you
  hear the next line spoken and Velostream aligns the subtitles.
- **Speed**: stretch the subtitle timeline for files made for a different frame rate.
- **Pause on hover** and **click to copy** a line, useful for language learning.
- **Subtitle style**: font (including dyslexia-friendly and Atkinson Hyperlegible), size, colour,
  background opacity, edge style and position.
- **Audio track**: pick the language or commentary track; your choice is remembered.

---

## GPU enhancement

Studio → Display → **GPU enhancement** processes every frame with WebGL2 shaders on a canvas laid
exactly over the video.

| Preset | What it does | Best for |
|--------|--------------|----------|
| **Off** | Native browser rendering | Battery |
| **Fast Sharpen** (CAS) | Contrast-adaptive sharpening in one pass | Soft or low-bitrate video |
| **FSR upscale** | Lanczos-2 upscale with anti-ringing, then RCAS sharpening | Low resolution shown on a big screen |
| **Anime4K-lite** | Lanczos-2 upscale, then pushes line art toward clean edges | Animation |
| **Deband** | Smooths colour banding in flat areas, with dithering | Gradients, skies, dark scenes |

- **Strength** scales the effect. **Max render resolution** caps the canvas size; lower it on
  weak GPUs.
- FSR and Anime4K only upscale when the video is shown **larger than its source**. Otherwise they
  run a single sharpening pass, because there is nothing to upscale.
- The **thermal guard** watches frame time and dropped frames. If the GPU cannot keep up for about
  6 s, it steps down (FSR/Anime4K → Fast Sharpen → Off) for this session only and tells you. Your
  saved choice is kept.
- When the sharpness slider is above 0 and no preset is chosen, Fast Sharpen is used
  automatically. Colour filters apply on top.
- GPU enhancement is unavailable when WebGL2 is missing, and for **direct files from another
  site served without CORS**: the browser does not let any page read those pixels. Streams (HLS
  and DASH) always work.

---

## Downloads, recording and snapshots

Press the **download** button or *Studio → Tools*.

| Source | Result |
|--------|--------|
| HLS on-demand (TS segments) | One **`.mp4`**: segments are remuxed to fragmented MP4 in the browser, and a separate audio rendition is merged in. No re-encoding, so there is no quality loss. |
| HLS on-demand (fMP4 segments) | One `.mp4` with init segments merged. |
| Direct file | Saved as is. |
| Live stream | **Record** from now until you stop, or **save the DVR buffer**. |
| A–B clip (HLS on-demand) | Set loop points A and B (<kbd>[</kbd> / <kbd>]</kbd>), then *Tools → Save A–B clip*: an `.mp4` of just that range, starting at 0:00. Cuts land on segment boundaries (keyframes, no re-encoding), so the clip can start and end a few seconds outside A and B. |

Choose **Save format → Original** to keep `.ts`/`.aac` files instead of MP4. If the first segment
cannot be remuxed (an unusual codec), Velostream falls back to the original format automatically.

Files are saved through the browser's download manager, with a *Save as* dialog when your browser
asks for one. Encrypted HLS (AES-128) is decrypted while saving. **DRM-protected video cannot be
saved.**

**Snapshots** (<kbd>S</kbd>) save a PNG of the current frame at full resolution.
<kbd>Shift</kbd>+<kbd>S</kbd> (or *Tools → Snapshot with subtitles & effects*) saves the picture as
you see it: GPU enhancement and colour filters applied, with the visible subtitle lines (main and
top) drawn in your subtitle style. **Burst** saves a 6-frame contact sheet.

---

## External players and command-line tools

*Studio → Tools → Open in external player* hands the stream to another app:

- **PotPlayer**, **VLC**, **mpv**, **IINA** (desktop, through their link handlers);
- **Android**: any installed video app through an intent.

If nothing happens, the app is not installed or has no link handler. Use the copy buttons
instead:

- **Copy stream link**;
- **Copy yt-dlp command** or **Copy ffmpeg command**: ready to paste, with the page's Referer,
  Origin and User-Agent so the server accepts the request.

Signed links expire. Run the command soon after copying it.

---

## The popup

- **Status** and **telemetry**: bandwidth, cache size, workers and seconds buffered ahead.
- **Now playing**: download or close the open player.
- **Detected streams**: with type, resolution, duration, live/DRM badges. *Rescan* and *Clear*.
- **This site**: *Always play in Velostream*.
- **Play any stream link**, **Continue watching**, and global **Settings** (appearance,
  playback, engine).
- On Firefox: **Allow access to websites**, when site access has not been granted yet.

---

## Accessibility

Velostream is built to be fully usable without a mouse or without sight:

- every control is a real button or slider with a label and is reachable with <kbd>Tab</kbd>;
  menus support arrow keys and <kbd>Esc</kbd>;
- changes are announced to screen readers: seek targets, volume, speed, quality switches, errors;
- **high contrast**, **reduced motion** (follows your system by default), **interface size** up to
  150 %, and a **simple mode** that hides advanced controls;
- subtitle fonts for dyslexia and low vision, with adjustable size, colours and background.
