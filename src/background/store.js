/**
 * Per-tab index — the single source of truth.
 *
 * MV3 kills the service worker whenever it feels like it, so nothing may
 * live only in a module variable: every mutation is mirrored into
 * chrome.storage.session and the in-memory copy is a cache that can be
 * rebuilt from storage at any moment.
 */

import { normalizeUrl } from '../core/url-normalize.js';
import { classify, rejectionReason, FILTER_CONFIG } from '../core/media-types.js';
import { SOURCE, STATUS, STATUS_RANK } from '../shared/messages.js';
import { log, warn } from '../shared/debug.js';

const KEY_PREFIX = 'tab:';
const OPTIONS_KEY = 'options';
const FLUSH_DELAY_MS = 300;

/** @type {Map<number, object>} */
const cache = new Map();
/** @type {Map<number, Promise<object>>} tabId -> a storage read already in flight */
const loading = new Map();
/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const pendingFlush = new Map();
/** @type {Map<number, Promise<unknown>>} tabId -> tail of its mutation chain */
const chains = new Map();

/**
 * Run `fn` after every earlier serialized operation on this tab.
 *
 * A page's own messages (reset, page info, DOM candidates) and the network
 * observer's batches all pass through here, so they are applied in the order
 * they happened rather than the order their awaits resolved. Without it the
 * document_start reset could land after the title, after the first DOM scan,
 * or after the first network batch - and wipe them.
 */
export function serialize(tabId, fn) {
  const previous = chains.get(tabId) || Promise.resolve();
  const next = previous.then(fn, fn);
  chains.set(tabId, next.catch(() => {}));
  return next;
}

export const DEFAULT_OPTIONS = {
  threshold: 'balanced',
  filenameTemplate: 'magpie/{host}/{title}/{index}-{basename}.{ext}',
  concurrency: 4,
  keepSessionHistory: true,
  writeSidecar: false,
  minBytes: 0,
  confirmedOnly: false,
};

function key(tabId) {
  return KEY_PREFIX + tabId;
}

function emptyTab(tabId) {
  return {
    tabId,
    pageUrl: '',
    pageTitle: '',
    /** normalizedUrl -> candidate */
    items: {},
    /** insertion order of normalizedUrl */
    order: [],
    /** candidates from previous SPA routes, kept when the option is on */
    history: [],
    counter: 0,
    usesMse: false,
    emeRequested: false,
    truncated: false,
    updatedAt: 0,
  };
}

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

export async function getOptions() {
  try {
    const stored = await chrome.storage.local.get(OPTIONS_KEY);
    return { ...DEFAULT_OPTIONS, ...(stored[OPTIONS_KEY] || {}) };
  } catch (err) {
    warn('options read failed', err);
    return { ...DEFAULT_OPTIONS };
  }
}

export async function setOptions(patch) {
  const next = { ...(await getOptions()), ...(patch || {}) };
  await chrome.storage.local.set({ [OPTIONS_KEY]: next });
  return next;
}

/* ------------------------------------------------------------------ *
 * Tab state
 * ------------------------------------------------------------------ */

/** @returns {Promise<object>} never null — an unknown tab gets a fresh state. */
export async function getTab(tabId) {
  if (cache.has(tabId)) return cache.get(tabId);
  if (loading.has(tabId)) return loading.get(tabId);
  const read = (async () => {
    let state = null;
    try {
      const stored = await chrome.storage.session.get(key(tabId));
      state = stored[key(tabId)] || null;
    } catch (err) {
      warn('session read failed', err);
    }
    if (!state || typeof state !== 'object' || !state.items) state = emptyTab(tabId);
    state.tabId = tabId;
    // A reset may have installed a newer state while this read was in flight;
    // two concurrent callers must end up holding the same object.
    if (!cache.has(tabId)) cache.set(tabId, state);
    return cache.get(tabId);
  })();
  loading.set(tabId, read);
  try {
    return await read;
  } finally {
    loading.delete(tabId);
  }
}

function scheduleFlush(tabId) {
  if (pendingFlush.has(tabId)) return;
  const timer = setTimeout(() => {
    pendingFlush.delete(tabId);
    flush(tabId);
  }, FLUSH_DELAY_MS);
  pendingFlush.set(tabId, timer);
}

