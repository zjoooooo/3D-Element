import {
  InstancedMesh, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  Object3D, Vector3, AdditiveBlending, DoubleSide
} from 'three';
import { Ability } from '../Ability.js';
import { createCrystalGeometry } from '../../assets/ProceduralGeometry.js';
import { RibbonGeometry, RibbonMode } from '../../effects/RibbonGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate } from '../../utils/math.js';
import { fusionParents, pairKeyOf } from '../../run/fusions.js';
import { BEHAVIORS } from '../../run/EnemySystem.js';

/** Ribbon tessellation — DashStrikeSkill's own number, same trailing-window read. */
const RIBBON_NODES = 10;

// Module-level scratch (FireballAbility/DashStrikeSkill idiom). `_p` (the
// outbound sample point) and `_hitP` (the return sweep's per-enemy point) are
// real Vector3s — TrainingDummies' damageOnce calls `point.distanceTo`
// internally (see dashLineHits' own comment) — and deliberately SEPARATE:
// both are handed by reference into damageOnce, which holds them across a
// loop that can synchronously reach a kill listener (VineBlazeSkill's fork).
// Nothing in that path writes either scratch today, but the 771ba02 rule is
// one scratch per handed-in call site, not "prove the current listeners
// don't touch it".
const _p = new Vector3(0, 1, 0);
const _hitP = new Vector3(0, 1, 0);
const _pos = new Vector3();
const _dir = new Vector3(0, 1, 0);
const _emit = {};
const _dummy = new Object3D();
const _ribbonPoints = Array.from({ length: RIBBON_NODES + 1 }, () => new Vector3());

// Implementer's own read of "a tide of ice blades" — cosmetic constants only
// (mechanism numbers all live in settings.fusions['0+2']).
const BLADE_CAP = 26; // instanced blades at full (return) density
const OUT_BLADES = 18; // 去程密——回程更密 (the full cap)
const BLADE_LEN = 1.5; // metres, fully raised
const BLADE_BOB = 4.8; // rad/s of the swimming bob
const TILT = 0.55; // radians the blades lean into their travel direction
const MIST_RATE = 22; // frost mist puffs per second along the front

/**
 * BladeTideSkill — 霜刃洪流 (金+水), the '0+2' fusion (spec §4.7). Fully
 * self-resolved (`combat.fusions['0+2'] = { kind: 'self' }`, fireball/
 * dashstrike precedent): CombatSystem never touches this cast.
 *
 * Three beats on one class-owned timeline (impactDuration = out+hover+back;
 * the base phase machine just supplies the clock): an OUTBOUND sweep
 * (0→1 over `outTime`) samples the aim line every `width` metres —
 * CombatSystem's own 'sweep' case math, class-side, `damageOnce` dedup
 * making overlapping samples free — for a flat `outDamage` per enemy; a
 * `hoverTime` hold at the far end; then a RETURN sweep (1→0 over
 * `backTime`) that judges each enemy INDIVIDUALLY: `enemies.slowed[i] > 0`
 * eats `backDamage × backSlowedMult` (必暴 — the spec's "回程对减速敌必暴"),
 * everyone else the plain `backDamage`, each exactly once.
 *
 * Two dedup identities, zero leak: the outbound sweep keys `damageOnce` by
 * `this` (DashStrikeSkill's own castId idiom — object identity, no counter
 * to collide with CombatSystem's numeric ids), the return sweep by
 * `this._backKey` (one extra per-instance object, built once at
 * construction) — so the same enemy is hit once per PROGRAM, twice per
 * cast. `onDestroy` releases both from `_hitMemory` itself, mirroring
 * DashStrike's own `releaseCast(this)` — RunManager's onRetire chain only
 * knows CombatSystem-minted ids and would never clean these.
 *
 * The return judgement needs per-enemy `slowed` reads, so it goes through
 * `ctx.enemies` directly (run-only). The sandbox has no `ctx.enemies` and
 * no reachable fusions anyway — every gameplay touch below is optional-
 * chained, so a bare-VFX ctx just plays the two sweeps (null-safe pin in
 * check-game). Hugging-neighbour splash corner: `damageOnce`'s hit test
 * pads by the target's own body radius, so a body within ~half a metre of
 * a judged point can eat that point's amount and be dedup-claimed by it.
 * Two guards keep the corner strictly player-favourable: the slowed pass
 * runs FIRST each frame, and its window's lower bound leads the plain
 * pass's by one maximum splash reach (`_sweepBack`'s `look`) — so a slowed
 * body is always claimed by its own crit before any plain neighbour's
 * splash can reach it, this frame or any earlier one (review fix round:
 * ordering alone only protected pairs landing in the SAME frame window; a
 * slowed body a hair down-line of a plain one could be splash-claimed a
 * frame early and under-paid). The residual error direction is only ever
 * an unslowed hugger over-paid a crit's 250.
 */
