# Store listing

Copy-ready text for the Firefox Add-ons (AMO) and Chrome Web Store submission forms. Upload
`dist/velostream-firefox-<version>.zip` / `dist/velostream-chrome-<version>.zip` from
`npm run build && npm run package`.

---

## Firefox Add-ons (AMO)

### 1. Upload version

- **Validation:** expect *0 errors, 10 warnings*: the 2 data_collection_permissions version notes and 8 `UNSUPPORTED_API` in
  `lib/shaka-player.compiled.js` (see reviewer notes below). Warnings do not block submission;
  click **Continue**.
- **Compatible applications:** *Firefox* is ticked. *Firefox for Android* is ticked **and greyed
  out**: AMO locks it on because the manifest declares `browser_specific_settings.gecko_android`.
  That is correct; Velostream supports Android 128+. Expect 2 extra validation warnings saying data_collection_permissions needs Firefox 140 / Android 142: older versions simply ignore the key, so they are harmless.

### 2. Source code

**Do you need to submit source code?** → **No.**

Velostream's own code is not minified, transpiled or bundled. The only minified file is the
unmodified third-party library Shaka Player, which reviewers verify against its official release
(link in the reviewer notes).

### 3. Describe add-on

| Field | Value |
|-------|-------|
| **Name** | Velostream |
| **Add-on URL** | `velostream` |
| **Summary** (max 250 characters) | Plays web videos (HLS, DASH, MP4) in a fast, accessible player over the site's own: background pre-buffering, GPU sharpening and upscaling, captured subtitles, gestures, and one-click download as a single MP4. No tracking, no servers. |
| **Categories (Firefox)** | Photos, Music & Videos; Download Management |
| **Categories (Android)** | Photos & Media |
| **Tags** | video, player, hls, streaming, download, subtitles, accessibility |
| **Support website** | `https://github.com/srikarthickeyanganapathy/Velostream` |
| **Support email** | *(optional; leave empty or use a dedicated address)* |
| **License** | MIT License |
| **Privacy policy** | Paste [PRIVACY.md](../PRIVACY.md) (optional on AMO because no data is collected, but recommended) |
| **This add-on is experimental** | No |
| **Requires payment** | No |

**Description:**

```
Velostream finds the video a page is playing and opens it in its own player, placed exactly over the site's video.

FAST
• Pre-downloads the whole video in the background with parallel connections, so seeking is instant and a weak connection does not stall playback
• Starts after half a second of video and keeps a rewindable buffer for live streams (live DVR)

BETTER PICTURE
• GPU enhancement: Fast Sharpen, FSR-style upscaling, Anime4K-style line art, and deband
• Brightness, contrast, saturation, warmth; zoom, rotate, mirror, aspect presets

SUBTITLES & AUDIO
• Picks up the site's subtitles automatically; load SRT, VTT or ASS files
• Dual subtitles, "sync next line to now", subtitle speed, pause on hover, click to copy
• Audio boost to 300%, equalizer presets, lip-sync delay, pitch-preserving speed, mono/left/right output

CONTROLS
• Double-tap zones, swipe for volume and brightness, long-press 2×, pinch zoom
• Customizable keyboard shortcuts, mouse wheel and middle-click actions
• Mini player, Picture-in-Picture, sleep timer, A-B loop, bookmarks, resume where you left off
• Per-site profiles and "always play in Velostream" for chosen sites
• Make it yours: five skins (glass, cinema, theater, floating pill, compact), minimal / standard / pro controls, seek bar styles, and show, hide or reorder buttons

SAVE
• Download on-demand HLS and DASH video as one MP4 (segments remuxed, audio merged, no re-encoding), or just an A–B clip
• Record live streams, take snapshots
• Open in VLC, mpv, PotPlayer or an Android app, or copy a ready yt-dlp / ffmpeg command

ACCESSIBLE
• Fully usable with keyboard and screen readers; high contrast, reduced motion, interface scaling, dyslexia-friendly subtitle fonts

PRIVATE
• No accounts, servers, analytics or remote code. Velostream only talks to the sites you watch.

Not supported: DRM-protected video (Netflix, Prime Video, Disney+, YouTube's protected streams and similar). Please only download content you have the right to keep.
```

### 4. Notes to reviewer

```
Velostream is a video player. It detects HLS/DASH/MP4 streams on pages and plays them in an extension page (player/player.html) mounted as an iframe over the site's video.

Third-party library:
lib/shaka-player.compiled.js is the unmodified Shaka Player 5.3.3 file dist/shaka-player.compiled-es2021.js from npm:
https://www.npmjs.com/package/shaka-player/v/5.3.3
https://github.com/shaka-project/shaka-player/releases/tag/v5.3.3
Its license is included as lib/SHAKA-LICENSE.txt.

Validation warnings:
The 8 UNSUPPORTED_API warnings (cast.*, webview.hostObjects) come from that unmodified library. They are guarded feature checks for Chromecast and WebView2 and are never executed in Firefox.

Permissions:
- content/interceptor.js runs in the MAIN world to observe the page's own fetch/XHR/Worker/MediaSource calls for stream detection, and to perform fetches with the page's own identity when the background asks for a segment the server only serves to the page.
- webRequest is used read-only (no blocking) to detect manifests requested by workers and remember the Referer/Origin a video host expects.
- declarativeNetRequest: one static rule exposes Content-Range/Content-Length on media responses; session rules add the site's Referer/Origin to the extension's own media requests.
- downloads: saving videos the user chooses to download.

No remote code, no eval, no analytics; data_collection_permissions is "none".

How to test:
1. Open https://shaka-player-demo.appspot.com/ or any page with an HLS stream, start the video.
2. Click the "Play in Velostream" pill over the video, or the toolbar button and pick the stream.
3. The player opens over the video. Press "?" for shortcuts; the download button saves an MP4.
Source and documentation: https://github.com/srikarthickeyanganapathy/Velostream
```

### 5. Images

- **Icon:** taken from the package (`icons/icon-128.png`).
- **Screenshots** (1280×800 or larger, 16:10): player over a page, Studio panel, subtitles menu,
  GPU enhancement on, popup with detected streams.

---

## Chrome Web Store

| Field | Value |
|-------|-------|
| **Name** | Velostream (from the manifest) |
| **Summary** (max 132 characters) | Fast, accessible player for web video: pre-buffering, GPU sharpening, captured subtitles and one-click MP4 download. |
| **Description** | Same as the AMO description above |
| **Category** | Productivity → Tools (or Entertainment) |
| **Language** | English |
| **Store icon** | `icons/icon-128.png` |
| **Screenshots** | 1280×800, 1–5 images |
| **Small promo tile** | 440×280 |

**Privacy practices tab:**

- **Single purpose:** *Velostream plays video streams found on web pages in an enhanced,
  accessible player that pre-buffers, enhances and optionally saves them.*
- **Permission justifications:** copy each one from [PERMISSIONS.md](PERMISSIONS.md#store-justification-text).
- **Remote code:** *No, I am not using remote code.*
- **Data usage:** tick nothing in the data categories. Certify all three statements: not sold to
  third parties, not used for unrelated purposes, not used for creditworthiness or lending.
- **Privacy policy URL:** a public link to `PRIVACY.md`, for example
  `https://github.com/srikarthickeyanganapathy/Velostream/blob/main/PRIVACY.md`.
