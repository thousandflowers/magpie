/**
 * HAR (HTTP Archive) import. Pure — takes parsed JSON, returns candidates.
 *
 * Exists because a DevTools capture is sometimes the only way to get at a
 * session, and because HAR entries keep response bodies the live page has
 * already thrown away.
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

/**
 * @param {object|string} har parsed HAR object, or its JSON text
 * @param {object} [opts] {maxItems}
 * @returns {{items: object[], skipped: number, error: string}}
 */
export function parseHar(har, opts = {}) {
  const maxItems = opts.maxItems || FILTER_CONFIG.MAX_ITEMS_PER_TAB;
  let doc = har;
  if (typeof har === 'string') {
    try {
      doc = JSON.parse(har);
    } catch (err) {
      return { items: [], skipped: 0, error: 'Not valid JSON: ' + err.message };
    }
  }
  const entries = doc && doc.log && Array.isArray(doc.log.entries) ? doc.log.entries : null;
  if (!entries) return { items: [], skipped: 0, error: 'No log.entries — is this a HAR file?' };

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
    seen.add(candidate.normalizedUrl);
    items.push(candidate);
  }

  return { items, skipped, error: '' };
}
