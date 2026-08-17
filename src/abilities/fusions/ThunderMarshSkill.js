import { Mesh, MeshBasicMaterial, Vector3, AdditiveBlending, DoubleSide } from 'three';
import { Ability } from '../Ability.js';
import { RibbonGeometry, RibbonMode } from '../../effects/RibbonGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { fusionParents, pairKeyOf } from '../../run/fusions.js';
import { chainHops } from '../templates/ChainBoltSkill.js';
import { BEHAVIORS } from '../../run/EnemySystem.js';

/** Bolt polyline tessellation: sky anchor + up to (boltHits) ground points,
 * with one mid-air jag between each pair — sized for boltHits 3. */
const BOLT_NODES = 8;

// Module-level scratch (sibling idiom). `_strikeP` is the ONE point handed
// by reference into `targets.damage()` — which can synchronously reach a
// kill listener (VineBlazeSkill's fork) — so it is dedicated to that call
// site alone (771ba02 rule); `_pos` serves the pure-VFX consumers, which
// all copy immediately.
const _strikeP = new Vector3(0, 1, 0);
const _pos = new Vector3();
const _dir = new Vector3(0, 1, 0);
const _emit = {};
const _boltPoints = Array.from({ length: BOLT_NODES }, () => new Vector3());

// Cosmetic constants — mechanism numbers live in settings.fusions['2+1'].
const RAIN_RATE = 26; // raindrop streaks per second over the pool
const RAIN_HEIGHT = 4.5; // metres above ground the rain spawns
const BOLT_FLASH = 0.18; // seconds the arc ribbon stays lit
const MAX_STRIKES = 8; // planning-buffer cap ≥ any sane boltHits value
/** A strike's point-test radius: effectively "the body standing there" —
 * the hit test pads by the target's own radius, so this only needs to be
 * comfortably smaller than any body (ChainBoltSkill's own named
 * HIT_RADIUS precedent, tighter here because the strike point IS the
 * planned body's centre, never an aim guess). */
const STRIKE_RADIUS = 0.05;

/**
 * ThunderMarshSkill — 回春雷泽 (水+木), the '2+1' fusion (spec §4.7). A
 * hybrid like VolcanoSkill: the POOL is a combat row (`kind:'marsh'` —
 * CombatSystem refreshes the 0.45 slow every tick and banks the
 * stand-inside heal through its healDue return, RunManager spends it), and
 * the BOLTS are self-resolved here: every `boltEvery` seconds one bolt
 * seeds on an enemy inside the pool and chain-hops (`chainHops`, the T6
 * pure function, reused verbatim) to its nearest unvisited neighbours —
 * `boltHits` strikes total, each `boltDecay`× the last, starting at
 * `boltDamage` (数值表 anchor: ≈5 bolts × 51 = 255 over the pool's 4s).
 *
 * Seed pick is DETERMINISTIC — a running `_boltSeq` cycles the in-pool
 * candidates — because `ctx.rng` still isn't wired onto the ability ctx
 * (forkPlacement's own documented fallback situation, third instance now;
 * wiring it means an App change outside this task's file list — errata).
 *
 * Strike order safety: `chainHops` returns INDICES, but a strike can kill
 * and swap-remove, sliding a different body into a later index — so the
 * whole bolt path is resolved to POSITIONS first (planning pass, no side
 * effects), then struck by position (a point strike hits whoever actually
 * stands there — the intended body, since each strike targets a distinct
 * one). The per-bolt `chainHops` result array is a per-EVENT allocation
 * (≤5 per cast), same class as _critPop's options — the per-tick path
 * allocates nothing; the hop scan's `seen` Set is this instance's own,
 * cleared per bolt, never rebuilt.
 *
 * The plan's 玩家在内回春光环 follow-decal is DROPPED for now: the ability
 * ctx carries no player position (App is outside this task's file list) —
 * the heal already reads through the hp orb; errata carries the note.
 */
export class ThunderMarshSkill extends Ability {
  constructor(context, element) {
    super(element, context);
    this._wux = -1;
    this._wuxB = -1;
    this._boltSeq = 0;
    this._nextBolt = Infinity;
    this._boltAge = 1; // ≥ BOLT_FLASH ⇒ ribbon dark
    this._boltCount = 0; // live nodes in the current arc polyline
    this._seen = new Set(); // chainHops' visited set, reused across bolts
    this._hx = new Float32Array(MAX_STRIKES); // planned strike positions
    this._hz = new Float32Array(MAX_STRIKES);
    this._rainRate = new RateEmitter();
  }

  /** Fusion config redirect — VineBlazeSkill's own reasoning, verbatim. */
  get config() {
    return settings.fusions[pairKeyOf(this.element)];
  }

  /** The pool's combat row (slow/heal live there; read live). */
  get _row() {
    return settings.combat.fusions[pairKeyOf(this.element)];
  }

