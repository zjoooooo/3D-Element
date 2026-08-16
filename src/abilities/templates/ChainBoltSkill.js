import { Vector3, Mesh, MeshBasicMaterial, AdditiveBlending, DoubleSide } from 'three';
import { Ability } from '../Ability.js';
import { RibbonGeometry, RibbonMode } from '../../effects/RibbonGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, Easing } from '../../utils/math.js';

/** Hard ceiling on additional hops — the editor's `hops` slider (T8) would
 * clamp here; also sizes the chain's point/ribbon buffers (+2 for the
 * caster's origin and the first target). Comfortably above the launch value
 * (4) and the Lv5 breakpoint's +2 (T12, a later milestone). */
const MAX_HOPS = 8;
const MAX_CHAIN_POINTS = MAX_HOPS + 2;

/** Half-width of the "aiming generally at this pack" corridor around the aim
 * ray, metres — the first-target search's primary rule (see
 * `_findFirstTarget`'s own doc). Implementer's choice: not spec/controller-
 * numbered, picked to feel like "aim roughly at the crowd," not "aim exactly
 * at one body." */
const AIM_CORRIDOR = 2.5;

/** Small point-hit radius for each resolved hop's `ctx.targets.damage` call
 * (brief: "single-point small radius") — each hop already targets one known
 * enemy exactly, so this only needs to reliably catch that one body, not
 * sweep an area. Implementer's choice. */
const HIT_RADIUS = 0.6;

const _up = new Vector3(0, 1, 0);
const _pos = new Vector3();
const _dir = new Vector3();
const _emit = {};

/**
 * Extend a chain `hops` additional jumps from `from`, each to the nearest
 * not-yet-hit enemy within `radius` of the current node.
 *
 * Pure(ish): reads only `enemies.x`/`.z`/`.count` (index-parallel, like every
 * other EnemySystem consumer), touches nothing else, and its only side
 * effect is on the `seen` collaborator explicitly passed in — mirrors
 * `pointAt(s, out)`'s "mutate the caller's own scratch" shape used
 * throughout this codebase rather than being a hidden global. `seen`
 * defaults to a fresh Set so this is directly callable standalone
 * (headless-testable against a real EnemySystem, no fake needed); the live
 * class instead passes its own pooled, per-cast-cleared Set so the hot path
 * allocates nothing (see ChainBoltSkill's own `_hitSet`).
 *
 * Index-based, not id-based: the whole walk is one synchronous pass with no
 * damage applied inside it (the caller resolves damage separately, after
 * this returns — see ChainBoltSkill.onImpact), so no enemy can die/swap-
 * remove mid-walk and invalidate an index this function already used.
 *
 * @param {{x:Float32Array, z:Float32Array, count:number}} enemies
 * @param {number} from      index of the already-hit node to extend from
 * @param {number} hops      additional jumps to attempt (≤ MAX_HOPS enforced by the caller)
 * @param {number} radius    metres — a candidate at exactly `radius` is excluded (matches
 *                           EnemySystem.damage's own `>=` boundary convention)
 * @param {Set<number>} [seen] indices already spent — mutated in place, pre-seeded with `from`
 * @returns {number[]} the hop indices, in order — shorter than `hops` if the chain runs out of candidates
 */
export function chainHops(enemies, from, hops, radius, seen = new Set()) {
  seen.add(from);
  const result = [];
  let current = from;

  for (let h = 0; h < hops; h++) {
    const cx = enemies.x[current];
    const cz = enemies.z[current];
    let best = -1;
    let bestDist = Infinity;

    for (let i = 0; i < enemies.count; i++) {
      if (seen.has(i)) continue;
      const dist = Math.hypot(enemies.x[i] - cx, enemies.z[i] - cz);
      if (dist >= radius) continue; // chain stops early once nothing left is in range
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }

    if (best === -1) break;
    seen.add(best);
    result.push(best);
    current = best;
  }

  return result;
}

