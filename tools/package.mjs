/**
 * Build the Chrome Web Store upload: dist/magpie-<version>.zip.
 *
 * The folder you clone is already the extension, so there is nothing to
 * compile. This script exists for the things a hand-made zip gets wrong: it
 * ships files the store has no business seeing (tests, screenshots, CI), and
 * it ships a manifest whose version has drifted from package.json.
 *
 * Every check below refuses rather than warns. A zip that uploads and is then
 * rejected days later costs more than a build that stops now.
 *
 * Usage: npm run package
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Everything the extension needs at runtime, and nothing else. */
const SHIPPED = ['manifest.json', 'icons', 'src', 'rules', 'LICENSE'];

/** The store's own limit. Well out of reach here, but drift is worth catching. */
const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024;

const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const json = (path) => JSON.parse(read(path));

/** @param {string} message */
function fail(message) {
  console.error(`package: ${message}`);
  process.exit(1);
}

const manifest = json('manifest.json');
const pkg = json('package.json');

// 1. Versions agree. Two files carry the number and only one is authoritative
// to the store; a mismatch means the zip you upload is not the version you
// tagged.
if (manifest.version !== pkg.version) {
  fail(`manifest.json is ${manifest.version} but package.json is ${pkg.version} - make them agree`);
}

// The store accepts one to four dot-separated integers, each 0-65535.
if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(manifest.version)
  || manifest.version.split('.').some((part) => Number(part) > 65535)) {
  fail(`"${manifest.version}" is not a version the Chrome Web Store accepts (1-4 integers, each 0-65535)`);
}

// 2. Every file the manifest names is actually there. Chrome reports a missing
// content script as a runtime error on the first page you visit, not at load.
const referenced = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((entry) => [...(entry.js ?? []), ...(entry.css ?? [])]),
  ...(manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []),
].filter(Boolean);

const missing = referenced.filter((path) => !existsSync(join(ROOT, path)));
if (missing.length > 0) fail(`manifest names files that do not exist: ${missing.join(', ')}`);

// 3. Everything the manifest names is inside what gets shipped. A path that
// resolves in the repo but sits outside SHIPPED loads unpacked and 404s once
// zipped - the worst kind of bug to find after upload.
const unshipped = referenced.filter((path) => !SHIPPED.some((dir) => path === dir || path.startsWith(`${dir}/`)));
if (unshipped.length > 0) fail(`manifest names files outside the shipped set: ${unshipped.join(', ')}`);

// 4. No remote code. Chrome Web Store policy forbids fetching executable code
// at runtime, and the README promises no CDN, no web fonts, no analytics.
// Checking the promise is cheaper than defending it in a review appeal.
const REMOTE_CODE = [
  [/\beval\s*\(/, 'eval()'],
  [/new\s+Function\s*\(/, 'new Function()'],
  [/importScripts\s*\(/, 'importScripts()'],
  [/<script[^>]+src\s*=\s*["']https?:/i, 'a remote <script src>'],
  [/@import\s+url\(\s*["']?https?:/i, 'a remote CSS @import'],
  [/["']https?:\/\/[^"']*\.(?:js|mjs|css|woff2?)\b/i, 'a remote script, stylesheet or font URL'],
];

const sources = execFileSync('git', ['ls-files', '-z', ...SHIPPED], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((path) => /\.(js|mjs|html|css|json)$/.test(path));

if (sources.length === 0) fail('git ls-files returned no source files - is this a git checkout?');

const offences = [];
for (const path of sources) {
  const text = read(path);
  for (const [pattern, what] of REMOTE_CODE) {
    if (pattern.test(text)) offences.push(`${path}: ${what}`);
  }
}
if (offences.length > 0) {
  fail(`remote code or a remote asset would ship, which the store rejects:\n  ${offences.join('\n  ')}`);
}

// 5. Build the zip from a staging copy, so a stray untracked file in the repo
// (a scratch note, a .DS_Store, a downloaded sample) cannot ride along.
const stage = mkdtempSync(join(tmpdir(), 'magpie-package-'));
const dist = join(ROOT, 'dist');
const zipPath = join(dist, `magpie-${manifest.version}.zip`);

try {
  for (const entry of SHIPPED) {
    cpSync(join(ROOT, entry), join(stage, entry), {
      recursive: true,
      filter: (source) => !/(^|\/)(\.DS_Store|\.git|node_modules)$/.test(source),
    });
  }

  mkdirSync(dist, { recursive: true });
  rmSync(zipPath, { force: true });
  // -X drops the extra macOS attributes; -r recurses; . is the staging root,
  // so paths inside the zip start at manifest.json as the store requires.
  execFileSync('zip', ['-rXq', zipPath, '.'], { cwd: stage });
} finally {
  rmSync(stage, { recursive: true, force: true });
}

const { size } = statSync(zipPath);
if (size > MAX_ZIP_BYTES) fail(`${zipPath} is ${size} bytes, over the store's limit`);

const listed = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

if (!listed.includes('manifest.json')) fail('manifest.json is not at the root of the zip');

console.log(`magpie ${manifest.version} -> dist/magpie-${manifest.version}.zip`);
console.log(`${listed.length} entries, ${(size / 1024).toFixed(1)} KB`);
console.log(`${sources.length} source files scanned, no remote code`);
