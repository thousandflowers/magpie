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
    FLASH_MATCHES: 'flash-matches',
  };
  /** Long enough to register as an event, short enough not to be a wait. */
  const FLASH_MS = 900;
  const ID_ATTR = 'data-magpie-id';
  /** How many picks the cursor can carry before it stops being a stack. */
  const TRAIL_MAX = 12;

  /** @type {{mode: string, picking: boolean, chosen: object[], pending: object[]}} */
  let state = { mode: 'floating', picking: true, chosen: [], pending: [] };
  /** Where the floating palette was left. Furniture, not a fixture. */
  let place = { x: null, y: null };
  let flashing = [];
  let flashTimer = null;
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

      .box.flash { outline: 3px solid #a07c12; outline-offset: 1px; background: rgba(232,85,45,.22); }

      #pal {
        position: fixed; background: #fbfbfa; color: #141413;
        border: 1px solid #bcbcb4; pointer-events: auto;
        box-shadow: 0 1px 2px rgba(0,0,0,.10), 0 12px 34px rgba(0,0,0,.18);
        display: flex; flex-direction: column; font-size: 12.5px;
      }
      #pal[data-dock="floating"] { width: 268px; border-radius: 10px; }
      #pal[data-dock="bottom"] { left: 0; right: 0; bottom: 0; border-radius: 0; border-left: 0; border-right: 0; border-bottom: 0; }
      #pal[data-dock="right"] { top: 0; right: 0; bottom: 0; width: 268px; border-radius: 0; border-top: 0; border-right: 0; border-bottom: 0; }
      #pal.over { outline: 2px dashed #e8552d; outline-offset: -4px; }

      .grip { display: flex; align-items: center; gap: 8px; padding: 7px 9px 7px 11px; border-bottom: 1px solid #dcdcd6; cursor: grab; user-select: none; }
      #pal[data-dock="floating"] .grip { border-radius: 10px 10px 0 0; }
      .grip.dragging { cursor: grabbing; }
      .grip .name { font-weight: 600; }
      .grip .n { font-variant-numeric: tabular-nums; color: #55554f; }
      .grip .spacer { margin-left: auto; }
      .grip button { border: 1px solid transparent; background: transparent; color: #55554f; border-radius: 5px; cursor: pointer; font-size: 12px; line-height: 1; min-width: 26px; min-height: 26px; padding: 4px 6px; }
      .grip button:hover { background: #e9e9e6; }
      .grip button[aria-pressed="true"] { background: #e8552d; color: #fff; }

      .lane { display: flex; flex-wrap: wrap; gap: 5px; padding: 9px 11px; overflow: auto; max-height: 220px; }
      #pal[data-dock="bottom"] .lane { flex-wrap: nowrap; max-height: none; }
      .lane img, .lane .blank { width: 54px; height: 41px; object-fit: cover; border-radius: 3px; background: #e9e9e6; flex: 0 0 auto; }
      .empty { padding: 14px 11px; color: #55554f; text-align: center; line-height: 1.45; }

      .foot { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-top: 1px solid #dcdcd6; }
      .foot .similar { border: 1px solid #bcbcb4; background: transparent; border-radius: 6px; padding: 7px 10px; cursor: pointer; min-height: 30px; color: inherit; }
      .foot .get { margin-left: auto; background: #e8552d; color: #fff; border: 0; border-radius: 6px; padding: 8px 13px; font-weight: 600; cursor: pointer; min-height: 32px; }
      .foot button[disabled] { opacity: .45; cursor: default; }

      #trail .reopen { position: absolute; background: #e8552d; color: #fff; font-size: 11px; font-weight: 600; padding: 4px 9px; border-radius: 20px; white-space: nowrap; pointer-events: auto; cursor: pointer; border: 0; }

      @media (prefers-color-scheme: dark) {
        #over, #tray { background: #1d1d22; color: #ececeb; border-color: #4a4a52; }
        #over h4, #tray .label { color: #b0b0ab; }
      }
      @media (prefers-reduced-motion: reduce) { #trail img, #trail .blank { transition: none; } }
      [hidden] { display: none !important; }
    </style>
    <div id="boxes"></div>

    <div id="pal" data-dock="floating" hidden>
      <div class="grip" id="grip">
        <span class="name">Magpie</span>
        <span class="n" id="palCount"></span>
        <span class="spacer"></span>
        <button type="button" id="dockBottom" title="Aggancia in fondo" aria-pressed="false">&#9601;</button>
        <button type="button" id="dockRight" title="Aggancia a destra" aria-pressed="false">&#9615;</button>
        <button type="button" id="dockFree" title="Rendi mobile" aria-pressed="true">&#9671;</button>
        <button type="button" id="close" title="Chiudi &mdash; le scelte ti seguono">&#10005;</button>
      </div>
      <div class="lane" id="lane" hidden></div>
      <div class="empty" id="empty">Trascina qui una foto, o cliccala nella pagina.</div>
      <div class="foot">
        <button type="button" class="similar" id="similar" disabled>trova simili</button>
        <button type="button" class="get" id="get" disabled>Scarica</button>
      </div>
    </div>

    <div id="trail" hidden></div>
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
    paint(flashing, 'flash');
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
    for (const tag of $('#trail').querySelectorAll('.count, .reopen')) {
      const drop = tag.classList.contains('count') ? 52 : 76;
      tag.style.transform = `translate(${mouse.x + 12}px, ${mouse.y + drop}px)`;
    }
  }

  const pal = $('#pal');
  const tell = (message) => {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch { /* the panel is gone; nothing to say */ }
  };

  /* ------------------------------------------------------------------ *
   * Moving and docking - the palette is furniture, not a fixture
   * ------------------------------------------------------------------ */

  const grip = $('#grip');
  let drag = null;

  grip.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || state.mode !== 'floating') return;
    const r = pal.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    grip.classList.add('dragging');
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    place = {
      x: Math.min(Math.max(0, e.clientX - drag.dx), innerWidth - 80),
      y: Math.min(Math.max(0, e.clientY - drag.dy), innerHeight - 40),
    };
    applyPlace();
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    grip.classList.remove('dragging');
    try { grip.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);

  function applyPlace() {
    if (state.mode !== 'floating') {
      pal.style.left = '';
      pal.style.top = '';
      return;
    }
    if (place.x == null) place = { x: Math.max(12, innerWidth - 300), y: 72 };
    pal.style.left = `${place.x}px`;
    pal.style.top = `${place.y}px`;
  }

  const setMode = (mode) => {
    state.mode = mode;
    tell({ type: MSG.PAGE_PICK, pickMode: mode });
    render();
  };
  $('#dockBottom').addEventListener('click', () => setMode('bottom'));
  $('#dockRight').addEventListener('click', () => setMode('right'));
  $('#dockFree').addEventListener('click', () => setMode('floating'));
  $('#close').addEventListener('click', () => setMode('trail'));
  $('#similar').addEventListener('click', () => tell({ type: MSG.PAGE_PICK, findSimilar: true }));
  $('#get').addEventListener('click', () => tell({ type: MSG.PAGE_PICK, download: true }));

  // The browser's own drag already carries the image; there is no need to
  // fight it, only to say which element it came from.
  addEventListener('dragstart', (event) => {
    const marked = event.target && event.target.closest && event.target.closest(`[${ID_ATTR}]`);
    if (!marked || !event.dataTransfer) return;
    event.dataTransfer.setData('text/magpie-id', marked.getAttribute(ID_ATTR));
    event.dataTransfer.effectAllowed = 'copy';
  }, true);

  pal.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    pal.classList.add('over');
  });
  pal.addEventListener('dragleave', () => pal.classList.remove('over'));
  pal.addEventListener('drop', (event) => {
    event.preventDefault();
    pal.classList.remove('over');
    const id = event.dataTransfer && event.dataTransfer.getData('text/magpie-id');
    if (id) tell({ type: MSG.PAGE_PICK, elementId: id, add: true });
  });

  function render() {
    attach();
    drawBoxes();

    const picks = state.chosen;
    const closed = state.mode === 'trail';

    pal.hidden = closed;
    pal.dataset.dock = closed ? 'floating' : state.mode;
    applyPlace();
    $('#dockBottom').setAttribute('aria-pressed', String(state.mode === 'bottom'));
    $('#dockRight').setAttribute('aria-pressed', String(state.mode === 'right'));
    $('#dockFree').setAttribute('aria-pressed', String(state.mode === 'floating'));

    if (!closed) {
      const lane = $('#lane');
      lane.textContent = '';
      for (const item of picks) lane.appendChild(thumb(item));
      lane.hidden = picks.length === 0;
      $('#empty').hidden = picks.length > 0;
      $('#palCount').textContent = picks.length ? String(picks.length) : '';
      $('#get').disabled = picks.length === 0;
      $('#get').textContent = picks.length ? `Scarica ${picks.length}` : 'Scarica';
      $('#similar').disabled = picks.length === 0;
    }

    const trail = $('#trail');
    trail.hidden = !closed || picks.length === 0;
    if (!trail.hidden) {
      trail.textContent = '';
      for (const item of picks.slice(0, TRAIL_MAX)) trail.appendChild(thumb(item));
      if (picks.length > TRAIL_MAX) {
        const c = document.createElement('div');
        c.className = 'count';
        c.textContent = `+${picks.length - TRAIL_MAX}`;
        trail.appendChild(c);
      }
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'reopen';
      back.textContent = `${picks.length} \u00b7 riapri`;
      back.addEventListener('click', () => setMode('floating'));
      trail.appendChild(back);
      placeTrail();
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
    if (event.target && event.target.closest && event.target.closest('#magpie-picker')) return;
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
    if (!message || typeof message.type !== 'string') return false;

    // Seen happening, not simply appeared: what the match found lights up in
    // place for a moment before the palette takes it.
    if (message.type === MSG.FLASH_MATCHES) {
      flashing = Array.isArray(message.items) ? message.items : [];
      drawBoxes();
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flashing = []; flashTimer = null; drawBoxes(); }, FLASH_MS);
      sendResponse({ ok: true, flashed: flashing.length });
      return false;
    }

    if (message.type !== MSG.SHOW_SELECTION) return false;
    state = {
      mode: typeof message.mode === 'string' ? message.mode : state.mode,
      picking: message.picking !== false,
      chosen: Array.isArray(message.chosen) ? message.chosen : [],
      pending: Array.isArray(message.pending) ? message.pending : [],
    };
    render();
    sendResponse({ ok: true, drawn: state.chosen.length + state.pending.length, mode: state.mode });
    return false;
  });
})();
