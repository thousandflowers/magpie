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
  The alternative - `web_accessible_resources` for the core modules - would also
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
  is in a repeated structure - a standalone hero genuinely is not part of the
  grid, and that asymmetry is real signal, not a fudge. Hero-vs-grid then scores
  0.602 and separates; grid-vs-grid is untouched at 1.0.
- **`cluster()` is union-find over the thresholded score matrix.** Linking every
  pair at or above the cut and taking connected components *is* single-linkage
  agglomerative clustering at that height, without building a dendrogram.
- **Clustering is capped at 1200 items per view**, chunked at 12 ms with
  `requestAnimationFrame` between slices. The remainder is shown as an explicit
  "not clustered - over the limit" group and named in the banner: a silent
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
| 1 | `node --test` passes with meaningful assertions | **PASS** - 75 tests, 0 failures, across `similarity`, `url-normalize`, `upgrade-rules` and `pipeline` (filenames, HLS/DASH, HAR, classification). All five required similarity fixtures are covered. |
| 2 | Unpacked load produces no manifest warnings and no service-worker errors | **PASS** - after one real fix: `'imageset'` is not a valid `webRequest` resource type and threw at worker startup, which stopped the worker registering. Now clean; no console errors in any run. |
| 3 | Wikipedia gallery: full-size images found, `/thumb/` upgrade fires, images cluster | **PASS** - live `en.wikipedia.org/wiki/Eurasian_magpie`: 69 items, 35 `/thumb/` URLs; `250px-Eurasian_magpie_2024_03_03_02.jpg` upgraded to the 12,070,770-byte original; commons images clustered into one 16-item group. |
| 4 | WordPress: `-300x200` thumbs upgrade to originals, no double listing | **PASS** - fixture gallery: 12/12 thumbnails `HEAD`-verified to their originals (8 KB → 335 KB), and the merged index lists each URL once. |
| 5 | Infinite scroll: items appear as you scroll, no duplicates, no jumping | **PASS (partial)** - a `MutationObserver` rescan indexes dynamically appended media, and re-appending 20 images with fresh `?utm_source=…&t=…` query strings left the index at 122, unchanged. "No jumping" rests on reserved aspect-ratio boxes and lazy tile reveal; that is a visual property and was not measured. |
| 6 | Hero image plus a 40-item grid: the hero gets its own cluster | **PASS** - asserted in `test/similarity.test.mjs`; hero alone, grid intact at 40. Required the symmetric repeated-group term above. |
| 7 | Public HLS stream: variants listed with bitrates, copied `yt-dlp` command runs | **PASS** - Apple `bipbop_4x3_variant.m3u8` parsed into 5 variants with bitrates and codecs; the generated command ran in a terminal, resolved formats and downloaded 483 KB / 62 of 180 fragments before being stopped on purpose. |
| 8 | DRM player: item marked `protected`, every download control disabled | **PASS** - after the page requested a key system, the video went `protected` ("Encrypted Media Extensions: com.widevine.alpha"), the tile showed the `DRM` badge, the detail drawer's download button was `[DISABLED]`, and a download of 2 items queued 1 and skipped 1. |
| 9 | 100+ items download with correct names and no collisions | **PASS** - 122 selected, 122 queued, 122 complete, 0 interrupted, 122 unique filenames, 0 zero-byte files; two files sharing the basename `clash.png` landed as `121-clash.png` and `122-clash.png`. |
| 10 | Killing the service worker and reopening the panel restores the index | **PASS** - worker terminated via CDP; the reopened panel showed all 35 items in 6 groups, rehydrated from `chrome.storage.session`, with the DRM banner intact. |

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

## 1. DASH `ContentProtection` - PASS

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
  Protected: item marked `protected`, `DRM` badge, "DRM protected - not
  downloadable", key system named, **none of the three stream actions
  offered**, download control disabled, zero shell commands generated, zero
  variants listed. Clean: 3 variants with resolutions, all three actions
  present and enabled, both commands generated. No console errors.

