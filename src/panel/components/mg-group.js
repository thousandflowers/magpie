/**
 * A collapsible cluster: plain-language header, group checkbox, dense grid.
 * The header describes the group the way a person would read it, which is
 * what makes the panel feel like it understood the page.
 */

import { formatBytes } from '../../core/filename.js';

export class MgGroup extends HTMLElement {
  constructor() {
    super();
    this._summary = null;
    this._built = false;
  }

  /**
   * @param {{label: string, count: number, bytes: number, kind: string,
   *          dimensions: string|null, pattern: string|null}} summary
   */
  set summary(summary) {
    this._summary = summary;
    this.build();
  }

  get grid() {
    return this.querySelector('.grid');
  }

  build() {
    if (this._built) {
      this.updateHeader();
      return;
    }
    this._built = true;
    this.textContent = '';
    if (!this.hasAttribute('open')) this.setAttribute('open', '');

    const head = document.createElement('div');
    head.className = 'group-head';
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', 'true');

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'group-check';
    check.setAttribute('aria-label', 'Select every item in this group');
    check.addEventListener('click', (event) => event.stopPropagation());
    check.addEventListener('change', () => {
      this.dispatchEvent(
        new CustomEvent('mg-group-toggle', { bubbles: true, detail: { checked: check.checked } }),
      );
    });

    const caret = document.createElement('span');
    caret.className = 'group-caret';
    caret.textContent = '▾';

    const label = document.createElement('div');
    label.className = 'group-label truncate';

    const count = document.createElement('div');
    count.className = 'group-count';

    head.append(check, caret, label, count);

    const toggle = () => {
      const open = this.toggleAttribute('open');
      caret.textContent = open ? '▾' : '▸';
      head.setAttribute('aria-expanded', String(open));
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });

    const grid = document.createElement('div');
    grid.className = 'grid';

    this.append(head, grid);
    this.updateHeader();
  }

  updateHeader() {
    const s = this._summary;
    if (!s) return;
    const label = this.querySelector('.group-label');
    const count = this.querySelector('.group-count');
    label.textContent = '';
    const strong = document.createElement('b');
    strong.textContent = `${s.count} ${s.kind ? `${s.kind}s` : 'items'}`;
    label.appendChild(strong);
    const rest = [s.dimensions, s.pattern].filter(Boolean).join('  ·  ');
    if (rest) label.append(document.createTextNode(`  ·  ${rest}`));
    label.title = rest || s.label || '';
    count.textContent = s.bytes ? formatBytes(s.bytes) : '';
  }

  /** Reflect how many of this group's items are selected. */
  setSelectionState(selected, total) {
    const check = this.querySelector('.group-check');
    if (!check) return;
    check.checked = total > 0 && selected === total;
    check.indeterminate = selected > 0 && selected < total;
  }
}

customElements.define('mg-group', MgGroup);
