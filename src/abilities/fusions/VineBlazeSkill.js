import { Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { Easing } from '../../utils/math.js';
import { fusionParents, pairKeyOf } from '../../run/fusions.js';

const _pos = new Vector3();
const _dir = new Vector3(0, 1, 0);
const _emit = {};
/**
 * `_spawnZone`'s OWN scratch, deliberately separate from `_pos` above
 * (fix round 2). `_payoutZone` hands `_pos` BY REFERENCE into
 * `ctx.targets.damage(_pos, ...)`, which (via `EnemySystem#damage`) holds
 * that reference across a `for` loop that re-reads `point.x`/`point.z` on
 * EVERY iteration — it is never copied once up front. A kill inside that
 * same loop fires `onDeath` synchronously, which can reach this class's own
 * `_onKillAt` → `_spawnZone` while the loop is still mid-iteration. Before
 * this fix, `_spawnZone` reused the SAME `_pos` for its own decal-position
 * set, so a reentrant fork silently overwrote the very point the outer
 * damage() sweep was still reading — every enemy visited AFTER the kill in
 * that same sweep got distance-checked against the wrong centre and
 * (depending on how far the corrupted point drifted) could silently take
 * no damage at all. Same reentrancy CLASS `EnemySystem`'s own
 * `_reactionQueue` field comment documents (a kill's side effect, fired
 * synchronously mid-loop, corrupting that same loop's still-in-progress
 * state) — a sibling bug, with a different repair: that one defers the
 * side effect and drains it once the loop has fully resolved; this one
 * instead gives the reentrant WRITE its own object, so it can never touch
 * what an outer sweep is still reading. `_spawnZone` is reachable from both
 * `onImpact` (never reentrant) and `_onKillAt` (reentrant) — using a
 * dedicated scratch for both call sites, rather than only guarding the
 * reentrant one, keeps the rule simple: nothing reachable from `_onKillAt`
 * ever touches `_pos`.
 */
const _forkPos = new Vector3();

/** Deterministic fallback's angular step (radians) — the golden angle, so a
 * running sequence of children never repeats a direction, however many fork
 * events one cast racks up (see `forkPlacement`'s own doc). */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Implementer's choice, not spec-numbered (mirrors AIM_CORRIDOR/HIT_RADIUS
 * in ChainBoltSkill.js): ember particles per zone per second, before the
 * global emissionRate/particleCount multipliers RateEmitter/emit() already fold in. */
const EMBER_RATE = 10;

/* ------------------------------------------------------------------ */
/* Pure helpers — headlessly testable, mirrors chainHops/dashLineHits   */
/* in the sibling template files (no THREE-backed instance needed).     */
/* ------------------------------------------------------------------ */

/**
 * One zone's burn-DoT accumulator for a single frame — the self-resolved
 * mirror of `CombatSystem#_dot`/`_take` (that pair is per-CAST, keyed by a
 * WeakMap-derived castId; this is per-ZONE, called directly since
 * `combat.fusions['1+3']` is `kind:'self'` and never reaches CombatSystem's
 * tick() at all). Same "leaky bucket" shape: accumulate `dps*step`, and once
 * the bucket reaches 1 or more, pay out the WHOLE bucket (not a clamped 1)
 * and reset it to 0 — a tick where dps*step alone already exceeds 1 pays
 * more than 1 in a single call, exactly like `_dot`/`_take` already does for
 * meteor's lava pool.
 *
 * Mutates `accum[i]` in place rather than returning a fresh object literal —
 * `onFade` calls this once per LIVE zone, up to 5×/frame, so an allocating
 * return would be a real per-frame allocation, not the zero-alloc hot path
 * this file otherwise holds to. Mirrors `chainHops`' own `seen` collaborator
 * / `pointAt(s, out)`'s "mutate the caller's own scratch" shape, used
 * throughout this codebase for exactly this reason (reviewer fix round:
 * `CombatSystem#_dot`/`_take`'s own split into two scalar-returning calls is
 * the same idea, one step further — this keeps it to one call instead of two).
 *
 * @param {Float32Array} accum  this cast's own per-zone accumulator array
 * @param {number} i            which zone
 * @param {number} dps          this zone's own damage-per-second (already amp'd)
 * @param {number} step         seconds since the last tick
 * @returns {number} amount to pay this tick, 0 if nothing banked yet
 */
