import { InstancedMesh, Mesh, MeshStandardMaterial, Object3D, Quaternion, Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { createCrystalGeometry, createAsteroidGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing } from '../../utils/math.js';
import { bpScale, bpAdd } from '../../run/breakpoints.js';

const MAX_BLADES = 24;
const TAU = Math.PI * 2;

/** Which BurstSphere shell reads best for each element — recoloured per
 * skill from its own settings block, so this only picks the silhouette. */
const BURST_MODE = {
  swordrain: BurstMode.AIR, // thin pressure shell — a ring of sword-light, not a fireball
  lifebloom: BurstMode.WATER, // a dome that blooms open, foam read as petals
  frostnova: BurstMode.FROST, // shell tearing into rime plates — already ice-native
  boulder: BurstMode.EARTH, // dense dust ball
  quake: BurstMode.EARTH, // same family, bigger
  // M8 T2: hail is ice-native like frostnova; the pillar is the earth family.
  hailstorm: BurstMode.FROST,
  stonepillar: BurstMode.EARTH
};

const _pos = new Vector3();
const _dir = new Vector3();
const _axis = new Vector3(0, 1, 0);
const _dummy = new Object3D();
const _spin = new Quaternion();
const _emit = {};

/**
 * ZoneBurstSkill — the point-(or self-)circle burst family: swordrain
 * (万剑诀), lifebloom (生命绽放), frostnova (寒霜新星), boulder (落石) and
 * quake (震地波).
 *
 * Every instance travels the base class's ordinary line to a target point
 * (swordrain/lifebloom/boulder — `CastShape.ZONE`, the same "front races to
 * the aimed point" the flagship zone skills already use) or lands on the
 * caster instantly (frostnova/quake — `CastShape.SELF`, `settings.combat[..]
 * .self`; see `advance()`'s override below), then detonates: a BurstSphere
 * shell, a shockwave-ring SDF decal, and a puff of particles. The shape's
 * own radius/`self` flag are read straight off `settings.combat[element]`
 * rather than duplicated in the per-element VFX block — CombatSystem's hit
 * test reads the exact same numbers, so the visual and the damage footprint
 * can never drift apart (WYSIWYG).
 *
 * Two of the five carry a preEffect that plays out during travel, timed to
 * finish right as the front arrives: swordrain drops a scatter of thin
 * blades out of the sky over `dropTime`, boulder drops one big rock over
 * `fallTime`. The other three have none — the burst alone is the whole beat.
 * Dice-only records again: a blade/rock's *position* is a fraction resolved
 * against the live zone radius every frame, never a baked metre.
 */
export class ZoneBurstSkill extends Ability {
  constructor(context, element) {
    super(element, context);
  }

  /** frostnova/quake: no target to travel to — the caster's own feet already
   * are the detonation point (spec: self-centred). */
  get _selfCentered() {
    return !!settings.combat[this.element]?.self;
  }

  /** The falling-blade rain (swordrain only). */
  get _hasBladeRain() {
    return this.element === 'swordrain';
  }

  /** The single falling boulder (boulder only). */
  get _hasFallingRock() {
    return this.element === 'boulder';
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    // Blades (swordrain's preEffect) — thin, faceted, unused (count 0) by
    // every other element in the family.
    this.bladeGeometry = createCrystalGeometry({ seed: 8.4, sides: 4, taper: 0.82, roughness: 0.18, bend: 0.04 });
    this.bladeMaterial = new MeshStandardMaterial({ roughness: 0.3, metalness: 0.6 });
    this.blades = new InstancedMesh(this.bladeGeometry, this.bladeMaterial, MAX_BLADES);
    this.blades.castShadow = true;
    this.blades.frustumCulled = false;
    this.blades.count = 0;
    this.blades.layers.set(LAYER.WORLD);
    this.blades.renderOrder = 2;
    this.group.add(this.blades);

    this.bladeRecords = [];
    for (let i = 0; i < MAX_BLADES; i++) {
      this.bladeRecords.push({ angle: 0, radial: 0, delay: 0, yaw: 0, started: false, landed: false });
    }

    // The single falling rock (boulder's preEffect) — unused by every other element.
    this.rockGeometry = createAsteroidGeometry({ seed: 15.2, detail: 1, lumpiness: 0.4, craters: 3 });
    this.rockMaterial = new MeshStandardMaterial({ roughness: 0.95, metalness: 0.0 });
    this.rock = new Mesh(this.rockGeometry, this.rockMaterial);
    this.rock.castShadow = true;
    this.rock.visible = false;
    this.rock.layers.set(LAYER.WORLD);
    this.rock.renderOrder = 2;
    this.group.add(this.rock);
    this._rockSpin = new Vector3(0.6, 1, 0.3).normalize();
    this._rockStarted = false;
  }

  createParticles() {
    // One burst-puff channel, shared by the whole family — recoloured from
    // each element's own settings block.
    this.puff = this.ctx.particles.get(`${this.element}.burst`, {
      capacity: 1200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.puff.uniforms.uDrag.value = 1.4;
    this.puff.uniforms.uEndSize.value = 0.3;
    this.puff.uniforms.uSizeIn.value = 0.08;
    this.puff.uniforms.uFadeIn.value = 0.06;
    this.puff.uniforms.uFadeOut.value = 0.4;
    this.puffEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing / travel                                                     */
  /* ------------------------------------------------------------------ */

  get impactDuration() {
    return Math.max(0.2, settings[this.element].burstLife ?? 0.7);
  }

  get fadeDuration() {
    return 0.5;
  }

  /**
   * Self-centred casts have nowhere to travel to — `origin` (the caster's
   * position at cast time, set by the base class every `spawn()`) already
   * *is* the detonation point, so the front "arrives" on the very first
   * tick instead of racing there at `config.speed` (which settings sets to
   * 0 for these two rows — see settings.js's own SELF comment: a real
   * subclass is free to not use the base timing at all, which is exactly
   * what this does). Zone-targeted casts keep the ordinary travel-to-point
   * behaviour unchanged.
   */
  advance(dt) {
    if (this._selfCentered) {
      this.position.copy(this.origin);
      this.u = 1;
      return true;
    }
    return super.advance(dt);
  }

  /** Live zone radius — read off the combat row directly (see class doc). M6
   * T12: scaled by the same bpScale('radius') CombatSystem's own burst case
   * applies to the hit footprint, off this same `bpLevel` (WYSIWYG). */
  _radius() {
    const radius = settings.combat[this.element]?.radius ?? settings[this.element].zoneRadius ?? 2;
    return radius * bpScale(this.element, 'radius', this.bpLevel);
  }

  /** Seconds of travel left before the front reaches the target — used to
   * time a preEffect so it finishes landing right as the burst goes off.
   * 0 for a self-centred cast (nothing to count down). */
  _timeToImpact() {
    if (this._selfCentered) return 0;
    const speed = Math.max(0.01, this.config.speed * settings.global.speed);
    return ((1 - this.u) * this.length) / speed;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.puffEmitter.reset();
    this._rockStarted = false;
    this.rock.visible = false;
    this.blades.count = 0;

    if (this._hasBladeRain) {
      // M6 T12 (万剑诀 Lv3 剑数+4): how many of MAX_BLADES this cast actually
      // drops, resolved once at spawn (spec: template classes read shape
      // params at spawn) — fixes a pre-existing gap where every cast dropped
      // all MAX_BLADES regardless of `swordCount`, which made this field dead.
      this._bladeWanted = Math.min(
        MAX_BLADES,
        Math.max(1, Math.round(settings[this.element].swordCount + bpAdd(this.element, 'count', this.bpLevel)))
      );
      for (const record of this.bladeRecords) {
        record.angle = Math.random() * TAU;
        record.radial = Math.sqrt(Math.random()); // even fill, not centre-piled
        record.delay = Math.random();
        record.yaw = Math.random() * TAU;
        record.started = false;
        record.landed = false;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Pre-effects                                                         */
  /* ------------------------------------------------------------------ */

  _updateBladeRain() {
    const c = settings[this.element];
    const radius = this._radius();
    const dropTime = Math.max(0.05, c.dropTime);
    const staggerWindow = dropTime * 0.35;

    if (this._timeToImpact() <= dropTime) {
      // M6 T12: only the first `_bladeWanted` records ever start — the rest
      // sit at their onSpawn-reset `started = false` forever, which is what
      // keeps a Lv1 cast's blade count honest to `swordCount` instead of
      // always drawing all MAX_BLADES (see onSpawn's own doc).
      for (let i = 0; i < this._bladeWanted; i++) {
        const record = this.bladeRecords[i];
        if (!record.started) {
          record.started = true;
          record.fallStart = this.age + record.delay * staggerWindow;
        }
      }
    }

    let used = 0;
    for (let i = 0; i < this._bladeWanted; i++) {
      const record = this.bladeRecords[i];
      if (!record.started) continue;
      const t = saturate((this.age - record.fallStart) / dropTime);
      if (t <= 0) continue;

      this.pointAt(1, _pos);
      _pos.x += Math.cos(record.angle) * record.radial * radius;
      _pos.z += Math.sin(record.angle) * record.radial * radius;
      _pos.y = lerp(c.dropHeight, 0.05, Easing.inQuad(t));

      _spin.setFromAxisAngle(_axis, record.yaw);
      _dummy.position.copy(_pos);
      _dummy.quaternion.copy(_spin);
      _dummy.scale.setScalar(c.swordSize);
      _dummy.updateMatrix();
      this.blades.setMatrixAt(used, _dummy.matrix);
      used++;

      // The moment a blade reaches the ground, it earns a small spark puff.
      if (t >= 1 && !record.landed) {
        record.landed = true;
        this._puffAt(_pos, 4, 0.4);
      }
    }
    this.blades.count = used;
    this.blades.instanceMatrix.needsUpdate = true;
  }

  _updateFallingRock() {
    const c = settings[this.element];
    const fallTime = Math.max(0.05, c.fallTime);

    if (!this._rockStarted && this._timeToImpact() <= fallTime) {
      this._rockStarted = true;
      this._rockStart = this.age;
      this.rock.visible = true;
    }
    if (!this._rockStarted) return;

    const t = saturate((this.age - this._rockStart) / fallTime);
    this.pointAt(1, _pos);
    _pos.y = lerp(c.dropHeight, c.rockSize * 0.5, Easing.inQuad(t));
    this.rock.position.copy(_pos);
    this.rock.rotation.set(
      this._rockSpin.x * this.age * 3,
      this._rockSpin.y * this.age * 2,
      this._rockSpin.z * this.age * 3
    );
    this.rock.scale.setScalar(c.rockSize);
  }

  _puffAt(point, count, life) {
    const g = settings.global;
    const c = settings[this.element];
    _emit.position = point;
    _emit.radius = 0.2;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 1.2;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.25;
    _emit.sizeVariance = 0.6;
    _emit.life = life;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.puff.setGradient(getColor(c.colorGlow), getColor(c.color), getColor(c.color), getColor(c.color));
    this.puff.emit(Math.round(count * g.particleCount), _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel() {
    if (this._hasBladeRain) this._updateBladeRain();
    if (this._hasFallingRock) this._updateFallingRock();
  }

  onImpact() {
    const c = settings[this.element];
    const g = settings.global;
    const radius = this._radius();
    this.position.setY(0);

    const colorA = getColor(c.color);
    const colorB = getColor(c.colorGlow);

    // Every consumer below copies straight out of `_pos` (BurstSystem.spawn /
    // DecalSystem.spawn both do `mesh.position.copy(...)` immediately), so one
    // shared scratch vector re-aimed in place between calls is enough — no
    // per-cast allocation, same as every hand-written ability's own onImpact.
    _pos.copy(this.position).setY(radius * 0.15);
    this.ctx.bursts.spawn(BURST_MODE[this.element] ?? BurstMode.EARTH, _pos, {
      radius: radius * 0.2,
      endRadius: radius * g.explosionIntensity,
      life: this.impactDuration * 0.75,
      intensity: 1.1,
      opacity: 0.9,
      fresnel: 1.2,
      displace: 0.5,
      colorA,
      colorB,
      colorC: colorB
    });

    // The signature "SDF ring decal" the brief calls for, shared by the
    // whole family — a shockwave sized straight off the live combat radius.
    _pos.copy(this.position).setY(0.1);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: radius * g.explosionIntensity,
      life: 0.6,
      width: 0.07,
      intensity: 1.1,
      colorA,
      colorB
    });

    _pos.copy(this.position).setY(0.3);
    _emit.position = _pos;
    _emit.radius = radius * 0.5;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 2.2;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.35;
    _emit.sizeVariance = 0.6;
    _emit.life = 0.6;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.puff.setGradient(colorB, colorA, colorA, colorA);
    this.puff.emit(Math.round(40 * g.particleCount), _emit);

    this.rock.visible = false;
    this.blades.count = 0;

    this.ctx.shake.add(0.4 * g.explosionIntensity * g.cameraShake, 1 / 0.15, 20);
    this.ctx.flash.trigger(colorB, 0.16 * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.6 * g.explosionIntensity;
  }

  onFade() {
    // Nothing left to drive — the burst/decal/particles all outlive the cast
    // (pooled systems of their own), same as fireball/meteor's own onFade.
  }

  onDestroy() {
    this.blades.count = 0;
    this.rock.visible = false;
    this._rockStarted = false;
  }

  dispose() {
    this.bladeGeometry.dispose();
    this.blades.dispose();
    this.bladeMaterial.dispose();
    this.rockGeometry.dispose();
    this.rockMaterial.dispose();
    super.dispose();
  }
}
