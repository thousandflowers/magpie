/**
 * Hand-built page fixtures for the similarity tests.
 * Each factory returns MediaCandidate-shaped plain objects.
 */

/** structuralPath is element-first: [img, ...ancestors, body]. */
function path(...nodes) {
  return nodes.map(([tag, classes = []]) => ({ tag, classes }));
}

const BODY = ['body', []];

/* ---------------------------------------------------------------- *
 * 1. WordPress gallery: -150x150 thumbnails alongside originals
 * ---------------------------------------------------------------- */

export function wordpressGallery(count = 8) {
  const base = 'https://blog.example.com/wp-content/uploads/2024/08';
  const thumbs = [];
  const originals = [];
  for (let i = 1; i <= count; i += 1) {
    const n = String(i).padStart(2, '0');
    const structuralPath = path(
      ['img', ['attachment-thumbnail']],
      ['a', ['gallery-link']],
      ['figure', ['gallery-item']],
      ['div', ['gallery', 'gallery-columns-4']],
      ['div', ['entry-content']],
      ['article', ['post']],
      ['main', ['site-main']],
      BODY,
    );
    thumbs.push({
      id: `wp-thumb-${n}`,
      url: `${base}/beach-${n}-150x150.jpg`,
      mimeType: 'image/jpeg',
      kind: 'image',
      width: 150,
      height: 150,
      bytes: 8 * 1024,
      source: 'dom',
      status: 'confirmed',
      inRepeatedGroup: true,
      structuralPath,
    });
    originals.push({
      id: `wp-full-${n}`,
      url: `${base}/beach-${n}.jpg`,
      mimeType: 'image/jpeg',
      kind: 'image',
      width: 2400,
      height: 1600,
      bytes: 1_200_000,
      source: 'net',
      status: 'background',
      inRepeatedGroup: false,
      structuralPath: [],
    });
  }
  return { thumbs, originals };
}

/* ---------------------------------------------------------------- *
 * 2. Hashed-CDN feed: /a/f3d9c2b1/photo.jpg
 * ---------------------------------------------------------------- */

const HASH_SHARDS = [
  ['a', 'f3d9c2b1'], ['b', '8c1d4e77'], ['c', '0091aabf'], ['d', 'de12ff40'],
  ['e', '7ab30c19'], ['f', '55cc90ea'], ['a', '13de7f02'], ['b', 'cc0918bd'],
];

export function hashedCdnFeed({ withStructure = true } = {}) {
  return HASH_SHARDS.map(([shard, hash], i) => ({
    id: `cdn-${i}`,
    url: `https://img.feedcdn.net/${shard}/${hash}/photo.jpg`,
    mimeType: 'image/jpeg',
    kind: 'image',
    width: 1080,
    height: 1080,
    bytes: 240_000,
    source: 'dom',
    status: 'confirmed',
    inRepeatedGroup: withStructure,
    structuralPath: withStructure
      ? path(
          ['img', ['post-media']],
          ['div', ['post-media-wrap']],
          ['article', ['feed-post']],
          ['div', ['feed']],
          ['main', []],
          BODY,
        )
      : [],
  }));
}

/* ---------------------------------------------------------------- *
 * 3. styled-components SPA grid: every class is machine-generated
 * ---------------------------------------------------------------- */

const DYNAMIC_SUFFIX = ['bdVaJa1', 'kAzhQr2', 'jTZlnQ3', 'hUwmXe4', 'pFdkLs5', 'qWnbTy6'];

export function styledComponentsGrid() {
  return DYNAMIC_SUFFIX.map((suffix, i) => ({
    id: `sc-${i}`,
    url: `https://cdn.shop.example/products/sku${1000 + i}/main.webp`,
    mimeType: 'image/webp',
    kind: 'image',
    width: 800,
    height: 800,
    bytes: 90_000,
    source: 'main',
    status: 'confirmed',
    inRepeatedGroup: true,
    // Same visual grid, different generated class on every single node.
    structuralPath: path(
      ['img', [`sc-${suffix}`, 'css-1qx3ab']],
      ['div', [`ProductCard-module__image___${suffix}`]],
      ['li', [`sc-grid${suffix}`, 'is-visible']],
      ['ul', ['ProductGrid-module__grid___a3F9c2']],
      ['section', ['products']],
      ['main', []],
      BODY,
    ),
  }));
}

