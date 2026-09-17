/**
 * Chrome Web Store screenshots: docs/store/*.png, at exactly 1280x800.
 *
 * The store rejects any other size, which is why the captures in docs/ - taken
 * at the panel's real 400px width - cannot be used for a listing. What a user
 * actually sees is a page with the panel beside it, so that is what these
 * images are: a real Chrome, the unpacked extension, the fixture gallery, and
 * the panel reading that page. Nothing is mocked and nothing leaves the
 * machine.
 *
 * The two halves are captured separately and composed in a third page, because
 * CDP screenshots a document, not a browser window - there is no way to ask it
 * for "the tab and its side panel" in one shot.
 *
 * Usage: npm run screenshots:store
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findChrome, launchChrome, waitForBrowser, connect, attach, evaluate, sleep,
} from '../test/browser/harness.mjs';
import { findWorker } from '../test/browser/e2e-lib.mjs';
import { startGalleryServer } from '../test/fixtures/gallery-server.mjs';

const PORT = 9341;
const PAGE_WIDTH = 880;
const PANEL_WIDTH = 400;
const HEIGHT = 800;
const OUT = fileURLToPath(new URL('../docs/store/', import.meta.url));

const binary = findChrome();
if (!binary) {
  console.error('store screenshots need a Chromium. Set CHROME_PATH, or run '
    + 'npx @puppeteer/browsers install chrome@stable');
  process.exit(1);
}

/** Each caption is the one sentence its image has to earn. */
const SCENES = [
  {
    name: '01-one-page-three-clusters.png',
    caption: 'Every image, video and audio file the page loads or references, grouped by similarity.',
    setUp: async () => {},
  },
  {
    name: '02-select-the-whole-set.png',
    caption: 'Pick one photo and Magpie selects every other one that belongs to the same set.',
    setUp: async (panel) => {
      // The "select similar" control lives in the detail drawer, which opens on
      // a double click - a single one only toggles the tile, which is how the
      // first run of this script produced a caption about selecting a set over
      // a panel reading "1 selected".
      const opened = await panel.inPanel(`(() => {
        // A tile from the biggest group, and within it the heaviest image: the
        // caption is about selecting a *set*, so the set has to exist, and on
        // a real page the heaviest member is a photograph rather than a UI
        // icon. Both rules are general - no list of URLs to keep up to date.
        const groups = [...document.querySelectorAll('mg-group')]
          .map((g) => [...g.querySelectorAll('mg-item')].filter((t) => t.item && t.item.kind === 'image'))
          .filter((tiles) => tiles.length > 1)
          // By weight, not by count: a set of six 200-byte interface icons is
          // the largest group on many pages and the least interesting one.
          .sort((a, b) => b.reduce((n, t) => n + (t.item.bytes || 0), 0)
            - a.reduce((n, t) => n + (t.item.bytes || 0), 0));
        if (!groups.length) return false;
        const tile = groups[0].sort((a, b) => (b.item.bytes || 0) - (a.item.bytes || 0))[0];
        if (!tile) return false;
        tile.scrollIntoView({ block: 'center' });
        tile.dispatchEvent(new MouseEvent('click', { detail: 2, bubbles: true }));
        return true;
      })()`);
      if (!opened) throw new Error('no tile to open');
      await sleep(600);
      const picked = await panel.inPanel(`(() => {
        const button = [...document.querySelectorAll('#detail button')]
          .find((b) => /similar/i.test(b.textContent));
        if (!button) return 0;
        button.click();
        return 1;
      })()`);
      if (!picked) throw new Error('the drawer has no "select similar" control');
      await sleep(900);
      const selected = await panel.inPanel(`document.querySelectorAll('mg-item[selected]').length`);
      if (selected < 2) throw new Error(`the caption promises a set; only ${selected} item is selected`);
      // Close the drawer and scroll the set into view: the picture has to show
      // the selection the caption is talking about, not the drawer that made
      // it.
      await panel.inPanel(`(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const first = document.querySelector('mg-item[selected]');
        if (first) first.scrollIntoView({ block: 'center' });
        return true;
      })()`);
      await sleep(500);
    },
  },
  {
    name: '03-full-size-originals.png',
    caption: 'Thumbnails are resolved to their full-size originals, each one proved with a HEAD request.',
    setUp: async (panel) => {
      await panel.inPanel(`(() => {
        const button = [...document.querySelectorAll('button')].find((b) => /original/i.test(b.textContent));
        if (button) button.click();
        return true;
      })()`);
      await sleep(2500);
    },
  },
];

/**
 * The two halves side by side, with a caption the listing can read at a glance.
 *
 * Returned as markup rather than a `data:text/html` URL: two full-page PNGs
 * base64-encoded and then percent-encoded run to megabytes, and a URL that
 * long is silently truncated - which produced three perfectly sized, perfectly
 * empty screenshots.
 */
const composite = (pageData, panelData, caption) => `<style>
  html, body { margin: 0; padding: 0; background: #11131a; }
  .frame { width: ${PAGE_WIDTH + PANEL_WIDTH}px; height: ${HEIGHT}px; display: flex; position: relative; }
  .frame img { display: block; height: ${HEIGHT}px; }
  .page { width: ${PAGE_WIDTH}px; }
  .panel { width: ${PANEL_WIDTH}px; box-shadow: -1px 0 0 rgba(0,0,0,.35); }
  .caption {
    position: absolute; left: 0; right: ${PANEL_WIDTH}px; bottom: 0;
    padding: 18px 28px; color: #fff; font: 500 19px/1.4 -apple-system, "Segoe UI", system-ui, sans-serif;
    background: linear-gradient(to top, rgba(10,12,18,.94), rgba(10,12,18,0));
  }
</style><div class="frame">
  <img class="page" src="data:image/png;base64,${pageData}">
  <img class="panel" src="data:image/png;base64,${panelData}">
  <div class="caption">${caption}</div>
</div>`;

