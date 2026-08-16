import { InstancedMesh, MeshStandardMaterial, Object3D, Quaternion, Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { createCrystalGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate } from '../../utils/math.js';

const MAX_SHARDS = 10;
const TAU = Math.PI * 2;
const SHARD_SIZE = 0.3;
const GROW_TIME = 0.25; // seconds the ring takes to assemble on cast

/**
 * Covers the 1-2 frame lag between this ability spawning and the fixed-step
 * tick actually running `player.addShield()` through CombatSystem (see the
 * class doc below) — without it, `ctx.playerState.shieldT` can still read
 * its pre-cast value (typically 0) on the very first frame this ability is
 * updated, and the ring would insta-shatter the instant it appears.
 */
const SPAWN_GRACE = 0.15;

const _pos = new Vector3();
const _dir = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dummy = new Object3D();
const _spin = new Quaternion();
const _emit = {};

/**
 * Ring material feel per wuxing — keyed off the wuxing index (not the
 * element id), same spirit as ZoneBurstSkill's own BURST_MODE table, so a
 * third shield-kind element would fall naturally into whichever family it's
 * closer to. Only water (iceshield) and earth (stoneskin) exist today.
 */
const SHARD_STYLE = {
  2: { sides: 6, taper: 0.7, roughness: 0.1, bend: 0.04, metalness: 0.2, translucent: true }, // water — crystalline
  4: { sides: 5, taper: 0.3, roughness: 0.95, bend: 0.16, metalness: 0.02, translucent: false } // earth — rough rock
};
const DEFAULT_STYLE = SHARD_STYLE[4];

/**
 * ShieldSkill — iceshield (冰晶甲) and stoneskin (石肤), the two `shield`-kind
 * casts (spec's 护盾特例). Unlike every other template, the number the player
 * actually cares about — how much is absorbed, for how long — lives on
 * PlayerState (`shield`/`shieldT`), not on this ability at all: CombatSystem's
 * `shield` case reports the cast's amount/duration/reflectShare the moment
 * this instance goes active (see CombatSystem.tick's own doc), and RunManager
 * is the one place that actually calls `player.addShield(...)`. This class is
 * pure VFX: a ring of shard instances standing around the caster, held up for
 * as long as `ctx.playerState.shieldT` reads positive, shattering the moment
 * it doesn't — which covers natural expiry and getting hit through to zero
 * identically (both surface as the same "shieldT hit zero" signal), the
 * cheaper of the two consistent options the brief left open.
 *
 * Self-centred and open-ended, so `advance()` is overridden in a shape that
 * borrows from both siblings: like OrbitAuraSkill, it tracks the caster's
 * *live* position every frame (a shield holds while you run around the
 * arena); like ZoneBurstSkill's self-centred casts, it eventually *does*
 * report "reached the end" — the frame the shield goes away — which is what
 * lets the base phase machine carry it into an ordinary impact (the shatter
 * burst) → fade (the ring dissolving) → done → pool release. No new
 * mechanism needed beyond the one every other template already runs on.
 *
 * `ctx.playerState` doesn't exist in the sandbox (same as every other
 * playerState read in this codebase) — there, the ring just holds for the
 * settings duration itself, a VFX-only preview with no shield state behind it.
 */
export class ShieldSkill extends Ability {
  constructor(context, element) {
    super(element, context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const style = SHARD_STYLE[settings.combat.wuxingOf[this.element]] ?? DEFAULT_STYLE;
    // Geometry/material both derive once from the wuxing style and never
    // change again for this instance's lifetime — a pooled instance keeps
    // the element it was built for across every re-acquire (AbilityManager
    // pools per element key), so unlike LineSweepSkill's crystal there is no
    // live shape control to re-sync against here.
    this.geometry = createCrystalGeometry({
      seed: 33.3,
      sides: style.sides,
      taper: style.taper,
      roughness: style.roughness,
      bend: style.bend
    });
    this.material = new MeshStandardMaterial({
      roughness: style.roughness,
      metalness: style.metalness,
      transparent: style.translucent,
      opacity: style.translucent ? 0.62 : 1
    });

    this.shards = new InstancedMesh(this.geometry, this.material, MAX_SHARDS);
    this.shards.castShadow = true;
    this.shards.frustumCulled = false;
    this.shards.count = 0;
    this.shards.layers.set(LAYER.WORLD);
    this.shards.renderOrder = 2;
    this.group.add(this.shards);
  }

  createParticles() {
    // One-shot shatter burst only (see class doc) — a held shield is
    // otherwise silent VFX, no continuous stream to drive every frame.
    this.shatter = this.ctx.particles.get(`${this.element}.shatter`, {
      capacity: 400,
      shape: ParticleShape.SOFT,
      additive: false,
      curl: false,
      softFade: 0.4
    });
    this.shatter.uniforms.uDrag.value = 1.1;
    this.shatter.uniforms.uEndSize.value = 0.45;
    this.shatter.uniforms.uSizeIn.value = 0.12;
    this.shatter.uniforms.uFadeIn.value = 0.02;
    this.shatter.uniforms.uFadeOut.value = 0.35;
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get impactDuration() {
    return 0.35; // the shatter burst's own beat
  }

  get fadeDuration() {
    return 0.45; // the ring dissolving to nothing
  }

  /** Live shard count — crystalCount (iceshield) or crackCount (stoneskin),
   * whichever the block carries; both name the same ring-instance count. */
  _shardCount() {
    const c = settings[this.element];
    return Math.min(MAX_SHARDS, Math.max(1, Math.round(c.crystalCount ?? c.crackCount ?? 6)));
  }

  /** Is there still a shield to show? See the class doc for why natural
   * expiry and getting hit through to zero converge on this one check. */
  _holding() {
    const ps = this.ctx.playerState;
    if (ps) return ps.shieldT > 0 || this.age < SPAWN_GRACE;
    // Sandbox: no PlayerState to read shieldT off — hold for the same
    // duration a real run would, so the VFX-only preview still reads right.
    return this.age < (settings.combat[this.element]?.duration ?? 5);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.shards.count = 0;
  }

  /**
   * Never travels anywhere (self-centred, no aim target) and tracks the
   * caster's *live* position every frame rather than the frozen cast-time
   * origin — same reasoning as OrbitAuraSkill's own override — but unlike
   * that permanent aura, this one does eventually report "reached the end":
   * the frame `_holding()` turns false, handing the base machine into the
   * shatter/fade tail below.
   */
  advance() {
    this.position.copy(this.ctx.character.position).setY(0);
    this.u = 0;
    return !this._holding();
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel() {
    this._updateRing(1);
  }

  onImpact() {
    const c = settings[this.element];
    const g = settings.global;
    this.shatter.setGradient(getColor(c.colorGlow), getColor(c.color), getColor(c.color), getColor(c.color));

    _emit.position = _pos.copy(this.position).setY(0.85);
    _emit.radius = c.shieldSize;
    _emit.direction = _dir.set(0, 0.4, 0);
    _emit.speed = 2.4;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.22;
    _emit.sizeVariance = 0.6;
    _emit.life = 0.55;
    _emit.lifeVariance = 0.35;
    _emit.spin = 0.6;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.shatter.emit(Math.round(28 * g.particleCount), _emit);

    this.ctx.shake.add(0.2 * g.cameraShake, 1 / 0.15, 20);
    this.lightBoost = (c.lightIntensity ?? 6) * 1.2;
  }

  /** @param {number} t 0..1 through impact (the shatter beat), then 1..2
   *   through fade — the ring's own scale rides the whole span down to 0. */
  onFade(dt, t) {
    this._updateRing(saturate(1 - t / 2));
  }

  onDestroy() {
    this.shards.count = 0;
  }

  /**
   * Rebuild every shard instance around the live position/count.
   * @param {number} scaleMult 1 while holding, ridden down to 0 as the ring
   *   shatters away (onFade).
   */
  _updateRing(scaleMult) {
    const c = settings[this.element];
    const count = this._shardCount();
    const radius = c.shieldSize;
    const grow = saturate(this.age / GROW_TIME) * scaleMult;
    const spin = this.age * 0.5;

    for (let i = 0; i < count; i++) {
      const theta = (i / count) * TAU + spin;
      _pos.set(
        this.position.x + Math.cos(theta) * radius,
        0.85 + Math.sin(this.age * 1.6 + i) * 0.06,
        this.position.z + Math.sin(theta) * radius
      );
      _spin.setFromAxisAngle(_up, theta);

      _dummy.position.copy(_pos);
      _dummy.quaternion.copy(_spin);
      _dummy.scale.setScalar(SHARD_SIZE * grow);
      _dummy.updateMatrix();
      this.shards.setMatrixAt(i, _dummy.matrix);
    }
    this.shards.count = count;
    this.shards.instanceMatrix.needsUpdate = true;
    this.shards.material.color.copy(getColor(c.color));
  }

  dispose() {
    this.geometry.dispose();
    this.shards.dispose();
    this.material.dispose();
    super.dispose();
  }
}
