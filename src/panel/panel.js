/**
 * Panel controller.
 *
 * Owns presentation only: filtering, clustering, selection and the drawers.
 * The per-tab index lives in the service worker, so the panel can be closed
 * and reopened (or the worker killed) without losing anything.
 */

import './components/mg-item.js';
import './components/mg-group.js';

import {
  cluster, clusterChunked, selectSimilar, describeGroup,
} from '../core/similarity.js';
import { SIMILARITY_PRESETS, FILTER_CONFIG } from '../core/media-types.js';
import {
  formatBytes, applyTemplate, tokensFor, DEFAULT_TEMPLATE, sanitizeSegment,
} from '../core/filename.js';
import {
  parseM3U8, parseMPD, ytDlpCommand, ffmpegCommand, estimateBytes,
} from '../core/manifest-parse.js';
import { parseHar } from '../core/har-import.js';
import { expiryInfo } from '../core/url-normalize.js';
import { MSG } from '../shared/messages.js';

/** Above this many items, clustering is skipped for the remainder and said so. */
const CLUSTER_LIMIT = 1200;
const REFRESH_DEBOUNCE_MS = 220;

/**
 * The one place a stream variant's columns are defined. The header row and the
 * cells are both generated from this list, and the stylesheet keys off
 * `data-field` and `data-label`, so reordering this array reorders everything
 * together and cannot desynchronise a label from its value.
 */
const VARIANT_COLUMNS = [
  { field: 'select', label: '' },
  { field: 'resolution', label: 'resolution' },
  { field: 'bitrate', label: 'bitrate', inline: true },
  { field: 'codec', label: 'codec', inline: true },
  { field: 'size', label: 'size', inline: true },
];

const $ = (id) => document.getElementById(id);

const el = {
  host: $('host'),
  totals: $('totals'),
  search: $('search'),
  threshold: $('threshold'),
  rescan: $('rescan'),
  minDim: $('min-dim'),
  minKb: $('min-kb'),
  confirmedOnly: $('confirmed-only'),
  includeHistory: $('include-history'),
  upgradeAll: $('upgrade-all'),
  explore: $('explore'),
  banner: $('banner'),
  body: $('body'),
  empty: $('empty'),
  detail: $('detail'),
  dropzone: $('dropzone'),
  harInput: $('har-input'),
  progress: $('progress'),
  progressText: $('progress-text'),
  progressFill: $('progress-fill'),
  stop: $('stop'),
  template: $('template'),
  selection: $('selection'),
  clear: $('clear'),
  download: $('download'),
};

const state = {
  tabId: null,
  pageUrl: '',
  pageTitle: '',
  items: [],
  options: {},
  truncated: false,
  historyCount: 0,
  emeRequested: false,
  selected: new Set(),
  seedId: null,
  seedScores: new Map(),
  expandedId: null,
  groups: [],
  notClustered: 0,
  sessionId: null,
  crawling: false,
  /** Files written locally in the current download, so progress does not lie. */
  localSaved: 0,
  /**
   * normalizedUrl -> {bytes, mimeType} decoded from an imported HAR. Held in
   * the panel, never in the store: a capture can carry hundreds of megabytes
   * and chrome.storage.session has a quota. Lives as long as the panel does.
   */
  harBodies: new Map(),
  kinds: new Set(['image', 'video', 'audio', 'stream']),
  renderToken: 0,
  /** A one-line hint for the banner, e.g. that the page needs a reload. */
  notice: '',
};

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...message, tabId: state.tabId }, (response) => {
      void chrome.runtime.lastError;
      resolve(response || { ok: false });
    });
  });
}

function toTab(message) {
  return new Promise((resolve) => {
    if (state.tabId == null) return resolve({ ok: false });
    chrome.tabs.sendMessage(state.tabId, message, (response) => {
      void chrome.runtime.lastError;
      resolve(response || { ok: false });
    });
  });
}

async function resolveTabId() {
  const params = new URLSearchParams(location.search);
  const fromQuery = Number(params.get('tabId'));
  if (Number.isInteger(fromQuery) && fromQuery > 0) return fromQuery;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, REFRESH_DEBOUNCE_MS);
}