  /** Gameplay-critical: the pool's whole life — the marsh row only ticks
   * TRAVEL+IMPACT (CombatSystem's own timed-window rule). */
  get impactDuration() {
    return this.config.life;
  }

  get fadeDuration() {
    return 0.45;
  }

  createShaders() {
    // The arc: one billboard ribbon rebuilt per bolt, faded over
    // BOLT_FLASH — the ChainBolt look on the shared ribbon machinery.
    this.ribbon = new RibbonGeometry(BOLT_NODES - 1);
    this.ribbonMaterial = new MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide
    });
    this.ribbonMesh = new Mesh(this.ribbon.geometry, this.ribbonMaterial);
    this.ribbonMesh.frustumCulled = false;
    this.ribbonMesh.layers.set(LAYER.VFX);
    this.ribbonMesh.renderOrder = 6;
    this.group.add(this.ribbonMesh);
  }

  createParticles() {
    this.rain = this.ctx.particles.get('thundermarsh.rain', {
      capacity: 800,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.3
    });
    this.rain.uniforms.uDrag.value = 0.15;
    this.rain.uniforms.uEndSize.value = 0.1;
    this.rain.uniforms.uSizeIn.value = 0.05;
    this.rain.uniforms.uFadeOut.value = 0.25;
    const water = getColor(this.config.color);
    const leaf = getColor(this.config.colorGlow);
    this.rain.setGradient(water, water, leaf, water);
  }

  /** Instant arrival — the pool forms at the aimed point (sibling override,
   * same NaN-speed reason). */
  advance() {
    this.pointAt(1, this.position);
    this.u = 1;
    return true;
  }

  onSpawn() {
    const parents = fusionParents(this.element); // [母, 子] = [水, 木]
    this._wux = settings.combat.wuxingOf[parents[1]] ?? -1; // 子 (木, 1) — mark identity
    this._wuxB = settings.combat.wuxingOf[parents[0]] ?? -1; // 母 (水, 2) — matchup-only
    // Park NOW: combat.tick observes a manual cast once in TRAVEL before
    // the first update (the T4 frame-order lesson) — the marsh row must
    // already find the pool on the target, not the caster's feet.
    this.pointAt(1, this.position);
    this._boltSeq = 0;
    this._nextBolt = this.config.boltEvery;
    this._boltAge = 1;
    this._boltCount = 0;
    this._rainRate.reset();
    this.ribbonMaterial.opacity = 0;
  }

  onImpact() {
    const row = this._row;
    _pos.set(this.position.x, 0.05, this.position.z);
    // The pool: FOAM spreading over the full combat radius (WYSIWYG — the
    // wet ground IS the slow/heal footprint), living exactly the pool's life.
    this.ctx.decals?.spawn(DecalType.FOAM, _pos, {
      radius: row.radius,
      life: this.config.life + this.fadeDuration,
      colorA: getColor(this.config.color),
      colorB: getColor(this.config.colorGlow),
      intensity: 0.9
    });
    this.ctx.decals?.spawn(DecalType.RIPPLE, _pos, {
      radius: row.radius,
      life: 0.7,
      width: 0.08,
      intensity: 0.9,
      colorA: getColor(this.config.color),
      colorB: getColor(this.config.colorGlow)
    });
  }

  onFade(dt, t) {
    const c = this.config;

    // Bolt cadence, catch-up style (a stalled frame that jumps several
    // 0.8s boundaries — or straight into FADE — still fires each once).
    while (this._nextBolt <= c.life + 1e-9 && this.impactTime + (t >= 1 ? this.fadeTime : 0) >= this._nextBolt) {
      this._fireBolt();
      this._nextBolt += c.boltEvery;
    }

    // Arc flash decay.
    this._boltAge += dt;
    this.ribbonMaterial.opacity = 0.9 * Math.max(0, 1 - this._boltAge / BOLT_FLASH);

    if (t < 1) this._emitRain(dt);
  }

  onDestroy() {
    this.ribbonMaterial.opacity = 0;
    this._boltCount = 0;
  }

  dispose() {
    this.ribbon.geometry.dispose();
    this.ribbonMaterial.dispose();
    super.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Bolts                                                               */
  /* ------------------------------------------------------------------ */

  /** The four cast-time amp factors, read live (sibling formula). */
  _amp() {
    return (
      (this.ctx.mods?.damageMult(this.element) ?? 1) *
      (this.autocast ? settings.run.autocastDamage : 1) *
      (this.quenched ? 1.5 : 1) *
      (this.fusionMult ?? 1)
    );
  }

  _fireBolt() {
    const en = this.ctx.enemies;
    if (!en) return;
    const c = this.config;
    const row = this._row;

    // Candidate scan #1: how many bodies stand in the pool (padded by their
    // own radius, the same reach every area test in EnemySystem uses).
    let candidates = 0;
    for (let i = 0; i < en.count; i++) {
      const reach = row.radius + settings.enemies[BEHAVIORS[en.behavior[i]]].radius;
      if (Math.hypot(en.x[i] - this.position.x, en.z[i] - this.position.z) < reach) candidates++;
    }
    if (candidates === 0) return; // 无敌可击则该道空过

    // Deterministic seed: the running bolt counter cycles the candidates
    // (class doc — ctx.rng still unwired, forkPlacement's own situation).
    let pick = this._boltSeq++ % candidates;
    let from = -1;
    for (let i = 0; i < en.count; i++) {
      const reach = row.radius + settings.enemies[BEHAVIORS[en.behavior[i]]].radius;
      if (Math.hypot(en.x[i] - this.position.x, en.z[i] - this.position.z) >= reach) continue;
      if (pick-- === 0) {
        from = i;
        break;
      }
    }
    if (from === -1) return;

    // Planning pass: resolve the whole path to POSITIONS before any strike
    // (class doc — a kill's swap-remove invalidates indices, never
    // positions). chainHops wants total-1 further hops.
    this._seen.clear();
    const hops = chainHops(en, from, Math.min(MAX_STRIKES, c.boltHits) - 1, c.hopRadius, this._seen);
    let strikes = 0;
    this._hx[strikes] = en.x[from];
    this._hz[strikes] = en.z[from];
    strikes++;
    for (const idx of hops) {
      this._hx[strikes] = en.x[idx];
      this._hz[strikes] = en.z[idx];
      strikes++;
    }

    // Strike pass, by position: 20 × 0.85^k down the chain.
    const targets = this.ctx.targets;
    const amp = this._amp();
    let amt = c.boltDamage * amp;
    for (let k = 0; k < strikes; k++) {
      _strikeP.x = this._hx[k];
      _strikeP.z = this._hz[k];
      const hits = targets ? targets.damage(_strikeP, STRIKE_RADIUS, amt, this._wux, this._wuxB) : 0;
      if (hits) this.ctx.stats?.book?.(this.element, amt * hits);
      amt *= c.boltDecay;
    }

    this._flashBolt(strikes);
  }

  /* ------------------------------------------------------------------ */
  /* VFX                                                                 */
  /* ------------------------------------------------------------------ */

  /** Rebuild the arc polyline over the planned strike positions: a sky
   * anchor above the seed, then down and across the chain with a small jag
   * between ground points. Camera-optional (BILLBOARD needs it; headless
   * ctx carries none). */
  _flashBolt(strikes) {
    this._boltAge = 0;
    const cam = this.ctx.camera;
    if (!cam) return;
    let n = 0;
    _boltPoints[n++].set(this._hx[0], RAIN_HEIGHT + 1.2, this._hz[0]);
    for (let k = 0; k < strikes && n < BOLT_NODES - 1; k++) {
      if (k > 0) {
        // one jag between ground points, lifted and skewed off the midpoint
        const mx = (this._hx[k - 1] + this._hx[k]) / 2;
        const mz = (this._hz[k - 1] + this._hz[k]) / 2;
        _boltPoints[n++].set(mx + (k % 2 ? 0.5 : -0.5), 1.8, mz + (k % 2 ? -0.4 : 0.4));
      }
      _boltPoints[n++].set(this._hx[k], 0.9, this._hz[k]);
      _pos.set(this._hx[k], 1.1, this._hz[k]);
      this.ctx.bursts?.spawn(BurstMode.STORM, _pos, {
        radius: 0.2,
        endRadius: 0.8,
        life: 0.25,
        intensity: 1.1,
        colorA: getColor(this.config.colorGlow),
        colorB: getColor(this.config.color),
        colorC: getColor(this.config.colorGlow)
      });
    }
    this._boltCount = n;
    this.ribbon.build(_boltPoints, {
      width: 0.22,
      mode: RibbonMode.BILLBOARD,
      cameraPosition: cam.position,
      count: n
    });
    this.ribbonMaterial.color.copy(getColor(this.config.colorGlow));
    this.lightBoost += 6; // the inherited light answers each strike
  }

  _emitRain(dt) {
    const g = settings.global;
    const count = this._rainRate.tick(dt, RAIN_RATE);
    if (count <= 0) return;
    _emit.position = _pos.set(this.position.x, RAIN_HEIGHT, this.position.z);
    _emit.radius = this._row.radius * 0.8;
    _emit.direction = _dir.set(0, -1, 0);
    _emit.speed = 7.5;
    _emit.speedVariance = 0.25;
    _emit.spread = 0.06;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.4;
    _emit.life = 0.55;
    _emit.lifeVariance = 0.3;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.rain.emit(Math.round(count * g.particleCount), _emit);
  }
}