## 2. Repeated-group penalty - FAILED as suspected, then fixed

The suspicion was correct. A 3-slide hero carousel above a 40-item product
grid (`carouselHeroPlusGrid`, same host, same directory, same file type) puts
the hero **inside** a repeated structure, so the boolean "is in some repeated
group" test cannot separate them - it awards no penalty at all.

The term now keys on repeated-group **identity**: the DOM scanner reports
`repeatDepth`, the index in the structural path of the node whose siblings
repeat, and the engine derives a group key from that node plus its ancestors.
Two cells of one grid share a key; a carousel slide and a grid cell do not.
When the two keys differ - or one element is repeated and the other is not -
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

Controls: two carousel slides 1.0000, two grid cells 1.0000 - the change costs
nothing within a group. The original fixture's margin roughly quadrupled, which
is the evidence that the old rule was tuned to it rather than correct.

Case C is kept as an explicit sensitivity test. With structure zeroed the
remaining terms total 0.4625 (url 0.75, type 1, host 1), so the dimension term
alone decides the headroom: at genuinely identical dimensions the two sets
would score 0.6625 and merge. That is a real limit of the current weights, not
something the repeated-group term can fix, and it is recorded rather than
papered over.

## 3. Dynamic-class detection by cardinality - PASS

The DOM scan now counts every class in the document in one cheap pass (no
computed styles) and attaches the counts for the classes on each candidate's
own path. A class is treated as dynamic only when it is **both** high-entropy
and on ≤ 2 elements. Entropy is Shannon entropy over the token's alphanumerics
adjusted for mixed case, digits and vowel scarcity - a measure, not a shape
match. The old regex heuristic is retained and used per-token whenever the map
has nothing to say about that class, which is what HAR-sourced and
network-only items get.

Measured in a real browser on the fixture gallery: `grid-thumb` 12,
`grid-item` 12, `icon` 5, `hero-image` 1, `photo-grid` 1, `gallery` 1. The
frequent classes are kept on frequency alone; the rare ones are kept because
their entropy is below threshold - which is the case the frequency rule on its
own would have got wrong. `repeatDepth` came back 2 for grid thumbnails
(`li.grid-item`), 1 for toolbar icons (`button.toolbar-button`), −1 for the
hero. No console errors.

**All existing similarity tests pass unchanged** - they supply no counts, so
they exercise the fallback. Total is now 98 tests, 0 failures.

## 4. Service-worker smoke test - PASS

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
run - otherwise this whole class of bug is invisible again.

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

# Third pass - structural evidence, and a duplicate that criterion 4 missed

## The structural term now has three states

`structuralSimilarity` previously returned `0` for two unrelated situations:
"these elements sit in different repeated groups" (a finding) and "one of these
items has no DOM at all" (no finding). Conflating them punished every
network-only and HAR-sourced item for evidence it could never have had.

| state | value | meaning |
|---|---|---|
| both paths present, same repeated group | `common / longer` (+0.15 when close) | measured |
| both paths present, different repeated groups | `0` | known different templates |
| either path missing | `NEUTRAL_STRUCTURE` = `0.5` | nothing known - same reasoning as `dimensionSimilarity` |

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
scarcity - a measurement, not a shape match. The old regex survives as a
per-token fallback wherever the map says nothing, which is what HAR-sourced and
network-only items get, so every pre-existing similarity test passes unchanged.

Measured in a real browser: `grid-thumb` 12, `grid-item` 12, `icon` 5,
`hero-image` 1, `photo-grid` 1. The frequent classes are acquitted by frequency;
the rare ones survive because their entropy is low - the exact case frequency
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
fetched - the verified upgrade target, or the item's own URL - and folds each
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
internal scroller. Everything else - layout, metadata, clustering, selection,
dark mode - is the real panel.

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
used as the README hero - the screenshots directory itself is ignored, so a
fresh clone would otherwise render a broken image.

**Known inconsistency, left alone:** `package.json` is 0.1.0 as instructed while
`manifest.json` still declares `"version": "1.0.0"`. Two version numbers now
disagree; whichever is wrong should be changed before a first release.

