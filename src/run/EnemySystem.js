// src/run/EnemySystem.js
import { settings } from '../config/settings.js';

/** Behaviour template ids — indexes both `this.behavior[i]` and `settings.enemies`. */
export const BEHAVIORS = ['swarm', 'ranged', 'tank'];

/**
 * The horde, as flat arrays (spec §5).
 *
 * Three hundred enemies is a data problem, not an object problem: every field
 * is an index-parallel typed array, death is a swap-remove, and the per-tick
 * work allocates nothing. Rendering is someone else's job — this file never
 * imports three.js, which is also what lets `npm run check:game` drive it
 * headless.
 *
 * Separation uses a uniform grid rebuilt per tick.
 * ponytail: O(n) rebuild is plenty at cap 300; revisit only if the cap rises.
 */
const CELL = 1.2; // metres per grid cell, ≈ separation distance
const GRID = 96; // cells per axis, covers the arena with margin
const HALF = (GRID * CELL) / 2;

export class EnemySystem {
  constructor(rng) {
    const cap = settings.run.enemyCap;
    this.count = 0;
    this._rng = rng;
    this._nextId = 1;

    this.x = new Float32Array(cap);
    this.z = new Float32Array(cap);
    this.prevX = new Float32Array(cap);
    this.prevZ = new Float32Array(cap);
    this.hp = new Float32Array(cap);
    // per-enemy slow factor — named 'slowed' so it cannot shadow the slow() method below
    this.slowed = new Float32Array(cap);
    this.slowT = new Float32Array(cap);
    this.flash = new Float32Array(cap);
    this.kbX = new Float32Array(cap);
    this.kbZ = new Float32Array(cap);
    this.element = new Uint8Array(cap);
    this.behavior = new Uint8Array(cap); // BEHAVIORS index: 0 swarm / 1 ranged / 2 tank
    this.elite = new Uint8Array(cap); // 0 normal / 1 elite (Task 5 consumes; spawn only marks it)
    this.fireT = new Float32Array(cap); // ranged fire cooldown
    this.id = new Float64Array(cap);

    // Uniform grid: head index per cell + linked "next" per enemy.
    this._cellHead = new Int16Array(GRID * GRID);
    this._cellNext = new Int16Array(cap);

    /** Per-cast hit memory: castId -> Set of enemy ids (spec §3 sweep dedup). */
    this._hitMemory = new Map();

    /** Assigned by whoever wants corpses (gems, shards). */
    this.onDeath = null;
    /** Assigned by whoever wants hit readouts (damage figures). */
    this.onHit = null;
    /** Assigned by whoever wants ranged fire events (projectile spawns). */
    this.onFire = null;
  }

  spawnAt(x, z, minute, element = 0, behavior = 0, elite = 0) {
    if (this.count >= this.x.length) return -1;
    const i = this.count++;
    const c = settings.enemies;
    const kind = c[BEHAVIORS[behavior]];
    this.x[i] = this.prevX[i] = x;
    this.z[i] = this.prevZ[i] = z;
    this.hp[i] = c.hpBase * (1 + c.hpPerMinute * minute) * kind.hpMult;
    this.slowed[i] = 0;
    this.slowT[i] = 0;
    this.flash[i] = 0;
    this.kbX[i] = 0;
    this.kbZ[i] = 0;
    this.element[i] = element;
    this.behavior[i] = behavior;
    this.elite[i] = elite; // ×hpMult stacking lands in Task 5; spawn only marks it
    this.fireT[i] = 0;
    this.id[i] = this._nextId++;
    return i;
  }

  /**
   * March everyone one step toward the player. Returns the strongest single
   * contact hit this tick (0 when nobody touches) — the caller applies it
   * through the player's mercy windows. Deliberately *not* a dps model:
   * iframes downstream are the rate limiter, so a touch is one full hit
   * (spec anchor: contact 8 per hit, ≈ one hit per 0.5s mercy window).
   */
  tick(step, player, minute) {
    const c = settings.enemies;
    let contact = 0;

    this._rebuildGrid();

    for (let i = 0; i < this.count; i++) {
      this.prevX[i] = this.x[i];
      this.prevZ[i] = this.z[i];

      // Seek, scaled by any slow on this enemy.
      let dx = player.x - this.x[i];
      let dz = player.z - this.z[i];
      const d = Math.hypot(dx, dz);
      const dist = d || 1; // the || 1 guards normalisation; contact uses raw d
      const kind = c[BEHAVIORS[this.behavior[i]]];
      const holding = this.behavior[i] === 1 && d < kind.holdRange; // ranged parks at range, never bites

      // Fire cadence: cools down every tick a ranged enemy is alive, closing
      // or holding alike, so a spitter that's still walking in doesn't get
      // stuck with a full wait the instant it arrives. It only pulls the
      // trigger while holding.
      if (this.behavior[i] === 1) {
        this.fireT[i] -= step;
        if (holding && this.fireT[i] <= 0) {
          this.fireT[i] = kind.fireEvery;
          this.onFire?.(this.x[i], this.z[i], (player.x - this.x[i]) / dist, (player.z - this.z[i]) / dist);
        }
      }

      const v = holding ? 0 : kind.speed * (1 - this.slowed[i]);
      dx = (dx / dist) * v;
      dz = (dz / dist) * v;

      // Soft separation: one averaged push from grid neighbours.
      const push = this._separation(i);
      dx += push[0] * 2.0;
      dz += push[1] * 2.0;

      // Knockback rides its own decaying channel so AI never fights it.
      this.x[i] += (dx + this.kbX[i]) * step;
      this.z[i] += (dz + this.kbZ[i]) * step;
      const decay = Math.exp(-c.knockbackDecay * step);
      this.kbX[i] *= decay;
      this.kbZ[i] *= decay;

      // Timers.
      if ((this.slowT[i] -= step) <= 0) this.slowed[i] = 0;
      this.flash[i] = Math.max(0, this.flash[i] - step * 6);

      if (!holding && d < kind.radius + 0.5) contact = Math.max(contact, kind.contactDamage);
    }
    return contact;
  }

