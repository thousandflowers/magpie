/**
 * Download pipeline: bounded concurrency, one request at a time per host,
 * exponential backoff, retries, and a hard stop.
 *
 * Nothing here starts on its own — every session is created by an explicit
 * user action (panel button or context menu).
 */

import { buildPath, tokensFor, applyTemplate } from '../core/filename.js';
import { expiryInfo } from '../core/url-normalize.js';
import { FILTER_CONFIG } from '../core/media-types.js';
import { STATUS } from '../shared/messages.js';
import { log, warn, error } from '../shared/debug.js';

const MAX_TRIES = 3;
const BASE_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 30_000;

/** How long the advisory HEAD probe may take before it is abandoned. */
const HEAD_TIMEOUT_MS = 6000;

/**
 * Statuses that mean the file is not there, as opposed to "not like that".
 * A 405 or a 403 to a HEAD says nothing about whether a GET would work.
 */
const GONE = new Set([404, 410]);

const RETRYABLE = new Set([
  'SERVER_FAILED', 'SERVER_NO_RANGE', 'SERVER_BAD_CONTENT', 'NETWORK_FAILED',
  'NETWORK_TIMEOUT', 'NETWORK_DISCONNECTED', 'FILE_TRANSIENT_ERROR',
  'FILE_TOO_SHORT', 'CRASH',
]);

/** @type {Map<string, object>} sessionId -> session */
const sessions = new Map();
/** @type {Map<number, {sessionId: string, jobId: string}>} chrome download id -> job */
const inflight = new Map();

let progressListener = null;
let sessionCounter = 0;

export function onProgress(fn) {
  progressListener = fn;
}

function emit(session) {
  // Every state change passes through here, which makes it the one place the
  // queue has to be written down so a terminated worker can pick it up again.
  persist();
  if (!progressListener) return;
  progressListener({
    sessionId: session.id,
    tabId: session.tabId,
    total: session.jobs.length,
    done: session.counts.done,
    failed: session.counts.failed,
    running: session.counts.running,
    stopped: session.stopped,
    finished: session.finished,
    expiringSoon: session.expiringSoon,
    errors: session.errors.slice(-5),
    sidecar: session.finished && session.writeSidecar ? buildSidecar(session) : null,
  });
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Order the queue: items whose signed URL expires soonest go first,
 * because a 10-minute S3 link will not survive a 400-item queue.
 */
function prioritise(jobs) {
  return jobs.slice().sort((a, b) => {
    const ea = a.expiresAt == null ? Infinity : a.expiresAt;
    const eb = b.expiresAt == null ? Infinity : b.expiresAt;
    if (ea !== eb) return ea - eb;
    return a.index - b.index;
  });
}

/**
 * @param {object} opts
 * @param {number} opts.tabId
 * @param {object[]} opts.items candidates to fetch
 * @param {string} opts.template filename template
 * @param {number} opts.concurrency
 * @param {object} opts.context {pageUrl, pageTitle, groupLabel}
 * @param {boolean} opts.useUpgrades prefer the verified upgrade URL
 * @param {boolean} opts.writeSidecar
 * @returns {{sessionId: string, total: number, skipped: number, expiringSoon: number}}
 */
export function startSession(opts) {
  const {
    tabId, items, template, concurrency = 4, context = {},
    useUpgrades = true, writeSidecar = false,
  } = opts;

  sessionCounter += 1;
  const id = `s${sessionCounter}-${Date.now()}`;
  const now = Date.now();

  const jobs = [];
  let skipped = 0;
  let expiringSoon = 0;

  const downloadable = items.filter((item) => {
    if (item.status === STATUS.PROTECTED) return false;   // DRM: never
    if (item.status === STATUS.UNAVAILABLE) return false;
    if (item.kind === 'stream') return false;             // manifests are not files
    return true;
  });
  skipped = items.length - downloadable.length;

  downloadable.forEach((item, index) => {
    const url = useUpgrades && item.upgradeVerified && item.upgradeUrl ? item.upgradeUrl : item.url;
    const { expiring, expiresAt } = expiryInfo(url);
    if (expiring && (expiresAt == null || expiresAt - now < FILTER_CONFIG.EXPIRY_WARN_MS)) {
      expiringSoon += 1;
    }
    jobs.push({
      jobId: `${id}-${index}`,
      item,
      url,
      index,
      host: hostOf(url),
      // Named after the URL actually fetched: when an upgrade wins, the file
      // holds the original, so calling it `photo-150x150.jpg` would be a lie.
      path: buildPath(
        { ...item, url },
        { ...context, index: index + 1, total: downloadable.length },
        template,
      ),
      tries: 0,
      state: 'queued',
      expiresAt: expiring ? expiresAt : null,
      downloadId: null,
      error: '',
    });
  });

  const session = {
    id,
    tabId,
    jobs: prioritise(jobs),
    concurrency: Math.max(1, Math.min(16, Number(concurrency) || 4)),
    activeHosts: new Set(),
    counts: { done: 0, failed: 0, running: 0 },
    errors: [],
    stopped: false,
    finished: false,
    startedAt: now,
    context,
    template,
    writeSidecar,
    expiringSoon,
  };
  sessions.set(id, session);
  log('download session', id, session.jobs.length, 'items');
  pump(session);
  emit(session);
  return { sessionId: id, total: session.jobs.length, skipped, expiringSoon };
}

export function stopSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.stopped = true;
  for (const job of session.jobs) {
    if (job.state === 'running' && job.downloadId != null) {
      chrome.downloads.cancel(job.downloadId).catch(() => {});
    }
    if (job.state === 'queued' || job.state === 'backoff') job.state = 'cancelled';
  }
  finishIfDone(session);
  emit(session);
  return true;
}

