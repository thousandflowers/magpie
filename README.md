# Magpie

A universal media harvester for the browser: it finds every image, video and
audio file a page loads or references, groups them by similarity, and downloads
them in bulk.

![The Magpie panel showing three clusters found on one page](docs/panel.png)

*The panel at its real 400px width: one page, three clusters — a 12-image
gallery, a collapsed set of 6 UI icons, and a hero on its own. Tiles in these
captures are flat placeholders (the fixture URLs point at hosts that do not
exist); the layout, metadata, clustering and selection state are real.
Regenerate with `npm run screenshots`.*

It exists because every other downloader either scrapes the DOM (fragile, misses
everything a single-page app fetches) or watches the network (catches
everything, including garbage, with no relationship to what is on screen).
Magpie does both and joins them. The signature interaction is **similarity
selection**: right-click one image and it selects every other item on the page
that belongs to the same set — same DOM structure, same URL shape, same
dimensions — and downloads them together.

The same mechanic at scale, as a full-length capture rather than an inline
image because it is 400 x 2873: [122 assets recognised as one set, 40 selected,
9.3 MB queued](docs/panel-bulk.png).

**Four detection layers feed one per-tab index, deduplicated by normalized URL:**
a `chrome.webRequest` observer (listener mode only); a MAIN-world interceptor at
`document_start` that mines `fetch`/XHR JSON payloads for media URLs an SPA has
not rendered yet; a DOM scanner covering `srcset`, `picture`, lazy `data-*`
attributes, CSS `background-image`, inline `<svg>`, `<canvas>` and gallery
`<a href>` links; and HAR import for a DevTools capture. An item seen by both
the DOM and the network is `confirmed` and sorts first.

**Similarity** is `0.35·url + 0.25·structure + 0.20·dimensions + 0.10·type +
0.10·host`, cut at `loose 0.45 / balanced 0.62 / strict 0.80`, clustered with
single linkage. The structure term has three states: a score, `0` when two items
are known to sit in *different* repeated groups (a carousel is not the grid
below it), and a neutral `0.5` when either item has no DOM at all — absence of
evidence must not be counted as evidence of difference.

---

## Install (unpacked)

No build step, no bundler, no `npm install`. The folder you cloned *is* the
extension.

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → choose this folder
4. Pin it. Clicking the icon opens the side panel for the current tab.

Chrome 120+. Loads unchanged in Arc, Dia, Brave and Edge; without
`chrome.sidePanel` the panel opens in a popup window instead.

```sh
npm test           # 94 unit tests, then a service-worker smoke test in Chrome
npm run test:unit  # unit tests only, no browser needed
npm run test:dash  # DRM boundary checked in the real panel (18 assertions)
npm run screenshots
```

`package.json` declares no dependencies. The browser checks look for a Chromium
(`CHROME_PATH` points at one) and skip with a notice if none is found — except
under `CI`, where the smoke test fails instead of skipping, because skipping is
how a dead service worker goes unnoticed.

---

## Permissions

| Permission | Why |
|---|---|
| `webRequest` | Layer A, **listener mode only** — never blocks, redirects or rewrites. Hence no `webRequestBlocking`, no `declarativeNetRequest`. |
| `downloads` | The point. Every download starts from an explicit click. |
| `storage` | Per-tab index in `chrome.storage.session` (an MV3 worker restart loses nothing), options in `chrome.storage.local`. Nothing leaves the machine. |
| `contextMenus` | The right-click entry points, including two-click "download all similar". |
| `notifications` | Reports what a context-menu download queued, since that path never opens the panel. |
| `sidePanel` | The panel. |
| `<all_urls>` | It has to work on any site: observe requests, run the scanner, `HEAD`-check upgrades, fetch what you selected. |

Deliberately **not** requested: `tabs`, `cookies` (a session-gated stream gets
`yt-dlp --cookies-from-browser` rather than your cookie jar), `history`,
`bookmarks`, `webNavigation`, `management`, `debugger`.

---

## Resolution upgrades

Thumbnails are a trap: a naive downloader saves the 150 px copy. Magpie derives
candidate full-size URLs and **proves each with a `HEAD` request** before
offering it. A candidate that fails, returns a non-media type, or reports a
*smaller* `Content-Length` is discarded and the original kept. Once upgrades are
known, items that would fetch the same bytes are collapsed, so a thumbnail and
its own full-size original never download twice.

Generic rules cover WordPress `-300x200` suffixes, `_thumb`/`_small` stems,
`/thumbs/` → `/original/`, resize/quality/format query parameters,
Cloudinary-style transform segments, `=s220` suffixes and Wikimedia `/thumb/`.

### `rules/site-rules.json`

Per-host overrides are data, not code.

