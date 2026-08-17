import { Mesh, MeshBasicMaterial, Vector3, AdditiveBlending, DoubleSide } from 'three';
import { Ability } from './Ability.js';
import { RibbonGeometry, RibbonMode } from '../effects/RibbonGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { bpScale } from '../run/breakpoints.js';
import { BEHAVIORS } from '../run/EnemySystem.js';

const BOLT_NODES = 4; // sky anchor, two jags, the ground

/** `_strikeP` is the ONE point handed by reference into `targets.damage()`,
 * which can synchronously reach a kill listener (VineBlazeSkill's fork) —
 * dedicated to that call site alone (771ba02). `_pos` serves the VFX
 * consumers, which all copy immediately. */
const _strikeP = new Vector3(0, 1, 0);
const _pos = new Vector3();
const _dir = new Vector3(0, 1, 0);
const _emit = {};
const _boltPoints = Array.from({ length: BOLT_NODES }, () => new Vector3());

// Cosmetic.
const SKY_HEIGHT = 6.0;
const BOLT_FLASH = 0.16;
const DRIZZLE_RATE = 14;

/**
 * StormFieldSkill — 雷暴领域 (木), a wide field that stands for `life`
 * seconds and drops one bolt on a random body inside it every `boltEvery`
 * (spec §4.3: 大圈,随机落雷).
 *
 * Fully self-resolved: `combat.stormfield` is `kind:'self'`, so CombatSystem
 * never touches it — the field itself deals nothing, only the bolts do. That
 * is the difference from 回春雷泽, whose pool IS a combat row; this one is
 * pure sky. A bolt strikes a POINT rather than chaining (that is 连锁闪电's
 * job, and 回春雷泽's), so the budget sits in cadence — but "a point" means
 * a 0.05m query padded by each body's own radius, the same ball-to-ball
 * contract every hit in this codebase keeps: in a crowd piled on the player
 * one bolt takes whoever is standing in that half-metre, measured at ~3.6
 * bodies on average and 8 at worst. The anchor prices the nominal per-body
 * damage, which that does not change.
 *
 * Target pick rolls the run's seeded `ctx.rng` (M8 T1's wiring), falling
 * back to a running counter over the in-field candidates wherever that
 * context is absent — the sandbox and every headless fixture — so a replay
 * of the same seed drops the same sky and a test without one is repeatable.
 *
 * The strike is by POSITION, resolved from the chosen body's coordinates the
 * instant before it lands: a kill's swap-remove can slide a different body
 * into a remembered index, and a point strike hits whoever actually stands
 * there (ThunderMarshSkill's own reasoning, one strike instead of a chain).
 */
export class StormFieldSkill extends Ability {
  constructor(context, element) {
    super(element, context);
    this._nextBolt = Infinity;
    this._seq = 0;
    this._boltAge = 1;
    this._drizzle = new RateEmitter();
  }

  /** Gameplay-critical: the field's whole life — every bolt lands inside it. */
  get impactDuration() {
    return this.config.life;
  }

  get fadeDuration() {
    return 0.5;
  }

