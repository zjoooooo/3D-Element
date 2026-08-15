import { settings } from '../config/settings.js';
import { FEEDS } from './TideSchedule.js';
import { FUSIONS, fusionKey, fusionId, isFusionId } from './fusions.js';

/**
 * Who is on stage this run (spec §6).
 *
 * Six seats in key order [LMB, RMB, Q, E, R, T]. A drafted run starts with
 * seat 0 only — the editor's Run dropdowns stay the debug override via
 * `draftLoadout: false`, which copies the whole configured six for testing.
 * Seats are run state, never written back into settings.
 *
 * A seat can also hold a fusion id (spec §4.7): two ripe plain elements in a
 * 相生 pair merge into one seat via `fuse`, freeing the other. `_levels` keys
 * off whatever string sits in a seat either way, so a fusion id levels the
 * same as a plain element — only its own cap differs (`settings.fusion.maxLevel`).
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
      const element = keep ? configured[seat] : null;
      // A debug loadout that repeats an id would deal duplicate cards later —
      // first seat wins, repeats sit out (M2 ledger).
      this.seats[seat] = element && !this.seats.slice(0, seat).includes(element) ? element : null;
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
    if (level === 0 || level >= this._maxLevelFor(element)) return false;
    this._levels[element] = level + 1;
    return true;
  }

  isMaxed(element) {
    return this.levelOf(element) >= this._maxLevelFor(element);
  }

  /** A fusion id caps at `fusion.maxLevel`; a plain element at `upgrades.skillLevelMax`. */
  _maxLevelFor(id) {
    return isFusionId(id) ? settings.fusion.maxLevel : settings.upgrades.skillLevelMax;
  }

  /** Seated plain-element pairs ripe to fuse (spec §4.7): both at
   * `fusion.minLevel`+ and `a`'s wuxing generates `b`'s (相生, FEEDS).
   * Direction matters, so (a, b) and (b, a) are scored separately. */
  eligibleFusions() {
    const wuxingOf = settings.combat.wuxingOf;
    const seated = this.equippedList().filter((id) => !isFusionId(id));
    const out = [];
    for (const a of seated) {
      if (this.levelOf(a) < settings.fusion.minLevel) continue;
      for (const b of seated) {
        if (b === a || this.levelOf(b) < settings.fusion.minLevel) continue;
        if (FEEDS[wuxingOf[a]] !== wuxingOf[b]) continue;
        const name = FUSIONS[fusionKey(wuxingOf[a], wuxingOf[b])]?.name;
        if (name) out.push({ a, b, name });
      }
    }
    return out;
  }

  /** Merge a ripe pair into `a`'s seat, freeing `b`'s. Returns the new
   * fusion id, or null if the pair isn't (or no longer) eligible. */
  fuse(a, b) {
    if (!this.eligibleFusions().some((f) => f.a === a && f.b === b)) return null;
    const id = fusionId(a, b);
    this.seats[this.seats.indexOf(a)] = id;
    this.seats[this.seats.indexOf(b)] = null;
    delete this._levels[a];
    delete this._levels[b];
    this._levels[id] = 1;
    return id;
  }
}
