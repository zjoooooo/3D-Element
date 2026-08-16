// src/run/CombatSystem.js
import { settings } from '../config/settings.js';

/**
 * Reads live ability state each tick and turns it into targets calls (spec §3).
 *
 * Abilities stay pure VFX — their public state (origin, direction, front
 * position, phase) already says where the danger is, and this table says what
 * that danger does. One WeakMap hands every cast a stable id so sweeps can
 * hit each enemy exactly once per cast.
 *
 * Beam's line damage is sampled at three points along the segment
 * (start / middle / front) rather than a true capsule test.
 * ponytail: 3-point sampling reads identically at beam width; a segment
 * distance query replaces it if a wide-line ability ever misses visibly.
 */
const LINE_SAMPLES = 3;

export class CombatSystem {
  constructor(targets, modifiers = null) {
    this.targets = targets;
    /** Damage multipliers from the run's upgrade layer; null in the sandbox. */
    this.mods = modifiers;
    this._castIds = new WeakMap();
    this._nextCast = 1;
    // Both keyed by numeric castId, so plain Map/Set — a WeakMap rejects
    // primitives. Entries are dropped via release() when a cast finishes.
    this._tickBudget = new Map(); // per-cast dot accumulator
    this._detonated = new Set(); // castIds whose burst already went off
    this._sweptU = new Map(); // per-cast u the sweep has been sampled up to
    this._p = { x: 0, z: 0 }; // scratch point, reused — no allocs per tick
    /** This run's per-skill damage ledger (spec §1 results screen top-3).
     * Nominal amt×hits, booked pre-matchup — the wuxing tax/bonus folds inside
     * EnemySystem per enemy, so a mixed crowd nets out; the ledger only needs
     * to rank skills against each other, not settle the run's exact total. */
    this.damageDealt = Object.create(null);
  }

  /** Wipe the damage ledger — a fresh run starts counting from zero. */
  resetStats() {
    this.damageDealt = Object.create(null);
  }

  /** Damage multiplier for a cast: the run's upgrade layer, times the 15%
   * autocast tax when the slot fired itself (`ability.autocast`, written on
   * every cast so a pooled instance never carries a stale flag forward),
   * times 1.5 for a quenched cast (`ability.quenched`, App writes it at cast
   * time — consuming the charge is App's job, this just honors the flag) and
   * the cast's own fusion multiplier (`ability.fusionMult`, 1 when unfused). */
  _amp(ability) {
    const base = this.mods ? this.mods.damageMult(ability.element) : 1;
    const taxed = ability.autocast ? base * settings.run.autocastDamage : base;
    return taxed * (ability.quenched ? 1.5 : 1) * (ability.fusionMult ?? 1);
  }

  /** Book a landed hit's nominal damage against its element, if it landed. */
  _book(element, amount, hits) {
    if (hits) this.book(element, amount * hits);
  }

  /**
   * Add a nominal damage amount straight to an element's ledger. `_book`
   * above is tick()'s own hit-counting entry point; this is the public door
   * for a self-resolved ability (fireball) that never runs through tick()
   * and so has to book its own hits directly (D-M3-8).
   */
  book(element, amount) {
    this.damageDealt[element] = (this.damageDealt[element] ?? 0) + amount;
  }

  _castKey(ability) {
    let id = this._castIds.get(ability);
    if (id === undefined) {
      // The id lives for the cast's lifetime; release() retires it with the
      // cast, so a pooled object re-acquired for a new one mints fresh here.
      id = this._nextCast++;
      this._castIds.set(ability, id);
    }
    return id;
  }

  /** Forget a finished cast: budget, detonation memory, and hand back its id. */
  release(ability) {
    const id = this._castIds.get(ability);
    if (id === undefined) return -1;
    this._castIds.delete(ability);
    this._tickBudget.delete(id);
    this._detonated.delete(id);
    this._sweptU.delete(id);
    return id;
  }

