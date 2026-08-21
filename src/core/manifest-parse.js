/**
 * HLS and DASH manifest parsing. Hand-rolled, no dependencies.
 *
 * Magpie never decrypts anything: the only reason encryption is parsed at all
 * is to mark the item `protected` and disable its controls (see README §DRM).
 */

import { toURL } from './url-normalize.js';

function resolve(url, base) {
  const u = toURL(url, base);
  return u ? u.href : url;
}

/** `KEY=VALUE,KEY="V,ALUE"` attribute lists, quotes respected. */
function parseAttributes(line) {
  const attrs = {};
  let i = 0;
  while (i < line.length) {
    const eq = line.indexOf('=', i);
    if (eq === -1) break;
    const key = line.slice(i, eq).trim();
    let value;
    let j = eq + 1;
    if (line[j] === '"') {
      const end = line.indexOf('"', j + 1);
      value = end === -1 ? line.slice(j + 1) : line.slice(j + 1, end);
      j = end === -1 ? line.length : end + 1;
    } else {
      const comma = line.indexOf(',', j);
      value = comma === -1 ? line.slice(j) : line.slice(j, comma);
      j = comma === -1 ? line.length : comma;
    }
    if (key) attrs[key.toUpperCase()] = value.trim();
    i = j + 1;
  }
  return attrs;
}

/**
 * @typedef {object} StreamInfo
 * @property {'hls'|'dash'} type
 * @property {boolean} master        true when this lists variants
 * @property {Array} variants        {url, bandwidth, resolution, codecs, ...}
 * @property {Array} audioTracks
 * @property {Array} subtitleTracks
 * @property {string[]} segments     media playlist segment URLs
 * @property {number} duration       seconds, 0 when unknown
 * @property {boolean} live
 * @property {boolean} encrypted
 * @property {string} encryptionMethod
 * @property {string[]} drmSystems   e.g. ['widevine']
 */

const DRM_UUIDS = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'widevine',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'playready',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'fairplay',
  'e2719d58-a985-b3c9-781a-b030af78d30e': 'clearkey',
};

/**
 * @param {string} text raw .m3u8 body
 * @param {string} baseUrl absolute URL the manifest was fetched from
 * @returns {StreamInfo}
 */
export function parseM3U8(text, baseUrl) {
  const out = {
    type: 'hls',
    master: false,
    url: baseUrl,
    variants: [],
    audioTracks: [],
    subtitleTracks: [],
    segments: [],
    duration: 0,
    live: false,
    encrypted: false,
    encryptionMethod: '',
    drmSystems: [],
  };
  if (typeof text !== 'string' || !text.trim().startsWith('#EXTM3U')) return out;

  const lines = text.split(/\r?\n/);
  let pendingVariant = null;
  let hasEndlist = false;
  let sawTargetDuration = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    if (!line.startsWith('#')) {
      if (pendingVariant) {
        pendingVariant.url = resolve(line, baseUrl);
        out.variants.push(pendingVariant);
        pendingVariant = null;
        out.master = true;
      } else {
        out.segments.push(resolve(line, baseUrl));
      }
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      pendingVariant = {
        bandwidth: Number(a.BANDWIDTH) || Number(a['AVERAGE-BANDWIDTH']) || 0,
        averageBandwidth: Number(a['AVERAGE-BANDWIDTH']) || 0,
        resolution: a.RESOLUTION || '',
        codecs: a.CODECS || '',
        frameRate: Number(a['FRAME-RATE']) || 0,
        audioGroup: a.AUDIO || '',
        url: '',
      };
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      const track = {
        type: (a.TYPE || '').toLowerCase(),
        name: a.NAME || '',
        language: a.LANGUAGE || '',
        groupId: a['GROUP-ID'] || '',
        url: a.URI ? resolve(a.URI, baseUrl) : '',
        default: a.DEFAULT === 'YES',
      };
      if (track.type === 'audio') out.audioTracks.push(track);
      else if (track.type === 'subtitles' || track.type === 'closed-captions') {
        out.subtitleTracks.push(track);
      }
      out.master = true;
    } else if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      const a = parseAttributes(line.slice(line.indexOf(':') + 1));
      const method = (a.METHOD || '').toUpperCase();
      if (method && method !== 'NONE') {
        out.encrypted = true;
        out.encryptionMethod = method;
        const fmt = (a.KEYFORMAT || '').toLowerCase();
        for (const [uuid, name] of Object.entries(DRM_UUIDS)) {
          if (fmt.includes(uuid) && !out.drmSystems.includes(name)) out.drmSystems.push(name);
        }
        if (fmt.includes('com.apple.streamingkeydelivery') && !out.drmSystems.includes('fairplay')) {
          out.drmSystems.push('fairplay');
        }
        if (fmt.includes('widevine') && !out.drmSystems.includes('widevine')) {
          out.drmSystems.push('widevine');
        }
      }
    } else if (line.startsWith('#EXTINF:')) {
      const secs = parseFloat(line.slice('#EXTINF:'.length));
      if (Number.isFinite(secs)) out.duration += secs;
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      hasEndlist = true;
    } else if (line.startsWith('#EXT-X-TARGETDURATION')) {
      sawTargetDuration = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      if (a.URI) out.segments.unshift(resolve(a.URI, baseUrl));
    }
  }

  out.live = sawTargetDuration && !hasEndlist && !out.master;
  out.variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return out;
}

/**
 * @param {string} xml raw .mpd body
 * @param {string} baseUrl
 * @param {typeof DOMParser} [ParserImpl] injected so core stays testable
 * @returns {StreamInfo}
 */
