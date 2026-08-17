import { InstancedMesh, MeshStandardMaterial, Object3D, Quaternion, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { createCrystalGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, Easing, randRange } from '../../utils/math.js';
import { bpScale } from '../../run/breakpoints.js';

/** Hard ceiling on spikes per cast — the editor's count slider clamps here. */
const MAX_SPIKES = 48;
const TAU = Math.PI * 2;

const _pos = new Vector3();
const _dir = new Vector3();
const _lean = new Vector3();
const _axis = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dummy = new Object3D();
const _spin = new Quaternion();
const _tilt = new Quaternion();
const _emit = {};

/**
 * LineSweepSkill — a data-driven variant of IceAbility's skeleton (spec: "ice's
 * skeleton, T4"): a field of spikes rising sequentially along the aimed line as
 * the fracture front races down it, one instanced draw call, one ground-crack
 * decal at the impact point, dust puffed as each spike breaches the surface.
 *
 * The one skill registered here is rockspikes (岩刺突贯); the class is written
 * so a second earth-toned line skill could register alongside it with nothing
 * but a settings block, the same "class stays constant, settings vary" contract
 * every other template in this milestone follows.
 *
 * Simplified relative to IceAbility on purpose (a "skeleton", not the flagship):
 * one crystal shape instead of three, a flat lateral band instead of a
 * near/far taper, no punch-through overshoot on the rise. The dice-record rule
 * still holds — a record stores only what chance decided (a position fraction,
 * a lateral sign, a handful of jitters), never a metre or a second, so every
 * shape control stays live while a field is already standing.
 */
export class LineSweepSkill extends Ability {
  constructor(context, element) {
    super(element, context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this._shapeKey = '';
    this.geometry = this._buildGeometry();
    this.material = new MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });

    this.mesh = new InstancedMesh(this.geometry, this.material, MAX_SPIKES);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.renderOrder = 2;
    this.group.add(this.mesh);

    /** Fixed-size record pool — a cast allocates nothing. Dice only, no
     * dimensions (see class doc): every metre/second is resolved live below. */
    this.records = [];
    for (let i = 0; i < MAX_SPIKES; i++) {
      this.records.push({
        along: 0, // 0..1 down the cast line — also this spike's rise order
        lateral: 0, // -1..1 across the band
        yaw: 0,
        heightJitter: 0,
        radiusJitter: 0,
        leanJitter: 0,
        eruptTime: -1, // absolute age it was triggered at, or -1 (still buried)
        shattered: false
      });
    }
    this._activeCount = 0;
  }

  _buildGeometry() {
    const c = settings[this.element];
    return createCrystalGeometry({
      seed: 4.1,
      sides: c.facets,
      taper: c.taper,
      roughness: c.roughness,
      bend: c.bend
    });
  }

  /** Rebuild the crystal only when a *shape* control moves (cheap: ~100 tris). */
  _syncGeometry() {
    const c = settings[this.element];
    const key = `${Math.round(c.facets)}|${c.taper.toFixed(3)}|${c.roughness.toFixed(3)}|${c.bend.toFixed(3)}`;
    if (key === this._shapeKey) return;
    this._shapeKey = key;
    const previous = this.geometry;
    this.geometry = this._buildGeometry();
    this.mesh.geometry = this.geometry;
    previous.dispose();
  }

  createParticles() {
    // Dust kicked up as each spike tears through the floor — non-additive, so
    // it occludes rather than glows (rock breaking ground, not a spark).
    this.dust = this.ctx.particles.get(`${this.element}.dust`, {
      capacity: 800,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.6
    });
    this.dust.uniforms.uDrag.value = 1.6;
    this.dust.uniforms.uEndSize.value = 1.4;
    this.dust.uniforms.uSizeIn.value = 0.1;
    this.dust.uniforms.uFadeIn.value = 0.1;
    this.dust.uniforms.uFadeOut.value = 0.4;

    this.dustEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._activeCount;
  }

  get impactDuration() {
    return Math.max(0.2, settings[this.element].lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.2, settings[this.element].sinkTime);
  }

  /** Visual half-width of the band — read off the combat row directly so the
   * silhouette can never drift from what actually gets hit (WYSIWYG). M6
   * T12: scaled by the same bpScale('width') CombatSystem's own sweep case
   * applies to the hitbox, off this same `bpLevel`, so a Lv3 rockspikes
   * field is exactly as wide on screen as it is to a sweep sample. */
  _halfWidth() {
    const width = settings.combat[this.element]?.width ?? 1.4;
    return width * bpScale(this.element, 'width', this.bpLevel) * 0.5;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings[this.element];
    this.dustEmitter.reset();

    const wanted = Math.min(MAX_SPIKES, Math.max(1, Math.round(c.spikeCount)));
    this._activeCount = wanted;

    for (let i = 0; i < wanted; i++) {
      const record = this.records[i];
      // Evenly spaced down the line (plus a little jitter so they don't read
      // as a ruler) — this is also the order the front triggers them in,
      // which is what makes the field rise sequentially rather than at once.
      record.along = saturate((i + randRange(0.1, 0.9)) / wanted);
      record.lateral = randRange(-1, 1);
      record.yaw = Math.random() * TAU;
      record.heightJitter = randRange(-1, 1);
      record.radiusJitter = randRange(-1, 1);
      record.leanJitter = randRange(-1, 1);
      record.eruptTime = -1;
      record.shattered = false;
    }
    for (let i = wanted; i < MAX_SPIKES; i++) this.records[i].eruptTime = -1;
    this.mesh.count = 0;
  }

  /** Trigger every spike the fracture front has now reached. */
  _triggerUpTo(limit) {
    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      if (record.eruptTime < 0 && record.along <= limit) record.eruptTime = this.age;
    }
  }

  /** 0 → 1 rise, held while buried (-1, not yet triggered). */
  _emergence(record) {
    if (record.eruptTime < 0) return -1;
    const riseTime = Math.max(0.02, settings[this.element].riseTime);
    return Easing.outQuint(saturate((this.age - record.eruptTime) / riseTime));
  }

  /** Rebuild every instance matrix from the live settings.
   * @param {number} retract 0..1 — the whole field withdrawing into the floor */
  _updateSpikes(retract) {
    const c = settings[this.element];
    const g = settings.global;
    const halfWidth = this._halfWidth();
    let used = 0;

    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      const emerge = this._emergence(record);
      if (emerge < 0) continue; // still buried — simply not drawn (count stays below it)

      const height = c.height * (1 + record.heightJitter * c.heightJitter * g.randomness);
      const radius = c.radius * (1 + record.radiusJitter * 0.35 * g.randomness);

      if (!record.shattered && emerge > 0.2) {
        record.shattered = true;
        this._breachFx(record, halfWidth, radius);
      }

      this.pointAt(record.along, _pos);
      _pos.addScaledVector(this.side, record.lateral * halfWidth);

      _lean.copy(this.direction).multiplyScalar(0.7).addScaledVector(this.side, record.lateral * 0.7);
      if (_lean.lengthSq() < 1e-6) _lean.copy(this.direction);
      _lean.normalize();
      const leanAngle = c.lean * (1 + record.leanJitter * 0.4 * g.randomness);
      _axis.crossVectors(_up, _lean).normalize();
      _tilt.setFromAxisAngle(_axis, leanAngle);
      _spin.setFromAxisAngle(_up, record.yaw);
      _tilt.multiply(_spin);

      _dummy.position.copy(_pos);
      _dummy.position.y = (Math.min(1, emerge) - 1) * height * 0.85;
      if (retract > 0) {
        _dummy.position.y -= Easing.inCubic(retract) * (height + radius + 0.4);
      }
      _dummy.quaternion.copy(_tilt);
      _dummy.scale.set(radius, height, radius);
      _dummy.updateMatrix();

      this.mesh.setMatrixAt(used, _dummy.matrix);
      used++;
    }

    this.mesh.count = used;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Dust puff and a small chip burst where a spike breaks the surface. */
  _breachFx(record, halfWidth, radius) {
    const c = settings[this.element];
    const g = settings.global;
    this.pointAt(record.along, _pos);
    _pos.addScaledVector(this.side, record.lateral * halfWidth).setY(0.1);

    _emit.position = _pos;
    _emit.radius = radius * 1.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 0.8;
    _emit.speedVariance = 0.7;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.5;
    _emit.sizeVariance = 0.6;
    _emit.life = 0.7;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.4;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.dust.emit(Math.round(3 * g.particleCount), _emit);
  }

  _syncUniforms() {
    const c = settings[this.element];
    const g = settings.global;
    this._syncGeometry();
    this.material.color.copy(getColor(c.color));

    this.dust.setGradient(getColor(c.colorGlow), getColor(c.color), getColor(c.color), getColor(c.color));
    this.dust.uniforms.uSizeScale.value = g.particleSize;
    this.dust.uniforms.uLifeScale.value = g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = g.particleSpeed;
    this.dust.uniforms.uOpacity.value = 0.8 * g.opacity;
    this.dust.uniforms.uTurbulence.value = 0.5 * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._syncUniforms();
    this._triggerUpTo(this.u);
    this._updateSpikes(0);

    const g = settings.global;
    const halfWidth = this._halfWidth();
    const count = Math.round(this.dustEmitter.tick(dt, 12) * g.particleCount);
    if (count > 0) {
      _emit.position = _pos.copy(this.position).setY(0.15);
      _emit.radius = halfWidth * 0.8;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = 0.5;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.4;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.5;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.dust.emit(count, _emit);
    }
    this.ctx.shake.rumble(0.15 * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings[this.element];
    const g = settings.global;
    this._triggerUpTo(1);
    this.pointAt(1, _pos).setY(0.05);

    // The signature beat the brief asks for: a ground-crack decal at the
    // impact point — DecalType.CRACK is the SDF library's earth-native shape
    // (radial fractures with hot glow), no new decal type needed.
    this.ctx.decals.spawn(DecalType.CRACK, _pos, {
      radius: this._halfWidth() * 2.4,
      life: 1.2,
      width: 0.5,
      intensity: 1.0,
      colorA: getColor(c.color),
      colorB: getColor(c.colorGlow)
    });

    _emit.position = _pos.setY(0.3);
    _emit.radius = this._halfWidth();
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 1.4;
    _emit.speedVariance = 0.7;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.6;
    _emit.sizeVariance = 0.6;
    _emit.life = 0.9;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.4;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.dust.emit(Math.round(24 * g.particleCount), _emit);

    this.ctx.shake.add(0.35 * g.explosionIntensity * g.cameraShake, 1 / 0.12, 20);
    this.ctx.flash.trigger(getColor(c.colorGlow), 0.12 * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.4 * g.explosionIntensity;
  }

  onFade(dt) {
    this._syncUniforms();
    let retract = 0;
    if (this.phase === AbilityPhase.FADE) {
      retract = saturate(this.fadeTime / Math.max(0.05, settings[this.element].sinkTime));
    }
    this._updateSpikes(retract);
  }

  onDestroy() {
    this._activeCount = 0;
    this.mesh.count = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.mesh.dispose();
    this.material.dispose();
    super.dispose();
  }
}