  createShaders() {
    this.ribbon = new RibbonGeometry(BOLT_NODES - 1);
    this.ribbonMaterial = new MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide
    });
    this.ribbonMaterial.color.copy(getColor(this.config.colorGlow));
    this.ribbonMesh = new Mesh(this.ribbon.geometry, this.ribbonMaterial);
    this.ribbonMesh.frustumCulled = false;
    this.ribbonMesh.layers.set(LAYER.VFX);
    this.ribbonMesh.renderOrder = 6;
    this.group.add(this.ribbonMesh);
  }

  createParticles() {
    this.drizzle = this.ctx.particles.get('stormfield.drizzle', {
      capacity: 600,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.3
    });
    this.drizzle.uniforms.uDrag.value = 0.2;
    this.drizzle.uniforms.uEndSize.value = 0.1;
    this.drizzle.uniforms.uSizeIn.value = 0.05;
    this.drizzle.uniforms.uFadeOut.value = 0.3;
    this.drizzle.setGradient(
      getColor(this.config.colorGlow), getColor(this.config.colorGlow),
      getColor(this.config.color), getColor(this.config.color)
    );
  }

  /** The field forms at the aimed point instantly (no `speed` in its block). */
  advance() {
    this.pointAt(1, this.position);
    this.u = 1;
    return true;
  }

  onSpawn() {
    // Parked before the first update, like every timed field (M7 T4's
    // frame-order lesson) — nothing else ever writes `position`.
    this.pointAt(1, this.position);
    this._nextBolt = this.config.boltEvery;
    this._seq = 0;
    this._boltAge = 1;
    this._drizzle.reset();
    this.ribbonMaterial.opacity = 0;
  }

  onImpact() {
    _pos.set(this.position.x, 0.05, this.position.z);
    // CRACK, not ARC: ARC's front grows as pow(age, 0.35), so a six-second
    // field would still be drawing at two-thirds of its radius a second and a
    // half in while bolts already target the full circle. The same lesson the
    // timed fields learned at T3 — a standing shape needs a mark that holds.
    this.ctx.decals?.spawn(DecalType.CRACK, _pos, {
      radius: this._radius(),
      life: this.config.life,
      colorA: getColor(this.config.color),
      colorB: getColor(this.config.colorGlow),
      width: 0.12,
      intensity: 1.0,
      growth: 0
    });
  }

  onFade(dt, t) {
    const c = this.config;
    // Catch-up cadence: a stalled frame that jumps several intervals still
    // fires each of them exactly once.
    const age = this.impactTime + (t >= 1 ? this.fadeTime : 0);
    while (this._nextBolt <= c.life + 1e-9 && age >= this._nextBolt) {
      this._strike();
      this._nextBolt += c.boltEvery;
    }
    this._boltAge += dt;
    this.ribbonMaterial.opacity = 0.9 * Math.max(0, 1 - this._boltAge / BOLT_FLASH);
    if (t < 1) this._emitDrizzle(dt);
  }

  onDestroy() {
    this.ribbonMaterial.opacity = 0;
  }

  dispose() {
    this.ribbon.geometry.dispose();
    this.ribbonMaterial.dispose();
    super.dispose();
  }

  _radius() {
    return this.config.zoneRadius * bpScale(this.element, 'radius', this.bpLevel);
  }

  _strike() {
    const en = this.ctx.enemies;
    if (!en) return;
    const radius = this._radius();

    let candidates = 0;
    for (let i = 0; i < en.count; i++) {
      const reach = radius + settings.enemies[BEHAVIORS[en.behavior[i]]].radius;
      if (Math.hypot(en.x[i] - this.position.x, en.z[i] - this.position.z) < reach) candidates++;
    }
    if (candidates === 0) return; // an empty field simply keeps raining

    let pick = this.ctx.rng ? Math.floor(this.ctx.rng() * candidates) : this._seq++ % candidates;
    let target = -1;
    for (let i = 0; i < en.count; i++) {
      const reach = radius + settings.enemies[BEHAVIORS[en.behavior[i]]].radius;
      if (Math.hypot(en.x[i] - this.position.x, en.z[i] - this.position.z) >= reach) continue;
      if (pick-- === 0) { target = i; break; }
    }
    if (target === -1) return;

    const c = this.config;
    const amt =
      c.boltDamage *
      (this.ctx.mods?.damageMult(this.element) ?? 1) *
      (this.autocast ? settings.run.autocastDamage : 1) *
      (this.quenched ? 1.5 : 1) *
      (this.fusionMult ?? 1) *
      bpScale(this.element, 'damage', this.bpLevel);
    const wux = settings.combat.wuxingOf[this.element] ?? -1;

    _strikeP.x = en.x[target];
    _strikeP.z = en.z[target];
    const hits = this.ctx.targets ? this.ctx.targets.damage(_strikeP, 0.05, amt, wux) : 0;
    if (hits) this.ctx.stats?.book?.(this.element, amt * hits);
    this._flash(_strikeP.x, _strikeP.z);
  }

  _flash(x, z) {
    this._boltAge = 0;
    this.lightBoost += 5;
    _pos.set(x, 1.0, z);
    this.ctx.bursts?.spawn(BurstMode.STORM, _pos, {
      radius: 0.2,
      endRadius: 1.1,
      life: 0.25,
      intensity: 1.15,
      colorA: getColor(this.config.colorGlow),
      colorB: getColor(this.config.color),
      colorC: getColor(this.config.colorGlow)
    });
    if (!this.ctx.camera) return;
    _boltPoints[0].set(x, SKY_HEIGHT, z);
    _boltPoints[1].set(x + 0.45, SKY_HEIGHT * 0.62, z - 0.3);
    _boltPoints[2].set(x - 0.35, SKY_HEIGHT * 0.3, z + 0.25);
    _boltPoints[3].set(x, 0.8, z);
    this.ribbon.build(_boltPoints, {
      width: 0.2,
      mode: RibbonMode.BILLBOARD,
      cameraPosition: this.ctx.camera.position,
      count: BOLT_NODES
    });
  }

  _emitDrizzle(dt) {
    const g = settings.global;
    const count = this._drizzle.tick(dt, DRIZZLE_RATE);
    if (count <= 0) return;
    _emit.position = _pos.set(this.position.x, SKY_HEIGHT * 0.8, this.position.z);
    _emit.radius = this._radius() * 0.9;
    _emit.direction = _dir.set(0, -1, 0);
    _emit.speed = 8;
    _emit.speedVariance = 0.2;
    _emit.spread = 0.05;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.13;
    _emit.sizeVariance = 0.4;
    _emit.life = 0.5;
    _emit.lifeVariance = 0.3;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.drizzle.emit(Math.round(count * g.particleCount), _emit);
  }
}