export function parseMPD(xml, baseUrl, ParserImpl) {
  const out = {
    type: 'dash',
    master: true,
    url: baseUrl,
    variants: [],
    audioTracks: [],
    subtitleTracks: [],
    segments: [],
    duration: 0,
    live: false,
    encrypted: false,
    encryptionMethod: '',
    drmSystems: [],
  };
  const Parser = ParserImpl || (typeof DOMParser !== 'undefined' ? DOMParser : null);
  if (!Parser || typeof xml !== 'string' || !xml.trim()) return out;

  let doc;
  try {
    doc = new Parser().parseFromString(xml, 'application/xml');
  } catch {
    return out;
  }
  const mpd = doc && doc.documentElement;
  if (!mpd || mpd.nodeName === 'parsererror') return out;

  out.live = (mpd.getAttribute('type') || 'static') === 'dynamic';
  out.duration = parseISODuration(mpd.getAttribute('mediaPresentationDuration'));

  const protections = doc.getElementsByTagName('ContentProtection');
  for (let i = 0; i < protections.length; i += 1) {
    const el = protections[i];
    const scheme = (el.getAttribute('schemeIdUri') || '').toLowerCase();
    const uuid = scheme.replace('urn:uuid:', '');
    if (scheme.includes('mp4protection')) {
      out.encrypted = true;
      out.encryptionMethod = (el.getAttribute('value') || 'cenc').toUpperCase();
      continue;
    }
    out.encrypted = true;
    if (!out.encryptionMethod) out.encryptionMethod = 'CENC';
    const name = DRM_UUIDS[uuid];
    if (name && !out.drmSystems.includes(name)) out.drmSystems.push(name);
  }

  const reps = doc.getElementsByTagName('Representation');
  for (let i = 0; i < reps.length; i += 1) {
    const rep = reps[i];
    const adaptation = rep.parentNode;
    const mime =
      rep.getAttribute('mimeType') ||
      (adaptation && adaptation.getAttribute ? adaptation.getAttribute('mimeType') : '') ||
      '';
    const contentType =
      (adaptation && adaptation.getAttribute && adaptation.getAttribute('contentType')) ||
      mime.split('/')[0] ||
      '';
    const width = Number(rep.getAttribute('width')) || 0;
    const height = Number(rep.getAttribute('height')) || 0;
    const entry = {
      id: rep.getAttribute('id') || String(i),
      bandwidth: Number(rep.getAttribute('bandwidth')) || 0,
      resolution: width && height ? `${width}x${height}` : '',
      codecs: rep.getAttribute('codecs') || (adaptation && adaptation.getAttribute
        ? adaptation.getAttribute('codecs') || '' : ''),
      mimeType: mime,
      url: baseUrl,
      lang: (adaptation && adaptation.getAttribute && adaptation.getAttribute('lang')) || '',
    };
    if (contentType === 'audio') out.audioTracks.push(entry);
    else if (contentType === 'text') out.subtitleTracks.push(entry);
    else out.variants.push(entry);
  }
  out.variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return out;
}

/** ISO-8601 duration (`PT1H2M3.5S`) to seconds. */
export function parseISODuration(value) {
  if (!value || typeof value !== 'string') return 0;
  const m = /^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(value);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m.map((x) => (x === undefined ? 0 : Number(x)));
  return y * 31536000 + mo * 2592000 + d * 86400 + h * 3600 + mi * 60 + s;
}

/** Estimated bytes for a variant, or 0 when the duration is unknown. */
export function estimateBytes(bandwidth, durationSeconds) {
  if (!bandwidth || !durationSeconds) return 0;
  return Math.round((bandwidth / 8) * durationSeconds);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * A ready-to-paste yt-dlp invocation, including the headers that make it work.
 * @param {object} opts {url, formatId, referer, userAgent, cookieHeader, output}
 */
export function ytDlpCommand({
  url, formatId, referer, userAgent, cookieHeader, cookiesFromBrowser, output,
}) {
  const parts = ['yt-dlp'];
  if (formatId) parts.push('-f', shellQuote(formatId));
  if (referer) parts.push('--referer', shellQuote(referer));
  if (userAgent) parts.push('--user-agent', shellQuote(userAgent));
  if (cookieHeader) parts.push('--add-header', shellQuote(`Cookie: ${cookieHeader}`));
  // Magpie does not request the "cookies" permission, so for a session-gated
  // stream it tells yt-dlp to read the cookies from the browser itself.
  else if (cookiesFromBrowser) parts.push('--cookies-from-browser', shellQuote(cookiesFromBrowser));
  if (output) parts.push('-o', shellQuote(output));
  parts.push(shellQuote(url));
  return parts.join(' ');
}

/**
 * A ready-to-paste ffmpeg invocation. Stream copy only — no re-encode,
 * no decryption.
 */
export function ffmpegCommand({ url, referer, userAgent, cookieHeader, output }) {
  const headers = [];
  if (referer) headers.push(`Referer: ${referer}`);
  if (cookieHeader) headers.push(`Cookie: ${cookieHeader}`);
  const parts = ['ffmpeg'];
  if (userAgent) parts.push('-user_agent', shellQuote(userAgent));
  if (headers.length) parts.push('-headers', shellQuote(headers.join('\r\n') + '\r\n'));
  parts.push('-i', shellQuote(url), '-c', 'copy', shellQuote(output || 'out.mp4'));
  return parts.join(' ');
}
