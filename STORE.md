# Chrome Web Store submission

Everything the listing form asks for, written out so submitting is copying
rather than composing. Nothing here is uploaded automatically: publishing needs
a developer account, and a listing is worth a person's eyes before it goes
live.

Build the artefact first:

```sh
npm test                    # the full suite, against a real Chrome
npm run package             # -> dist/magpie-<version>.zip
npm run screenshots:store   # -> docs/store/*.png at 1280x800
```

`npm run package` refuses to build on a version mismatch, a manifest that names
a missing file, a file the zip would leave out, or any remote script,
stylesheet or font. A clean build is the precondition for everything below.

---

## Item

**Name** (75 max)

```
Magpie - bulk media downloader
```

**Short description** (132 max)

```
Finds every image, video and audio file a page loads, groups them by similarity, and downloads them in bulk.
```

**Category**: Workflow & Planning
**Language**: English

**Detailed description**

```
Magpie finds the media a page actually has, not just the media a page shows.

Most downloaders pick one strategy and live with its blind spot. A DOM scraper
misses everything a single-page app fetches after load. A network sniffer
catches every byte on the wire with no idea which ones are on your screen.
Magpie runs four detection layers at once and joins them into one list per tab:

- a request observer, watching what the page loads
- an interceptor that reads the JSON an app fetches, so media that has not been
  rendered yet still shows up
- a DOM scanner covering srcset, <picture>, lazy data-* attributes, CSS
  background images, inline SVG, <canvas> and gallery links
- HAR import, for a capture exported from DevTools - saved straight out of the
  archive, without touching the network again

Anything two layers agree on is marked confirmed and sorts first.

SIMILARITY SELECTION

The signature move: right-click one image and Magpie selects every other item
on the page that belongs to the same set - same DOM structure, same URL shape,
same dimensions - and downloads them together. One right-click on one thumbnail
takes the whole gallery and leaves the site's icons, avatars and ads behind.

FULL-SIZE, PROVEN

Thumbnails are a trap: a naive downloader saves the 150px copy. Magpie derives
the likely full-size URL and proves each candidate with a HEAD request before
offering it. A candidate that fails, returns the wrong type or reports fewer
bytes is discarded and the original kept. WordPress size suffixes, /thumbs/
paths, resize and quality parameters, Cloudinary transforms and Wikimedia
renditions are all handled, and per-site rules are plain JSON.

EXPLORE

Point it at a gallery and let it walk: it scrolls each page in steps so lazy
loaders and infinite feeds fire, opens the tabs, accordions and menus that hide
more media, follows same-origin links most-like-the-start-page first, and keeps
one index across the whole crawl. Bounded by construction - 40 pages, 60
clicks, a gap between navigations - and deliberately careful about what it
clicks: a control needs a positive reason, and anything that reads as
transactional or destructive is refused.

STREAMS

HLS and DASH manifests are parsed in the browser and their variants listed with
resolution, bitrate and codec. You get a yt-dlp command, an ffmpeg command or
the segment list. Magpie does not remux video in a browser tab; a correct shell
command is more useful and considerably more honest.

DRM: A HARD BOUNDARY

Magpie never circumvents DRM and contains no code path that could. Encrypted
media is marked protected, its controls disabled, and the download queue
refuses it. No key material is requested, stored or parsed. This is a design
boundary, not a setting.

PRIVACY

No account, no telemetry, no analytics, no server, no CDN, no web fonts. The
index lives in session storage and dies with the tab. Nothing leaves your
machine except the files you asked for and the thumbnails the panel draws.
Open source, MIT licensed: https://github.com/thousandflowers/magpie

WHAT IT DOES NOT DO

No DRM circumvention. No video remuxing. No live-stream recording. No
auto-download - nothing is ever saved without a click. Nothing the browser
itself cannot fetch: a cross-origin tainted canvas is marked unavailable and
says so.

Collect only what you are allowed to collect. Being able to fetch something is
not the same as being entitled to keep, republish or redistribute it.
```

---

## Privacy tab

**Single purpose**

```
Magpie finds the image, video and audio files on the page you are viewing and
downloads the ones you select. Every feature serves that one purpose: detecting
media, grouping it so a whole set can be selected at once, resolving a
thumbnail to its full-size original, and saving the result.
```

**Permission justifications** - one per declared permission. Each answers "why
does this extension need it", rather than describing the API.

