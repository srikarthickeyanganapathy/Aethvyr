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
| **Audio-only** | Drops to the lowest-bitrate stream and stops video rendering to save battery and data. A frequency visualizer in your accent colour plays while audio-only is on (static redraws only with reduced motion). |
| **Sleep timer** | Stops after a time or at the end of the video, fading the volume out. |
| **Skip intro / recap / credits** | When the stream has chapters, the pill reads **Skip Intro**, **Skip Recap**, **Skip Credits** or **Skip Preview** inside a chapter named like an opening (*Opening*, *Intro*, *OP*), recap, ending (*Ending*, *Credits*, *ED*) or preview that is 10 s – 4 min long, and jumps to that chapter's end. Otherwise it offers +30/60/85/90 s near the start. *Smart skip* fast-forwards through black, silent stretches. |
| **Ambient glow** | Studio → Display (or the popup): a soft glow in the video's colours fills the letterbox bars. Updates about 4 times a second, only while playing. |
| **Live streams** | A **Live** button jumps to the edge. The DVR keeps the last 30 minutes (configurable) so you can pause and rewind even when the site does not offer it. |

### Player look

Everyone likes a player to look a little different. **Studio → Prefs → Player look** changes
the controls without changing what they do. Glass with Standard controls is the default.

| Option | Choices |
|--------|---------|
| **Skin** | **Glass**: frosted floating islands (default). **Cinema**: an edge-to-edge bar on a soft gradient with play first. **Theater**: docked like Cinema, darker, with big icons and a heavy seek bar. **Floating pill**: a compact 440 px bar you drag anywhere by its handle or any empty part; on the handle the arrow keys move it (<kbd>Shift</kbd> for bigger steps, <kbd>Home</kbd> to reset), and the spot is remembered. **Compact**: an opaque one-line toolbar docked at the bottom, square corners, no blur. |
| **Controls** | **Minimal** (hides speed, Picture-in-Picture, download, statistics and audio-only, like simple mode), **Standard**, or **Pro**, which adds previous / next frame, an A–B loop button (set A, set B, clear), snapshot (<kbd>Shift</kbd>-click includes subtitles), and one-click **Audio & EQ** and **Picture & GPU** buttons that open those Studio tabs. Choosing Compact turns Pro on (unless you picked Minimal). |
| **Seek bar** | **Classic**; **Chapter segments** (gaps at chapter starts); **Loudness & buffer heatmap**, a strip above the bar whose height is how loud each part was while you watched (measured once the audio engine is running) and whose colour shows played, buffered and not-yet-loaded parts. |
| **Seek bar thickness** | 4–10 px. |
| **Control background darkness** | *Skin default*, or 0–95 % black behind the controls. |
| **Show or hide buttons** | Hide any button except Play and Studio. Hidden buttons keep their keyboard shortcuts. |
| **Order of the right-hand buttons** | Move speed, subtitles, Studio, Picture-in-Picture and full screen left or right. |

On players narrower than 600 px every skin uses the stacked phone layout. Keyboard focus always
follows the order on screen. *Reset player look* restores the defaults. The look is part of
backups and syncs between devices when sync is on.

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
| <kbd>?</kbd> | Shortcuts & gestures | <kbd>Esc</kbd> | Close menu or transcript, then the player |
| <kbd>T</kbd> | Transcript & search | | |

Keys pressed inside the player never reach the site's own shortcut handlers.

---

## Studio

Studio is the settings panel inside the player (sliders button). It has five tabs.

### Quality

- **Streams on this page** (when the page has more than one playable stream): switch to another
  one inside the same player, without closing it. Your position in the current one is saved.
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
- **Smart loudness normalization**: keeps the volume even across scenes and videos. It slowly lifts
  quiet dialogue toward a steady level (up to +12 dB) and lowers loud passages (down to −12 dB),
  ignoring silences, and a limiter catches sudden peaks. Gentler than Night mode, which squashes
  everything.
- **Spatial & dialogue**:
  - *Stereo width*: 0 % is mono, 100 % as recorded, up to 200 % for a wider stage.
  - *Dialogue boost*: lifts the voice band (around 2 kHz) in the centre of the mix only, so
    speech gets clearer without making music and effects louder.
  - *Headphone crossfeed*: blends a little of each side, delayed and softened, into the other
    ear, so hard-panned mixes stop sounding "inside your head" on headphones.

### Display

