/**
 * Media type classification. Pure — no DOM, no chrome.
 */

export const IMAGE_EXT = new Set([
  'jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico', 'cur',
  'svg', 'tif', 'tiff', 'heic', 'heif', 'jxl', 'apng', 'jfif',
]);

export const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'ogv', 'mpg', 'mpeg', 'mp2',
  '3gp', '3g2', 'flv', 'f4v', 'wmv', 'ts', 'mts', 'm2ts',
]);

export const AUDIO_EXT = new Set([
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'wma', 'aiff',
  'aif', 'weba', 'mid', 'midi',
]);

export const STREAM_EXT = new Set(['m3u8', 'm3u', 'mpd']);

/** Tunables in exactly one place, per spec §4. */
export const FILTER_CONFIG = {
  /** Below this many bytes an image is treated as a candidate tracking pixel. */
  TRACKING_PIXEL_MAX_BYTES: 1024,
  /** ...and only if its rendered/natural size is at most this many px per side. */
  TRACKING_PIXEL_MAX_SIDE: 2,
  /** Sprite sheets and UI chrome below this size are hidden by default. */
  SPRITE_MAX_BYTES: 5 * 1024,
  /** Data URIs smaller than this are hidden from the default view. */
  DATA_URI_MIN_BYTES: 1024,
  /** Hard ceiling on the per-tab in-memory index. */
  MAX_ITEMS_PER_TAB: 4000,
  /** Similarity scoring is chunked to keep the main thread responsive. */
  SCORE_CHUNK_MS: 12,
  /** Pre-signed URLs expiring within this window trigger the warning banner. */
  EXPIRY_WARN_MS: 10 * 60 * 1000,
};

export const SIMILARITY_PRESETS = { loose: 0.45, balanced: 0.62, strict: 0.8 };

const EXT_RE = new RegExp(
  '\\.(' +
    [...IMAGE_EXT, ...VIDEO_EXT, ...AUDIO_EXT, ...STREAM_EXT].join('|') +
    ')(?:[?#]|$)',
  'i',
);

/** Path shapes used by media CDNs even when the URL carries no extension. */
const CDN_PATH_RE =
  /\/(?:images?|imgs?|photos?|pics?|media|assets|uploads?|files?|thumbs?|thumbnails?|videos?|vids?|audio|attachments?|content|cdn|static)\//i;

const CDN_HOST_RE =
  /(^|\.)(?:cdn|img|image|images|media|static|assets|photos?|video|videos|i|p|s\d*)\./i;