/* ---------------------------------------------------------------- *
 * 4. One hero image plus a 40-item grid, same host and directory
 * ---------------------------------------------------------------- */

export function heroPlusGrid(gridCount = 40) {
  const base = 'https://news.example.org/wp-content/uploads/2024/08';
  const hero = {
    id: 'hero',
    url: `${base}/hero-banner.jpg`,
    mimeType: 'image/jpeg',
    kind: 'image',
    width: 1600,
    height: 900,
    bytes: 480_000,
    source: 'dom',
    status: 'confirmed',
    inRepeatedGroup: false,
    structuralPath: path(
      ['img', ['hero-image']],
      ['figure', ['post-hero']],
      ['header', ['entry-header']],
      ['article', ['post']],
      ['main', []],
      BODY,
    ),
  };
  const grid = [];
  for (let i = 1; i <= gridCount; i += 1) {
    const n = String(i).padStart(2, '0');
    grid.push({
      id: `grid-${n}`,
      url: `${base}/photo-${n}-400x300.jpg`,
      mimeType: 'image/jpeg',
      kind: 'image',
      width: 400,
      height: 300,
      bytes: 30_000,
      source: 'dom',
      status: 'confirmed',
      inRepeatedGroup: true,
      structuralPath: path(
        ['img', ['grid-thumb']],
        ['a', ['grid-link']],
        ['li', ['grid-item']],
        ['ul', ['photo-grid']],
        ['section', ['gallery']],
        ['article', ['post']],
        ['main', []],
        BODY,
      ),
    });
  }
  return { hero, grid };
}

/* ---------------------------------------------------------------- *
 * 5. UI icon sprite set that must stay out of the content cluster
 * ---------------------------------------------------------------- */

const ICON_NAMES = ['search', 'user', 'cart', 'menu', 'close', 'heart'];

export function iconsAndContent() {
  const icons = ICON_NAMES.map((name, i) => ({
    id: `icon-${name}`,
    url: `https://shop.example.com/assets/icons/${name}-16.png`,
    mimeType: 'image/png',
    kind: 'image',
    width: 16,
    height: 16,
    bytes: 900,
    source: 'dom',
    status: 'confirmed',
    inRepeatedGroup: true,
    structuralPath: path(
      ['img', ['icon']],
      ['button', ['toolbar-button']],
      ['nav', ['toolbar']],
      ['header', ['site-header']],
      BODY,
    ),
    _iconIndex: i,
  }));

  const content = [1, 2, 3, 4, 5, 6].map((i) => ({
    id: `content-${i}`,
    url: `https://shop.example.com/assets/photos/landscape-${i}.jpg`,
    mimeType: 'image/jpeg',
    kind: 'image',
    width: 1200,
    height: 800,
    bytes: 320_000,
    source: 'dom',
    status: 'confirmed',
    inRepeatedGroup: true,
    structuralPath: path(
      ['img', ['product-photo']],
      ['figure', ['product-figure']],
      ['li', ['product-card']],
      ['ul', ['product-list']],
      ['main', []],
      BODY,
    ),
  }));

  return { icons, content };
}

/* ---------------------------------------------------------------- *
 * 6. A 3-slide hero carousel above a 40-item product grid.
 *
 * Independent of heroPlusGrid: here the hero IS inside a repeated
 * structure, so "is in some repeated group" cannot separate them. Same
 * host, same directory, same file type, similar dimensions — only the
 * repeated-group identity distinguishes the two sets.
 * ---------------------------------------------------------------- */

