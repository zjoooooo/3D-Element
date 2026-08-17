// src/run/CombatSystem.js
import { settings } from '../config/settings.js';
import { bpScale, bpAdd, bpReplace, bpFlag } from './breakpoints.js';
import { isFusionId, fusionParents, pairKeyOf } from './fusions.js';

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

/**
 * M7 T3: the 'burst' case's wave table, generalised off 陨石 Lv5's old
 * bespoke extraWave branch (spec §4.7, 地心火山's three magma bombs). A row
 * with no `waves` field of its own detonates through this single implicit
 * entry — delay 0, ×1 damage, ×1 radius — reproducing the pre-M7-T3 "one
 * unconditional hit on first sight of impact/fade" behaviour exactly.
 * Frozen and shared: every such row reads this exact same array reference,
 * never a fresh one per tick (zero-alloc hot path).
 */
const DEFAULT_WAVE = Object.freeze([{ delay: 0, damageMult: 1, radiusMult: 1 }]);

/** 陨石 Lv5's extraWave, now data instead of a bespoke branch: one more
 * detonation 0.5s after the cast's own last wave, at ×0.6 damage and ×0.6
 * radius — the exact numbers the old hardcoded branch used. */
const EXTRA_WAVE = Object.freeze({ delay: 0.5, damageMult: 0.6, radiusMult: 0.6 });

/**
 * `element`'s combat row (spec §4.7): a fusion id resolves through its
 * pair-key into `settings.combat.fusions`, a plain id straight into
 * `settings.combat` — the one lookup `tick()` uses below, exported so a
 * caller (or an assertion) can ask the same question without an instance.
 */
export function rowFor(element) {
  return isFusionId(element) ? settings.combat.fusions[pairKeyOf(element)] : settings.combat[element];
}

export class CombatSystem {
  /**
   * @param {(element: string) => number} [levelOf] M6 T12: the run's
   *   loadout.levelOf, injected so breakpoints.js's bpScale/bpAdd/bpReplace/
   *   bpFlag calls below have a level to read. Null (every pre-T12 call
   *   site, and the sandbox — App only wires this inside its runMode block)
   *   reads as a constant Lv1 via `_level()`, which is identity everywhere:
   *   CombatSystem stays sandbox-agnostic and never imports Loadout.
   */
  constructor(targets, modifiers = null, levelOf = null) {
    this.targets = targets;
    /** Damage multipliers from the run's upgrade layer; null in the sandbox. */
    this.mods = modifiers;
    this.levelOf = levelOf;
    this._castIds = new WeakMap();
    this._nextCast = 1;
    // Both keyed by numeric castId, so plain Map/Set — a WeakMap rejects
    // primitives. Entries are dropped via release() when a cast finishes.
    this._tickBudget = new Map(); // per-cast dot accumulator
    this._detonated = new Set(); // castIds whose burst already went off (shield kind only, as of M7 T3 — 'burst' tracks itself via _waveCursor below)
    // M7 T3: per-cast "how many waves have detonated" cursor for the
    // 'burst' case — replaces the old `_detonated`+`_extraDetonated` pair
    // there (shield still uses `_detonated` above, on its own, unaffected).
    // A row's own `damage`/`radius` are one implicit wave (`DEFAULT_WAVE`,
    // delay 0) unless it supplies its own `waves` table (地心火山's three
    // bombs); 陨石 Lv5's `extraWave` flag is `EXTRA_WAVE`, appended after
    // whichever list applies — one channel instead of two parallel Sets.
    this._waveCursor = new Map();
    this._sweptU = new Map(); // per-cast u the sweep has been sampled up to
    this._p = { x: 0, z: 0 }; // scratch point, reused — no allocs per tick
    /** This run's per-skill damage ledger (spec §1 results screen top-3).
     * Nominal amt×hits, booked pre-matchup — the wuxing tax/bonus folds inside
     * EnemySystem per enemy, so a mixed crowd nets out; the ledger only needs
     * to rank skills against each other, not settle the run's exact total. */
    this.damageDealt = Object.create(null);
    /**
     * M6 T5 (冰晶甲/石肤): this tick's shield application, if any. Reused in
     * place every tick (never a fresh object) — `amount` reads 0 when no
     * shield-kind cast detonated this tick. Same "CombatSystem stays player-
     * agnostic, RunManager applies it" shape as `tick()`'s own `healDue`
     * return, just surfaced as a public field instead of a second return
     * value — `tick()`'s numeric return is already pinned by an M6 T4
     * assertion (`healCombat.tick(...) === 0`), so reusing it as a second
     * channel would break that contract instead of extending it.
     */
    this.shieldDue = { amount: 0, duration: 0, reflectShare: 0 };
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
    this._waveCursor.delete(id);
    this._sweptU.delete(id);
    return id;
  }

