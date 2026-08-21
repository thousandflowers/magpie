/**
 * HAR (HTTP Archive) import. Pure — takes parsed JSON, returns candidates.
 *
 * Exists because a DevTools capture is sometimes the only way to get at a
 * session: signed URLs expire, content sits behind a login, things get taken
 * down. When DevTools exported the capture with content ("Save all as HAR
 * (with content)"), the response bodies are in the file, and Magpie saves the
 * file straight out of them without touching the network. An export without
 * content still imports — it just has to re-fetch.
 */

import { normalizeUrl } from './url-normalize.js';
import { classify, rejectionReason, FILTER_CONFIG } from './media-types.js';

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return '';
  const target = String(name).toLowerCase();
  for (const h of headers) {
    if (h && typeof h.name === 'string' && h.name.toLowerCase() === target) {
      return String(h.value == null ? '' : h.value);
    }
  }
  return '';
}

/** Bodies larger than this are left to the network; one file should not eat the budget. */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Total decoded bytes held in memory for one import. */
export const MAX_TOTAL_BODY_BYTES = 512 * 1024 * 1024;

/**
 * Decode one HAR `content` object into bytes.
 *
 * `encoding: "base64"` is what DevTools writes for binary responses; a text
 * body (an SVG, say) arrives as-is. Absent `text` means the capture was
 * exported without content, which is not an error — it just means no bytes.
 *
 * @param {object} content the `response.content` object
 * @returns {Uint8Array|null} null when there is nothing usable
 */
export function decodeHarBody(content) {
  if (!content || typeof content !== 'object') return null;
  const text = content.text;
  if (typeof text !== 'string' || !text) return null;

  try {
    if (String(content.encoding || '').toLowerCase() === 'base64') {
      const binary = atob(text.replace(/\s/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes.length ? bytes : null;
    }
    const bytes = new TextEncoder().encode(text);
    return bytes.length ? bytes : null;
  } catch {
    // A truncated or malformed body is not worth failing the whole import for.
    return null;
  }
}

/**
 * @param {object|string} har parsed HAR object, or its JSON text
 * @param {object} [opts] {maxItems, withBodies}
 * @returns {{items: object[], bodies: Map<string, {bytes: Uint8Array, mimeType: string}>,
 *            skipped: number, bodyBytes: number, error: string}}
 */
export function parseHar(har, opts = {}) {
  const maxItems = opts.maxItems || FILTER_CONFIG.MAX_ITEMS_PER_TAB;
  const withBodies = opts.withBodies !== false;
  const maxBody = opts.maxBodyBytes || MAX_BODY_BYTES;
  const maxTotal = opts.maxTotalBodyBytes || MAX_TOTAL_BODY_BYTES;
  const bodies = new Map();
  let bodyBytes = 0;
  let doc = har;
  if (typeof har === 'string') {
    try {
      doc = JSON.parse(har);
    } catch (err) {
      return { items: [], bodies: new Map(), skipped: 0, bodyBytes: 0, error: 'Not valid JSON: ' + err.message };
    }
  }
  const entries = doc && doc.log && Array.isArray(doc.log.entries) ? doc.log.entries : null;
  if (!entries) {
    return {
      items: [], bodies: new Map(), skipped: 0, bodyBytes: 0,
      error: 'No log.entries — is this a HAR file?',
    };
  }

  const seen = new Set();
  const items = [];
  let skipped = 0;

  for (const entry of entries) {
    if (items.length >= maxItems) {
      skipped += 1;
      continue;
    }
    const req = entry && entry.request;
    const res = entry && entry.response;
    if (!req || typeof req.url !== 'string') continue;
    if (res && Number(res.status) >= 400) {
      skipped += 1;
      continue;
    }

    const mimeType =
      (res && res.content && res.content.mimeType) ||
      (res && headerValue(res.headers, 'content-type')) ||
      '';
    const kind = classify({ url: req.url, mimeType });
    if (!kind) continue;

    const bytes =
      Number(res && res.content && res.content.size) ||
      Number(res && res.bodySize) ||
      Number(res && headerValue(res.headers, 'content-length')) ||
      0;

    const candidate = {
      url: req.url,
      normalizedUrl: normalizeUrl(req.url),
      mimeType: mimeType.split(';', 1)[0].trim(),
      kind,
      bytes: bytes > 0 ? bytes : null,
      source: 'har',
      status: kind === 'stream' ? 'stream' : 'background',
      pageUrl: (entry && entry.pageref) || '',
      timestamp: Date.parse((entry && entry.startedDateTime) || '') || 0,
      initiator: headerValue(req.headers, 'referer'),
    };

    if (rejectionReason(candidate)) {
      skipped += 1;
      continue;
    }
    if (seen.has(candidate.normalizedUrl)) {
      skipped += 1;
      continue;
    }
    if (withBodies && bodyBytes < maxTotal) {
      const decoded = decodeHarBody(res && res.content);
      if (decoded && decoded.byteLength <= maxBody && bodyBytes + decoded.byteLength <= maxTotal) {
        bodies.set(candidate.normalizedUrl, {
          bytes: decoded,
          mimeType: candidate.mimeType || (res && res.content && res.content.mimeType) || '',
        });
        bodyBytes += decoded.byteLength;
        // The capture holds the file, so this one never needs the network.
        candidate.harBody = true;
        if (!candidate.bytes) candidate.bytes = decoded.byteLength;
      }
    }

    seen.add(candidate.normalizedUrl);
    items.push(candidate);
  }

  return { items, bodies, skipped, bodyBytes, error: '' };
}
