/**
 * Per-tab index — the single source of truth.
 *
 * MV3 kills the service worker whenever it feels like it, so nothing may
 * live only in a module variable: every mutation is mirrored into
 * chrome.storage.session and the in-memory copy is a cache that can be
 * rebuilt from storage at any moment.
 */

import { normalizeUrl } from '../core/url-normalize.js';
import { classify, rejectionReason, isDataUri, FILTER_CONFIG } from '../core/media-types.js';
import { SOURCE, STATUS, STATUS_RANK } from '../shared/messages.js';
import { log, warn, error } from '../shared/debug.js';

const KEY_PREFIX = 'tab:';
const OPTIONS_KEY = 'options';
const FLUSH_DELAY_MS = 300;

/** @type {Map<number, object>} */
const cache = new Map();
/** @type {Map<number, Promise<object>>} tabId -> a storage read already in flight */
const loading = new Map();
/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const pendingFlush = new Map();
/** @type {Map<number, Promise<void>>} tabId -> a write to session storage still in flight */
const inflight = new Map();
/** Tabs that changed again while their write was in flight. */
const dirty = new Set();
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
    /**
     * Navigation generation. Bumped when a navigation starts; every item
     * carries the generation it was indexed under, so a reset can retire the
     * previous document's items and keep the ones that already belong to the
     * new one, whichever order the two arrived in.
     */
    gen: 0,
    /** The generation a started navigation is waiting to settle, or null. */
    pendingGen: null,
    /** data: URL characters held, against FILTER_CONFIG.DATA_URI_TAB_BUDGET. */
    dataBytes: 0,
    /** Set when the session history had to be dropped to fit in storage. */
    historyTruncated: false,
    /** Set when live items lost their structure to fit in storage. */
    trimmed: false,
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

/**
 * Write one tab's state through to session storage.
 *
 * One write per tab at a time. A multi-megabyte state takes longer to
 * serialise and ship than the 300 ms debounce, and a crawl changes it
 * constantly; overlapping writes of the same key were piling up until the
 * browser counted them together and refused for quota - at 3 MB of a 10 MB
 * budget. A change during a write is flushed once, after it.
 */
export async function flush(tabId) {
  const state = cache.get(tabId);
  if (!state) return;
  const timer = pendingFlush.get(tabId);
  if (timer) {
    clearTimeout(timer);
    pendingFlush.delete(tabId);
  }
  if (inflight.has(tabId)) {
    dirty.add(tabId);
    return inflight.get(tabId);
  }
  const write = writeState(tabId, state).finally(() => {
    inflight.delete(tabId);
    if (dirty.delete(tabId)) flush(tabId);
  });
  inflight.set(tabId, write);
  return write;
}

