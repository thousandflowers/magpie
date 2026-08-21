/**
 * The similarity engine. Pure functions only — no DOM, no chrome globals —
 * so `node --test` can exercise it directly.
 *
 * A MediaCandidate is a plain object; every field is optional except `url`:
 *
 *   {
 *     id, url, normalizedUrl, mimeType, kind,
 *     width, height,                 // natural dimensions when known
 *     bytes, source, status,
 *     structuralPath: [{tag, classes}],  // element -> body (element first)
 *     inRepeatedGroup: boolean,
 *   }
 */

import {
  patternOf, jaccard, bareHost, registrableDomain,
} from './url-normalize.js';
import { mimeSubtype, mimeTopLevel, classify, extOf } from './media-types.js';

export const WEIGHTS = {
  url: 0.35,
  structure: 0.25,
  dimension: 0.2,
  type: 0.1,
  host: 0.1,
};

export const DEFAULT_THRESHOLD = 0.62;

/* ------------------------------------------------------------------ *
 * Class-name hygiene
 * ------------------------------------------------------------------ */

/**
 * Build-tool generated class shapes, per spec §5.
 * `SPEC_DYNAMIC_RE` matches far more than intended on its own — it also eats
 * hand-written classes like `photo-gallery` — so it is only honoured when the
 * token also carries a hash signal. See DECISIONS.md.
 */
const SPEC_DYNAMIC_RE = /^[A-Za-z]+[-_][A-Za-z0-9]{5,}$/;
const CSS_MODULE_RE = /^css-[a-z0-9]+$/;
const STYLED_RE = /^sc-[A-Za-z0-9]+$/;
const HEX_RUN_RE = /[0-9a-f]{6,}/i;
const STATE_RE = /^(?:is|has|js)-|(?:^|[-_])(?:active|selected|current|open|hover|focus|visible|hidden|disabled|loading|loaded|error)(?:$|[-_])/i;

/** A class is only "dynamic by cardinality" if it is this rare in the document. */
export const MAX_DYNAMIC_FREQUENCY = 2;
/** ...and this disordered. Tuned so `photo-gallery` stays and `sc-bdVaJa1` goes. */
export const ENTROPY_THRESHOLD = 3.6;

/**
 * Entropy proxy for a class name.
 *
 * Shannon entropy over the token's alphanumerics, nudged by the three things
 * that separate a generated token from an authored one: mixed case, digits,
 * and too few vowels to be pronounceable. Higher means less word-like.
 *
 * @param {string} token
 * @returns {number} bits per character, adjusted
 */
export function classEntropy(token) {
  const s = String(token || '').replace(/[^A-Za-z0-9]/g, '');
  if (s.length < 4) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  const vowelRatio = (s.match(/[aeiou]/gi) || []).length / s.length;
  const mixedCase = /[a-z]/.test(s) && /[A-Z]/.test(s) ? 0.6 : 0;
  const hasDigit = /\d/.test(s) ? 0.6 : 0;
  return bits + mixedCase + hasDigit + Math.max(0, 0.35 - vowelRatio) * 2;
}

/**
 * Does this token look machine-generated rather than authored?
 * Every branch keys off an opaque, digit-bearing run — never off a list of
 * known class names — so a new build tool needs no code change here.
 *
 * This is the FALLBACK. When the DOM scanner supplies class frequencies the
 * cardinality test below is used instead, because "appears on one element"
 * is direct evidence where string shape is only a guess.
 */
function hasHashSignal(token) {
  if (CSS_MODULE_RE.test(token) || STYLED_RE.test(token)) return true;
  if (HEX_RUN_RE.test(token) && /\d/.test(token)) return true;
  const tail = token.split(/[-_]/).filter(Boolean).pop() || '';
  // Mixed-case-plus-digits tails are the CSS-Modules / emotion signature.
  if (tail.length >= 5 && /\d/.test(tail) && /[a-z]/.test(tail) && /[A-Z]/.test(tail)) {
    return true;
  }
  // The spec's own shape, honoured only when the tail is long and digit-bearing.
  return SPEC_DYNAMIC_RE.test(token) && tail.length >= 6 && /\d/.test(tail);
}

/**
 * @param {string[]|string} classes
 * @param {Record<string, number>|null} [classCounts] how many elements in the
 *   document carry each class, as measured by the DOM scanner. When a class is
 *   present here it decides the outcome; when it is absent (HAR-sourced items,
 *   network-only items, a scan that could not build the map) the shape
 *   heuristic decides instead.
 * @returns {string[]} stable classes, sorted
 */
