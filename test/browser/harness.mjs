/**
 * Shared plumbing for the browser-level checks: find a Chromium, launch it
 * with the unpacked extension, and talk CDP over Node's built-in WebSocket.
 * No dependencies, in keeping with the rest of the project.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: a directory name containing a space would
// otherwise reach Chrome percent-encoded and the extension would not load.
export const EXTENSION_DIR = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = [
  process.env.CHROME_PATH,
  join(homedir(), 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** @returns {string|null} */
export function findChrome() {
  for (const path of CANDIDATES) {
    if (path && existsSync(path)) return path;
  }
  // Any playwright chromium build, whatever its revision.
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (existsSync(cache)) {
    for (const dir of ['chromium-1234']) {
      const guess = join(cache, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if (existsSync(guess)) return guess;
    }
  }
  return null;
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