/**
 * Re-validate a remembered target (index + its own stable `id`) against the
 * live population — the WYSIWYG fix (M6 T6 fix round): `onSpawn` remembers
 * one target for the travel-phase visual to commit to, and `onImpact` must
 * land its damage on that *same* enemy, not whichever `_findFirstTarget()`
 * happens to turn up fresh.
 *
 * The index alone can't be trusted across that gap: `EnemySystem._kill`
 * swap-removes on death, copying the population's last live slot into the
 * gap — a *different*, still-living enemy can end up sitting at the
 * remembered index by the time `onImpact` looks. The id is what actually
 * identifies the body; this follows it by re-scanning only when the index
 * no longer matches.
 *
 * @param {{x:Float32Array, z:Float32Array, id:Float64Array, count:number}} enemies
 * @param {number} index  the index the target was found at, originally
 * @param {number} id     `enemies.id[index]` at that same moment
 * @param {number} range  metres — the target must still be this close to (ox,oz)
 * @param {number} ox
 * @param {number} oz
 * @returns {number} the target's CURRENT index if it's still alive and in
 *   range; -1 if it's gone (dead, or walked out of range) — the caller
 *   should fall back to a fresh search.
 */
export function resolveTarget(enemies, index, id, range, ox, oz) {
  let i = index;
  if (i < 0 || i >= enemies.count || enemies.id[i] !== id) {
    i = -1;
    for (let k = 0; k < enemies.count; k++) {
      if (enemies.id[k] === id) {
        i = k;
        break;
      }
    }
  }
  if (i === -1) return -1;
  if (Math.hypot(enemies.x[i] - ox, enemies.z[i] - oz) >= range) return -1;
  return i;
}

/**
 * ChainBoltSkill — chainbolt (连锁闪电), the other `self`-kind (D-M3-8) line
 * special. Pure VFX+damage, same as every other ability: no character
 * movement involved (unlike its DashStrikeSkill sibling), so App has no
 * cast-time hook for this one at all.
 *
 * First target: nearest enemy to the aim ray within a modest corridor, or
 * failing that the nearest enemy anywhere in range (`_findFirstTarget`).
 * `onSpawn` runs that search once and *remembers* the answer (index + the
 * enemy's own stable `id`, not the index alone — `onImpact` re-validates
 * through `resolveTarget`, which follows the id through an EnemySystem
 * swap-remove relocation rather than trusting a stale index) — spec §3
 * 所见即所判 (WYSIWYG) is load-bearing here: the travel-phase bolt visually
 * commits to flying at *that* target, so onImpact using a second, independent
 * search that could land on a *different* enemy would make the bolt visibly
 * streak toward A while the damage lands on B. `resolveTarget` only falls
 * back to a fresh `_findFirstTarget()` call when the remembered target is
 * actually gone (dead, or walked out of range) — not on every impact.
 *
 * Damage lands all at once in `onImpact` (first hit + every hop, decaying
 * `hopDecay` per hop) via `ctx.targets.damage` — plain damage, not
 * damageOnce: each hop already names one specific enemy, so there is no
 * overlapping-sample dedup problem the way DashStrikeSkill's line sweep has,
 * and this class never opens a per-cast hit-memory Set on `ctx.enemies` at
 * all (nothing to release in `onDestroy`). The VFX (ribbon + arc glyphs)
 * then *reveals* that already-resolved chain over ~0.3s — damage timing ≠
 * VFX timing, same as fireball's own burst-then-still-fading-visual shape.
 *
 * Sandbox: `ctx.enemies` (wired by App only in run mode, same pattern as
 * `ctx.mods`/`ctx.stats`/`ctx.playerState`) is undefined there, so
 * `_findFirstTarget` returns -1 unconditionally and every cast fizzles —
 * the bolt still flies its full nominal range and sputters, exactly per the
 * brief's contract, with zero null-deref risk (`this.ctx.enemies?.`).
 */
