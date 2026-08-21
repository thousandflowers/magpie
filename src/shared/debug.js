/**
 * The only place allowed to write to the console.
 * Flip DEBUG to true (or set `magpieDebug` in chrome.storage.local) while
 * developing; ships false so a normal install is silent.
 */

export let DEBUG = false;

const PREFIX = '[magpie]';

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
  try {
    chrome.storage.local.get('magpieDebug').then((v) => {
      DEBUG = Boolean(v && v.magpieDebug);
    }).catch(() => {});
  } catch {
    /* storage unavailable in this context */
  }
}

export function log(...args) {
  if (DEBUG) console.log(PREFIX, ...args);
}

export function warn(...args) {
  if (DEBUG) console.warn(PREFIX, ...args);
}

/** Errors are always reported — a silent failure is worse than a noisy one. */
export function error(...args) {
  console.error(PREFIX, ...args);
}

/** Run `fn`, log and swallow anything it throws. Returns `fallback` on failure. */
export function attempt(fn, fallback, context) {
  try {
    return fn();
  } catch (err) {
    warn(context || 'attempt failed', err);
    return fallback;
  }
}