  /** M6 T12: `element`'s skill level for this tick's breakpoint reads — 1
   * (identity) with no `levelOf` injected, same null-safe shape `this.mods`
   * already uses a few lines up. */
  _level(element) {
    return this.levelOf ? this.levelOf(element) : 1;
  }

  /**
   * @param {{x:number, z:number}|null} [playerPos] M7 T6: the player's
   *   position, read-only, threaded in by RunManager for the marsh kind's
   *   stand-inside heal — optional and null everywhere else (every legacy
   *   2-arg caller reads exactly as before). CombatSystem still never
   *   touches PlayerState; position in, healDue out.
   * @returns {number} total healing due to the player this tick (lifebloom's
   *   `healPlayer` — see the 'burst' case — and the marsh's `healInside`).
   *   RunManager is the one place that actually calls `player.heal()` with
   *   it ("RunManager routes heal"): CombatSystem never touches PlayerState,
   *   same as it never has.
   */
  tick(step, active, playerPos = null) {
    let healDue = 0;
    this.shieldDue.amount = 0;
    for (const ability of active) {
      const c = rowFor(ability.element);
      if (!c || c.kind === 'self') continue;
      const castId = this._castKey(ability);
      // M7 T1 (spec §4.7 双属性判定): a fused cast's hits carry two
      // candidates — wux = 子系 (the generated half; mark/debuff identity,
      // same as fusionWux() elsewhere), wuxB = 母系 (matchup-only, see
      // EnemySystem#_applyWux). A plain element only ever had the one.
      const fusedParents = isFusionId(ability.element) ? fusionParents(ability.element) : null;
      const wux = fusedParents
        ? settings.combat.wuxingOf[fusedParents[1]] ?? -1
        : settings.combat.wuxingOf[ability.element] ?? -1;
      const wuxB = fusedParents ? settings.combat.wuxingOf[fusedParents[0]] ?? -1 : -1;
      // M6 T12: this cast's skill level, read once per ability per tick —
      // every case below folds its own relevant params through bpScale/
      // bpAdd/bpReplace/bpFlag off this same number.
      const level = this._level(ability.element);

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
          // M6 T12: width feeds both the damage sample radius and the slow
          // radius below, so it's scaled once here rather than at each use.
          const width = c.width * bpScale(ability.element, 'width', level);
          const stepU = Math.max(0.01, width / ability.length);
          const amt = c.damage * this._amp(ability) * bpScale(ability.element, 'damage', level);
          for (let t = from; ; t += stepU) {
            const u = Math.min(t, to);
            this._p.x = ability.origin.x + ability.direction.x * ability.length * u;
            this._p.z = ability.origin.z + ability.direction.z * ability.length * u;
            this._book(ability.element, amt, this.targets.damageOnce(castId, this._p, width, amt, wux, wuxB));
            if (u >= to) break;
          }
          this._sweptU.set(castId, to);
          // M6 T12: slowFactor REPLACEs (thunder arms from 0, snare 0.45→0.65
          // — see breakpoints.js's REPLACE_KEYS) rather than scaling; falls
          // back to the row's own base when no breakpoint tier applies.
          const slowFactor = bpReplace(ability.element, 'slowFactor', level) ?? c.slowFactor;
          if (slowFactor && travelling) {
            const slowTime = c.slowTime * bpScale(ability.element, 'slowTime', level);
            this.targets.slow(ability.position, width * 1.5, slowFactor, slowTime);
          }
          break;
        }

        case 'burst': {
          // A cast's detonations are an ordered list of "waves" (M7 T3,
          // generalised off 陨石 Lv5's old bespoke extraWave branch): a row
          // with its own `waves` table (地心火山's three magma bombs, each
          // scattered to its own landing point by the class — see that
          // row's own comment) fires exactly that list; a row with no
          // `waves` field (every other burst skill) falls back to
          // `DEFAULT_WAVE`, one implicit hit at delay 0 — byte-identical to
          // the old unconditional "first sight of impact/fade" detonation.
          // `extraWave` (陨石 Lv5) appends `EXTRA_WAVE` after whichever list
          // applies; meteor never defines its own `waves`, so arming it is
          // exactly the old "primary, then one more 0.5s later at ×0.6".
          // `_waveCursor` (per-cast, released alongside the others) is how
          // many waves have fired — replaces `_detonated`+`_extraDetonated`
          // for this case (shield still uses `_detonated` on its own).
          // A phase-window gate double-fires here: abilities advance on the
          // render frame while this runs at a fixed 60Hz, so any time
          // window is seen once per queued tick, not once — the cursor only
          // ever moves forward, so a wave that already fired can't re-fire,
          // and a stalled frame that jumps clean past several delays at
          // once still fires each of them exactly once (catch-up loop).
          const radius =
            (c.radius ?? settings[ability.element].zoneRadius ?? 2) *
            bpScale(ability.element, 'radius', level);
          if (ability.phase === 'impact' || ability.phase === 'fade') {
            const age = ability.impactTime + ability.fadeTime; // seconds since impact
            const waves = c.waves ?? DEFAULT_WAVE;
            const total = waves.length + (bpFlag(ability.element, 'extraWave', level) ? 1 : 0);
            let cursor = this._waveCursor.get(castId) ?? 0;
            while (cursor < total) {
              const wave = cursor < waves.length ? waves[cursor] : EXTRA_WAVE;
              if (age < wave.delay) break;
              const waveRadius = radius * wave.radiusMult;
              const amt = c.damage * this._amp(ability) * wave.damageMult;
              this._book(ability.element, amt, this.targets.damage(ability.position, waveRadius, amt, wux, wuxB));
              // M6 T12: slowFactor REPLACEs, same rule as the sweep case above.
              const slowFactor = bpReplace(ability.element, 'slowFactor', level) ?? c.slowFactor;
              if (slowFactor) {
                const slowTime = c.slowTime * bpScale(ability.element, 'slowTime', level);
                this.targets.slow(ability.position, waveRadius, slowFactor, slowTime);
              }
              // M6 T4: boulder's stun (M7 T3: every one of volcano's three
              // bombs too) — a full-strength (1.0) slow rather than a new
              // mechanic, same debuff channel/resonance/淤塞 interactions
              // c.slowFactor above already rides.
              if (c.stunTime) {
                const stunTime = c.stunTime * bpScale(ability.element, 'stunTime', level);
                this.targets.slow(ability.position, waveRadius, 1.0, stunTime);
              }
              // quake's 震地波 shove — an extra shockwave impulse beyond the
              // baseline the damage() hit itself already applied.
              if (c.knockback) {
                this.targets.knockback(
                  ability.position,
                  waveRadius,
                  c.knockback * bpScale(ability.element, 'knockback', level)
                );
              }
              // M6 T4: lifebloom's self-heal. CombatSystem stays player-agnostic
              // (see tick()'s own doc) — accumulate and hand it back to the caller.
              if (c.healPlayer) {
                healDue += c.healPlayer * this._amp(ability) * bpScale(ability.element, 'healPlayer', level);
              }
              cursor++;
            }
            this._waveCursor.set(castId, cursor);
            // M7 T3: how many waves have fired, exposed on the ability
            // itself so a wave-riding class (VolcanoSkill) can move
            // `ability.position` to the next scatter point ahead of the
            // wave that will land there, and detect "a wave just
            // detonated" to spawn its own trailing VFX (a lava pool) at
            // that exact spot and moment.
            ability.waveIndex = cursor;
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
              this._book(ability.element, amt, this.targets.damage(ability.position, radius, amt, wux, wuxB));
            }
          }
          break;
        }

