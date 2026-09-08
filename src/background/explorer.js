/**
 * The explorer's head: decides, queues and drives.
 *
 * The content script has no judgement of its own — it ships element
 * descriptions here and this module answers with `src/core/explore-policy.js`,
 * the tested rules. Crawl state lives in chrome.storage.session so an MV3
 * worker restart mid-crawl does not lose the queue.
 *
 * Nothing starts on its own: a crawl exists only after an explicit click.
 */

import {
  shouldClick, shouldFollow, crawlKey, EXPLORE_LIMITS,
} from '../core/explore-policy.js';
import { sendToTab } from '../shared/messages.js';
import { log, warn } from '../shared/debug.js';

const KEY = (tabId) => `crawl:${tabId}`;

export const EXPLORE_MSG = {
  START: 'explore-start',
  STOP: 'explore-stop',
  PAGE: 'explore-page',
  JUDGE: 'explore-judge',
  LINKS: 'explore-links',
  PAGE_DONE: 'explore-page-done',
  PROGRESS: 'explore-progress',
};

let notify = () => {};

export function onExploreProgress(fn) {
  notify = fn;
}

async function readCrawl(tabId) {
  try {
    const stored = await chrome.storage.session.get(KEY(tabId));
    return stored[KEY(tabId)] || null;
  } catch {
    return null;
  }
}

async function writeCrawl(tabId, crawl) {
  try {
    if (crawl) await chrome.storage.session.set({ [KEY(tabId)]: crawl });
    else await chrome.storage.session.remove(KEY(tabId));
  } catch (err) {
    warn('crawl write failed', err);
  }
  notify(tabId, crawl);
}

/** True while a crawl owns this tab — the index must not be reset on navigation. */
export async function isCrawling(tabId) {
  const crawl = await readCrawl(tabId);
  return Boolean(crawl && crawl.running);
}

export async function startCrawl(tabId, startUrl) {
  const key = crawlKey(startUrl, startUrl);
  const crawl = {
    tabId,
    running: true,
    startedAt: Date.now(),
    startUrl: key,
    queue: [],
    visited: [key],
    pages: 0,
    clicks: 0,
    stopped: false,
    currentUrl: key,
    note: '',
  };
  await writeCrawl(tabId, crawl);
  log('crawl started on', key);
  await sendToTab(tabId, { type: EXPLORE_MSG.PAGE, limits: EXPLORE_LIMITS });
  return crawl;
}

export async function stopCrawl(tabId, note) {
  const crawl = await readCrawl(tabId);
  if (!crawl) return null;
  crawl.running = false;
  crawl.stopped = true;
  if (note) crawl.note = note;
  await writeCrawl(tabId, crawl);
  await sendToTab(tabId, { type: EXPLORE_MSG.STOP });
  log('crawl stopped on tab', tabId, note || '');
  return crawl;
}

/**
 * Answer the content script: which of these may it click?
 * @returns {{click: number[], refused: number}}
 */
export function judgeCandidates(candidates) {
  const click = [];
  let refused = 0;
  const list = Array.isArray(candidates) ? candidates.slice(0, 200) : [];
  list.forEach((description, index) => {
    const verdict = shouldClick(description);
    if (verdict.click) click.push(index);
    else refused += 1;
  });
  return { click, refused };
}

/** Queue the same-origin links a page offered. */
export async function acceptLinks(tabId, links, pageUrl) {
  const crawl = await readCrawl(tabId);
  if (!crawl || !crawl.running) return { queued: 0 };
  const visited = new Set(crawl.visited);
  const queued = new Set(crawl.queue);
  let added = 0;

  for (const link of Array.isArray(links) ? links.slice(0, 500) : []) {
    if (crawl.visited.length + crawl.queue.length >= EXPLORE_LIMITS.MAX_PAGES * 3) break;
    const href = link && link.href;
    if (!shouldFollow(href, pageUrl, link).follow) continue;
    const key = crawlKey(href, pageUrl);
    if (!key || visited.has(key) || queued.has(key)) continue;
    queued.add(key);
    crawl.queue.push(key);
    added += 1;
  }
  if (added) await writeCrawl(tabId, crawl);
  return { queued: added };
}

/** A page finished; move to the next one, or stop. */
export async function pageFinished(tabId, result) {
  const crawl = await readCrawl(tabId);
  if (!crawl || !crawl.running) return null;

  if (!(result && result.skipped)) crawl.pages += 1;
  crawl.clicks += Number(result && result.clicks) || 0;
  // Persist the counters before any branch that stops: stopCrawl re-reads from
  // storage, so an unwritten increment would be reported as one page short.
  await writeCrawl(tabId, crawl);

  if (result && result.stopped) return stopCrawl(tabId, 'stopped by you');
  if (crawl.pages >= EXPLORE_LIMITS.MAX_PAGES) {
    return stopCrawl(tabId, `page limit reached (${EXPLORE_LIMITS.MAX_PAGES})`);
  }

  const next = crawl.queue.shift();
  if (!next) return stopCrawl(tabId, 'nothing left to visit');

  crawl.visited.push(next);
  crawl.currentUrl = next;
  await writeCrawl(tabId, crawl);

  // Politeness gap, then navigate. The content script reloads with the page and
  // is told to explore again once it reports in.
  await new Promise((resolve) => setTimeout(resolve, EXPLORE_LIMITS.PAGE_DELAY_MS));
  const still = await readCrawl(tabId);
  if (!still || !still.running) return still;
  try {
    await chrome.tabs.update(tabId, { url: next });
  } catch (err) {
    warn('navigation failed', err);
    return stopCrawl(tabId, 'could not navigate');
  }
  return still;
}

/**
 * Called when a page reports in during a crawl. Usually it is the page the
 * crawl navigated to; sometimes the tab went somewhere on its own - a click
 * that turned out to be a link, a redirect. That page is explored once, like
 * any other, and a page already visited is not explored again: re-exploring
 * it is how a logo click became an endless loop through a wiki's front page.
 */
export async function resumeAfterNavigation(tabId, url) {
  const crawl = await readCrawl(tabId);
  if (!crawl || !crawl.running) return false;
  const key = crawlKey(url, url);
  if (key && key !== crawl.currentUrl) {
    if (crawl.visited.includes(key)) {
      log('crawl landed on a visited page, moving on', key);
      await pageFinished(tabId, { clicks: 0, skipped: true });
      return true;
    }
    crawl.visited.push(key);
    crawl.currentUrl = key;
    await writeCrawl(tabId, crawl);
  }
  await sendToTab(tabId, { type: EXPLORE_MSG.PAGE, limits: EXPLORE_LIMITS });
  return true;
}

export async function crawlStatus(tabId) {
  const crawl = await readCrawl(tabId);
  if (!crawl) return null;
  return {
    running: crawl.running,
    pages: crawl.pages,
    clicks: crawl.clicks,
    queued: crawl.queue.length,
    currentUrl: crawl.currentUrl,
    note: crawl.note,
    limit: EXPLORE_LIMITS.MAX_PAGES,
  };
}

export async function clearCrawl(tabId) {
  await writeCrawl(tabId, null);
}
