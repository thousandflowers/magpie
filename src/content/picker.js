/**
 * What the selection looks like *in the page*.
 *
 * The panel is 400px of thumbnails; the page is where the photographs actually
 * are. So the page leads: chosen media is outlined where it sits, and the set
 * being built is drawn in one of three ways, switched from the panel.
 *
 *   in place  - outlines only, nothing else on screen
 *   trail     - the picks shrink and follow the cursor
 *   over      - a small panel floats above the site, always visible
 *   tray      - a strip along the bottom, scrollable
 *
 * All four ship at once on purpose: which one is right is a question about how
 * it feels to use, and that is answered by using it, not by arguing.
 *
 * Everything is drawn inside a shadow root on a host of our own, so the site's
 * stylesheet cannot reach it and ours cannot reach the site. The host takes no
 * pointer events; only the pieces that need a click do.
 */

(() => {
  'use strict';

  if (window !== window.top) return;   // the page is the top document's
  if (window.__magpiePicker) return;   // one host per document
  window.__magpiePicker = true;

  const MSG = {
    SHOW_SELECTION: 'show-selection',
    PAGE_PICK: 'page-pick',
  };
  const ID_ATTR = 'data-magpie-id';
  /** How many picks the cursor can carry before it stops being a stack. */
  const TRAIL_MAX = 12;

  /** @type {{mode: string, picking: boolean, chosen: object[], pending: object[]}} */
  let state = { mode: 'place', picking: true, chosen: [], pending: [] };
  let frame = null;

  /* ------------------------------------------------------------------ *
   * The surface
   * ------------------------------------------------------------------ */

  const host = document.createElement('div');
  // Named so the browser checks can find the shadow root without guessing at
  // a z-index in a style attribute.
  host.id = 'magpie-picker';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
      .box { position: fixed; border-radius: 3px; pointer-events: none; }
      .box.chosen { outline: 3px solid #e8552d; outline-offset: 1px; }
      .box.pending { outline: 3px dashed #a07c12; outline-offset: 1px; background: rgba(160,124,18,.16); }

      #trail { position: fixed; left: 0; top: 0; pointer-events: none; }
      #trail img, #trail .blank {
        position: absolute; width: 46px; height: 35px; border-radius: 3px;
        object-fit: cover; border: 1.5px solid #fff; background: #ddd;
        box-shadow: 0 1px 2px rgba(0,0,0,.2), 0 8px 24px rgba(0,0,0,.22);
        transition: transform .34s cubic-bezier(.22,.9,.28,1);
      }
      #trail .count {
        position: absolute; background: #141413; color: #fff; font-size: 11px;
        font-weight: 600; padding: 3px 8px; border-radius: 20px; white-space: nowrap;
      }

      #over {
        position: fixed; top: 16px; right: 16px; width: 210px; padding: 10px;
        background: #fbfbfa; color: #141413; border: 1px solid #bcbcb4;
        border-radius: 10px; box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 10px 30px rgba(0,0,0,.14);
        pointer-events: auto;
      }
      #over h4 { margin: 0 0 8px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; color: #55554f; font-weight: 600; }
      #over .mini { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
      #over .mini img, #over .mini .blank { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 2px; background: #e9e9e6; }

      #tray {
        position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 12px;
        padding: 10px 14px; background: #fbfbfa; color: #141413;
        border-top: 1px solid #bcbcb4; box-shadow: 0 -6px 24px rgba(0,0,0,.12);
        pointer-events: auto;
      }
      #tray .lane { display: flex; gap: 6px; overflow-x: auto; flex: 1 1 auto; padding-bottom: 2px; }
      #tray .lane img, #tray .lane .blank { flex: 0 0 auto; width: 54px; height: 41px; object-fit: cover; border-radius: 3px; background: #e9e9e6; }
      #tray .label { font-size: 12px; color: #55554f; white-space: nowrap; font-variant-numeric: tabular-nums; }

      @media (prefers-color-scheme: dark) {
        #over, #tray { background: #1d1d22; color: #ececeb; border-color: #4a4a52; }
        #over h4, #tray .label { color: #b0b0ab; }
      }
      @media (prefers-reduced-motion: reduce) { #trail img, #trail .blank { transition: none; } }
      [hidden] { display: none !important; }
    </style>
    <div id="boxes"></div>
    <div id="trail" hidden></div>
    <div id="over" hidden><h4>Your picks</h4><div class="mini"></div></div>
    <div id="tray" hidden><div class="lane"></div><span class="label"></span></div>
  `;

  const attach = () => {
    if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
  };
  attach();

  const $ = (sel) => root.querySelector(sel);
  const elementFor = (id) => {
    try {
      return document.querySelector(`[${ID_ATTR}="${CSS.escape(String(id))}"]`);
    } catch {
      return null;
    }
  };

  const blank = (cls) => {
    const d = document.createElement('div');
    d.className = 'blank' + (cls ? ' ' + cls : '');
    return d;
  };

  /** A thumbnail, or a blank of the same shape when the URL cannot be drawn. */
  function thumb(item, cls) {
    if (item.url && /^(?:https?|data|blob):/i.test(item.url)) {
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = '';
      if (cls) img.className = cls;
      // A broken thumbnail should leave a hole of the right shape, not an icon.
      img.addEventListener('error', () => { img.replaceWith(blank(cls)); }, { once: true });
      return img;
    }
    return blank(cls);
  }

  /* ------------------------------------------------------------------ *
   * Outlines, wherever the elements happen to be right now
   * ------------------------------------------------------------------ */

  function drawBoxes() {
    const boxes = $('#boxes');
    boxes.textContent = '';
    const paint = (list, cls) => {
      for (const item of list) {
        const el = elementFor(item.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.bottom < -200 || r.top > innerHeight + 200) continue;
        const b = document.createElement('div');
        b.className = 'box ' + cls;
        b.style.left = `${r.left}px`;
        b.style.top = `${r.top}px`;
        b.style.width = `${r.width}px`;
        b.style.height = `${r.height}px`;
        boxes.appendChild(b);
      }
    };
    paint(state.pending, 'pending');
    paint(state.chosen, 'chosen');
  }

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; drawBoxes(); });
  };
  addEventListener('scroll', schedule, { passive: true, capture: true });
  addEventListener('resize', schedule, { passive: true });

  /* ------------------------------------------------------------------ *
   * The three ways of carrying the set
   * ------------------------------------------------------------------ */

  let mouse = { x: innerWidth / 2, y: innerHeight / 2 };
  addEventListener('mousemove', (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    if (state.mode === 'trail') placeTrail();
  }, { passive: true });

  function placeTrail() {
    const cards = $('#trail').querySelectorAll('img, .blank');
    cards.forEach((c, i) => {
      const a = (i / Math.max(cards.length, 1)) * Math.PI * 2;
      const r = 26 + i * 3.4;
      c.style.transform =
        `translate(${mouse.x + Math.cos(a) * r - 23}px, ${mouse.y + Math.sin(a) * r - 17}px) rotate(${(i * 13) % 26 - 13}deg)`;
    });
    const count = $('#trail .count');
    if (count) count.style.transform = `translate(${mouse.x + 10}px, ${mouse.y + 54}px)`;
  }

  function render() {
    attach();
    drawBoxes();

    const picks = state.chosen;
    const trail = $('#trail');
    const over = $('#over');
    const tray = $('#tray');

    trail.hidden = state.mode !== 'trail' || picks.length === 0;
    over.hidden = state.mode !== 'over';
    tray.hidden = state.mode !== 'tray' || picks.length === 0;

    if (!trail.hidden) {
      trail.textContent = '';
      for (const item of picks.slice(0, TRAIL_MAX)) trail.appendChild(thumb(item));
      if (picks.length > TRAIL_MAX) {
        const c = document.createElement('div');
        c.className = 'count';
        c.textContent = `+${picks.length - TRAIL_MAX}`;
        trail.appendChild(c);
      }
      placeTrail();
    }

    if (!over.hidden) {
      const mini = $('#over .mini');
      mini.textContent = '';
      for (const item of picks.slice(0, 16)) mini.appendChild(thumb(item));
      $('#over h4').textContent = picks.length ? `Your picks · ${picks.length}` : 'Your picks';
    }

    if (!tray.hidden) {
      const lane = $('#tray .lane');
      lane.textContent = '';
      for (const item of picks) lane.appendChild(thumb(item));
      $('#tray .label').textContent = `${picks.length} picked`;
    }
  }

  /* ------------------------------------------------------------------ *
   * Picking on the page
   *
   * Capture phase, so the click is ours before the site's own handler or a
   * surrounding link can act on it. Only elements the scanner has already
   * marked are taken; everything else passes through untouched, which is what
   * keeps the site usable while the panel is open.
   * ------------------------------------------------------------------ */

  addEventListener('click', (event) => {
    if (!state.picking) return;
    const marked = event.target && event.target.closest && event.target.closest(`[${ID_ATTR}]`);
    if (!marked) return;
    event.preventDefault();
    event.stopPropagation();
    chrome.runtime.sendMessage(
      { type: MSG.PAGE_PICK, elementId: marked.getAttribute(ID_ATTR) },
      () => void chrome.runtime.lastError,
    );
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== MSG.SHOW_SELECTION) return false;
    state = {
      mode: typeof message.mode === 'string' ? message.mode : 'place',
      picking: message.picking !== false,
      chosen: Array.isArray(message.chosen) ? message.chosen : [],
      pending: Array.isArray(message.pending) ? message.pending : [],
    };
    render();
    sendResponse({ ok: true, drawn: state.chosen.length + state.pending.length });
    return false;
  });
})();
