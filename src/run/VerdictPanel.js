import { t } from '../ui/strings.js';

/**
 * The end card (spec §7 结算): stats, the build, the top three skills and one
 * line about what killed you — plus the advice the wuxing table implies. Grey
 * DOM for now; M5 dresses it.
 */
export class VerdictPanel {
  constructor(parent = document.body) {
    this.root = document.createElement('div');
    this.root.className = 'verdict';
    this.root.style.display = 'none';
    parent.appendChild(this.root);
    this.isOpen = false;
  }

  /**
   * @param {boolean} [canContinue] M9 T3: offer the endless half. Only a
   *   fresh win offers it — once carried on, dying ends the run for good.
   * @param {boolean} [cleared] M9 T3: this run already crossed the finish
   *   line, so a death here is a cleared run rather than a failed one.
   */
  show({ won, elapsed, kills, level, buildLines, topSkills, deathLine, canContinue = false, cleared = false }) {
    const s = Math.floor(elapsed);
    const time = `${String((s / 60) | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    this.root.innerHTML =
      `<h2>${won ? t('verdict.won') : t('verdict.lost')}${cleared && !won ? ` · ${t('verdict.cleared')}` : ''}</h2>` +
      `<p>${t('verdict.survived')} ${time} · ${t('run.kills')} ${kills} · ${t('run.level')} ${level}</p>` +
      `<p class="verdict__build">${buildLines.join('<br>')}</p>` +
      (topSkills.length
        ? `<p>${t('verdict.topSkills')}${topSkills.map(([name, amount]) => `${name} ${Math.round(amount)}`).join(' / ')}</p>`
        : '') +
      (deathLine ? `<p class="verdict__death">${deathLine}</p>` : '') +
      (canContinue ? `<p class="verdict__hint verdict__hint--endless">${t('verdict.endless')}</p>` : '') +
      `<p class="verdict__hint">${t('verdict.restart')}</p>`;
    this.root.style.display = '';
    this.isOpen = true;
  }

  hide() {
    this.root.style.display = 'none';
    this.isOpen = false;
  }

  dispose() {
    this.root.remove();
  }
}
