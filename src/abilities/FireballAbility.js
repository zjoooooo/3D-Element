import { Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { lerp, saturate, Easing } from '../utils/math.js';
import { bpScale } from '../run/breakpoints.js';

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _step = new Vector3();
const _impact = new Vector3();

/**
 * Points along the segment covered this frame that the trail is split between.
 *
 * At 26 m/s the ball crosses nearly half a metre between frames, and firing
 * every particle from the head leaves the wake visibly beaded.
 */
const TRAIL_BATCHES = 3;

/**
 * The small one: a ball of fire thrown flat and fast, popping where it lands.
 *
 * There is no mesh and no shader here — that is the point of it. The head is
 * simply a lot of additive particles emitted very close together and given a
 * very short life, so they pile up into a ball that travels; the wake is the
 * same emission at a lower rate and a longer life, falling behind because it
 * inherits only part of the ball's velocity. Everything at the far end — the
 * fire burst, the shockwave ring, the scorch, the shake, the flash — is a
 * shared system that the other five abilities already drive.
 *
 * That makes this the cheapest ability in the project and the one to copy when
 * adding another: the whole file is emission parameters and one flight path.
 *
 * The base class walks the front along the floor. `_headPoint` lifts that onto
 * the actual trajectory — out of the hand, flat across, dipping into the ground
 * over the last stretch — and everything that reads `position` (the light, the
 * camera framing, the trail) follows it there.
 */
export class FireballAbility extends Ability {
  constructor(context) {
    super('fireball', context);

    this._core = new RateEmitter(150);
    this._sparkRate = new RateEmitter(55);
    this._smokeRate = new RateEmitter(26);
    /** Where the head was last frame; the trail fills the gap between. */
    this._previous = new Vector3();
    /** The ball's own velocity, for the wake to inherit a fraction of. */
    this._velocity = new Vector3();
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The ball itself. Curl noise on a 0.26s life is what keeps it boiling
    // rather than reading as a smooth sphere of sprites.
    this.core = particles.get('fireball.core', {
      capacity: 3000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.core.uniforms.uDrag.value = 2.6;
    this.core.uniforms.uEndSize.value = 0.35;
    this.core.uniforms.uSizeIn.value = 0.12;
    this.core.uniforms.uFadeIn.value = 0.08;
    this.core.uniforms.uFadeOut.value = 0.45;

    // Sparks shed off it, stretched along their own velocity.
    this.sparks = particles.get('fireball.sparks', {
      capacity: 2000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 0.8;
    this.sparks.uniforms.uEndSize.value = 0.2;
    this.sparks.uniforms.uSizeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.5;

    // The wake. Non-additive, so it darkens what is behind it instead of
    // brightening it — a fireball with no smoke reads as a firework.
    this.smoke = particles.get('fireball.smoke', {
      capacity: 1500,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.7
    });
    this.smoke.uniforms.uDrag.value = 1.6;
    this.smoke.uniforms.uEndSize.value = 2.8;
    this.smoke.uniforms.uSizeIn.value = 0.16;
    this.smoke.uniforms.uFadeIn.value = 0.2;
    this.smoke.uniforms.uFadeOut.value = 0.35;
  }

  /**
   * Push the editor's live values into the three systems.
   *
   * Sizes and lifetimes are passed to `emit` in metres and seconds, so the two
   * scale uniforms carry nothing but the global multipliers — which keeps every
   * number in the settings block readable as the thing it actually is.
   */
  _syncParticles() {
    const c = this.config;
    const g = settings.global;

    const hot = getColor(c.colorEmberA);
    const mid = getColor(c.colorEmberB);
    const edge = getColor(c.colorEmberC);
    const ash = getColor(c.colorEmberD);

    this.core.setGradient(hot, mid, edge, ash);
    this.core.uniforms.uGravity.value.set(0, c.coreRise, 0);
    this.core.uniforms.uSizeScale.value = g.particleSize;
    this.core.uniforms.uLifeScale.value = g.particleLifetime;
    this.core.uniforms.uSpeedScale.value = g.particleSpeed;
    this.core.uniforms.uOpacity.value = g.opacity;
    this.core.uniforms.uGlow.value = c.coreGlow * g.glow;
    this.core.uniforms.uTurbulence.value = c.coreTurbulence * g.turbulence;

    this.sparks.setGradient(hot, mid, edge, ash);
    this.sparks.uniforms.uGravity.value.set(0, c.sparkGravity, 0);
    this.sparks.uniforms.uSizeScale.value = g.particleSize;
    this.sparks.uniforms.uLifeScale.value = g.particleLifetime;
    this.sparks.uniforms.uSpeedScale.value = g.particleSpeed;
    this.sparks.uniforms.uOpacity.value = g.opacity;
    this.sparks.uniforms.uGlow.value = c.coreGlow * 0.8 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;

    this.smoke.setGradient(
      getColor(c.colorSmokeA),
      getColor(c.colorSmokeB),
      getColor(c.colorSmokeC),
      getColor(c.colorSmokeD)
    );
    this.smoke.uniforms.uGravity.value.set(0, c.smokeRise, 0);
    this.smoke.uniforms.uSizeScale.value = g.particleSize;
    this.smoke.uniforms.uLifeScale.value = g.particleLifetime;
    this.smoke.uniforms.uSpeedScale.value = g.particleSpeed;
    this.smoke.uniforms.uOpacity.value = c.smokeOpacity * g.opacity;
    this.smoke.uniforms.uTurbulence.value = 0.5 * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* Flight path                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * The ball's position at `s` along the cast, 0 at the hand and 1 at the target.
   *
   * Flat for most of the throw and dropping only over the last stretch: a bolt
   * that arcs like a lob stops reading as something thrown hard, and a bolt that
   * stays at chest height sails over the mark it is supposed to hit.
   */
  _headPoint(s, out) {
    const c = this.config;
    this.pointAt(s, out);
    // The hand is off the centre line, and the offset is gone by the far end.
    out.addScaledVector(this.direction, c.handForward * (1 - s));
    out.addScaledVector(this.side, c.handSide * (1 - s));
    const drop = saturate((s - c.dip) / Math.max(0.05, 1 - c.dip));
    out.y = lerp(c.handHeight, c.endHeight, Easing.inQuad(drop));
    return out;
  }

  /** Fire is unsteady: gutter it rather than the base class's slow glint. */
  lightShimmer() {
    return 0.82 + 0.18 * Math.sin(this.age * 31.7) * Math.sin(this.age * 12.3);
  }

  get impactDuration() {
    return 0.55;
  }

  get fadeDuration() {
    return 0.9;
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this._core.reset();
    this._sparkRate.reset();
    this._smokeRate.reset();
    this._syncParticles();

    this._headPoint(0, this.position);
    this._previous.copy(this.position);
    this._velocity.copy(this.direction).multiplyScalar(this.config.speed);

    this._muzzleFx();
  }

  onTravel(dt) {
    const c = this.config;
    this._syncParticles();

    // `advance` left `position` on the floor line; put it on the trajectory.
    this._headPoint(this.u, this.position);
    if (dt > 0) this._velocity.subVectors(this.position, this._previous).divideScalar(dt);

    this._trailFx(dt);

    // The fuse walks _previous → position, so the strike check has to run
    // before this frame's position is folded into _previous.
    if (c.hitStop && this._struckSomething()) return;
    this._previous.copy(this.position);

    // A small ball of fire lights the ground it passes over more than it lights
    // itself; the light already rides `position`, so this only keeps it warm.
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.12);
  }

  /**
   * Detonate here if the ball has flown into a target.
   *
   * The aimed point is where the bolt is *going*, not where it stops — flying
   * through a dummy and bursting on the floor behind it is the one thing that
   * would give the whole hit test away. Shortening `length` to the distance
   * already covered makes `pointAt(1)` the ball's own position, which is what
   * `onImpact` works from, so the burst lands on the target rather than at the
   * cursor. The phase is stepped here rather than waiting for the base class's
   * own end-of-line check, so the frame you touch it is the frame it goes off.
   *
   * @returns {boolean} true if this frame ended the flight
   */
  _struckSomething() {
    if (this.u >= 1) return false;

    // The fuse used to test only the frame's end point, but at 34 m/s a
    // low-fps frame moves the ball further than the fuse reaches and it flies
    // clean through a body. Walk the stretch covered since last frame instead;
    // `_previous` still holds where the ball was.
    const size = this.config.size;
    const travelled = _step.subVectors(this.position, this._previous).length();
    const steps = Math.min(8, Math.max(1, Math.ceil(travelled / Math.max(0.2, size))));
    for (let s = 1; s <= steps; s++) {
      _pos.lerpVectors(this._previous, this.position, s / steps);
      if (!this.ctx.targets.hits(_pos, size)) continue;

      // Burst where it was struck, not where the frame would have carried it.
      this.position.copy(_pos);
      this.length = Math.max(0.1, this.front - travelled * (1 - s / steps));
      this.u = 1;
      this.phase = AbilityPhase.IMPACT;
      this.impactTime = 0;
      this.onImpact();
      return true;
    }
    return false;
  }

  onImpact() {
    const c = this.config;
    const g = settings.global;
    const time = frame.uTime.value;
    const scale = c.burstSize * g.explosionIntensity;

    this._headPoint(1, _impact);
    // The pop happens where the ball is; the scorch lands under it.
    _pos.copy(_impact);
    _impact.y = 0;

    const hot = getColor(c.colorHot);
    const mid = getColor(c.colorFlameMid);
    const edge = getColor(c.colorFlameEdge);

    /* the ball of fire, and a faster inner flash inside it */
    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.size,
      endRadius: scale,
      life: 0.55,
      intensity: c.burstIntensity,
      opacity: 0.95,
      fresnel: 1.1,
      displace: 0.5,
      turbulence: c.burstTurbulence,
      colorA: hot,
      colorB: mid,
      colorC: edge
    });
    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.size * 0.5,
      endRadius: scale * 0.5,
      life: 0.22,
      intensity: c.burstIntensity * 2,
      opacity: 1,
      displace: 0.2,
      colorA: hot,
      colorB: hot,
      colorC: mid
    });

    /* the ring across the floor, and the mark it leaves */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _impact, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.45,
      width: 0.05,
      intensity: 1.1,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });
    this.ctx.decals.spawn(DecalType.SCORCH, _impact, {
      radius: c.scorchRadius * g.explosionIntensity,
      life: c.scorchLife,
      intensity: c.scorchIntensity,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorCrack),
      height: 0.012
    });

    /* everything thrown out of it */
    _emit.position = _pos;
    _emit.radius = c.size * 0.6;
    _emit.direction = _dir.set(0, 0.75, 0);
    _emit.speed = 5.5;
    _emit.speedVariance = 0.85;
    _emit.spread = 1;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.size * 0.7;
    _emit.sizeVariance = 0.7;
    _emit.life = 0.55;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.core.emit(Math.round(c.burstEmbers * g.particleCount), _emit);

    _emit.speed = 8.5;
    _emit.size = c.sparkSize * 1.4;
    _emit.life = c.sparkLifetime * 1.4;
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

    _emit.speed = 2.2;
    _emit.size = c.smokeSize * 2.4;
    _emit.life = c.smokeLifetime * 1.5;
    this.smoke.emit(Math.round(c.burstSmoke * g.particleCount), _emit);

    // What it actually does to anything standing there. Kept clear of the global
    // multipliers above on purpose: those are the look, this is the hit.
    // ctx.mods is the run's upgrade layer (M2) — App wires it in run mode only
    // (Task 7); the sandbox leaves it undefined, so this stays exactly c.damage.
    // this.autocast pays the same 15% tax CombatSystem folds into every other
    // element (Task 9) — this self-resolved hit was the one path that could
    // dodge it. The wuxing arg lets it fold the matchup like every other
    // skill instead of the dead `wuxingOf.fireball` entry (D-M3-8), and the
    // landed-hit count books it into the run's damage ledger — this path
    // never told CombatSystem's stats about its damage at all before.
    // M6 T12 (火弹 Lv3 爆炸半径×1.35, Lv5 damage×1.3): kind:'self' resolves
    // its own hits (never through CombatSystem), so both scale by hand here.
    const amt =
      c.damage *
      (this.ctx.mods?.damageMult(this.element) ?? 1) *
      (this.autocast ? settings.run.autocastDamage : 1) *
      bpScale(this.element, 'damage', this.bpLevel);
    const damageRadius = c.damageRadius * bpScale(this.element, 'radius', this.bpLevel);
    const hits = this.ctx.targets.damage(_pos, damageRadius, amt, settings.combat.wuxingOf[this.element] ?? -1);
    this.ctx.stats?.book?.(this.element, amt * hits);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 2.2 * g.explosionIntensity;

    this.position.copy(_pos);
  }

  onFade() {
    // Nothing of the ball is left to drive: the burst, the decals and the
    // particles are all owned by systems that outlive the cast. The phase is
    // still worth sitting through — it is what keeps the light on the impact
    // while the fire dies down.
    this._syncParticles();
  }

  onDestroy() {
    this._velocity.set(0, 0, 0);
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The spit of sparks as it leaves the hand. */
  _muzzleFx() {
    const c = this.config;
    const g = settings.global;

    _emit.position = this._headPoint(0, _pos);
    _emit.radius = 0.14;
    _emit.direction = _dir.copy(this.direction).setY(0.35).normalize();
    _emit.speed = 3.4;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.55;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.sparkSize;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime * 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(c.muzzleSparks * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /**
   * The head and the wake, spread along the segment covered this frame.
   *
   * The head's particles inherit almost all of the ball's velocity, so they
   * travel with it and pile into a sphere; the wake inherits a fraction, so it
   * is left standing in the air behind. That difference is the whole trick —
   * one emission point, two very different results.
   */
  _trailFx(dt) {
    const c = this.config;
    const g = settings.global;
    const time = frame.uTime.value;

    const core = this._core.tick(dt, c.coreRate);
    const sparks = this._sparkRate.tick(dt, c.sparkRate);
    const smoke = this._smokeRate.tick(dt, c.smokeRate);
    const perBatch = 1 / TRAIL_BATCHES;

    for (let i = 0; i < TRAIL_BATCHES; i++) {
      const t = (i + 1) * perBatch;
      _step.lerpVectors(this._previous, this.position, t);

      _emit.position = _step;
      _emit.radius = c.size * 0.55;
      _emit.direction = _dir.copy(this.direction).negate();
      _emit.speed = 0.4;
      _emit.speedVariance = 1;
      _emit.spread = 1;
      _emit.inherit = _pos.copy(this._velocity).multiplyScalar(0.92);
      _emit.anchor = null;
      _emit.size = c.size;
      _emit.sizeVariance = 0.45;
      _emit.life = c.coreLife;
      _emit.lifeVariance = 0.35;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.core.emit(Math.round(core * perBatch * g.particleCount), _emit);

      _emit.radius = c.size * 0.3;
      _emit.speed = c.sparkSpeed;
      _emit.inherit = _pos.copy(this._velocity).multiplyScalar(0.35);
      _emit.size = c.sparkSize;
      _emit.life = c.sparkLifetime;
      this.sparks.emit(Math.round(sparks * perBatch * g.particleCount), _emit);

      _emit.radius = c.size * 0.5;
      _emit.speed = 0.5;
      _emit.spread = 1;
      _emit.inherit = _pos.copy(this._velocity).multiplyScalar(0.12);
      _emit.size = c.smokeSize;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.spin = 0.5;
      this.smoke.emit(Math.round(smoke * perBatch * g.particleCount), _emit);
    }
  }
}
