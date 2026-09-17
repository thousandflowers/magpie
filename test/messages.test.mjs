import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeCandidate, MAX_DATA_URL } from '../src/shared/messages.js';

test('a data: URL survives sanitising intact - a truncated one is a corrupt file', () => {
  // ~16 KB of base64, the size of a small inline PNG: well over the 4 KB cap
  // that applies to ordinary URLs.
  const url = `data:image/png;base64,${'A'.repeat(16 * 1024)}`;
  const clean = sanitizeCandidate({ url, kind: 'image' });
  assert.equal(clean.url, url);
});

test('a data: URL past the index budget is dropped, never cut short', () => {
  const url = `data:image/png;base64,${'A'.repeat(MAX_DATA_URL + 1)}`;
  assert.equal(sanitizeCandidate({ url, kind: 'image' }), null);
});

test('an ordinary URL is still capped', () => {
  const url = `https://cdn.example.com/${'a'.repeat(5000)}.jpg`;
  assert.equal(sanitizeCandidate({ url }).url.length, 4096);
});

test('synthetic and preview fields are carried through', () => {
  const clean = sanitizeCandidate({
    url: 'magpie-canvas:m1', synthetic: 'canvas', previewUrl: 'https://x.test/t.jpg',
  });
  assert.equal(clean.synthetic, 'canvas');
  assert.equal(clean.previewUrl, 'https://x.test/t.jpg');
});

/* ------------------------------------------------------------------ *
 * A candidate arrives from a page
 *
 * The MAIN-world bridge's token is a namespace shipped in the CRX, not a
 * secret: any script on the page can post a well-formed candidate. What
 * survives sanitising reaches img.src in the panel, a credentialed fetch from
 * the HEAD upgrade check, and chrome.downloads.download - so a URL whose
 * scheme is not a way of fetching bytes has no business in the index.
 * ------------------------------------------------------------------ */

test('a candidate whose scheme is not fetchable is refused', () => {
  for (const url of [
    'javascript:fetch("https://attacker.example")',
    'chrome-extension://abcdefghijklmnop/panel.html',
    'file:///etc/passwd',
    'filesystem:https://e.com/temporary/x.jpg',
    'about:blank',
    'ws://e.com/socket',
  ]) {
    assert.equal(sanitizeCandidate({ url }), null, `${url} was accepted`);
  }
});

test('the schemes media actually arrives on are kept', () => {
  for (const url of [
    'https://e.com/a.jpg',
    'http://e.com/a.jpg',
    'blob:https://e.com/6f1a',
    'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  ]) {
    const out = sanitizeCandidate({ url });
    assert.ok(out && out.url === url, `${url} was refused`);
  }
});

test('previewUrl and upgradeUrl are held to the same rule', () => {
  const out = sanitizeCandidate({
    url: 'https://e.com/a.jpg',
    previewUrl: 'javascript:alert(1)',
    upgradeUrl: 'file:///etc/passwd',
  });
  assert.equal(out.previewUrl, '', 'previewUrl reaches img.src');
  assert.equal(out.upgradeUrl, '', 'upgradeUrl is fetched with credentials');
});