export class BladeTideSkill extends Ability {
  constructor(context, element) {
    super(element, context);
    /** The return sweep's own dedup identity (class doc). Stable across the
     * instance's whole pooled life — released per cast, never re-minted. */
    this._backKey = {};
    this._outU = 0;
    this._backU = 1;
    this._wux = -1;
    this._wuxB = -1;
    this._mistRate = new RateEmitter();
  }

  /** Base `Ability#config` assumes `settings[this.element]` — a fusion id
   * only has its pair-key block (VineBlazeSkill's redirect, verbatim). */
  get config() {
    return settings.fusions[pairKeyOf(this.element)];
  }

  /** The whole flight: out, hover, home. Gameplay-critical (the class's own
   * timeline below keys every beat off these three settings numbers). */
  get impactDuration() {
    const c = this.config;
    return c.outTime + c.hoverTime + c.backTime;
  }

  /** Cosmetic mist tail — both sweeps have fully resolved by FADE (the
   * return sweep's own end-flush runs at the impact window's last frame). */
  get fadeDuration() {
    return 0.35;
  }

  createShaders() {
    const ice = getColor(this.config.color);
    const gold = getColor(this.config.colorGlow);

    // The tide: thin faceted blades — swordrain's exact geometry recipe
    // (ZoneBurstSkill's `bladeGeometry`), instanced. World-frame instances,
    // so `frustumCulled = false` is mandatory (27b8397: instance transforms
    // never enter the shared bounding sphere — one missed flag hides the
    // whole tide at certain camera angles).
    this.bladeGeometry = createCrystalGeometry({ seed: 8.4, sides: 4, taper: 0.82, roughness: 0.18, bend: 0.04 });
    this.bladeMaterial = new MeshStandardMaterial({
      color: ice,
      roughness: 0.25,
      metalness: 0.65,
      emissive: gold,
      emissiveIntensity: 0.4
    });
    this.blades = new InstancedMesh(this.bladeGeometry, this.bladeMaterial, BLADE_CAP);
    this.blades.castShadow = true;
    this.blades.frustumCulled = false;
    this.blades.count = 0;
    this.blades.layers.set(LAYER.WORLD);
    this.blades.renderOrder = 2;
    this.group.add(this.blades);

    // Frost-mist ribbon trailing the front — DashStrike's afterimage strip,
    // recoloured (flat additive billboard, no bespoke shader).
    this.ribbon = new RibbonGeometry(RIBBON_NODES);
    this.ribbonMaterial = new MeshBasicMaterial({
      transparent: true,
      opacity: 0.75,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide
    });
    this.ribbonMesh = new Mesh(this.ribbon.geometry, this.ribbonMaterial);
    this.ribbonMesh.frustumCulled = false;
    this.ribbonMesh.layers.set(LAYER.VFX);
    this.ribbonMesh.renderOrder = 6;
    this.group.add(this.ribbonMesh);

    // Per-blade static scatter, rolled once at construction (deterministic
    // formula, not Math.random — a pooled instance re-casts with the same
    // tide shape, same as forkPlacement's own no-rng fallback philosophy).
    this._lat = new Float32Array(BLADE_CAP);
    this._along = new Float32Array(BLADE_CAP);
    this._yaw = new Float32Array(BLADE_CAP);
    for (let i = 0; i < BLADE_CAP; i++) {
      const g = i * 2.399963; // golden angle spin — no two blades line up
      this._lat[i] = Math.sin(g) * 0.92; // ×width at sync time
      this._along[i] = Math.cos(g * 1.7) * 0.55; // metres of fore/aft stagger
      this._yaw[i] = (i % 5) * 0.37 - 0.74;
    }
  }

