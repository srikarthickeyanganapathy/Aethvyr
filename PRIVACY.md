# Privacy policy

*Last updated: 16 November 2026*

Velostream is a browser extension that plays and saves video from the pages you visit. It is
designed to work entirely on your device.

## What Velostream does not do

- It does **not** collect, sell or share personal data.
- It has **no servers**, accounts, analytics, telemetry, crash reporting or advertising.
- It does **not** send your browsing history, page content or video URLs anywhere, except to
  your own browser account when you turn on the optional sync described below.
- It does **not** load remote code or remote configuration.

## Data handled on your device

| Data | Where it is stored | Purpose | Retention |
|------|--------------------|---------|-----------|
| Settings (player preferences, gestures, shortcuts, site profiles, sites set to *Always play in Velostream*) | `storage.local` | Your preferences | Until you change them or uninstall |
| Watch positions and bookmarks (video URL, title, position) | `storage.local` | *Continue watching* and resume | Newest 200 videos; *Clear history* in the popup deletes them |
| Library (favorites and collections of videos from your history) | `storage.local` | The library page | Until you remove them or uninstall |
| Streams and subtitles detected in a tab | `storage.session` | The popup's stream list | Until the tab closes or the browser restarts |
| Video segments | IndexedDB (extension origin) | Pre-buffering for smooth playback and seeking | Deleted when you close the player |
| Downloaded videos and snapshots | Your downloads folder | What you chose to save | Yours to manage |

## Network requests

Velostream makes requests only to the servers that host the video you chose to play: playlists,
segments, keys and subtitles. It repeats the headers the site's own player used (Referer,
Origin, cookies for that site and authorization headers) so the server accepts the requests.
These go to the same servers the site's player would contact. No request goes to the developer
or any third party.

## Optional sync across your devices

Sync is **off by default**. Only if you turn on *Sync across my devices* in the popup does
Velostream copy the following into the browser's extension sync storage (`storage.sync`):

- your settings, except device-specific ones (volume, interface size, buffer and cache sizes,
  GPU enhancement, quality cap and similar);
- watch positions of your most recent videos: the video address, the page address and the title;
- bookmarks for those videos, and your library (favorites and collections).

Your browser then syncs that storage through **your own browser account**: Google for Chrome and
Edge sync, Mozilla for a Firefox account. Velostream runs no server and never receives this data.
Video addresses are synced as they are, including any access tokens in them, because those are
needed to play the video again. If your browser itself is not signed in to sync, the data stays on
the device.

Turning sync off stops uploading. To remove what was already uploaded, use *Delete synced data* in
the popup (devices that still have sync on will upload their copy again).

## Permissions

What each permission is used for is documented in [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

## Children

Velostream does not knowingly collect any data from anyone, including children.

## Changes

Changes to this policy are published in this file and noted in the changelog.

## Contact

Open an issue at
<https://github.com/srikarthickeyanganapathy/playerstreamextension/issues>.
