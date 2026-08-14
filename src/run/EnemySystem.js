// src/run/EnemySystem.js
import { settings } from '../config/settings.js';

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
    this.id = new Float64Array(cap);

    // Uniform grid: head index per cell + linked "next" per enemy.
    this._cellHead = new Int16Array(GRID * GRID);
    this._cellNext = new Int16Array(cap);

    /** Per-cast hit memory: castId -> Set of enemy ids (spec §3 sweep dedup). */
    this._hitMemory = new Map();

    /** Assigned by whoever wants corpses (gems, shards). */
    this.onDeath = null;
  }

  spawnAt(x, z, minute) {
    if (this.count >= this.x.length) return -1;
    const i = this.count++;
    const c = settings.enemies;
    this.x[i] = this.prevX[i] = x;
    this.z[i] = this.prevZ[i] = z;
    this.hp[i] = c.hpBase * (1 + c.hpPerMinute * minute) * c.swarm.hpMult;
    this.slowed[i] = 0;
    this.slowT[i] = 0;
    this.flash[i] = 0;
    this.kbX[i] = 0;
    this.kbZ[i] = 0;
    this.element[i] = 0; // M1: swarm only; tides colour this in M3
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
    const speed = c.swarm.speed;
    const contactR = c.swarm.radius + 0.5; // + player capsule radius
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
      const v = speed * (1 - this.slowed[i]);
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

      if (d < contactR) contact = Math.max(contact, c.swarm.contactDamage);
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

  hits(point, radius) {
    for (let i = 0; i < this.count; i++) {
      if (Math.hypot(this.x[i] - point.x, this.z[i] - point.z) < radius) return true;
    }
    return false;
  }

  damage(point, radius, amount) {
    let hits = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      const dx = this.x[i] - point.x;
      const dz = this.z[i] - point.z;
      if (Math.hypot(dx, dz) >= radius) continue;
      hits++;
      this.flash[i] = 1;
      const d = Math.hypot(dx, dz) || 1;
      const kb = settings.enemies.knockback / settings.enemies.swarm.mass;
      this.kbX[i] += (dx / d) * kb;
      this.kbZ[i] += (dz / d) * kb;
      if ((this.hp[i] -= amount) <= 0) this._kill(i);
    }
    return hits;
  }

  damageOnce(castId, point, radius, amount) {
    let seen = this._hitMemory.get(castId);
    if (!seen) this._hitMemory.set(castId, (seen = new Set()));
    let hits = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      if (Math.hypot(this.x[i] - point.x, this.z[i] - point.z) >= radius) continue;
      if (seen.has(this.id[i])) continue;
      seen.add(this.id[i]);
      hits++;
      this.flash[i] = 1;
      if ((this.hp[i] -= amount) <= 0) this._kill(i);
    }
    // ponytail: memory grows one Set per cast; RunManager clears finished casts.
    return hits;
  }

  slow(point, radius, factor, duration) {
    for (let i = 0; i < this.count; i++) {
      if (Math.hypot(this.x[i] - point.x, this.z[i] - point.z) >= radius) continue;
      this.slowed[i] = Math.max(this.slowed[i], factor);
      this.slowT[i] = Math.max(this.slowT[i], duration);
    }
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
      this.flash, this.kbX, this.kbZ, this.element, this.id
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
