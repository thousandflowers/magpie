import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeSegment, applyTemplate, tokensFor, buildPath, basenameOf,
  resolveExtension, formatBytes, DEFAULT_TEMPLATE,
} from '../src/core/filename.js';
import {
  parseM3U8, parseMPD, parseISODuration, ytDlpCommand, ffmpegCommand, estimateBytes,
} from '../src/core/manifest-parse.js';
import { parseHar } from '../src/core/har-import.js';
import {
  classify, looksLikeMediaUrl, rejectionReason, extOf, dataUriBytes,
} from '../src/core/media-types.js';

/* ------------------------- filenames ------------------------- */

test('sanitizeSegment defuses path traversal and reserved names', () => {
  assert.equal(sanitizeSegment('../../etc/passwd'), '_._etc_passwd');
  assert.ok(!sanitizeSegment('../../etc/passwd').includes('..'));
  assert.equal(sanitizeSegment('..'), 'file');
  assert.equal(sanitizeSegment('.'), 'file');
  assert.equal(sanitizeSegment('CON'), '_CON');
  assert.equal(sanitizeSegment('nul.txt'), '_nul.txt');
  assert.equal(sanitizeSegment(''), 'file');
  assert.equal(sanitizeSegment('a<b>c:d"e|f?g*h'), 'a_b_c_d_e_f_g_h');
});

test('sanitizeSegment strips control characters', () => {
  const nasty = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(10) + 'c';
  assert.equal(sanitizeSegment(nasty), 'abc');
});

test('sanitizeSegment caps length but keeps the extension', () => {
  const long = 'x'.repeat(300) + '.jpeg';
  const out = sanitizeSegment(long);
  assert.equal(out.length, 100);
  assert.ok(out.endsWith('.jpeg'));
});

test('applyTemplate cannot escape the download directory', () => {
  const tokens = { host: '../../evil', title: 'a/b', index: '001', basename: '..', ext: 'jpg' };
  const path = applyTemplate('magpie/{host}/{title}/{index}-{basename}.{ext}', tokens);
  assert.ok(!path.includes('..'), path);
  assert.ok(!path.startsWith('/'), path);
  assert.equal(path.split('/')[0], 'magpie');
});

test('applyTemplate expands every documented token', () => {
  const tokens = {
    host: 'cdn.e.com', title: 'My Post', date: '2024-08-17', index: '007',
    basename: 'beach', ext: 'jpg', width: '1200', height: '800', group: 'Group 1',
  };
  assert.equal(
    applyTemplate('{date}/{host}/{group}/{index}-{basename}-{width}x{height}.{ext}', tokens),
    '2024-08-17/cdn.e.com/Group 1/007-beach-1200x800.jpg',
  );
});

test('applyTemplate always preserves the real extension', () => {
  const tokens = { host: 'e.com', index: '001', basename: 'photo', ext: 'webp' };
  assert.equal(applyTemplate('{host}/{basename}', tokens), 'e.com/photo.webp');
  assert.equal(applyTemplate('{host}/{basename}.{ext}', tokens), 'e.com/photo.webp');
});

test('the MIME type overrules a lying URL extension', () => {
  assert.equal(resolveExtension('https://e.com/a.jpg', 'image/webp'), 'webp');
  assert.equal(resolveExtension('https://e.com/a', 'image/png'), 'png');
  assert.equal(resolveExtension('https://e.com/opaque', ''), 'bin');
  assert.equal(resolveExtension('https://e.com/a.jpg', ''), 'jpg');
});

test('basenameOf survives odd URLs', () => {
  assert.equal(basenameOf('https://e.com/a/b/photo.jpg'), 'photo');
  assert.equal(basenameOf('https://e.com/a/b/'), 'b');
  assert.equal(basenameOf('https://e.com/'), 'index');
  assert.equal(basenameOf('data:image/png;base64,AA'), 'inline');
  assert.equal(basenameOf('blob:https://e.com/x'), 'blob');
  assert.equal(basenameOf('https://e.com/caf%C3%A9.jpg'), 'café');
});

