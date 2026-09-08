/**
 * Smoke test: does the extension actually load?
 *
 * A single bad value in the webRequest type filter once threw at worker
 * startup, so the service worker never registered and nothing worked at all.
 * No unit test could reach that; this can.
 */

import {
  findChrome, launchChrome, waitForBrowser, listTargets,
  connect, attach, collectErrors, evaluate, sleep,
} from './harness.mjs';

const PORT = 9333;
const binary = findChrome();
if (!binary) {
  const message = 'no Chromium found. Set CHROME_PATH to point at one.';
  if (process.env.CI) {
    // Skipping on CI would make this entire class of bug invisible again,
    // which is the one thing this test exists to prevent.
    console.error(`✖ service-worker smoke test cannot be skipped on CI: ${message}`);
    process.exit(1);
  }
  console.log(`SKIP service-worker smoke test: ${message}`);
  process.exit(0);
}

const chrome = launchChrome(binary, PORT);
const errors = [];
let client;
try {
  const version = await waitForBrowser(PORT);
  client = await connect(version.webSocketDebuggerUrl);
  collectErrors(client, errors);

  let worker = null;
  let targets = [];
  for (let i = 0; i < 40 && !worker; i += 1) {
    targets = await listTargets(PORT);
    worker = targets.find((t) => t.url.includes('/src/background/service-worker.js'));
    if (!worker) await sleep(500);
  }
  if (!worker) {
    // Branded Google Chrome (137+) ignores --load-extension without a word;
    // the target list and Chrome's own stderr are the only evidence there is.
    const seen = targets.map((t) => `${t.type} ${t.url}`).join('\n    ') || '(none)';
    const said = chrome.stderr.join('').trim().slice(-1500) || '(nothing on stderr)';
    throw new Error(`service worker never registered\n  targets:\n    ${seen}\n  chrome stderr:\n${said}`);
  }

  const session = await attach(client, worker.id);
  await sleep(1500);
  const alive = await evaluate(client, session,
    `[typeof chrome.webRequest, typeof chrome.downloads, typeof chrome.contextMenus].join(',')`);
  if (alive !== 'object,object,object') throw new Error(`worker APIs unavailable: ${alive}`);
  if (errors.length) throw new Error(`console errors:\n  ${errors.join('\n  ')}`);

  console.log(`✔ service worker registered and clean (${worker.url})`);
} catch (err) {
  console.error(`✖ service-worker smoke test failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (client) client.close();
  chrome.kill();
}
