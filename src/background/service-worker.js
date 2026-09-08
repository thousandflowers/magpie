/**
 * MV3 service worker — entry point and message router.
 *
 * Everything user-visible is driven from here, but no state lives here:
 * the worker can be killed at any moment, so the store is the authority and
 * this file only wires events together.
 */

import {
  getTab, addCandidates, resetTab, setPageInfo, deleteTab, itemsOf,
  findItem, getOptions, setOptions, flushAll, pruneClosedTabs, updateItem, patchTab, serialize,
} from './store.js';
import { installNetObserver, flushNow } from './net-observer.js';
import {
  installDownloadListeners, startSession, stopSession, stopAll, onProgress, reapSessions,
} from './downloader.js';
import { createMenus, installMenuHandlers } from './context-menus.js';
import { verifyBatch, loadSiteRules } from './upgrade-verify.js';
import {
  EXPLORE_MSG, startCrawl, stopCrawl, judgeCandidates, acceptLinks,
  pageFinished, resumeAfterNavigation, crawlStatus, isCrawling, clearCrawl,
  onExploreProgress,
} from './explorer.js';
import { MSG, SOURCE, STATUS, sanitizeCandidate } from '../shared/messages.js';
import { log, warn, error } from '../shared/debug.js';

const PANEL_URL = 'src/panel/panel.html';
const SEED_KEY = 'panel-seed';

/* ------------------------------------------------------------------ *
 * Panel plumbing
 * ------------------------------------------------------------------ */

async function rememberSeed(tabId, normalizedUrl) {
  try {
    const stored = await chrome.storage.session.get(SEED_KEY);
    const seeds = stored[SEED_KEY] || {};
    if (normalizedUrl) seeds[tabId] = normalizedUrl;
    else delete seeds[tabId];
    await chrome.storage.session.set({ [SEED_KEY]: seeds });
  } catch (err) {
    warn('seed write failed', err);
  }
}

async function takeSeed(tabId) {
  try {
    const stored = await chrome.storage.session.get(SEED_KEY);
    const seeds = stored[SEED_KEY] || {};
    const seed = seeds[tabId] || null;
    if (seed) {
      delete seeds[tabId];
      await chrome.storage.session.set({ [SEED_KEY]: seeds });
    }
    return seed;
  } catch {
    return null;
  }
}

/**
 * Side panel where available, a popup window everywhere else.
 * Must be called from a user gesture.
 */
async function openPanel(tabId, seedNormalizedUrl) {
  await rememberSeed(tabId, seedNormalizedUrl);
  if (chrome.sidePanel && chrome.sidePanel.open) {
    try {
      await chrome.sidePanel.setOptions({
        tabId,
        path: PANEL_URL,
        enabled: true,
      });
      await chrome.sidePanel.open({ tabId });
      return;
    } catch (err) {
      warn('sidePanel unavailable, falling back to a window', err);
    }
  }
  await chrome.windows.create({
    url: chrome.runtime.getURL(`${PANEL_URL}?tabId=${tabId}`),
    type: 'popup',
    width: 480,
    height: 900,
  });
}

/** Nudge an open panel to re-read the index. Harmless when none is open. */
function refreshPanel(tabId, extra) {
  chrome.runtime.sendMessage(
    { type: MSG.STATE_UPDATE, tabId, ...(extra || {}) },
    () => void chrome.runtime.lastError,
  );
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

function bootstrap() {
  installNetObserver((tabId, result) => {
    if (result.added) refreshPanel(tabId);
  });
  installDownloadListeners();
  installMenuHandlers({ openPanel, refreshPanel });
  onProgress((progress) => {
    chrome.runtime.sendMessage(
      { type: MSG.DOWNLOAD_PROGRESS, progress },
      () => void chrome.runtime.lastError,
    );
    if (progress.finished) reapSessions();
  });
  onExploreProgress((tabId) => {
    crawlStatus(tabId).then((status) => {
      chrome.runtime.sendMessage(
        { type: EXPLORE_MSG.PROGRESS, tabId, status },
        () => void chrome.runtime.lastError,
      );
    });
  });
  loadSiteRules();
}

bootstrap();

chrome.runtime.onInstalled.addListener(() => {
  createMenus();
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {});
  }
  log('installed');
});

chrome.runtime.onStartup.addListener(() => {
  createMenus();
  pruneClosedTabs();
});

