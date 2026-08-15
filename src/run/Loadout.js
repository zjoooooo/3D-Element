import { settings } from '../config/settings.js';

/**
 * Who is on stage this run (spec §6).
 *
 * Six seats in key order [LMB, RMB, Q, E, R, T]. A drafted run starts with
 * seat 0 only — the editor's Run dropdowns stay the debug override via
 * `draftLoadout: false`, which copies the whole configured six for testing.
 * Seats are run state, never written back into settings.
 */
export class Loadout {
  constructor() {
    this.seats = [null, null, null, null, null, null];
    this._levels = Object.create(null);
  }

  reset() {
    const configured = settings.run.loadout;
    this._levels = Object.create(null);
    for (let seat = 0; seat < 6; seat++) {
      const keep = settings.run.draftLoadout ? seat === 0 : true;
      this.seats[seat] = keep ? configured[seat] : null;
      if (this.seats[seat]) this._levels[this.seats[seat]] = 1;
    }
  }

  elementAt(seat) {
    return this.seats[seat] ?? null;
  }

  equippedList() {
    return this.seats.filter(Boolean);
  }

  hasEmpty() {
    return this.seats.includes(null);
  }

  has(element) {
    return this.seats.includes(element);
  }

  acquire(element) {
    if (this.has(element)) return -1;
    const seat = this.seats.indexOf(null);
    if (seat === -1) return -1;
    this.seats[seat] = element;
    this._levels[element] = 1;
    return seat;
  }

  levelOf(element) {
    return this._levels[element] ?? 0;
  }

  upgrade(element) {
    const level = this.levelOf(element);
    if (level === 0 || level >= settings.upgrades.skillLevelMax) return false;
    this._levels[element] = level + 1;
    return true;
  }

  isMaxed(element) {
    return this.levelOf(element) >= settings.upgrades.skillLevelMax;
  }
}
