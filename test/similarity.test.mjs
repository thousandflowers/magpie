import test from 'node:test';
import assert from 'node:assert/strict';

import {
  score, explain, cluster, clusterChunked, selectSimilar, describeGroup,
  stripDynamicClasses, structuralSimilarity, urlPatternSimilarity,
  dimensionSimilarity, typeSimilarity, hostSimilarity, DEFAULT_THRESHOLD,
  classEntropy, ENTROPY_THRESHOLD, MAX_DYNAMIC_FREQUENCY, NEUTRAL_STRUCTURE,
} from '../src/core/similarity.js';
import { SIMILARITY_PRESETS } from '../src/core/media-types.js';
import {
  wordpressGallery, hashedCdnFeed, styledComponentsGrid,
  heroPlusGrid, iconsAndContent, carouselHeroPlusGrid, mixedEvidenceGrid,
} from './fixtures/pages.mjs';

const T = DEFAULT_THRESHOLD;

/** Index of the group containing an item with this id. */
function groupOf(groups, id) {
  return groups.findIndex((g) => g.items.some((i) => i.id === id));
}

test('score is bounded, symmetric and reflexive', () => {
  const { thumbs } = wordpressGallery(4);
  const icons = iconsAndContent().icons;
  const all = [...thumbs, ...icons];
  for (const a of all) {
    assert.equal(score(a, a), 1, 'an item is identical to itself');
    for (const b of all) {
      const s = score(a, b);
      assert.ok(s >= 0 && s <= 1, `score out of range: ${s}`);
      assert.ok(
        Math.abs(s - score(b, a)) < 1e-12,
        `score is asymmetric for ${a.id}/${b.id}`,
      );
    }
  }
});

test('the weighted terms actually sum to the composite score', () => {
  const { hero, grid } = heroPlusGrid(2);
  const e = explain(hero, grid[0]);
  const manual =
    0.35 * e.url + 0.25 * e.structure + 0.2 * e.dimension +
    0.1 * e.type + 0.1 * e.host;
  assert.ok(Math.abs(manual - e.total) < 1e-12);
});

/* ---------------------------------------------------------------- */

test('WordPress gallery: -150x150 thumbnails form one cluster', () => {
  const { thumbs } = wordpressGallery(8);
  const groups = cluster(thumbs, T);
  assert.equal(groups.length, 1, 'all eight thumbnails belong together');
  assert.equal(groups[0].size, 8);
  // Identical URL shape + identical structure + identical dimensions.
  assert.ok(score(thumbs[0], thumbs[1]) > 0.95);
});

test('WordPress: a thumbnail still matches its own original, but scores lower', () => {
  const { thumbs, originals } = wordpressGallery(4);
  const sameAsset = score(thumbs[0], originals[0]);
  const siblingThumb = score(thumbs[0], thumbs[1]);
  assert.ok(
    siblingThumb > sameAsset,
    'two same-size thumbs are more similar than a thumb and a full-size original',
  );
  // Same host + same directory + same extension is the 0.75 URL tier.
  assert.equal(urlPatternSimilarity(thumbs[0], originals[0]), 0.75);
});

test('hashed-CDN feed clusters despite shard letters and hex directories', () => {
  const feed = hashedCdnFeed();
  const groups = cluster(feed, T);
  assert.equal(groups.length, 1, 'the whole feed is one group');
  assert.equal(groups[0].size, feed.length);
  // The hex segment is genericised, but the shard letter differs, so the
  // URL term alone is weak and structure has to carry the match.
  assert.ok(urlPatternSimilarity(feed[0], feed[1]) <= 0.4);
  assert.equal(structuralSimilarity(feed[0], feed[1]), 1);
});

test('hashed-CDN feed still clusters with no DOM evidence at all', () => {
  const blind = hashedCdnFeed({ withStructure: false });
  const seen = hashedCdnFeed();
  const blindScore = score(blind[0], blind[1]);
  const seenScore = score(seen[0], seen[1]);

  assert.ok(
    blindScore >= T,
    `network-only items are not punished for having no DOM (${blindScore.toFixed(3)})`,
  );
  assert.equal(cluster(blind, T).length, 1, 'the whole feed is still one group');
  assert.ok(
    seenScore > blindScore,
    'DOM evidence raises confidence; its absence simply does not lower it',
  );
});

