/**
 * Right-click entry points. The two-click path — right-click an image,
 * "Download all similar" — must work without ever opening the panel.
 */

import { getTab, itemsOf, findItem, getOptions } from './store.js';
import { normalizeUrl } from '../core/url-normalize.js';
import { selectSimilar, describeGroup } from '../core/similarity.js';
import { SIMILARITY_PRESETS } from '../core/media-types.js';
import { startSession } from './downloader.js';
import { STATUS } from '../shared/messages.js';
import { log, warn } from '../shared/debug.js';

export const MENU = {
  DOWNLOAD_ONE: 'magpie-download-one',
  DOWNLOAD_SIMILAR: 'magpie-download-similar',
  OPEN_WITH_SELECTION: 'magpie-open-with-selection',
  OPEN_PANEL: 'magpie-open-panel',
};

const MEDIA_CONTEXTS = ['image', 'video', 'audio'];

export function createMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: MENU.DOWNLOAD_ONE,
      title: 'Download this',
      contexts: MEDIA_CONTEXTS,
    });
    chrome.contextMenus.create({
      id: MENU.DOWNLOAD_SIMILAR,
      title: 'Download all similar on this page',
      contexts: MEDIA_CONTEXTS,
    });
    chrome.contextMenus.create({
      id: MENU.OPEN_WITH_SELECTION,
      title: 'Open Magpie panel with this selected',
      contexts: MEDIA_CONTEXTS,
    });
    chrome.contextMenus.create({
      id: MENU.OPEN_PANEL,
      title: 'Open Magpie panel',
      contexts: ['page', 'frame', 'selection', 'link'],
    });
    log('context menus created');
  });
}

function notify(title, message) {
  if (!chrome.notifications) return;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title,
    message,
  }, () => void chrome.runtime.lastError);
}

/** The clicked media element, resolved against the index. */
async function seedFor(info, tabId) {
  const state = await getTab(tabId);
  const src = info.srcUrl || info.linkUrl || '';
  if (!src) return { state, seed: null };
  const normalized = normalizeUrl(src, state.pageUrl || undefined);
  const seed =
    findItem(state, normalized) ||
    findItem(state, src) ||
    // The DOM scan may not have reached this element yet; synthesise enough
    // of a candidate that the URL terms of the score still work.
    {
      id: 'seed',
      url: src,
      normalizedUrl: normalized,
      kind: info.mediaType || 'image',
      mimeType: '',
      width: 0,
      height: 0,
      status: STATUS.REFERENCED,
      structuralPath: [],
      sources: [],
    };
  return { state, seed };
}

/**
 * @param {object} deps {openPanel(tabId, seedId), refreshPanel(tabId)}
 */
export function installMenuHandlers(deps) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab || tab.id == null) return;
    const tabId = tab.id;
    try {
      switch (info.menuItemId) {
        case MENU.OPEN_PANEL:
          await deps.openPanel(tabId, null);
          break;

        case MENU.OPEN_WITH_SELECTION: {
          const { seed } = await seedFor(info, tabId);
          await deps.openPanel(tabId, seed ? seed.normalizedUrl : null);
          break;
        }

        case MENU.DOWNLOAD_ONE: {
          const { state, seed } = await seedFor(info, tabId);
          if (!seed) return;
          if (seed.status === STATUS.PROTECTED) {
            notify('Magpie', 'DRM protected — not downloadable.');
            return;
          }
          const options = await getOptions();
          startSession({
            tabId,
            items: [seed],
            template: options.filenameTemplate,
            concurrency: 1,
            context: { pageUrl: state.pageUrl, pageTitle: state.pageTitle, groupLabel: 'single' },
            writeSidecar: false,
          });
          notify('Magpie', 'Downloading 1 item.');
          break;
        }

        case MENU.DOWNLOAD_SIMILAR: {
          const { state, seed } = await seedFor(info, tabId);
          if (!seed) return;
          const options = await getOptions();
          const threshold = SIMILARITY_PRESETS[options.threshold] || SIMILARITY_PRESETS.balanced;
          const pool = itemsOf(state).filter((i) => i.status !== STATUS.PROTECTED && i.kind !== 'stream');
          const matches = selectSimilar(seed, pool, threshold).map((m) => m.item);
          const items = matches.length ? matches : [seed];
          const summary = describeGroup(items);

          const { total, skipped, expiringSoon } = startSession({
            tabId,
            items,
            template: options.filenameTemplate,
            concurrency: options.concurrency,
            context: {
              pageUrl: state.pageUrl,
              pageTitle: state.pageTitle,
              groupLabel: 'similar',
            },
            writeSidecar: false,
          });

          const parts = [`Downloading ${total} of ${items.length} similar items.`];
          if (skipped) parts.push(`${skipped} skipped (protected or stream).`);
          if (expiringSoon) parts.push(`${expiringSoon} have expiring URLs — queued first.`);
          notify('Magpie', `${summary.label}\n${parts.join(' ')}`);
          deps.refreshPanel(tabId);
          break;
        }

        default:
          break;
      }
    } catch (err) {
      warn('context menu action failed', err);
      notify('Magpie', 'That action failed. Open the panel for details.');
    }
  });
}