  _rebuildGrid() {
    this._cellHead.fill(-1);
    for (let i = 0; i < this.count; i++) {
      const cell = this._cellOf(this.x[i], this.z[i]);
      this._cellNext[i] = this._cellHead[cell];
      this._cellHead[cell] = i;
    }
  }

  _cellOf(x, z) {
    const cx = Math.min(GRID - 1, Math.max(0, ((x + HALF) / CELL) | 0));
    const cz = Math.min(GRID - 1, Math.max(0, ((z + HALF) / CELL) | 0));
    return cz * GRID + cx;
  }

  _separation(i) {
    const out = _push;
    out[0] = 0;
    out[1] = 0;
    const min = settings.enemies.separation;
    const cx = Math.min(GRID - 1, Math.max(0, ((this.x[i] + HALF) / CELL) | 0));
    const cz = Math.min(GRID - 1, Math.max(0, ((this.z[i] + HALF) / CELL) | 0));
    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        const gx = cx + ox;
        const gz = cz + oz;
        if (gx < 0 || gz < 0 || gx >= GRID || gz >= GRID) continue;
        for (let j = this._cellHead[gz * GRID + gx]; j !== -1; j = this._cellNext[j]) {
          if (j === i) continue;
          const dx = this.x[i] - this.x[j];
          const dz = this.z[i] - this.z[j];
          const d = Math.hypot(dx, dz);
          if (d > 0.001 && d < min) {
            const f = (min - d) / min / d;
            out[0] += dx * f;
            out[1] += dz * f;
          }
        }
      }
    }
    return out;
  }

  /* ---- Targets contract ------------------------------------------------ */
  // Every test is sphere-vs-sphere, the dummies' own semantics: the body's
  // radius counts toward the reach, so clipping the edge of a capsule is a
  // hit. A pure point test made the fireball's 0.4m fuse fly clean through
  // 0.45m-wide bodies unless it struck dead centre.

  hits(point, radius) {
    for (let i = 0; i < this.count; i++) {
      const reach = radius + settings.enemies[BEHAVIORS[this.behavior[i]]].radius;
      if (Math.hypot(this.x[i] - point.x, this.z[i] - point.z) < reach) return true;
    }
    return false;
  }

  damage(point, radius, amount) {
    let hits = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      const kind = settings.enemies[BEHAVIORS[this.behavior[i]]];
      const dx = this.x[i] - point.x;
      const dz = this.z[i] - point.z;
      if (Math.hypot(dx, dz) >= radius + kind.radius) continue;
      hits++;
      this.flash[i] = 1;
      const d = Math.hypot(dx, dz) || 1;
      const kb = settings.enemies.knockback / kind.mass;
      this.kbX[i] += (dx / d) * kb;
      this.kbZ[i] += (dz / d) * kb;
      this.onHit?.(this.x[i], this.z[i], amount);
      if ((this.hp[i] -= amount) <= 0) this._kill(i);
    }
    return hits;
  }

  damageOnce(castId, point, radius, amount) {
    let seen = this._hitMemory.get(castId);
    if (!seen) this._hitMemory.set(castId, (seen = new Set()));
    let hits = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      const reach = radius + settings.enemies[BEHAVIORS[this.behavior[i]]].radius;
      if (Math.hypot(this.x[i] - point.x, this.z[i] - point.z) >= reach) continue;
      if (seen.has(this.id[i])) continue;
      seen.add(this.id[i]);
      hits++;
      this.flash[i] = 1;
      this.onHit?.(this.x[i], this.z[i], amount);
      if ((this.hp[i] -= amount) <= 0) this._kill(i);
    }
    // ponytail: memory grows one Set per cast; RunManager clears finished casts.
    return hits;
  }

  slow(point, radius, factor, duration) {
    for (let i = 0; i < this.count; i++) {
      const reach = radius + settings.enemies[BEHAVIORS[this.behavior[i]]].radius;
      if (Math.hypot(this.x[i] - point.x, this.z[i] - point.z) >= reach) continue;
      this.slowed[i] = Math.max(this.slowed[i], factor);
      this.slowT[i] = Math.max(this.slowT[i], duration);
    }
  }

  /** Index of the closest live enemy to (x, z); -1 when the field is empty. */
  nearestTo(x, z) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.count; i++) {
      const d = Math.hypot(this.x[i] - x, this.z[i] - z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  releaseCast(castId) {
    this._hitMemory.delete(castId);
  }

  _kill(i) {
    this.onDeath?.(this.x[i], this.z[i], this.element[i]);
    const last = --this.count;
    if (i === last) return;
    for (const a of [
      this.x, this.z, this.prevX, this.prevZ, this.hp, this.slowed, this.slowT,
      this.flash, this.kbX, this.kbZ, this.element, this.behavior, this.elite, this.fireT, this.id
    ]) {
      a[i] = a[last];
    }
  }

  clear() {
    this.count = 0;
    this._hitMemory.clear();
  }
}

const _push = [0, 0];