test('styled-components grid: generated classes are stripped, grid still clusters', () => {
  const grid = styledComponentsGrid();
  assert.deepEqual(
    stripDynamicClasses(['sc-bdVaJa1', 'css-1qx3ab', 'photo-gallery']),
    ['photo-gallery'],
    'styled-components and emotion classes go, authored classes stay',
  );
  assert.deepEqual(
    stripDynamicClasses(['ProductGrid-module__grid___a3F9c2', 'is-visible', 'grid']),
    ['grid'],
    'CSS-Modules hashes and state classes go',
  );
  assert.equal(
    structuralSimilarity(grid[0], grid[1]), 1,
    'once the noise is stripped the two paths are identical',
  );
  const groups = cluster(grid, T);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].size, grid.length);
});

test('a network-only item still clusters with the grid it belongs to', () => {
  const { dom, network } = mixedEvidenceGrid();
  const groups = cluster([...dom, ...network], T);

  assert.equal(groups.length, 1, 'one grid, one group, whatever the evidence');
  assert.equal(groups[0].size, dom.length + network.length);

  const mixed = score(dom[0], network[0]);
  assert.equal(
    structuralSimilarity(dom[0], network[0]), NEUTRAL_STRUCTURE,
    'the network-only item has no path, so the term abstains',
  );
  assert.ok(mixed >= T, `they cluster (${mixed.toFixed(3)})`);

  // Under the old rule a missing path scored 0, which dragged the same pair
  // below the threshold — absence of evidence was being counted against them.
  const asIfZero = mixed - 0.25 * NEUTRAL_STRUCTURE;
  assert.ok(asIfZero < T, `a hard 0 would have split the grid (${asIfZero.toFixed(3)})`);
});

test('neutral structure does not resurrect a known-different group', () => {
  // The distinction that matters: unknown stays neutral, known-different stays 0.
  const { hero, grid } = carouselHeroPlusGrid();
  assert.equal(structuralSimilarity(hero[0], grid[0]), 0, 'known to be different templates');
  const { network } = mixedEvidenceGrid();
  assert.equal(
    structuralSimilarity(hero[0], network[0]), NEUTRAL_STRUCTURE,
    'nothing known either way',
  );
});

test('hero image lands in its own cluster, apart from the 40-item grid', () => {
  const { hero, grid } = heroPlusGrid(40);
  const groups = cluster([hero, ...grid], T);

  const heroGroup = groupOf(groups, 'hero');
  const gridGroup = groupOf(groups, 'grid-01');
  assert.notEqual(heroGroup, gridGroup, 'hero must not join the grid');
  assert.equal(groups[heroGroup].size, 1, 'hero is alone');
  assert.equal(groups[gridGroup].size, 40, 'the grid stays whole');

  // The hero shares host, directory and extension with every grid item —
  // it is separated by dimensions and by not being in a repeated structure.
  assert.equal(urlPatternSimilarity(hero, grid[0]), 0.75);
  assert.ok(score(hero, grid[0]) < T);
});

test('carousel hero does not cluster with the product grid below it', () => {
  const { hero, grid } = carouselHeroPlusGrid();
  const groups = cluster([...hero, ...grid], T);

  const heroGroup = groupOf(groups, 'slide-01');
  const gridGroup = groupOf(groups, 'product-01');
  assert.notEqual(heroGroup, gridGroup, 'a carousel is not the product grid');
  assert.equal(groups[heroGroup].size, 3, 'the three slides stay together');
  assert.equal(groups[gridGroup].size, 40, 'the grid stays whole');

  // Both sides sit in a repeated structure, so "is repeated" cannot separate
  // them; only the group identity can.
  assert.equal(hero[0].inRepeatedGroup, true);
  assert.equal(grid[0].inRepeatedGroup, true);
  assert.equal(urlPatternSimilarity(hero[0], grid[0]), 0.75, 'same host, directory and extension');
  assert.equal(
    structuralSimilarity(hero[0], grid[0]), 0,
    'different repeated groups means no structural evidence of sameness',
  );
  assert.ok(score(hero[0], grid[0]) < T);
  assert.ok(score(hero[0], hero[1]) > 0.95, 'slides still match each other');
  assert.ok(score(grid[0], grid[1]) > 0.95, 'grid cells still match each other');
});

