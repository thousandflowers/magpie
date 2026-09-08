/**
 * A local gallery for the browser checks: one WordPress-shaped page and every
 * image it references, generated on the fly so nothing binary is committed.
 *
 * The page carries the shapes a real site throws at the scanner: thumbnails
 * linking to their originals, a hero, a repeated toolbar of icons, a lazy
 * section (`data-src`, never fetched), an iframe that arrives late, a painted
 * canvas and an inline `data:` image. Every image is pseudo-random noise, so
 * its byte size scales with its pixels and an original is always larger than
 * its thumbnail - which is what the upgrade verifier keys on.
 */

import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A deterministic, incompressible RGB PNG: bytes grow with pixels. */
export function png(width, height, seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let x = (seed >>> 0) || 1;
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset++] = 0; // filter: none
    for (let i = 0; i < width * 3; i += 1) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5; // xorshift32
      raw[offset++] = x & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const GALLERY = {
  title: 'Magpie test gallery',
  thumbs: 12,
  icons: 5,
  lazy: 4,
  thumbSize: [150, 150],
  originalSize: [640, 480],
  heroSize: [1200, 400],
  iconSize: [24, 24],
  lazySize: [300, 200],
  frameSize: [200, 200],
  canvasSize: [320, 180],
  dataSize: [64, 64],
};

const pad2 = (n) => String(n).padStart(2, '0');
export const thumbPath = (n) => `/uploads/2024/08/beach-${pad2(n)}-150x150.png`;
export const originalPath = (n) => `/uploads/2024/08/beach-${pad2(n)}.png`;
export const iconPath = (n) => `/assets/icons/icon-${n}.png`;
export const lazyPath = (n) => `/uploads/lazy/lazy-${n}.png`;
export const HERO_PATH = '/uploads/2024/08/hero.png';
export const FRAME_IMAGE_PATH = '/uploads/frame/inner.png';

/**
 * Which image a path names: [width, height, seed], or null. Data-driven so
 * adding a family is one line.
 */
const IMAGE_ROUTES = [
  [/^\/uploads\/2024\/08\/beach-(\d\d)-150x150\.png$/, (m) => [...GALLERY.thumbSize, 100 + Number(m[1])]],
  [/^\/uploads\/2024\/08\/beach-(\d\d)\.png$/, (m) => [...GALLERY.originalSize, 200 + Number(m[1])]],
  [/^\/uploads\/2024\/08\/hero\.png$/, () => [...GALLERY.heroSize, 300]],
  [/^\/assets\/icons\/icon-(\d)\.png$/, (m) => [...GALLERY.iconSize, 400 + Number(m[1])]],
  [/^\/uploads\/lazy\/lazy-(\d)\.png$/, (m) => [...GALLERY.lazySize, 500 + Number(m[1])]],
  [/^\/uploads\/frame\/inner\.png$/, () => [...GALLERY.frameSize, 600]],
  // The SPA: a JSON feed the DOM never renders, an XHR feed, a route change.
  [/^\/uploads\/spa\/feed-(\d)\.png$/, (m) => [400, 300, 800 + Number(m[1])]],
  [/^\/uploads\/spa\/xhr-(\d)\.png$/, (m) => [400, 300, 820 + Number(m[1])]],
  [/^\/uploads\/spa\/route-(\d)\.png$/, (m) => [320, 240, 840 + Number(m[1])]],
  [/^\/uploads\/spa\/poster\.png$/, () => [640, 360, 860]],
  // The explorer's two pages: visible, behind a button, in a lightbox, on page 2.
  [/^\/uploads\/explore\/visible-(\d)\.png$/, (m) => [300, 200, 900 + Number(m[1])]],
  [/^\/uploads\/explore\/hidden-(\d)\.png$/, (m) => [300, 200, 910 + Number(m[1])]],
  [/^\/uploads\/explore\/lightbox\.png$/, () => [1200, 800, 930]],
  [/^\/uploads\/explore\/page2-(\d)\.png$/, (m) => [300, 200, 940 + Number(m[1])]],
  [/^\/uploads\/explore\/lazy-(\d+)\.png$/, (m) => [300, 200, 960 + Number(m[1])]],
];

function imageSpec(pathname) {
  for (const [re, spec] of IMAGE_ROUTES) {
    const m = re.exec(pathname);
    if (m) return spec(m);
  }
  return null;
}

const imageCache = new Map();
/** The exact bytes the server sends for an image path (what a download must match). */
export function imageBytes(pathname) {
  const spec = imageSpec(pathname);
  if (!spec) return null;
  if (!imageCache.has(pathname)) imageCache.set(pathname, png(...spec));
  return imageCache.get(pathname);
}

