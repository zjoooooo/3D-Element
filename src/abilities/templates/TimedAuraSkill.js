import { Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { createCrystalGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, Easing } from '../../utils/math.js';
import { bpScale } from '../../run/breakpoints.js';

/** VFX-only scratch — every consumer copies immediately. This template never
 * calls into `targets` at all (the combat row is the whole mechanism), so no
 * point of it is ever handed by reference into a call that could reenter
 * (771ba02's rule has no call site to bite here). */
const _pos = new Vector3();
const _dir = new Vector3(0, 1, 0);
const _emit = {};

/** Both fields stand still for seconds, so the mark has to hold its ground
 * at full strength while they do. CRACK is the only family that does (its
 * own fade is `1 - smoothstep(0.55, 1.0, age)`, i.e. solid for the first
 * half); SHOCKWAVE and DUSTRING animate as one-shot expanding rings — read
 * over a 2.5s life they draw a ring sweeping outward through ground the
 * field is NOT hitting yet, which is WYSIWYG exactly backwards (review
 * catch). Colour is what separates the two here, not shape. */
const DECAL = {
  cyclonecut: DecalType.CRACK,
  sandfield: DecalType.CRACK
};

// Cosmetic constants — every mechanism number lives in settings.
const SHARD_HEIGHT = 1.35; // metres, a fully risen orbiting shard
const SHARD_WIDTH = 0.42;
const SPIN_RATE = 2.4; // rad/s the whole formation turns
const BOB_SPEED = 5.0;
const BOB_DEPTH = 0.3;
const RISE_TIME = 0.3;
const PARTICLE_RATE = 22;

/**
 * TimedAuraSkill — a standing field that lives for `life` seconds and then
 * goes away: 磁暴 (cyclonecut, a metal ring that cuts its band and drags
 * bodies toward the eye) and 沙暴领域 (sandfield, a solid disc that grinds
 * and blinds).
 *
 * It is an ORDINARY cast — cooldown, mana, the five-field stamping, a
 * lifetime — that merely borrows the `aura` combat kind for its hit test.
 * That distinction is load-bearing: App's "seated means standing" roster
 * (装备即常驻) is derived as "an aura row with no `life`", so these two are
 * deliberately excluded from it (`permanentAuraElements`). The permanent
 * rings (bladeorbit/firering/sunwheel) keep OrbitAuraSkill; this template is
 * their timed cousin, and shares nothing with them but the row kind.
 *
 * Sibling: `fusions/PrismArraySkill.js` is the same machine for a fusion id
 * (锋岩星阵) — it predates this template and deliberately wasn't folded onto
 * it (see the M8 errata). The timing contract below — park at spawn, never
 * move, impactDuration IS the row's life — is shared by both; change one and
 * read the other.
 *
 * The mechanism is entirely the combat row — dps over the band, the optional
 * slow, the optional `kbMult` (磁暴 runs it NEGATIVE, which turns the
 * baseline outward shove into an inward pull: 拽向圆心). This class never
 * touches `targets`; it parks the cast at the aimed point and makes the
 * danger legible: a ring of shards orbiting at the band's own radius, a
 * ground mark sized to the row's own radius (WYSIWYG), and a trickle of
 * particles. `position` is written once, at spawn, and never again — 静置,
 * which is also what lets the row's own hit test read it every tick without
 * chasing the player the way a permanent aura does.
 *
 * Pooled per AbilityManager's contract: one shared shard geometry and one
 * material per instance, built at construction; a cast only repositions.
 */
export class TimedAuraSkill extends Ability {
  constructor(context, element) {
    super(element, context);
    this._decal = null;
    this._rate = new RateEmitter();
  }

  /** The combat row — read live so a radius dragged in the editor mid-cast
   * reshapes the ring and its ground mark on the next frame (the fusion
   * classes' own `_row` precedent). */
  get _row() {
    return settings.combat[this.element];
  }

  /** Gameplay-critical: the field's whole life. The aura case ticks
   * TRAVEL+IMPACT only (M7 T4's timed-window rule), so this IS the window
   * the row gets to do its work in. */
  get impactDuration() {
    return this.config.life;
  }

  /** Cosmetic settle — the row has already gone quiet. */
  get fadeDuration() {
    return 0.4;
  }

  createShaders() {
    const c = this.config;
    // One shared shard, instanced by hand across a handful of meshes: the
    // count is small enough that per-mesh transforms beat an InstancedMesh
    // (VolcanoSkill's cone/bomb precedent), and it keeps the orbit loop to
    // one line per shard.
    this.shardGeometry = createCrystalGeometry({ seed: 6.2, sides: 5, taper: 0.3, roughness: 0.5, bend: 0.12 });
    this.shardMaterial = new MeshStandardMaterial({
      color: getColor(c.color),
      roughness: 0.4,
      metalness: 0.45,
      emissive: getColor(c.colorGlow),
      emissiveIntensity: 0.5
    });
    this._shards = [];
    for (let i = 0; i < c.shardCount; i++) {
      const m = new Mesh(this.shardGeometry, this.shardMaterial);
      m.castShadow = true;
      m.visible = false;
      m.layers.set(LAYER.WORLD);
      m.renderOrder = 2;
      this.group.add(m);
      this._shards.push(m);
    }
  }

  createParticles() {
    const c = this.config;
    this.motes = this.ctx.particles.get(`${this.element}.motes`, {
      capacity: 600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.4;
    this.motes.uniforms.uEndSize.value = 0.28;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeOut.value = 0.4;
    this.motes.setGradient(getColor(c.colorGlow), getColor(c.colorGlow), getColor(c.color), getColor(c.color));
  }

  /** No travel: the field forms at the aimed point the instant the cast
   * resolves (every timed-field class before this one, same NaN reason — a
   * row with no `speed` would stall the base advance() forever). */
  advance() {
    this.pointAt(1, this.position);
    this.u = 1;
    return true;
  }

  onSpawn() {
    // Park BEFORE the first update: combat.tick runs ahead of
    // abilities.update inside a frame, so a manual cast is observed once in
    // TRAVEL — the field must already sit on its target (M7 T4's lesson).
    this.pointAt(1, this.position);
    this._decal = null;
    this._rate.reset();
    for (const m of this._shards) m.visible = false; // pooled reset
  }

  onImpact() {
    const c = this.config;
    const row = this._row;
    _pos.set(this.position.x, 0.05, this.position.z);
    // Sized to the ROW's radius (breakpoint-scaled exactly like the hit
    // test), not a VFX number: the mark on the floor is the footprint that
    // actually gets hit (WYSIWYG).
    this._decal =
      this.ctx.decals?.spawn(DECAL[this.element] ?? DecalType.CRACK, _pos, {
        radius: row.radius * bpScale(this.element, 'radius', this.bpLevel),
        life: c.life,
        colorA: getColor(c.color),
        colorB: getColor(c.colorGlow),
        width: 0.14,
        intensity: 1.0,
        growth: 0 // this class owns the scale for the pop-in
      }) ?? null;
    if (this._decal) this._decal.mesh.scale.setScalar(0);
  }

  /**
   * @param {number} t 0..1 through the field's life, then 1..2 through the
   *   cosmetic settle.
   */
  onFade(dt, t) {
    const row = this._row;
    // The shards ride the BAND's own middle — for a ring row that is the
    // annulus they cut, for a solid-disc row (band === radius) it lands at
    // half the radius, which reads as a churning field rather than a rim.
    // Scaled by the SAME breakpoints CombatSystem's own aura case applies
    // to the hit test (OrbitAuraSkill's explicit WYSIWYG convention) — a
    // plain element really can grow a `breakpoints.lv3.radius`, unlike the
    // fusion classes, so an unscaled visual would drift at Lv3.
    const radius = row.radius * bpScale(this.element, 'radius', this.bpLevel);
    const band = (row.band ?? 0) * bpScale(this.element, 'band', this.bpLevel);
    const ringR = Math.max(0.2, radius - band * 0.5);

    if (this._decal) {
      this._decal.mesh.scale.setScalar(radius * 2 * Easing.outQuad(saturate(this.impactTime / RISE_TIME)));
      if (t >= 1) this._decal = null; // its own life expires with the field
    }

    const settle = 1 - Easing.inQuad(saturate(t - 1));
    const spin = this.age * SPIN_RATE;
    for (let i = 0; i < this._shards.length; i++) {
      const m = this._shards[i];
      const angle = spin + (i / this._shards.length) * Math.PI * 2;
      const bob = Math.sin(this.age * BOB_SPEED + i * 1.9);
      m.position.set(
        this.position.x + Math.cos(angle) * ringR,
        0.25 + Math.abs(bob) * 0.3,
        this.position.z + Math.sin(angle) * ringR
      );
      m.rotation.set(bob * 0.25, -angle, 0.35 + bob * 0.1);
      const h = SHARD_HEIGHT * settle * (1 - BOB_DEPTH * 0.5 * (1 + bob)) *
        Easing.outQuad(saturate((this.impactTime - i * 0.04) / RISE_TIME));
      m.scale.set(SHARD_WIDTH, Math.max(0.001, h), SHARD_WIDTH);
      m.visible = h > 0.002;
    }

    if (t < 1) this._emitMotes(dt, ringR);
  }

  onDestroy() {
    for (const m of this._shards) m.visible = false;
    this._decal = null;
  }

  dispose() {
    this.shardGeometry.dispose();
    this.shardMaterial.dispose();
    super.dispose();
  }

  _emitMotes(dt, ringR) {
    const g = settings.global;
    const count = this._rate.tick(dt, PARTICLE_RATE);
    if (count <= 0) return;
    _emit.position = _pos.set(this.position.x, 0.3, this.position.z);
    _emit.radius = ringR;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 1.1;
    _emit.speedVariance = 0.6;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.2;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.6;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(count * g.particleCount), _emit);
  }

}
