/**
 * One media tile. Light DOM on purpose, so panel.css styles it and the whole
 * grid stays one stylesheet rather than N shadow roots.
 *
 * Thumbnails are only fetched once the tile scrolls into view: a Pinterest
 * page produces hundreds of items and the panel must not stutter.
 */

import { formatBytes } from '../../core/filename.js';

const KIND_GLYPH = {
  image: 'IMG',
  video: 'VID',
  audio: 'AUD',
  stream: 'STRM',
  text: 'TXT',
};

export class MgItem extends HTMLElement {
  static observedAttributes = ['selected'];

  constructor() {
    super();
    this._item = null;
    this._revealed = false;
    this._score = null;
  }

  /** @param {object} item candidate */
  set item(item) {
    this._item = item;
    this.dataset.status = item.status || '';
    this.id = `item-${item.id}`;
    this.tabIndex = 0;
    this.setAttribute('role', 'checkbox');
    this.setAttribute('aria-checked', this.hasAttribute('selected') ? 'true' : 'false');
    this.render();
  }

  get item() {
    return this._item;
  }

  /** Similarity score against the current seed, shown as a badge. */
  set score(value) {
    this._score = value;
    const badge = this.querySelector('.badge.score');
    if (value == null) {
      if (badge) badge.remove();
      return;
    }
    const text = value.toFixed(2);
    if (badge) badge.textContent = text;
    else {
      const el = document.createElement('span');
      el.className = 'badge score';
      el.textContent = text;
      this.appendChild(el);
    }
  }

  attributeChangedCallback(name) {
    if (name === 'selected') {
      this.setAttribute('aria-checked', this.hasAttribute('selected') ? 'true' : 'false');
    }
  }

  render() {
    const item = this._item;
    if (!item) return;
    this.textContent = '';

    const box = document.createElement('div');
    box.className = 'thumb-box';
    const dims = item.width && item.height ? `${item.width}×${item.height}` : '';
    if (dims) box.style.aspectRatio = `${item.width} / ${item.height}`;

    const glyph = document.createElement('div');
    glyph.className = 'thumb-glyph';
    glyph.textContent = KIND_GLYPH[item.kind] || 'FILE';
    box.appendChild(glyph);
    this.appendChild(box);

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    const left = document.createElement('span');
    left.textContent = dims || (KIND_GLYPH[item.kind] || 'FILE').toLowerCase();
    const right = document.createElement('span');
    right.textContent = item.bytes ? formatBytes(item.bytes) : '';
    meta.append(left, right);
    this.appendChild(meta);

    if (item.status === 'protected') {
      const badge = document.createElement('span');
      badge.className = 'badge protected';
      badge.textContent = 'DRM';
      badge.title = item.protectedReason || 'DRM protected — not downloadable';
      this.appendChild(badge);
    } else if (item.status === 'unavailable') {
      const badge = document.createElement('span');
      badge.className = 'badge protected';
      badge.textContent = 'N/A';
      badge.title = item.protectedReason || 'Not retrievable from this page';
      this.appendChild(badge);
    } else if (item.upgradeVerified) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'HD';
      badge.title = `Upgraded: ${item.upgradeNote || 'higher resolution available'}`;
      this.appendChild(badge);
    }

    this.title = item.url;
    if (this._score != null) this.score = this._score;
    if (this._revealed) this.reveal();
  }

  /** Called by the panel's IntersectionObserver. */
  reveal() {
    this._revealed = true;
    const item = this._item;
    if (!item || item.kind !== 'image') return;
    if (item.url.startsWith('magpie-')) return; // synthetic: captured on demand
    const box = this.querySelector('.thumb-box');
    if (!box || box.querySelector('img')) return;

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = item.alt || '';
    img.addEventListener('error', () => {
      // A preview that does not load falls back to the file itself, once.
      if (img.src !== item.url && /^https?:/i.test(item.url)) img.src = item.url;
      else img.remove();
    });
    img.addEventListener(
      'load',
      () => {
        const glyph = box.querySelector('.thumb-glyph');
        if (glyph) glyph.remove();
      },
      { once: true },
    );
    img.src = item.previewUrl || item.url;
    box.appendChild(img);
  }
}

customElements.define('mg-item', MgItem);
