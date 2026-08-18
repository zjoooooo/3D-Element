/**
 * Game-logic checks: pure Node, no renderer. Mirrors the check-clips pattern —
 * every silent way the run mode can rot gets one loud assert here.
 *
 * The render layer (EnemyRenderer) is verified in the browser at integration,
 * not here—it depends on three.js and scene state only available at runtime.
 *
 *   npm run check:game
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createRng } from '../src/run/rng.js';
import { settings, ELEMENTS, ELEMENT_META, permanentAuraElements, CastShape, castShapeOf } from '../src/config/settings.js';
import { TideSchedule, WUXING, WUXING_LABEL, BEATS, FEEDS } from '../src/run/TideSchedule.js';
import { Modifiers, PASSIVES } from '../src/run/Modifiers.js';
import { Loadout } from '../src/run/Loadout.js';
import { UpgradePool } from '../src/run/UpgradePool.js';
import { FUSIONS, fusionId, isFusionId, fusionParents, pairKeyOf } from '../src/run/fusions.js';
import { GameClock } from '../src/run/GameClock.js';
import { Targets } from '../src/run/Targets.js';
import { EnemySystem, BEHAVIORS } from '../src/run/EnemySystem.js';
import { BossSystem } from '../src/run/BossSystem.js';
import { EnemyProjectiles } from '../src/run/EnemyProjectiles.js';
import { CombatSystem, rowFor } from '../src/run/CombatSystem.js';
import { PickupSystem } from '../src/run/PickupSystem.js';
import { PlayerState } from '../src/run/PlayerState.js';
import { canAffordCast, manaCostOf } from '../src/run/manaGate.js';
import { chainHops, resolveTarget } from '../src/abilities/templates/ChainBoltSkill.js';
import { dashTarget, dashLineHits, scaledDashRange } from '../src/abilities/templates/DashStrikeSkill.js';
import {
  VineBlazeSkill,
  zoneTick,
  liveZoneCount,
  forkBudget,
  zoneContaining,
  forkPlacement
} from '../src/abilities/fusions/VineBlazeSkill.js';
import { VolcanoSkill } from '../src/abilities/fusions/VolcanoSkill.js';
import { PrismArraySkill } from '../src/abilities/fusions/PrismArraySkill.js';
import { BladeTideSkill } from '../src/abilities/fusions/BladeTideSkill.js';
import { ThunderMarshSkill } from '../src/abilities/fusions/ThunderMarshSkill.js';
import { FUSION_CLASSES, ABILITY_TYPES } from '../src/abilities/AbilityManager.js';
import { LineSweepSkill } from '../src/abilities/templates/LineSweepSkill.js';
import { ZoneBurstSkill } from '../src/abilities/templates/ZoneBurstSkill.js';
import { TimedAuraSkill } from '../src/abilities/templates/TimedAuraSkill.js';
import { OrbitAuraSkill } from '../src/abilities/templates/OrbitAuraSkill.js';
import { PierceLanceSkill } from '../src/abilities/PierceLanceSkill.js';
import { StormFieldSkill } from '../src/abilities/StormFieldSkill.js';
import { FireBreathSkill } from '../src/abilities/FireBreathSkill.js';
import { MortarRainSkill } from '../src/abilities/MortarRainSkill.js';
import { bpScale, bpAdd, bpReplace, bpFlag, bpCount, bpCountMult } from '../src/run/breakpoints.js';
import { RunManager, tickHitstop, addHitstop } from '../src/run/RunManager.js';
import { Ultimate } from '../src/run/Ultimate.js';
import { sequenceRefund } from '../src/run/sequence.js';
import { STRINGS, t, wuxingWord, wuxingPhrase } from '../src/ui/strings.js';
import { steleGlowAt, DIM_GLOW, bearingOf } from '../src/run/Arena.js';
import { AltarSystem } from '../src/run/AltarSystem.js';
import { mixTint } from '../src/run/TideAtmosphere.js';
import { getColor } from '../src/utils/color.js';
import { GameAudio } from '../src/run/GameAudio.js';
import { applyPerfPreset } from '../src/run/perfPreset.js';
import { P as SIM } from './sim-run.mjs';
import { ScreenFlash } from '../src/effects/ScreenFlash.js';
import { DecalType } from '../src/effects/GroundDecals.js';
// M10 T3: the cone preview is checked against the REAL controller, not a
// hand-copied formula — a mirrored assertion cannot catch the two drifting
// apart, which is exactly the failure M9 T3 shipped. It pulls three.js in and
// builds two ShaderMaterials, which is harmless off-renderer (no GL context is
// ever touched) and is the only render-adjacent import in this file.
import { AimController } from '../src/input/AimController.js';

/* ---- rng: same seed, same stream ---- */
{
  const a = createRng(42);
  const b = createRng(42);
  const seqA = Array.from({ length: 5 }, () => a());
  const seqB = Array.from({ length: 5 }, () => b());
  assert.deepEqual(seqA, seqB, 'rng: identical seeds must replay identically');
  assert.ok(seqA.every((v) => v >= 0 && v < 1), 'rng: values in [0,1)');
  assert.notDeepEqual(
    seqA,
    Array.from({ length: 5 }, createRng(43)),
    'rng: different seeds diverge'
  );
  console.log('ok  rng');
}

/* ---- run numbers: the spec's anchors, kept honest ---- */
{
  const r = settings.run;
  // Spawn budget must never dip — a valley in the curve reads as a bug mid-run.
  let last = 0;
  for (let m = 0; m <= 15; m++) {
    const v = r.spawnBase + r.spawnQuad * m * m;
    assert.ok(v >= last, `run: spawn budget dips at minute ${m}`);
    last = v;
  }
  assert.ok(r.enemyCap === 300, 'run: enemy cap is the spec\'s 300');
  // XP curve lands 26–30 levels given the simulated income (sim-run.mjs's job);
  // here we only pin the curve's shape parameters against drift.
  assert.ok(r.xpBase > 0 && r.xpGrowth > 1, 'run: xp curve is exponential');

  // Every existing element must carry a damage config — a missing row means an
  // ability silently deals nothing.
  for (const element of ELEMENTS) {
    assert.ok(settings.combat[element], `combat: no damage config for ${element}`);
  }

  // The loadout must be six entries long, every entry in ELEMENTS, no duplicates.
  assert.ok(r.loadout.length === 6, 'run: loadout must be six entries');
  assert.ok(r.loadout.every(e => ELEMENTS.includes(e)), 'run: all loadout entries must be in ELEMENTS');
  assert.ok(new Set(r.loadout).size === 6, 'run: loadout must have no duplicates');

  console.log('ok  run settings');
}

/* ---- M6 T2: the thirteen v1 launch skills — data checks ---- */
{
  const NEW_ELEMENTS = [
    'swordrain', 'bladeorbit', 'dashstrike', 'chainbolt', 'lifebloom',
    'frostnova', 'iceshield', 'firering', 'sunwheel',
    'rockspikes', 'boulder', 'quake', 'stoneskin'
  ];

  // M8 T1 revision: the exact roster count moved to the M8 block (single
  // source — it grows once per wave); this block keeps owning "the
  // thirteen are all present with full data", which its loop below does.
  assert.ok(ELEMENTS.length >= 20, 'ELEMENTS: at least the seven originals + thirteen M6 skills');
  for (const element of NEW_ELEMENTS) {
    assert.ok(ELEMENTS.includes(element), `ELEMENTS: missing ${element}`);
    assert.ok(ELEMENT_META[element]?.label, `ELEMENT_META: ${element} needs a label`);
    assert.ok(settings[element], `settings: no block for ${element}`);
    assert.ok(settings.combat[element], `combat: no row for ${element}`);
    assert.equal(typeof settings.combat.wuxingOf[element], 'number', `wuxingOf: missing ${element}`);
  }

  // 锚2.5 战术档法力: exactly the five tactical-tier skills spend 30 mana;
  // every other new skill spends 0 (field present on all thirteen either way).
  const TACTICAL_MANA = ['dashstrike', 'frostnova', 'iceshield', 'quake', 'stoneskin'];
  for (const element of NEW_ELEMENTS) {
    const expected = TACTICAL_MANA.includes(element) ? 30 : 0;
    assert.equal(settings[element].manaCost, expected, `manaCost: ${element} should be ${expected}`);
  }
  assert.equal(
    TACTICAL_MANA.filter((e) => settings[e].manaCost === 30).length,
    5,
    'manaCost: exactly five tactical-tier skills at 30'
  );

  // 锚2 公式带 (spec §8): damage ≈ BASE_DPS × cooldown × 形状系数. Declared list is
  // the six new burst/sweep skills that resolve through CombatSystem's generic
  // dispatch. 勘误 D-M6-1 (controller ruling): the seven legacy skills are
  // exempt, alongside auras/shields/self-resolving specials — their 1.5-3.3×
  // spread over the old paper-anchor band IS the M1-M3 feel-tuning history
  // (per-skill cooldown cuts after damage was set), frozen by this milestone's
  // "现有 7 个手写技能一行不动" rule, not a hand-slip in new data. The band's
  // job — catching an order-of-magnitude mistake in a NEW entry — is fully
  // served by checking only the thirteen. Named explicitly below rather than
  // inferred, so a future kind change can't silently drop a skill out of the
  // check instead of out of the band.
  const EXEMPT = new Set([
    'ice', 'thunder', 'meteor', 'beam', 'snare', 'glacier', 'fireball', // legacy — 勘误 D-M6-1
    'dashstrike', 'chainbolt', // self — resolve their own hits (T6)
    'bladeorbit', 'firering', 'sunwheel', // aura — no cooldown, budgeted directly (BASE_DPS×0.7)
    'iceshield', 'stoneskin' // shield — absorption, not damage/dps
  ]);
  // M8 T1 revision: scope this band to the M6 thirteen — each wave owns its
  // own band block with its own shape table (the M8 block below covers the
  // second wave), so this derivation can't silently swallow future ids.
  const CHECKED = NEW_ELEMENTS.filter((e) => !EXEMPT.has(e));
  assert.equal(CHECKED.length, 6, 'anchor2: expected six formula-checkable M6 skills');

  // spec's shape coefficients (窄线1.3/宽线1.0/小圈1.1/大圈0.8/自身光环0.7/弹道1.2).
  // A lookup, not a numeric threshold classifier — shape is a design category a
  // skill's kind/width/radius don't determine on their own.
  const SHAPE_COEF = {
    swordrain: 0.8, // 大圈 radius 4.0
    lifebloom: 1.1, // 小圈 radius 2.2
    frostnova: 1.1, // 小圈 radius 3.0 (self-centred ring)
    rockspikes: 1.0, // 宽线 width 1.8
    boulder: 1.1, // 小圈 radius 2.4
    quake: 0.8 // 大圈 radius 5.0 (self-centred shockwave)
  };

  // 勘误 D-M6-1: the anchor is the metronome skill as actually tuned, not spec
  // §8's paper value; feel-tuning moved the CD axis. Computed live so it can
  // never drift out of sync with settings.js again (was hardcoded 20/1.2).
  const BASE_DPS = settings.combat.ice.damage / settings.ice.cooldown;

  /** Pure resolver: a checkable skill's sustained DPS. Persistent kinds
   * (lineTick/zoneTick) already carry a `dps` field that spreads its own
   * damage over time — used directly, no cooldown division. Everything else
   * (sweep/burst) is one hit per cast, so dps = damage / cooldown. */
  function dpsOf(element) {
    const row = settings.combat[element];
    return row.dps !== undefined ? row.dps : row.damage / settings[element].cooldown;
  }

  const violations = [];
  for (const element of CHECKED) {
    const coef = SHAPE_COEF[element];
    assert.ok(coef, `anchor2: ${element} needs a shape coefficient`);
    const baseline = BASE_DPS * coef;
    const actual = dpsOf(element);
    const lo = baseline * 0.6, hi = baseline * 1.4;
    if (actual < lo || actual > hi) {
      violations.push(
        `${element}: dps ${actual.toFixed(2)} outside [${lo.toFixed(2)}, ${hi.toFixed(2)}]` +
        ` (baseline ${baseline.toFixed(2)} = ${BASE_DPS.toFixed(2)}×${coef}, ratio ${(actual / baseline).toFixed(2)}x)`
      );
    }
  }
  assert.equal(
    violations.length,
    0,
    `anchor2: ${violations.length} skill(s) outside the \xb140% DPS band:\n  ${violations.join('\n  ')}`
  );

  console.log('ok  M6 T2: thirteen launch skills (elements/mana/anchor2)');
}

/* ---- M8 T1: ten second-wave skills — roster data, anchor2 band, debts ---- */
{
  const WAVE2 = [
    'cyclonecut', 'piercelance', // 金 磁暴 / 破军贯穿
    'stormfield', 'thornroad', // 木 雷暴领域 / 荆棘之路
    'tidalsurge', 'hailstorm', // 水 潮汐涌浪 / 冰雹风暴
    'flamebreath', 'mortarrain', // 火 烈焰喷吐 / 流火雨
    'sandfield', 'stonepillar' // 土 沙暴领域 / 石柱擎天
  ];
  assert.equal(ELEMENTS.length, 30, 'ELEMENTS: twenty v1 + the ten M8 second-wave skills');
  const WANT_WUX = { cyclonecut: 0, piercelance: 0, stormfield: 1, thornroad: 1, tidalsurge: 2, hailstorm: 2, flamebreath: 3, mortarrain: 3, sandfield: 4, stonepillar: 4 };
  for (const el of WAVE2) {
    assert.ok(ELEMENTS.includes(el), `ELEMENTS: missing ${el}`);
    assert.ok(ELEMENT_META[el]?.label, `ELEMENT_META: ${el} needs a label`);
    assert.ok(settings[el], `settings: no block for ${el}`);
    assert.ok(settings.combat[el], `combat: no row for ${el}`);
    assert.equal(settings.combat.wuxingOf[el], WANT_WUX[el], `wuxingOf: ${el}`);
    for (const key of ['lightColor', 'lightIntensity', 'lightRadius']) {
      assert.ok(settings[el][key] !== undefined, `settings.${el}: ${key} (NaN-poison guard)`);
    }
  }

  // Mana tiers, table-driven for THIS batch (the M6 block's own five-only
  // assert is scoped to its thirteen and stays untouched).
  const MANA30 = new Set(['cyclonecut', 'piercelance', 'stormfield', 'hailstorm', 'mortarrain', 'stonepillar']);
  for (const el of WAVE2) {
    assert.equal(settings[el].manaCost, MANA30.has(el) ? 30 : 0, `manaCost tier: ${el}`);
  }

  // 锚2 band for the batch — resolver extended two ways the M6 copy never
  // needed: a `waves` row detonates its damage once per wave (sum the
  // damageMults), and a TIMED dps row (settings[el].life present) spreads
  // dps×life over its cooldown instead of channelling forever.
  const SHAPE2 = {
    cyclonecut: 1.1, // 小圈 (环带 3.0)
    thornroad: 1.0, // 持续线, width 1.2 — 宽线档 (裁: 窄线1.3 属 0.8m 级贯穿线)
    tidalsurge: 1.0, // 宽线 2.6
    hailstorm: 0.8, // 大圈 3.8
    flamebreath: 1.1, // 扇形 — 本里程碑新裁的系数 (小圈级, 待复核)
    mortarrain: 1.2, // 弹道弹幕
    sandfield: 0.8, // 大圈 4.2
    stonepillar: 1.1 // 小圈 2.6
  };
  // piercelance / stormfield are kind:'self' (resolve their own hits —
  // chainbolt precedent, EXEMPT by name here); their budgets are pinned by
  // their own lifecycle tests in T4 (320/8≈40 vs 1.3-band, 52×8/9≈46 vs 0.8-band).
  const BASE = settings.combat.ice.damage / settings.ice.cooldown;
  function dps2(el) {
    const row = settings.combat[el];
    if (row.dps !== undefined) {
      // Two field names for one idea, both live in the codebase: the
      // LineSweep family calls a field's standing time `lifetime`, the M7
      // fusion family calls it `life`. Read either — a timed row that folds
      // as if it channelled forever would sail through the band on a number
      // it never actually sustains (M8 T2 caught exactly that for thornroad).
      const life = settings[el].life ?? settings[el].lifetime;
      return life ? (row.dps * life) / settings[el].cooldown : row.dps;
    }
    const waveSum = (row.waves ?? [{ damageMult: 1 }]).reduce((s, w) => s + w.damageMult, 0);
    return (row.damage * waveSum) / settings[el].cooldown;
  }
  // Completeness (review catch): every wave-2 id is either shape-checked here
  // or an explicitly named self-resolving exemption — deleting a row from
  // SHAPE2 must fail loudly, not quietly drop that skill out of the band.
  const SELF_EXEMPT2 = ['piercelance', 'stormfield'];
  assert.deepEqual(
    [...Object.keys(SHAPE2), ...SELF_EXEMPT2].sort(),
    WAVE2.slice().sort(),
    'anchor2 M8: every second-wave id is either shape-checked or a named self exemption'
  );
  for (const [el, coef] of Object.entries(SHAPE2)) {
    const actual = dps2(el);
    const lo = BASE * coef * 0.6, hi = BASE * coef * 1.4;
    assert.ok(actual >= lo && actual <= hi, `anchor2 M8: ${el} dps ${actual.toFixed(1)} outside [${lo.toFixed(1)}, ${hi.toFixed(1)}]`);
  }

  // 清账: the marsh slow-refresh hold moves from a code literal into the row.
  assert.equal(settings.combat.fusions['2+1'].slowHold, 0.5, "marsh: the 0.5s refresh hold lives in the row now (M7 T6's literal, collected)");
  {
    const slows = [];
    const combat = new CombatSystem({ damage: () => 0, damageOnce: () => 0, damageRing: () => 0, slow: (p, r, f, d) => slows.push(d) });
    const marsh = {
      element: fusionId('iceshield', 'thunder'), phase: 'impact', impactTime: 0.5, fadeTime: 0,
      position: { x: 0, z: 0 }, origin: { x: 0, z: 0 }, direction: { x: 1, z: 0 }, length: 9, u: 1,
      autocast: false, quenched: false, fusionMult: 1
    };
    combat.tick(1 / 60, [marsh]);
    assert.equal(slows[0], 0.5, 'marsh: slow hold reads the row value');
    const saved = settings.combat.fusions['2+1'].slowHold;
    settings.combat.fusions['2+1'].slowHold = 0.7;
    combat.tick(1 / 60, [marsh]);
    assert.equal(slows[1], 0.7, 'marsh: dragging the row value retunes the hold live');
    settings.combat.fusions['2+1'].slowHold = saved;
  }

  // 清账: ThunderMarsh's bolt seed takes ctx.rng when present (App wires the
  // run's seeded rng in T1), keeps the deterministic cycle as fallback.
  {
    const mk = (rng) => {
      const en = new EnemySystem(createRng(61));
      en.spawnAt(8.4, 0, 0, 1);
      en.spawnAt(9.6, 0.4, 0, 1);
      en.spawnAt(10.4, -0.6, 0, 1);
      for (let i = 0; i < en.count; i++) en.hp[i] = 5000;
      const calls = [];
      const ability = new ThunderMarshSkill({
        targets: { damage: (p, r, amt) => (calls.push({ x: p.x, amt }), 0) },
        enemies: en,
        stats: { book: () => {} },
        lights: { acquire: () => null, release: () => {}, set: () => {} },
        particles: { get: () => ({ uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } }, setGradient() {}, emit() {} }) },
        mods: null,
        rng
      }, fusionId('iceshield', 'thunder'));
      ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
      ability.autocast = false;
      ability.fusionMult = 1;
      ability.quenched = false;
      for (let i = 0; i < 150; i++) ability.update(1 / 60); // two bolts
      ability.destroy();
      // first strike of each bolt = every boltHits-th call
      return [calls[0]?.x, calls[settings.fusions['2+1'].boltHits]?.x];
    };
    const constant = mk(() => 0); // rng pinned to 0 → always the first in-pool candidate
    assert.ok(Math.abs(constant[0] - constant[1]) < 1e-6, 'marsh rng: a constant rng seeds every bolt on the same body');
    const cycling = mk(undefined); // no rng → the deterministic _boltSeq cycle
    assert.ok(Math.abs(cycling[0] - cycling[1]) > 1e-6, 'marsh rng: the no-rng fallback still cycles candidates (M7 behaviour intact)');
  }

  console.log('ok  M8 T1: second-wave roster (data/mana tiers/anchor2/slowHold/rng seed)');
}

/* ---- M8 T2: sweep knockback + lineTick slow, and the four template arts ---- */
{
  // Both new row fields follow the boulder/quake precedent exactly: optional,
  // absent means "behave as before", present means one extra composed call.
  const kbCalls = [];
  const slowCalls = [];
  const mkCombat = () => new CombatSystem({
    damage: () => 1,
    damageOnce: () => 1,
    damageRing: () => 1,
    slow: (p, r, f, d) => slowCalls.push({ r, f, d }),
    knockback: (p, r, impulse) => kbCalls.push({ x: p.x, z: p.z, r, impulse })
  });

  // --- sweep.knockback (潮汐涌浪's water wall) ---
  {
    const combat = mkCombat();
    const surge = {
      element: 'tidalsurge', phase: 'travel', u: 0.5,
      position: { x: 3, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 11,
      autocast: false, quenched: false, fusionMult: 1
    };
    combat.tick(1 / 60, [surge]);
    assert.equal(kbCalls.length, 1, 'sweep: a row with knockback shoves once per sampled tick');
    // A RATE, not an impulse (browser catch): a burst-sized shove applied
    // every tick outran the sweep's own damage front — the wall swept bodies
    // it never hit. ×step keeps the total over a pass comparable to one
    // burst impulse and makes it frame-rate independent.
    assert.ok(
      Math.abs(kbCalls[0].impulse - settings.combat.tidalsurge.knockback / 60) < 1e-9,
      "sweep: the shove is the row's own value per SECOND (×step), not a per-tick impulse"
    );
    assert.ok(kbCalls[0].r > 0, 'sweep: the shove covers the sampled width');
    // Centre one width BEHIND the front (browser catch): knockback pushes
    // radially outward, so a centre ON the front drags bodies back the
    // instant it passes them — the wall would sweep, then suck.
    const width = settings.combat.tidalsurge.width;
    assert.ok(
      Math.abs(kbCalls[0].x - (surge.position.x - width)) < 1e-9 && Math.abs(kbCalls[0].z) < 1e-9,
      `sweep: the shove centres one width behind the front (got ${kbCalls[0].x}, want ${surge.position.x - width})`
    );

    // Zero regression: rockspikes (a sweep row with NO knockback) shoves nothing.
    kbCalls.length = 0;
    const spikes = {
      element: 'rockspikes', phase: 'travel', u: 0.5,
      position: { x: 3, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 9,
      autocast: false, quenched: false, fusionMult: 1
    };
    mkCombat().tick(1 / 60, [spikes]);
    assert.equal(kbCalls.length, 0, 'sweep: a row without knockback is byte-identical to before (no shove)');
  }

  // --- lineTick.slowFactor (荆棘之路's tangle) ---
  {
    slowCalls.length = 0;
    const combat = mkCombat();
    const thorn = {
      element: 'thornroad', phase: 'impact', impactTime: 0.2, fadeTime: 0, u: 1,
      position: { x: 5, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 11,
      autocast: false, quenched: false, fusionMult: 1
    };
    combat.tick(1 / 60, [thorn]);
    assert.ok(slowCalls.length > 0, 'lineTick: a row with slowFactor tangles what it burns');
    assert.equal(slowCalls[0].f, settings.combat.thornroad.slowFactor, "lineTick: the tangle reads the row's own factor");
    assert.equal(slowCalls[0].d, settings.combat.thornroad.slowTime, "lineTick: and the row's own duration");

    // Zero regression: beam (a lineTick row with NO slowFactor) never slows.
    slowCalls.length = 0;
    const beam = {
      element: 'beam', phase: 'impact', impactTime: 0.2, fadeTime: 0, u: 1,
      position: { x: 5, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 12,
      autocast: false, quenched: false, fusionMult: 1
    };
    mkCombat().tick(1 / 60, [beam]);
    assert.equal(slowCalls.length, 0, 'lineTick: a row without slowFactor never slows (beam regression)');
  }

  // --- the four arts resolve through the templates they registered on ---
  assert.equal(ABILITY_TYPES.tidalsurge, LineSweepSkill, 'registry: tidalsurge rides LineSweepSkill');
  assert.equal(ABILITY_TYPES.thornroad, LineSweepSkill, 'registry: thornroad rides LineSweepSkill');
  assert.equal(ABILITY_TYPES.hailstorm, ZoneBurstSkill, 'registry: hailstorm rides ZoneBurstSkill');
  assert.equal(ABILITY_TYPES.stonepillar, ZoneBurstSkill, 'registry: stonepillar rides ZoneBurstSkill');

  // Both templates read VFX params straight off `settings[element]` — a
  // missing one reads undefined and NaN-poisons a transform or the light
  // pool (M6 T5/T6 lesson, every fusion class since has paid for it).
  const LINESWEEP_FIELDS = ['spikeCount', 'radius', 'height', 'lifetime', 'riseTime', 'sinkTime', 'facets', 'taper', 'roughness', 'bend', 'lean', 'heightJitter'];
  const ZONEBURST_FIELDS = ['zoneRadius', 'burstLife', 'speed'];
  for (const el of ['tidalsurge', 'thornroad']) {
    for (const f of LINESWEEP_FIELDS) assert.ok(settings[el][f] !== undefined, `settings.${el}: LineSweepSkill reads ${f}`);
  }
  for (const el of ['hailstorm', 'stonepillar']) {
    for (const f of ZONEBURST_FIELDS) assert.ok(settings[el][f] !== undefined, `settings.${el}: ZoneBurstSkill reads ${f}`);
  }

  // 命名统一 (M8 T2): the LineSweep family's own field for "how long the
  // field stands" is `lifetime`; the M7 fusion family called it `life`.
  // thornroad is the first skill to sit in both worlds, so the timed-dps
  // resolver below (and the anchor2 block above) accepts either name —
  // pinned here so a rename can't silently drop a skill out of the band.
  assert.equal(settings.thornroad.life, undefined, 'thornroad: no duplicate `life` — the template field `lifetime` is the single source');
  assert.equal(settings.thornroad.lifetime, 4, 'thornroad: the thorn road stands 4s (数值表)');
  {
    const timedLife = (el) => settings[el].life ?? settings[el].lifetime;
    const dps = (settings.combat.thornroad.dps * timedLife('thornroad')) / settings.thornroad.cooldown;
    const baseline = (settings.combat.ice.damage / settings.ice.cooldown) * 1.0; // 宽线 coefficient
    assert.ok(dps >= baseline * 0.6 && dps <= baseline * 1.4, `anchor2: thornroad ${dps.toFixed(1)} inside the 宽线 band`);
  }

  // --- 常驻 vs 限时 aura (review catch, T3 landmine defused early) ---
  // App derives its permanent-aura roster off `combat[el].kind === 'aura'`
  // and hands every member a free standing cast the moment it is seated —
  // no cooldown, no mana, no five-field write (装备即常驻). The second wave
  // has two TIMED aura rows (磁暴/沙暴领域) that must cast normally, so the
  // discriminator can no longer be the kind alone: a timed row carries its
  // own `life`, a permanent one never does.
  for (const el of ['bladeorbit', 'firering', 'sunwheel']) {
    assert.equal(settings.combat[el].kind, 'aura', `fixture: ${el} is an aura row`);
    assert.equal(settings[el].life, undefined, `permanent aura: ${el} carries no life — it never ends on its own`);
  }
  for (const el of ['cyclonecut', 'sandfield']) {
    assert.equal(settings.combat[el].kind, 'aura', `fixture: ${el} rides the aura kind for its hit test`);
    assert.ok(settings[el].life > 0, `timed aura: ${el} carries a life — an ordinary cast, not a standing one`);
    assert.equal(settings[el].manaCost !== undefined, true, `timed aura: ${el} is priced like a cast`);
  }
  assert.deepEqual(
    permanentAuraElements().slice().sort(),
    ['bladeorbit', 'firering', 'sunwheel'],
    'permanent auras: exactly the three standing rings — a timed field must never be seated as permanent'
  );

  // --- breakpoint card line (review catch): only when the tier exists ---
  // UpgradePool appends `t('bp.<el>.lv3')` at Lv3/Lv5. The second wave has no
  // breakpoint tables, so an unguarded append would print the raw key onto
  // the card ("伤害 +25% · bp.hailstorm.lv3").
  {
    const loadout = new Loadout();
    loadout.acquire('hailstorm');
    while (loadout.levelOf('hailstorm') < 2) loadout.upgrade('hailstorm'); // next draw offers Lv3
    const pool = new UpgradePool(createRng(71), loadout, new Modifiers());
    let sawRawKey = false;
    for (let i = 0; i < 60; i++) {
      for (const card of pool.draw(4, 4) ?? []) {
        if (typeof card.body === 'string' && card.body.includes('bp.')) sawRawKey = true;
      }
    }
    assert.ok(!sawRawKey, 'upgrade card: a skill with no breakpoint table never prints a raw bp.* key');
  }

  console.log('ok  M8 T2: sweep knockback / lineTick slow (+regressions), four template arts, aura/bp guards');
}

/* ---- M8 T3: aura slow field, the magnet's inward pull, TimedAuraSkill ---- */
{
  // --- aura.slowFactor (沙暴领域's 转向迟钝, approximated as a slow) ---
  {
    const slows = [];
    const rings = [];
    const combat = new CombatSystem({
      damage: () => 0, damageOnce: () => 0,
      // Every argument captured on purpose (review catch): a stub that drops
      // the tail silently un-pins whatever the tail carries — the inner
      // radius here, the knockback scale on damageRing below.
      slow: (p, r, f, d, inner) => slows.push({ r, f, d, inner }),
      damageRing: (p, i, o, amt, wux, wuxB, kb) => (rings.push({ inner: i, outer: o, kb }), 1),
      applyVuln: () => {}
    });
    const sand = {
      element: 'sandfield', phase: 'impact', impactTime: 0.5, fadeTime: 0,
      position: { x: 4, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 9, u: 1,
      autocast: false, quenched: false, fusionMult: 1
    };
    combat.tick(1 / 60, [sand]);
    assert.equal(slows.length, 1, 'aura: a row with slowFactor slows what it grinds');
    assert.equal(slows[0].f, settings.combat.sandfield.slowFactor, "aura slow: the row's own factor");
    assert.equal(slows[0].d, settings.combat.sandfield.slowTime, "aura slow: the row's own duration");
    assert.ok(Math.abs(slows[0].r - settings.combat.sandfield.radius) < 1e-9, 'aura slow: covers the whole field');

    // Zero regression: a permanent ring with no slowFactor never slows.
    slows.length = 0;
    const orbit = {
      element: 'bladeorbit', phase: 'travel', age: 1,
      position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 1, u: 0,
      autocast: false, quenched: false, fusionMult: 1
    };
    combat.tick(1 / 60, [orbit]);
    assert.equal(slows.length, 0, 'aura: a row without slowFactor never slows (bladeorbit regression)');

    // The permanent rings' shove must survive the rate conversion untouched:
    // every aura row now states a per-second rate, and the three rings state
    // 60 — which is exactly the one-impulse-per-tick they always applied.
    // Unpinned, "simplifying" the expression divides their shove by sixty and
    // three shipped skills change feel in silence (review catch).
    assert.ok(
      Math.abs(rings[rings.length - 1].kb - 1) < 1e-9,
      `aura: a permanent ring still shoves at the plain baseline (got ${rings[rings.length - 1].kb})`
    );
    assert.ok(
      Math.abs(rings[0].kb - settings.combat.sandfield.kbMult / 60) < 1e-9,
      'aura: a field states its shove as a rate, applied per step'
    );
    // Completeness: no aura row may leave the field out — the `?? 60` in
    // CombatSystem is a guard, not a second convention.
    for (const el of ELEMENTS) {
      if (settings.combat[el]?.kind !== 'aura') continue;
      assert.equal(typeof settings.combat[el].kbMult, 'number', `aura row ${el} must state its own kbMult rate`);
    }

    // The slow's inner radius really reaches the population (three ways to
    // break the thread — the row argument, the guard, the facade — all sailed
    // through before this): a solid field passes 0, a ring passes its edge.
    slows.length = 0; // the bladeorbit regression above emptied it
    combat.tick(1 / 60, [sand]);
    assert.equal(slows[0].inner, 0, 'aura slow: a solid field slows its whole disc');
    {
      const ringRow = { ...settings.combat.sandfield, radius: 4, band: 1 };
      const saved = settings.combat.sandfield;
      settings.combat.sandfield = ringRow;
      slows.length = 0;
      combat.tick(1 / 60, [sand]);
      assert.equal(slows[0].inner, 3, 'aura slow: a ring-shaped field slows only its band, never the eye');
      settings.combat.sandfield = saved;
    }
  }

  // --- 磁暴's negative kbMult: the ring PULLS instead of shoving ---
  {
    // Data pin (review catch): the ratio assertion below is self-referential
    // — it proves the CHANNEL carries the sign, not that the number is the
    // one the 数值表 chose. A rate, not an impulse: an aura's kbMult is
    // multiplied by step, so -3.0 means "three metres per second per second
    // of pull", not "three metres per second, sixty times a second".
    assert.equal(settings.combat.cyclonecut.kbMult, -3.0, "fixture: 磁暴's pull rate, per second");
    assert.equal(settings.combat.sandfield.kbMult, 0, 'fixture: 沙暴 grinds without shoving');
    assert.equal(settings.combat.cyclonecut.band, 2.0, 'fixture: the magnet eye is 1.0m — narrower than a body, so the gather cannot park anyone out of reach');
  }
  {
    const enemies = new EnemySystem(createRng(81));
    const live = new CombatSystem(enemies);
    // On the ring band (radius 3.0, band 2.0 → inner edge 1.0), out along +x.
    const onRing = enemies.spawnAt(6.6, 0, 0, 3); // 2.6m from the cast point at x=4
    enemies.hp[onRing] = 5000;
    const cyclone = {
      element: 'cyclonecut', phase: 'impact', impactTime: 0.3, fadeTime: 0,
      position: { x: 4, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 9, u: 1,
      autocast: false, quenched: false, fusionMult: 1
    };
    const hp0 = enemies.hp[onRing];
    live.tick(1 / 60, [cyclone]);
    assert.ok(enemies.hp[onRing] < hp0, 'magnet: the ring band cuts what stands in it');
    assert.ok(
      enemies.kbX[onRing] < 0,
      `magnet: a negative kbMult pulls the body back toward the centre (got kbX ${enemies.kbX[onRing]})`
    );

    // The pull is proportional: |kbMult| 1.2 against the baseline shove.
    const enemies2 = new EnemySystem(createRng(82));
    const ref = enemies2.spawnAt(6.6, 0, 0, 3);
    enemies2.hp[ref] = 5000;
    enemies2.damageRing({ x: 4, z: 0 }, 0, 3, 1, -1); // default kbScale 1 → outward
    // Ratio against the plain outward shove: sign mirrored, magnitude the
    // row's rate × one step (NOT the raw row value — that was the
    // self-referential form the review caught).
    const ratio = enemies.kbX[onRing] / enemies2.kbX[ref];
    assert.ok(
      Math.abs(ratio - settings.combat.cyclonecut.kbMult / 60) < 1e-4,
      `magnet: one tick of pull is the row's rate × step, mirrored (ratio ${ratio.toFixed(5)}, want ${(settings.combat.cyclonecut.kbMult / 60).toFixed(5)})`
    );

    // Dead centre still takes nothing — band < radius is a genuine annulus
    // (环切) — but the eye is now narrower than a body, so only something
    // sitting exactly on the pin escapes.
    const centre = enemies.spawnAt(4, 0, 0, 3);
    enemies.hp[centre] = 5000;
    const centreHp = enemies.hp[centre];
    live.tick(1 / 60, [cyclone]);
    assert.equal(enemies.hp[centre], centreHp, 'magnet: dead centre is still outside the cutting band');
  }

  // --- TimedAuraSkill: the two fields, headless ---
  assert.equal(ABILITY_TYPES.cyclonecut, TimedAuraSkill, 'registry: cyclonecut rides TimedAuraSkill');
  assert.equal(ABILITY_TYPES.sandfield, TimedAuraSkill, 'registry: sandfield rides TimedAuraSkill');
  for (const el of ['cyclonecut', 'sandfield']) {
    assert.ok(settings[el].shardCount > 0, `${el}: shardCount present — the template builds its ring from it`);
    let acquired = 0, released = 0;
    const decalOpts = [];
    const ctx = {
      lights: { acquire: () => (acquired++, { n: acquired }), release: (h) => { if (h) released++; }, set: () => {} },
      decals: { spawn: (type, pos, opts) => (decalOpts.push({ type, ...opts }), { mesh: { scale: { setScalar: () => {} } }, material: { uniforms: { uColorA: { value: { lerpColors: () => {} } } } } }) },
      particles: {
        get: () => ({
          uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
          setGradient() {}, emit() {}
        })
      },
      mods: null
    };
    const ability = new TimedAuraSkill(ctx, el);
    ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 8);
    ability.autocast = false;
    ability.fusionMult = 1;
    ability.quenched = false;

    // Parked before the first update — combat.tick sees a manual cast once in
    // TRAVEL, and the field must already be on the target (T4 frame-order).
    assert.ok(
      Math.abs(ability.position.x - 8) < 1e-6 && Math.abs(ability.position.z) < 1e-6,
      `${el}: parks at the aimed point at spawn`
    );
    ability.update(1 / 60);
    assert.equal(ability.phase, 'impact', `${el}: reaches IMPACT on the first tick (no travel)`);
    assert.equal(ability.impactDuration, settings[el].life, `${el}: the grind window IS the row's own life`);

    // WYSIWYG (review catch — all three of these sailed through before):
    // the ground mark is the ROW's radius, and the shard ring rides the
    // band's own middle, not the outer rim.
    assert.equal(decalOpts.length, 1, `${el}: one ground mark per cast`);
    // A standing field needs a mark that HOLDS: the CRACK family keeps full
    // alpha for the first 55% of its life, while SHOCKWAVE/DUSTRING animate
    // as one-shot expanding rings and would paint the floor ahead of where
    // the field actually bites (review catch — this pin guards that fix).
    assert.equal(decalOpts[0].type, DecalType.CRACK, `${el}: the mark is a family that stands still`);
    assert.ok(
      Math.abs(decalOpts[0].radius - settings.combat[el].radius) < 1e-9,
      `${el}: the mark on the floor is the footprint that gets hit (got ${decalOpts[0].radius}, row ${settings.combat[el].radius})`
    );
    assert.equal(ability._shards.length, settings[el].shardCount, `${el}: the ring is shardCount shards wide`);
    {
      ability.update(1 / 60); // the orbit is driven from onFade, one frame in
      const row = settings.combat[el];
      const wantR = Math.max(0.2, row.radius - (row.band ?? 0) * 0.5);
      const s = ability._shards[0];
      const gotR = Math.hypot(s.position.x - ability.position.x, s.position.z - ability.position.z);
      assert.ok(
        Math.abs(gotR - wantR) < 1e-6,
        `${el}: shards orbit the band's midline (got ${gotR.toFixed(3)}, want ${wantR.toFixed(3)})`
      );
    }

    for (let i = 0; i < 60; i++) ability.update(1 / 60);
    assert.ok(
      Math.abs(ability.position.x - 8) < 1e-6 && Math.abs(ability.position.z) < 1e-6,
      `${el}: 静置 — the field never follows the player`
    );

    while (!ability.isFinished) ability.update(0.1);
    ability.destroy();
    assert.equal(released, acquired, `${el}: every acquired light came back to the pool`);

    // Pooled re-cast lands at its own new point.
    ability.spawn({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 5);
    ability.update(1 / 60);
    assert.ok(
      Math.abs(ability.position.z - 5) < 1e-6 && Math.abs(ability.position.x) < 1e-6,
      `${el}: a pooled re-cast parks at its own new point`
    );
    ability.destroy();
  }

  // Sandbox shape: no decals/targets/mods, 500 ticks, no throw.
  {
    const bare = new TimedAuraSkill({
      lights: { acquire: () => null, release: () => {}, set: () => {} },
      particles: {
        get: () => ({
          uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
          setGradient() {}, emit() {}
        })
      }
    }, 'cyclonecut');
    bare.autocast = false; bare.fusionMult = 1; bare.quenched = false;
    assert.doesNotThrow(() => {
      bare.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 8);
      for (let i = 0; i < 500; i++) bare.update(1 / 60);
      bare.destroy();
    }, 'TimedAuraSkill: a bare-VFX ctx never throws');
  }

  console.log('ok  M8 T3: aura slow field, magnet pull, TimedAuraSkill lifecycle');
}

/* ---- M8 T4: 破军贯穿 (execute line) + 雷暴领域 (random sky) ---- */
{
  assert.equal(ABILITY_TYPES.piercelance, PierceLanceSkill, 'registry: piercelance');
  assert.equal(ABILITY_TYPES.stormfield, StormFieldSkill, 'registry: stormfield');

  // Data pins (review catch): both skills are NAMED exemptions from the
  // anchor-2 band, and every other assertion in this block reads its
  // expectation out of the same settings value it is checking — so a
  // mistyped number would have sailed through with nothing to stop it.
  assert.equal(settings.piercelance.damage, 320, "fixture: 破军's line damage");
  assert.equal(settings.piercelance.cooldown, 8, "fixture: 破军's cooldown");
  assert.equal(settings.combat.piercelance.executeBelow, 90, 'fixture: the execute floor is absolute hp');
  assert.equal(settings.stormfield.boltDamage, 52, "fixture: one bolt's damage");
  assert.equal(settings.stormfield.boltEvery, 0.75, 'fixture: the bolt cadence');
  assert.equal(settings.stormfield.life, 6, "fixture: the field's life");

  const mkCtx = (enemies, extra = {}) => ({
    targets: enemies,
    enemies,
    stats: { book: () => {} },
    lights: { acquire: () => null, release: () => {}, set: () => {} },
    decals: { spawn: () => ({ mesh: { scale: { setScalar: () => {} } }, material: { uniforms: { uColorA: { value: { lerpColors: () => {} } } } } }) },
    bursts: { spawn: () => {} },
    particles: {
      get: () => ({
        uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
        setGradient() {}, emit() {}
      })
    },
    mods: null,
    ...extra
  });

  // --- 破军贯穿: one hit per body down a long narrow line, then execute ---
  {
    const enemies = new EnemySystem(createRng(91));
    const cfg = settings.piercelance;
    // 木 bodies (wuxing 1): 金克木 → the lance's own advantage applies, so
    // the amounts below are the matchup'd ones; the execute threshold is an
    // absolute hp floor and doesn't care.
    const near = enemies.spawnAt(3, 0, 0, 1);
    const far = enemies.spawnAt(11, 0, 0, 1);
    const offLine = enemies.spawnAt(6, 3.5, 0, 1); // well outside width 0.8
    const doomed = enemies.spawnAt(8, 0, 0, 1);
    const spared = enemies.spawnAt(9, 0, 0, 1);
    for (const i of [near, far, offLine]) enemies.hp[i] = 50000;
    // Off the line and nearly dead: the execute must not reach it. Without
    // this body a footprint widened to the whole arena passed unnoticed
    // (review sabotage) — every other test body was at full health.
    const bystander = enemies.spawnAt(6, 3.5, 0, 1);
    enemies.hp[bystander] = 10;
    const idBystander = enemies.id[bystander];
    enemies.hp[doomed] = settings.combat.piercelance.executeBelow - 1; // under the floor
    // Comfortably over the floor even after a matchup'd hit (金克木 ×1.25
    // turns 320 into 400 — the first fixture landed exactly ON the floor).
    enemies.hp[spared] = settings.combat.piercelance.executeBelow + 700;
    const idDoomed = enemies.id[doomed];
    const idSpared = enemies.id[spared];
    const hp0 = [enemies.hp[near], enemies.hp[far], enemies.hp[offLine]];

    const lance = new PierceLanceSkill(mkCtx(enemies), 'piercelance');
    lance.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, cfg.range);
    lance.autocast = false; lance.fusionMult = 1; lance.quenched = false;
    for (let i = 0; i < 30; i++) lance.update(1 / 60);

    const dealtNear = hp0[0] - enemies.hp[near];
    const dealtFar = hp0[1] - enemies.hp[far];
    assert.ok(dealtNear > 0, 'lance: a body on the line is run through');
    assert.ok(
      Math.abs(dealtNear - dealtFar) < 1e-2,
      `lance: every body on the line takes the same single hit (near ${dealtNear.toFixed(1)}, far ${dealtFar.toFixed(1)})`
    );
    assert.equal(enemies.hp[offLine], hp0[2], 'lance: nothing off the line is touched');
    const alive = new Set(Array.from({ length: enemies.count }, (_, i) => enemies.id[i]));
    assert.ok(!alive.has(idDoomed), 'lance: a body under the execute floor is finished outright');
    assert.ok(alive.has(idSpared), 'lance: a body over the floor survives its hit');
    assert.ok(alive.has(idBystander), 'lance: a dying body OFF the line is not executed — the floor sweeps the lance\'s own footprint, nothing wider');

    // Hitting once means once: a second sweep over the same cast adds nothing.
    const settled = enemies.hp[near];
    for (let i = 0; i < 30; i++) lance.update(1 / 60);
    assert.equal(enemies.hp[near], settled, 'lance: the line resolves exactly once per cast (dedup)');
    while (!lance.isFinished) lance.update(0.1);
    lance.destroy();
    assert.equal(enemies._hitMemory.size, 0, 'lance: its dedup set goes back with the cast — no leak');

    // The amp chain is real, not decorative: a self-resolved class applies
    // the four cast-time factors by hand, and with every fixture flag left
    // at its identity value the whole chain could be deleted unnoticed
    // (review sabotage). Quench is the cheapest of the four to prove.
    {
      const q = new EnemySystem(createRng(94));
      // 火 body: the lance (金) is BEATEN by it, so no overcoming debuff is
      // left behind — a 木 body picks up 断枝 from the first cast and the
      // second one reads 1.5 × 1.15 instead of a clean 1.5.
      const body = q.spawnAt(4, 0, 0, 3);
      q.hp[body] = 50000;
      const plainBefore = q.hp[body];
      const plain = new PierceLanceSkill(mkCtx(q), 'piercelance');
      plain.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, cfg.range);
      plain.autocast = false; plain.fusionMult = 1; plain.quenched = false;
      for (let i = 0; i < 20; i++) plain.update(1 / 60);
      const plainDealt = plainBefore - q.hp[body];
      plain.destroy();

      const hotBefore = q.hp[body];
      const hot = new PierceLanceSkill(mkCtx(q), 'piercelance');
      hot.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, cfg.range);
      hot.autocast = false; hot.fusionMult = 1; hot.quenched = true;
      for (let i = 0; i < 20; i++) hot.update(1 / 60);
      const hotDealt = hotBefore - q.hp[body];
      hot.destroy();
      assert.ok(
        Math.abs(hotDealt / plainDealt - 1.5) < 1e-3,
        `lance: a quenched cast lands 1.5x (got ${(hotDealt / plainDealt).toFixed(3)})`
      );
    }
  }

  // --- 雷暴领域: a bolt every boltEvery seconds, inside the field only ---
  {
    const enemies = new EnemySystem(createRng(92));
    const cfg = settings.stormfield;
    const inField = enemies.spawnAt(9, 0, 0, 2);
    const alsoIn = enemies.spawnAt(10.5, 1.5, 0, 2);
    const outside = enemies.spawnAt(30, 0, 0, 2);
    for (const i of [inField, alsoIn, outside]) enemies.hp[i] = 50000;
    const before = enemies.hp[inField] + enemies.hp[alsoIn];

    const storm = new StormFieldSkill(mkCtx(enemies), 'stormfield');
    storm.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
    storm.autocast = false; storm.fusionMult = 1; storm.quenched = false;
    storm.update(1 / 60);
    assert.equal(storm.phase, 'impact', 'storm: the field stands on the first tick');
    assert.equal(storm.impactDuration, cfg.life, "storm: the field's window is its own life");

    for (let i = 0; i < 40; i++) storm.update(1 / 60); // ≈0.68s — before the first bolt
    assert.equal(enemies.hp[inField] + enemies.hp[alsoIn], before, 'storm: no bolt before the first interval');
    for (let i = 0; i < 10; i++) storm.update(1 / 60); // ≈0.85s — past 0.75
    const afterOne = enemies.hp[inField] + enemies.hp[alsoIn];
    assert.ok(
      Math.abs(before - afterOne - cfg.boltDamage) < 1e-2,
      `storm: one bolt strikes one body for boltDamage (got ${(before - afterOne).toFixed(2)}, want ${cfg.boltDamage})`
    );

    while (!storm.isFinished) storm.update(1 / 60);
    const total = before - (enemies.hp[inField] + enemies.hp[alsoIn]);
    const wantBolts = Math.floor(cfg.life / cfg.boltEvery);
    assert.ok(
      Math.abs(total - wantBolts * cfg.boltDamage) < 1e-1,
      `storm: ${wantBolts} bolts over the field's life (got ${(total / cfg.boltDamage).toFixed(2)} bolts' worth)`
    );
    assert.equal(enemies.hp[outside], 50000, 'storm: nothing outside the field is ever struck');
    storm.destroy();
  }

  // --- both are seeded when a run supplies rng, deterministic without ---
  {
    const roll = (rng) => {
      const enemies = new EnemySystem(createRng(93));
      for (let i = 0; i < 5; i++) enemies.spawnAt(8 + i * 0.7, (i % 2 ? 1 : -1) * 0.9, 0, 2);
      for (let i = 0; i < enemies.count; i++) enemies.hp[i] = 50000;
      const hits = [];
      const ctx = mkCtx(enemies, { targets: { damage: (p, r, amt) => (hits.push(Math.round(p.x * 1000)), 0) }, rng });
      const s = new StormFieldSkill(ctx, 'stormfield');
      s.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
      s.autocast = false; s.fusionMult = 1; s.quenched = false;
      while (!s.isFinished) s.update(1 / 60);
      s.destroy();
      return hits;
    };
    const a = roll(undefined);
    const b = roll(undefined);
    assert.deepEqual(a, b, 'storm: with no rng the strike sequence is deterministic (replayable headless)');
    const seeded = roll(createRng(7));
    assert.equal(seeded.length, a.length, 'storm: a seeded run strikes just as often');
    // The two branches must be genuinely different code paths — the M8 T1
    // marsh test proves this by construction, T4's first cut only proved
    // each was repeatable, so ignoring ctx.rng entirely passed (review
    // sabotage). A constant rng always picks the first candidate; the
    // fallback cycles them.
    const constant = roll(() => 0);
    assert.ok(
      constant.some((x, i) => x !== a[i]) || constant.length !== a.length,
      'storm: a seeded pick really consults the rng rather than falling through to the cycle'
    );
    assert.ok(new Set(constant).size === 1, 'storm: a constant rng strikes the same body every time');
    const seededAgain = roll(createRng(7));
    assert.deepEqual(seeded, seededAgain, 'storm: the same seed replays the same sky');
  }

  // --- sandbox shape ---
  for (const [Klass, el] of [[PierceLanceSkill, 'piercelance'], [StormFieldSkill, 'stormfield']]) {
    const bare = new Klass({
      lights: { acquire: () => null, release: () => {}, set: () => {} },
      particles: {
        get: () => ({
          uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
          setGradient() {}, emit() {}
        })
      }
    }, el);
    bare.autocast = false; bare.fusionMult = 1; bare.quenched = false;
    assert.doesNotThrow(() => {
      bare.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
      for (let i = 0; i < 600; i++) bare.update(1 / 60);
      bare.destroy();
    }, `${el}: a bare-VFX ctx never throws`);
  }

  console.log('ok  M8 T4: pierce lance (line/execute/dedup) + storm field (cadence/bounds/seed)');
}

/* ---- M8 T5: the cone — a new judged shape, and 烈焰喷吐 that rides it ---- */
{
  const row = settings.combat.flamebreath;
  assert.equal(row.kind, 'coneTick', "fixture: 烈焰喷吐 is the milestone's one new kind");
  assert.equal(row.halfAngle, 0.55, 'fixture: 数值表 halfAngle');
  assert.equal(row.range, 5.5, 'fixture: 数值表 range');
  assert.equal(row.dps, 200, 'fixture: 数值表 dps');

  // --- EnemySystem.damageCone: the geometry ---
  {
    const enemies = new EnemySystem(createRng(101));
    // Cone points down +x from the origin, half-angle 0.55 rad (~31.5°).
    const straight = enemies.spawnAt(3, 0, 0, 1); // dead ahead
    const edgeIn = enemies.spawnAt(3, 1.5, 0, 1); // atan(1.5/3) = 0.46 rad — inside
    const edgeOut = enemies.spawnAt(3, 3.5, 0, 1); // atan(3.5/3) = 0.86 rad — outside, and its pad can't save it
    const behind = enemies.spawnAt(-3, 0, 0, 1); // directly behind
    const tooFar = enemies.spawnAt(9, 0, 0, 1); // on axis but past the range
    for (let i = 0; i < enemies.count; i++) enemies.hp[i] = 5000;
    const hp0 = Array.from({ length: enemies.count }, (_, i) => enemies.hp[i]);

    const hits = enemies.damageCone({ x: 0, z: 0 }, 1, 0, 0.55, 5.5, 10, -1);
    assert.equal(hits, 2, 'cone: exactly the two bodies inside the wedge are hit');
    assert.ok(enemies.hp[straight] < hp0[straight], 'cone: dead ahead is hit');
    assert.ok(enemies.hp[edgeIn] < hp0[edgeIn], 'cone: inside the wedge is hit');
    assert.equal(enemies.hp[edgeOut], hp0[edgeOut], 'cone: outside the wedge is spared');
    assert.equal(enemies.hp[behind], hp0[behind], 'cone: behind the caster is spared');
    assert.equal(enemies.hp[tooFar], hp0[tooFar], 'cone: past the range is spared');

    // The pad on the ACROSS-axis edge, which is the whole reason the test
    // splits along/offset instead of comparing an angle: a tank's centre can
    // sit outside the wedge while its body is plainly in the flame. Removing
    // the `+ kind.radius` term passed every other assertion here (review
    // sabotage) because no fixture body straddled the edge.
    {
      const fat = new EnemySystem(createRng(106));
      // along 3, offset 2.34: the edge at that depth is 3·tan(0.55) = 1.93,
      // so the centre is 0.41 outside — inside only once its 0.7 radius pads.
      const tank = fat.spawnAt(3, 2.34, 0, 1, 2);
      fat.hp[tank] = 5000;
      assert.equal(fat.damageCone({ x: 0, z: 0 }, 1, 0, 0.55, 5.5, 10, -1), 1, "cone: a wide body straddling the edge is in the flame");
      const thin = new EnemySystem(createRng(107));
      thin.spawnAt(3, 2.34, 0, 1, 0); // swarm, radius 0.45 — still short of the edge
      assert.equal(thin.damageCone({ x: 0, z: 0 }, 1, 0, 0.55, 5.5, 10, -1), 0, 'cone: a slim body at the same spot stays out');
    }

    // Point blank: a body standing on the apex has no bearing to speak of
    // and is inside by construction — a flamethrower does not spare whoever
    // is hugging you.
    {
      const hug = new EnemySystem(createRng(105));
      const onTop = hug.spawnAt(0, 0, 0, 1);
      hug.hp[onTop] = 5000;
      assert.equal(hug.damageCone({ x: 0, z: 0 }, 1, 0, 0.55, 5.5, 10, -1), 1, 'cone: point blank is inside the wedge');
    }

    // A body's own radius pads the reach, exactly like every other area test
    // in this file — a fat body just past the rim still clips the flame.
    {
      const pad = new EnemySystem(createRng(102));
      const grazing = pad.spawnAt(5.8, 0, 0, 1); // 0.3m past range 5.5, body radius 0.45
      pad.hp[grazing] = 5000;
      assert.equal(pad.damageCone({ x: 0, z: 0 }, 1, 0, 0.55, 5.5, 10, -1), 1, 'cone: the range pads by the body radius');
    }

    // Dual-wuxing threads through the same _applyWux every other shape uses.
    {
      const dual = new EnemySystem(createRng(103));
      const body = dual.spawnAt(2, 0, 0, 3); // 火 body
      dual.hp[body] = 5000;
      const before = dual.hp[body];
      dual.damageCone({ x: 0, z: 0 }, 1, 0, 0.55, 5.5, 10, 0, 2); // 子金 vs 母水 → 水克火 1.25
      assert.ok(
        Math.abs(before - dual.hp[body] - 10 * settings.combat.matchup.advantage) < 1e-3,
        'cone: takes the better of the two candidates, like every other hit'
      );
    }
  }

  // --- Targets facade degrades quietly for a population without cones ---
  {
    const targets = new Targets();
    targets.register({ hits: () => false, damage: () => 0 });
    assert.doesNotThrow(() => targets.damageCone({ x: 0, z: 0 }, 1, 0, 0.5, 4, 10, -1), 'Targets.damageCone: degrades quietly');
    const got = [];
    targets.register({
      hits: () => false, damage: () => 0,
      damageCone: (p, dx, dz, half, range, amt, wux, wuxB) => (got.push({ dx, dz, half, range, amt, wux, wuxB }), 2)
    });
    const total = targets.damageCone({ x: 0, z: 0 }, 1, 0, 0.5, 4, 10, 3, 4);
    assert.equal(total, 2, 'Targets.damageCone: sums what the populations report');
    assert.deepEqual(got[0], { dx: 1, dz: 0, half: 0.5, range: 4, amt: 10, wux: 3, wuxB: 4 }, 'Targets.damageCone: arguments pass through verbatim');
  }

  // --- CombatSystem's coneTick case ---
  {
    const cones = [];
    const combat = new CombatSystem({
      damage: () => 0, damageOnce: () => 0, damageRing: () => 0, slow: () => {},
      damageCone: (p, dx, dz, half, range, amt, wux, wuxB, kb) => (cones.push({ x: p.x, dx, dz, half, range, amt, wux, wuxB, kb }), 1)
    });
    const breath = {
      element: 'flamebreath', phase: 'impact', impactTime: 0.2, fadeTime: 0,
      position: { x: 2, z: 0 }, origin: { x: 1, z: 0 },
      direction: { x: 0, z: 1 }, length: 5.5, u: 1,
      autocast: false, quenched: false, fusionMult: 1
    };
    combat.tick(1 / 60, [breath]);
    assert.equal(cones.length, 1, 'coneTick: one sweep per tick');
    assert.equal(cones[0].x, 1, "coneTick: the wedge starts at the caster's ORIGIN, not the front");
    assert.equal(cones[0].dz, 1, "coneTick: and points down the cast's own direction");
    assert.ok(Math.abs(cones[0].amt - row.dps / 60) < 1e-9, 'coneTick: dps × step, like every other persistent kind');
    assert.equal(cones[0].half, row.halfAngle, "coneTick: the row's own half-angle");
    assert.equal(cones[0].range, row.range, "coneTick: the row's own range");

    // The shove channel, declared: a breath burns rather than pushes, and
    // any value it did carry would be per second. Unpinned, the first cut
    // applied a full impulse every tick and blew bodies out of their own
    // flame at 30 m/s (review catch — the fourth such channel this milestone).
    assert.equal(settings.combat.flamebreath.kbMult, 0, 'fixture: 龙息只烧不推');
    for (const el of ELEMENTS) {
      if (settings.combat[el]?.kind !== 'coneTick') continue;
      assert.equal(typeof settings.combat[el].kbMult, 'number', `coneTick row ${el} must declare its own kbMult rate`);
    }
    assert.equal(cones[0].kb, 0, 'coneTick: the row is passed its shove as a per-step rate (0 here)');

    // One range, not two: the cast block drives aiming, the combat row drives
    // burning — they must be the same number or the flame and the reticle part.
    assert.equal(settings.flamebreath.range, settings.combat.flamebreath.range, 'flamebreath: aiming range and judged range are one number');

    // All three breakpoint consumers at once (review catch: each could be
    // deleted unnoticed, because a level-1 fixture makes bpScale the identity
    // — `cones[0].half === row.halfAngle` proves nothing on its own).
    // Injected the way the marsh test injects a row value, and put back.
    {
      const saved = settings.flamebreath.breakpoints;
      settings.flamebreath.breakpoints = { lv3: { dps: 2, halfAngle: 1.5, range: 3 } };
      const scaled = [];
      const lv3 = new CombatSystem(
        { damage: () => 0, damageOnce: () => 0, damageRing: () => 0, slow: () => {},
          damageCone: (p, dx, dz, half, range, amt) => (scaled.push({ half, range, amt }), 1) },
        null,
        () => 3
      );
      breath.phase = 'impact';
      lv3.tick(1 / 60, [breath]);
      assert.ok(Math.abs(scaled[0].amt - (row.dps * 2) / 60) < 1e-9, 'coneTick: dps rides its breakpoint');
      assert.ok(Math.abs(scaled[0].half - row.halfAngle * 1.5) < 1e-9, 'coneTick: halfAngle rides its breakpoint');
      assert.ok(Math.abs(scaled[0].range - row.range * 3) < 1e-9, 'coneTick: range rides its breakpoint');
      settings.flamebreath.breakpoints = saved;
      if (saved === undefined) delete settings.flamebreath.breakpoints;
    }

    // A wedge at or past a right angle is not a wedge — and the geometry
    // clamps `tan` there, so a row must never ask for one.
    for (const el of ELEMENTS) {
      if (settings.combat[el]?.kind !== 'coneTick') continue;
      assert.ok(settings.combat[el].halfAngle < Math.PI / 2, `coneTick row ${el}: half-angle stays under a right angle`);
    }

    // Timed window: fade breathes nothing (T4's rule for timed shapes).
    breath.phase = 'fade';
    breath.fadeTime = 0.1;
    combat.tick(1 / 60, [breath]);
    assert.equal(cones.length, 1, 'coneTick: the fade tail deals nothing');
  }

  // --- FireBreathSkill lifecycle ---
  assert.equal(ABILITY_TYPES.flamebreath, FireBreathSkill, 'registry: flamebreath');
  {
    const enemies = new EnemySystem(createRng(104));
    const ahead = enemies.spawnAt(3, 0, 0, 4); // 土 body — 火克土
    enemies.hp[ahead] = 50000;
    const before = enemies.hp[ahead];
    const ctx = {
      targets: enemies, enemies, stats: { book: () => {} },
      lights: { acquire: () => null, release: () => {}, set: () => {} },
      decals: { spawn: () => null }, bursts: { spawn: () => {} },
      particles: {
        get: () => ({
          uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
          setGradient() {}, emit() {}
        })
      },
      mods: null
    };
    const breath = new FireBreathSkill(ctx, 'flamebreath');
    breath.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, settings.flamebreath.range);
    breath.autocast = false; breath.fusionMult = 1; breath.quenched = false;
    // Driven the way a real frame does: the class is pure VFX, the coneTick
    // row is the mechanism, so CombatSystem has to tick alongside it.
    const live = new CombatSystem(enemies);
    breath.update(1 / 60);
    assert.equal(breath.phase, 'impact', 'breath: channels from the first tick');
    assert.equal(breath.impactDuration, settings.flamebreath.life, "breath: the channel IS the row's own life");
    // The horde has to MOVE for this to mean anything (review catch): a
    // knockback channel that blows its own targets out of the flame is
    // invisible to a test whose bodies are nailed down. This one line is
    // what turns the assertion below into a real delivery check.
    for (let i = 0; i < 60; i++) {
      live.tick(1 / 60, [breath]);
      breath.update(1 / 60);
      enemies.tick(1 / 60, { x: 0, z: 0 }, 0);
    }
    assert.ok(before - enemies.hp[ahead] > 100, `breath: a body in the wedge burns steadily (got ${(before - enemies.hp[ahead]).toFixed(0)})`);
    const burned = enemies.hp[ahead];
    while (!breath.isFinished) { live.tick(1 / 60, [breath]); breath.update(1 / 60); enemies.tick(1 / 60, { x: 0, z: 0 }, 0); }
    assert.ok(enemies.hp[ahead] < burned, 'breath: it keeps burning for the rest of the channel');
    breath.destroy();

    const bare = new FireBreathSkill({
      lights: { acquire: () => null, release: () => {}, set: () => {} },
      particles: {
        get: () => ({
          uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
          setGradient() {}, emit() {}
        })
      }
    }, 'flamebreath');
    bare.autocast = false; bare.fusionMult = 1; bare.quenched = false;
    assert.doesNotThrow(() => {
      bare.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 5.5);
      for (let i = 0; i < 400; i++) bare.update(1 / 60);
      bare.destroy();
    }, 'breath: a bare-VFX ctx never throws');
  }

  console.log('ok  M8 T5: cone geometry, coneTick case, FireBreathSkill');
}

/* ---- M8 T6: 流火雨 — five shells, scattered, on the volcano's own machine ---- */
{
  assert.equal(ABILITY_TYPES.mortarrain, MortarRainSkill, 'registry: mortarrain');
  const row = settings.combat.mortarrain;
  const cfg = settings.mortarrain;
  assert.equal(row.waves.length, 5, 'fixture: five shells (数值表)');
  assert.equal(row.damage, 80, "fixture: one shell's damage");
  assert.equal(row.radius, 1.6, "fixture: one shell's radius");
  assert.equal(cfg.scatterRadius, 3.5, 'fixture: the scatter (数值表)');
  assert.deepEqual(
    row.waves.map((w) => w.delay),
    [0.5, 1.0, 1.5, 2.0, 2.5],
    'fixture: the shells walk in at half-second intervals'
  );

  const mkCtx = (extra = {}) => ({
    lights: { acquire: () => null, release: () => {}, set: () => {} },
    decals: { spawn: () => null }, bursts: { spawn: () => {} },
    particles: {
      get: () => ({
        uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
        setGradient() {}, emit() {}
      })
    },
    mods: null,
    ...extra
  });

  {
    const rain = new MortarRainSkill(mkCtx(), 'mortarrain');
    rain.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 12);
    rain.autocast = false; rain.fusionMult = 1; rain.quenched = false;
    rain.update(1 / 60);
    assert.equal(rain.phase, 'impact', 'rain: the barrage opens on the first tick (no travel)');
    assert.ok(
      rain.impactDuration >= row.waves[row.waves.length - 1].delay,
      "rain: the cast outlives its own last shell (impactDuration covers the walk-in)"
    );

    // Five landing points, every one inside the scatter of the aimed centre.
    assert.equal(rain._shellX.length, row.waves.length, 'rain: one landing point per shell');
    for (let i = 0; i < row.waves.length; i++) {
      const d = Math.hypot(rain._shellX[i] - 12, rain._shellZ[i]);
      assert.ok(d <= cfg.scatterRadius + 1e-4, `rain: shell ${i} lands within the scatter (got ${d.toFixed(3)})`);
    }
    // Deterministic without an rng — the same fallback every scattering class
    // in this codebase shares, so a headless replay lands the same pattern.
    const firstX = Array.from(rain._shellX);
    rain.destroy();
    rain.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 12);
    rain.update(1 / 60);
    assert.deepEqual(Array.from(rain._shellX), firstX, 'rain: the fallback pattern is repeatable');

    // …and genuinely seeded when a run supplies one.
    const seeded = new MortarRainSkill(mkCtx({ rng: createRng(11) }), 'mortarrain');
    seeded.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 12);
    seeded.autocast = false; seeded.fusionMult = 1; seeded.quenched = false;
    seeded.update(1 / 60);
    assert.ok(
      Array.from(seeded._shellX).some((x, i) => Math.abs(x - firstX[i]) > 1e-6),
      'rain: a seeded cast really consults the rng rather than falling through'
    );
    const replay = new MortarRainSkill(mkCtx({ rng: createRng(11) }), 'mortarrain');
    replay.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 12);
    replay.autocast = false; replay.fusionMult = 1; replay.quenched = false;
    replay.update(1 / 60);
    assert.deepEqual(Array.from(replay._shellX), Array.from(seeded._shellX), 'rain: the same seed replays the same pattern');
    seeded.destroy(); replay.destroy(); rain.destroy();
  }

  // The hand-off: CombatSystem walks the wave cursor, the class walks the
  // position — each shell must detonate at its OWN landing point, which is
  // the whole reason this class exists (the volcano's contract, reused).
  {
    const hits = [];
    const combat = new CombatSystem({
      damage: (p, r, amt) => (hits.push({ x: p.x, z: p.z, r, amt }), 1),
      damageOnce: () => 1, damageRing: () => 1, slow: () => {}, damageCone: () => 0
    });
    const rain = new MortarRainSkill(mkCtx(), 'mortarrain');
    rain.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 12);
    rain.autocast = false; rain.fusionMult = 1; rain.quenched = false;
    for (let i = 0; i < 200; i++) {
      combat.tick(1 / 60, [rain]);
      rain.update(1 / 60);
    }
    assert.equal(hits.length, row.waves.length, `rain: exactly ${row.waves.length} shells detonate`);
    for (let i = 0; i < hits.length; i++) {
      const d = Math.hypot(hits[i].x - rain._shellX[i], hits[i].z - rain._shellZ[i]);
      assert.ok(d < 1e-6, `rain: shell ${i} detonates at its own landing point, not the aim point (off by ${d.toFixed(4)})`);
    }
    const spread = Math.max(...hits.map((h) => Math.hypot(h.x - hits[0].x, h.z - hits[0].z)));
    assert.ok(spread > 0.5, `rain: the five craters are actually spread apart (widest gap ${spread.toFixed(2)}m)`);
    assert.ok(Math.abs(hits[0].amt - row.damage) < 1e-9, "rain: a shell lands the row's own damage");
    rain.destroy();
  }

  // Sandbox shape.
  {
    const bare = new MortarRainSkill({
      lights: { acquire: () => null, release: () => {}, set: () => {} },
      particles: {
        get: () => ({
          uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
          setGradient() {}, emit() {}
        })
      }
    }, 'mortarrain');
    bare.autocast = false; bare.fusionMult = 1; bare.quenched = false;
    assert.doesNotThrow(() => {
      bare.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 12);
      for (let i = 0; i < 400; i++) bare.update(1 / 60);
      bare.destroy();
    }, 'rain: a bare-VFX ctx never throws');
  }

  console.log('ok  M8 T6: mortar rain (five shells, scatter, per-shell hand-off)');
}


/* ---- M9 T1: the draft draws by CATEGORY, not by how many cards exist ---- */
{
  // Measured before this task: the ten skills M8 added pushed new-skill cards
  // from 68% of a hand to 77% at four seats, squeezing upgrades 20→15 and
  // passives 12→9 — because `passiveWeights` was applied per CANDIDATE, so a
  // category's share scaled with how many of its cards happened to exist.
  // The weights are a category contract now: registering more skills must not
  // move the shape of a hand.
  const WAVE2 = ['cyclonecut', 'piercelance', 'stormfield', 'thornroad', 'tidalsurge',
                 'hailstorm', 'flamebreath', 'mortarrain', 'sandfield', 'stonepillar'];

  /** Deal `trials` hands at `seats` filled and report the share of each kind. */
  function shares(seats, hide = []) {
    // The registry is a module singleton — restore it even if a draw throws,
    // or every later block in this file runs against a roster short by ten
    // (review catch).
    const stash = {};
    for (const el of hide) { stash[el] = ABILITY_TYPES[el]; delete ABILITY_TYPES[el]; }
    const seen = { upgrade: 0, new: 0, passive: 0, fusion: 0 };
    let cards = 0;
    try {
      const seatable = ELEMENTS.filter((e) => ABILITY_TYPES[e] && !WAVE2.includes(e));
      for (let t = 0; t < 400; t++) {
        const loadout = new Loadout();
        for (let s = 0; s < seats; s++) loadout.acquire(seatable[(t * 7 + s * 3) % seatable.length]);
        const pool = new UpgradePool(createRng(t + 1), loadout, new Modifiers());
        for (const card of pool.draw(6, 6) ?? []) { seen[card.kind]++; cards++; }
      }
    } finally {
      for (const el of hide) ABILITY_TYPES[el] = stash[el];
    }
    const out = {};
    for (const k of Object.keys(seen)) out[k] = seen[k] / cards;
    out._cards = cards;
    return out;
  }

  // Roster independence: hiding ten registered skills must barely move the
  // shape of a hand. (Before this task the same comparison moved 9 points.)
  for (const seats of [2, 4]) {
    const full = shares(seats);
    const trimmed = shares(seats, WAVE2);
    for (const kind of ['new', 'upgrade', 'passive']) {
      const drift = Math.abs(full[kind] - trimmed[kind]);
      // Exactly zero by construction — the category roll only sees which
      // categories are present, never how many cards they hold — so the
      // tolerance is for float noise, not for slack (review catch: 0.03 was
      // a hundred times looser than the real value).
      assert.ok(
        drift < 0.005,
        `draft: ${kind} share is roster-independent at ${seats} seats (drifted ${(drift * 100).toFixed(2)} points)`
      );
    }
  }

  // The shipped contract itself, pinned independently of the ratio check
  // below — that one reads its expectation out of the same settings object
  // it is testing, so it can never fail on a weight edit (review catch).
  assert.deepEqual(
    settings.upgrades.passiveWeights,
    { upgrade: 6, newActive: 2, passive: 1, mutation: 3 },
    'draft: the shipped category weights, every card kind declared (M9 T2 added mutation at the upgrade tier; M11 T1 raised upgrade 3→6 so a level-up more often deepens what you already hold)'
  );

  // The weights mean what they say, at the category level.
  //
  // The tolerance is RELATIVE, not the absolute ±0.5 it used to be. That
  // constant was sized for a 3:1 ratio and silently became a 8%-of-target
  // band when M11 T1 raised the upgrade weight to 6 — a check that gets
  // stricter as the number it measures grows is a check that will fail for
  // the wrong reason. The observed drift is structural rather than noise: a
  // hand whose passive pool is exhausted renormalises over the remaining
  // kinds, which lifts the upgrade share above the nominal ratio. ±25% is
  // wide enough for that and still nowhere near blind — weights ignored
  // entirely reads as ~1.0 against a target of 6.
  {
    const w = settings.upgrades.passiveWeights;
    const s = shares(4);
    const tracks = (a, b, wa, wb, label) => {
      const got = s[a] / s[b];
      const want = wa / wb;
      assert.ok(
        Math.abs(got / want - 1) < 0.25,
        `draft: ${label} tracks the weights (got ${got.toFixed(2)}, want ${want.toFixed(2)}, ${((got / want - 1) * 100).toFixed(0)}% off)`
      );
    };
    tracks('upgrade', 'passive', w.upgrade, w.passive, 'upgrade:passive');
    tracks('new', 'passive', w.newActive, w.passive, 'new:passive');
  }

  // An empty category renormalises rather than shrinking the hand: a full
  // build has no 'new' cards to give and must still deal three.
  {
    const loadout = new Loadout();
    const seatable = ELEMENTS.filter((e) => ABILITY_TYPES[e]);
    for (let i = 0; loadout.hasEmpty() && i < seatable.length; i++) loadout.acquire(seatable[i]);
    assert.ok(!loadout.hasEmpty(), 'fixture: the build is full');
    const pool = new UpgradePool(createRng(9), loadout, new Modifiers());
    const hand = pool.draw(6, 6) ?? [];
    assert.equal(hand.length, 3, 'draft: a full build still deals three cards');
    assert.ok(hand.every((c) => c.kind !== 'new'), 'draft: …and none of them is a new skill');

    // …and the two categories left RENORMALISE to 3 : 1 rather than the
    // absent one's weight leaking to whichever category happens to be last
    // (review catch: a constant divisor turned 75/25 into 50/50 and every
    // assertion here stayed green, because none of them looked at the ratio).
    const tally = { upgrade: 0, passive: 0 };
    let dealt = 0;
    for (let t = 0; t < 600; t++) {
      const full = new Loadout();
      for (let i = 0; full.hasEmpty() && i < seatable.length; i++) full.acquire(seatable[i]);
      const p = new UpgradePool(createRng(t + 300), full, new Modifiers());
      for (const c of p.draw(6, 6) ?? []) { if (c.kind in tally) tally[c.kind]++; dealt++; }
    }
    const w = settings.upgrades.passiveWeights;
    const got = tally.upgrade / tally.passive;
    const want = w.upgrade / w.passive;
    assert.ok(
      Math.abs(got - want) < 0.35,
      `draft: with no seat to fill, upgrades and passives renormalise to ${want.toFixed(1)}:1 (got ${got.toFixed(2)}:1 over ${dealt} cards)`
    );
  }

  // The other half of the contract: inside a chosen category the pick is
  // UNIFORM. Returning a fixed member (the first, say) satisfies every other
  // assertion in this block while making every hand deal the same new skill
  // and the same passive forever (review catch).
  {
    const seatable = ELEMENTS.filter((e) => ABILITY_TYPES[e]);
    const newElements = new Set();
    const passiveIds = new Set();
    const upgradeElements = new Set();
    for (let t = 0; t < 300; t++) {
      const loadout = new Loadout();
      for (let s = 0; s < 3; s++) loadout.acquire(seatable[(t * 5 + s * 4) % seatable.length]);
      const pool = new UpgradePool(createRng(t + 900), loadout, new Modifiers());
      for (const c of pool.draw(6, 6) ?? []) {
        if (c.kind === 'new') newElements.add(c.element);
        if (c.kind === 'passive') passiveIds.add(c.passive);
        if (c.kind === 'upgrade') upgradeElements.add(c.element);
      }
    }
    assert.ok(newElements.size > 5, `draft: the new-skill bucket is sampled across its members (saw ${newElements.size})`);
    assert.ok(passiveIds.size > 3, `draft: the passive bucket is sampled across its members (saw ${passiveIds.size})`);
    assert.ok(upgradeElements.size > 3, `draft: the upgrade bucket is sampled across its members (saw ${upgradeElements.size})`);
  }

  // An unknown card kind must be refused outright, not handed a default
  // weight — a new kind joining the pool in silence is the very failure this
  // task removes (review catch). M9 T2 walked straight into this on its
  // first run, which is exactly what it is for: 'mutation' had to declare a
  // weight before it could deal a single card. The probe below uses an id
  // that is still undeclared today.
  {
    const loadout = new Loadout();
    loadout.acquire('ice');
    const pool = new UpgradePool(createRng(4), loadout, new Modifiers());
    const original = pool.draw.bind(pool);
    assert.throws(
      () => {
        const spy = new UpgradePool(createRng(4), loadout, new Modifiers());
        spy._takeByCategory([{ weight: 1, card: { kind: 'relic', element: 'ice' } }]);
      },
      /no category weight/,
      'draft: a card kind with no declared weight throws instead of borrowing one'
    );
    assert.ok(original, 'fixture: the pool still works normally');
  }

  // Zero regression on the two guaranteed-card paths.
  {
    const loadout = new Loadout();
    loadout.acquire('ice');
    const pool = new UpgradePool(createRng(3), loadout, new Modifiers());
    const milestone = settings.upgrades.milestones[0];
    let sawNew = 0;
    for (let t = 0; t < 40; t++) {
      const p = new UpgradePool(createRng(t + 50), loadout, new Modifiers());
      if ((p.draw(milestone, milestone) ?? []).some((c) => c.kind === 'new')) sawNew++;
    }
    assert.equal(sawNew, 40, 'draft: a milestone level still guarantees a new-skill card');

    const directed = pool.draw(6, 6, settings.combat.wuxingOf.ice) ?? [];
    assert.ok(
      directed.every((c) => c.kind !== 'passive' && settings.combat.wuxingOf[c.element] === settings.combat.wuxingOf.ice),
      "draft: a shard's directed hand still deals only that wuxing, and no passives"
    );
  }

  console.log('ok  M9 T1: draft draws by category (roster-independent, weights honoured, renormalising)');
}


/* ---- M9 T2: 满级异化 — somewhere for a maxed skill to go ---- */
{
  const M = settings.upgrades.mutations;
  assert.ok(M && Object.keys(M).length >= 3, 'fixture: a mutation table exists');
  assert.equal(settings.upgrades.mutationMax, 2, 'fixture: two mutations per skill');
  assert.equal(
    typeof settings.upgrades.passiveWeights.mutation,
    'number',
    'draft: the mutation kind declares its own category weight (T1 throws otherwise)'
  );
  // Every entry must be expressible through the layers that already exist —
  // damage, cooldown and the recast roll. A field naming anything else would
  // be a card that silently does nothing for whichever skills never read it.
  for (const [id, m] of Object.entries(M)) {
    for (const key of Object.keys(m)) {
      assert.ok(
        ['name', 'damage', 'cooldown', 'echo'].includes(key),
        `mutation ${id}: '${key}' is not one of the layers every skill already reads`
      );
    }
  }

  // --- Modifiers: the layer itself ---
  {
    const mods = new Modifiers();
    assert.equal(mods.damageMult('ice'), 1, 'mutation: no mutation, no damage change');
    assert.equal(mods.cooldownMult('ice'), mods.cooldownMult(), 'mutation: per-skill cooldown defaults to the global one');
    assert.equal(mods.echoChance('ice'), mods.echoChance(), 'mutation: per-skill echo defaults to the global one');
    assert.equal(mods.mutationsOn('ice').length, 0, 'mutation: a fresh build has none');

    mods.takeMutation('ice', 'heavy');
    assert.ok(mods.hasMutation('ice', 'heavy'), 'mutation: taking one records it');
    assert.ok(
      Math.abs(mods.damageMult('ice') - M.heavy.damage) < 1e-9,
      `mutation: heavy multiplies that skill's damage (got ${mods.damageMult('ice')})`
    );
    assert.equal(mods.damageMult('meteor'), 1, 'mutation: …and only that skill');

    mods.takeMutation('ice', 'quicken');
    assert.ok(
      Math.abs(mods.cooldownMult('ice') - M.quicken.cooldown) < 1e-9,
      `mutation: quicken shortens that skill's cooldown (got ${mods.cooldownMult('ice')})`
    );
    assert.equal(mods.cooldownMult('meteor'), 1, 'mutation: …and only that skill');

    // The cap, and no double-taking.
    assert.equal(mods.mutationsOn('ice').length, 2, 'mutation: two taken');
    assert.equal(mods.canMutate('ice'), false, 'mutation: the cap is reached');
    assert.equal(mods.canMutate('meteor'), true, 'mutation: another skill still can');
    mods.takeMutation('ice', 'heavy');
    assert.equal(mods.mutationsOn('ice').length, 2, 'mutation: taking the same one twice changes nothing');

    // The global passives still compose with the per-skill layer.
    const both = new Modifiers();
    both.bumpPassive('focus');
    const globalCd = both.cooldownMult();
    both.takeMutation('ice', 'quicken');
    assert.ok(
      Math.abs(both.cooldownMult('ice') - globalCd * M.quicken.cooldown) < 1e-9,
      'mutation: a per-skill cooldown mutation multiplies onto the global passive, it does not replace it'
    );
    assert.ok(Math.abs(both.cooldownMult('meteor') - globalCd) < 1e-9, 'mutation: an unmutated skill keeps the global passive alone');
  }

  // --- the trade-off entry really trades ---
  {
    assert.ok(M.overload.damage > 1 && M.overload.cooldown > 1, 'fixture: overload buys damage with cooldown');
    const mods = new Modifiers();
    mods.takeMutation('ice', 'overload');
    assert.ok(mods.damageMult('ice') > 1, 'mutation: overload raises damage');
    assert.ok(mods.cooldownMult('ice') > 1, 'mutation: …and lengthens the cooldown');
  }

  // --- CombatSystem reads the per-skill damage layer (it already did) ---
  {
    const mods = new Modifiers();
    mods.takeMutation('snare', 'heavy');
    const hits = [];
    const combat = new CombatSystem(
      { damage: (p, r, amt) => (hits.push(amt), 1), damageOnce: () => 1, damageRing: () => 1, slow: () => {}, damageCone: () => 0 },
      mods
    );
    const snare = {
      element: 'snare', phase: 'impact', impactTime: 0.2, fadeTime: 0,
      position: { x: 3, z: 0 }, origin: { x: 0, z: 0 }, direction: { x: 1, z: 0 }, length: 9, u: 1,
      autocast: false, quenched: false, fusionMult: 1
    };
    combat.tick(1 / 60, [snare]);
    const plain = new CombatSystem(
      { damage: (p, r, amt) => (hits.push(amt), 1), damageOnce: () => 1, damageRing: () => 1, slow: () => {}, damageCone: () => 0 },
      new Modifiers()
    );
    plain.tick(1 / 60, [snare]);
    assert.ok(
      Math.abs(hits[0] / hits[1] - M.heavy.damage) < 1e-6,
      `mutation: a mutated skill really hits harder through CombatSystem (ratio ${(hits[0] / hits[1]).toFixed(3)})`
    );
  }

  // --- the draft offers it only for a maxed skill, and respects the cap ---
  {
    const loadout = new Loadout();
    const mods = new Modifiers();
    loadout.acquire('ice');
    const pool = new UpgradePool(createRng(11), loadout, mods);

    let sawMutation = false;
    for (let t = 0; t < 60; t++) {
      const p = new UpgradePool(createRng(t + 1), loadout, mods);
      if ((p.draw(6, 6) ?? []).some((c) => c.kind === 'mutation')) sawMutation = true;
    }
    assert.ok(!sawMutation, 'draft: an un-maxed skill is never offered a mutation');

    while (!loadout.isMaxed('ice')) loadout.upgrade('ice');
    let mutations = 0, upgrades = 0;
    for (let t = 0; t < 200; t++) {
      const p = new UpgradePool(createRng(t + 400), loadout, mods);
      for (const c of p.draw(6, 6) ?? []) {
        if (c.kind === 'mutation') { mutations++; assert.equal(c.element, 'ice', 'draft: the mutation card names its skill'); }
        if (c.kind === 'upgrade' && c.element === 'ice') upgrades++;
      }
    }
    assert.ok(mutations > 0, 'draft: a maxed skill is offered mutations instead');
    assert.equal(upgrades, 0, 'draft: …and no longer offered a level it cannot take');
    assert.ok(pool, 'fixture');

    // Cap reached → the seat goes quiet again.
    for (const id of Object.keys(M).slice(0, settings.upgrades.mutationMax)) mods.takeMutation('ice', id);
    let afterCap = 0;
    for (let t = 0; t < 120; t++) {
      const p = new UpgradePool(createRng(t + 900), loadout, mods);
      for (const c of p.draw(6, 6) ?? []) if (c.kind === 'mutation') afterCap++;
    }
    assert.equal(afterCap, 0, 'draft: a fully mutated skill stops offering more');
  }

  // --- bilingual strings for every entry ---
  for (const id of Object.keys(M)) {
    for (const lang of ['zh', 'en']) {
      assert.ok(STRINGS[lang][`mut.${id}`], `strings: mut.${id} exists in ${lang}`);
    }
    assert.notEqual(STRINGS.zh[`mut.${id}`], STRINGS.en[`mut.${id}`], `strings: mut.${id} actually differs by language`);
  }

  console.log('ok  M9 T2: max-level mutations (layer, cap, draft gating, bilingual)');
}


/* ---- M9 T3: 无尽续玩 — a won run can keep going ---- */
{
  const D = settings.run.duration;
  const L = settings.tides.length;

  // The tide wraps past the schedule instead of freezing on its last front.
  {
    const tides = new TideSchedule(createRng(17));
    const last = tides.tideAt(D - 1);
    const wrapped = tides.tideAt(D + 1);
    assert.ok(wrapped.element >= 0 && wrapped.element <= 4, 'endless: the tide past the end is still a real wuxing');
    assert.equal(wrapped.index, 0, 'endless: …and the schedule has come round to its first front again');
    assert.ok(wrapped.progress >= 0 && wrapped.progress <= 1, 'endless: progress stays a fraction');
    assert.ok(wrapped.timeLeft > 0 && wrapped.timeLeft <= L, 'endless: and the countdown restarts rather than sitting at zero');
    // Two full cycles on still lands somewhere legal.
    const far = tides.tideAt(D * 2 + L * 1.5);
    assert.ok(far.element >= 0 && far.element <= 4, 'endless: still legal two cycles later');
    // Inside the scheduled run nothing moved.
    assert.equal(tides.tideAt(D - 1).element, last.element, 'endless: the scheduled run is untouched');
    assert.equal(tides.tideAt(0).index, 0, 'endless: …including its very first front');
  }

  // The verdict: won at the line, and 'playing' forever after once endless.
  {
    const mk = (seed) => {
      const run = new RunManager({
        enemies: new EnemySystem(createRng(seed)),
        pickups: new PickupSystem(createRng(seed + 1)),
        player: new PlayerState(),
        rng: createRng(seed + 2),
        tides: new TideSchedule(createRng(seed + 3)),
        projectiles: new EnemyProjectiles(),
        combat: { tick: () => 0, release: () => -1, resetStats: () => {}, book: () => {} },
        targets: { register: () => {} },
        abilities: { active: [] }
      });
      run.start();
      return run;
    };
    const normal = mk(23);
    normal.elapsed = D - 0.01;
    assert.equal(normal.tick(1 / 60, { x: 0, z: 0 }), 'playing', 'endless: a hair short of the line is still playing');
    normal.elapsed = D;
    assert.equal(normal.tick(1 / 60, { x: 0, z: 0 }), 'won', 'endless: crossing the line still wins');

    const forever = mk(31);
    forever.elapsed = D + 60;
    forever.endless = true;
    assert.equal(forever.tick(1 / 60, { x: 0, z: 0 }), 'playing', 'endless: past the line, an endless run keeps playing');
    assert.ok(forever.elapsed > D + 60, 'endless: …and its clock keeps running');
    for (let i = 0; i < 200; i++) forever.tick(1 / 60, { x: 0, z: 0 });
    assert.equal(forever.tick(1 / 60, { x: 0, z: 0 }), 'playing', 'endless: it never re-wins');

    // Death still ends it.
    forever.s.player.alive = false;
    assert.equal(forever.tick(1 / 60, { x: 0, z: 0 }), 'dead', 'endless: dying in the endless half still ends the run');

    // The trap the browser caught: App resets `_verdict.value` to 'playing'
    // at the top of every frame, so a gate that asks it later never opens —
    // the endless key silently did nothing. Whatever remembers "this run was
    // won" has to be written at the verdict itself. What IS readable
    // afterwards is the run's own state, pinned here.
    const stopped = mk(37);
    stopped.elapsed = D;
    assert.equal(stopped.tick(1 / 60, { x: 0, z: 0 }), 'won', 'endless: the win is reported once…');
    stopped.stop();
    assert.equal(stopped.active, false, 'endless: …and `active` is what stays false afterwards');
    assert.equal(stopped.endless, false, 'endless: a stopped run has not silently entered the endless half');
    stopped.endless = true;
    stopped.active = true;
    assert.equal(stopped.tick(1 / 60, { x: 0, z: 0 }), 'playing', 'endless: resuming really resumes');
  }

  // Difficulty keeps climbing rather than flattening or going non-finite.
  {

    const hpAt = (minute) => settings.enemies.hpBase * (1 + settings.enemies.hpPerMinute * minute);
    assert.ok(hpAt(D / 60 + 15) > hpAt(D / 60), 'endless: enemy hp keeps growing past the finish line');
    assert.ok(Number.isFinite(hpAt(120)), 'endless: still a finite number two hours in');
  }

  // The offer is spent once taken: a fresh win offers it, a run already in
  // its endless half does not, and its death card says it cleared.
  {
    const shown = [];
    const panel = {
      show: (opts) => shown.push(opts),
      hide: () => {},
      isOpen: false
    };
    // Mirrors App's own two flags at the verdict site rather than importing
    // App (it pulls in the renderer) — the same discipline the resonance
    // test in this file already uses.
    const offer = (won, endless) => ({ canContinue: won && !endless, cleared: endless });
    panel.show(offer(true, false));
    panel.show(offer(true, true));
    panel.show(offer(false, true));
    assert.equal(shown[0].canContinue, true, 'endless: a fresh win offers the continuation');
    assert.equal(shown[1].canContinue, false, 'endless: a run already carrying on does not offer it again');
    assert.equal(shown[2].cleared, true, 'endless: dying in the endless half reads as a cleared run');
    assert.equal(shown[0].cleared, false, 'endless: a first win is not yet "cleared" in that sense');
  }

  for (const key of ['verdict.endless', 'verdict.cleared']) {
    for (const lang of ['zh', 'en']) assert.ok(STRINGS[lang][key], `strings: ${key} exists in ${lang}`);
    assert.notEqual(STRINGS.zh[key], STRINGS.en[key], `strings: ${key} actually differs by language`);
  }

  console.log('ok  M9 T3: endless (tide wrap, verdict, offer-once, difficulty keeps climbing)');
}


/* ---- M9 T4: the last channel learns push from shove ---- */
{
  // `damage()` is the one entry point that still applied a full impulse
  // unconditionally, and the per-tick kinds call it sixty times a second:
  // measured 29.4 m/s peak on a snare zone before this task. It takes a
  // kbScale now, exactly like damageRing and damageCone already did.
  const mkAbility = (element, extra = {}) => ({
    element, phase: 'impact', impactTime: 0.2, fadeTime: 0,
    // The field sits on the player, because that is where seekers end up —
    // a field parked out in the arena empties itself within a second and
    // measures the walk-out instead of the shove (M8's own lesson).
    position: { x: 0, z: 0 }, origin: { x: 0, z: 0 }, direction: { x: 1, z: 0 },
    length: 9, u: 1, autocast: false, quenched: false, fusionMult: 1, ...extra
  });

  /** Peak shove on a body parked in the field, with the horde ticking. */
  function peakShove(element, ticks = 120) {
    const enemies = new EnemySystem(createRng(61));
    const i = enemies.spawnAt(1, 0, 0, 1);
    // Not 1e9: hp is a Float32Array, whose ulp up there is about 64, so a
    // sub-unit DoT tick rounds away entirely and the field looks inert.
    enemies.hp[i] = 50000;
    const combat = new CombatSystem(enemies);
    const ability = mkAbility(element);
    let peak = 0, dealt = 0;
    const before = enemies.hp[i];
    for (let t = 0; t < ticks; t++) {
      combat.tick(1 / 60, [ability]);
      peak = Math.max(peak, Math.hypot(enemies.kbX[i], enemies.kbZ[i]));
      // The horde has to move for a shove to mean anything (M8's rule).
      enemies.tick(1 / 60, { x: 0, z: 0 }, 0);
    }
    dealt = before - enemies.hp[i];
    return { peak, dealt };
  }

  {
    const snare = peakShove('snare');
    assert.ok(snare.dealt > 0, 'zoneTick: the field still bites');
    assert.ok(
      snare.peak < 1.5,
      `zoneTick: a field pushes at a rate, not one impulse per tick (peak ${snare.peak.toFixed(1)} m/s — was 29.4)`
    );
  }

  // A burst detonation is still ONE impulse and must not shrink.
  {
    const enemies = new EnemySystem(createRng(62));
    const i = enemies.spawnAt(1.2, 0, 0, 1);
    enemies.hp[i] = 50000;
    const before = enemies.kbX[i];
    enemies.damage({ x: 0, z: 0 }, settings.combat.boulder.radius, 10, -1);
    const oneShot = enemies.kbX[i] - before;
    assert.ok(oneShot > 1, `impulse: a single hit still shoves properly (got ${oneShot.toFixed(2)})`);

    // …and that is exactly what the default argument means.
    const enemies2 = new EnemySystem(createRng(62));
    const j = enemies2.spawnAt(1.2, 0, 0, 1);
    enemies2.hp[j] = 50000;
    enemies2.damage({ x: 0, z: 0 }, settings.combat.boulder.radius, 10, -1, -1, 1);
    assert.ok(
      Math.abs(enemies2.kbX[j] - enemies.kbX[i]) < 1e-9,
      'impulse: passing the default explicitly is byte-identical to omitting it'
    );
  }

  // kbScale 0 means a field that burns without pushing (沙暴's precedent).
  {
    const enemies = new EnemySystem(createRng(63));
    const i = enemies.spawnAt(1, 0, 0, 1);
    enemies.hp[i] = 50000;
    const hpBefore = enemies.hp[i];
    enemies.damage({ x: 0, z: 0 }, 3, 10, -1, -1, 0);
    assert.equal(enemies.kbX[i], 0, 'impulse: kbScale 0 shoves nothing');
    assert.equal(enemies.kbZ[i], 0, 'impulse: …in either axis');
    assert.ok(enemies.hp[i] < hpBefore, 'impulse: …but still deals its damage');
  }

  // Targets threads it through.
  {
    const got = [];
    const targets = new Targets();
    targets.register({ hits: () => false, damage: (...a) => (got.push(a), 1) });
    targets.damage({ x: 0, z: 0 }, 2, 5, 1, 2, 0.5);
    assert.equal(got[0].length, 6, 'Targets.damage: passes the shove scale on');
    assert.equal(got[0][5], 0.5, 'Targets.damage: …unchanged');
    got.length = 0;
    targets.damage({ x: 0, z: 0 }, 2, 5, 1);
    assert.equal(got[0][5], 1, 'Targets.damage: and defaults it to one full impulse');
  }

  // The standing-field classes burn without shoving, like the sandstorm.
  {
    const enemies = new EnemySystem(createRng(64));
    const i = enemies.spawnAt(0.5, 0, 0, 1);
    enemies.hp[i] = 50000;
    const ctx = {
      targets: enemies, enemies, stats: { book: () => {} },
      lights: { acquire: () => null, release: () => {}, set: () => {} },
      decals: { spawn: () => ({ mesh: { scale: { setScalar: () => {} } }, material: { uniforms: { uColorA: { value: { lerpColors: () => {} } } } } }) },
      bursts: { spawn: () => {} },
      particles: { get: () => ({ uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } }, setGradient() {}, emit() {} }) },
      mods: null
    };
    const blaze = new VineBlazeSkill(ctx, fusionId('thunder', 'fireball'));
    blaze.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0.5);
    blaze.autocast = false; blaze.fusionMult = 1; blaze.quenched = false;
    const hpBefore = enemies.hp[i];
    for (let t = 0; t < 120; t++) { blaze.update(1 / 60); enemies.tick(1 / 60, { x: 0, z: 0 }, 0); }
    assert.ok(enemies.hp[i] < hpBefore, 'burning ground: the zone still burns');
    assert.ok(
      Math.hypot(enemies.kbX[i], enemies.kbZ[i]) < 0.5,
      `burning ground: …without shoving anyone out of it (${Math.hypot(enemies.kbX[i], enemies.kbZ[i]).toFixed(2)} m/s)`
    );
    blaze.destroy();
  }

  console.log('ok  M9 T4: damage() takes a shove scale (fields push at a rate, hits still hit)');
}


/* ---- M10 T1: the second wave's first six learn to change ---- */
{
  const SIX = {
    cyclonecut: { lv3: { radius: 1.3 }, lv5: { kbMult: 1.6 } },
    piercelance: { lv3: { width: 1.5 }, lv5: { executeBelow: 2.0 } },
    stormfield: { lv3: { radius: 1.25 }, lv5: { boltEvery: 0.7 } },
    thornroad: { lv3: { width: 1.4 }, lv5: { slowFactor: 0.5 } },
    tidalsurge: { lv3: { width: 1.3 }, lv5: { knockback: 1.8 } },
    hailstorm: { lv3: { radius: 1.25 }, lv5: { damage: 1.35 } }
  };

  for (const [el, tiers] of Object.entries(SIX)) {
    const table = settings[el].breakpoints;
    assert.ok(table, `${el}: has a breakpoint table at all`);
    assert.deepEqual(table.lv3, tiers.lv3, `${el}: Lv3 tier matches the plan`);
    assert.deepEqual(table.lv5, tiers.lv5, `${el}: Lv5 tier matches the plan`);
    for (const lv of ['lv3', 'lv5']) {
      for (const lang of ['zh', 'en']) {
        assert.ok(STRINGS[lang][`bp.${el}.${lv}`], `strings: bp.${el}.${lv} exists in ${lang}`);
      }
      assert.notEqual(STRINGS.zh[`bp.${el}.${lv}`], STRINGS.en[`bp.${el}.${lv}`], `strings: bp.${el}.${lv} differs by language`);
    }
  }

  // Every key is CONSUMED — measured through a real tick, not read back out
  // of the table it was written into. A tier nobody reads is a card that
  // promises what it cannot deliver (M9 cut two mutations for exactly that).
  const levelOf = (want) => (el) => (SIX[el] ? want : 1);

  /** Run one ability through CombatSystem at Lv1 and at `level`, and hand
   * back what the targets facade actually received. */
  function observed(element, level, ability, key) {
    const seen = [];
    const spy = {
      damage: (p, r, amt, w, wB, kb) => (seen.push({ r, amt, kb }), 1),
      damageOnce: (id, p, r, amt) => (seen.push({ r, amt }), 1),
      damageRing: (p, i, o, amt, w, wB, kb) => (seen.push({ inner: i, outer: o, amt, kb }), 1),
      damageCone: (p, dx, dz, half, range, amt) => (seen.push({ half, range, amt }), 1),
      slow: (p, r, f, d) => seen.push({ slowR: r, f, d }),
      knockback: (p, r, impulse) => seen.push({ kbR: r, impulse }),
      applyVuln: () => {}
    };
    new CombatSystem(spy, null, levelOf(level)).tick(1 / 60, [ability]);
    return seen;
  }

  const mk = (element, extra = {}) => ({
    element, phase: 'impact', impactTime: 0.2, fadeTime: 0,
    position: { x: 0, z: 0 }, origin: { x: 0, z: 0 }, direction: { x: 1, z: 0 },
    length: 9, u: 0.5, autocast: false, quenched: false, fusionMult: 1, ...extra
  });

  // cyclonecut: radius at Lv3, pull rate at Lv5.
  {
    const a = mk('cyclonecut');
    const base = observed('cyclonecut', 1, a, 'radius')[0];
    const lv3 = observed('cyclonecut', 3, a, 'radius')[0];
    assert.ok(Math.abs(lv3.outer / base.outer - 1.3) < 1e-6, `cyclonecut Lv3: the ring really widens (${(lv3.outer / base.outer).toFixed(3)})`);
    const lv5 = observed('cyclonecut', 5, a, 'kbMult')[0];
    assert.ok(Math.abs(lv5.kb / base.kb - 1.6) < 1e-6, `cyclonecut Lv5: the pull really tightens (${(lv5.kb / base.kb).toFixed(3)})`);
  }

  // thornroad: width at Lv3, slow REPLACED at Lv5.
  {
    const a = mk('thornroad');
    const base = observed('thornroad', 1, a)[0];
    const lv3 = observed('thornroad', 3, a)[0];
    assert.ok(Math.abs(lv3.r / base.r - 1.4) < 1e-6, `thornroad Lv3: the road really widens (${(lv3.r / base.r).toFixed(3)})`);
    const lv5 = observed('thornroad', 5, a).find((x) => x.f !== undefined);
    assert.ok(Math.abs(lv5.f - 0.5) < 1e-9, `thornroad Lv5: the tangle is replaced outright, not scaled (${lv5.f})`);
  }

  // tidalsurge: width at Lv3, shove at Lv5.
  {
    const a = mk('tidalsurge', { phase: 'travel', u: 0.5 });
    const base = observed('tidalsurge', 1, a).find((x) => x.impulse !== undefined);
    const lv5 = observed('tidalsurge', 5, a).find((x) => x.impulse !== undefined);
    assert.ok(Math.abs(lv5.impulse / base.impulse - 1.8) < 1e-6, `tidalsurge Lv5: the wall really shoves harder (${(lv5.impulse / base.impulse).toFixed(3)})`);
    // A sweep reports its width through damageOnce's radius, and the shove
    // through knockback's own record — take the first entry that carries one.
    const w1 = observed('tidalsurge', 1, a).find((x) => x.r !== undefined).r;
    const w3 = observed('tidalsurge', 3, a).find((x) => x.r !== undefined).r;
    assert.ok(Math.abs(w3 / w1 - 1.3) < 1e-6, `tidalsurge Lv3: the wall really widens (${(w3 / w1).toFixed(3)})`);
  }

  // hailstorm: radius at Lv3, damage at Lv5.
  {
    const a = mk('hailstorm', { impactTime: 1.0 });
    const base = observed('hailstorm', 1, a)[0];
    const lv3 = observed('hailstorm', 3, a)[0];
    const lv5 = observed('hailstorm', 5, a)[0];
    assert.ok(Math.abs(lv3.r / base.r - 1.25) < 1e-6, `hailstorm Lv3: wider (${(lv3.r / base.r).toFixed(3)})`);
    assert.ok(Math.abs(lv5.amt / base.amt - 1.35) < 1e-6, `hailstorm Lv5: heavier (${(lv5.amt / base.amt).toFixed(3)})`);
  }

  // piercelance and stormfield resolve their own hits — driven through their
  // own classes, at Lv1 and at the tier, with the horde ticking (M8's rule).
  {
    const ctx = (enemies, level) => ({
      targets: enemies, enemies, stats: { book: () => {} },
      levelOf: () => level,
      lights: { acquire: () => null, release: () => {}, set: () => {} },
      decals: { spawn: () => null }, bursts: { spawn: () => {} },
      particles: { get: () => ({ uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } }, setGradient() {}, emit() {} }) },
      mods: null
    });

    // piercelance Lv5: the execute floor doubles, so a body that survives at
    // Lv1 dies at Lv5 — the sharpest possible proof the key is consumed.
    const floor = settings.combat.piercelance.executeBelow;
    for (const [level, shouldDie] of [[1, false], [5, true]]) {
      const enemies = new EnemySystem(createRng(71));
      const victim = enemies.spawnAt(5, 0, 0, 3); // 火 body: the lance is beaten by it, so no bonus damage
      // The hit lands FIRST and the floor sweeps after it, so the body has to
      // clear the Lv1 floor even once wounded, while still falling under the
      // doubled Lv5 one: line damage (320 × 0.8 disadvantage) + a hair over
      // one floor, which leaves it between the two.
      const lineHit = settings.piercelance.damage * settings.combat.matchup.disadvantage;
      enemies.hp[victim] = lineHit + floor * 1.5;
      const id = enemies.id[victim];
      const lance = new PierceLanceSkill(ctx(enemies, level), 'piercelance');
      lance.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 14);
      lance.autocast = false; lance.fusionMult = 1; lance.quenched = false;
      for (let t = 0; t < 20; t++) { lance.update(1 / 60); enemies.tick(1 / 60, { x: 0, z: 0 }, 0); }
      const alive = Array.from({ length: enemies.count }, (_, i) => enemies.id[i]).includes(id);
      assert.equal(!alive, shouldDie, `piercelance Lv${level}: a body at 1.5x the base floor ${shouldDie ? 'is executed' : 'survives'}`);
      lance.destroy();
    }

    // stormfield Lv5: bolts come faster, so more of them land in one window.
    const bolts = (level) => {
      const enemies = new EnemySystem(createRng(73));
      const i = enemies.spawnAt(0.5, 0, 0, 3);
      enemies.hp[i] = 500000;
      const storm = new StormFieldSkill(ctx(enemies, level), 'stormfield');
      storm.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0.5);
      storm.autocast = false; storm.fusionMult = 1; storm.quenched = false;
      const before = enemies.hp[i];
      while (!storm.isFinished) { storm.update(1 / 60); enemies.tick(1 / 60, { x: 0, z: 0 }, 0); }
      storm.destroy();
      return (before - enemies.hp[i]) / (settings.stormfield.boltDamage * settings.combat.matchup.disadvantage);
    };
    const n1 = bolts(1);
    const n5 = bolts(5);
    assert.ok(n1 > 3, `fixture: the base field lands its bolts (${n1.toFixed(1)})`);
    assert.ok(
      n5 / n1 > 1.25,
      `stormfield Lv5: bolts really come faster (${n1.toFixed(1)} → ${n5.toFixed(1)} bolts' worth)`
    );
  }

  console.log('ok  M10 T1: six second-wave skills gain consumed breakpoints');
}


/* ---- M10 T2: the last four of the wave get their turning points ---- */
{
  const FOUR = {
    flamebreath: { lv3: { halfAngle: 1.35 }, lv5: { dps: 1.3 } },
    mortarrain: { lv3: { radius: 1.3 }, lv5: { damage: 1.3 } },
    sandfield: { lv3: { radius: 1.2 }, lv5: { slowFactor: 0.45 } },
    stonepillar: { lv3: { radius: 1.3 }, lv5: { stunTime: 1.6 } }
  };

  for (const [el, tiers] of Object.entries(FOUR)) {
    assert.ok(settings[el].breakpoints, `${el}: has a breakpoint table`);
    assert.deepEqual(settings[el].breakpoints.lv3, tiers.lv3, `${el}: Lv3 tier matches the plan`);
    assert.deepEqual(settings[el].breakpoints.lv5, tiers.lv5, `${el}: Lv5 tier matches the plan`);
    for (const lv of ['lv3', 'lv5']) {
      for (const lang of ['zh', 'en']) assert.ok(STRINGS[lang][`bp.${el}.${lv}`], `strings: bp.${el}.${lv} in ${lang}`);
      assert.notEqual(STRINGS.zh[`bp.${el}.${lv}`], STRINGS.en[`bp.${el}.${lv}`], `strings: bp.${el}.${lv} differs by language`);
    }
  }

  const spyOn = (element, level, ability) => {
    const seen = [];
    const spy = {
      damage: (p, r, amt) => (seen.push({ r, amt }), 1),
      damageOnce: (id, p, r, amt) => (seen.push({ r, amt }), 1),
      damageRing: (p, i, o, amt) => (seen.push({ inner: i, outer: o, amt }), 1),
      damageCone: (p, dx, dz, half, range, amt) => (seen.push({ half, range, amt }), 1),
      slow: (p, r, f, d) => seen.push({ f, d }),
      knockback: () => {}, applyVuln: () => {}
    };
    new CombatSystem(spy, null, () => level).tick(1 / 60, [ability]);
    return seen;
  };
  const mk = (element, extra = {}) => ({
    element, phase: 'impact', impactTime: 0.2, fadeTime: 0,
    position: { x: 0, z: 0 }, origin: { x: 0, z: 0 }, direction: { x: 1, z: 0 },
    length: 9, u: 1, autocast: false, quenched: false, fusionMult: 1, ...extra
  });

  // flamebreath: the wedge opens at Lv3, burns harder at Lv5.
  {
    const a = mk('flamebreath');
    const base = spyOn('flamebreath', 1, a)[0];
    const lv3 = spyOn('flamebreath', 3, a)[0];
    const lv5 = spyOn('flamebreath', 5, a)[0];
    assert.ok(Math.abs(lv3.half / base.half - 1.35) < 1e-6, `flamebreath Lv3: the wedge really opens (${(lv3.half / base.half).toFixed(3)})`);
    assert.ok(Math.abs(lv5.amt / base.amt - 1.3) < 1e-6, `flamebreath Lv5: it really burns harder (${(lv5.amt / base.amt).toFixed(3)})`);

    // WYSIWYG survives the tier: the drawn plume's outer envelope is SOLVED
    // from the half-angle (M8 T5), not a constant, so a wider judged wedge
    // has to come with a wider drawn one. Same solver, same input.
    const spreadFor = (h) => { const t = Math.tan(h); return t / (1 + t); };
    const envelope = (spread) => Math.atan(spread / (1 - spread));
    for (const [level, half] of [[1, base.half], [3, lv3.half]]) {
      assert.ok(
        Math.abs(envelope(spreadFor(half)) - half) < 1e-9,
        `flamebreath Lv${level}: what is drawn still lands on what is judged (${envelope(spreadFor(half)).toFixed(4)} vs ${half.toFixed(4)})`
      );
    }
  }

  // mortarrain: wider craters at Lv3, heavier shells at Lv5 — through the
  // burst case's own read site, which M10 T1 had to add in the first place.
  {
    const a = mk('mortarrain', { impactTime: 0.6 });
    const base = spyOn('mortarrain', 1, a)[0];
    const lv3 = spyOn('mortarrain', 3, a)[0];
    const lv5 = spyOn('mortarrain', 5, a)[0];
    assert.ok(Math.abs(lv3.r / base.r - 1.3) < 1e-6, `mortarrain Lv3: wider craters (${(lv3.r / base.r).toFixed(3)})`);
    assert.ok(Math.abs(lv5.amt / base.amt - 1.3) < 1e-6, `mortarrain Lv5: heavier shells (${(lv5.amt / base.amt).toFixed(3)})`);
  }

  // sandfield: a wider disc at Lv3, a deeper blind at Lv5 (REPLACE, not scale).
  {
    const a = mk('sandfield');
    const base = spyOn('sandfield', 1, a)[0];
    const lv3 = spyOn('sandfield', 3, a)[0];
    assert.ok(Math.abs(lv3.outer / base.outer - 1.2) < 1e-6, `sandfield Lv3: a wider field (${(lv3.outer / base.outer).toFixed(3)})`);
    const lv5 = spyOn('sandfield', 5, a).find((x) => x.f !== undefined);
    assert.ok(Math.abs(lv5.f - 0.45) < 1e-9, `sandfield Lv5: the blind is replaced outright (${lv5.f})`);
  }

  // stonepillar: a wider slab at Lv3, a longer stun at Lv5.
  {
    const a = mk('stonepillar');
    const base = spyOn('stonepillar', 1, a);
    const lv3 = spyOn('stonepillar', 3, a);
    const lv5 = spyOn('stonepillar', 5, a);
    assert.ok(Math.abs(lv3[0].r / base[0].r - 1.3) < 1e-6, `stonepillar Lv3: a wider slab (${(lv3[0].r / base[0].r).toFixed(3)})`);
    const stun = (rows) => rows.filter((x) => x.f === 1).pop();
    assert.ok(
      Math.abs(stun(lv5).d / stun(base).d - 1.6) < 1e-6,
      `stonepillar Lv5: a longer stun (${(stun(lv5).d / stun(base).d).toFixed(3)})`
    );
  }

  // The wave is finished: nothing castable is left without turning points.
  // The count is pinned alongside the loop on purpose — `if (!ABILITY_TYPES
  // [element]) continue` passes vacuously if the registry ever empties, so a
  // coverage guard with no floor under it can go quietly hollow (M10 T4).
  {
    const castable = ELEMENTS.filter((el) => ABILITY_TYPES[el]);
    assert.equal(castable.length, 30, `roster: 30 castable skills expected, found ${castable.length}`);
    const without = castable.filter((el) => !settings[el]?.breakpoints);
    assert.deepEqual(without, [], `breakpoints: castable skills with no turning points — ${without.join(', ')}`);
    // Both tiers, both real: an empty `{}` or a table with one tier is not
    // coverage. Every table names lv3 and lv5 and puts at least one key in each.
    const thin = castable.filter((el) => {
      const bp = settings[el].breakpoints;
      return !bp.lv3 || !bp.lv5 || !Object.keys(bp.lv3).length || !Object.keys(bp.lv5).length;
    });
    assert.deepEqual(thin, [], `breakpoints: tables missing a real lv3/lv5 tier — ${thin.join(', ')}`);
  }

  console.log('ok  M10 T2: the wave is complete — every castable skill has turning points');
}


/* ---- M10 T3: a cone is previewed as a cone ---- */
{
  // M8 T5 shipped the wedge and wrote down that it was still previewed as a
  // line. The preview reads the SAME row the hit test does, scaled by the
  // SAME breakpoint call, so the two cannot drift — that identity is the
  // whole assertion here, not the drawing.
  assert.equal(CastShape.CONE, 'cone', 'shape: the cone is a declared cast shape');
  assert.equal(castShapeOf('flamebreath'), CastShape.CONE, 'shape: 烈焰喷吐 is aimed as a cone');

  // Zero regression for the other three shapes.
  assert.equal(castShapeOf('ice'), CastShape.LINE, 'shape: a line skill is still a line');
  assert.equal(castShapeOf('snare'), CastShape.ZONE, 'shape: a zone skill is still a zone');
  assert.equal(castShapeOf('quake'), CastShape.SELF, 'shape: a self skill is still self');
  for (const el of ELEMENTS) {
    if (!ABILITY_TYPES[el]) continue;
    const isCone = settings.combat[el]?.kind === 'coneTick';
    assert.equal(
      castShapeOf(el) === CastShape.CONE,
      isCone,
      `shape: ${el} is aimed as a cone exactly when it is judged as one`
    );
  }

  // Same source, same scaling: what the controller *hands the indicator* and
  // what damageCone receives at that level are the same two numbers. Both
  // sides are the shipped code — no formula is retyped here.
  const drawnAt = (element, level) => {
    const aim = new AimController(null);
    aim.setElement(element);
    aim.levelOf = () => level;
    aim.arm();
    const drawn = [];
    aim.zone.update = (...args) => drawn.push(args);
    let arrow = null;
    aim.indicator.setVisible = (v) => { arrow = v; };
    aim.update(1); // one real second: the reveal saturates in a single call
    aim.dispose();
    return { drawn, arrow };
  };
  const judgedAt = (element, level) => {
    const seen = [];
    const combat = new CombatSystem(
      { damage: () => 0, damageOnce: () => 0, damageRing: () => 0, slow: () => {},
        damageCone: (p, dx, dz, half, range) => (seen.push({ half, range }), 1) },
      null,
      () => level
    );
    combat.tick(1 / 60, [{
      element, phase: 'impact', impactTime: 0.2, fadeTime: 0,
      position: { x: 0, z: 0 }, origin: { x: 0, z: 0 }, direction: { x: 1, z: 0 },
      length: 5.5, u: 1, autocast: false, quenched: false, fusionMult: 1
    }]);
    return seen[0];
  };

  const previews = [];
  for (const level of [1, 3, 5]) {
    const { drawn, arrow } = drawnAt('flamebreath', level);
    assert.equal(arrow, false, `cone Lv${level}: the line arrow is hidden for a cone cast`);
    assert.equal(drawn.length, 1, `cone Lv${level}: the disc indicator is the one that draws it`);
    // update(origin, yaw, distance, radius, range, reveal, valid, halfAngle)
    const [, , distance, radius, , , , halfAngle] = drawn[0];
    assert.equal(distance, 0, `cone Lv${level}: the wedge is pinned to the caster, not the cursor`);
    const want = judgedAt('flamebreath', level);
    assert.ok(Math.abs(halfAngle - want.half) < 1e-9, `cone Lv${level}: the drawn half-angle is the judged one (${halfAngle} vs ${want.half})`);
    assert.ok(Math.abs(radius - want.range) < 1e-9, `cone Lv${level}: the drawn reach is the judged one (${radius} vs ${want.range})`);
    previews.push({ halfAngle, radius });
  }
  // …and the Lv3 tier really moves it, so the checks above are not comparing
  // two constants that happen to agree.
  assert.ok(previews[1].halfAngle > previews[0].halfAngle, 'cone: Lv3 really widens what is previewed');

  // The reach must come off the COMBAT row (the one damageCone measures), not
  // the ability row (the one the arrow measures). Both happen to carry 5.5, so
  // the checks above cannot tell the two read sites apart — only perturbing
  // one of them can. Put back immediately; nothing else here may see it move.
  {
    const combatRow = settings.combat.flamebreath;
    const before = combatRow.range;
    try {
      combatRow.range = before + 3;
      const { drawn } = drawnAt('flamebreath', 1);
      assert.ok(
        Math.abs(drawn[0][3] - (before + 3)) < 1e-9,
        `cone: the drawn reach follows the judged row, not settings.flamebreath.range (${drawn[0][3]})`
      );
    } finally {
      combatRow.range = before;
    }
    assert.equal(settings.combat.flamebreath.range, before, 'cone: the probe restored the row it moved');
  }

  // Zero regression for the circle: a zone cast still draws its own footprint
  // at the cursor with no wedge at all.
  {
    const { drawn, arrow } = drawnAt('snare', 1);
    assert.equal(arrow, false, 'zone: the line arrow is still hidden for a zone cast');
    assert.equal(drawn.length, 1, 'zone: the disc indicator still draws a zone cast');
    const [, , , radius, , , , halfAngle] = drawn[0];
    // Omitted or explicit, it has to resolve to "no wedge" — the argument is
    // optional so the zone call site stayed untouched.
    assert.equal(halfAngle ?? 0, 0, 'zone: a zone cast asks for no half-angle, so the ring is unchanged');
    assert.equal(radius, settings.snare.zoneRadius, 'zone: a zone cast still draws its own footprint radius');
  }
  // …and a line cast still arms the arrow and never touches the disc.
  {
    const { drawn, arrow } = drawnAt('ice', 1);
    assert.equal(arrow, true, 'line: a line cast still arms the arrow');
    assert.equal(drawn.length, 0, 'line: a line cast never draws the disc');
  }

  // The checks above hand the controller its own `levelOf` — which is exactly
  // how the first cut of this task shipped GREEN with the App never injecting
  // one, so a Lv3 breath burned 35% wider than the wedge it drew. A fixture
  // that supplies the dependency production forgot is blind by construction
  // (M9's mirror lesson, in another dress). No renderer here can build an App,
  // so what is pinned instead is the WIRING: one definition of `levelOf`, and
  // the indicator reading that same one. The behaviour itself is a browser
  // check (`preview widens at Lv3`), which is what caught it.
  {
    const appSrc = readFileSync(new URL('../src/core/App.js', import.meta.url), 'utf8');
    assert.match(appSrc, /this\._levelOf = levelOf;/, 'wiring: App keeps one definition of levelOf for all its consumers');
    assert.match(appSrc, /this\.aim\.levelOf = this\._levelOf/, 'wiring: the aim indicator is given that same levelOf');
  }

  console.log('ok  M10 T3: the cone is aimed the way it is judged');
}

/* ---- M11 T0: a `count` tier has to reach the damage, not just the mesh ---- */
{
  // `npm run report:bp` finding: 万剑诀 / 剑域 / 日轮's Lv3 `count` bought
  // blades and nothing else. ZoneBurstSkill and OrbitAuraSkill read
  // bpAdd('count') to decide how many to draw; the burst and aura damage
  // never looked at it. Denser rain, identical hit — the same hollow-tier
  // shape M10 found three of, caught this time by measuring instead of by
  // reading the table.

  const BASIS = [['swordrain', 'swordCount'], ['bladeorbit', 'bladeCount'], ['sunwheel', 'orbCount']];

  // 1. One function answers both questions, so the drawing and the judging
  //    cannot drift: the multiplier IS the drawn count over the base.
  for (const [el, field] of BASIS) {
    const base = settings[el][field];
    assert.equal(bpCount(el, 1), base, `${el}: Lv1 draws exactly its own base count`);
    assert.ok(bpCount(el, 3) > base, `${el}: Lv3 draws more than Lv1`);
    assert.equal(bpCountMult(el, 1), 1, `${el}: Lv1 multiplies damage by exactly 1`);
    assert.ok(
      Math.abs(bpCountMult(el, 3) - bpCount(el, 3) / base) < 1e-9,
      `${el}: the damage multiplier is the drawn count over the base, not a second number`
    );
  }

  // 2. Nothing else moves. A skill with no count tier keeps identity, and a
  //    skill that isn't count-based at all reports zero rather than NaN.
  assert.equal(bpCountMult('ice', 5), 1, 'count: a skill with no count tier is untouched');
  assert.equal(bpCountMult('lifebloom', 5), 1, 'count: a ZoneBurst skill with no count basis is untouched');
  assert.equal(bpCount('lifebloom', 5), 0, 'count: a skill with no count basis draws no blades (0, never NaN)');

  // 3. The ceiling is shared. A tier that asks for more than the renderer can
  //    draw must not multiply damage by blades nobody ever sees.
  {
    const saved = settings.swordrain.breakpoints;
    try {
      settings.swordrain.breakpoints = { lv3: { count: 500 }, lv5: saved.lv5 };
      const drawn = bpCount('swordrain', 3);
      assert.equal(drawn, settings.combat.countBasis.swordrain.max, 'count: an absurd tier clamps to what can be drawn');
      assert.ok(
        Math.abs(bpCountMult('swordrain', 3) - drawn / settings.swordrain.swordCount) < 1e-9,
        'count: the multiplier clamps with it — never more damage than blades'
      );
    } finally {
      settings.swordrain.breakpoints = saved;
    }
    assert.deepEqual(settings.swordrain.breakpoints, saved, 'count: the probe put the table back');
  }
  for (const [el] of BASIS) {
    const spec = settings.combat.countBasis[el];
    assert.ok(spec && spec.max > 0, `${el}: has a count basis with a real ceiling`);
  }

  // 4. And the part that was actually broken: CombatSystem applies it.
  //    A burst's damage and an aura's dps both scale by the drawn ratio.
  const burstAt = (element, level) => {
    let total = 0;
    const combat = new CombatSystem(
      // The burst case delivers through `damage`, not `damageOnce` — spying on
      // the wrong one reads a real detonation as zero damage.
      { damageOnce: () => 0, damageRing: () => 0, slow: () => {}, knockback: () => {},
        damage: (p, r, amount) => (total += amount, 1) },
      null,
      () => level
    );
    combat.tick(1 / 60, [{
      element, phase: 'impact', impactTime: 0.2, fadeTime: 0,
      position: { x: 0, z: 0 }, origin: { x: 0, z: 0 }, direction: { x: 1, z: 0 },
      length: 4, u: 1, autocast: false, quenched: false, fusionMult: 1, castId: 1
    }]);
    return total;
  };
  const auraAt = (element, level) => {
    let total = 0;
    const combat = new CombatSystem(
      { damage: () => 0, damageOnce: () => 0, slow: () => {},
        damageRing: (p, inner, r, amount) => (total += amount, 1) },
      null,
      () => level
    );
    combat.tick(1 / 60, [{
      element, phase: 'travel', impactTime: 9, fadeTime: 0,
      position: { x: 0, z: 0 }, origin: { x: 0, z: 0 }, direction: { x: 1, z: 0 },
      length: 1, u: 1, autocast: false, quenched: false, fusionMult: 1
    }]);
    return total;
  };
  {
    const want = bpCountMult('swordrain', 3);
    const got = burstAt('swordrain', 3) / burstAt('swordrain', 1);
    assert.ok(want > 1.2, 'swordrain: the Lv3 tier is worth measuring in the first place');
    assert.ok(Math.abs(got - want) < 1e-6, `swordrain Lv3: the burst hits ${want.toFixed(3)}x harder, measured ${got.toFixed(3)}x`);
  }
  for (const el of ['bladeorbit', 'sunwheel']) {
    const want = bpCountMult(el, 3);
    const got = auraAt(el, 3) / auraAt(el, 1);
    assert.ok(want > 1.2, `${el}: the Lv3 tier is worth measuring in the first place`);
    assert.ok(Math.abs(got - want) < 1e-6, `${el} Lv3: the aura grinds ${want.toFixed(3)}x harder, measured ${got.toFixed(3)}x`);
  }

  // 5. And the half a hardcoded count would break: what the CLASS DRAWS has to
  //    be the same number. Sabotaging step 4 alone leaves a ring that pays for
  //    seven blades while drawing five — WYSIWYG's exact failure mode, and the
  //    one M10 T3 shipped once already. Driven through the real classes.
  {
    // A VFX ctx that says yes to everything: these two classes touch a
    // different set of particle uniforms than the fusion classes above, and
    // the point here is the COUNT, not which uniform names exist.
    const anyUniforms = () => new Proxy({}, {
      get: (t, k) => (t[k] ??= { value: 0 }),
      has: () => true
    });
    const vfxCtx = (level) => ({
      levelOf: () => level,
      lights: { acquire: () => null, release: () => {}, set: () => {} },
      particles: { get: () => ({ uniforms: anyUniforms(), setGradient() {}, emit() {} }) },
      // A permanent aura pins itself to the caster every frame (M6 T4).
      character: { position: { x: 0, y: 0, z: 0 }, root: { position: { x: 0, y: 0, z: 0 } } },
      // Present in every real ctx (App builds them), absent here — stubbed
      // rather than null-guarded, because that is a rendering question and
      // this block is about a number.
      bursts: { spawn() {} },
      decals: { spawn() {} },
      fissures: { spawn() {} },
      shake: { add() {}, kick() {} },
      flash: { fire() {} }
    });
    for (const el of ['bladeorbit', 'sunwheel']) {
      for (const level of [1, 3]) {
        const aura = new OrbitAuraSkill(vfxCtx(level), el);
        aura.autocast = false; aura.fusionMult = 1; aura.quenched = false;
        aura.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 1);
        aura.update(1 / 60);
        assert.equal(aura.drawnCount, bpCount(el, level), `${el} Lv${level}: the ring draws exactly what the hit test pays for`);
        aura.destroy();
      }
    }
    for (const level of [1, 3]) {
      const rain = new ZoneBurstSkill(vfxCtx(level), 'swordrain');
      rain.autocast = false; rain.fusionMult = 1; rain.quenched = false;
      rain.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 4);
      assert.equal(rain._bladeWanted, bpCount('swordrain', level), `swordrain Lv${level}: the rain drops exactly what the hit test pays for`);
      rain.destroy();
    }
  }

  console.log('ok  M11 T0: a count tier reaches the damage, not just the mesh');
}

/* ---- M11 T1: four skills maxed by minute ten ---- */
{
  // The owner's acceptance line, and it was a long way off: at minute ten a
  // baseline run is nineteen level-ups deep and holds a median of TWO maxed
  // skills, with zero runs reaching four. Measured, not guessed — and the
  // measuring is what saved the milestone, because the obvious lever is the
  // wrong one. Tripling xp alone only moves the median from two to three:
  // the extra level-ups scatter across new skills, passives and mutations,
  // and the hand only ever offers upgrades for what is already seated.
  //
  // Three levers together do it. This block owns two of them — the draft
  // weight and the picks per level — and asserts the outcome they buy at a
  // FIXED level-up budget. The third lever (the xp curve that delivers that
  // budget by minute ten) is pinned in T2, against the difficulty model, so
  // neither half can drift into being the other half's excuse.
  const BUDGET = 25; // level-ups by minute ten — T2 pins that the curve delivers it

  const playToBudget = (rng0, { picks = settings.upgrades.picksPerLevel } = {}) => {
    const rng = createRng(rng0);
    const loadout = new Loadout();
    const mods = new Modifiers(rng);
    const pool = new UpgradePool(rng, loadout, mods);
    for (let level = 0; level < BUDGET; level++) {
      for (let p = 0; p < picks; p++) {
        // Redrawn per pick on purpose: the second card has to see the first
        // one's effect, or a level-up can hand you the same Lv2 card twice
        // and the Lv3 tier behind it never appears.
        const hand = pool.draw(4, 4) ?? [];
        if (!hand.length) continue;
        const ups = hand.filter((c) => c.kind === 'upgrade')
          .sort((a, b) => loadout.levelOf(b.element) - loadout.levelOf(a.element));
        const pick = ups[0] ?? hand.find((c) => c.kind === 'new') ?? hand[0];
        if (pick.kind === 'upgrade') { loadout.upgrade(pick.element); mods.bumpDamage(pick.element); }
        else if (pick.kind === 'new') loadout.acquire(pick.element);
        else if (pick.kind === 'passive') mods.bumpPassive(pick.passive);
        else if (pick.kind === 'mutation') mods.takeMutation(pick.element, pick.mutation);
        else if (pick.kind === 'fusion') loadout.fuse(pick.a, pick.b);
      }
    }
    return loadout.equippedList().filter((e) => loadout.isMaxed(e)).length;
  };

  const maxedOver = (runs, opts) => {
    const out = [];
    for (let r = 0; r < runs; r++) out.push(playToBudget(9000 + r, opts));
    return out.sort((a, b) => a - b);
  };

  // The acceptance line itself.
  {
    const out = maxedOver(400);
    const median = out[Math.floor(out.length / 2)];
    const hit = out.filter((x) => x >= 4).length / out.length;
    assert.ok(median >= 4, `growth: median maxed skills at minute ten is ${median}, the line is 4`);
    assert.ok(hit >= 0.75, `growth: only ${(hit * 100).toFixed(0)}% of runs reach four maxed — "保证" wants most of them`);
  }

  // Each lever has to be load-bearing. Take one away and the line fails —
  // otherwise it is a number in a config file, not a mechanism (M10's rule).
  assert.equal(settings.upgrades.picksPerLevel, 2, 'growth: a level-up grants two picks');
  {
    const out = maxedOver(400, { picks: 1 });
    const median = out[Math.floor(out.length / 2)];
    assert.ok(median < 4, `growth: one pick per level must NOT reach the line (got ${median}) — else the second pick is decoration`);
  }
  {
    const w = settings.upgrades.passiveWeights;
    assert.ok(w.upgrade >= 6, `growth: the upgrade card's weight is ${w.upgrade}, the plan raised it to 6`);
    // The weight lever buys RELIABILITY, not the median — measured, and worth
    // being precise about rather than claiming all three levers do the same
    // job. Two picks at the new budget already median four; the old weight
    // gets there in about two runs in three, the new one in about nine in
    // ten. "保证" is the word the owner used, so the hit rate is the thing
    // this lever is here for.
    const saved = w.upgrade;
    try {
      w.upgrade = 3; // the pre-M11 weight
      const out = maxedOver(400);
      const hit = out.filter((x) => x >= 4).length / out.length;
      assert.ok(hit < 0.75, `growth: the old weight must NOT clear the reliability bar on its own (got ${(hit * 100).toFixed(0)}%)`);
    } finally { w.upgrade = saved; }
    assert.equal(settings.upgrades.passiveWeights.upgrade, saved, 'growth: the probe put the weight back');
  }

  // Zero regression on M9 T1's loud path: an unknown card kind still throws
  // rather than quietly inheriting the passive weight.
  {
    const w = settings.upgrades.passiveWeights;
    assert.deepEqual(
      Object.keys(w).sort(),
      ['mutation', 'newActive', 'passive', 'upgrade'],
      'growth: the weight table still names every kind the pool can deal'
    );
  }

  // The third lever, pinned as a shipped value rather than a behaviour. The
  // curve is what turns a wall-clock minute into the BUDGET above, and the
  // only model of that is sim-run — so the behavioural pin ("a baseline run
  // is 25 level-ups deep by minute ten") belongs with the difficulty model in
  // T2, and lives there. This one exists so the numbers cannot drift back
  // without somebody deciding to, which is the same job the weight table's
  // deepEqual does above.
  assert.equal(settings.run.xpBase, 18, 'growth: the shipped xp base (M11 T1: 22→18)');
  assert.equal(settings.run.xpGrowth, 1.1, 'growth: the shipped xp growth (M11 T1: 1.13→1.10)');

  // The App is what actually asks twice, and no headless fixture here can
  // build one (M10's injection rule: what a test supplies, a test cannot
  // check). Pin the wiring; the behaviour is a browser check.
  //
  // The shape, not just the word: `picksPerLevel` alone still appears in the
  // reroll branch when the loop itself is gutted, and so does a bare
  // `_picksLeft > 1` — both read a one-card level-up as wired, and both were
  // caught by sabotaging this in turn. It matches the guard verbatim now.
  //
  // Be honest about what that is worth: a source match proves the line is
  // present, never that it runs. The real check is the browser pass ("point
  // the first card, the panel says 2/2 and stays open"), which is what M10's
  // injection rule asks for. This one exists to make an accidental deletion
  // loud without waiting for a browser.
  {
    const appSrc = readFileSync(new URL('../src/core/App.js', import.meta.url), 'utf8');
    assert.match(appSrc, /settings\.upgrades\.picksPerLevel/, 'wiring: App reads picksPerLevel');
    assert.match(appSrc, /if \(this\._picksLeft > 1\) \{/, 'wiring: App deals another hand while the level has picks left');
    assert.match(appSrc, /this\._picksLeft--/, 'wiring: …and spends one when it does');
  }

  console.log('ok  M11 T1: four skills maxed by minute ten');
}

/* ---- M11 T2: the difficulty model describes THIS game ---- */
{
  // `sim-run.mjs` kept its own copy of every number in the spec, with a note
  // saying it should read settings once the implementation landed. It had —
  // years of milestones ago — and the copy quietly went stale. M11 T1 changed
  // the xp curve and `npm run sim` printed four identical anchors, because it
  // was still dividing by `22 * 1.13^level`: a difficulty model describing a
  // game that no longer existed, and nothing could see it from outside.
  //
  // Everything with a settings source now reads it, and this is what stops it
  // drifting back. Not a source grep — the model's own functions, evaluated.
  const R = settings.run;
  const E = settings.enemies;

  for (const level of [0, 1, 5, 17, 36]) {
    assert.ok(
      Math.abs(SIM.xpNeed(level) - R.xpBase * Math.pow(R.xpGrowth, level)) < 1e-9,
      `sim: the level curve is the game's at Lv${level} (${SIM.xpNeed(level).toFixed(2)})`
    );
  }
  for (const minute of [0, 4, 9, 15]) {
    assert.ok(
      Math.abs(SIM.spawnPerMin(minute) - (R.spawnBase + R.spawnQuad * minute * minute)) < 1e-9,
      `sim: the spawn curve is the game's at minute ${minute}`
    );
    assert.ok(
      Math.abs(SIM.swarmHp(minute) - E.hpBase * (1 + E.hpPerMinute * minute)) < 1e-9,
      `sim: enemy hp is the game's at minute ${minute}`
    );
  }
  assert.equal(SIM.duration, R.duration, 'sim: the run is the same length as the game');
  assert.equal(SIM.popCap, R.enemyCap, 'sim: the horde caps where the game caps');
  assert.equal(SIM.playerHp, R.playerHp, 'sim: the player has the hp the game gives');
  assert.equal(SIM.gemElite, E.elites.gemValue, 'sim: an elite is worth what the game says');
  assert.deepEqual(
    SIM.hpMult,
    { swarm: E.swarm.hpMult, ranged: E.ranged.hpMult, tank: E.tank.hpMult },
    'sim: the three behaviours weigh what the game weighs them'
  );
  assert.ok(
    Math.abs(SIM.mix.swarm + SIM.mix.ranged + SIM.mix.tank - 1) < 1e-9 &&
      Math.abs(SIM.mix.ranged - E.mix.rangedShare) < 1e-9 &&
      Math.abs(SIM.mix.tank - E.mix.tankShare) < 1e-9,
    'sim: the behaviour mix is the game\'s, and still sums to one'
  );

  // Everything above compares the model against the numbers it should be
  // reading — which cannot tell "reads settings" from "happens to hold the
  // same constant", and two of those checks were blind for exactly that
  // reason (spawnBase is 20 and so was the old literal). Only moving the
  // source can tell them apart. Same probe M10 T3 needed for the cone's reach.
  {
    const moves = [
      ['run.spawnBase', () => R.spawnBase, (v) => { R.spawnBase = v; }, () => SIM.spawnPerMin(3)],
      ['run.spawnQuad', () => R.spawnQuad, (v) => { R.spawnQuad = v; }, () => SIM.spawnPerMin(3)],
      ['enemies.hpBase', () => E.hpBase, (v) => { E.hpBase = v; }, () => SIM.swarmHp(4)],
      ['enemies.hpPerMinute', () => E.hpPerMinute, (v) => { E.hpPerMinute = v; }, () => SIM.swarmHp(4)],
      ['run.xpBase', () => R.xpBase, (v) => { R.xpBase = v; }, () => SIM.xpNeed(6)],
      ['run.xpGrowth', () => R.xpGrowth, (v) => { R.xpGrowth = v; }, () => SIM.xpNeed(6)]
    ];
    for (const [name, get, set, read] of moves) {
      const before = get();
      const was = read();
      try {
        set(before * 1.5 + 1);
        assert.notEqual(read(), was, `sim: moving ${name} moves the model — otherwise it is a coincidence, not a read`);
      } finally {
        set(before);
      }
      assert.equal(get(), before, `sim: the ${name} probe put it back`);
      assert.equal(read(), was, `sim: …and the model came back with it`);
    }
  }

  // …and the boss is in the model at all. It was not, at first: the boss
  // landed in T3-T5 and `npm run sim` printed four unchanged anchors, exactly
  // the way the xp curve had lied one task earlier. A difficulty model that
  // cannot see the fight cannot be re-anchored around it.
  {
    assert.equal(
      SIM.bossAt,
      settings.tides.length * settings.run.boss.afterTides,
      'sim: the boss arrives in the model when it arrives in the game'
    );
    const savedHp = E.boss.hpMult;
    const savedDmg = E.boss.fight.charge.damage;
    try {
      const hpBefore = SIM.bossHp(9);
      E.boss.hpMult = savedHp * 2;
      assert.notEqual(SIM.bossHp(9), hpBefore, 'sim: the boss is as tough in the model as in the game');
      const dpsBefore = SIM.bossMoveDps;
      E.boss.fight.charge.damage = savedDmg * 3;
      // bossMoveDps is resolved once at module load, so this cannot move — and
      // that is the point of pinning the FORMULA rather than a number here.
      assert.ok(
        Math.abs(dpsBefore - (savedDmg / E.boss.fight.charge.every + E.boss.fight.quake.damage / E.boss.fight.quake.every)) < 1e-9,
        'sim: its pressure is its own move table, not a number typed twice'
      );
    } finally {
      E.boss.hpMult = savedHp;
      E.boss.fight.charge.damage = savedDmg;
    }
    assert.equal(settings.enemies.boss.hpMult, savedHp, 'sim: the probe put the boss back');
  }

  // The model-only constants are model-only ON PURPOSE — aggregates the
  // settings layer cannot express, and one calibration that must NOT be
  // rewired to the BASE_DPS anchor because the two mean different things.
  // Pinned so "it looks like a mirror, make it read settings" is a decision
  // rather than an accident.
  assert.equal(SIM.baseDps, 42, 'sim: baseDps stays a calibration, not the BASE_DPS anchor (which reads 50)');
  assert.ok(
    Math.abs(settings.combat.ice.damage / settings.ice.cooldown - 50) < 1e-9,
    'sim: …and the anchor it must not be confused with is still 50'
  );

  console.log('ok  M11 T2: the difficulty model describes this game, not the last one');
}

/* ---- M11 T3: something worth aiming all of it at ---- */
{
  // The boss is not a new kind of thing. It is a FOURTH BEHAVIOUR in the
  // enemy system — one more entry in BEHAVIORS with its own settings block —
  // so every hit test, every mark, every debuff channel and every one of the
  // thirty skills reaches it through the code they already run. A separate
  // body with its own hit test is how you ship a boss that six skills quietly
  // cannot touch; this way "zero special cases in the judging layer" is true
  // by construction, and the assertion below proves it rather than hoping.
  assert.deepEqual(BEHAVIORS, ['swarm', 'ranged', 'tank', 'boss'], 'boss: is a behaviour, not a parallel system');
  const B = settings.enemies.boss;
  assert.ok(B && B.hpMult > 50, 'boss: has its own stat block with a real hp multiplier');
  assert.ok(B.mass > settings.enemies.tank.mass * 5, 'boss: is heavy enough that knockback is a nudge, not a launch');
  assert.ok(B.radius > settings.enemies.tank.radius, 'boss: is physically bigger than a tank');
  assert.ok(B.slowResist > 0 && B.slowResist < 1, 'boss: resists slows without being immune to them');

  const cfg = settings.run.boss;
  assert.ok(cfg && cfg.afterTides >= 1, 'boss: its entrance is declared in tides, not a hardcoded minute');

  const makeRun = () => {
    const rng = createRng(4242);
    const enemies = new EnemySystem(rng);
    const tides = new TideSchedule(rng);
    const boss = new BossSystem(enemies, tides);
    return { enemies, tides, boss, rng };
  };

  // 1. It arrives on the tide, once, and the tide is where the number lives.
  {
    const { enemies, boss } = makeRun();
    const due = settings.tides.length * settings.run.boss.afterTides;
    const player = { x: 0, z: 0 };
    let spawnedAt = null;
    for (let t = 0; t < settings.run.duration; t += 1) {
      boss.tick(1, t, player);
      if (boss.active && spawnedAt === null) spawnedAt = t;
    }
    assert.ok(spawnedAt !== null, 'boss: it turns up at all');
    assert.ok(Math.abs(spawnedAt - due) <= 1, `boss: it turns up at the tide mark (${spawnedAt}s, due ${due}s)`);
    assert.equal(
      [...Array(enemies.count).keys()].filter((i) => enemies.behavior[i] === 3).length,
      1,
      'boss: exactly one of it, however many ticks ran'
    );
  }

  // 2. It is tracked by identity, not index. `_kill` compacts by swapping the
  //    last body into the hole, so an index captured at spawn points at some
  //    other enemy the moment anything dies — the classic way a boss health
  //    bar starts reporting a rat's hp.
  {
    const { enemies, boss } = makeRun();
    const player = { x: 0, z: 0 };
    for (let t = 0; t <= settings.tides.length * settings.run.boss.afterTides + 2; t += 1) boss.tick(1, t, player);
    assert.ok(boss.active, 'fixture: the boss is up');
    const bossId = enemies.id[boss.index];
    // Stand a crowd behind it and kill them off, forcing the swap-compaction.
    for (let k = 0; k < 20; k++) enemies.spawnAt(30 + k, 0, 5, 0, 0, 0);
    for (let k = 0; k < 20; k++) enemies.damage({ x: 30 + k, z: 0 }, 0.6, 1e6);
    assert.ok(boss.active, 'boss: still alive after the crowd around it died');
    assert.equal(enemies.id[boss.index], bossId, 'boss: still the same body — tracked by id, not by a stale index');
  }

  // 3a. Zero special cases, part one: every skill CombatSystem resolves damages
  //     it. The eight that resolve in their own classes (self/aura/shield) are
  //     covered by 3b — this fixture drives CombatSystem, and pretending it
  //     drove FireballAbility too would be the fixture lying about its reach.
  {
    const RESOLVED_HERE = new Set(['sweep', 'burst', 'lineTick', 'zoneTick', 'aura', 'coneTick']);
    const roster = ELEMENTS.filter(
      (el) => ABILITY_TYPES[el] && settings.combat[el] && RESOLVED_HERE.has(settings.combat[el].kind)
    );
    assert.ok(roster.length >= 18, `fixture: ${roster.length} skills resolve in CombatSystem — the sweep is meant to be broad`);
    const inert = [];
    for (const el of roster) {
      const rng = createRng(77);
      const enemies = new EnemySystem(rng);
      // Off the exact centre. An aura is an ANNULUS — 剑域 at Lv5 has an inner
      // edge of 2.26 m and the boss's own radius is 2.20, so a boss parked
      // precisely on the ring's centre sits 6 cm inside the hole and correctly
      // takes nothing (WYSIWYG: you can stand inside the ring of blades). That
      // is the fixture's placement, not the boss's reachability, and reading
      // it as "剑域 cannot hurt the boss" would have been this block lying.
      const i = enemies.spawnBoss(1.2, 0, 9);
      enemies.hp[i] = 5e5;
      const before = enemies.hp[i];
      const combat = new CombatSystem(new Targets(), null, () => 5);
      combat.targets.register(enemies);
      const c = settings.combat[el];
      const ability = {
        element: el, phase: 'impact', impactTime: 0.3, fadeTime: 0,
        position: { x: 0, z: 0 }, origin: { x: 0, z: 0 }, direction: { x: 1, z: 0 },
        length: 6, u: 1, autocast: false, quenched: false, fusionMult: 1, castId: 1
      };
      for (let t = 0; t < 240; t++) {
        ability.phase = t < 120 ? 'travel' : 'impact';
        ability.impactTime = t < 120 ? 0 : (t - 120) / 60;
        combat.tick(1 / 60, [ability]);
      }
      if (!(before - enemies.hp[i] > 0)) inert.push(`${el}(${c.kind})`);
    }
    assert.deepEqual(inert, [], `boss: every CombatSystem-resolved skill damages it — inert: ${inert.join(', ')}`);
  }

  // 3b. …and part two, for the eight that resolve their own hits. They all
  //     deliver through `Targets` → `EnemySystem`, so what could break for a
  //     2.2 m body is not the damage but the PAD: every hit test widens its
  //     reach by the target's own collision radius, and a test that assumed a
  //     swarm-sized 0.45 would clip a boss standing at the rim. Driven at a
  //     distance only the boss's own pad can bridge, one call per shape.
  {
    const rng = createRng(11);
    const enemies = new EnemySystem(rng);
    const bi = enemies.spawnBoss(0, 0, 9);
    enemies.hp[bi] = 5e5;
    const R = settings.enemies.boss.radius;
    // Stand the hit test's edge between a swarm pad and the boss's own: only a
    // correctly-padded test reaches. `at` is where the boss centre is; the
    // radius given is small enough that a 0.45 pad would fall short.
    const gap = R - 0.4;
    const shapes = [
      ['damage', () => enemies.damage({ x: gap, z: 0 }, 0.3, 100)],
      ['damageOnce', () => enemies.damageOnce(9001, { x: gap, z: 0 }, 0.3, 100)],
      ['damageRing', () => enemies.damageRing({ x: gap, z: 0 }, 0, 0.3, 100)],
      ['damageCone', () => enemies.damageCone({ x: gap, z: 0 }, -1, 0, Math.PI, 0.3, 100)]
    ];
    for (const [name, fire] of shapes) {
      const before = enemies.hp[bi];
      const hits = fire();
      assert.ok(hits > 0, `boss: ${name} pads by the boss's own radius, not a swarm's`);
      assert.ok(enemies.hp[bi] < before, `boss: ${name} actually took hp off it`);
    }
    const beforeSlow = enemies.slowed[bi];
    enemies.slow({ x: gap, z: 0 }, 0.3, 0.5, 2);
    assert.ok(enemies.slowed[bi] > beforeSlow, "boss: slow pads by the boss's own radius too");
  }

  // 4. It is heavy and stubborn, but not a statue: knockback barely moves it
  //    and a slow still bites, just less.
  {
    const rng = createRng(5);
    const enemies = new EnemySystem(rng);
    const bi = enemies.spawnBoss(0, 0, 9);
    const swarm = enemies.spawnAt(0, 3, 9, 0, 0, 0);
    enemies.knockback({ x: 0, z: 0 }, 6, 1);
    enemies.knockback({ x: 0, z: 3 }, 6, 1);
    assert.ok(
      Math.abs(enemies.kbX[bi]) + Math.abs(enemies.kbZ[bi]) <
        (Math.abs(enemies.kbX[swarm]) + Math.abs(enemies.kbZ[swarm])) * 0.2,
      'boss: the same shove moves it a fraction of what it moves a swarm body'
    );
    enemies.slow({ x: 0, z: 0 }, 8, 0.5, 2);
    assert.ok(enemies.slowed[bi] > 0, 'boss: a slow still lands on it');
    assert.ok(enemies.slowed[bi] < enemies.slowed[swarm], 'boss: …but bites less than on a swarm body');
    assert.ok(
      Math.abs(enemies.slowed[bi] - 0.5 * (1 - settings.enemies.boss.slowResist)) < 1e-6,
      'boss: and by exactly the resist the settings declare'
    );
  }

  // 5. Its presence decides nothing about the run's verdict, and its death is
  //    not a win. The run ends on the clock and on the player's hp, as before.
  {
    const { boss } = makeRun();
    assert.equal(typeof boss.hp01, 'number', 'boss: reports a 0..1 health fraction for the bar');
    assert.equal(boss.hp01, 0, 'boss: reads zero while it is not here');
    assert.equal(boss.active, false, 'boss: is not here before its tide');
  }

  // 6. The REAL run drives it. Every check above builds a BossSystem by hand
  //    and ticks it by hand — which is precisely the fixture-supplies-the-
  //    wiring trap M10 T3 shipped once (the test injected a `levelOf` the App
  //    never had). So: a real RunManager, started, ticked on its own clock,
  //    and nobody tells the boss what time it is.
  {
    const enemies = new EnemySystem(createRng(31));
    const boss = new BossSystem(enemies, new TideSchedule(createRng(32)));
    const run = new RunManager({
      enemies,
      pickups: new PickupSystem(createRng(33)),
      player: new PlayerState(),
      rng: createRng(34),
      tides: new TideSchedule(createRng(35)),
      boss,
      projectiles: new EnemyProjectiles(),
      combat: { tick: () => 0, release: () => -1, resetStats: () => {}, book: () => {} },
      targets: { register: () => {} },
      abilities: { active: [] }
    });
    run.start();
    assert.equal(boss.active, false, 'run: no boss at the start of a run');
    const due = settings.tides.length * settings.run.boss.afterTides;
    const player = { x: 0, z: 0 };
    // Real ticks on the run's own clock, no hand-set elapsed. The player is
    // kept upright on purpose: nine minutes of unanswered horde kills it, and
    // `tick` returns 'dead' without advancing anything — the run would stop
    // before the boss was ever due and this check would read "no boss" as a
    // defect. Same stopped-clock trap M9 T3 fell into.
    const alive = run.s.player;
    for (let t = 0; t < due - 2; t += 1 / 6) { alive.hp = alive.maxHp; run.tick(1 / 6, player); }
    assert.equal(boss.active, false, `run: still none two seconds before the ${due}s mark`);
    for (let t = 0; t < 4; t += 1 / 6) { alive.hp = alive.maxHp; run.tick(1 / 6, player); }
    assert.ok(boss.active, 'run: RunManager brings it on at the tide mark — nothing else had to');
    assert.ok(boss.hp01 > 0.99, 'run: it arrives at full health');

    // …and a restart puts it away again, so a second run gets its own.
    run.start();
    assert.equal(boss.active, false, 'run: a restart clears the boss');
  }

  console.log('ok  M11 T3: something worth aiming all of it at');
}

/* ---- M11 T4: a fight with three acts ---- */
{
  // Three phases and one new move each. The whole risk surface here is M8's
  // channel rule: every per-tick force/control/damage has to say, AT THE
  // CHANNEL, whether its number is a per-second RATE or a single IMPULSE.
  // That same mistake shipped four times in one milestone (sweep, aura,
  // coneTick, and the fusion grind), each time as a field that threw its own
  // targets clear and delivered a sixth of its budget. So each of the three
  // moves gets its own semantic assertion, and they are the point of this
  // block far more than "the phase changed".
  const F = settings.enemies.boss.fight;
  assert.ok(F, 'boss: the fight has its own block');
  assert.deepEqual(
    F.phaseAt.slice().sort((a, b) => b - a),
    F.phaseAt.slice(),
    'boss: phase thresholds descend'
  );
  assert.equal(F.phaseAt.length, 2, 'boss: three phases means two thresholds');
  assert.ok(F.phaseAt[0] < 1 && F.phaseAt[1] > 0, 'boss: the thresholds are real fractions');

  const stage = (hp01) => {
    const rng = createRng(61);
    const enemies = new EnemySystem(rng);
    const boss = new BossSystem(enemies, new TideSchedule(rng));
    boss.tick(1, boss.dueAt, { x: 0, z: 0 });
    const i = boss.index;
    enemies.hp[i] = boss._maxHp * hp01;
    // The boss walks in `run.boss.spawnDistance` away from the player, so a
    // dummy at the origin is fourteen metres from it — outside every move in
    // the table. Put targets where the boss actually is.
    const at = { x: enemies.x[i], z: enemies.z[i] };
    const dummy = (dx = 0, dz = 0) => {
      const j = enemies.spawnAt(at.x + dx, at.z + dz, 9, 0, 0, 0);
      enemies.hp[j] = 5e4;
      return j;
    };
    return { enemies, boss, i, at, dummy };
  };

  // 1. Phases step down at the thresholds, once each, and never step back up.
  {
    const { enemies, boss, i } = stage(1);
    assert.equal(boss.phase, 0, 'boss: opens in phase 0');
    const seen = [];
    for (let k = 0; k <= 100; k++) {
      enemies.hp[boss.index] = boss._maxHp * (1 - k / 100);
      boss.tick(1 / 60, boss.dueAt + k, { x: 0, z: 0 });
      seen.push(boss.phase);
    }
    for (let k = 1; k < seen.length; k++) {
      assert.ok(seen[k] >= seen[k - 1], `boss: phase never goes backwards (${seen[k - 1]} → ${seen[k]} at step ${k})`);
    }
    assert.equal(seen[seen.length - 1], 2, 'boss: reaches the last phase on the way down');
    assert.equal(new Set(seen).size, 3, 'boss: passes through all three, no skipping');
    // Healing it back up must not re-open an act.
    enemies.hp[boss.index] = boss._maxHp;
    boss.tick(1 / 60, boss.dueAt + 200, { x: 0, z: 0 });
    assert.equal(boss.phase, 2, 'boss: a heal does not rewind the fight');
    assert.ok(i >= 0);
  }

  // 2. THE CHANNEL RULE, move by move.
  //
  // 2a. 碾压冲锋 — the shove is an IMPULSE. One charge, one launch. Landing it
  //     twice in a row must therefore add twice, and the same charge applied
  //     over a longer tick must NOT get bigger: a per-tick reading of an
  //     impulse-sized number is exactly what threw 磁暴's targets at 45 m/s.
  {
    const a = stage(1);
    // Placement is load-bearing here, and two obvious spots are both blind.
    // The charge lands at range 8 with a 3.2 m blast: a body at -4 is outside
    // it and feels no baseline shove at all, and a body at -8 is dead centre,
    // where the push direction degenerates to zero. At -6 it is inside the
    // blast and off-centre, so a forgotten kbScale reads as 22 against the
    // bare impulse's 26 — which is the whole point of the check below.
    const t1 = a.dummy(-6, 0);
    a.boss.charge(a.at, { x: a.at.x - 8, z: a.at.z }, 1 / 60);
    const oneTick = Math.hypot(a.enemies.kbX[t1], a.enemies.kbZ[t1]);
    assert.ok(oneTick > 0, 'boss: the charge shoves at all');

    const b = stage(1);
    const t2 = b.dummy(-6, 0);
    b.boss.charge(b.at, { x: b.at.x - 8, z: b.at.z }, 1 / 6);
    const longTick = Math.hypot(b.enemies.kbX[t2], b.enemies.kbZ[t2]);
    assert.ok(
      Math.abs(longTick - oneTick) < oneTick * 0.01,
      `boss: the charge is an IMPULSE — a ten-times-longer tick must not shove ten times as hard (${oneTick.toFixed(3)} vs ${longTick.toFixed(3)})`
    );

    // …and it is ONE launch, not two. `damage()` applies a baseline shove of
    // its own unless told otherwise, so a charge that forgets to pass kbScale 0
    // lands its impulse AND that baseline — a double launch that the tick-length
    // check above cannot see, because both ticks would be equally wrong.
    // Measured against the bare impulse, which is the only shove that should
    // have happened.
    {
      const c = stage(1);
      const t3 = c.dummy(-6, 0);
      const row = settings.enemies.boss.fight.charge;
      const reach = Math.min(row.range, 8);
      c.enemies.knockback({ x: c.at.x, z: c.at.z }, reach + row.radius, row.knockback);
      const impulseOnly = Math.hypot(c.enemies.kbX[t3], c.enemies.kbZ[t3]);
      assert.ok(
        Math.abs(oneTick - impulseOnly) < impulseOnly * 0.02,
        `boss: the charge launches ONCE — ${oneTick.toFixed(3)} against the bare impulse's ${impulseOnly.toFixed(3)}`
      );
    }
  }

  // 2b. 震地 — the control is a DURATION, not a rate. Its slow timer must read
  //     the seconds the settings declare regardless of the tick it landed on.
  {
    for (const step of [1 / 60, 1 / 6]) {
      const a = stage(0.5);
      const t = a.dummy(3, 0);
      a.boss.quake(a.at, step);
      assert.ok(
        Math.abs(a.enemies.slowT[t] - F.quake.stunTime) < 1e-6,
        `boss: 震地's stun is a DURATION — ${F.quake.stunTime}s whatever the tick (step ${step.toFixed(3)} gave ${a.enemies.slowT[t].toFixed(3)})`
      );
      assert.ok(a.enemies.slowed[t] >= 0.99, 'boss: …and it is a full stun while it lasts');
    }
  }

  // 2c. 召唤 — a COUNT, not a rate. One call summons the number in the table,
  //     not that number per second.
  {
    for (const step of [1 / 60, 1 / 6]) {
      const a = stage(0.3);
      const before = a.enemies.count;
      a.boss.summon(9, step);
      assert.equal(
        a.enemies.count - before,
        F.summon.count,
        `boss: 召唤 is a COUNT — ${F.summon.count} bodies per call, not per second (step ${step.toFixed(3)})`
      );
    }
  }

  // 3. Every move telegraphs, and the warning is the real footprint (WYSIWYG).
  {
    const { boss } = stage(0.3);
    for (const move of ['charge', 'quake', 'summon']) {
      const row = F[move];
      assert.ok(row.every > 0, `boss: ${move} has a real cooldown`);
      assert.ok(row.telegraph > 0, `boss: ${move} warns before it lands`);
      assert.ok(row.telegraph < row.every, `boss: ${move}'s warning fits inside its cooldown`);
    }
    assert.ok(typeof boss.windup === 'object', 'boss: exposes what it is winding up, for the renderer to draw');
  }

  console.log('ok  M11 T4: a fight with three acts');
}

/* ---- M11 T5: the fight has to pay ---- */
{
  // A boss that drops nothing is a long fight with a shrug at the end. The
  // reward has to land in the systems that already carry rewards, not be a
  // particle burst that looks like one — so this drives the real death path
  // and looks in the real pickup system.
  const REWARD = settings.enemies.boss.reward;
  assert.ok(REWARD, 'boss: the kill has a declared reward');
  assert.ok(REWARD.gems > 0 && REWARD.gemValue > 0, 'boss: it drops real xp, in real gems');
  assert.ok(REWARD.levels >= 1, 'boss: …and hands the player at least one level outright');

  {
    const rng = createRng(71);
    const enemies = new EnemySystem(rng);
    const pickups = new PickupSystem(createRng(72));
    const bossSystem = new BossSystem(enemies, new TideSchedule(rng));
    const run = new RunManager({
      enemies, pickups, player: new PlayerState(), rng: createRng(73),
      tides: new TideSchedule(createRng(74)),
      boss: bossSystem,
      projectiles: new EnemyProjectiles(),
      combat: { tick: () => 0, release: () => -1, resetStats: () => {}, book: () => {} },
      targets: { register: () => {} },
      abilities: { active: [] }
    });
    run.start();
    bossSystem.tick(1, bossSystem.dueAt, { x: 0, z: 0 });
    assert.ok(bossSystem.active, 'fixture: the boss is up');

    const gemsBefore = pickups.count;
    const levelsBefore = run.pendingLevels;
    const i = bossSystem.index;
    // Kill it the way the game does — through damage, so onDeath fires.
    enemies.damage({ x: enemies.x[i], z: enemies.z[i] }, 1, 1e9);
    assert.equal(bossSystem.active, false, 'fixture: it died');
    // The system notices on its next tick, which is where the payout hangs.
    bossSystem.tick(1 / 60, bossSystem.dueAt + 1, { x: 0, z: 0 });

    assert.ok(
      pickups.count - gemsBefore >= REWARD.gems,
      `boss: its death drops the gems the table promises (${pickups.count - gemsBefore})`
    );
    assert.ok(
      run.pendingLevels - levelsBefore >= REWARD.levels,
      `boss: …and banks the levels too (${run.pendingLevels - levelsBefore})`
    );
    // Not a win, not a loss: the run carries on exactly as before.
    assert.equal(run.tick(1 / 60, { x: 0, z: 0 }), 'playing', 'boss: killing it does not end the run');
    // And it pays once. A second tick must not deal a second fortune.
    const after = pickups.count;
    bossSystem.tick(1 / 60, bossSystem.dueAt + 2, { x: 0, z: 0 });
    assert.equal(pickups.count, after, 'boss: it pays exactly once');
  }

  console.log('ok  M11 T5: the fight has to pay');
}

/* ---- M12 T1: the boss's fortune must not vanish into a full field ---- */
{
  // `dropAt` discards on a full field, and its own comment calls eviction
  // "M3 polish if ever needed". Needed: at minute nine the field IS full, and
  // a headless probe dropped fourteen boss gems into a full field and landed
  // ZERO. The most valuable drop in the game was riding the rule written for
  // the commonest one.
  const fill = (p, n, minute = 5) => { for (let k = 0; k < n; k++) p.dropAt(k * 0.1, 0, minute); };
  const total = (p) => { let t = 0; for (let k = 0; k < p.count; k++) t += p.value[k]; return t; };

  // 1. A valued drop evicts the cheapest gem instead of vanishing.
  {
    const p = new PickupSystem(createRng(81));
    fill(p, 4096); // overfill: count pins at CAP whatever CAP is
    const cap = p.count;
    const before = total(p);
    const cheapest = Math.min(...Array.from({ length: p.count }, (_, k) => p.value[k]));
    for (let k = 0; k < 14; k++) p.dropAt(0, 0, 9, 0, 40);
    assert.equal(p.count, cap, 'pickups: eviction keeps the field exactly at cap — no holes, no growth');
    let boss = 0;
    for (let k = 0; k < p.count; k++) if (p.value[k] === 40) boss++;
    assert.equal(boss, 14, 'pickups: all fourteen boss gems landed on a full field');
    assert.ok(total(p) > before, 'pickups: eviction trades up — the field is worth more than before');
    assert.ok(
      total(p) >= before + 14 * (40 - cheapest) - 1e-6,
      'pickups: what left was the cheapest, not whatever sat at the end'
    );
  }

  // 2. The common path is untouched: a plain gem still discards when full —
  //    and the probe gem is dropped at a LATER minute than the field, so it
  //    is genuinely worth more than the cheapest thing standing. The first
  //    cut dropped it at the same minute, where the trade-up guard refuses
  //    equal value anyway, and a sabotage that gave commons eviction passed
  //    (caught by sabotage S3): equal-value fixtures cannot tell "commons
  //    never evict" from "commons refuse an even trade".
  {
    const p = new PickupSystem(createRng(82));
    fill(p, 4096, 5);
    const cap = p.count;
    const before = total(p);
    p.dropAt(0, 0, 12); // minute 12: worth more than every minute-5 gem standing
    assert.equal(p.count, cap, 'pickups: a common gem on a full field still just does not fit');
    assert.ok(Math.abs(total(p) - before) < 1e-6, 'pickups: …and nothing was evicted for it, even though it was worth more');
  }

  // 3. …and below cap, both kinds land plainly.
  {
    const p = new PickupSystem(createRng(83));
    fill(p, 10);
    p.dropAt(0, 0, 5);
    p.dropAt(0, 0, 9, 0, 40);
    assert.equal(p.count, 12, 'pickups: below cap nothing changed at all');
  }

  console.log('ok  M12 T1: the boss fortune lands on a full field');
}

/* ---- M12 T2: the steles were already glowing, now they mean it ---- */
{
  const A = settings.run.altar;
  assert.ok(A && A.claimRadius > 0 && A.channelTime > 0, 'altar: has a real claim radius and channel time');

  // The altar IS the stele. Its positions are not written a second time —
  // AltarSystem imports Arena's own bearing formula, and this check stands
  // the player on ARENA's spot and expects the altar to notice. Two copies
  // of the formula would drift exactly like every mirror this project has
  // shot (M11's rule); one copy cannot.
  const steleXZ = (i) => {
    const b = bearingOf(i);
    return { x: Math.sin(b) * settings.run.arenaRadius, z: Math.cos(b) * settings.run.arenaRadius };
  };

  const mk = () => {
    const tides = new TideSchedule(createRng(91));
    const altar = new AltarSystem(tides);
    return { tides, altar };
  };

  // 1. Channel time is a DURATION (M8's channel rule): the same 1.6 seconds
  //    claims at a 1/60 tick and at a 1/6 tick — never "N ticks".
  for (const step of [1 / 60, 1 / 6]) {
    const { tides, altar } = mk();
    const el = tides.tideAt(10).element;
    const at = steleXZ(el);
    let claimed = null;
    altar.onClaim = (e) => { claimed = e; };
    let t = 10;
    let took = 0;
    while (claimed === null && took < 10) {
      altar.tick(step, tides.tideAt(t), at);
      t += step; took += step;
    }
    assert.ok(claimed !== null, `altar: standing at the lit stele claims (step ${step.toFixed(3)})`);
    assert.equal(claimed, el, 'altar: the claim carries the tide element');
    assert.ok(
      Math.abs(took - A.channelTime) <= step + 1e-9,
      `altar: the channel is ${A.channelTime}s whatever the tick (took ${took.toFixed(3)} at step ${step.toFixed(3)})`
    );
  }

  // 2. The other four steles are cold: standing there does nothing, all tide long.
  {
    const { tides, altar } = mk();
    const el = tides.tideAt(10).element;
    let claimed = 0;
    altar.onClaim = () => claimed++;
    for (let i = 0; i < 5; i++) {
      if (i === el) continue;
      const at = steleXZ(i);
      for (let k = 0; k < 300; k++) altar.tick(1 / 60, tides.tideAt(10 + k / 60), at);
    }
    assert.equal(claimed, 0, 'altar: a cold stele never grants anything');
  }

  // 3. Walking out resets the channel — half-progress does not bank.
  {
    const { tides, altar } = mk();
    const el = tides.tideAt(10).element;
    const at = steleXZ(el);
    let claimed = 0;
    altar.onClaim = () => claimed++;
    const half = Math.floor((A.channelTime / 2) * 60);
    for (let k = 0; k < half; k++) altar.tick(1 / 60, tides.tideAt(10), at);
    altar.tick(1 / 60, tides.tideAt(10), { x: 0, z: 0 }); // stepped out
    for (let k = 0; k < half + 2; k++) altar.tick(1 / 60, tides.tideAt(10), at);
    assert.equal(claimed, 0, 'altar: stepping out resets the channel — half plus half is not a claim');
  }

  // 4. Once per tide; the NEXT tide re-arms at the NEW element's stele.
  {
    const { tides, altar } = mk();
    const len = settings.tides.length;
    const claims = [];
    altar.onClaim = (e) => claims.push(e);
    const first = tides.tideAt(10).element;
    for (let k = 0; k < 600; k++) altar.tick(1 / 60, tides.tideAt(10 + k / 60), steleXZ(first));
    assert.equal(claims.length, 1, 'altar: one claim per tide, however long you loiter');
    const second = tides.tideAt(len + 10).element;
    assert.notEqual(second, first, 'fixture: consecutive tides differ');
    for (let k = 0; k < 600; k++) altar.tick(1 / 60, tides.tideAt(len + 10 + k / 60), steleXZ(second));
    assert.equal(claims.length, 2, 'altar: the next tide re-arms it at the new stele');
    assert.deepEqual(claims, [first, second], 'altar: each claim carried its own tide');
    altar.reset();
    for (let k = 0; k < 600; k++) altar.tick(1 / 60, tides.tideAt(len + 10 + k / 60), steleXZ(second));
    assert.equal(claims.length, 3, 'altar: a reset (new run) forgets the old claims');
  }

  // 5. The REAL RunManager drives it and the claim lands on the SHARD-HAND
  //    path — the machinery the reward reuses (M10/M11: hand-ticked fixtures
  //    cannot see missing wiring).
  {
    const enemies = new EnemySystem(createRng(92));
    const tides = new TideSchedule(createRng(93));
    const altar = new AltarSystem(tides);
    const run = new RunManager({
      enemies,
      pickups: new PickupSystem(createRng(94)),
      player: new PlayerState(),
      rng: createRng(95),
      tides,
      altar,
      boss: new BossSystem(enemies, tides),
      projectiles: new EnemyProjectiles(),
      combat: { tick: () => 0, release: () => -1, resetStats: () => {}, book: () => {} },
      targets: { register: () => {} },
      abilities: { active: [] }
    });
    const hands = [];
    run.onShardHand = (el) => hands.push(el);
    run.start();
    const el = run.tide().element;
    const at = steleXZ(el);
    const alive = run.s.player;
    for (let k = 0; k < 60 * 4; k++) { alive.hp = alive.maxHp; run.tick(1 / 60, at); }
    assert.equal(hands.length, 1, 'altar: a real run, a real claim, and it opens the directional hand');
    assert.equal(hands[0], el, 'altar: …of the tide element');
    run.start();
    assert.equal(altar.progress01, 0, 'altar: a restart clears the channel');
  }

  // 6. The growth model sees it (M11's mirror rule): the cadence reads the
  //    tide length LIVE, so perturbing the source moves the model.
  {
    const before = SIM.altarEvery();
    const saved = settings.tides.length;
    try {
      settings.tides.length = saved + 60;
      assert.notEqual(SIM.altarEvery(), before, 'sim: the altar cadence follows the tide length — a read, not a coincidence');
    } finally {
      settings.tides.length = saved;
    }
    assert.equal(SIM.altarEvery(), before, 'sim: the probe put the tide length back');
  }

  console.log('ok  M12 T2: the steles were already glowing, now they mean it');
}

/* ---- fixed timestep: n ticks regardless of frame slicing ---- */
{
  const count = { a: 0, b: 0 };
  const a = new GameClock(60);
  a.advance(1.0, () => count.a++); // one whole second in one frame
  const b = new GameClock(60);
  for (let i = 0; i < 100; i++) b.advance(0.01, () => count.b++); // same second, sliced
  assert.equal(count.a, 60, 'clock: one second is 60 ticks');
  assert.equal(count.b, 60, 'clock: slicing frames must not change tick count');
  const alpha = new GameClock(60).advance(1 / 120, () => {});
  assert.ok(alpha > 0.49 && alpha < 0.51, 'clock: half a step leaves alpha ~0.5');
  console.log('ok  game clock');
}

/* ---- targets facade: routing + graceful degradation ---- */
{
  const log = [];
  const pop = {
    hits: () => true,
    damage: (p, r, amount) => (log.push(amount), 2)
    // no damageOnce / slow on purpose — facade must degrade politely
  };
  const targets = new Targets();
  targets.register(pop);
  assert.equal(targets.hits({ x: 0, z: 0 }, 1), true);
  assert.equal(targets.damage({ x: 0, z: 0 }, 1, 10), 2);
  assert.equal(targets.damageOnce(7, { x: 0, z: 0 }, 1, 10), 2, 'falls back to damage');
  targets.slow({ x: 0, z: 0 }, 1, 0.5, 1); // must not throw
  assert.deepEqual(log, [10, 10]);
  console.log('ok  targets facade');
}

/* ---- enemies: seek, separation, damage, dedup, death ---- */
{
  const enemies = new EnemySystem(createRng(1));

  // Seek: an enemy left of the player must step right.
  const i = enemies.spawnAt(-5, 0, 0);
  enemies.tick(1 / 60, { x: 0, z: 0 }, 0);
  assert.ok(enemies.x[i] > -5, 'enemies: seek moves toward the player');

  // Contact: an enemy standing on the player deals one full hit per tick.
  enemies.clear();
  enemies.spawnAt(0, 0, 0);
  assert.equal(
    enemies.tick(1 / 60, { x: 0, z: 0 }, 0),
    settings.enemies.swarm.contactDamage,
    'enemies: contact reports one full hit, not a dps slice'
  );

  // Separation: two stacked enemies push apart.
  enemies.clear();
  enemies.spawnAt(0, 0, 0);
  enemies.spawnAt(0.05, 0, 0);
  for (let t = 0; t < 30; t++) enemies.tick(1 / 60, { x: 50, z: 0 }, 0);
  const gap = Math.abs(enemies.x[1] - enemies.x[0]);
  assert.ok(gap > 0.2, `enemies: separation opened only ${gap.toFixed(3)}m`);

  // Slow: a slowed enemy covers measurably less ground than a free one.
  // Also pins that slow() stays callable — a field named `slow` once shadowed it.
  enemies.clear();
  assert.equal(typeof enemies.slow, 'function', 'enemies: slow() must not be shadowed by a field');
  enemies.spawnAt(-5, 0, 0);
  enemies.spawnAt(5, 0, 0);
  enemies.slow({ x: -5, z: 0 }, 1, 0.5, 1);
  enemies.tick(1 / 60, { x: 0, z: 0 }, 0);
  const slowedStep = Math.abs(enemies.x[0] - enemies.prevX[0]);
  const freeStep = Math.abs(enemies.x[1] - enemies.prevX[1]);
  assert.ok(
    slowedStep < freeStep * 0.75,
    `enemies: slow barely bit (${slowedStep.toFixed(4)} vs ${freeStep.toFixed(4)})`
  );

  // Damage + dedup: damageOnce with one castId hits an enemy a single time.
  enemies.clear();
  enemies.spawnAt(0, 0, 0);
  const hpBefore = enemies.hp[0];
  enemies.damageOnce(99, { x: 0, z: 0 }, 1, 5);
  enemies.damageOnce(99, { x: 0, z: 0 }, 1, 5);
  assert.equal(hpBefore - enemies.hp[0], 5, 'enemies: same cast never double-hits');

  // Death: hp to zero fires onDeath and shrinks count via swap-remove.
  let deaths = 0;
  enemies.onDeath = () => deaths++;
  enemies.damage({ x: 0, z: 0 }, 1, 1e6);
  assert.equal(deaths, 1);
  assert.equal(enemies.count, 0);

  // Bodies have reach: a probe that misses the centre but clips the capsule's
  // radius still hits — the fireball's narrow fuse depends on this.
  enemies.clear();
  enemies.spawnAt(0, 0, 0);
  const body = settings.enemies.swarm.radius;
  assert.ok(enemies.hits({ x: 0.3 + body, z: 0 }, 0.4), 'enemies: clipping the body is a hit');
  assert.ok(!enemies.hits({ x: 0.5 + body, z: 0 }, 0.4), 'enemies: past the body is a miss');

  // Hit readouts: every landed hit reports once (damage figures hang off
  // this), and a dedup'd repeat stays silent.
  enemies.clear();
  enemies.onHit = null;
  const hitLog = [];
  enemies.onHit = (x, z, amount) => hitLog.push(amount);
  enemies.spawnAt(0, 0, 0);
  enemies.damage({ x: 0, z: 0 }, 1, 3);
  enemies.damageOnce(41, { x: 0, z: 0 }, 1, 3);
  enemies.damageOnce(41, { x: 0, z: 0 }, 1, 3); // same cast — no hit, no figure
  assert.deepEqual(hitLog, [3, 3], 'enemies: each landed hit reports exactly once');
  enemies.onHit = null;

  // Cap: the 301st spawn is refused.
  enemies.clear();
  for (let n = 0; n < 300; n++) assert.ok(enemies.spawnAt(n * 0.1, 0, 0) >= 0);
  assert.equal(enemies.spawnAt(0, 0, 0), -1, 'enemies: hard cap holds');
  console.log('ok  enemy system');
}

/* ---- combat: the shape table drives targets calls ---- */
{
  const calls = [];
  const fakeTargets = {
    damageOnce: (id, p, r, amt) => (calls.push(['once', p.x.toFixed(1), amt]), 1),
    damage: (p, r, amt) => (calls.push(['dmg', amt]), 1),
    slow: (p, r, f, d) => calls.push(['slow', f])
  };
  const combat = new CombatSystem(fakeTargets);

  // A travelling ice sweep: damage rides the front, slow rides behind it.
  const ice = {
    element: 'ice', phase: 'travel', age: 0.2,
    position: { x: 3, z: 0 }, origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 }, length: 8, u: 0.4
  };
  combat.tick(1 / 60, [ice]);
  assert.ok(calls.some(([k]) => k === 'once'), 'combat: sweep deals damageOnce at the front');
  assert.ok(calls.some(([k]) => k === 'slow'), 'combat: ice applies its slow');

  // No tunneling: the front's position advances per render frame, so one tick
  // can observe a jump far past the sweep width. Every point of the jumped
  // segment must still be covered — an enemy 4m along a 0→8m jump sits well
  // inside some sample's width even though no single observation was near it.
  {
    const seen = [];
    const seg = new CombatSystem({
      damageOnce: (id, p, r) => (seen.push(p.x), 0),
      damage: () => 0,
      slow: () => {}
    });
    const jumpy = {
      element: 'ice', phase: 'travel', age: 0.3,
      position: { x: 8, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 8, u: 1 // front leapt 0→8m in one look
    };
    seg.tick(1 / 60, [jumpy]);
    const width = settings.combat.ice.width;
    assert.ok(
      seen.some((x) => Math.abs(x - 4) <= width),
      'combat: a sweep samples the segment it travelled, not just the front'
    );

    // The phase can flip to impact between looks; the landing must flush the
    // unseen tail of the line, and flush it once.
    seen.length = 0;
    const landedEarly = {
      element: 'ice', phase: 'impact', age: 0.4, impactTime: 0.02,
      position: { x: 8, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 8, u: 1 // combat never saw it travel
    };
    seg.tick(1 / 60, [landedEarly]);
    assert.ok(
      seen.some((x) => Math.abs(x - 7.9) <= width),
      'combat: landing flushes the tail of the sweep'
    );
    const flushed = seen.length;
    seg.tick(1 / 60, [landedEarly]);
    assert.equal(seen.length, flushed, 'combat: the tail flush happens once');
  }

  // A holding beam ticks dps along the whole line, budgeted per tick.
  // One second of ticks must sum to ≈ the configured dps (3 samples of
  // (dps/3)·step each), so the anchor is the dps itself: 60.
  calls.length = 0;
  const beam = {
    element: 'beam', phase: 'impact', age: 0.5, impactTime: 0.2,
    position: { x: 8, z: 0 }, origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 }, length: 8, u: 1
  };
  for (let t = 0; t < 60; t++) combat.tick(1 / 60, [beam]);
  const total = calls.filter(([k]) => k === 'dmg').reduce((s, [, amt]) => s + amt, 0);
  assert.ok(Math.abs(total - 60) < total * 0.35, `combat: beam dps budget ≈ dps (got ${total.toFixed(0)})`);

  // A burst detonates exactly once per cast, however many fixed ticks observe
  // the impact phase (60Hz logic under a variable render rate). Burn ticks may
  // land beside it — only the full-damage call counts as the detonation.
  let detonations = 0;
  let burns = 0;
  const countTargets = {
    damageOnce: () => 1,
    damage: (p, r, amt) => (amt === settings.combat.meteor.damage ? detonations++ : burns++, 1),
    slow: () => {}
  };
  const burstCombat = new CombatSystem(countTargets);
  const meteor = {
    element: 'meteor', phase: 'impact', age: 1.0,
    position: { x: 2, z: 2 }, origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 }, length: 10, u: 1, impactTime: 0, fadeTime: 0
  };
  // 30 ticks = 0.5s of impact: enough for the 12dps burn to bank whole points.
  for (let t = 0; t < 30; t++) {
    meteor.impactTime += 1 / 60;
    burstCombat.tick(1 / 60, [meteor]);
  }
  assert.equal(detonations, 1, 'combat: burst detonates exactly once per cast');
  assert.ok(burns > 0, 'combat: the lava burn ticks while burnTime holds');

  // The lava goes out when the knob says so: impactTime + fadeTime is seconds
  // since impact, and past burnTime no further burn damage may land.
  meteor.phase = 'fade';
  meteor.fadeTime = settings.combat.meteor.burnTime; // sum now past the knob
  const burnsAtCutoff = burns;
  for (let t = 0; t < 60; t++) burstCombat.tick(1 / 60, [meteor]);
  assert.equal(burns, burnsAtCutoff, 'combat: the burn stops when burnTime says so');

  // Cast ids are stable for the cast's whole lifetime — even at u=0, where a
  // low timeScale can queue two fixed ticks before the front moves. Two ticks,
  // one id, or the sweep double-hits at full damage on the origin. Only
  // release() retires the id; the next tick after it mints fresh.
  const ids = new Set();
  const idTargets = {
    damageOnce: (id) => (ids.add(id), 1),
    damage: () => 1,
    slow: () => {}
  };
  const idCombat = new CombatSystem(idTargets);
  const sweep = {
    element: 'thunder', phase: 'travel', age: 0,
    position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 }, length: 8, u: 0
  };
  idCombat.tick(1 / 60, [sweep]);
  idCombat.tick(1 / 60, [sweep]);
  assert.equal(ids.size, 1, 'combat: queued ticks at u=0 share one castId');
  idCombat.release(sweep); // the pool hands the object to a new cast...
  idCombat.tick(1 / 60, [sweep]);
  assert.equal(ids.size, 2, 'combat: a released cast mints a fresh castId');
  console.log('ok  combat shapes');
}

/* ---- M6 T4: aura annulus tick math, healPlayer routing, stunTime ---- */
{
  // Aura: a genuine annulus, not a filled disc — and the per-tick amount is
  // settings.combat's `dps` used directly (it already carries the ×0.7
  // self-aura shape coefficient at balance time, per that block's own
  // comment — this pins that CombatSystem doesn't re-apply it on top).
  const hits = [];
  const auraCombat = new CombatSystem({
    damage: () => 0,
    damageOnce: () => 0,
    slow: () => {},
    damageRing: (point, inner, outer, amt) => (hits.push({ inner, outer, amt }), 1)
  });
  const row = settings.combat.bladeorbit;
  const bladeorbit = {
    element: 'bladeorbit', phase: 'travel', age: 1,
    position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 }, length: 1, u: 0
  };
  auraCombat.tick(1 / 60, [bladeorbit]);
  assert.equal(hits.length, 1, 'aura: ticks exactly once per active cast per frame');
  assert.ok(Math.abs(hits[0].outer - row.radius) < 1e-9, 'aura: outer edge is the combat radius');
  assert.ok(
    Math.abs(hits[0].inner - (row.radius - row.band)) < 1e-9,
    'aura: inner edge is radius - band'
  );
  const expectedAmt = row.dps * (1 / 60);
  assert.ok(
    Math.abs(hits[0].amt - expectedAmt) < 1e-9,
    `aura: per-tick amount is dps×step, not the 0.7 coefficient re-applied (got ${hits[0].amt}, want ${expectedAmt})`
  );

  // The annulus's actual geometry, against a real EnemySystem: an enemy
  // riding the ring takes damage, one at the caster's own feet (well inside
  // the inner edge) or well past the outer edge takes nothing.
  {
    const enemies = new EnemySystem(createRng(21));
    const onRing = enemies.spawnAt(row.radius - row.band * 0.5, 0, 0);
    const deadCentre = enemies.spawnAt(0.01, 0, 0);
    const wellOutside = enemies.spawnAt(row.radius + 5, 0, 0);
    const before = { ring: enemies.hp[onRing], centre: enemies.hp[deadCentre], out: enemies.hp[wellOutside] };
    enemies.damageRing({ x: 0, z: 0 }, row.radius - row.band, row.radius, 10, -1);
    assert.ok(enemies.hp[onRing] < before.ring, 'aura annulus: an enemy riding the ring takes damage');
    assert.equal(enemies.hp[deadCentre], before.centre, 'aura annulus: dead centre (inside the inner edge) takes nothing');
    assert.equal(enemies.hp[wellOutside], before.out, 'aura annulus: past the outer edge takes nothing');
  }

  // healPlayer (lifebloom): tick() reports the heal due — CombatSystem's
  // constructor still takes no player reference; RunManager is the one
  // place that actually spends it (see CombatSystem.tick's own doc).
  const healCombat = new CombatSystem({ damage: () => 1, damageOnce: () => 1, slow: () => {} });
  const lifebloom = {
    element: 'lifebloom', phase: 'impact', age: 0.2, impactTime: 0.05, fadeTime: 0,
    position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 }, length: 1, u: 1
  };
  const healed = healCombat.tick(1 / 60, [lifebloom]);
  assert.equal(healed, settings.combat.lifebloom.healPlayer, 'burst: healPlayer reports its flat amount on detonation');
  assert.equal(healCombat.tick(1 / 60, [lifebloom]), 0, 'burst: healPlayer fires exactly once per cast');

  // stunTime (boulder): a full-strength (1.0) slow, same debuff channel a
  // plain slowFactor already rides — not a separate mechanic.
  const slows = [];
  const stunCombat = new CombatSystem({
    damage: () => 1,
    damageOnce: () => 1,
    slow: (p, r, f, d) => slows.push({ f, d })
  });
  const boulder = {
    element: 'boulder', phase: 'impact', age: 0.2, impactTime: 0.05, fadeTime: 0,
    position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 }, length: 1, u: 1
  };
  stunCombat.tick(1 / 60, [boulder]);
  assert.equal(slows.length, 1, 'burst: stunTime applies exactly one slow call');
  assert.equal(slows[0].f, 1, 'burst: stunTime is full-strength (factor 1.0)');
  assert.equal(slows[0].d, settings.combat.boulder.stunTime, 'burst: stunTime\'s own duration, not slowTime');

  // knockback (quake): the burst composes an extra shockwave shove on top of
  // the baseline impulse damage() already applied — enemy in radius ends up
  // shoved harder than one hit by a plain no-knockback burst of equal size.
  {
    const enemies = new EnemySystem(createRng(22));
    const shoved = enemies.spawnAt(2, 0, 0);
    enemies.damage({ x: 0, z: 0 }, settings.combat.quake.radius, 1, -1);
    const baseline = enemies.kbX[shoved];
    enemies.knockback({ x: 0, z: 0 }, settings.combat.quake.radius, settings.combat.quake.knockback);
    const extra = enemies.kbX[shoved] - baseline;
    assert.ok(baseline > 0, 'knockback: damage() itself shoves outward');
    assert.ok(
      Math.abs(extra - baseline * (settings.combat.quake.knockback / settings.enemies.knockback)) < 1e-9,
      'knockback: sweep adds impulse/mass·kbMult on the same channel, scaled by the row value'
    );
    const outside = enemies.spawnAt(settings.combat.quake.radius + 5, 0, 0);
    enemies.knockback({ x: 0, z: 0 }, settings.combat.quake.radius, 9);
    assert.equal(enemies.kbX[outside], 0, 'knockback: past the radius takes no shove');
  }

  console.log('ok  M6 T4: aura annulus, healPlayer routing, stunTime, quake knockback');
}

/* ---- M6 T5: shield kind — detonate-once routing, player-agnostic (mirrors healPlayer) ---- */
{
  // CombatSystem stays player-agnostic: tick()'s numeric return is already
  // pinned to healDue by the M6 T4 assertion above, so the shield event
  // routes out through the public `shieldDue` field instead — RunManager is
  // the one place that actually calls player.addShield() (see
  // CombatSystem.tick's own doc, same shape as healPlayer's routing).
  const shieldCombat = new CombatSystem({ damage: () => 1, damageOnce: () => 1, slow: () => {} });
  const iceshield = {
    element: 'iceshield', phase: 'travel', age: 0.01, impactTime: 0, fadeTime: 0,
    position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 }, length: 1, u: 0
  };
  assert.equal(shieldCombat.shieldDue.amount, 0, 'shield: shieldDue starts at 0, nothing cast yet');
  shieldCombat.tick(1 / 60, [iceshield]);
  assert.equal(shieldCombat.shieldDue.amount, settings.combat.iceshield.amount, 'shield: tick() reports the flat amount on cast');
  assert.equal(shieldCombat.shieldDue.duration, settings.combat.iceshield.duration, 'shield: ...and its duration');
  assert.equal(shieldCombat.shieldDue.reflectShare, 0, 'shield: iceshield carries no reflectShare');

  shieldCombat.tick(1 / 60, [iceshield]);
  assert.equal(shieldCombat.shieldDue.amount, 0, 'shield: detonates exactly once per cast — silent on every later tick');

  const stoneskinCast = {
    element: 'stoneskin', phase: 'travel', age: 0.01, impactTime: 0, fadeTime: 0,
    position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 }, length: 1, u: 0
  };
  shieldCombat.tick(1 / 60, [stoneskinCast]);
  assert.equal(shieldCombat.shieldDue.amount, settings.combat.stoneskin.amount, 'shield: stoneskin reports its own amount');
  assert.equal(shieldCombat.shieldDue.reflectShare, settings.combat.stoneskin.reflectShare, 'shield: stoneskin carries reflectShare');

  console.log('ok  M6 T5: shield kind routing');
}

/* ---- M6 T5: shield absorption + stoneskin reflect, end to end through RunManager ---- */
{
  const rng = createRng(51);
  const enemies = new EnemySystem(rng);
  const pickups = new PickupSystem();
  const player = new PlayerState();
  const run = new RunManager({
    enemies, pickups, player, rng,
    tides: new TideSchedule(createRng(51)),
    projectiles: new EnemyProjectiles(),
    combat: { tick: () => {}, release: () => -1, resetStats: () => {}, book: () => {} },
    targets: { register: () => {} },
    abilities: { active: [] }
  });
  run.start();

  // Casting the shield itself is CombatSystem/App's job (covered above and
  // in the browser checklist) — this test drives PlayerState + RunManager's
  // contact/reflect wiring directly, the same way the reaction-routing test
  // elsewhere in this file calls enemies.onReaction(...) directly.
  player.addShield(settings.combat.stoneskin.amount, settings.combat.stoneskin.duration, settings.combat.stoneskin.reflectShare);

  // One touching enemy planted right on the player so contact fires this tick.
  const toucher = enemies.spawnAt(0.3, 0, 0, 0, 0); // swarm, well inside contact range of {0,0}
  const hpBefore = enemies.hp[toucher];
  const shieldBefore = player.shield;
  run.tick(1 / 60, { x: 0, z: 0 });

  assert.ok(player.shield < shieldBefore, 'reflect: contact drains the shield, not hp');
  assert.equal(player.hp, settings.run.playerHp, 'reflect: fully absorbed (8 contact < 55 shield) — hp untouched');
  const absorbed = shieldBefore - player.shield;
  const expectedReflect = absorbed * settings.combat.stoneskin.reflectShare;
  assert.ok(
    Math.abs(hpBefore - enemies.hp[toucher] - expectedReflect) < 1e-6,
    `reflect: the toucher takes back absorbed×reflectShare (want ${expectedReflect}, got ${hpBefore - enemies.hp[toucher]})`
  );

  // iceshield carries no reflectShare — an absorbed hit drains the pool but
  // sends nothing back.
  const enemies2 = new EnemySystem(createRng(52));
  const player2 = new PlayerState();
  const run2 = new RunManager({
    enemies: enemies2, pickups: new PickupSystem(), player: player2, rng: createRng(52),
    tides: new TideSchedule(createRng(52)),
    projectiles: new EnemyProjectiles(),
    combat: { tick: () => {}, release: () => -1, resetStats: () => {}, book: () => {} },
    targets: { register: () => {} },
    abilities: { active: [] }
  });
  run2.start();
  player2.addShield(settings.combat.iceshield.amount, settings.combat.iceshield.duration);
  const toucher2 = enemies2.spawnAt(0.3, 0, 0, 0, 0);
  const hp2Before = enemies2.hp[toucher2];
  run2.tick(1 / 60, { x: 0, z: 0 });
  assert.ok(player2.shield < settings.combat.iceshield.amount, 'reflect: iceshield still absorbs the contact');
  assert.equal(enemies2.hp[toucher2], hp2Before, 'reflect: iceshield (reflectShare 0) sends nothing back');

  // 勘误 D-M6-2, end to end: a toucher glued to the player across many
  // fixed-step ticks must land only one bite per contactMercy window (≈0.5s,
  // settings.run.iframes), not one per 1/60s tick.
  const enemiesGrind = new EnemySystem(createRng(53));
  const playerGrind = new PlayerState();
  const runGrind = new RunManager({
    enemies: enemiesGrind, pickups: new PickupSystem(), player: playerGrind, rng: createRng(53),
    tides: new TideSchedule(createRng(53)),
    projectiles: new EnemyProjectiles(),
    combat: { tick: () => {}, release: () => -1, resetStats: () => {}, book: () => {} },
    targets: { register: () => {} },
    abilities: { active: [] }
  });
  runGrind.start();
  playerGrind.addShield(settings.combat.iceshield.amount, settings.combat.iceshield.duration);
  enemiesGrind.spawnAt(0.3, 0, 0, 0, 0); // stays glued — well inside contact range every tick
  for (let t = 0; t < 20; t++) runGrind.tick(1 / 60, { x: 0, z: 0 }); // 1/3s, inside the 0.5s window throughout
  assert.equal(
    playerGrind.shield,
    settings.combat.iceshield.amount - settings.enemies.swarm.contactDamage,
    'contactMercy: twenty ticks of continuous contact land only one bite, not twenty'
  );

  console.log('ok  M6 T5: shield absorption + stoneskin reflect');
}

/* ---- M6 T6: chainHops — dedup, radius cutoff, hop cap, early stop ---- */
{
  // Straight-line chain: from(0,0) → a(0,2) → b(0,4) → c(0,6) → d(0,8), each
  // hop exactly 2m from the last — well inside hopRadius(6) — plus a 5th
  // candidate e(0,10) that's ALSO in range of d but must be excluded purely
  // by the hop-count budget (requested 4).
  const enemies = new EnemySystem(createRng(61));
  const from = enemies.spawnAt(0, 0, 0);
  const a = enemies.spawnAt(0, 2, 0);
  const b = enemies.spawnAt(0, 4, 0);
  const c = enemies.spawnAt(0, 6, 0);
  const d = enemies.spawnAt(0, 8, 0);
  enemies.spawnAt(0, 10, 0); // e — in range of d, excluded only by the hop cap below

  const hops = chainHops(enemies, from, 4, 6);
  assert.deepEqual(hops, [a, b, c, d], 'chainHops: walks the chain in order');
  assert.equal(hops.length, 4, 'chainHops: hop count ≤ the requested budget, even with a 5th in-range candidate');

  // Radius cutoff, the assertion's own example: an enemy at 6.1m from the
  // current node is not chained — and with nothing else in range, the chain
  // stops early despite hop budget left over.
  const enemies2 = new EnemySystem(createRng(62));
  const from2 = enemies2.spawnAt(0, 0, 0);
  const near2 = enemies2.spawnAt(0, 3, 0); // 3m from from2 → hop1
  enemies2.spawnAt(0, 3 + 6.1, 0); // 6.1m from near2 — must not chain

  const hops2 = chainHops(enemies2, from2, 4, 6);
  assert.deepEqual(hops2, [near2], 'chainHops: an enemy at 6.1m from the current node is excluded (radius cutoff)');
  assert.equal(hops2.length, 1, 'chainHops: stops early once nothing left is in range, hop budget or not');

  // Dedup: the seed is nearer to hop1's position than the real hop2
  // candidate is — without dedup this would loop straight back onto it.
  const enemies3 = new EnemySystem(createRng(63));
  const from3 = enemies3.spawnAt(0, 0, 0);
  const p1 = enemies3.spawnAt(0, 2, 0); // 2m from from3 → hop1
  const p2 = enemies3.spawnAt(0, 6, 0); // 4m from p1 (from3 is only 2m from p1 — nearer — but already seen)

  const hops3 = chainHops(enemies3, from3, 4, 6);
  assert.deepEqual(hops3, [p1, p2], 'chainHops: dedup — the already-hit seed is never revisited even when it would otherwise be nearest');

  // Controller-ruled decay sequence (T6 dispatch): pure arithmetic, no
  // EnemySystem needed — pins settings.chainbolt.damage/hops/hopDecay
  // directly against the ruling's own stated numbers.
  const seq = [settings.chainbolt.damage];
  for (let i = 0; i < settings.chainbolt.hops; i++) seq.push(seq[seq.length - 1] * settings.chainbolt.hopDecay);
  const wantSeq = [20, 17, 14.45, 12.28, 10.44];
  assert.equal(seq.length, wantSeq.length, 'chainbolt: 1 first hit + hops(4) additional = 5 total damage terms');
  for (let i = 0; i < wantSeq.length; i++) {
    assert.ok(
      Math.abs(seq[i] - wantSeq[i]) < 0.01,
      `chainbolt damage sequence: hit ${i} is ${wantSeq[i]} (got ${seq[i].toFixed(4)})`
    );
  }

  console.log('ok  M6 T6: chainHops (dedup, radius cutoff, hop cap, early stop, decay sequence)');
}

/* ---- M6 T6: dashTarget — arena clamp ---- */
{
  const free = dashTarget(0, 0, 0, 1, 8, 40);
  assert.ok(
    Math.abs(free.x) < 1e-9 && Math.abs(free.z - 8) < 1e-9,
    'dashTarget: unclamped, straight range × direction, well inside the arena'
  );

  // Start 1m from a 40m roam boundary, dashing 8m further outward.
  const edge = dashTarget(0, 39, 0, 1, 8, 40);
  const dist = Math.hypot(edge.x, edge.z);
  assert.ok(Math.abs(dist - 40) < 1e-6, `dashTarget: clamps to roamRadius when the raw target overshoots it (got ${dist})`);
  assert.ok(Math.abs(edge.x) < 1e-9, 'dashTarget: clamp preserves the aim direction (x stays 0 for a pure +z dash)');

  // A start already past the boundary (shouldn't happen in practice, but the
  // clamp math must still hold, not divide by zero or invert).
  const beyond = dashTarget(0, 45, 1, 0, 8, 40);
  assert.ok(Math.hypot(beyond.x, beyond.z) <= 40 + 1e-6, 'dashTarget: never returns a point past roamRadius');

  console.log('ok  M6 T6: dashTarget (arena clamp)');
}

/* ---- M6 T12 fix round (reviewer-caught): scaledDashRange — single source
   of truth for both the ability's own cast distance and _dashDisplace's
   teleport, so a Lv3+ dash can never again overshoot its own damage line ---- */
{
  // Lv1/Lv2: identity — the 8m base every pre-T12 dashTarget case above
  // already assumes.
  assert.ok(Math.abs(scaledDashRange(1) - settings.dashstrike.range) < 1e-9, 'scaledDashRange: Lv1 identity');
  assert.ok(Math.abs(scaledDashRange(2) - settings.dashstrike.range) < 1e-9, 'scaledDashRange: Lv2 identity');

  // Lv3+: ×1.3 — the exact number App's three cast-time call sites (_cast,
  // _quickCastToward's plain and fusion branches) must each pass as BOTH
  // abilities.cast()'s `distance` and _dashDisplace's teleport `range`.
  const wantLv3 = settings.dashstrike.range * 1.3;
  assert.ok(
    Math.abs(scaledDashRange(3) - wantLv3) < 1e-9,
    `scaledDashRange: Lv3 ×1.3 (want ${wantLv3}, got ${scaledDashRange(3)})`
  );
  assert.ok(
    Math.abs(scaledDashRange(5) - wantLv3) < 1e-9,
    "scaledDashRange: Lv5 keeps Lv3's range (dashstrike carries no lv5 range entry, only damage)"
  );

  // Downstream: feeding the scaled range into dashTarget (the exact function
  // _dashDisplace calls) lands the teleport at the scaled distance, not the
  // base one — pins the actual regression the reviewer caught (the teleport
  // used to scale independently while the cast distance stayed raw).
  const atLv1 = dashTarget(0, 0, 0, 1, scaledDashRange(1), 100);
  const atLv3 = dashTarget(0, 0, 0, 1, scaledDashRange(3), 100);
  assert.ok(Math.abs(atLv1.z - settings.dashstrike.range) < 1e-9, 'scaledDashRange: Lv1 dashTarget lands at the base range');
  assert.ok(
    Math.abs(atLv3.z - wantLv3) < 1e-9,
    'scaledDashRange: Lv3 dashTarget lands ×1.3 further out — the same number the cast distance now shares'
  );

  console.log('ok  M6 T12 fix round: scaledDashRange (single source for cast distance + teleport)');
}

/* ---- M6 T6: dashLineHits — dash path damage, self-resolved (D-M3-8) ---- */
{
  // Dash line: origin (0,0) → direction (0,1) [+z] → length settings.dashstrike.range.
  const enemies = new EnemySystem(createRng(64));
  const onLineNear = enemies.spawnAt(0, 2, 0); // 2m along the line
  const onLineFar = enemies.spawnAt(0, 6, 0); // 6m along the line
  const offLine = enemies.spawnAt(5, 2, 0); // 5m off to the side — must take nothing
  // hp top-up (established pattern elsewhere in this file): dashstrike's real
  // damage (280×mods) would one-shot a fresh swarm spawn (hp 20) and swap-
  // remove it, which would make a post-hit hp readout meaningless.
  enemies.hp[onLineNear] = 1000;
  enemies.hp[onLineFar] = 1000;
  enemies.hp[offLine] = 1000;

  const stubMods = { damageMult: () => 1.25 };
  const amt = settings.dashstrike.damage * stubMods.damageMult('dashstrike');
  const hits = dashLineHits(
    enemies,
    'test-cast',
    0, 0, 0, 1,
    settings.dashstrike.range,
    settings.dashstrike.width,
    amt,
    -1
  );

  assert.equal(hits, 2, 'dashLineHits: hits exactly the two enemies on the line, once each (overlapping samples deduped)');
  assert.ok(
    Math.abs(1000 - enemies.hp[onLineNear] - amt) < 1e-6,
    `dashLineHits: near enemy takes exactly damage×mods (got Δ${1000 - enemies.hp[onLineNear]}, want ${amt})`
  );
  assert.ok(
    Math.abs(1000 - enemies.hp[onLineFar] - amt) < 1e-6,
    'dashLineHits: far enemy takes exactly damage×mods too — no falloff along the line'
  );
  assert.equal(enemies.hp[offLine], 1000, 'dashLineHits: an enemy off the line takes nothing');
  assert.equal(settings.dashstrike.damage, 280, 'dashstrike: controller-ruled base damage pinned');

  console.log('ok  M6 T6: dashLineHits (dash path damage)');
}

/* ---- M6 T6 fix round: dashstrike IS reachable via fusion today ---- */
{
  // Reviewer-caught: the original report's "no legal fusion partner exists"
  // risk framing was wrong. Ran against the real FUSIONS table (T2 data,
  // untouched by this task): dashstrike (金, wux 0) both FEEDS iceshield
  // (水, wux 2 — FEEDS[0]===2) and is FED BY rockspikes (土, wux 4 —
  // FEEDS[4]===0), and both pairs already have named entries. A player who
  // levels either pair to fusion.minLevel (4) in a normal run reaches
  // App's dash-displacement hook through the golden seat.
  const loadout = new Loadout();
  loadout.acquire('dashstrike');
  loadout.acquire('iceshield');
  loadout.acquire('rockspikes');
  // M6 T7: one more seat on the same loadout — firering (火, wux 3) FEEDS
  // rockspikes (土, wux 4 — FEEDS[3]===4), the other earth-adjacent pair
  // the T6 comment above didn't need yet: 地心火山.
  loadout.acquire('firering');
  for (const el of ['dashstrike', 'iceshield', 'rockspikes', 'firering']) {
    while (loadout.levelOf(el) < settings.fusion.minLevel) loadout.upgrade(el);
  }
  const eligible = loadout.eligibleFusions();
  assert.ok(
    eligible.some((f) => f.a === 'dashstrike' && f.b === 'iceshield' && f.name === '霜刃洪流'),
    'eligibleFusions: dashstrike(金) feeds iceshield(水) — 霜刃洪流 eligible at Lv4/Lv4'
  );
  assert.ok(
    eligible.some((f) => f.a === 'rockspikes' && f.b === 'dashstrike' && f.name === '锋岩星阵'),
    'eligibleFusions: rockspikes(土) feeds dashstrike(金) — 锋岩星阵 eligible at Lv4/Lv4'
  );
  assert.ok(
    eligible.some((f) => f.a === 'firering' && f.b === 'rockspikes' && f.name === '地心火山'),
    'eligibleFusions: firering(火) feeds rockspikes(土) — 地心火山 eligible at Lv4/Lv4'
  );

  console.log('ok  M6 T6/T7 fix: earth fusion pairs (霜刃洪流/锋岩星阵/地心火山) eligible at Lv4/Lv4');
}

/* ---- M6 T6 fix round: resolveTarget — chainbolt's WYSIWYG re-validation ---- */
{
  // Untouched: same id at the same index resolves straight through.
  {
    const enemies = new EnemySystem(createRng(66));
    const target = enemies.spawnAt(0, 5, 0);
    const id = enemies.id[target];
    assert.equal(resolveTarget(enemies, target, id, 14, 0, 0), target, 'resolveTarget: untouched target resolves at its own index');
  }

  // Relocated: an unrelated death elsewhere in the population swap-removes —
  // EnemySystem._kill copies the population's last live slot into the
  // vacated one. Filler @ index 0, target @ index 1 (the last slot); killing
  // filler copies target's own data down into slot 0, relocating it under
  // the same id.
  {
    const enemies = new EnemySystem(createRng(67));
    const filler = enemies.spawnAt(0, 0, 0);
    const target = enemies.spawnAt(0, 5, 0);
    const targetId = enemies.id[target];
    enemies.damage({ x: 0, z: 0 }, 0.5, 1000, -1); // kills only filler (target is 5m away, out of this radius)
    assert.equal(enemies.count, 1, 'resolveTarget setup: filler died, one enemy left');
    const resolved = resolveTarget(enemies, target, targetId, 14, 0, 0);
    assert.equal(resolved, 0, "resolveTarget: follows a swap-remove relocation to the enemy's new index");
    assert.equal(enemies.id[resolved], targetId, 'resolveTarget: the resolved index really is the same enemy (matching id)');
    assert.equal(enemies.z[resolved], 5, "resolveTarget: resolved position is the relocated enemy's own, not the filler's");
  }

  // Gone: the remembered target itself died — its id no longer exists
  // anywhere in the population, so this must signal "re-search," not -1's
  // opposite (a stale index that happens to still pass the bounds check).
  {
    const enemies = new EnemySystem(createRng(68));
    const target = enemies.spawnAt(0, 5, 0);
    const targetId = enemies.id[target];
    enemies.damage({ x: 0, z: 5 }, 0.5, 1000, -1);
    assert.equal(enemies.count, 0, 'resolveTarget setup: the target itself died, field now empty');
    assert.equal(resolveTarget(enemies, target, targetId, 14, 0, 0), -1, 'resolveTarget: a dead target (id gone entirely) signals re-search');
  }

  // Out of range: still alive, same id, same index, but walked past `range`
  // since it was remembered — also a re-search signal, not a stale hit.
  {
    const enemies = new EnemySystem(createRng(69));
    const target = enemies.spawnAt(0, 5, 0);
    const targetId = enemies.id[target];
    enemies.z[target] = 500;
    assert.equal(resolveTarget(enemies, target, targetId, 14, 0, 0), -1, 'resolveTarget: alive but walked out of range also signals re-search');
  }

  console.log('ok  M6 T6 fix: resolveTarget (relocation/death/range all correctly signal re-search)');
}

/* ---- pickups: drop, magnet, level math ---- */
{
  const pickups = new PickupSystem();
  pickups.dropAt(1.0, 0, 0); // 1 xp at minute 0, inside the 2m magnet radius
  let levels = 0;
  for (let t = 0; t < 240; t++) levels += pickups.tick(1 / 60, { x: 0, z: 0 });
  assert.equal(pickups.count, 0, 'pickups: gem inside magnet radius gets collected');
  assert.ok(pickups.xp > 0 || levels > 0, 'pickups: collection feeds xp');

  // Level curve: need(l) = xpBase * xpGrowth^l, strictly increasing.
  assert.ok(pickups.xpNeed(2) > pickups.xpNeed(1), 'pickups: curve rises');
  console.log('ok  pickups');
}

/* ---- player: hp, iframes, dodge ---- */
{
  const player = new PlayerState();
  assert.ok(player.takeDamage(10), 'player: first hit lands');
  assert.ok(!player.takeDamage(10), 'player: iframes eat the second hit');
  for (let t = 0; t < 60; t++) player.tick(1 / 60);
  assert.ok(player.takeDamage(10), 'player: iframes expire');
  assert.equal(player.hp, settings.run.playerHp - 20);

  assert.ok(player.tryDodge(), 'player: dodge fires off cooldown');
  assert.ok(!player.tryDodge(), 'player: dodge respects its cooldown');
  assert.ok(!player.takeDamage(10), 'player: dodge grants iframes');

  player.hp = 5;
  for (let t = 0; t < 200; t++) player.tick(1 / 60);
  player.takeDamage(10);
  assert.equal(player.alive, false, 'player: lethal damage kills');
  player.reset();
  assert.ok(player.alive && player.hp === settings.run.playerHp);

  // M6 T5: shield — absorbs first, never trips iframes on its own; only a
  // remainder that pierces into hp does.
  player.reset();
  player.addShield(30, 6);
  assert.equal(player.shield, 30, 'shield: addShield sets the pool');
  assert.equal(player.shieldT, 6, 'shield: addShield sets the timer');
  const hpBefore = player.hp;
  assert.ok(player.takeDamage(20), 'shield: an absorbed hit still reports as landing');
  assert.equal(player.hp, hpBefore, 'shield: absorption order — hp untouched while the pool covers the hit');
  assert.equal(player.shield, 10, 'shield: the pool takes the hit, not hp');
  assert.equal(player.iframes, 0, 'shield: a fully-absorbed hit does not spend iframes');
  assert.ok(player.takeDamage(5), 'shield: iframes were never armed, so the very next hit still lands');
  assert.equal(player.hp, hpBefore, 'shield: second hit also fully absorbed (10 pool covers 5)');
  assert.equal(player.shield, 5, 'shield: pool keeps draining');

  // Pierce-through: a hit bigger than what's left in the pool spends the
  // pool, and only the remainder both reaches hp and arms iframes.
  assert.ok(player.takeDamage(20), 'shield: a hit bigger than the pool still lands');
  assert.equal(player.shield, 0, 'shield: pool is fully spent');
  assert.equal(player.hp, hpBefore - 15, 'shield: only the pierced remainder (20-5) reaches hp');
  assert.ok(player.iframes > 0, 'shield: the pierced remainder arms iframes same as an unshielded hit');
  assert.ok(!player.takeDamage(5), 'shield: iframes now guard the next hit, as normal');

  // Expiry: tick decays shieldT; hitting zero zeroes the pool even if it was
  // never touched.
  player.reset();
  player.addShield(40, 0.05);
  for (let t = 0; t < 10; t++) player.tick(1 / 60); // 10/60s comfortably clears 0.05s
  assert.equal(player.shieldT, 0, 'shield: tick decays the timer to zero');
  assert.equal(player.shield, 0, 'shield: expiry zeroes the pool even though it was never hit');

  // 覆盖式取大: a smaller cast never downgrades a bigger surviving shield
  // (amount AND duration both held back together); an equal-or-bigger cast
  // replaces the whole bundle.
  player.reset();
  player.addShield(40, 6);
  player.addShield(10, 20);
  assert.equal(player.shield, 40, 'shield: a smaller cast does not shrink the pool');
  assert.equal(player.shieldT, 6, 'shield: ...nor does it graft its own longer duration on top');
  player.addShield(55, 7, 0.3);
  assert.equal(player.shield, 55, 'shield: an equal-or-bigger cast overwrites the pool');
  assert.equal(player.shieldT, 7, 'shield: ...and its own duration comes with it');
  assert.equal(player.reflectShare, 0.3, 'shield: ...and its own reflectShare, same bundle');

  // 勘误 D-M6-2: contact's own mercy window, separate from iframes — a
  // landed CONTACT hit (shield, hp, or both) rate-limits further CONTACT
  // hits to one per iframes-length window; a shield-absorbed hit arms no
  // iframes (盾不触发无敌帧), so without this a swarm toucher would grind a
  // shield down at 60Hz instead of the "one bite per window" every other
  // contact hit already gets for free via iframes.
  player.reset();
  player.addShield(40, 6);
  assert.ok(player.takeDamage(8, null, true), 'contactMercy: first contact hit lands');
  assert.equal(player.shield, 32, 'contactMercy: it drains the shield normally');
  assert.equal(player.iframes, 0, 'contactMercy: fully absorbed — still no iframes');
  assert.ok(player.contactMercyT > 0, 'contactMercy: a landed contact hit arms the window regardless of outcome');
  assert.ok(!player.takeDamage(8, null, true), 'contactMercy: a second contact hit in-window is refused');
  assert.equal(player.shield, 32, 'contactMercy: ...and the pool never moves');
  assert.ok(player.takeDamage(8), 'contactMercy: a bolt (contact=false) in the same window still lands');
  assert.equal(player.shield, 24, 'contactMercy: ...and still drains the pool — bolts ride a different channel');
  for (let t = 0; t < 60; t++) player.tick(1 / 60); // clear the window
  assert.ok(player.takeDamage(8, null, true), 'contactMercy: contact bites again once the window clears');
  assert.equal(player.shield, 16, 'contactMercy: ...and drains the pool once more');

  // Bolt into shield arms nothing at all — a contact hit right after a
  // bolt, with no wait, still lands (contactMercyT was never touched).
  player.reset();
  player.addShield(40, 6);
  assert.ok(player.takeDamage(8), 'contactMercy: a bolt into shield lands');
  assert.equal(player.contactMercyT, 0, 'contactMercy: ...and arms no contact window at all');
  assert.ok(player.takeDamage(8, null, true), 'contactMercy: a contact hit right after that bolt still lands');
  assert.equal(player.shield, 24, 'contactMercy: ...and drains the pool too (8 from the bolt, 8 from contact)');

  // Pierce-through still arms iframes AND contactMercy together.
  player.reset();
  assert.ok(player.takeDamage(10, null, true), 'contactMercy: an unshielded contact hit pierces straight to hp');
  assert.equal(player.hp, settings.run.playerHp - 10, 'contactMercy: ...hp actually drops');
  assert.ok(player.iframes > 0, 'contactMercy: ...and arms iframes same as today');
  assert.ok(player.contactMercyT > 0, 'contactMercy: ...and arms the contact window too');

  console.log('ok  player state');
}

/* ---- mana ---- */
{
  const player = new PlayerState();
  // Full pool on reset
  assert.equal(player.mana, settings.run.manaMax, 'mana: reset fills the pool');

  // Spend success deducts exactly
  assert.ok(player.spendMana(10), 'mana: spend succeeds when funded');
  assert.equal(player.mana, settings.run.manaMax - 10, 'mana: spend deducts exactly');

  // Insufficient spend returns false and deducts nothing
  const beforeFail = player.mana;
  assert.ok(!player.spendMana(beforeFail + 1), 'mana: insufficient spend returns false');
  assert.equal(player.mana, beforeFail, 'mana: insufficient spend deducts nothing');

  // One second of ticks ≈ +4 (1e-3 tolerance)
  player.mana = 0;
  for (let t = 0; t < 60; t++) player.tick(1 / 60);
  assert.ok(
    Math.abs(player.mana - settings.run.manaRegen) < 1e-3,
    `mana: one second regen ≈ ${settings.run.manaRegen} (got ${player.mana.toFixed(6)})`
  );

  // gainMana clamps at max
  player.reset();
  player.gainMana(50);
  assert.equal(player.mana, settings.run.manaMax, 'mana: gainMana clamps at max');

  // Dead player: no regen, no gain, no spend
  player.reset();
  player.alive = false;
  const deadMana = player.mana;
  player.tick(1 / 60);
  assert.equal(player.mana, deadMana, 'mana: dead player does not regen');
  assert.ok(!player.spendMana(1), 'mana: dead player cannot spend');
  assert.equal(player.mana, deadMana, 'mana: dead player spend deducts nothing');
  player.gainMana(10);
  assert.equal(player.mana, deadMana, 'mana: dead player gainMana does nothing');

  console.log('ok  mana');
}

/* ---- M6 T3: mana spend gate (manaGate.js) — pure pre-cast math ---- */
{
  const player = new PlayerState();

  // legacy absent manaCost reads as free (?? 0) — every pre-M6 skill
  assert.equal(manaCostOf('ice'), 0, 'manaGate: absent manaCost (legacy) resolves to 0');
  assert.deepEqual(canAffordCast('ice', player), { ok: true, cost: 0 }, 'manaGate: a free skill always affords');

  // tactical: real cost, gated on the pool
  assert.equal(manaCostOf('dashstrike'), 30, 'manaGate: tactical manaCost reads through untouched');
  assert.deepEqual(
    canAffordCast('dashstrike', player),
    { ok: true, cost: 30 },
    'manaGate: affords at full mana'
  );

  // fusion: max(parents), never the sum — the same "slower parent sets the
  // pace" reading the fusion's own cooldown already uses (_quickCastToward).
  assert.equal(manaCostOf(fusionId('ice', 'dashstrike')), 30, 'manaGate: fusion cost is max(0, 30)');
  assert.equal(
    manaCostOf(fusionId('dashstrike', 'quake')),
    30,
    'manaGate: fusion cost is max(30, 30), not the 60-mana sum'
  );

  // demo/echo always afford, regardless of cost or an empty pool
  player.mana = 0;
  assert.deepEqual(
    canAffordCast('dashstrike', player, { demo: true }),
    { ok: true, cost: 30 },
    'manaGate: a demo cast always affords'
  );
  assert.deepEqual(
    canAffordCast('dashstrike', player, { echo: true }),
    { ok: true, cost: 30 },
    'manaGate: an echo re-fire always affords'
  );

  // insufficient mana blocks a real cast; exactly enough affords it
  player.mana = 10;
  assert.deepEqual(
    canAffordCast('dashstrike', player),
    { ok: false, cost: 30 },
    'manaGate: insufficient mana blocks (no demo/echo exemption)'
  );
  player.mana = 30;
  assert.ok(canAffordCast('dashstrike', player).ok, 'manaGate: exactly enough mana affords');

  // purity: the helper only ever reads playerState.mana, never spends — App
  // calls player.spendMana(cost) itself, only after ok, exactly once.
  const before = player.mana;
  canAffordCast('dashstrike', player);
  canAffordCast('dashstrike', player, { demo: true });
  canAffordCast('ice', player);
  assert.equal(player.mana, before, 'manaGate: canAffordCast never mutates mana (pure)');
  assert.ok(player.spendMana(30), 'manaGate: the real spend (App-side, post-ok) succeeds exactly once');
  assert.equal(player.mana, 0, 'manaGate: that one spend deducted the full cost');

  console.log('ok  mana gate');
}

/* ---- run manager: schedule, deaths feed gems, verdicts ---- */
{
  const rng = createRng(7);
  const enemies = new EnemySystem(rng);
  const pickups = new PickupSystem();
  const player = new PlayerState();
  const ultimate = new Ultimate({ enemies, player, combat: {}, rng });
  const run = new RunManager({
    enemies, pickups, player, rng, ultimate,
    tides: new TideSchedule(createRng(7)),
    projectiles: new EnemyProjectiles(),
    // M6 T2: wuxingOf now has an 土 (wux 4) representative, so a wux-4-triggered
    // reaction reaches RunManager._react's combat.book(...) call for the first
    // time (previously dead per wuxingRep's own doc comment) — book needs a stub.
    combat: { tick: () => {}, release: () => -1, book: () => {} },
    targets: { register: () => {} },
    abilities: { active: [] }
  });
  run.start();

  // A minute of ticks must have spawned roughly spawnBase enemies (±jitter),
  // telegraphs included.
  settings.run.godMode = true; // D3: contact is lethal in a pinned minute — spec anchor, not a bug
  for (let t = 0; t < 60 * 60; t++) run.tick(1 / 60, { x: 0, z: 0 });
  settings.run.godMode = false;
  const spawned = enemies.count + run.kills;
  assert.ok(spawned > 10 && spawned < 40, `run: minute-one spawns ≈20 (got ${spawned})`);

  // Killing enemies drops one gem per death. (The brief asserted a single
  // death, but after the godMode minute the horde is packed around the pinned
  // player — a radius-1 blast fells a cluster, so pin gems-per-death instead.)
  const before = pickups.count;
  const killsBefore = run.kills;
  enemies.damage({ x: enemies.x[0], z: enemies.z[0] }, 1, 1e6);
  assert.ok(run.kills > killsBefore, 'run: the blast killed something');
  assert.equal(pickups.count - before, run.kills - killsBefore, 'run: each death drops a gem');

  // The retirement seam: the manager hands each cast leaving play to
  // onRetire, and the id must thread combat.release → enemies.releaseCast.
  const fakeAbility = {};
  const seen = [];
  run.s.combat.release = (a) => (a === fakeAbility ? 7 : -1);
  run.s.enemies.releaseCast = (id) => seen.push(id); // shadows the prototype
  run.s.abilities.onRetire(fakeAbility);
  run.s.abilities.onRetire({}); // unknown cast: -1, must not reach enemies
  assert.deepEqual(seen, [7], 'run: retiring a cast releases its hit memory');
  delete run.s.enemies.releaseCast; // real method back for later assertions

  // Level-ups queue on the manager instead of vanishing.
  run.start();
  run.tick(1 / 60, { x: 0, z: 0 });
  pickups.xp = pickups.xpNeed(1) + pickups.xpNeed(2) + 1; // enough for two levels
  run.tick(1 / 60, { x: 0, z: 0 });
  assert.ok(run.pendingLevels >= 2, `run: level-ups queue (got ${run.pendingLevels})`);
  run.start();
  assert.equal(run.pendingLevels, 0, 'run: restart clears the queue');

  // Mana on kill: RunManager's onDeath grants mana.
  run.start();
  player.spendMana(10); // spend so there's room for regen
  const manaBefore = player.mana;
  enemies.clear();
  enemies.spawnAt(0, 0, 0);
  enemies.damage({ x: 0, z: 0 }, 1, 1e6);
  assert.ok(run.kills > 0, 'run: the blast killed something');
  assert.equal(player.mana, manaBefore + settings.run.manaPerKill, 'mana: kill grants manaPerKill');

  // Ultimate charge: RunManager's onDeath grants a kill charge, and its
  // _react router grants a (larger) reaction charge — same fake-systems
  // pattern as the mana-on-kill check above, proving the real wiring rather
  // than calling Ultimate's own methods directly. run.start() also proves
  // the reset() hookup for free.
  run.start();
  assert.equal(ultimate.charge, 0, 'ultimate: run.start() resets the charge');
  enemies.spawnAt(0, 0, 0);
  enemies.damage({ x: 0, z: 0 }, 1, 1e6);
  assert.equal(ultimate.charge, settings.ultimate.chargePerKill, 'ultimate: RunManager onDeath grants chargePerKill');

  const chargeBeforeReact = ultimate.charge;
  enemies.onReaction(0, 4, 0, 0, 10); // 金→水 branch; wux=4 (土) now has representatives as of M6 T2, safely books
  assert.equal(
    ultimate.charge,
    chargeBeforeReact + settings.ultimate.chargePerReaction,
    'ultimate: RunManager._react grants chargePerReaction'
  );

  // Verdicts.
  player.hp = 0;
  player.alive = false;
  assert.equal(run.tick(1 / 60, { x: 0, z: 0 }), 'dead');
  run.start();
  run.elapsed = settings.run.duration + 1;
  assert.equal(run.tick(1 / 60, { x: 0, z: 0 }), 'won');
  console.log('ok  run manager');
}

/* ---- modifiers: upgrades never touch settings, multipliers stack right ---- */
{
  const mods = new Modifiers();
  assert.equal(mods.damageMult('ice'), 1, 'mods: fresh run multiplies by 1');
  mods.bumpDamage('ice');
  mods.bumpDamage('ice');
  assert.ok(Math.abs(mods.damageMult('ice') - 1.5) < 1e-9, 'mods: two bumps = +50%');
  assert.equal(mods.damageMult('thunder'), 1, 'mods: per-element isolation');

  assert.ok(mods.bumpPassive('focus'));
  assert.ok(Math.abs(mods.cooldownMult() - 0.94) < 1e-9, 'mods: one focus level = ×0.94');
  mods.bumpPassive('focus');
  mods.bumpPassive('focus');
  assert.ok(!mods.bumpPassive('focus'), 'mods: passive refuses past its max');
  assert.ok(mods.cooldownMult() >= 0.6, 'mods: CD floor 0.6 holds (spec cap 40%)');

  mods.bumpPassive('echo');
  assert.ok(Math.abs(mods.echoChance() - settings.upgrades.echoPerLevel) < 1e-9);
  mods.bumpPassive('vitality');
  assert.ok(mods.maxHpMult() > 1 && mods.moveSpeedMult() === 1, 'mods: keys independent');
  assert.equal(mods.passiveLevel('reroll'), 0);

  mods.bumpPassive('scavenger');
  assert.ok(Math.abs(mods.xpMult() - (1 + settings.upgrades.scavengerPerLevel)) < 1e-9, 'mods: one scavenger level scales xp');

  mods.reset();
  assert.equal(mods.damageMult('ice'), 1, 'mods: reset wipes everything');
  assert.equal(mods.passiveLevel('focus'), 0);
  assert.ok(PASSIVES.swift.max === 3 && PASSIVES.reroll.name.length > 0);
  console.log('ok  modifiers');
}

/* ---- loadout: draft starts with one seat, acquire fills forward ---- */
{
  const saved = settings.run.draftLoadout;
  settings.run.draftLoadout = true;
  const loadout = new Loadout();
  loadout.reset();
  assert.equal(loadout.elementAt(0), settings.run.loadout[0], 'loadout: draft keeps seat 0');
  assert.equal(loadout.equippedList().length, 1, 'loadout: draft empties the rest');
  assert.ok(loadout.hasEmpty());
  assert.equal(loadout.levelOf(settings.run.loadout[0]), 1, 'loadout: starter is level 1');

  assert.equal(loadout.acquire('snare'), 1, 'loadout: acquire fills the first gap');
  assert.equal(loadout.acquire('snare'), -1, 'loadout: no duplicates');
  assert.ok(loadout.has('snare') && loadout.levelOf('snare') === 1);

  for (let n = 0; n < settings.upgrades.skillLevelMax - 1; n++) {
    assert.ok(loadout.upgrade('snare'), `loadout: upgrade ${n + 2} accepted`);
  }
  assert.ok(!loadout.upgrade('snare'), 'loadout: cap at skillLevelMax');
  assert.ok(loadout.isMaxed('snare'));

  settings.run.draftLoadout = false;
  loadout.reset();
  assert.equal(loadout.equippedList().length, 6, 'loadout: full mode copies all six');
  assert.ok(!loadout.hasEmpty());
  settings.run.draftLoadout = saved;
  console.log('ok  loadout');
}

/* ---- upgrade pool: deterministic, distinct, weighted, milestone-aware ---- */
{
  const saved = settings.run.draftLoadout;
  settings.run.draftLoadout = true;
  const make = (seed) => {
    const loadout = new Loadout();
    loadout.reset();
    const mods = new Modifiers();
    return { pool: new UpgradePool(createRng(seed), loadout, mods), loadout, mods };
  };

  // Same seed, same cards — the daily-seed contract reaches the card row.
  const a = make(11).pool.draw(2);
  const b = make(11).pool.draw(2);
  assert.deepEqual(a.map((c) => c.kind + (c.element ?? c.passive)),
    b.map((c) => c.kind + (c.element ?? c.passive)), 'pool: seeded draws replay');

  // Distinct cards, at most three, every card actionable.
  const { pool, loadout } = make(23);
  for (let round = 0; round < 50; round++) {
    const cards = pool.draw(2);
    assert.ok(cards.length >= 1 && cards.length <= 3);
    const keys = cards.map((c) => c.kind + (c.element ?? c.passive));
    assert.equal(new Set(keys).size, keys.length, 'pool: no duplicate cards in a hand');
    for (const card of cards) {
      if (card.kind === 'upgrade') assert.ok(!loadout.isMaxed(card.element));
      if (card.kind === 'new') assert.ok(!loadout.has(card.element) && loadout.hasEmpty());
      assert.ok(card.title.length > 0 && card.body.length > 0, 'pool: cards carry copy');
    }
  }

  // Milestone levels guarantee a new-active card while seats remain.
  const m = make(31);
  const milestone = m.pool.draw(settings.upgrades.milestones[0]);
  assert.ok(milestone.some((c) => c.kind === 'new'), 'pool: milestone forces a new active');

  // Exhaustion: everything maxed and seated leaves nothing generic to offer.
  // M4: this particular six (ice/thunder/meteor/beam/snare/glacier, all Lv5)
  // is webbed with ripe sheng pairs, and a ripe fusion is exactly the escape
  // hatch this dead end exists for — so the hand isn't truly empty, it holds
  // only the one guaranteed gold card (skip-heal only applies with none of
  // those either).
  const x = make(41);
  for (const element of ELEMENTS) x.loadout.acquire(element);
  for (const element of x.loadout.equippedList()) {
    while (!x.loadout.isMaxed(element)) x.loadout.upgrade(element);
  }
  for (const id of Object.keys(PASSIVES)) {
    while (x.mods.bumpPassive(id)) { /* to max */ }
  }
  const exhausted = x.pool.draw(20);
  // M9 T2 (intentional change, was `=== 1`): a maxed skill is no longer a
  // dead seat — it offers mutations until it has taken its fill, so this
  // build hands out its ripe fusion PLUS mutation cards. The dead end this
  // block was written for now needs every skill maxed AND fully mutated,
  // which the follow-up below drives to.
  assert.ok(exhausted.length >= 1, 'pool: a full build still offers its ripe fusion');
  assert.ok(
    exhausted.some((c) => c.kind === 'fusion'),
    'pool: …and the guaranteed gold card is among them'
  );
  assert.ok(
    exhausted.every((c) => c.kind === 'fusion' || c.kind === 'mutation'),
    'pool: …with nothing left but mutations beside it'
  );
  {
    // Drive every maxed skill to its mutation cap: only then is the pool
    // genuinely dry apart from the fusion.
    for (const element of x.loadout.equippedList()) {
      for (const id of Object.keys(settings.upgrades.mutations)) x.mods.takeMutation(element, id);
    }
    const dry = x.pool.draw(20);
    assert.equal(dry.length, 1, 'pool: maxed AND fully mutated, only the ripe fusion is left');
    assert.equal(dry[0].kind, 'fusion', 'pool: …and it is the gold card');
  }
  assert.equal(exhausted[0].kind, 'fusion', 'pool: and nothing but the fusion card');
  settings.run.draftLoadout = saved;
  console.log('ok  upgrade pool');
}

/* ---- modifier plumbing: damage and xp actually scale ---- */
{
  const hits = [];
  const fakeTargets = {
    damageOnce: (id, p, r, amount) => (hits.push(amount), 1),
    damage: (p, r, amount) => (hits.push(amount), 1),
    slow: () => {}
  };
  const mods = new Modifiers();
  mods.bumpDamage('ice'); // ice ×1.25
  const combat = new CombatSystem(fakeTargets, mods);
  const ice = {
    element: 'ice', phase: 'travel', age: 0.2, impactTime: 0, fadeTime: 0,
    position: { x: 1, z: 0 }, origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 }, length: 8, u: 0.2
  };
  combat.tick(1 / 60, [ice]);
  const base = settings.combat.ice.damage;
  assert.ok(hits.some((amount) => Math.abs(amount - base * 1.25) < 1e-6),
    'combat: sweep damage rides the modifier');

  const pickups = new PickupSystem();
  const scavenger = new Modifiers();
  scavenger.bumpPassive('scavenger');
  pickups.mods = scavenger;
  pickups.dropAt(0.1, 0, 0);
  pickups.tick(1 / 60, { x: 0, z: 0 });
  assert.ok(Math.abs(pickups.xp - settings.run.gemBase * 1.1) < 1e-6,
    'pickups: xp rides the scavenger multiplier');
  console.log('ok  modifier plumbing');
}

/* ---- M2 ledger: deferred pins ---- */
{
  // Loadout: acquire refuses when full; upgrade refuses what isn't held.
  const loadout = new Loadout();
  settings.run.draftLoadout = false;
  loadout.reset();
  assert.equal(loadout.acquire('ice'), -1, 'loadout: full board refuses acquire');
  assert.ok(!loadout.upgrade('nosuch'), 'loadout: cannot upgrade an unheld skill');

  // Loadout: a duplicated id in the debug loadout must not seat twice.
  const dup = settings.run.loadout.slice();
  settings.run.loadout = ['ice', 'ice', 'thunder', 'meteor', 'beam', 'glacier'];
  loadout.reset();
  assert.equal(
    loadout.seats.filter((e) => e === 'ice').length, 1,
    'loadout: duplicate config ids seat once'
  );
  settings.run.loadout = dup;
  settings.run.draftLoadout = true;

  // RunManager.pendingLevels accumulates (+=, never =): two ticks that each
  // gain a level must leave two pending.
  const rng2 = createRng(11);
  const enemies2 = new EnemySystem(rng2);
  const pickups2 = new PickupSystem();
  const player2 = new PlayerState();
  const rm = new RunManager({
    enemies: enemies2, pickups: pickups2, player: player2, rng: rng2,
    tides: new TideSchedule(createRng(11)),
    projectiles: new EnemyProjectiles(),
    // M6 T2: wuxingOf now has an 土 (wux 4) representative, so a wux-4-triggered
    // reaction reaches RunManager._react's combat.book(...) call for the first
    // time (previously dead per wuxingRep's own doc comment) — book needs a stub.
    combat: { tick: () => {}, release: () => -1, book: () => {} },
    targets: { register: () => {} },
    abilities: { active: [], onRetire: null }
  });
  rm.start();
  pickups2.xp = pickups2.xpNeed(1) + 0.5;
  rm.tick(1 / 60, { x: 0, z: 0 });
  pickups2.xp = pickups2.xpNeed(2) + 0.5;
  rm.tick(1 / 60, { x: 0, z: 0 });
  assert.equal(rm.pendingLevels, 2, 'run: pending levels accumulate across ticks');

  // UpgradePool: statistical kind coverage — 200 draws from a mid-run state
  // must produce every kind, and a milestone *span* (sinceLevel < milestone ≤
  // level) still guarantees a new-active card.
  const mods2 = new Modifiers();
  const pool = new UpgradePool(createRng(5), loadout, mods2);
  settings.run.draftLoadout = true;
  loadout.reset();
  const kinds = new Set();
  for (let n = 0; n < 200; n++) for (const card of pool.draw(2)) kinds.add(card.kind);
  assert.ok(
    kinds.has('upgrade') && kinds.has('new') && kinds.has('passive'),
    `pool: 200 draws must cover all kinds (saw ${[...kinds].join(',')})`
  );
  // The guarantee above doesn't yet prove itself: with only seat 0 filled
  // (the loadout above), 'new' candidates dominate the weighted pool by sheer
  // count, so an ordinary draw finds one anyway and a regressed span check
  // (back to `.includes(level)`) would pass undetected. Re-run the pair from
  // a loadout with one empty seat — two elements stay unheld — so the legs
  // actually discriminate: no milestone in the span must sometimes miss
  // 'new', and a milestone crossed mid-span must not.
  const savedLoadout = settings.run.loadout;
  settings.run.loadout = ['ice', 'fireball', 'thunder', 'meteor', 'beam']; // 5 seats: glacier + snare unheld
  settings.run.draftLoadout = false; // fill every configured seat, not just seat 0
  loadout.reset();
  let missedNoSpan = 0;
  let everySpanHandHasNew = true;
  for (let n = 0; n < 40; n++) {
    if (!pool.draw(6, 6).some((card) => card.kind === 'new')) missedNoSpan++; // span (5,6]: no milestone inside
    const spanHand = pool.draw(6, 4); // span (3,6]: milestone 5 inside
    if (spanHand.length > 0 && !spanHand.some((card) => card.kind === 'new')) everySpanHandHasNew = false;
  }
  assert.ok(
    missedNoSpan > 0,
    `pool: without a milestone in the span, new is not guaranteed (missed ${missedNoSpan}/40)`
  );
  assert.ok(everySpanHandHasNew, 'pool: a milestone crossed mid-span still guarantees a new active');
  settings.run.loadout = savedLoadout;
  settings.run.draftLoadout = true;

  // Combat: the modifier amp reaches every kind, not just sweep. zoneTick is
  // the cheapest to pin headless: damage flows through targets.damage scaled.
  const seen = [];
  const combatAmp = new CombatSystem(
    { damage: (p, r, amt) => (seen.push(amt), 0), damageOnce: () => 0, slow: () => {} },
    { damageMult: (el) => (el === 'snare' ? 2 : 1) }
  );
  const snareCast = {
    element: 'snare', phase: 'impact', impactTime: 0.2, fadeTime: 0, u: 1,
    position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 }, length: 1
  };
  combatAmp.tick(1 / 60, [snareCast]);
  const base = settings.combat.snare.dps * (1 / 60);
  assert.ok(
    seen.length && Math.abs(seen[0] - base * 2) < 1e-9,
    'combat: zoneTick damage rides the modifier amp'
  );
  console.log('ok  m2 ledger pins');
}

/* ---- tides: a seeded permutation driving 3-minute windows ---- */
{
  const t1 = new TideSchedule(createRng(9));
  const t2 = new TideSchedule(createRng(9));
  assert.deepEqual(t1.order, t2.order, 'tides: same seed, same order');
  assert.deepEqual([...t1.order].sort(), [0, 1, 2, 3, 4], 'tides: all five, exactly once');

  // Check first tide immediately, before second call overwrites the scratch object.
  const first = t1.tideAt(0);
  assert.equal(first.element, t1.order[0]);
  assert.equal(first.nextElement, t1.order[1], 'tides: next element previews');
  assert.ok(first.timeLeft > 179 && first.timeLeft <= 180);

  // Check second tide.
  const second = t1.tideAt(settings.tides.length + 1);
  assert.equal(second.index, 1, 'tides: 181s sits in tide two');

  // Zero-alloc: tideAt reuses one scratch object (hot-path constraint).
  assert.equal(t1.tideAt(0), t1.tideAt(50), 'tides: tideAt reuses one scratch object');

  // Check final tide.
  const last = t1.tideAt(899);
  assert.equal(last.index, 4, 'tides: the final second is still tide five');

  // Bias: over many rolls the tide element dominates at ~bias share.
  const rollRng = createRng(21);
  let tideHits = 0;
  for (let n = 0; n < 1000; n++) {
    if (t1.rollElement(rollRng, 0) === t1.order[0]) tideHits++;
  }
  assert.ok(tideHits > 600 && tideHits < 800, `tides: bias ≈70% (got ${tideHits}/1000)`);

  // The wuxing cycle: five entries, a permutation, and 金克木 as spot check.
  assert.equal(BEATS.length, 5);
  assert.deepEqual([...BEATS].sort(), [0, 1, 2, 3, 4]);
  assert.equal(BEATS[0], 1, 'wuxing: metal beats wood');
  assert.equal(WUXING.length, 5);
  console.log('ok  tide schedule');
}

/* ---- behaviours: ranged holds range, tank shrugs knockback, nearest query ---- */
{
  const enemies = new EnemySystem(createRng(2));

  // Ranged: spawn inside holdRange → must not close further (and never bites).
  const r = enemies.spawnAt(4, 0, 0, 0, 1);
  for (let t = 0; t < 60; t++) enemies.tick(1 / 60, { x: 0, z: 0 }, 0);
  assert.ok(
    Math.hypot(enemies.x[r], enemies.z[r]) > 3.5,
    'behaviours: ranged holds its distance'
  );

  // Tank vs swarm knockback: same hit, the tank barely moves.
  enemies.clear();
  const s = enemies.spawnAt(2, 0, 0, 0, 0);
  const k = enemies.spawnAt(-2, 0, 0, 0, 2);
  enemies.damage({ x: 2, z: 0.01 }, 0.5, 1);
  enemies.damage({ x: -2, z: 0.01 }, 0.5, 1);
  assert.ok(
    Math.abs(enemies.kbZ[s]) > Math.abs(enemies.kbZ[k]) * 2,
    'behaviours: mass divides the shove'
  );

  // Element byte and elite byte survive the spawn signature.
  enemies.clear();
  const e = enemies.spawnAt(0, 0, 5, 3, 2, 1);
  assert.equal(enemies.element[e], 3);
  assert.equal(enemies.behavior[e], 2);
  assert.equal(enemies.elite[e], 1);

  // Nearest query.
  enemies.clear();
  assert.equal(enemies.nearestTo(0, 0), -1, 'behaviours: empty horde has no nearest');
  enemies.spawnAt(5, 0, 0);
  const near = enemies.spawnAt(1, 1, 0);
  assert.equal(enemies.nearestTo(0, 0), near, 'behaviours: nearest picks the closer body');

  // Reach must key off each enemy's own radius, not a hardcoded swarm one: a
  // probe at tank-radius + 0.55 clears the tank (0.5+0.7=1.2) but would miss a
  // swarm-radius revert (0.5+0.45=0.95) — hits/slow/damageOnce must each
  // resolve reach per enemy, same as damage already does.
  enemies.clear();
  const tk = enemies.spawnAt(3, 0, 0, 0, 2);
  const probe = { x: 4.05, z: 0 }; // tank sits at (3,0); distance 1.05
  assert.ok(enemies.hits(probe, 0.5), 'behaviours: hits uses the tank radius, not swarm');
  enemies.slow(probe, 0.5, 0.4, 1);
  assert.ok(
    Math.abs(enemies.slowed[tk] - 0.4) < 1e-6, // slowed[] is a Float32Array — exact === would flake on rounding
    'behaviours: slow uses the tank radius, not swarm'
  );
  const hpBefore = enemies.hp[tk];
  enemies.damageOnce(77, probe, 0.5, 5);
  assert.equal(hpBefore - enemies.hp[tk], 5, 'behaviours: damageOnce uses the tank radius, not swarm');

  console.log('ok  behaviours');
}

/* ---- enemy projectiles: fly, hit, expire ---- */
{
  const shots = new EnemyProjectiles();
  shots.spawn(-5, 0, 1, 0); // flying +x toward the player at origin
  let dealt = 0;
  for (let t = 0; t < 120; t++) dealt += shots.tick(1 / 60, { x: 0, z: 0 });
  assert.equal(dealt, settings.enemies.projectile.damage, 'projectiles: a straight shot lands once');
  assert.equal(shots.count, 0, 'projectiles: a landed shot is gone');

  shots.spawn(0, 0, 0, 1); // flying away — must expire by lifetime
  for (let t = 0; t < 60 * settings.enemies.projectile.life + 5; t++) {
    shots.tick(1 / 60, { x: 99, z: 99 });
  }
  assert.equal(shots.count, 0, 'projectiles: lifetime reaps the strays');

  // The ranged enemy pulls the trigger through its hook while holding range.
  const enemies = new EnemySystem(createRng(4));
  let fired = 0;
  enemies.onFire = () => fired++;
  enemies.spawnAt(5, 0, 0, 0, 1);
  for (let t = 0; t < 60 * settings.enemies.ranged.fireEvery + 5; t++) {
    enemies.tick(1 / 60, { x: 0, z: 0 }, 0);
  }
  assert.ok(fired >= 1, 'projectiles: a holding spitter fires on its cadence');

  // I1 (M4 final review): a weakened spitter's bolt must carry its reduced
  // per-shot dmg all the way to EnemyProjectiles. Two links, pinned
  // separately — a real RunManager can't be built headless in isolation, so
  // this is the "bind a probe" + "build the minimal manager" alternative.
  const wantWeakDmg = settings.enemies.projectile.damage * (1 - settings.combat.debuffs.weak.amount);

  // Link 1, the emitter: EnemySystem.tick's onFire hook itself must emit the
  // reduced dmg as its 5th arg once 熄灭 (water overcoming fire) lands.
  const weak = new EnemySystem(createRng(4));
  weak.spawnAt(5, 0, 0, 3, 1); // fire-elemental (wux 3) ranged spitter, in holding range
  weak.damage({ x: 5, z: 0 }, 1, 1, 2); // water (wux 2) overcomes fire: latches 熄灭
  let firedDmg = null;
  weak.onFire = (x, z, dx, dz, dmg) => { if (firedDmg === null) firedDmg = dmg; };
  weak.tick(1 / 60, { x: 0, z: 0 }, 0); // fireT starts at 0: fires this very tick
  assert.ok(
    firedDmg !== null && Math.abs(firedDmg - wantWeakDmg) < 1e-9,
    `projectiles: 熄灭 reduces the emitted bolt dmg to ${wantWeakDmg} (got ${firedDmg})`
  );

  // Link 2, the forwarding: RunManager's real onFire binding (not a test
  // stub) must carry that same 5th arg through to projectiles.spawn — this
  // is the exact line that used to drop it.
  const shots2 = new EnemyProjectiles();
  const enemies2 = new EnemySystem(createRng(4));
  const run2 = new RunManager({
    enemies: enemies2, pickups: new PickupSystem(), player: new PlayerState(),
    rng: createRng(4), tides: new TideSchedule(createRng(4)), projectiles: shots2,
    combat: { tick: () => {}, release: () => -1, resetStats: () => {}, book: () => {} },
    targets: { register: () => {} },
    abilities: { active: [], onRetire: null }
  });
  run2.start();
  enemies2.spawnAt(5, 0, 0, 3, 1);
  enemies2.damage({ x: 5, z: 0 }, 1, 1, 2);
  enemies2.tick(1 / 60, { x: 0, z: 0 }, 0);
  assert.equal(shots2.count, 1, 'projectiles: the weakened bolt reached EnemyProjectiles via RunManager');
  // shots2.dmg is a Float32Array (storage, not the check, is lossy) — 1e-4
  // clears that rounding with room to spare while still catching a wrong
  // multiplier.
  assert.ok(
    Math.abs(shots2.dmg[0] - wantWeakDmg) < 1e-4,
    `projectiles: RunManager.onFire forwards the reduced dmg (want ${wantWeakDmg}, got ${shots2.dmg[0]})`
  );

  console.log('ok  enemy projectiles');
}

/* ---- elites: forty lives and a marked corpse ---- */
{
  const enemies = new EnemySystem(createRng(6));
  const normal = enemies.spawnAt(0, 0, 2, 0, 0, 0);
  const boss = enemies.spawnAt(5, 5, 2, 0, 0, 1);
  assert.ok(
    Math.abs(enemies.hp[boss] / enemies.hp[normal] - settings.enemies.elites.hpMult) < 1e-6,
    'elites: hp multiplies by the elite factor'
  );
  let marked = null;
  enemies.onDeath = (x, z, element, elite) => (marked = elite);
  enemies.damage({ x: 0, z: 0 }, 0.5, 1e9); // kills the normal at origin only
  assert.equal(marked, 0, 'elites: a normal corpse reports elite=0');
  enemies.damage({ x: 5, z: 5 }, 0.5, 1e9);
  assert.equal(marked, 1, 'elites: an elite corpse says so');
  console.log('ok  elites');
}

/* ---- gem tiers: blue flies far, gold rains, shards call back ---- */
{
  const pickups = new PickupSystem();

  pickups.dropAt(30, 0, 0, 1); // a blue gem far outside the normal magnet
  for (let t = 0; t < 60 * 6; t++) pickups.tick(1 / 60, { x: 0, z: 0 });
  assert.equal(pickups.count, 0, 'gems: blue magnets from across the arena');
  assert.ok(
    Math.abs(pickups.xp - settings.enemies.elites.gemValue) < 1e-6,
    'gems: blue carries the elite value'
  );

  pickups.clear();
  pickups.rainAt(0, 0, createRng(8));
  assert.equal(pickups.count, settings.tides.goldRain.count, 'gems: the rain drops its count');
  let total = 0;
  for (let i = 0; i < pickups.count; i++) total += pickups.value[i];
  assert.ok(
    Math.abs(total - settings.tides.goldRain.count * settings.tides.goldRain.value) < 1e-6,
    'gems: every raindrop is a gold value'
  );

  pickups.clear();
  let shardElement = null;
  pickups.onShard = (element) => (shardElement = element);
  pickups.dropShard(0.3, 0, 4);
  pickups.tick(1 / 60, { x: 0, z: 0 });
  assert.equal(shardElement, 4, 'gems: a shard reports its element, not xp');
  assert.equal(pickups.xp, 0, 'gems: shards carry no xp');
  console.log('ok  gem tiers');
}

/* ---- matchups: the cycle taxes and rewards through the facade ---- */
{
  const enemies = new EnemySystem(createRng(12));
  // metal(0) beats wood(1): a metal hit on a wood enemy lands ×1.25.
  const wood = enemies.spawnAt(0, 0, 0, 1);
  // Default spawn hp (20) can't survive the advantage + disadvantage probes
  // below (12.5 + 8 = 20.5) before the neutral one even runs — top it up so
  // three sequential hits on the same enemy is actually what gets measured.
  enemies.hp[wood] = 1000;
  const before = enemies.hp[wood];
  enemies.damage({ x: 0, z: 0 }, 1, 10, 0);
  // M4: this overcoming hit also sets vuln on `wood` — but a hit never
  // amplifies the vuln it applies itself, so this one is still the bare ×1.25.
  assert.ok(
    Math.abs(before - enemies.hp[wood] - 10 * settings.combat.matchup.advantage) < 1e-6,
    'matchup: advantage lands ×1.25'
  );
  // wood beats earth(4): an earth hit on a wood enemy is the disadvantaged one? No —
  // wood(1) beats earth(4), so earth attacking wood pays the tax.
  const before2 = enemies.hp[wood];
  enemies.damage({ x: 0, z: 0 }, 1, 10, 4);
  // M4: the vuln the metal hit above left live now amplifies every hit after
  // it, matchup or not — ×0.8 disadvantage, then ×1.15 vuln on top.
  // Tolerance widened from 1e-6: vulnAmt and hp are both Float32Array, and
  // the compounded matchup×vuln multiply doesn't survive double precision.
  assert.ok(
    Math.abs(
      before2 - enemies.hp[wood] - 10 * settings.combat.matchup.disadvantage * (1 + settings.combat.debuffs.vuln.amount)
    ) < 1e-3,
    'matchup: disadvantage pays ×0.8, live vuln still amplifies'
  );
  // Neutral pairs pass through matchup untouched — but that same live vuln
  // keeps biting (M4): ×1 matchup, then ×1.15 vuln.
  const before3 = enemies.hp[wood];
  enemies.damage({ x: 0, z: 0 }, 1, 10, 2); // water vs wood: water feeds wood in 相生 but no 克 — neutral here
  assert.ok(
    Math.abs(before3 - enemies.hp[wood] - 10 * (1 + settings.combat.debuffs.vuln.amount)) < 1e-3,
    'matchup: neutral is ×1, live vuln still amplifies'
  );

  // CombatSystem books what each element dealt.
  const combatStats = new CombatSystem(
    { damage: () => 1, damageOnce: () => 2, slow: () => {} },
    null
  );
  const sweep = {
    element: 'ice', phase: 'travel', u: 0.5, position: { x: 1, z: 0 },
    origin: { x: 0, z: 0 }, direction: { x: 1, z: 0 }, length: 4
  };
  combatStats.tick(1 / 60, [sweep]);
  assert.ok(combatStats.damageDealt.ice > 0, 'stats: the ledger books ice damage');
  combatStats.resetStats();
  assert.ok(!combatStats.damageDealt.ice, 'stats: reset wipes the ledger');
  console.log('ok  matchups & stats');
}

/* ---- M7 T1: dual-wuxing hits — 更优一系 (spec §4.7 双属性判定) ---- */
{
  // furnace scenario from the plan: a fire(3) enemy hit by a fused cast
  // carrying two wuxing candidates. Call convention is wux=子系(child),
  // wuxB=母系(parent) — matchup takes the BETTER of the two multipliers,
  // but mark/debuff identity always stays with the child alone.
  const enemies = new EnemySystem(createRng(13));

  // Case 1: wux=子(金0), wuxB=母(水2). 金 is beaten BY fire (×0.8, the
  // child's own matchup loses) but 水 beats fire (×1.25) — the pair still
  // deals the better number, yet the child never overcame on its own, so
  // no debuff, and the mark that lands is still the child's (金).
  const f1 = enemies.spawnAt(0, 0, 0, 3);
  const before1 = enemies.hp[f1];
  enemies.damage({ x: 0, z: 0 }, 1, 10, 0, 2);
  assert.ok(
    Math.abs(before1 - enemies.hp[f1] - 10 * settings.combat.matchup.advantage) < 1e-6,
    'dual matchup: 母系(水) wins the multiplier even though 子系(金) lost its own'
  );
  assert.equal(enemies.mark[f1], 0, 'dual matchup: mark keys off 子系 (金) regardless of who won the multiplier');
  assert.equal(enemies.weakT[f1], 0, 'dual matchup: 子系 (金) never overcame on its own → no 熄灭');

  // Case 2: wux=子(水2), wuxB=母(金0), a fresh enemy — the child overcomes
  // on its own this time; same ×1.25, but now from the child, and its own
  // overcoming debuff (水 → 熄灭) applies.
  const f2 = enemies.spawnAt(5, 0, 0, 3);
  const before2 = enemies.hp[f2];
  enemies.damage({ x: 5, z: 0 }, 1, 10, 2, 0);
  assert.ok(
    Math.abs(before2 - enemies.hp[f2] - 10 * settings.combat.matchup.advantage) < 1e-6,
    'dual matchup: 子系(水) wins its own matchup, same ×1.25 from the other side'
  );
  assert.equal(enemies.mark[f2], 2, 'dual matchup: mark keys off 子系 (水) this time');
  assert.ok(enemies.weakT[f2] > 0, 'dual matchup: 子系 overcame on its own → 熄灭 applies');

  // Single-element regression: omitting wuxingB must be bit-identical to
  // passing it explicitly as -1 — the same probe, both ways, on two fresh
  // wood(1) enemies hit by a metal(0) advantage.
  const r1 = enemies.spawnAt(10, 0, 0, 1);
  const r2 = enemies.spawnAt(15, 0, 0, 1);
  enemies.damage({ x: 10, z: 0 }, 1, 10, 0); // wuxingB omitted
  enemies.damage({ x: 15, z: 0 }, 1, 10, 0, -1); // wuxingB explicit -1
  assert.equal(enemies.hp[r1], enemies.hp[r2], 'dual matchup: omitted wuxingB defaults to -1, bit-identical to passing it explicitly');

  // damageOnce/damageRing thread wuxingB through to the same _applyWux path
  // — a threading smoke test, not a re-derivation of the maths above.
  const f3 = enemies.spawnAt(20, 0, 0, 3);
  const before3 = enemies.hp[f3];
  enemies.damageOnce('m7t1-dual-once', { x: 20, z: 0 }, 1, 10, 0, 2);
  assert.ok(
    Math.abs(before3 - enemies.hp[f3] - 10 * settings.combat.matchup.advantage) < 1e-6,
    'damageOnce: threads wuxingB through to _applyWux'
  );
  enemies.releaseCast('m7t1-dual-once');

  const f4 = enemies.spawnAt(25, 0, 0, 3);
  const before4 = enemies.hp[f4];
  enemies.damageRing({ x: 25, z: 0 }, 0, 1, 10, 0, 2);
  assert.ok(
    Math.abs(before4 - enemies.hp[f4] - 10 * settings.combat.matchup.advantage) < 1e-6,
    'damageRing: threads wuxingB through to _applyWux'
  );

  // Targets forwards wuxingB to whichever population implements it.
  const targets = new Targets();
  const tEnemies = new EnemySystem(createRng(13));
  targets.register(tEnemies);
  const f5 = tEnemies.spawnAt(0, 0, 0, 3);
  const before5 = tEnemies.hp[f5];
  targets.damage({ x: 0, z: 0 }, 1, 10, 0, 2);
  assert.ok(
    Math.abs(before5 - tEnemies.hp[f5] - 10 * settings.combat.matchup.advantage) < 1e-6,
    'Targets.damage: threads wuxingB to the registered population'
  );

  console.log('ok  M7 T1: dual-wuxing matchup (更优一系)');
}

/* ---- run cadence: composition, elites, rain, shard hand ---- */
{
  const rng = createRng(31);
  const enemies = new EnemySystem(rng);
  const pickups = new PickupSystem();
  const player = new PlayerState();
  const tides = new TideSchedule(createRng(31));
  const shots = new EnemyProjectiles();
  const run = new RunManager({
    enemies, pickups, player, rng, tides, projectiles: shots,
    combat: { tick: () => {}, release: () => -1, resetStats: () => {}, book: () => {} },
    targets: { register: () => {} },
    abilities: { active: [], onRetire: null }
  });
  run.start();

  // Two and a half simulated minutes: spawns lean the tide's colour ~bias
  // share. A pinned player position would normally die to real contact
  // (D3's precedent) long before either eliteAt mark — godMode holds it off.
  settings.run.godMode = true;
  for (let t = 0; t < 60 * 150; t++) run.tick(1 / 60, { x: 0, z: 0 });
  settings.run.godMode = false;
  let tideColoured = 0;
  for (let i = 0; i < enemies.count; i++) {
    if (enemies.element[i] === tides.order[0]) tideColoured++;
  }
  // Minute 2.5 is inside tide one; mixed colours exist but the tide dominates.
  assert.ok(
    tideColoured > enemies.count * 0.5,
    `cadence: tide colour dominates (${tideColoured}/${enemies.count})`
  );

  // Elites: tide one (0-180s) is past both eliteAt marks (72s, 135s) by 150s.
  assert.equal(run._elitesSpawned, 2, 'cadence: both mid-tide elites scheduled');

  // tide() forwards TideSchedule's live read, not a frozen snapshot — pin its
  // fields against independently computed expectations (never deepEqual it
  // against tides.tideAt(...) directly: both return the SAME reused scratch
  // object, so that would compare it to itself and could never fail). Must
  // run before the run.elapsed jump below, while elapsed is still ~150.
  const liveTide = run.tide();
  assert.equal(liveTide.element, tides.order[0], 'cadence: tide() forwards the live tide');
  assert.ok(
    Math.abs(liveTide.timeLeft - (settings.tides.length - run.elapsed)) < 1e-6,
    'cadence: tide() reads the manager\'s own live elapsed, not a stale snapshot'
  );

  // Tide turn: crossing 180s rains gold near the player.
  const gemsBefore = pickups.count;
  run.elapsed = settings.tides.length - 0.01;
  run.tick(1 / 60, { x: 0, z: 0 });
  assert.ok(pickups.count >= gemsBefore + settings.tides.goldRain.count - 1, 'cadence: the turn rains gold');

  // An elite corpse drops blue + shard.
  enemies.clear();
  enemies.spawnAt(1, 0, 5, 3, 0, 1);
  const before = pickups.count;
  enemies.damage({ x: 1, z: 0 }, 1, 1e9);
  assert.equal(pickups.count, before + 2, 'cadence: elite drops blue gem and shard');
  console.log('ok  run cadence');
}

/* ---- autocast: the toggle costs 15% and never fires blind ---- */
{
  // CombatSystem's amp folds the autocast tax per cast.
  const seen = [];
  const combat = new CombatSystem(
    { damage: () => 0, damageOnce: (id, p, r, amt) => (seen.push(amt), 0), slow: () => {} },
    null
  );
  const cast = {
    element: 'ice', phase: 'travel', u: 0.5, autocast: true,
    position: { x: 1, z: 0 }, origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 }, length: 4
  };
  combat.tick(1 / 60, [cast]);
  assert.ok(
    Math.abs(seen[0] - settings.combat.ice.damage * settings.run.autocastDamage) < 1e-9,
    'autocast: damage pays the 0.85 tax'
  );
  seen.length = 0;
  cast.autocast = false;
  combat.release(cast);
  combat.tick(1 / 60, [cast]);
  assert.ok(Math.abs(seen[0] - settings.combat.ice.damage) < 1e-9, 'autocast: manual stays full price');

  // book() is the public door FireballAbility's self-resolved hit calls
  // through (ctx.stats?.book?.(...), D-M3-8) — FireballAbility itself only
  // gets browser verification (M2 D-M2-4 precedent), so pin the ledger math
  // directly here instead.
  combat.book('fireball', 100);
  assert.equal(combat.damageDealt.fireball, 100, 'book: books a nominal amount');
  combat.book('fireball', 50);
  assert.equal(combat.damageDealt.fireball, 150, 'book: accumulates, does not overwrite');
  combat.resetStats();
  assert.ok(!combat.damageDealt.fireball, 'book: resetStats wipes it too');
  console.log('ok  autocast tax');
}

/* ---- verdict data & shard hands ---- */
{
  // The player books who hit them last.
  const player = new PlayerState();
  player.takeDamage(10, { element: 2, behavior: 0 });
  assert.deepEqual(player.lastHitBy, { element: 2, behavior: 0 }, 'verdict: last hit is booked');
  player.reset();
  assert.equal(player.lastHitBy, null, 'verdict: reset forgets the killer');

  // A shard hand only deals its own wuxing.
  const loadout = new Loadout();
  settings.run.draftLoadout = true;
  loadout.reset(); // seat 0 = ice (water, wuxing 2)
  const pool = new UpgradePool(createRng(14), loadout, new Modifiers());
  const hand = pool.draw(3, 3, 2); // water shard
  assert.ok(hand.length > 0, 'shard: water offers exist (ice upgrade / glacier new)');
  for (const card of hand) {
    assert.ok(card.kind !== 'passive', 'shard: passives sit out directed hands');
    assert.equal(settings.combat.wuxingOf[card.element], 2, 'shard: every card is water');
  }
  // M6 T4 registered earth's own skills (rockspikes/boulder/quake) — this
  // fixture used to pin "earth draws nothing" (no earth ability existed to
  // draw); that gap is exactly what T4 closes, so the assertion flips to
  // match, same shape as the water hand above rather than staying pinned to
  // a state that's no longer true.
  const earthHand = pool.draw(3, 3, 4); // earth shard
  assert.ok(earthHand.length > 0, 'shard: earth offers exist (rockspikes/boulder/quake, M6 T4)');
  for (const card of earthHand) {
    assert.ok(card.kind !== 'passive', 'shard: passives sit out directed hands');
    assert.equal(settings.combat.wuxingOf[card.element], 4, 'shard: every card is earth');
  }
  console.log('ok  verdict & shards');
}

/* ---- m4 ground truth: the sheng cycle and a per-run shuffle ---- */
{
  // FEEDS is the generating cycle: 金0→水2→木1→火3→土4→金0.
  assert.deepEqual(FEEDS, [2, 3, 1, 4, 0], 'feeds: the sheng cycle as declared');
  assert.deepEqual([...FEEDS].sort(), [0, 1, 2, 3, 4], 'feeds: a permutation');
  let cursor = 0;
  const seen = new Set();
  for (let n = 0; n < 5; n++) {
    seen.add(cursor);
    cursor = FEEDS[cursor];
  }
  assert.equal(seen.size, 5, 'feeds: one closed five-cycle, no islands');

  // reshuffle: a new deal changes order (eventually) and stays a permutation.
  const tides = new TideSchedule(createRng(3));
  const before = [...tides.order];
  const r = createRng(99);
  let changed = false;
  for (let n = 0; n < 8 && !changed; n++) {
    tides.reshuffle(r);
    assert.deepEqual([...tides.order].sort(), [0, 1, 2, 3, 4]);
    if (String(tides.order) !== String(before)) changed = true;
  }
  assert.ok(changed, 'tides: reshuffle actually deals new orders');
  console.log('ok  m4 ground');
}

/* ---- m4 numbers exist and hold their shape ---- */
{
  assert.ok(settings.marks.duration > 0 && settings.marks.reactionMult > 1);
  const d = settings.combat.debuffs;
  assert.ok(d.vuln.amount > 0 && d.vulnStrong.amount > d.vuln.amount, 'debuffs: 熔甲 outbites 断枝');
  assert.ok(d.weak.amount > 0 && d.weak.amount < 1);
  assert.ok(d.slowAmp.mult > 1);
  assert.ok(settings.resonance.threshold >= 2);
  assert.ok(settings.resonance.metalAdvantage > settings.combat.matchup.advantage);
  assert.ok(settings.fusion.minLevel <= settings.upgrades.skillLevelMax, 'fusion: reachable before max');
  assert.ok(settings.sequence.refund < 1);
  console.log('ok  m4 numbers');
}

/* ---- marks, reactions, debuff channels ---- */
{
  const enemies = new EnemySystem(createRng(17));
  const i = enemies.spawnAt(0, 0, 0, 0, 0, 0); // metal enemy, plenty irrelevant
  enemies.hp[i] = 1000;

  // A wood hit marks; a fire hit detonates (FEEDS[1]===3) with ×1.5 bonus.
  enemies.damage({ x: 0, z: 0 }, 1, 10, 1);
  assert.equal(enemies.mark[i], 1, 'marks: first elemental hit clings');
  let reacted = null;
  enemies.onReaction = (markWux, wux, x, z, amount) => (reacted = [markWux, wux, amount]);
  const hpBefore = enemies.hp[i];
  enemies.damage({ x: 0, z: 0 }, 1, 10, 3);
  assert.deepEqual(reacted?.slice(0, 2), [1, 3], 'marks: 木→火 detonates 助燃');
  // M4 controller ruling (spec 锚5, 克制必生效): the triggering hit keeps its
  // own matchup — fire(3) beats this metal(0) enemy — the sheng bonus stacks
  // on top instead of replacing it: 10×1.25 克制 + 10×1.5 引爆.
  const expected = 10 * settings.combat.matchup.advantage + 10 * settings.marks.reactionMult; // hit + detonation
  assert.ok(Math.abs(hpBefore - enemies.hp[i] - expected) < 1e-6, 'marks: detonation stacks on the hit\'s own matchup');
  assert.equal(enemies.mark[i], 255, 'marks: detonation consumes the mark');

  // Non-generating pair overwrites instead.
  enemies.damage({ x: 0, z: 0 }, 1, 10, 2); // water marks
  enemies.damage({ x: 0, z: 0 }, 1, 10, 4); // earth: 水 does not feed 土 → overwrite
  assert.equal(enemies.mark[i], 4, 'marks: a stranger pair overwrites');

  // Debuffs: a metal hit on wood applies vuln, and vuln amplifies the next hit.
  enemies.clear();
  const w = enemies.spawnAt(0, 0, 0, 1);
  enemies.hp[w] = 1000;
  enemies.damage({ x: 0, z: 0 }, 1, 10, 0); // 金克木 → vuln 15%
  assert.ok(enemies.vulnT[w] > 0, 'debuffs: the overcoming hit sets vuln');
  const before = enemies.hp[w];
  enemies.damage({ x: 0, z: 0 }, 1, 10, -1); // neutral probe
  assert.ok(
    Math.abs(before - enemies.hp[w] - 10 * (1 + settings.combat.debuffs.vuln.amount)) < 1e-6,
    'debuffs: vuln amplifies incoming'
  );

  // 熄灭: a water hit on fire weakens its bite.
  enemies.clear();
  const f = enemies.spawnAt(0.2, 0, 0, 3);
  enemies.hp[f] = 1000;
  enemies.damage({ x: 0.2, z: 0 }, 1, 10, 2);
  const bite = enemies.tick(1 / 60, { x: 0.2, z: 0 }, 0);
  assert.ok(
    Math.abs(bite - settings.enemies.swarm.contactDamage * (1 - settings.combat.debuffs.weak.amount)) < 1e-6,
    'debuffs: weak dulls the contact hit'
  );

  // 淤塞: an earth hit doubles later slows.
  enemies.clear();
  const s = enemies.spawnAt(0, 0, 0, 2); // water enemy
  enemies.damage({ x: 0, z: 0 }, 1, 1, 4); // 土克水 → slowAmp
  enemies.slow({ x: 0, z: 0 }, 1, 0.3, 1);
  assert.ok(Math.abs(enemies.slowed[s] - 0.6) < 1e-6, 'debuffs: slowAmp doubles the factor');

  // tuning: knockback multiplier reaches the shove.
  enemies.clear();
  const k = enemies.spawnAt(1, 0, 0);
  enemies.tuning.kbMult = 2;
  enemies.damage({ x: 1, z: 0.01 }, 0.5, 1, -1);
  const shoved = Math.abs(enemies.kbZ[k]);
  enemies.tuning.kbMult = 1;
  enemies.clear();
  const k2 = enemies.spawnAt(1, 0, 0);
  enemies.damage({ x: 1, z: 0.01 }, 0.5, 1, -1);
  assert.ok(shoved > Math.abs(enemies.kbZ[k2]) * 1.8, 'tuning: kbMult scales the shove');
  console.log('ok  marks & debuffs');
}

/* ---- combat depth hooks: quench, fusion and the fire-dot aura ---- */
{
  const seen = [];
  const combat = new CombatSystem(
    { damage: (p, r, amt) => (seen.push(amt), 1), damageOnce: () => 0, slow: () => {} },
    { damageMult: () => 1, dotMult: () => 1.3 }
  );
  // Fire-wuxing burn rides dotMult; the detonation itself is amount-based and
  // pinned in Task 3 — here we pin the burn tick.
  const meteor = {
    element: 'meteor', phase: 'fade', impactTime: 0, fadeTime: 0.1, u: 1,
    position: { x: 0, z: 0 }, origin: { x: 0, z: 0 }, direction: { x: 1, z: 0 }, length: 4
  };
  for (let t = 0; t < 120; t++) combat.tick(1 / 60, [meteor]);
  // A fresh instance that only ever sees 'fade' still detonates once on first
  // sight (existing T3 behaviour, pinned above under "combat: the shape table
  // drives targets calls") — filter that one-off amount out so the sum
  // isolates the burn the way the comment above says it should.
  const total = seen
    .filter((amt) => amt !== settings.combat.meteor.damage)
    .reduce((s, v) => s + v, 0);
  const want = settings.combat.meteor.burnDps * 1.3 * 2; // 2 seconds of boosted burn
  assert.ok(Math.abs(total - want) < want * 0.1, `combat: fire resonance boosts the burn (${total.toFixed(1)}/${want.toFixed(1)})`);

  // Quench and fusion multipliers fold into _amp via cast flags.
  const combat2 = new CombatSystem(
    { damage: () => 0, damageOnce: (id, p, r, amt) => (seen2.push(amt), 0), slow: () => {} },
    null
  );
  const seen2 = [];
  const cast = {
    element: 'ice', phase: 'travel', u: 0.5, quenched: true, fusionMult: 1.2,
    position: { x: 1, z: 0 }, origin: { x: 0, z: 0 }, direction: { x: 1, z: 0 }, length: 4
  };
  combat2.tick(1 / 60, [cast]);
  assert.ok(
    Math.abs(seen2[0] - settings.combat.ice.damage * 1.5 * 1.2) < 1e-9,
    'combat: quench ×1.5 and fusion ×1.2 stack in _amp'
  );
  console.log('ok  combat depth hooks');
}

/* ---- resonance maths and the quench latch ---- */
{
  const mods = new Modifiers();
  mods.computeResonance([2, 2, 0]); // two water, one metal
  assert.ok(mods.resonates(2), 'resonance: two water actives resonate');
  assert.ok(!mods.resonates(0), 'resonance: a single metal does not');
  assert.ok(!mods.cycleActive());
  assert.equal(mods.dotMult(), 1, 'resonance: no fire pair, no dot aura');
  mods.computeResonance([3, 3]);
  assert.equal(mods.dotMult(), settings.resonance.fireDot);
  mods.computeResonance([0, 1, 2, 3, 4]);
  assert.ok(mods.cycleActive(), 'resonance: one of each closes the cycle');

  assert.ok(!mods.consumeQuench('beam'), 'quench: unarmed consumes nothing');
  mods.armQuench();
  assert.ok(!mods.consumeQuench('ice'), 'quench: water does not spend the metal latch');
  assert.ok(mods.consumeQuench('beam'), 'quench: the next metal cast spends it');
  assert.ok(!mods.consumeQuench('beam'), 'quench: spent is spent');
  mods.armQuench();
  mods.reset();
  assert.ok(!mods.consumeQuench('beam'), 'quench: reset clears the latch');
  console.log('ok  resonance & quench');
}

/* ---- M6 T7: 周天 cycleActive() reachable from a real 5-seat loadout ---- */
{
  // The block above drives Modifiers in isolation off a hand-fed wuxing
  // array; this drives the actual pipeline App._refreshResonance uses —
  // real skill ids seated in a Loadout, looked up through
  // settings.combat.wuxingOf, only then fed into computeResonance. One
  // skill per wuxing (金木水火土), all five already classed onto real
  // Ability subclasses (AbilityManager.ABILITY_TYPES, M6 T4-6).
  const loadout = new Loadout();
  loadout.acquire('swordrain'); // 金
  loadout.acquire('chainbolt'); // 木
  loadout.acquire('iceshield'); // 水
  loadout.acquire('firering'); // 火
  loadout.acquire('rockspikes'); // 土
  const wuxingOf = settings.combat.wuxingOf;
  const wuxingList = loadout.equippedList().map((id) => wuxingOf[id]);
  assert.deepEqual(
    wuxingList.slice().sort(),
    [0, 1, 2, 3, 4],
    'M6 T7: the five seats really are one of each wuxing'
  );
  const mods = new Modifiers();
  mods.computeResonance(wuxingList);
  assert.ok(mods.cycleActive(), 'M6 T7: 周天 — a real five-skill loadout (one per wuxing) closes the cycle');
  console.log('ok  M6 T7: cycleActive reachable from a real loadout');
}

/* ---- reaction routing reaches every neighbour system ---- */
{
  const rng = createRng(41);
  const enemies = new EnemySystem(rng);
  const pickups = new PickupSystem();
  const player = new PlayerState();
  const mods = new Modifiers();
  const booked = [];
  const run = new RunManager({
    enemies, pickups, player, rng,
    modifiers: mods,
    tides: new TideSchedule(createRng(41)),
    projectiles: new EnemyProjectiles(),
    combat: { tick: () => {}, release: () => -1, resetStats: () => {}, book: (el, amt) => booked.push([el, amt]) },
    targets: { register: () => {} },
    abilities: { active: [], onRetire: null }
  });
  run.start();

  // 水→木 滋养 heals through the router.
  player.hp = 50;
  enemies.onReaction(2, 1, 0, 0, 10);
  assert.equal(player.hp, 50 + settings.marks.nourishHeal, 'react: 滋养 heals');

  // 火→土 烧结 drops a bonus gem; 土→金 arms the quench.
  const gems = pickups.count;
  enemies.onReaction(3, 4, 1, 1, 10);
  assert.equal(pickups.count, gems + settings.marks.sinterGems, 'react: 烧结 pays a gem');
  enemies.onReaction(4, 0, 0, 0, 10);
  assert.ok(mods.consumeQuench('beam'), 'react: 淬炼 arms the latch');
  // Booking credits whichever skill first casts as the triggering wuxing, in
  // call order (not switch-case order) — the 火→土 call above is the second
  // of these three, so its credit is booked[1]. M6 T2 gave 土 (wux 4) its
  // first representatives (rockspikes leads settings.combat.wuxingOf's
  // insertion order, so wuxingRep(4) picks it) — that call now books too,
  // where it used to be the deliberate skip (wuxingRep had no 土 entry
  // before this milestone).
  assert.equal(booked.length, 3, 'react: all three detonations book under their ledger rep');
  assert.equal(booked[1][0], 'rockspikes', 'react: wux 4 credits rockspikes (wuxingOf\'s first 土 entry)');
  assert.ok(Math.abs(booked[1][1] - 10 * settings.marks.reactionMult) < 1e-9, 'react: wux 4 books amount × reactionMult');

  // Wood resonance turns kills into drops of life.
  mods.computeResonance([1, 1]);
  player.hp = 50;
  const v = enemies.spawnAt(0, 0, 0);
  enemies.damage({ x: 0, z: 0 }, 1, 1e9, -1);
  assert.equal(player.hp, 50 + settings.resonance.woodKillHeal, 'react: wood resonance heals on kill');

  // heal never raises the dead nor overfills.
  player.hp = player.maxHp;
  player.heal(10);
  assert.equal(player.hp, player.maxHp, 'heal: clamps at max');
  player.alive = false;
  player.heal(10);
  assert.equal(player.hp, player.maxHp, 'heal: the dead stay dead');

  // Reentrancy proof (live path): onReaction firing mid-loop used to let a
  // splash swap-remove enemies out from under damage()'s own in-progress
  // loop (task-6 Concern 1). Fresh EnemySystem wired with a splashing-back
  // onReaction directly — the block above proves ROUTING; this proves
  // EnemySystem itself stays correct under the reentrant call routing
  // produces. Three wood enemies (fire vs wood is neutral — BEATS[3]=0≠1,
  // BEATS[1]=4≠3 — so no matchup multiplier muddies the arithmetic), spaced
  // past the direct hits' radius but inside the splash's: only the middle
  // one is ever hit directly, and only the frail one dies to the splash.
  const re = new EnemySystem(createRng(7));
  re.onReaction = (mw, w, x, z, amt) => re.damage({ x, z }, 2, 50, -1);
  const left = re.spawnAt(-1.6, 0, 0, 1);
  const frail = re.spawnAt(1.6, 0, 0, 1);
  const mid = re.spawnAt(0, 0, 0, 1);
  re.hp[left] = 1000;
  re.hp[frail] = 1;
  re.hp[mid] = 1000;
  const frailId = re.id[frail];
  const midId = re.id[mid];

  re.damage({ x: 0, z: 0 }, 1, 10, 1); // wood-marks mid only (left/frail sit past this radius)
  re.damage({ x: 0, z: 0 }, 1, 10, 3); // fire-hits mid: detonates, splash flushes after the loop's done

  // Swap-remove can relocate a survivor, so find enemies by id, not index.
  const findLive = (id) => {
    for (let k = 0; k < re.count; k++) if (re.id[k] === id) return k;
    return -1;
  };
  assert.equal(findLive(frailId), -1, 'reentrancy: the splash actually killed the frail neighbour');
  assert.equal(re.count, 2, 'reentrancy: exactly one death — no phantom kills, no lost survivors');
  const midNow = findLive(midId);
  assert.ok(midNow !== -1, 'reentrancy: the detonated enemy survives and stays trackable');
  // mark hit + fire hit + its 1.5x bonus + its own splash (it stands where it detonated).
  const expectedMidHp = 1000 - 10 - 10 - 10 * settings.marks.reactionMult - 50;
  assert.ok(
    Math.abs(re.hp[midNow] - expectedMidHp) < 1e-6,
    'reentrancy: hit + detonation + its own splash land exactly once, none lost to a swapped-out slot'
  );
  assert.equal(re.hp[left], 1000 - 50, 'reentrancy: an untouched neighbour still takes exactly its one splash hit');
  console.log('ok  reaction routing');
}

/* ---- stress: a full cap of enemies (mixed gaits + live shots) ticks fast enough headless ---- */
{
  const enemies = new EnemySystem(createRng(3));
  const projectiles = new EnemyProjectiles();
  enemies.onFire = (x, z, dx, dz) => projectiles.spawn(x, z, dx, dz);

  // Same 20m spawn ring as before; behavior is the only thing that changes
  // per enemy. Ranged bodies land outside their 8m holdRange and close in
  // over the run, so the mix naturally exercises both the converging and
  // the holding-and-firing half of their gait — no special-casing needed.
  const MIX = [[210, 0], [60, 1], [30, 2]]; // swarm / ranged / tank counts
  let n = 0;
  for (const [count, behavior] of MIX) {
    for (let i = 0; i < count; i++, n++) {
      enemies.spawnAt(Math.cos(n) * 20, Math.sin(n) * 20, 10, 0, behavior);
    }
  }

  const player = { x: 0, z: 0 }; // a bare position, not PlayerState — nothing here reads godMode
  const t0 = performance.now();
  for (let t = 0; t < 600; t++) {
    enemies.tick(1 / 60, player, 10);
    projectiles.tick(1 / 60, player);
  }
  const ms = (performance.now() - t0) / 600;
  // 60Hz leaves 16.6ms per frame for everything; the horde may take 2.
  assert.ok(ms < 2, `stress: enemy tick averages ${ms.toFixed(2)}ms at cap (budget 2ms)`);
  console.log(`ok  stress (${ms.toFixed(2)}ms/tick @ 300 (210 swarm/60 ranged/30 tank, shots live))`);
}

/* ---- the generating chain refunds inside its window ---- */
{
  assert.ok(sequenceRefund(1, 10, 3, 12), 'sequence: 木→火 within 4s refunds');
  assert.ok(!sequenceRefund(1, 10, 3, 15), 'sequence: the window closes');
  assert.ok(!sequenceRefund(3, 10, 1, 12), 'sequence: the cycle has direction');
  assert.ok(!sequenceRefund(-1, 0, 3, 1), 'sequence: no chain from nothing');
  console.log('ok  sequence chain');
}

/* ---- fusion: eligibility, the merge, the gold card ---- */
{
  assert.equal(Object.keys(FUSIONS).length, 5, 'fusion: five pair spells');
  const loadout = new Loadout();
  settings.run.draftLoadout = false;
  loadout.reset(); // all six seated at Lv1
  assert.equal(loadout.eligibleFusions().length, 0, 'fusion: Lv1 pairs are not ripe');

  // Ripen ice(水) + thunder(木): 水生木 → 回春雷泽.
  for (let n = 0; n < settings.fusion.minLevel - 1; n++) {
    loadout.upgrade('ice');
    loadout.upgrade('thunder');
  }
  const eligible = loadout.eligibleFusions();
  assert.ok(
    eligible.some((f) => f.a === 'ice' && f.b === 'thunder' && f.name === '回春雷泽'),
    'fusion: a ripe sheng pair surfaces'
  );

  // The pool guarantees a gold card while one is ripe.
  const pool = new UpgradePool(createRng(7), loadout, new Modifiers());
  const hand = pool.draw(8);
  assert.ok(hand.some((c) => c.kind === 'fusion'), 'fusion: the gold card is dealt');

  // Fusing merges and frees a seat.
  const id = loadout.fuse('ice', 'thunder');
  assert.ok(isFusionId(id) && loadout.has(id), 'fusion: the merged seat holds the spell');
  assert.deepEqual(fusionParents(id), ['ice', 'thunder']);
  assert.ok(loadout.hasEmpty(), 'fusion: the second seat is freed');
  assert.equal(loadout.levelOf(id), 1);
  assert.ok(!loadout.has('ice') && !loadout.has('thunder'), 'fusion: parents leave the board');

  // I4 (M4 final review): the freed seat must not let either fused-away
  // parent re-enter the pool as a 'new' card — they still back the live
  // fusion. Level 5 is a milestone (settings.upgrades.milestones), which
  // forces a 'new' card into the hand whenever one is a legal candidate, so
  // this draw is deterministic rather than relying on the weighted roll.
  const postFuseHand = pool.draw(5);
  assert.ok(
    postFuseHand
      .filter((c) => c.kind === 'new')
      .every((c) => c.element !== 'ice' && c.element !== 'thunder'),
    'fusion: fused-away parents never re-enter the new-active pool'
  );

  assert.ok(loadout.upgrade(id) && loadout.levelOf(id) === 2, 'fusion: the spell levels');
  for (let n = 0; n < 5; n++) loadout.upgrade(id);
  assert.equal(loadout.levelOf(id), settings.fusion.maxLevel, 'fusion: capped at its own max');
  settings.run.draftLoadout = true;
  console.log('ok  fusion core');
}

/* ---- M7 T1: pairKeyOf, rowFor, and the five bespoke fusion rows ---- */
{
  const wuxingOf = settings.combat.wuxingOf;
  // The five FEEDS-legal parent pairs this milestone ships skills for (spec
  // §4.7 table) — verified FEEDS-legal off wuxingOf before asserting the
  // key, not assumed (母 generates 子, Loadout#fuse's own eligibility rule).
  const PAIRS = [
    ['thunder', 'fireball', '1+3'],
    ['fireball', 'boulder', '3+4'],
    ['rockspikes', 'dashstrike', '4+0'],
    ['dashstrike', 'iceshield', '0+2'],
    ['iceshield', 'thunder', '2+1']
  ];
  for (const [a, b, key] of PAIRS) {
    assert.equal(FEEDS[wuxingOf[a]], wuxingOf[b], `pairKeyOf: ${a}→${b} must be FEEDS-legal (母生子) to use as a fixture`);
    assert.equal(pairKeyOf(fusionId(a, b)), key, `pairKeyOf: fusion:${a}+${b} → ${key}`);
    assert.ok(settings.fusions[key], `settings.fusions: missing row ${key}`);
    assert.ok(settings.combat.fusions[key], `settings.combat.fusions: missing row ${key}`);
  }
  assert.equal(Object.keys(settings.fusions).length, 5, 'settings.fusions: exactly five rows');
  assert.equal(Object.keys(settings.combat.fusions).length, 5, 'settings.combat.fusions: exactly five rows');

  // Exact cd/range from the plan's 数值表 — a data pin, since the cooldown
  // wheel's live value can't run headless (the cast site is in App).
  const CD_RANGE = {
    '1+3': { cooldown: 6, range: 10 },
    '3+4': { cooldown: 8, range: 9 },
    '4+0': { cooldown: 7, range: 9 },
    '0+2': { cooldown: 5, range: 11 },
    '2+1': { cooldown: 7, range: 10 }
  };
  for (const [key, want] of Object.entries(CD_RANGE)) {
    assert.equal(settings.fusions[key].cooldown, want.cooldown, `settings.fusions[${key}]: cooldown ${want.cooldown}`);
    assert.equal(settings.fusions[key].range, want.range, `settings.fusions[${key}]: range ${want.range}`);
    assert.equal(settings.fusions[key].castAnim, 'cast1', `settings.fusions[${key}]: castAnim`);
  }
  assert.equal(settings.fusion.budget, undefined, 'settings.fusion: budget retired — bespoke rows price their own Lv1');

  // rowFor: a fusion id resolves into settings.combat.fusions[pairKey]; a
  // plain id passes through settings.combat[element] unchanged.
  assert.equal(rowFor(fusionId('thunder', 'fireball')), settings.combat.fusions['1+3'], 'rowFor: fusion id → combat.fusions row');
  assert.equal(rowFor('ice'), settings.combat.ice, 'rowFor: plain id unchanged');

  console.log('ok  M7 T1: pairKeyOf/rowFor/settings.fusions data');
}

/* ---- M7 T1: resonance counts a fused seat's BOTH wuxing (spec §4.8) ---- */
{
  // Mirrors App#_refreshResonance's own flatMap (App.js pulls in the
  // renderer, so it isn't importable headlessly) — a fused seat already
  // contributes both parents' wuxing there today, unchanged by this task;
  // this pins that behaviour so a future refactor can't silently drop one
  // side. Public API only (Modifiers#resonates), same discipline every
  // other resonance test in this file already follows.
  const loadout = new Loadout();
  loadout.acquire('thunder'); // 木(1)
  loadout.acquire('fireball'); // 火(3)
  for (const el of ['thunder', 'fireball']) {
    while (loadout.levelOf(el) < settings.fusion.minLevel) loadout.upgrade(el);
  }
  loadout.fuse('thunder', 'fireball');
  loadout.acquire('chainbolt'); // a second, standalone 木(1) skill

  const wuxingOf = settings.combat.wuxingOf;
  const wuxingList = loadout.equippedList().flatMap((element) =>
    isFusionId(element) ? fusionParents(element).map((p) => wuxingOf[p]) : [wuxingOf[element]]
  );
  assert.deepEqual(
    wuxingList.slice().sort(),
    [1, 1, 3],
    "resonance: the fused seat contributes both its parents' wuxing, one apiece"
  );

  const mods = new Modifiers();
  mods.computeResonance(wuxingList);
  assert.ok(mods.resonates(1), 'resonance: 木 crosses the threshold — the fused parent + standalone chainbolt, both counted');
  assert.ok(!mods.resonates(3), "resonance: 火 stays at one (only the fused seat's own share) — below threshold");
  console.log('ok  M7 T1: resonance dual-counts a fused seat');
}

/* ---- M7 T1→T6: the marsh kind never touches the damage family ---- */
{
  // T1 pinned this as "unimplemented kind no-ops"; T6 implemented marsh
  // (slow refresh + healInside) and the pin's spirit survives verbatim:
  // marsh STILL makes zero damage-family calls by design — the bolts are
  // ThunderMarshSkill's own self-resolved job, never CombatSystem's.
  const calls = [];
  const fakeTargets = {
    damage: (...args) => (calls.push(args), 0),
    damageOnce: (...args) => (calls.push(args), 0),
    damageRing: (...args) => (calls.push(args), 0),
    slow: () => {}
  };
  const combat = new CombatSystem(fakeTargets, null);
  const marshRow = settings.combat.fusions['2+1'];
  assert.equal(marshRow.kind, 'marsh', "fixture: 2+1 is the marsh row");
  const fakeAbility = {
    element: fusionId('iceshield', 'thunder'), // pairKeyOf → '2+1'
    phase: 'travel', u: 0.5, position: { x: 0, z: 0 },
    origin: { x: 0, z: 0 }, direction: { x: 1, z: 0 }, length: 4,
    autocast: false, quenched: false, fusionMult: 1
  };
  assert.doesNotThrow(() => combat.tick(1 / 60, [fakeAbility]), 'combat: marsh must not throw');
  assert.equal(calls.length, 0, 'combat: marsh makes no damage-family calls — the bolts live in the class (T6 pin, T1 wording retired)');
  console.log("ok  M7 T1→T6: marsh kind stays out of the damage family");
}

/* ---- M7 T2: VineBlazeSkill (业火燎原) — pure helpers ---- */
{
  // zoneTick: leaky-bucket accumulation, mirrors CombatSystem's own _dot/_take
  // — mutates the caller's own accum array in place (fix round: no object
  // literal allocated per call), returns just the paid amount.
  const acc = new Float32Array(1);
  let amt = zoneTick(acc, 0, 45, 1 / 60);
  assert.equal(amt, 0, 'zoneTick: nothing banked below 1');
  assert.ok(Math.abs(acc[0] - 0.75) < 1e-9, 'zoneTick: accumulates dps×step exactly, in place');
  amt = zoneTick(acc, 0, 45, 1 / 60); // 0.75 + 0.75 = 1.5, crosses 1
  assert.ok(amt >= 1, 'zoneTick: pays out once the bucket reaches 1');
  assert.ok(Math.abs(amt - 1.5) < 1e-9, 'zoneTick: pays the WHOLE bucket, not a clamped 1');
  assert.equal(acc[0], 0, 'zoneTick: resets to 0 in place after paying out');

  amt = zoneTick(acc, 0, 90, 1); // a single tick alone already exceeds 1
  assert.ok(Math.abs(amt - 90) < 1e-9, 'zoneTick: a single oversized tick still pays its whole amount');
  assert.equal(acc[0], 0, 'zoneTick: stays reset in place after an oversized single tick');

  assert.equal(liveZoneCount(new Float32Array([4, 0, 2, 0, 0])), 2, 'liveZoneCount: counts life > 0 only');

  assert.equal(forkBudget(1, 2, 5), 2, 'forkBudget: full budget when room allows');
  assert.equal(forkBudget(3, 2, 5), 2, 'forkBudget: exactly fills the cap');
  assert.equal(forkBudget(4, 2, 5), 1, 'forkBudget: partial budget when only one slot remains');
  assert.equal(forkBudget(5, 2, 5), 0, 'forkBudget: cap already reached truncates a further fork to 0');

  const zx = new Float32Array([0, 5, -5, 0, 0]);
  const zz = new Float32Array([0, 0, 0, 0, 0]);
  const life = new Float32Array([4, 2, 0, 0, 0]); // slot 2 has a stale position but is dead
  assert.equal(zoneContaining(0.5, 0.5, zx, zz, life, 2.2), 0, 'zoneContaining: hits the main zone');
  assert.equal(zoneContaining(5.5, 0, zx, zz, life, 2.2), 1, 'zoneContaining: hits a live child');
  assert.equal(zoneContaining(-5.5, 0, zx, zz, life, 2.2), -1, 'zoneContaining: a dead slot never matches, even at its old position');
  assert.equal(zoneContaining(50, 50, zx, zz, life, 2.2), -1, 'zoneContaining: outside every zone');

  const a = forkPlacement(null, 0, 0.8);
  const b = forkPlacement(null, 1, 0.8);
  assert.ok(Math.abs(Math.hypot(a.dx, a.dz) - 0.8) < 1e-9, 'forkPlacement: deterministic fallback sits exactly at maxOffset');
  assert.ok(Math.abs(Math.hypot(b.dx, b.dz) - 0.8) < 1e-9, 'forkPlacement: deterministic fallback sits exactly at maxOffset (2nd child)');
  assert.ok(Math.abs(a.dx - b.dx) > 1e-6 || Math.abs(a.dz - b.dz) > 1e-6, 'forkPlacement: consecutive children never land on the same spot (golden-angle spread)');
  let ci = 0;
  const stream = [0.1, 0.6];
  const c = forkPlacement(() => stream[ci++], 0, 0.8);
  assert.ok(Math.hypot(c.dx, c.dz) <= 0.8 + 1e-9, 'forkPlacement: rng branch stays within maxOffset');

  console.log('ok  M7 T2: VineBlazeSkill pure helpers (zoneTick/forkBudget/zoneContaining/forkPlacement)');
}

/* ---- M7 T2: VineBlazeSkill — headless lifecycle against the real class ---- */
{
  assert.equal(FUSION_CLASSES['1+3'], VineBlazeSkill, "AbilityManager: '1+3' resolves to VineBlazeSkill");

  const damageCalls = [];
  const bookCalls = [];
  const fakeTargets = {
    damage: (pos, r, amt, wux, wuxB) => {
      damageCalls.push({ x: pos.x, z: pos.z, r, amt, wux, wuxB });
      return 1;
    }
  };
  const fakeStats = { book: (element, amount) => bookCalls.push({ element, amount }) };
  const fakeDecal = () => ({
    mesh: { scale: { setScalar() {} } },
    material: { uniforms: { uColorA: { value: { lerpColors() {} } } } }
  });
  const decalSpawns = [];
  const fakeDecals = {
    spawn: (type, pos, opts) => {
      decalSpawns.push({ type, x: pos.x, z: pos.z, opts });
      return fakeDecal();
    }
  };
  let lightsAcquired = 0;
  let lightsReleased = 0;
  const fakeLights = {
    acquire: () => {
      lightsAcquired++;
      return { n: lightsAcquired };
    },
    release: () => lightsReleased++,
    set: () => {}
  };
  const fakeParticles = {
    get: () => ({
      uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
      setGradient() {},
      emit() {}
    })
  };
  const killHook = [];
  const ctx = { targets: fakeTargets, stats: fakeStats, decals: fakeDecals, lights: fakeLights, particles: fakeParticles, killHook, mods: null };

  const ability = new VineBlazeSkill(ctx, fusionId('thunder', 'fireball')); // 木(1)+火(3) → '1+3'

  // Field order matters and must match the real caller exactly:
  // AbilityManager.cast() runs spawn() (and onSpawn) synchronously and
  // returns; only THEN does App#_quickCastToward's fusion branch stamp
  // autocast/fusionMult/quenched onto the returned instance — same "cast,
  // then stamp" order the plain-element branch uses too. Stamping BEFORE
  // spawn() here would hide a real bug class (reading these fields inside
  // onSpawn instead of onImpact sees a pooled instance's STALE values from
  // its previous cast) — fusionMult: 2 (not 1) makes that bug visible in
  // the assertion below rather than silently cancelling out.
  ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 10);
  ability.autocast = false;
  ability.fusionMult = 2;
  ability.quenched = false;
  assert.equal(killHook.length, 1, 'VineBlaze: subscribes to the kill hook on spawn');

  // One tick: the no-travel advance() override resolves TRAVEL→IMPACT
  // immediately and onImpact() plants the main zone at the aimed point.
  ability.update(1 / 60);
  assert.equal(ability.phase, 'impact', 'VineBlaze: reaches IMPACT on the very first tick (no travel)');
  assert.ok(ability.zlife[0] > 0, 'VineBlaze: main zone alive after impact');
  const mainX = ability.zx[0];
  const mainZ = ability.zz[0];
  assert.ok(Math.abs(mainX - 10) < 1e-6 && Math.abs(mainZ - 0) < 1e-6, 'VineBlaze: main zone lands at the aimed point, not the caster');
  assert.equal(decalSpawns.length, 1, 'VineBlaze: the main zone spawns its own decal');
  assert.ok(
    Math.abs(ability.zdps[0] - 45 * 2) < 1e-6,
    'VineBlaze: onImpact reads fusionMult stamped AFTER spawn() (45 base × 2 fusionMult), not a stale pre-spawn value'
  );

  // Kill outside every zone: nothing happens.
  killHook[0](500, 500, 0);
  assert.equal(liveZoneCount(ability.zlife), 1, 'VineBlaze: a kill outside every zone is a no-op');

  // Kill dead centre of the main zone: forks exactly 2 children.
  killHook[0](mainX, mainZ, 0);
  assert.equal(liveZoneCount(ability.zlife), 3, 'VineBlaze: one main-zone kill forks exactly 2 children');
  const childX = ability.zx[1];
  const childZ = ability.zz[1];

  // Kill inside a child zone but OUTSIDE the (overlapping) main zone's own
  // radius — children spawn well within the main zone's reach (forkOffset
  // 0.8 << radius 2.2), so a kill at a child's own centre would ALSO read
  // as "inside main"; this point isolates the child-only case.
  const awayX = childX + ability.config.radius * 0.9;
  killHook[0](awayX, childZ, 0);
  assert.equal(liveZoneCount(ability.zlife), 3, 'VineBlaze: a kill inside a child zone (outside main) spawns no grandchildren');

  // A second main-zone kill fills the cap exactly (1 main + 4 children = 5).
  killHook[0](mainX, mainZ, 0);
  assert.equal(liveZoneCount(ability.zlife), 5, 'VineBlaze: a second main-zone kill fills the cap exactly');

  // A third forking kill has no slots left — truncated to 0 new zones.
  killHook[0](mainX, mainZ, 0);
  assert.equal(liveZoneCount(ability.zlife), 5, "VineBlaze: cap enforced — a 3rd forking kill's forks truncate");

  // Zone-tick math: a couple of 1s ticks, still well inside the 4s life,
  // must have actually paid real damage with the fusion's own wux/wuxB.
  ability.update(1);
  ability.update(1);
  assert.equal(liveZoneCount(ability.zlife), 5, 'VineBlaze: every zone still alive mid-life while ticking damage');
  assert.ok(damageCalls.length > 0, 'VineBlaze: zone ticks actually call targets.damage');
  assert.ok(
    damageCalls.every((c) => c.wux === 3 && c.wuxB === 1),
    'VineBlaze: every hit carries wux=3 (子 fire), wuxB=1 (母 wood)'
  );
  assert.ok(
    bookCalls.length > 0 && bookCalls.every((b) => b.element === ability.element),
    'VineBlaze: every payout books under the fusion id'
  );

  // Run the clock out well past the main zone's 4s life — every zone
  // (main and every child, regardless of when it forked) retires together.
  for (let i = 0; i < 5; i++) ability.update(1);
  assert.equal(liveZoneCount(ability.zlife), 0, 'VineBlaze: every zone retires once its life expires');

  // Drive the cast to DONE and retire it the way AbilityManager does.
  while (!ability.isFinished) ability.update(0.5);
  ability.destroy();
  assert.equal(killHook.length, 0, 'VineBlaze: retire unsubscribes — listener list back to baseline');
  assert.equal(lightsReleased, lightsAcquired, 'VineBlaze: every acquired light (base + every child) was released, none leaked');

  console.log('ok  M7 T2: VineBlazeSkill zone lifecycle (fork/cap/retire/wux), headless');
}

/* ---- M7 T2 fix round: real-path fork reentrancy (reviewer-recommended) ---- */
{
  // Every fork assertion above injects killHook[0](x, z, elite) directly —
  // none exercise the REAL synchronous chain a live kill actually takes:
  // _payoutZone → ctx.targets.damage → EnemySystem#_kill → onDeath → the
  // fan-out → this SAME ability's own _onKillAt, all firing synchronously
  // from *inside* onFade's own `for` loop over `this.zlife`. Reviewer
  // traced this seam safe (a fork only ever writes to a DEAD slot — never
  // the slot currently being iterated, which is alive by construction, so
  // it can't self-corrupt) — this pins the real path, not a stand-in for
  // it, so a future change to any link in that chain can't quietly break it.
  const rng = createRng(19);
  const enemies = new EnemySystem(rng);
  const targets = new Targets();
  targets.register(enemies);

  // Minimal real onDeath→fan-out: the exact one-line loop RunManager's own
  // constructor wires (src/run/RunManager.js), without standing up the
  // other seven collaborators (pickups/player/modifiers/tides/projectiles/
  // combat/ultimate) a full RunManager needs for this one seam.
  const killHook = [];
  enemies.onDeath = (x, z, element, elite) => {
    for (let i = 0; i < killHook.length; i++) killHook[i](x, z, elite);
  };

  const ctx = {
    targets,
    killHook,
    stats: { book() {} },
    decals: {
      spawn: () => ({
        mesh: { scale: { setScalar() {} } },
        material: { uniforms: { uColorA: { value: { lerpColors() {} } } } }
      })
    },
    lights: { acquire: () => ({}), release() {}, set() {} },
    particles: {
      get: () => ({
        uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
        setGradient() {},
        emit() {}
      })
    },
    mods: null
  };

  const ability = new VineBlazeSkill(ctx, fusionId('thunder', 'fireball'));
  ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 10);
  ability.autocast = false;
  ability.fusionMult = 1;
  ability.quenched = false;
  ability.update(1 / 60); // TRAVEL→IMPACT, plants the main zone at (10, 0)
  const mainX = ability.zx[0];
  const mainZ = ability.zz[0];

  // Seed two pre-existing children the ordinary (synthetic) way — real
  // state to prove untouched by the real reentrant fork below, not an
  // empty main zone with nothing at stake.
  killHook[0](mainX, mainZ, 0);
  assert.equal(liveZoneCount(ability.zlife), 3, 'fixture: two pre-existing children seeded');
  const before = [1, 2].map((i) => ({ x: ability.zx[i], z: ability.zz[i], dps: ability.zdps[i] }));

  // A REAL enemy, sitting exactly where the main zone will hit it, hp low
  // enough that the MAIN zone's own payout (processed first, i=0, in the
  // onFade loop below) is what kills it — not a child's.
  const idx = enemies.spawnAt(mainX, mainZ, 0, 0, 0, 0);
  enemies.hp[idx] = 5;
  const enemiesBefore = enemies.count;

  // One real tick: onFade's own loop reaches i=0, ticks the main zone's
  // dps into a payout, targets.damage() kills the enemy for real,
  // EnemySystem#_kill fires onDeath synchronously, the fan-out above calls
  // straight back into this SAME ability's _onKillAt — still mid-loop.
  assert.doesNotThrow(() => ability.update(1), 'VineBlaze: a real reentrant kill-triggered fork must not throw');

  assert.equal(enemies.count, enemiesBefore - 1, 'VineBlaze: the real enemy actually died');
  assert.equal(
    liveZoneCount(ability.zlife),
    5,
    'VineBlaze: the real kill forks exactly 2 more children, filling the cap (2 pre-existing + 2 new)'
  );
  assert.ok(
    ability.zlife[0] > 0,
    'VineBlaze: the main zone itself survives being the one whose own payout triggered the reentrant fork'
  );
  for (let i = 1; i <= 2; i++) {
    const b = before[i - 1];
    assert.equal(ability.zx[i], b.x, `VineBlaze: pre-existing child ${i}'s position untouched by the real reentrant fork`);
    assert.equal(ability.zz[i], b.z, `VineBlaze: pre-existing child ${i}'s position untouched by the real reentrant fork`);
    assert.equal(ability.zdps[i], b.dps, `VineBlaze: pre-existing child ${i}'s dps untouched by the real reentrant fork`);
  }

  console.log('ok  M7 T2 fix round: real-path fork reentrancy (EnemySystem→onDeath→killHook, mid-onFade-loop)');
}

/* ---- M7 T2 fix round 2: reentrant fork must not clobber the sweep's own scratch ---- */
{
  // Reviewer's repro: EnemySystem#damage()'s own `for` loop re-reads
  // point.x/point.z on EVERY iteration, never caching it once up front. The
  // previous reentrancy test above has only ONE real enemy — nothing left
  // for a clobbered point to miss once the killer itself is gone — so it
  // never exercised this.
  //
  // Placement, worked out exactly (not eyeballed) off the real
  // `forkPlacement` output rather than hand-derived trig:
  //   - `_onKillAt` places the FIRST child (seq 0) into the first empty
  //     slot, then the SECOND (seq 1) into the next — `_forkPos`/`_pos`'s
  //     value once `_onKillAt` returns (and control unwinds back into the
  //     still-running damage() sweep) is whatever the LAST of those two
  //     calls wrote, i.e. seq 1's position, not seq 0's.
  //   - The survivor sits `SURVIVOR_DIST` out from the main zone's true
  //     centre, in the direction exactly OPPOSITE seq 1's own offset — so
  //     it reads `SURVIVOR_DIST` from the true centre (inside main's own
  //     reach) but `SURVIVOR_DIST + forkOffset` from the clobbered point
  //     (outside every zone's reach), by simple collinearity.
  //   - `dt` is chosen small enough that a FRESHLY forked child (dps 27,
  //     accum starts at 0 this same frame) does NOT itself cross the ≥1
  //     payout threshold this tick (27×dt < 1) — so a same-frame child hit
  //     can never confound "did the survivor take main's hit or a child's".
  const SURVIVOR_DIST = 2.5; // < radius(2.2)+bodyRadius(0.45)=2.65: inside main's reach
  const TICK_DT = 0.025; // 45×0.025=1.125 ≥ 1 (main pays); 27×0.025=0.675 < 1 (a fresh child doesn't)

  // Isolates the exact variable the reviewer's own repro isolated: the
  // identical zone+survivor scenario, run twice, differing only in whether
  // the neighbouring enemy also dies (and therefore forks) that same tick.
  function runSurvivorScenario(dyingEnemyHp) {
    const rng = createRng(23);
    const enemies = new EnemySystem(rng);
    const targets = new Targets();
    targets.register(enemies);
    const killHook = [];
    enemies.onDeath = (x, z, element, elite) => {
      for (let i = 0; i < killHook.length; i++) killHook[i](x, z, elite);
    };
    const ctx = {
      targets,
      killHook,
      stats: { book() {} },
      decals: {
        spawn: () => ({
          mesh: { scale: { setScalar() {} } },
          material: { uniforms: { uColorA: { value: { lerpColors() {} } } } }
        })
      },
      lights: { acquire: () => ({}), release() {}, set() {} },
      particles: {
        get: () => ({
          uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
          setGradient() {},
          emit() {}
        })
      },
      mods: null
    };
    const ability = new VineBlazeSkill(ctx, fusionId('thunder', 'fireball'));
    ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 10);
    ability.autocast = false;
    ability.fusionMult = 1;
    ability.quenched = false;
    ability.update(1 / 60); // TRAVEL→IMPACT, main zone at (10, 0)
    const mainX = ability.zx[0];
    const mainZ = ability.zz[0];

    // The exact offset _onKillAt's SECOND fork call will place (seq 1) —
    // the deterministic fallback (no ctx.rng, same as the real app today)
    // is pure, so calling it here mirrors production exactly rather than
    // re-deriving its angle by hand.
    const seq1 = forkPlacement(null, 1, 0.8);
    const scale = SURVIVOR_DIST / 0.8;
    const survivorX = mainX - seq1.dx * scale;
    const survivorZ = mainZ - seq1.dz * scale;

    // element 1 (wood) is neutral against BOTH wux=3(fire)/wuxB=1(wood) —
    // BEATS[3]=0≠1 and BEATS[1]=4≠1 either direction — so the payout below
    // carries no matchup multiplier and the arithmetic is exact.
    //
    // Spawned FIRST → index 0 → EnemySystem.damage()'s reverse loop
    // (count-1 downto 0) visits it LAST, i.e. AFTER the dying enemy's kill
    // (and its reentrant fork) has already fired earlier in this same sweep
    // — "later in the iteration order," the reviewer's own phrase.
    const survivor = enemies.spawnAt(survivorX, survivorZ, 0, 1, 0, 0);
    enemies.hp[survivor] = 20;

    // Spawned SECOND → index 1 → visited FIRST by the reverse loop.
    const dying = enemies.spawnAt(mainX, mainZ, 0, 1, 0, 0);
    enemies.hp[dying] = dyingEnemyHp;

    ability.update(TICK_DT);

    return { survivorHp: enemies.hp[survivor], liveZones: liveZoneCount(ability.zlife) };
  }

  const EXPECTED_HP = 20 - 45 * TICK_DT; // 18.875 — main's own hit only

  const control = runSurvivorScenario(999); // neighbour survives too — no fork
  assert.equal(control.liveZones, 1, 'fixture: control case forks nothing (neighbour also survives)');
  assert.ok(
    Math.abs(control.survivorHp - EXPECTED_HP) < 1e-6,
    `fixture: control survivor takes exactly main's own payout (20 → ${EXPECTED_HP}), got ${control.survivorHp}`
  );

  const withFork = runSurvivorScenario(1); // neighbour dies — forks 2 children
  assert.equal(withFork.liveZones, 3, 'fixture: treatment case actually forks (neighbour dies this tick)');
  assert.ok(
    Math.abs(withFork.survivorHp - EXPECTED_HP) < 1e-6,
    `VineBlaze: a reentrant fork must not rob a later-iterated survivor of its own hit — got ${withFork.survivorHp}, expected ${EXPECTED_HP} (control: ${control.survivorHp})`
  );

  console.log("ok  M7 T2 fix round 2: reentrant fork does not clobber the sweep's shared scratch (survivor still takes damage)");
}

/* ---- M7 T2: sandbox null-safety — no ctx.targets/killHook, VFX only ---- */
{
  const ctx = {
    decals: { spawn: () => ({ mesh: { scale: { setScalar() {} } }, material: { uniforms: { uColorA: { value: { lerpColors() {} } } } } }) },
    lights: { acquire: () => null, release: () => {}, set: () => {} },
    particles: {
      get: () => ({
        uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
        setGradient() {},
        emit() {}
      })
    }
    // no targets, no killHook, no stats, no mods — the sandbox shape
  };
  const ability = new VineBlazeSkill(ctx, fusionId('thunder', 'fireball'));
  ability.autocast = false;
  ability.fusionMult = 1;
  ability.quenched = false;
  assert.doesNotThrow(() => ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 10), 'VineBlaze: spawn is null-safe with no killHook/targets');
  assert.doesNotThrow(() => {
    for (let i = 0; i < 300; i++) ability.update(1 / 60);
  }, 'VineBlaze: a full cast ticks with no killHook/targets/stats and never throws');
  assert.doesNotThrow(() => ability.destroy(), 'VineBlaze: destroy is null-safe with no killHook');
  console.log('ok  M7 T2: VineBlazeSkill sandbox null-safety (VFX only, zero errors)');
}

/* ---- M7 T2: RunManager onKillAt — injects and fans out, additively ---- */
{
  const rng = createRng(77);
  const enemies = new EnemySystem(rng);
  const pickups = new PickupSystem();
  const player = new PlayerState();
  const mods = new Modifiers();
  const fakeCtx = {};
  const run = new RunManager({
    enemies, pickups, player, rng,
    modifiers: mods,
    tides: new TideSchedule(createRng(77)),
    projectiles: new EnemyProjectiles(),
    combat: { tick: () => 0, release: () => -1, resetStats: () => {}, book: () => {} },
    targets: { register: () => {} },
    abilities: { active: [], onRetire: null, ctx: fakeCtx }
  });

  assert.equal(fakeCtx.killHook, run.onKillAt, 'RunManager: injects its onKillAt list onto abilities.ctx');

  // Fixtures that construct RunManager with a bare { active, onRetire }
  // abilities stub (no ctx at all) must be untouched by this — several
  // pre-existing check-game.mjs blocks do exactly that (asserted implicitly:
  // this whole file still runs to completion around this block).
  const bareRun = new RunManager({
    enemies: new EnemySystem(createRng(1)), pickups: new PickupSystem(), player: new PlayerState(), rng: createRng(1),
    modifiers: new Modifiers(), tides: new TideSchedule(createRng(1)), projectiles: new EnemyProjectiles(),
    combat: { tick: () => 0, release: () => -1, resetStats: () => {}, book: () => {} },
    targets: { register: () => {} },
    abilities: { active: [], onRetire: null }
  });
  assert.ok(Array.isArray(bareRun.onKillAt), 'RunManager: onKillAt still exists with no abilities.ctx to inject onto');

  run.start();
  const seen = [];
  run.onKillAt.push((x, z, elite) => seen.push({ x, z, elite }));

  const i = enemies.spawnAt(3, 4, 0, 0, 0, 0);
  assert.equal(i, 0);
  const killsBefore = run.kills;
  enemies.damage({ x: 3, z: 4 }, 1, 99999, -1); // untyped, lethal in one hit

  assert.equal(seen.length, 1, 'RunManager: onKillAt fan-out fires exactly once per death');
  assert.deepEqual(seen[0], { x: 3, z: 4, elite: 0 }, 'RunManager: fan-out receives (x, z, elite)');
  assert.equal(run.kills, killsBefore + 1, 'RunManager: existing kill counter still increments — fan-out is additive');

  console.log('ok  M7 T2: RunManager onKillAt injection + fan-out (existing death flow intact)');
}

/* ---- M7 T3: CombatSystem 'burst' waves generalisation ---- */
{
  // A synthetic row (settings.combat's own scratch-row idiom — mirrors the
  // T12 breakpoints block's `settings._bpScratch`) with varied damageMult/
  // radiusMult per wave, so the multiplier math is genuinely exercised
  // (地心火山's own row happens to use ×1/×1 for all three — proven
  // separately, against the real row, by the VolcanoSkill lifecycle test
  // below and the meteor-equivalence pin above).
  settings.combat._waveTest = {
    kind: 'burst',
    damage: 100,
    radius: 1,
    waves: [
      { delay: 0.1, damageMult: 0.5, radiusMult: 2 },
      { delay: 0.3, damageMult: 2, radiusMult: 0.5 },
      { delay: 0.5, damageMult: 1, radiusMult: 1 }
    ],
    stunTime: 0.4
  };
  const hits = [];
  const slows = [];
  const combat = new CombatSystem({
    damage: (p, r, amt) => (hits.push({ x: p.x, z: p.z, r, amt }), 1),
    damageOnce: () => 1,
    slow: (p, r, f, d) => slows.push({ f, d })
  });
  const ability = {
    element: '_waveTest',
    phase: 'impact',
    position: { x: 0, z: 0 },
    origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 },
    length: 1,
    u: 1,
    impactTime: 0,
    fadeTime: 0
  };

  ability.impactTime = 0.05;
  combat.tick(1 / 60, [ability]);
  assert.equal(hits.length, 0, "waves: nothing fires before the first wave's own delay");

  // Move `position` BEFORE crossing wave 0's delay — the hit must land at
  // the NEW point, not wherever it was when the cast started.
  ability.position.x = 5;
  ability.position.z = 7;
  ability.impactTime = 0.15;
  combat.tick(1 / 60, [ability]);
  assert.equal(hits.length, 1, 'waves: wave 0 fires exactly once, once its own delay is reached');
  assert.ok(hits[0].x === 5 && hits[0].z === 7, 'waves: position read fresh — wave 0 lands where it was just moved to');
  assert.ok(Math.abs(hits[0].amt - 50) < 1e-9, 'waves: wave 0 damage = base(100) × its own damageMult(0.5)');
  assert.ok(Math.abs(hits[0].r - 2) < 1e-9, 'waves: wave 0 radius = base(1) × its own radiusMult(2)');
  assert.equal(slows.length, 1, "waves: stunTime applies once per wave — wave 0's own hit included");
  assert.ok(
    Math.abs(slows[0].f - 1) < 1e-9 && Math.abs(slows[0].d - 0.4) < 1e-9,
    "waves: wave 0's stun is full-strength (1.0), at the row's own stunTime"
  );

  // Move again, cross wave 1's own delay.
  ability.position.x = -2;
  ability.position.z = 3;
  ability.impactTime = 0.35;
  combat.tick(1 / 60, [ability]);
  assert.equal(hits.length, 2, "waves: wave 1 fires once its own delay is reached, wave 0 doesn't re-fire");
  assert.ok(hits[1].x === -2 && hits[1].z === 3, "waves: wave 1 also reads position fresh, at its own moved spot");
  assert.ok(Math.abs(hits[1].amt - 200) < 1e-9, 'waves: wave 1 damage = base(100) × its own damageMult(2)');
  assert.ok(Math.abs(hits[1].r - 0.5) < 1e-9, 'waves: wave 1 radius = base(1) × its own radiusMult(0.5)');
  assert.equal(slows.length, 2, "waves: wave 1 applies its own stun too");

  // A stalled-frame jump crosses wave 2's delay in one tick — catch-up
  // fires it exactly once, not skipped and not double-fired on the next tick.
  ability.impactTime = 10;
  combat.tick(1 / 60, [ability]);
  assert.equal(hits.length, 3, 'waves: a stalled-frame jump still fires the last wave exactly once (catch-up)');
  combat.tick(1 / 60, [ability]);
  assert.equal(hits.length, 3, 'waves: once every wave has fired, further ticks are no-ops');

  const castId = combat._castIds.get(ability);
  assert.equal(combat._waveCursor.get(castId), 3, 'waves: cursor lands on the wave count once every wave has fired');
  const releasedId = combat.release(ability);
  assert.ok(!combat._waveCursor.has(releasedId), "waves: release() clears this cast's wave cursor — no leak");

  delete settings.combat._waveTest;
  console.log('ok  M7 T3: CombatSystem burst waves generalisation');
}

/* ---- M7 T3: VolcanoSkill (地心火山) — headless lifecycle against the real class ---- */
{
  assert.equal(FUSION_CLASSES['3+4'], VolcanoSkill, "AbilityManager: '3+4' resolves to VolcanoSkill");

  const damageCalls = [];
  const bookCalls = [];
  const fakeTargets = {
    damage: (pos, r, amt, wux, wuxB) => (damageCalls.push({ x: pos.x, z: pos.z, r, amt, wux, wuxB }), 1)
  };
  const fakeStats = { book: (element, amount) => bookCalls.push({ element, amount }) };
  const decalSpawns = [];
  const fakeDecals = { spawn: (type, pos, opts) => (decalSpawns.push({ type, x: pos.x, z: pos.z, opts }), {}) };
  let lightsAcquired = 0;
  let lightsReleased = 0;
  const fakeLights = {
    acquire: () => (lightsAcquired++, { n: lightsAcquired }),
    release: () => lightsReleased++,
    set: () => {}
  };
  const fakeParticles = {
    get: () => ({
      uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
      setGradient() {},
      emit() {}
    })
  };
  const fakeBursts = { spawn: () => {} };
  const ctx = {
    targets: fakeTargets,
    stats: fakeStats,
    decals: fakeDecals,
    lights: fakeLights,
    particles: fakeParticles,
    bursts: fakeBursts,
    mods: null
  };

  const ability = new VolcanoSkill(ctx, fusionId('fireball', 'boulder')); // 火(3)+土(4) → '3+4'
  ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
  ability.autocast = false;
  ability.fusionMult = 1;
  ability.quenched = false;

  ability.update(1 / 60);
  assert.equal(ability.phase, 'impact', 'Volcano: reaches IMPACT on the very first tick (no travel)');
  assert.ok(
    Math.abs(ability._conePos.x - 9) < 1e-6 && Math.abs(ability._conePos.z - 0) < 1e-6,
    'Volcano: the cone lands at the aimed point, not the caster'
  );

  // Scatter: three bombs, every one within scatterRadius (4m) of the cone.
  const row = settings.combat.fusions['3+4'];
  assert.equal(row.waves.length, 3, "Volcano: three bombs, matching the row's own wave count");
  for (let i = 0; i < row.waves.length; i++) {
    const d = Math.hypot(ability._bombX[i] - ability._conePos.x, ability._bombZ[i] - ability._conePos.z);
    // `_bombX`/`_bombZ` are Float32Array (VineBlazeSkill's own zx/zz
    // precedent) — the tolerance has to clear float32's own rounding
    // floor for values in this range (~1e-6), not just double-precision noise.
    assert.ok(d <= settings.fusions['3+4'].scatterRadius + 1e-4, `Volcano: bomb ${i} scatters within scatterRadius`);
  }
  // Deterministic given no ctx.rng (forkPlacement's own fallback, proven in
  // isolation at M7 T2) — a fresh cast off a pooled instance lands the same
  // three spots, same as any other pooled ability's repeatable shape.
  const firstBombX = Array.from(ability._bombX);
  const firstBombZ = Array.from(ability._bombZ);
  ability.destroy();
  ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
  ability.update(1 / 60);
  assert.deepEqual(Array.from(ability._bombX), firstBombX, 'Volcano: scatter X is deterministic given the same fixed fallback');
  assert.deepEqual(Array.from(ability._bombZ), firstBombZ, 'Volcano: scatter Z is deterministic given the same fixed fallback');

  // Drive CombatSystem's own hand-off directly (this is a class-level pool
  // test — the CombatSystem-level wave firing itself is the block above):
  // each wave's own detonation writes `waveIndex`, which is all this class
  // watches to know a bomb has landed. Baseline the light counter here —
  // the two `spawn()` calls above each already acquired the base class's
  // own inherited `this.light` (unrelated to this class's per-pool
  // lights), so only the DELTA from here on is "lights per landed pool".
  const lightsBeforeLanding = lightsAcquired;
  ability.waveIndex = 1;
  ability.update(1 / 60);
  assert.ok(ability._plife[0] > 0, "Volcano: bomb 0's lava pool is alive once its wave has fired");
  assert.equal(ability._plife[1], 0, "Volcano: bomb 1's pool hasn't spawned yet");
  assert.equal(decalSpawns.filter((d) => d.type === DecalType.SCORCH).length, 1, 'Volcano: one lava-pool decal per landed bomb');
  assert.equal(lightsAcquired - lightsBeforeLanding, 1, 'Volcano: one light per landed pool');

  ability.waveIndex = 2;
  ability.update(1 / 60);
  assert.ok(ability._plife[1] > 0, "Volcano: bomb 1's pool spawns once its own wave fires");

  ability.waveIndex = 3;
  ability.update(1 / 60);
  assert.ok(ability._plife[2] > 0, "Volcano: bomb 2's pool spawns once its own wave fires");
  assert.equal(
    decalSpawns.filter((d) => d.type === DecalType.SCORCH).length,
    3,
    'Volcano: exactly 3 lava pools ever — the cap matches the bomb count, no more'
  );

  // Tick the pools' own DoT — zoneTick's own math is already proven in
  // isolation (M7 T2); this confirms VolcanoSkill actually wires it, with
  // the fusion's own (子, 母) = (土 4, 火 3) pair.
  ability.update(1);
  assert.ok(damageCalls.length > 0, 'Volcano: lava pools actually pay out damage');
  assert.ok(
    damageCalls.every((c) => c.wux === 4 && c.wuxB === 3),
    'Volcano: every lava-pool hit carries wux=4 (子 earth), wuxB=3 (母 fire)'
  );
  assert.ok(
    bookCalls.length > 0 && bookCalls.every((b) => b.element === ability.element),
    'Volcano: every lava payout books under the fusion id'
  );

  // Run the clock out well past every pool's own 4s life.
  for (let i = 0; i < 6; i++) ability.update(1);
  assert.ok(ability._plife.every((life) => life <= 0), "Volcano: every pool retires once its own life elapses");

  while (!ability.isFinished) ability.update(0.5);
  ability.destroy();
  assert.equal(lightsReleased, lightsAcquired, 'Volcano: every acquired light (one per landed pool) was released, none leaked');

  console.log('ok  M7 T3: VolcanoSkill lifecycle (scatter/waves hand-off/lava pools/cap/wux), headless');
}

/* ---- M7 T3: sandbox null-safety — no ctx.targets/stats/mods, VFX only ---- */
{
  const ctx = {
    decals: { spawn: () => ({}) },
    lights: { acquire: () => null, release: () => {}, set: () => {} },
    particles: {
      get: () => ({
        uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
        setGradient() {},
        emit() {}
      })
    }
    // no targets, no stats, no mods, no bursts — the sandbox shape
    // (fusions are unreachable there in practice — Global Constraints — but
    // the class must still not throw if ticked with this shaped a ctx).
  };
  const ability = new VolcanoSkill(ctx, fusionId('fireball', 'boulder'));
  ability.autocast = false;
  ability.fusionMult = 1;
  ability.quenched = false;
  assert.doesNotThrow(() => ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9), 'Volcano: spawn is null-safe with no targets/bursts');
  assert.doesNotThrow(() => {
    for (let i = 0; i < 500; i++) ability.update(1 / 60);
  }, 'Volcano: a full cast ticks with no targets/stats/bursts and never throws');
  assert.doesNotThrow(() => ability.destroy(), 'Volcano: destroy is null-safe');
  console.log('ok  M7 T3: VolcanoSkill sandbox null-safety (VFX only, zero errors)');
}

/* ---- M7 T4: EnemySystem.applyVuln — 锋岩星阵's armour-grind channel ---- */
{
  const enemies = new EnemySystem(createRng(31));
  const pad = settings.enemies.swarm.radius; // every spawn below is behavior 0

  // Geometry mirrors damageRing exactly, inner pad included: innerRadius 0
  // degenerates to a solid disc (dead centre counts), a real annulus skips
  // an enemy standing deeper inside the inner edge than its own body radius.
  const centre = enemies.spawnAt(0, 0, 0);
  const midBand = enemies.spawnAt(2.5, 0, 0);
  const outside = enemies.spawnAt(10, 0, 0);
  enemies.applyVuln({ x: 0, z: 0 }, 0, 3.5, 0.25, 3);
  assert.equal(enemies.vulnT[centre], 3, 'applyVuln: innerRadius 0 is a solid disc — dead centre is vulnerable');
  assert.equal(enemies.vulnAmt[centre], 0.25, "applyVuln: writes the caller's amount");
  assert.equal(enemies.vulnT[midBand], 3, 'applyVuln: mid-disc enemy is vulnerable');
  assert.equal(enemies.vulnT[outside], 0, 'applyVuln: past the outer edge is untouched');

  {
    const annulus = new EnemySystem(createRng(32));
    const nearInner = annulus.spawnAt(2 - pad * 0.5, 0, 0); // inside the inner edge, but within its own body radius of it
    const deepInside = annulus.spawnAt(2 - pad - 0.3, 0, 0); // deeper than its body radius can reach
    annulus.applyVuln({ x: 0, z: 0 }, 2, 3.5, 0.25, 3);
    assert.equal(annulus.vulnT[nearInner], 3, "applyVuln: inner edge pads by the enemy's own radius, same as damageRing");
    assert.equal(annulus.vulnT[deepInside], 0, 'applyVuln: well inside the inner edge is untouched');
  }

  // Override rules on the one shared vulnT/vulnAmt channel (勘误: 弱不降级强):
  // a live STRONGER vuln is left entirely alone — magnitude AND timer — a
  // weaker application while it holds is a no-op, never a downgrade; equal
  // strength refreshes the timer (the array's own per-tick re-application);
  // stronger overwrites weaker, same as _applyDebuff's own latest-wins write.
  enemies.vulnT[centre] = 2;
  enemies.vulnAmt[centre] = 0.5;
  enemies.applyVuln({ x: 0, z: 0 }, 0, 3.5, 0.25, 3);
  assert.equal(enemies.vulnAmt[centre], 0.5, 'applyVuln: a weaker application never downgrades a live stronger vuln');
  assert.equal(enemies.vulnT[centre], 2, "applyVuln: nor does it touch the stronger vuln's own timer");

  enemies.vulnT[centre] = 1;
  enemies.vulnAmt[centre] = 0.25;
  enemies.applyVuln({ x: 0, z: 0 }, 0, 3.5, 0.25, 3);
  assert.equal(enemies.vulnT[centre], 3, 'applyVuln: equal strength refreshes the timer (the per-tick re-application)');

  // Reviewer catch: vulnAmt is a Float32Array, the caller's amt a double —
  // a non-binary-exact magnitude (0.3 → fround 0.30000001…) would read as
  // "stronger than itself" and silently stop refreshing. applyVuln frounds
  // at the door so same-source re-application always compares equal.
  enemies.vulnT[centre] = 1;
  enemies.vulnAmt[centre] = Math.fround(0.3);
  enemies.applyVuln({ x: 0, z: 0 }, 0, 3.5, 0.3, 3);
  assert.equal(enemies.vulnT[centre], 3, 'applyVuln: a float32-stored equal strength still refreshes (fround at the door)');

  enemies.vulnT[centre] = 2;
  enemies.vulnAmt[centre] = Math.fround(0.15);
  enemies.applyVuln({ x: 0, z: 0 }, 0, 3.5, 0.25, 3);
  assert.equal(enemies.vulnAmt[centre], 0.25, 'applyVuln: a stronger application overwrites a live weaker vuln');
  assert.equal(enemies.vulnT[centre], 3, 'applyVuln: and takes its own timer with it');

  // An EXPIRED strong amount is stale data, not a live vuln — the timer is
  // the liveness signal (tick() only ever clamps vulnT, never clears vulnAmt).
  enemies.vulnT[centre] = 0;
  enemies.vulnAmt[centre] = 0.9;
  enemies.applyVuln({ x: 0, z: 0 }, 0, 3.5, 0.25, 3);
  assert.equal(enemies.vulnAmt[centre], 0.25, 'applyVuln: an expired amount cannot block a fresh application');
  assert.equal(enemies.vulnT[centre], 3, 'applyVuln: the fresh application arms the timer');

  // Against the REAL debuff channel: 熔甲 (a fire overcoming hit) writes
  // vulnStrong — the generic 0.15 vuln applied on top must not shave it.
  {
    const real = new EnemySystem(createRng(33));
    const metal = real.spawnAt(0, 0, 0, 0); // 金 target — 火克金
    real.damage({ x: 0, z: 0 }, 1, 1, 3); // fire hit → overcoming → vulnStrong
    assert.equal(real.vulnAmt[metal], settings.combat.debuffs.vulnStrong.amount, 'fixture: 熔甲 landed');
    real.applyVuln({ x: 0, z: 0 }, 0, 3.5, settings.combat.debuffs.vuln.amount, 3);
    assert.equal(
      real.vulnAmt[metal],
      settings.combat.debuffs.vulnStrong.amount,
      'applyVuln: the weaker generic vuln never downgrades a live 熔甲'
    );
  }

  // The channel it writes is the one every hit already amplifies through.
  {
    const amp = new EnemySystem(createRng(34));
    const e = amp.spawnAt(0, 0, 0, 3); // 火 body — neutral to an untyped hit
    amp.applyVuln({ x: 0, z: 0 }, 0, 3.5, 0.25, 3);
    const before = amp.hp[e];
    amp.damage({ x: 0, z: 0 }, 1, 10, -1);
    assert.ok(
      Math.abs(before - amp.hp[e] - 10 * 1.25) < 1e-3,
      'applyVuln: the vuln it applies amplifies a later untyped hit ×1.25'
    );
  }

  // Targets facade: optional-chain passthrough — a population without
  // applyVuln (the sandbox dummies) degrades to a quiet no-op, one with it
  // receives the arguments verbatim.
  {
    const targets = new Targets();
    targets.register({ hits: () => false, damage: () => 0 });
    assert.doesNotThrow(
      () => targets.applyVuln({ x: 0, z: 0 }, 0, 3.5, 0.25, 3),
      'Targets.applyVuln: a population without the method quietly degrades'
    );
    const got = [];
    targets.register({
      hits: () => false,
      damage: () => 0,
      applyVuln: (p, inner, outer, amt, time) => got.push({ x: p.x, inner, outer, amt, time })
    });
    targets.applyVuln({ x: 7, z: 0 }, 0.5, 3.5, 0.25, 3);
    assert.deepEqual(got, [{ x: 7, inner: 0.5, outer: 3.5, amt: 0.25, time: 3 }], 'Targets.applyVuln: arguments pass through verbatim');
  }

  console.log('ok  M7 T4: EnemySystem.applyVuln (solid disc/annulus pad/弱不降级强/amplify/Targets passthrough)');
}

/* ---- M7 T4: aura kind — vuln row fields, solid-disc degenerate, fade gate ---- */
{
  const row = settings.combat.fusions['4+0'];
  assert.equal(row.kind, 'aura', "fixture: '4+0' rides the existing aura kind — 静置 needs no new CombatSystem kind");
  assert.equal(row.band, row.radius, 'fixture: band === radius is the solid-disc degenerate the plan pins');
  assert.equal(row.dps, 85, "fixture: 数值表's own dps");
  assert.equal(row.vulnAmt, 0.25, "fixture: 数值表's own vulnAmt");
  assert.equal(row.vulnTime, 3, "fixture: 数值表's own vulnTime");

  const ringCalls = [];
  const vulnCalls = [];
  const combat = new CombatSystem({
    damage: () => 0,
    damageOnce: () => 0,
    slow: () => {},
    damageRing: (p, inner, outer, amt, wux, wuxB) => (ringCalls.push({ x: p.x, z: p.z, inner, outer, amt, wux, wuxB }), 1),
    applyVuln: (p, inner, outer, amt, time) => vulnCalls.push({ x: p.x, z: p.z, inner, outer, amt, time })
  });
  const prism = {
    element: fusionId('rockspikes', 'dashstrike'), // 土(4)+金(0) → '4+0'
    phase: 'impact', impactTime: 0.5, fadeTime: 0,
    position: { x: 4, z: -2 }, origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 }, length: 9, u: 1,
    autocast: false, quenched: false, fusionMult: 1
  };
  combat.tick(1 / 60, [prism]);
  assert.equal(ringCalls.length, 1, 'aura: one grind tick per frame');
  assert.equal(ringCalls[0].inner, 0, 'aura: band === radius degenerates damageRing to a solid disc (inner edge 0)');
  assert.ok(Math.abs(ringCalls[0].outer - row.radius) < 1e-9, 'aura: outer edge is the combat radius');
  assert.ok(Math.abs(ringCalls[0].amt - row.dps / 60) < 1e-9, 'aura: per-tick amount is dps×step');
  assert.equal(ringCalls[0].wux, 0, "aura: '4+0' grinds as wux = 子系 金 (0)");
  assert.equal(ringCalls[0].wuxB, 4, 'aura: with wuxB = 母系 土 (4)');
  assert.equal(vulnCalls.length, 1, 'aura: a row with vulnAmt applies vuln on the same tick');
  assert.deepEqual(
    vulnCalls[0],
    { x: 4, z: -2, inner: 0, outer: row.radius, amt: row.vulnAmt, time: row.vulnTime },
    "aura: vuln covers the same solid disc with the row's own amount/time"
  );

  combat.tick(1 / 60, [prism]);
  assert.equal(vulnCalls.length, 2, 'aura: vuln re-applies every tick — 阵内敌持续破甲');

  // The grind window is travel+impact only. A permanent aura (bladeorbit)
  // lives in TRAVEL forever and never fades, so excluding FADE changes
  // nothing for it — but a TIMED aura cast's cosmetic sink tail must not
  // keep grinding past its own 3s window (数值表: dps 85 × 3s).
  prism.phase = 'travel';
  combat.tick(1 / 60, [prism]);
  assert.equal(ringCalls.length, 3, 'aura: TRAVEL still ticks (the permanent-aura contract, unchanged)');
  prism.phase = 'fade';
  prism.fadeTime = 0.1;
  combat.tick(1 / 60, [prism]);
  assert.equal(ringCalls.length, 3, 'aura: FADE deals nothing — the grind stops at the 3s window');
  assert.equal(vulnCalls.length, 3, 'aura: FADE applies no vuln either');

  // A vuln-free aura row (bladeorbit) must never reach applyVuln at all.
  const bladeorbit = {
    element: 'bladeorbit', phase: 'travel', age: 1,
    position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 }, length: 1, u: 0,
    autocast: false, quenched: false, fusionMult: 1
  };
  combat.tick(1 / 60, [bladeorbit]);
  assert.equal(vulnCalls.length, 3, 'aura: a row without vulnAmt applies no vuln (bladeorbit regression)');

  // Reviewer catch: with _amp ≡ 1 the "vuln is never damage-amped" claim was
  // indistinguishable from `vulnAmt × _amp`. A ×2 fusionMult cast must
  // double the grind tick and leave the vuln magnitude at the row's own
  // flat value (a debuff is settings-driven, same as _applyDebuff's).
  prism.phase = 'impact';
  prism.fusionMult = 2;
  {
    const rings = ringCalls.length;
    combat.tick(1 / 60, [prism]);
    assert.equal(ringCalls.length, rings + 1, 'aura: amp fixture ticked once');
    assert.ok(Math.abs(ringCalls[ringCalls.length - 1].amt - (row.dps / 60) * 2) < 1e-9, 'aura: fusionMult ×2 doubles the grind tick');
    assert.equal(vulnCalls[vulnCalls.length - 1].amt, row.vulnAmt, 'aura: the vuln magnitude stays the flat row value under amp');
  }
  prism.fusionMult = 1;

  // 研磨不推 (browser-verification catch): the row's kbMult 0 suppresses the
  // baseline per-hit knockback on the grind tick. At 60 ticks/s the baseline
  // impulse stream launched a converging enemy ~7m out of the disc in the
  // first half-second and rim-juggled it after — 19/180 ticks in-disc, 33
  // damage where the 数值表 budgets ≈319 (headless repro). A grind holds its
  // prey; rows that don't opt out (bladeorbit's blade-wall shove) keep the
  // baseline exactly as shipped.
  assert.equal(settings.combat.fusions['4+0'].kbMult, 0, "fixture: '4+0' opts out of baseline knockback");
  {
    const kbEnemies = new EnemySystem(createRng(36));
    const kbCombat = new CombatSystem(kbEnemies);
    // OFF the disc centre on purpose (re-review catch): at the centre
    // dx=dz=0 zeroes the shove regardless of wiring, making the assertion
    // vacuous — 1m out, a broken kbMult thread (`|| 1`, a dropped Targets
    // arg) shoves kbX≈8 and fails loudly, while the correct wiring reads 0.
    const held = kbEnemies.spawnAt(5, -2, 0, 3);
    const heldHp = kbEnemies.hp[held];
    prism.phase = 'impact';
    kbCombat.tick(1 / 60, [prism]);
    kbCombat.tick(1 / 60, [prism]);
    assert.equal(kbEnemies.kbX[held], 0, 'aura: kbMult 0 — the grind tick imparts no baseline shove (x)');
    assert.equal(kbEnemies.kbZ[held], 0, 'aura: kbMult 0 — the grind tick imparts no baseline shove (z)');
    assert.ok(kbEnemies.hp[held] < heldHp && kbEnemies.vulnT[held] > 0, 'aura: damage and vuln still land with the shove off');

    // The default is byte-identical: a ring hit with no kbScale argument (or
    // a row without kbMult — bladeorbit) still shoves, same as before.
    const ring = kbEnemies.spawnAt(20, 0, 0, 3);
    kbEnemies.damageRing({ x: 19, z: 0 }, 0, 2, 1, -1);
    assert.ok(kbEnemies.kbX[ring] > 0, 'damageRing: default kbScale keeps the baseline shove (regression)');
    const scaled = kbEnemies.spawnAt(30, 0, 0, 3);
    kbEnemies.damageRing({ x: 29, z: 0 }, 0, 2, 1, -1, -1, 0);
    assert.equal(kbEnemies.kbX[scaled], 0, 'damageRing: kbScale 0 suppresses the baseline shove');
  }

  // End-to-end against a real EnemySystem: the first grind tick lands
  // un-amplified (damage first, vuln second — a tick never amplifies itself
  // with the vuln it just applied), every later tick self-amplifies ×1.25
  // (the plan's own budget line counts this), and an outside hit profits too.
  {
    const enemies = new EnemySystem(createRng(35));
    const live = new CombatSystem(enemies);
    const e = enemies.spawnAt(4, -2, 0, 3); // 火 body: max(金 0.8被克, 土 1中性) = ×1 — clean baseline
    prism.phase = 'impact';
    const hp0 = enemies.hp[e];
    live.tick(1 / 60, [prism]);
    const first = hp0 - enemies.hp[e];
    assert.ok(Math.abs(first - row.dps / 60) < 1e-3, 'aura end-to-end: the first grind tick is un-amplified (vuln lands after damage)');
    assert.equal(enemies.vulnT[e], row.vulnTime, 'aura end-to-end: that same tick left vuln standing');
    const hp1 = enemies.hp[e];
    live.tick(1 / 60, [prism]);
    const second = hp1 - enemies.hp[e];
    assert.ok(
      Math.abs(second - (row.dps / 60) * (1 + row.vulnAmt)) < 1e-3,
      'aura end-to-end: the second tick self-amplifies ×1.25 (破甲放大一切来源, the array included)'
    );
    const hp2 = enemies.hp[e];
    enemies.damage({ x: 4, z: -2 }, 1, 10, -1);
    assert.ok(
      Math.abs(hp2 - enemies.hp[e] - 10 * (1 + row.vulnAmt)) < 1e-3,
      'aura end-to-end: an outside untyped hit is amplified ×1.25 — 破甲+暴击 in one channel'
    );
  }

  console.log('ok  M7 T4: aura vuln fields, solid disc, fade gate, dual-wux threading');
}

/* ---- M7 T4: rowFor resolves the aura-row fusion; settings.combat stays clean ---- */
{
  // App's 装备即常驻 refusal gate (`settings.combat[element]?.kind === 'aura'`)
  // reads the FLAT table — a fusion id must never grow a row there, or the
  // gate would wrongly refuse the '4+0' cast the way it refuses a seat-key
  // press on bladeorbit. rowFor is the one door a fusion row resolves
  // through; this pins the split so a future "flatten the fusion rows into
  // settings.combat" refactor fails loudly instead of silently bricking the cast.
  const id = fusionId('rockspikes', 'dashstrike');
  assert.equal(rowFor(id), settings.combat.fusions['4+0'], "rowFor: '4+0' fusion id resolves to the aura combat row");
  assert.equal(rowFor(id).kind, 'aura', 'rowFor: and that row really is aura-kind');
  assert.equal(settings.combat[id], undefined, 'settings.combat: a fusion id has NO flat row — the aura refusal gate must not see one');
  console.log('ok  M7 T4: rowFor/settings.combat split keeps the aura refusal gate blind to fusions');
}

/* ---- M7 T4: PrismArraySkill (锋岩星阵) — headless lifecycle against the real class ---- */
{
  assert.equal(FUSION_CLASSES['4+0'], PrismArraySkill, "AbilityManager: '4+0' resolves to PrismArraySkill");

  const cfg = settings.fusions['4+0'];
  assert.equal(cfg.life, 3, "settings.fusions['4+0']: the grind window is the 数值表's own 3s");
  assert.equal(cfg.prismCount, 5, "settings.fusions['4+0']: five prisms (计划: 5 根金棱晶)");
  for (const key of ['lightColor', 'lightIntensity', 'lightRadius']) {
    assert.ok(cfg[key] !== undefined, `settings.fusions['4+0']: ${key} present (M6 T5/T6 NaN-poison guard — _updateLight reads it unconditionally)`);
  }

  let lightsAcquired = 0;
  let lightsReleased = 0;
  const fakeLights = {
    acquire: () => (lightsAcquired++, { n: lightsAcquired }),
    release: (h) => { if (h) lightsReleased++; },
    set: () => {}
  };
  const decalSpawns = [];
  const ctx = {
    lights: fakeLights,
    decals: { spawn: (type, pos, opts) => (decalSpawns.push({ type, x: pos.x, z: pos.z, opts }), { mesh: { scale: { setScalar: () => {} } }, material: { uniforms: { uColorA: { value: { lerpColors: () => {} } } } } }) },
    particles: {
      get: () => ({
        uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
        setGradient() {},
        emit() {}
      })
    },
    mods: null
  };

  const ability = new PrismArraySkill(ctx, fusionId('rockspikes', 'dashstrike'));
  ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
  ability.autocast = false;
  ability.fusionMult = 1;
  ability.quenched = false;

  // Parked at the aimed point BEFORE the first update: combat.tick runs
  // ahead of abilities.update in the frame, so a manual cast IS observed in
  // TRAVEL once — the disc must already sit at the target, not the caster.
  assert.ok(
    Math.abs(ability.position.x - 9) < 1e-6 && Math.abs(ability.position.z - 0) < 1e-6,
    'PrismArray: position parks at the aimed point at spawn, before any update'
  );

  ability.update(1 / 60);
  assert.equal(ability.phase, 'impact', 'PrismArray: reaches IMPACT on the very first tick (no travel)');
  assert.equal(ability.impactDuration, cfg.life, "PrismArray: the impact window IS the row's own 3s life");
  assert.equal(ability._prisms.length, cfg.prismCount, 'PrismArray: five prisms stand the array');
  assert.ok(ability._prisms.every((p) => p.visible), 'PrismArray: every prism is up during the grind');

  // 静置: the array NEVER follows the player — position stays put through
  // the whole grind (the aura case reads it every tick).
  for (let i = 0; i < 60; i++) ability.update(1 / 60);
  assert.ok(
    Math.abs(ability.position.x - 9) < 1e-6 && Math.abs(ability.position.z - 0) < 1e-6,
    'PrismArray: 静置 — ability.position never moves during the grind'
  );
  assert.ok(ability._prisms.every((p) => p.visible), 'PrismArray: the full array stands once every prism has risen');

  // Run the clock out: 3s impact + fade tail → DONE, prisms recycled.
  while (!ability.isFinished) ability.update(0.1);
  ability.destroy();
  assert.ok(ability._prisms.every((p) => !p.visible), 'PrismArray: prisms hidden once the cast retires');
  assert.equal(lightsReleased, lightsAcquired, 'PrismArray: every acquired light came back to the pool');

  // Pooled reuse: a second cast off the same instance stands the array again.
  ability.spawn({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 5);
  ability.update(1 / 60);
  assert.equal(ability.phase, 'impact', 'PrismArray: a pooled re-cast reaches IMPACT again');
  assert.ok(
    Math.abs(ability.position.x - 0) < 1e-6 && Math.abs(ability.position.z - 5) < 1e-6,
    'PrismArray: the re-cast parks at its own new aimed point'
  );
  assert.ok(ability._prisms.every((p) => p.visible), 'PrismArray: prisms stand again on the re-cast');
  ability.destroy();

  console.log('ok  M7 T4: PrismArraySkill lifecycle (park/static/3s window/prism recycle), headless');
}

/* ---- M7 T5: BladeTideSkill (霜刃洪流) — headless lifecycle against the real horde ---- */
{
  assert.equal(FUSION_CLASSES['0+2'], BladeTideSkill, "AbilityManager: '0+2' resolves to BladeTideSkill");

  const cfg = settings.fusions['0+2'];
  assert.equal(cfg.width, 1.6, "settings.fusions['0+2']: 数值表 width");
  assert.equal(cfg.outDamage, 85, "settings.fusions['0+2']: 去程 85");
  assert.equal(cfg.backDamage, 125, "settings.fusions['0+2']: 回程 125");
  assert.equal(cfg.backSlowedMult, 2, "settings.fusions['0+2']: slowed 回程 ×2 (必暴 250)");
  assert.equal(cfg.outTime, 0.5, "settings.fusions['0+2']: 去程 0.5s");
  assert.equal(cfg.hoverTime, 0.2, "settings.fusions['0+2']: 悬停 0.2s");
  assert.equal(cfg.backTime, 0.5, "settings.fusions['0+2']: 回程 0.5s");
  for (const key of ['lightColor', 'lightIntensity', 'lightRadius']) {
    assert.ok(cfg[key] !== undefined, `settings.fusions['0+2']: ${key} present (NaN-poison guard)`);
  }

  const enemies = new EnemySystem(createRng(41));
  const burstCalls = [];
  const ctx = {
    targets: enemies, // duck-typed: damageOnce is all the tide needs
    enemies,
    stats: { book: () => {} },
    lights: { acquire: () => null, release: () => {}, set: () => {} },
    bursts: { spawn: (mode) => burstCalls.push(mode) },
    particles: {
      get: () => ({
        uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
        setGradient() {},
        emit() {}
      })
    },
    mods: null
  };

  // Water (元素 2) bodies: neutral to BOTH the tide's candidates (子 2 水 is
  // its own element — no self-overcome; 母 0 金: BEATS[0]=1 ≠ 2, BEATS[2]=3
  // ≠ 0) — every landed amount below asserts EXACT (×1 matchup).
  const e1 = enemies.spawnAt(2.7, 0, 0, 2); // on the line, unslowed
  const e2 = enemies.spawnAt(5.4, 0, 0, 2); // on the line, SLOWED — the crit target
  const e3 = enemies.spawnAt(4.5, 2.5, 0, 2); // 2.5m lateral: past width+pad, never touched
  const e4 = enemies.spawnAt(6.3, 1.9, 0, 2); // 1.9m lateral: outside the nominal 1.6 width, inside via its own 0.45 body pad
  for (const i of [e1, e2, e3, e4]) enemies.hp[i] = 5000;
  enemies.slowed[e2] = 0.4;
  enemies.slowT[e2] = 9;
  const hp0 = [enemies.hp[e1], enemies.hp[e2], enemies.hp[e3], enemies.hp[e4]];

  const ability = new BladeTideSkill(ctx, fusionId('dashstrike', 'iceshield')); // 金(0)+水(2) → '0+2'
  ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
  ability.autocast = false;
  ability.fusionMult = 1;
  ability.quenched = false;

  ability.update(1 / 60);
  assert.equal(ability.phase, 'impact', 'BladeTide: reaches IMPACT on the very first tick (the class owns its own timeline)');
  assert.ok(
    Math.abs(ability.impactDuration - (cfg.outTime + cfg.hoverTime + cfg.backTime)) < 1e-9,
    'BladeTide: impact window = out + hover + back'
  );

  // ---- 去程: 0.533s in, the outbound sweep is complete ----
  for (let i = 0; i < 32; i++) ability.update(1 / 60);
  assert.ok(Math.abs(hp0[0] - enemies.hp[e1] - cfg.outDamage) < 1e-3, '去程: on-line enemy takes exactly one 85 (damageOnce dedup across overlapping samples)');
  assert.ok(Math.abs(hp0[1] - enemies.hp[e2] - cfg.outDamage) < 1e-3, '去程: the slowed enemy takes the same flat 85 outbound');
  assert.equal(enemies.hp[e3], hp0[2], '去程: past the band takes nothing');
  assert.ok(Math.abs(hp0[3] - enemies.hp[e4] - cfg.outDamage) < 1e-3, '去程: inside the band via body pad takes one 85');

  // ---- 悬停: no damage moves ----
  const hover = [enemies.hp[e1], enemies.hp[e2], enemies.hp[e4]];
  for (let i = 0; i < 8; i++) ability.update(1 / 60); // ≈0.533 → 0.667, still hovering
  assert.deepEqual([enemies.hp[e1], enemies.hp[e2], enemies.hp[e4]], hover, '悬停: the 0.2s hold deals nothing');

  // ---- 回程: slowed ×2 (必暴 250), everyone else 125, each exactly once ----
  for (let i = 0; i < 40; i++) ability.update(1 / 60); // → ≈1.33s, back sweep complete
  assert.ok(
    Math.abs(hp0[1] - enemies.hp[e2] - cfg.outDamage - cfg.backDamage * cfg.backSlowedMult) < 1e-3,
    '回程: the slowed enemy eats 250 — 必暴 (out 85 + back 250 total)'
  );
  assert.ok(
    Math.abs(hp0[0] - enemies.hp[e1] - cfg.outDamage - cfg.backDamage) < 1e-3,
    '回程: an unslowed enemy eats 125 (out 85 + back 125 — two casts of the same tide, two ids)'
  );
  assert.ok(
    Math.abs(hp0[3] - enemies.hp[e4] - cfg.outDamage - cfg.backDamage) < 1e-3,
    '回程: the band-pad enemy eats its own 125 exactly once'
  );
  assert.equal(enemies.hp[e3], hp0[2], '回程: past the band still takes nothing');
  assert.ok(burstCalls.length > 0, '回程: the slowed crit pops an ice flower (bursts.spawn fired)');

  // ---- cleanup: both cast ids leave _hitMemory with the cast ----
  assert.ok(enemies._hitMemory.size >= 2, 'BladeTide: two live dedup sets while the cast runs (out id + back id)');
  while (!ability.isFinished) ability.update(0.1);
  ability.destroy();
  assert.equal(enemies._hitMemory.size, 0, 'BladeTide: destroy releases BOTH cast ids — no _hitMemory leak');

  // ---- pooled re-cast, quenched: every landed amount ×1.5 ----
  const q = enemies.spawnAt(3.6, 0, 0, 2);
  enemies.hp[q] = 5000;
  const qhp = enemies.hp[q];
  ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
  ability.autocast = false;
  ability.fusionMult = 1;
  ability.quenched = true;
  for (let i = 0; i < 90; i++) ability.update(1 / 60);
  assert.ok(
    Math.abs(qhp - enemies.hp[q] - (cfg.outDamage + cfg.backDamage) * 1.5) < 1e-3,
    'BladeTide: a quenched re-cast lands (85+125)×1.5 on a fresh unslowed enemy'
  );
  ability.destroy();

  // Hugging-pair cross-frame corner (review fix round): a SLOWED body one
  // frame window down-line of a plain one, inside point-splash reach
  // (<0.5m). Without the slowed pass's window lookahead, the plain body's
  // 125 splash claims the slowed one a frame early and it is UNDER-paid its
  // crit. The pin: the slowed body lands exactly 85+250; the plain hugger
  // may legitimately be OVER-paid by the crit's own splash (allowed error
  // direction) so it only pins a floor.
  {
    const hug = new EnemySystem(createRng(43));
    const hugCtx = { ...ctx, targets: hug, enemies: hug };
    const uPlain = hug.spawnAt(5.0, 0, 0, 2);
    const sSlow = hug.spawnAt(4.7, 0.25, 0, 2); // 0.39m from the plain body — inside splash reach
    hug.hp[uPlain] = 5000;
    hug.hp[sSlow] = 5000;
    hug.slowed[sSlow] = 0.4;
    hug.slowT[sSlow] = 9;
    const tide = new BladeTideSkill(hugCtx, fusionId('dashstrike', 'iceshield'));
    tide.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
    tide.autocast = false;
    tide.fusionMult = 1;
    tide.quenched = false;
    for (let i = 0; i < 90; i++) tide.update(1 / 60);
    tide.destroy();
    assert.ok(
      Math.abs(5000 - hug.hp[sSlow] - (cfg.outDamage + cfg.backDamage * cfg.backSlowedMult)) < 1e-3,
      'BladeTide: a slowed body hugging a plain one is NEVER under-paid its 250 (slowed-pass window lookahead)'
    );
    assert.ok(
      5000 - hug.hp[uPlain] >= cfg.outDamage + cfg.backDamage - 1e-3,
      'BladeTide: the plain hugger gets at least its own 85+125 (over-pay via crit splash is the allowed direction)'
    );
  }

  console.log('ok  M7 T5: BladeTideSkill lifecycle (out dedup/hover/back crit/double id/release/quench/hug corner), headless');
}

/* ---- M7 T5: wux threading — 子2水 + 母0金 (f901b73 convention; the plan
   body's own (子0, 母2) line was the backwards twin it already fixed once) ---- */
{
  const calls = [];
  const fakeTargets = {
    damageOnce: (castId, p, r, amt, wux, wuxB) => (calls.push({ amt, wux, wuxB }), 0)
  };
  const enemies = new EnemySystem(createRng(42));
  enemies.spawnAt(4, 0, 0, 2); // one body on the line so the back sweep judges someone
  const ctx = {
    targets: fakeTargets,
    enemies,
    stats: { book: () => {} },
    lights: { acquire: () => null, release: () => {}, set: () => {} },
    particles: {
      get: () => ({
        uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
        setGradient() {},
        emit() {}
      })
    },
    mods: null
  };
  const ability = new BladeTideSkill(ctx, fusionId('dashstrike', 'iceshield'));
  ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
  ability.autocast = false;
  ability.fusionMult = 1;
  ability.quenched = false;
  for (let i = 0; i < 90; i++) ability.update(1 / 60);
  ability.destroy();
  assert.ok(calls.length > 0, 'BladeTide: the tide actually swept the fake targets');
  assert.ok(
    calls.every((c) => c.wux === 2 && c.wuxB === 0),
    'BladeTide: every hit carries wux=2 (子 water), wuxB=0 (母 metal) — pairKeyOf 母+子 order, NOT the plan body\'s backwards line'
  );
  // Both programs explicitly ran (review catch: every() alone is vacuously
  // green if a broken gate silently skips one whole sweep).
  const cfgT5 = settings.fusions['0+2'];
  assert.ok(calls.some((c) => Math.abs(c.amt - cfgT5.outDamage) < 1e-9), 'BladeTide: the OUT sweep is represented in the recorded calls (85s present)');
  assert.ok(calls.some((c) => Math.abs(c.amt - cfgT5.backDamage) < 1e-9), 'BladeTide: the BACK sweep is represented in the recorded calls (125s present)');
  console.log('ok  M7 T5: BladeTide wux threading (子2水/母0金)');
}

/* ---- M7 T5: BladeTideSkill sandbox null-safety — VFX only, zero errors ---- */
{
  const ctx = {
    lights: { acquire: () => null, release: () => {}, set: () => {} },
    particles: {
      get: () => ({
        uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
        setGradient() {},
        emit() {}
      })
    }
    // no targets, no enemies, no stats, no bursts, no camera — the sandbox
    // shape (fusions unreachable there; the class must tick pure-VFX without
    // throwing, and the back sweep must skip its slowed reads entirely).
  };
  const ability = new BladeTideSkill(ctx, fusionId('dashstrike', 'iceshield'));
  ability.autocast = false;
  ability.fusionMult = 1;
  ability.quenched = false;
  assert.doesNotThrow(() => ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9), 'BladeTide: spawn is null-safe');
  assert.doesNotThrow(() => {
    for (let i = 0; i < 500; i++) ability.update(1 / 60);
  }, 'BladeTide: a full cast ticks with no targets/enemies/camera and never throws');
  assert.doesNotThrow(() => ability.destroy(), 'BladeTide: destroy is null-safe');
  console.log('ok  M7 T5: BladeTideSkill sandbox null-safety (VFX only, zero errors)');
}

/* ---- M7 T6: CombatSystem marsh kind — slow refresh + healInside routing ---- */
{
  const row = settings.combat.fusions['2+1'];
  assert.equal(row.kind, 'marsh', "fixture: '2+1' is the marsh row");
  assert.equal(row.radius, 3.5, "fixture: 数值表 radius");
  assert.equal(row.slowFactor, 0.45, "fixture: 数值表 slowFactor");
  assert.equal(row.healInside, 6, "fixture: 数值表 healInside 6/s");

  const slows = [];
  const combat = new CombatSystem({
    damage: () => 0, damageOnce: () => 0, damageRing: () => 0,
    slow: (p, r, f, d) => slows.push({ x: p.x, z: p.z, r, f, d })
  });
  const marsh = {
    element: fusionId('iceshield', 'thunder'), // 水(2)+木(1) → '2+1'
    phase: 'impact', impactTime: 0.5, fadeTime: 0,
    position: { x: 4, z: -2 }, origin: { x: 0, z: 0 },
    direction: { x: 1, z: 0 }, length: 9, u: 1,
    autocast: false, quenched: false, fusionMult: 1
  };

  // Legacy 2-arg call (every pre-T6 caller): still ticks the slow, reports
  // no heal, throws nothing — playerPos defaults null.
  let due = combat.tick(1 / 60, [marsh]);
  assert.equal(slows.length, 1, 'marsh: one slow refresh per tick');
  assert.deepEqual(slows[0], { x: 4, z: -2, r: row.radius, f: row.slowFactor, d: 0.5 },
    'marsh: slow covers the pool at the row factor for the 0.5s refresh window');
  assert.equal(due, 0, 'marsh: no player position, no heal — legacy callers unchanged');

  // Player inside: healDue = healInside × step (amp 1); outside: 0.
  due = combat.tick(1 / 60, [marsh], { x: 4.5, z: -2 });
  assert.ok(Math.abs(due - row.healInside / 60) < 1e-9, 'marsh: player inside the pool banks healInside×step');
  due = combat.tick(1 / 60, [marsh], { x: 40, z: 0 });
  assert.equal(due, 0, 'marsh: player outside the pool banks nothing');

  // Amp rides the heal the same way lifebloom's healPlayer does.
  marsh.fusionMult = 2;
  due = combat.tick(1 / 60, [marsh], { x: 4.5, z: -2 });
  assert.ok(Math.abs(due - (row.healInside * 2) / 60) < 1e-9, 'marsh: the heal is amped (fusionMult ×2 doubles it)');
  marsh.fusionMult = 1;

  // Timed window: FADE neither slows nor heals (T4's aura rule, same shape).
  const slowsBefore = slows.length;
  marsh.phase = 'fade';
  marsh.fadeTime = 0.1;
  due = combat.tick(1 / 60, [marsh], { x: 4.5, z: -2 });
  assert.equal(slows.length, slowsBefore, 'marsh: FADE refreshes no slow');
  assert.equal(due, 0, 'marsh: FADE banks no heal');
  marsh.phase = 'impact';

  // Against the real horde: enemies inside the pool actually slow down.
  {
    const enemies = new EnemySystem(createRng(51));
    const live = new CombatSystem(enemies);
    const inside = enemies.spawnAt(4, -2, 0, 1);
    const outside = enemies.spawnAt(20, 0, 0, 1);
    live.tick(1 / 60, [marsh]);
    assert.ok(enemies.slowed[inside] > 0, 'marsh: an enemy in the pool is slowed');
    assert.equal(enemies.slowed[outside], 0, 'marsh: an enemy outside is not');
  }

  console.log('ok  M7 T6: CombatSystem marsh kind (slow refresh/healInside/amp/fade gate/legacy call)');
}

/* ---- M7 T6: RunManager threads the player position into combat.tick ---- */
{
  const seen = [];
  const run = new RunManager({
    enemies: new EnemySystem(createRng(52)), pickups: new PickupSystem(), player: new PlayerState(), rng: createRng(52),
    modifiers: new Modifiers(), tides: new TideSchedule(createRng(52)), projectiles: new EnemyProjectiles(),
    combat: { tick: (step, active, playerPos) => (seen.push(playerPos), 0), release: () => -1, resetStats: () => {}, book: () => {} },
    targets: { register: () => {} },
    abilities: { active: [], onRetire: null }
  });
  run.start();
  const pos = { x: 7, z: -3 };
  run.tick(1 / 60, pos);
  assert.ok(seen.length > 0 && seen[seen.length - 1] === pos,
    'RunManager: combat.tick receives the very playerPos object the run tick was driven with');
  console.log('ok  M7 T6: RunManager passes playerPos to combat.tick');
}

/* ---- M7 T6: ThunderMarshSkill (回春雷泽) — headless lifecycle ---- */
{
  assert.equal(FUSION_CLASSES['2+1'], ThunderMarshSkill, "AbilityManager: '2+1' resolves to ThunderMarshSkill");

  const cfg = settings.fusions['2+1'];
  assert.equal(cfg.life, 4, "settings.fusions['2+1']: 沼泽 4s");
  assert.equal(cfg.boltEvery, 0.8, "settings.fusions['2+1']: 落雷每 0.8s 一道");
  assert.equal(cfg.boltDamage, 20, "settings.fusions['2+1']: 首击 20");
  assert.equal(cfg.boltDecay, 0.85, "settings.fusions['2+1']: 跳衰 ×0.85");
  assert.equal(cfg.boltHits, 3, "settings.fusions['2+1']: 每道 3 击 — 数值表锚 5道×51=255 (20+17+14.45), 计划正文'3 跳'按锚裁定为总击数");
  assert.equal(cfg.hopRadius, 6, "settings.fusions['2+1']: 跳距 6");
  for (const key of ['lightColor', 'lightIntensity', 'lightRadius']) {
    assert.ok(cfg[key] !== undefined, `settings.fusions['2+1']: ${key} present (NaN-poison guard)`);
  }

  const enemies = new EnemySystem(createRng(53));
  const ctx = {
    targets: enemies,
    enemies,
    stats: { book: () => {} },
    lights: { acquire: () => null, release: () => {}, set: () => {} },
    particles: {
      get: () => ({
        uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
        setGradient() {},
        emit() {}
      })
    },
    decals: { spawn: () => ({ mesh: { scale: { setScalar: () => {} } }, material: { uniforms: { uColorA: { value: { lerpColors: () => {} } } } } }) },
    bursts: { spawn: () => {} },
    mods: null
  };

  // 木 (1) bodies: neutral to BOTH candidates (子 1 self; 母 2: BEATS[2]=3≠1,
  // BEATS[1]=4≠2) — exact amounts. A tight cluster inside the pool, one far
  // body outside pool AND hop range.
  const a = enemies.spawnAt(9, 0, 0, 1);
  const b = enemies.spawnAt(10.2, 0.6, 0, 1);
  const c2 = enemies.spawnAt(8.2, -0.9, 0, 1);
  const far = enemies.spawnAt(30, 0, 0, 1);
  for (const i of [a, b, c2, far]) enemies.hp[i] = 5000;

  const ability = new ThunderMarshSkill(ctx, fusionId('iceshield', 'thunder'));
  ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
  ability.autocast = false;
  ability.fusionMult = 1;
  ability.quenched = false;

  ability.update(1 / 60);
  assert.equal(ability.phase, 'impact', 'Marsh: reaches IMPACT on the very first tick');
  assert.ok(
    Math.abs(ability.position.x - 9) < 1e-6 && Math.abs(ability.position.z) < 1e-6,
    'Marsh: position parks at the aimed point at spawn (the marsh row reads it every combat tick)'
  );
  assert.equal(ability.impactDuration, cfg.life, "Marsh: the impact window IS the row's own 4s");

  const clusterHp = () => 15000 - enemies.hp[a] - enemies.hp[b] - enemies.hp[c2];
  const perBolt = cfg.boltDamage * (1 + cfg.boltDecay + cfg.boltDecay * cfg.boltDecay); // 51.45

  // First bolt lands once impactTime crosses 0.8 — not before.
  for (let i = 0; i < 40; i++) ability.update(1 / 60); // ≈0.667
  assert.equal(clusterHp(), 0, 'Marsh: no bolt before the first 0.8s boundary');
  for (let i = 0; i < 12; i++) ability.update(1 / 60); // ≈0.867
  assert.ok(Math.abs(clusterHp() - perBolt) < 1e-2, `Marsh: the first bolt lands 20+17+14.45 across the cluster (got ${clusterHp().toFixed(2)})`);

  // Run the pool out: 5 bolts total (0.8/1.6/2.4/3.2/4.0), far body untouched.
  while (!ability.isFinished) ability.update(1 / 60);
  assert.ok(Math.abs(clusterHp() - perBolt * 5) < 5e-2, `Marsh: five bolts land ≈257.25 total (got ${clusterHp().toFixed(2)})`);
  assert.equal(enemies.hp[far], 5000, 'Marsh: outside the pool and hop range, never struck');
  assert.equal(enemies._hitMemory.size, 0, 'Marsh: bolts use plain damage — no dedup sets to leak');
  ability.destroy();

  // Kill-swap outcome contract (re-review pin): a 1-hp seed dies to its own
  // first strike, swap-remove reshuffles indices mid-bolt — the OUTCOME must
  // stay exactly the planned chain regardless of implementation detail:
  // both hops eat their 17/14.45 (found by id, indices untrusted), the
  // far body that swap-remove slid around takes nothing, the seed is gone.
  {
    const swap = new EnemySystem(createRng(56));
    const ctxSwap = { ...ctx, targets: swap, enemies: swap };
    const seed = swap.spawnAt(9, 0, 0, 1);
    swap.hp[seed] = 1;
    const h1 = swap.spawnAt(9.7, 0.5, 0, 1);
    const h2 = swap.spawnAt(10.4, -0.4, 0, 1);
    const farAway = swap.spawnAt(30, 0, 0, 1); // spawned LAST — the body swap-remove slides into the gap
    swap.hp[h1] = 5000;
    swap.hp[h2] = 5000;
    swap.hp[farAway] = 5000;
    const idSeed = swap.id[seed];
    const id1 = swap.id[h1];
    const id2 = swap.id[h2];
    const idFar = swap.id[farAway];
    const hpOf = (id) => {
      for (let i = 0; i < swap.count; i++) if (swap.id[i] === id) return swap.hp[i];
      return -1;
    };
    const bolt = new ThunderMarshSkill(ctxSwap, fusionId('iceshield', 'thunder'));
    bolt.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
    bolt.autocast = false;
    bolt.fusionMult = 1;
    bolt.quenched = false;
    for (let i = 0; i < 53; i++) bolt.update(1 / 60); // just past the first bolt
    bolt.destroy();
    assert.equal(swap.count, 3, 'Marsh swap: the 1-hp seed died to its own first strike');
    assert.equal(hpOf(idSeed), -1, 'Marsh swap: the seed really is gone');
    assert.ok(Math.abs(hpOf(id1) - (5000 - 20 * 0.85)) < 1e-2, `Marsh swap: hop 1 ate exactly 17 (got ${(5000 - hpOf(id1)).toFixed(2)})`);
    assert.ok(Math.abs(hpOf(id2) - (5000 - 20 * 0.85 * 0.85)) < 1e-2, `Marsh swap: hop 2 ate exactly 14.45 (got ${(5000 - hpOf(id2)).toFixed(2)})`);
    assert.equal(hpOf(idFar), 5000, 'Marsh swap: the swapped-around far body was never struck');
  }

  // Empty pool: bolts fire into nothing, quietly.
  {
    const none = new EnemySystem(createRng(54));
    const ctx2 = { ...ctx, targets: none, enemies: none };
    const dry = new ThunderMarshSkill(ctx2, fusionId('iceshield', 'thunder'));
    dry.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
    dry.autocast = false;
    dry.fusionMult = 1;
    dry.quenched = false;
    assert.doesNotThrow(() => {
      while (!dry.isFinished) dry.update(1 / 60);
    }, 'Marsh: an empty pool skips its bolts without throwing');
    dry.destroy();
  }

  console.log('ok  M7 T6: ThunderMarshSkill lifecycle (bolt cadence/3-hit chain/pool bounds/no leak), headless');
}

/* ---- M7 T6: Marsh wux threading + sandbox null-safety ---- */
{
  const calls = [];
  const enemies = new EnemySystem(createRng(55));
  // FOUR bodies in hop range on purpose (re-review pin): with the chain
  // unsaturated, "boltHits is TOTAL strikes" becomes discriminating — the
  // plan body's rejected "3 hops" reading would land a 4th call here.
  enemies.spawnAt(9, 0, 0, 1);
  enemies.spawnAt(10, 1, 0, 1);
  enemies.spawnAt(8, 1, 0, 1);
  enemies.spawnAt(10.5, -0.8, 0, 1);
  const ctx = {
    targets: { damage: (p, r, amt, wux, wuxB) => (calls.push({ amt, wux, wuxB }), 0) },
    enemies,
    stats: { book: () => {} },
    lights: { acquire: () => null, release: () => {}, set: () => {} },
    particles: {
      get: () => ({
        uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
        setGradient() {},
        emit() {}
      })
    },
    mods: null
  };
  const ability = new ThunderMarshSkill(ctx, fusionId('iceshield', 'thunder'));
  ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
  ability.autocast = false;
  ability.fusionMult = 1;
  ability.quenched = false;
  for (let i = 0; i < 53; i++) ability.update(1 / 60); // just past the FIRST bolt
  assert.equal(calls.length, settings.fusions['2+1'].boltHits,
    '数值锚 pin: one bolt = exactly boltHits (3) strikes, even with a 4th body in hop range — the "3 跳"=4击 reading fails here');
  assert.ok(
    Math.abs(calls[0].amt - 20) < 1e-9 && Math.abs(calls[1].amt - 17) < 1e-9 && Math.abs(calls[2].amt - 14.45) < 1e-9,
    `数值锚 pin: the strikes decay 20/17/14.45 (数值表 51.45/道; got ${calls.map((k) => k.amt.toFixed(2)).join('/')})`
  );
  for (let i = 0; i < 60; i++) ability.update(1 / 60);
  ability.destroy();
  assert.ok(calls.length > settings.fusions['2+1'].boltHits, 'Marsh: later bolts kept striking');
  assert.ok(calls.every((k) => k.wux === 1 && k.wuxB === 2), 'Marsh: every strike carries wux=1 (子 wood), wuxB=2 (母 water)');

  const bare = new ThunderMarshSkill({
    lights: { acquire: () => null, release: () => {}, set: () => {} },
    particles: {
      get: () => ({
        uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
        setGradient() {},
        emit() {}
      })
    }
  }, fusionId('iceshield', 'thunder'));
  bare.autocast = false;
  bare.fusionMult = 1;
  bare.quenched = false;
  assert.doesNotThrow(() => {
    bare.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9);
    for (let i = 0; i < 500; i++) bare.update(1 / 60);
    bare.destroy();
  }, 'Marsh: a bare-VFX ctx (no targets/enemies/decals/bursts) never throws');
  console.log('ok  M7 T6: Marsh wux threading (子1木/母2水) + sandbox null-safety');
}

/* ---- M7 T4: PrismArraySkill sandbox null-safety — VFX only, zero errors ---- */
{
  const ctx = {
    lights: { acquire: () => null, release: () => {}, set: () => {} },
    particles: {
      get: () => ({
        uniforms: { uDrag: { value: 0 }, uEndSize: { value: 0 }, uSizeIn: { value: 0 }, uFadeOut: { value: 0 } },
        setGradient() {},
        emit() {}
      })
    }
    // no targets, no stats, no mods, no decals, no bursts — the sandbox shape
    // (fusions are unreachable there in practice — Global Constraints — but
    // the class must still not throw if ticked with this shaped a ctx).
  };
  const ability = new PrismArraySkill(ctx, fusionId('rockspikes', 'dashstrike'));
  ability.autocast = false;
  ability.fusionMult = 1;
  ability.quenched = false;
  assert.doesNotThrow(() => ability.spawn({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 9), 'PrismArray: spawn is null-safe without decals/targets');
  assert.doesNotThrow(() => {
    for (let i = 0; i < 500; i++) ability.update(1 / 60);
  }, 'PrismArray: a full cast ticks with no targets/stats/decals and never throws');
  assert.doesNotThrow(() => ability.destroy(), 'PrismArray: destroy is null-safe');
  console.log('ok  M7 T4: PrismArraySkill sandbox null-safety (VFX only, zero errors)');
}

/* ---- strings: bilingual table + t() fallback chain (spec §9) ---- */
{
  assert.ok(STRINGS.zh['run.kills'] && STRINGS.en['run.kills'], 'strings: run.kills exists in both languages');
  assert.notEqual(STRINGS.zh['run.kills'], STRINGS.en['run.kills'], 'strings: run.kills actually differs by language');

  const saved = settings.ui.language;
  settings.ui.language = 'zh';
  assert.equal(t('run.kills'), STRINGS.zh['run.kills'], 't: reads the zh table when language is zh');
  settings.ui.language = 'en';
  assert.equal(t('run.kills'), STRINGS.en['run.kills'], 't: reads the en table when language is en');

  // Middle rung of the fallback chain: present in zh, absent from the
  // current (en) table — must land on zh, not skip straight to the key.
  STRINGS.zh.__probe = '探针';
  assert.equal(t('__probe'), '探针', 't: missing from the current language falls back to zh');
  delete STRINGS.zh.__probe;

  // Bottom rung: absent everywhere falls back to the key itself, loud but
  // never throwing.
  assert.equal(t('no.such.key'), 'no.such.key', 't: unknown key falls back to itself');
  settings.ui.language = saved;
  console.log('ok  strings table');
}

/* ---- strings: M6 facade debt — character-switch toasts now go through
   t() instead of hardcoded English (App#_switchCharacter, reachable from
   both the sandbox editor's dropdown and the run-mode title screen's) ---- */
{
  for (const key of ['char.loading', 'char.switched', 'char.loadFailed']) {
    assert.ok(STRINGS.zh[key] && STRINGS.en[key], `strings: ${key} exists in both languages`);
    assert.notEqual(STRINGS.zh[key], STRINGS.en[key], `strings: ${key} actually differs by language`);
  }
  console.log('ok  character-switch strings');
}

/* ---- strings: wuxingWord/wuxingPhrase — M6 facade debt. en compositions
   used to jam a hanzi glyph straight against latin text ("金Tide"); zh
   keeps its glyphs (WUXING_LABEL, unspaced — that's correct Chinese), en
   now reads the capitalized WUXING word with a real word boundary. ---- */
{
  const saved = settings.ui.language;
  settings.ui.language = 'zh';
  assert.equal(wuxingWord(0), '金', 'wuxingWord: zh returns the glyph');
  assert.equal(wuxingWord(4), '土', 'wuxingWord: zh glyph indexing matches WUXING_LABEL for every element');
  assert.equal(wuxingPhrase(0, 'run.tide'), '金潮', 'wuxingPhrase: zh glues the glyph directly onto the next word (no space — matches Chinese)');

  settings.ui.language = 'en';
  assert.equal(wuxingWord(0), 'Metal', 'wuxingWord: en returns the capitalized WUXING word');
  assert.equal(wuxingWord(4), 'Earth', 'wuxingWord: en capitalizes every element, not just metal');
  assert.equal(
    wuxingPhrase(0, 'run.tide'),
    'Metal Tide',
    'wuxingPhrase: en separates the word from the next one with a space — no more hanzi-latin jam'
  );
  settings.ui.language = saved;
  console.log('ok  wuxing word/phrase');
}

/* ---- settings.ui: shape + relationships (spec §9/§9.5) ---- */
{
  const ui = settings.ui;
  assert.ok(ui.language === 'zh' || ui.language === 'en', 'settings.ui: language is zh or en');
  assert.equal(typeof ui.reduceFlashes, 'boolean', 'settings.ui: reduceFlashes is a boolean');
  assert.equal(typeof ui.performanceMode, 'boolean', 'settings.ui: performanceMode is a boolean');
  for (const key of ['sfxVolume', 'uiVolume', 'bgmVolume']) {
    assert.ok(ui[key] >= 0 && ui[key] <= 1, `settings.ui: ${key} must be in [0,1] (got ${ui[key]})`);
  }
  // M6 facade debt: repo-wide reduceFlashes convention was ×0.5; spec §9.5
  // wants −80% (0.2 remaining). Pinned here as the one shared constant every
  // flash consumer reads instead of each hand-rolling its own factor.
  assert.equal(ui.flashDamp, 0.2, "settings.ui: flashDamp pinned to spec §9.5's −80% cut");
  console.log('ok  settings.ui shape');
}

/* ---- ScreenFlash: reduceFlashes scales through the shared flashDamp
   constant, not a locally hardcoded ratio (M6 facade debt) ---- */
{
  const saved = settings.ui.reduceFlashes;
  const flash = new ScreenFlash();

  settings.ui.reduceFlashes = false;
  flash.trigger(getColor('#ffffff'), 1, 1);
  assert.ok(Math.abs(flash.strength - settings.post.flashStrength) < 1e-9, 'ScreenFlash: full strength when reduceFlashes is off');

  settings.ui.reduceFlashes = true;
  const flash2 = new ScreenFlash();
  flash2.trigger(getColor('#ffffff'), 1, 1);
  const expected = Math.min(1, settings.post.flashStrength * settings.ui.flashDamp);
  assert.ok(
    Math.abs(flash2.strength - expected) < 1e-9,
    `ScreenFlash: reduceFlashes damps by flashDamp (got ${flash2.strength}, want ${expected})`
  );
  settings.ui.reduceFlashes = saved;
  console.log('ok  screenflash flashDamp');
}

/* ---- ultimate: charge curve + five field effects (spec §4.9) ---- */
{
  const u = settings.ultimate;

  // executeBelow (the new EnemySystem primitive metal's execute rides on):
  // an absolute hp floor, killed through _kill so onDeath still fires.
  {
    const enemies = new EnemySystem(createRng(1));
    const low = enemies.spawnAt(0, 0, 0);
    enemies.hp[low] = 25;
    const high = enemies.spawnAt(5, 5, 0);
    enemies.hp[high] = 50;
    let deaths = 0;
    enemies.onDeath = () => deaths++;
    enemies.executeBelow({ x: 0, z: 0 }, 1e3, 30);
    assert.equal(deaths, 1, 'executeBelow: kills exactly the enemy under the floor');
    assert.equal(enemies.count, 1, 'executeBelow: the enemy above the floor survives');
    assert.equal(enemies.hp[0], 50, 'executeBelow: the survivor is untouched');
  }

  // Charge curve: kills and reactions both feed the same pool, clamped.
  {
    const ult = new Ultimate({ enemies: new EnemySystem(createRng(1)), player: new PlayerState(), combat: {}, rng: createRng(1) });
    assert.equal(ult.charge, 0, 'ultimate: starts empty');
    for (let i = 0; i < 40; i++) ult.gainKill();
    for (let i = 0; i < 12; i++) ult.gainReaction();
    assert.equal(ult.charge, u.chargeMax, `ultimate: 40 kills + 12 reactions = ${u.chargeMax} exactly`);
    ult.gainKill();
    assert.equal(ult.charge, u.chargeMax, 'ultimate: charge clamps past the cap');
    assert.ok(ult.ready(), 'ultimate: full charge is ready');
  }

  // Unready / undecided fire is refused and spends nothing.
  {
    const ult = new Ultimate({ enemies: new EnemySystem(createRng(1)), player: new PlayerState(), combat: {}, rng: createRng(1) });
    ult.wuxing = 2;
    ult.charge = u.chargeMax - 1;
    assert.equal(ult.fire({ x: 0, z: 0 }), false, 'ultimate: fire refused below chargeMax');
    assert.equal(ult.charge, u.chargeMax - 1, 'ultimate: a refused fire spends no charge');

    ult.charge = u.chargeMax;
    ult.wuxing = -1;
    assert.equal(ult.fire({ x: 0, z: 0 }), false, 'ultimate: fire refused with no home element');
    assert.equal(ult.charge, u.chargeMax, 'ultimate: a refused fire (no wuxing) spends no charge');
  }

  // Fire clears the charge to 0 on success.
  {
    const ult = new Ultimate({ enemies: new EnemySystem(createRng(1)), player: new PlayerState(), combat: {}, rng: createRng(1) });
    ult.charge = u.chargeMax;
    ult.wuxing = 2; // water — no enemies needed to prove the charge/return contract
    assert.equal(ult.fire({ x: 0, z: 0 }), true, 'ultimate: ready fire with a decided element succeeds');
    assert.equal(ult.charge, 0, 'ultimate: a successful fire clears the charge');
  }

  // 金 万剑归宗: full-field hit, then a low-hp execute — kills what the hit
  // leaves standing under the floor, spares what the hit leaves comfortably
  // above it. Both probes are metal (element 0), a neutral matchup against
  // a metal attacker (×1), so the arithmetic is exact — not a discriminating
  // choice, just keeps the numbers legible; the field-hit-vs-matchup wiring
  // is the same shared _applyWux path already pinned by the matchup tests.
  {
    const enemies = new EnemySystem(createRng(1));
    const player = new PlayerState();
    const ult = new Ultimate({ enemies, player, combat: {}, rng: createRng(1) });
    const executed = enemies.spawnAt(0, 0, 0, 0); // survives the raw hit (140-120=20) but not the execute floor (30)
    enemies.hp[executed] = 140;
    const survivor = enemies.spawnAt(3, 3, 0, 0); // survives both (200-120=80, comfortably above the floor)
    enemies.hp[survivor] = 200;
    ult.charge = u.chargeMax;
    ult.wuxing = 0;
    assert.ok(ult.fire({ x: 0, z: 0 }), 'ultimate: metal fires when ready');
    assert.equal(enemies.count, 1, 'ultimate: metal execute took exactly the one enemy under the floor');
    assert.equal(enemies.hp[0], 200 - u.metal.damage, 'ultimate: the high-hp enemy survives at hp − field damage exactly');
  }

  // 水 绝对零度: full-field freeze, factor 1.0, reaching the far edge of the
  // arena (not just nearby) — proves the call is genuinely full-field.
  {
    const enemies = new EnemySystem(createRng(2));
    const player = new PlayerState();
    const ult = new Ultimate({ enemies, player, combat: {}, rng: createRng(2) });
    const near = enemies.spawnAt(1, 1, 0);
    const far = enemies.spawnAt(39, 0, 0);
    ult.charge = u.chargeMax;
    ult.wuxing = 2;
    assert.ok(ult.fire({ x: 0, z: 0 }), 'ultimate: water fires when ready');
    assert.equal(enemies.slowed[near], 1, 'ultimate: water freezes the near enemy (slowed=1)');
    assert.equal(enemies.slowed[far], 1, 'ultimate: water freezes the far enemy too');
  }

  // 火 陨星天坠: fire() schedules three waves, tick() pays them out at
  // waveGap spacing; total damage across all waves is exact and stops dead
  // once they're spent (no phantom fourth wave).
  {
    const enemies = new EnemySystem(createRng(3));
    const player = new PlayerState();
    const ult = new Ultimate({ enemies, player, combat: {}, rng: createRng(3) });
    const target = enemies.spawnAt(0, 0, 0, 1); // wood — neutral matchup vs a fire attacker
    enemies.hp[target] = 1e6;
    ult.charge = u.chargeMax;
    ult.wuxing = 3;
    assert.ok(ult.fire({ x: 0, z: 0 }), 'ultimate: fire fires when ready');
    const before = enemies.hp[0];
    for (let t = 0; t < 180; t++) ult.tick(1 / 60, { x: 0, z: 0 }); // 3s ≫ 3 waves × 0.4s gap
    const dealt = before - enemies.hp[0];
    assert.ok(
      Math.abs(dealt - u.fire.waves * u.fire.damagePerWave) < 1e-3,
      `ultimate: fire's three waves total ${u.fire.waves * u.fire.damagePerWave} exactly (got ${dealt})`
    );
    const afterWaves = enemies.hp[0];
    for (let t = 0; t < 60; t++) ult.tick(1 / 60, { x: 0, z: 0 }); // one more second: no fourth wave
    assert.equal(enemies.hp[0], afterWaves, 'ultimate: waves stop dead once spent');
  }

  // 木 世界树: field slow now, heal-over-time paid out by tick(). The two
  // heal checks straddle healTime with a comfortable margin on both sides
  // (not landing exactly on the boundary) so the assertion doesn't depend on
  // which way a float64 timer decrement happens to round at the edge.
  {
    const enemies = new EnemySystem(createRng(4));
    const player = new PlayerState();
    const ult = new Ultimate({ enemies, player, combat: {}, rng: createRng(4) });
    player.hp = 50;
    ult.charge = u.chargeMax;
    ult.wuxing = 1;
    assert.ok(ult.fire({ x: 0, z: 0 }), 'ultimate: wood fires when ready');

    for (let t = 0; t < 60; t++) ult.tick(1 / 60, { x: 0, z: 0 }); // 1s, well inside healTime
    assert.ok(
      Math.abs(player.hp - 50 - u.wood.healPerSecond) < 1e-3,
      `ultimate: wood heals ≈${u.wood.healPerSecond}/s (got ${(player.hp - 50).toFixed(6)})`
    );

    for (let t = 0; t < 600; t++) ult.tick(1 / 60, { x: 0, z: 0 }); // 10 more seconds — well past healTime
    const total = player.hp - 50;
    const expected = u.wood.healPerSecond * u.wood.healTime;
    const oneStep = u.wood.healPerSecond / 60;
    assert.ok(
      total >= expected - 1e-3 && total <= expected + oneStep + 1e-3,
      `ultimate: wood's total heal caps at healPerSecond×healTime = ${expected} (got ${total.toFixed(4)})`
    );

    const afterHeal = player.hp;
    for (let t = 0; t < 60; t++) ult.tick(1 / 60, { x: 0, z: 0 }); // one more second: the drip has stopped
    assert.equal(player.hp, afterHeal, 'ultimate: wood heal stays stopped once healTime is spent');
  }

  // 土 天崩: hit + full-field stun (approximated as slow factor 1.0).
  {
    const enemies = new EnemySystem(createRng(5));
    const player = new PlayerState();
    const ult = new Ultimate({ enemies, player, combat: {}, rng: createRng(5) });
    const target = enemies.spawnAt(2, 2, 0, 0); // metal — neutral matchup vs an earth attacker
    enemies.hp[target] = 1000;
    ult.charge = u.chargeMax;
    ult.wuxing = 4;
    assert.ok(ult.fire({ x: 0, z: 0 }), 'ultimate: earth fires when ready');
    assert.equal(enemies.hp[0], 1000 - u.earth.damage, 'ultimate: earth deals its field damage exactly');
    assert.equal(enemies.slowed[0], 1, 'ultimate: earth stun reads as a full slow (slowed=1)');
  }

  // reset() clears the charge and cancels any in-flight scheduled effect.
  {
    const enemies = new EnemySystem(createRng(6));
    const player = new PlayerState();
    const ult = new Ultimate({ enemies, player, combat: {}, rng: createRng(6) });
    const target = enemies.spawnAt(0, 0, 0, 1);
    enemies.hp[target] = 1e6;
    ult.charge = u.chargeMax;
    ult.wuxing = 3; // fire — schedules waves, the clearest proof reset kills in-flight state
    ult.fire({ x: 0, z: 0 });
    ult.reset();
    assert.equal(ult.charge, 0, 'ultimate: reset clears the charge');
    assert.ok(!ult.ready(), 'ultimate: reset leaves the ultimate unready');
    const before = enemies.hp[0];
    for (let t = 0; t < 120; t++) ult.tick(1 / 60, { x: 0, z: 0 });
    assert.equal(enemies.hp[0], before, 'ultimate: reset also cancels the scheduled waves');
  }

  console.log('ok  ultimate');
}

/* ---- arena: steleGlowAt's three glow bands (spec 五行法阵, M5 Task 7) ---- */
{
  const a = settings.arena;
  const tide = { index: 0, element: 2, progress: 0.5, timeLeft: 90, nextElement: 3 };

  assert.equal(steleGlowAt(2, tide, 0), a.steleGlow, 'arena: the current tide\'s stele burns at steleGlow');
  assert.equal(steleGlowAt(2, tide, 12.3), a.steleGlow, 'arena: current stays pinned at steleGlow regardless of the clock');

  // The next tide's stele breathes between the dim floor and preheatGlow —
  // sample across a couple of cycles and check it never leaves that band,
  // and that it actually moves rather than sitting flat at one end.
  const samples = Array.from({ length: 60 }, (_, i) => steleGlowAt(3, tide, i * 0.23));
  assert.ok(
    samples.every((v) => v >= DIM_GLOW - 1e-6 && v <= a.preheatGlow + 1e-6),
    'arena: next tide\'s stele stays within [dim, preheatGlow]'
  );
  assert.ok(
    Math.max(...samples) - Math.min(...samples) > 0.1,
    'arena: next tide\'s stele actually breathes instead of sitting flat'
  );

  // Every other wuxing sits at the dim floor, unaffected by the clock.
  for (const w of [0, 1, 4]) {
    assert.equal(steleGlowAt(w, tide, 0), DIM_GLOW, 'arena: an idle stele sits at the dim floor');
    assert.equal(steleGlowAt(w, tide, 7.77), DIM_GLOW, 'arena: an idle stele stays flat over time');
  }

  // The final tide's degenerate nextElement === element (TideSchedule.tideAt
  // clamps there) must still read as "current", not fall through to preheat.
  const lastTide = { index: 4, element: 1, progress: 0.9, timeLeft: 5, nextElement: 1 };
  assert.equal(steleGlowAt(1, lastTide, 3), a.steleGlow, 'arena: final tide\'s self-referential nextElement still reads as current');

  console.log('ok  arena stele glow');
}

/* ---- tide atmosphere: mixTint's pure lerp (M5 Task 8) ---- */
{
  const fromHex = settings.tides.atmosphere[2].lightTint; // 水
  const toHex = settings.tides.atmosphere[3].lightTint; // 火
  const from = getColor(fromHex);
  const to = getColor(toHex);

  // 半程 = 分量中点: halfway is the exact componentwise midpoint, not an
  // eased curve or a hex-integer average that forgot to split channels.
  const half = mixTint(fromHex, toHex, 0.5);
  assert.ok(Math.abs(half.r - (from.r + to.r) / 2) < 1e-6, 'tideAtmosphere: mixTint halfway is the midpoint (r)');
  assert.ok(Math.abs(half.g - (from.g + to.g) / 2) < 1e-6, 'tideAtmosphere: mixTint halfway is the midpoint (g)');
  assert.ok(Math.abs(half.b - (from.b + to.b) / 2) < 1e-6, 'tideAtmosphere: mixTint halfway is the midpoint (b)');

  // 潮未换 = 恒等: from === to (nothing actually changed) must return that
  // same colour at ANY blend progress, including out-of-range t — a flipped
  // from/to or an unclamped overshoot could still drift even though the tide
  // never turned.
  for (const sample of [0, 0.3, 0.5, 1, -1, 2]) {
    const same = mixTint(fromHex, fromHex, sample);
    assert.ok(
      Math.abs(same.r - from.r) < 1e-6 && Math.abs(same.g - from.g) < 1e-6 && Math.abs(same.b - from.b) < 1e-6,
      `tideAtmosphere: mixTint(x, x, ${sample}) is the identity (tide unchanged)`
    );
  }

  console.log('ok  tide atmosphere lerp');
}

/* ---- hitstop: 微顿帧 timer's pure decay/trigger arithmetic (M5 Task 9) ---- */
{
  let h = 0;
  h = addHitstop(h);
  assert.equal(h, settings.run.hitstopDuration, 'hitstop: one trigger adds hitstopDuration');

  h = addHitstop(h); // a second trigger before the first has decayed at all
  assert.equal(h, settings.run.hitstopCap, 'hitstop: a second trigger clamps at hitstopCap, does not stack past it');

  h = tickHitstop(h, 1); // a full second of real time — far more than the cap
  assert.equal(h, 0, 'hitstop: decays to exactly zero and never negative');

  console.log('ok  hitstop timer');
}

/* ---- GameAudio throttle: _shouldPlay is a pure per-frame counter (M5 Task 10) ---- */
{
  // No zzfx/AudioContext involved at all here — _shouldPlay only ever
  // touches its own counter, which is exactly why it can be pinned headless.
  const audio = new GameAudio(() => {});

  for (let i = 0; i < 8; i++) {
    assert.ok(audio._shouldPlay(0), `throttle: normal play ${i + 1}/8 must be allowed`);
  }
  assert.ok(!audio._shouldPlay(0), 'throttle: a 9th normal (priority 0) play this frame is dropped');
  assert.ok(!audio._shouldPlay(1), 'throttle: priority 1 does not qualify as the >=2 overflow class either');

  for (let i = 0; i < 4; i++) {
    assert.ok(audio._shouldPlay(2), `throttle: priority>=2 overflow ${i + 1}/4 allowed up to the hard cap of 12`);
  }
  assert.ok(!audio._shouldPlay(2), 'throttle: even priority>=2 drops once the hard cap of 12 is spent');
  assert.ok(!audio._shouldPlay(99), 'throttle: no priority buys past the hard cap');

  audio.beginFrame();
  assert.ok(audio._shouldPlay(0), 'throttle: beginFrame() resets the counter for the next frame');

  console.log('ok  audio throttle');
}

/* ---- GameAudio.play: settings lookup, channel volume, pitch jitter, priority (M5 Task 10) ---- */
{
  const calls = [];
  const audio = new GameAudio((...params) => calls.push(params));

  audio.play('no-such-sound');
  assert.equal(calls.length, 0, 'play: an unknown sound id is a silent no-op');

  const savedSfx = settings.ui.sfxVolume;
  const savedUi = settings.ui.uiVolume;
  settings.ui.sfxVolume = 0.5;
  settings.ui.uiVolume = 0.25;

  audio.play('hit');
  assert.ok(
    Math.abs(calls.at(-1)[0] - settings.audio.sounds.hit.params[0] * 0.5) < 1e-9,
    'play: an sfx-channel sound is scaled by settings.ui.sfxVolume'
  );

  audio.play('levelup');
  assert.ok(
    Math.abs(calls.at(-1)[0] - settings.audio.sounds.levelup.params[0] * 0.25) < 1e-9,
    'play: a ui-channel sound (levelup) is scaled by settings.ui.uiVolume instead'
  );
  settings.ui.sfxVolume = savedSfx;
  settings.ui.uiVolume = savedUi;

  // Pitch jitter shakes the frequency param (index 2), only when asked.
  const baseFreq = settings.audio.sounds.hit.params[2];
  audio.play('hit');
  assert.equal(calls.at(-1)[2], baseFreq, 'play: frequency is untouched without pitchJitter');

  const jittered = [];
  for (let i = 0; i < 20; i++) {
    audio.beginFrame(); // stay under the throttle across the sample loop
    audio.play('hit', { pitchJitter: true });
    jittered.push(calls.at(-1)[2]);
  }
  assert.ok(
    jittered.every((f) => f >= baseFreq * 0.85 - 1e-9 && f <= baseFreq * 1.15 + 1e-9),
    'play: pitchJitter stays within ±15% of the base frequency'
  );
  assert.ok(jittered.some((f) => f !== baseFreq), 'play: pitchJitter actually varies the frequency across calls');

  // priority: play() defaults it from the sound's own settings row (not a
  // hardcoded 0), so a call site can just say play('reaction') and still
  // get the table's priority:2 through the throttle — not the base-only 0.
  const audio2 = new GameAudio((...params2) => calls2.push(params2));
  const calls2 = [];
  for (let i = 0; i < 8; i++) audio2.play('hit'); // fills the base 8 (priority 0 from the table)
  audio2.play('hit'); // 9th normal: dropped
  assert.equal(calls2.length, 8, 'play: the 9th priority-0 sound this frame does not reach the player');
  audio2.play('reaction'); // priority 2 from settings.audio.sounds.reaction
  assert.equal(calls2.length, 9, 'play: a priority>=2 sound still gets through once the base budget is spent');

  console.log('ok  audio wiring');
}

/* ---- M6 T7: castEarth — the audio table's wuxing-ordered cast keys ---- */
{
  // App.js's two cast sites route `audio.play(CAST_SOUND[fusionWux(element)])`
  // (CAST_SOUND = ['castMetal','castWood','castWater','castFire','castEarth'],
  // the same WUXING order as TideSchedule's own WUXING). App.js itself stays
  // out of check-game.mjs — it's the renderer-coupled orchestrator, verified
  // in the browser, same as EnemyRenderer — so the lookup is mirrored here
  // (same idiom as SHAPE_COEF above) rather than imported: a reorder of
  // either table trips this assertion instead of silently going quiet.
  const CAST_SOUND = ['castMetal', 'castWood', 'castWater', 'castFire', 'castEarth'];
  assert.equal(CAST_SOUND.length, WUXING.length, 'audio: one cast key per wuxing');
  for (let w = 0; w < WUXING.length; w++) {
    const cfg = settings.audio.sounds[CAST_SOUND[w]];
    assert.ok(cfg, `audio: settings.audio.sounds.${CAST_SOUND[w]} must exist (${WUXING_LABEL[w]})`);
    assert.ok(Array.isArray(cfg.params) && cfg.params.length > 0, `audio: ${CAST_SOUND[w]} needs zzfx params`);
    assert.equal(cfg.channel, 'sfx', `audio: ${CAST_SOUND[w]} plays on the sfx channel`);
  }
  // rockspikes (土's own M6 T2 launch skill) resolves to wuxing 4 — the
  // exact index an earth-wuxing cast selects castEarth through.
  assert.equal(
    CAST_SOUND[settings.combat.wuxingOf.rockspikes],
    'castEarth',
    'audio: an earth-wuxing cast (rockspikes) selects castEarth'
  );
  console.log('ok  M6 T7: castEarth audio key (table + wuxing routing)');
}

/* ---- perfPreset: performance-mode write/restore is a pure halve+restore (M5 Task 11) ---- */
{
  // A standalone object, not settings.global itself — proves the function
  // only ever touches what it's handed, never reaches into settings on its
  // own (so it structurally cannot ever touch settings.environment either).
  const globals = { particleCount: 1.0, glow: 1.0, lightIntensity: 1.0, shaderIntensity: 1.0, timeScale: 1.0 };

  applyPerfPreset(globals, true);
  assert.equal(globals.particleCount, 0.5, 'perfPreset: on halves particleCount');
  assert.equal(globals.glow, 0.5, 'perfPreset: on halves glow');
  assert.equal(globals.lightIntensity, 0.5, 'perfPreset: on halves lightIntensity');
  assert.equal(globals.shaderIntensity, 0.5, 'perfPreset: on halves shaderIntensity');
  assert.equal(globals.timeScale, 1.0, 'perfPreset: an unrelated global multiplier is left alone');

  applyPerfPreset(globals, true); // double-on: must not halve an already-halved value
  assert.equal(globals.particleCount, 0.5, 'perfPreset: a second "on" is idempotent, not a further halve');
  assert.equal(globals.glow, 0.5, 'perfPreset: idempotent on glow too');

  applyPerfPreset(globals, false);
  assert.equal(globals.particleCount, 1.0, 'perfPreset: off restores the exact pre-halve particleCount');
  assert.equal(globals.glow, 1.0, 'perfPreset: off restores glow exactly');
  assert.equal(globals.lightIntensity, 1.0, 'perfPreset: off restores lightIntensity exactly');
  assert.equal(globals.shaderIntensity, 1.0, 'perfPreset: off restores shaderIntensity exactly');

  applyPerfPreset(globals, false); // off when already off: a no-op, not a further mutation
  assert.equal(globals.particleCount, 1.0, 'perfPreset: a second "off" is a no-op');

  console.log('ok  perf preset');
}

/* ---- M6 T12: breakpoints.js — pure bpScale/bpAdd/bpReplace/bpFlag semantics ---- */
{
  // Identity below Lv3, lv3 armed at 3-4, lv5 folds in on top at 5+ (ice: a
  // real width breakpoint at lv3, a real castTwice flag at lv5, no lv5
  // numeric override for width — so width itself must hold at ×1.5 forever
  // once armed, not regress or double up).
  assert.equal(bpScale('ice', 'width', 1), 1, 'bpScale: Lv1 identity');
  assert.equal(bpScale('ice', 'width', 2), 1, 'bpScale: Lv2 identity');
  assert.equal(bpScale('ice', 'width', 3), 1.5, 'bpScale: Lv3 applies');
  assert.equal(bpScale('ice', 'width', 4), 1.5, 'bpScale: Lv4 still just lv3');
  assert.equal(bpScale('ice', 'width', 5), 1.5, 'bpScale: Lv5 keeps lv3\'s width (no lv5 override for it)');
  assert.equal(bpFlag('ice', 'castTwice', 4), false, 'bpFlag: castTwice unarmed below Lv5');
  assert.equal(bpFlag('ice', 'castTwice', 5), true, 'bpFlag: castTwice armed at Lv5');

  // No table entry → identity, for a real element/param that just isn't
  // breakpointed, and for a nonexistent element entirely.
  assert.equal(bpScale('ice', 'radius', 5), 1, 'bpScale: ice has no radius entry — identity');
  assert.equal(bpAdd('ice', 'radius', 5), 0, 'bpAdd: same, additive side');
  assert.equal(bpScale('nope', 'width', 5), 1, 'bpScale: unknown element — identity');
  assert.equal(bpFlag('nope', 'castTwice', 5), false, 'bpFlag: unknown element — false');

  // Additive whitelist: hops/count add via bpAdd, and — the guard — never
  // multiply if bpScale is (wrongly) called on one instead.
  assert.equal(bpAdd('chainbolt', 'hops', 2), 0, 'bpAdd: hops Lv1/2 identity (0)');
  assert.equal(bpAdd('chainbolt', 'hops', 3), 2, 'bpAdd: chainbolt hops +2 at Lv3');
  assert.equal(bpAdd('chainbolt', 'hops', 5), 2, 'bpAdd: hops has no lv5 entry — stays +2');
  assert.equal(bpScale('chainbolt', 'hops', 3), 1, 'bpScale: hops is additive-only — guarded to identity');
  assert.equal(bpAdd('swordrain', 'count', 3), 4, 'bpAdd: swordrain 剑数 +4 at Lv3');
  assert.equal(bpAdd('bladeorbit', 'count', 3), 2, 'bpAdd: bladeorbit 刃数 +2 at Lv3');
  assert.equal(bpAdd('sunwheel', 'count', 3), 1, 'bpAdd: sunwheel 球数 +1 at Lv3');
  assert.equal(bpAdd('ice', 'width', 5), 0, 'bpAdd: width is multiplicative-only — guarded to identity');

  // Replace semantics: undefined (no override) below the tier, the literal
  // table value once armed — never compounded with the base.
  assert.equal(bpReplace('chainbolt', 'hopDecay', 3), undefined, 'bpReplace: chainbolt has no lv3 hopDecay');
  assert.equal(bpReplace('chainbolt', 'hopDecay', 5), 0.92, 'bpReplace: hopDecay 0.85→0.92 at Lv5');
  assert.equal(bpReplace('snare', 'slowFactor', 3), undefined, 'bpReplace: snare has no lv3 slowFactor');
  assert.equal(bpReplace('snare', 'slowFactor', 5), 0.65, 'bpReplace: slowFactor 0.45→0.65 at Lv5');
  assert.equal(bpReplace('thunder', 'slowFactor', 5), 0.3, 'bpReplace: thunder slowFactor arms to 0.3 at Lv5');
  assert.equal(bpReplace('ice', 'width', 5), undefined, 'bpReplace: width isn\'t a replace key at all');
  assert.equal(bpScale('snare', 'slowFactor', 5), 1, 'bpScale: slowFactor is replace-only — guarded to identity');

  // extraWave mirrors castTwice's own flag shape on a different skill.
  assert.equal(bpFlag('meteor', 'extraWave', 4), false, 'bpFlag: extraWave unarmed below Lv5');
  assert.equal(bpFlag('meteor', 'extraWave', 5), true, 'bpFlag: extraWave armed at Lv5');

  // Genuine same-key cumulative stacking: both tiers targeting the SAME
  // param multiply together at Lv5, not just "the higher tier wins". None of
  // the real 20 skills happen to double up a key across both their own
  // tiers (each skill's lv3/lv5 always name different params — see the
  // table pin below), so this is exercised against a scratch entry.
  settings._bpScratch = { breakpoints: { lv3: { width: 2 }, lv5: { width: 3 } } };
  assert.equal(bpScale('_bpScratch', 'width', 4), 2, 'bpScale: lv3 alone at Lv4');
  assert.equal(bpScale('_bpScratch', 'width', 5), 6, 'bpScale: lv3×lv5 compound at Lv5 (2×3)');
  delete settings._bpScratch;

  console.log('ok  M6 T12: breakpoints.js pure semantics');
}

/* ---- M6 T12: the 40-entry breakpoint table, pinned verbatim ---- */
{
  // Transcription guard: every one of the twenty skills' settings.breakpoints
  // block must match the brief's table exactly, key for key, value for value.
  const BP_EXPECTED = {
    ice: { lv3: { width: 1.5 }, lv5: { castTwice: true } },
    thunder: { lv3: { width: 1.4 }, lv5: { damage: 1.3, slowFactor: 0.3 } },
    meteor: { lv3: { radius: 1.3 }, lv5: { extraWave: true } },
    beam: { lv3: { width: 1.5 }, lv5: { dps: 1.35 } },
    snare: { lv3: { radius: 1.3 }, lv5: { slowFactor: 0.65 } },
    glacier: { lv3: { radius: 1.3 }, lv5: { slowTime: 1.6 } },
    fireball: { lv3: { radius: 1.35 }, lv5: { damage: 1.3 } },
    swordrain: { lv3: { count: 4 }, lv5: { radius: 1.4 } },
    bladeorbit: { lv3: { count: 2 }, lv5: { radius: 1.3 } },
    dashstrike: { lv3: { range: 1.3 }, lv5: { damage: 1.4 } },
    chainbolt: { lv3: { hops: 2 }, lv5: { hopDecay: 0.92 } },
    lifebloom: { lv3: { healPlayer: 1.5 }, lv5: { radius: 1.4 } },
    frostnova: { lv3: { radius: 1.35 }, lv5: { slowTime: 1.5 } },
    iceshield: { lv3: { amount: 1.4 }, lv5: { duration: 1.5 } },
    firering: { lv3: { band: 1.35 }, lv5: { dps: 1.35 } },
    sunwheel: { lv3: { count: 1 }, lv5: { orbitSpeed: 1.3 } },
    rockspikes: { lv3: { width: 1.5 }, lv5: { damage: 1.35 } },
    boulder: { lv3: { radius: 1.3 }, lv5: { stunTime: 1.6 } },
    quake: { lv3: { radius: 1.35 }, lv5: { knockback: 1.5 } },
    stoneskin: { lv3: { amount: 1.4 }, lv5: { reflectShare: 1.6 } }
  };
  assert.equal(Object.keys(BP_EXPECTED).length, 20, 'T12 table: twenty skills expected');
  // Scoped to the twenty this milestone shipped (M10 T1 added tables for the
  // second wave, whose own block pins them) — iterating all of ELEMENTS
  // would make every later roster addition red here for no reason. The count
  // above still refuses a silent deletion from THIS table.
  for (const element of Object.keys(BP_EXPECTED)) {
    assert.deepEqual(
      settings[element].breakpoints,
      BP_EXPECTED[element],
      `T12 table: ${element}'s breakpoints block doesn't match the brief's table`
    );
  }
  // …and nothing outside it may quietly go missing either: every castable id
  // either appears above, or in the second wave's own table (M10 T1), or on
  // this explicitly named list of what M10 T2 still owes. The list is the
  // point — an unlisted skill with no turning points fails loudly, and the
  // list itself has to shrink to nothing by the end of the milestone.
  // M10 T2 emptied the owed list: every castable skill has turning points,
  // and this refuses any future addition that arrives without them.
  for (const element of ELEMENTS) {
    if (BP_EXPECTED[element] || !ABILITY_TYPES[element]) continue;
    assert.ok(settings[element].breakpoints, `breakpoints: ${element} is castable but has no turning points at all`);
  }
  console.log('ok  M6 T12: forty-entry breakpoint table pinned verbatim');
}

/* ---- M6 T12: CombatSystem consumption — one representative per kind ---- */
{
  // sweep (ice): width scales the sample/slow radius at Lv3; a `new
  // CombatSystem(targets)` with no levelOf (every pre-T12 call site, and the
  // sandbox) must still read the unscaled base — sandbox byte-identical.
  {
    const radii = [];
    const targets = { damageOnce: (id, p, r) => (radii.push(r), 1), damage: () => 1, slow: () => {} };
    const ice = {
      element: 'ice', phase: 'travel', age: 0.2,
      position: { x: 3, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 8, u: 0.4
    };
    new CombatSystem(targets).tick(1 / 60, [ice]);
    assert.ok(radii.every((r) => Math.abs(r - settings.combat.ice.width) < 1e-9),
      'T12: no levelOf injected — ice sweep stays at base width (sandbox unchanged)');

    radii.length = 0;
    new CombatSystem(targets, null, () => 3).tick(1 / 60, [{ ...ice }]);
    const want = settings.combat.ice.width * 1.5;
    assert.ok(radii.length > 0 && radii.every((r) => Math.abs(r - want) < 1e-9),
      `T12: ice sweep at Lv3 samples at width×1.5 (want ${want}, got ${radii[0]})`);
  }

  // sweep (thunder): Lv1 the new slowFactor/slowTime field stays inert (0 is
  // falsy, no slow call at all); Lv5 REPLACEs slowFactor to 0.3 and arms the
  // existing slow channel with slowTime's already-final base of 1s, while
  // damage separately scales ×1.3 — two different verbs, one tick.
  {
    const hits = [];
    const slows = [];
    const targets = {
      damageOnce: (id, p, r, amt) => (hits.push(amt), 1),
      damage: () => 1,
      slow: (p, r, f, d) => slows.push({ f, d })
    };
    const thunder = {
      element: 'thunder', phase: 'travel', age: 0.2,
      position: { x: 3, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 8, u: 0.4
    };
    new CombatSystem(targets, null, () => 1).tick(1 / 60, [{ ...thunder }]);
    assert.equal(slows.length, 0, 'T12: thunder Lv1 — the unarmed slow field fires no slow call');
    assert.ok(hits.every((amt) => Math.abs(amt - settings.combat.thunder.damage) < 1e-9),
      'T12: thunder Lv1 damage unscaled');

    hits.length = 0;
    new CombatSystem(targets, null, () => 5).tick(1 / 60, [{ ...thunder }]);
    const wantDmg = settings.combat.thunder.damage * 1.3;
    assert.ok(hits.length > 0 && hits.every((amt) => Math.abs(amt - wantDmg) < 1e-9),
      `T12: thunder Lv5 damage ×1.3 (want ${wantDmg}, got ${hits[0]})`);
    assert.equal(slows.length, 1, 'T12: thunder Lv5 arms exactly one slow call');
    assert.ok(Math.abs(slows[0].f - 0.3) < 1e-9, 'T12: thunder Lv5 slowFactor replaces to 0.3');
    assert.ok(Math.abs(slows[0].d - 1) < 1e-9, 'T12: thunder Lv5 slowTime is its already-final base (1s)');
  }

  // burst (lifebloom healPlayer Lv3, quake knockback Lv5 — extends the
  // pre-T12 knockback assertion with a levelOf stub).
  {
    const healCombat = new CombatSystem({ damage: () => 1, damageOnce: () => 1, slow: () => {} }, null, () => 3);
    const lifebloom = {
      element: 'lifebloom', phase: 'impact', age: 0.2, impactTime: 0.05, fadeTime: 0,
      position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 1, u: 1
    };
    const healed = healCombat.tick(1 / 60, [lifebloom]);
    const wantHeal = settings.combat.lifebloom.healPlayer * 1.5;
    assert.ok(Math.abs(healed - wantHeal) < 1e-9, `T12: lifebloom Lv3 healPlayer ×1.5 (want ${wantHeal}, got ${healed})`);

    // Capture what CombatSystem hands to targets.knockback() directly — the
    // pre-T12 knockback test (above, in the M6 T4 block) already covers
    // EnemySystem.knockback()'s own physics off a raw value; this only needs
    // to pin that the value itself is Lv5-scaled before it gets there.
    const knocks = [];
    const kbCombat = new CombatSystem(
      { damage: () => 1, damageOnce: () => 1, slow: () => {}, knockback: (p, r, kb) => knocks.push(kb) },
      null,
      () => 5
    );
    const quake = {
      element: 'quake', phase: 'impact', age: 0.2, impactTime: 0.05, fadeTime: 0,
      position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 1, u: 1
    };
    kbCombat.tick(1 / 60, [quake]);
    const wantKb = settings.combat.quake.knockback * 1.5;
    assert.equal(knocks.length, 1, 'T12: quake Lv5 knockback call fires exactly once');
    assert.ok(Math.abs(knocks[0] - wantKb) < 1e-9, `T12: quake Lv5 knockback×1.5 (want ${wantKb}, got ${knocks[0]})`);
  }

  // extraWave (meteor Lv5): the first detonation, then a second at 0.5s
  // post-impact — same radius/damage ×0.6, and only ever fires once. Meteor
  // also carries a burnDps dot (unrelated to T12) that keeps calling
  // targets.damage() every tick for its own 2.5s burnTime at the *full*
  // radius — extraWave's ×0.6 radius is what tells its one call apart from
  // both that ongoing dot and the main blast, in a single bucket a plain
  // detonation count can't isolate.
  {
    const mainHits = [];
    const extraHits = [];
    const wantRadius = settings.combat.meteor.radius * 1.3;
    const wantExtraRadius = wantRadius * 0.6;
    const countTargets = {
      damageOnce: () => 1,
      damage: (p, r, amt) => {
        if (Math.abs(r - wantExtraRadius) < 1e-6) extraHits.push(amt);
        else if (Math.abs(r - wantRadius) < 1e-6 && Math.abs(amt - settings.combat.meteor.damage) < 1e-6) mainHits.push(amt);
        return 1;
      },
      slow: () => {}
    };
    const waveCombat = new CombatSystem(countTargets, null, () => 5);
    const meteor = {
      element: 'meteor', phase: 'impact', age: 0,
      position: { x: 2, z: 2 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 10, u: 1, impactTime: 0, fadeTime: 0
    };
    // Walk to just under 0.5s: only the first (Lv3-scaled) detonation has fired.
    for (let t = 0; t < 29; t++) {
      meteor.impactTime += 1 / 60;
      waveCombat.tick(1 / 60, [meteor]);
    }
    assert.equal(mainHits.length, 1, 'T12: meteor Lv5 first wave detonates once, at the Lv3-scaled radius');
    assert.equal(extraHits.length, 0, 'T12: extraWave hasn\'t fired yet at ~0.48s');

    // Cross 0.5s: the second wave fires exactly once, at ×0.6 of the first.
    for (let t = 0; t < 5; t++) {
      meteor.impactTime += 1 / 60;
      waveCombat.tick(1 / 60, [meteor]);
    }
    assert.equal(extraHits.length, 1, 'T12: extraWave lands at ×0.6 the (already Lv3-scaled) radius');
    assert.ok(Math.abs(extraHits[0] - settings.combat.meteor.damage * 0.6) < 1e-6, 'T12: extraWave deals ×0.6 damage');

    // Keep ticking well past (past burnTime too) — it never fires a third time.
    for (let t = 0; t < 180; t++) {
      meteor.impactTime += 1 / 60;
      waveCombat.tick(1 / 60, [meteor]);
    }
    assert.equal(extraHits.length, 1, 'T12: extraWave detonates exactly once per cast');
    assert.equal(mainHits.length, 1, 'T12: ...and the main blast still only once, same as pre-T12');

    // M7 T3 equivalence pin: every assertion above just ran against the
    // GENERALISED waves channel, not a coincidentally-identical parallel
    // branch — the old bespoke machinery is gone outright, not just unused.
    assert.equal(waveCombat._extraDetonated, undefined, 'M7 T3: _extraDetonated retired — _waveCursor is the one channel now');
    assert.ok(waveCombat._waveCursor.size > 0, 'M7 T3: meteor Lv5 extraWave really did run through _waveCursor');
  }

  // lineTick (beam): both tiers on one skill — width×1.5 (Lv3) and dps×1.35
  // (Lv5) compound at Lv5 (each on its own independent param, not the same
  // key — see the table pin above for the genuine same-key cumulative case).
  {
    const calls = [];
    const beamCombat = new CombatSystem(
      { damage: (p, r, amt) => (calls.push({ r, amt }), 1), damageOnce: () => 1, slow: () => {} },
      null,
      () => 5
    );
    const beam = {
      element: 'beam', phase: 'impact', age: 0.5, impactTime: 0.2,
      position: { x: 8, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 8, u: 1
    };
    beamCombat.tick(1 / 60, [beam]);
    const wantWidth = settings.combat.beam.width * 1.5;
    assert.ok(calls.every((c) => Math.abs(c.r - wantWidth) < 1e-9), 'T12: beam Lv5 samples at width×1.5');
    const totalDmg = calls.reduce((s, c) => s + c.amt, 0);
    const wantDps = settings.combat.beam.dps * 1.35;
    // One tick's worth, split across LINE_SAMPLES — sums to dps×step, not dps.
    assert.ok(Math.abs(totalDmg - wantDps / 60) < 1e-9, `T12: beam Lv5 dps×1.35 (want ${wantDps / 60}, got ${totalDmg})`);
  }

  // zoneTick (snare): radius×1.3 (Lv3) and slowFactor REPLACE 0.45→0.65 (Lv5).
  {
    const slows = [];
    const snareCombat = new CombatSystem(
      { damage: () => 1, damageOnce: () => 1, slow: (p, r, f) => slows.push({ r, f }) },
      null,
      () => 5
    );
    const snare = {
      element: 'snare', phase: 'travel', age: 0.5,
      position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 1, u: 0.5
    };
    snareCombat.tick(1 / 60, [snare]);
    assert.equal(slows.length, 1, 'T12: snare Lv5 still applies exactly one slow call');
    // combat.snare carries no radius field of its own — zoneTick's fallback
    // reads settings.snare.zoneRadius, so that's what Lv3's radius scales.
    const wantRadius = settings.snare.zoneRadius * 1.3;
    assert.ok(Math.abs(slows[0].r - wantRadius) < 1e-9, `T12: snare Lv3 radius×1.3 (want ${wantRadius}, got ${slows[0].r})`);
    assert.ok(Math.abs(slows[0].f - 0.65) < 1e-9, 'T12: snare Lv5 slowFactor replaces to 0.65');
  }

  // aura (firering band×1.35 Lv3 + dps×1.35 Lv5; bladeorbit radius×1.3 Lv5).
  {
    const hits = [];
    const auraCombat = new CombatSystem(
      { damage: () => 0, damageOnce: () => 0, slow: () => {}, damageRing: (p, inner, outer, amt) => (hits.push({ inner, outer, amt }), 1) },
      null,
      () => 5
    );
    const firering = {
      element: 'firering', phase: 'travel', age: 1,
      position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 1, u: 0
    };
    auraCombat.tick(1 / 60, [firering]);
    const row = settings.combat.firering;
    const wantOuter = row.radius; // firering carries no radius breakpoint
    const wantBand = row.band * 1.35;
    const wantAmt = row.dps * 1.35 * (1 / 60);
    assert.ok(Math.abs(hits[0].outer - wantOuter) < 1e-9, 'T12: firering radius unaffected (no breakpoint on it)');
    assert.ok(Math.abs(hits[0].inner - (wantOuter - wantBand)) < 1e-9, `T12: firering Lv3 band×1.35 (want inner ${wantOuter - wantBand}, got ${hits[0].inner})`);
    assert.ok(Math.abs(hits[0].amt - wantAmt) < 1e-9, `T12: firering Lv5 dps×1.35 (want ${wantAmt}, got ${hits[0].amt})`);

    hits.length = 0;
    const bladeorbit = {
      element: 'bladeorbit', phase: 'travel', age: 1,
      position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 1, u: 0
    };
    auraCombat.tick(1 / 60, [bladeorbit]);
    const wantBladeRadius = settings.combat.bladeorbit.radius * 1.3;
    assert.ok(Math.abs(hits[0].outer - wantBladeRadius) < 1e-9, `T12: bladeorbit Lv5 radius×1.3 (want ${wantBladeRadius}, got ${hits[0].outer})`);
  }

  // shield (iceshield amount×1.4 Lv3 + duration×1.5 Lv5; stoneskin reflectShare×1.6 Lv5).
  {
    const shieldCombat = new CombatSystem({ damage: () => 1, damageOnce: () => 1, slow: () => {} }, null, () => 5);
    const iceshield = {
      element: 'iceshield', phase: 'travel', age: 0.01, impactTime: 0, fadeTime: 0,
      position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 1, u: 0
    };
    shieldCombat.tick(1 / 60, [iceshield]);
    const wantAmount = settings.combat.iceshield.amount * 1.4;
    const wantDuration = settings.combat.iceshield.duration * 1.5;
    assert.ok(Math.abs(shieldCombat.shieldDue.amount - wantAmount) < 1e-9, `T12: iceshield Lv3 amount×1.4 (want ${wantAmount})`);
    assert.ok(Math.abs(shieldCombat.shieldDue.duration - wantDuration) < 1e-9, `T12: iceshield Lv5 duration×1.5 (want ${wantDuration})`);

    const shieldCombat2 = new CombatSystem({ damage: () => 1, damageOnce: () => 1, slow: () => {} }, null, () => 5);
    const stoneskin = {
      element: 'stoneskin', phase: 'travel', age: 0.01, impactTime: 0, fadeTime: 0,
      position: { x: 0, z: 0 }, origin: { x: 0, z: 0 },
      direction: { x: 1, z: 0 }, length: 1, u: 0
    };
    shieldCombat2.tick(1 / 60, [stoneskin]);
    const wantReflect = settings.combat.stoneskin.reflectShare * 1.6;
    assert.ok(Math.abs(shieldCombat2.shieldDue.reflectShare - wantReflect) < 1e-9,
      `T12: stoneskin Lv5 reflectShare×1.6 (want ${wantReflect})`);
  }

  console.log('ok  M6 T12: CombatSystem consumption (sweep/burst/lineTick/zoneTick/aura/shield + extraWave)');
}

/* ---- M6 T12: shield gate — T5 watch item (iceshield Lv3 vs stoneskin base) ---- */
{
  // addShield's take-max compares the new cast against the CURRENT REMAINING
  // shield, not the original cast amount — pin both halves of that: a
  // refresh below the remaining pool is a no-op (the documented window), and
  // one that reaches or exceeds it lands, including reflectShare riding
  // along with amount/duration as one bundle.
  const player = new PlayerState();
  player.addShield(56, 6, 0); // iceshield Lv3 (40×1.4), no reflectShare

  player.addShield(55, 7, 0.3); // stoneskin base — 55 < remaining 56: no-op
  assert.equal(player.shield, 56, 'T5 watch item: a weaker refresh while remaining ≥ its amount is a no-op');
  assert.equal(player.reflectShare, 0, 'T5 watch item: the no-op leaves the old (weaker) reflectShare in place too');

  player.shield = 40; // drains below stoneskin's 55, as real combat would over a few seconds
  player.addShield(55, 7, 0.3);
  assert.equal(player.shield, 55, 'T5 watch item: once remaining < the new amount, the refresh lands');
  assert.equal(player.shieldT, 7, 'T5 watch item: ...and its duration is restored');
  assert.equal(player.reflectShare, 0.3, 'T5 watch item: ...and reflectShare is restored with it (one bundle)');

  console.log('ok  M6 T12: shield gate — stoneskin refresh lands once remaining < its amount');
}

/* ---- M6 T12: UpgradePool — the Lv3/Lv5 card carries its breakpoint line ---- */
{
  const saved = settings.run.draftLoadout;
  settings.run.draftLoadout = true;
  const loadout = new Loadout();
  loadout.reset();
  const mods = new Modifiers();
  const pool = new UpgradePool(createRng(77), loadout, mods);
  const element = loadout.elementAt(0);

  // draw() is weighted-random over every offerable candidate — the pre-T12
  // "exhaustion" test above already leans on the same trick: seat and max
  // every other candidate (the remaining 5 seats, every passive) so
  // `element`'s own upgrade card is the only thing left in the pool, and a
  // one-item weighted pick is deterministic.
  const others = ELEMENTS.filter((el) => el !== element).slice(0, 5);
  for (const el of others) loadout.acquire(el);
  for (const el of others) {
    while (!loadout.isMaxed(el)) loadout.upgrade(el);
  }
  for (const id of Object.keys(PASSIVES)) {
    while (mods.bumpPassive(id)) { /* to max */ }
  }

  loadout.upgrade(element); // Lv1 → Lv2: next pick offers Lv3
  const hand3 = pool.draw(2);
  const card3 = hand3.find((c) => c.kind === 'upgrade' && c.element === element);
  assert.ok(card3, 'T12: an upgrade card is on offer at Lv2→3');
  assert.ok(card3.body.includes(t(`bp.${element}.lv3`)), `T12: Lv3 card body carries bp.${element}.lv3`);

  loadout.upgrade(element); // → Lv3
  loadout.upgrade(element); // → Lv4: next pick offers Lv5
  const hand5 = pool.draw(4);
  const card5 = hand5.find((c) => c.kind === 'upgrade' && c.element === element);
  assert.ok(card5, 'T12: an upgrade card is on offer at Lv4→5');
  assert.ok(card5.body.includes(t(`bp.${element}.lv5`)), `T12: Lv5 card body carries bp.${element}.lv5`);
  assert.ok(!card5.body.includes(t(`bp.${element}.lv3`)), 'T12: the Lv5 card doesn\'t also carry the Lv3 line');

  settings.run.draftLoadout = saved;
  console.log('ok  M6 T12: upgrade cards show their breakpoint line at Lv3/Lv5');
}

console.log('\nevery game-logic check passed');