const DATA_IMAGE_BYTES = png(...GALLERY.dataSize, 700);
/** The inline data: image, as bytes, so a saved copy can be compared. */
export const dataImageBytes = () => DATA_IMAGE_BYTES;
const DATA_IMAGE = `data:image/png;base64,${DATA_IMAGE_BYTES.toString('base64')}`;

function galleryHtml() {
  const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
  const icons = range(GALLERY.icons).map((n) =>
    `<button class="toolbar-button" type="button"><img class="icon" src="${iconPath(n)}" width="24" height="24" alt=""></button>`).join('\n      ');
  const thumbs = range(GALLERY.thumbs).map((n) =>
    `<li class="grid-item"><a class="gallery-link" href="${originalPath(n)}"><img class="grid-thumb attachment-thumbnail" src="${thumbPath(n)}" width="150" height="150" alt="beach ${pad2(n)}"></a></li>`).join('\n      ');
  const lazy = range(GALLERY.lazy).map((n) =>
    `<img class="lazy" data-src="${lazyPath(n)}" width="300" height="200" alt="lazy ${n}">`).join('\n      ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${GALLERY.title}</title>
  <style>
    .photo-grid { display: grid; grid-template-columns: repeat(4, 150px); gap: 8px; list-style: none; padding: 0; }
    .toolbar-button { padding: 4px; }
    .lazy-section img { background: #ddd; }
  </style>
</head>
<body>
  <main class="site-main">
    <img class="hero-image" src="${HERO_PATH}" width="1200" height="400" alt="hero">
    <nav class="toolbar">
      ${icons}
    </nav>
    <ul class="gallery photo-grid">
      ${thumbs}
    </ul>
    <section class="lazy-section">
      ${lazy}
    </section>
    <canvas id="painted" width="${GALLERY.canvasSize[0]}" height="${GALLERY.canvasSize[1]}"></canvas>
    <img class="inline-data" src="${DATA_IMAGE}" width="64" height="64" alt="inline">
    <div id="frame-slot"></div>
  </main>
  <script>
    const ctx = document.getElementById('painted').getContext('2d');
    ctx.fillStyle = '#e8552d'; ctx.fillRect(0, 0, ${GALLERY.canvasSize[0]}, ${GALLERY.canvasSize[1]});
    ctx.fillStyle = '#ffffff'; ctx.fillRect(40, 40, 240, 100);
    // A third-party-style iframe that arrives after the page has settled.
    setTimeout(() => {
      const frame = document.createElement('iframe');
      frame.src = '/frame.html';
      frame.width = '220';
      frame.height = '220';
      document.getElementById('frame-slot').appendChild(frame);
    }, 800);
  </script>
</body>
</html>`;
}

/* ---------------------------------------------------------------- *
 * The SPA: media that only exists in JSON, a stream fetched like hls.js
 * would, a <video> with a poster, an EME hook, and a pushState route.
 * ---------------------------------------------------------------- */

export const SPA = {
  title: 'SPA fixture',
  feed: 3,
  xhr: 2,
  route: 3,
  feedPath: (n) => `/uploads/spa/feed-${n}.png`,
  xhrPath: (n) => `/uploads/spa/xhr-${n}.png`,
  routePath: (n) => `/uploads/spa/route-${n}.png`,
  posterPath: '/uploads/spa/poster.png',
  clipPath: (n) => `/media/clip-${n}.webm`,
  masterPath: '/stream/master.m3u8',
  variants: [[1080, 1920, 6000000], [720, 1280, 3200000], [360, 640, 800000]],
  segmentsPerVariant: 3,
};

const SPA_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${SPA.title}</title></head>
<body>
  <main id="app">
    <h1>Feed</h1>
    <video id="clip" poster="${SPA.posterPath}" src="${SPA.clipPath(1)}" width="320" height="180"></video>
    <div id="grid"></div>
    <button id="route" type="button">open page two</button>
  </main>
  <script>
    // Media the DOM never renders: only a fetch/XHR interceptor can see it.
    fetch('/api/feed').then((r) => r.json()).then((doc) => { window.__feed = doc; });
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/feed-xhr');
    xhr.onload = () => { window.__xhr = JSON.parse(xhr.responseText); };
    xhr.send();
    // A player fetching its manifest.
    fetch('${SPA.masterPath}').then((r) => r.text()).then((t) => { window.__manifest = t; });
    // A route change without a navigation.
    document.getElementById('route').addEventListener('click', () => {
      history.pushState({}, '', '/spa/two');
      const grid = document.getElementById('grid');
      grid.textContent = '';
      for (let i = 1; i <= ${SPA.route}; i += 1) {
        const img = document.createElement('img');
        img.src = '/uploads/spa/route-' + i + '.png';
        img.width = 320; img.height = 240;
        grid.appendChild(img);
      }
    });
    // Pretend to be a DRM player. The request fails in a test browser; the
    // interceptor sees the call before it does.
    window.__eme = () => navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
      initDataTypes: ['cenc'],
      videoCapabilities: [{ contentType: 'video/mp4;codecs="avc1.42E01E"' }],
    }]).catch(() => 'refused');
    window.__lateVideo = () => {
      const v = document.createElement('video');
      v.src = '${SPA.clipPath(2)}'; v.width = 320; v.height = 180;
      document.getElementById('app').appendChild(v);
    };
  </script>
</body>
</html>`;

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

const FEED_JSON = JSON.stringify({
  page: 1,
  next: '/api/feed?page=2',
  items: range(SPA.feed).map((n) => ({ id: n, image: SPA.feedPath(n), caption: `feed ${n}` })),
});
const XHR_JSON = JSON.stringify({
  results: range(SPA.xhr).map((n) => ({ media: { url: SPA.xhrPath(n) } })),
});

function masterPlaylist() {
  return ['#EXTM3U', ...SPA.variants.flatMap(([h, w, bw]) => [
    `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${w}x${h},CODECS="avc1.4d401f,mp4a.40.2"`,
    `/stream/${h}/index.m3u8`,
  ]), ''].join('\n');
}

function mediaPlaylist(height) {
  return ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-VERSION:3',
    ...range(SPA.segmentsPerVariant).flatMap((n) => ['#EXTINF:6.0,', `/stream/${height}/seg-${n}.ts`]),
    '#EXT-X-ENDLIST', ''].join('\n');
}

/* ---------------------------------------------------------------- *
 * The explorer's fixture: two pages, media behind a button and in a
 * lightbox, and traps that record any click the policy should refuse.
 * ---------------------------------------------------------------- */

export const EXPLORE = {
  title1: 'Explore fixture',
  title2: 'Explore page 2',
  visible: 2,
  hidden: 4,
  page2: 3,
  /** Lazy images on page 2, each a viewport apart, loaded by an IntersectionObserver with no margin. */
  lazy: 12,
  lazyGap: 900,
  visiblePath: (n) => `/uploads/explore/visible-${n}.png`,
  lazyPath: (n) => `/uploads/explore/lazy-${n}.png`,
  hiddenPath: (n) => `/uploads/explore/hidden-${n}.png`,
  lightboxPath: '/uploads/explore/lightbox.png',
  page2Path: (n) => `/uploads/explore/page2-${n}.png`,
};

const EXPLORE_1_HTML = `<!doctype html>
<html lang="it">
<head><meta charset="utf-8"><title>${EXPLORE.title1}</title>
<style>.gallery img { display: inline-block; } .lightbox[hidden] { display: none; }</style></head>
<body>
  <main>
    <div class="gallery">
      ${range(EXPLORE.visible).map((n) => `<img src="${EXPLORE.visiblePath(n)}" width="300" height="200" alt="visible ${n}">`).join('\n      ')}
    </div>
    <button id="more" type="button">Mostra altre foto</button>
    <button id="zoom" type="button" class="open-lightbox">Ingrandisci</button>
    <div class="lightbox" id="lightbox" hidden></div>
    <p><a href="/explore/2">Pagina 2</a></p>
    <!-- traps: each records a hit at /trap/... if anything touches it -->
    <button type="button" id="trap-delete" style="cursor:pointer">Elimina account</button>
    <button type="button" id="trap-pay" style="cursor:pointer">Paga ora</button>
    <button type="button" id="trap-upload" style="cursor:pointer">Carica file</button>
    <form action="/trap/form" method="get"><button type="submit">Mostra altre foto</button></form>
    <a href="/trap/logout">Esci</a>
    <a href="/explore/archive.zip" download>Scarica tutto</a>
  </main>
  <script>
    document.getElementById('more').addEventListener('click', () => {
      const g = document.querySelector('.gallery');
      for (let i = 1; i <= ${EXPLORE.hidden}; i += 1) {
        const img = document.createElement('img');
        img.src = '/uploads/explore/hidden-' + i + '.png'; img.width = 300; img.height = 200;
        g.appendChild(img);
      }
    });
    document.getElementById('zoom').addEventListener('click', () => {
      const box = document.getElementById('lightbox');
      box.hidden = false;
      box.innerHTML = '<img src="${EXPLORE.lightboxPath}" width="600" height="400" alt="lightbox">';
    });
    for (const id of ['trap-delete', 'trap-pay', 'trap-upload']) {
      document.getElementById(id).addEventListener('click', () => fetch('/trap/' + id));
    }
  </script>
</body>
</html>`;

const EXPLORE_2_HTML = `<!doctype html>
<html lang="it">
<head><meta charset="utf-8"><title>${EXPLORE.title2}</title></head>
<body>
  <!-- a site logo: a span wrapping an image, inside a link back to page 1 -->
  <header><a href="/explore/1"><span class="logo" style="cursor:pointer;display:inline-block"><img src="${EXPLORE.visiblePath(1)}" width="120" height="80" alt="logo"></span></a></header>
  <main>
    <div class="gallery">
      ${range(EXPLORE.page2).map((n) => `<img src="${EXPLORE.page2Path(n)}" width="300" height="200" alt="page2 ${n}">`).join('\n      ')}
    </div>
    <p><a href="/explore/1">Pagina 1</a> · <a href="/trap/logout">Esci</a></p>
    <!-- A long lazy feed: each image sits a viewport below the last and gets
         its src only when it actually intersects. Jumping to the bottom of the
         page loads the last one; only scrolling through loads them all. -->
    <section class="feed">
      ${range(EXPLORE.lazy).map((n) => `<figure style="height:${EXPLORE.lazyGap}px;margin:0"><img class="lazy" data-lazy-src="${EXPLORE.lazyPath(n)}" width="300" height="200" alt="lazy ${n}"></figure>`).join('\n      ')}
    </section>
  </main>
  <script>
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.src = e.target.dataset.lazySrc;
        io.unobserve(e.target);
      }
    });
    for (const img of document.querySelectorAll('img.lazy')) io.observe(img);
  </script>
</body>
</html>`;

const FRAME_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Embedded widget</title></head>
<body><img src="${FRAME_IMAGE_PATH}" width="200" height="200" alt="inner"></body></html>`;

/**
 * @param {number} [port] 0 picks a free one
 * @returns {Promise<{origin: string, port: number, hits: Array<{method: string, path: string}>, close: () => Promise<void>}>}
 */
export function startGalleryServer(port = 0) {
  const hits = [];
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    hits.push({ method: req.method, path: pathname });
    const reply = (status, type, body) => {
      res.writeHead(status, {
        'content-type': type,
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const html = (body) => reply(200, 'text/html; charset=utf-8', Buffer.from(body));
    if (pathname === '/' || pathname === '/gallery') return html(galleryHtml());
    if (pathname === '/frame.html') return html(FRAME_HTML);
    if (pathname === '/spa' || pathname === '/spa/two') return html(SPA_HTML);
    if (pathname === '/explore/1') return html(EXPLORE_1_HTML);
    if (pathname === '/explore/2') return html(EXPLORE_2_HTML);
    if (pathname === '/api/feed') return reply(200, 'application/json', Buffer.from(FEED_JSON));
    if (pathname === '/api/feed-xhr') return reply(200, 'application/json; charset=utf-8', Buffer.from(XHR_JSON));
    if (pathname === SPA.masterPath) return reply(200, 'application/vnd.apple.mpegurl', Buffer.from(masterPlaylist()));
    const media = /^\/stream\/(\d+)\/index\.m3u8$/.exec(pathname);
    if (media) return reply(200, 'application/vnd.apple.mpegurl', Buffer.from(mediaPlaylist(media[1])));
    if (/^\/stream\/\d+\/seg-\d\.ts$/.test(pathname)) return reply(200, 'video/mp2t', Buffer.alloc(188, 0x47));
    if (/^\/media\/clip-\d\.webm$/.test(pathname)) return reply(200, 'video/webm', Buffer.alloc(256));
    if (pathname.startsWith('/trap/')) return reply(200, 'text/plain', Buffer.from('trap sprung'));
    const image = imageBytes(pathname);
    if (image) return reply(200, 'image/png', image);
    return reply(404, 'text/plain', Buffer.from('not found'));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        origin: `http://127.0.0.1:${actual}`,
        port: actual,
        hits,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// `node test/fixtures/gallery-server.mjs` serves it for a human to look at.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const site = await startGalleryServer(Number(process.env.PORT) || 8765);
  console.log(`gallery at ${site.origin}/  (ctrl-c to stop)`);
}