export function carouselHeroPlusGrid({
  gridCount = 40,
  heroWidth = 1440,
  heroHeight = 600,
  gridWidth = 800,
  gridHeight = 800,
} = {}) {
  const base = 'https://shop.example.com/media/catalog';

  // img -> div.hero-slide -> div.hero-carousel -> section.hero -> main -> body
  // The repeating node is div.hero-slide, at index 1 of the element-first path.
  const hero = [];
  for (let i = 1; i <= 3; i += 1) {
    const n = String(i).padStart(2, '0');
    hero.push({
      id: `slide-${n}`,
      url: `${base}/hero-slide-${n}.jpg`,
      mimeType: 'image/jpeg',
      kind: 'image',
      width: heroWidth,
      height: heroHeight,
      bytes: 260_000,
      source: 'dom',
      status: 'confirmed',
      inRepeatedGroup: true,
      repeatDepth: 1,
      structuralPath: path(
        ['img', ['hero-image']],
        ['div', ['hero-slide']],
        ['div', ['hero-carousel']],
        ['section', ['hero']],
        ['main', []],
        BODY,
      ),
    });
  }

  // img -> a -> li.product-card -> ul.product-grid -> section.products -> main -> body
  // The repeating node is li.product-card, at index 2.
  const grid = [];
  for (let i = 1; i <= gridCount; i += 1) {
    const n = String(i).padStart(2, '0');
    grid.push({
      id: `product-${n}`,
      url: `${base}/product-${n}.jpg`,
      mimeType: 'image/jpeg',
      kind: 'image',
      width: gridWidth,
      height: gridHeight,
      bytes: 140_000,
      source: 'dom',
      status: 'confirmed',
      inRepeatedGroup: true,
      repeatDepth: 2,
      structuralPath: path(
        ['img', ['product-photo']],
        ['a', ['product-link']],
        ['li', ['product-card']],
        ['ul', ['product-grid']],
        ['section', ['products']],
        ['main', []],
        BODY,
      ),
    });
  }

  return { hero, grid };
}

/* ---------------------------------------------------------------- *
 * 7. One grid, two kinds of evidence.
 *
 * Some cells were scanned in the DOM; the rest were only ever seen by the
 * network observer, so they have no structural path and no dimensions —
 * exactly what Layer A produces for a feed that has not rendered yet. They
 * belong to the same set and must still cluster with it: missing structure
 * is absence of evidence, not evidence of difference.
 * ---------------------------------------------------------------- */

export function mixedEvidenceGrid({ domCount = 6, networkCount = 3 } = {}) {
  const base = 'https://cdn.example.net/media/library';

  const dom = [];
  for (let i = 1; i <= domCount; i += 1) {
    const n = String(i).padStart(2, '0');
    dom.push({
      id: `dom-${n}`,
      url: `${base}/gallery-item-${n}.jpg`,
      mimeType: 'image/jpeg',
      kind: 'image',
      width: 900,
      height: 600,
      bytes: 180_000,
      source: 'dom',
      sources: ['dom', 'net'],
      status: 'confirmed',
      inRepeatedGroup: true,
      repeatDepth: 2,
      structuralPath: path(
        ['img', ['tile-image']],
        ['a', ['tile-link']],
        ['li', ['tile']],
        ['ul', ['media-library']],
        ['main', []],
        BODY,
      ),
    });
  }

  // Same directory and file type, different filename shape (0.75 on the URL
  // ladder), and no DOM evidence whatsoever.
  const network = [];
  for (let i = 1; i <= networkCount; i += 1) {
    network.push({
      id: `net-${i}`,
      url: `${base}/IMG_4${String(i).padStart(2, '0')}.jpg`,
      mimeType: 'image/jpeg',
      kind: 'image',
      width: 0,
      height: 0,
      bytes: 176_000,
      source: 'net',
      sources: ['net'],
      status: 'background',
      inRepeatedGroup: false,
      repeatDepth: -1,
      structuralPath: [],
    });
  }

  return { dom, network };
}
