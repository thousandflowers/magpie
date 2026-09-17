/**
 * The download queue, and what happens when you press Stop.
 *
 * The panel learns everything it shows - the progress line, the error list,
 * the sidecar - from the queue's terminal emit. A session that never reaches
 * `finished` leaves the user looking at a frozen counter with no way to know
 * what happened, which is worse than a reported failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// chrome.downloads, in memory. Nothing is written and nothing is fetched:
// download() hands back an id, and the test decides what becomes of it.
let nextDownloadId = 1;
const started = [];
const cancelled = [];
let onChanged = null;

/** What chrome.downloads.search will say about each id. */
const downloadState = new Map();
const store = new Map();

globalThis.chrome = {
  downloads: {
    download: async (opts) => {
      const id = nextDownloadId++;
      started.push({ id, ...opts });
      downloadState.set(id, { id, state: 'in_progress' });
      return id;
    },
    cancel: async (id) => { cancelled.push(id); },
    search: async ({ id }) => (downloadState.has(id) ? [downloadState.get(id)] : []),
    onChanged: { addListener: (fn) => { onChanged = fn; } },
  },
  storage: {
    session: {
      get: async (key) => ({ [key]: store.get(key) }),
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v)); },
      remove: async (keys) => { for (const k of [].concat(keys)) store.delete(k); },
    },
  },
  runtime: { lastError: null },
};

const {
  startSession, stopSession, getSession, onProgress, installDownloadListeners,
} = await import('../src/background/downloader.js');

installDownloadListeners();

/** What Chrome sends when a download ends. */
const interrupt = (id, error) => onChanged({ id, state: { current: 'interrupted' }, error: { current: error } });
const complete = (id) => onChanged({ id, state: { current: 'complete' } });

/** One photo per host, so the per-host pacing does not serialise the test. */
const photos = (n) => Array.from({ length: n }, (_, i) => ({
  id: `i${i}`,
  url: `https://cdn${i}.example.com/photo-${i}.jpg`,
  normalizedUrl: `https://cdn${i}.example.com/photo-${i}.jpg`,
  kind: 'image',
  mimeType: 'image/jpeg',
  status: 'referenced',
}));

const settle = () => new Promise((r) => setTimeout(r, 20));

test('a stopped session still reaches "finished", so the panel is told', async () => {
  started.length = 0;
  cancelled.length = 0;
  const seen = [];
  onProgress((p) => seen.push(p));

  const { sessionId, total } = startSession({
    tabId: 1, items: photos(4), template: 'x/{index}.{ext}', concurrency: 4, context: {},
  });
  assert.equal(total, 4);
  await settle();
  assert.equal(started.length, 4, 'all four started - one host each');

  stopSession(sessionId);
  assert.equal(cancelled.length, 4);
  // Chrome answers each cancel with an interruption, after the fact.
  for (const d of started) interrupt(d.id, 'USER_CANCELED');
  await settle();

  const session = getSession(sessionId);
  assert.equal(session.finished, true, 'the session never finished, so there was no terminal emit');
  assert.ok(seen.some((p) => p.finished), 'the panel was never told the session ended');
});

test('pressing Stop does not report the cancelled downloads as failures', async () => {
  started.length = 0;
  cancelled.length = 0;
  onProgress(() => {});

  const { sessionId } = startSession({
    tabId: 2, items: photos(3), template: 'x/{index}.{ext}', concurrency: 3, context: {},
  });
  await settle();
  stopSession(sessionId);
  for (const d of started) interrupt(d.id, 'USER_CANCELED');
  await settle();

  const session = getSession(sessionId);
  assert.equal(session.counts.failed, 0, `cancelling counted ${session.counts.failed} failures`);
  assert.deepEqual(session.errors, [], 'cancelling wrote errors the user did not cause');
});

test('a real failure is still a failure', async () => {
  started.length = 0;
  onProgress(() => {});

  const { sessionId } = startSession({
    tabId: 3, items: photos(2), template: 'x/{index}.{ext}', concurrency: 2, context: {},
  });
  await settle();
  complete(started[0].id);
  interrupt(started[1].id, 'FILE_ACCESS_DENIED');
  await settle();

  const session = getSession(sessionId);
  assert.equal(session.counts.done, 1);
  assert.equal(session.counts.failed, 1);
  assert.equal(session.errors.length, 1);
  assert.equal(session.finished, true);
});

/* ------------------------------------------------------------------ *
 * The worker dies mid-batch
 *
 * An MV3 service worker is terminated after 30 seconds without an event, and
 * chrome.downloads.onChanged does not fire for progress - so one large file
 * is enough. The queue lived in a module-level Map, so on the next wake the
 * completion was dropped, pump() was never called again, and the remaining
 * items never started: the panel sat at "4/50" for good, with no error
 * anywhere.
 * ------------------------------------------------------------------ */

test('a batch survives the worker being terminated mid-download', async () => {
  started.length = 0;
  onProgress(() => {});

  const { sessionId } = startSession({
    tabId: 9, items: photos(5), template: 'x/{index}.{ext}', concurrency: 2, context: {},
  });
  await settle();
  assert.equal(started.length, 2, 'two running, three still queued');

  // One finishes while the worker is still alive; one finishes while it is
  // not, which is the case that used to be lost entirely.
  complete(started[0].id);
  downloadState.set(started[0].id, { id: started[0].id, state: 'complete' });
  await settle();
  downloadState.set(started[1].id, { id: started[1].id, state: 'complete' });

  // The queue is written down on a short debounce; a real worker dies thirty
  // seconds in, so waiting for the write is not cheating.
  await new Promise((r) => setTimeout(r, 400));

  // A fresh module instance is a fresh worker: same storage, no memory.
  const startedBefore = started.length;
  const fresh = await import('../src/background/downloader.js?worker=2');
  fresh.installDownloadListeners();
  await fresh.resumeSessions();
  await settle();

  const session = fresh.getSession(sessionId);
  assert.ok(session, 'the session was not restored at all');
  assert.equal(session.counts.done, 2,
    `the completion that landed while the worker was gone was lost (done=${session.counts.done})`);
  assert.ok(started.length > startedBefore,
    'no queued item was started after the restart - the batch was stuck for good');
});
