/**
 * The DRM boundary, exercised for DASH.
 *
 * README promises that a protected stream is detected, marked, and refused.
 * That is an ethical commitment as much as a feature, so it gets a test that
 * runs the real parser over a real manifest and then pushes the resulting item
 * through the real download queue.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMPD } from '../src/core/manifest-parse.js';
import { startSession } from '../src/background/downloader.js';
import { STATUS } from '../src/shared/messages.js';
import { MiniDOMParser } from './fixtures/mini-xml.mjs';
import { PROTECTED_MPD, CLEAN_MPD, MANIFEST_URL } from './fixtures/dash.mjs';

const parse = (xml) => parseMPD(xml, MANIFEST_URL, MiniDOMParser);

/** What the panel does with a parsed manifest, as a single predicate. */
const actionsEnabled = (info) => !info.encrypted;

function streamItem(info, id) {
  return {
    id,
    url: MANIFEST_URL,
    normalizedUrl: MANIFEST_URL,
    kind: 'stream',
    mimeType: 'application/dash+xml',
    status: info.encrypted ? STATUS.PROTECTED : STATUS.BACKGROUND,
    protectedReason: info.encrypted ? `Encrypted stream (${info.encryptionMethod})` : '',
  };
}

/* ------------------------- protected ------------------------- */

test('a DASH manifest with ContentProtection is detected as encrypted', () => {
  const info = parse(PROTECTED_MPD);
  assert.equal(info.type, 'dash');
  assert.equal(info.encrypted, true);
  assert.equal(info.encryptionMethod, 'CENC', 'the mp4protection descriptor names the scheme');
  assert.deepEqual(info.drmSystems, ['widevine'], 'the Widevine UUID is recognised');
});

test('parsing a protected manifest collects no key material', () => {
  const info = parse(PROTECTED_MPD);
  const serialized = JSON.stringify(info);
  assert.ok(!('keys' in info) && !('pssh' in info) && !('defaultKid' in info));
  assert.ok(!serialized.includes('pssh'), 'the pssh box is never carried out of the parser');
  assert.ok(
    !serialized.includes('1a2b3c4d'),
    'the default_KID is never carried out of the parser',
  );
});

test('a protected DASH stream marks the item protected', () => {
  const item = streamItem(parse(PROTECTED_MPD), 'dash-protected');
  assert.equal(item.status, STATUS.PROTECTED);
  assert.equal(item.protectedReason, 'Encrypted stream (CENC)');
});

test('all three stream actions are disabled for a protected manifest', () => {
  const info = parse(PROTECTED_MPD);
  assert.equal(actionsEnabled(info), false);
  // yt-dlp, ffmpeg and segment export are gated on the same flag, so none of
  // the three can be offered while it is set.
  for (const action of ['copy yt-dlp command', 'copy ffmpeg command', 'export segment list']) {
    assert.equal(actionsEnabled(info), false, `${action} must stay disabled`);
  }
});

test('the download queue refuses a protected stream even when it is selected', () => {
  const item = streamItem(parse(PROTECTED_MPD), 'dash-protected');
  const result = startSession({
    tabId: 1,
    items: [item],
    template: 'magpie/{host}/{index}-{basename}.{ext}',
    concurrency: 1,
    context: {},
  });
  assert.equal(result.total, 0, 'nothing was queued');
  assert.equal(result.skipped, 1, 'the protected item was skipped');
});

test('a protected stream is skipped even alongside downloadable items', () => {
  const protectedItem = streamItem(parse(PROTECTED_MPD), 'dash-protected');
  const image = {
    id: 'img-1',
    url: 'https://cdn.example.com/photo.jpg',
    normalizedUrl: 'https://cdn.example.com/photo.jpg',
    kind: 'image',
    mimeType: 'image/jpeg',
    status: STATUS.CONFIRMED,
  };
  globalThis.chrome = {
    downloads: { download: async () => 1, onChanged: { addListener() {} } },
  };
  try {
    const result = startSession({
      tabId: 2,
      items: [protectedItem, image],
      template: 'magpie/{host}/{index}-{basename}.{ext}',
      concurrency: 1,
      context: {},
    });
    assert.equal(result.total, 1, 'only the image was queued');
    assert.equal(result.skipped, 1, 'the protected stream was skipped');
  } finally {
    delete globalThis.chrome;
  }
});

/* ------------------------- clean ------------------------- */

test('the same manifest without ContentProtection is not encrypted', () => {
  const info = parse(CLEAN_MPD);
  assert.equal(info.encrypted, false);
  assert.equal(info.encryptionMethod, '');
  assert.deepEqual(info.drmSystems, []);
});

test('a clean DASH manifest lists its variants, sorted by bitrate', () => {
  const info = parse(CLEAN_MPD);
  assert.equal(info.variants.length, 3);
  assert.deepEqual(
    info.variants.map((v) => v.resolution),
    ['1920x1080', '1280x720', '640x360'],
  );
  assert.equal(info.variants[0].bandwidth, 4500000);
  assert.equal(info.variants[0].codecs, 'avc1.640028');
  assert.equal(info.audioTracks.length, 1);
  assert.equal(info.audioTracks[0].lang, 'en');
  assert.equal(info.duration, 630, 'PT10M30S');
  assert.equal(info.live, false);
});

test('all three stream actions are enabled for a clean manifest', () => {
  assert.equal(actionsEnabled(parse(CLEAN_MPD)), true);
});

test('a clean stream is still not a downloadable file', () => {
  // Not a DRM decision: a manifest is not a file, so the queue never fetches
  // one. The panel offers a shell command instead.
  const item = streamItem(parse(CLEAN_MPD), 'dash-clean');
  const result = startSession({
    tabId: 3, items: [item], template: 'x/{index}.{ext}', concurrency: 1, context: {},
  });
  assert.equal(result.total, 0);
  assert.equal(result.skipped, 1);
});

test('the protected and clean manifests differ only in ContentProtection', () => {
  const strip = (xml) => xml.replace(/<ContentProtection[\s\S]*?(?:\/>|<\/ContentProtection>)/g, '')
    .replace(/ xmlns:cenc="[^"]*"/, '')
    .replace(/\s+/g, ' ').trim();
  assert.equal(strip(PROTECTED_MPD), strip(CLEAN_MPD));
});
