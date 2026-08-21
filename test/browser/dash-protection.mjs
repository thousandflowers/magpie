/**
 * The DRM boundary for DASH, checked in the real panel rather than against a
 * restatement of its logic: the manifests are handed to the actual
 * renderStream path and the resulting controls are read back out of the DOM.
 */

import {
  findChrome, launchChrome, waitForBrowser, listTargets,
  connect, attach, collectErrors, evaluate, sleep,
} from './harness.mjs';
import { PROTECTED_MPD, CLEAN_MPD } from '../fixtures/dash.mjs';

const PORT = 9334;
const STREAM_ACTIONS = ['copy yt-dlp command', 'copy ffmpeg command', 'export segment list'];
const PROTECTED_URL = 'https://stream.example.com/vod/asset-42/protected.mpd';
const CLEAN_URL = 'https://stream.example.com/vod/asset-43/clean.mpd';

const binary = findChrome();
if (!binary) {
  console.log('SKIP DASH protection browser check: no Chromium found. Set CHROME_PATH to run it.');
  process.exit(0);
}

const chrome = launchChrome(binary, PORT);
const errors = [];
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? '✔' : '✖'} ${label}`);
  if (!ok) failures.push(label);
};

let client;
try {
  const version = await waitForBrowser(PORT);
  client = await connect(version.webSocketDebuggerUrl);
  collectErrors(client, errors);

  let worker = null;
  for (let i = 0; i < 40 && !worker; i += 1) {
    worker = (await listTargets(PORT)).find((t) => t.url.includes('/src/background/service-worker.js'));
    if (!worker) await sleep(500);
  }
  if (!worker) throw new Error('service worker never registered');
  const extensionId = new URL(worker.url).host;

  const { targetId } = await client.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/src/panel/panel.html`,
  });
  const panel = await attach(client, targetId);
  await sleep(1500);

  // Point the panel at the blank tab, then feed it two stream items the way a
  // HAR import would.
  // A match pattern cannot select about:blank, so pick any non-extension tab.
  const tabId = await evaluate(client, panel, `(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => !String(t.url || '').startsWith('chrome-extension://')) || tabs[0];
    if (!tab) throw new Error('no tab to attach the index to');
    return tab.id;
  })()`);
  await evaluate(client, panel, `(async () => {
    const ask = (m) => new Promise(r => chrome.runtime.sendMessage(m, x => { void chrome.runtime.lastError; r(x); }));
    return ask({ type: 'import-har', tabId: ${tabId}, items: [
      { url: ${JSON.stringify(PROTECTED_URL)}, mimeType: 'application/dash+xml', kind: 'stream', status: 'background' },
      { url: ${JSON.stringify(CLEAN_URL)}, mimeType: 'application/dash+xml', kind: 'stream', status: 'background' },
    ] });
  })()`);

  await client.send('Page.navigate', {
    url: `chrome-extension://${extensionId}/src/panel/panel.html?tabId=${tabId}`,
  }, panel);
  await sleep(2500);

  // Serve the fixtures in place of the network. Nothing here leaves the machine.
  await evaluate(client, panel, `(() => {
    const bodies = {
      ${JSON.stringify(PROTECTED_URL)}: ${JSON.stringify(PROTECTED_MPD)},
      ${JSON.stringify(CLEAN_URL)}: ${JSON.stringify(CLEAN_MPD)},
    };
    window.fetch = async (url) => ({
      ok: true, status: 200, headers: new Headers(),
      text: async () => bodies[String(url)] || '',
    });
    return true;
  })()`);

  const inspect = async (url) => {
    await evaluate(client, panel, `(() => {
      const tile = [...document.querySelectorAll('mg-item')].find(t => t.item && t.item.url === ${JSON.stringify(url)});
      if (!tile) throw new Error('tile not rendered for ' + ${JSON.stringify(url)});
      tile.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
      return true;
    })()`);
    await sleep(1800);
    return evaluate(client, panel, `(() => {
      const detail = document.getElementById('detail');
      const tile = [...document.querySelectorAll('mg-item')].find(t => t.item && t.item.url === ${JSON.stringify(url)});
      return {
        text: detail.textContent,
        status: tile ? tile.item.status : null,
        badge: tile && tile.querySelector('.badge') ? tile.querySelector('.badge').textContent : null,
        buttons: [...detail.querySelectorAll('button')].map(b => ({ label: b.textContent.trim(), disabled: b.disabled })),
        variantRows: detail.querySelectorAll('.variants tr').length,
        resolutions: [...detail.querySelectorAll('.variants td')].map(td => td.textContent).filter(t => /^\\d+x\\d+$/.test(t)),
        commands: [...detail.querySelectorAll('pre.command')].map(p => p.textContent.slice(0, 20)),
      };
    })()`);
  };

  /* ---------------- protected ---------------- */
  const bad = await inspect(PROTECTED_URL);
  check(bad.status === 'protected', 'protected MPD: item is marked `protected`');
  check(bad.badge === 'DRM', 'protected MPD: tile carries the DRM badge');
  check(/DRM protected/.test(bad.text) && /not downloadable/.test(bad.text),
    'protected MPD: panel says "DRM protected — not downloadable"');
  check(/widevine/i.test(bad.text), 'protected MPD: the key system is named');
  for (const action of STREAM_ACTIONS) {
    check(!bad.buttons.some((b) => b.label === action), `protected MPD: "${action}" is not offered`);
  }
  check(bad.buttons.some((b) => b.label === 'download' && b.disabled),
    'protected MPD: the download control is disabled');
  check(bad.commands.length === 0, 'protected MPD: no shell command is generated');
  check(bad.variantRows === 0, 'protected MPD: no variants are listed');

  /* ---------------- clean ---------------- */
  const good = await inspect(CLEAN_URL);
  check(good.status !== 'protected', 'clean MPD: item is not marked protected');
  check(good.variantRows === 4, `clean MPD: 3 variants listed plus a header (got ${good.variantRows})`);
  check(
    ['1920x1080', '1280x720', '640x360'].every((r) => good.resolutions.includes(r)),
    `clean MPD: resolutions listed (${good.resolutions.join(', ')})`,
  );
  for (const action of STREAM_ACTIONS) {
    const button = good.buttons.find((b) => b.label === action);
    check(Boolean(button) && !button.disabled, `clean MPD: "${action}" is offered and enabled`);
  }
  check(good.commands.length === 2, 'clean MPD: yt-dlp and ffmpeg commands are generated');

  const unexpected = errors.filter((e) => !/favicon|ERR_/.test(e));
  check(unexpected.length === 0, `no console errors${unexpected.length ? `: ${unexpected.join(' | ')}` : ''}`);
} catch (err) {
  console.error(`✖ DASH protection browser check crashed: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (client) client.close();
  chrome.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} assertion(s) failed`);
  process.exitCode = 1;
} else if (!process.exitCode) {
  console.log('\nall DASH protection assertions passed');
}
