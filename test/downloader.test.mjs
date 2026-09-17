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

globalThis.chrome = {
  downloads: {
    download: async (opts) => {
      const id = nextDownloadId++;
      started.push({ id, ...opts });
      return id;
    },
    cancel: async (id) => { cancelled.push(id); },
    onChanged: { addListener: (fn) => { onChanged = fn; } },
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
