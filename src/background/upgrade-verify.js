/**
 * Resolution upgrades: propose candidates from the pure rules, then prove
 * them with a HEAD request before offering them.
 *
 * A 404 dressed up as "full resolution" is worse than no upgrade at all,
 * so an unverified candidate is never presented as the download target.
 */

import { upgradeCandidates } from '../core/upgrade-rules.js';
import { kindFromMime } from '../core/media-types.js';
import { updateItem, collapseUpgradeDuplicates } from './store.js';
import { log, warn } from '../shared/debug.js';

const RULES_URL = 'rules/site-rules.json';
const MAX_CANDIDATES_PER_ITEM = 6;
const MAX_PARALLEL = 4;
const HEAD_TIMEOUT_MS = 6000;

let rulesPromise = null;

export async function loadSiteRules() {
  if (!rulesPromise) {
    rulesPromise = (async () => {
      try {
        const res = await fetch(chrome.runtime.getURL(RULES_URL));
        const doc = await res.json();
        const rules = Array.isArray(doc.rules) ? doc.rules : [];
        log('loaded', rules.length, 'site rules');
        return rules;
      } catch (err) {
        warn('site rules unavailable', err);
        return [];
      }
    })();
  }
  return rulesPromise;
}

async function head(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      credentials: 'include',
      redirect: 'follow',
      signal: controller.signal,
    });
    const lengthHeader = res.headers.get('content-length');
    return {
      ok: res.ok,
      status: res.status,
      bytes: lengthHeader ? Number(lengthHeader) || null : null,
      mimeType: (res.headers.get('content-type') || '').split(';', 1)[0].trim(),
    };
  } catch {
    return { ok: false, status: 0, bytes: null, mimeType: '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} item
 * @param {object[]} rules
 * @returns {Promise<{url: string, note: string, bytes: number|null}|null>}
 */
export async function verifyUpgrade(item, rules) {
  if (!item || !item.url) return null;
  if (item.kind === 'stream' || item.status === 'protected') return null;
  if (item.url.startsWith('data:') || item.url.startsWith('blob:')) return null;

  const candidates = upgradeCandidates(item.url, rules).slice(0, MAX_CANDIDATES_PER_ITEM);
  if (!candidates.length) return null;

  const originalBytes = Number(item.bytes) || 0;

  for (const candidate of candidates) {
    if (!candidate.verify) return { url: candidate.url, note: candidate.note, bytes: null };
    const probe = await head(candidate.url);
    if (!probe.ok) continue;
    // The upgrade must still be media...
    if (probe.mimeType && !kindFromMime(probe.mimeType)) continue;
    // ...and must not be smaller than what we already have.
    if (originalBytes && probe.bytes && probe.bytes < originalBytes) continue;
    return { url: candidate.url, note: candidate.note, bytes: probe.bytes };
  }
  return null;
}

/**
 * Verify a batch, writing results back into the tab index.
 * @param {number} tabId
 * @param {object[]} items
 * @returns {Promise<{checked: number, upgraded: number}>}
 */
export async function verifyBatch(tabId, items) {
  const rules = await loadSiteRules();
  let checked = 0;
  let upgraded = 0;
  const queue = items.filter((i) => i && !i.upgradeChecked);

  async function worker() {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      checked += 1;
      let result = null;
      try {
        result = await verifyUpgrade(item, rules);
      } catch (err) {
        warn('upgrade probe failed', err);
      }
      await updateItem(tabId, item.normalizedUrl, {
        upgradeChecked: true,
        upgradeVerified: Boolean(result),
        upgradeUrl: result ? result.url : '',
        upgradeNote: result ? result.note : '',
        upgradeBytes: result ? result.bytes : null,
      });
      if (result) upgraded += 1;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL, Math.max(1, queue.length)) }, worker),
  );
  // Now that every upgrade target is known, fold away the items that would
  // have downloaded the same file twice.
  const collapsed = await collapseUpgradeDuplicates(tabId);
  return { checked, upgraded, collapsed };
}