// The action opens the side panel directly via setPanelBehavior; this
// listener is the fallback path for browsers without chrome.sidePanel.
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    if (tab && tab.id != null) openPanel(tab.id, null);
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  deleteTab(tabId);
  clearCrawl(tabId);
});

/**
 * A navigation, seen from the browser side. This fires before the new
 * document issues its first subresource request, and it reaches the worker in
 * the same queue as the webRequest events, so the reset always lands before
 * the network batch it must not wipe. The page's own document_start message
 * travels through the renderer instead and can arrive after that batch - it
 * did, and took the first dozen items with it.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;
  serialize(tabId, async () => {
    if (await isCrawling(tabId)) return; // a crawl keeps its index across pages
    const options = await getOptions();
    await resetTab(tabId, {
      url: changeInfo.url || (tab && tab.url) || '',
      keepHistory: options.keepSessionHistory,
    });
    refreshPanel(tabId);
  });
});

if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    flushNow();
    flushAll();
  });
}

/* ------------------------------------------------------------------ *
 * Message router
 * ------------------------------------------------------------------ */

/** Resolve the tab a message is about: explicit id, or the sender's tab. */
function tabIdFor(message, sender) {
  if (Number.isInteger(message.tabId)) return message.tabId;
  if (sender && sender.tab && Number.isInteger(sender.tab.id)) return sender.tab.id;
  return null;
}