export function zoneTick(accum, i, dps, step) {
  const next = accum[i] + dps * step;
  if (next >= 1) {
    accum[i] = 0;
    return next;
  }
  accum[i] = next;
  return 0;
}

/** How many live zones a flat `life` array currently holds (life[i] > 0 is
 * the sole liveness signal — see the class doc on why no separate boolean
 * array is kept in sync with it). */
export function liveZoneCount(life) {
  let n = 0;
  for (let i = 0; i < life.length; i++) if (life[i] > 0) n++;
  return n;
}

/** How many of `forkCount` children a fork event may actually place, given
 * `count` zones already alive and a `cap` total (main included) — the spec's
 * "全场同 cast 燃区上限 5" truncation rule, arithmetic only. Never negative. */
export function forkBudget(count, forkCount, cap) {
  return Math.max(0, Math.min(forkCount, cap - count));
}

/**
 * Which live zone (if any) a point falls inside, scanning slot 0 first.
 *
 * Slot 0 is always the main zone for this class's whole active lifetime (see
 * class doc — children only ever claim slots 1..N-1), so checking it first
 * is not an arbitrary tie-break: a kill can land inside BOTH the main zone
 * and an overlapping child at once (children spawn well within the main
 * zone's own radius — forkOffset is deliberately smaller than radius), and
 * the spec's "kills inside the main zone fork" rule has to win that overlap,
 * or a kill at a child's own centre would wrongly read as "inside the child
 * only" and silently swallow a fork it should have triggered.
 *
 * @returns {number} the zone index, or -1 if the point is outside every live zone
 */
export function zoneContaining(px, pz, zx, zz, life, radius) {
  for (let i = 0; i < life.length; i++) {
    if (life[i] <= 0) continue;
    if (Math.hypot(zx[i] - px, zz[i] - pz) <= radius) return i;
  }
  return -1;
}

/**
 * Where the `seq`-th child of this cast lands, relative to the kill it
 * forked from — small offset, magnitude always exactly `maxOffset` (brief:
 * "small random offset ≤0.8m").
 *
 * `rng`, when given (a `() => [0,1)` function — `ctx.rng`, mirroring
 * `App#runRng`), places it uniformly inside the disc (angle × √u for uniform
 * area, same "uniform-ish point" idiom `ParticleSystem#emit`'s own ball-point
 * code already uses in 3D). App never wires `ctx.rng` onto the ability
 * context today (grepped — only `App#runRng` exists, read solely by the echo
 * roll), so in practice this always takes the deterministic branch: a
 * golden-angle spiral off a running per-cast child index (`seq`, monotonic
 * across every fork event this cast ever has, not reset per event), so a
 * second or third fork event's children never land exactly on an earlier
 * one's spot the way a naive "always start at angle 0" scheme would.
 *
 * @param {(() => number)|null} rng
 * @param {number} seq         this cast's running child index (0, 1, 2, ...)
 * @param {number} maxOffset   metres
 */
export function forkPlacement(rng, seq, maxOffset) {
  if (rng) {
    const angle = rng() * Math.PI * 2;
    const r = maxOffset * Math.sqrt(rng());
    return { dx: Math.cos(angle) * r, dz: Math.sin(angle) * r };
  }
  const angle = seq * GOLDEN_ANGLE;
  return { dx: Math.cos(angle) * maxOffset, dz: Math.sin(angle) * maxOffset };
}

