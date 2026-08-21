/**
 * Layer B — MAIN-world interceptor.
 *
 * Runs in the page's own realm at document_start, before page scripts, so it
 * can wrap fetch/XHR before anything uses them. It is a classic script in the
 * page world: it cannot import extension modules and cannot touch chrome.*,
 * so it carries its own loose URL matcher and posts everything it finds to
 * the ISOLATED world, which re-validates and forwards.
 *
 * The matcher here is deliberately permissive — it is a prefilter, not an
 * authority. src/core/media-types.js has the last word in the background.
 */

(() => {
  'use strict';

  const TOKEN = 'magpie:bridge:v1';
  const MEDIA_EXT_RE =
    /\.(?:jpe?g|png|gif|webp|avif|bmp|ico|svg|tiff?|heic|heif|jxl|mp4|m4v|webm|mkv|mov|avi|ogv|mpe?g|3gp|flv|ts|mp3|wav|ogg|oga|m4a|aac|flac|opus|wma|m3u8|mpd)(?:[?#]|$)/i;
  const CDN_SHAPE_RE =
    /\/(?:images?|imgs?|photos?|pics?|media|assets|uploads?|thumbs?|thumbnails?|videos?|vids?|audio|attachments?|cdn)\//i;
  const NON_MEDIA_RE = /\.(?:html?|php|aspx?|jsp|m?js|css|json|txt|woff2?|ttf|map|wasm|pdf)(?:[?#]|$)/i;

  const MAX_JSON_BYTES = 4 * 1024 * 1024;
  const MAX_WALK_NODES = 20000;
  const MAX_WALK_DEPTH = 12;
  const FLUSH_MS = 200;
  const MAX_BATCH = 400;

  /** URLs already reported, so a chatty feed does not resend the same asset. */
  const seen = new Set();
  let pending = [];
  let flushTimer = null;

  function post(type, items, detail) {
    try {
      window.postMessage({ token: TOKEN, type, items: items || [], detail: detail || '' }, '*');
    } catch {
      /* a page may have frozen structuredClone-hostile objects; ignore */
    }
  }

  function flush() {
    flushTimer = null;
    if (!pending.length) return;
    const batch = pending.slice(0, MAX_BATCH);
    pending = pending.slice(MAX_BATCH);
    post('candidates', batch);
    if (pending.length) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function report(url, extra) {
    if (typeof url !== 'string' || url.length < 8 || url.length > 4096) return;
    if (seen.has(url)) return;
    seen.add(url);
    pending.push({ url, origin: 'main', ...(extra || {}) });
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function looksLikeMedia(value) {
    if (typeof value !== 'string') return false;
    if (value.length < 8 || value.length > 4096) return false;
    if (!/^(?:https?:\/\/|\/\/|\/[^/])/.test(value)) return false;
    if (NON_MEDIA_RE.test(value)) return false;
    if (MEDIA_EXT_RE.test(value)) return true;
    if (!CDN_SHAPE_RE.test(value)) return false;
    const path = value.split(/[?#]/, 1)[0];
    const tail = path.slice(path.lastIndexOf('/') + 1);
    return tail.length >= 8 && !tail.includes('.');
  }

  /**
   * Walk a parsed JSON body and report every string that looks like media.
   * This is the whole point of Layer B: in an SPA the media never reaches
   * the DOM until something scrolls.
   */
  function walk(value, baseUrl) {
    let nodes = 0;
    const stack = [[value, 0]];
    while (stack.length) {
      const [node, depth] = stack.pop();
      if (nodes++ > MAX_WALK_NODES || depth > MAX_WALK_DEPTH) return;
      if (typeof node === 'string') {
        if (looksLikeMedia(node)) {
          try {
            report(new URL(node, baseUrl || location.href).href, { via: 'json' });
          } catch {
            report(node, { via: 'json' });
          }
        }
        continue;
      }
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (const child of node) stack.push([child, depth + 1]);
        continue;
      }
      for (const key of Object.keys(node)) stack.push([node[key], depth + 1]);
    }
  }

  function isJsonType(contentType) {
    return typeof contentType === 'string' && /\bjson\b|\+json/i.test(contentType);
  }

  /* ---------------------------------------------------------------- *
   * fetch
   * ---------------------------------------------------------------- */

  let ourFetch = null;

  function installFetchHook() {
    const original = window.fetch;
    if (typeof original !== 'function' || original === ourFetch) return;
    const nativeFetch = original;

    ourFetch = function magpieFetch(...args) {
      const result = nativeFetch.apply(this, args);
      if (!result || typeof result.then !== 'function') return result;
      return result.then((response) => {
        try {
          inspectResponse(response);
        } catch {
          /* never let instrumentation break the page */
        }
        return response;
      });
    };
    try {
      Object.defineProperty(ourFetch, 'name', { value: 'fetch' });
      Object.defineProperty(ourFetch, 'toString', {
        value: () => nativeFetch.toString(),
        configurable: true,
      });
      window.fetch = ourFetch;
    } catch {
      /* a page may have made fetch non-writable */
    }
  }

  function inspectResponse(response) {
    if (!response || typeof response.clone !== 'function') return;
    const contentType = response.headers && response.headers.get('content-type');
    if (contentType && !isJsonType(contentType)) {
      if (/^(?:image|video|audio)\//i.test(contentType) && response.url) {
        report(response.url, { via: 'fetch', mimeType: contentType.split(';')[0].trim() });
      }
      return;
    }
    const length = Number(response.headers && response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_JSON_BYTES) return;

    let clone;
    try {
      clone = response.clone();
    } catch {
      return; // body already consumed or not cloneable
    }
    clone
      .text()
      .then((text) => {
        if (text.length > MAX_JSON_BYTES) return;
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        walk(parsed, response.url || location.href);
      })
      .catch(() => {});
  }

  /* ---------------------------------------------------------------- *
   * XMLHttpRequest
   * ---------------------------------------------------------------- */

  function installXhrHook() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto || proto.__magpieHooked) return;

    const originalOpen = proto.open;
    const originalSend = proto.send;

    proto.open = function magpieOpen(method, url, ...rest) {
      try {
        this.__magpieUrl = String(url);
      } catch {
        /* frozen instance */
      }
      return originalOpen.call(this, method, url, ...rest);
    };

    proto.send = function magpieSend(...args) {
      try {
        this.addEventListener('load', () => {
          try {
            const contentType = this.getResponseHeader && this.getResponseHeader('content-type');
            if (!isJsonType(contentType)) {
              if (contentType && /^(?:image|video|audio)\//i.test(contentType)) {
                report(this.responseURL || this.__magpieUrl, { via: 'xhr' });
              }
              return;
            }
            let body = null;
            if (this.responseType === 'json') body = this.response;
            else if (!this.responseType || this.responseType === 'text') {
              if (this.responseText && this.responseText.length <= MAX_JSON_BYTES) {
                body = JSON.parse(this.responseText);
              }
            }
            if (body) walk(body, this.responseURL || this.__magpieUrl || location.href);
          } catch {
            /* malformed JSON, cross-origin restrictions: not our problem */
          }
        });
      } catch {
        /* listener could not be attached */
      }
      return originalSend.apply(this, args);
    };

    try {
      Object.defineProperty(proto, '__magpieHooked', { value: true, enumerable: false });
    } catch {
      /* best effort */
    }
  }

  /* ---------------------------------------------------------------- *
   * Blob URLs, MSE and EME
   * ---------------------------------------------------------------- */

  function installObjectUrlHook() {
    const original = URL.createObjectURL;
    if (typeof original !== 'function' || original.__magpie) return;

    const wrapped = function createObjectURL(object) {
      const url = original.call(this, object);
      try {
        const isMediaSource =
          typeof MediaSource !== 'undefined' && object instanceof MediaSource;
        const isBlob = typeof Blob !== 'undefined' && object instanceof Blob;
        if (isMediaSource) {
          // An MSE blob is a live stream, not a file: reporting it as a
          // downloadable URL would hand the user a broken link.
          report(url, { via: 'mse', kind: 'stream', mediaSource: true });
        } else if (isBlob && /^(?:image|video|audio)\//i.test(object.type || '')) {
          report(url, {
            via: 'blob',
            mimeType: object.type,
            bytes: object.size,
          });
        }
      } catch {
        /* never interfere with the page's own blob handling */
      }
      return url;
    };
    try {
      Object.defineProperty(wrapped, '__magpie', { value: true });
      URL.createObjectURL = wrapped;
    } catch {
      /* read-only in some hardened pages */
    }
  }

  function installMseHook() {
    if (typeof MediaSource === 'undefined' || !MediaSource.prototype) return;
    const proto = MediaSource.prototype;
    if (proto.__magpieHooked) return;
    const original = proto.addSourceBuffer;
    proto.addSourceBuffer = function magpieAddSourceBuffer(mimeType) {
      try {
        post('mse', [], String(mimeType || ''));
      } catch {
        /* ignore */
      }
      return original.apply(this, arguments);
    };
    try {
      Object.defineProperty(proto, '__magpieHooked', { value: true, enumerable: false });
    } catch {
      /* best effort */
    }
  }

  /**
   * EME detection. Magpie never touches keys or key systems — this hook
   * exists solely so protected media can be marked and its download
   * controls disabled.
   */
  function installEmeHook() {
    if (!navigator.requestMediaKeySystemAccess) return;
    const original = navigator.requestMediaKeySystemAccess.bind(navigator);
    if (original.__magpie) return;
    const wrapped = function requestMediaKeySystemAccess(keySystem, configs) {
      try {
        post('eme', [], String(keySystem || ''));
      } catch {
        /* ignore */
      }
      return original(keySystem, configs);
    };
    try {
      Object.defineProperty(wrapped, '__magpie', { value: true });
      navigator.requestMediaKeySystemAccess = wrapped;
    } catch {
      /* ignore */
    }
  }

  /* ---------------------------------------------------------------- *
   * SPA routing
   *
   * history.pushState must be wrapped here, in the page's own realm: the
   * ISOLATED world has a separate JS context, so a wrapper installed there
   * never sees a call made by page code.
   * ---------------------------------------------------------------- */

  function installHistoryHook() {
    for (const name of ['pushState', 'replaceState']) {
      const original = history[name];
      if (typeof original !== 'function' || original.__magpie) continue;
      const wrapped = function magpieHistory(...args) {
        const result = original.apply(this, args);
        // location is only updated once the call returns.
        setTimeout(() => post('route', [], location.href), 0);
        return result;
      };
      try {
        Object.defineProperty(wrapped, '__magpie', { value: true });
        history[name] = wrapped;
      } catch {
        /* history may be frozen */
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Install, and re-assert if the page overwrites us
   * ---------------------------------------------------------------- */

  function installAll() {
    installFetchHook();
    installXhrHook();
    installHistoryHook();
    installObjectUrlHook();
    installMseHook();
    installEmeHook();
  }

  installAll();

  // Frameworks that polyfill fetch after us would otherwise blind Layer B.
  document.addEventListener('readystatechange', () => {
    if (window.fetch !== ourFetch) installFetchHook();
    installXhrHook();
  }, true);

  window.addEventListener('pageshow', installAll, true);
})();
