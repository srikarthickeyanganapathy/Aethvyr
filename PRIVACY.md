# Privacy policy

*Last updated: 14 November 2026*

Velostream is a browser extension that plays and saves video from the pages you visit. It is
designed to work entirely on your device.

## What Velostream does not do

- It does **not** collect, sell or share personal data.
- It has **no servers**, accounts, analytics, telemetry, crash reporting or advertising.
- It does **not** send your browsing history, page content or video URLs anywhere.
- It does **not** load remote code or remote configuration.

## Data handled on your device

| Data | Where it is stored | Purpose | Retention |
|------|--------------------|---------|-----------|
| Settings (player preferences, gestures, shortcuts, site profiles, sites set to *Always play in Velostream*) | `storage.local` | Your preferences | Until you change them or uninstall |
| Watch positions and bookmarks (video URL, title, position) | `storage.local` | *Continue watching* and resume | Newest 200 videos; *Clear history* in the popup deletes them |
| Streams and subtitles detected in a tab | `storage.session` | The popup's stream list | Until the tab closes or the browser restarts |
| Video segments | IndexedDB (extension origin) | Pre-buffering for smooth playback and seeking | Deleted when you close the player |
| Downloaded videos and snapshots | Your downloads folder | What you chose to save | Yours to manage |

## Network requests

Velostream makes requests only to the servers that host the video you chose to play: playlists,
segments, keys and subtitles. It repeats the headers the site's own player used (Referer,
Origin, cookies for that site and authorization headers) so the server accepts the requests.
These go to the same servers the site's player would contact. No request goes to the developer
or any third party.

## Permissions

What each permission is used for is documented in [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

## Children

Velostream does not knowingly collect any data from anyone, including children.

## Changes

Changes to this policy are published in this file and noted in the changelog.

## Contact

Open an issue at
<https://github.com/srikarthickeyanganapathy/playerstreamextension/issues>.
