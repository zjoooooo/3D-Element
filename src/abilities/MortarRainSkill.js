import { Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { Ability } from './Ability.js';
import { createAsteroidGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { lerp, saturate } from '../utils/math.js';
import { forkPlacement } from './fusions/VineBlazeSkill.js';

/** VFX-only scratch — this class never calls into `targets` (the burst row's
 * wave table is the whole mechanism), so no point of it is ever handed into
 * a call that could reenter (771ba02 has no site to bite here). */
const _pos = new Vector3();
const _dir = new Vector3(0, 1, 0);
const _emit = {};

// Cosmetic — every mechanism number (shell damage, radius, the wave table,
// the scatter) lives in settings, which is also what CombatSystem judges.
const FLIGHT_TIME = 0.3; // a shell's own fall, and the lead the class needs
const ARC_HEIGHT = 5.5; // metres the shell arcs above its landing point
const SHELL_SCALE = 0.28;
const PUFF_COUNT = 20;

/**
 * MortarRainSkill — 流火雨 (火), five shells walked across a scattered
 * footprint (spec §4.3: 迫击弹幕).
 *
 * The 地心火山 machine with the volcano taken off: that fusion's cone and
 * lava pools were its own, but its *contract* with CombatSystem is exactly
 * what a barrage needs — the row's `waves` table says when each shell
 * detonates, `ability.waveIndex` says how many already have, and the class
 * moves `ability.position` to the next landing point ahead of the wave that
 * will land there. Nothing about that hand-off is volcano-specific, so this
 * class is the same dance with a simpler stage: no cone, no pools, just five
 * craters walking across the scatter.
 *
 * `_updateFlight` positions purely as a function of `age` and the static
 * wave delays, so there is nothing to race CombatSystem over — both read the
 * same `impactTime`/`fadeTime` off this same object (the volcano's own doc
 * spells out why that is not a race).
 *
 * Scatter rolls the run's seeded `ctx.rng` when a run supplies one (M8 T1's
 * wiring — a replay shells the same pattern) and falls back to the shared
 * golden-angle spiral otherwise, `forkPlacement` reused verbatim.
 */
export class MortarRainSkill extends Ability {
  constructor(context, element) {
    super(element, context);
    const shells = settings.combat[element].waves.length;
    this._centre = new Vector3();
    this._shellX = new Float32Array(shells);
    this._shellZ = new Float32Array(shells);
    this._seq = 0;
    /** Written by CombatSystem's burst case (its own doc): how many of this
     * cast's waves have detonated. Read here to fire each crater's VFX. */
    this.waveIndex = 0;
    /** How many craters this class has already played — trails `waveIndex`,
     * catching up one (or several, after a stalled frame) per update. */
    this._vfxWave = 0;
    /** Which shell's launch puff has played, so the flight window fires it
     * once per shell rather than every frame of the fall. */
    this._flightPlayed = -1;
  }

  get _row() {
    return settings.combat[this.element];
  }

  /** Long enough for the last shell to land and its crater to settle. */
  get impactDuration() {
    const waves = this._row.waves;
    return waves[waves.length - 1].delay + 0.4;
  }

  get fadeDuration() {
    return 0.4;
  }

  createShaders() {
    const c = this.config;
    this.shellGeometry = createAsteroidGeometry({ seed: 5.7, detail: 1, lumpiness: 0.4, craters: 2 });
    this.shellMaterial = new MeshStandardMaterial({
      color: getColor(c.color),
      roughness: 0.8,
      metalness: 0,
      emissive: getColor(c.colorGlow),
      emissiveIntensity: 1.4
    });
    // One shared mesh: the row's delays (0.5s apart) are well clear of
    // FLIGHT_TIME, so two shells are never in the air at once — the same
    // reasoning VolcanoSkill's single bomb mesh already documents.
    this.shell = new Mesh(this.shellGeometry, this.shellMaterial);
    this.shell.castShadow = true;
    this.shell.visible = false;
    this.shell.scale.setScalar(SHELL_SCALE);
    this.shell.layers.set(LAYER.WORLD);
    this.shell.renderOrder = 2;
    this.group.add(this.shell);
  }

  createParticles() {
    const c = this.config;
    this.embers = this.ctx.particles.get('mortarrain.embers', {
      capacity: 800,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.embers.uniforms.uDrag.value = 1.5;
    this.embers.uniforms.uEndSize.value = 0.3;
    this.embers.uniforms.uSizeIn.value = 0.05;
    this.embers.uniforms.uFadeOut.value = 0.4;
    this.embers.setGradient(getColor(c.colorGlow), getColor(c.colorGlow), getColor(c.color), getColor(c.color));
  }

  /** No travel — the barrage is called down on the aimed point the instant
   * the cast resolves (`settings.mortarrain` carries no `speed`, so the base
   * advance() would NaN-stall; every instant cast overrides this the same way). */
  advance() {
    this.pointAt(1, this.position);
    this.u = 1;
    return true;
  }

  onSpawn() {
    this._seq = 0;
    this.waveIndex = 0;
    this._vfxWave = 0;
    this._flightPlayed = -1;
    this.shell.visible = false;
  }

  /** Roll the five landing points once, up front — pure math with no
   * dependency on anything that changes between now and each shell's own
   * arrival (VolcanoSkill's own reasoning). */
  onImpact() {
    this._centre.copy(this.position);
    const waves = this._row.waves;
    for (let i = 0; i < waves.length; i++) {
      const off = forkPlacement(this.ctx.rng ?? null, this._seq++, this.config.scatterRadius);
      this._shellX[i] = this._centre.x + off.dx;
      this._shellZ[i] = this._centre.z + off.dz;
    }
    // The target ring: one mark over the whole footprint so the player can
    // read where the barrage will walk before the first shell lands.
    _pos.set(this._centre.x, 0.05, this._centre.z);
    this.ctx.decals?.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: this.config.zoneRadius,
      life: 0.8,
      width: 0.07,
      intensity: 1.0,
      colorA: getColor(this.config.colorGlow),
      colorB: getColor(this.config.color)
    });
  }

  onFade(dt) {
    const age = this.impactTime + this.fadeTime;
    const waves = this._row.waves;
    while (this._vfxWave < this.waveIndex) {
      this._crater(this._vfxWave);
      this._vfxWave++;
    }
    this._updateFlight(age, waves);
  }

  onDestroy() {
    this.shell.visible = false;
  }

  dispose() {
    this.shellGeometry.dispose();
    this.shellMaterial.dispose();
    super.dispose();
  }

  /** Which shell (if any) is currently falling, and where it is — also the
   * one place `this.position` moves, so the wave that lands next detonates
   * at its own point rather than the aim point. */
  _updateFlight(age, waves) {
    let flying = -1;
    for (let i = 0; i < waves.length; i++) {
      if (age >= waves[i].delay - FLIGHT_TIME && age < waves[i].delay) {
        flying = i;
        break;
      }
    }
    if (flying === -1) {
      this.shell.visible = false;
      return;
    }
    if (this._flightPlayed !== flying) {
      this._flightPlayed = flying;
      this._puff(this._shellX[flying], ARC_HEIGHT * 0.8, this._shellZ[flying], 8, 0.4);
    }
    // Pre-positioned for CombatSystem's own detonation, a whole flight ahead
    // of its delay — see the burst case's doc on why the class owns this.
    this.position.set(this._shellX[flying], 0, this._shellZ[flying]);

    const t = saturate((age - (waves[flying].delay - FLIGHT_TIME)) / FLIGHT_TIME);
    this.shell.visible = true;
    this.shell.position.set(
      this._shellX[flying],
      lerp(ARC_HEIGHT, 0.2, t * t), // falling, not floating: quadratic drop
      this._shellZ[flying]
    );
    this.shell.rotation.set(t * 7, t * 4, t * 5);
  }

  /** A shell just landed (CombatSystem detonated its wave) — its crater. */
  _crater(i) {
    const c = this.config;
    const row = this._row;
    const x = this._shellX[i];
    const z = this._shellZ[i];
    const radius = row.radius * (row.waves[i]?.radiusMult ?? 1);

    _pos.set(x, 0.05, z);
    this.ctx.decals?.spawn(DecalType.SCORCH, _pos, {
      radius,
      life: 1.6,
      colorA: getColor(c.color),
      colorB: getColor(c.colorGlow),
      intensity: 1.1
    });
    _pos.set(x, radius * 0.2, z);
    this.ctx.bursts?.spawn(BurstMode.FIRE, _pos, {
      radius: radius * 0.25,
      endRadius: radius * settings.global.explosionIntensity,
      life: 0.45,
      intensity: 1.15,
      colorA: getColor(c.colorGlow),
      colorB: getColor(c.color),
      colorC: getColor(c.colorGlow)
    });
    this._puff(x, 0.3, z, PUFF_COUNT, 0.5);
    this.lightBoost += 4;
    this.shell.visible = false;
  }

  _puff(x, y, z, count, life) {
    const g = settings.global;
    _emit.position = _pos.set(x, y, z);
    _emit.radius = 0.25;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 2.6;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.8;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.28;
    _emit.sizeVariance = 0.6;
    _emit.life = life;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.embers.emit(Math.round(count * g.particleCount), _emit);
  }
}
