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
    if (pathname === '/' || pathname === '/gallery') return reply(200, 'text/html; charset=utf-8', Buffer.from(galleryHtml()));
    if (pathname === '/frame.html') return reply(200, 'text/html; charset=utf-8', Buffer.from(FRAME_HTML));
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
