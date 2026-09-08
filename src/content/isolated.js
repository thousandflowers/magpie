/**
 * Layer C — DOM scanner, and the bridge for Layer B.
 *
 * Runs in the ISOLATED world so it can talk to the service worker. Content
 * scripts are classic scripts and cannot import extension modules reliably
 * (page CSP can block dynamic import of extension URLs), so this file is
 * self-contained: it extracts raw evidence and lets src/core decide what is
 * media. The matcher below is a prefilter, never the authority.
 */

(() => {
  'use strict';

  const TOKEN = 'magpie:bridge:v1';
  const ID_ATTR = 'data-magpie-id';

  const MSG = {
    DOM_CANDIDATES: 'dom-candidates',
    MAIN_CANDIDATES: 'main-candidates',
    PAGE_RESET: 'page-reset',
    PAGE_INFO: 'page-info',
    MSE_DETECTED: 'mse-detected',
    EME_DETECTED: 'eme-detected',
    SCAN_NOW: 'scan-now',
    CAPTURE_CANVAS: 'capture-canvas',
    HIGHLIGHT_ITEM: 'highlight-item',
  };

  const MEDIA_EXT_RE =
    /\.(?:jpe?g|png|gif|webp|avif|bmp|ico|svg|tiff?|heic|heif|jxl|mp4|m4v|webm|mkv|mov|avi|ogv|mpe?g|3gp|flv|ts|mp3|wav|ogg|oga|m4a|aac|flac|opus|wma|m3u8|mpd)(?:[?#]|$)/i;
  const CDN_SHAPE_RE =
    /\/(?:images?|imgs?|photos?|pics?|media|assets|uploads?|thumbs?|thumbnails?|videos?|vids?|audio|attachments?|cdn)\//i;
  const NON_MEDIA_RE = /\.(?:html?|php|aspx?|jsp|m?js|css|json|txt|woff2?|ttf|map|wasm|pdf)(?:[?#]|$)/i;

  /** Attributes lazy-loaders hide the real URL in. */
  const LAZY_ATTRS = [
    'data-src', 'data-srcset', 'data-original', 'data-lazy', 'data-lazy-src',
    'data-full', 'data-hi-res', 'data-highres', 'data-zoom-image',
    'data-large_image', 'data-large', 'data-image', 'data-bg', 'data-background',
    'data-poster', 'data-thumb', 'data-url', 'data-href',
  ];

  const DEBOUNCE_MS = 250;
  const MAX_ELEMENTS = 6000;
  const MAX_PATH_DEPTH = 24;
  const REPEAT_LOOKUP_DEPTH = 6;
  const REPEAT_MIN_SIBLINGS = 3;
  const MAX_COUNT_KEYS = 64;

  let elementCounter = 0;
  let scanTimer = null;
  let scanning = false;
  let lastHref = location.href;
  /** Only the top document names the page; an iframe must never reset the tab's index. */
  const IS_TOP = window === window.top;
  /** class name -> how many elements in the document carry it. */
  let classFrequency = new Map();

  /* ---------------------------------------------------------------- *
   * Small helpers
   * ---------------------------------------------------------------- */

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {
      /* extension context invalidated during a reload */
    }
  }

  function absolute(url) {
    if (typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (!trimmed || trimmed === '#') return '';
    if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return trimmed;
    try {
      return new URL(trimmed, document.baseURI).href;
    } catch {
      return '';
    }
  }

  function looksLikeMedia(value) {
    if (typeof value !== 'string' || value.length < 5) return false;
    if (value.startsWith('data:')) return /^data:(?:image|video|audio)\//i.test(value);
    if (value.startsWith('blob:')) return true;
    if (NON_MEDIA_RE.test(value)) return false;
    if (MEDIA_EXT_RE.test(value)) return true;
    if (!CDN_SHAPE_RE.test(value)) return false;
    const path = value.split(/[?#]/, 1)[0];
    const tail = path.slice(path.lastIndexOf('/') + 1);
    return tail.length >= 8 && !tail.includes('.');
  }

  function idOf(el) {
    let id = el.getAttribute(ID_ATTR);
    if (!id) {
      elementCounter += 1;
      id = `m${elementCounter}`;
      try {
        el.setAttribute(ID_ATTR, id);
      } catch {
        /* read-only DOM nodes (rare) */
      }
    }
    return id;
  }

  /**
   * Highest-resolution entry of a srcset. Width descriptors win over density,
   * because `1200w` is what the user actually wants when both are present.
   */
  function bestFromSrcset(srcset) {
    if (typeof srcset !== 'string' || !srcset.trim()) return '';
    let best = '';
    let bestScore = -1;
    for (const part of srcset.split(',')) {
      const bits = part.trim().split(/\s+/);
      const url = bits[0];
      if (!url) continue;
      const descriptor = bits[1] || '1x';
      let score = 1;
      const w = /^(\d+(?:\.\d+)?)w$/i.exec(descriptor);
      const x = /^(\d+(?:\.\d+)?)x$/i.exec(descriptor);
      if (w) score = Number(w[1]);
      else if (x) score = Number(x[1]) * 1000; // keep density below any real width
      if (score > bestScore) {
        bestScore = score;
        best = url;
      }
    }
    return best;
  }

  /** Every url() inside a background-image / image-set declaration. */
  function urlsFromCss(value) {
    if (typeof value !== 'string' || value === 'none' || !value) return [];
    const out = [];
    const re = /url\((['"]?)(.*?)\1\)/g;
    let match;
    while ((match = re.exec(value)) !== null) {
      if (match[2]) out.push(match[2]);
    }
    return out;
  }

  /** Class list with obvious per-instance noise left in — core does the stripping. */
  function classesOf(el) {
    const raw = el.getAttribute ? el.getAttribute('class') : '';
    if (!raw || typeof raw !== 'string') return [];
    return raw.trim().split(/\s+/).slice(0, 12);
  }

  /** element -> body, as the similarity engine expects. */
  function structuralPath(el) {
    const path = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < MAX_PATH_DEPTH) {
      path.push({ tag: node.tagName.toLowerCase(), classes: classesOf(node) });
      if (node.tagName === 'BODY') break;
      node = node.parentElement;
      depth += 1;
    }
    return path;
  }

  /**
   * Count every class in the document.
   *
   * This is the signal that replaces guessing at a class name's shape: a
   * generated class (`sc-bdVaJa1`) sits on one or two elements, a structural
   * one (`grid-item`) sits on every sibling in the grid.
   */
  function buildClassFrequency() {
    const freq = new Map();
    let visited = 0;
    for (const el of document.querySelectorAll('[class]')) {
      if (visited++ > MAX_ELEMENTS) break;
      const raw = el.getAttribute('class');
      if (!raw || typeof raw !== 'string') continue;
      for (const token of raw.trim().split(/\s+/)) {
        if (!token) continue;
        freq.set(token, (freq.get(token) || 0) + 1);
      }
    }
    return freq;
  }

  /** The document-wide count of each class appearing in one path. */
  function countsForPath(path) {
    const counts = {};
    let keys = 0;
    for (const node of path) {
      for (const cls of node.classes) {
        if (counts[cls] !== undefined) continue;
        if (keys >= MAX_COUNT_KEYS) return counts;
        counts[cls] = classFrequency.get(cls) || 0;
        keys += 1;
      }
    }
    return counts;
  }

  /** Signature used to spot repeated siblings — a grid, list or feed. */
  function signatureOf(el) {
    return `${el.tagName}.${classesOf(el).sort().join('.')}`;
  }

  /**
   * Index, in the element-first structural path, of the nearest ancestor whose
   * siblings repeat — i.e. the cell of the grid/list/carousel this element sits
   * in. Returns -1 when nothing repeats.
   *
   * The index is what lets the similarity engine tell one repeated group from
   * another: a carousel slide and a product-grid cell are both repeated, and
   * they are not the same set.
   */
  function repeatDepthOf(el) {
    let node = el;
    for (let i = 0; i < REPEAT_LOOKUP_DEPTH && node && node.parentElement; i += 1) {
      const parent = node.parentElement;
      const signature = signatureOf(node);
      let matches = 0;
      for (const sibling of parent.children) {
        if (signatureOf(sibling) === signature) matches += 1;
        if (matches >= REPEAT_MIN_SIBLINGS) return i;
      }
      node = parent;
    }
    return -1;
  }

  function rectOf(el) {
    try {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    } catch {
      return { w: 0, h: 0 };
    }
  }

  /** Build the candidate the background expects. */
  function candidate(url, el, extra) {
    const absoluteUrl = absolute(url);
    if (!absoluteUrl) return null;
    const base = {
      url: absoluteUrl,
      source: 'dom',
      status: 'referenced',
      pageUrl: location.href,
      frameUrl: window === window.top ? '' : location.href,
      frameOrigin: window === window.top ? '' : location.origin,
      timestamp: Date.now(),
    };
    if (el) {
      const rect = rectOf(el);
      const path = structuralPath(el);
      const repeatDepth = repeatDepthOf(el);
      base.elementId = idOf(el);
      base.structuralPath = path;
      base.inRepeatedGroup = repeatDepth >= 0;
      base.repeatDepth = repeatDepth;
      base.classCounts = countsForPath(path);
      base.renderedWidth = rect.w;
      base.renderedHeight = rect.h;
    }
    return { ...base, ...(extra || {}) };
  }

  /* ---------------------------------------------------------------- *
   * The scan
   * ---------------------------------------------------------------- */

  function collectFromImg(el, push) {
    const fromSrcset = bestFromSrcset(el.getAttribute('srcset'));
    const src = fromSrcset || el.currentSrc || el.getAttribute('src') || '';
    if (src) {
      push(candidate(src, el, {
        kind: 'image',
        width: el.naturalWidth || 0,
        height: el.naturalHeight || 0,
        alt: el.getAttribute('alt') || '',
        status: el.complete && el.naturalWidth ? 'confirmed' : 'referenced',
      }));
    }
    // A gallery thumbnail wrapped in a link to the full-size file is the most
    // common upgrade pattern on the web: treat the link target as the upgrade.
    const link = el.closest && el.closest('a[href]');
    if (link) {
      const href = absolute(link.getAttribute('href'));
      if (href && href !== absolute(src) && looksLikeMedia(href)) {
        push(candidate(href, el, {
          kind: 'image',
          status: 'referenced',
          // The panel renders the thumbnail for this tile rather than pulling
          // the full-size file just to draw a 150px preview.
          previewUrl: absolute(src),
          alt: el.getAttribute('alt') || '',
        }));
      }
    }
  }

  function collectFromMediaEl(el, push) {
    const kind = el.tagName === 'AUDIO' ? 'audio' : 'video';
    const src = el.currentSrc || el.getAttribute('src') || '';
    if (src) {
      push(candidate(src, el, {
        kind,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
        status: src.startsWith('blob:') ? 'referenced' : 'confirmed',
      }));
    }
    const poster = el.getAttribute('poster');
    if (poster) push(candidate(poster, el, { kind: 'image', poster: true }));
    for (const source of el.querySelectorAll('source[src], source[srcset]')) {
      const url = source.getAttribute('src') || bestFromSrcset(source.getAttribute('srcset'));
      if (url) {
        push(candidate(url, el, {
          kind,
          mimeType: source.getAttribute('type') || '',
        }));
      }
    }
    for (const track of el.querySelectorAll('track[src]')) {
      const url = track.getAttribute('src');
      if (url) push(candidate(url, el, { kind: 'text', mimeType: 'text/vtt' }));
    }
  }

  function collectFromPicture(el, push) {
    for (const source of el.querySelectorAll('source[srcset]')) {
      const url = bestFromSrcset(source.getAttribute('srcset'));
      if (url) {
        push(candidate(url, el, {
          kind: 'image',
          mimeType: source.getAttribute('type') || '',
        }));
      }
    }
  }

  function collectFromLazyAttrs(el, push) {
    const attrs = el.attributes;
    if (!attrs) return;
    for (const attr of attrs) {
      const name = attr.name;
      if (!name.startsWith('data-')) continue;
      const value = attr.value;
      if (!value || value.length > 4096) continue;
      const isKnown = LAZY_ATTRS.includes(name);
      const url = name.endsWith('srcset') ? bestFromSrcset(value) : value;
      if (!url) continue;
      if (!isKnown && !looksLikeMedia(url)) continue;
      if (isKnown && !looksLikeMedia(url)) continue;
      push(candidate(url, el, { kind: '', via: name }));
    }
  }

  function collectFromEmbeds(el, push) {
    const url =
      el.getAttribute('data') || el.getAttribute('src') || '';
    if (url && looksLikeMedia(url)) push(candidate(url, el, { kind: '' }));
  }

  function collectFromAnchor(el, push) {
    const href = el.getAttribute('href');
    if (!href) return;
    const absoluteHref = absolute(href);
    if (!absoluteHref || !looksLikeMedia(absoluteHref)) return;
    // Only report links that are not already covered by a child image.
    if (el.querySelector && el.querySelector('img')) return;
    push(candidate(absoluteHref, el, { kind: '' }));
  }

  function collectFromBackground(el, push) {
    let style;
    try {
      style = getComputedStyle(el);
    } catch {
      return;
    }
    if (!style) return;
    const declarations = [style.backgroundImage, style.borderImageSource, style.maskImage];
    for (const declaration of declarations) {
      for (const url of urlsFromCss(declaration)) {
        if (!looksLikeMedia(url)) continue;
        const rect = rectOf(el);
        push(candidate(url, el, {
          kind: 'image',
          width: rect.w,
          height: rect.h,
          via: 'background-image',
        }));
      }
    }
  }

  function collectFromSvg(el, push) {
    if (el.closest && el.closest('svg') !== el) return;
    const rect = rectOf(el);
    if (rect.w < 8 || rect.h < 8) return;
    push(candidate(`magpie-svg:${idOf(el)}`, el, {
      kind: 'image',
      mimeType: 'image/svg+xml',
      width: rect.w,
      height: rect.h,
      status: 'confirmed',
      synthetic: 'svg',
    }));
  }

  function collectFromCanvas(el, push) {
    const w = el.width | 0;
    const h = el.height | 0;
    if (w <= 0 || h <= 0) return;
    let tainted = false;
    try {
      const ctx = el.getContext('2d', { willReadFrequently: true });
      if (ctx) ctx.getImageData(0, 0, 1, 1);
    } catch {
      tainted = true;
    }
    push(candidate(`magpie-canvas:${idOf(el)}`, el, {
      kind: 'image',
      mimeType: 'image/png',
      width: w,
      height: h,
      status: tainted ? 'unavailable' : 'confirmed',
      protectedReason: tainted ? 'Canvas is cross-origin tainted' : '',
      synthetic: 'canvas',
    }));
  }

  const BACKGROUND_SKIP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD', 'TITLE']);

  function scan() {
    if (scanning) return;
    scanning = true;
    const found = [];
    const seen = new Set();
    const push = (item) => {
      if (!item || !item.url) return;
      if (seen.has(item.url)) return;
      seen.add(item.url);
      found.push(item);
    };

    try {
      // Frequencies first: every candidate built below reads from this map.
      classFrequency = buildClassFrequency();
      for (const el of document.querySelectorAll('img')) collectFromImg(el, push);
      for (const el of document.querySelectorAll('video, audio')) collectFromMediaEl(el, push);
      for (const el of document.querySelectorAll('picture')) collectFromPicture(el, push);
      for (const el of document.querySelectorAll('object, embed, iframe')) collectFromEmbeds(el, push);
      for (const el of document.querySelectorAll('a[href]')) collectFromAnchor(el, push);
      for (const el of document.querySelectorAll('svg')) collectFromSvg(el, push);
      for (const el of document.querySelectorAll('canvas')) collectFromCanvas(el, push);
      for (const el of document.querySelectorAll('[poster]')) {
        const poster = el.getAttribute('poster');
        if (poster) push(candidate(poster, el, { kind: 'image', poster: true }));
      }

      // One computed-style walk for the whole document. This is the expensive
      // part of the scan, so it is capped and skips non-rendered elements.
      let visited = 0;
      for (const el of document.querySelectorAll('*')) {
        if (visited++ > MAX_ELEMENTS) break;
        if (BACKGROUND_SKIP.has(el.tagName)) continue;
        collectFromLazyAttrs(el, push);
        collectFromBackground(el, push);
      }
    } catch (err) {
      // A broken page must not stop the scan from reporting what it did find.
      void err;
    }

    scanning = false;
    if (found.length) send({ type: MSG.DOM_CANDIDATES, items: found });
  }

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const run = () => scan();
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1000 });
      else run();
    }, DEBOUNCE_MS);
  }

  /* ---------------------------------------------------------------- *
   * Bridge from the MAIN world
   * ---------------------------------------------------------------- */

  window.addEventListener('message', (event) => {
    // Same-window only, and only our own token: the page can post anything.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.token !== TOKEN) return;

    if (data.type === 'candidates') {
      const items = Array.isArray(data.items) ? data.items.slice(0, 500) : [];
      const clean = [];
      for (const raw of items) {
        if (!raw || typeof raw.url !== 'string') continue;
        const url = absolute(raw.url);
        if (!url) continue;
        clean.push({
          url,
          kind: typeof raw.kind === 'string' ? raw.kind : '',
          mimeType: typeof raw.mimeType === 'string' ? raw.mimeType.slice(0, 128) : '',
          bytes: Number.isFinite(raw.bytes) ? raw.bytes : null,
          source: 'main',
          status: 'background',
          pageUrl: location.href,
          frameOrigin: window === window.top ? '' : location.origin,
          timestamp: Date.now(),
        });
      }
      if (clean.length) send({ type: MSG.MAIN_CANDIDATES, items: clean });
    } else if (data.type === 'route') {
      setTimeout(onRouteChange, 0);
    } else if (data.type === 'mse') {
      send({ type: MSG.MSE_DETECTED, detail: String(data.detail || '').slice(0, 128) });
    } else if (data.type === 'eme') {
      send({ type: MSG.EME_DETECTED, detail: `Encrypted Media Extensions: ${String(data.detail || '').slice(0, 96)}` });
    }
  });

  /* ---------------------------------------------------------------- *
   * Navigation
   * ---------------------------------------------------------------- */

  function reportPage(navigation) {
    if (!IS_TOP) return;
    send({
      type: MSG.PAGE_INFO,
      url: location.href,
      title: document.title || '',
      navigation,
    });
  }

  function onRouteChange() {
    if (!IS_TOP) return;
    if (location.href === lastHref) return;
    lastHref = location.href;
    send({ type: MSG.PAGE_RESET, url: location.href });
    reportPage(false);
    scheduleScan();
  }

  /**
   * popstate and hashchange are real DOM events, so they reach this world.
   * pushState/replaceState are plain function calls in the page's realm and
   * are wrapped by main-world.js, which posts a `route` bridge message.
   */
  function hookHistory() {
    window.addEventListener('popstate', () => setTimeout(onRouteChange, 0));
    window.addEventListener('hashchange', () => setTimeout(onRouteChange, 0));
  }

  /* ---------------------------------------------------------------- *
   * Requests from the panel
   * ---------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    if (message.type === MSG.SCAN_NOW) {
      scan();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === MSG.CAPTURE_CANVAS) {
      const el = document.querySelector(`[${ID_ATTR}="${CSS.escape(message.elementId || '')}"]`);
      // The message reaches every frame; only the one holding the element
      // answers, otherwise an iframe's "not here" wins the race.
      if (!el) return false;
      try {
        if (el.tagName === 'CANVAS') {
          sendResponse({ ok: true, dataUrl: el.toDataURL('image/png') });
        } else {
          const svg = new XMLSerializer().serializeToString(el);
          const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
          sendResponse({ ok: true, dataUrl: encoded });
        }
      } catch (err) {
        sendResponse({ ok: false, reason: String((err && err.message) || err) });
      }
      return false;
    }

    if (message.type === MSG.HIGHLIGHT_ITEM) {
      const el = document.querySelector(`[${ID_ATTR}="${CSS.escape(message.elementId || '')}"]`);
      if (!el) return false;
      if (el.scrollIntoView) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const previous = el.style.outline;
        el.style.outline = '3px solid #e8552d';
        setTimeout(() => {
          el.style.outline = previous;
        }, 1600);
      }
      sendResponse({ ok: Boolean(el) });
      return false;
    }

    return false;
  });

  /* ---------------------------------------------------------------- *
   * Start
   * ---------------------------------------------------------------- */

  hookHistory();
  reportPage(true);

  const observer = new MutationObserver(scheduleScan);
  function observe() {
    if (!document.documentElement) return;
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'href', 'poster', 'style', 'class', ...LAZY_ATTRS],
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      // <title> does not exist yet at document_start, so report it again.
      reportPage(false);
      observe();
      scan();
    });
  } else {
    observe();
    scan();
  }
  window.addEventListener('load', () => {
    reportPage(false);
    scheduleScan();
  });
})();