export function stripDynamicClasses(classes, classCounts) {
  const list = Array.isArray(classes)
    ? classes
    : String(classes || '').split(/\s+/);
  const counts = classCounts && typeof classCounts === 'object' ? classCounts : null;
  const keep = [];
  for (const raw of list) {
    const token = String(raw || '').trim();
    if (!token) continue;
    if (STATE_RE.test(token)) continue;

    const frequency =
      counts && Object.prototype.hasOwnProperty.call(counts, token)
        ? Number(counts[token])
        : null;

    // A generated class is high-entropy AND rare; a structural class like
    // `grid-item` is on every sibling, so its frequency alone acquits it.
    const dynamic =
      frequency === null || !Number.isFinite(frequency)
        ? hasHashSignal(token)
        : frequency <= MAX_DYNAMIC_FREQUENCY && classEntropy(token) >= ENTROPY_THRESHOLD;

    if (dynamic) continue;
    keep.push(token.toLowerCase());
  }
  keep.sort();
  return keep;
}

/** Normalise a raw structural path once, so scoring stays cheap. */
export function normalizePath(structuralPath, classCounts) {
  if (!Array.isArray(structuralPath)) return [];
  return structuralPath.map((node) => ({
    tag: String(node && node.tag ? node.tag : '').toLowerCase(),
    classes: stripDynamicClasses(node && node.classes, classCounts),
  }));
}

function pathOf(c) {
  if (c && c._normPath) return c._normPath;
  const p = normalizePath(c && c.structuralPath, c && c.classCounts);
  if (c && typeof c === 'object') {
    Object.defineProperty(c, '_normPath', { value: p, enumerable: false, configurable: true });
  }
  return p;
}

/* ------------------------------------------------------------------ *
 * Term 1 — URL pattern
 * ------------------------------------------------------------------ */

function patOf(c) {
  if (c && c._pat) return c._pat;
  const p = patternOf(c && (c.url || ''));
  if (c && typeof c === 'object') {
    Object.defineProperty(c, '_pat', { value: p, enumerable: false, configurable: true });
  }
  return p;
}

/** @returns {number} 0..1 */
export function urlPatternSimilarity(a, b) {
  const pa = patOf(a);
  const pb = patOf(b);
  if (!pa.host && !pb.host) return 0;

  const sameHost = pa.bare === pb.bare && pa.bare !== '';
  const sameExt = pa.ext === pb.ext && pa.ext !== '';

  if (sameHost && pa.pattern === pb.pattern && pa.pattern !== '') return 1;
  if (sameHost && sameExt && pa.dir === pb.dir) return 0.75;
  if (sameHost && sameExt) return 0.4;
  return Math.min(0.35, jaccard(pa.tokens, pb.tokens));
}

/* ------------------------------------------------------------------ *
 * Term 2 — DOM structure
 * ------------------------------------------------------------------ */

/** Returned when an item is in a repeated group whose identity is unknown. */
const UNKNOWN_GROUP = '*';

/** Score used when at least one item carries no DOM structure at all. */
export const NEUTRAL_STRUCTURE = 0.5;

/**
 * Identity of the repeated group an element belongs to: the repeating node's
 * own signature plus every ancestor above it. Two cells of the same grid
 * produce the same key; a carousel slide and a grid cell do not.
 *
 * `repeatDepth` is the index into the (element-first) structural path of the
 * node whose siblings repeat, supplied by the DOM scanner. Items that predate
 * it — or that never had a DOM at all — report UNKNOWN_GROUP, which is treated
 * leniently so their behaviour does not change.
 *
 * @param {object} c candidate
 * @param {Array<{tag: string, classes: string[]}>} path normalised path
 * @returns {string} '' when not in a repeated group
 */
function repeatKeyOf(c, path) {
  if (!c || !c.inRepeatedGroup) return '';
  const depth = Number.isInteger(c.repeatDepth) ? c.repeatDepth : -1;
  if (depth < 0 || depth >= path.length) return UNKNOWN_GROUP;
  return path
    .slice(depth)
    .map((node) => `${node.tag}.${node.classes.join('.')}`)
    .join('>');
}

function nodesMatch(x, y) {
  if (x.tag !== y.tag) return false;
  if (x.classes.length !== y.classes.length) return false;
  for (let i = 0; i < x.classes.length; i += 1) {
    if (x.classes[i] !== y.classes[i]) return false;
  }
  return true;
}

/**
 * Compared from the root end: two thumbnails in the same grid share every
 * ancestor down to their own cell, which is exactly the signal we want.
 *
 * @returns {number} 0..1. NEUTRAL_STRUCTURE when either item has no structural
 *   path; a hard 0 only when both do and they belong to different repeated
 *   groups.
 */