/** Write one tab's state through to session storage immediately. */
export async function flush(tabId) {
  const state = cache.get(tabId);
  if (!state) return;
  const timer = pendingFlush.get(tabId);
  if (timer) {
    clearTimeout(timer);
    pendingFlush.delete(tabId);
  }
  try {
    await chrome.storage.session.set({ [key(tabId)]: state });
  } catch (err) {
    warn('session write failed', err);
  }
}

export async function flushAll() {
  await Promise.all([...cache.keys()].map((id) => flush(id)));
}

export async function deleteTab(tabId) {
  cache.delete(tabId);
  chains.delete(tabId);
  const timer = pendingFlush.get(tabId);
  if (timer) clearTimeout(timer);
  pendingFlush.delete(tabId);
  try {
    await chrome.storage.session.remove(key(tabId));
  } catch (err) {
    warn('session remove failed', err);
  }
}

/** Shallow-merge tab-level flags and persist them. */
export async function patchTab(tabId, patch) {
  const state = await getTab(tabId);
  Object.assign(state, patch || {});
  state.updatedAt = Date.now();
  scheduleFlush(tabId);
  return state;
}

export async function setPageInfo(tabId, { url, title }) {
  const state = await getTab(tabId);
  if (typeof url === 'string' && url) state.pageUrl = url;
  if (typeof title === 'string') state.pageTitle = title;
  state.updatedAt = Date.now();
  scheduleFlush(tabId);
  return state;
}

/**
 * SPA route change or real navigation.
 * @param {number} tabId
 * @param {{url?: string, keepHistory?: boolean}} opts
 */
export async function resetTab(tabId, opts = {}) {
  const state = await getTab(tabId);
  const keep = opts.keepHistory !== false;
  const previous = state.order.map((k) => state.items[k]).filter(Boolean);
  const next = emptyTab(tabId);
  next.pageUrl = opts.url || state.pageUrl;
  next.counter = state.counter;
  if (keep && previous.length) {
    next.history = [...state.history, ...previous].slice(-FILTER_CONFIG.MAX_ITEMS_PER_TAB);
  }
  next.updatedAt = Date.now();
  cache.set(tabId, next);
  await flush(tabId);
  log('tab reset', tabId, 'kept', next.history.length, 'historical items');
  return next;
}

/* ------------------------------------------------------------------ *
 * Merging
 * ------------------------------------------------------------------ */

/**
 * Which status wins when the same URL arrives from two layers.
 * DOM + network => confirmed. Protected and unavailable are sticky.
 */
function mergeStatus(existing, incoming) {
  if (existing.status === STATUS.PROTECTED || incoming.status === STATUS.PROTECTED) {
    return STATUS.PROTECTED;
  }
  // A decoded <img> or a readable canvas is proof the bytes arrived; a later
  // DOM-only sighting must not talk that back down to "referenced".
  if (existing.status === STATUS.CONFIRMED || incoming.status === STATUS.CONFIRMED) {
    return STATUS.CONFIRMED;
  }
  const sources = new Set([...(existing.sources || []), ...(incoming.sources || [])]);
  const sawDom = sources.has(SOURCE.DOM);
  const sawNet = sources.has(SOURCE.NET) || sources.has(SOURCE.MAIN) || sources.has(SOURCE.HAR);
  if (sawDom && sawNet) return STATUS.CONFIRMED;
  if (sawNet) return STATUS.BACKGROUND;
  if (existing.status === STATUS.UNAVAILABLE || incoming.status === STATUS.UNAVAILABLE) {
    return STATUS.UNAVAILABLE;
  }
  return STATUS.REFERENCED;
}

function preferDefined(a, b) {
  return a === undefined || a === null || a === '' || a === 0 ? b : a;
}

const AV_KINDS = new Set(['video', 'audio', 'stream']);

/** Once a page has asked for a key system, its audio and video stay protected. */
function protectedByEme(state, kind) {
  return Boolean(state.emeRequested) && AV_KINDS.has(kind);
}

/**
 * Merge a batch of candidates into a tab.
 * @param {number} tabId
 * @param {object[]} candidates already sanitized
 * @returns {Promise<{added: number, updated: number, rejected: number, truncated: boolean}>}
 */
