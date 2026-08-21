/**
 * The explorer's hands: scrolls, and clicks what it is told to click.
 *
 * It deliberately makes no decisions. Content scripts cannot import extension
 * modules, and duplicating the safety rules here would mean two copies of the
 * one thing that must never drift — so this file only *describes* candidate
 * elements, ships the descriptions to the service worker, and clicks back the
 * indexes it is handed. src/core/explore-policy.js decides, and it is tested.
 *
 * Dormant until a start message arrives. Nothing here runs on its own.
 */

(() => {
  'use strict';

  const MSG = {
    EXPLORE_PAGE: 'explore-page',
    EXPLORE_STOP: 'explore-stop',
    EXPLORE_JUDGE: 'explore-judge',
    EXPLORE_LINKS: 'explore-links',
    EXPLORE_PAGE_DONE: 'explore-page-done',
  };

  const CLICKED_ATTR = 'data-magpie-clicked';
  const MAX_ELEMENTS = 3000;
  const MAX_CANDIDATES = 120;
  const MAX_LINKS = 400;

  let running = false;
  let stopRequested = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function ask(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError;
          resolve(response || {});
        });
      } catch {
        resolve({});
      }
    });
  }

  function isVisible(el, rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
  }

  /**
   * Anything a person could plausibly click. Keyed on affordance —
   * `cursor: pointer`, a button role, a tab stop — rather than on a list of
   * class names, so an unfamiliar design system still gets explored.
   */
  function collectCandidates() {
    const out = [];
    let visited = 0;
    for (const el of document.querySelectorAll('*')) {
      if (visited++ > MAX_ELEMENTS || out.length >= MAX_CANDIDATES) break;
      if (el.hasAttribute(CLICKED_ATTR)) continue;

      const tag = el.tagName.toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      let affords = tag === 'button' || tag === 'summary' || role === 'button' || role === 'tab';
      if (!affords && el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') affords = true;

      let rect;
      let style;
      try {
        rect = el.getBoundingClientRect();
        style = getComputedStyle(el);
      } catch {
        continue;
      }
      if (!affords && style.cursor === 'pointer') affords = true;
      if (!affords) continue;
      if (!isVisible(el, rect)) continue;

      out.push({
        el,
        description: {
          tag,
          role,
          type: (el.getAttribute('type') || '').toLowerCase(),
          text: (el.textContent || '').slice(0, 120),
          ariaLabel: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
          alt: el.getAttribute('alt') || '',
          className: (el.getAttribute('class') || '').slice(0, 200),
          id: (el.getAttribute('id') || '').slice(0, 80),
          testId: el.getAttribute('data-testid') || '',
          href: el.tagName === 'A' ? el.href : '',
          target: el.getAttribute('target') || '',
          hasDownloadAttr: el.hasAttribute('download'),
          insideForm: Boolean(el.closest && el.closest('form')),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          visible: true,
          containsMedia: Boolean(el.querySelector && el.querySelector('img, video, picture, canvas')),
          area: Math.round(rect.width * rect.height),
        },
      });
    }
    return out;
  }

  function collectLinks() {
    const links = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      if (links.length >= MAX_LINKS) break;
      const href = a.href;
      if (!href || seen.has(href)) continue;
      seen.add(href);
      links.push({
        href,
        text: (a.textContent || '').slice(0, 120),
        ariaLabel: a.getAttribute('aria-label') || '',
        title: a.getAttribute('title') || '',
        className: (a.getAttribute('class') || '').slice(0, 200),
        id: (a.getAttribute('id') || '').slice(0, 80),
        hasDownloadAttr: a.hasAttribute('download'),
      });
    }
    return links;
  }

  /** Scroll to the bottom in steps, so lazy loaders and feeds actually fire. */
  async function scrollThrough(limits) {
    let previousHeight = -1;
    for (let step = 0; step < limits.MAX_SCROLL_STEPS; step += 1) {
      if (stopRequested) return step;
      const height = document.documentElement.scrollHeight;
      window.scrollTo({ top: height, behavior: 'auto' });
      await sleep(limits.SETTLE_MS);
      if (height === previousHeight && step > 1) break; // nothing new is loading
      previousHeight = height;
    }
    // Back to the top so the next round sees the whole page again.
    window.scrollTo({ top: 0, behavior: 'auto' });
    await sleep(120);
    return limits.MAX_SCROLL_STEPS;
  }

  async function explorePage(limits) {
    running = true;
    stopRequested = false;
    let clicks = 0;
    let dry = 0;

    const scrolled = await scrollThrough(limits);

    while (clicks < limits.MAX_CLICKS && dry < limits.DRY_ROUNDS && !stopRequested) {
      const candidates = collectCandidates();
      if (!candidates.length) break;

      const verdict = await ask({
        type: MSG.EXPLORE_JUDGE,
        candidates: candidates.map((c) => c.description),
      });
      const approved = Array.isArray(verdict.click) ? verdict.click : [];
      if (!approved.length) {
        dry += 1;
        continue;
      }
      dry = 0;

      for (const index of approved) {
        if (stopRequested || clicks >= limits.MAX_CLICKS) break;
        const target = candidates[index];
        if (!target || !target.el.isConnected) continue;
        try {
          target.el.setAttribute(CLICKED_ATTR, '1');
          target.el.click();
          clicks += 1;
        } catch {
          /* a click handler that throws is the page's problem, not ours */
        }
        await sleep(limits.SETTLE_MS);
      }
      // Newly revealed content may itself be lazy.
      await scrollThrough(limits);
    }

    const links = collectLinks();
    await ask({ type: MSG.EXPLORE_LINKS, links, pageUrl: location.href });
    running = false;
    return { clicks, scrolled, links: links.length, stopped: stopRequested };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    if (message.type === MSG.EXPLORE_PAGE) {
      if (running) {
        sendResponse({ ok: false, reason: 'already exploring this page' });
        return false;
      }
      explorePage(message.limits || {})
        .then((result) => {
          chrome.runtime.sendMessage(
            { type: MSG.EXPLORE_PAGE_DONE, ...result, pageUrl: location.href },
            () => void chrome.runtime.lastError,
          );
        })
        .catch(() => {
          chrome.runtime.sendMessage(
            { type: MSG.EXPLORE_PAGE_DONE, clicks: 0, links: 0, failed: true, pageUrl: location.href },
            () => void chrome.runtime.lastError,
          );
        });
      sendResponse({ ok: true, started: true });
      return false;
    }

    if (message.type === MSG.EXPLORE_STOP) {
      stopRequested = true;
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