export function structuralSimilarity(a, b) {
  const pa = pathOf(a);
  const pb = pathOf(b);
  // Absence of evidence, not evidence of difference. A network-only or
  // HAR-sourced item never had a DOM to be scanned, so this term has nothing
  // to say and must not punish it — the same reasoning as dimensionSimilarity
  // returning 0.5 for unknown dimensions. A hard 0 is reserved for the case
  // below, where the two elements are *known* to sit in different repeated
  // groups, which is a real finding.
  if (!pa.length || !pb.length) return NEUTRAL_STRUCTURE;

  // Stored element-first; reverse to compare root-first.
  const ra = pa.slice().reverse();
  const rb = pb.slice().reverse();

  let common = 0;
  const max = Math.min(ra.length, rb.length);
  while (common < max && nodesMatch(ra[common], rb[common])) common += 1;

  const longer = Math.max(pa.length, pb.length);
  let score = common / longer;

  // Grid / list / feed handling. What matters is not whether each element is
  // in *some* repeated structure, but whether both are in the *same* one: a
  // hero carousel and a product grid are both repeated, and they are not the
  // same set. See DECISIONS.md.
  const ka = repeatKeyOf(a, pa);
  const kb = repeatKeyOf(b, pb);
  if (ka || kb) {
    const sameGroup =
      Boolean(ka) && Boolean(kb) &&
      (ka === kb || ka === UNKNOWN_GROUP || kb === UNKNOWN_GROUP);
    if (!sameGroup) {
      // Different templates. Whatever ancestry they share is page chrome
      // (body > main > ...), not evidence that they belong together.
      return 0;
    }
    const depthA = pa.length - common;
    const depthB = pb.length - common;
    if (common > 0 && depthA <= 4 && depthB <= 4) score += 0.15;
  }
  return Math.max(0, Math.min(1, score));
}

/* ------------------------------------------------------------------ *
 * Term 3 — dimensions
 * ------------------------------------------------------------------ */

function dims(c) {
  const w = Number(c && c.width);
  const h = Number(c && c.height);
  return w > 0 && h > 0 ? { w, h } : null;
}

/** @returns {number} 0..1, neutral 0.5 when either side has no dimensions. */
export function dimensionSimilarity(a, b) {
  const da = dims(a);
  const db = dims(b);
  if (!da || !db) return 0.5;

  const areaA = da.w * da.h;
  const areaB = db.w * db.h;
  const areaRatio = Math.min(areaA, areaB) / Math.max(areaA, areaB);

  const arA = da.w / da.h;
  const arB = db.w / db.h;
  const aspectDelta = Math.abs(arA - arB) / Math.max(arA, arB);

  return 0.5 * areaRatio + 0.5 * (1 - Math.min(aspectDelta, 1));
}

/* ------------------------------------------------------------------ *
 * Terms 4 and 5 — MIME type and host
 * ------------------------------------------------------------------ */

function effectiveMime(c) {
  if (c && c.mimeType) return c.mimeType;
  const kind = classify(c || {});
  const ext = extOf((c && c.url) || '');
  return kind && ext ? `${kind}/${ext}` : kind ? `${kind}/*` : '';
}

/** @returns {number} 0, 0.6 or 1 */
export function typeSimilarity(a, b) {
  const ma = effectiveMime(a);
  const mb = effectiveMime(b);
  if (!ma || !mb) return 0;
  const sa = mimeSubtype(ma);
  const sb = mimeSubtype(mb);
  if (sa && sa === sb && sa !== '*') return 1;
  const ta = mimeTopLevel(ma);
  const tb = mimeTopLevel(mb);
  if (ta && ta === tb) return 0.6;
  return 0;
}

/** @returns {number} 0, 0.7 or 1 */
export function hostSimilarity(a, b) {
  const ha = patOf(a).host;
  const hb = patOf(b).host;
  if (!ha || !hb) return 0;
  if (ha === hb) return 1;
  if (bareHost(ha) === bareHost(hb)) return 1;
  if (registrableDomain(ha) === registrableDomain(hb)) return 0.7;
  return 0;
}

/* ------------------------------------------------------------------ *
 * Composite
 * ------------------------------------------------------------------ */

/**
 * @param {object} a @param {object} b
 * @returns {number} 0..1
 */
export function score(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return (
    WEIGHTS.url * urlPatternSimilarity(a, b) +
    WEIGHTS.structure * structuralSimilarity(a, b) +
    WEIGHTS.dimension * dimensionSimilarity(a, b) +
    WEIGHTS.type * typeSimilarity(a, b) +
    WEIGHTS.host * hostSimilarity(a, b)
  );
}

