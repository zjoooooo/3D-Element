import { InstancedMesh, MeshStandardMaterial, Object3D, Quaternion, Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { createCrystalGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';

const TAU = Math.PI * 2;
const MAX_ORBITERS = 8;

const _pos = new Vector3();
const _dir = new Vector3();
const _up = new Vector3(0, 1, 0);
const _tangent = new Vector3();
const _dummy = new Object3D();
const _spin = new Quaternion();
const _roll = new Quaternion();
const _emit = {};

/**
 * OrbitAuraSkill — bladeorbit (剑域), firering (燃阵) and sunwheel (日轮): the
 * three permanent auras (spec §4.5 装备即常驻 — equip it and it runs, no cast,
 * no cooldown, no cast key). `App#_syncAuras()` spawns and retires the one
 * instance a seat owns directly through `AbilityManager.cast()`/`.retire()`,
 * outside the normal cast pipeline entirely (see its own doc) — this class
 * never itself decides when it starts or stops.
 *
 * What makes an instance permanent is `speed: 0` in its settings row (so the
 * base class's line-cast timing carries no meaning here — see settings.js's
 * own SELF comment) plus this class's own `advance()` override below, which
 * simply never reports "arrived": the cast sits in the TRAVEL phase for its
 * entire seated lifetime, `onTravel()` running every frame, tracking the
 * caster's *live* position (`ctx.character` — not `ctx.playerState`, which
 * doesn't exist in the sandbox; see the class-wide note in ZoneBurstSkill's
 * sibling files) rather than the frozen cast-time origin every other ability
 * uses.
 *
 * CombatSystem's `aura` kind reads `ability.position` (kept pinned to the
 * caster here) and ticks damage in the annulus `[radius-band, radius]` —
 * this class only has to keep the *visual* ring honest at that same radius,
 * which is why it reads `settings.combat[element].radius`/`.band` directly
 * rather than duplicating them.
 */
export class OrbitAuraSkill extends Ability {
  constructor(context, element) {
    super(element, context);
    // Exempts this cast from AbilityManager's MAX_CONCURRENT eviction — a
    // permanent effect that flickers out because four unrelated spells were
    // in flight would break "装备即常驻" outright. See AbilityManager.cast().
    this.permanent = true;
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    // bladeorbit's five (or however many) orbiting swords — unused (count 0)
    // by the other two elements in the family.
    this.bladeGeometry = createCrystalGeometry({ seed: 21.6, sides: 4, taper: 0.85, roughness: 0.15, bend: 0.03 });
    this.bladeMaterial = new MeshStandardMaterial({ roughness: 0.25, metalness: 0.7 });
    this.blades = new InstancedMesh(this.bladeGeometry, this.bladeMaterial, MAX_ORBITERS);
    this.blades.castShadow = true;
    this.blades.frustumCulled = false;
    this.blades.count = 0;
    this.blades.layers.set(LAYER.WORLD);
    this.blades.renderOrder = 2;
    this.group.add(this.blades);

    this._ringTimer = 0; // firering: ground decal refresh
    this._orbTimer = 0; // sunwheel: burst-puff refresh
  }

  createParticles() {
    // Rising motes shared by the whole family (firering's fire wisps,
    // sunwheel's ember trail) — bladeorbit doesn't emit any.
    this.motes = this.ctx.particles.get(`${this.element}.aura`, {
      capacity: 1000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.motes.uniforms.uDrag.value = 1.2;
    this.motes.uniforms.uEndSize.value = 0.16;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.08;
    this.motes.uniforms.uFadeOut.value = 0.4;
    this.moteEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Permanence                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Never "arrives" — the whole point (see class doc). Tracks the caster's
   * live position every frame rather than the base class's fixed line, since
   * a seated aura has to follow the player around the arena.
   */
  advance() {
    this.position.copy(this.ctx.character.position).setY(0);
    this.u = 0;
    return false;
  }

  /** Live orbit radius/band — read off the combat row (see class doc). */
  _combat() {
    return settings.combat[this.element];
  }

  onSpawn() {
    this.moteEmitter.reset();
    this._ringTimer = 0;
    this._orbTimer = 0;
    this.blades.count = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Per-element orbiters                                                */
  /* ------------------------------------------------------------------ */

  _updateBlades() {
    const c = settings[this.element];
    const radius = this._combat().radius;
    const count = Math.min(MAX_ORBITERS, Math.max(1, Math.round(c.bladeCount)));
    const height = 0.95;

    for (let i = 0; i < count; i++) {
      const theta = (i / count) * TAU + this.age * c.orbitSpeed * TAU;
      _pos.set(this.position.x + Math.cos(theta) * radius, height + Math.sin(this.age * 1.3 + i) * 0.08, this.position.z + Math.sin(theta) * radius);
      _tangent.set(-Math.sin(theta), 0, Math.cos(theta));

      _spin.setFromUnitVectors(_up, _tangent);
      _roll.setFromAxisAngle(_tangent, 0.4);
      _spin.multiply(_roll);

      _dummy.position.copy(_pos);
      _dummy.quaternion.copy(_spin);
      _dummy.scale.setScalar(c.bladeSize);
      _dummy.updateMatrix();
      this.blades.setMatrixAt(i, _dummy.matrix);
    }
    this.blades.count = count;
    this.blades.instanceMatrix.needsUpdate = true;
    this.blades.material.color.copy(getColor(c.color));
  }

  _updateFireRing(dt) {
    const c = settings[this.element];
    const g = settings.global;
    const combat = this._combat();

    // A scorched ring under the caster's feet — refreshed well before its own
    // life runs out, so it never visibly gaps as the player moves.
    const refresh = 0.35;
    this._ringTimer -= dt;
    if (this._ringTimer <= 0) {
      this._ringTimer = refresh;
      _pos.copy(this.position).setY(0.03);
      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: combat.radius,
        life: refresh * 2.2,
        intensity: 0.75,
        colorA: getColor(c.color),
        colorB: getColor(c.colorGlow),
        height: 0.03
      });
    }

    // Fire wisps rising off the ring itself, not the whole disc.
    const count = Math.round(this.moteEmitter.tick(dt, 26) * g.particleCount);
    if (count > 0) {
      const theta = Math.random() * TAU;
      _pos.set(
        this.position.x + Math.cos(theta) * combat.radius,
        0.05,
        this.position.z + Math.sin(theta) * combat.radius
      );
      _emit.position = _pos;
      _emit.radius = combat.band * 0.5;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.flameHeight * 1.6;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.5;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.22;
      _emit.sizeVariance = 0.6;
      _emit.life = 0.6;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.motes.setGradient(getColor(c.colorGlow), getColor(c.color), getColor(c.color), getColor(c.color));
      this.motes.emit(count, _emit);
    }
  }

  _updateSunOrbs(dt) {
    const c = settings[this.element];
    const g = settings.global;
    const combat = this._combat();
    const count = Math.max(1, Math.round(c.orbCount));

    // Three small fireballs walking a circular path — "orbiting" is a
    // continuous re-trigger of a small BurstSphere shell at each orbit
    // position, since BurstSphere itself is a one-shot pooled expansion
    // (see class doc); the refresh interval is short enough to read as a
    // steady, faintly pulsing ball rather than a flicker.
    this._orbTimer -= dt;
    if (this._orbTimer <= 0) {
      this._orbTimer = 0.28;
      for (let i = 0; i < count; i++) {
        const theta = (i / count) * TAU + this.age * 0.6 * TAU;
        _pos.set(
          this.position.x + Math.cos(theta) * combat.radius,
          1.1,
          this.position.z + Math.sin(theta) * combat.radius
        );
        this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
          radius: c.orbSize * 0.6,
          endRadius: c.orbSize,
          life: 0.32, // slightly longer than the 0.28s refresh — no visible gap
          intensity: 1.3,
          opacity: 0.95,
          fresnel: 1.0,
          displace: 0.35,
          colorA: getColor(c.color),
          colorB: getColor(c.colorGlow),
          colorC: getColor(c.colorGlow)
        });
      }
    }

    const moteCount = Math.round(this.moteEmitter.tick(dt, 18) * g.particleCount);
    if (moteCount > 0) {
      const theta = Math.random() * TAU;
      _pos.set(
        this.position.x + Math.cos(theta) * combat.radius,
        1.1,
        this.position.z + Math.sin(theta) * combat.radius
      );
      _emit.position = _pos;
      _emit.radius = c.orbSize;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = 0.5;
      _emit.speedVariance = 0.7;
      _emit.spread = 1;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.16;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.5;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.motes.setGradient(getColor(c.colorGlow), getColor(c.color), getColor(c.color), getColor(c.color));
      this.motes.emit(moteCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    if (this.element === 'bladeorbit') this._updateBlades();
    else if (this.element === 'firering') this._updateFireRing(dt);
    else if (this.element === 'sunwheel') this._updateSunOrbs(dt);
  }

  /** A permanent cast never reaches these — see advance(). Left as harmless
   * no-ops rather than omitted, so a future retire-via-normal-fade path (if
   * one is ever added) doesn't inherit undefined behaviour by surprise. */
  onImpact() {}

  onFade() {}

  onDestroy() {
    this.blades.count = 0;
  }

  dispose() {
    this.bladeGeometry.dispose();
    this.blades.dispose();
    this.bladeMaterial.dispose();
    super.dispose();
  }
}
