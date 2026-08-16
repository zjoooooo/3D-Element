import { settings } from '../config/settings.js';
import { t } from '../ui/strings.js';

/**
 * Esc's run-mode destination (spec §9/§9.5): three live volume sliders, a
 * zh/en language toggle, reduceFlashes/performanceMode checkboxes, a
 * read-only build recap (skills/levels/resonance — spec's "可查看 build 全览",
 * off the same summary lines the level-up hand and verdict screen already
 * build), and 重开/回标题/继续.
 *
 * Opening it is a full stop, same as a level-up hand — App's frame loop
 * freezes on the same gate `UpgradeUi.isOpen` already drives (see App's
 * `_frozen` getter). So this owns its own window keydown handler the same
 * way `UpgradeUi` owns 1/2/3/4, closing itself on Escape before
 * InputManager's own keydown handler gets a turn — see `_onKey`'s own
 * comment for exactly how that ordering is kept (it is not simply "capture
 * beats bubble").
 *
 * Volume/reduceFlashes bind straight to `settings.ui` on input — no App
 * round-trip needed, since every consumer (GameAudio, ScreenFlash, ...)
 * already reads that object live. performanceMode is the one exception: it
 * *also* writes into `settings.global`'s multipliers, which is App's call
 * (`onPerfModeChange`), not this component's.
 */
export class PauseMenu {
  /**
   * @param {{onRestart: Function, onReturnToTitle: Function,
   *   onLanguageChange: Function, onPerfModeChange: (on: boolean) => void,
   *   getBuildSummary: () => {lines: string[], resonance: string}}} hooks
   */
  constructor(hooks = {}, parent = document.body) {
    this.hooks = hooks;
    this.root = document.createElement('div');
    this.root.className = 'pause-menu';
    this.root.style.display = 'none';
    parent.appendChild(this.root);
    this._open = false;
    window.addEventListener('keydown', this._onKey, true);
  }

  get isOpen() {
    return this._open;
  }

  open() {
    this._open = true;
    this._render();
    this.root.style.display = '';
  }

  close() {
    this._open = false;
    this.root.style.display = 'none';
    this.root.innerHTML = '';
  }

  /** Rebuilt on every open() and again on a language flip (while still open)
   * so its own labels never sit stale in the language the panel opened in. */
  _render() {
    const ui = settings.ui;
    const summary = this.hooks.getBuildSummary?.() ?? { lines: [], resonance: '' };

    this.root.innerHTML =
      `<div class="pause-menu__dim"></div>` +
      `<div class="pause-menu__panel">` +
      `<h2>${t('pause.title')}</h2>` +
      `<label class="pause-menu__row">${t('pause.sfx')}` +
      `<input type="range" min="0" max="1" step="0.01" value="${ui.sfxVolume}" data-vol="sfxVolume"></label>` +
      `<label class="pause-menu__row">${t('pause.ui')}` +
      `<input type="range" min="0" max="1" step="0.01" value="${ui.uiVolume}" data-vol="uiVolume"></label>` +
      `<label class="pause-menu__row">${t('pause.bgm')}` +
      `<input type="range" min="0" max="1" step="0.01" value="${ui.bgmVolume}" data-vol="bgmVolume"></label>` +
      `<div class="pause-menu__row pause-menu__lang-row">` +
      `<button class="pause-menu__lang${ui.language === 'zh' ? ' is-active' : ''}" data-lang="zh">中文</button>` +
      `<button class="pause-menu__lang${ui.language === 'en' ? ' is-active' : ''}" data-lang="en">EN</button>` +
      `</div>` +
      `<label class="pause-menu__row"><input type="checkbox" data-flashes${ui.reduceFlashes ? ' checked' : ''}>` +
      `${t('pause.reduceFlashes')}</label>` +
      `<label class="pause-menu__row"><input type="checkbox" data-perf${ui.performanceMode ? ' checked' : ''}>` +
      `${t('pause.performanceMode')}</label>` +
      (summary.lines.length
        ? `<div class="pause-menu__build"><b>${t('pause.build')}</b><p>${summary.lines.join('<br>')}</p>` +
          (summary.resonance ? `<p>${summary.resonance}</p>` : '') +
          `</div>`
        : '') +
      `<div class="pause-menu__actions">` +
      `<button data-act="resume">${t('pause.resume')}</button>` +
      `<button data-act="restart">${t('pause.restart')}</button>` +
      `<button data-act="title">${t('pause.toTitle')}</button>` +
      `</div>` +
      `</div>`;

    this.root.querySelectorAll('[data-vol]').forEach((input) => {
      input.addEventListener('input', (event) => {
        settings.ui[event.target.dataset.vol] = Number(event.target.value);
      });
    });
    this.root.querySelectorAll('[data-lang]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (settings.ui.language === btn.dataset.lang) return;
        settings.ui.language = btn.dataset.lang;
        this._render(); // this panel's own labels flip immediately, not just RunHud's
        this.hooks.onLanguageChange?.();
      });
    });
    this.root.querySelector('[data-flashes]').addEventListener('change', (event) => {
      settings.ui.reduceFlashes = event.target.checked;
    });
    this.root.querySelector('[data-perf]').addEventListener('change', (event) => {
      settings.ui.performanceMode = event.target.checked;
      this.hooks.onPerfModeChange?.(event.target.checked);
    });
    this.root.querySelector('[data-act="resume"]').addEventListener('click', () => this.close());
    this.root.querySelector('[data-act="restart"]').addEventListener('click', () => {
      this.close();
      this.hooks.onRestart?.();
    });
    this.root.querySelector('[data-act="title"]').addEventListener('click', () => {
      this.close();
      this.hooks.onReturnToTitle?.();
    });
  }

  _onKey = (event) => {
    if (!this._open) return;
    // stopImmediatePropagation, not stopPropagation: event.target is window
    // itself here (both this listener and InputManager's sit directly on
    // window), so there is no separate node for a plain stopPropagation to
    // stop the event *before* — same-node listeners still all run in
    // registration order regardless. Without the immediate variant,
    // InputManager's own keydown handler would still fire right after this
    // one for the exact same Escape press: this.close() has already run by
    // then, so it would read _frozen as false and hand the key to App's
    // cancel handler, which reopens the menu it was just told to close.
    event.stopImmediatePropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    }
  };

  dispose() {
    window.removeEventListener('keydown', this._onKey, true);
    this.root.remove();
  }
}