mkdirSync(OUT, { recursive: true });

/**
 * What to photograph. The fixture is the default because it needs no network
 * and is always the same, but its images are generated noise - fine for a
 * test, poor for a listing. Point this at a real page for the actual store
 * assets:
 *
 *   MAGPIE_SHOT_URL=https://en.wikipedia.org/wiki/Eurasian_magpie npm run screenshots:store
 */
const externalUrl = process.env.MAGPIE_SHOT_URL || '';
const site = externalUrl ? null : await startGalleryServer();
const target = externalUrl || `${site.origin}/`;
const pattern = externalUrl ? `${new URL(externalUrl).origin}/*` : `${site.origin}/*`;
const chrome = launchChrome(binary, PORT, [`--window-size=${PAGE_WIDTH},${HEIGHT}`]);
let client = null;

try {
  // waitForBrowser answers with the whole /json/version object, not a URL.
  const version = await waitForBrowser(PORT);
  client = await connect(version.webSocketDebuggerUrl);

  const worker = await findWorker(PORT);
  const extensionId = new URL(worker.url).host;

  // The page, in its own window at the width it will occupy in the image.
  const { targetId: pageTarget } = await client.send('Target.createTarget', {
    url: 'about:blank', newWindow: true, width: PAGE_WIDTH, height: HEIGHT,
  });
  const page = await attach(client, pageTarget);
  // Chrome 153 ignores the `url` given to Target.createTarget and leaves the
  // new window at about:blank, so the navigation has to be asked for.
  await client.send('Page.navigate', { url: target }, page);
  await client.send('Emulation.setDeviceMetricsOverride',
    { width: PAGE_WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, page);
  await sleep(2500);

  // The panel, opened as an ordinary tab pointed at that page's tab id.
  const panelUrl = `chrome-extension://${extensionId}/src/panel/panel.html`;
  const { targetId: panelTarget } = await client.send('Target.createTarget', {
    url: 'about:blank', newWindow: true, width: PANEL_WIDTH, height: HEIGHT,
  });
  const panelSession = await attach(client, panelTarget);
  await client.send('Page.navigate', { url: panelUrl }, panelSession);
  await sleep(900);
  const tabId = await evaluate(client, panelSession, `(async () => {
    const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pattern)} });
    if (!tabs.length) throw new Error('the page tab went missing');
    return tabs[0].id;
  })()`);
  await client.send('Page.navigate', { url: `${panelUrl}?tabId=${tabId}` }, panelSession);
  await sleep(1500);
  await client.send('Emulation.setDeviceMetricsOverride',
    { width: PANEL_WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, panelSession);

  const panel = { inPanel: (expression) => evaluate(client, panelSession, expression) };
  const tiles = await panel.inPanel('document.querySelectorAll("mg-item").length');
  if (!tiles) throw new Error('the panel found nothing on the page - nothing worth photographing');
  console.log(`panel is showing ${tiles} items from ${target}`);

  // A third page holds the two images side by side, at the store's exact size.
  const { targetId: frameTarget } = await client.send('Target.createTarget', {
    url: 'about:blank', newWindow: true, width: PAGE_WIDTH + PANEL_WIDTH, height: HEIGHT,
  });
  const frame = await attach(client, frameTarget);
  await client.send('Emulation.setDeviceMetricsOverride',
    { width: PAGE_WIDTH + PANEL_WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, frame);
  const { frameTree } = await client.send('Page.getFrameTree', {}, frame);
  const frameId = frameTree.frame.id;

  for (const scene of SCENES) {
    await scene.setUp(panel);
    const pageShot = await client.send('Page.captureScreenshot', { format: 'png' }, page);
    const panelShot = await client.send('Page.captureScreenshot', { format: 'png' }, panelSession);
    await client.send('Page.setDocumentContent', {
      frameId: frameId,
      html: `<!doctype html><html><head><meta charset="utf-8"></head><body>${composite(pageShot.data, panelShot.data, scene.caption)}</body></html>`,
    }, frame);

    // Both halves have to have decoded before the shutter. Without this check
    // an empty frame is captured, written, and reported as a success - which
    // is exactly what a too-long data: URL produced the first time round.
    const drawn = await evaluate(client, frame, `(async () => {
      const images = [...document.images];
      await Promise.all(images.map((i) => i.decode().catch(() => {})));
      return images.filter((i) => i.naturalWidth > 0).length;
    })()`);
    if (drawn !== 2) throw new Error(`${scene.name}: ${drawn} of 2 halves rendered`);

    const { data } = await client.send('Page.captureScreenshot', { format: 'png' }, frame);
    const bytes = Buffer.from(data, 'base64');
    writeFileSync(join(OUT, scene.name), bytes);
    console.log(`  wrote docs/store/${scene.name} (${PAGE_WIDTH + PANEL_WIDTH}x${HEIGHT}, ${(bytes.length / 1024).toFixed(0)} KB)`);
  }

  console.log(`\n${SCENES.length} screenshots at ${PAGE_WIDTH + PANEL_WIDTH}x${HEIGHT}, ready for the listing.`);
} catch (err) {
  console.error(`store screenshots failed: ${err.message}`);
  if (chrome.stderr.length) console.error(chrome.stderr.join('').slice(-1500));
  process.exitCode = 1;
} finally {
  if (client) client.close();
  chrome.kill();
  if (site) await site.close();
}