export function stopAll() {
  for (const id of sessions.keys()) stopSession(id);
}

/* ------------------------------------------------------------------ *
 * Surviving the worker
 *
 * An MV3 service worker is terminated after thirty seconds without an event,
 * and `chrome.downloads.onChanged` does not fire while bytes arrive - so one
 * large file is enough to end it. The queue lived only in the Map above, so
 * on the next wake the completion arrived for a session nobody remembered,
 * `pump()` was never called again, and the rest of the batch never started.
 * The panel sat at "4/50" for good, with no error anywhere.
 *
 * Only what is needed to finish the work and to write the sidecar is stored.
 * The items themselves are not: they can carry a structural path apiece, and
 * session storage is a 10 MB budget the index is already fighting for.
 * ------------------------------------------------------------------ */

const PERSIST_KEY = 'downloads';
const PERSIST_DEBOUNCE_MS = 250;
let persistTimer = null;

/** @param {object} job */
const packJob = (job) => ({
  jobId: job.jobId,
  url: job.url,
  index: job.index,
  host: job.host,
  path: job.path,
  tries: job.tries,
  state: job.state,
  expiresAt: job.expiresAt,
  downloadId: job.downloadId,
  error: job.error,
  // Exactly the fields buildSidecar reads back, and nothing else.
  item: {
    url: job.item.url,
    mimeType: job.item.mimeType || '',
    width: job.item.width || 0,
    height: job.item.height || 0,
    bytes: job.item.bytes == null ? null : job.item.bytes,
    status: job.item.status,
    sources: job.item.sources || [],
    frameOrigin: job.item.frameOrigin || '',
  },
});

const packSession = (session) => ({
  id: session.id,
  tabId: session.tabId,
  concurrency: session.concurrency,
  counts: session.counts,
  errors: session.errors,
  stopped: session.stopped,
  finished: session.finished,
  startedAt: session.startedAt,
  context: session.context,
  template: session.template,
  writeSidecar: session.writeSidecar,
  expiringSoon: session.expiringSoon,
  jobs: session.jobs.map(packJob),
});

/** activeHosts is derived, never stored: it is whatever is running. */
const unpackSession = (packed) => ({
  ...packed,
  activeHosts: new Set(packed.jobs.filter((j) => j.state === 'running').map((j) => j.host)),
});

/**
 * `globalThis.chrome`, or null. A bare `chrome` reference throws where the API
 * is absent - which is every unit test that does not install a stub, and any
 * future context that imports this module for its pure parts.
 */
const sessionStore = () => (globalThis.chrome && globalThis.chrome.storage
  ? globalThis.chrome.storage.session || null
  : null);

