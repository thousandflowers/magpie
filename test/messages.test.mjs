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
