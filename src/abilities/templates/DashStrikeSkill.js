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

/** Ribbon tessellation — a short 8m line needs nowhere near this many nodes;
 * picked so the trailing window (below) still reads smooth. */
const RIBBON_NODES = 10;

// Module-level scratch, matching FireballAbility/ThunderAbility's own idiom:
// every use computes into these and consumes the result before returning, so
// sharing them across pooled instances (JS is single-threaded — no instance
// is ever mid-computation while another runs) allocates nothing per cast.
// dashLineHits' own sample point — a real Vector3, not a plain {x,z}: the
// `targets` contract only *promises* a `damageOnce(castId, point, ...)`
// method, but TrainingDummies' own implementation (the sandbox population)
// calls `point.distanceTo(dummy.centre)` internally, which throws on a
// plain object. EnemySystem only ever reads `.x`/`.z` off `point`, so this
// satisfies both populations; `.y` is fixed once at body height for the
// dummies' 3D distance check (EnemySystem ignores it entirely).
const _p = new Vector3(0, 1, 0);
const _pos = new Vector3();
const _dir = new Vector3();
const _emit = {};
const _ribbonPoints = Array.from({ length: RIBBON_NODES + 1 }, () => new Vector3());

/**
 * Every enemy along the dash line takes `amount` damage exactly once each,
 * however many overlapping samples cross them.
 *
 * Mirrors CombatSystem's own 'sweep' kind math (see CombatSystem.js's
 * `case 'sweep'`) — samples spaced `radius` apart so consecutive circles
 * overlap enough to leave no gap, deduped per sample via `targets.damageOnce`
 * — but self-resolved (kind: 'self', D-M3-8 territory: dashstrike bypasses
 * CombatSystem's dispatch table entirely, same as fireball) and run once in
 * a single pass rather than incrementally across travel frames, since the
 * whole line is already known the instant the cast fires (unlike a sweep
 * ability's front, which really is still travelling when CombatSystem looks
 * at it).
 *
 * `targets` only needs a `damageOnce(castId, point, radius, amount, wuxing)`
 * method — the real `Targets` facade (population-agnostic: dummies in the
 * sandbox, the horde in a run), a bare `EnemySystem` (duck-typed, identical
 * method shape), or a test fake all work. `point` itself must be a real
 * Vector3 (see `_p`'s own comment) for that same cross-population reason.
 *
 * Pulled out of the class as a pure(ish) function — mirrors `chainHops` in
 * ChainBoltSkill.js — so the hit-test math is headlessly assertable without
 * constructing a THREE-backed Ability.
 *
 * @returns {number} enemies hit, summed across every sample point
 */
export function dashLineHits(targets, castId, originX, originZ, dirX, dirZ, length, radius, amount, wuxing = -1) {
  const stepU = Math.max(0.01, radius / Math.max(0.1, length));
  let hits = 0;
  for (let u = 0; ; u += stepU) {
    const t = Math.min(u, 1);
    _p.x = originX + dirX * length * t;
    _p.z = originZ + dirZ * length * t;
    hits += targets.damageOnce(castId, _p, radius, amount, wuxing);
    if (t >= 1) break;
  }
  return hits;
}

/**
 * Where a dashstrike's teleport lands: `range` metres along the aim
 * direction from `(originX, originZ)`, clamped to the same roam bounds
 * ordinary movement respects (`settings.character.roamRadius` — pinned to
 * `settings.run.arenaRadius` for the run's whole lifetime, see App's
 * constructor) so a dash off the arena's edge can't step the character past
 * the rim into the unlit void beyond the 法阵.
 *
 * Plain numbers in, plain object out — headlessly testable, and App's
 * cast-time hook (`_dashDisplace`) calls it without needing a THREE Vector3.
 */
export function dashTarget(originX, originZ, dirX, dirZ, range, roamRadius) {
  const x = originX + dirX * range;
  const z = originZ + dirZ * range;
  const dist = Math.hypot(x, z);
  const scale = dist > roamRadius ? roamRadius / dist : 1;
  return { x: x * scale, z: z * scale };
}

/**
 * DashStrikeSkill — dashstrike (弑神一闪), the one `self`-kind (D-M3-8)
 * line special that also displaces the caster. Per the brief: this class is
 * pure VFX+damage, exactly like every other ability — the *player's own*
 * teleport rides App's dodge-roll lerp channel (`_dodgeStart`/`_dodgeTarget`
 * over `frame()`'s steer-gate), wired at cast time in `App#_dashDisplace`,
 * never touched from here. That split is what keeps this class poolable and
 * ignorant of run-vs-sandbox: the sandbox has no playerState/character-lerp
 * concept to move, so it simply never calls that hook, and this class's own
 * damage/VFX behave identically either way (dummies in the sandbox, the
 * horde in a run — same as fireball).
 *
 * VFX is two beats: an afterimage ribbon that trails the flash's own front
 * as it crosses the line (a `trailLength`-metre window, not the whole path —
 * a speed streak, not a growing bar), and a slash flash where it lands.
 * Damage resolves once, at impact (the base class's own travel timing —
 * `range/speed` — already lands that at ~0.2s, inside the brief's own
 * 0.15-0.25s dash-duration ballpark, so the VFX and the physical teleport
 * that App drives on the identical window arrive together).
 */
