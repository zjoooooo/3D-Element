import { settings } from '../config/settings.js';

/**
 * The 15 minutes themselves (spec §7).
 *
 * Owns the clock-facing state — elapsed time, spawn scheduling, telegraphs,
 * kills — and hands down one verdict per tick: playing, dead or won. Systems
 * stay ignorant of each other; every cross-wire (deaths feed gems, finished
 * casts release their hit memory) is knotted here and nowhere else.
 */
const TELEGRAPH_TIME = 0.5; // seconds a spawn ring shows before the enemy lands

export class RunManager {
  constructor(systems) {
    this.s = systems;
    this.active = false;
    this.elapsed = 0;
    this.kills = 0;
    this.telegraphs = [];
    this._spawnDebt = 0;
    this.pendingLevels = 0;
    // Mid-tide elite scheduler: how many of this tide's eliteAt marks have
    // already queued a spawn, and which tide index that count belongs to.
    this._elitesSpawned = 0;
    this._lastTideIndex = 0;
    /** Fired the tick a new tide opens, with the incoming element. */
    this.onTideTurn = null;
    /** Fired when a shard is picked up (element index) — App opens a directional hand. */
    this.onShardHand = null;

    this.s.enemies.onDeath = (x, z, element, elite) => {
      this.kills++;
      if (elite) {
        this.s.pickups.dropAt(x, z, this.elapsed / 60, 1);
        this.s.pickups.dropShard(x, z, element);
      } else {
        this.s.pickups.dropAt(x, z, this.elapsed / 60);
      }
    };
    this.s.enemies.onFire = (x, z, dx, dz) => this.s.projectiles.spawn(x, z, dx, dz);
    this.s.pickups.onShard = (element) => this.onShardHand?.(element);

    // Casts hand back their hit memory the moment the manager retires them —
    // scanning `active` misses them (the manager splices finished casts out
    // of that array inside its own update, before this tick ever runs).
    this.s.abilities.onRetire = (ability) => {
      const id = this.s.combat.release(ability);
      if (id !== -1) this.s.enemies.releaseCast(id);
    };
  }

  start() {
    this.active = true;
    this.elapsed = 0;
    this.kills = 0;
    this.telegraphs.length = 0;
    this._spawnDebt = 0;
    this.pendingLevels = 0;
    this._elitesSpawned = 0;
    this._lastTideIndex = 0;
    this.s.enemies.clear();
    this.s.pickups.clear();
    this.s.player.reset();
    this.s.projectiles.clear();
    this.s.combat.resetStats?.();
  }

  stop() {
    this.active = false;
  }

  /** Which tide `elapsed` sits in — forwards TideSchedule's reused scratch object. */
  tide() {
    return this.s.tides.tideAt(this.elapsed);
  }

  tick(step, playerPos) {
    if (!this.active) return 'playing';
    if (!this.s.player.alive) return 'dead';
    if (this.elapsed >= settings.run.duration) return 'won';

    this.elapsed += step;
    const minute = this.elapsed / 60;

    // Accrue spawn debt from the budget curve, jittered ±20%.
    const perSecond = (settings.run.spawnBase + settings.run.spawnQuad * minute * minute) / 60;
    this._spawnDebt += perSecond * step * (0.8 + 0.4 * this.s.rng());
    while (this._spawnDebt >= 1) {
      this._spawnDebt -= 1;
      this._queueSpawn(playerPos);
    }

    // Telegraphs count up; expired ones become enemies, carrying whatever
    // element/behaviour/elite flag they were queued with.
    for (let i = this.telegraphs.length - 1; i >= 0; i--) {
      const tg = this.telegraphs[i];
      tg.t += step / TELEGRAPH_TIME;
      if (tg.t >= 1) {
        this.s.enemies.spawnAt(tg.x, tg.z, minute, tg.element, tg.behavior, tg.elite);
        this.telegraphs[i] = this.telegraphs[this.telegraphs.length - 1];
        this.telegraphs.pop();
      }
    }

    // Scratch-object hazard: tides.tideAt() and tides.rollElement() share one
    // reused scratch object (rollElement calls tideAt internally), so a held
    // reference can look mutated by an unrelated later call. Read once here
    // and copy the primitives out immediately — nothing below may hold this
    // object across the _queueSpawn(playerPos) call above (already ran) or
    // the elite _queueSpawn below (which skips rollElement by passing an
    // explicit element/behavior), so these locals stay valid all tick.
    const tideNow = this.s.tides.tideAt(this.elapsed);
    const tideIndex = tideNow.index;
    const tideElement = tideNow.element;
    const tideProgress = tideNow.progress;

    // Tide turn: the tick that crosses into a new tide rains gold on the
    // player and resets the mid-tide elite scheduler.
    if (tideIndex !== this._lastTideIndex) {
      this._lastTideIndex = tideIndex;
      this._elitesSpawned = 0;
      this.s.pickups.rainAt(playerPos.x, playerPos.z, this.s.rng);
      this.onTideTurn?.(tideElement);
    }

    // Mid-tide elites: one per eliteAt mark this tide's progress has crossed.
    const marks = settings.tides.eliteAt;
    if (this._elitesSpawned < marks.length && tideProgress >= marks[this._elitesSpawned]) {
      this._elitesSpawned++;
      this._queueSpawn(playerPos, tideElement, 0, 1);
    }

    // Projectiles bite through the same mercy window as contact.
    const shot = this.s.projectiles.tick(step, playerPos);
    if (shot > 0) this.s.player.takeDamage(shot);

    // March, bite, collect.
    const contact = this.s.enemies.tick(step, playerPos, minute);
    if (contact > 0) this.s.player.takeDamage(contact);
    this.s.player.tick(step);
    this.s.combat.tick(step, this.s.abilities.active);
    this.pendingLevels += this.s.pickups.tick(step, playerPos);

    return 'playing';
  }

  /**
   * Queue a telegraphed spawn. `element`/`behavior` default to the tide's
   * own composition roll and the minute's behaviour mix; elites (and any
   * other caller with an opinion) pass both explicitly to skip the roll.
   */
  _queueSpawn(playerPos, element = null, behavior = null, elite = 0) {
    const angle = this.s.rng() * Math.PI * 2;
    const r = settings.run.spawnRadius;
    const x = playerPos.x + Math.cos(angle) * r;
    const z = playerPos.z + Math.sin(angle) * r;
    const a = settings.run.arenaRadius - 1;
    const d = Math.hypot(x, z);
    // Clamp the ring onto the arena so edge-hugging never starves spawns.
    const cx = d > a ? (x / d) * a : x;
    const cz = d > a ? (z / d) * a : z;

    const spawnElement = element ?? this.s.tides.rollElement(this.s.rng, this.elapsed);
    let spawnBehavior = behavior;
    if (spawnBehavior === null) {
      const minute = this.elapsed / 60;
      const mix = settings.enemies.mix;
      const roll = this.s.rng();
      spawnBehavior = 0;
      if (minute >= mix.tankFrom && roll < mix.tankShare) spawnBehavior = 2;
      else if (minute >= mix.rangedFrom && roll < mix.tankShare + mix.rangedShare) spawnBehavior = 1;
    }

    this.telegraphs.push({ x: cx, z: cz, t: 0, element: spawnElement, behavior: spawnBehavior, elite });
  }
}
