/**
 * The explorer's safety rules.
 *
 * This is the one part of Magpie that acts on a live page on its own, on an app
 * where the user may be signed in. The tests below are mostly about what it
 * must REFUSE to touch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  linkPriority,
  shouldClick, shouldFollow, crawlKey, accessibleText,
  RISK_WORDS, OPPORTUNITY_WORDS, EXPLORE_LIMITS,
} from '../src/core/explore-policy.js';

/** A plausible, clickable, unlabelled control. */
const base = { tag: 'button', visible: true, area: 900 };
const el = (patch) => ({ ...base, ...patch });

/* ------------------------- refusals ------------------------- */

test('a control with no positive reason is not clicked', () => {
  const { click, reason } = shouldClick(el({ text: 'Continue reading' }));
  assert.equal(click, true, 'this one does read as a media control');
  assert.equal(shouldClick(el({ text: 'Xyzzy' })).click, false);
  assert.match(shouldClick(el({ text: 'Xyzzy' })).reason, /no positive reason/);
  assert.ok(reason);
});

test('form controls are never clicked, whatever they are called', () => {
  for (const tag of ['input', 'textarea', 'select', 'option', 'label', 'form']) {
    assert.equal(shouldClick(el({ tag, text: 'show all photos' })).click, false, tag);
  }
  assert.equal(shouldClick(el({ insideForm: true, text: 'view gallery' })).click, false);
  assert.equal(shouldClick(el({ type: 'submit', text: 'next' })).click, false);
});

test('transactional and destructive labels are refused even when media-shaped', () => {
  const cases = [
    'Buy now', 'Checkout', 'Pay', 'Delete photo', 'Remove from album',
    'Log out', 'Sign in', 'Submit', 'Publish', 'Share', 'Report',
    'Compra ora', 'Elimina foto', 'Paga', 'Esci', 'Pubblica', 'Segnala',
  ];
  for (const text of cases) {
    assert.equal(shouldClick(el({ text })).click, false, text);
  }
  // Even wrapping an image does not buy an exception.
  assert.equal(shouldClick(el({ text: 'Delete', containsMedia: true })).click, false);
  assert.equal(shouldClick(el({ className: 'btn btn-delete', containsMedia: true })).click, false);
});

test('a control that starts its own transfer or leaves the tab is refused', () => {
  assert.equal(shouldClick(el({ text: 'view gallery', hasDownloadAttr: true })).click, false);
  assert.equal(shouldClick(el({ text: 'view gallery', target: '_blank' })).click, false);
  assert.equal(shouldClick(el({ text: 'Download', containsMedia: true })).click, false);
});

test('invisible, disabled and hairline elements are skipped', () => {
  assert.equal(shouldClick(el({ text: 'next', visible: false })).click, false);
  assert.equal(shouldClick(el({ text: 'next', disabled: true })).click, false);
  assert.equal(shouldClick(el({ text: 'next', area: 12 })).click, false);
  assert.equal(shouldClick(null).click, false);
});

test('a real link is left to the crawl queue, not clicked', () => {
  const link = el({ tag: 'a', href: 'https://e.com/gallery/2', text: 'next page' });
  const { click, reason } = shouldClick(link);
  assert.equal(click, false);
  assert.match(reason, /queued for navigation/);
});

/* ------------------------- permissions ------------------------- */

test('media controls are clicked', () => {
  const cases = [
    'Next', 'Load more', 'Show more', 'View all photos', 'Enlarge', 'Zoom',
    'Open gallery', 'Slideshow', 'Page 2',
    'Avanti', 'Mostra altro', 'Vedi tutte', 'Ingrandisci', 'Galleria',
  ];
  for (const text of cases) {
    assert.equal(shouldClick(el({ text })).click, true, text);
  }
});

test('an icon-only control is read from its class and id', () => {
  assert.equal(shouldClick(el({ className: 'carousel-next-arrow' })).click, true);
  assert.equal(shouldClick(el({ id: 'gallery-expand' })).click, true);
  assert.equal(shouldClick(el({ className: 'sc-a1b2c3' })).click, false, 'a hashed class says nothing');
});

test('a thumbnail wrapped in a button is clicked, because that opens the big one', () => {
  assert.equal(shouldClick(el({ containsMedia: true })).click, true);
  assert.equal(shouldClick(el({ tag: 'div', role: 'button', containsMedia: true })).click, true);
});

test('accessibleText reads every label a person would', () => {
  assert.equal(
    accessibleText({ text: 'Next', ariaLabel: 'Next photo', title: 'go on' }),
    'next next photo go on',
  );
  assert.equal(accessibleText({}), '');
});

/* ------------------------- navigation ------------------------- */

test('only same-origin http links are followed', () => {
  const page = 'https://shop.example.com/gallery';
  assert.equal(shouldFollow('/gallery/2', page).follow, true);
  assert.equal(shouldFollow('https://shop.example.com/a', page).follow, true);
  assert.equal(shouldFollow('https://other.example.com/a', page).follow, false);
  assert.equal(shouldFollow('https://cdn.shop.example.com/a', page).follow, false, 'subdomain is another origin');
  assert.equal(shouldFollow('mailto:a@b.c', page).follow, false);
  assert.equal(shouldFollow('javascript:void 0', page).follow, false);
  assert.equal(shouldFollow('', page).follow, false);
});

