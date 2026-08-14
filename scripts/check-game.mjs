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
import { settings, ELEMENTS } from '../src/config/settings.js';
import { GameClock } from '../src/run/GameClock.js';
import { Targets } from '../src/run/Targets.js';
import { EnemySystem } from '../src/run/EnemySystem.js';
import { CombatSystem } from '../src/run/CombatSystem.js';
import { PickupSystem } from '../src/run/PickupSystem.js';
import { PlayerState } from '../src/run/PlayerState.js';
import { RunManager } from '../src/run/RunManager.js';

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

/* ---- run manager: schedule, deaths feed gems, verdicts ---- */
{
  const rng = createRng(7);
  const enemies = new EnemySystem(rng);
  const pickups = new PickupSystem();
  const player = new PlayerState();
  const run = new RunManager({
    enemies, pickups, player, rng,
    combat: { tick: () => {}, release: () => -1 },
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

  // Verdicts.
  player.hp = 0;
  player.alive = false;
  assert.equal(run.tick(1 / 60, { x: 0, z: 0 }), 'dead');
  run.start();
  run.elapsed = settings.run.duration + 1;
  assert.equal(run.tick(1 / 60, { x: 0, z: 0 }), 'won');
  console.log('ok  run manager');
}

/* ---- stress: a full cap of enemies ticks fast enough headless ---- */
{
  const enemies = new EnemySystem(createRng(3));
  for (let n = 0; n < 300; n++) {
    enemies.spawnAt(Math.cos(n) * 20, Math.sin(n) * 20, 10);
  }
  const t0 = performance.now();
  for (let t = 0; t < 600; t++) enemies.tick(1 / 60, { x: 0, z: 0 }, 10);
  const ms = (performance.now() - t0) / 600;
  // 60Hz leaves 16.6ms per frame for everything; the horde may take 2.
  assert.ok(ms < 2, `stress: enemy tick averages ${ms.toFixed(2)}ms at cap (budget 2ms)`);
  console.log(`ok  stress (${ms.toFixed(2)}ms/tick at 300 enemies)`);
}

console.log('\nevery game-logic check passed');
