import { Mesh, MeshBasicMaterial, Vector3, AdditiveBlending, DoubleSide } from 'three';
import { Ability } from './Ability.js';
import { RibbonGeometry, RibbonMode } from '../effects/RibbonGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, Easing } from '../utils/math.js';
import { bpScale } from '../run/breakpoints.js';
import { dashLineHits } from './templates/DashStrikeSkill.js';

const RIBBON_NODES = 8;

const _pos = new Vector3();
const _dir = new Vector3(0, 1, 0);
const _emit = {};
const _ribbonPoints = Array.from({ length: RIBBON_NODES + 1 }, () => new Vector3());

// Cosmetic — the mechanism numbers live in settings.
const FLASH_TIME = 0.14; // seconds the lance itself is drawn at full brightness
const SPARK_COUNT = 34;

/**
 * PierceLanceSkill — 破军贯穿 (金), a very long, very narrow line that
 * strikes everything standing in it exactly once and then finishes anything
 * left under an absolute hp floor (spec §4.3: 超长窄线,处决残血).
 *
 * Self-resolved (`combat.piercelance` is `kind:'self'`, the fireball/
 * dashstrike precedent): CombatSystem never sees this cast. The line test is
 * `dashLineHits` reused verbatim — the same overlapping-sample-with-dedup
 * sweep 弑神一闪 already uses, which is exactly the shape a lance wants —
 * and the execute pass is `EnemySystem#executeBelow`, the machinery the 金
 * 禁咒 already established for "an absolute floor, not a fraction of max hp"
 * (settings.ultimate.metal's own reasoning). Both resolve ONCE, at impact:
 * there is no travelling front to sample across frames.
 *
 * The execute runs at each sample point along the line rather than as one
 * big circle, so its reach is the lance's own footprint — a body the lance
 * did not touch is never executed.
 */
export class PierceLanceSkill extends Ability {
  constructor(context, element) {
    super(element, context);
    this._flash = 1; // ≥ FLASH_TIME means "spent"
  }

  /** One long beat: the flash and its afterglow. */
  get impactDuration() {
    return 0.25;
  }

  get fadeDuration() {
    return 0.4;
  }

  createShaders() {
    const c = this.config;
    this.ribbon = new RibbonGeometry(RIBBON_NODES);
    this.ribbonMaterial = new MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide
    });
    this.ribbonMaterial.color.copy(getColor(c.colorGlow));
    this.ribbonMesh = new Mesh(this.ribbon.geometry, this.ribbonMaterial);
    this.ribbonMesh.frustumCulled = false;
    this.ribbonMesh.layers.set(LAYER.VFX);
    this.ribbonMesh.renderOrder = 6;
    this.group.add(this.ribbonMesh);
  }

  createParticles() {
    this.sparks = this.ctx.particles.get('piercelance.sparks', {
      capacity: 500,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.1;
    this.sparks.uniforms.uEndSize.value = 0.14;
    this.sparks.uniforms.uSizeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.4;
  }

  /** Instant: a lance is already through them by the time it registers.
   * (`settings.piercelance` carries no `speed`, so the base advance() would
   * NaN-stall — the same override every instant cast in this codebase uses.) */
  advance() {
    this.pointAt(1, this.position);
    this.u = 1;
    return true;
  }

  onSpawn() {
    this._flash = 0;
    this.ribbonMaterial.opacity = 0;
    this.ribbon.clear();
  }

  onImpact() {
    const c = this.config;
    const row = settings.combat[this.element];
    const level = this.bpLevel;
    // The four cast-time factors CombatSystem folds for every dispatched
    // kind, inlined — a self-resolved class has to apply them by hand
    // (DashStrikeSkill's own onImpact formula).
    const amt =
      c.damage *
      (this.ctx.mods?.damageMult(this.element) ?? 1) *
      (this.autocast ? settings.run.autocastDamage : 1) *
      (this.quenched ? 1.5 : 1) *
      (this.fusionMult ?? 1) *
      bpScale(this.element, 'damage', level);
    const width = c.width * bpScale(this.element, 'width', level);
    const wux = settings.combat.wuxingOf[this.element] ?? -1;

    if (this.ctx.targets) {
      const hits = dashLineHits(
        this.ctx.targets, this, this.origin.x, this.origin.z,
        this.direction.x, this.direction.z, this.length, width, amt, wux
      );
      if (hits) this.ctx.stats?.book?.(this.element, amt * hits);
    }

    // 处决残血: an absolute floor, swept along the same line the damage
    // covered — run AFTER it, so a body the lance brought under the floor
    // is finished by the same cast. `executeBelow` goes through _kill, so
    // gems/shards/kill hooks all fire normally (its own doc).
    const floor = row.executeBelow * bpScale(this.element, 'executeBelow', level);
    const enemies = this.ctx.enemies;
    if (enemies && floor > 0) {
      const stepU = Math.max(0.01, width / Math.max(0.1, this.length));
      for (let u = 0; ; u += stepU) {
        const t = Math.min(u, 1);
        _pos.x = this.origin.x + this.direction.x * this.length * t;
        _pos.z = this.origin.z + this.direction.z * this.length * t;
        enemies.executeBelow(_pos, width, floor);
        if (t >= 1) break;
      }
    }

    this._spark();
    _pos.set(this.position.x, 0.9, this.position.z);
    this.ctx.bursts?.spawn(BurstMode.AIR, _pos, {
      radius: 0.2,
      endRadius: 1.4 * settings.global.explosionIntensity,
      life: 0.35,
      intensity: 1.2,
      colorA: getColor(c.colorGlow),
      colorB: getColor(c.color),
      colorC: getColor(c.colorGlow)
    });
  }

  onFade(dt, t) {
    this._flash += dt;
    const glow = Math.max(0, 1 - this._flash / (FLASH_TIME + this.fadeDuration));
    this.ribbonMaterial.opacity = 0.95 * Easing.outQuad(saturate(glow));
    if (!this.ctx.camera) return;
    const width = this.config.width * bpScale(this.element, 'width', this.bpLevel);
    for (let i = 0; i <= RIBBON_NODES; i++) {
      this.pointAt(i / RIBBON_NODES, _ribbonPoints[i]).y = 1.0;
    }
    this.ribbon.build(_ribbonPoints, {
      width: width * (0.9 + 0.35 * glow),
      mode: RibbonMode.BILLBOARD,
      cameraPosition: this.ctx.camera.position,
      count: RIBBON_NODES + 1
    });
  }

  onDestroy() {
    // The line's dedup identity is this instance (dashLineHits' castId
    // convention) — RunManager's release chain only knows CombatSystem-minted
    // ids, so a self-resolved class hands its own back (BladeTide precedent).
    this.ctx.enemies?.releaseCast(this);
    this.ribbonMaterial.opacity = 0;
    this.ribbon.clear();
  }

  dispose() {
    this.ribbon.geometry.dispose();
    this.ribbonMaterial.dispose();
    super.dispose();
  }

  _spark() {
    const g = settings.global;
    _emit.position = _pos.set(this.position.x, 0.9, this.position.z);
    _emit.radius = 0.4;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = 8;
    _emit.speedVariance = 0.6;
    _emit.spread = 0.3;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.4;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(SPARK_COUNT * g.particleCount), _emit);
  }
}