async function writeState(tabId, state) {
  try {
    await chrome.storage.session.set({ [key(tabId)]: state });
    state.storageError = '';
  } catch (err) {
    // Kept on the state so the panel can say what the browser said.
    state.storageError = String((err && err.message) || err).slice(0, 200);
    // Out of room - session storage is 10 MB for the whole extension, and a
    // crawl across many pages fills it. The live page is worth more than
    // what came before it: drop the history, say so, and try once more.
    if (state.history && state.history.length) {
      state.history = [];
      state.historyTruncated = true;
      try {
        await chrome.storage.session.set({ [key(tabId)]: state });
        warn('session history dropped for tab', tabId, 'to stay within storage');
        return;
      } catch {
        /* still too big: fall through to trimming the live items */
      }
    }
    // Last resort: keep every URL and status, lose the structure the
    // clustering leans on. A worker restart then still restores the page.
    if (!state.trimmed) {
      for (const k of state.order) if (state.items[k]) state.items[k] = lighten(state.items[k]);
      state.trimmed = true;
      try {
        await chrome.storage.session.set({ [key(tabId)]: state });
        warn('index trimmed for tab', tabId, 'to stay within storage');
        return;
      } catch (again) {
        error('session write failed for tab', tabId, again);
        return;
      }
    }
    // Always reported: a failed write means a worker restart loses this tab.
    error('session write failed for tab', tabId, err);
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
 * A navigation has started in this tab (chrome.tabs.onUpdated 'loading').
 * Nothing is removed yet: everything indexed from here on is tagged with the
 * new generation and belongs to the new document. The old items are retired
 * when the page reports in (resetTab with `olderThan`), or by
 * navigationOutcome() if no page ever does.
 */
export async function beginNavigation(tabId) {
  const state = await getTab(tabId);
  state.gen = (state.gen || 0) + 1;
  state.pendingGen = state.gen;
  if (state.order.length) scheduleFlush(tabId); // an empty tab is not worth a write
  return state;
}

/**
 * The navigation finished (onUpdated 'complete'). Returns 'none' when nothing
 * was pending, 'settled' when the page reported in or the document never
 * changed (a download link, a 204), and 'orphaned' when the URL changed but no
 * content script ever reported - chrome://, a PDF, the Web Store - so the
 * caller should reset the tab itself.
 */
export async function navigationOutcome(tabId, tabUrl) {
  const state = await getTab(tabId);
  if (state.pendingGen == null) return 'none';
  if (tabUrl && state.pageUrl && tabUrl !== state.pageUrl) return 'orphaned';
  state.pendingGen = null;
  return 'settled';
}

function dataChars(url) {
  return isDataUri(url) ? url.length : 0;
}

/**
 * What an item keeps once its page is gone. The structural path and the class
 * frequencies are most of an item's weight and only matter for clustering
 * against neighbours on the same page; a history item has none.
 */
function lighten(item) {
  const { structuralPath, classCounts, ...rest } = item;
  void structuralPath;
  void classCounts;
  return { ...rest, path: [], counts: '', repeatDepth: -1, inRepeatedGroup: false };
}

/**
 * SPA route change or real navigation.
 * @param {number} tabId
 * @param {{url?: string, keepHistory?: boolean, olderThan?: number, keepFlags?: boolean}} opts
 *   `olderThan` retires only items from generations before it and keeps the
 *   rest live; absent, everything is retired. `keepFlags` carries the DRM and
 *   MSE flags across a same-document route change, where the player persists.
 */
export async function resetTab(tabId, opts = {}) {
  const state = await getTab(tabId);
  const keep = opts.keepHistory !== false;
  const live = state.order.map((k) => state.items[k]).filter(Boolean);
  const olderThan = Number.isInteger(opts.olderThan) ? opts.olderThan : Infinity;
  const stale = live.filter((item) => (item.gen || 0) < olderThan);
  const kept = live.filter((item) => (item.gen || 0) >= olderThan);

  const next = emptyTab(tabId);
  next.pageUrl = opts.url || state.pageUrl;
  next.counter = state.counter;
  next.gen = state.gen || 0;
  if (opts.keepFlags) {
    next.emeRequested = Boolean(state.emeRequested);
    next.usesMse = Boolean(state.usesMse);
  }
  for (const item of kept) {
    next.items[item.normalizedUrl] = item;
    next.order.push(item.normalizedUrl);
    next.dataBytes += dataChars(item.url);
  }
  // History survives a reset that found nothing live: two resets in a row (a
  // redirect hop, a replaceState on load) must not empty it.
  next.history = keep
    ? [...(state.history || []), ...stale.map(lighten)].slice(-FILTER_CONFIG.MAX_ITEMS_PER_TAB)
    : [];
  next.historyTruncated = keep ? Boolean(state.historyTruncated) : false;
  next.updatedAt = Date.now();
  cache.set(tabId, next);
  await flush(tabId);
  log('tab reset', tabId, 'retired', stale.length, 'kept', kept.length, 'history', next.history.length);
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

/* ------------------------------------------------------------------ *
 * Stored shape
 *
 * chrome.storage.session charges for the in-memory size of the value tree,
 * about three times its JSON, so the 10 MB quota is reached at roughly 3 MB
 * of JSON - and the structural path (sixteen {tag, classes[]} nodes) and the
 * class-count map are most of an item's objects. They are stored as one
 * string per node and one string per map, and expanded when read. Class
 * names cannot contain spaces, which is what makes the join safe.
 * ------------------------------------------------------------------ */

function packItem(item) {
  const { structuralPath, classCounts, ...rest } = item;
  return {
    ...rest,
    path: Array.isArray(structuralPath)
      ? structuralPath.map((n) => [n.tag || '', ...(n.classes || [])].join(' '))
      : rest.path || [],
    counts: classCounts && typeof classCounts === 'object'
      ? Object.entries(classCounts).map(([name, n]) => `${name} ${n}`).join(' ')
      : rest.counts || '',
  };
}

/** The shape the similarity engine and the panel read. Tolerates both shapes. */
export function unpackItem(item) {
  if (!item) return item;
  if (item.structuralPath) return item; // seeded or legacy: already expanded
  const { path, counts, ...rest } = item;
  const structuralPath = (path || []).map((node) => {
    const [tag, ...classes] = String(node).split(' ');
    return { tag, classes };
  });
  const classCounts = {};
  const tokens = counts ? counts.split(' ') : [];
  for (let i = 0; i + 1 < tokens.length; i += 2) classCounts[tokens[i]] = Number(tokens[i + 1]) || 0;
  return { ...rest, structuralPath, classCounts: counts ? classCounts : null };
}

const hasStructure = (stored) => Boolean(
  (stored.path && stored.path.length) || (stored.structuralPath && stored.structuralPath.length),
);

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

    const existing = unpackItem(state.items[normalized]);
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
        // The newest scan reflects the DOM as it is now: a lazy loader has
        // swapped its placeholder for the real thumbnail by the second pass.
        previewUrl: raw.previewUrl || existing.previewUrl || '',
        synthetic: preferDefined(existing.synthetic, raw.synthetic),
        sources: [...new Set([...(existing.sources || []), ...incomingSources])],
        // Seen again by the current document: it belongs to this generation.
        gen: state.gen || 0,
      };
      merged.status = protectedByEme(state, kind)
        ? STATUS.PROTECTED
        : mergeStatus(existing, { ...raw, sources: incomingSources });
      state.items[normalized] = packItem(merged);
      updated += 1;
      continue;
    }

    if (state.order.length >= FILTER_CONFIG.MAX_ITEMS_PER_TAB) {
      state.truncated = true;
      rejected += 1;
      continue;
    }
    const chars = dataChars(normalized);
    if (chars && (state.dataBytes || 0) + chars > FILTER_CONFIG.DATA_URI_TAB_BUDGET) {
      state.truncated = true;
      rejected += 1;
      continue;
    }
    state.dataBytes = (state.dataBytes || 0) + chars;

    state.counter += 1;
    state.items[normalized] = packItem({
      ...raw,
      kind,
      gen: state.gen || 0,
      id: `${tabId}-${state.counter}`,
      normalizedUrl: normalized,
      url: raw.url,
      sources: [raw.source || SOURCE.DOM],
      status: protectedByEme(state, kind)
        ? STATUS.PROTECTED
        : raw.status || (raw.source === SOURCE.DOM ? STATUS.REFERENCED : STATUS.BACKGROUND),
      firstSeen: raw.timestamp || Date.now(),
    });
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
    return [hasStructure(item) ? 0 : 1, item.firstSeen || 0];
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
  return all.map(unpackItem).sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 9;
    const rb = STATUS_RANK[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    return (a.firstSeen || 0) - (b.firstSeen || 0);
  });
}

export function findItem(state, idOrUrl) {
  if (state.items[idOrUrl]) return unpackItem(state.items[idOrUrl]);
  for (const k of state.order) {
    const item = state.items[k];
    if (item && (item.id === idOrUrl || item.url === idOrUrl)) return unpackItem(item);
  }
  for (const item of state.history || []) {
    if (item && (item.id === idOrUrl || item.url === idOrUrl)) return unpackItem(item);
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