export async function addCandidates(tabId, candidates) {
  const state = await getTab(tabId);
  let added = 0;
  let updated = 0;
  let rejected = 0;

  for (const raw of candidates) {
    if (!raw || !raw.url) continue;

    const kind = raw.kind || classify(raw);
    if (!kind) {
      rejected += 1;
      continue;
    }
    if (rejectionReason({ ...raw, kind })) {
      rejected += 1;
      continue;
    }

    const normalized = raw.normalizedUrl || normalizeUrl(raw.url, state.pageUrl || undefined);
    if (!normalized) {
      rejected += 1;
      continue;
    }

    const existing = state.items[normalized];
    if (existing) {
      const incomingSources = [raw.source || SOURCE.DOM];
      const merged = {
        ...existing,
        mimeType: preferDefined(existing.mimeType, raw.mimeType),
        width: Math.max(existing.width || 0, raw.width || 0),
        height: Math.max(existing.height || 0, raw.height || 0),
        renderedWidth: Math.max(existing.renderedWidth || 0, raw.renderedWidth || 0),
        renderedHeight: Math.max(existing.renderedHeight || 0, raw.renderedHeight || 0),
        bytes: existing.bytes != null ? existing.bytes : raw.bytes,
        // The path, its group identity and its class frequencies are one
        // observation: keeping half of an old one and half of a new one would
        // score against a group key that never existed.
        ...(existing.structuralPath && existing.structuralPath.length
          ? {
              structuralPath: existing.structuralPath,
              inRepeatedGroup: Boolean(existing.inRepeatedGroup),
              repeatDepth: Number.isInteger(existing.repeatDepth) ? existing.repeatDepth : -1,
              classCounts: existing.classCounts || null,
            }
          : {
              structuralPath: raw.structuralPath || [],
              inRepeatedGroup: Boolean(raw.inRepeatedGroup),
              repeatDepth: Number.isInteger(raw.repeatDepth) ? raw.repeatDepth : -1,
              classCounts: raw.classCounts || null,
            }),
        elementId: preferDefined(existing.elementId, raw.elementId),
        alt: preferDefined(existing.alt, raw.alt),
        // Sticky: once a capture is known to hold the bytes, later sightings
        // over the network must not downgrade it back to a re-fetch.
        harBody: Boolean(existing.harBody || raw.harBody),
        upgradeUrl: preferDefined(existing.upgradeUrl, raw.upgradeUrl),
        upgradeNote: preferDefined(existing.upgradeNote, raw.upgradeNote),
        frameUrl: preferDefined(existing.frameUrl, raw.frameUrl),
        frameOrigin: preferDefined(existing.frameOrigin, raw.frameOrigin),
        protectedReason: preferDefined(existing.protectedReason, raw.protectedReason),
        previewUrl: preferDefined(existing.previewUrl, raw.previewUrl),
        synthetic: preferDefined(existing.synthetic, raw.synthetic),
        sources: [...new Set([...(existing.sources || []), ...incomingSources])],
      };
      merged.status = protectedByEme(state, kind)
        ? STATUS.PROTECTED
        : mergeStatus(existing, { ...raw, sources: incomingSources });
      state.items[normalized] = merged;
      updated += 1;
      continue;
    }

    if (state.order.length >= FILTER_CONFIG.MAX_ITEMS_PER_TAB) {
      state.truncated = true;
      rejected += 1;
      continue;
    }

    state.counter += 1;
    state.items[normalized] = {
      ...raw,
      kind,
      id: `${tabId}-${state.counter}`,
      normalizedUrl: normalized,
      url: raw.url,
      sources: [raw.source || SOURCE.DOM],
      status: protectedByEme(state, kind)
        ? STATUS.PROTECTED
        : raw.status || (raw.source === SOURCE.DOM ? STATUS.REFERENCED : STATUS.BACKGROUND),
      firstSeen: raw.timestamp || Date.now(),
    };
    state.order.push(normalized);
    added += 1;
  }

  if (added || updated) {
    state.updatedAt = Date.now();
    scheduleFlush(tabId);
  }
  return { added, updated, rejected, truncated: state.truncated };
}

/** Patch one item in place (used by upgrade verification and stream probing). */
export async function updateItem(tabId, normalizedUrl, patch) {
  const state = await getTab(tabId);
  const item = state.items[normalizedUrl];
  if (!item) return null;
  state.items[normalizedUrl] = { ...item, ...patch };
  state.updatedAt = Date.now();
  scheduleFlush(tabId);
  return state.items[normalizedUrl];
}

