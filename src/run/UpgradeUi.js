import { ELEMENT_META } from '../config/settings.js';

/**
 * The level-up hand (spec §6): world frozen behind a dim, three cards, keys
 * 1/2/3 or click, skip heals, reroll while 时来运转 has charges. Grey-box
 * styling — the gilded card art belongs to M5.
 *
 * Owns its keydown in the capture phase so the game's InputManager never sees
 * a keystroke while a hand is open; that plus App's freeze gate is the whole
 * "run pause is a full stop" contract.
 */
export class UpgradeUi {
  constructor(parent = document.body) {
    this.root = document.createElement('div');
    this.root.className = 'upgrade-ui';
    this.root.style.display = 'none';
    parent.appendChild(this.root);
    this.onChoice = null;
    this._cards = [];
    this._open = false;
    window.addEventListener('keydown', this._onKey, true);
  }

  get isOpen() {
    return this._open;
  }

  open(cards, { rerolls = 0, summary = '' } = {}) {
    this._cards = cards;
    this._open = true;
    const body = cards
      .map((card, i) => {
        const element = card.element ? (ELEMENT_META[card.element]?.label ?? card.element) : '';
        return (
          `<button class="upgrade-ui__card" data-i="${i}">` +
          `<b>${i + 1}</b><em>${element ? element + ' · ' : ''}${card.title}</em>` +
          `<span>${card.body}</span></button>`
        );
      })
      .join('');
    this.root.innerHTML =
      `<div class="upgrade-ui__dim"></div><div class="upgrade-ui__panel">` +
      `<p class="upgrade-ui__head">${cards.length ? '升级！选择其一' : '无可选项'}</p>` +
      `<div class="upgrade-ui__hand">${body}</div>` +
      `<div class="upgrade-ui__row">` +
      `<button class="upgrade-ui__minor" data-act="skip">弃权 · 回复生命 (4)</button>` +
      (rerolls > 0
        ? `<button class="upgrade-ui__minor" data-act="reroll">时来运转 · 刷新 ×${rerolls}</button>`
        : '') +
      `</div><p class="upgrade-ui__summary">${summary}</p></div>`;
    this.root.style.display = '';
    this.root.querySelectorAll('[data-i]').forEach((el) =>
      el.addEventListener('click', () => this._pick(Number(el.dataset.i)))
    );
    this.root.querySelector('[data-act="skip"]').addEventListener('click', () =>
      this._emit({ action: 'skip' })
    );
    this.root.querySelector('[data-act="reroll"]')?.addEventListener('click', () =>
      this._emit({ action: 'reroll' })
    );
  }

  close() {
    this._open = false;
    this.root.style.display = 'none';
    this.root.innerHTML = '';
  }

  _pick(i) {
    if (this._cards[i]) this._emit({ action: 'pick', card: this._cards[i] });
  }

  _emit(result) {
    this.close();
    this.onChoice?.(result);
  }

  _onKey = (event) => {
    if (!this._open) return;
    event.stopPropagation();
    if (event.key >= '1' && event.key <= '3') this._pick(Number(event.key) - 1);
    else if (event.key === '4') this._emit({ action: 'skip' });
    else return;
    event.preventDefault();
  };

  dispose() {
    window.removeEventListener('keydown', this._onKey, true);
    this.root.remove();
  }
}
