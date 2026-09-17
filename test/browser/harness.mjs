/**
 * Shared plumbing for the browser-level checks: find a Chromium, launch it
 * with the unpacked extension, and talk CDP over Node's built-in WebSocket.
 * No dependencies, in keeping with the rest of the project.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: a directory name containing a space would
// otherwise reach Chrome percent-encoded and the extension would not load.
//
// MAGPIE_EXTENSION_DIR points the checks at an unpacked copy instead of the
// repo. The release workflow unzips the built artefact and sets it, so the
// smoke test proves the thing that ships rather than the thing it was built
// from - a file left out of the zip is otherwise invisible until install.
export const EXTENSION_DIR = process.env.MAGPIE_EXTENSION_DIR
  ? resolve(process.env.MAGPIE_EXTENSION_DIR)
  : resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fixed install locations. Order does not decide the winner - rank() does.
const INSTALLED = [
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

// Where @puppeteer/browsers and playwright unpack their downloads, most
// preferred root first. Revisions are not listed: the tree under each root is
// walked, so any version found there works and none has to be named here.
// The two tools number their builds differently (`mac_arm-153.0.8010.47`
// against `chromium-1234`), so there is no meaningful order *between* roots -
// only within one, where a plain descending sort does put the newer build
// first.
const CACHE_ROOTS = [
  join(homedir(), '.cache/puppeteer'),
  join(homedir(), '.cache/ms-playwright'),
  join(homedir(), 'Library/Caches/ms-playwright'),
];

const BINARIES = new Set(['Google Chrome for Testing', 'Chromium', 'chrome', 'chromium']);

/**
 * Branded Google Chrome 137 and later ignores --load-extension without a word:
 * the browser starts, no service worker registers, and every browser check
 * reads like a regression in the extension. A Chrome for Testing or plain
 * Chromium build therefore wins over a branded one wherever both exist.
 * @param {string} path
 */
const isBranded = (path) => /Google Chrome(?:\.app|$)/.test(path) && !path.includes('for Testing');

/** Breadth-limited walk; the deepest hit (puppeteer's) sits 6 levels down. */
function* walk(dir, depth = 0) {
  if (depth > 7) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable or vanished mid-walk: not an error, just no Chrome here
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path, depth + 1);
    else if (entry.isFile() && BINARIES.has(entry.name)) yield path;
  }
}

/**
 * @returns {string|null} the best Chromium on this machine, or null. CHROME_PATH
 *   wins outright when it points at something that exists, so CI stays in charge.
 */
export function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

  const found = INSTALLED.filter((path) => existsSync(path));
  for (const root of CACHE_ROOTS) found.push(...[...walk(root)].sort().reverse());
  if (found.length === 0) return null;

  // A branded build is the last resort: it launches and then quietly refuses
  // to load the extension, which is worse than no browser at all.
  return found.find((path) => !isBranded(path)) ?? found[0];
}


/**
 * @param {string} binary
 * @param {number} port
 * @param {string[]} [extras] extra command-line switches
 * @param {{downloadDir?: string}} [opts] where downloads land. Set through the
 *   profile rather than CDP's Browser.setDownloadBehavior, which overrides the
 *   extension's own `filename` and names every file after its URL or a GUID.
 */
export function launchChrome(binary, port, extras = [], opts = {}) {
  // Chrome fails to load a bad --load-extension path silently: the browser
  // starts, no worker registers, and it reads exactly like a regression in the
  // extension. Check the path here so it reports itself instead.
  const manifest = join(EXTENSION_DIR, 'manifest.json');
  if (!existsSync(manifest)) {
    throw new Error(
      `no extension at ${EXTENSION_DIR} (expected ${manifest}) — the path is wrong, not the extension`,
    );
  }
  // Same silent failure from the other direction: the path is right, the
  // browser is the wrong build. Say so before the worker fails to appear.
  if (isBranded(binary)) {
    const complaint = `${binary} is a branded Google Chrome build; 137 and later ignore --load-extension, `
      + 'so no service worker will register. Install Chrome for Testing '
      + '(npx @puppeteer/browsers install chrome@stable) or point CHROME_PATH at one.';
    if (process.env.CI) throw new Error(complaint);
    console.warn(`WARNING: ${complaint}`);
  }
  const profile = mkdtempSync(join(tmpdir(), 'magpie-profile-'));
  if (opts.downloadDir) {
    mkdirSync(join(profile, 'Default'), { recursive: true });
    writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({
      download: { default_directory: opts.downloadDir, prompt_for_download: false },
    }));
  }
  const child = spawn(binary, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // CI runners have no usable sandbox; locally the sandbox stays on.
    ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    `--load-extension=${EXTENSION_DIR}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    ...extras,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  return {
    child,
    stderr,
    kill() {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/** Poll the DevTools HTTP endpoint until the browser answers. */
export async function waitForBrowser(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return res.json();
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome did not expose a DevTools endpoint in time');
}

export const listTargets = async (port) =>
  (await fetch(`http://127.0.0.1:${port}/json/list`)).json();

/** Minimal CDP client over the built-in WebSocket. */
export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = [];
  let id = 0;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  });
  return {
    on: (fn) => listeners.push(fn),
    send(method, params = {}, sessionId) {
      id += 1;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close: () => ws.close(),
  };
}

/** Attach to a target and turn on the two domains that report errors. */
export async function attach(client, targetId) {
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Runtime.enable', {}, sessionId);
  await client.send('Log.enable', {}, sessionId);
  return sessionId;
}

/** Collect console errors and uncaught exceptions from every attached target. */
export function collectErrors(client, sink) {
  client.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      sink.push(`uncaught: ${d.exception?.description || d.text}`);
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const { text, url } = m.params.entry;
      sink.push(`log: ${text}${url ? ` (${url})` : ''}`);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      sink.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
  });
}

export async function evaluate(client, sessionId, expression) {
  const r = await client.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}
