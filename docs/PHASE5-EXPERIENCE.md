# Phase 5 · Player and Studio experience

## Choosing a playback surface

| Surface | When to use it | Controls and limits |
| --- | --- | --- |
| Full Aethvyr Player | Open a supported detected stream for quality selection, subtitles and Studio. | The existing Minimal, Standard and Pro layouts retain button visibility and ordering. Fullscreen or viewport fill provides edge-to-edge viewing. Auto-hide and the focus indicator support distraction-free viewing and keyboard use. |
| Lightweight shortcuts | Keep the website video and add keyboard controls. | K toggles playback, M toggles mute, brackets change speed and minus/equals adjust volume. |
| Enhancement only | Keep the website's media pipeline and apply the native enhancement. | Select Original to restore the website player. Playback and protected-content decisions stay with the browser and website. |

For a website video, turn on **Cinema mode** in the popup and select **Dim**, **Dark** or **Black** under Theater background. Escape removes the mask. The shading applies inside the document containing the video. A cross-origin embedded video can shade its own frame only. The background choice lasts for the lifetime of that document.

## Finding and restoring settings

In the popup, open **Settings** and type a category or setting name. For example, searching for “rewind” shows the Engine category. Clear the search to see all categories. Under **Restore one setting**, choose the setting and select **Restore default**. Import and export are available below the categories. Exported backups can contain personal viewing data.

Playback essentials stay on the player. Studio houses display processing, audio, downloads, shortcuts and gestures. Under **Display → Color Studio → Experimental lighting**, ambient video lighting is opt-in. It suspends frame sampling in Eco, on a low hardware tier or when reduced motion applies. Hidden documents skip sampling. Studio's selected tab uses dark text on the brand accent, and touch devices get larger tab targets.

## Global controls evaluation

The existing popup can select a connected full-player session, play or pause it, mute it and jump to its tab. Enhanced native video is selectable on the active tab. Playback speed, fine volume and Picture-in-Picture are available from the applicable player. Picture-in-Picture depends on browser support, embedding policy and user activation. The popup does not broadcast pause to other sessions. Mini player, fullscreen, skins and gesture bindings reuse the existing player implementation.

## Validation

The Edge fixture upgraded a legacy installation, opened and played a local video, sought, entered and exited fullscreen, and restored native playback. It checked lightweight keyboard shortcuts, restoration of playback rate and CSS filter, cinema shading and Escape, session selection and remote playback control. Popup checks filtered settings to one category and restored a nested gesture preference while preserving a separately changed seek step. Studio's arrow-key test verified both focus and selected tab. Reduced-motion emulation verified a computed zero transition duration. The responsive check exercised 390 × 844 mobile emulation and a 320 × 240 viewport.

Run `npm run build`, then `node scripts/chromium-foundation.mjs <chromium-executable> <legacy-2.7.1-chromium-zip> --experience` from the repository root. The fixture refreshes the [small player](media/phase5-small-player.png) and [Studio](media/phase5-studio.png) screenshots. Lint and all 55 unit tests passed. Chromium and Firefox packages built and passed archive validation. Physical touch devices, audible screen-reader output and Firefox interactive playback were outside this run.