  createParticles() {
    this.mist = this.ctx.particles.get('bladetide.mist', {
      capacity: 700,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.45
    });
    this.mist.uniforms.uDrag.value = 1.1;
    this.mist.uniforms.uEndSize.value = 0.55;
    this.mist.uniforms.uSizeIn.value = 0.08;
    this.mist.uniforms.uFadeOut.value = 0.5;
    const ice = getColor(this.config.color);
    const gold = getColor(this.config.colorGlow);
    this.mist.setGradient(ice, ice, gold, ice);
  }

  /** No travel phase: the class owns its own out/hover/back clock inside the
   * impact window (class doc) — same instant-arrival override every fusion
   * class uses, and for the same NaN reason (`settings.fusions['0+2']`
   * carries no `speed`). `position` deliberately stays at the origin here:
   * the timeline drive below walks it out and home along the line, so the
   * camera and the inherited light ride the tide's actual front. */
  advance() {
    this.u = 1;
    return true;
  }

  onSpawn() {
    const parents = fusionParents(this.element); // [母, 子] = [金, 水]
    this._wux = settings.combat.wuxingOf[parents[1]] ?? -1; // 子 (水, 2) — mark identity
    this._wuxB = settings.combat.wuxingOf[parents[0]] ?? -1; // 母 (金, 0) — matchup-only
    this._outU = 0;
    this._backU = 1;
    this._mistRate.reset();
    this.blades.count = 0;
    this.ribbon.clear();
  }

  onImpact() {
    // Nothing lands at "arrival" — the timeline below does all the work.
    // (advance() fires this on the first update; the sweeps key off
    // impactTime, which starts accruing the frame after.)
  }

  /**
   * The class-owned timeline (class doc): out → hover → back, keyed off
   * `impactTime` against the three settings windows; the FADE tail (t ≥ 1
   * via the base's own onFade contract) only dissolves the visuals — both
   * sweeps are guaranteed flushed by then (each branch's own end-flush).
   */
  onFade(dt, t) {
    const c = this.config;
    if (t >= 1) {
      // Cosmetic dissolve; both flushes ran on the impact window's last
      // frame in the normal cadence, but a stalled frame can jump straight
      // here — flush both programs too so no enemy is silently skipped.
      if (this._outU < 1) this._sweepOut(1);
      if (this._backU > 0) this._sweepBack(0);
      this._syncBlades(0, -1, saturate(2 - t));
      this.ribbonMaterial.opacity = 0.75 * saturate(2 - t);
      return;
    }
    this.ribbonMaterial.opacity = 0.75;

    const time = this.impactTime;
    if (time < c.outTime) {
      const u = saturate(time / c.outTime);
      this._sweepOut(u);
      this.pointAt(u, this.position);
      this._syncBlades(u, 1, 1);
      this._emitMist(dt, u);
    } else if (time < c.outTime + c.hoverTime) {
      if (this._outU < 1) this._sweepOut(1); // out flush — a stalled frame can jump the boundary
      this.pointAt(1, this.position);
      this._syncBlades(1, 0, 1);
      this._emitMist(dt, 1);
    } else {
      if (this._outU < 1) this._sweepOut(1);
      const u = 1 - saturate((time - c.outTime - c.hoverTime) / c.backTime);
      this._sweepBack(u);
      this.pointAt(u, this.position);
      this._syncBlades(u, -1, 1);
      this._emitMist(dt, u);
    }
    this._syncRibbon();
  }

  onDestroy() {
    // Both dedup identities go back with the cast (class doc) — RunManager's
    // release chain never saw these keys, so this is the ONLY cleanup line.
    this.ctx.enemies?.releaseCast(this);
    this.ctx.enemies?.releaseCast(this._backKey);
    this.blades.count = 0;
    this.ribbon.clear();
  }