/** Per-term breakdown, for the panel's "why did this match?" readout. */
export function explain(a, b) {
  return {
    url: urlPatternSimilarity(a, b),
    structure: structuralSimilarity(a, b),
    dimension: dimensionSimilarity(a, b),
    type: typeSimilarity(a, b),
    host: hostSimilarity(a, b),
    total: score(a, b),
  };
}

/**
 * Everything similar to `seed`, best first. The seed itself is included.
 * @returns {Array<{item: object, score: number}>}
 */
export function selectSimilar(seed, candidates, threshold = DEFAULT_THRESHOLD) {
  const out = [];
  for (const c of candidates) {
    const s = c === seed ? 1 : score(seed, c);
    if (s >= threshold) out.push({ item: c, score: s });
  }
  out.sort((x, y) => y.score - x.score);
  return out;
}

/* ------------------------------------------------------------------ *
 * Clustering
 * ------------------------------------------------------------------ */

class DisjointSet {
  constructor(n) {
    this.parent = new Array(n);
    this.rank = new Array(n).fill(0);
    for (let i = 0; i < n; i += 1) this.parent[i] = i;
  }
  find(x) {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else {
      this.parent[rb] = ra;
      this.rank[ra] += 1;
    }
  }
}

/**
 * Single-linkage agglomerative clustering, cut at `threshold`.
 * Linking every pair whose score clears the threshold and taking connected
 * components is exactly single linkage at that cut height.
 *
 * @param {object[]} candidates
 * @param {number} threshold
 * @returns {Array<{items: object[], size: number}>} largest group first
 */
export function cluster(candidates, threshold = DEFAULT_THRESHOLD) {
  const n = candidates.length;
  if (n === 0) return [];
  const ds = new DisjointSet(n);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (score(candidates[i], candidates[j]) >= threshold) ds.union(i, j);
    }
  }
  const byRoot = new Map();
  for (let i = 0; i < n; i += 1) {
    const r = ds.find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(candidates[i]);
  }
  const groups = [...byRoot.values()].map((items) => ({ items, size: items.length }));
  groups.sort((a, b) => b.size - a.size);
  return groups;
}

/**
 * Incremental clustering for large indexes: yields after `budgetMs` so the
 * caller can hand the main thread back. Resume by passing the returned state.
 *
 * @returns {{done: boolean, state: object, groups?: Array}}
 */
export function clusterChunked(candidates, threshold, state, budgetMs = 12, now = () => Date.now()) {
  const n = candidates.length;
  const st = state || { i: 0, j: 1, ds: new DisjointSet(n) };
  const start = now();
  while (st.i < n) {
    if (st.j >= n) {
      st.i += 1;
      st.j = st.i + 1;
      continue;
    }
    if (score(candidates[st.i], candidates[st.j]) >= threshold) st.ds.union(st.i, st.j);
    st.j += 1;
    if (now() - start > budgetMs) return { done: false, state: st };
  }
  const byRoot = new Map();
  for (let i = 0; i < n; i += 1) {
    const r = st.ds.find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(candidates[i]);
  }
  const groups = [...byRoot.values()].map((items) => ({ items, size: items.length }));
  groups.sort((a, b) => b.size - a.size);
  return { done: true, state: st, groups };
}

/** Most common value in an array, with its count. */
function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return { value: best, count: bestN };
}

/**
 * Plain-language group header: "48 images · 1200x800 · cdn.example.com/photos/*"
 * @param {object[]} items
 */
export function describeGroup(items) {
  if (!items || !items.length) return { count: 0, label: 'Empty group' };
  const kinds = mode(items.map((c) => classify(c) || 'file'));
  const dimList = items
    .filter((c) => c.width > 0 && c.height > 0)
    .map((c) => `${c.width}x${c.height}`);
  const dim = dimList.length ? mode(dimList) : { value: null, count: 0 };
  const pats = items
    .map((c) => {
      const p = patOf(c);
      return p.dir || p.file ? `${p.host}${p.dir}/${p.file}` : '';
    })
    .filter(Boolean);
  const pat = pats.length ? mode(pats) : { value: null, count: 0 };
  const bytes = items.reduce((sum, c) => sum + (Number(c.bytes) || 0), 0);

  const noun = kinds.count === items.length ? `${kinds.value}s` : 'items';
  const parts = [`${items.length} ${noun}`];
  if (dim.value && dim.count > items.length / 2) parts.push(dim.value);
  else if (dimList.length) parts.push('mixed sizes');
  if (pat.value) parts.push(pat.value);

  return {
    count: items.length,
    kind: kinds.value,
    dimensions: dim.count > items.length / 2 ? dim.value : null,
    pattern: pat.value,
    bytes,
    label: parts.join(' · '),
  };
}
