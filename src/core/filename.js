/**
 * Filename templating and path sanitising. Pure.
 *
 * Downloads land inside the browser's download directory, so a path that
 * escapes it (or that Windows refuses to create) is a real failure mode,
 * not a nicety.
 */

import { toURL } from './url-normalize.js';
import { extOf, extFromMime } from './media-types.js';

export const DEFAULT_TEMPLATE = 'magpie/{host}/{title}/{index}-{basename}.{ext}';
export const MAX_SEGMENT = 100;

const RESERVED_WINDOWS = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

const ILLEGAL_RE = /[<>:"/\\|?*]/g;

/** Drop C0 controls and DEL without a control-character regex literal. */
function stripControl(input) {
  let out = '';
  for (const ch of String(input)) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

/**
 * Make one path segment safe. Never returns '' — falls back to 'file'.
 * @param {string} value
 * @param {number} [max]
 */
export function sanitizeSegment(value, max = MAX_SEGMENT) {
  let s = stripControl(value == null ? '' : value);
  s = s.replace(ILLEGAL_RE, '_');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/\.{2,}/g, '.');      // no `..` can survive anywhere in a segment
  s = s.replace(/^\.+/, '');          // no leading dots: kills `.` and `..`
  s = s.replace(/[.\s]+$/, '');       // Windows strips these anyway
  if (!s) return 'file';
  const stem = s.includes('.') ? s.slice(0, s.lastIndexOf('.')) : s;
  if (RESERVED_WINDOWS.has(stem.toLowerCase())) s = '_' + s;
  if (s.length > max) {
    const dot = s.lastIndexOf('.');
    if (dot > 0 && s.length - dot <= 12) {
      const ext = s.slice(dot);
      s = s.slice(0, Math.max(1, max - ext.length)) + ext;
    } else {
      s = s.slice(0, max);
    }
  }
  return s || 'file';
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Basename of a URL path, without extension. */
export function basenameOf(url) {
  if (typeof url === 'string' && url.startsWith('data:')) return 'inline';
  if (typeof url === 'string' && url.startsWith('blob:')) return 'blob';
  const u = toURL(url);
  if (!u) return 'file';
  const segs = u.pathname.split('/').filter(Boolean);
  const last = segs.length ? decodeURIComponentSafe(segs[segs.length - 1]) : '';
  if (!last) return segs.length > 1 ? decodeURIComponentSafe(segs[segs.length - 2]) : 'index';
  const dot = last.lastIndexOf('.');
  const stem = dot > 0 ? last.slice(0, dot) : last;
  return stem || 'file';
}

/**
 * The real extension. The URL is a hint; the MIME type is the authority,
 * because plenty of CDNs serve `photo.jpg` that is actually a WebP.
 */
export function resolveExtension(url, mimeType) {
  const fromMime = extFromMime(mimeType || '');
  if (fromMime) return fromMime;
  const fromUrl = extOf(url || '');
  if (fromUrl) return fromUrl;
  return 'bin';
}

function pad(n, width) {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

/** `YYYY-MM-DD` in local time. */
export function dateToken(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

/**
 * @typedef {object} TemplateTokens
 * @property {string} host @property {string} title @property {string} date
 * @property {string} index @property {string} basename @property {string} ext
 * @property {string} width @property {string} height @property {string} group
 */

/**
 * Build the tokens for one item.
 * @param {object} item candidate
 * @param {object} ctx {pageUrl, pageTitle, index, total, groupLabel, now}
 * @returns {TemplateTokens}
 */
export function tokensFor(item, ctx = {}) {
  const u = toURL(item.url);
  const pageU = toURL(ctx.pageUrl || '');
  const width = String(ctx.total || 0).length;
  return {
    host: (u && u.hostname) || (pageU && pageU.hostname) || 'unknown-host',
    title: ctx.pageTitle || (pageU && pageU.pathname.split('/').filter(Boolean).pop()) || 'page',
    date: dateToken(ctx.now instanceof Date ? ctx.now : new Date()),
    index: pad(Number(ctx.index) || 0, Math.max(3, width)),
    basename: basenameOf(item.url),
    ext: resolveExtension(item.url, item.mimeType),
    width: String(item.width || 0),
    height: String(item.height || 0),
    group: ctx.groupLabel || 'ungrouped',
  };
}

const TOKEN_RE = /\{(host|title|date|index|basename|ext|width|height|group)\}/g;

/**
 * Expand a template into a safe relative path.
 * Unknown tokens are left literal (and then sanitised away), which is less
 * surprising than silently dropping part of the user's template.
 *
 * @param {string} template
 * @param {TemplateTokens} tokens
 * @returns {string} relative path with `/` separators, never absolute
 */
export function applyTemplate(template, tokens) {
  const raw = String(template || DEFAULT_TEMPLATE);
  // A token value containing a separator must not be able to inject a
  // directory level, so separators inside values are neutralised first.
  const expanded = raw.replace(TOKEN_RE, (_, key) => {
    const value = tokens[key] == null ? '' : String(tokens[key]);
    return value.replace(/[/\\]/g, '_');
  });

  const parts = expanded
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => sanitizeSegment(seg));

  if (!parts.length) return 'magpie/file';

  // Guarantee the real extension survives, even if the template omitted it.
  const ext = tokens.ext ? sanitizeSegment(tokens.ext, 12) : '';
  const last = parts[parts.length - 1];
  if (ext && ext !== 'bin' && !last.toLowerCase().endsWith('.' + ext.toLowerCase())) {
    parts[parts.length - 1] = sanitizeSegment(`${last}.${ext}`);
  }
  return parts.join('/');
}

/** Convenience: item + context -> final relative path. */
export function buildPath(item, ctx = {}, template = DEFAULT_TEMPLATE) {
  return applyTemplate(template, tokensFor(item, ctx));
}

/** Human-readable byte size. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