/** Extensions that are definitely not media, to kill CDN-shape false positives. */
const NON_MEDIA_EXT_RE =
  /\.(?:html?|php|aspx?|jsp|js|mjs|cjs|css|json|xml|txt|woff2?|ttf|eot|map|wasm|pdf|zip|gz|rar|7z)(?:[?#]|$)/i;

/**
 * @param {string} url
 * @returns {string} lower-case extension without the dot, or ''.
 */
export function extOf(url) {
  if (typeof url !== 'string') return '';
  const m = EXT_RE.exec(url);
  if (m) return m[1].toLowerCase();
  // Fall back to a plain path-tail read for extensions we do not know.
  const path = url.split(/[?#]/, 1)[0];
  const tail = path.slice(path.lastIndexOf('/') + 1);
  const dot = tail.lastIndexOf('.');
  if (dot <= 0 || dot === tail.length - 1) return '';
  const ext = tail.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : '';
}

/** @returns {'image'|'video'|'audio'|'stream'|''} */
export function kindFromExt(ext) {
  if (!ext) return '';
  if (STREAM_EXT.has(ext)) return 'stream';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return '';
}

/** @returns {'image'|'video'|'audio'|'stream'|''} */
export function kindFromMime(mime) {
  if (typeof mime !== 'string' || !mime) return '';
  const type = mime.split(';', 1)[0].trim().toLowerCase();
  if (
    type === 'application/vnd.apple.mpegurl' ||
    type === 'application/x-mpegurl' ||
    type === 'audio/mpegurl' ||
    type === 'audio/x-mpegurl' ||
    type === 'application/dash+xml'
  ) {
    return 'stream';
  }
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return '';
}

/** MIME subtype, e.g. `image/jpeg` -> `jpeg`. */
export function mimeSubtype(mime) {
  if (typeof mime !== 'string') return '';
  const type = mime.split(';', 1)[0].trim().toLowerCase();
  const slash = type.indexOf('/');
  return slash === -1 ? '' : type.slice(slash + 1);
}

/** MIME top-level type, e.g. `image/jpeg` -> `image`. */
export function mimeTopLevel(mime) {
  if (typeof mime !== 'string') return '';
  const type = mime.split(';', 1)[0].trim().toLowerCase();
  const slash = type.indexOf('/');
  return slash === -1 ? '' : type.slice(0, slash);
}

/**
 * Best-effort kind for a candidate. MIME wins over extension because
 * plenty of CDNs serve real media as application/octet-stream.
 * @param {{url?: string, mimeType?: string}} c
 */
export function classify(c) {
  const byMime = kindFromMime(c.mimeType);
  if (byMime) return byMime;
  return kindFromExt(extOf(c.url || ''));
}

/** Extension implied by a MIME type, used when the URL lies about the format. */
const MIME_EXT = {
  jpeg: 'jpg', jpg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', avif: 'avif',
  'svg+xml': 'svg', bmp: 'bmp', 'x-icon': 'ico', vnd_microsoft_icon: 'ico',
  tiff: 'tiff', heic: 'heic', heif: 'heif', mp4: 'mp4', webm: 'webm',
  quicktime: 'mov', 'x-matroska': 'mkv', 'x-msvideo': 'avi', ogg: 'ogg',
  mpeg: 'mp3', 'x-wav': 'wav', wav: 'wav', 'mp4a-latm': 'm4a', aac: 'aac',
  flac: 'flac', opus: 'opus', 'x-m4a': 'm4a',
};

export function extFromMime(mime) {
  const sub = mimeSubtype(mime).replace(/^x-/, (m) => m); // keep as-is, table has both
  return MIME_EXT[sub] || MIME_EXT[sub.replace(/^x-/, '')] || '';
}

/**
 * Does this string look like a media URL? Used to mine JSON payloads,
 * so it must be cheap and reject obvious non-media.
 * @param {unknown} s
 */
export function looksLikeMediaUrl(s) {
  if (typeof s !== 'string') return false;
  if (s.length < 8 || s.length > 4096) return false;
  if (!/^(?:https?:\/\/|\/\/|\/[^/])/.test(s)) return false;
  if (NON_MEDIA_EXT_RE.test(s)) return false;
  if (EXT_RE.test(s)) return true;
  if (!CDN_PATH_RE.test(s) && !CDN_HOST_RE.test(s)) return false;
  // CDN shape with no extension: require an opaque-looking last segment,
  // otherwise every /content/ article link would qualify.
  const path = s.split(/[?#]/, 1)[0];
  const tail = path.slice(path.lastIndexOf('/') + 1);
  return tail.length >= 8 && !tail.includes('.');
}

export function isDataUri(url) {
  return typeof url === 'string' && url.startsWith('data:');
}

export function isBlobUri(url) {
  return typeof url === 'string' && url.startsWith('blob:');
}

/** Rough byte size of a data: URI without materialising it. */
export function dataUriBytes(url) {
  if (!isDataUri(url)) return 0;
  const comma = url.indexOf(',');
  if (comma === -1) return 0;
  const payload = url.length - comma - 1;
  return url.slice(0, comma).includes(';base64')
    ? Math.floor(payload * 0.75)
    : payload;
}

export function dataUriMime(url) {
  if (!isDataUri(url)) return '';
  const head = url.slice(5, url.indexOf(',') === -1 ? undefined : url.indexOf(','));
  return head.split(';', 1)[0] || '';
}

/**
 * Junk filter shared by every layer. Returns a reason string when the
 * candidate should be dropped, or '' when it should be kept.
 * @param {object} c
 */
export function rejectionReason(c) {
  const bytes = Number.isFinite(c.bytes) ? c.bytes : null;
  const side = Math.max(c.width || 0, c.height || 0);
  if (
    bytes !== null &&
    bytes < FILTER_CONFIG.TRACKING_PIXEL_MAX_BYTES &&
    side > 0 &&
    side <= FILTER_CONFIG.TRACKING_PIXEL_MAX_SIDE
  ) {
    return 'tracking-pixel';
  }
  if (isDataUri(c.url)) {
    if (/^data:image\/(?:x-icon|vnd\.microsoft\.icon)/i.test(c.url)) return 'favicon';
    if (dataUriBytes(c.url) < FILTER_CONFIG.DATA_URI_MIN_BYTES) return 'tiny-data-uri';
  }
  if (/\/favicon\.(?:ico|png)(?:[?#]|$)/i.test(c.url || '')) return 'favicon';
  return '';
}
