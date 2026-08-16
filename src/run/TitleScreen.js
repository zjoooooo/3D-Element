import { CHARACTERS } from '../animation/CharacterController.js';
import { ELEMENT_SIGILS } from '../ui/glyphs.js';
import { ELEMENT_META, settings } from '../config/settings.js';
import { WUXING_LABEL } from './TideSchedule.js';
import { t } from '../ui/strings.js';

/**
 * Wuxing index (WUXING_LABEL order, 金木水火土) → the 本命 skill it seats at
 * loadout slot 0. Two skills share wuxing 3 (meteor, fireball both cast as
 * 火) so this can't be derived generically off `settings.combat.wuxingOf`
 * the way RunManager's own `wuxingRep()` picks a "first match" — the spec's
 * title screen names fireball specifically. Index 4 (土) has no skill until
 * M6, hence the disabled placeholder card.
 */
const HOME_ELEMENT = ['beam', 'thunder', 'ice', 'fireball', null];

/**
 * The run's front door (spec §9 / §9.5): world lore, five 本命 cards (one
 * per wuxing — four pickable, 土 a disabled placeholder), a link out to the
 * sandbox, the character dropdown (same switch path the sandbox editor's own
 * dropdown already uses), and the photosensitivity small print.
 *
 * Shown on `#run` instead of auto-starting a run; App shows/hides this one
 * instance across a session (回标题 re-shows it) rather than rebuilding it —
 * its content never changes after construction.
 */
export class TitleScreen {
  /** @param {{onStart: (element: string) => void, onCharacter: (id: string) => void}} hooks */
  constructor({ onStart, onCharacter }, parent = document.body) {
    this.onStart = onStart;
    this.onCharacter = onCharacter;

    this.root = document.createElement('div');
    this.root.className = 'title-screen';
    this._render();
    parent.appendChild(this.root);
  }

  _render() {
    const cards = WUXING_LABEL.map((label, wux) => {
      const element = HOME_ELEMENT[wux];
      if (!element) {
        return (
          `<div class="title-screen__card title-screen__card--disabled">` +
          `<span class="title-screen__glyph">${label}</span>` +
          `<b>${label}</b>` +
          `<span class="title-screen__note">${t('title.earthSoon')}</span>` +
          `</div>`
        );
      }
      const meta = ELEMENT_META[element];
      return (
        `<button class="title-screen__card" data-element="${element}" style="--accent:${meta?.accent ?? ''}">` +
        `<span class="title-screen__glyph">${ELEMENT_SIGILS[element] ?? ''}</span>` +
        `<b>${label}</b>` +
        `<span class="title-screen__note">${meta?.label ?? element}</span>` +
        `</button>`
      );
    }).join('');

    const characterOptions = Object.keys(CHARACTERS)
      .map((id) => `<option value="${id}"${id === settings.character.model ? ' selected' : ''}>${id}</option>`)
      .join('');

    this.root.innerHTML =
      `<div class="title-screen__dim"></div>` +
      `<div class="title-screen__panel">` +
      `<h1 class="title-screen__logo">${t('title.name')}</h1>` +
      `<p class="title-screen__lore">${t('title.lore')}</p>` +
      `<div class="title-screen__cards">${cards}</div>` +
      `<div class="title-screen__row">` +
      `<label class="title-screen__character">${t('title.character')}` +
      `<select data-character>${characterOptions}</select></label>` +
      `<a class="title-screen__sandbox" data-sandbox href="./">${t('title.sandbox')}</a>` +
      `</div>` +
      `<p class="title-screen__note title-screen__photosensitivity">${t('title.photosensitivity')}</p>` +
      `</div>`;

    this.root.querySelectorAll('[data-element]').forEach((btn) =>
      btn.addEventListener('click', () => this.onStart?.(btn.dataset.element))
    );
    this.root.querySelector('[data-character]').addEventListener('change', (event) =>
      this.onCharacter?.(event.target.value)
    );
    // Real navigation, not just a hash edit — App reads location.hash once at
    // boot, so only a fresh load without #run actually lands in the sandbox.
    this.root.querySelector('[data-sandbox]').href = location.pathname + location.search;
  }

  show() {
    this.root.style.display = '';
  }

  hide() {
    this.root.style.display = 'none';
  }

  dispose() {
    this.root.remove();
  }
}