---

# Fourth pass - three small corrections

- **`manifest.json` version aligned to 0.1.0.** The two version numbers no
  longer disagree; the inconsistency flagged at the end of the third pass is
  closed.

- **README hero swapped to the cluster shot** (400 x 805). The bulk shot is
  400 x 2873, a 1:7 aspect that renders as a wall in a README, so it is linked
  rather than embedded. It still earns a mention - it is the clearest evidence
  of the tool working at scale - just not as an inline image.

- **The variants table is no longer a table at 400px.** Five columns of stream
  metadata could only be read by scrolling sideways, which is the wrong
  interaction in a side panel. CSS re-lays the rows as stacked blocks:
  resolution as the line header, then bitrate / codec / size as label-value
  rows beneath. The markup is untouched, so the column labels now live in CSS
  keyed to cell position (`td:nth-child(3)::before` and friends) and the header
  row is hidden. That coupling was the cost of keeping the change CSS-only, and
  it has since been removed - see below.

- **The detail drawer wraps instead of overflowing.** The cause was
  `min-width: auto` on grid and flex children: one long value - a `saves as`
  path, a signed URL - widened the whole drawer past the panel, so the action
  row had room and never wrapped. `min-width: 0` on the drawer, its children,
  the definition lists and the URL comparison lets values shrink and wrap, and
  the action row then wraps as it was always meant to.

Screenshots regenerated. The harness now sums the fixed sections rather than
deriving the body height from `clientHeight`, so a tall detail drawer can no
longer squeeze the item list out of the frame, and it prints the measured
horizontal overflow beside each shot. All six report **0px**.

---

# Fifth pass - the label coupling is gone

`VARIANT_COLUMNS` in `panel.js` is now the single definition of a stream
variant's columns. The hidden header row and the cells are both generated from
it, each cell carrying `data-field` (what it is) and, for the three that stack
under the resolution, `data-label` (what to call it). The stylesheet keys off
those attributes - `td[data-field="resolution"]` for the line header,
`td[data-label]::before { content: attr(data-label) }` for the rest - so no rule
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
which is the point - this was a maintainability fix, not a visual one. Shots 02
and 03 came back byte-identical, so the committed README images needed no
update.

---

# Sixth pass - HAR import saves from the capture, not from the network

The module header claimed HAR import existed "because HAR entries keep response
bodies the live page has already thrown away". It did not read those bodies:
`parseHar` looked only at `content.mimeType` and `content.size`, and every
download re-fetched the URL. That made the feature useless in exactly the case
it was written for - an expired signed URL, a session behind a login, a file
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

# Seventh pass - the explorer

Automatic exploration: scroll a page, click the controls that reveal more
media, follow same-origin links, and keep the index across the whole walk.

## The asymmetry that makes it safe

Scrolling and following links are GET-shaped and reversible, so they are
exhaustive. Clicking is not: on an app where the user is signed in, an
indiscriminate clicker eventually hits "Delete", "Pay" or "Log out". So the two
are governed differently, and **a click needs a positive reason** -
`src/core/explore-policy.js` refuses by default and only approves a control that
either wraps media or reads as a media control.

Refused outright, whatever the label says: form controls, anything inside a
`<form>`, submit buttons, `download` attributes, `target="_blank"`, and any
accessible text or class token matching the transactional/destructive list
(English and Italian). A `<a href>` is never clicked - it is queued for
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
reset on navigation - wiping it on each hop would throw away exactly what the
walk went to collect.

Bounded by construction: 40 pages, 60 clicks and 40 scroll steps per page, a
1.2 s gap between navigations, two dry rounds before a page is called done, and
a stop that reaches both the queue and the page.

## Verified against a two-page fixture app

Page 1 held two visible thumbnails, a "Mostra altre foto" button revealing four
more, an "Ingrandisci" button opening a lightbox, a link to page 2 - and four
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
counter in memory and then called `stopCrawl`, which re-reads from storage - so
a finished crawl reported one page fewer than it had visited. The counters are
now persisted before any branch that stops.

