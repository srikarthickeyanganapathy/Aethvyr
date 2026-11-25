# Troubleshooting

Player errors show a title, a message and a **Retry** button. The browser console (DevTools on the
page, `player.html` frame) has the details: `[Velostream] Shaka error <code> [HTTP status] <url> - <reason>`.
Include that line when you report a problem.

## Nothing is detected

1. Start the video in the site's own player once, then press **Rescan** in the popup.
2. Reload the page after installing or updating Aethvyr; pages opened before do not have its
   scripts.
3. On Firefox, check that site access is granted (**Allow access to websites** in the popup).
4. If the popup says the site uses **DRM** or a **proprietary player**, see below. Some sites
   (YouTube, for example) feed video through their own MSE pipeline with no manifest Aethvyr
   could open.

## Error codes

| Code | Meaning | What to do |
|------|---------|------------|
| **1001** HTTP 401 / 403 / 410 | The server refused the link. Usually the site **signs video links** and the signature expired, or it was single-use. | Aethvyr first switches to a newer link if the page requested one. Otherwise reload the page and open the player again. |
| **1001** HTTP 404 | The file is gone (the episode or server changed). | Reload the page; pick another server on the site. |
| **1001** HTTP 5xx / 429 | Server overload. | Aethvyr retries automatically twice a minute; press Retry later. |
| **1002** | A request failed outright (connection reset, DNS, TLS, blocked). The message names the server and the reason. | Check your connection. If the reason says *blocked* (`ERR_BLOCKED_BY_CLIENT`), allow that server in your ad or content blocker. Aethvyr already retries silently and resends requests after its background worker restarts. |
| **1003** | Timed out. | Slow server or network; Retry. |
| **3016**, **4032**, **4012**, **4001** | The browser cannot decode the codec (for example HEVC/AV1 without hardware support, or AC-3 audio). | Try a lower quality, another browser, or *Open in external player*. |
| **3017** | The player ran out of memory for its buffer (common on phones). | Aethvyr shrinks the buffer automatically. Lower *Player RAM buffer* in Studio → Quality. |
| **4000**, **4030** | The manifest could not be parsed. | Usually not a real video playlist (an ad or tracking URL). Pick another stream. |
| **6xxx** | DRM. | See below. |

## DRM-protected video

Widevine, PlayReady and FairPlay streams can only be decrypted by the site's own player inside
the browser's protected media path. Aethvyr detects them (the popup shows a DRM badge, and the
player explains it) and cannot play or save them. This is by design and will not change.

## Full screen does not work

- Browsers only allow full screen right after a click or key press **inside the player**. Use the
  full-screen button or <kbd>F</kbd>. If Aethvyr is asked without such a gesture (for example
  *Auto full screen* triggered by Shift or Ctrl alone), it waits for the next real one.
- If the site embeds its player in an iframe that does not allow full screen, Aethvyr fills the
  browser window instead. Press <kbd>F11</kbd> for true full screen.
- The console message *"Failed to execute 'requestFullscreen'… can only be initiated by a user
  gesture"* comes from the browser itself and is harmless.

## GPU enhancement has no effect

- Check Studio → Display → GPU enhancement for a status hint. *Unavailable* means WebGL2 is
  missing (or disabled in `chrome://gpu`), or the video is a cross-origin file without CORS,
  which the browser does not let any page read.
- *Stepped down* means the thermal guard lowered the preset because frames were dropping. Lower
  *Max render resolution*, or use Fast Sharpen.
- FSR and Anime4K only upscale when the video is shown larger than its resolution (full screen
  on a big display). In a small window they sharpen only.
- The effect is subtle at low strength by design; try 70–100 % to compare.

## Playback stutters

- Studio → Quality: lower the quality or set a quality cap; raise *Parallel downloads*.
- Turn off GPU enhancement to rule it out.
- On phones, lower *Player RAM buffer ahead* to 30 s.

## Download problems

- **An MP4 shows only a few seconds or cannot seek**. Versions before 2.7.1 could save the media
  fragments with a short initialization duration and no seek index. Open **Library → Offline / Cached**
  and choose **Export** if the job is still cached. Otherwise, retry the original stream. Existing
  files are unchanged. If you only have the old file, try repackaging a copy with
  `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`.
- **MP4 has no sound**. If the source uses separate renditions, select the audio track before
  exporting. **Original** can save video and audio separately when available.
- Large exports use a disk-backed temporary file where supported. Browsers without disk writing
  have a lower export limit. Check available storage before retrying.

## Resetting

Popup → Settings → **Reset all settings**, or remove and reinstall the extension. Clearing site data does not
reset Aethvyr; its settings live in the extension's own storage.
