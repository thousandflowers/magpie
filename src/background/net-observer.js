/**
 * Layer A — network observer.
 *
 * Purely observational: no blocking, no redirecting, no header rewriting.
 * webRequest is used in listener mode only, which is why the extension needs
 * "webRequest" but not "webRequestBlocking" or declarativeNetRequest.
 */

import { addCandidates, serialize } from './store.js';
import { normalizeUrl } from '../core/url-normalize.js';
import { classify, extOf, kindFromExt, rejectionReason } from '../core/media-types.js';
import { SOURCE, STATUS } from '../shared/messages.js';
import { log } from '../shared/debug.js';

/** chrome.webRequest.ResourceType values only — an unknown one throws. */
const WATCHED_TYPES = [
  'image', 'media', 'xmlhttprequest', 'object', 'other', 'sub_frame',
];

const FLUSH_MS = 250;

/** tabId -> pending candidates */
const queue = new Map();
let flushTimer = null;
let onFlush = null;

function enqueue(tabId, candidate) {
  if (tabId == null || tabId < 0) return; // requests with no tab (e.g. SW fetches)
  if (!queue.has(tabId)) queue.set(tabId, []);
  queue.get(tabId).push(candidate);
  if (!flushTimer) flushTimer = setTimeout(flushQueue, FLUSH_MS);
}

async function flushQueue() {
  flushTimer = null;
  const batches = [...queue.entries()];
  queue.clear();
  for (const [tabId, items] of batches) {
    try {
      const result = await serialize(tabId, () => addCandidates(tabId, items));
      if ((result.added || result.updated) && onFlush) onFlush(tabId, result);
    } catch (err) {
      log('net flush failed', err);
    }
  }
}

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return '';
  const target = name.toLowerCase();
  for (const h of headers) {
    if (h && h.name && h.name.toLowerCase() === target) return String(h.value || '');
  }
  return '';
}

/**
 * Build a candidate, or null when this request is not media.
 * @param {object} details webRequest details
 * @param {string} mimeType '' when headers have not arrived yet
 * @param {number|null} bytes
 */
function toCandidate(details, mimeType, bytes) {
  const kind = classify({ url: details.url, mimeType }) ||
    kindFromExt(extOf(details.url));
  if (!kind) return null;

  const candidate = {
    url: details.url,
    normalizedUrl: normalizeUrl(details.url),
    mimeType: mimeType.split(';', 1)[0].trim(),
    kind,
    bytes,
    source: SOURCE.NET,
    status: STATUS.BACKGROUND,
    initiator: details.initiator || details.documentUrl || '',
    frameUrl: details.frameId ? details.documentUrl || '' : '',
    requestType: details.type,
    frameId: details.frameId,
    timestamp: details.timeStamp || Date.now(),
  };
  if (rejectionReason(candidate)) return null;
  return candidate;
}

function onBeforeRequest(details) {
  // Header-less pass: catches cached responses and octet-stream media whose
  // only tell is the path. MIME arrives later and upgrades the record.
  const ext = extOf(details.url);
  if (!kindFromExt(ext)) return;
  const candidate = toCandidate(details, '', null);
  if (candidate) enqueue(details.tabId, candidate);
}

function onHeadersReceived(details) {
  const mimeType = headerValue(details.responseHeaders, 'content-type');
  const lengthHeader = headerValue(details.responseHeaders, 'content-length');
  const bytes = lengthHeader ? Number(lengthHeader) || null : null;

  const candidate = toCandidate(details, mimeType, bytes);
  if (!candidate) return;

  const disposition = headerValue(details.responseHeaders, 'content-disposition');
  if (disposition) candidate.contentDisposition = disposition.slice(0, 256);
  enqueue(details.tabId, candidate);
}

let installed = false;

/**
 * @param {(tabId: number, result: object) => void} notify called after a merge
 */
export function installNetObserver(notify) {
  onFlush = notify;
  if (installed) return;
  if (!chrome.webRequest) {
    log('webRequest unavailable — Layer A disabled');
    return;
  }
  const filter = { urls: ['<all_urls>'], types: WATCHED_TYPES };
  chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, filter);
  chrome.webRequest.onHeadersReceived.addListener(onHeadersReceived, filter, ['responseHeaders']);
  installed = true;
  log('net observer installed');
}

/** Exposed for the service worker's suspend handler. */
export function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return flushQueue();
}
