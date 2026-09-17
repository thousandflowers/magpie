import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeUrl, patternOf, jaccard, bareHost, registrableDomain,
  genericiseFilename, pathTokens, expiryInfo, toURL,
} from '../src/core/url-normalize.js';

test('normalizeUrl drops tracking noise but keeps size-bearing keys', () => {
  assert.equal(
    normalizeUrl('https://cdn.example.com/p/a.jpg?utm_source=x&w=800&h=600&_=1723'),
    'https://cdn.example.com/p/a.jpg?h=600&w=800',
  );
  assert.equal(
    normalizeUrl('https://cdn.example.com/p/a.jpg?fbclid=abc'),
    'https://cdn.example.com/p/a.jpg',
  );
});

test('normalizeUrl keeps signature params so a pre-signed URL still resolves', () => {
  const signed =
    'https://bucket.s3.amazonaws.com/k.jpg?X-Amz-Signature=deadbeef&X-Amz-Expires=900&foo=1';
  const out = normalizeUrl(signed);
  assert.ok(out.includes('x-amz-signature=deadbeef'));
  assert.ok(out.includes('x-amz-expires=900'));
  // `foo=1` used to be dropped here, and that assertion was wrong. This value
  // is the per-tab dedupe key, and an unrecognised key is far more often what
  // selects the asset than it is noise - so dropping it merged two different
  // photos and threw the second one's URL away. Unknown keys are kept now;
  // known tracking keys are still dropped, which the tests below cover.
  assert.ok(out.includes('foo=1'));
});

test('normalizeUrl is stable across equivalent spellings', () => {
  const forms = [
    'https://Example.COM:443/a/b/c.png#frag',
    'https://example.com/a/b/c.png',
    'https://example.com/a/b/c.png/',
  ];
  const [first] = forms.map((f) => normalizeUrl(f));
  for (const f of forms) assert.equal(normalizeUrl(f), first);
  assert.equal(first, 'https://example.com/a/b/c.png');
});

test('normalizeUrl sorts query keys so ordering cannot create duplicates', () => {
  assert.equal(
    normalizeUrl('https://e.com/a.jpg?h=2&w=1'),
    normalizeUrl('https://e.com/a.jpg?w=1&h=2'),
  );
});

test('normalizeUrl passes data:, blob: and junk through untouched', () => {
  assert.equal(normalizeUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(normalizeUrl('blob:https://e.com/abc-123'), 'blob:https://e.com/abc-123');
  assert.equal(normalizeUrl('not a url'), 'not a url');
  assert.equal(normalizeUrl(null), '');
});

test('normalizeUrl resolves relative and protocol-relative inputs', () => {
  assert.equal(
    normalizeUrl('/img/a.jpg', 'https://e.com/page/index.html'),
    'https://e.com/img/a.jpg',
  );
  assert.equal(normalizeUrl('//cdn.e.com/a.jpg'), 'https://cdn.e.com/a.jpg');
});

test('patternOf genericises digit and hash path segments', () => {
  const p = patternOf('https://img.cdn.net/a/f3d9c2b1/2024/08/photo_01.jpg');
  assert.equal(p.host, 'img.cdn.net');
  assert.equal(p.dir, '/a/*/*/*');
  assert.equal(p.file, 'photo_#.jpg');
  assert.equal(p.ext, 'jpg');
  assert.equal(p.pattern, '/a/*/*/*/photo_#.jpg');
});

test('patternOf keeps the extension and collapses digit runs in the stem', () => {
  assert.equal(genericiseFilename('IMG_20240817_113355.JPG'), 'img_#_#.jpg');
  assert.equal(genericiseFilename('beach-01-150x150.jpg'), 'beach-#-#x#.jpg');
  assert.equal(genericiseFilename('9f86d081884c7d65'), '*');
  assert.equal(genericiseFilename('logo.svg'), 'logo.svg');
  assert.equal(genericiseFilename(''), '');
});

test('two renditions of the same asset share a pattern', () => {
  const a = patternOf('https://cdn.e.com/photos/2024/08/img-01.jpg');
  const b = patternOf('https://cdn.e.com/photos/2023/01/img-99.jpg');
  assert.equal(a.pattern, b.pattern);
});

test('host helpers', () => {
  assert.equal(bareHost('WWW.Example.com:8080'), 'example.com');
  assert.equal(bareHost('m.example.com'), 'example.com');
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('cdn.example.com'), 'example.com');
  assert.equal(registrableDomain('example.com'), 'example.com');
});