test('a destructive link is not followed — /logout is a GET on most sites', () => {
  const page = 'https://app.example.com/photos';
  assert.equal(shouldFollow('/logout', page).follow, false);
  assert.equal(shouldFollow('/account/delete', page).follow, false);
  assert.equal(shouldFollow('/checkout', page).follow, false);
  assert.equal(shouldFollow('/esci', page).follow, false);
  assert.equal(
    shouldFollow('/x', page, { text: 'Delete everything' }).follow, false,
    'the label counts even when the path looks innocent',
  );
  assert.equal(shouldFollow('/photos/2', page).follow, true);
});

test('crawlKey ignores the fragment', () => {
  assert.equal(crawlKey('/a#one', 'https://e.com/'), 'https://e.com/a');
  assert.equal(crawlKey('/a#two', 'https://e.com/'), 'https://e.com/a');
  assert.notEqual(crawlKey('/a?p=1', 'https://e.com/'), crawlKey('/a?p=2', 'https://e.com/'));
  // A garbage relative path still resolves; shouldFollow is what rejects it.
  assert.equal(crawlKey('::::', 'https://e.com/'), 'https://e.com/::::');
  assert.equal(shouldFollow('::::', 'https://e.com/').follow, true, 'same origin, but junk');
  assert.equal(crawlKey('http://[', 'https://e.com/'), '', 'genuinely unparseable');
  assert.equal(crawlKey('', ''), '');
});

/* ------------------------- shape ------------------------- */

test('the word lists and limits are present and bounded', () => {
  assert.ok(RISK_WORDS.length > 20);
  assert.ok(OPPORTUNITY_WORDS.length > 20);
  for (const [key, value] of Object.entries(EXPLORE_LIMITS)) {
    assert.ok(Number.isFinite(value) && value > 0, `${key} must be a positive number`);
  }
  assert.ok(EXPLORE_LIMITS.MAX_PAGES <= 100, 'a crawl must be bounded');
});

test('no word appears in both lists, which would make the outcome arbitrary', () => {
  const risky = new Set(RISK_WORDS);
  const overlap = OPPORTUNITY_WORDS.filter((w) => risky.has(w));
  assert.deepEqual(overlap, [], `overlapping: ${overlap.join(', ')}`);
});

test('a control inside a link is the link, and is left to the crawl queue', () => {
  // The span wrapping a site logo wraps an image, which is otherwise a
  // positive reason to click - and its <a> goes to the front page.
  const { click, reason } = shouldClick(el({ tag: 'span', containsMedia: true, insideLink: true }));
  assert.equal(click, false);
  assert.match(reason, /inside a link/);
  assert.equal(shouldClick(el({ tag: 'span', text: 'show more photos', insideLink: true })).click, false);
  assert.equal(shouldClick(el({ tag: 'span', containsMedia: true, insideLink: false })).click, true);
});

test('a link whose query is an action is refused as its path would be', () => {
  const page = 'https://wiki.example.org/wiki/Category:Birds';
  assert.equal(shouldFollow('https://wiki.example.org/w/index.php?title=Category_talk:Birds&action=edit', page).follow, false);
  assert.equal(shouldFollow('https://wiki.example.org/w/index.php?title=Category:Birds&oldid=5', page).follow, true);
});

test('links most like the start page are visited first', () => {
  const start = 'https://wiki.example.org/wiki/Category:Pica_pica';
  const nextPage = linkPriority('https://wiki.example.org/w/index.php?title=Category:Pica_pica&filefrom=Z', start, { text: 'next page' });
  const subAlbum = linkPriority('https://wiki.example.org/wiki/Category:Pica_pica_in_art', start, { text: 'Pica pica in art' });
  const frontPage = linkPriority('https://wiki.example.org/wiki/Main_Page', start, { text: 'Main page' });
  const help = linkPriority('https://wiki.example.org/wiki/Help:Contents', start, { text: 'Help' });
  const random = linkPriority('https://wiki.example.org/wiki/Special:Random/File', start, { text: 'Random file' });
  assert.ok(subAlbum > frontPage && nextPage > frontPage, `sub ${subAlbum} next ${nextPage} front ${frontPage}`);
  assert.ok(subAlbum > help && nextPage > help && frontPage >= random, `help ${help} random ${random}`);
  assert.equal(linkPriority('/wiki/X', 'not a url'), 0); // no start page to compare against
});

test('a closed disclosure is opened whatever it is called; an open or risky one is not', () => {
  assert.equal(shouldClick(el({ text: 'Specifiche', role: 'tab', ariaSelected: 'false' })).click, true);
  assert.equal(shouldClick(el({ text: 'Panoramica', role: 'tab', ariaSelected: 'true' })).click, false, 'already selected');
  assert.equal(shouldClick(el({ text: 'Note tecniche', ariaExpanded: 'false', ariaControls: true })).click, true);
  assert.equal(shouldClick(el({ text: 'Note tecniche', ariaExpanded: 'true', ariaControls: true })).click, false, 'already open');
  assert.equal(shouldClick(el({ tag: 'summary', text: 'Materiali', ariaExpanded: 'false' })).click, true);
  assert.equal(shouldClick(el({ text: 'Menu', ariaHasPopup: 'true' })).click, true);
  assert.equal(shouldClick(el({ text: 'Elimina raccolta', ariaExpanded: 'false', ariaControls: true })).click, false, 'risk words win');
  assert.equal(shouldClick(el({ text: 'Xyzzy' })).click, false, 'a plain button still needs a reason');
});
