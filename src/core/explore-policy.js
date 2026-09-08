/**
 * What the explorer is allowed to touch. Pure — no DOM, no chrome — so the
 * safety rules can be tested directly.
 *
 * The asymmetry here is deliberate:
 *
 *  - Scrolling and following same-origin links are GET-shaped and reversible,
 *    so they are exhaustive by default.
 *  - Clicking is not. On a page where the user is signed in, an indiscriminate
 *    clicker eventually hits "Delete", "Pay" or "Log out". So a click needs a
 *    positive reason to believe it reveals media, and anything that smells
 *    transactional is refused outright. **Default is deny.**
 *
 * The word lists below are a real limitation, not a design flourish: they are
 * lexical, English and Italian only, and a button labelled only with an icon in
 * another language will simply not be clicked. That is the safe direction to
 * fail in. They live in one exported object so a new locale is a data change.
 */

/** Verbs that mean money, destruction, identity or publishing. Never clicked. */
export const RISK_WORDS = [
  // transactional
  'buy', 'purchase', 'checkout', 'pay', 'payment', 'order', 'subscribe',
  'book', 'reserve', 'donate', 'bid', 'compra', 'acquista', 'paga',
  'pagamento', 'ordina', 'abbonati', 'prenota', 'dona',
  // destructive
  'delete', 'remove', 'discard', 'clear', 'reset', 'cancel', 'unsubscribe',
  'block', 'report', 'elimina', 'cancella', 'rimuovi', 'annulla', 'segnala',
  'blocca', 'svuota',
  // identity
  'log out', 'logout', 'sign out', 'signout', 'log in', 'login', 'sign in',
  'signin', 'register', 'esci', 'accedi', 'registrati', 'disconnetti',
  // outward-facing
  'submit', 'send', 'post', 'reply', 'comment', 'publish', 'share', 'invite',
  'upload', 'follow', 'like', 'vote', 'confirm', 'apply', 'save', 'edit',
  'invia', 'pubblica', 'condividi', 'invita', 'carica file', 'commenta',
  'conferma', 'segui', 'salva', 'modifica',
  // starts a file transfer of its own
  'download', 'scarica', 'export', 'esporta', 'print', 'stampa',
];

/** Words that suggest the control reveals more media. Required for a click. */
export const OPPORTUNITY_WORDS = [
  'next', 'prev', 'previous', 'more', 'load more', 'show more', 'view more',
  'view all', 'see all', 'show all', 'expand', 'enlarge', 'zoom', 'full',
  'fullscreen', 'original', 'gallery', 'album', 'photos', 'pictures', 'images',
  'video', 'videos', 'media', 'slide', 'slideshow', 'carousel', 'thumbnail',
  'preview', 'open', 'continue', 'page',
  'avanti', 'successivo', 'successiva', 'precedente', 'altro', 'altre',
  'mostra', 'vedi tutto', 'vedi tutte', 'ingrandisci', 'espandi', 'galleria',
  'foto', 'immagini', 'video', 'anteprima', 'apri', 'continua', 'pagina',
];

export const EXPLORE_LIMITS = {
  /**
   * Scroll steps per page before giving up on an infinite feed. A step is most
   * of a viewport, so every lazy image on the way down actually intersects;
   * 120 of them cover a long feed without letting an endless one run forever.
   */
  MAX_SCROLL_STEPS: 120,
  /** Pause after each scroll step, for an IntersectionObserver to fire. */
  SCROLL_SETTLE_MS: 200,
  /** Clicks per page. A gallery needs many; a runaway loop must still end. */
  MAX_CLICKS: 60,
  /** Pages visited in one crawl. */
  MAX_PAGES: 40,
  /** Pause after a click or scroll, for lazy loading to start. */
  SETTLE_MS: 450,
  /** Consecutive rounds finding nothing new before a page is considered done. */
  DRY_ROUNDS: 2,
  /** Politeness gap between page navigations. */
  PAGE_DELAY_MS: 1200,
  /**
   * Wall-clock budget for one page's click rounds. A page thick with pointer
   * controls (a wiki, a shop) otherwise spends minutes clicking chrome that
   * reveals nothing, and the crawl never reaches page two.
   */
  MAX_PAGE_MS: 45_000,
};

