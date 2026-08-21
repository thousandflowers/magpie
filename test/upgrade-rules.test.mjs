import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  genericUpgrades, siteUpgrades, upgradeCandidates,
} from '../src/core/upgrade-rules.js';

const SITE_RULES = JSON.parse(
  readFileSync(new URL('../rules/site-rules.json', import.meta.url), 'utf8'),
).rules;

/** Assert that `want` appears among the produced candidates. */
function includes(list, want, msg) {
  const urls = list.map((c) => (typeof c === 'string' ? c : c.url));
  assert.ok(urls.includes(want), `${msg || 'missing'}\n  want: ${want}\n  got:  ${urls.join('\n        ')}`);
}

test('WordPress dimension suffix is stripped', () => {
  includes(
    genericUpgrades('https://blog.e.com/wp-content/uploads/2024/08/beach-01-150x150.jpg'),
    'https://blog.e.com/wp-content/uploads/2024/08/beach-01.jpg',
  );
  includes(
    genericUpgrades('https://e.com/img/photo-300x200.png'),
    'https://e.com/img/photo.png',
  );
});

test('a legitimate filename that merely contains digits is not mangled', () => {
  const out = genericUpgrades('https://e.com/img/photo-2024.jpg');
  assert.ok(!out.includes('https://e.com/img/photo.jpg'), 'photo-2024 is not a rendition');
});

test('thumbnail stem suffixes are stripped and larger variants proposed', () => {
  const out = genericUpgrades('https://e.com/i/sunset_thumb.jpg');
  includes(out, 'https://e.com/i/sunset.jpg');
  includes(out, 'https://e.com/i/sunset_large.jpg');
  includes(out, 'https://e.com/i/sunset_o.jpg');
  includes(genericUpgrades('https://e.com/i/logo.min.png'), 'https://e.com/i/logo.png');
});

test('thumbnail directories are swapped for full-size directories', () => {
  const out = genericUpgrades('https://e.com/thumbs/a/pic.jpg');
  includes(out, 'https://e.com/originals/a/pic.jpg');
  includes(out, 'https://e.com/original/a/pic.jpg');
  includes(out, 'https://e.com/a/pic.jpg', 'dropping the segment entirely is also tried');

  includes(genericUpgrades('https://e.com/preview/x.png'), 'https://e.com/original/x.png');
  includes(genericUpgrades('https://e.com/small/x.png'), 'https://e.com/large/x.png');
});

test('resize, quality and format query parameters are removed', () => {
  includes(
    genericUpgrades('https://cdn.e.com/i/a.jpg?w=300&h=200&quality=60'),
    'https://cdn.e.com/i/a.jpg',
  );
  includes(
    genericUpgrades('https://cdn.e.com/i/a.jpg?w=300&quality=60'),
    'https://cdn.e.com/i/a.jpg?w=300&quality=100',
    'a size-only CDN gets max quality as a fallback',
  );
  includes(
    genericUpgrades('https://cdn.e.com/i/a.jpg?format=webp'),
    'https://cdn.e.com/i/a.jpg',
  );
});

test('Cloudinary-style transform segments are dropped', () => {
  includes(
    genericUpgrades('https://res.cdn.com/demo/image/upload/w_300,h_200,c_fill/dog.jpg'),
    'https://res.cdn.com/demo/image/upload/dog.jpg',
  );
});

test('Google-style =s220 size suffixes are widened', () => {
  const out = genericUpgrades('https://lh3.googleusercontent.com/abcDEF=s220-c');
  includes(out, 'https://lh3.googleusercontent.com/abcDEF=s0');
  includes(out, 'https://lh3.googleusercontent.com/abcDEF');
});

test('Wikimedia thumb paths resolve to the original file', () => {
  const url =
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Sunset.jpg/220px-Sunset.jpg';
  includes(genericUpgrades(url), 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Sunset.jpg');
  includes(
    siteUpgrades(url, SITE_RULES),
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Sunset.jpg',
    'the shipped site rule agrees with the generic rule',
  );
});

test('an already-full-size URL yields no misleading candidates', () => {
  assert.deepEqual(genericUpgrades('https://e.com/photos/sunset.jpg'), []);
  assert.deepEqual(genericUpgrades('not-a-url'), []);
  assert.deepEqual(genericUpgrades('data:image/png;base64,AA'), []);
});

test('candidates never include the input URL and never repeat', () => {
  const input = 'https://e.com/thumbs/a/pic_small.jpg?w=100&quality=50';
  const out = genericUpgrades(input);
  assert.ok(!out.includes(input));
  assert.equal(new Set(out).size, out.length);
});

/* ------------------------- site rules ------------------------- */

test('every shipped site rule has a valid shape and compiles', () => {
  assert.ok(SITE_RULES.length > 0);
  for (const rule of SITE_RULES) {
    assert.equal(typeof rule.match, 'string', 'match is required');
    assert.equal(typeof rule.find, 'string', 'find is required');
    assert.equal(typeof rule.replace, 'string', 'replace is required');
    assert.doesNotThrow(() => new RegExp(rule.find), `bad regex in ${rule.match}`);
    if (rule.path) assert.doesNotThrow(() => new RegExp(rule.path));
  }
});

test('site rules match on hostname suffix, not substring', () => {
  const rules = [{ match: 'example.com', find: '/thumb/', replace: '/full/' }];
  includes(siteUpgrades('https://cdn.example.com/thumb/a.jpg', rules), 'https://cdn.example.com/full/a.jpg');
  assert.deepEqual(
    siteUpgrades('https://notexample.com/thumb/a.jpg', rules), [],
    'a suffix match must not fire on notexample.com',
  );
});

test('a shipped rule rewrites a real-world thumbnail', () => {
  includes(
    siteUpgrades('https://preview.redd.it/abc123.jpg?width=320&crop=smart', SITE_RULES),
    'https://i.redd.it/abc123.jpg',
  );
  includes(
    siteUpgrades('https://cdn.shopify.com/s/files/1/0/p/shirt_small.jpg', SITE_RULES),
    'https://cdn.shopify.com/s/files/1/0/p/shirt.jpg',
  );
});

test('a malformed rule is skipped rather than crashing the pass', () => {
  const rules = [
    { match: 'e.com', find: '([unclosed', replace: 'x' },
    { match: 'e.com', find: '_s\\.jpg$', replace: '.jpg' },
  ];
  includes(siteUpgrades('https://e.com/a_s.jpg', rules), 'https://e.com/a.jpg');
  assert.deepEqual(siteUpgrades('https://e.com/a.jpg', [null, {}, 3]), []);
});

test('upgradeCandidates puts site rules ahead of generic ones', () => {
  const url = 'https://preview.redd.it/abc123.jpg?width=320';
  const out = upgradeCandidates(url, SITE_RULES);
  assert.equal(out[0].url, 'https://i.redd.it/abc123.jpg');
  assert.ok(out.every((c) => typeof c.verify === 'boolean' && typeof c.note === 'string'));
  assert.equal(new Set(out.map((c) => c.url)).size, out.length, 'no duplicates');
});
