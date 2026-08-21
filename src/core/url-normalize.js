/**
 * URL normalisation and pattern extraction. Pure — no DOM, no chrome.
 *
 * Two different jobs live here:
 *   normalizeUrl()  -> a stable dedupe key (what Layer A/B/C/D join on)
 *   patternOf()     -> a shape descriptor for similarity scoring
 */

/**
 * Query keys that actually change which bytes come back. Everything else
 * (utm_*, session tokens, cache busters) is stripped so that the same asset
 * requested twice dedupes to one entry.
 */
export const SIZE_BEARING_KEYS = new Set([
  'w', 'h', 'width', 'height', 'size', 'quality', 'format', 'name',
]);

/** Extra keys that must survive because dropping them 404s the request. */
export const AUTH_KEYS = new Set([
  'token', 'sig', 'signature', 'expires', 'st', 'se', 'sp', 'sv', 'key',
  'x-amz-signature', 'x-amz-credential', 'x-amz-date', 'x-amz-expires',
  'x-amz-algorithm', 'x-amz-signedheaders', 'x-amz-security-token',
  'policy', 'hmac', 'hash', 'auth', 'access_token', 'oauth2_token',
  'goog-signature', 'x-goog-signature', 'ci', 'oh', 'oe', '_nc_sid', '_nc_ohc',
]);

const HEXISH_RE = /^[0-9a-f]{8,}$/i;
const BASEISH_RE = /^[A-Za-z0-9_-]{12,}$/;
const DIGITS_RE = /^\d+$/;

/** Strip the leading `www.` / `m.` and the port. */
export function bareHost(host) {
  return String(host || '')
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^(?:www\d*|m|mobile|amp)\./, '');
}

/**
 * Registrable domain, approximated without a public-suffix list:
 * last two labels, or last three when the second-to-last is a known
 * second-level suffix (co.uk, com.au, ...).
 */
const SECOND_LEVEL = new Set([
  'co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'in',
]);

export function registrableDomain(host) {
  const parts = bareHost(host).split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const second = parts[parts.length - 2];
  if (SECOND_LEVEL.has(second)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

/** Parse to a URL object, tolerating protocol-relative and relative inputs. */
export function toURL(raw, base) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    if (raw.startsWith('//')) return new URL('https:' + raw);
    return new URL(raw, base || undefined);
  } catch {
    return null;
  }
}

/**
 * Canonical form used as the per-tab dedupe key.
 * Keeps only size-bearing and auth-bearing query keys, sorted.
 * data: and blob: URLs are returned untouched — they are already unique.
 */