---

# Eighth pass - a real run finds what reading cannot

The panel had been looked at as screenshots and the pipeline reasoned about;
this pass loaded the unpacked extension into Chrome, pointed it at a page and
read everything back out of the actual panel. `test/browser/e2e.mjs` is that
run, kept: 38 assertions, in `npm test`, against a gallery that
`test/fixtures/gallery-server.mjs` serves from the test process (every image is
generated noise, so an original is always bigger than its thumbnail and nothing
binary is committed). Version 0.1.1.

## CI had been red on every run since the first commit

`browser-actions/setup-chrome@v1` installed branded Google Chrome 151 on the
runner. Branded Chrome 137 and later ignores `--load-extension` without a word,
so the worker never registered and the smoke test failed exactly the way a real
regression would. Locally the harness found Chrome for Testing and passed,
which is why nobody noticed. The workflow now uses `setup-chrome@v2` (Chrome for
Testing for the channel names) and refuses to continue unless `--version` says
"for Testing"; the smoke test prints the target list and Chrome's stderr when
the worker is missing, so the next silent failure explains itself.

## Bugs the run found, all fixed

1. **Any iframe reset the tab and renamed the page.** The content script sent
   its document_start `PAGE_INFO` from every frame, and the worker treated each
   as a navigation: an ad or an embed arriving late wiped the index and set
   `pageUrl` to the frame's URL, so downloads landed under
   `magpie/host/frame.html/`. Only the top document reports now, and the worker
   ignores page messages from `frameId > 0` regardless.
2. **The navigation reset raced the network batch.** The reset came from the
   page's document_start message, which travels through the renderer; the
   `webRequest` events come from the browser. Their order is not defined, and
   in traces the reset landed after the first batch often enough to leave the
   thumbnails "DOM only". The reset now comes from `chrome.tabs.onUpdated`
   (`status: loading`), which fires before the new document's first subresource
   request and shares the worker's event queue with `webRequest`. The message
   still names the page and resumes a crawl.
3. **Two messages a few milliseconds apart lost the title and the first
   candidates.** Page messages and network batches for one tab now run through
   one serialized chain (`serialize()` in the store), and `getTab` is
   single-flight so two concurrent cache misses cannot install two different
   state objects.
4. **`confirmed` regressed to `referenced` on the second scan.** `mergeStatus`
   derived status from layers only, so a decoded `<img>`, a canvas or a `data:`
   image - DOM-only by nature - was talked down on every rescan. Confirmed is
   now sticky.
5. **"Done" was never reported.** `finishIfDone` set the flag after the last
   emit, so the progress line stayed at `12/12 fetched` forever and the sidecar
   was never written. It emits now. The panel also asked for a sidecar on every
   download regardless of the option; it now reads `writeSidecar` from options.
6. **A `data:` image over 4 KB was truncated into a corrupt file.** The
   sanitizer capped every URL at 4096 characters. A `data:` URL is the file: it
   is kept whole up to 1 MiB and dropped beyond that, never cut. Unit-tested.
7. **The wrong frame answered capture and highlight requests.** Both messages
   reach every frame, and a frame without the element replied "gone" first,
   winning the race. Only the frame holding the element responds.
8. **Two fields never survived the sanitizer.** `synthetic` (so every capture
   was named `inline-svg`, canvases included) and the new `previewUrl`, which
   lets a link-target original's tile render from its thumbnail instead of
   pulling the full-size file - measured: zero `GET`s for originals before
   "find originals", where there had been twelve.
9. Smaller: media indexed after the page requested a key system now arrives
   `protected` (only earlier items were being marked); HAR streams no longer get
   the non-status `stream`; the panel's `IntersectionObserver` is disconnected
   before each re-render instead of holding every tile ever drawn; pressing
   rescan on a tab that has no content script (opened before the extension was
   installed) says to reload the page instead of showing an empty list.

## What the harness taught