/**
 * VineBlazeSkill — 业火燎原 (木+火), the '1+3' fusion (spec §4.7). Self-
 * resolved (`combat.fusions['1+3'] = { kind: 'self' }`, fireball/dashstrike/
 * chainbolt precedent): CombatSystem never touches this cast at all.
 *
 * One instant main zone forms at the aimed point and burns for `life`
 * seconds (dps 45, radius 2.2). Any enemy that dies INSIDE it forks 2 child
 * zones at the corpse (dps 27, life = however much of the main zone's own
 * life was left at that moment) — children never fork again (no exponential
 * growth), and every zone this cast ever holds, main included, is capped at
 * `maxZones` (5) total. Because a child's life is always "whatever the main
 * zone had left," every zone this cast ever spawns — main or child, however
 * many fork events happen — reaches zero life at the exact same wall-clock
 * moment: the main zone's own original expiry. That is what lets a single
 * ability-level `impactDuration` (= the main zone's `life`) cover every
 * zone's whole burn without each needing its own independent phase timer.
 *
 * Zone state lives in flat parallel arrays sized to `config.maxZones`,
 * preallocated once at construction (pooled instances reused across many
 * casts, per AbilityManager's own contract) and only ever `.fill()`-reset
 * per cast — no per-cast or per-tick allocation. Slot 0 is always the main
 * zone; slots 1..N-1 are always children. A child's own light is acquired
 * from the shared pool directly (`ctx.lights.acquire()`, released the moment
 * its zone's life hits 0, or on `onDestroy` if the cast is evicted mid-burn);
 * the main zone instead rides the base `Ability` class's own single `light`
 * field for free (`this.position` is pinned to the main zone's landing point
 * the moment `advance()` resolves it, and never moves again) — spawning a
 * SEPARATE light for slot 0 on top of that inherited one would just double
 * the pool cost at the same spot for no visual gain.
 *
 * Each zone also gets a `GroundDecals.CRACK` patch (recoloured green→orange,
 * see `onFade`) and a light trickle of ember particles into one shared
 * channel. No bespoke geometry of its own — every visual is one of the
 * three existing pooled VFX services (decals/particles/lights), so
 * `createShaders()` is the inherited no-op.
 *
 * Kill hook: `ctx.killHook` (RunManager's `onKillAt` array, injected onto
 * the shared ability ctx — see RunManager's own doc) is an ordinary array of
 * `(x, z, elite)` functions. This class pushes its own bound handler in
 * `onSpawn` and swap-removes it in `onDestroy` — every cast (pooled
 * instances are reused, so each cast's own active window needs its own
 * subscription), never per fork. `ctx.killHook` absent (sandbox — fusions
 * are unreachable there anyway, Global Constraints) skips the subscribe
 * outright; `ctx.targets` absent skips damage the same way `?.` guards it
 * everywhere else in this file.
 */
export class VineBlazeSkill extends Ability {
  constructor(context, element) {
    super(element, context);

    const cap = this.config.maxZones;
    this.zx = new Float32Array(cap);
    this.zz = new Float32Array(cap);
    this.zdps = new Float32Array(cap);
    this.zaccum = new Float32Array(cap);
    this.zlife = new Float32Array(cap);
    this.zbirth = new Float32Array(cap);
    /** Decal handle per slot, or null — held only so `onFade` can drive the
     * birth pop-in/colour lerp on it; the decal's own life timer (matched to
     * the zone's initial life at spawn) is what actually retires it, never a
     * manual release here (see `_retireZone`). */
    this._decal = new Array(cap).fill(null);
    /** Light handle per slot — slot 0 stays null forever (see class doc:
     * the main zone rides the inherited `this.light` instead). */
    this._lightEntry = new Array(cap).fill(null);
    this._emberRate = Array.from({ length: cap }, () => new RateEmitter());

    this._wux = -1;
    this._wuxB = -1;
    this._amp = 1;
    /** Running count of every child this CAST has ever spawned, across
     * every fork event — `forkPlacement`'s own spiral index, reset per cast
     * in `onSpawn`. */
    this._forkSeq = 0;
    this._subscribed = false;
    /** Bound once — not per spawn — so re-subscribing on the next cast never
     * allocates a new closure (zero-alloc steady state, brief's own words). */
    this._onKillAt = this._onKillAt.bind(this);
  }

