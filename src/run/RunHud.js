import { WUXING_LABEL } from './TideSchedule.js';
import { t } from '../ui/strings.js';

/**
 * M1's grey readouts: hp, clock, kills, level. The real HUD — glass bottles,
 * orbs, tide banners — is milestone 5; this exists so the grey box is
 * playable and honest, nothing more.
 */
export class RunHud {
  constructor(parent = document.body) {
    this.root = document.createElement('div');
    this.root.className = 'run-hud';
    this.root.innerHTML =
      '<span class="run-hud__bar"><i data-fill></i></span>' +
      '<span data-k="hp"></span><span data-k="time"></span>' +
      '<span data-k="kills"></span><span data-k="level"></span>' +
      '<span data-k="tide"></span><span data-k="resonance"></span>';
    parent.appendChild(this.root);
    this._fields = Object.fromEntries(
      [...this.root.querySelectorAll('[data-k]')].map((el) => [el.dataset.k, el])
    );
    this._fill = this.root.querySelector('[data-fill]');
    this._last = {};
    this._lastPct = -1;
  }

  update(player, run, pickups, tideInfo, resonanceText) {
    // The red bar is the read; the number backs it up. Max HP comes in on the
    // player rather than from settings so this stays a dumb display.
    const pct = Math.round((player.hp / (player.maxHp || 100)) * 100);
    if (pct !== this._lastPct) {
      this._lastPct = pct;
      this._fill.style.width = `${Math.max(0, pct)}%`;
    }
    this._set('hp', `${t('run.hp')} ${Math.ceil(player.hp)}`);
    const s = Math.floor(run.elapsed);
    this._set('time', `${String((s / 60) | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
    this._set('kills', `${t('run.kills')} ${run.kills}`);
    this._set('level', `${t('run.level')} ${pickups.level}`);
    this._set(
      'tide',
      `${WUXING_LABEL[tideInfo.element]}${t('run.tide')} ${Math.ceil(tideInfo.timeLeft)}s · ${t('run.nextTide')} ${WUXING_LABEL[tideInfo.nextElement]}`
    );
    this._set('resonance', resonanceText);
  }

  _set(key, text) {
    if (this._last[key] === text) return;
    this._last[key] = text;
    this._fields[key].textContent = text;
  }

  setVisible(on) {
    this.root.style.display = on ? '' : 'none';
  }

  dispose() {
    this.root.remove();
  }
}