| Field | Required | Meaning |
|---|---|---|
| `match` | yes | Hostname or suffix. `example.com` matches `cdn.example.com`, not `notexample.com`. `*` matches any host. |
| `find` | yes | Regex applied to the whole URL. |
| `replace` | yes | Replacement; `$1`…`$9` are capture groups. |
| `path` | no | Regex the pathname must satisfy first. |
| `verify` | no | `false` skips the `HEAD` check. Defaults true. |
| `note` | no | Shown in the panel beside the upgraded URL. |

```json
{
  "match": "redd.it",
  "find": "^https?://preview\\.redd\\.it/([^?]+).*$",
  "replace": "https://i.redd.it/$1",
  "note": "Reddit: preview.redd.it renditions have an i.redd.it original"
}
```

`https://preview.redd.it/abc123.jpg?width=320&crop=smart` →
`https://i.redd.it/abc123.jpg`, then `HEAD`-checked. Rules run in array order
before the generic ones; a malformed regex is skipped, not fatal.

---

## Streams

HLS and DASH manifests are parsed in-process (no dependencies) and their
variants listed with resolution, bitrate, codec and estimated size. You then get
a **`yt-dlp` command**, an **`ffmpeg` command** (`-c copy`, with headers), or a
**segment list** as JSON. Magpie does not ship `ffmpeg.wasm` and does not remux
video in a browser tab; a correct shell command is more useful and considerably
more honest.

---

## DRM — a hard boundary

**Magpie never circumvents DRM and contains no code path that could.**

When a stream declares encryption — `#EXT-X-KEY` with any method other than
`METHOD=NONE`, or a DASH `ContentProtection` element — or when the page calls
`navigator.requestMediaKeySystemAccess`, the affected media is marked
`protected`: dimmed, badged `DRM`, its download control disabled, all three
stream actions withheld, and the download queue refuses it even if it is
selected some other way. Key systems are identified only to say "not
downloadable": no key material is requested, stored or parsed, no `pssh` box or
`default_KID` leaves the parser, and no segment is ever decrypted.

This is a design boundary, not a setting. Please do not send patches that cross
it.

---

## What this does not do

- **No DRM circumvention.** See above.
- **No video remuxing.** Streams give you a command and a segment list, not an `.mp4`.
- **No live-stream recording.** A live playlist is reported as live; capturing it is `yt-dlp`'s job.
- **Nothing the browser itself cannot fetch.** A cross-origin tainted `<canvas>` is marked `unavailable`.
- **No auto-download, ever.** Nothing is fetched without a click.
- **No telemetry, no analytics, no remote calls.** Beyond fetching what you asked for and `HEAD`-checking upgrades, it makes no network requests. No CDN, no web fonts.
- **No account, login or sync.** The index lives in session storage and dies with the tab.
- **Clustering is capped** at 1200 items per view (the score matrix is quadratic). The remainder is listed ungrouped and the panel says so rather than hiding it.
- **A hero image with the same dimensions as the grid below it will cluster with that grid.** Magpie detects that the two sit in different repeated structures and zeroes the structural term — but the remaining four terms floor at 0.4625 for two images sharing a host, a directory and a file type, so the dimension term alone carries the rest of the way to 0.62. At identical dimensions the pair scores 0.6625 and merges. That is a limit of the current term weights, not of the repeated-group test; `strict` separates them.
- **It cannot see inside cross-origin iframes it is not injected into**, and no extension runs on `chrome://` pages or the Chrome Web Store.

## Not verified

Stated plainly rather than implied by silence:

- **Arc, Dia, Brave and Edge have not been launched.** Nothing Chrome-only is used beyond `chrome.sidePanel`, which has a popup fallback, but that is an argument, not a test.
- **The panel has been reviewed as screenshots, not used.** Nobody has driven it interactively for a long session; keyboard flow, scroll behaviour under load and hover states are unproven in practice.
- **HAR import is tested against a synthetic HAR**, not one exported from DevTools.
- **No commercial DRM player has been visited.** The DRM path is verified with hand-written HLS and DASH manifests, a simulated `requestMediaKeySystemAccess` call, and assertions read out of the real panel — not against Netflix or Spotify.
- **No DASH manifest has been fetched from a live CDN.** HLS has (Apple's public test stream, downloaded for real with the generated command).
- **The 122-item bulk download was measured once**, on localhost. Behaviour against a rate-limiting CDN rests on the retry/backoff code, which has not met a real 429.

---

## Keyboard

| Key | Action |
|---|---|
| `/` | focus search |
| `a` | select/deselect every item in the focused group |
| `Enter` | download the selection |
| `Escape` | close the drawer, or clear the selection |
| `Space` | toggle the focused item |
| `i` | open the detail drawer |

---

## Your responsibility

Magpie collects media you are allowed to collect. Respecting the terms of
service of the sites you point it at, and the copyright of what you download, is
on you. Being able to fetch something is not the same as being entitled to keep,
republish or redistribute it.

MIT licensed — see [LICENSE](LICENSE).
