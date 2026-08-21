# Decisions

Every open choice in the spec, the decision taken, and one line of reasoning.
Deviations from the spec are marked **[deviation]** and justified.

## Architecture

- **Content scripts are self-contained; `core/` is imported only by the service
  worker and the panel.** Chrome content scripts are classic scripts, and
  `import(chrome.runtime.getURL(...))` is blocked by a strict page CSP on exactly
  the sites Magpie most needs to work on. Both content scripts therefore carry a
  compact media-URL prefilter of their own and send raw evidence; `src/core`
  remains the single authority for classification, normalisation and filtering.
  The alternative — `web_accessible_resources` for the core modules — would also
  have exposed extension internals to every page. **[deviation from §3's "core is
  importable everywhere" implication]**
- **`history.pushState` is wrapped in the MAIN world, not the isolated one.**
  The isolated world has a separate JS context, so a wrapper installed there
  never sees a call made by page code. Verified: hooking it in the isolated world
  silently failed to detect SPA route changes. `popstate`/`hashchange` are real
  DOM events and are still handled in the isolated world.
- **Streams are resolved in the panel, not the service worker.** `DOMParser` does
  not exist in a service worker, so DASH could not be parsed there.
  `parseMPD()` takes an injected parser, which also makes it testable in Node.
- **One extra file: `src/background/upgrade-verify.js`.** The `HEAD` verification
  loop needs `fetch` and the store, so it belongs in the background, but it is
  neither downloading nor observing; giving it its own small module beat bolting
  it onto `downloader.js`.
- **All per-tab state lives in `chrome.storage.session`**, with an in-memory
  cache that is rebuilt from storage on any miss, and a 300 ms debounced
  write-through. Nothing is held only in a module variable.

## The similarity engine

- **Dynamic-class stripping is gated on a hash signal.** **[deviation]** The
  spec's regex `/^[A-Za-z]+[-_][A-Za-z0-9]{5,}$/` also matches hand-written
  classes such as `photo-gallery`, and applying it literally strips the very
  class names that make `structuralSimilarity` work. It is honoured only when the
  token also carries a machine-generated signal: a `css-`/`sc-` prefix, a run of
  six or more hex characters, or a mixed-case-plus-digits tail. This keeps
  `photo-gallery` and strips `ProductCard-module__image___bdVaJa1`. The rule keys
  off shape, never off a list of known class names.
- **The repeated-group signal is symmetric.** **[deviation]** The spec gives
  `+0.15` when both elements sit in a repeated sibling structure. Applied only as
  a bonus, a hero image sharing a host and directory with a 40-item grid still
  links into it at the balanced threshold (0.640 > 0.62), which fails acceptance
  criterion 6. Magpie therefore also subtracts 0.15 when exactly one of the two
  is in a repeated structure — a standalone hero genuinely is not part of the
  grid, and that asymmetry is real signal, not a fudge. Hero-vs-grid then scores
  0.602 and separates; grid-vs-grid is untouched at 1.0.
- **`cluster()` is union-find over the thresholded score matrix.** Linking every
  pair at or above the cut and taking connected components *is* single-linkage
  agglomerative clustering at that height, without building a dendrogram.
- **Clustering is capped at 1200 items per view**, chunked at 12 ms with
  `requestAnimationFrame` between slices. The remainder is shown as an explicit
  "not clustered — over the limit" group and named in the banner: a silent
  truncation would read as "we covered everything".
- **`describeGroup` needs a strict majority** for a dominant dimension. A 50/50
  split of thumbnails and originals was being labelled `150x150`, which is
  misleading; it now says "mixed sizes".

## Detection

- **Junk thresholds live in one object** (`FILTER_CONFIG` in `core/media-types.js`).
- **`srcset` width descriptors beat density descriptors.** When both are present,
  `1200w` is what the user actually wants.
- **A gallery thumbnail wrapped in `<a href="…full.jpg">` reports the link target
  as a separate `referenced` candidate**, which is why the local fixture yields
  12 thumbnails *and* their 12 originals.
- **`<canvas>` and inline `<svg>` are indexed under synthetic `magpie-canvas:` /
  `magpie-svg:` URLs** and captured on demand from the panel. Taint is probed
  cheaply at scan time with a 1×1 `getImageData`; a tainted canvas is marked
  `unavailable` rather than crashing the scan. Capturing every canvas on every
  scan would have been far too expensive.
- **An MSE `blob:` is reported as a stream, not a file**, so the panel never
  offers a link that cannot be fetched.

## Downloads

- **Files are named after the URL actually fetched.** When a verified upgrade
  wins, saving the 800×600 original as `photo-150x150.png` would be a lie.
- **Retry uses a `HEAD` probe.** `chrome.downloads` reports transport failures,
  not HTTP status codes, so the retry path issues a cheap `HEAD` to learn whether
  this is a 429/503 and honours `Retry-After` when present.
- **Path segments collapse runs of dots.** `..` cannot survive anywhere in a
  segment, which makes "the path never escapes the download directory" a property
  that is trivially true rather than argued.
- **The sidecar manifest is written by the panel**, because a service worker has
  no `URL.createObjectURL` and Chrome refuses `data:` URL downloads.
- **`--cookies-from-browser` is only emitted for session-gated stream URLs.**
  Adding it unconditionally makes `yt-dlp` read the browser keychain for nothing
  and can fail outright on a public stream.

## UI

- `chrome.sidePanel` where available, a 480×900 popup window otherwise.
- Light DOM custom elements, not shadow DOM: one stylesheet for the whole dense
  grid instead of one per tile.
- Thumbnails load only when the tile intersects the viewport, and every tile
  reserves its aspect ratio from known dimensions, so nothing shifts as items
  stream in.
- Accent colour is used for selection state and nothing else.

---

# Acceptance criteria

Verified against Chrome for Testing 151 (headless, unpacked load) driven over
CDP, against a local fixture gallery, a 122-image bulk gallery, a live Wikipedia
article and Apple's public HLS test stream.

| # | Criterion | Result |
|---|---|---|
| 1 | `node --test` passes with meaningful assertions | **PASS** — 75 tests, 0 failures, across `similarity`, `url-normalize`, `upgrade-rules` and `pipeline` (filenames, HLS/DASH, HAR, classification). All five required similarity fixtures are covered. |
| 2 | Unpacked load produces no manifest warnings and no service-worker errors | **PASS** — after one real fix: `'imageset'` is not a valid `webRequest` resource type and threw at worker startup, which stopped the worker registering. Now clean; no console errors in any run. |
| 3 | Wikipedia gallery: full-size images found, `/thumb/` upgrade fires, images cluster | **PASS** — live `en.wikipedia.org/wiki/Eurasian_magpie`: 69 items, 35 `/thumb/` URLs; `250px-Eurasian_magpie_2024_03_03_02.jpg` upgraded to the 12,070,770-byte original; commons images clustered into one 16-item group. |
| 4 | WordPress: `-300x200` thumbs upgrade to originals, no double listing | **PASS** — fixture gallery: 12/12 thumbnails `HEAD`-verified to their originals (8 KB → 335 KB), and the merged index lists each URL once. |
| 5 | Infinite scroll: items appear as you scroll, no duplicates, no jumping | **PASS (partial)** — a `MutationObserver` rescan indexes dynamically appended media, and re-appending 20 images with fresh `?utm_source=…&t=…` query strings left the index at 122, unchanged. "No jumping" rests on reserved aspect-ratio boxes and lazy tile reveal; that is a visual property and was not measured. |
| 6 | Hero image plus a 40-item grid: the hero gets its own cluster | **PASS** — asserted in `test/similarity.test.mjs`; hero alone, grid intact at 40. Required the symmetric repeated-group term above. |
| 7 | Public HLS stream: variants listed with bitrates, copied `yt-dlp` command runs | **PASS** — Apple `bipbop_4x3_variant.m3u8` parsed into 5 variants with bitrates and codecs; the generated command ran in a terminal, resolved formats and downloaded 483 KB / 62 of 180 fragments before being stopped on purpose. |
| 8 | DRM player: item marked `protected`, every download control disabled | **PASS** — after the page requested a key system, the video went `protected` ("Encrypted Media Extensions: com.widevine.alpha"), the tile showed the `DRM` badge, the detail drawer's download button was `[DISABLED]`, and a download of 2 items queued 1 and skipped 1. |
| 9 | 100+ items download with correct names and no collisions | **PASS** — 122 selected, 122 queued, 122 complete, 0 interrupted, 122 unique filenames, 0 zero-byte files; two files sharing the basename `clash.png` landed as `121-clash.png` and `122-clash.png`. |
| 10 | Killing the service worker and reopening the panel restores the index | **PASS** — worker terminated via CDP; the reopened panel showed all 35 items in 6 groups, rehydrated from `chrome.storage.session`, with the DRM banner intact. |

## Bugs this verification pass found and fixed

1. `'imageset'` in the `webRequest` type filter threw at worker startup, so the
   service worker never registered and nothing worked. Caught only by running it.
2. `history.pushState` hooked in the isolated world never fired, so SPA route
   changes did not reset the index.
3. `registrableDomain()` destructured the wrong element and returned `co.uk` for
   `a.b.example.co.uk`.
4. Downloaded files were named after the thumbnail while containing the upgraded
   original.
5. `document.title` is empty at `document_start`, so `{title}` fell back to
   `index.html`; the page is now re-reported at `DOMContentLoaded` and `load`.
6. CSS-Modules class names survived stripping, breaking structural similarity on
   styled-component grids.
7. Synthetic `magpie-canvas:` URLs produced junk group labels such as `//m#`.

## Not verified mechanically

- Arc, Dia, Brave and Edge were not launched; the manifest uses no
  Chrome-only surface beyond `chrome.sidePanel`, which has a popup fallback.
- The panel's visual design (dark mode, focus rings, density) was exercised in a
  headless browser, so it was not looked at by a human.
- HAR import is unit-tested against a synthetic HAR, not a browser-exported one.
- No DASH stream with real `ContentProtection` was fetched; that path is covered
  by a unit test with an injected parser.

---

# Follow-up pass

Four bounded tasks. Nothing outside them was touched.

## 1. DASH `ContentProtection` — PASS

Previously the DASH protected branch had never executed. It now has two
hand-written manifests in `test/fixtures/dash.mjs`: `PROTECTED_MPD` carries a
Widevine `ContentProtection` (`urn:uuid:edef8ba9-…`) plus the `mp4protection`
descriptor with a `cenc:default_KID`; `CLEAN_MPD` is the same document with
those elements removed. A test asserts the two are byte-identical once
`ContentProtection` is stripped, so any behavioural difference is attributable
to it alone.

Node has no `DOMParser`, and Magpie takes no dependencies, so
`test/fixtures/mini-xml.mjs` is a ~55-line test-only XML parser exposing the
four DOM methods `parseMPD` uses. It is not a general-purpose XML parser and
does not pretend to be.

- `test/dash-protection.test.mjs` (12 tests, in `node --test`): protected →
  `encrypted`, `encryptionMethod: 'CENC'`, `drmSystems: ['widevine']`, item
  status `protected`; the **real download queue** refuses it (`total: 0,
  skipped: 1`) alone and alongside a downloadable image (`total: 1, skipped:
  1`). Clean → not encrypted, 3 variants sorted by bitrate, 1 audio track,
  duration 630 s. One test asserts the parser carries no `pssh` and no
  `default_KID` out of the manifest.
- `test/browser/dash-protection.mjs` (18 assertions, `npm run test:dash`):
  the manifests are fed to the **actual panel** in Chrome rather than to a
  restatement of its logic, and the controls are read back out of the DOM.
  Protected: item marked `protected`, `DRM` badge, "DRM protected — not
  downloadable", key system named, **none of the three stream actions
  offered**, download control disabled, zero shell commands generated, zero
  variants listed. Clean: 3 variants with resolutions, all three actions
  present and enabled, both commands generated. No console errors.

## 2. Repeated-group penalty — FAILED as suspected, then fixed

The suspicion was correct. A 3-slide hero carousel above a 40-item product
grid (`carouselHeroPlusGrid`, same host, same directory, same file type) puts
the hero **inside** a repeated structure, so the boolean "is in some repeated
group" test cannot separate them — it awards no penalty at all.

The term now keys on repeated-group **identity**: the DOM scanner reports
`repeatDepth`, the index in the structural path of the node whose siblings
repeat, and the engine derives a group key from that node plus its ancestors.
Two cells of one grid share a key; a carousel slide and a grid cell do not.
When the two keys differ — or one element is repeated and the other is not —
the structural term returns **0** rather than being nudged by −0.15: different
templates mean the ancestry they share is page chrome (`body > main > …`), not
evidence of belonging to the same set. Items with no `repeatDepth` (HAR
imports, older scans) report an unknown key and keep the previous lenient
behaviour.

Threshold 0.62 (balanced). "old" is the boolean ±0.15 rule; "new" is identity:

| Fixture | old | new |
|---|---|---|
| A. standalone hero vs grid (`heroPlusGrid`) | 0.6021 **pass**, margin 0.018 | **0.5458 pass**, margin 0.074 |
| B. carousel slide vs grid, 1440×600 vs 800×800 | 0.6497 **FAIL** | **0.5782 pass**, margin 0.042 |
| C. carousel slide vs grid, 1200×800 vs 900×800 | 0.6839 **FAIL** | **0.6125 pass**, margin 0.008 |

Controls: two carousel slides 1.0000, two grid cells 1.0000 — the change costs
nothing within a group. The original fixture's margin roughly quadrupled, which
is the evidence that the old rule was tuned to it rather than correct.

Case C is kept as an explicit sensitivity test. With structure zeroed the
remaining terms total 0.4625 (url 0.75, type 1, host 1), so the dimension term
alone decides the headroom: at genuinely identical dimensions the two sets
would score 0.6625 and merge. That is a real limit of the current weights, not
something the repeated-group term can fix, and it is recorded rather than
papered over.

## 3. Dynamic-class detection by cardinality — PASS

The DOM scan now counts every class in the document in one cheap pass (no
computed styles) and attaches the counts for the classes on each candidate's
own path. A class is treated as dynamic only when it is **both** high-entropy
and on ≤ 2 elements. Entropy is Shannon entropy over the token's alphanumerics
adjusted for mixed case, digits and vowel scarcity — a measure, not a shape
match. The old regex heuristic is retained and used per-token whenever the map
has nothing to say about that class, which is what HAR-sourced and
network-only items get.

Measured in a real browser on the fixture gallery: `grid-thumb` 12,
`grid-item` 12, `icon` 5, `hero-image` 1, `photo-grid` 1, `gallery` 1. The
frequent classes are kept on frequency alone; the rare ones are kept because
their entropy is below threshold — which is the case the frequency rule on its
own would have got wrong. `repeatDepth` came back 2 for grid thumbnails
(`li.grid-item`), 1 for toolbar icons (`button.toolbar-button`), −1 for the
hero. No console errors.

**All existing similarity tests pass unchanged** — they supply no counts, so
they exercise the fallback. Total is now 98 tests, 0 failures.

## 4. Service-worker smoke test — PASS

`test/browser/service-worker.smoke.mjs` (~40 lines on a shared harness) loads
the unpacked extension in Chrome for Testing, waits for the service-worker
target, asserts the worker's `chrome.*` APIs are live, and fails on any console
error or uncaught exception. Wired as `npm test` → `node --test && node
test/browser/service-worker.smoke.mjs`.

**Verified that it can fail**: reintroducing the original `'imageset'` value in
the `webRequest` type filter made it exit 1 with the exact startup TypeError,
then it passed again once reverted. A smoke test that cannot fail is worthless,
so this was checked rather than assumed.

It skips with a notice (exit 0) when no Chromium is found, so `npm test` works
on a machine without one. CI must set `CHROME_PATH` for the check to actually
run — otherwise this whole class of bug is invisible again.

## Bugs found during this pass

1. `test/browser/harness.mjs` initially derived the extension path from
   `URL.pathname`, which percent-encodes the space in the project directory
   name; Chrome silently failed to load the extension and the smoke test
   reported "service worker never registered". Fixed with `fileURLToPath`.
   Worth noting because the failure looked exactly like a real regression.

## Files added or changed

Added: `package.json`, `test/dash-protection.test.mjs`,
`test/fixtures/dash.mjs`, `test/fixtures/mini-xml.mjs`,
`test/browser/harness.mjs`, `test/browser/service-worker.smoke.mjs`,
`test/browser/dash-protection.mjs`.
Changed: `src/core/similarity.js` (tasks 2 and 3), `src/content/isolated.js`
(`repeatDepth`, class frequency map), `src/shared/messages.js` and
`src/background/store.js` (carry the two new fields),
`test/fixtures/pages.mjs` and `test/similarity.test.mjs` (new fixture and
tests), `README.md` (test command only).

---

# Third pass — structural evidence, and a duplicate that criterion 4 missed

## The structural term now has three states

`structuralSimilarity` previously returned `0` for two unrelated situations:
"these elements sit in different repeated groups" (a finding) and "one of these
items has no DOM at all" (no finding). Conflating them punished every
network-only and HAR-sourced item for evidence it could never have had.

| state | value | meaning |
|---|---|---|
| both paths present, same repeated group | `common / longer` (+0.15 when close) | measured |
| both paths present, different repeated groups | `0` | known different templates |
| either path missing | `NEUTRAL_STRUCTURE` = `0.5` | nothing known — same reasoning as `dimensionSimilarity` |

Only pairs missing structure moved; both hero separations are untouched, so the
change does not erode the repeated-group work:

| pair | before | after |
|---|---|---|
| network-only vs network-only (hashed CDN) | 0.5400 separate | **0.6650 clusters** |
| DOM grid cell vs network-only sibling | 0.5625 separate | **0.6875 clusters** |
| WordPress thumbnail vs its full-size original | 0.5298 separate | **0.6548 clusters** |
| standalone hero vs grid | 0.5458 | unchanged |
| carousel slide vs grid | 0.5782 | unchanged |

Three existing tests encoded the old philosophy and were rewritten to assert the
new one. `mixedEvidenceGrid` covers it directly: one grid, some cells scanned
and some seen only by the network observer, clustering as one group. The test
also asserts that a hard `0` would have split them, so it fails if the old rule
returns.

## Repeated-group re-keying (second pass, recorded here in full)

The boolean "is in some repeated structure" rule was tuned to its own fixture.
A 3-slide hero carousel above a 40-item product grid puts the hero *inside* a
repeated structure, so the boolean test awards no penalty at all and the two
merge. The term now keys on group **identity**: the scanner reports
`repeatDepth`, the index in the structural path of the node whose siblings
repeat, and the engine derives a key from that node plus its ancestors.

Threshold 0.62. "old" is the boolean ±0.15 rule, "new" is identity:

| fixture | old | new |
|---|---|---|
| standalone hero vs grid | 0.6021 pass, margin 0.018 | **0.5458 pass**, margin 0.074 |
| carousel slide vs grid, 1440×600 vs 800×800 | 0.6497 **FAIL** | **0.5782 pass**, margin 0.042 |
| carousel slide vs grid, 1200×800 vs 900×800 | 0.6839 **FAIL** | **0.6125 pass**, margin 0.008 |
| controls: slide-vs-slide, cell-vs-cell | 1.0000 | 1.0000 |

The original fixture's margin roughly quadrupling is the evidence the old rule
was fitted rather than correct.

## Cardinality replaces shape for dynamic classes

The DOM scan counts every class in the document in one cheap pass and attaches
the counts for the classes on each candidate's own path. A class is dynamic only
when it is **both** high-entropy and on ≤ 2 elements. Entropy is Shannon entropy
over the token's alphanumerics adjusted for mixed case, digits and vowel
scarcity — a measurement, not a shape match. The old regex survives as a
per-token fallback wherever the map says nothing, which is what HAR-sourced and
network-only items get, so every pre-existing similarity test passes unchanged.

Measured in a real browser: `grid-thumb` 12, `grid-item` 12, `icon` 5,
`hero-image` 1, `photo-grid` 1. The frequent classes are acquitted by frequency;
the rare ones survive because their entropy is low — the exact case frequency
alone would have got wrong.

## The 0.6625 weights limit

With the structural term zeroed, the other four terms floor at **0.4625** for
two images sharing a host, a directory and a file type (url 0.75, type 1,
host 1). The dimension term alone carries the rest of the way to 0.62, so at
identical dimensions a hero and a grid score **0.6625** and merge at `balanced`;
`strict` separates them. This is a property of the weights, not of the
repeated-group test, and it is kept as a sensitivity test rather than tuned
away. Documented in the README's "what this does not do".

## Acceptance criterion 4 was passing on a technicality

Asked directly whether the upgrade pipeline deduped a WordPress thumbnail
against its own full-size original, the answer was **no**. Each *URL* appeared
once, which is what the earlier report checked, but each *asset* appeared twice:
the thumbnail (from the grid) and the original (from its `<a href>`). Measured
on the fixture gallery: 12 collisions, and selecting 3 thumbnail/original pairs
queued **6** downloads of 3 images. The neutral-structure change made this
worse by clustering the pair at 0.6548, so "download all similar" would have
saved everything twice.

`collapseUpgradeDuplicates` now groups items by the URL that would actually be
fetched — the verified upgrade target, or the item's own URL — and folds each
group down to one survivor, preferring the item that has DOM structure because
it is the one on screen and it carries the grid context clustering needs.
Grouping by effective URL catches both shapes of the bug: thumbnail-vs-original,
and two thumbnail sizes of one asset. After the fix, on the same page: 34 → 22
items, 0 collisions, and "select all similar" from a thumbnail selects 12,
queues 12, saves 12 unique files, each named after the original.

## Panel screenshot harness

`test/browser/panel-screenshots.mjs` seeds a tab index straight into
`chrome.storage.session`, opens `panel.html` at 400px, and writes six PNGs to
`test/screenshots/`. It asserts nothing and is not part of `npm test`. Two
things about the images are synthetic and are stated in the file header and the
README caption: the tiles are painted with flat SVG placeholders because the
fixture hosts do not exist, and the viewport is grown to fit the panel's
internal scroller. Everything else — layout, metadata, clustering, selection,
dark mode — is the real panel.

## `node --test` was running the browser scripts

Node's default test glob is `**/test/**/*.mjs`, so `npm test` was also executing
`harness.mjs`, the DASH browser check and the screenshot harness: three browser
launches and a set of PNGs written as a side effect of the unit tests, 36
seconds instead of 0.1. The scripts are now selected explicitly with
`node --test "test/*.test.mjs"` (94 tests, 125 ms) and the browser checks run
only from their own npm scripts.

## CI

`.github/workflows/test.yml` runs Node LTS + `browser-actions/setup-chrome`,
exports `CHROME_PATH` and runs `npm test`. GitHub sets `CI`, which makes the
smoke test refuse to skip. Verified end to end by reintroducing the original
`'imageset'` value with `CI=true`: `npm test` exited 1 on the startup
TypeError, and 0 again once reverted. `--no-sandbox` is passed only when `CI` is
set, so the local sandbox stays on.

## Publication

MIT `LICENSE`; `.gitignore` covering `test/screenshots/`, `node_modules`,
`.DS_Store`; `package.json` at version 0.1.0 with description, keywords,
repository and license. `docs/panel.png` is the committed copy of screenshot 3
used as the README hero — the screenshots directory itself is ignored, so a
fresh clone would otherwise render a broken image.

**Known inconsistency, left alone:** `package.json` is 0.1.0 as instructed while
`manifest.json` still declares `"version": "1.0.0"`. Two version numbers now
disagree; whichever is wrong should be changed before a first release.

---

# Fourth pass — three small corrections

- **`manifest.json` version aligned to 0.1.0.** The two version numbers no
  longer disagree; the inconsistency flagged at the end of the third pass is
  closed.

- **README hero swapped to the cluster shot** (400 x 805). The bulk shot is
  400 x 2873, a 1:7 aspect that renders as a wall in a README, so it is linked
  rather than embedded. It still earns a mention — it is the clearest evidence
  of the tool working at scale — just not as an inline image.

- **The variants table is no longer a table at 400px.** Five columns of stream
  metadata could only be read by scrolling sideways, which is the wrong
  interaction in a side panel. CSS re-lays the rows as stacked blocks:
  resolution as the line header, then bitrate / codec / size as label-value
  rows beneath. The markup is untouched, so the column labels now live in CSS
  keyed to cell position (`td:nth-child(3)::before` and friends) and the header
  row is hidden. That coupling was the cost of keeping the change CSS-only, and
  it has since been removed — see below.

- **The detail drawer wraps instead of overflowing.** The cause was
  `min-width: auto` on grid and flex children: one long value — a `saves as`
  path, a signed URL — widened the whole drawer past the panel, so the action
  row had room and never wrapped. `min-width: 0` on the drawer, its children,
  the definition lists and the URL comparison lets values shrink and wrap, and
  the action row then wraps as it was always meant to.

Screenshots regenerated. The harness now sums the fixed sections rather than
deriving the body height from `clientHeight`, so a tall detail drawer can no
longer squeeze the item list out of the frame, and it prints the measured
horizontal overflow beside each shot. All six report **0px**.

---

# Fifth pass — the label coupling is gone

`VARIANT_COLUMNS` in `panel.js` is now the single definition of a stream
variant's columns. The hidden header row and the cells are both generated from
it, each cell carrying `data-field` (what it is) and, for the three that stack
under the resolution, `data-label` (what to call it). The stylesheet keys off
those attributes — `td[data-field="resolution"]` for the line header,
`td[data-label]::before { content: attr(data-label) }` for the rest — so no rule
counts columns any more.

Verified by reordering the array to `size, codec, bitrate` and reading the
rendered rows back out of the DOM:

```
1920x1080 | size — | codec avc1.640028 | bitrate 6000 kbps
640x360   | size — | codec avc1.4d401e | bitrate 800 kbps
```

Every label stayed with its own value. Under the previous position-keyed CSS the
same reorder would have rendered `size 6000 kbps`. Table overflow stayed at 0px,
and the shipped order was restored afterwards.

Screenshot 04 regenerated; it renders identically to the position-keyed version,
which is the point — this was a maintainability fix, not a visual one. Shots 02
and 03 came back byte-identical, so the committed README images needed no
update.

---

# Sixth pass — HAR import saves from the capture, not from the network

The module header claimed HAR import existed "because HAR entries keep response
bodies the live page has already thrown away". It did not read those bodies:
`parseHar` looked only at `content.mimeType` and `content.size`, and every
download re-fetched the URL. That made the feature useless in exactly the case
it was written for — an expired signed URL, a session behind a login, a file
taken down.

`decodeHarBody()` now reads `response.content.text`, honouring
`encoding: "base64"` for binary bodies and treating anything else as UTF-8. A
capture exported without content still imports; it simply has no bytes and falls
back to the network, which is reported rather than hidden.

**The bytes never enter the store.** `chrome.storage.session` has a quota and a
capture can be hundreds of megabytes, so `parseHar` returns them in a separate
`Map` that the panel holds in memory for as long as it is open; the item carries
only a `harBody` boolean. Per-file and per-import budgets (64 MB / 512 MB) keep
one oversized response from eating the import.

Downloads split three ways: canvas and SVG captures, HAR bodies, and things that
genuinely need fetching. Only the last goes to the background queue.

Verified with the HTTP server **stopped**, so nothing could have come from the
network: a HAR holding three images plus one control entry exported without a
body.

```
import  : HAR: merged 4 new, 0 updated, 0 skipped, 3 with bodies (984 KB) saveable offline
footer  : 3 saved locally · 0/1 fetched, 1 failed
  001-beach-01.png  complete     335815
  002-beach-02.png  complete     335807
  003-beach-03.png  complete     335806
  001-beach-04.png  interrupted  0  NETWORK_FAILED   <- the control, no body in the capture
```

The three byte counts match the originals exactly, and the control failed as it
should. That contrast is the test: with the server down, a file can only have
come from the capture.

One honesty fix fell out of it. The progress line read `0/1 saved, 1 failed`
while three files had just been written, because local saves are not part of the
background queue and the queue owns that message. Every progress line now
carries the local count, and "saved" became "fetched" where it means fetched.

---

# Seventh pass — the explorer

Automatic exploration: scroll a page, click the controls that reveal more
media, follow same-origin links, and keep the index across the whole walk.

## The asymmetry that makes it safe

Scrolling and following links are GET-shaped and reversible, so they are
exhaustive. Clicking is not: on an app where the user is signed in, an
indiscriminate clicker eventually hits "Delete", "Pay" or "Log out". So the two
are governed differently, and **a click needs a positive reason** —
`src/core/explore-policy.js` refuses by default and only approves a control that
either wraps media or reads as a media control.

Refused outright, whatever the label says: form controls, anything inside a
`<form>`, submit buttons, `download` attributes, `target="_blank"`, and any
accessible text or class token matching the transactional/destructive list
(English and Italian). A `<a href>` is never clicked — it is queued for
navigation instead, where `shouldFollow` applies the same word list to the path,
because `/logout` is a GET on most sites.

**The word lists are a real limitation**, not a flourish: lexical, two
languages, and an icon-only control labelled in a third will simply not be
clicked. That is the safe direction to fail in, and they sit in one exported
object so a locale is a data change.

## Where the decision lives

Content scripts cannot import extension modules, so duplicating the rules in the
page would mean two copies of the one thing that must never drift.
`src/content/explorer.js` therefore makes no decisions at all: it describes
candidate elements, ships the descriptions to the worker, and clicks back the
indexes it is handed. One message per round, not per element.

Crawl state lives in `chrome.storage.session` under `crawl:<tabId>`, so a worker
restart mid-walk keeps the queue. While a crawl owns a tab the index is **not**
reset on navigation — wiping it on each hop would throw away exactly what the
walk went to collect.

Bounded by construction: 40 pages, 60 clicks and 40 scroll steps per page, a
1.2 s gap between navigations, two dry rounds before a page is called done, and
a stop that reaches both the queue and the page.

## Verified against a two-page fixture app

Page 1 held two visible thumbnails, a "Mostra altre foto" button revealing four
more, an "Ingrandisci" button opening a lightbox, a link to page 2 — and four
traps: `Elimina account`, `Paga ora`, a submit button inside a form labelled
*"Mostra altre foto"* (media wording, dangerous shape), and an `Esci` link. Each
trap recorded a click in `localStorage`.

```
fine: pages 2, clicks 2, queued 0, note "nothing left to visit"
indicizzati: 10
  beach-01..06 (2 visibili + 4 dietro al bottone)
  beach-07..09 (pagina 2)
  hero-banner   (dentro il lightbox)
bottoni distruttivi cliccati: NESSUNO
```

Everything hidden behind a click or a second page was found; the form-shaped
button with media wording was refused on shape before its label was even read.

One bug found and fixed in the same pass: `pageFinished` incremented the page
counter in memory and then called `stopCrawl`, which re-reads from storage — so
a finished crawl reported one page fewer than it had visited. The counters are
now persisted before any branch that stops.