  /**
   * @returns {number} total healing due to the player this tick (lifebloom's
   *   `healPlayer` — see the 'burst' case). RunManager is the one place that
   *   actually calls `player.heal()` with it ("RunManager routes heal"):
   *   CombatSystem never touches PlayerState, same as it never has.
   */
  tick(step, active) {
    let healDue = 0;
    for (const ability of active) {
      const c = settings.combat[ability.element];
      if (!c || c.kind === 'self') continue;
      const castId = this._castKey(ability);
      const wux = settings.combat.wuxingOf[ability.element] ?? -1;

      switch (c.kind) {
        case 'sweep': {
          // The front's position only advances on the render frame, so at low
          // fps (or with the live speed/timeScale sliders up) it can jump past
          // `width` between two observations and a bolt visibly crossing an
          // enemy deals nothing. Sample the whole segment travelled since the
          // last look instead of the point where the front happens to be —
          // damageOnce's per-cast dedup makes overlapping samples free. The
          // phase can also flip to impact between looks, so the landing flushes
          // whatever tail of the line the travel ticks never got to see.
          const from = this._sweptU.get(castId) ?? 0;
          const travelling = ability.phase === 'travel';
          const landed = ability.phase === 'impact' || ability.phase === 'fade';
          if (!travelling && !(landed && from < 1)) break;
          const to = travelling ? ability.u : 1;
          const stepU = Math.max(0.01, c.width / ability.length);
          const amt = c.damage * this._amp(ability);
          for (let t = from; ; t += stepU) {
            const u = Math.min(t, to);
            this._p.x = ability.origin.x + ability.direction.x * ability.length * u;
            this._p.z = ability.origin.z + ability.direction.z * ability.length * u;
            this._book(ability.element, amt, this.targets.damageOnce(castId, this._p, c.width, amt, wux));
            if (u >= to) break;
          }
          this._sweptU.set(castId, to);
          if (c.slowFactor && travelling) {
            this.targets.slow(ability.position, c.width * 1.5, c.slowFactor, c.slowTime);
          }
          break;
        }

        case 'burst': {
          // One detonation per cast. A phase-window gate double-fires here:
          // abilities advance on the render frame while this runs at a fixed
          // 60Hz, so any time window is seen once per queued tick, not once.
          // The per-cast Set fires it exactly once — on 'fade' too, since a
          // stalled frame can jump clean past 'impact'.
          if (
            (ability.phase === 'impact' || ability.phase === 'fade') &&
            !this._detonated.has(castId)
          ) {
            this._detonated.add(castId);
            const radius = c.radius ?? settings[ability.element].zoneRadius ?? 2;
            const amt = c.damage * this._amp(ability);
            this._book(ability.element, amt, this.targets.damage(ability.position, radius, amt, wux));
            if (c.slowFactor) this.targets.slow(ability.position, radius, c.slowFactor, c.slowTime);
            // M6 T4: boulder's stun — a full-strength (1.0) slow rather than a
            // new mechanic, same debuff channel/resonance/淤塞 interactions
            // c.slowFactor above already rides.
            if (c.stunTime) this.targets.slow(ability.position, radius, 1.0, c.stunTime);
            // M6 T4: lifebloom's self-heal. CombatSystem stays player-agnostic
            // (see tick()'s own doc) — accumulate and hand it back to the caller.
            if (c.healPlayer) healDue += c.healPlayer * this._amp(ability);
          }
          // Meteor's lava keeps burning through the fade, but the lava stops
          // burning when the knob says so, not when the VFX happens to fade:
          // impactTime freezes once the fade starts and fadeTime accrues from
          // 0, so their sum is seconds since impact. Flush inline — a callback
          // here would allocate a closure every tick.
          if (
            c.burnDps &&
            (ability.phase === 'impact' || ability.phase === 'fade') &&
            ability.impactTime + ability.fadeTime < c.burnTime
          ) {
            // Fire resonance (T5's dotMult) rides the burn only — 火, wux 3 —
            // and degrades to ×1 both in the sandbox (mods null) and against
            // a pre-T5 Modifiers that doesn't carry dotMult yet.
            const resonance = wux === 3 ? this.mods?.dotMult?.() ?? 1 : 1;
            if (this._dot(castId, step, c.burnDps * this._amp(ability) * resonance)) {
              const amt = this._take(castId);
              this._book(ability.element, amt, this.targets.damage(ability.position, c.radius, amt, wux));
            }
          }
          break;
        }

        case 'lineTick': {
          if (ability.phase === 'idle' || ability.phase === 'done') break;
          const perSecond = (c.dps * this._amp(ability)) / LINE_SAMPLES;
          const amt = perSecond * step;
          for (let s = 1; s <= LINE_SAMPLES; s++) {
            const t = (s / LINE_SAMPLES) * ability.u;
            this._p.x = ability.origin.x + ability.direction.x * ability.length * t;
            this._p.z = ability.origin.z + ability.direction.z * ability.length * t;
            this._book(ability.element, amt, this.targets.damage(this._p, c.width, amt, wux));
          }
          break;
        }

        case 'zoneTick': {
          if (ability.phase === 'idle' || ability.phase === 'done') break;
          const radius = settings[ability.element].zoneRadius ?? 2;
          const amt = c.dps * this._amp(ability) * step;
          this._book(ability.element, amt, this.targets.damage(ability.position, radius, amt, wux));
          if (c.slowFactor) this.targets.slow(ability.position, radius, c.slowFactor, c.slowTime);
          break;
        }

        case 'aura': {
          // 装备即常驻 (M6 T4): a permanent cast that never leaves 'travel' (see
          // OrbitAuraSkill) — always ticks while seated. `c.dps` already carries
          // the self-aura shape coefficient (settings.combat's own comment: BASE_DPS
          // × 0.7, baked into the constant at balance time — not re-applied here,
          // same as every other kind above never re-derives its own baseline).
          // The hit test is a genuine annulus — `ability.position` is the *player*
          // (OrbitAuraSkill keeps it pinned there every frame, not the cast's
          // origin) — because the visual is a ring the swords/flames/orbs actually
          // occupy, not a filled disc: an enemy standing on the caster's own feet,
          // well inside the ring, should take nothing (WYSIWYG).
          if (ability.phase === 'idle' || ability.phase === 'done') break;
          const inner = Math.max(0, c.radius - (c.band ?? 0));
          const amt = c.dps * this._amp(ability) * step;
          this._book(
            ability.element,
            amt,
            this.targets.damageRing(ability.position, inner, c.radius, amt, wux)
          );
          break;
        }

        default:
          break;
      }
    }
    return healDue;
  }

  /* Accumulate fractional dot damage so tiny per-tick amounts still land.
     Returns true when a full point is banked — caller flushes via _take. */
  _dot(castId, step, dps) {
    const acc = (this._tickBudget.get(castId) ?? 0) + dps * step;
    this._tickBudget.set(castId, acc);
    return acc >= 1;
  }

  _take(castId) {
    const acc = this._tickBudget.get(castId) ?? 0;
    this._tickBudget.set(castId, 0);
    return acc;
  }
}
