/**
 * Shared plumbing for the end-to-end runs: assertions that print as they go,
 * polling, a file lister, a launched Chrome with the extension attached, and
 * the panel opened as a tab against a given page.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  findChrome, launchChrome, waitForBrowser, listTargets,
  connect, attach, collectErrors, evaluate, sleep,
} from './harness.mjs';

export { sleep, evaluate, attach };

export const failures = [];

export function check(ok, label) {
  console.log(`${ok ? '✔' : '✖'} ${label}`);
  if (!ok) failures.push(label);
}

export async function waitFor(probe, { timeout = 15000, every = 300, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function listFiles(root, prefix = '') {
  const out = [];
  for (const name of readdirSync(join(root, prefix))) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = statSync(join(root, rel));
    if (stat.isDirectory()) out.push(...listFiles(root, rel));
    else if (!name.endsWith('.crdownload')) out.push({ path: rel, size: stat.size });
  }
  return out;
}

/** A Chromium to run in, or a clean exit - which CI is not allowed to take. */
export function requireChrome(what) {
  const binary = findChrome();
  if (binary) return binary;
  const message = 'no Chromium found. Set CHROME_PATH to point at one.';
  if (process.env.CI) {
    console.error(`✖ ${what} cannot be skipped on CI: ${message}`);
    process.exit(1);
  }
  console.log(`SKIP ${what}: ${message}`);
  process.exit(0);
}

export function findWorker(port) {
  return waitFor(
    async () => (await listTargets(port)).find((t) => t.url.includes('/src/background/service-worker.js')),
    { label: 'service worker', timeout: 20000 },
  );
}

/** Launch Chrome with the extension, attach to its worker, hand back a CDP client. */
export async function launchWithExtension(binary, port, { downloadDir } = {}) {
  const chrome = launchChrome(binary, port, [], { downloadDir });
  const errors = [];
  const version = await waitForBrowser(port);
  const client = await connect(version.webSocketDebuggerUrl);
  collectErrors(client, errors);
  const worker = await findWorker(port);
  await attach(client, worker.id);
  // Attaching the debugger to the worker and navigating in the same instant
  // loses the page's webRequest events about half the time. A harness
  // artefact - nothing attaches to the worker in normal use - so wait it out.
  await sleep(500);
  return { chrome, client, errors, worker, extensionId: new URL(worker.url).host };
}

/**
 * Open a URL in its own window and attach to it, so its errors are collected.
 * Its own window, not a tab behind the panel's: a hidden tab has its timers
 * clamped to one a second and its IntersectionObservers never fire, which is
 * not how the tab a person is looking at behaves - and the explorer relies on
 * both to make lazy images load.
 */
export async function openPage(client, url) {
  const { targetId } = await client.send('Target.createTarget', { url, newWindow: true });
  const session = await attach(client, targetId);
  return { targetId, session };
}

/**
 * Open the panel as its own tab, pointed at the tab whose URL matches
 * `pattern`, and return the handles the checks read it through.
 */
export async function openPanelFor(client, extensionId, pattern) {
  const panelUrl = `chrome-extension://${extensionId}/src/panel/panel.html`;
  const { targetId, session: panel } = await openPage(client, panelUrl);
  await sleep(800);
  const tabId = await evaluate(client, panel, `(async () => {
    const tabs = await chrome.tabs.query({ url: ${JSON.stringify(pattern)} });
    if (!tabs.length) throw new Error('no tab matches ' + ${JSON.stringify(pattern)});
    return tabs[0].id;
  })()`);
  await client.send('Page.navigate', { url: `${panelUrl}?tabId=${tabId}` }, panel);
  await sleep(800);

  const ask = (message) => evaluate(client, panel,
    `new Promise((resolve) => chrome.runtime.sendMessage(${JSON.stringify(message)}, (r) => { void chrome.runtime.lastError; resolve(r); }))`);
  const inPanel = (expression) => evaluate(client, panel, expression);
  return {
    targetId,
    panel,
    tabId,
    ask,
    inPanel,
    toTab: (message) => evaluate(client, panel,
      `new Promise((resolve) => chrome.tabs.sendMessage(${tabId}, ${JSON.stringify(message)}, (r) => { void chrome.runtime.lastError; resolve(r); }))`),
    getState: (extra = {}) => ask({ type: 'get-state', tabId, ...extra }),
    tileCount: () => inPanel(`document.querySelectorAll('mg-item').length`),
    progress: () => inPanel(`document.getElementById('progress-text').textContent`),
    /** Click the tile carrying the item whose URL ends with `suffix`; detail 2 opens the drawer. */
    clickTile: (suffix, detail = 1) => inPanel(`(() => {
      const tile = [...document.querySelectorAll('mg-item')]
        .find((t) => t.item && t.item.url.endsWith(${JSON.stringify(suffix)}));
      if (!tile) throw new Error('no tile for ' + ${JSON.stringify(suffix)});
      tile.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: ${Number(detail)} }));
      return true;
    })()`),
    clickButton: (label, scope = '#detail') => inPanel(`(() => {
      const button = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')]
        .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
      if (!button) throw new Error('no button ' + ${JSON.stringify(label)});
      button.click();
      return true;
    })()`),
  };
}

export function report(name) {
  if (failures.length) {
    console.error(`\n${failures.length} assertion(s) failed`);
    process.exitCode = 1;
  } else if (!process.exitCode) {
    console.log(`\nall ${name} assertions passed`);
  }
}
