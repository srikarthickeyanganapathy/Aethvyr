# Phase 8 · Personal library

## Organizing a title

Use Recently watched to find a title by name or website. Continue watching uses saved playback position and completion. Favorites, collections and bookmarks retain their existing records. Grid and list layouts share the same controls.

Movies and Series follow format. Anime, Donghua and Cartoons follow medium, so an anime film can appear on both shelves. Choose Educational under Edit category for lectures and courses. Edit episode details to correct the format, medium, series title, season or fractional episode number. Season zero appears under Specials. Use detected details removes the episode override. The separate Category selector can also be returned to Auto.

Series group by a publisher-provided series identity when present. A title without an identity groups within its source website. Within a series, matching known season and episode numbers collapse into one row, retaining completion from either record. Missing season or episode numbers use the saved page or record identity. Individual source entries and bookmarks remain available in Recently watched and Bookmarked. A matching publisher identity is needed for automatic cross-site grouping. Watching, Completed, Plan to Watch, On Hold and Dropped are personal status choices.

## Playback and privacy

Play next moves a title to the front of the queue. Add to queue moves it to the end. Clear queue saves the current order locally. Restore previous queue brings that order back ahead of subsequent additions and skips deleted history entries. Repeat, shuffle and the optional autoplay countdown retain their existing behavior.

When the queue is empty the content script checks publisher episode markup, then next-link metadata and descriptive anchors. Adapters may scope rules to a hostname. Only a publisher-marked episode link on the same origin is eligible for automatic countdown. Other candidates need a click. Links are rechecked before opening. Sites without usable links produce no destination.

Artwork starts disabled. Enabling it permits requests to image URLs supplied by source pages. Episode corrections, artwork preference, watch status, queue and optional watch statistics stay on the device. No new sync payload, external lookup service or developer analytics endpoint was added. Statistics record active watch time, daily totals, completion counts, categories and session count. The Statistics view can disable recording or delete the totals.

## Storage and verification

Episode corrections are additive v1 records keyed by history item. Prior history, favorites, collections, classifications and bookmarks need no rewrite. Legacy queues without a cleared snapshot still load. Removing a history item removes its episode override. Clearing history also removes its queue.

All 60 unit tests and lint passed. Chromium and Firefox packages passed validation. The Edge upgrade fixture retained a bookmark, collection, position, file handle and download bytes. Browser checks exercised queue editing, clear/restore and reload, fractional specials, duplicate episode grouping, layout switching, verified next-link navigation, countdown cancellation, statistics recording and deletion. The test used local fixtures. Interactive Firefox and third-party site behavior remain unverified.
