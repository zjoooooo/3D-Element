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

  show({ won, elapsed, kills, level, buildLines, topSkills, deathLine }) {
    const s = Math.floor(elapsed);
    const time = `${String((s / 60) | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    this.root.innerHTML =
      `<h2>${won ? '生存达成' : '倒下了'}</h2>` +
      `<p>存活 ${time} · 击杀 ${kills} · Lv ${level}</p>` +
      `<p class="verdict__build">${buildLines.join('<br>')}</p>` +
      (topSkills.length
        ? `<p>输出前三：${topSkills.map(([name, amount]) => `${name} ${Math.round(amount)}`).join(' / ')}</p>`
        : '') +
      (deathLine ? `<p class="verdict__death">${deathLine}</p>` : '') +
      `<p class="verdict__hint">回车重开</p>`;
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