const handlers = {
  async [MSG.PAGE_INFO](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    if (sender && sender.frameId) return { ok: true }; // only the top document names the page
    // The index itself is reset from chrome.tabs.onUpdated (see below); this
    // message only names the page and, during a crawl, resumes the walk.
    await setPageInfo(tabId, { url: message.url, title: message.title });
    refreshPanel(tabId);
    if (message.navigation && (await isCrawling(tabId))) await resumeAfterNavigation(tabId);
    return { ok: true };
  },

  async [MSG.PAGE_RESET](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    if (sender && sender.frameId) return { ok: true };
    const options = await getOptions();
    await resetTab(tabId, { url: message.url, keepHistory: options.keepSessionHistory });
    refreshPanel(tabId);
    return { ok: true };
  },

  async [MSG.DOM_CANDIDATES](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    const items = (message.items || []).map(sanitizeCandidate).filter(Boolean);
    for (const item of items) {
      item.source = SOURCE.DOM;
      if (!item.status) item.status = STATUS.REFERENCED;
      if (sender && sender.frameId) {
        item.frameOrigin = item.frameOrigin || (sender.url ? new URL(sender.url).origin : '');
      }
    }
    const result = await addCandidates(tabId, items);
    if (result.added || result.updated) refreshPanel(tabId);
    return { ok: true, ...result };
  },

  async [MSG.MAIN_CANDIDATES](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    const items = (message.items || []).map(sanitizeCandidate).filter(Boolean);
    for (const item of items) {
      item.source = SOURCE.MAIN;
      item.status = item.status || STATUS.BACKGROUND;
    }
    const result = await addCandidates(tabId, items);
    if (result.added) refreshPanel(tabId);
    return { ok: true, ...result };
  },

  async [MSG.MSE_DETECTED](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    await patchTab(tabId, { usesMse: true });
    refreshPanel(tabId);
    return { ok: true };
  },

  async [MSG.EME_DETECTED](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    const state = await getTab(tabId);
    // Any media on a page that asked for a key system is treated as protected
    // until proven otherwise. Downloads stay disabled for those items.
    for (const key of state.order) {
      const item = state.items[key];
      if (!item) continue;
      if (item.kind === 'video' || item.kind === 'audio' || item.kind === 'stream') {
        item.status = STATUS.PROTECTED;
        item.protectedReason = message.detail || 'Encrypted Media Extensions in use';
      }
    }
    await patchTab(tabId, { emeRequested: true });
    refreshPanel(tabId);
    return { ok: true };
  },

  async [MSG.GET_STATE](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false, items: [] };
    const state = await getTab(tabId);
    const options = await getOptions();
    const seed = message.consumeSeed ? await takeSeed(tabId) : null;
    return {
      ok: true,
      tabId,
      pageUrl: state.pageUrl,
      pageTitle: state.pageTitle,
      usesMse: state.usesMse,
      emeRequested: state.emeRequested,
      truncated: state.truncated,
      historyCount: (state.history || []).length,
      items: itemsOf(state, { includeHistory: Boolean(message.includeHistory) }),
      options,
      seed,
    };
  },

  async [MSG.SET_OPTIONS](message) {
    const options = await setOptions(message.options || {});
    return { ok: true, options };
  },

  async [MSG.CLEAR_TAB](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    await resetTab(tabId, { keepHistory: false });
    refreshPanel(tabId);
    return { ok: true };
  },

  async [MSG.IMPORT_HAR](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    const items = (message.items || []).map(sanitizeCandidate).filter(Boolean);
    for (const item of items) item.source = SOURCE.HAR;
    const result = await addCandidates(tabId, items);
    refreshPanel(tabId);
    return { ok: true, ...result };
  },

  async [MSG.VERIFY_UPGRADES](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    const state = await getTab(tabId);
    const ids = Array.isArray(message.ids) ? new Set(message.ids) : null;
    const pool = itemsOf(state).filter((i) => (ids ? ids.has(i.id) : true));
    const result = await verifyBatch(tabId, pool);
    refreshPanel(tabId);
    return { ok: true, ...result };
  },

  async [MSG.DOWNLOAD_ITEMS](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    const state = await getTab(tabId);
    const options = await getOptions();
    const items = (message.ids || [])
      .map((id) => findItem(state, id))
      .filter(Boolean);
    if (!items.length) return { ok: false, reason: 'nothing selected' };

    const result = startSession({
      tabId,
      items,
      template: message.template || options.filenameTemplate,
      concurrency: message.concurrency || options.concurrency,
      context: {
        pageUrl: state.pageUrl,
        pageTitle: state.pageTitle,
        groupLabel: message.groupLabel || '',
      },
      useUpgrades: message.useUpgrades !== false,
      writeSidecar: message.writeSidecar === true,
    });
    return { ok: true, ...result };
  },

  async [MSG.STOP_DOWNLOADS](message) {
    if (message.sessionId) stopSession(message.sessionId);
    else stopAll();
    return { ok: true };
  },

  async [MSG.OPEN_PANEL](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    await openPanel(tabId, message.seed || null);
    return { ok: true };
  },

  async [EXPLORE_MSG.START](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    const state = await getTab(tabId);
    if (!state.pageUrl) return { ok: false, reason: 'no page to explore yet' };
    const crawl = await startCrawl(tabId, state.pageUrl);
    return { ok: true, status: await crawlStatus(tabId), started: Boolean(crawl) };
  },

  async [EXPLORE_MSG.STOP](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    await stopCrawl(tabId, 'stopped by you');
    return { ok: true, status: await crawlStatus(tabId) };
  },

  async [EXPLORE_MSG.JUDGE](message) {
    // The content script has no judgement of its own; this is where the tested
    // policy is applied.
    return { ok: true, ...judgeCandidates(message.candidates) };
  },

  async [EXPLORE_MSG.LINKS](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    return { ok: true, ...(await acceptLinks(tabId, message.links, message.pageUrl)) };
  },

  async [EXPLORE_MSG.PAGE_DONE](message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    await pageFinished(tabId, message);
    return { ok: true };
  },

  async 'explore-status'(message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    return { ok: true, status: await crawlStatus(tabId) };
  },

  async 'patch-item'(message, sender) {
    const tabId = tabIdFor(message, sender);
    if (tabId == null) return { ok: false };
    const item = await updateItem(tabId, message.normalizedUrl, message.patch || {});
    return { ok: Boolean(item), item };
  },
};

/**
 * Messages a page sends about itself are applied in the order they were sent,
 * through the store's per-tab chain (which the network observer shares).
 * Without this, the document_start PAGE_INFO (which resets the index) and the
 * DOMContentLoaded one (which carries the title and is followed by the first
 * DOM candidates) race through their awaits, and the reset can land last -
 * wiping the title and everything found so far.
 */
const ORDERED = new Set([
  MSG.PAGE_INFO, MSG.PAGE_RESET, MSG.DOM_CANDIDATES, MSG.MAIN_CANDIDATES,
  MSG.MSE_DETECTED, MSG.EME_DETECTED, MSG.IMPORT_HAR, MSG.CLEAR_TAB,
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  const handler = handlers[message.type];
  if (!handler) return false;
  const tabId = tabIdFor(message, sender);
  const run = () => handler(message, sender);
  (ORDERED.has(message.type) && tabId != null ? serialize(tabId, run) : run())
    .then(sendResponse)
    .catch((err) => {
      error('handler failed', message.type, err);
      sendResponse({ ok: false, reason: String((err && err.message) || err) });
    });
  return true; // keep the channel open for the async response
});