function normalise(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Everything a person would read off the control, in one string.
 * @param {object} el element description
 */
export function accessibleText(el) {
  return normalise(
    [el.text, el.ariaLabel, el.title, el.alt, el.name, el.value]
      .filter(Boolean)
      .join(' '),
  );
}

/** Class and id tokens, which is where icon-only controls hide their meaning. */
function tokenText(el) {
  return normalise(`${el.className || ''} ${el.id || ''} ${el.testId || ''}`)
    .replace(/[-_/]+/g, ' ');
}

function matchesAny(haystack, words) {
  return words.some((word) => haystack.includes(word));
}

/**
 * @typedef {object} ElementDescription
 * @property {string} tag lower-case tag name
 * @property {string} [type] input/button type
 * @property {string} [role]
 * @property {string} [text] visible text
 * @property {string} [ariaLabel] @property {string} [title] @property {string} [alt]
 * @property {string} [name] @property {string} [value]
 * @property {string} [className] @property {string} [id] @property {string} [testId]
 * @property {string} [href] resolved absolute URL, when it is a link
 * @property {string} [target]
 * @property {boolean} [hasDownloadAttr]
 * @property {boolean} [insideForm]
 * @property {boolean} [insideLink] the control sits inside an <a href>
 * @property {boolean} [disabled]
 * @property {boolean} [visible]
 * @property {boolean} [containsMedia] the control wraps an img/video
 * @property {number} [area] rendered area in px²
 */

/**
 * Should the explorer click this element?
 * @param {ElementDescription} el
 * @returns {{click: boolean, reason: string}}
 */
export function shouldClick(el) {
  if (!el || typeof el !== 'object') return { click: false, reason: 'no element' };
  if (el.disabled) return { click: false, reason: 'disabled' };
  if (el.visible === false) return { click: false, reason: 'not visible' };
  if (!el.area || el.area < 64) return { click: false, reason: 'too small to be a control' };

  const tag = String(el.tag || '').toLowerCase();

  // Anything that can submit, type into, or upload is off limits, whatever it
  // is called.
  if (['input', 'textarea', 'select', 'option', 'label', 'form'].includes(tag)) {
    return { click: false, reason: 'form control' };
  }
  if (el.insideForm) return { click: false, reason: 'inside a form' };
  if (tag === 'button' && String(el.type || '').toLowerCase() === 'submit') {
    return { click: false, reason: 'submit button' };
  }
  if (el.hasDownloadAttr) return { click: false, reason: 'starts its own download' };
  if (String(el.target || '') === '_blank') return { click: false, reason: 'opens a new tab' };

  const words = accessibleText(el);
  const tokens = tokenText(el);
  if (matchesAny(words, RISK_WORDS) || matchesAny(tokens, RISK_WORDS)) {
    return { click: false, reason: 'reads as transactional or destructive' };
  }

  // A link that leaves the page is navigation, handled by the crawl queue —
  // not by clicking. The same goes for anything inside one: clicking the span
  // that wraps a site's logo is clicking the logo's link, and the crawl found
  // itself on a wiki's front page over and over.
  if (tag === 'a' && el.href && !/^javascript:/i.test(el.href)) {
    return { click: false, reason: 'link — queued for navigation instead' };
  }
  if (el.insideLink) return { click: false, reason: 'inside a link — navigation, not a control' };

  // Positive reason required from here on.
  if (el.containsMedia) return { click: true, reason: 'wraps media — likely opens it larger' };
  if (matchesAny(words, OPPORTUNITY_WORDS) || matchesAny(tokens, OPPORTUNITY_WORDS)) {
    return { click: true, reason: 'reads as a media control' };
  }
  if (['tab', 'button'].includes(String(el.role || '')) && matchesAny(tokens, OPPORTUNITY_WORDS)) {
    return { click: true, reason: 'media control by role' };
  }
  return { click: false, reason: 'no positive reason to believe it reveals media' };
}

/**
 * Should the crawl queue this link?
 * @param {string} href absolute URL
 * @param {string} pageUrl the page it was found on
 * @param {object} [el] optional element description, for the risk check
 * @returns {{follow: boolean, reason: string}}
 */
export function shouldFollow(href, pageUrl, el) {
  if (typeof href !== 'string' || !href) return { follow: false, reason: 'no href' };
  let target;
  let origin;
  try {
    target = new URL(href, pageUrl);
    origin = new URL(pageUrl);
  } catch {
    return { follow: false, reason: 'unparseable' };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { follow: false, reason: 'not http' };
  }
  if (target.origin !== origin.origin) return { follow: false, reason: 'different origin' };
  if (el && el.hasDownloadAttr) return { follow: false, reason: 'starts its own download' };

  // A link whose text is destructive is still destructive when followed:
  // /logout is a GET on most sites.
  if (el) {
    const words = accessibleText(el);
    const tokens = tokenText(el);
    if (matchesAny(words, RISK_WORDS) || matchesAny(tokens, RISK_WORDS)) {
      return { follow: false, reason: 'reads as transactional or destructive' };
    }
  }
  const path = normalise(target.pathname);
  if (matchesAny(path.replace(/[-_/]+/g, ' '), RISK_WORDS)) {
    return { follow: false, reason: 'path reads as transactional or destructive' };
  }
  return { follow: true, reason: 'same origin' };
}

/** Strip the fragment: /a#one and /a#two are the same document to a crawler. */
export function crawlKey(href, pageUrl) {
  try {
    const u = new URL(href, pageUrl);
    u.hash = '';
    return u.href;
  } catch {
    return '';
  }
}
