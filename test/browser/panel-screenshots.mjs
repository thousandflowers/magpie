/**
 * Panel screenshot harness.
 *
 * Opens panel.html as a normal tab at the real side-panel width, seeds the
 * per-tab index directly into chrome.storage.session, and writes PNGs to
 * test/screenshots/ for a human to look at. It asserts nothing and is not part
 * of `npm test`.
 *
 * Two things about these images are synthetic and worth knowing:
 *  - the fixture URLs point at hosts that do not exist, so after each render
 *    the tiles are painted with flat SVG placeholders. Layout, density,
 *    metadata, typography, selection state and dark mode are all real; the
 *    picture content is not.
 *  - the viewport is grown to fit the panel's internal scroller, so a shot may
 *    be taller than a real side panel while being exactly as wide.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findChrome, launchChrome, waitForBrowser, listTargets,
  connect, attach, evaluate, sleep,
} from './harness.mjs';
import { normalizeUrl } from '../../src/core/url-normalize.js';
import { heroPlusGrid, iconsAndContent } from '../fixtures/pages.mjs';

const PORT = 9338;
const WIDTH = 400;
const OUT = fileURLToPath(new URL('../screenshots/', import.meta.url));

const binary = findChrome();
if (!binary) {
  console.log('SKIP panel screenshots: no Chromium found. Set CHROME_PATH to point at one.');
  process.exit(0);
}
mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ *
 * Seeding
 * ------------------------------------------------------------------ */

let nextTabId = 900000;

/** Build a store-shaped tab state from candidate-ish objects. */
function tabState({ pageUrl, pageTitle, items = [], emeRequested = false }) {
  const tabId = (nextTabId += 1);
  const state = {
    tabId,
    pageUrl,
    pageTitle,
    items: {},
    order: [],
    history: [],
    counter: 0,
    usesMse: false,
    emeRequested,
    truncated: false,
    updatedAt: Date.now(),
  };
  items.forEach((raw, index) => {
    const normalizedUrl = normalizeUrl(raw.url, pageUrl);
    if (state.items[normalizedUrl]) return;
    state.counter += 1;
    state.items[normalizedUrl] = {
      status: 'confirmed',
      sources: ['dom', 'net'],
      mimeType: 'image/jpeg',
      kind: 'image',
      ...raw,
      id: `${tabId}-${state.counter}`,
      normalizedUrl,
      firstSeen: Date.now() + index,
    };
    state.order.push(normalizedUrl);
  });
  return state;
}

const HLS_5_VARIANTS = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3200000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,CODECS="avc1.4d401e,mp4a.40.2"
480/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240,CODECS="avc1.42c015,mp4a.40.2"
240/index.m3u8
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
`;

const HLS_ENCRYPTED = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://asset-42",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6.0,
seg1.ts
#EXT-X-ENDLIST
`;

function bulkItems(count = 122) {
  const base = 'https://cdn.stockhouse.example/library/2024';
  const path = [
    { tag: 'img', classes: ['tile-image'] },
    { tag: 'a', classes: ['tile-link'] },
    { tag: 'li', classes: ['tile'] },
    { tag: 'ul', classes: ['asset-grid'] },
    { tag: 'main', classes: [] },
    { tag: 'body', classes: [] },
  ];
  return Array.from({ length: count }, (_, i) => ({
    url: `${base}/asset-${String(i + 1).padStart(3, '0')}.jpg`,
    width: 1200,
    height: 800,
    bytes: 180_000 + (i % 17) * 9000,
    structuralPath: path,
    inRepeatedGroup: true,
    repeatDepth: 2,
  }));
}

/* ------------------------------------------------------------------ *
 * Rendering helpers, injected into the panel
 * ------------------------------------------------------------------ */