  /**
   * Base `Ability#config` assumes `settings[this.element]`, true for every
   * plain element but not a fusion: `this.element` is `'fusion:a+b'`, which
   * has no top-level settings entry — only its pair-key does
   * (`settings.fusions['1+3']`, see `fusions.js#pairKeyOf`). `Ability.js`
   * itself stays fusion-agnostic (outside this task's file list), so this
   * redirect lives here; every future fusion class needs its own copy of it
   * too, same as T1 left this to each bespoke class rather than the base one.
   */
  get config() {
    return settings.fusions[pairKeyOf(this.element)];
  }

  createParticles() {
    // One shared ember channel for every zone this cast (or any future cast
    // of this same pooled instance) ever spawns — recoloured fire-preset,
    // mirrors FireballAbility's own `sparks`/ZoneBurstSkill's own `puff`.
    this.embers = this.ctx.particles.get('vineblaze.embers', {
      capacity: 900,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.embers.uniforms.uDrag.value = 1.6;
    this.embers.uniforms.uEndSize.value = 0.24;
    this.embers.uniforms.uSizeIn.value = 0.05;
    this.embers.uniforms.uFadeOut.value = 0.4;
    const green = getColor(this.config.color);
    const orange = getColor(this.config.colorGlow);
    this.embers.setGradient(green, orange, orange, orange);
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** Gameplay-critical, not cosmetic like every sibling class's own copy of
   * this getter: this is how long the main zone (and by extension, every
   * zone this cast ever spawns — see class doc) actually burns. */
  get impactDuration() {
    return this.config.life;
  }

  /** Purely cosmetic tail — every zone has already retired (life ≤ 0, see
   * `onFade`) well before this starts. Implementer's choice, not spec-given. */
  get fadeDuration() {
    return 0.3;
  }

  /**
   * No travel: the main zone forms exactly at the aimed point
   * (`pointAt(1)`), the instant the cast resolves — not thrown like a
   * fireball, and not self-centred on the caster's own feet like
   * frostnova/quake's own override (ZoneBurstSkill). `settings.fusions['1+3']`
   * carries no `speed` field (this row is cast-side numbers + this class's
   * own mechanism numbers, never a travel speed), so falling through to the
   * base class's default `advance()` would read `config.speed` as
   * `undefined` and NaN-stall the front forever (`this.u` never reaches 1,
   * the cast never leaves TRAVEL, `onImpact` never fires) — this bypasses
   * that read entirely, same fix shape ZoneBurstSkill's `_selfCentered`
   * already established for its own two self-centred rows.
   *
   * Only ever called once per cast (the base class stops calling `advance()`
   * the instant `phase` leaves TRAVEL), so always returning true here is safe.
   */
  advance() {
    this.pointAt(1, this.position);
    this.u = 1;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const parents = fusionParents(this.element); // [母, 子]
    this._wux = settings.combat.wuxingOf[parents[1]] ?? -1; // 子 — mark/debuff identity
    this._wuxB = settings.combat.wuxingOf[parents[0]] ?? -1; // 母 — matchup-only candidate

    this.zlife.fill(0);
    this.zaccum.fill(0);
    this.zbirth.fill(0);
    this._decal.fill(null);
    this._forkSeq = 0;

    if (this.ctx.killHook && !this._subscribed) {
      this.ctx.killHook.push(this._onKillAt);
      this._subscribed = true;
    }
  }

  /**
   * The main zone — see class doc for why this is otherwise the whole of
   * `onImpact`: `advance()` already parked `this.position` at the landing
   * point.
   *
   * `_amp` is computed HERE, not in `onSpawn`, on purpose: `AbilityManager
   * .cast()` runs `spawn()` (and therefore `onSpawn`) synchronously, and
   * only AFTER it returns does `App#_quickCastToward`'s fusion branch stamp
   * `ability.autocast`/`.fusionMult`/`.quenched` onto the instance (same
   * "cast, then stamp" order the plain-element branch and every other
   * caller use) — reading them any earlier than `onImpact` (which only
   * fires on a later animation frame, always after that stamping has
   * completed) would see a pooled instance's STALE values from its
   * previous cast. `FireballAbility#onImpact` reads `this.autocast` at the
   * exact same point for the exact same reason — this mirrors it.
   */
  onImpact() {
    this._amp =
      (this.ctx.mods?.damageMult(this.element) ?? 1) *
      (this.autocast ? settings.run.autocastDamage : 1) *
      (this.quenched ? 1.5 : 1) *
      (this.fusionMult ?? 1);
    this._spawnZone(0, this.position.x, this.position.z, this.config.dps, this.config.life);
  }

  /**
   * Every live zone's per-frame tick: birth pop-in + colour lerp, ember
   * trickle, child-light drive, life countdown, and the burn-DoT payout —
   * runs through both the IMPACT and FADE phases (the base class calls this
   * hook in both, see `Ability#update`), which is fine: by the time FADE
   * starts, every zone has already retired (this ability's own
   * `impactDuration` is exactly the main zone's `life`), so the loop below
   * is a cheap no-op scan for the whole fade tail.
   */
  onFade(dt) {
    const c = this.config;
    const birthTime = Math.max(0.01, c.birthTime);

    for (let i = 0; i < this.zlife.length; i++) {
      if (this.zlife[i] <= 0) continue;

      this.zbirth[i] += dt;
      const decal = this._decal[i];
      if (decal) {
        const scaleT = Easing.outQuad(Math.min(1, this.zbirth[i] / birthTime));
        decal.mesh.scale.setScalar(c.radius * 2 * scaleT);
        // Green birth → orange burn: the cheaper of the plan's two offered
        // options (one decal, its own colorA uniform lerped over the
        // zone's life) over layering a second decal — colorB stays the
        // fixed ember accent the CRACK shader's own veins already use.
        const total = this.zbirth[i] + this.zlife[i]; // constant per zone == its initial life
        const ageT = total > 0 ? this.zbirth[i] / total : 0;
        decal.material.uniforms.uColorA.value.lerpColors(getColor(c.color), getColor(c.colorGlow), ageT);
      }

      this._emitEmbers(i, dt);

      if (i > 0 && this._lightEntry[i]) {
        _pos.set(this.zx[i], 0.4, this.zz[i]);
        // "低强度": a visible fraction below the main zone's own inherited-
        // light numbers, not a second full-strength light.
        this.ctx.lights.set(this._lightEntry[i], _pos, getColor(c.colorGlow), c.lightIntensity * 0.6, c.lightRadius * 0.6, dt);
      }

      this.zlife[i] -= dt;
      if (this.zlife[i] <= 0) {
        this._retireZone(i);
        continue;
      }

      const amount = zoneTick(this.zaccum, i, this.zdps[i], dt);
      if (amount > 0) this._payoutZone(i, amount);
    }
  }

  onDestroy() {
    if (this._subscribed && this.ctx.killHook) {
      const list = this.ctx.killHook;
      const i = list.indexOf(this._onKillAt);
      if (i !== -1) {
        list[i] = list[list.length - 1];
        list.pop();
      }
    }
    this._subscribed = false;

    // Defensive, not redundant: AbilityManager's MAX_CONCURRENT eviction
    // calls `destroy()` directly on whatever cast is oldest, regardless of
    // whether its zones had already burned out on their own — any child
    // light still held at that point must still come back to the pool.
    for (let i = 0; i < this._lightEntry.length; i++) {
      if (this._lightEntry[i]) {
        this.ctx.lights?.release(this._lightEntry[i]);
        this._lightEntry[i] = null;
      }
    }
    this.zlife.fill(0);
    this._decal.fill(null);
  }

  /* ------------------------------------------------------------------ */
  /* Zones                                                               */
  /* ------------------------------------------------------------------ */

  /** Fan-out target for `ctx.killHook` (RunManager's own listener list) —
   * bound once at construction (class doc), pushed/removed whole in
   * onSpawn/onDestroy. Reacts only to a kill inside THIS cast's own main
   * zone (`zoneContaining` scans slot 0 first — see that function's own doc
   * on why main wins any overlap with a child); a kill inside a child, or
   * outside every zone, is a no-op. */
  _onKillAt(x, z, _elite) {
    const c = this.config;
    const hit = zoneContaining(x, z, this.zx, this.zz, this.zlife, c.radius);
    if (hit !== 0) return;

    const budget = forkBudget(liveZoneCount(this.zlife), c.forkCount, c.maxZones);
    if (budget <= 0) return;

    let placed = 0;
    for (let slot = 1; slot < this.zlife.length && placed < budget; slot++) {
      if (this.zlife[slot] > 0) continue; // occupied — find the next empty slot
      const off = forkPlacement(this.ctx.rng ?? null, this._forkSeq++, c.forkOffset);
      // 寿命取剩余主区寿命: however much life the main zone (slot 0) has
      // left AT THIS MOMENT, not a fresh `c.life` — every zone this cast
      // ever spawns dies at the main zone's own original expiry (class doc).
      this._spawnZone(slot, x + off.dx, z + off.dz, c.forkDps, this.zlife[0]);
      placed++;
    }
  }

  _spawnZone(slot, x, z, baseDps, life) {
    const c = this.config;
    this.zx[slot] = x;
    this.zz[slot] = z;
    this.zdps[slot] = baseDps * this._amp;
    this.zlife[slot] = life;
    this.zaccum[slot] = 0;
    this.zbirth[slot] = 0;

    // `_forkPos`, not `_pos` — see that scratch's own doc (fix round 2):
    // this method is reachable from `_onKillAt`, which can run reentrantly
    // mid-`targets.damage()` sweep; `_pos` is what that sweep is still
    // reading by reference at that moment.
    _forkPos.set(x, 0.05, z);
    const decal =
      this.ctx.decals?.spawn(DecalType.CRACK, _forkPos, {
        radius: c.radius,
        life,
        colorA: getColor(c.color),
        colorB: getColor(c.colorGlow),
        width: 0.18,
        intensity: 1.0,
        growth: 0 // load-bearing: DecalSystem#update only ever touches
        // `mesh.scale` when growth !== 0, so leaving it 0 hands this
        // class exclusive, uncontested control of the scale for the
        // birth pop-in (onFade) with zero risk of the two fighting.
      }) ?? null;
    if (decal) decal.mesh.scale.setScalar(0); // pop-in starts from nothing
    this._decal[slot] = decal;

    if (slot > 0) this._lightEntry[slot] = this.ctx.lights?.acquire() ?? null;
    this._emberRate[slot].reset();
  }

  /** Life hit 0 — release whatever this slot was holding. The decal is NOT
   * released here: `DecalSystem` already retires it on its own once its own
   * `life` (set to match this zone's initial life at `_spawnZone`) elapses,
   * so touching the pool a second time here would double-free it. */
  _retireZone(slot) {
    this.zlife[slot] = 0;
    if (this._lightEntry[slot]) {
      this.ctx.lights.release(this._lightEntry[slot]);
      this._lightEntry[slot] = null;
    }
    this._decal[slot] = null;
  }

  /** One zone's banked DoT payout: matchup'd damage at its own position, and
   * the same nominal-amt×hits booking every other self-resolved class uses. */
  _payoutZone(slot, amount) {
    _pos.set(this.zx[slot], 1.0, this.zz[slot]);
    const hits = this.ctx.targets?.damage(_pos, this.config.radius, amount, this._wux, this._wuxB) ?? 0;
    this.ctx.stats?.book?.(this.element, amount * hits);
  }

  _emitEmbers(i, dt) {
    const g = settings.global;
    const count = this._emberRate[i].tick(dt, EMBER_RATE);
    if (count <= 0) return;
    _emit.position = _pos.set(this.zx[i], 0.15, this.zz[i]);
    _emit.radius = this.config.radius * 0.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 0.8;
    _emit.speedVariance = 0.6;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.6;
    _emit.life = 0.65;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.embers.emit(Math.round(count * g.particleCount), _emit);
  }
}
