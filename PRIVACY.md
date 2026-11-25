# Privacy policy

*Last updated: 25 November 2026*

Aethvyr is a browser extension that plays and saves video from the pages you visit. It is
designed to work entirely on your device.

## What Aethvyr does not do

- It does **not** collect, sell or share personal data.
- It has **no servers**, accounts, analytics, telemetry, crash reporting or advertising.
- It does **not** send your browsing history, page content or video URLs anywhere, except to
  your own browser account when you turn on the optional sync described below.
- It does **not** load remote code or remote configuration.

## Data handled on your device

| Data | Where it is stored | Purpose | Retention |
|------|--------------------|---------|-----------|
| Settings (player preferences, gestures, shortcuts, site profiles, sites set to *Always play in Aethvyr*) | `storage.local` | Your preferences | Until you change them or uninstall |
| Watch positions and bookmarks (video URL, title, position) | `storage.local` | *Continue watching* and resume | Newest 200 videos; *Clear history* in the popup deletes them |
| Library (favorites and collections of videos from your history) | `storage.local` | The library page | Until you remove them or uninstall |
| Streams and subtitles detected in a tab | `storage.session` | The popup's stream list | Until the tab closes or the browser restarts |
| Video segments | IndexedDB (extension origin) | Pre-buffering for smooth playback and seeking | Deleted when you close the player |
| Downloaded videos and snapshots | Your downloads folder | What you chose to save | Yours to manage |

When you grant private-window access, the web video player skips watch-history writes for private tabs. Private bookmarks and local-file records live in the player page. Private web playback uses a per-session memory cache capped at 16 MiB and skips durable download checkpoints. Private exports can save a file you explicitly select, and interrupted private exports must restart. Private requests use their owning page’s network context, subject to its cross-origin access rules. Regular tabs still save their watch positions for Continue Watching.

## Network requests

Aethvyr makes requests only to the servers that host the video you chose to play: playlists,
segments, keys and subtitles. It repeats the headers the site's own player used (Referer,
Origin, cookies for that site and authorization headers) so the server accepts the requests.
These go to the same servers the site's player would contact. No request goes to the developer
or any third party.

## Optional sync across your devices

Sync is **off by default**. Only if you turn on *Sync across my devices* in the popup does
Aethvyr copy the following into the browser's extension sync storage (`storage.sync`):

- your settings, except device-specific ones (volume, interface size, buffer and cache sizes,
  GPU enhancement, quality cap and similar);
- watch positions and titles of recent videos, plus a cleaned website page address when available;
- bookmarks for those videos, and your library (favorites and collections).

Your browser then syncs that storage through **your own browser account**: Google for Chrome and
Edge sync, Mozilla for a Firefox account. Aethvyr runs no server and never receives this data.
Stream addresses stay on the device that played them. Sync strips page query strings and fragments
and omits page URLs with URL credentials or paths that look like credentials. A valid YouTube
video ID is kept for watch-page navigation. Direct links and some sites that identify videos
through query strings may need to be reopened manually on another device.

An updated device rewrites older synced history the next time it successfully syncs. Update your
other devices to continue syncing. If sync is already off, use *Delete synced data* to clear older
copies still stored in your account.

Playback diagnostics are local and exported only when you choose *Save playback diagnostics*.
The report contains supported numeric playback and browser data and excludes page URLs,
stream URLs, titles, request headers, and raw error messages.

Turning sync off stops uploading. To remove what was already uploaded, use *Delete synced data* in
the popup (devices that still have sync on will upload their copy again).

## Permissions

What each permission is used for is documented in [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

## Children

Aethvyr does not knowingly collect any data from anyone, including children.

## Changes

Changes to this policy are published in this file and noted in the changelog.

## Contact

Open an issue at
<https://github.com/srikarthickeyanganapathy/Velostream/issues>.