test('buildPath produces the documented default layout', () => {
  const item = { url: 'https://cdn.e.com/p/beach.jpg', mimeType: 'image/jpeg' };
  const path = buildPath(item, { pageUrl: 'https://e.com/post', pageTitle: 'Summer', index: 4, total: 120 });
  assert.equal(path, 'magpie/cdn.e.com/Summer/004-beach.jpg');
  assert.equal(DEFAULT_TEMPLATE, 'magpie/{host}/{title}/{index}-{basename}.{ext}');
});

test('index padding widens with the batch size, so files sort correctly', () => {
  const item = { url: 'https://e.com/a.jpg', mimeType: 'image/jpeg' };
  assert.equal(tokensFor(item, { index: 7, total: 9 }).index, '007');
  assert.equal(tokensFor(item, { index: 7, total: 5000 }).index, '0007');
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '—');
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});

/* ------------------------- HLS / DASH ------------------------- */

const MASTER_M3U8 = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720/index.m3u8
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"
`;

const MEDIA_M3U8 = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.0,
seg1.ts
#EXTINF:6.0,
seg2.ts
#EXT-X-ENDLIST
`;

test('parseM3U8 reads a master playlist and sorts variants by bitrate', () => {
  const info = parseM3U8(MASTER_M3U8, 'https://v.e.com/hls/master.m3u8');
  assert.equal(info.type, 'hls');
  assert.equal(info.master, true);
  assert.equal(info.variants.length, 2);
  assert.equal(info.variants[0].resolution, '1280x720');
  assert.equal(info.variants[0].bandwidth, 2400000);
  assert.equal(info.variants[0].url, 'https://v.e.com/hls/720/index.m3u8');
  assert.equal(info.audioTracks.length, 1);
  assert.equal(info.audioTracks[0].url, 'https://v.e.com/hls/audio/en.m3u8');
  assert.equal(info.subtitleTracks.length, 1);
  assert.equal(info.encrypted, false);
});

test('parseM3U8 reads a media playlist, its duration and its segments', () => {
  const info = parseM3U8(MEDIA_M3U8, 'https://v.e.com/hls/720/index.m3u8');
  assert.equal(info.master, false);
  assert.equal(info.duration, 12);
  assert.equal(info.live, false);
  assert.deepEqual(info.segments, [
    'https://v.e.com/hls/720/init.mp4',
    'https://v.e.com/hls/720/seg1.ts',
    'https://v.e.com/hls/720/seg2.ts',
  ]);
});

test('parseM3U8 detects a live playlist', () => {
  const live = MEDIA_M3U8.replace('#EXT-X-ENDLIST\n', '');
  assert.equal(parseM3U8(live, 'https://v.e.com/l.m3u8').live, true);
});