- `Browser.setDownloadBehavior` over CDP overrides the extension's own
  `filename`: every file lands as its URL basename or a GUID, which reads
  exactly like a broken template. The download directory is set through the
  profile's `Preferences` instead, and the extension's paths come out as they
  do in a normal Chrome.
- Attaching the debugger to the service worker and navigating in the same
  instant loses the page's `webRequest` events about half the time. Nothing
  attaches to the worker in normal use; the run waits half a second.

## Verified

- `npm test`: 116 unit tests, smoke test, 38 end-to-end assertions, all green,
  four consecutive runs with the ordering trace enabled.
- Live `en.wikipedia.org/wiki/Eurasian_magpie`: 57 items (54 images, 3 audio),
  13 confirmed by both layers, 23 `/thumb/` URLs; six probed, six upgraded
  (`500px-…02.jpg` → the 12,070,770-byte original); no console errors.

---

# Ninth pass - review of the eighth, and the flows the gallery never reached

A line-by-line review of the eighth pass found five real problems in it, and a
second end-to-end run (`test/browser/e2e-flows.mjs`, 41 assertions, in `npm
test`) went after everything the gallery page could not exercise. Both are
recorded here; the unit count is now 124.

## What the review found, and what replaced it

1. **`tabs.onUpdated` 'loading' reset the index for loads that never replaced
   the document.** A download link served as an attachment, a 204, a stopped
   load: each fires 'loading' and then 'complete' on a tab whose page - and
   content script - are still there. The eighth pass wiped the index on every
   one of them. The reset is now in **two steps**. 'loading' opens a new
   *generation* and removes nothing; every item carries the generation it was
   indexed under. The page's own document_start report retires only the
   generations before the pending one, so a network batch that arrived first
   is kept whichever order the two came in - which was the whole point of the
   change. 'complete' settles: if the URL never changed, nothing happens; if it
   changed and, after a 1.5 s grace, no page ever reported (chrome://, a PDF,
   the Web Store), the tab is reset then. A `pushState` completes in the same
   instant it starts and its own report follows within the grace, which is why
   the grace exists.
2. **A reset that found nothing live emptied the history.** `resetTab` only
   carried `history` forward when there were live items to add to it; a
   redirect hop or a `replaceState` on load - two resets in a row - dropped
   everything collected on earlier pages. History is now carried regardless.
3. **The DRM flag died on a route change.** `emeRequested` is set once, when the
   player asks for a key system; an SPA moving to the next title with
   `pushState` rebuilt the state from scratch, and the next title's segments
   arrived downloadable. A same-document reset now keeps the DRM and MSE flags
   (`keepFlags`); a real navigation still clears them.
4. **`previewUrl` could be a lazy loader's placeholder.** The link-target
   original took its preview from the `<img>` `src` of the moment, which on a
   lazy gallery is a 1x1 `data:` placeholder, and the store kept the first
   value forever. A preview is now only ever an `http(s)` URL, the newest scan
   wins, and a tile whose preview fails falls back to the file itself once.
5. **A malformed `data:` URL took the whole batch down.** `fetch()` on it
   rejected out of `downloadItems`, so the remaining captures and the entire
   network queue were never started, silently. Each local save now fails on
   its own and is counted in the progress line.

Also from the review: the "reload the page" hint stayed on screen after the
reload had worked (it clears itself once items arrive, and on a tab switch);
the network observer flushed one tab's batch after another so a slow tab held
the rest (tabs now merge in parallel; order matters only within a tab); and a
tab could hold an unbounded number of inline `data:` images inside the
10 MB session-storage quota, where one failed write loses the whole index. A
tab now holds at most 3 MiB of `data:` URLs (`DATA_URI_TAB_BUDGET`), reports
itself truncated past that, and a failed write is an error in the console
rather than a debug line. The CI job has a 15-minute timeout and the runs
release the fixture server whichever step throws, so a hung browser cannot
hold a runner for six hours.