async function refresh({ consumeSeed = false } = {}) {
  if (state.tabId == null) return;
  const response = await send({
    type: MSG.GET_STATE,
    consumeSeed,
    includeHistory: el.includeHistory.checked,
  });
  if (!response.ok) return;

  state.items = response.items || [];
  state.pageUrl = response.pageUrl || '';
  state.pageTitle = response.pageTitle || '';
  state.options = response.options || {};
  state.truncated = Boolean(response.truncated);
  state.historyCount = response.historyCount || 0;
  state.emeRequested = Boolean(response.emeRequested);
  // The "reload the page" hint has done its job once anything arrives.
  if (state.notice && state.items.length) state.notice = '';

  if (!el.template.value) el.template.value = state.options.filenameTemplate || DEFAULT_TEMPLATE;
  if (state.options.threshold) el.threshold.value = state.options.threshold;

  // Drop selections whose items are gone (navigation, filter change).
  const live = new Set(state.items.map((i) => i.id));
  for (const id of [...state.selected]) if (!live.has(id)) state.selected.delete(id);

  if (consumeSeed && response.seed) {
    const seedItem = state.items.find((i) => i.normalizedUrl === response.seed);
    if (seedItem) applySeed(seedItem);
  }

  await render();
}

/* ------------------------------------------------------------------ *
 * Filtering and grouping
 * ------------------------------------------------------------------ */

function currentThreshold() {
  return SIMILARITY_PRESETS[el.threshold.value] || SIMILARITY_PRESETS.balanced;
}

