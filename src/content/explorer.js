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
  /** How much of a viewport one scroll step moves: overlap, so nothing falls between steps. */
  const SCROLL_FRACTION = 0.85;
  /** Inner scrollers considered besides the window (an app shell, a feed in a pane). */
  const MAX_SCROLLERS = 4;
  const MIN_SCROLLER_PX = 200;

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
          insideLink: Boolean(el.closest && el.closest('a[href]')),
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

  /** The window, plus any element that scrolls on its own: an app shell, a feed in a pane. */
  function scrollTargets() {
    const targets = [window];
    let visited = 0;
    for (const el of document.querySelectorAll('*')) {
      if (visited++ > MAX_ELEMENTS || targets.length > MAX_SCROLLERS) break;
      if (el.clientHeight < MIN_SCROLLER_PX || el.scrollHeight <= el.clientHeight + MIN_SCROLLER_PX) continue;
      const overflow = getComputedStyle(el).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') targets.push(el);
    }
    return targets;
  }

  function metrics(target) {
    if (target === window) {
      return { top: window.scrollY, height: document.documentElement.scrollHeight, viewport: window.innerHeight };
    }
    return { top: target.scrollTop, height: target.scrollHeight, viewport: target.clientHeight };
  }

  function scrollTo(target, top) {
    if (target === window) window.scrollTo({ top, behavior: 'auto' });
    else target.scrollTop = top;
  }

  /**
   * Scroll through in viewport-sized steps, so every lazy image and every
   * IntersectionObserver sentinel on the way down actually intersects. Jumping
   * straight to the bottom loads only what happens to sit there - measured:
   * 0 of 12 lazy images on the fixture feed, against 12 of 12 this way.
   * A feed that grows while at the bottom is followed until it stops growing
   * or the step budget runs out.
   */
  async function scrollThrough(limits) {
    const settle = limits.SCROLL_SETTLE_MS || 200;
    let steps = 0;
    for (const target of scrollTargets()) {
      let lastHeight = -1;
      while (steps < limits.MAX_SCROLL_STEPS && !stopRequested) {
        const before = metrics(target);
        scrollTo(target, before.top + before.viewport * SCROLL_FRACTION);
        steps += 1;
        await sleep(settle);
        const after = metrics(target);
        if (after.top + after.viewport < after.height - 2) continue; // not at the bottom yet
        await sleep(limits.SETTLE_MS); // at the bottom: give a feed time to append
        const height = metrics(target).height;
        if (height === lastHeight) break; // nothing new is loading
        lastHeight = height;
      }
      // Back to the top so the next round sees the whole page again.
      scrollTo(target, 0);
    }
    await sleep(120);
    return steps;
  }

  /** What a click round could have changed: the page's height, or its media. */
  function pageSignature() {
    return `${document.documentElement.scrollHeight}:${document.querySelectorAll('img, video, picture, canvas').length}`;
  }

  async function explorePage(limits) {
    running = true;
    stopRequested = false;
    let clicks = 0;
    let dry = 0;
    const deadline = Date.now() + (limits.MAX_PAGE_MS || 45_000);

    const scrolled = await scrollThrough(limits);

    while (clicks < limits.MAX_CLICKS && dry < limits.DRY_ROUNDS && !stopRequested && Date.now() < deadline) {
      const before = pageSignature();
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
        if (stopRequested || clicks >= limits.MAX_CLICKS || Date.now() >= deadline) break;
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
      // Newly revealed content may itself be lazy - but only re-scroll when
      // the round actually revealed something; a full pass costs seconds.
      if (pageSignature() !== before) await scrollThrough(limits);
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