const PAINT_THUMBS = `(() => {
  const hues = [14, 202, 148, 276, 38, 322, 96];
  let n = 0;
  for (const tile of document.querySelectorAll('mg-item')) {
    if (!tile.item || tile.item.kind !== 'image') continue;
    const box = tile.querySelector('.thumb-box');
    if (!box) continue;
    const h = hues[n++ % hues.length];
    const w = tile.item.width || 100;
    const t = tile.item.height || 100;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + t + '">'
      + '<rect width="100%" height="100%" fill="hsl(' + h + ',42%,64%)"/>'
      + '<rect y="' + (t * 0.64) + '" width="100%" height="' + (t * 0.36) + '" fill="hsl(' + h + ',38%,46%)"/>'
      + '<circle cx="' + (w * 0.73) + '" cy="' + (t * 0.27) + '" r="' + (Math.min(w, t) * 0.12) + '" fill="hsl(' + ((h + 45) % 360) + ',72%,84%)"/>'
      + '</svg>';
    const glyph = box.querySelector('.thumb-glyph');
    if (glyph) glyph.remove();
    let img = box.querySelector('img');
    if (!img) { img = document.createElement('img'); box.appendChild(img); }
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  return true;
})()`;

const chrome = launchChrome(binary, PORT);
const written = [];
let client;

