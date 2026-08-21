/**
 * Thumbnail -> original resolution. Pure: produces ordered *candidate* URLs.
 * Verification (HEAD, Content-Length comparison) happens in the background,
 * because a candidate that 404s is worse than no upgrade at all.
 */

import { toURL, SIZE_BEARING_KEYS } from './url-normalize.js';

/** Query keys whose presence means "a resized copy was requested". */
const RESIZE_KEYS = [
  'w', 'h', 'width', 'height', 'size', 'resize', 'fit', 'crop', 'sw', 'sh',
  'max-w', 'max-h', 'maxwidth', 'maxheight', 'thumb', 'thumbnail', 'sz', 's',
];
const QUALITY_KEYS = ['quality', 'q', 'compress', 'lossy', 'dpr'];
const FORMAT_KEYS = ['format', 'fm', 'output', 'auto'];

const THUMB_DIR_MAP = {
  thumb: ['original', 'large', 'full'],
  thumbs: ['originals', 'original', 'large', 'full'],
  thumbnail: ['original', 'large', 'full'],
  thumbnails: ['originals', 'original', 'large', 'full'],
  small: ['large', 'original', 'full'],
  preview: ['original', 'full', 'large'],
  medium: ['large', 'original', 'full'],
  resized: ['original', 'full'],
  tn: ['original', 'full'],
};

const STEM_SUFFIXES = [
  '_thumb', '-thumb', '_thumbnail', '-thumbnail', '_small', '-small',
  '_medium', '-medium', '_preview', '-preview', '_s', '-s', '_t', '-t',
  '_m', '-m', '.min', '.thumb', '_tn', '-tn', '_sm', '-sm', '_lo', '-lo',
];
const STEM_REPLACEMENTS = ['', '_large', '_o', '_orig', '_original', '_full', '_big', '_hd'];

function splitPath(u) {
  const segs = u.pathname.split('/');
  const file = segs.pop() || '';
  return { segs, file };
}

function withPath(u, segs, file) {
  const next = new URL(u.href);
  next.pathname = [...segs, file].join('/');
  return next.href;
}

function stemExt(file) {
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return { stem: file, ext: '' };
  return { stem: file.slice(0, dot), ext: file.slice(dot) };
}

/* ------------------------------------------------------------------ *
 * Individual generic rules. Each returns an array of candidate hrefs.
 * ------------------------------------------------------------------ */

/** WordPress: `photo-300x200.jpg` -> `photo.jpg` */
function wordpressSuffix(u) {
  const { segs, file } = splitPath(u);
  const { stem, ext } = stemExt(file);
  const m = /^(.*?)-\d{2,5}x\d{2,5}$/.exec(stem);
  if (!m || !m[1]) return [];
  return [withPath(u, segs, m[1] + ext)];
}

/** `photo_thumb.jpg` -> `photo.jpg`, `photo_large.jpg`, `photo_o.jpg` */
function stemSuffix(u) {
  const { segs, file } = splitPath(u);
  const { stem, ext } = stemExt(file);
  const lower = stem.toLowerCase();
  const hit = STEM_SUFFIXES.find((s) => lower.endsWith(s) && lower.length > s.length);
  if (!hit) return [];
  const base = stem.slice(0, stem.length - hit.length);
  return STEM_REPLACEMENTS.map((r) => withPath(u, segs, base + r + ext));
}

/** `/thumbs/x.jpg` -> `/original/x.jpg` and friends */
function thumbDirectory(u) {
  const { segs, file } = splitPath(u);
  const out = [];
  for (let i = 0; i < segs.length; i += 1) {
    const replacements = THUMB_DIR_MAP[segs[i].toLowerCase()];
    if (!replacements) continue;
    for (const r of replacements) {
      const copy = segs.slice();
      copy[i] = r;
      out.push(withPath(u, copy, file));
    }
    // Also try dropping the segment entirely — common on static hosts.
    out.push(withPath(u, segs.slice(0, i).concat(segs.slice(i + 1)), file));
  }
  return out;
}

/** Drop resize / quality / format query params. */
function queryStrip(u) {
  const out = [];
  const hasResize = RESIZE_KEYS.some((k) => u.searchParams.has(k));
  const hasQuality = QUALITY_KEYS.some((k) => u.searchParams.has(k));
  const hasFormat = FORMAT_KEYS.some((k) => u.searchParams.has(k));
  if (!hasResize && !hasQuality && !hasFormat) return out;

  const bare = new URL(u.href);
  for (const k of [...RESIZE_KEYS, ...QUALITY_KEYS, ...FORMAT_KEYS]) bare.searchParams.delete(k);
  out.push(bare.href);

  if (hasQuality && hasResize) {
    // Keep the resize but max the quality — some CDNs 404 without a size.
    const maxQ = new URL(u.href);
    for (const k of QUALITY_KEYS) if (maxQ.searchParams.has(k)) maxQ.searchParams.set(k, '100');
    out.push(maxQ.href);
  }
  if (hasFormat && !hasResize) {
    const noFormat = new URL(u.href);
    for (const k of FORMAT_KEYS) noFormat.searchParams.delete(k);
    out.push(noFormat.href);
  }
  return out;
}