test('parseM3U8 flags encryption but never touches keys', () => {
  const enc = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:4.0,
a.ts
`;
  const info = parseM3U8(enc, 'https://v.e.com/e.m3u8');
  assert.equal(info.encrypted, true);
  assert.equal(info.encryptionMethod, 'SAMPLE-AES');
  assert.deepEqual(info.drmSystems, ['fairplay']);
  assert.ok(!('keys' in info), 'no key material is ever collected');
});

test('parseM3U8 does not treat METHOD=NONE as encryption', () => {
  const info = parseM3U8('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\na.ts\n', 'https://v.e/a.m3u8');
  assert.equal(info.encrypted, false);
});

test('parseM3U8 rejects anything that is not a playlist', () => {
  assert.equal(parseM3U8('<html>', 'https://e.com/x').variants.length, 0);
  assert.equal(parseM3U8(null, 'https://e.com/x').type, 'hls');
});

test('parseMPD reads representations and flags Widevine', async () => {
  const { JSDOM } = await import('node:util').then(() => ({ JSDOM: null })).catch(() => ({ JSDOM: null }));
  // No DOM in Node, so inject a tiny stand-in parser built on the same API surface.
  const doc = makeFakeXmlDoc();
  const Parser = function FakeParser() {};
  Parser.prototype.parseFromString = () => doc;
  const info = parseMPD('<MPD/>', 'https://v.e.com/dash.mpd', Parser);
  assert.equal(info.type, 'dash');
  assert.equal(info.encrypted, true);
  assert.deepEqual(info.drmSystems, ['widevine']);
  assert.equal(info.variants.length, 2);
  assert.equal(info.variants[0].bandwidth, 3000000);
  assert.equal(info.audioTracks.length, 1);
  assert.ok(JSDOM === null);
});

test('parseMPD returns an empty result without a parser', () => {
  const info = parseMPD('<MPD/>', 'https://v.e.com/d.mpd', null);
  assert.equal(info.variants.length, 0);
});

test('parseISODuration', () => {
  assert.equal(parseISODuration('PT1H2M3S'), 3723);
  assert.equal(parseISODuration('PT30.5S'), 30.5);
  assert.equal(parseISODuration(''), 0);
  assert.equal(parseISODuration('garbage'), 0);
});

test('estimateBytes', () => {
  assert.equal(estimateBytes(2400000, 60), 18000000);
  assert.equal(estimateBytes(0, 60), 0);
});

test('shell commands quote every value they interpolate', () => {
  const cmd = ytDlpCommand({
    url: "https://v.e.com/m.m3u8?a=1&b=2",
    formatId: '720',
    referer: "https://e.com/it's-here",
    cookieHeader: 'sid=abc',
  });
  assert.ok(cmd.startsWith('yt-dlp -f '));
  assert.ok(cmd.includes(`'https://v.e.com/m.m3u8?a=1&b=2'`));
  assert.ok(cmd.includes(`--add-header 'Cookie: sid=abc'`));
  assert.ok(!/[^\\]'[^']*it's/.test(cmd), 'the apostrophe is escaped, not left bare');

  const fromBrowser = ytDlpCommand({ url: 'https://v.e.com/m.m3u8', cookiesFromBrowser: 'chrome' });
  assert.ok(fromBrowser.includes(`--cookies-from-browser 'chrome'`));

  const ff = ffmpegCommand({ url: 'https://v.e.com/m.m3u8', output: 'out.mp4' });
  assert.equal(ff, `ffmpeg -i 'https://v.e.com/m.m3u8' -c copy 'out.mp4'`);
});

/* ------------------------- HAR ------------------------- */

const HAR = {
  log: {
    entries: [
      {
        startedDateTime: '2024-08-17T10:00:00.000Z',
        request: { url: 'https://cdn.e.com/a.jpg', headers: [{ name: 'Referer', value: 'https://e.com/p' }] },
        response: { status: 200, content: { mimeType: 'image/jpeg', size: 240000 }, headers: [] },
      },
      {
        startedDateTime: '2024-08-17T10:00:01.000Z',
        request: { url: 'https://cdn.e.com/a.jpg?utm_source=x', headers: [] },
        response: { status: 200, content: { mimeType: 'image/jpeg', size: 240000 }, headers: [] },
      },
      {
        startedDateTime: '2024-08-17T10:00:02.000Z',
        request: { url: 'https://e.com/page.html', headers: [] },
        response: { status: 200, content: { mimeType: 'text/html', size: 5000 }, headers: [] },
      },
      {
        startedDateTime: '2024-08-17T10:00:03.000Z',
        request: { url: 'https://cdn.e.com/missing.png', headers: [] },
        response: { status: 404, content: { mimeType: 'image/png', size: 0 }, headers: [] },
      },
      {
        startedDateTime: '2024-08-17T10:00:04.000Z',
        request: { url: 'https://v.e.com/master.m3u8', headers: [] },
        response: { status: 200, content: { mimeType: 'application/vnd.apple.mpegurl', size: 900 }, headers: [] },
      },
    ],
  },
};

test('parseHar keeps media, drops HTML, errors and duplicates', () => {
  const { items, skipped, error } = parseHar(HAR);
  assert.equal(error, '');
  assert.equal(items.length, 2, 'one image plus one stream');
  assert.equal(items[0].url, 'https://cdn.e.com/a.jpg');
  assert.equal(items[0].source, 'har');
  assert.equal(items[0].bytes, 240000);
  assert.equal(items[0].initiator, 'https://e.com/p');
  assert.equal(items[1].kind, 'stream');
  assert.ok(skipped >= 2, 'the 404 and the duplicate are counted as skipped');
});

test('parseHar accepts raw JSON text and rejects non-HAR input', () => {
  assert.equal(parseHar(JSON.stringify(HAR)).items.length, 2);
  assert.match(parseHar('{').error, /Not valid JSON/);
  assert.match(parseHar({}).error, /log\.entries/);
});

test('parseHar honours the item cap', () => {
  const { items, skipped } = parseHar(HAR, { maxItems: 1 });
  assert.equal(items.length, 1);
  assert.ok(skipped > 0);
});

/* ------------------------- classification ------------------------- */

test('classify prefers MIME, falls back to extension', () => {
  assert.equal(classify({ url: 'https://e.com/a', mimeType: 'image/png' }), 'image');
  assert.equal(classify({ url: 'https://e.com/a.mp4', mimeType: 'application/octet-stream' }), 'video');
  assert.equal(classify({ url: 'https://e.com/a.m3u8' }), 'stream');
  assert.equal(classify({ url: 'https://e.com/a.html' }), '');
  assert.equal(extOf('https://e.com/a.JPEG?x=1'), 'jpeg');
});

test('looksLikeMediaUrl mines JSON payloads without swallowing every string', () => {
  assert.ok(looksLikeMediaUrl('https://cdn.e.com/p/photo.jpg'));
  assert.ok(looksLikeMediaUrl('//cdn.e.com/p/photo.webp'));
  assert.ok(looksLikeMediaUrl('/media/clip.mp4'));
  assert.ok(looksLikeMediaUrl('https://cdn.e.com/images/f3d9c2b1a4e6'), 'extensionless CDN path');
  assert.ok(!looksLikeMediaUrl('https://e.com/about'));
  assert.ok(!looksLikeMediaUrl('https://e.com/app.js'));
  assert.ok(!looksLikeMediaUrl('https://e.com/data.json'));
  assert.ok(!looksLikeMediaUrl('hello world'));
  assert.ok(!looksLikeMediaUrl(42));
});

test('rejectionReason drops the usual junk', () => {
  assert.equal(rejectionReason({ url: 'https://e.com/px.gif', bytes: 43, width: 1, height: 1 }), 'tracking-pixel');
  assert.equal(rejectionReason({ url: 'https://e.com/favicon.ico' }), 'favicon');
  assert.equal(rejectionReason({ url: 'data:image/png;base64,' + 'A'.repeat(40) }), 'tiny-data-uri');
  assert.equal(rejectionReason({ url: 'https://e.com/hero.jpg', bytes: 500000, width: 1600, height: 900 }), '');
  assert.ok(dataUriBytes('data:image/png;base64,' + 'A'.repeat(4000)) > 2000);
});

/* ------------------------- helpers ------------------------- */

/** Minimal stand-in for the handful of DOM APIs parseMPD touches. */
function makeFakeXmlDoc() {
  const el = (name, attrs, children = []) => ({
    nodeName: name,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    parentNode: null,
    children,
  });
  const videoAdaptation = el('AdaptationSet', { mimeType: 'video/mp4', contentType: 'video' });
  const audioAdaptation = el('AdaptationSet', { mimeType: 'audio/mp4', contentType: 'audio', lang: 'en' });
  const reps = [
    el('Representation', { id: 'v1', bandwidth: '3000000', width: '1920', height: '1080', codecs: 'avc1' }),
    el('Representation', { id: 'v2', bandwidth: '800000', width: '640', height: '360', codecs: 'avc1' }),
    el('Representation', { id: 'a1', bandwidth: '128000', codecs: 'mp4a.40.2' }),
  ];
  reps[0].parentNode = videoAdaptation;
  reps[1].parentNode = videoAdaptation;
  reps[2].parentNode = audioAdaptation;
  const protections = [
    el('ContentProtection', { schemeIdUri: 'urn:mpeg:dash:mp4protection:2011', value: 'cenc' }),
    el('ContentProtection', { schemeIdUri: 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed' }),
  ];
  return {
    documentElement: el('MPD', { type: 'static', mediaPresentationDuration: 'PT10M' }),
    getElementsByTagName: (tag) => {
      if (tag === 'Representation') return reps;
      if (tag === 'ContentProtection') return protections;
      return [];
    },
  };
}