  dispose() {
    this.blades.dispose(); // the InstancedMesh's own instance buffers (ZoneBurstSkill precedent)
    this.bladeGeometry.dispose();
    this.bladeMaterial.dispose();
    this.ribbon.geometry.dispose();
    this.ribbonMaterial.dispose();
    super.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Damage                                                              */
  /* ------------------------------------------------------------------ */

  /** The four cast-time factors CombatSystem's `_amp()` folds for every
   * dispatched kind, inlined for a self-resolved class (DashStrike's own
   * onImpact formula) — read live at damage time, so the post-spawn
   * five-field stamping order can never hand a sweep stale values. */
  _amp() {
    return (
      (this.ctx.mods?.damageMult(this.element) ?? 1) *
      (this.autocast ? settings.run.autocastDamage : 1) *
      (this.quenched ? 1.5 : 1) *
      (this.fusionMult ?? 1)
    );
  }

  /** Outbound sweep: sample every `width` metres from wherever the last
   * frame left off up to `u` — damageOnce (keyed by `this`) makes overlap
   * free, exactly CombatSystem's 'sweep' case run class-side. */
  _sweepOut(u) {
    const from = this._outU;
    if (u <= from) return;
    this._outU = u;
    const targets = this.ctx.targets;
    if (!targets) return;
    const c = this.config;
    const amt = c.outDamage * this._amp();
    const stepU = Math.max(0.01, c.width / this.length);
    for (let s = from; ; s += stepU) {
      const uu = Math.min(s, u);
      _p.x = this.origin.x + this.direction.x * this.length * uu;
      _p.z = this.origin.z + this.direction.z * this.length * uu;
      const hits = targets.damageOnce(this, _p, c.width, amt, this._wux, this._wuxB);
      if (hits) this.ctx.stats?.book?.(this.element, amt * hits);
      if (uu >= u) break;
    }
  }

  /** Return sweep: the wavefront walks 1→0; every enemy whose line
   * projection falls inside this frame's swept window is judged
   * individually off its own live `slowed` — slowed pass first, and with
   * its window's lower bound led by one maximum splash reach (0.05 sample
   * radius + the largest body radius + margin), so a slowed body is
   * claimed by its own crit before any plain neighbour's splash can
   * dedup-claim it a frame early (class doc, review fix round). */
  _sweepBack(u) {
    const prev = this._backU;
    if (u >= prev) return;
    this._backU = u;
    if (!this.ctx.enemies) return;
    const e = settings.enemies;
    const look = (0.1 + Math.max(e.swarm.radius, e.ranged.radius, e.tank.radius)) / this.length;
    this._backPass(u - look, prev, true);
    this._backPass(u, prev, false);
  }

  _backPass(lo, hi, wantSlowed) {
    const en = this.ctx.enemies;
    const targets = this.ctx.targets;
    if (!targets) return;
    const c = this.config;
    const amt = c.backDamage * this._amp() * (wantSlowed ? c.backSlowedMult : 1);
    // Downward, damage()'s own idiom: a kill swap-removes from the tail,
    // and the tail was already visited by the time it can land in slot i.
    for (let i = en.count - 1; i >= 0; i--) {
      if (en.slowed[i] > 0 !== wantSlowed) continue;
      const rx = en.x[i] - this.origin.x;
      const rz = en.z[i] - this.origin.z;
      const t = (rx * this.direction.x + rz * this.direction.z) / this.length;
      if (t < lo || t > hi) continue;
      const pad = settings.enemies[BEHAVIORS[en.behavior[i]]].radius;
      const lat = Math.abs(rx * this.side.x + rz * this.side.z);
      if (lat > c.width + pad) continue;
      _hitP.x = en.x[i];
      _hitP.z = en.z[i];
      // Radius 0.05: a point at the body's own centre — the reach pad the
      // hit test adds is the target's own radius, so this can't miss its
      // enemy, and dedup (the back key) caps any hugging-neighbour splash
      // at one hit each (ordering note in the class doc).
      const hits = targets.damageOnce(this._backKey, _hitP, 0.05, amt, this._wux, this._wuxB);
      if (hits) {
        this.ctx.stats?.book?.(this.element, amt * hits);
        if (wantSlowed) this._critPop(_hitP.x, _hitP.z);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* VFX                                                                 */
  /* ------------------------------------------------------------------ */

  /** 回程暴击敌头上冰晶炸裂小花 — one small frost shell per crit. */
  _critPop(x, z) {
    _pos.set(x, 1.2, z);
    this.ctx.bursts?.spawn(BurstMode.FROST, _pos, {
      radius: 0.25,
      endRadius: 1.0,
      life: 0.35,
      intensity: 1.1,
      colorA: getColor(this.config.color),
      colorB: getColor(this.config.colorGlow),
      colorC: getColor(this.config.color)
    });
  }

  /**
   * The swimming blade wall at `u` along the line. `dirSign` leans the
   * blades into their travel (+1 out, -1 home, 0 hover); `alpha` sinks them
   * during the fade tail. 回程更密: the return (and fade) shows the full
   * cap, the outbound a thinner OUT_BLADES of it.
   */
  _syncBlades(u, dirSign, alpha) {
    const c = this.config;
    const shown = dirSign >= 0 && this.impactTime < c.outTime + c.hoverTime ? OUT_BLADES : BLADE_CAP;
    const headX = this.origin.x + this.direction.x * this.length * u;
    const headZ = this.origin.z + this.direction.z * this.length * u;
    const yaw = Math.atan2(this.direction.x, this.direction.z);
    for (let i = 0; i < shown; i++) {
      const bob = Math.sin(this.age * BLADE_BOB + i * 1.7);
      _dummy.position.set(
        headX + this.side.x * this._lat[i] * c.width + this.direction.x * this._along[i],
        0.12 + Math.abs(bob) * 0.22,
        headZ + this.side.z * this._lat[i] * c.width + this.direction.z * this._along[i]
      );
      _dummy.rotation.set(dirSign * TILT + bob * 0.12, yaw + this._yaw[i], bob * 0.08);
      const h = BLADE_LEN * alpha * (0.75 + 0.25 * Math.abs(bob));
      _dummy.scale.set(0.6, Math.max(0.001, h), 0.6);
      _dummy.updateMatrix();
      this.blades.setMatrixAt(i, _dummy.matrix);
    }
    this.blades.count = shown;
    this.blades.instanceMatrix.needsUpdate = true;
  }

  /** Frost mist trailing the front — the ribbon window is DashStrike's own
   * comet-tail read, and the camera is optional on purpose (headless/test
   * ctx carries none; BILLBOARD mode needs it to face the strip). */
  _syncRibbon() {
    const cam = this.ctx.camera;
    if (!cam) return;
    const c = this.config;
    const head = saturate(this._backU < 1 ? this._backU : this._outU);
    const tail = Math.max(0, head - 0.3);
    const span = Math.max(0.02, head - tail);
    const count = Math.min(RIBBON_NODES + 1, Math.max(2, Math.ceil((span * this.length) / 0.4) + 1));
    for (let i = 0; i < count; i++) {
      const t = tail + (i / (count - 1)) * span;
      this.pointAt(t, _ribbonPoints[i]).y = 0.8;
    }
    this.ribbon.build(_ribbonPoints, {
      width: c.width * 0.8,
      mode: RibbonMode.BILLBOARD,
      cameraPosition: cam.position,
      count
    });
    this.ribbonMaterial.color.copy(getColor(this.config.color));
  }

  _emitMist(dt, u) {
    const g = settings.global;
    const count = this._mistRate.tick(dt, MIST_RATE);
    if (count <= 0) return;
    _pos.set(
      this.origin.x + this.direction.x * this.length * u,
      0.35,
      this.origin.z + this.direction.z * this.length * u
    );
    _emit.position = _pos;
    _emit.radius = this.config.width * 0.7;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 0.9;
    _emit.speedVariance = 0.6;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.3;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.55;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.mist.emit(Math.round(count * g.particleCount), _emit);
  }

  get instanceCount() {
    return this.blades.count;
  }
}