function filtered() {
  const needle = el.search.value.trim().toLowerCase();
  const minDim = Number(el.minDim.value) || 0;
  const minBytes = (Number(el.minKb.value) || 0) * 1024;
  const confirmedOnly = el.confirmedOnly.checked;

  return state.items.filter((item) => {
    if (!state.kinds.has(item.kind)) return false;
    if (confirmedOnly && item.status !== 'confirmed') return false;
    if (minDim && Math.max(item.width || 0, item.height || 0) < minDim) return false;
    if (minBytes && (item.bytes || 0) < minBytes) return false;
    if (needle && !item.url.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/**
 * Cluster without blocking: the score matrix is quadratic, so it is walked in
 * time-boxed chunks and the tail beyond CLUSTER_LIMIT is reported, not hidden.
 */
async function computeGroups(items, token) {
  const threshold = currentThreshold();
  const head = items.slice(0, CLUSTER_LIMIT);
  const tail = items.slice(CLUSTER_LIMIT);

  let groups;
  if (head.length <= 200) {
    groups = cluster(head, threshold);
  } else {
    let chunk = clusterChunked(head, threshold, null, FILTER_CONFIG.SCORE_CHUNK_MS);
    while (!chunk.done) {
      if (token !== state.renderToken) return null; // a newer render superseded us
      await new Promise((resolve) => requestAnimationFrame(resolve));
      chunk = clusterChunked(head, threshold, chunk.state, FILTER_CONFIG.SCORE_CHUNK_MS);
    }
    groups = chunk.groups;
  }

  if (tail.length) groups.push({ items: tail, size: tail.length, unclustered: true });
  state.notClustered = tail.length;
  return groups;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const revealObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (typeof entry.target.reveal === 'function') entry.target.reveal();
      revealObserver.unobserve(entry.target);
    }
  },
  { root: null, rootMargin: '200px' },
);

async function render() {
  const token = ++state.renderToken;
  const items = filtered();

  el.host.textContent = hostLabel();
  const totalBytes = items.reduce((sum, i) => sum + (i.bytes || 0), 0);
  el.totals.textContent = `${items.length} item${items.length === 1 ? '' : 's'} · ${formatBytes(totalBytes)}`;

  const groups = await computeGroups(items, token);
  if (groups === null || token !== state.renderToken) return;
  state.groups = groups;

  el.empty.hidden = items.length > 0;
  // Tiles from the previous render are about to be dropped; stop watching them.
  revealObserver.disconnect();
  const fragment = document.createDocumentFragment();

  groups.forEach((group, index) => {
    const node = document.createElement('mg-group');
    const summary = group.unclustered
      ? {
          count: group.size,
          kind: '',
          dimensions: null,
          pattern: `not clustered — over the ${CLUSTER_LIMIT}-item limit`,
          bytes: group.items.reduce((s, i) => s + (i.bytes || 0), 0),
          label: 'not clustered',
        }
      : describeGroup(group.items);
    node.summary = summary;
    node.dataset.groupIndex = String(index);

    const grid = node.grid;
    for (const item of group.items) {
      const tile = document.createElement('mg-item');
      tile.item = item;
      if (state.selected.has(item.id)) tile.setAttribute('selected', '');
      if (state.seedScores.has(item.id)) tile.score = state.seedScores.get(item.id);
      grid.appendChild(tile);
      revealObserver.observe(tile);
    }
    fragment.appendChild(node);
  });

  el.body.textContent = '';
  el.body.appendChild(el.empty);
  el.body.appendChild(fragment);

  updateSelectionUi();
  updateBanner();
  if (state.expandedId) showDetail(findItem(state.expandedId));
}

function hostLabel() {
  if (!state.pageUrl) return 'no page';
  try {
    return new URL(state.pageUrl).host;
  } catch {
    return state.pageUrl;
  }
}

function updateBanner() {
  const notes = [];
  if (state.notice) notes.push(state.notice);
  if (state.truncated) {
    notes.push(`index capped at ${FILTER_CONFIG.MAX_ITEMS_PER_TAB} items — later finds were dropped`);
  }
  if (state.notClustered) {
    notes.push(`${state.notClustered} items past the clustering limit are listed ungrouped`);
  }
  if (state.emeRequested) {
    notes.push('this page uses DRM — protected media cannot be downloaded');
  }
  const expiring = expiringSelection();
  if (expiring) notes.push(`${expiring} selected URL(s) expire within 10 minutes — they are queued first`);

  el.banner.textContent = notes.join(' · ');
  el.banner.hidden = notes.length === 0;
}

function expiringSelection() {
  let count = 0;
  const soon = Date.now() + FILTER_CONFIG.EXPIRY_WARN_MS;
  for (const item of selectedItems()) {
    if (!item.expiresAt && !item.expiring) continue;
    if (!item.expiresAt || item.expiresAt < soon) count += 1;
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

function findItem(id) {
  return state.items.find((i) => i.id === id) || null;
}

function selectedItems() {
  return state.items.filter((i) => state.selected.has(i.id));
}

function isDownloadable(item) {
  return item.status !== 'protected' && item.status !== 'unavailable' && item.kind !== 'stream';
}

function setSelected(id, on) {
  if (on) state.selected.add(id);
  else state.selected.delete(id);
  const tile = document.getElementById(`item-${id}`);
  if (tile) tile.toggleAttribute('selected', on);
}

function updateSelectionUi() {
  const items = selectedItems();
  const downloadable = items.filter(isDownloadable);
  const bytes = downloadable.reduce((sum, i) => sum + (i.upgradeBytes || i.bytes || 0), 0);

  el.selection.textContent = '';
  const strong = document.createElement('b');
  strong.textContent = String(items.length);
  el.selection.append(strong, document.createTextNode(` selected · ${formatBytes(bytes)}`));
  if (items.length !== downloadable.length) {
    const note = document.createElement('span');
    note.className = 'dim';
    note.textContent = `  (${items.length - downloadable.length} not downloadable)`;
    el.selection.appendChild(note);
  }
  el.download.disabled = downloadable.length === 0;

  for (const node of el.body.querySelectorAll('mg-group')) {
    const tiles = [...node.querySelectorAll('mg-item')];
    const chosen = tiles.filter((t) => t.hasAttribute('selected')).length;
    node.setSelectionState(chosen, tiles.length);
  }
  updateBanner();
}

function clearSelection() {
  for (const id of [...state.selected]) setSelected(id, false);
  state.seedId = null;
  state.seedScores.clear();
  for (const tile of el.body.querySelectorAll('mg-item')) tile.score = null;
  updateSelectionUi();
}

/** Re-run scoring with this item as the seed and select everything similar. */
function applySeed(seed) {
  const threshold = currentThreshold();
  const matches = selectSimilar(seed, filtered(), threshold);
  state.seedId = seed.id;
  state.seedScores = new Map(matches.map((m) => [m.item.id, m.score]));
  state.selected = new Set(matches.map((m) => m.item.id));
  for (const tile of el.body.querySelectorAll('mg-item')) {
    const id = tile.item ? tile.item.id : null;
    tile.toggleAttribute('selected', state.selected.has(id));
    tile.score = state.seedScores.has(id) ? state.seedScores.get(id) : null;
  }
  updateSelectionUi();
}

/* ------------------------------------------------------------------ *
 * Detail drawer
 * ------------------------------------------------------------------ */

function row(dl, key, value, className) {
  const dt = document.createElement('dt');
  dt.textContent = key;
  const dd = document.createElement('dd');
  dd.textContent = value;
  if (className) dd.className = className;
  dl.append(dt, dd);
}

function button(label, onClick, { disabled = false, title = '' } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.disabled = disabled;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function showDetail(item) {
  if (!item) {
    el.detail.hidden = true;
    state.expandedId = null;
    return;
  }
  state.expandedId = item.id;
  el.detail.hidden = false;
  el.detail.textContent = '';

  const dl = document.createElement('dl');
  row(dl, 'kind', `${item.kind}${item.mimeType ? ` · ${item.mimeType}` : ''}`);
  row(dl, 'size', item.width && item.height ? `${item.width}×${item.height}` : 'unknown');
  row(dl, 'bytes', item.bytes ? formatBytes(item.bytes) : 'unknown');
  row(dl, 'status', item.status + (item.protectedReason ? ` — ${item.protectedReason}` : ''));
  row(dl, 'layer', (item.sources || []).join(' + ') || item.source || '—');
  if (hasHarBody(item)) row(dl, 'source', 'imported HAR body — saved without the network');
  else if (item.harBody) row(dl, 'source', 'HAR body was imported in another panel session — will re-fetch');
  if (item.frameOrigin) row(dl, 'frame', item.frameOrigin);
  row(dl, 'saves as', applyTemplate(el.template.value || DEFAULT_TEMPLATE, tokensFor(item, {
    pageUrl: state.pageUrl, pageTitle: state.pageTitle, index: 1, total: state.selected.size || 1,
  })));
  el.detail.appendChild(dl);

  const urls = document.createElement('div');
  urls.className = 'url-compare';
  row(urls, 'original', item.url);
  if (item.upgradeVerified && item.upgradeUrl) {
    row(urls, 'upgraded', `${item.upgradeUrl}  (${item.upgradeNote})`, 'upgraded');
  } else if (item.upgradeChecked) {
    row(urls, 'upgraded', 'no verified higher-resolution original');
  } else {
    row(urls, 'upgraded', 'not probed yet — press "find originals"');
  }
  el.detail.appendChild(urls);

  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  const blocked = !isDownloadable(item);
  actions.append(
    button('download', () => downloadItems([item]), {
      disabled: blocked,
      title: blocked ? 'DRM protected — not downloadable' : '',
    }),
    button('copy URL', () => navigator.clipboard.writeText(item.upgradeUrl || item.url)),
    button('open in new tab', () => chrome.tabs.create({ url: item.url, active: false }), {
      disabled: item.url.startsWith('magpie-'),
    }),
    button('select similar to this', () => applySeed(item)),
  );
  if (item.elementId) {
    actions.appendChild(
      button('show on page', () => toTab({ type: MSG.HIGHLIGHT_ITEM, elementId: item.elementId })),
    );
  }
  actions.appendChild(button('close', () => showDetail(null)));
  el.detail.appendChild(actions);

  if (item.kind === 'stream') renderStream(item);
}

/* ------------------------------------------------------------------ *
 * Streams
 * ------------------------------------------------------------------ */

async function renderStream(item) {
  const box = document.createElement('div');
  box.textContent = 'reading manifest…';
  el.detail.appendChild(box);

  let info = null;
  let failure = '';
  try {
    const response = await fetch(item.url, { credentials: 'include' });
    const text = await response.text();
    const isDash =
      /\.mpd(?:[?#]|$)/i.test(item.url) || /dash\+xml/i.test(item.mimeType || '') ||
      text.trimStart().startsWith('<');
    info = isDash ? parseMPD(text, item.url, DOMParser) : parseM3U8(text, item.url);
  } catch (err) {
    failure = String((err && err.message) || err);
  }

  box.textContent = '';
  if (!info || failure) {
    box.textContent = `Could not read the manifest: ${failure || 'unrecognised format'}`;
    return;
  }

  if (info.encrypted) {
    // Hard boundary: encrypted stream, no actions at all. Magpie does not
    // circumvent DRM and has no code path that could.
    const note = document.createElement('div');
    note.textContent =
      `DRM protected (${info.encryptionMethod}${info.drmSystems.length ? ` · ${info.drmSystems.join(', ')}` : ''})` +
      ' — not downloadable. Magpie will not attempt to decrypt it.';
    box.appendChild(note);
    if (item.status !== 'protected') {
      send({
        type: 'patch-item',
        normalizedUrl: item.normalizedUrl,
        patch: { status: 'protected', protectedReason: `Encrypted stream (${info.encryptionMethod})` },
      }).then(scheduleRefresh);
    }
    return;
  }

  const variants = info.variants.length ? info.variants : [{
    id: 'only', bandwidth: 0, resolution: '', codecs: '', url: item.url,
  }];

  const wrap = document.createElement('div');
  wrap.className = 'scroll-x';
  const table = document.createElement('table');
  table.className = 'variants';

  const head = document.createElement('tr');
  for (const column of VARIANT_COLUMNS) {
    const th = document.createElement('th');
    th.textContent = column.label;
    head.appendChild(th);
  }
  table.appendChild(head);

  let chosen = variants[0];
  variants.forEach((variant, index) => {
    const tr = document.createElement('tr');
    const pick = document.createElement('input');
    pick.type = 'radio';
    pick.name = 'variant';
    pick.checked = index === 0;
    pick.setAttribute('aria-label', `Select the ${variant.resolution || 'only'} variant`);
    pick.addEventListener('change', () => {
      chosen = variant;
      refreshCommands();
    });

    const values = {
      select: pick,
      resolution: variant.resolution || '—',
      bitrate: variant.bandwidth ? `${Math.round(variant.bandwidth / 1000)} kbps` : '—',
      codec: variant.codecs || '—',
      size: formatBytes(estimateBytes(variant.bandwidth, info.duration)),
    };

    for (const column of VARIANT_COLUMNS) {
      const td = document.createElement('td');
      td.dataset.field = column.field;
      // Cells that stack under the resolution carry their own label, so the
      // stylesheet reads it from the attribute rather than counting columns.
      if (column.inline) td.dataset.label = column.label;
      const cell = values[column.field];
      if (cell instanceof HTMLElement) td.appendChild(cell);
      else td.textContent = cell;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  });
  wrap.appendChild(table);
  box.appendChild(wrap);

  const meta = document.createElement('div');
  meta.className = 'dim';
  meta.textContent = [
    info.type.toUpperCase(),
    info.live ? 'live' : info.duration ? `${Math.round(info.duration)}s` : 'duration unknown',
    `${info.variants.length} variant(s)`,
    info.audioTracks.length ? `${info.audioTracks.length} audio track(s)` : '',
  ].filter(Boolean).join(' · ');
  box.appendChild(meta);

  const ytPre = document.createElement('pre');
  ytPre.className = 'command';
  const ffPre = document.createElement('pre');
  ffPre.className = 'command';

  function refreshCommands() {
    ytPre.textContent = ytDlpCommand({
      url: item.url,
      formatId: chosen && chosen.id ? String(chosen.id) : undefined,
      referer: state.pageUrl,
      userAgent: navigator.userAgent,
      // Only for session-gated streams: on a public URL this flag makes
      // yt-dlp read the browser keychain for nothing, and it can fail.
      cookiesFromBrowser: expiryInfo(item.url).expiring ? 'chrome' : undefined,
      output: `${sanitizeSegment(state.pageTitle || 'stream')}.%(ext)s`,
    });
    ffPre.textContent = ffmpegCommand({
      url: (chosen && chosen.url) || item.url,
      referer: state.pageUrl,
      userAgent: navigator.userAgent,
      output: `${sanitizeSegment(state.pageTitle || 'stream')}.mp4`,
    });
  }
  refreshCommands();

  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  actions.append(
    button('copy yt-dlp command', () => navigator.clipboard.writeText(ytPre.textContent)),
    button('copy ffmpeg command', () => navigator.clipboard.writeText(ffPre.textContent)),
    button('export segment list', () => exportSegments(item, info, chosen)),
  );

  box.append(ytPre, ffPre, actions);
}

async function exportSegments(item, info, chosen) {
  let segments = info.segments;
  if (!segments.length && chosen && chosen.url && chosen.url !== item.url) {
    try {
      const response = await fetch(chosen.url, { credentials: 'include' });
      segments = parseM3U8(await response.text(), chosen.url).segments;
    } catch {
      segments = [];
    }
  }
  const payload = {
    tool: 'magpie',
    manifest: item.url,
    page: state.pageUrl,
    type: info.type,
    duration: info.duration,
    variant: chosen ? { id: chosen.id, resolution: chosen.resolution, bandwidth: chosen.bandwidth } : null,
    segments,
  };
  saveBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    `magpie/${sanitizeSegment(hostLabel())}/segments-${Date.now()}.json`,
  );
}

/* ------------------------------------------------------------------ *
 * Downloads
 * ------------------------------------------------------------------ */

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, conflictAction: 'uniquify' }, () => {
    void chrome.runtime.lastError;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
}

/** Canvas and inline SVG have no fetchable URL: capture them from the page. */
async function downloadSynthetic(item, index, total) {
  const response = await toTab({ type: MSG.CAPTURE_CANVAS, elementId: item.elementId });
  if (!response.ok || !response.dataUrl) {
    setProgressText(`capture failed: ${response.reason || 'element is gone'}`);
    return false;
  }
  let blob;
  try {
    blob = await (await fetch(response.dataUrl)).blob();
  } catch {
    return false;
  }
  const filename = applyTemplate(el.template.value || DEFAULT_TEMPLATE, {
    ...tokensFor({ ...item, mimeType: blob.type }, {
      pageUrl: state.pageUrl, pageTitle: state.pageTitle, index, total,
    }),
    basename: item.synthetic === 'canvas' ? 'canvas' : 'inline-svg',
  });
  saveBlob(blob, filename);
  return true;
}

/** A data: image is already in hand: write it without the download queue. */
async function saveDataUrl(item, index, total) {
  let blob;
  try {
    blob = await (await fetch(item.url)).blob();
  } catch {
    return false; // a malformed data: URL is one failed file, not a failed batch
  }
  saveBlob(blob, applyTemplate(el.template.value || DEFAULT_TEMPLATE, tokensFor(
    { ...item, mimeType: blob.type || item.mimeType },
    { pageUrl: state.pageUrl, pageTitle: state.pageTitle, index, total },
  )));
  return true;
}

/** True when the imported capture holds this item's bytes. */
function hasHarBody(item) {
  return state.harBodies.has(item.normalizedUrl);
}

/** Write a file out of an imported HAR without touching the network. */
function saveFromHar(item, index, total) {
  const body = state.harBodies.get(item.normalizedUrl);
  if (!body) return false;
  const type = body.mimeType || item.mimeType || 'application/octet-stream';
  const blob = new Blob([body.bytes], { type });
  saveBlob(blob, applyTemplate(el.template.value || DEFAULT_TEMPLATE, tokensFor(
    { ...item, mimeType: type },
    { pageUrl: state.pageUrl, pageTitle: state.pageTitle, index, total },
  )));
  return true;
}

async function downloadItems(items) {
  const downloadable = items.filter(isDownloadable);
  if (!downloadable.length) return;
  state.localSaved = 0;

  // Anything already in hand — a canvas capture, or bytes from an imported
  // HAR — is written here; only what genuinely has to be fetched goes to the
  // background queue.
  const inHand = (i) => i.url.startsWith('magpie-') || i.url.startsWith('data:') || hasHarBody(i);
  const local = downloadable.filter(inHand);
  const network = downloadable.filter((i) => !local.includes(i));

  let index = 0;
  let fromHar = 0;
  let captured = 0;
  let failedLocal = 0;
  for (const item of local) {
    index += 1;
    let saved = false;
    if (hasHarBody(item)) saved = saveFromHar(item, index, downloadable.length);
    else if (item.url.startsWith('data:')) saved = await saveDataUrl(item, index, downloadable.length);
    else saved = await downloadSynthetic(item, index, downloadable.length);
    if (!saved) failedLocal += 1;
    else if (hasHarBody(item)) fromHar += 1;
    else captured += 1;
  }

  state.localSaved = fromHar + captured;
  if (!network.length) {
    const parts = [];
    if (fromHar) parts.push(`${fromHar} saved from the HAR, no network needed`);
    if (captured) parts.push(`${captured} captured from the page`);
    if (failedLocal) parts.push(`${failedLocal} could not be saved`);
    el.progress.hidden = false;
    setProgressText(parts.join(' · ') || 'nothing to save');
    return;
  }

  const response = await send({
    type: MSG.DOWNLOAD_ITEMS,
    ids: network.map((i) => i.id),
    template: el.template.value || DEFAULT_TEMPLATE,
    writeSidecar: Boolean(state.options.writeSidecar),
    groupLabel: state.seedId ? 'similar' : '',
  });
  if (response.ok) {
    state.sessionId = response.sessionId;
    el.progress.hidden = false;
    setProgressText(`${localPrefix()}queued ${response.total}${response.skipped ? `, skipped ${response.skipped}` : ''}`);
  } else {
    setProgressText(`could not start: ${response.reason || 'unknown error'}`);
    el.progress.hidden = false;
  }
}

function setProgressText(text) {
  el.progressText.textContent = text;
}

/**
 * Files saved without the network are not part of the background queue, so
 * every progress line has to carry them or it under-reports what happened.
 */
function localPrefix() {
  return state.localSaved ? `${state.localSaved} saved locally · ` : '';
}

/* ------------------------------------------------------------------ *
 * HAR import
 * ------------------------------------------------------------------ */

async function importHar(file) {
  if (!file) return;
  setProgressText(`reading ${file.name}…`);
  el.progress.hidden = false;
  try {
    const text = await file.text();
    const { items, bodies, skipped, bodyBytes, error } = parseHar(text);
    if (error) {
      setProgressText(`HAR import failed: ${error}`);
      return;
    }
    for (const [key, body] of bodies) state.harBodies.set(key, body);
    const response = await send({ type: MSG.IMPORT_HAR, items });
    const offline = bodies.size
      ? `, ${bodies.size} with bodies (${formatBytes(bodyBytes)}) saveable offline`
      : ', no response bodies in this capture — they will be re-fetched';
    setProgressText(
      `HAR: merged ${response.added || 0} new, ${response.updated || 0} updated, ${skipped} skipped${offline}`,
    );
    scheduleRefresh();
  } catch (err) {
    setProgressText(`HAR import failed: ${String((err && err.message) || err)}`);
  }
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

el.body.addEventListener('click', (event) => {
  const tile = event.target.closest('mg-item');
  if (tile && tile.item) {
    if (event.detail === 2) {
      showDetail(tile.item);
      return;
    }
    setSelected(tile.item.id, !tile.hasAttribute('selected'));
    updateSelectionUi();
    if (state.expandedId) showDetail(tile.item);
    return;
  }
});

el.body.addEventListener('keydown', (event) => {
  const tile = event.target.closest('mg-item');
  if (!tile || !tile.item) return;
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    setSelected(tile.item.id, !tile.hasAttribute('selected'));
    updateSelectionUi();
  } else if (event.key === 'i') {
    showDetail(tile.item);
  }
});

el.body.addEventListener('mg-group-toggle', (event) => {
  const node = event.target.closest('mg-group');
  if (!node) return;
  for (const tile of node.querySelectorAll('mg-item')) {
    if (tile.item) setSelected(tile.item.id, event.detail.checked);
  }
  updateSelectionUi();
});

for (const chip of document.querySelectorAll('.chip[data-kind]')) {
  chip.addEventListener('click', () => {
    const on = chip.getAttribute('aria-pressed') !== 'true';
    chip.setAttribute('aria-pressed', String(on));
    if (on) state.kinds.add(chip.dataset.kind);
    else state.kinds.delete(chip.dataset.kind);
    render();
  });
}

let searchTimer = null;
el.search.addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 150);
});

el.threshold.addEventListener('change', async () => {
  await send({ type: MSG.SET_OPTIONS, options: { threshold: el.threshold.value } });
  if (state.seedId) {
    const seed = findItem(state.seedId);
    if (seed) {
      await render();
      applySeed(seed);
      return;
    }
  }
  render();
});

for (const input of [el.minDim, el.minKb]) input.addEventListener('change', render);
el.confirmedOnly.addEventListener('change', render);
el.includeHistory.addEventListener('change', () => refresh());

el.rescan.addEventListener('click', async () => {
  const response = await toTab({ type: MSG.SCAN_NOW });
  // A tab opened before Magpie was installed has no content script until it
  // is reloaded; say so instead of showing an empty list forever.
  state.notice = response.ok ? '' : 'Magpie is not running in this tab yet - reload the page, then rescan';
  scheduleRefresh();
});

el.upgradeAll.addEventListener('click', async () => {
  el.upgradeAll.disabled = true;
  el.progress.hidden = false;
  setProgressText('probing for higher-resolution originals…');
  const target = state.selected.size ? [...state.selected] : filtered().map((i) => i.id);
  const response = await send({ type: MSG.VERIFY_UPGRADES, ids: target });
  setProgressText(
    response.ok
      ? `checked ${response.checked}, found ${response.upgraded} higher-resolution original(s)`
      : 'upgrade probe failed',
  );
  el.upgradeAll.disabled = false;
  refresh();
});

el.template.addEventListener('change', () => {
  send({ type: MSG.SET_OPTIONS, options: { filenameTemplate: el.template.value } });
  if (state.expandedId) showDetail(findItem(state.expandedId));
});

function renderCrawlStatus(status) {
  state.crawling = Boolean(status && status.running);
  el.explore.textContent = state.crawling ? 'stop exploring' : 'explore';
  el.explore.setAttribute('aria-pressed', String(state.crawling));
  if (!status) return;
  el.progress.hidden = false;
  const where = status.currentUrl ? ` · ${status.currentUrl.replace(/^https?:\/\//, '').slice(0, 40)}` : '';
  setProgressText(
    state.crawling
      ? `exploring: page ${status.pages + 1}/${status.limit}, ${status.queued} queued, ${status.clicks} clicks${where}`
      : `exploring finished: ${status.pages} page(s), ${status.clicks} clicks${status.note ? ` — ${status.note}` : ''}`,
  );
}

el.explore.addEventListener('click', async () => {
  const response = await send({ type: state.crawling ? 'explore-stop' : 'explore-start' });
  if (!response.ok) {
    el.progress.hidden = false;
    setProgressText(`could not start exploring: ${response.reason || 'unknown'}`);
    return;
  }
  renderCrawlStatus(response.status);
});

el.clear.addEventListener('click', clearSelection);
el.download.addEventListener('click', () => downloadItems(selectedItems()));
el.stop.addEventListener('click', () => send({ type: MSG.STOP_DOWNLOADS, sessionId: state.sessionId }));

el.dropzone.addEventListener('click', () => el.harInput.click());
el.harInput.addEventListener('change', () => importHar(el.harInput.files[0]));
for (const type of ['dragenter', 'dragover']) {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.remove('over');
  });
}
el.dropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer && event.dataTransfer.files[0];
  if (file) importHar(file);
});

