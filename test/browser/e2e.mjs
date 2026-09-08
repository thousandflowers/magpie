/**
 * End to end, in a real Chrome: the unpacked extension against a local
 * gallery, driven over CDP and read back out of the actual panel.
 *
 * What it proves that the unit tests cannot: the content scripts see the
 * page, the layers merge into one index, the panel clusters and selects, the
 * upgrade verifier proves originals with HEAD alone, and the download queue
 * writes the right bytes under the right names. Nothing here leaves the
 * machine - the gallery is served from this process.
 */

import { mkdtempSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findChrome, launchChrome, waitForBrowser, listTargets,
  connect, attach, collectErrors, evaluate, sleep,
} from './harness.mjs';
import {
  startGalleryServer, GALLERY, thumbPath, originalPath, HERO_PATH, FRAME_IMAGE_PATH, imageBytes, dataImageBytes,
} from '../fixtures/gallery-server.mjs';

const PORT = 9335;

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? '✔' : '✖'} ${label}`);
  if (!ok) failures.push(label);
};

async function waitFor(probe, { timeout = 15000, every = 300, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function listFiles(root, prefix = '') {
  const out = [];
  for (const name of readdirSync(join(root, prefix))) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = statSync(join(root, rel));
    if (stat.isDirectory()) out.push(...listFiles(root, rel));
    else if (!name.endsWith('.crdownload')) out.push({ path: rel, size: stat.size });
  }
  return out;
}

const binary = findChrome();
if (!binary) {
  const message = 'no Chromium found. Set CHROME_PATH to point at one.';
  if (process.env.CI) {
    console.error(`✖ end-to-end check cannot be skipped on CI: ${message}`);
    process.exit(1);
  }
  console.log(`SKIP end-to-end check: ${message}`);
  process.exit(0);
}

const site = await startGalleryServer();
const downloadDir = mkdtempSync(join(tmpdir(), 'magpie-downloads-'));
const chrome = launchChrome(binary, PORT, [], { downloadDir });
const errors = [];
let client;

try {
  const version = await waitForBrowser(PORT);
  client = await connect(version.webSocketDebuggerUrl);
  collectErrors(client, errors);

  const worker = await waitFor(
    async () => (await listTargets(PORT)).find((t) => t.url.includes('/src/background/service-worker.js')),
    { label: 'service worker', timeout: 20000 },
  );
  await attach(client, worker.id);
  const extensionId = new URL(worker.url).host;
  // Attaching the debugger to the worker and navigating in the same instant
  // loses the page's webRequest events about half the time. A harness
  // artefact - nothing attaches to the worker in normal use - so wait it out.
  await sleep(500);

  /* ---------------- the page, then the panel pointed at it ---------------- */

  const { targetId: pageTarget } = await client.send('Target.createTarget', { url: `${site.origin}/` });
  await attach(client, pageTarget);

  const panelUrl = `chrome-extension://${extensionId}/src/panel/panel.html`;
  const { targetId: panelTarget } = await client.send('Target.createTarget', { url: panelUrl });
  const panel = await attach(client, panelTarget);
  await sleep(800);
  const tabId = await evaluate(client, panel, `(async () => {
    const tabs = await chrome.tabs.query({ url: ${JSON.stringify(`${site.origin}/*`)} });
    if (!tabs.length) throw new Error('gallery tab not found');
    return tabs[0].id;
  })()`);
  await client.send('Page.navigate', { url: `${panelUrl}?tabId=${tabId}` }, panel);
  await sleep(800);

  const ask = (message) => evaluate(client, panel,
    `new Promise((resolve) => chrome.runtime.sendMessage(${JSON.stringify(message)}, (r) => { void chrome.runtime.lastError; resolve(r); }))`);
  const toTab = (message) => evaluate(client, panel,
    `new Promise((resolve) => chrome.tabs.sendMessage(${tabId}, ${JSON.stringify(message)}, (r) => { void chrome.runtime.lastError; resolve(r); }))`);
  const getState = () => ask({ type: 'get-state', tabId });
  const tileCount = () => evaluate(client, panel, `document.querySelectorAll('mg-item').length`);
  const find = (state, test) => state.items.find((i) => test(i.url));
  const count = (state, test) => state.items.filter((i) => test(i.url)).length;
  const isThumb = (u) => /beach-\d\d-150x150\.png$/.test(u);
  const isOriginal = (u) => /beach-\d\d\.png$/.test(u);

  /* ---------------- detection ---------------- */

  await waitFor(async () => find(await getState(), (u) => u.endsWith(FRAME_IMAGE_PATH)),
    { label: 'the late iframe to be indexed', timeout: 20000 });
  await sleep(1200); // anything the iframe's arrival broke shows up here

  const seen = await getState();
  check(seen.pageUrl === `${site.origin}/`,
    `page URL is the top document, not the iframe (got ${seen.pageUrl})`);
  check(seen.pageTitle === GALLERY.title,
    `page title is "${GALLERY.title}" (got "${seen.pageTitle}")`);
  check(count(seen, isThumb) === GALLERY.thumbs, `${GALLERY.thumbs} thumbnails indexed`);
  check(count(seen, isOriginal) === GALLERY.thumbs, `${GALLERY.thumbs} link-target originals indexed`);
  check(Boolean(find(seen, (u) => u.endsWith(HERO_PATH))), 'hero indexed');
  check(count(seen, (u) => /icon-\d\.png$/.test(u)) === GALLERY.icons, `${GALLERY.icons} toolbar icons indexed`);
  const lazy = seen.items.filter((i) => /lazy-\d\.png$/.test(i.url));
  check(lazy.length === GALLERY.lazy && lazy.every((i) => i.status === 'referenced'),
    `${GALLERY.lazy} lazy data-src images indexed as referenced`);
  check(!site.hits.some((h) => /lazy-\d\.png$/.test(h.path)), 'indexing a lazy image did not fetch it');
  const inner = find(seen, (u) => u.endsWith(FRAME_IMAGE_PATH));
  check(inner && inner.frameOrigin === site.origin, 'iframe image carries its frame origin');
  check(Boolean(find(seen, (u) => u.startsWith('magpie-canvas:'))), 'painted canvas indexed under a synthetic URL');
  check(Boolean(find(seen, (u) => u.startsWith('data:image/png'))), 'inline data: image indexed');
  const thumb = find(seen, (u) => u.endsWith(thumbPath(1)));
  const layers = {};
  for (const i of seen.items) layers[i.sources.join('+')] = (layers[i.sources.join('+')] || 0) + 1;
  check(thumb && thumb.status === 'confirmed' && thumb.sources.includes('dom') && thumb.sources.includes('net'),
    `a loaded thumbnail is confirmed by DOM + network (got ${thumb && thumb.status}, ${thumb && thumb.sources}; layers ${JSON.stringify(layers)})`);
  check((layers['dom+net'] || 0) >= GALLERY.thumbs + GALLERY.icons + 1,
    `every fetched image is seen by both the DOM and the network (${layers['dom+net'] || 0} dom+net)`);

  // Rescans happen on every DOM mutation; they must not downgrade what the
  // page has already proven, and must not duplicate anything.
  await toTab({ type: 'scan-now' });
  await sleep(500);
  await toTab({ type: 'scan-now' });
  await sleep(900);
  const rescanned = await getState();
  const canvas = find(rescanned, (u) => u.startsWith('magpie-canvas:'));
  const inline = find(rescanned, (u) => u.startsWith('data:image/png'));
  check(canvas && canvas.status === 'confirmed', `canvas stays confirmed after rescans (got ${canvas && canvas.status})`);
  check(inline && inline.status === 'confirmed', `data: image stays confirmed after rescans (got ${inline && inline.status})`);
  check(rescanned.items.length === seen.items.length,
    `rescans add no duplicates (${seen.items.length} -> ${rescanned.items.length})`);

  /* ---------------- clustering, read from the panel ---------------- */

  await waitFor(async () => (await tileCount()) >= rescanned.items.length, { label: 'panel tiles' });
  const groups = await evaluate(client, panel,
    `[...document.querySelectorAll('mg-group')].map((g) => [...g.querySelectorAll('mg-item')].map((t) => t.item.url))`);
  const groupOf = (test) => groups.find((g) => g.some(test)) || [];
  const thumbGroup = groupOf((u) => u.endsWith(thumbPath(1)));
  check(thumbGroup.filter(isThumb).length === GALLERY.thumbs, 'all thumbnails cluster into one group');
  check(!thumbGroup.includes(`${site.origin}${HERO_PATH}`), 'the hero is not in the thumbnail group');
  const iconGroup = groupOf((u) => /icon-1\.png$/.test(u));
  check(iconGroup.filter((u) => /icon-\d\.png$/.test(u)).length === GALLERY.icons && !iconGroup.some(isThumb),
    'toolbar icons cluster apart from content');

  /* ---------------- find originals ---------------- */

  const hitsBefore = site.hits.length;
  const verify = await ask({ type: 'verify-upgrades', tabId });
  check(verify.ok && verify.upgraded >= GALLERY.thumbs, `find originals verified ${verify.upgraded} upgrades`);
  check(verify.collapsed >= GALLERY.thumbs, `thumbnail/original pairs collapsed (${verify.collapsed})`);
  const probes = site.hits.slice(hitsBefore).filter((h) => isOriginal(h.path));
  check(probes.some((h) => h.method === 'HEAD' && h.path === originalPath(1)), 'originals were HEAD-probed');
  check(probes.length > 0 && probes.every((h) => h.method === 'HEAD'), 'verification fetched no original, HEAD only');
  // Before the collapse the panel listed the originals as tiles; it must have
  // drawn them from the thumbnail, not by pulling the full-size file.
  check(!site.hits.slice(0, hitsBefore).some((h) => h.method === 'GET' && isOriginal(h.path)),
    'panel tiles for link-target originals were drawn from the thumbnail');
  const upgraded = await getState();
  const effective = (i) => (i.upgradeVerified && i.upgradeUrl ? i.upgradeUrl : i.url);
  const resolved = new Set(upgraded.items.filter((i) => isThumb(i.url) || isOriginal(i.url)).map(effective));
  check(resolved.size === GALLERY.thumbs && [...resolved].every(isOriginal),
    `every beach item now resolves to exactly one original (${resolved.size})`);
  check(upgraded.items.filter((i) => isThumb(i.url) || isOriginal(i.url)).length === GALLERY.thumbs,
    'one item per asset after the collapse');

  /* ---------------- download the group ---------------- */

  await waitFor(async () => (await tileCount()) === upgraded.items.length, { label: 'panel to reflect the collapse' });
  const enabled = await evaluate(client, panel, `(() => {
    const group = [...document.querySelectorAll('mg-group')]
      .find((g) => [...g.querySelectorAll('mg-item')].some((t) => t.item.url.endsWith(${JSON.stringify(thumbPath(1))})));
    const box = group.querySelector('.group-check');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return !document.getElementById('download').disabled;
  })()`);
  check(enabled, 'selecting the group enables the download button');
  await evaluate(client, panel, `document.getElementById('download').click(), true`);

  const settled = await waitFor(async () => {
    const list = await evaluate(client, panel, `chrome.downloads.search({})`);
    const complete = list.filter((d) => d.state === 'complete').length;
    const interrupted = list.filter((d) => d.state === 'interrupted');
    return complete + interrupted.length >= GALLERY.thumbs ? { complete, interrupted } : null;
  }, { timeout: 90000, label: `${GALLERY.thumbs} downloads to settle` });
  check(settled.complete === GALLERY.thumbs && settled.interrupted.length === 0,
    `${settled.complete} complete, ${settled.interrupted.length} interrupted${settled.interrupted.length ? ` (${settled.interrupted.map((d) => d.error).join(', ')})` : ''}`);
  await sleep(800);
  const progress = await evaluate(client, panel, `document.getElementById('progress-text').textContent`);
  check(/12\/12 fetched.*done/.test(progress), `progress line reports completion (got "${progress}")`);

  const files = listFiles(downloadDir);
  const pngs = files.filter((f) => f.path.endsWith('.png'));
  check(pngs.length === GALLERY.thumbs, `${pngs.length} files written (${pngs.slice(0, 3).map((f) => f.path).join(', ')})`);
  check(pngs.every((f) => f.path.startsWith(`magpie/127.0.0.1/${GALLERY.title}/`)), 'files land under magpie/{host}/{title}/');
  const named = pngs.map((f) => ({ f, m: /(\d{3})-beach-(\d\d)\.png$/.exec(f.path) }));
  check(named.every((n) => n.m) && new Set(named.map((n) => n.m && n.m[2])).size === GALLERY.thumbs,
    'each file is named after its original, once');
  check(named.every((n) => n.m && n.f.size === imageBytes(originalPath(Number(n.m[2]))).length),
    'every file holds the original bytes, not the thumbnail');
  check(!files.some((f) => /manifest-\d+\.json$/.test(f.path)), 'no sidecar manifest unless the option is on');

  /* ---------------- captures: canvas and data: image ---------------- */

  await evaluate(client, panel, `(() => {
    document.getElementById('clear').click();
    for (const tile of document.querySelectorAll('mg-item')) {
      if (tile.item.url.startsWith('magpie-canvas:') || tile.item.url.startsWith('data:image/png')) {
        tile.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    }
    document.getElementById('download').click();
    return true;
  })()`);
  const captured = await waitFor(async () => {
    const now = listFiles(downloadDir).filter((f) => f.path.endsWith('.png'));
    return now.length >= GALLERY.thumbs + 2 ? now : null;
  }, { timeout: 20000, label: 'canvas and data: captures' }).catch(() => listFiles(downloadDir));
  const canvasFile = captured.find((f) => /-canvas\.png$/.test(f.path));
  const inlineFile = captured.find((f) => /-inline\.png$/.test(f.path));
  check(Boolean(canvasFile) && canvasFile.size > 100, `canvas capture saved as *-canvas.png (${canvasFile ? canvasFile.size : 'missing'})`);
  check(Boolean(inlineFile) && inlineFile.size === dataImageBytes().length,
    `data: image saved as *-inline.png with its exact bytes (${inlineFile ? inlineFile.size : 'missing'}, files: ${captured.map((f) => f.path.split('/').pop()).join(', ')})`);

  /* ---------------- console ---------------- */

  const unexpected = errors.filter((e) => !/favicon|ERR_/.test(e));
  check(unexpected.length === 0, `no console errors${unexpected.length ? `:\n    ${unexpected.join('\n    ')}` : ''}`);
} catch (err) {
  console.error(`✖ end-to-end check crashed: ${err.message}`);
  if (chrome.stderr.length) console.error(chrome.stderr.join('').slice(-2000));
  process.exitCode = 1;
} finally {
  if (client) client.close();
  chrome.kill();
  await site.close();
  rmSync(downloadDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} assertion(s) failed`);
  process.exitCode = 1;
} else if (!process.exitCode) {
  console.log('\nall end-to-end assertions passed');
}
