/**
 * The message contract. Every cross-context payload shape is declared here
 * and validated on receipt, because the MAIN world runs alongside page code
 * that can post anything it likes.
 */

/** Namespaced token for window.postMessage traffic between MAIN and ISOLATED. */
export const BRIDGE_TOKEN = 'magpie:bridge:v1';

export const MSG = {
  /* content -> background */
  DOM_CANDIDATES: 'dom-candidates',
  MAIN_CANDIDATES: 'main-candidates',
  PAGE_RESET: 'page-reset',
  PAGE_INFO: 'page-info',
  MSE_DETECTED: 'mse-detected',
  EME_DETECTED: 'eme-detected',

  /* panel/menu -> background */
  GET_STATE: 'get-state',
  SET_OPTIONS: 'set-options',
  DOWNLOAD_ITEMS: 'download-items',
  STOP_DOWNLOADS: 'stop-downloads',
  IMPORT_HAR: 'import-har',
  RESOLVE_STREAM: 'resolve-stream',
  VERIFY_UPGRADES: 'verify-upgrades',
  CLEAR_TAB: 'clear-tab',
  OPEN_PANEL: 'open-panel',

  /* background -> content */
  SCAN_NOW: 'scan-now',
  CAPTURE_CANVAS: 'capture-canvas',
  HIGHLIGHT_ITEM: 'highlight-item',

  /* background -> panel */
  STATE_UPDATE: 'state-update',
  DOWNLOAD_PROGRESS: 'download-progress',
};

export const SOURCE = {
  DOM: 'dom',
  NET: 'net',
  MAIN: 'main',
  HAR: 'har',
};

export const STATUS = {
  CONFIRMED: 'confirmed',   // seen in the DOM *and* really fetched
  BACKGROUND: 'background', // fetched, never found on screen
  REFERENCED: 'referenced', // in the DOM, not fetched yet (lazy)
  PROTECTED: 'protected',   // DRM — download controls disabled
  UNAVAILABLE: 'unavailable', // tainted canvas, cross-origin blob, ...
};

/** Rank used for sorting: confirmed items come first. */
export const STATUS_RANK = {
  [STATUS.CONFIRMED]: 0,
  [STATUS.BACKGROUND]: 1,
  [STATUS.REFERENCED]: 2,
  [STATUS.PROTECTED]: 3,
  [STATUS.UNAVAILABLE]: 4,
};

const MAX_STR = 4096;
const MAX_ITEMS = 2000;
const MAX_PATH_NODES = 40;
const MAX_CLASSES = 12;
const MAX_COUNT_KEYS = 64;

function str(v, max = MAX_STR) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function bool(v) {
  return v === true;
}

/**
 * Coerce an untrusted candidate into the shape the rest of the extension
 * relies on. Returns null when there is no usable URL.
 * @param {unknown} raw
 */
export function sanitizeCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = str(raw.url);
  if (!url) return null;

  const path = Array.isArray(raw.structuralPath)
    ? raw.structuralPath.slice(0, MAX_PATH_NODES).map((n) => ({
        tag: str(n && n.tag, 32).toLowerCase(),
        classes: Array.isArray(n && n.classes)
          ? n.classes.slice(0, MAX_CLASSES).map((c) => str(c, 64))
          : [],
      }))
    : [];

  const classCounts = {};
  if (raw.classCounts && typeof raw.classCounts === 'object') {
    let keys = 0;
    for (const [name, count] of Object.entries(raw.classCounts)) {
      if (keys >= MAX_COUNT_KEYS) break;
      const n = Number(count);
      if (!Number.isFinite(n) || n < 0) continue;
      classCounts[str(name, 64)] = Math.min(n, 1e6);
      keys += 1;
    }
  }

  return {
    url,
    mimeType: str(raw.mimeType, 128),
    kind: str(raw.kind, 16),
    width: num(raw.width),
    height: num(raw.height),
    renderedWidth: num(raw.renderedWidth),
    renderedHeight: num(raw.renderedHeight),
    bytes: raw.bytes == null ? null : num(raw.bytes),
    source: str(raw.source, 16) || SOURCE.DOM,
    status: str(raw.status, 16) || STATUS.REFERENCED,
    elementId: str(raw.elementId, 64),
    structuralPath: path,
    inRepeatedGroup: bool(raw.inRepeatedGroup),
    repeatDepth: Number.isInteger(raw.repeatDepth) && raw.repeatDepth >= 0 ? raw.repeatDepth : -1,
    classCounts,
    upgradeUrl: str(raw.upgradeUrl),
    upgradeNote: str(raw.upgradeNote, 128),
    frameUrl: str(raw.frameUrl),
    frameOrigin: str(raw.frameOrigin, 256),
    pageUrl: str(raw.pageUrl),
    alt: str(raw.alt, 256),
    poster: bool(raw.poster),
    protectedReason: str(raw.protectedReason, 128),
    origin: str(raw.origin, 64),
    timestamp: num(raw.timestamp),
  };
}

/**
 * Validate a whole bridge message from the MAIN world.
 * @param {unknown} data
 * @returns {{type: string, items: object[]}|null}
 */
export function sanitizeBridgeMessage(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.token !== BRIDGE_TOKEN) return null;
  const type = str(data.type, 64);
  if (!type) return null;
  const rawItems = Array.isArray(data.items) ? data.items.slice(0, MAX_ITEMS) : [];
  const items = [];
  for (const raw of rawItems) {
    const c = sanitizeCandidate(raw);
    if (c) items.push(c);
  }
  return { type, items, detail: str(data.detail, 256) };
}

/** Promise wrapper that never rejects when the receiver is gone. */
export function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        void chrome.runtime.lastError;
        resolve(response);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** Same, aimed at a tab (and optionally one frame). */
export function sendToTab(tabId, message, frameId) {
  return new Promise((resolve) => {
    try {
      const options = frameId === undefined ? {} : { frameId };
      chrome.tabs.sendMessage(tabId, message, options, (response) => {
        void chrome.runtime.lastError;
        resolve(response);
      });
    } catch {
      resolve(undefined);
    }
  });
}