The store's reset semantics are now unit-tested (`test/store.test.mjs`, with
an in-memory `chrome.storage`): a batch arriving before the page's report is
kept, two resets in a row keep the history, a settled load changes nothing, an
orphaned one is flagged, the DRM flag survives a route change and not a
navigation, and the `data:` budget refuses and frees as it should.

## The second run

- **Layer B is real.** Five image URLs named only inside fetch and XHR JSON
  bodies were indexed as `background` from the MAIN world, with no DOM and
  without a single request for them; the API endpoints themselves were not.
- **Streams end to end.** A manifest fetched by the page was indexed as a
  stream; the drawer listed its three variants with resolutions, generated
  both commands, and "export segment list" wrote the 1080p variant's three
  segments to a file.
- **DRM.** The key-system request marked the video and the stream `protected`,
  left images alone, and a video added afterwards arrived protected. The flag
  survived a `pushState`.
- **A route change** moved the previous route's items to history, kept them
  retrievable, and indexed the new route's images with both DOM and network
  evidence - the ordering the generation reset exists for.
- **A worker restart** (`ServiceWorker.stopAllWorkers` from the panel's page
  session, the target seen to disappear) lost nothing: same items, same title,
  same flag, from `chrome.storage.session`.
- **The explorer** walked two pages: revealed four images behind "Mostra altre
  foto", opened the lightbox, followed "Pagina 2" and kept one index across the
  hop, and touched none of six traps - two destructive buttons, an upload
  button, a form-shaped "Mostra altre foto", an "Esci" link and a `download`
  link - each of which would have recorded a hit on the server.
- **HAR import** through the real file input: four entries merged, three with
  bodies; the download wrote the three files with their exact bytes from a
  host that does not exist (`127.0.0.1:1`) while the one exported without a
  body failed over the network as it should, and the progress line said
  `3 saved locally · 0/1 fetched, 1 failed`.
- **The panel's controls**: `a` selects the focused group, `Escape` clears,
  "select similar to this" takes the grid, and the threshold and template
  persist as options.

## Verified

`npm test`: 124 unit tests, the smoke test, 37 + 41 end-to-end assertions,
all green, two consecutive runs. Still not verified: a HAR exported by DevTools
itself, the explorer on a third-party site, the context menu driven
mechanically, Arc, Dia, Brave, Edge.

---

# Tenth pass - the explorer against a real site

Asked directly whether the explorer could walk a site and make every image
load, the answer had to be measured. Wikimedia Commons (`Category:Pica_pica`)
was the only public site that let a headless Chrome for Testing in; Pixabay,
Unsplash and Openverse answered 403 from a bot wall before a page loaded, so
infinite-scroll sites behind such walls stay unverified here. Each run below is
150 s, stopped by the probe.

## What the first run found

1. **Scrolling jumped to the bottom.** `scrollThrough` scrolled to the page's
   full height on each step, so an image or "load more" sentinel that only
   loads when it intersects the viewport never did unless it sat at the end.
   Fixture: 0 of 12 lazy images. It now moves by 85% of a viewport per step,
   through the window and any pane that scrolls on its own, and follows a feed
   that grows at the bottom until it stops growing. 12 of 12. On Commons the
   first scroll alone took the page from 414 to 632 items.
2. **The crawl never left page one**: 0 pages after 100 s, and the tab was on
   the front page - repeatedly. The span wrapping the site logo wraps an image,
   which is a positive reason to click; its `<a>` went to `Main_Page`; there the
   same click happened again. A page reached by a stray navigation was being
   explored without being counted, so nothing ever ended it. Two rules:
   anything inside an `<a href>` is the link and is refused like one (the link
   itself is collected for the queue), and a page the tab lands on by itself
   is visited once - recorded, explored, counted - and never twice.
3. **Click rounds had no clock.** A page thick with pointer controls (a wiki)
   spends its 60 clicks on chrome that reveals nothing, each round followed by
   a full re-scroll. Rounds now have a 45 s budget per page, and the re-scroll
   happens only when a round changed the page's height or media count.
