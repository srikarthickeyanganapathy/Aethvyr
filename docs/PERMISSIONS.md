# Permissions and site access

## Store justification text

| Access | Production use and scope |
| --- | --- |
| HTTP and HTTPS host access | Detect media at document start on user-visited websites and their embedded players. The engine reads selected media across origins. File selection works through browser file pickers. File, FTP and other schemes are outside the manifest match patterns. |
| All matching frames and related blank frames | Embedded players frequently live on a different origin. Each content script operates in its own frame. The engine addresses the owning tab and frame for detection, mounting and page-context requests. |
| Web-accessible player page | A website frame must be able to navigate its overlay iframe to `player/player.html`. Its JavaScript, shared utilities and bundled libraries load internally from the extension origin. |
| `webRequest` | Observe request and response metadata for media discovery. In regular tabs, briefly retain selected authentication headers for the exact observed resource in worker memory. |
| `declarativeNetRequestWithHostAccess` on Chromium, `declarativeNetRequest` on Firefox | Install session rules for progressive video when the extension needs to supply the embedding origin as Referer and expose the response to its player. Rules match an exact media URL, tab, media resource type and extension initiator. |
| `scripting` | Load the isolated bridge in the requested frame when the user opens the player on an already-loaded website. |
| `storage` | Store local preferences, library, history and bookmarks, temporary tab state and optional account sync. |
| `unlimitedStorage` | Support user-configured IndexedDB media caches and resumable export checkpoints that can exceed normal origin retention limits. Application cache budgets and private-session memory limits still apply. |
| `downloads` | Send an explicitly selected export or snapshot to the browser download manager. |

## Optional and site-scoped access

The automatic detector needs access before page scripts start, sometimes in an embedded origin unrelated to the top-level site. A click-time host grant alone cannot observe earlier requests in those frames. Users can restrict site access in browser extension settings. Denying an embedded host may limit detection there. A fully opt-in host mode would need a grant interface, registration of scripts for granted origins, and a reload path. The redundant `activeTab` permission was removed.

Optional downloads would require coordinating a user-gesture permission prompt with delayed export completion and resume. That flow remains a separate compatibility item. The manifest requests one DNR permission per target. Chromium documents the host-access variant for extensions that already rely on host permissions. [Chrome permission declarations](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) · [Chrome DNR permissions](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
