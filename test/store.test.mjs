import test from 'node:test';
import assert from 'node:assert/strict';

// The store talks to chrome.storage; give it an in-memory one before import.
const session = new Map();
const writes = [];
let slowWriteMs = 0;
globalThis.chrome = {
  storage: {
    session: {
      get: async (key) => (key == null ? Object.fromEntries(session) : { [key]: session.get(key) }),
      set: async (obj) => {
        writes.push(Object.keys(obj)[0]);
        await new Promise((r) => setTimeout(r, slowWriteMs));
        for (const [k, v] of Object.entries(obj)) session.set(k, structuredClone(v));
      },
      remove: async (keys) => { for (const k of [].concat(keys)) session.delete(k); },
    },
    local: { get: async () => ({}), set: async () => {} },
  },
  tabs: { query: async () => [] },
};

const {
  addCandidates, resetTab, beginNavigation, navigationOutcome, getTab, setPageInfo, patchTab, itemsOf, flush, findItem,
} = await import('../src/background/store.js');
const { FILTER_CONFIG } = await import('../src/core/media-types.js');

let nextTab = 100;
const image = (url, extra = {}) => ({ url, kind: 'image', mimeType: 'image/png', source: 'net', ...extra });
const liveUrls = (state) => itemsOf(state).map((i) => i.url);

test('a navigation started before the page reports keeps the new document\'s items', async () => {
  const tab = nextTab++;
  await setPageInfo(tab, { url: 'http://a.test/one' });
  await addCandidates(tab, [image('http://a.test/old.png')]);
  // tabs.onUpdated 'loading' opens a generation; the network batch lands first...
  await beginNavigation(tab);
  await addCandidates(tab, [image('http://a.test/new.png')]);
  // ...and only then does the page's document_start message reset.
  const state = await getTab(tab);
  await resetTab(tab, { url: 'http://a.test/two', olderThan: state.pendingGen });
  const after = await getTab(tab);
  assert.deepEqual(liveUrls(after), ['http://a.test/new.png']);
  assert.deepEqual(after.history.map((i) => i.url), ['http://a.test/old.png']);
  assert.equal(after.pendingGen, null);
  assert.equal(after.pageUrl, 'http://a.test/two');
});

test('without a pending generation a reset retires everything, as before', async () => {
  const tab = nextTab++;
  await addCandidates(tab, [image('http://a.test/x.png'), image('http://a.test/y.png')]);
  await resetTab(tab, { url: 'http://a.test/next' });
  const after = await getTab(tab);
  assert.deepEqual(liveUrls(after), []);
  assert.equal(after.history.length, 2);
});

test('two resets in a row do not empty the history', async () => {
  const tab = nextTab++;
  await addCandidates(tab, [image('http://a.test/kept.png')]);
  await resetTab(tab, { url: 'http://a.test/b' });
  await resetTab(tab, { url: 'http://a.test/b' }); // replaceState on load, or a redirect hop
  const after = await getTab(tab);
  assert.deepEqual(after.history.map((i) => i.url), ['http://a.test/kept.png']);
});

test('a load that never replaced the document settles without touching the index', async () => {
  const tab = nextTab++;
  await setPageInfo(tab, { url: 'http://a.test/gallery' });
  await addCandidates(tab, [image('http://a.test/g.png')]);
  await beginNavigation(tab);
  // A download link: 'complete' arrives with the same URL and no page report.
  assert.equal(await navigationOutcome(tab, 'http://a.test/gallery'), 'settled');
  const after = await getTab(tab);
  assert.deepEqual(liveUrls(after), ['http://a.test/g.png']);
  assert.equal(after.pendingGen, null);
  assert.equal(await navigationOutcome(tab, 'http://a.test/gallery'), 'none');
});

test('a document nobody reported from is flagged for the caller to reset', async () => {
  const tab = nextTab++;
  await setPageInfo(tab, { url: 'http://a.test/gallery' });
  await beginNavigation(tab);
  assert.equal(await navigationOutcome(tab, 'chrome://downloads/'), 'orphaned');
});