function persist() {
  const storage = sessionStore();
  if (persistTimer || !storage) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    const live = {};
    for (const [id, session] of sessions) {
      if (!session.finished) live[id] = packSession(session);
    }
    try {
      if (Object.keys(live).length) await storage.set({ [PERSIST_KEY]: live });
      else await storage.remove(PERSIST_KEY);
    } catch (err) {
      warn('could not remember the download queue', err);
    }
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Rebuild any unfinished session and carry on. Call once when the worker
 * starts, after installDownloadListeners.
 */
export async function resumeSessions() {
  const storage = sessionStore();
  if (!storage) return 0;
  let stored;
  try {
    stored = (await storage.get(PERSIST_KEY))[PERSIST_KEY];
  } catch (err) {
    warn('could not read the download queue back', err);
    return 0;
  }
  if (!stored || typeof stored !== 'object') return 0;

  let resumed = 0;
  for (const packed of Object.values(stored)) {
    if (!packed || sessions.has(packed.id)) continue;
    const session = unpackSession(packed);
    sessions.set(session.id, session);
    resumed += 1;

    // What became of the jobs that were in flight while we were away? Chrome
    // kept downloading them, so ask it rather than assume.
    for (const job of session.jobs) {
      if (job.state !== 'running' || job.downloadId == null) continue;
      inflight.set(job.downloadId, { sessionId: session.id, jobId: job.jobId });
      let found = null;
      try {
        [found] = await chrome.downloads.search({ id: job.downloadId });
      } catch {
        found = null;
      }
      if (!found) {
        // Chrome has no record of it: it never survived the restart either.
        inflight.delete(job.downloadId);
        completeJob(session, job, false, 'NETWORK_FAILED');
      } else if (found.state === 'complete') {
        inflight.delete(job.downloadId);
        completeJob(session, job, true, '');
      } else if (found.state === 'interrupted') {
        inflight.delete(job.downloadId);
        completeJob(session, job, false, found.error || 'INTERRUPTED');
      }
      // in_progress: leave it running, the listener will hear about it.
    }
    log('resumed download session', session.id, session.counts);
    pump(session);
    emit(session);
  }
  return resumed;
}

function nextJob(session) {
  for (const job of session.jobs) {
    if (job.state !== 'queued') continue;
    if (session.activeHosts.has(job.host)) continue; // sequential per host
    return job;
  }
  return null;
}

function pump(session) {
  if (session.finished) return;
  // A stopped session starts nothing more, but it still has to be able to
  // finish. Returning here before finishIfDone left every stopped session
  // pending forever: the panel's error list and its sidecar are both gated on
  // the terminal emit, so pressing Stop froze the counter and said nothing,
  // and reapSessions - which only collects finished sessions - leaked it for
  // the life of the worker.
  if (session.stopped) {
    finishIfDone(session);
    return;
  }
  while (session.counts.running < session.concurrency) {
    const job = nextJob(session);
    if (!job) break;
    startJob(session, job);
  }
  finishIfDone(session);
}

async function startJob(session, job) {
  job.state = 'running';
  job.tries += 1;
  session.counts.running += 1;
  session.activeHosts.add(job.host);

  try {
    const downloadId = await chrome.downloads.download({
      url: job.url,
      filename: job.path,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    job.downloadId = downloadId;
    inflight.set(downloadId, { sessionId: session.id, jobId: job.jobId });
  } catch (err) {
    // download() itself rejects for malformed filenames and blocked schemes.
    completeJob(session, job, false, String((err && err.message) || err));
  }
  emit(session);
}

function releaseHost(session, job) {
  session.activeHosts.delete(job.host);
}

function completeJob(session, job, ok, reason) {
  if (job.state === 'done' || job.state === 'failed') return;
  session.counts.running = Math.max(0, session.counts.running - 1);
  releaseHost(session, job);

  if (ok) {
    job.state = 'done';
    session.counts.done += 1;
    emit(session);
    pump(session);
    return;
  }

  // A download the user cancelled is not a download that failed. Stop cancels
  // every running job, Chrome answers each with USER_CANCELED, and every one
  // of them used to land in counts.failed and in the error list - so pressing
  // Stop on a four-wide session reported four failures the user had caused on
  // purpose.
  if (reason === 'USER_CANCELED' || session.stopped) {
    job.state = 'cancelled';
    emit(session);
    pump(session);
    return;
  }

  job.error = reason || 'unknown error';
  const retryable = RETRYABLE.has(reason) && job.tries < MAX_TRIES && !session.stopped;
  if (!retryable) {
    job.state = 'failed';
    session.counts.failed += 1;
    session.errors.push({ url: job.url, error: job.error });
    emit(session);
    pump(session);
    return;
  }

  job.state = 'backoff';
  scheduleRetry(session, job);
  emit(session);
  pump(session);
}

async function scheduleRetry(session, job) {
  let delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (job.tries - 1));
  // chrome.downloads reports transport failures, not HTTP status codes, so a
  // cheap HEAD tells us whether this is rate limiting and how long to wait.
  // A server that accepts the connection and never answers would otherwise
  // pin this job in `backoff` for good, and finishIfDone counts backoff as
  // pending - so the session hangs at N-1 of N and is never reaped. Same six
  // seconds upgrade-verify.js already uses.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HEAD_TIMEOUT_MS);
  try {
    const res = await fetch(job.url, { method: 'HEAD', credentials: 'include', signal: abort.signal });
    if (res.status === 429 || res.status === 503) {
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        delay = Math.min(MAX_BACKOFF_MS, retryAfter * 1000);
      } else {
        delay = Math.min(MAX_BACKOFF_MS, delay * 2);
      }
    } else if (GONE.has(res.status)) {
      // Only a status that says the file is not there justifies giving up on
      // a transport error. Plenty of CDNs answer 405 to HEAD, and some signed
      // URLs answer 403 to anything but GET, so treating every 4xx as fatal
      // failed downloads whose GET would have succeeded.
      job.state = 'failed';
      session.counts.failed += 1;
      session.errors.push({ url: job.url, error: `HTTP ${res.status}` });
      emit(session);
      pump(session);
      return;
    }
  } catch {
    /* HEAD is advisory; fall back to plain exponential backoff */
  } finally {
    clearTimeout(timer);
  }

  await sleep(delay);
  if (session.stopped || session.finished) return;
  job.state = 'queued';
  pump(session);
}

function finishIfDone(session) {
  if (session.finished) return;
  const pending = session.jobs.some(
    (j) => j.state === 'queued' || j.state === 'running' || j.state === 'backoff',
  );
  if (pending) return;
  session.finished = true;
  log('session finished', session.id, session.counts);
  // The panel only learns "done" (and gets the sidecar) from this emit.
  emit(session);
}

/** Reproducible record of one harvest. */
function buildSidecar(session) {
  return {
    tool: 'magpie',
    generatedAt: new Date().toISOString(),
    page: { url: session.context.pageUrl || '', title: session.context.pageTitle || '' },
    template: session.template,
    counts: session.counts,
    items: session.jobs.map((job) => ({
      path: job.path,
      sourceUrl: job.item.url,
      downloadedUrl: job.url,
      upgraded: job.url !== job.item.url,
      mimeType: job.item.mimeType || '',
      width: job.item.width || 0,
      height: job.item.height || 0,
      bytes: job.item.bytes || null,
      status: job.item.status,
      layer: (job.item.sources || []).join('+'),
      frameOrigin: job.item.frameOrigin || '',
      state: job.state,
      error: job.error || '',
    })),
  };
}

/** Wire chrome.downloads events to the queue. Call once from the SW. */
export function installDownloadListeners() {
  if (!chrome.downloads) {
    error('chrome.downloads unavailable — downloads disabled');
    return;
  }
  chrome.downloads.onChanged.addListener((delta) => {
    const ref = inflight.get(delta.id);
    if (!ref) return;
    const session = sessions.get(ref.sessionId);
    if (!session) {
      inflight.delete(delta.id);
      return;
    }
    const job = session.jobs.find((j) => j.jobId === ref.jobId);
    if (!job) return;

    if (delta.state && delta.state.current === 'complete') {
      inflight.delete(delta.id);
      completeJob(session, job, true, '');
    } else if (delta.state && delta.state.current === 'interrupted') {
      inflight.delete(delta.id);
      const reason = (delta.error && delta.error.current) || 'INTERRUPTED';
      completeJob(session, job, false, reason);
    }
  });
}

/** Filename preview for the panel, without starting anything. */
export function previewPath(item, context, template) {
  return applyTemplate(template, tokensFor(item, context));
}

export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

/** Drop finished sessions so the map cannot grow forever. */
export function reapSessions() {
  for (const [id, s] of sessions) {
    if (s.finished && Date.now() - s.startedAt > 10 * 60 * 1000) sessions.delete(id);
  }
}
