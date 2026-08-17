import { Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { createCrystalGeometry, createAsteroidGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { lerp, saturate, Easing } from '../../utils/math.js';
import { fusionParents, pairKeyOf } from '../../run/fusions.js';
import { zoneTick, forkPlacement } from './VineBlazeSkill.js';

/** VFX-only scratch: every consumer below (decals/bursts/particles/lights)
 * copies this immediately, never holds it across a loop — safe to share.
 * NOT used by `_payoutPool` — see that method's own doc. */
const _pos = new Vector3();
const _poolPos = new Vector3(); // `_payoutPool`'s own scratch (771ba02 lesson) — see that method's doc
const _dir = new Vector3(0, 1, 0);
const _emit = {};

// Implementer's own read of "a volcano cone" and "a small magma bomb" —
// not spec-numbered (mirrors VineBlazeSkill's own EMBER_RATE/GOLDEN_ANGLE
// precedent: cosmetic constants stay local, mechanism numbers live in
// settings). The brief's own "~0.25s" flight time is explicitly
// approximate, unlike the load-bearing wave delays/damage/radius/stunTime
// numbers, which all live in `settings.combat.fusions['3+4']`.
const CONE_RADIUS = 2.2;
const CONE_HEIGHT = 2.8;
const CONE_GLOW_PEAK = 1.6;
const SINK_LEAD = 0.3; // seconds after the last bomb before the cone starts sinking
const SINK_TIME = 0.6;
const FLIGHT_TIME = 0.25; // a bomb's own hop from the cone's mouth to its landing point
const ARC_HEIGHT = 2.4; // metres the bomb arcs upward mid-hop

/**
 * VolcanoSkill — 地心火山 (火+土), the '3+4' fusion (spec §4.7).
 *
 * A hybrid, unlike VineBlazeSkill's fully self-resolved '1+3': the cone
 * rises at the aimed point over `coneRiseTime` (0.4s), then spits three
 * magma bombs, each scattered to its own point within `scatterRadius` (4m)
 * of the cone (`forkPlacement`, reused wholesale from VineBlazeSkill — same
 * deterministic golden-angle fallback when `ctx.rng` is absent, which it
 * always is today, see that function's own doc). Each bomb's own burst
 * damage/radius/stun rides `settings.combat.fusions['3+4']`'s `waves` table
 * through `CombatSystem`'s generalised 'burst' case (see that file's own
 * doc) — this class's only job there is to move `ability.position` to the
 * next bomb's landing point before its wave fires, which `_updateBombFlight`
 * does continuously as a pure function of `age` (no race with CombatSystem:
 * both read the exact same `impactTime`/`fadeTime` fields off this same
 * object, see that file's doc for why that's not a race).
 *
 * The lava pool at each landing point is NOT part of that channel: the
 * built-in burst-kind burn dot ticks a single evolving point at the row's
 * own (bomb) radius, but three separate, WIDER pools that outlive the wave
 * sequence by a further `lavaLife` (4s) each need their own bookkeeping —
 * this class self-resolves them instead, `VineBlazeSkill`'s own `zoneTick`
 * leaky-bucket helper reused verbatim, flat parallel arrays sized to the
 * bomb count (never more than one pool per bomb, so no separate cap
 * arithmetic is needed the way VineBlaze's unbounded kill-driven forks
 * require). `ability.waveIndex` (written by CombatSystem, see its own doc)
 * is how this class knows a bomb has actually landed — `onFade`'s own
 * catch-up loop spawns that bomb's pool/VFX the moment it notices.
 */
export class VolcanoSkill extends Ability {
  constructor(context, element) {
    super(element, context);

    const bombCount = settings.combat.fusions[pairKeyOf(element)].waves.length;
    this._conePos = new Vector3();
    this._bombX = new Float32Array(bombCount);
    this._bombZ = new Float32Array(bombCount);
    this._bombSeq = 0;
    // Lava pools: one slot per bomb — a slot is only ever written once per
    // cast (by `_landBomb`, itself only ever called once per wave index),
    // so the array's own fixed size already IS the cap; no separate
    // truncation logic the way VineBlaze's kill-driven fork budget needs.
    this._plife = new Float32Array(bombCount);
    this._paccum = new Float32Array(bombCount);
    this._lightEntry = new Array(bombCount).fill(null);

    this._wux = -1;
    this._wuxB = -1;
    this._amp = 1;
    /** M7 T3 handshake (CombatSystem's 'burst' case doc): how many of this
     * cast's own waves have detonated. Written by CombatSystem; read here
     * to know when a bomb has landed (spawn its pool/VFX) and to
     * pre-position `this.position` for the wave still to come. */
    this.waveIndex = 0;
    /** How many of `waveIndex`'s waves this class has already played
     * landing VFX for — trails `waveIndex`, catches up one bomb per
     * `onFade` call (or several, if a stalled frame let CombatSystem fire
     * more than one wave before this class's own next tick). */
    this._vfxWave = 0;
    /** Which bomb index's spit puff has already played, so the flight
     * window (`_updateBombFlight`) fires it exactly once per bomb rather
     * than every frame of the hop. */
    this._flightPlayed = -1;
  }

  /** Base `Ability#config` assumes `settings[this.element]`, true for a
   * plain element but not a fusion — see VineBlazeSkill's own copy of this
   * redirect for the full reasoning (fusion ids have no top-level settings
   * entry, only their pair-key does). This is the cast-side/VFX/self-
   * resolved-lava numbers block; `_row` below is the CombatSystem-facing
   * combat row the three bombs themselves ride. */
  get config() {
    return settings.fusions[pairKeyOf(this.element)];
  }

  /** `settings.combat.fusions['3+4']` — read live (never cached across a
   * cast) so a value dragged in the editor mid-cast takes effect
   * immediately, same "always sample settings" rule this whole file
   * follows (settings.js's own header). */
  get _row() {
    return settings.combat.fusions[pairKeyOf(this.element)];
  }

  /** Long enough to cover the full eruption AND every lava pool's own
   * tail: the last bomb lands at `waves[last].delay` and its pool still
   * burns `lavaLife` seconds after that. */
  get impactDuration() {
    const waves = this._row.waves;
    return waves[waves.length - 1].delay + this.config.lavaLife;
  }

  /** Purely cosmetic tail — every pool has already retired (life ≤ 0, see
   * `_tickPools`) well before this starts. Implementer's choice, not
   * spec-given, mirrors VineBlazeSkill's own 0.3s. */
  get fadeDuration() {
    return 0.3;
  }

  createShaders() {
    const rock = getColor(this.config.color);
    const glow = getColor(this.config.colorGlow);

    // The cone: one crystal-family mesh (ProceduralGeometry's own tapered,
    // faceted prism already reads as a rough volcanic cone) recoloured
    // dark rock, with a molten emissive tint `_updateCone` drives over the
    // rise/sink — reused wholesale rather than a new geometry function,
    // the same "recolour an existing shape" move VineBlazeSkill's own
    // decal made (green→orange CRACK).
    this.coneGeometry = createCrystalGeometry({ seed: 4.1, sides: 8, taper: 0.42, roughness: 0.55, bend: 0.04 });
    this.coneMaterial = new MeshStandardMaterial({
      color: rock,
      roughness: 0.92,
      metalness: 0.04,
      emissive: glow,
      emissiveIntensity: 0
    });
    this.cone = new Mesh(this.coneGeometry, this.coneMaterial);
    this.cone.castShadow = true;
    this.cone.visible = false;
    this.cone.layers.set(LAYER.WORLD);
    this.cone.renderOrder = 2;
    this.group.add(this.cone);

    // The bomb in flight: one small rock, repositioned along its own
    // parabolic hop each frame. BurstSphere can't do this — its own
    // `update()` only ever touches `scale`, never `.position` (see that
    // file), so a single moving "arc" instance isn't possible — this
    // lerped mesh is the brief's own offered fallback (labelled here as
    // asked). BurstSphere is still used, in its native, already-
    // established idiom, for the STATIONARY burst at each landing
    // (`_landBomb`) — the same role it already plays for boulder/
    // swordrain/etc in ZoneBurstSkill. Bombs never overlap in flight (the
    // row's own delays are ≥0.9s apart, well past `FLIGHT_TIME`'s 0.25s),
    // so one shared mesh instance is enough — no pooling needed.
    this.bombGeometry = createAsteroidGeometry({ seed: 9.3, detail: 1, lumpiness: 0.35, craters: 2 });
    this.bombMaterial = new MeshStandardMaterial({
      color: rock,
      roughness: 0.85,
      metalness: 0,
      emissive: glow,
      emissiveIntensity: 1.3
    });
    this.bomb = new Mesh(this.bombGeometry, this.bombMaterial);
    this.bomb.castShadow = true;
    this.bomb.visible = false;
    this.bomb.scale.setScalar(0.32);
    this.bomb.layers.set(LAYER.WORLD);
    this.bomb.renderOrder = 2;
    this.group.add(this.bomb);
  }

  createParticles() {
    // One shared eruption channel — recoloured fire preset, mirrors
    // ZoneBurstSkill's own `puff`/VineBlazeSkill's own `embers`.
    this.embers = this.ctx.particles.get('volcano.embers', {
      capacity: 700,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.embers.uniforms.uDrag.value = 1.3;
    this.embers.uniforms.uEndSize.value = 0.3;
    this.embers.uniforms.uSizeIn.value = 0.06;
    this.embers.uniforms.uFadeOut.value = 0.4;
    const rock = getColor(this.config.color);
    const glow = getColor(this.config.colorGlow);
    this.embers.setGradient(glow, glow, rock, rock);
  }

  /**
   * No travel: the cone forms exactly at the aimed point (`pointAt(1)`),
   * the instant the cast resolves — same no-travel override VineBlazeSkill
   * uses and for the same reason (`settings.fusions['3+4']` carries no
   * `speed` field; falling through to the base class's default would read
   * `config.speed` as `undefined` and NaN-stall the cast in TRAVEL
   * forever). Only ever called once per cast (the base class stops calling
   * `advance()` the instant `phase` leaves TRAVEL).
   */
  advance() {
    this.pointAt(1, this.position);
    this.u = 1;
    return true;
  }

  onSpawn() {
    const parents = fusionParents(this.element); // [母, 子] = [火, 土]
    this._wux = settings.combat.wuxingOf[parents[1]] ?? -1; // 子 (土, 4) — mark/debuff identity
    this._wuxB = settings.combat.wuxingOf[parents[0]] ?? -1; // 母 (火, 3) — matchup-only candidate

    this._bombSeq = 0;
    this._plife.fill(0);
    this._paccum.fill(0);
    this.waveIndex = 0;
    this._vfxWave = 0;
    this._flightPlayed = -1;
    this.cone.visible = false;
    this.bomb.visible = false;
  }

  /**
   * `_amp` is computed HERE, not in `onSpawn`, on purpose — see
   * VineBlazeSkill's own `onImpact` doc for the full reasoning
   * (`AbilityManager.cast()` stamps `autocast`/`.fusionMult`/`.quenched`
   * onto the instance AFTER `spawn()` returns; reading them any earlier
   * sees a pooled instance's stale values from its previous cast).
   *
   * Plants the cone at the landing point and rolls the three bombs' own
   * scattered landing spots once, up front (pure math, no dependency on
   * anything that changes between now and when each bomb actually lands).
   */
  onImpact() {
    this._amp =
      (this.ctx.mods?.damageMult(this.element) ?? 1) *
      (this.autocast ? settings.run.autocastDamage : 1) *
      (this.quenched ? 1.5 : 1) *
      (this.fusionMult ?? 1);

    this._conePos.copy(this.position);
    this.cone.position.set(this._conePos.x, 0, this._conePos.z);
    this.cone.rotation.y = Math.random() * Math.PI * 2; // cosmetic yaw only — GroundDecals' own precedent
    this.cone.visible = true;
    this.cone.scale.set(CONE_RADIUS, 0.001, CONE_RADIUS);
    this.coneMaterial.emissiveIntensity = 0;

    const waves = this._row.waves;
    for (let i = 0; i < waves.length; i++) {
      const off = forkPlacement(this.ctx.rng ?? null, this._bombSeq++, this.config.scatterRadius);
      this._bombX[i] = this._conePos.x + off.dx;
      this._bombZ[i] = this._conePos.z + off.dz;
    }

    this._puffAt(this._conePos.x, 0.4, this._conePos.z, 26, 0.6);
    _pos.set(this._conePos.x, 0.06, this._conePos.z);
    this.ctx.decals?.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: CONE_RADIUS * 1.4,
      life: 0.7,
      width: 0.08,
      intensity: 1.0,
      colorA: getColor(this.config.colorGlow),
      colorB: getColor(this.config.color)
    });
  }

  /**
   * Runs every frame through IMPACT+FADE: catches up on any bomb
   * CombatSystem has landed since the last look (spawning its pool/VFX),
   * drives the cone's rise/sink, the currently-flying bomb's own hop (and
   * pre-positions `this.position` for it), and every live pool's own tick.
   */
  onFade(dt) {
    const age = this.impactTime + this.fadeTime;
    const waves = this._row.waves;

    while (this._vfxWave < this.waveIndex) {
      this._landBomb(this._vfxWave);
      this._vfxWave++;
    }

    this._updateCone(age, waves);
    this._updateBombFlight(age, waves);
    this._tickPools(dt);
  }

  onDestroy() {
    // Defensive, not redundant: AbilityManager's MAX_CONCURRENT eviction
    // calls `destroy()` directly on whatever cast is oldest, regardless of
    // whether every pool had already burned out on its own.
    for (let i = 0; i < this._lightEntry.length; i++) {
      if (this._lightEntry[i]) {
        this.ctx.lights?.release(this._lightEntry[i]);
        this._lightEntry[i] = null;
      }
    }
    this._plife.fill(0);
    this.cone.visible = false;
    this.bomb.visible = false;
  }

  dispose() {
    this.coneGeometry.dispose();
    this.coneMaterial.dispose();
    this.bombGeometry.dispose();
    this.bombMaterial.dispose();
    super.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame drivers                                                   */
  /* ------------------------------------------------------------------ */

  _updateCone(age, waves) {
    const riseTime = Math.max(0.01, this.config.coneRiseTime);
    const sinkStart = waves[waves.length - 1].delay + SINK_LEAD;

    let h;
    if (age < riseTime) h = Easing.outQuad(age / riseTime);
    else if (age < sinkStart) h = 1;
    else h = 1 - Easing.inQuad(saturate((age - sinkStart) / SINK_TIME));

    this.cone.scale.y = Math.max(0.001, CONE_HEIGHT * h);
    this.cone.visible = h > 0.001;
    this.coneMaterial.emissiveIntensity = CONE_GLOW_PEAK * h;
  }

  /** Purely a function of `age` and the static wave delays — no reliance
   * on reading `waveIndex` back to decide timing, so there's nothing for
   * this to race against CombatSystem's own tick() over (see class doc). */
  _updateBombFlight(age, waves) {
    let flying = -1;
    for (let i = 0; i < waves.length; i++) {
      const start = waves[i].delay - FLIGHT_TIME;
      if (age >= start && age < waves[i].delay) {
        flying = i;
        break;
      }
    }

    if (flying === -1) {
      this.bomb.visible = false;
      return;
    }

    if (this._flightPlayed !== flying) {
      this._flightPlayed = flying;
      this._puffAt(this._conePos.x, 0.6, this._conePos.z, 10, 0.35); // spit puff, cone mouth
    }
    // Pre-position for CombatSystem's own wave detonation, well ahead of
    // its delay (the whole flight window, ≥0.25s) — see CombatSystem's
    // 'burst' case doc on why this class owns moving `ability.position`.
    this.position.set(this._bombX[flying], 0, this._bombZ[flying]);

    const t = saturate((age - (waves[flying].delay - FLIGHT_TIME)) / FLIGHT_TIME);
    this.bomb.visible = true;
    this.bomb.position.x = lerp(this._conePos.x, this._bombX[flying], t);
    this.bomb.position.z = lerp(this._conePos.z, this._bombZ[flying], t);
    this.bomb.position.y = Math.sin(t * Math.PI) * ARC_HEIGHT + lerp(CONE_HEIGHT * 0.85, 0.15, t);
    this.bomb.rotation.set(t * 9, t * 5, t * 7);
  }

  /** A bomb has landed (CombatSystem's own wave just detonated it, per
   * `waveIndex`) — its own lava pool starts here, plus the one-shot
   * landing burst/decal/particles WYSIWYG-sized off the SAME wave's own
   * (already radiusMult-scaled) combat radius. */
  _landBomb(i) {
    const c = this.config;
    const x = this._bombX[i];
    const z = this._bombZ[i];

    this._plife[i] = c.lavaLife;
    this._paccum[i] = 0;
    this._lightEntry[i] = this.ctx.lights?.acquire() ?? null;

    _pos.set(x, 0.05, z);
    this.ctx.decals?.spawn(DecalType.SCORCH, _pos, {
      radius: c.lavaRadius,
      life: c.lavaLife,
      colorA: getColor(c.color),
      colorB: getColor(c.colorGlow),
      intensity: 1.15
    });

    const row = this._row;
    const bombRadius = row.radius * (row.waves[i]?.radiusMult ?? 1);
    _pos.set(x, bombRadius * 0.15, z);
    this.ctx.bursts?.spawn(BurstMode.FIRE, _pos, {
      radius: bombRadius * 0.25,
      endRadius: bombRadius * settings.global.explosionIntensity,
      life: 0.5,
      intensity: 1.1,
      colorA: getColor(c.colorGlow),
      colorB: getColor(c.color),
      colorC: getColor(c.colorGlow)
    });

    this._puffAt(x, 0.3, z, 22, 0.5);
    this.bomb.visible = false;
  }

  _tickPools(dt) {
    const c = this.config;
    for (let i = 0; i < this._plife.length; i++) {
      if (this._plife[i] <= 0) continue;

      if (this._lightEntry[i]) {
        _pos.set(this._bombX[i], 0.3, this._bombZ[i]);
        this.ctx.lights.set(
          this._lightEntry[i],
          _pos,
          getColor(c.colorGlow),
          5 * saturate(this._plife[i] / c.lavaLife),
          4,
          dt
        );
      }

      this._plife[i] -= dt;
      if (this._plife[i] <= 0) {
        this._retirePool(i);
        continue;
      }

      const amount = zoneTick(this._paccum, i, c.lavaDps * this._amp, dt);
      if (amount > 0) this._payoutPool(i, amount);
    }
  }

  _retirePool(i) {
    this._plife[i] = 0;
    if (this._lightEntry[i]) {
      this.ctx.lights.release(this._lightEntry[i]);
      this._lightEntry[i] = null;
    }
  }

  /**
   * One pool's banked DoT payout — same nominal-amt×hits booking every
   * other self-resolved class uses. `_poolPos`, NOT `_pos`: `targets
   * .damage()` (via `EnemySystem#damage`) holds this point BY REFERENCE
   * across a `for` loop that re-reads `point.x`/`point.z` on every
   * iteration, and a kill inside that loop can synchronously reach any
   * live `onKillAt` listener (a VineBlazeSkill instance's own zone-fork,
   * say) before the loop is done. Giving this call site its own scratch
   * means nothing reachable from that reentrant window can ever corrupt
   * the point this sweep is still reading — the exact fix 771ba02 applied
   * to VineBlazeSkill's `_spawnZone`/`_pos` split, applied here
   * defensively even though nothing this class itself does currently
   * reenters it.
   */
  _payoutPool(i, amount) {
    _poolPos.set(this._bombX[i], 1.0, this._bombZ[i]);
    const hits = this.ctx.targets?.damage(_poolPos, this.config.lavaRadius, amount, this._wux, this._wuxB) ?? 0;
    this.ctx.stats?.book?.(this.element, amount * hits);
  }

  _puffAt(x, y, z, count, life) {
    const g = settings.global;
    _pos.set(x, y, z);
    _emit.position = _pos;
    _emit.radius = 0.3;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 3.0;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.3;
    _emit.sizeVariance = 0.6;
    _emit.life = life;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.embers.emit(Math.round(count * g.particleCount), _emit);
  }
}