export class ChainBoltSkill extends Ability {
  constructor(context, element) {
    super(element, context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.ribbon = new RibbonGeometry(MAX_HOPS + 1);
    this.ribbonMaterial = new MeshBasicMaterial({
      transparent: true,
      opacity: 0.9,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide
    });
    this.ribbonMesh = new Mesh(this.ribbon.geometry, this.ribbonMaterial);
    this.ribbonMesh.frustumCulled = false;
    this.ribbonMesh.layers.set(LAYER.VFX);
    this.ribbonMesh.renderOrder = 6;
    this.group.add(this.ribbonMesh);

    /** The resolved chain, world points (origin, first target, each hop) —
     * preallocated Vector3s, only `_chainCount` of them are live this cast.
     * Fed straight to `ribbon.build(points, {count})`, which only reads the
     * first `count` entries — no slicing/reallocating to reveal it
     * progressively in onFade. */
    this._chainPoints = Array.from({ length: MAX_CHAIN_POINTS }, () => new Vector3());
    this._chainCount = 0;
    /** Per-point "has its arrival glyph already fired" flag — mirrors the
     * dice-record `landed`/`shattered` idiom ZoneBurstSkill/LineSweepSkill
     * already use for a one-shot-per-milestone reveal. */
    this._landed = new Array(MAX_CHAIN_POINTS).fill(false);
    /** Reused every cast (cleared in onSpawn) — chainHops' own dedup
     * collaborator, zero-alloc steady state (this is the "your own hit-set"
     * the brief asks for). */
    this._hitSet = new Set();
    /** The player's actual aim, captured once in onSpawn before
     * `this.direction` may get redirected toward the found target for the
     * travel visual — `_findFirstTarget` always searches along this, never
     * `this.direction` (see that method's own doc). */
    this._aimDir = new Vector3();
    /** The target `onSpawn` found and committed the travel visual to — index
     * + the enemy's own stable id, re-validated by `resolveTarget` at
     * `onImpact` rather than re-searched independently (see class doc,
     * WYSIWYG fix). -1 when nothing was found (fizzle, or sandbox). */
    this._targetIndex = -1;
    this._targetId = -1;
    this._hit = false;
  }

  createParticles() {
    // A small spark puff at each hop landing — the burst+ribbon carry most
    // of the read.
    this.sparks = this.ctx.particles.get('chainbolt.sparks', {
      capacity: 800,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: false,
      softFade: 0.3
    });
    this.sparks.uniforms.uDrag.value = 1.4;
    this.sparks.uniforms.uEndSize.value = 0.16;
    this.sparks.uniforms.uSizeIn.value = 0.04;
    this.sparks.uniforms.uFadeOut.value = 0.35;
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get impactDuration() {
    return 0.3; // the chain reveal window (brief: "~0.3s")
  }

  get fadeDuration() {
    return 0.2; // final dissolve once every hop has landed
  }

  /* ------------------------------------------------------------------ */
  /* Targeting                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Nearest enemy to the aim ray within a modest corridor; failing that, the
   * nearest enemy anywhere in range (brief: "pick the simplest correct").
   * Always searches along `this._aimDir` (the player's original aim,
   * captured once in onSpawn), never `this.direction` — which onSpawn may
   * have already redirected toward a previously-found target — so a second,
   * later call (onImpact's fresh re-resolution) can't feed on its own prior
   * answer.
   *
   * -1 when `ctx.enemies` is absent (sandbox) or the field is empty.
   */
  _findFirstTarget() {
    const enemies = this.ctx.enemies;
    if (!enemies || enemies.count === 0) return -1;

    const range = this.config.range;
    const ox = this.origin.x;
    const oz = this.origin.z;
    const dx = this._aimDir.x;
    const dz = this._aimDir.z;

    let corridorBest = -1;
    let corridorAlong = Infinity;
    let nearestBest = -1;
    let nearestDist = Infinity;

    for (let i = 0; i < enemies.count; i++) {
      const ex = enemies.x[i] - ox;
      const ez = enemies.z[i] - oz;
      const dist = Math.hypot(ex, ez);
      if (dist >= range) continue;
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestBest = i;
      }
      const along = ex * dx + ez * dz;
      if (along <= 0) continue; // behind the caster — the ray corridor doesn't reach backward
      const perp = Math.abs(ex * dz - ez * dx); // |cross|, unit direction ⇒ exact perpendicular distance
      if (perp <= AIM_CORRIDOR && along < corridorAlong) {
        corridorAlong = along;
        corridorBest = i;
      }
    }

    return corridorBest !== -1 ? corridorBest : nearestBest;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.ribbon.clear();
    this._chainCount = 0;
    this._hit = false;
    for (let i = 0; i < this._landed.length; i++) this._landed[i] = false;
    this._aimDir.copy(this.direction);

    // Commit to one target: the travel-phase bolt visually aims here instead
    // of flying past it to the fixed nominal range, and onImpact's damage
    // must land on this *same* enemy (WYSIWYG, see class doc) — remembered
    // by id, not just index, so a swap-remove elsewhere in the population
    // during travel can't quietly point the index at someone else.
    this._targetIndex = this._findFirstTarget();
    if (this._targetIndex !== -1) {
      const enemies = this.ctx.enemies;
      this._targetId = enemies.id[this._targetIndex];
      const dx = enemies.x[this._targetIndex] - this.origin.x;
      const dz = enemies.z[this._targetIndex] - this.origin.z;
      const dist = Math.max(0.5, Math.hypot(dx, dz));
      this.direction.set(dx / dist, 0, dz / dist);
      this.side.crossVectors(this.direction, _up).normalize();
      this.length = dist;
    } else {
      this._targetId = -1;
    }
  }

  onTravel() {
    // A simple travelling bolt — reuses the first two (of MAX_CHAIN_POINTS)
    // preallocated point slots rather than a fresh array; onImpact
    // overwrites them for real once the chain is actually resolved.
    this.pointAt(0, this._chainPoints[0]).y = 1.0;
    this.pointAt(this.u, this._chainPoints[1]).y = 1.0;
    this.ribbon.build(this._chainPoints, {
      width: this.config.boltWidth,
      mode: RibbonMode.BILLBOARD,
      cameraPosition: this.ctx.camera.position,
      count: 2
    });
    this.ribbonMaterial.color.copy(getColor(this.config.colorGlow));
    this.ribbonMaterial.opacity = 0.9;
  }

  onImpact() {
    const c = this.config;
    const g = settings.global;

    this._chainPoints[0].copy(this.origin).setY(1.0);
    this._chainCount = 1;

    // Land on the SAME enemy the travel-phase bolt visually committed to in
    // onSpawn (WYSIWYG, see class doc) — resolveTarget follows it through a
    // possible swap-remove relocation; a fresh _findFirstTarget() only runs
    // when that target is actually gone (never found one at spawn, died, or
    // walked out of range since).
    const enemies = this.ctx.enemies;
    let first = -1;
    if (this._targetIndex !== -1 && enemies) {
      first = resolveTarget(enemies, this._targetIndex, this._targetId, c.range, this.origin.x, this.origin.z);
    }
    if (first === -1) first = this._findFirstTarget();

    if (first === -1) {
      this._hit = false;
      this.ribbon.clear();
      this._sputterFx();
      return;
    }
    this._hit = true;

    const wux = settings.combat.wuxingOf[this.element] ?? -1;
    // Same four factors CombatSystem's own `_amp()` folds in for every other
    // kind, inlined here since kind:'self' skips it — mirrors
    // DashStrikeSkill's identical formula (see its own comment on why this
    // goes beyond fireball's literal, pre-quench/fusion code).
    const baseAmt =
      c.damage *
      (this.ctx.mods?.damageMult(this.element) ?? 1) *
      (this.autocast ? settings.run.autocastDamage : 1) *
      (this.quenched ? 1.5 : 1) *
      (this.fusionMult ?? 1);

    this._hitSet.clear();
    this._hitSet.add(first);
    this._chainPoints[1].set(enemies.x[first], 1.0, enemies.z[first]);
    this._chainCount = 2;
    this._applyHit(first, baseAmt, wux);

    const hopBudget = Math.min(MAX_HOPS, Math.max(0, Math.round(c.hops)));
    const hopIdx = chainHops(enemies, first, hopBudget, c.hopRadius, this._hitSet);
    let amt = baseAmt;
    for (let i = 0; i < hopIdx.length; i++) {
      amt *= c.hopDecay;
      const idx = hopIdx[i];
      this._chainPoints[this._chainCount].set(enemies.x[idx], 1.0, enemies.z[idx]);
      this._chainCount++;
      this._applyHit(idx, amt, wux);
    }

    this.ctx.shake.add(0.22 * g.cameraShake, 1 / 0.1, 20);
    this.ctx.flash.trigger(getColor(c.colorGlow), 0.14 * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.4 * g.explosionIntensity;
  }

  /** One resolved hit — landed enemy's own live position (not a stale
   * capture), small point radius (brief: "single-point small radius"). */
  _applyHit(idx, amt, wux) {
    const enemies = this.ctx.enemies;
    _pos.set(enemies.x[idx], 1.0, enemies.z[idx]);
    const hits = this.ctx.targets.damage(_pos, HIT_RADIUS, amt, wux);
    this.ctx.stats?.book?.(this.element, amt * hits);
  }

  onFade(dt, t) {
    if (!this._hit) return; // fizzle already played its one-shot sputter; nothing to reveal

    const c = this.config;
    // t: 0..1 across the whole reveal window (impactDuration), held at 1
    // through the fade phase that follows.
    const revealT = Math.min(1, t);
    const revealCount = Math.max(1, Math.min(this._chainCount, 1 + Math.round(revealT * (this._chainCount - 1))));

    for (let i = 1; i < revealCount; i++) {
      if (!this._landed[i]) {
        this._landed[i] = true;
        this._hopFx(this._chainPoints[i]);
      }
    }

    this.ribbon.build(this._chainPoints, {
      width: c.boltWidth,
      mode: RibbonMode.BILLBOARD,
      cameraPosition: this.ctx.camera.position,
      count: revealCount
    });
    this.ribbonMaterial.color.copy(getColor(c.colorGlow));
    this.ribbonMaterial.opacity = t <= 1 ? 0.9 : 0.9 * (1 - Easing.inCubic(saturate(t - 1)));
  }

  onDestroy() {
    this.ribbon.clear();
    this._chainCount = 0;
    this._hit = false;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The inter-hop arc glyph, sized by `arcSize` (brief). */
  _hopFx(point) {
    const c = this.config;
    const g = settings.global;

    this.ctx.bursts.spawn(BurstMode.STORM, point, {
      radius: c.arcSize * 0.4,
      endRadius: c.arcSize * g.explosionIntensity,
      life: 0.18,
      intensity: 1.1,
      opacity: 0.9,
      fresnel: 1.2,
      displace: 0.35,
      colorA: getColor(c.color),
      colorB: getColor(c.colorGlow),
      colorC: getColor(c.colorGlow)
    });

    _emit.position = point;
    _emit.radius = 0.2;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 2;
    _emit.speedVariance = 0.7;
    _emit.spread = 1;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.14;
    _emit.sizeVariance = 0.6;
    _emit.life = 0.3;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.setGradient(getColor(c.colorGlow), getColor(c.color), getColor(c.color), getColor(c.color));
    this.sparks.emit(Math.round(10 * g.particleCount), _emit);
  }

  /** No target found anywhere in range — a short sputter at the cast point,
   * cooldown/mana still spent (App's own cast pipeline, untouched by this
   * class either way — see class doc). */
  _sputterFx() {
    const c = this.config;
    const g = settings.global;
    this.pointAt(0, _pos).y = 1.0;

    this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
      radius: 0.15,
      endRadius: 0.5 * g.explosionIntensity,
      life: 0.22,
      intensity: 0.6,
      opacity: 0.75,
      fresnel: 1.0,
      displace: 0.3,
      colorA: getColor(c.color),
      colorB: getColor(c.colorGlow),
      colorC: getColor(c.colorGlow)
    });
  }

  dispose() {
    this.ribbon.dispose();
    this.ribbonMaterial.dispose();
    super.dispose();
  }
}