test('the repeated-group term keys on identity, not on being repeated at all', () => {
  const { hero, grid } = carouselHeroPlusGrid();
  // Same fixture, but with the group identity removed (as an older scan, or a
  // HAR import, would report it). Then the two sets are no longer separable.
  const blind = (item) => ({ ...item, repeatDepth: undefined });
  assert.ok(
    structuralSimilarity(blind(hero[0]), blind(grid[0])) > 0,
    'without repeatDepth the engine falls back to lenient behaviour',
  );
  assert.ok(
    score(blind(hero[0]), blind(grid[0])) > score(hero[0], grid[0]),
    'the identity check is what does the separating',
  );
});

test('carousel separation degrades predictably as dimensions converge', () => {
  // Documented sensitivity: with structure zeroed, the remaining terms are
  // url 0.75, type 1 and host 1, which alone total 0.4625. The dimension term
  // is therefore what decides how much headroom is left under 0.62.
  const wide = carouselHeroPlusGrid();
  const near = carouselHeroPlusGrid({ heroWidth: 1200, heroHeight: 800, gridWidth: 900, gridHeight: 800 });
  const wideScore = score(wide.hero[0], wide.grid[0]);
  const nearScore = score(near.hero[0], near.grid[0]);
  assert.ok(wideScore < T, `realistic carousel shape separates (${wideScore.toFixed(4)})`);
  assert.ok(nearScore < T, `near-identical dimensions still separate (${nearScore.toFixed(4)})`);
  assert.ok(nearScore > wideScore, 'closer dimensions score higher, as they should');
});

test('icon sprite set does not cluster with content images', () => {
  const { icons, content } = iconsAndContent();
  const groups = cluster([...icons, ...content], T);
  assert.equal(groups.length, 2, 'icons and photos are two separate groups');

  const iconGroup = groups[groupOf(groups, 'icon-search')];
  const contentGroup = groups[groupOf(groups, 'content-1')];
  assert.equal(iconGroup.size, icons.length);
  assert.equal(contentGroup.size, content.length);
  assert.ok(score(icons[0], content[0]) < 0.5);
});

/* ---------------------------------------------------------------- */

test('individual terms behave as specified', () => {
  const a = { url: 'https://x.example/img/a.jpg', mimeType: 'image/jpeg', width: 100, height: 100 };
  const b = { url: 'https://x.example/img/b.jpg', mimeType: 'image/jpeg', width: 100, height: 100 };
  const c = { url: 'https://y.other/img/c.png', mimeType: 'image/png', width: 400, height: 100 };

  assert.equal(dimensionSimilarity(a, b), 1);
  assert.equal(dimensionSimilarity(a, { url: 'x' }), 0.5, 'unknown dimensions are neutral');
  assert.equal(typeSimilarity(a, b), 1);
  assert.equal(typeSimilarity(a, c), 0.6, 'same top-level type');
  assert.equal(typeSimilarity(a, { url: 'v.mp4', mimeType: 'video/mp4' }), 0);
  assert.equal(hostSimilarity(a, b), 1);
  assert.equal(hostSimilarity(a, c), 0);
  assert.equal(
    hostSimilarity(a, { url: 'https://cdn.example/img/d.jpg' }), 0,
    'different registrable domains score zero',
  );
  assert.equal(
    hostSimilarity(
      { url: 'https://a.site.co.uk/i.jpg' },
      { url: 'https://b.site.co.uk/i.jpg' },
    ),
    0.7,
    'same registrable domain across subdomains',
  );
  assert.equal(
    structuralSimilarity(a, b), NEUTRAL_STRUCTURE,
    'no structural path means no structural evidence, which is neutral',
  );
  assert.equal(NEUTRAL_STRUCTURE, 0.5, 'the same neutral value dimensions use');
});

test('class frequency decides, when the scanner supplies it', () => {
  // Counts measured from the real DOM scan of the fixture gallery.
  const counts = {
    'grid-thumb': 12, 'grid-item': 12, 'photo-grid': 1, 'gallery': 1,
    'hero-image': 1, 'post-hero': 1, 'sc-bdVaJa1': 1, 'css-1qx3ab': 2,
    'ProductGrid-module__grid___a3F9c2': 1,
  };
  assert.deepEqual(
    stripDynamicClasses(['grid-thumb', 'sc-bdVaJa1'], counts),
    ['grid-thumb'],
    'a class on 12 siblings is structural; one on a single element is not',
  );
  assert.deepEqual(
    stripDynamicClasses(['hero-image', 'photo-grid', 'gallery'], counts),
    ['gallery', 'hero-image', 'photo-grid'],
    'rare but word-like classes survive — rarity alone is not enough',
  );
  assert.deepEqual(
    stripDynamicClasses(['ProductGrid-module__grid___a3F9c2', 'css-1qx3ab'], counts), [],
    'rare and high-entropy goes',
  );
});

