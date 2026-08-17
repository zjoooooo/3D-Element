import { Vector3 } from 'three';
import { Ability } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate } from '../utils/math.js';
import { bpScale } from '../run/breakpoints.js';

/** VFX-only scratch — this class deals no damage of its own (the coneTick
 * combat row is the whole mechanism), so nothing here is ever handed into a
 * call that could reenter (771ba02 has no site to bite). */
const _pos = new Vector3();
const _dir = new Vector3();
const _emit = {};

// Cosmetic — the wedge's real numbers (half-angle, range, dps) live in the
// combat row, which is also what CombatSystem judges against.
/**
 * `ParticleSystem#emit`'s `spread` is a 0..1 jitter added to each component
 * of the direction vector (1 = full sphere), NOT an angle — feeding it a
 * radian value sent a tenth of the flame outside the judged wedge and left
 * the inner third thin. Solved rather than measured: the widest bearing that
 * jitter can produce comes from pushing the axial component down by `s` and
 * the lateral one up by `s`, i.e. `atan(s / (1 - s))`, so putting the plume's
 * OUTER envelope exactly on the judged edge means `s = tanθ / (1 + tanθ)`.
 * (An earlier empirical constant hit 87% of the edge at 0.55 rad and drifted
 * with the angle — it would have overshot outright past ~1 rad.)
 */
const spreadFor = (halfAngle) => {
  const t = Math.tan(halfAngle);
  return t / (1 + t);
};
/** Each emitter damps at its own `uDrag`, and the shader integrates it
 * analytically as `travel = (1 - e^(-k·t)) / k` — so the launch speed that
 * dies exactly on the rim has to be solved against THAT emitter's own k. One
 * shared constant sent the embers 29% past the judged range while the plume
 * landed on it (review catch: same function, wrong k). */
const PLUME_DRAG = 1.9;
const EMBER_DRAG = 1.2;
const speedFor = (range, life, drag) => (range * drag) / (1 - Math.exp(-drag * life));
const PLUME_RATE = 90; // flame particles per second at full throat
const EMBER_RATE = 26;
const THROAT_HEIGHT = 1.05; // metres — where the breath leaves the caster
const SPIN_UP = 0.15; // seconds for the plume to reach full width

/**
 * FireBreathSkill — 烈焰喷吐 (火), a channelled wedge of flame (spec §4.3:
 * 扇形龙息).
 *
 * Pure VFX, like the timed fields: `combat.flamebreath` is `kind:'coneTick'`
 * and CombatSystem sweeps the wedge every tick from the caster's own origin
 * down the aim line. This class draws that wedge and nothing else — a cone
 * of flame particles fanned across the row's own half-angle out to the row's
 * own range, so the fire the player sees is the fire that burns (WYSIWYG).
 *
 * It does NOT follow the caster mid-channel: `origin` and `direction` are
 * fixed at cast time, which is what the combat row reads, so the flame and
 * the hit test can never disagree about where the breath is pointing. A
 * player who walks during the channel walks out from behind their own fire —
 * the same contract every other aimed cast in the game keeps.
 */
export class FireBreathSkill extends Ability {
  constructor(context, element) {
    super(element, context);
    this._plume = new RateEmitter();
    this._embers = new RateEmitter();
  }

  /** Gameplay-critical: the channel's length — the coneTick case ticks for
   * exactly this long (TRAVEL+IMPACT only, the timed-shape rule). */
  get impactDuration() {
    return this.config.life;
  }

  /** Cosmetic guttering after the throat closes. */
  get fadeDuration() {
    return 0.35;
  }

  createParticles() {
    const c = this.config;
    this.flame = this.ctx.particles.get('flamebreath.plume', {
      capacity: 1400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this.flame.uniforms.uDrag.value = PLUME_DRAG;
    this.flame.uniforms.uEndSize.value = 0.85;
    this.flame.uniforms.uSizeIn.value = 0.06;
    this.flame.uniforms.uFadeOut.value = 0.45;
    this.flame.setGradient(
      getColor(c.colorGlow), getColor(c.colorGlow), getColor(c.color), getColor(c.color)
    );

    this.sparks = this.ctx.particles.get('flamebreath.embers', {
      capacity: 500,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.3
    });
    this.sparks.uniforms.uDrag.value = EMBER_DRAG;
    this.sparks.uniforms.uEndSize.value = 0.2;
    this.sparks.uniforms.uSizeIn.value = 0.04;
    this.sparks.uniforms.uFadeOut.value = 0.4;
  }

  /** Instant: a breath starts at the mouth, there is no front to travel.
   * (`settings.flamebreath` has no `speed` — the base advance() would
   * NaN-stall, the same override every instant cast uses.) */
  advance() {
    this.pointAt(1, this.position);
    this.u = 1;
    return true;
  }

  onSpawn() {
    this._plume.reset();
    this._embers.reset();
    // The light rides the middle of the wedge rather than the far tip, so a
    // short breath still lights the caster's own feet.
    this.pointAt(0.5, this.position);
  }

  onFade(dt, t) {
    if (t >= 1) return; // guttering — the row has already stopped breathing
    const throttle = saturate(this.impactTime / SPIN_UP);
    this._emitPlume(dt, throttle);
    this._emitEmbers(dt, throttle);
  }

  _row() {
    return settings.combat[this.element];
  }

  /**
   * The wedge itself: particles launched from the caster's throat, each on
   * its own bearing inside the row's half-angle, at a speed that carries it
   * roughly to the row's range over its own life — so the visible fan and
   * the judged wedge cover the same ground.
   */
  _emitPlume(dt, throttle) {
    const g = settings.global;
    const count = this._plume.tick(dt, PLUME_RATE * throttle);
    if (count <= 0) return;
    const row = this._row();
    const level = this.bpLevel;
    const half = row.halfAngle * bpScale(this.element, 'halfAngle', level);
    const range = row.range * bpScale(this.element, 'range', level);
    const life = 0.42;

    _emit.position = _pos.set(
      this.origin.x + this.direction.x * 0.35,
      THROAT_HEIGHT,
      this.origin.z + this.direction.z * 0.35
    );
    _emit.radius = 0.18;
    // Both calibrations below are solved against the particle system's own
    // curves (see the two helpers): the plume's outer envelope lands on the
    // judged edge, and its launch speed dies at the judged range.
    _emit.direction = _dir.set(this.direction.x, 0.06, this.direction.z).normalize();
    _emit.speed = speedFor(range, life, PLUME_DRAG);
    _emit.speedVariance = 0.35;
    _emit.spread = spreadFor(half);
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.34;
    _emit.sizeVariance = 0.5;
    _emit.life = life;
    _emit.lifeVariance = 0.25;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.flame.emit(Math.round(count * g.particleCount), _emit);
  }

  _emitEmbers(dt, throttle) {
    const g = settings.global;
    const count = this._embers.tick(dt, EMBER_RATE * throttle);
    if (count <= 0) return;
    const row = this._row();
    const range = row.range * bpScale(this.element, 'range', this.bpLevel);
    _emit.position = _pos.set(
      this.origin.x + this.direction.x * 0.5,
      THROAT_HEIGHT,
      this.origin.z + this.direction.z * 0.5
    );
    _emit.radius = 0.2;
    _emit.direction = _dir.set(this.direction.x, 0.22, this.direction.z).normalize();
    _emit.speed = speedFor(range, 0.35, EMBER_DRAG);
    _emit.speedVariance = 0.5;
    _emit.spread = spreadFor(row.halfAngle * 0.8);
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.13;
    _emit.sizeVariance = 0.6;
    _emit.life = 0.35;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(count * g.particleCount), _emit);
  }
}
