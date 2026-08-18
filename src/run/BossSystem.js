import { settings } from '../config/settings.js';
import { BOSS_BEHAVIOR } from './EnemySystem.js';

/** Index-matched to `_cd` and to the phase that unlocks each one. */
const MOVES = ['charge', 'quake', 'summon'];

/** One scratch point for every hit test below — per-tick, so never allocated. */
const _p = { x: 0, z: 0 };
const _at = (x, z) => { _p.x = x; _p.z = z; return _p; };

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
    /** Last known position, so the reward can drop where the fight happened. */
    this.lastX = 0;
    this.lastZ = 0;
    /** 0/1/2. Only ever climbs: healing it must not re-open an act. */
    this._phase = 0;
    /** Seconds until each move is off cooldown, index-matched to MOVES. */
    this._cd = [0, 0, 0];
    /**
     * What is being wound up right now, for the renderer to draw and for the
     * player to read. Mutated in place, never reallocated — this is read every
     * frame (零分配热路径). `move` is null when nothing is coming.
     */
    this.windup = { move: null, t: 0, of: 0, x: 0, z: 0, radius: 0 };
  }

  /** 0/1/2 — which act the fight is in. */
  get phase() {
    return this._phase;
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
    if (this._spawned && this._id && this.index === -1) {
      this._onDefeat();
      return;
    }

    const i = this.index;
    if (i === -1) return;

    // Where it was standing, kept fresh so the payout can land on the corpse
    // — by the time `onDefeat` fires the body is already off the field.
    this.lastX = this.enemies.x[i];
    this.lastZ = this.enemies.z[i];

    /* ---- acts ---- */
    // Climbs only. A heal (or a shield, or a mistake) must not rewind the
    // fight and re-play an entrance — the assertion for that drives the hp
    // back up to full and expects the phase to stay where it got to.
    const F = settings.enemies.boss.fight;
    const hp01 = this.hp01;
    let want = 0;
    for (const threshold of F.phaseAt) if (hp01 <= threshold) want++;
    if (want > this._phase) {
      this._phase = want;
      this.onPhase?.(this._phase);
    }

    /* ---- moves ---- */
    // One move unlocked per act: charge from the start, quake at the second,
    // summon at the third. Cooldowns run for every unlocked move at once, so
    // the last act is genuinely busier rather than merely different.
    const here = { x: this.enemies.x[i], z: this.enemies.z[i] };
    const unlocked = this._phase + 1;
    for (let m = 0; m < unlocked; m++) {
      this._cd[m] -= step;
      if (this._cd[m] > 0) continue;
      const move = MOVES[m];
      const row = F[move];
      // Wind up first, land second. The telegraph IS the footprint — the ring
      // drawn during the windup is the circle that gets judged (WYSIWYG).
      if (this.windup.move === null) {
        this.windup.move = move;
        this.windup.t = 0;
        this.windup.of = row.telegraph;
        this.windup.radius = move === 'charge' ? row.radius : (row.radius ?? row.ringRadius);
        this.windup.x = move === 'charge' ? (playerPos?.x ?? 0) : here.x;
        this.windup.z = move === 'charge' ? (playerPos?.z ?? 0) : here.z;
      }
    }

    if (this.windup.move !== null) {
      this.windup.t += step;
      if (this.windup.t >= this.windup.of) {
        const move = this.windup.move;
        const m = MOVES.indexOf(move);
        this.windup.move = null;
        this._cd[m] = F[move].every;
        if (move === 'charge') this.charge(here, playerPos ?? here, step);
        else if (move === 'quake') this.quake(here, step);
        else this.summon(elapsed / 60, step);
      }
    }
  }

  /**
   * 碾压冲锋 — a line of damage from the boss toward the player, and a shove.
   *
   * **The shove is an IMPULSE.** One charge, one launch — deliberately NOT
   * multiplied by `step`, because it is not a field you stand in. This is the
   * declaration M8's channel rule demands, and the assertion for it lands the
   * same charge on a 1/60 tick and a 1/6 tick and requires the same shove.
   */
  charge(from, toward, step) {
    const i = this.index;
    if (i === -1) return 0;
    const row = settings.enemies.boss.fight.charge;
    const dx = (toward.x ?? 0) - from.x;
    const dz = (toward.z ?? 0) - from.z;
    const d = Math.hypot(dx, dz) || 1;
    const reach = Math.min(row.range, d);
    const hitX = from.x + (dx / d) * reach;
    const hitZ = from.z + (dz / d) * reach;
    // kbScale 0: the damage call must not add its own baseline shove on top of
    // the impulse below, or the charge lands two different launches at once.
    const hits = this.enemies.damage(_at(hitX, hitZ), row.radius, row.damage, -1, -1, 0);
    this.enemies.knockback(_at(from.x, from.z), reach + row.radius, row.knockback);
    return hits;
  }

  /**
   * 震地 — a ring around the boss that damages and stuns.
   *
   * **The stun is a DURATION**, in seconds, handed to the slow channel exactly
   * as `settings` states it. Not accrued per tick: a stun that grew with the
   * frame budget would pin the player for as long as the machine was slow.
   */
  quake(centre, step) {
    const i = this.index;
    if (i === -1) return 0;
    const row = settings.enemies.boss.fight.quake;
    const hits = this.enemies.damage(_at(centre.x, centre.z), row.radius, row.damage, -1, -1, 0);
    // 1.0 is the full-strength slow this engine spells "stun" (M6 T4's ruling —
    // one control channel, not a second mechanic).
    this.enemies.slow(_at(centre.x, centre.z), row.radius, 1, row.stunTime);
    return hits;
  }

  /**
   * 召唤 — a ring of bodies around the boss.
   *
   * **A COUNT per call**, not a rate: `count` bodies appear once, when the move
   * lands. A per-tick reading would summon `count` × 60 a second and cap the
   * horde inside two frames.
   */
  summon(minute, step) {
    const i = this.index;
    if (i === -1) return 0;
    const row = settings.enemies.boss.fight.summon;
    const cx = this.enemies.x[i];
    const cz = this.enemies.z[i];
    let made = 0;
    for (let k = 0; k < row.count; k++) {
      const a = (k / row.count) * Math.PI * 2;
      const spawned = this.enemies.spawnAt(
        cx + Math.cos(a) * row.ringRadius,
        cz + Math.sin(a) * row.ringRadius,
        minute, 0, 0, 0
      );
      if (spawned !== -1) made++;
    }
    return made;
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