test('keepFlags carries the DRM flag across a same-document route change only', async () => {
  const tab = nextTab++;
  await patchTab(tab, { emeRequested: true });
  await resetTab(tab, { url: 'http://drm.test/title/2', keepFlags: true });
  assert.equal((await getTab(tab)).emeRequested, true);
  await resetTab(tab, { url: 'http://elsewhere.test/' });
  assert.equal((await getTab(tab)).emeRequested, false);
});

test('media indexed after the key-system request arrives protected', async () => {
  const tab = nextTab++;
  await patchTab(tab, { emeRequested: true });
  await addCandidates(tab, [
    { url: 'http://drm.test/seg.mp4', kind: 'video', source: 'net' },
    image('http://drm.test/poster.png'),
  ]);
  const state = await getTab(tab);
  assert.equal(state.items['http://drm.test/seg.mp4'].status, 'protected');
  assert.equal(state.items['http://drm.test/poster.png'].status, 'background');
});

test('data: URLs past the tab budget are refused and the tab says it is truncated', async () => {
  const tab = nextTab++;
  // Two of these fit under the budget together; a third does not.
  const half = Math.floor(FILTER_CONFIG.DATA_URI_TAB_BUDGET / 2) - 1024;
  const inline = (seed) => image(`data:image/png;base64,${seed.repeat(half)}`, { source: 'dom' });
  const result = await addCandidates(tab, [inline('A'), inline('B'), inline('C')]);
  assert.equal(result.added, 2);
  assert.equal(result.rejected, 1);
  assert.equal(result.truncated, true);
  // Retiring them frees the budget.
  await resetTab(tab, { keepHistory: false });
  assert.equal((await addCandidates(tab, [inline('D')])).added, 1);
});

test('flushes of one tab never overlap: changes during a write are written once, after it', async () => {
  const tab = nextTab++;
  await addCandidates(tab, [image('http://a.test/first.png')]);
  await flush(tab);
  writes.length = 0;
  slowWriteMs = 30;
  const first = flush(tab);
  for (let i = 0; i < 5; i += 1) {
    await addCandidates(tab, [image(`http://a.test/more-${i}.png`)]);
    flush(tab); // would have been five more concurrent writes
  }
  await first;
  await new Promise((r) => setTimeout(r, 80));
  slowWriteMs = 0;
  const ours = writes.filter((k) => k === `tab:${tab}`);
  assert.equal(ours.length, 2, `one write in flight plus one for what changed meanwhile, got ${ours.length}`);
  const stored = session.get(`tab:${tab}`);
  assert.equal(stored.order.length, 6, 'the second write carried every change');
});

test('structure is stored compactly and read back exactly', async () => {
  const tab = nextTab++;
  const structuralPath = [
    { tag: 'img', classes: ['grid-thumb', 'attachment-thumbnail'] },
    { tag: 'a', classes: ['gallery-link'] },
    { tag: 'li', classes: ['grid-item'] },
    { tag: 'body', classes: [] },
  ];
  const classCounts = { 'grid-thumb': 12, 'gallery-link': 12, 'grid-item': 12 };
  await addCandidates(tab, [image('http://a.test/t.png', { source: 'dom', structuralPath, classCounts, repeatDepth: 2 })]);
  const state = await getTab(tab);
  const stored = state.items['http://a.test/t.png'];
  assert.equal(stored.structuralPath, undefined, 'the stored item carries no object tree');
  assert.deepEqual(stored.path, ['img grid-thumb attachment-thumbnail', 'a gallery-link', 'li grid-item', 'body']);
  assert.equal(typeof stored.counts, 'string');
  const [read] = itemsOf(state);
  assert.deepEqual(read.structuralPath, structuralPath);
  assert.deepEqual(read.classCounts, classCounts);
  assert.equal(read.repeatDepth, 2);
  assert.deepEqual(findItem(state, 'http://a.test/t.png').structuralPath, structuralPath);
  // A second sighting merges through the same door and keeps the structure.
  await addCandidates(tab, [image('http://a.test/t.png', { source: 'net' })]);
  const [again] = itemsOf(await getTab(tab));
  assert.deepEqual(again.structuralPath, structuralPath);
  assert.deepEqual(again.sources, ['dom', 'net']);
});
