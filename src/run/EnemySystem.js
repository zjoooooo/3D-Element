// src/run/EnemySystem.js
import { settings } from '../config/settings.js';
import { BEATS, FEEDS } from './TideSchedule.js';

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
// Reaction queue: entries are (markWux, wux, x, z, amount), five floats each.
// 32 detonations is far above anything one damage()/damageOnce() call produces.
const REACTION_QUEUE_CAP = 32;

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
    this.elite = new Uint8Array(cap); // 0 normal / 1 elite — scales hp/damage, marks the corpse
    this.fireT = new Float32Array(cap); // ranged fire cooldown
    // Marks and their three 相克 debuff channels (spec §4.6) — one clinging
    // wuxing per body, plus the timers/magnitude the reactions and taxes read.
    this.mark = new Uint8Array(cap); // wuxing clinging to this body, 255 = none
    this.markT = new Float32Array(cap); // seconds left on that mark
    this.vulnT = new Float32Array(cap); // 易伤 timer (断枝/破土 or 熔甲)
    this.vulnAmt = new Float32Array(cap); // its magnitude — vuln or the stronger vulnStrong, never both
    this.weakT = new Float32Array(cap); // 熄灭 timer — tick() shaves contact/bolt damage while it holds
    this.slowAmpT = new Float32Array(cap); // 淤塞 timer — slow() doubles its own factor while it holds
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
    /** Assigned by whoever wants reaction events: (markWux, triggerWux, x, z, amount). */
    this.onReaction = null;
    /**
     * onReaction can call straight back into damage()/damageOnce() (助燃's
     * splash does exactly this via RunManager). Firing it synchronously from
     * inside _applyWux used to hand that reentrant call the still-in-progress
     * outer loop's arrays mid-iteration — a kill in there can swap-remove an
     * enemy out from under the outer loop's cached index (spec bug: a wood
     * mark detonated by a fire hit corrupts the outer damage() pass). Fix:
     * _applyWux queues the five call args here instead of calling out; the
     * queue is drained by _flushReactions() once the loop that filled it has
     * fully resolved. Flat and preallocated — zero alloc on the hot path.
     */
    this._reactionQueue = new Float32Array(REACTION_QUEUE_CAP * 5);
    this._reactionFlush = new Float32Array(REACTION_QUEUE_CAP * 5); // see _flushReactions
    this._reactionCount = 0;

    /** element/behavior/position of the strongest contact this tick — reused
     * scratch, zero-alloc. x/z (M6 T5) is 石肤's reflect target: whoever
     * landed *this* hit, at the position they landed it from. */
    this.lastContact = { element: 0, behavior: 0, x: 0, z: 0 };

    /** Matchup/knockback/slow knobs a resonance build can override (spec §4.8). */
    this.tuning = { kbMult: 1, slowDurMult: 1, advantage: 0, disadvantage: 0, reactionMult: 1 };
  }

  spawnAt(x, z, minute, element = 0, behavior = 0, elite = 0) {
    if (this.count >= this.x.length) return -1;
    const i = this.count++;
    const c = settings.enemies;
    const kind = c[BEHAVIORS[behavior]];
    this.x[i] = this.prevX[i] = x;
    this.z[i] = this.prevZ[i] = z;
    this.hp[i] = c.hpBase * (1 + c.hpPerMinute * minute) * kind.hpMult * (elite ? c.elites.hpMult : 1);
    this.slowed[i] = 0;
    this.slowT[i] = 0;
    this.flash[i] = 0;
    this.kbX[i] = 0;
    this.kbZ[i] = 0;
    this.element[i] = element;
    this.behavior[i] = behavior;
    this.elite[i] = elite;
    this.fireT[i] = 0;
    this.mark[i] = 255;
    this.markT[i] = 0;
    this.vulnT[i] = 0;
    this.vulnAmt[i] = 0;
    this.weakT[i] = 0;
    this.slowAmpT[i] = 0;
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
      // trigger while holding. A weakened spitter's bolt bites softer too.
      if (this.behavior[i] === 1) {
        this.fireT[i] -= step;
        if (holding && this.fireT[i] <= 0) {
          this.fireT[i] = kind.fireEvery;
          const dmg =
            c.projectile.damage * (this.weakT[i] > 0 ? 1 - settings.combat.debuffs.weak.amount : 1);
          this.onFire?.(this.x[i], this.z[i], (player.x - this.x[i]) / dist, (player.z - this.z[i]) / dist, dmg);
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

      // Timers: the old two, plus the mark and its three debuff channels.
      // slowAmpT needs no separate clamp beyond the timer itself — once it's
      // back at 0, slow() just stops doubling, no residual coefficient.
      if ((this.slowT[i] -= step) <= 0) this.slowed[i] = 0;
      this.flash[i] = Math.max(0, this.flash[i] - step * 6);
      if ((this.markT[i] -= step) <= 0) {
        this.markT[i] = 0;
        this.mark[i] = 255;
      }
      if ((this.vulnT[i] -= step) <= 0) this.vulnT[i] = 0;
      if ((this.weakT[i] -= step) <= 0) this.weakT[i] = 0;
      if ((this.slowAmpT[i] -= step) <= 0) this.slowAmpT[i] = 0;

      if (!holding && d < kind.radius + 0.5) {
        let dmg = kind.contactDamage * (this.elite[i] ? c.elites.damageMult : 1);
        if (this.weakT[i] > 0) dmg *= 1 - settings.combat.debuffs.weak.amount; // 熄灭 dulls the bite
        if (dmg > contact) {
          contact = dmg;
          this.lastContact.element = this.element[i];
          this.lastContact.behavior = this.behavior[i];
          this.lastContact.x = this.x[i];
          this.lastContact.z = this.z[i];
        }
      }
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

  /**
   * @param {number} [kbScale] M9 T4: how much of the baseline shove this hit
   *   carries — the same tail damageRing and damageCone already take. 1 (the
   *   default, and every one-shot hit in the codebase) is one full impulse.
   *   A channel that calls this every tick passes `step` instead, because
   *   sixty impulses a second is not a push, it is a catapult: a snare field
   *   measured 30 m/s and threw its own targets clear of itself. 0 is a
   *   field that burns without shoving at all (沙暴's own precedent).
   */
  damage(point, radius, amount, wuxing = -1, wuxingB = -1, kbScale = 1) {
    let hits = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      const kind = settings.enemies[BEHAVIORS[this.behavior[i]]];
      const dx = this.x[i] - point.x;
      const dz = this.z[i] - point.z;
      if (Math.hypot(dx, dz) >= radius + kind.radius) continue;
      hits++;
      this.flash[i] = 1;
      const d = Math.hypot(dx, dz) || 1;
      if (kbScale) {
        const kb = (settings.enemies.knockback / kind.mass) * this.tuning.kbMult * kbScale;
        this.kbX[i] += (dx / d) * kb;
        this.kbZ[i] += (dz / d) * kb;
      }
      this._applyWux(i, amount, wuxing, wuxingB);
    }
    this._flushReactions();
    return hits;
  }

  /** Like damage(), but only within a band [innerRadius, radius] of point —
   * the annulus a permanent aura's orbiting ring/flames/orbs actually occupy
   * (M6 T4). Mirrors damage()'s loop exactly, plus the inner cutoff; an
   * enemy standing well inside the ring (nearer than innerRadius, padded by
   * its own collision radius the same way the outer edge already is) takes
   * nothing.
   *
   * `kbScale` (M7 T4) scales the baseline per-hit shove, default 1 —
   * byte-identical for every pre-M7-T4 caller. 0 turns it off outright:
   * a 60Hz grind tick (锋岩星阵's solid disc) streaming the full baseline
   * impulse launched enemies clean out of its own footprint (研磨不推 —
   * see the '4+0' combat row's own comment); flash/matchup/vuln/marks are
   * untouched, only the shove scales. */
  damageRing(point, innerRadius, radius, amount, wuxing = -1, wuxingB = -1, kbScale = 1) {
    let hits = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      const kind = settings.enemies[BEHAVIORS[this.behavior[i]]];
      const dx = this.x[i] - point.x;
      const dz = this.z[i] - point.z;
      const dist = Math.hypot(dx, dz);
      if (dist >= radius + kind.radius) continue;
      if (dist < innerRadius - kind.radius) continue;
      hits++;
      this.flash[i] = 1;
      if (kbScale) {
        const d = dist || 1;
        const kb = (settings.enemies.knockback / kind.mass) * this.tuning.kbMult * kbScale;
        this.kbX[i] += (dx / d) * kb;
        this.kbZ[i] += (dz / d) * kb;
      }
      this._applyWux(i, amount, wuxing, wuxingB);
    }
    this._flushReactions();
    return hits;
  }

  /**
   * A wedge (M8 T5, 烈焰喷吐's 扇形龙息): everything within `range` of
   * `point` whose bearing off (`dirX`, `dirZ`) is inside `halfAngle`.
   *
   * The one new judged shape this milestone adds. It mirrors damage()'s loop
   * — same flash, same `_applyWux`, same reaction flush — with the shove
   * behind a `kbScale` gate (an aura's own precedent: pass 0 and this burns
   * without pushing) and one extra test for the wedge.
   *
   * That test splits the offset into "along the axis" and "across it" rather
   * than comparing an angle, which is what lets a body's own radius pad BOTH
   * edges the way damageRing pads its inner and outer rims — a pure angular
   * comparison pads only the far edge, leaving a tank visibly swept by the
   * flame and taking nothing. One `tan` per call, none per enemy. A body at
   * the apex (along ≈ 0, offset ≤ its radius) is inside by construction,
   * which is what a flamethrower does to something hugging you.
   */
  damageCone(point, dirX, dirZ, halfAngle, range, amount, wuxing = -1, wuxingB = -1, kbScale = 1) {
    // Clamped below a right angle: past π/2 `tan` goes negative and the test
    // below rejects everything, so a "wider cone" breakpoint would silently
    // switch the flamethrower off rather than widen it (review catch). A
    // wedge at or past 90° is a disc with a back wall — out of scope for
    // this shape, and the completeness pin refuses to let a row ask for one.
    const tanHalf = Math.tan(Math.min(halfAngle, 1.5));
    let hits = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      const kind = settings.enemies[BEHAVIORS[this.behavior[i]]];
      const dx = this.x[i] - point.x;
      const dz = this.z[i] - point.z;
      const dist = Math.hypot(dx, dz);
      if (dist >= range + kind.radius) continue;
      // Distance along the axis and offset across it, so the body's own
      // radius pads BOTH edges — the same courtesy damageRing extends at its
      // inner and outer rims. A pure angular test pads only the far edge,
      // which leaves a tank visibly swept by the flame and taking nothing
      // (review catch). `along > 0` keeps the wedge in front; a body at the
      // apex itself (along ≈ 0, offset ≈ 0 ≤ its radius) is inside, which is
      // what a flamethrower does to something hugging you.
      const along = dx * dirX + dz * dirZ;
      const offset = Math.abs(dx * dirZ - dz * dirX);
      if (along < 0 || offset > along * tanHalf + kind.radius) continue;
      hits++;
      this.flash[i] = 1;
      if (kbScale) {
        const d = dist || 1;
        const kb = (settings.enemies.knockback / kind.mass) * this.tuning.kbMult * kbScale;
        this.kbX[i] += (dx / d) * kb;
        this.kbZ[i] += (dz / d) * kb;
      }
      this._applyWux(i, amount, wuxing, wuxingB);
    }
    this._flushReactions();
    return hits;
  }

  damageOnce(castId, point, radius, amount, wuxing = -1, wuxingB = -1) {
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
      this._applyWux(i, amount, wuxing, wuxingB);
    }
    this._flushReactions();
    // ponytail: memory grows one Set per cast; RunManager clears finished casts.
    return hits;
  }

  /**
   * The wuxing half of a hit (spec §4.6): matchup multiplier, live vuln
   * amplification, the debuff channel an overcoming hit inflicts, and mark
   * resolution. Shared by damage(), damageOnce() and damageRing() so no hit
   * loop forks this.
   *
   * `wuxingB` (M7 T1, spec §4.7 双属性判定) is a fused cast's second
   * candidate — call convention is **wuxing = 子系 (child), wuxingB = 母系
   * (parent)**, defaulted -1 so every pre-M7 single-element call is
   * bit-identical to before. Matchup weighs BOTH candidates against the
   * target and takes the better multiplier (更优一系) — but everything
   * downstream (the overcoming debuff, mark application, detonation) still
   * reads `wuxing` alone: a hit only inflicts its child's own debuff when
   * the child itself overcomes, even if the parent's matchup is what won.
   *
   * Order is load-bearing. Matchup first. Then any *live* vuln amplifies
   * this hit's dealt — any wuxing, including none at all, so splash/助燃
   * follow-ups cast with no wuxing still profit from a vuln an earlier hit
   * left behind. Only THEN does an overcoming hit apply its own debuff
   * channel, so the hit that freshly applies vuln never amplifies itself
   * with it. Mark resolution runs last: a detonating hit keeps the dealt
   * computed above in full — 克制必生效 (controller ruling, spec 锚5) — the
   * sheng bonus is a separate, additional payoff off the raw pre-matchup
   * amount, not a replacement for the triggering hit's own damage.
   */
  _applyWux(i, amount, wuxing, wuxingB = -1) {
    let dealt = amount;
    let overcoming = false;
    if (wuxing >= 0) {
      const target = this.element[i];
      let mult = this._matchup(wuxing, target);
      if (wuxingB >= 0) mult = Math.max(mult, this._matchup(wuxingB, target));
      dealt *= mult;
      overcoming = BEATS[wuxing] === target;
    }
    if (this.vulnT[i] > 0) dealt *= 1 + this.vulnAmt[i]; // 易伤/熔甲: live vuln bites every hit
    if (overcoming) this._applyDebuff(i, wuxing);

    if (wuxing >= 0) {
      const old = this.mark[i];
      if (old !== 255 && old !== wuxing && FEEDS[old] === wuxing) {
        // Detonate: the sheng bonus stacks on top of the triggering hit's
        // own (already matchup'd + vuln'd) dealt, computed off the raw
        // pre-matchup amount so it doesn't inherit that multiplier too.
        const bonus = amount * settings.marks.reactionMult * this.tuning.reactionMult;
        this.onHit?.(this.x[i], this.z[i], bonus);
        this._queueReaction(old, wuxing, this.x[i], this.z[i], amount);
        this.mark[i] = 255;
        if ((this.hp[i] -= bonus) <= 0) {
          this._kill(i);
          return;
        }
      } else {
        this.mark[i] = wuxing;
        this.markT[i] = settings.marks.duration;
      }
    }
    this.onHit?.(this.x[i], this.z[i], dealt);
    if ((this.hp[i] -= dealt) <= 0) this._kill(i);
  }

  /** Record a detonation's side effect instead of firing it mid-loop (see the field comment on _reactionQueue above). */
  _queueReaction(markWux, wux, x, z, amount) {
    if (this._reactionCount >= REACTION_QUEUE_CAP) return; // ponytail: fixed-cap queue, overflow drops the reaction rather than growing/crashing — raise REACTION_QUEUE_CAP if a single call ever legitimately detonates more than 32 marks
    const base = this._reactionCount++ * 5;
    this._reactionQueue[base] = markWux;
    this._reactionQueue[base + 1] = wux;
    this._reactionQueue[base + 2] = x;
    this._reactionQueue[base + 3] = z;
    this._reactionQueue[base + 4] = amount;
  }

  /**
   * Runs once the calling damage()/damageOnce() loop has fully resolved.
   * Snapshot-then-reset-then-iterate, in that order: onReaction can itself
   * re-enter damage() (助燃's splash), which appends fresh entries to
   * _reactionQueue and calls this same method again at its own end. Reading
   * straight out of _reactionQueue while iterating would hand that reentrant
   * flush a live buffer to overwrite mid-read, so the pending entries are
   * copied to a second preallocated buffer, and the count reset to 0, before
   * a single callback fires. This is safe today for one reason only: every
   * current reaction deals untyped damage (wuxing -1), which _applyWux can
   * never queue a reaction off, so a reentrant flush is always a same-call
   * no-op — not "safe regardless of nesting depth." A future typed-damage
   * reaction would still clobber this shared _reactionFlush buffer mid-
   * iteration of an outer flush (the copy only guards _reactionQueue against
   * concurrent refill, not this buffer against a second writer), and this
   * scheme would need revisiting before one ships.
   */
  _flushReactions() {
    const n = this._reactionCount;
    if (n === 0) return;
    this._reactionFlush.set(this._reactionQueue.subarray(0, n * 5));
    this._reactionCount = 0;
    for (let k = 0; k < n; k++) {
      const b = k * 5;
      this.onReaction?.(
        this._reactionFlush[b],
        this._reactionFlush[b + 1],
        this._reactionFlush[b + 2],
        this._reactionFlush[b + 3],
        this._reactionFlush[b + 4]
      );
    }
  }

  /** 克中 debuff channel, keyed by the attacker's wuxing (spec §4.6 三通道). */
  _applyDebuff(i, wuxing) {
    const d = settings.combat.debuffs;
    if (wuxing === 2) this.weakT[i] = d.weak.duration; // 水 熄灭
    else if (wuxing === 4) this.slowAmpT[i] = d.slowAmp.duration; // 土 淤塞
    else {
      const ch = wuxing === 3 ? d.vulnStrong : d.vuln; // 火 熔甲 vs 金/木 断枝·破土
      this.vulnT[i] = ch.duration;
      this.vulnAmt[i] = ch.amount;
    }
  }

  /** One candidate wuxing's matchup multiplier against `target` (spec §4.7
   * 更优一系): ×advantage if it overcomes, ×disadvantage if it's overcome,
   * ×1 (neutral) otherwise. `_applyWux` calls this once per candidate
   * (wuxing, and wuxingB when a fused cast supplies one) and keeps the
   * larger of the two. */
  _matchup(wux, target) {
    if (BEATS[wux] === target) return this._advantage();
    if (BEATS[target] === wux) return this._disadvantage();
    return 1;
  }

  _advantage() {
    return this.tuning.advantage || settings.combat.matchup.advantage;
  }

  _disadvantage() {
    return this.tuning.disadvantage || settings.combat.matchup.disadvantage;
  }

  /** `innerRadius` (M8 T3, default 0 = a filled disc) skips bodies deeper
   * inside than their own collision radius, exactly the way damageRing and
   * applyVuln already do — so a ring-shaped field's control matches its
   * damage instead of reaching into an eye it can't touch. */
  slow(point, radius, factor, duration, innerRadius = 0) {
    const dur = duration * this.tuning.slowDurMult;
    for (let i = 0; i < this.count; i++) {
      const pad = settings.enemies[BEHAVIORS[this.behavior[i]]].radius;
      const reach = radius + pad;
      const dist = Math.hypot(this.x[i] - point.x, this.z[i] - point.z);
      if (dist >= reach) continue;
      if (innerRadius > 0 && dist < innerRadius - pad) continue;
      // 淤塞: a standing slowAmp doubles this slow's own factor before it merges.
      const f = this.slowAmpT[i] > 0
        ? Math.min(settings.combat.debuffs.slowAmp.cap, factor * settings.combat.debuffs.slowAmp.mult)
        : factor;
      this.slowed[i] = Math.max(this.slowed[i], f);
      this.slowT[i] = Math.max(this.slowT[i], dur);
    }
  }

  /**
   * 破甲 (M7 T4 锋岩星阵): apply a vuln of `amt` for `time` seconds to every
   * enemy within the annulus [innerRadius, radius] of `point`. The band test
   * mirrors damageRing()'s exactly, inner-edge pad included, so the vuln
   * footprint can never drift from the grind footprint that rides the same
   * row (WYSIWYG) — innerRadius 0 degenerates to the same solid disc.
   *
   * Writes the ONE shared vulnT/vulnAmt channel `_applyDebuff`'s 断枝/熔甲
   * already write ("vuln or the stronger vulnStrong, never both" — the field
   * comment above), with one more rule a per-tick re-application forces:
   * a live STRONGER vuln is left entirely alone (弱不降级强) — magnitude and
   * timer both — where equal strength refreshes the timer (the array
   * re-arming its own 3s linger every tick) and stronger overwrites outright,
   * the same latest-wins write `_applyDebuff` itself does. `vulnT` is the
   * liveness signal (tick() clamps it to 0 and leaves vulnAmt stale), so an
   * expired amount never blocks a fresh application.
   */
  applyVuln(point, innerRadius, radius, amt, time) {
    // Compare float32-vs-float32: vulnAmt is a Float32Array, and a
    // non-binary-exact amt (0.3 → stored 0.30000001…) would otherwise read
    // back as "stronger than itself" and silently stop refreshing the timer
    // on its own re-application (reviewer catch).
    amt = Math.fround(amt);
    for (let i = 0; i < this.count; i++) {
      const kind = settings.enemies[BEHAVIORS[this.behavior[i]]];
      const dist = Math.hypot(this.x[i] - point.x, this.z[i] - point.z);
      if (dist >= radius + kind.radius) continue;
      if (dist < innerRadius - kind.radius) continue;
      if (this.vulnT[i] > 0 && this.vulnAmt[i] > amt) continue; // 弱不降级强
      this.vulnT[i] = time;
      this.vulnAmt[i] = amt;
    }
  }

  /**
   * Shockwave shove (spec §12 震地波 击退): an extra outward impulse on top
   * of the baseline every damage() hit already applies — same mass/kbMult
   * scaling, same kbX/kbZ channel the decay integrator drains. Sweep shape
   * mirrors slow() above: burst rows compose it after their damage call.
   */
  knockback(point, radius, impulse) {
    for (let i = 0; i < this.count; i++) {
      const kind = settings.enemies[BEHAVIORS[this.behavior[i]]];
      const dx = this.x[i] - point.x;
      const dz = this.z[i] - point.z;
      const dist = Math.hypot(dx, dz);
      if (dist >= radius + kind.radius) continue;
      const d = dist || 1;
      const kb = (impulse / kind.mass) * this.tuning.kbMult;
      this.kbX[i] += (dx / d) * kb;
      this.kbZ[i] += (dz / d) * kb;
    }
  }

  /**
   * Kills every enemy within `radius` of `point` whose hp is at or under
   * `hpThreshold` — an absolute floor (spec §4.9 金斩杀; see
   * settings.ultimate.metal for why it's absolute, not a %-of-max-hp ratio).
   * Goes through `_kill` so onDeath still fires (gems/shards), unlike a bare
   * `hp[i] = 0`. Not hot-path — Ultimate calls this once per cast, never per tick.
   */
  executeBelow(point, radius, hpThreshold) {
    for (let i = this.count - 1; i >= 0; i--) {
      if (this.hp[i] > hpThreshold) continue;
      const reach = radius + settings.enemies[BEHAVIORS[this.behavior[i]]].radius;
      if (Math.hypot(this.x[i] - point.x, this.z[i] - point.z) >= reach) continue;
      this._kill(i);
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
    this.onDeath?.(this.x[i], this.z[i], this.element[i], this.elite[i]);
    const last = --this.count;
    if (i === last) return;
    for (const a of [
      this.x, this.z, this.prevX, this.prevZ, this.hp, this.slowed, this.slowT,
      this.flash, this.kbX, this.kbZ, this.element, this.behavior, this.elite, this.fireT, this.id,
      this.mark, this.markT, this.vulnT, this.vulnAmt, this.weakT, this.slowAmpT
    ]) {
      a[i] = a[last];
    }
  }

  clear() {
    this.count = 0;
    this._hitMemory.clear();
    this._reactionCount = 0;
  }
}

const _push = [0, 0];
