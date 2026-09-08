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

function nextJob(session) {
  for (const job of session.jobs) {
    if (job.state !== 'queued') continue;
    if (session.activeHosts.has(job.host)) continue; // sequential per host
    return job;
  }
  return null;
}

function pump(session) {
  if (session.stopped || session.finished) return;
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
  try {
    const res = await fetch(job.url, { method: 'HEAD', credentials: 'include' });
    if (res.status === 429 || res.status === 503) {
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        delay = Math.min(MAX_BACKOFF_MS, retryAfter * 1000);
      } else {
        delay = Math.min(MAX_BACKOFF_MS, delay * 2);
      }
    } else if (res.status >= 400 && res.status !== 429) {
      job.state = 'failed';
      session.counts.failed += 1;
      session.errors.push({ url: job.url, error: `HTTP ${res.status}` });
      emit(session);
      pump(session);
      return;
    }
  } catch {
    /* HEAD is advisory; fall back to plain exponential backoff */
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
