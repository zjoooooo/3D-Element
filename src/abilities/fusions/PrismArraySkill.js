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
import { pairKeyOf } from '../../run/fusions.js';

/** VFX-only scratch — every consumer below (decals/particles) copies it
 * immediately, never holds it across a loop. This class never hands ANY
 * point to targets at all (see class doc: the aura combat row resolves every
 * hit inside CombatSystem), so the 771ba02 reentrant-scratch rule has no
 * damage path to bite here — nothing reachable from a kill listener ever
 * runs in this file. */
const _pos = new Vector3();
const _dir = new Vector3(0, 1, 0);
const _emit = {};

// Implementer's own read of "a grinding prism array" — cosmetic constants,
// not spec numbers (VineBlazeSkill's EMBER_RATE / VolcanoSkill's CONE_*
// precedent: mechanism numbers live in settings, looks live here). The
// spec-numbered pieces — prism COUNT, the 3s window, the 3.5m disc — all
// come off `settings.fusions['4+0']` / the combat row instead.
const RING_FRACTION = 0.62; // prisms stand at this fraction of the combat radius
const PRISM_HEIGHT = 2.1; // metres, fully risen
const PRISM_WIDTH = 0.85; // x/z scale of the shared unit crystal
const RISE_TIME = 0.35; // seconds for one prism to stand up
const RISE_STAGGER = 0.06; // seconds between successive prisms standing
const BOB_SPEED = 5.2; // rad/s of the grind's rise/fall loop
const BOB_PHASE_STEP = (Math.PI * 4) / 5; // per-prism offset — pentagram order, so the wave traces the star
const BOB_DEPTH = 0.28; // fraction of height each prism sinks per grind cycle
const SPIN_RATE = 1.1; // rad/s of each prism's own slow twist (alternating)
const SPARK_RATE = 16; // grinding sparks per second, whole array

/**
 * PrismArraySkill — 锋岩星阵 (土+金), the '4+0' fusion (spec §4.7).
 *
 * The one PURE-VFX fusion class so far: unlike VineBlazeSkill (fully
 * self-resolved) and VolcanoSkill (hybrid), this class deals no damage of
 * its own and never touches `ctx.targets`. The combat row
 * (`settings.combat.fusions['4+0']`, kind `'aura'` with band === radius) is
 * the whole mechanism: CombatSystem's existing aura case grinds the solid
 * 3.5m disc at 85 dps and re-applies the 0.25/3s vuln every tick — 静置 by
 * construction, because nothing here ever moves `ability.position` the way
 * OrbitAuraSkill pins its own to the player. This file only makes the danger
 * legible: five gold prisms in a pentagon rising/falling in pentagram phase
 * order, a gold-recoloured CRACK decal popped to the full combat radius
 * (WYSIWYG: the ground mark IS the hitbox), grinding sparks, and the base
 * class's own inherited light.
 *
 * Timing contract: `impactDuration` IS the row's 3s `life` — the aura case
 * only ticks TRAVEL+IMPACT (M7 T4, see its own doc), so the grind window
 * equals exactly that 3s and the FADE tail below is purely the prisms
 * sinking home. `onSpawn` parks `position` at the aimed point BEFORE the
 * first update on purpose: combat.tick runs ahead of abilities.update in
 * the frame, so a manually-cast array IS observed once in TRAVEL — the disc
 * must already sit on the target, not on the caster's feet.
 *
 * Pooled per AbilityManager's contract: one shared crystal geometry + one
 * gold material for all five prisms, built once at construction; a cast
 * only repositions/rescales them (zero per-cast allocation).
 */
export class PrismArraySkill extends Ability {
  constructor(context, element) {
    super(element, context);
    /** CRACK decal handle for this cast, or null. Held only to drive the
     * pop-in scale; dropped the moment the grind window closes — the
     * decal's own `life` (matched to the row's) expires there and the
     * pooled slot recycles, so driving it any later would fight the slot's
     * next user (VineBlazeSkill's `_retireZone` keeps the same rule). */
    this._decal = null;
    this._sparkRate = new RateEmitter();
    this._sparkCursor = 0;
  }

