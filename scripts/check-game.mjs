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

import { createRng } from '../src/run/rng.js';
import { settings, ELEMENTS, ELEMENT_META } from '../src/config/settings.js';
import { TideSchedule, WUXING, BEATS, FEEDS } from '../src/run/TideSchedule.js';
import { Modifiers, PASSIVES } from '../src/run/Modifiers.js';
import { Loadout } from '../src/run/Loadout.js';
import { UpgradePool } from '../src/run/UpgradePool.js';
import { FUSIONS, fusionId, isFusionId, fusionParents } from '../src/run/fusions.js';
import { GameClock } from '../src/run/GameClock.js';
import { Targets } from '../src/run/Targets.js';
import { EnemySystem } from '../src/run/EnemySystem.js';
import { EnemyProjectiles } from '../src/run/EnemyProjectiles.js';
import { CombatSystem } from '../src/run/CombatSystem.js';
import { PickupSystem } from '../src/run/PickupSystem.js';
import { PlayerState } from '../src/run/PlayerState.js';
import { canAffordCast, manaCostOf } from '../src/run/manaGate.js';
import { RunManager, tickHitstop, addHitstop } from '../src/run/RunManager.js';
import { Ultimate } from '../src/run/Ultimate.js';
import { sequenceRefund } from '../src/run/sequence.js';
import { STRINGS, t, wuxingWord, wuxingPhrase } from '../src/ui/strings.js';
import { steleGlowAt, DIM_GLOW } from '../src/run/Arena.js';
import { mixTint } from '../src/run/TideAtmosphere.js';
import { getColor } from '../src/utils/color.js';
import { GameAudio } from '../src/run/GameAudio.js';
import { applyPerfPreset } from '../src/run/perfPreset.js';
import { ScreenFlash } from '../src/effects/ScreenFlash.js';

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

  assert.equal(ELEMENTS.length, 20, 'ELEMENTS: seven original + the thirteen M6 T2 launch skills');
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
  const CHECKED = ELEMENTS.filter((e) => !EXEMPT.has(e));
  assert.equal(CHECKED.length, 6, 'anchor2: expected six formula-checkable new skills');

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

  console.log('ok  M6 T4: aura annulus, healPlayer routing, stunTime');
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
  assert.equal(exhausted.length, 1, 'pool: a full build offers only its ripe fusion');
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

console.log('\nevery game-logic check passed');