try {
  const version = await waitForBrowser(PORT);
  client = await connect(version.webSocketDebuggerUrl);

  let worker = null;
  for (let i = 0; i < 40 && !worker; i += 1) {
    worker = (await listTargets(PORT)).find((t) => t.url.includes('/src/background/service-worker.js'));
    if (!worker) await sleep(500);
  }
  if (!worker) throw new Error('service worker never registered');
  const extensionId = new URL(worker.url).host;
  const panelUrl = `chrome-extension://${extensionId}/src/panel/panel.html`;

  const { targetId } = await client.send('Target.createTarget', { url: panelUrl });
  const panel = await attach(client, targetId);
  await client.send('Page.enable', {}, panel);
  await sleep(1200);

  async function seedAndOpen(state, { emulateDark = false } = {}) {
    await evaluate(client, panel, `(async () => {
      await chrome.storage.session.set({ ${JSON.stringify(`tab:${state.tabId}`)}: ${JSON.stringify(state)} });
      return true;
    })()`);
    // Headless Chrome reports dark by default, so light is emulated explicitly
    // rather than left to the default.
    await client.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: emulateDark ? 'dark' : 'light' }],
    }, panel);
    await client.send('Page.navigate', { url: `${panelUrl}?tabId=${state.tabId}` }, panel);
    await sleep(2200);
  }

  async function capture(name, { maxHeight = 4200 } = {}) {
    await evaluate(client, panel, PAINT_THUMBS);
    // Measure from a known viewport: device metrics persist between shots, and
    // a tall one makes the panel's flex body report its own height back.
    await client.send('Emulation.setDeviceMetricsOverride',
      { width: WIDTH, height: 800, deviceScaleFactor: 1, mobile: false }, panel);
    await sleep(350);
    const needed = await evaluate(client, panel, `(() => {
      // Sum the fixed sections and add the scroller's own content height, so a
      // tall detail drawer cannot squeeze the item list out of the shot.
      const body = document.getElementById('body');
      let around = 0;
      for (const el of document.body.children) {
        if (el !== body) around += el.getBoundingClientRect().height;
      }
      return Math.ceil(around + Math.min(body.scrollHeight, 3000)) + 4;
    })()`);
    const height = Math.min(Math.max(needed, 560), maxHeight);
    await client.send('Emulation.setDeviceMetricsOverride',
      { width: WIDTH, height, deviceScaleFactor: 2, mobile: false }, panel);
    await sleep(500);
    await evaluate(client, panel, PAINT_THUMBS);
    await sleep(200);
    // Informational only: a side panel that scrolls sideways is a defect, so
    // the number is printed next to every shot rather than left to the eye.
    const overflow = await evaluate(client, panel, `(() => {
      const root = document.documentElement;
      const worst = [...document.querySelectorAll('.detail, .variants, .body, .footer, .header')]
        .reduce((n, el) => Math.max(n, el.scrollWidth - el.clientWidth), 0);
      return Math.max(root.scrollWidth - root.clientWidth, worst);
    })()`);
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' }, panel);
    const file = join(OUT, name);
    writeFileSync(file, Buffer.from(data, 'base64'));
    written.push(`${name}  ${WIDTH}x${height}`);
    console.log(`  wrote ${name} (${WIDTH}x${height}, horizontal overflow ${overflow}px)`);
  }

  /* ---------------- 1. empty ---------------- */
  await seedAndOpen(tabState({
    pageUrl: 'https://example.com/articles/nothing-here',
    pageTitle: 'An article with no media',
  }));
  await capture('01-empty.png');

  /* ---------------- 2. gallery, three clusters, one collapsed ---------------- */
  const { hero, grid } = heroPlusGrid(12);
  const { icons } = iconsAndContent();
  await seedAndOpen(tabState({
    pageUrl: 'https://news.example.org/2024/08/the-coast-road',
    pageTitle: 'The coast road',
    items: [hero, ...grid, ...icons].map((i) => ({ ...i, id: undefined })),
  }));
  await evaluate(client, panel, `(() => {
    const groups = [...document.querySelectorAll('mg-group')];
    const target = groups[1] || groups[0];
    target.querySelector('.group-head').click();
    return groups.length;
  })()`);
  await sleep(400);
  await capture('02-clusters-one-collapsed.png');

  /* ---------------- 3. bulk, ~40 selected ---------------- */
  const bulk = tabState({
    pageUrl: 'https://cdn.stockhouse.example/library/2024',
    pageTitle: 'Asset library 2024',
    items: bulkItems(122),
  });
  await seedAndOpen(bulk);
  await evaluate(client, panel, `(() => {
    const tiles = [...document.querySelectorAll('mg-item')].slice(0, 40);
    for (const tile of tiles) tile.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    return tiles.length;
  })()`);
  await sleep(600);
  await capture('03-bulk-selection.png');

  /* ---------------- 4. stream expanded ---------------- */
  const streamUrl = 'https://vod.example.tv/asset-42/master.m3u8';
  await seedAndOpen(tabState({
    pageUrl: 'https://watch.example.tv/titles/the-coast-road',
    pageTitle: 'The coast road',
    items: [
      { url: streamUrl, kind: 'stream', mimeType: 'application/vnd.apple.mpegurl', bytes: 1840, status: 'background', sources: ['net'] },
      ...bulkItems(4).map((i) => ({ ...i, width: 1280, height: 720 })),
    ],
  }));
  await evaluate(client, panel, `(() => {
    window.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => ${JSON.stringify(HLS_5_VARIANTS)} });
    const tile = [...document.querySelectorAll('mg-item')].find(t => t.item && t.item.kind === 'stream');
    tile.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    return true;
  })()`);
  await sleep(2000);
  await capture('04-stream-variants.png');

  /* ---------------- 5. DRM ---------------- */
  const drmUrl = 'https://vod.example.tv/asset-99/protected.m3u8';
  await seedAndOpen(tabState({
    pageUrl: 'https://watch.example.tv/titles/licensed-feature',
    pageTitle: 'Licensed feature',
    emeRequested: true,
    items: [
      {
        url: drmUrl, kind: 'stream', mimeType: 'application/vnd.apple.mpegurl', bytes: 940,
        status: 'protected', protectedReason: 'Encrypted Media Extensions: com.widevine.alpha',
        sources: ['net'],
      },
      ...bulkItems(4).map((i) => ({ ...i, width: 1280, height: 720 })),
    ],
  }));
  await evaluate(client, panel, `(() => {
    window.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => ${JSON.stringify(HLS_ENCRYPTED)} });
    const tile = [...document.querySelectorAll('mg-item')].find(t => t.item && t.item.kind === 'stream');
    tile.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    return true;
  })()`);
  await sleep(2000);
  await capture('05-drm-protected.png');

  /* ---------------- 6. bulk again, dark ---------------- */
  const bulkDark = tabState({
    pageUrl: 'https://cdn.stockhouse.example/library/2024',
    pageTitle: 'Asset library 2024',
    items: bulkItems(122),
  });
  await seedAndOpen(bulkDark, { emulateDark: true });
  await evaluate(client, panel, `(() => {
    const tiles = [...document.querySelectorAll('mg-item')].slice(0, 40);
    for (const tile of tiles) tile.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    return tiles.length;
  })()`);
  await sleep(600);
  await capture('06-bulk-selection-dark.png');

  console.log(`\n${written.length} screenshot(s) in test/screenshots/`);
} catch (err) {
  console.error(`✖ panel screenshots failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (client) client.close();
  chrome.kill();
}