test('a frequent class survives even when it looks generated', () => {
  // The whole point of counting: shape says "hash", the DOM says "template".
  const token = 'sc-bdVaJa1';
  assert.ok(classEntropy(token) >= ENTROPY_THRESHOLD, 'it does look generated');
  assert.deepEqual(stripDynamicClasses([token], { [token]: 40 }), [token.toLowerCase()]);
  assert.deepEqual(stripDynamicClasses([token], { [token]: MAX_DYNAMIC_FREQUENCY }), []);
});

test('without counts the shape heuristic still decides', () => {
  assert.deepEqual(
    stripDynamicClasses(['sc-bdVaJa1', 'css-1qx3ab', 'photo-gallery']),
    ['photo-gallery'],
    'HAR-sourced and network-only items keep the old behaviour',
  );
  assert.deepEqual(
    stripDynamicClasses(['grid-thumb', 'sc-bdVaJa1'], { 'grid-thumb': 12 }),
    ['grid-thumb'],
    'a class missing from the map falls back to the heuristic individually',
  );
});

test('classEntropy separates words from hashes', () => {
  for (const word of ['photo-gallery', 'grid-item', 'hero-image', 'toolbar-button', 'product-photo']) {
    assert.ok(classEntropy(word) < ENTROPY_THRESHOLD, `${word} reads as authored (${classEntropy(word).toFixed(2)})`);
  }
  for (const hash of ['sc-bdVaJa1', 'css-1qx3ab', 'ProductCard-module__image___bdVaJa1', 'a3F9c2b1']) {
    assert.ok(classEntropy(hash) >= ENTROPY_THRESHOLD, `${hash} reads as generated (${classEntropy(hash).toFixed(2)})`);
  }
  assert.equal(classEntropy(''), 0);
  assert.equal(classEntropy('ab'), 0, 'too short to judge');
});

test('threshold presets widen and tighten a selection', () => {
  const { hero, grid } = heroPlusGrid(6);
  const all = [hero, ...grid];
  const loose = selectSimilar(grid[0], all, SIMILARITY_PRESETS.loose);
  const balanced = selectSimilar(grid[0], all, SIMILARITY_PRESETS.balanced);
  const strict = selectSimilar(grid[0], all, SIMILARITY_PRESETS.strict);
  assert.ok(loose.length >= balanced.length);
  assert.ok(balanced.length >= strict.length);
  assert.equal(balanced.length, 6, 'balanced picks the grid and nothing else');
  assert.equal(balanced[0].item.id, grid[0].id, 'the seed is first');
  assert.ok(loose.length > balanced.length, 'loose reaches the hero too');
});

test('chunked clustering agrees with the one-shot version', () => {
  const { hero, grid } = heroPlusGrid(20);
  const all = [hero, ...grid];
  const oneShot = cluster(all, T);

  // Force a yield on every single pair comparison.
  let tick = 0;
  const now = () => (tick += 100);
  let out = clusterChunked(all, T, null, 12, now);
  let guard = 0;
  while (!out.done) {
    out = clusterChunked(all, T, out.state, 12, now);
    guard += 1;
    assert.ok(guard < 100000, 'chunked clustering must terminate');
  }
  assert.deepEqual(
    out.groups.map((g) => g.size),
    oneShot.map((g) => g.size),
  );
});

test('describeGroup produces a readable header', () => {
  const { grid } = heroPlusGrid(40);
  const d = describeGroup(grid);
  assert.equal(d.count, 40);
  assert.equal(d.dimensions, '400x300');
  assert.ok(d.label.startsWith('40 images · 400x300 · news.example.org'));
  assert.ok(d.pattern.includes('photo-#-#x#.jpg'), `pattern was ${d.pattern}`);
  assert.equal(describeGroup([]).count, 0);
});

test('empty and degenerate inputs do not throw', () => {
  assert.deepEqual(cluster([], T), []);
  assert.equal(score(null, {}), 0);
  // Two empty URLs share nothing but the two neutral terms: structure and
  // dimensions, both unknown, at 0.5 each.
  assert.equal(score({ url: '' }, { url: '' }), 0.225);
  assert.equal(cluster([{ url: 'https://a/x.jpg' }], T).length, 1);
});