        case 'shield': {
          // Detonates once per cast, same idiom as burst above — except there
          // is no travel/arrival to gate on: a shield cast is self-centred
          // and instant (ShieldSkill's own `advance()` never reports
          // anything else), so "on cast" and "the first tick this ability is
          // active" are the same moment. Gating on `_detonated` alone (no
          // phase check — every ability `tick()` ever sees is already past
          // idle by construction) keeps this decoupled from however long
          // ShieldSkill's own VFX phase machine later chooses to hold the
          // ring up for (see that class's own doc).
          if (!this._detonated.has(castId)) {
            this._detonated.add(castId);
            const amt = c.amount * this._amp(ability) * bpScale(ability.element, 'amount', level);
            // Take the larger of two casts that happen to detonate the same
            // tick (a near-impossible coincidence, but resolved the same
            // order-independent way PlayerState.addShield's own take-max
            // already is) rather than reporting both.
            if (amt >= this.shieldDue.amount) {
              this.shieldDue.amount = amt;
              this.shieldDue.duration = c.duration * bpScale(ability.element, 'duration', level);
              this.shieldDue.reflectShare = (c.reflectShare ?? 0) * bpScale(ability.element, 'reflectShare', level);
            }
          }
          break;
        }

        case 'lineTick': {
          if (ability.phase === 'idle' || ability.phase === 'done') break;
          const width = c.width * bpScale(ability.element, 'width', level);
          const perSecond = (c.dps * this._amp(ability) * bpScale(ability.element, 'dps', level)) / LINE_SAMPLES;
          const amt = perSecond * step;
          for (let s = 1; s <= LINE_SAMPLES; s++) {
            const t = (s / LINE_SAMPLES) * ability.u;
            this._p.x = ability.origin.x + ability.direction.x * ability.length * t;
            this._p.z = ability.origin.z + ability.direction.z * ability.length * t;
            this._book(ability.element, amt, this.targets.damage(this._p, width, amt, wux, wuxB));
          }
          break;
        }

