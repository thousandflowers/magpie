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
  /** Draw the current selection in the page, in one of the picker's modes. */
  SHOW_SELECTION: 'show-selection',
  /** Light the matches in place for a beat before the palette takes them. */
  FLASH_MATCHES: 'flash-matches',
  CAPTURE_CANVAS: 'capture-canvas',
  HIGHLIGHT_ITEM: 'highlight-item',

  /* page -> panel */
  PAGE_PICK: 'page-pick',

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
/**
 * A data: image is its own bytes, so it cannot be cut to MAX_STR without
 * becoming a corrupt file. One that would not fit the session-storage index
 * is dropped instead - truncating it silently is the one wrong answer.
 */
export const MAX_DATA_URL = 1024 * 1024;
// Measured on a 414-item category page: the path was 35% of an item's weight
// and the class counts 21%, at 2.2 KB per item. The engine reads at most the
// cell, its grid and their ancestors; sixteen levels and eight classes a node
// cover that with room to spare.
const MAX_PATH_NODES = 16;
const MAX_CLASSES = 8;
const MAX_COUNT_KEYS = 32;

function str(v, max = MAX_STR) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/**
 * Schemes a media URL may use. Every URL that survives here can reach
 * `img.src`, a `fetch` with credentials, or `chrome.downloads.download`, and
 * candidates arrive from a page: the MAIN-world bridge's token is a namespace
 * shipped in the CRX, not a secret, so any script on the page can post one. A
 * scheme that is not a way of fetching bytes has no business in the index.
 */
const FETCHABLE = /^(?:https?|data|blob):/i;

/**
 * The scanner's own placeholders for media that has no URL of its own - a
 * painted `<canvas>`, an inline `<svg>`. They name an element, are never
 * fetched, and the panel asks the content script for the bytes instead.
 */
const SYNTHETIC = /^magpie-(?:canvas|svg):/i;

/** @param {string} url @returns {string} the URL, or '' when it is not fetchable. */
function fetchableUrl(url) {
  return FETCHABLE.test(url) || SYNTHETIC.test(url) ? url : '';
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
  const isData = typeof raw.url === 'string' && raw.url.startsWith('data:');
  if (isData && raw.url.length > MAX_DATA_URL) return null;
  const url = fetchableUrl(isData ? raw.url : str(raw.url));
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
    harBody: bool(raw.harBody),
    repeatDepth: Number.isInteger(raw.repeatDepth) && raw.repeatDepth >= 0 ? raw.repeatDepth : -1,
    classCounts,
    upgradeUrl: fetchableUrl(str(raw.upgradeUrl)),
    upgradeNote: str(raw.upgradeNote, 128),
    frameUrl: str(raw.frameUrl),
    frameOrigin: str(raw.frameOrigin, 256),
    pageUrl: str(raw.pageUrl),
    alt: str(raw.alt, 256),
    poster: bool(raw.poster),
    protectedReason: str(raw.protectedReason, 128),
    synthetic: str(raw.synthetic, 16),
    previewUrl: fetchableUrl(str(raw.previewUrl)),
    origin: str(raw.origin, 64),
    timestamp: num(raw.timestamp),
  };
}

/*
 * There used to be a `sanitizeBridgeMessage` here: the whole-message validator
 * for the MAIN-world bridge, exported and imported by nobody. A content script
 * is a classic script and cannot import a module, so isolated.js rebuilds each
 * candidate inline instead - which meant the repository looked like it
 * validated bridge messages in one place and did not. Removed rather than
 * left as a decoy; the real check is `sanitizeCandidate` above, which the
 * background applies to everything the bridge forwards.
 */

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