export class DashStrikeSkill extends Ability {
  constructor(context, element) {
    super(element, context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.ribbon = new RibbonGeometry(RIBBON_NODES);
    // Flat additive strip, not a bespoke shader (T4 template idiom — the
    // flagship hand-written abilities earn a custom shader each, the newer
    // data-driven skills don't need to): a fading glow is enough to sell a
    // fast, thin afterimage.
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
  }

  createParticles() {
    // A small spit of sparks off the slash — the burst+ribbon carry most of
    // the read, this just adds grit at the exit point.
    this.sparks = this.ctx.particles.get('dashstrike.sparks', {
      capacity: 600,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.2;
    this.sparks.uniforms.uEndSize.value = 0.18;
    this.sparks.uniforms.uSizeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.4;
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get impactDuration() {
    return 0.12; // just long enough to sell the slash-flash burst
  }

  get fadeDuration() {
    return 0.3; // the afterimage ribbon dissolving
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.ribbon.clear();
  }

  /** Rebuild the ribbon from the live front, trailing `trailLength` metres
   * behind it — a comet-tail window, not the whole path (see class doc). */
  _syncRibbon() {
    const c = this.config;
    const length = this.length;
    const head = Math.min(length, this.front);
    const tail = Math.max(0, head - c.trailLength);
    const span = Math.max(0.01, head - tail);
    const count = Math.min(RIBBON_NODES + 1, Math.max(2, Math.ceil(span / 0.35) + 1));

    for (let i = 0; i < count; i++) {
      const t = (tail + (i / (count - 1)) * span) / length;
      this.pointAt(t, _ribbonPoints[i]).y = 0.95;
    }
    this.ribbon.build(_ribbonPoints, {
      width: c.width * 0.7,
      mode: RibbonMode.BILLBOARD,
      cameraPosition: this.ctx.camera.position,
      count
    });
    this.ribbonMaterial.color.copy(getColor(c.colorGlow));
  }

  onTravel() {
    this._syncRibbon();
  }

  onImpact() {
    const c = this.config;
    const g = settings.global;

    // Damage: the whole line, exactly once per enemy, self-resolved (see
    // dashLineHits' own doc). Mods/autocast-tax/quenched/fusionMult applied
    // by hand — same four factors CombatSystem's own `_amp()` folds in for
    // every other kind, just inlined here since kind:'self' skips it (mirrors
    // fireball's ctx.mods?./autocast handling, extended to also honour
    // quenched/fusionMult like the invariant asks — fireball itself predates
    // both and was never updated to read them; not touched by this task).
    const amt =
      c.damage *
      (this.ctx.mods?.damageMult(this.element) ?? 1) *
      (this.autocast ? settings.run.autocastDamage : 1) *
      (this.quenched ? 1.5 : 1) *
      (this.fusionMult ?? 1);
    const wux = settings.combat.wuxingOf[this.element] ?? -1;
    const hits = dashLineHits(
      this.ctx.targets,
      this,
      this.origin.x,
      this.origin.z,
      this.direction.x,
      this.direction.z,
      this.length,
      c.width,
      amt,
      wux
    );
    this.ctx.stats?.book?.(this.element, amt * hits);

    /* the slash flash at the exit point */
    this.pointAt(1, _pos).setY(1.0);
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.flashSize * 0.3,
      endRadius: c.flashSize * g.explosionIntensity,
      life: 0.28,
      intensity: 1.4,
      opacity: 1,
      fresnel: 1.3,
      displace: 0.4,
      colorA: getColor(c.color),
      colorB: getColor(c.colorGlow),
      colorC: getColor(c.colorGlow)
    });

    _emit.position = _pos;
    _emit.radius = 0.3;
    _emit.direction = _dir.copy(this.direction).negate().setY(0.3).normalize();
    _emit.speed = 6;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.6;
    _emit.life = 0.35;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.setGradient(getColor(c.colorGlow), getColor(c.color), getColor(c.color), getColor(c.color));
    this.sparks.emit(Math.round(30 * g.particleCount), _emit);

    this.ctx.shake.add(0.35 * g.cameraShake, 1 / 0.12, 22);
    this.ctx.flash.trigger(getColor(c.colorGlow), 0.22 * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.8 * g.explosionIntensity;

    this._syncRibbon();
  }

  onFade(dt, t) {
    this._syncRibbon();
    // t: 0..1 through impact (held bright), 1..2 through fade (dissolve).
    this.ribbonMaterial.opacity = t <= 1 ? 0.9 : 0.9 * (1 - Easing.inCubic(saturate(t - 1)));
  }

  onDestroy() {
    this.ribbon.clear();
    // See dashLineHits' own doc: `this` is the damageOnce castId, keyed by
    // object identity so it can never collide with CombatSystem's own
    // numeric ids. EnemySystem is the only population that actually opened a
    // hit-memory Set for it (dummies degrade dedup-free, see Targets.js's own
    // contract) — releasing through the raw ctx.enemies reference (already
    // wired for ChainBoltSkill's targeting) avoids adding a passthrough to
    // the population-agnostic Targets facade for what only this one
    // self-resolved special needs. Sandbox-safe: ctx.enemies is undefined
    // there, so this is a no-op exactly where nothing was ever opened.
    this.ctx.enemies?.releaseCast(this);
  }

  dispose() {
    this.ribbon.dispose();
    this.ribbonMaterial.dispose();
    super.dispose();
  }
}
