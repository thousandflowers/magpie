/**
 * End to end, second run: the flows the gallery run does not reach.
 *
 * A single-page app whose media exists only in JSON, a stream fetched the way
 * a player fetches it, a DRM key-system request, a pushState route change, a
 * service-worker restart, the explorer walking two pages past four traps, a
 * HAR import saved without the network, and the panel's own controls. The
 * pages come from the fixture server; nothing leaves the machine.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  check, waitFor, listFiles, requireChrome, launchWithExtension, openPage, openPanelFor,
  report, sleep, evaluate, attach,
} from './e2e-lib.mjs';
import { listTargets } from './harness.mjs';
import { startGalleryServer, SPA, EXPLORE, png } from '../fixtures/gallery-server.mjs';

const PORT = 9336;
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
const binary = requireChrome('end-to-end flows');

const downloadDir = mkdtempSync(join(tmpdir(), 'magpie-downloads-'));
const scratch = mkdtempSync(join(tmpdir(), 'magpie-har-'));
let site = null;
let run = null;

try {
  site = await startGalleryServer();
  run = await launchWithExtension(binary, PORT, { downloadDir });
  const { client, errors, worker, extensionId } = run;
  const has = (state, suffix) => state.items.find((i) => i.url.endsWith(suffix)) || null;

  /* ================= A. the SPA: JSON-only media, a stream, DRM, a route ================= */

  const spa = await openPage(client, `${site.origin}/spa`);
  // Before the panel draws any tile: the page itself must not have fetched
  // what was only ever named in JSON.
  await sleep(1500);
  check(!site.hits.some((h) => /\/spa\/(feed|xhr)-\d\.png$/.test(h.path)), 'mining a JSON body fetched none of it');
  const p = await openPanelFor(client, extensionId, `${site.origin}/spa*`);

  const fed = await waitFor(async () => {
    const s = await p.getState();
    return has(s, SPA.feedPath(SPA.feed)) && has(s, SPA.xhrPath(SPA.xhr)) && has(s, SPA.masterPath) ? s : null;
  }, { label: 'JSON feed media and the manifest to be indexed', timeout: 20000 });

  const mined = fed.items.filter((i) => /\/spa\/(feed|xhr)-\d\.png$/.test(i.url));
  check(mined.length === SPA.feed + SPA.xhr, `${mined.length} media URLs mined from fetch and XHR JSON bodies`);
  check(mined.every((i) => i.sources.includes('main') && i.status === 'background' && !(i.structuralPath || []).length),
    'JSON-only media is background, from the MAIN-world layer, with no DOM');
  check(!fed.items.some((i) => /\/api\//.test(i.url)), 'the API endpoints themselves are not indexed');
  const poster = has(fed, SPA.posterPath);
  check(poster && poster.kind === 'image' && poster.poster === true, 'the video poster is indexed as an image');
  const clip = has(fed, SPA.clipPath(1));
  check(clip && clip.kind === 'video' && clip.sources.includes('net'),
    `the <video> source is indexed as video (${clip && clip.kind}: ${clip && clip.sources})`);
  const master = has(fed, SPA.masterPath);
  check(master && master.kind === 'stream', `a manifest fetched by the page is indexed as a stream (${master && master.kind})`);

  // The stream, read in the detail drawer: variants, commands, segment export.
  await waitFor(async () => (await p.tileCount()) >= fed.items.length, { label: 'panel tiles' });
  await p.clickTile(SPA.masterPath, 2);
  await waitFor(async () => (await p.inPanel(`document.querySelectorAll('#detail .variants tr').length`)) >= 4,
    { label: 'stream variants in the detail drawer' }).catch(() => null);
  const drawer = await p.inPanel(`(() => {
    const d = document.getElementById('detail');
    return {
      rows: d.querySelectorAll('.variants tr').length,
      resolutions: [...d.querySelectorAll('td[data-field="resolution"]')].map((td) => td.textContent),
      commands: [...d.querySelectorAll('pre.command')].map((pre) => pre.textContent),
    };
  })()`);
  check(drawer.rows === SPA.variants.length + 1, `${drawer.rows - 1} HLS variants listed`);
  check(SPA.variants.every(([h, w]) => drawer.resolutions.includes(`${w}x${h}`)), `resolutions read ${drawer.resolutions.join(', ')}`);
  check(drawer.commands.length === 2 && drawer.commands[0].startsWith('yt-dlp') && drawer.commands[0].includes(SPA.masterPath)
    && drawer.commands[1].startsWith('ffmpeg'), 'yt-dlp and ffmpeg commands are generated for the manifest');
  await p.clickButton('export segment list');
  const segmentFile = await waitFor(() => listFiles(downloadDir).find((f) => /segments-\d+\.json$/.test(f.path)) || null,
    { label: 'the segment list file' }).catch(() => null);
  const segments = segmentFile ? JSON.parse(readFileSync(join(downloadDir, segmentFile.path), 'utf8')).segments : [];
  check(segments.length === SPA.segmentsPerVariant && segments.every((u) => u.includes(`/stream/${SPA.variants[0][0]}/seg-`)),
    `segment list exported from the ${SPA.variants[0][0]}p variant (${segments.length} segments)`);

  // DRM: the key-system request marks audio and video, present and future.
  await evaluate(client, spa.session, `window.__eme()`);
  const drm = await waitFor(async () => { const s = await p.getState(); return s.emeRequested ? s : null; },
    { label: 'the key-system request to be noticed' }).catch(() => ({ items: [], emeRequested: false }));
  check(drm.emeRequested === true, 'the key-system request is noticed');
  check(has(drm, SPA.clipPath(1)) && has(drm, SPA.clipPath(1)).status === 'protected', 'the video is marked protected');
  check(has(drm, SPA.masterPath) && has(drm, SPA.masterPath).status === 'protected', 'the stream is marked protected');
  check(has(drm, SPA.posterPath) && has(drm, SPA.posterPath).status !== 'protected', 'images are left alone');
  await evaluate(client, spa.session, `window.__lateVideo(), true`);
  const late = await waitFor(async () => has(await p.getState(), SPA.clipPath(2)), { label: 'a video added after the key-system request' });
  check(late.status === 'protected', `media indexed after the key-system request arrives protected (got ${late.status})`);

  // A route change: the old route becomes history, the flag survives, and the
  // new route's items are all there whichever order the resets arrived in.
  const beforeRoute = await p.getState();
  await evaluate(client, spa.session, `document.getElementById('route').click(), true`);
  await waitFor(async () => has(await p.getState(), SPA.routePath(SPA.route)), { label: 'the new route to be indexed' });
  await sleep(1200);
  const routed = await p.getState();
  const routeItems = routed.items.filter((i) => /\/spa\/route-\d\.png$/.test(i.url));
  check(routed.pageUrl === `${site.origin}/spa/two`, `pushState is a route change (page is now ${routed.pageUrl})`);
  check(routeItems.length === SPA.route && routeItems.every((i) => i.sources.includes('dom') && i.sources.includes('net')),
    `${routeItems.length} images of the new route indexed, each seen by DOM and network`);
  check(!has(routed, SPA.feedPath(1)), 'the previous route left the live index');
  check(routed.historyCount >= beforeRoute.items.length, `previous route kept as history (${routed.historyCount} items)`);
  check(Boolean(has(await p.getState({ includeHistory: true }), SPA.feedPath(1))), 'history is returned on request');
  check(routed.emeRequested === true, 'the DRM flag survives a same-document route change');

  /* ================= B. the service worker dies and the index does not ================= */

  await sleep(1000); // let the debounced write-through land
  // Stop the worker the way Chrome itself does when it idles out. The
  // ServiceWorker domain lives on a page session; the panel's own page shares
  // the extension's origin, so it sees the extension's worker.
  const stopped = await (async () => {
    for (const session of [p.panel, spa.session]) {
      const ok = await client.send('ServiceWorker.enable', {}, session)
        .then(() => client.send('ServiceWorker.stopAllWorkers', {}, session))
        .then(() => true, () => false);
      if (ok) return true;
    }
    return false;
  })();
  const gone = await waitFor(async () =>
    !(await listTargets(PORT)).some((t) => t.id === worker.id) || null,
    { label: 'the worker target to disappear', timeout: 10000 }).catch(() => false);
  const restored = await p.getState(); // the message wakes a fresh worker
  const fresh = await waitFor(async () => {
    const w = (await listTargets(PORT)).find((t) => t.url.includes('/src/background/service-worker.js'));
    return w && w.id !== worker.id ? w : null;
  }, { label: 'a fresh service worker', timeout: 10000 }).catch(() => null);
  // The restarted worker is not always listed again by /json/list; the proof
  // that it came back is the answer to the message above.
  if (fresh) await attach(client, fresh.id);
  check(stopped && gone === true && restored.ok, `the service worker was stopped and answered again (${stopped}, ${gone}, ${restored.ok})`);
  check(restored.ok && restored.items.length === routed.items.length && restored.pageTitle === routed.pageTitle
    && restored.emeRequested === true,
    `index restored from session storage after the restart (${restored.items.length}/${routed.items.length} items, "${restored.pageTitle}")`);

  /* ================= C. the explorer walks two pages past four traps ================= */

  await openPage(client, `${site.origin}/explore/1`);
  const q = await openPanelFor(client, extensionId, `${site.origin}/explore/*`);
  await waitFor(async () => has(await q.getState(), EXPLORE.visiblePath(EXPLORE.visible)), { label: 'explore page 1 to be indexed' });
  const started = await q.ask({ type: 'explore-start', tabId: q.tabId });
  check(Boolean(started.ok && started.started), 'explore starts on request');
  const finished = await waitFor(async () => {
    const r = await q.ask({ type: 'explore-status', tabId: q.tabId });
    return r.status && !r.status.running ? r.status : null;
  }, { label: 'the crawl to finish', timeout: 90000, every: 1000 });
  const crawled = await q.getState();
  check(finished.pages === 2 && /nothing left/.test(finished.note),
    `crawl finished: ${finished.pages} pages, ${finished.clicks} clicks, "${finished.note}"`);
  check(range(EXPLORE.hidden).every((n) => has(crawled, EXPLORE.hiddenPath(n))), 'images behind "Mostra altre foto" were revealed and indexed');
  check(Boolean(has(crawled, EXPLORE.lightboxPath)), 'the lightbox was opened and its image indexed');
  check(range(EXPLORE.page2).every((n) => has(crawled, EXPLORE.page2Path(n))), 'page 2 was followed and its images kept in the same index');
  check(range(EXPLORE.visible).every((n) => has(crawled, EXPLORE.visiblePath(n))), 'page 1 items survived the hop');
  const lazyLoaded = range(EXPLORE.lazy).filter((n) => { const i = has(crawled, EXPLORE.lazyPath(n)); return i && i.sources.includes('net'); });
  check(lazyLoaded.length === EXPLORE.lazy,
    `scrolling page 2 made every lazy image load, not just the last (${lazyLoaded.length}/${EXPLORE.lazy} fetched)`);
  const sprung = site.hits.filter((h) => h.path.startsWith('/trap/') || h.path.endsWith('.zip'));
  check(sprung.length === 0, `no trap was touched${sprung.length ? `: ${sprung.map((h) => h.path).join(', ')}` : ''}`);
  check(crawled.pageUrl === `${site.origin}/explore/2`, `the tab ended on page 2 (${crawled.pageUrl})`);
  const page1Loads = site.hits.filter((h) => h.method === 'GET' && h.path === '/explore/1').length;
  check(page1Loads === 1, `the logo wrapped in a link was not clicked: page 1 loaded once (${page1Loads})`);

  /* ================= D. a HAR import, saved without the network ================= */

  const captured = range(3).map((n) => ({ name: `photo-${n}.png`, url: `http://127.0.0.1:1/har/photo-${n}.png`, bytes: png(120, 90, 1000 + n) }));
  const entry = (url, content) => ({
    startedDateTime: new Date().toISOString(),
    request: { method: 'GET', url, headers: [] },
    response: { status: 200, headers: [{ name: 'Content-Type', value: 'image/png' }], content },
  });
  const har = { log: { version: '1.2', creator: { name: 'magpie-e2e' }, entries: [
    ...captured.map((c) => entry(c.url, { size: c.bytes.length, mimeType: 'image/png', text: c.bytes.toString('base64'), encoding: 'base64' })),
    entry('http://127.0.0.1:1/har/no-body.png', { size: 5000, mimeType: 'image/png' }), // exported without content
  ] } };
  const harPath = join(scratch, 'capture.har');
  writeFileSync(harPath, JSON.stringify(har));
  await client.send('DOM.enable', {}, q.panel);
  const { root } = await client.send('DOM.getDocument', { depth: 1 }, q.panel);
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#har-input' }, q.panel);
  await client.send('DOM.setFileInputFiles', { files: [harPath], nodeId }, q.panel);
  let imported = await waitFor(async () => { const t = await q.progress(); return /^HAR:/.test(t) ? t : null; }, { label: 'HAR import', timeout: 4000 }).catch(() => null);
  if (!imported) {
    await q.inPanel(`document.getElementById('har-input').dispatchEvent(new Event('change')), true`);
    imported = await waitFor(async () => { const t = await q.progress(); return /^HAR:/.test(t) ? t : null; }, { label: 'HAR import' });
  }
  check(/HAR: merged 4 new/.test(imported) && /3 with bodies/.test(imported), `HAR import reported (${imported})`);
  await waitFor(async () => (await q.tileCount()) >= crawled.items.length + 4, { label: 'HAR tiles' });
  // The three together: similarity selection seeded from a HAR item (no DOM,
  // no dimensions - URL shape and host carry it), then the download.
  await q.inPanel(`document.getElementById('clear').click(), true`);
  await q.clickTile(captured[0].name, 2);
  await sleep(300);
  await q.clickButton('select similar to this');
  const similarHar = await q.inPanel(`[...document.querySelectorAll('mg-item[selected]')].map((t) => t.item.url)`);
  check(captured.every((c) => similarHar.some((u) => u.endsWith(c.name))) && !similarHar.some((u) => /\/(explore|spa)\//.test(u)),
    `"select similar" from one HAR photo takes the other captured photos and nothing from the page (${similarHar.length} selected)`);
  if (!similarHar.some((u) => u.endsWith('no-body.png'))) await q.clickTile('no-body.png');
  await q.inPanel(`document.getElementById('download').click(), true`);
  const harDone = await waitFor(async () => { const t = await q.progress(); return /1 failed/.test(t) ? t : null; },
    { label: 'the HAR download to settle', timeout: 40000 }).catch(() => 'timed out');
  check(/^3 saved locally · 0\/1 fetched, 1 failed/.test(harDone), `progress counts the local saves and the one re-fetch (${harDone})`);
  const saved = listFiles(downloadDir).filter((f) => /photo-\d\.png$/.test(f.path));
  check(saved.length === 3 && captured.every((c) => saved.some((f) => f.path.endsWith(c.name) && f.size === c.bytes.length)),
    'three files written from the capture with their exact bytes');

  /* ================= E. the panel's own controls ================= */

  await q.clickButton('close').catch(() => null); // Escape closes an open drawer before it clears anything
  await q.inPanel(`document.getElementById('clear').click(), true`);
  await q.inPanel(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })), true`);
  const firstGroup = await q.inPanel(`document.querySelector('mg-group').querySelectorAll('mg-item').length`);
  const selectedA = await q.inPanel(`Number(document.querySelector('#selection b').textContent)`);
  check(firstGroup > 0 && selectedA === firstGroup, `"a" selects the whole first group (${selectedA}/${firstGroup})`);
  await q.inPanel(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  check((await q.inPanel(`Number(document.querySelector('#selection b').textContent)`)) === 0, 'Escape clears the selection');

  await q.clickTile(EXPLORE.page2Path(1), 2);
  await sleep(300);
  await q.clickButton('select similar to this');
  const similar = await q.inPanel(`[...document.querySelectorAll('mg-item[selected]')].map((t) => t.item.url)`);
  check(similar.length >= EXPLORE.page2 && range(EXPLORE.page2).every((n) => similar.some((u) => u.endsWith(EXPLORE.page2Path(n)))),
    `"select similar" from one page-2 image takes its grid (${similar.length} selected)`);

  await q.inPanel(`(() => { const s = document.getElementById('threshold'); s.value = 'strict'; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(500);
  check((await q.getState()).options.threshold === 'strict', 'the similarity threshold persists as an option');
  const template = 'magpie/{host}/{index}-{basename}.{ext}';
  await q.inPanel(`(() => { const t = document.getElementById('template'); t.value = ${JSON.stringify(template)}; t.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(500);
  check((await q.getState()).options.filenameTemplate === template, 'the filename template persists as an option');

  /* ================= console ================= */

  const unexpected = errors.filter((e) => !/favicon|ERR_|net::|127\.0\.0\.1:1\//.test(e));
  check(unexpected.length === 0, `no console errors${unexpected.length ? `:\n    ${unexpected.join('\n    ')}` : ''}`);
} catch (err) {
  console.error(`✖ end-to-end flows crashed: ${err.message}`);
  if (run && run.chrome.stderr.length) console.error(run.chrome.stderr.join('').slice(-2000));
  process.exitCode = 1;
} finally {
  if (run) {
    run.client.close();
    run.chrome.kill();
  }
  if (site) await site.close();
  rmSync(downloadDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}

report('end-to-end flow');