/** Wikimedia: `/commons/thumb/a/ab/File.jpg/220px-File.jpg` -> `/commons/a/ab/File.jpg` */
function wikimedia(u) {
  const idx = u.pathname.indexOf('/thumb/');
  if (idx === -1) return [];
  const segs = u.pathname.split('/').filter((s, i, arr) => !(arr[i] === '' && i > 0));
  const t = segs.indexOf('thumb');
  if (t === -1 || segs.length < t + 4) return [];
  // Everything after `thumb` except the final size-prefixed rendition.
  const kept = segs.slice(0, t).concat(segs.slice(t + 1, segs.length - 1));
  const next = new URL(u.href);
  next.pathname = kept.join('/');
  next.search = '';
  return [next.href];
}

/** `/w_300,h_200,c_fill/` style transform segments (Cloudinary and clones). */
function transformSegment(u) {
  const { segs, file } = splitPath(u);
  const out = [];
  for (let i = 0; i < segs.length; i += 1) {
    if (!/^[a-z]{1,3}_[^/]+(?:,[a-z]{1,3}_[^/]+)*$/i.test(segs[i])) continue;
    if (!/(?:^|,)(?:w|h|c|q|f|dpr)_/i.test(segs[i])) continue;
    out.push(withPath(u, segs.slice(0, i).concat(segs.slice(i + 1)), file));
  }
  return out;
}

/** A bare `=s220` / `=w400-h300` suffix (Google-hosted images). */
function sizeSuffix(u) {
  const { segs, file } = splitPath(u);
  const eq = file.lastIndexOf('=');
  if (eq <= 0) return [];
  const tail = file.slice(eq + 1);
  if (!/^[swh]\d+(?:-[a-z]+\d*)*$/i.test(tail)) return [];
  return [
    withPath(u, segs, file.slice(0, eq) + '=s0'),
    withPath(u, segs, file.slice(0, eq)),
  ];
}

const GENERIC_RULES = [
  wikimedia,
  wordpressSuffix,
  transformSegment,
  sizeSuffix,
  stemSuffix,
  thumbDirectory,
  queryStrip,
];

/**
 * @param {string} url
 * @returns {string[]} ordered upgrade candidates, best guess first, no dupes,
 *                     never including the input URL itself.
 */
export function genericUpgrades(url) {
  const u = toURL(url);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return [];
  const seen = new Set([u.href, url]);
  const out = [];
  for (const rule of GENERIC_RULES) {
    let produced = [];
    try {
      produced = rule(u) || [];
    } catch {
      produced = [];
    }
    for (const href of produced) {
      if (!href || seen.has(href)) continue;
      seen.add(href);
      out.push(href);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Declarative per-host rules — see rules/site-rules.json
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} SiteRule
 * @property {string}  match    hostname suffix, e.g. "example.com"
 * @property {string}  [path]   optional regex the pathname must satisfy
 * @property {string}  find     regex applied to the full URL
 * @property {string}  replace  replacement string ($1, $2 ... supported)
 * @property {boolean} [verify] HEAD-check before use (default true)
 * @property {string}  [note]   human-readable explanation
 */

function hostMatches(host, match) {
  const h = String(host || '').toLowerCase();
  const m = String(match || '').toLowerCase();
  if (!m) return false;
  if (m === '*') return true;
  return h === m || h.endsWith('.' + m);
}

/**
 * @param {string} url
 * @param {SiteRule[]} rules
 * @returns {Array<{url: string, verify: boolean, note: string}>}
 */
export function siteUpgrades(url, rules) {
  const u = toURL(url);
  if (!u || !Array.isArray(rules)) return [];
  const out = [];
  for (const rule of rules) {
    if (!rule || !rule.find || typeof rule.replace !== 'string') continue;
    if (!hostMatches(u.hostname, rule.match)) continue;
    if (rule.path) {
      let pathRe;
      try {
        pathRe = new RegExp(rule.path);
      } catch {
        continue;
      }
      if (!pathRe.test(u.pathname)) continue;
    }
    let re;
    try {
      re = new RegExp(rule.find);
    } catch {
      continue;
    }
    if (!re.test(u.href)) continue;
    const next = u.href.replace(re, rule.replace);
    if (next && next !== u.href) {
      out.push({
        url: next,
        verify: rule.verify !== false,
        note: rule.note || `${rule.match} rule`,
      });
    }
  }
  return out;
}

/**
 * Full ordered candidate list: site rules first (they are hand-verified),
 * then generic rules.
 * @param {string} url
 * @param {SiteRule[]} [rules]
 * @returns {Array<{url: string, verify: boolean, note: string}>}
 */
export function upgradeCandidates(url, rules = []) {
  const seen = new Set([url]);
  const out = [];
  for (const c of siteUpgrades(url, rules)) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  for (const href of genericUpgrades(url)) {
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ url: href, verify: true, note: 'generic rule' });
  }
  return out;
}

/** Re-exported so callers can reason about which query keys survive dedupe. */
export { SIZE_BEARING_KEYS };