| Permission | Justification |
|---|---|
| `storage` | Holds the media found in each tab (`chrome.storage.session`, cleared with the tab) and the user's own settings such as the filename template (`chrome.storage.local`). Nothing is synced or transmitted. |
| `downloads` | The extension's purpose is saving media files. Every download begins with an explicit click. |
| `contextMenus` | Provides the right-click entry points, including "download all similar", the extension's primary interaction. |
| `webRequest` | Listener mode only, to notice media the page requests that is not present in the DOM - the media an app fetches after load. It never blocks, redirects or modifies a request, which is why `webRequestBlocking` is not requested. |
| `notifications` | Reports what a right-click download queued. That path never opens the panel, so without a notification there is no feedback at all. |
| `sidePanel` | The interface is a side panel, so the list of found media stays beside the page it came from. |
| `host_permissions` (`<all_urls>`) | Media is on every site, so the detection layers have to run wherever the user opens the panel. The extension reads media elements and media request URLs, and fetches only the files the user selects, the thumbnails the panel draws, and a `HEAD` check on a candidate full-size URL. Users who prefer to narrow this can set site access to "on specific sites" in Chrome; the extension works normally under that restriction. |

**Remote code**: *No, I am not using remote code.* All logic ships in the
package. There is no `eval`, no `new Function`, no `importScripts` of a remote
URL, and no externally hosted script, stylesheet or font - the source tree
contains no absolute `http(s)` URL at all, and `npm run package` fails the
build if one appears. `rules/site-rules.json` is compiled with `new RegExp`,
but it is a packaged file, not a remotely updatable one.

**Data usage**: none of the categories apply. Certify all three:

- not being sold to third parties
- not being used or transferred for any purpose unrelated to the item's single
  purpose
- not being used or transferred to determine creditworthiness or for lending

**Privacy policy URL**

```
https://github.com/thousandflowers/magpie/blob/main/PRIVACY.md
```

---

## Reviewer notes

The field is optional and should not be left empty here. A generic media
downloader that parses HLS and DASH is the shape of extension that gets
rejected for facilitating unauthorised downloads, so lead with the boundary
rather than waiting to be asked:

```
Magpie never circumvents DRM, and the refusal is enforced in code rather than
documented as a policy:

- When a stream declares encryption (#EXT-X-KEY with any method other than
  NONE, or a DASH ContentProtection element), or the page calls
  navigator.requestMediaKeySystemAccess, every affected item is marked
  protected: src/background/service-worker.js.
- The download queue refuses a protected item unconditionally, even when it has
  been selected some other way: src/background/downloader.js.
- Resolution upgrades refuse protected items: src/background/upgrade-verify.js.
- The panel disables the download control and withholds all three stream
  actions on a protected item: src/panel/panel.js.

No key material is requested, stored, parsed or decrypted; no pssh box or
default_KID leaves the parser; no segment is ever decrypted. The stream
features produce a yt-dlp or ffmpeg command and a segment list - the extension
does not download or remux video itself.

Nothing leaves the user's machine. The source tree contains no absolute http(s)
URL: no analytics, no CDN, no web fonts, no server of ours. The only outbound
requests are the files the user selected, the thumbnails the panel draws, and a
HEAD check on a candidate full-size URL - all to the site the media is on.

webRequest is registered as a listener only. There is no webRequestBlocking, no
declarativeNetRequest, and no request is ever blocked, redirected or modified.

The "explore" feature drives the user's own tab and is bounded by construction
(40 pages, 60 clicks, a gap between navigations). It refuses to click anything
transactional or destructive: form controls, anything inside a form, submit
buttons, download attributes, target=_blank, links and anything inside a link.
The rules are in src/core/explore-policy.js and are unit-tested against a set
of traps.
```

---

## Graphic assets

| Asset | Required size | Where it comes from |
|---|---|---|
| Store icon | 128 x 128 | `icons/icon-128.png` |
| Screenshots (1 to 5) | 1280 x 800 | `npm run screenshots:store` -> `docs/store/` |
| Small promo tile | 440 x 280 | Optional; skip unless the listing is being featured. |

The store rejects a screenshot at any other size, which is why the two captures
in `docs/` - taken at the panel's real 400px width - cannot be used as they
are.

---

## After submitting

- Review takes anywhere from a few hours to a couple of weeks. `<all_urls>`
  puts an item in the slower queue.
- A rejection arrives by email naming the policy section. The ones that apply
  here are **Single Purpose**, **Permission Justification** and the
  unauthorised-download clause; the answers above are written to satisfy all
  three.
- The version uploaded must be higher than the published one. `manifest.json`
  and `package.json` have to agree, and the release workflow refuses a tag that
  does not match them.