  /** Base `Ability#config` assumes `settings[this.element]`, true for a
   * plain element but not a fusion — see VineBlazeSkill's own copy of this
   * redirect for the full reasoning (a fusion id has no top-level settings
   * entry, only its pair-key does). */
  get config() {
    return settings.fusions[pairKeyOf(this.element)];
  }

  /** `settings.combat.fusions['4+0']` — read live, never cached across a
   * cast (VolcanoSkill's own `_row` precedent), so a radius dragged in the
   * editor mid-cast reshapes the decal/ring on the next frame. */
  get _row() {
    return settings.combat.fusions[pairKeyOf(this.element)];
  }

  /** Gameplay-critical, not cosmetic: this IS the grind window — the aura
   * combat row ticks for exactly this long (TRAVEL+IMPACT only, see
   * CombatSystem's aura case). */
  get impactDuration() {
    return this.config.life;
  }

  /** Purely cosmetic tail — the prisms sinking home. The aura case deals
   * nothing during FADE (M7 T4), so this length is free to taste. */
  get fadeDuration() {
    return 0.4;
  }

  createShaders() {
    const count = this.config.prismCount;
    // One shared crystal (the same family LineSweepSkill instances for
    // rockspikes, recoloured gold — "recolour an existing shape", the move
    // both earlier fusion classes made) and one shared material: five
    // meshes, not an InstancedMesh, because five is far below the
    // instancing win and per-mesh transforms keep the bob loop trivial
    // (VolcanoSkill's cone/bomb precedent).
    this.prismGeometry = createCrystalGeometry({ seed: 7.3, sides: 6, taper: 0.16, roughness: 0.42, bend: 0.08 });
    this.prismMaterial = new MeshStandardMaterial({
      color: getColor(this.config.color),
      roughness: 0.35,
      metalness: 0.55,
      emissive: getColor(this.config.colorGlow),
      emissiveIntensity: 0.55
    });
    this._prisms = [];
    this._px = new Float32Array(count);
    this._pz = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const m = new Mesh(this.prismGeometry, this.prismMaterial);
      m.castShadow = true;
      m.visible = false;
      m.layers.set(LAYER.WORLD);
      m.renderOrder = 2;
      this.group.add(m);
      this._prisms.push(m);
    }
  }

  createParticles() {
    // Grinding sparks — recoloured fire-preset channel, mirrors
    // VineBlazeSkill's `embers`/VolcanoSkill's own shared channel shape.
    this.sparks = this.ctx.particles.get('prismarray.sparks', {
      capacity: 500,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.3
    });
    this.sparks.uniforms.uDrag.value = 1.8;
    this.sparks.uniforms.uEndSize.value = 0.16;
    this.sparks.uniforms.uSizeIn.value = 0.04;
    this.sparks.uniforms.uFadeOut.value = 0.35;
    const gold = getColor(this.config.color);
    const glow = getColor(this.config.colorGlow);
    this.sparks.setGradient(glow, glow, gold, gold);
  }

  /**
   * No travel: the array stands exactly at the aimed point the instant the
   * cast resolves — same no-travel override both earlier fusion classes use
   * and for the same reason (`settings.fusions['4+0']` carries no `speed`
   * field; the base default would read it as `undefined` and NaN-stall the
   * cast in TRAVEL forever). Only ever called once per cast.
   */
  advance() {
    this.pointAt(1, this.position);
    this.u = 1;
    return true;
  }

  onSpawn() {
    // Park at the aimed point NOW, not on the first update: combat.tick runs
    // ahead of abilities.update inside the frame, so a manual cast is
    // observed once in TRAVEL — the aura case must already find the disc on
    // the target, not on the caster's feet (class doc; pinned headless).
    this.pointAt(1, this.position);
    this._decal = null;
    this._sparkCursor = 0;
    this._sparkRate.reset();
    // Pooled reset: a re-cast must not flash the previous cast's array for
    // the one frame before onImpact re-places it.
    for (const m of this._prisms) m.visible = false;
  }

  /** Stand the array: place the five prisms on their pentagon and arm the
   * ground mark. All placement keys off `this.position` (parked in onSpawn,
   * never moved again — 静置). */
  onImpact() {
    const cfg = this.config;
    const row = this._row;
    const count = this._prisms.length;
    const ringR = row.radius * RING_FRACTION;
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (i * Math.PI * 2) / count;
      this._px[i] = this.position.x + Math.cos(angle) * ringR;
      this._pz[i] = this.position.z + Math.sin(angle) * ringR;
      const m = this._prisms[i];
      m.position.set(this._px[i], 0, this._pz[i]);
      m.rotation.set(0, i * 2.4, 0); // decorrelate the shared geometry's facets
      m.scale.set(PRISM_WIDTH, 0.001, PRISM_WIDTH);
      m.visible = true;
    }

    // WYSIWYG ground mark: the CRACK patch pops to the COMBAT radius — the
    // gold disc on the floor is exactly the solid disc that grinds. growth 0
    // hands this class exclusive control of the scale for the pop-in
    // (VineBlazeSkill's own load-bearing note on DecalSystem#update).
    _pos.set(this.position.x, 0.05, this.position.z);
    this._decal =
      this.ctx.decals?.spawn(DecalType.CRACK, _pos, {
        radius: row.radius,
        life: cfg.life,
        colorA: getColor(cfg.color),
        colorB: getColor(cfg.colorGlow),
        width: 0.16,
        intensity: 1.1,
        growth: 0
      }) ?? null;
    if (this._decal) this._decal.mesh.scale.setScalar(0); // pop-in starts from nothing
    this.ctx.decals?.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: row.radius,
      life: 0.6,
      width: 0.07,
      intensity: 1.0,
      colorA: getColor(cfg.colorGlow),
      colorB: getColor(cfg.color)
    });
  }

  /**
   * Per-frame drive through IMPACT (the grind: rise stagger + pentagram bob
   * + sparks) and FADE (the sink; the combat row has already gone quiet).
   * @param {number} t 0..1 through the grind, 1..2 through the sink.
   */
  onFade(dt, t) {
    if (this._decal) {
      const popT = Easing.outQuad(saturate(this.impactTime / RISE_TIME));
      this._decal.mesh.scale.setScalar(this._row.radius * 2 * popT);
      // The grind window closes here and so does the decal's own life —
      // drop the handle before the pooled slot can recycle (field doc).
      if (t >= 1) this._decal = null;
    }

    const sink = 1 - Easing.inQuad(saturate(t - 1));
    for (let i = 0; i < this._prisms.length; i++) {
      const m = this._prisms[i];
      const rise = Easing.outQuad(saturate((this.impactTime - i * RISE_STAGGER) / RISE_TIME));
      const bob = 1 - BOB_DEPTH * 0.5 * (1 + Math.sin(this.age * BOB_SPEED + i * BOB_PHASE_STEP));
      const h = PRISM_HEIGHT * rise * bob * sink;
      m.scale.set(PRISM_WIDTH, Math.max(0.001, h), PRISM_WIDTH);
      m.rotation.y += SPIN_RATE * dt * (i % 2 === 0 ? 1 : -1);
      m.visible = h > 0.002;
    }

    if (t < 1) this._emitSparks(dt);
  }

  onDestroy() {
    for (const m of this._prisms) m.visible = false;
    this._decal = null;
  }

  dispose() {
    this.prismGeometry.dispose();
    this.prismMaterial.dispose();
    super.dispose();
  }

  /** A trickle of grinding sparks, one prism at a time round-robin — a
   * fixed-rate budget for the whole array, not per prism, so five prisms
   * never emit five arrays' worth. */
  _emitSparks(dt) {
    const g = settings.global;
    const count = this._sparkRate.tick(dt, SPARK_RATE);
    if (count <= 0) return;
    const i = (this._sparkCursor = (this._sparkCursor + 1) % this._prisms.length);
    _emit.position = _pos.set(this._px[i], 0.25, this._pz[i]);
    _emit.radius = 0.3;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 1.7;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.75;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.13;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.45;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(count * g.particleCount), _emit);
  }
}