export function normalizeUrl(raw, base) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return trimmed;

  const u = toURL(trimmed, base);
  if (!u) return trimmed;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.href;

  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if (
    (u.protocol === 'https:' && u.port === '443') ||
    (u.protocol === 'http:' && u.port === '80')
  ) {
    u.port = '';
  }

  const kept = [];
  for (const [k, v] of u.searchParams) {
    const lk = k.toLowerCase();
    if (SIZE_BEARING_KEYS.has(lk) || AUTH_KEYS.has(lk)) kept.push([lk, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // Collapse a trailing slash on non-root paths so /a/b and /a/b/ agree.
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.href;
}

function genericisePathSegment(seg) {
  if (!seg) return seg;
  if (DIGITS_RE.test(seg)) return '*';
  if (HEXISH_RE.test(seg)) return '*';
  if (BASEISH_RE.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return '*';
  return seg.toLowerCase();
}

/**
 * Filename shape: digit runs become `#`, hash-looking stems become `*`,
 * extension preserved. `IMG_20240817_113355.jpg` -> `img_#_#.jpg`.
 */
export function genericiseFilename(file) {
  if (!file) return '';
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : '';
  let shape;
  if (HEXISH_RE.test(stem) || (BASEISH_RE.test(stem) && /\d/.test(stem) && /[A-Za-z]/.test(stem) && !/[-_]/.test(stem))) {
    shape = '*';
  } else {
    shape = stem.toLowerCase().replace(/\d+/g, '#');
  }
  return ext ? `${shape}.${ext}` : shape;
}

/** Split a path into comparison tokens for the Jaccard fallback. */
export function pathTokens(pathname) {
  return String(pathname || '')
    .toLowerCase()
    .split(/[/\-_.]+/)
    .filter((t) => t && !DIGITS_RE.test(t) && !HEXISH_RE.test(t));
}

/**
 * @typedef {object} UrlPattern
 * @property {string} host        full lower-case hostname
 * @property {string} bare        hostname without www./m.
 * @property {string} domain      registrable domain
 * @property {string} dir         directory part of the path, genericised
 * @property {string} file        filename, genericised
 * @property {string} ext         lower-case extension
 * @property {string} pattern     `dir/file` — the shape key
 * @property {string[]} tokens    path tokens for Jaccard
 * @property {string} sizeKey     serialized size-bearing query, if any
 */

/** @returns {UrlPattern} */
export function patternOf(raw, base) {
  const empty = {
    host: '', bare: '', domain: '', dir: '', file: '', ext: '',
    pattern: '', tokens: [], sizeKey: '',
  };
  if (typeof raw !== 'string' || !raw) return empty;
  if (raw.startsWith('data:') || raw.startsWith('blob:')) {
    return { ...empty, host: raw.slice(0, 5), bare: raw.slice(0, 5), pattern: raw.slice(0, 5) };
  }
  const u = toURL(raw, base);
  if (!u) return empty;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    // Synthetic (magpie-canvas:, magpie-svg:) and exotic schemes have no
    // meaningful host or path shape; treating them as one avoids junk patterns.
    return { ...empty, host: u.protocol, bare: u.protocol, pattern: u.protocol };
  }

  const segs = u.pathname.split('/').filter(Boolean);
  const file = segs.length ? segs[segs.length - 1] : '';
  const dirSegs = segs.slice(0, -1).map(genericisePathSegment);
  const dir = '/' + dirSegs.join('/');
  const genericFile = genericiseFilename(file);

  const sizeParts = [];
  for (const [k, v] of u.searchParams) {
    const lk = k.toLowerCase();
    if (SIZE_BEARING_KEYS.has(lk)) sizeParts.push(`${lk}=${v}`);
  }
  sizeParts.sort();

  return {
    host: u.hostname.toLowerCase(),
    bare: bareHost(u.hostname),
    domain: registrableDomain(u.hostname),
    dir,
    file: genericFile,
    ext: (genericFile.includes('.') ? genericFile.split('.').pop() : '').toLowerCase(),
    pattern: `${dir}/${genericFile}`,
    tokens: pathTokens(u.pathname),
    sizeKey: sizeParts.join('&'),
  };
}

/** Jaccard similarity of two token arrays. */
export function jaccard(a, b) {
  if (!a.length && !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Detect pre-signed / expiring URLs.
 * @returns {{expiring: boolean, expiresAt: number|null}} epoch ms, when known.
 */
export function expiryInfo(raw) {
  const u = toURL(raw);
  if (!u) return { expiring: false, expiresAt: null };
  const q = u.searchParams;
  const now = Date.now();

  const amzDate = q.get('X-Amz-Date') || q.get('x-amz-date');
  const amzExpires = q.get('X-Amz-Expires') || q.get('x-amz-expires');
  if (amzDate && amzExpires) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
    if (m) {
      const start = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      return { expiring: true, expiresAt: start + Number(amzExpires) * 1000 };
    }
  }

  for (const key of ['Expires', 'expires', 'se', 'X-Goog-Expires', 'oe']) {
    const v = q.get(key);
    if (!v) continue;
    // Unix seconds, unix millis, ISO-8601, or hex seconds (Facebook-style `oe`).
    const asNum = Number(v);
    if (Number.isFinite(asNum) && asNum > 1e9 && asNum < 1e11) {
      return { expiring: true, expiresAt: asNum * 1000 };
    }
    if (Number.isFinite(asNum) && asNum >= 1e12 && asNum < 1e14) {
      return { expiring: true, expiresAt: asNum };
    }
    const iso = Date.parse(v);
    if (!Number.isNaN(iso) && iso > now - 3.15e10) {
      return { expiring: true, expiresAt: iso };
    }
    if (/^[0-9a-f]{8}$/i.test(v)) {
      const secs = parseInt(v, 16);
      if (secs > 1e9 && secs < 1e11) return { expiring: true, expiresAt: secs * 1000 };
    }
  }

  for (const key of ['token', 'sig', 'signature', 'hmac', 'st', 'policy']) {
    if (q.has(key)) return { expiring: true, expiresAt: null };
  }
  return { expiring: false, expiresAt: null };
}