        case 'zoneTick': {
          if (ability.phase === 'idle' || ability.phase === 'done') break;
          const radius = (settings[ability.element].zoneRadius ?? 2) * bpScale(ability.element, 'radius', level);
          const amt = c.dps * this._amp(ability) * step;
          this._book(ability.element, amt, this.targets.damage(ability.position, radius, amt, wux, wuxB));
          const slowFactor = bpReplace(ability.element, 'slowFactor', level) ?? c.slowFactor;
          if (slowFactor) {
            const slowTime = c.slowTime * bpScale(ability.element, 'slowTime', level);
            this.targets.slow(ability.position, radius, slowFactor, slowTime);
          }
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
          // well inside the ring, should take nothing (WYSIWYG). 锋岩星阵 (M7 T4)
          // rides this same case with band === radius, which degenerates the
          // annulus to a genuine solid disc (inner edge 0) — no second kind.
          //
          // M7 T4: the grind window is TRAVEL+IMPACT only. A permanent aura
          // (OrbitAuraSkill) lives in TRAVEL until it's retired straight to
          // IDLE and never fades, so this changes nothing for it; a TIMED
          // aura cast (PrismArraySkill, the first one) budgets its whole
          // grind as its impactDuration (the row's own 3s), and its cosmetic
          // sink tail (FADE) must not keep grinding past that window.
          if (ability.phase !== 'travel' && ability.phase !== 'impact') break;
          const radius = c.radius * bpScale(ability.element, 'radius', level);
          const band = (c.band ?? 0) * bpScale(ability.element, 'band', level);
          const inner = Math.max(0, radius - band);
          const amt = c.dps * this._amp(ability) * bpScale(ability.element, 'dps', level) * step;
          // `kbMult` (M7 T4, 研磨不推): a row may scale the baseline per-hit
          // shove — 0 for 锋岩星阵, whose 60Hz solid-disc stream would
          // otherwise juggle enemies out of its own footprint (the row's own
          // comment has the numbers). Absent (every permanent aura) reads 1:
          // bladeorbit's blade-wall shove ships unchanged.
          this._book(
            ability.element,
            amt,
            this.targets.damageRing(ability.position, inner, radius, amt, wux, wuxB, c.kbMult ?? 1)
          );
          // M7 T4 (锋岩星阵's 破甲): a row may carry vulnAmt/vulnTime — the
          // same band gets its vuln refreshed every tick, AFTER the damage
          // call, so a tick never amplifies itself with the vuln it just
          // applied (the same freshly-applied-never-self-amplifies order
          // _applyWux keeps for the overcoming debuffs); from the next tick
          // on the standing vuln amplifies every source, this aura's own
          // grind included — the plan's budget line prices that in. Flat
          // row values on purpose: a debuff magnitude is settings-driven
          // like _applyDebuff's own, never damage-amped.
          if (c.vulnAmt) {
            this.targets.applyVuln(ability.position, inner, radius, c.vulnAmt, c.vulnTime);
          }
          break;
        }

        case 'marsh': {
          // 回春雷泽 (M7 T6): a timed pool — TRAVEL+IMPACT only, the same
          // grind-window rule the timed aura established at T4; FADE is the
          // pool draining, visually. Every tick refreshes its slow (a hard
          // 0.5s hold, the plan's own number: leaving the pool sheds it
          // fast) and banks healInside×step while the player stands inside
          // — `playerPos` is RunManager's read-only thread-through, and the
          // heal leaves through tick()'s healDue return exactly like
          // lifebloom's healPlayer. No damage-family calls here by design
          // (pinned since T1): the bolts are ThunderMarshSkill's own
          // self-resolved job.
          if (ability.phase !== 'travel' && ability.phase !== 'impact') break;
          const radius = c.radius * bpScale(ability.element, 'radius', level);
          const slowFactor = bpReplace(ability.element, 'slowFactor', level) ?? c.slowFactor;
          // M8 T1: the refresh hold reads the row (`slowHold`) — T6 shipped
          // it as a code literal, collected into the tuning ledger now.
          if (slowFactor) this.targets.slow(ability.position, radius, slowFactor, c.slowHold ?? 0.5);
          if (playerPos && c.healInside) {
            const dx = playerPos.x - ability.position.x;
            const dz = playerPos.z - ability.position.z;
            if (Math.hypot(dx, dz) < radius) {
              healDue += c.healInside * this._amp(ability) * bpScale(ability.element, 'healInside', level) * step;
            }
          }
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