test('pathTokens drops numeric and hash noise', () => {
  assert.deepEqual(
    pathTokens('/photos/2024/f3d9c2b1/summer-beach_01.jpg'),
    ['photos', 'summer', 'beach', 'jpg'],
  );
});

test('jaccard', () => {
  assert.equal(jaccard([], []), 0);
  assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
});

test('expiryInfo reads S3-style pre-signed URLs', () => {
  const info = expiryInfo(
    'https://b.s3.amazonaws.com/k.jpg?X-Amz-Date=20240817T120000Z&X-Amz-Expires=900&X-Amz-Signature=ab',
  );
  assert.equal(info.expiring, true);
  assert.equal(info.expiresAt, Date.UTC(2024, 7, 17, 12, 0, 0) + 900_000);
});

test('expiryInfo reads unix-second Expires params', () => {
  const info = expiryInfo('https://cdn.e.com/v.mp4?Expires=1723900000&Signature=x');
  assert.equal(info.expiring, true);
  assert.equal(info.expiresAt, 1_723_900_000_000);
});

test('expiryInfo flags an opaque token even without a readable deadline', () => {
  const info = expiryInfo('https://cdn.e.com/v.mp4?token=opaque');
  assert.equal(info.expiring, true);
  assert.equal(info.expiresAt, null);
});

test('expiryInfo leaves plain URLs alone', () => {
  assert.deepEqual(expiryInfo('https://cdn.e.com/a.jpg'), { expiring: false, expiresAt: null });
  assert.deepEqual(expiryInfo('nonsense'), { expiring: false, expiresAt: null });
});

test('toURL never throws', () => {
  assert.equal(toURL(''), null);
  assert.equal(toURL('::::'), null);
  assert.equal(toURL(undefined), null);
  assert.ok(toURL('https://e.com') instanceof URL);
});

/* ------------------------------------------------------------------ *
 * The dedupe key must not merge two different assets
 *
 * The key is what the per-tab index is stored under, and a merge keeps the
 * first URL and throws the second away. Dropping every query key that is not
 * recognised as size- or auth-bearing means `?id=1001` and `?id=2002` share a
 * key, and one of the two photos is silently never offered. An unknown key is
 * far more often the thing that selects the asset than it is noise.
 * ------------------------------------------------------------------ */

test('an opaque asset selector keeps two assets apart', () => {
  const a = normalizeUrl('https://cdn.example.com/getimage?id=1001');
  const b = normalizeUrl('https://cdn.example.com/getimage?id=2002');
  assert.notEqual(a, b, 'two different photos collapsed into one key');
});

test('the common asset-selector spellings all survive', () => {
  const base = 'https://site.com/photo.php';
  for (const key of ['file', 'path', 'src', 'image', 'p', 'v', 'page']) {
    assert.notEqual(
      normalizeUrl(`${base}?${key}=a.jpg`),
      normalizeUrl(`${base}?${key}=b.jpg`),
      `?${key}= was dropped, so two assets share a key`,
    );
  }
});

test('tracking parameters are still dropped', () => {
  const bare = normalizeUrl('https://e.com/a.jpg');
  for (const q of ['utm_source=x&utm_medium=y', 'fbclid=abc', 'gclid=abc', '_ga=1', 'igshid=z']) {
    assert.equal(normalizeUrl(`https://e.com/a.jpg?${q}`), bare, `${q} survived`);
  }
});

test('a tracking parameter beside a real one drops only itself', () => {
  assert.equal(
    normalizeUrl('https://e.com/get?id=7&utm_source=news'),
    normalizeUrl('https://e.com/get?id=7'),
  );
});
