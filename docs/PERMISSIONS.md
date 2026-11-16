# Permissions

Every permission Velostream requests, why, and the justification text to use in store listings.

| Permission | Why it is needed |
|------------|------------------|
| **Host access `<all_urls>`** | Video can be on any site and inside any embedded frame. The content scripts must run in every frame to detect streams, mount the player over the site's video and fetch with the page's identity. The engine needs host access to download playlists and segments without CORS restrictions. |
| **`webRequest`** | Detects manifests requested by the site's player at network level, including those requested by Web Workers that content scripts cannot see. It also remembers the Referer, Origin and authorization headers each video host expects, so Velostream can repeat them. Read-only: requests are never blocked or modified through this API. |
| **`declarativeNetRequest`**, **`declarativeNetRequestWithHostAccess`** | One static rule appends `Access-Control-Expose-Headers: Content-Length, Content-Range, Content-Type, Accept-Ranges` to media responses (playlists, segments, subtitles, keys) so byte-range downloads made through the page can read them; it changes nothing else. Per-host session rules add the site's Referer and Origin to requests made by Velostream itself (not the site's), because many video CDNs reject requests without them. |
| **`scripting`** | Injects the content script into frames that were open before Velostream was installed or updated, so the player can launch without reloading the page. |
| **`storage`**, **`unlimitedStorage`** | Settings, watch positions, bookmarks and the library (`storage.local`); per-tab detection state (`storage.session`); only when the user turns on sync, a small copy of settings, recent positions, bookmarks and library in `storage.sync`, which the browser syncs through the user's own account; the background pre-buffer of video segments in IndexedDB, which can be hundreds of megabytes. |
| **`downloads`** | Saves videos, recordings and snapshots through the browser's download manager, with a *Save as* dialog. |
| **`activeTab`** | Lets the popup act on the current tab (rescan, launch). |

## Store justification text

> **Single purpose:** Velostream plays video streams found on web pages in an enhanced,
> accessible player that pre-buffers, enhances and optionally saves them.
>
> **Host permissions:** Videos can appear on any website and inside embedded frames. Velostream
> must detect the stream in each frame, place its player over the site's video and download the
> stream's playlist and segments. No page content is collected or transmitted.
>
> **webRequest:** Read-only observation of media requests, to detect video manifests requested
> by the site's player (including from Web Workers) and the headers the video server expects.
>
> **declarativeNetRequest:** Adds the site's Referer/Origin to Velostream's own media requests
> and exposes range headers on media responses, so streams from hot-link-protected CDNs play.
>
> **scripting:** Injects Velostream's own content script into frames opened before installation
> so the player can start without a page reload.
>
> **storage / unlimitedStorage:** Stores settings, watch history and a local cache of video
> segments for smooth seeking. If the user opts in to sync, settings and recent watch positions
> are also kept in storage.sync so the browser can sync them through the user's own account.
>
> **downloads:** Saves the video the user chooses to download.
>
> **Remote code:** None. All code, including the bundled Shaka Player library, ships in the
> package.