- **GPU enhancement**: preset, strength and maximum render resolution (see below).
- **Color Studio**: GPU colour grading with looks (*Neutral, Anime, Cinema, Natural, Night*) and
  sliders for gamma, vibrance (boosts dull colours more than vivid ones), temperature, tint,
  shadows and highlights. Works with or without an enhancement preset, on top of the colour sliders
  below. Needs WebGL2.
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
- **Player look** (see [Player look](#player-look) below): skin, controls density, seek bar style
  and thickness, control background darkness, which buttons are shown and their order.
- **Playback** defaults: speed, seek step, resume, auto full screen, controls auto-hide.
- **Gestures**, **Mouse**, **Keyboard** (see above).
- **Device**: on first run Velostream classifies the device as low-end, standard or high-end
  (CPU cores, memory, touch screen size and GPU). Low-end devices get smaller buffers, a 512 MB
  cache, 3 parallel downloads and a 1080p GPU render cap; high-end desktops get 8 downloads, a 4 GB
  cache and a longer RAM buffer. Only settings you had not changed are adjusted. *Re-detect and
  re-tune* applies the tier's values again.
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
- **Transcript & search** (<kbd>T</kbd>, or *Transcript & search* in this menu): a side panel with
  every line of the current subtitle track. The line being spoken is highlighted and kept in view
  (*Follow*; scrolling yourself pauses it). Type to search the whole video: matches are
  highlighted and counted, and clicking any line jumps there. Copy the text, or save it as an
  `.srt` with your sync offset applied.

---

## GPU enhancement

Studio → Display → **GPU enhancement** processes every frame with WebGL2 shaders on a canvas laid
exactly over the video.

| Preset | What it does | Best for |
|--------|--------------|----------|
| **Off** | Native browser rendering | Battery |
| **Fast Sharpen** (CAS) | Contrast-adaptive sharpening in one pass | Soft or low-bitrate video |
| **FSR upscale** | Lanczos-2 upscale with anti-ringing, then RCAS sharpening | Low resolution shown on a big screen |
| **Anime4K (fast)** | The real Anime4K neural networks (Restore S + Upscale ×2 S): cleans up compression and blur, then doubles the resolution | Animation on phones and laptops |
| **Anime4K HQ** | The larger Anime4K networks (Restore M + Upscale ×2 M), noticeably sharper line art | Animation on a dedicated or recent integrated GPU |
| **De-block + sharpen** | Smooths the 8×8 block edges of low-bitrate video where both sides are flat, then lightly sharpens | 360p–720p web video |
| **Denoise** | Edge-preserving (bilateral) noise removal; *grain* can be kept | Old, dark or noisy video |
| **Deband** | Smooths colour banding in flat areas, with dithering | Gradients, skies, dark scenes |

Measured on an Intel integrated GPU (848×480 source shown at 1080p): Fast Sharpen 0.3 ms per frame,
De-block 0.3 ms, Deband 0.6 ms, Denoise 1.5 ms, FSR 2.6 ms, Anime4K 3.1 ms, Anime4K HQ 5.5 ms.

- **Strength** scales the effect. **Max render resolution** caps the canvas size; lower it on
  weak GPUs.
- FSR and Anime4K only upscale when the video is shown **larger than its source** (Anime4K: more
  than 1.2×). Otherwise FSR runs a single sharpening pass and Anime4K runs only its Restore network.
- Anime4K needs half-float render targets. Where the GPU does not offer them it automatically uses
  the older *Anime4K-lite* shader instead; *Stats for nerds* shows which path is running. The
  networks compile in the background the first time, with Anime4K-lite shown meanwhile.
- The **thermal guard** watches frame time and dropped frames. If the GPU cannot keep up for about
  6 s, it steps down (Anime4K HQ → Anime4K → Fast Sharpen → Off; FSR → Fast Sharpen → Off;
  De-block, Denoise, Deband → Off) for this session only and tells you. Your saved choice is kept.
  Color Studio grading is never stepped down (it is very cheap).
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
- **Play any stream link**, **Continue watching** (with *Open library*), and global **Settings**
  (appearance, playback, engine, sync, backup).

---

## Library

*Popup → Continue watching → Open library* opens a full page with every video you played in
Velostream:

- **Continue watching** (started, not finished), **Recently watched**, **Favorites** (star any
  video), **Collections** and **Bookmarked**. Sections can be linked directly
  (`library.html#favorites`).
- **Search** by title or site, and **sort** by recent, title or progress.
- Each card shows progress, when you watched it and its bookmarks. *Open* opens the page; the
  player resumes where you stopped.
- **Collections**: create, rename, delete, and add a video to several collections.
- **Remove from history** asks first, and deletes the video's bookmarks only if you tick that box.

Everything stays on your device and is included in backups.

---

## Sync across devices

Off by default. Turn on *Settings → Sync across my devices* in the popup on each device. Velostream
then keeps these in step through your **browser account's sync** (Google for Chrome/Edge, Mozilla
for Firefox), with no Velostream server involved:

- settings (but not device-specific ones such as volume, interface size, buffer/cache sizes and
  GPU enhancement);
- watch positions of your recent videos, their bookmarks, and your library.

Changes upload about 10–60 seconds after you make them, and other devices pick them up when their
browser syncs. *Sync now* forces a round trip; *Delete synced data* removes Velostream's copy
from your account. Browser sync storage is small (about 100 KB), so with very long video addresses
only the most recent videos sync. See the [privacy policy](../PRIVACY.md#optional-sync-across-your-devices).
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
