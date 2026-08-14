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
      '<span data-k="hp"></span><span data-k="time"></span>' +
      '<span data-k="kills"></span><span data-k="level"></span>';
    parent.appendChild(this.root);
    this._fields = Object.fromEntries(
      [...this.root.querySelectorAll('[data-k]')].map((el) => [el.dataset.k, el])
    );
    this._last = {};
  }

  update(player, run, pickups) {
    this._set('hp', `HP ${Math.ceil(player.hp)}`);
    const s = Math.floor(run.elapsed);
    this._set('time', `${String((s / 60) | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
    this._set('kills', `击杀 ${run.kills}`);
    this._set('level', `Lv ${pickups.level}`);
  }

  _set(key, text) {
    if (this._last[key] === text) return;
    this._last[key] = text;
    this._fields[key].textContent = text;
  }

  setVisible(on) {
    this.root.style.display = on ? '' : 'none';
  }

  showVerdict(text) {
    this._set('hp', text);
  }

  dispose() {
    this.root.remove();
  }
}
