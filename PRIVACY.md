# Privacy policy

**Magpie collects nothing.**

That is the whole policy. The rest of this page is the evidence for it, because
an extension that asks for `<all_urls>` should not expect to be taken at its
word.

## No data leaves your machine

Magpie has no server, no account, no analytics, no crash reporting, no
telemetry, no update ping of its own and no remote configuration. It contacts
no host that you have not pointed it at.

The only network requests it makes are these three, and each goes to the site
the media is on, never anywhere else:

1. **Downloading what you selected.** A `GET` for each file, started by your
   click. Nothing is ever fetched automatically.
2. **Checking a full-size URL before offering it.** A `HEAD` request that reads
   the status, content type and length, then throws the response away.
3. **Fetching a stream manifest** (`.m3u8`, `.mpd`) so its variants can be
   listed. Parsed in the browser; nothing is uploaded.

It ships with no CDN reference, no web font and no third-party script. You can
check that yourself: `npm run package` refuses to build if a remote script,
stylesheet or font URL appears anywhere in the extension's source.

## What is stored, and where

Everything stays in your own browser profile.

| What | Where | Lifetime |
|---|---|---|
| The media found in a tab: URLs, dimensions, file types, which layer saw each one | `chrome.storage.session` | Cleared when you close the tab or quit the browser. |
| Your settings: similarity threshold, filename template, whether to write a sidecar file | `chrome.storage.local` | Until you remove the extension. |
| The files you download | Your Downloads folder, through Chrome's own download manager | Yours. |

Nothing in either store is transmitted, synced or shared. Removing the
extension removes both.

## What Magpie can see, and what it does with it

`<all_urls>` is a broad permission and it is fair to ask why.

Magpie reads the page you are on: the `<img>`, `<video>`, `<audio>`, `<canvas>`
and `<svg>` elements, their lazy-loading attributes, CSS background images,
gallery links, and the URLs of the media requests the page makes. It needs this
on any site because "any site" is where media is.

It does **not** read or transmit form fields, passwords, cookies, page text,
browsing history, or anything you type. It does not request the `cookies`,
`history`, `bookmarks`, `tabs`, `management` or `debugger` permissions, so it
cannot reach those even if it tried. The `webRequest` listener is observe-only:
it never blocks, redirects or rewrites a request, which is why
`webRequestBlocking` and `declarativeNetRequest` are absent too.

What it does read stays in the session index above, and serves one purpose:
showing you the media so you can download it.

## Sensitive sites

Magpie runs on every page because media is on every page, including ones you
would rather it did not see. If that matters, Chrome lets you restrict any
extension per site: `chrome://extensions` -> Magpie -> **Details** -> **Site
access** -> *On specific sites*. Magpie works normally under that restriction;
it simply sees nothing elsewhere.

## Children

Magpie has no accounts, no content of its own and no social features. It is not
directed at children and collects no information from anyone.

## DRM

Magpie never circumvents DRM. When a stream declares encryption the media is
marked protected and its download is refused. No key material is requested,
stored, parsed or decrypted. The README has the detail.

## Changes

This file is versioned in the repository, so every change to it carries a date
and a diff:
<https://github.com/thousandflowers/magpie/commits/main/PRIVACY.md>

## Contact

Open an issue: <https://github.com/thousandflowers/magpie/issues>