4. **The queue was blind.** With links followed in discovery order, the 40-page
   budget went to `Main_Page`, `Commons:Welcome`, `Village_pump`,
   `Special:RecentChanges`, `Special:Random/File`, an `action=edit` page. Links
   are now scored by likeness to the start page - shared address tokens
   (Jaccard over path and query), a pagination parameter, a "next"/"more"
   label - and visited highest first; the risk-word check covers the query, so
   `?action=edit` is refused like `/edit`. Same start, next run: `Category:Pica`,
   `Videos_of_Pica_pica`, `Quality_images_of_Pica_pica`, then the
   subcategories (anatomy, captive, eggs, illustrations, juvenile, nests).
5. **A route change during a crawl reset the crawl.** MediaWiki calls
   `replaceState` on load; the `PAGE_RESET` that follows moved each page's
   finds to history at every hop (`items 812 → 9, history 812`). A crawl keeps
   one index; the same-document reset is skipped while one runs.

## Storage, measured

With one index across thirteen pages, `chrome.storage.session` refused writes
at 2.9 MB of JSON. `QUOTA_BYTES` is 10,485,760 and single 8 MB values write
fine; `getBytesInUse` explained it - the quota charges the in-memory size of
the value tree, ~3x the JSON, and an item's structural path (sixteen
`{tag, classes[]}` nodes) plus its class-count map were most of its objects.

- The store now keeps both as strings - one per path node, one per map - and
  expands them on read (`packItem`/`unpackItem`, tolerant of the expanded
  shape for seeded states). Same 2,028 items: 7.3 MB charged instead of the
  8.4 MB that 1,404 had cost. Path depth and class caps also came down
  (16 nodes, 8 classes, 32 counts) from a measured 14.5-level average.
- Writes are single-flight per tab: a change during a multi-megabyte write is
  flushed once, after it, instead of piling overlapping writes of one key.
- If a write still fails: history is dropped first (it travels light anyway -
  no structure), then live items lose their structure (`trimmed`), and the
  panel's banner says which happened; the URLs and statuses always survive a
  worker restart. The browser's message is kept on the state.

## Verified

- Fixture: 41 → 44 flow assertions (lazy feed 12/12, logo-in-a-link not
  clicked, page 1 loaded exactly once); 129 unit tests (link priority,
  query-aware risk, compact round trip, single-flight flush).
- Commons, 150 s: 13 pages, 67 clicks, 2,028 items (1,698 images, 166 videos,
  164 audio), subcategories first, no trap, no loop, no trimming, no console
  error of Magpie's own.
- One harness lesson worth keeping: a tab behind the panel's tab is hidden,
  and a hidden tab has its timers clamped to one a second and its
  IntersectionObservers never fire. That masked the scroll result entirely;
  every test page now opens in its own window, which is how the tab a person
  is looking at behaves.

---

# Eleventh pass - what hides behind a control that does not talk about media

Asked whether images behind menus get found, the answer had two halves.
Images that are in the DOM but hidden - `display: none`, `[hidden]`, a closed
menu drawn with CSS - were already indexed and fetched without a click: the
scanner reads the DOM, not the screen. Images the page renders only when a
control is operated were found only if the control's label or class read as a
media control. A tab called "Specifiche", an accordion called "Note tecniche",
a button called "Menu" and a `<details>` called "Materiali" were not opened:
measured on a fixture built for it, 0 of 4, 0 of 2, 0 of 2, 0 of 1.

`isDisclosure()` adds a third positive reason, shape rather than words: a
closed `aria-expanded="false"`, an `aria-haspopup`, an `aria-controls`, an
unselected `role="tab"`, a `<summary>` whose `<details>` is closed. An open one
is not clicked (that would close it), and the risk words still veto - the
fixture's "Elimina raccolta" disclosure records a server hit if touched, and
did not. The content script reports the four attributes and lets an element
that carries them afford a click even without a pointer cursor. After the
change: 4/4, 2/2, 2/2, 1/1, all fetched, trap untouched. Unit-tested.
