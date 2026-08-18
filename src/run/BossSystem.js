import { settings } from '../config/settings.js';
import { BOSS_BEHAVIOR } from './EnemySystem.js';

/**
 * 首领战 (M11 T3) — the encounter, not the body.
 *
 * The body lives in `EnemySystem` as one more enemy with `behavior === boss`,
 * which is the whole trick: every hit test, mark, debuff and reaction in the
 * game reaches it through code that already runs, so "no special cases in the
 * judging layer" is true by construction rather than by vigilance. A boss with
 * its own hit test is how you ship one that six skills quietly cannot touch.
 *
 * What is left for this class is everything that is NOT a body: when it turns
 * up, which phase it is in, what it is winding up, and a 0..1 number for the
 * health bar to draw. It owns no geometry and no rendering — `BossRenderer`
 * reads this and this never reads it back, so the procedural body can be
 * swapped for an imported model later without touching a line of the fight
 * (the milestone's own open item).
 *
 * The body is followed by **id**, never by index: `EnemySystem#_kill` compacts
 * by swapping the last body into the hole, so an index captured at spawn
 * points at some other enemy the moment anything dies — the classic way a boss
 * health bar starts reporting a rat's hp.
 */
export class BossSystem {
  /**
   * @param {import('./EnemySystem.js').EnemySystem} enemies
   * @param {import('./TideSchedule.js').TideSchedule} tides unused today, kept
   *   because the entrance is a tide mark and a future one may want the tide's
   *   own element to colour the fight.
   */
  constructor(enemies, tides = null) {
    this.enemies = enemies;
    this.tides = tides;
    this.reset();
  }

  reset() {
    /** Id of the live body, or 0 when there is none. */
    this._id = 0;
    /** Hp it spawned with — the denominator of the bar, never re-read from the body. */
    this._maxHp = 0;
    /** One boss per run: a spawned-and-since-killed boss must not come back. */
    this._spawned = false;
  }

  /** When the boss is due, in seconds. Counted in tides, so it follows any
   *  change to the tide length rather than drifting off a fixed minute. */
  get dueAt() {
    return settings.tides.length * settings.run.boss.afterTides;
  }

  /** Index of the live body, or -1. Re-resolved every read; see the class doc. */
  get index() {
    return this._id ? this.enemies.indexOfId(this._id) : -1;
  }

  get active() {
    return this.index !== -1;
  }

  /** 0..1 for the health bar. Exactly 0 when there is no boss to draw. */
  get hp01() {
    const i = this.index;
    if (i === -1 || this._maxHp <= 0) return 0;
    return Math.max(0, Math.min(1, this.enemies.hp[i] / this._maxHp));
  }

  /** True on the tick the boss stopped existing after having existed. */
  get defeated() {
    return this._spawned && this._id !== 0 && this.index === -1;
  }

  /**
   * @param {number} step seconds
   * @param {number} elapsed run seconds so far — the caller's clock, not one
   *   kept here, so a paused or endless run needs no second opinion about time
   * @param {{x:number,z:number}} playerPos
   */
  tick(step, elapsed, playerPos) {
    if (!this._spawned && elapsed >= this.dueAt) this._spawn(elapsed, playerPos);
    // Once the body is gone the id is dropped, so `defeated` reads true exactly
    // once per run and the bar stops drawing.
    if (this._spawned && this._id && this.index === -1) this._onDefeat();
  }

  _spawn(elapsed, playerPos) {
    const cfg = settings.run.boss;
    // Off to one side rather than on top of the player: it should walk in.
    const px = playerPos?.x ?? 0;
    const pz = playerPos?.z ?? 0;
    const i = this.enemies.spawnBoss(px + cfg.spawnDistance, pz, elapsed / 60);
    if (i === -1) return; // horde is capped this instant; try again next tick
    this._spawned = true;
    this._id = this.enemies.id[i];
    this._maxHp = this.enemies.hp[i];
  }

  _onDefeat() {
    this._id = 0;
    this.onDefeat?.();
  }

  /** Behaviour index of the boss body — exported for callers that filter. */
  static get BEHAVIOR() {
    return BOSS_BEHAVIOR;
  }
}