/* Keyboard shortcuts, per spec §8. */
document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName);
  if (event.key === 'Escape') {
    if (state.expandedId) showDetail(null);
    else clearSelection();
    return;
  }
  if (typing) return;
  if (event.key === '/') {
    event.preventDefault();
    el.search.focus();
    el.search.select();
  } else if (event.key === 'a') {
    const node = (document.activeElement && document.activeElement.closest('mg-group')) ||
      el.body.querySelector('mg-group');
    if (!node) return;
    event.preventDefault();
    const tiles = [...node.querySelectorAll('mg-item')];
    const allOn = tiles.every((t) => t.hasAttribute('selected'));
    for (const tile of tiles) if (tile.item) setSelected(tile.item.id, !allOn);
    updateSelectionUi();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    downloadItems(selectedItems());
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'explore-progress') {
    if (message.tabId === state.tabId) renderCrawlStatus(message.status);
    return;
  }
  if (message.type === MSG.STATE_UPDATE) {
    if (message.tabId === state.tabId) scheduleRefresh();
  } else if (message.type === MSG.DOWNLOAD_PROGRESS) {
    const p = message.progress;
    if (!p || p.tabId !== state.tabId) return;
    el.progress.hidden = false;
    const pct = p.total ? Math.round(((p.done + p.failed) / p.total) * 100) : 0;
    el.progressFill.style.width = `${pct}%`;
    setProgressText(
      `${localPrefix()}${p.done}/${p.total} fetched${p.failed ? `, ${p.failed} failed` : ''}` +
      `${p.stopped ? ' (stopped)' : p.finished ? ' — done' : ''}`,
    );
    if (p.finished && p.sidecar) {
      saveBlob(
        new Blob([JSON.stringify(p.sidecar, null, 2)], { type: 'application/json' }),
        `magpie/${sanitizeSegment(hostLabel())}/manifest-${Date.now()}.json`,
      );
    }
    if (p.errors && p.errors.length && p.finished) {
      const first = p.errors[0];
      setProgressText(`${localPrefix()}${p.done}/${p.total} fetched, ${p.failed} failed — e.g. ${first.error}`);
    }
  }
});

chrome.tabs.onActivated.addListener(async () => {
  const next = await resolveTabId();
  if (next === state.tabId) return;
  state.tabId = next;
  state.notice = '';
  clearSelection();
  showDetail(null);
  refresh({ consumeSeed: true });
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

(async function boot() {
  state.tabId = await resolveTabId();
  el.template.value = DEFAULT_TEMPLATE;
  await refresh({ consumeSeed: true });
  // A crawl outlives the panel, so pick up one that is already running.
  const crawl = await send({ type: 'explore-status' });
  if (crawl.ok && crawl.status) renderCrawlStatus(crawl.status);
  // A seed arriving from the context menu should be visible immediately.
  if (state.seedId) {
    const tile = document.getElementById(`item-${state.seedId}`);
    if (tile) tile.scrollIntoView({ block: 'center' });
  }
})();