/**
 * Collapse items that resolve to the same file.
 *
 * A WordPress gallery indexes `beach-01-150x150.jpg` (in the grid) and
 * `beach-01.jpg` (the link target) as two items; once the thumbnail's upgrade
 * is verified, both download the same bytes. Two thumbnail sizes of one asset
 * do the same. Grouping by the URL that would actually be fetched catches both
 * shapes, so "download all similar" cannot save one image twice.
 *
 * The survivor is the item with DOM structure (it is the one on screen, and it
 * carries the grid context clustering needs); ties break on discovery order.
 *
 * @param {number} tabId
 * @returns {Promise<number>} how many duplicates were folded away
 */
export async function collapseUpgradeDuplicates(tabId) {
  const state = await getTab(tabId);
  const groups = new Map();

  for (const key of state.order) {
    const item = state.items[key];
    if (!item) continue;
    const effective = item.upgradeVerified && item.upgradeUrl
      ? normalizeUrl(item.upgradeUrl, state.pageUrl || undefined)
      : item.normalizedUrl;
    if (!effective) continue;
    if (!groups.has(effective)) groups.set(effective, []);
    groups.get(effective).push(key);
  }

  const rank = (key) => {
    const item = state.items[key];
    const hasStructure = item.structuralPath && item.structuralPath.length ? 0 : 1;
    return [hasStructure, item.firstSeen || 0];
  };

  let collapsed = 0;
  for (const keys of groups.values()) {
    if (keys.length < 2) continue;
    const ordered = keys.slice().sort((a, b) => {
      const [sa, ta] = rank(a);
      const [sb, tb] = rank(b);
      return sa !== sb ? sa - sb : ta - tb;
    });
    const [survivorKey, ...duplicates] = ordered;
    const survivor = { ...state.items[survivorKey] };
    for (const key of duplicates) {
      const dup = state.items[key];
      if (!dup) continue;
      survivor.sources = [...new Set([...(survivor.sources || []), ...(dup.sources || [])])];
      if (survivor.upgradeBytes == null && dup.bytes != null) survivor.upgradeBytes = dup.bytes;
      if (!survivor.width && dup.width) {
        survivor.width = dup.width;
        survivor.height = dup.height;
      }
      delete state.items[key];
      const at = state.order.indexOf(key);
      if (at !== -1) state.order.splice(at, 1);
      collapsed += 1;
    }
    survivor.mergedDuplicates = (survivor.mergedDuplicates || 0) + duplicates.length;
    state.items[survivorKey] = survivor;
  }

  if (collapsed) {
    state.updatedAt = Date.now();
    scheduleFlush(tabId);
    log('collapsed', collapsed, 'duplicate item(s) on tab', tabId);
  }
  return collapsed;
}

/** Items in display order: confirmed first, then by discovery time. */
export function itemsOf(state, { includeHistory = false } = {}) {
  const live = state.order.map((k) => state.items[k]).filter(Boolean);
  const all = includeHistory ? [...live, ...(state.history || [])] : live;
  return all.slice().sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 9;
    const rb = STATUS_RANK[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    return (a.firstSeen || 0) - (b.firstSeen || 0);
  });
}

export function findItem(state, idOrUrl) {
  if (state.items[idOrUrl]) return state.items[idOrUrl];
  for (const k of state.order) {
    const item = state.items[k];
    if (item && (item.id === idOrUrl || item.url === idOrUrl)) return item;
  }
  for (const item of state.history || []) {
    if (item && (item.id === idOrUrl || item.url === idOrUrl)) return item;
  }
  return null;
}

/** Drop state for tabs that no longer exist. Cheap housekeeping on wake. */
export async function pruneClosedTabs() {
  try {
    const stored = await chrome.storage.session.get(null);
    const openTabs = new Set((await chrome.tabs.query({})).map((t) => t.id));
    const dead = Object.keys(stored)
      .filter((k) => k.startsWith(KEY_PREFIX))
      .filter((k) => !openTabs.has(Number(k.slice(KEY_PREFIX.length))));
    if (dead.length) {
      await chrome.storage.session.remove(dead);
      for (const k of dead) cache.delete(Number(k.slice(KEY_PREFIX.length)));
      log('pruned', dead.length, 'closed tabs');
    }
  } catch (err) {
    warn('prune failed', err);
  }
}
