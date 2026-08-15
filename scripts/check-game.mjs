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
import { TideSchedule, WUXING, BEATS } from '../src/run/TideSchedule.js';
import { Modifiers, PASSIVES } from '../src/run/Modifiers.js';
import { Loadout } from '../src/run/Loadout.js';
import { UpgradePool } from '../src/run/UpgradePool.js';
import { GameClock } from '../src/run/GameClock.js';
import { Targets } from '../src/run/Targets.js';
import { EnemySystem } from '../src/run/EnemySystem.js';
import { EnemyProjectiles } from '../src/run/EnemyProjectiles.js';
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
    tides: new TideSchedule(createRng(7)),
    projectiles: new EnemyProjectiles(),
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

  // Level-ups queue on the manager instead of vanishing.
  run.start();
  run.tick(1 / 60, { x: 0, z: 0 });
  pickups.xp = pickups.xpNeed(1) + pickups.xpNeed(2) + 1; // enough for two levels
  run.tick(1 / 60, { x: 0, z: 0 });
  assert.ok(run.pendingLevels >= 2, `run: level-ups queue (got ${run.pendingLevels})`);
  run.start();
  assert.equal(run.pendingLevels, 0, 'run: restart clears the queue');

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

  // Exhaustion: everything maxed and seated → empty hand (skip-heal path).
  const x = make(41);
  for (const element of ELEMENTS) x.loadout.acquire(element);
  for (const element of x.loadout.equippedList()) {
    while (!x.loadout.isMaxed(element)) x.loadout.upgrade(element);
  }
  for (const id of Object.keys(PASSIVES)) {
    while (x.mods.bumpPassive(id)) { /* to max */ }
  }
  assert.equal(x.pool.draw(20).length, 0, 'pool: a full build draws nothing');
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
    combat: { tick: () => {}, release: () => -1 },
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
  assert.ok(
    Math.abs(before - enemies.hp[wood] - 10 * settings.combat.matchup.advantage) < 1e-6,
    'matchup: advantage lands ×1.25'
  );
  // wood beats earth(4): an earth hit on a wood enemy is the disadvantaged one? No —
  // wood(1) beats earth(4), so earth attacking wood pays the tax.
  const before2 = enemies.hp[wood];
  enemies.damage({ x: 0, z: 0 }, 1, 10, 4);
  assert.ok(
    Math.abs(before2 - enemies.hp[wood] - 10 * settings.combat.matchup.disadvantage) < 1e-6,
    'matchup: disadvantage pays ×0.8'
  );
  // Neutral pairs pass through untouched.
  const before3 = enemies.hp[wood];
  enemies.damage({ x: 0, z: 0 }, 1, 10, 2); // water vs wood: water feeds wood in 相生 but no 克 — neutral here
  assert.ok(Math.abs(before3 - enemies.hp[wood] - 10) < 1e-6, 'matchup: neutral is ×1');

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
    combat: { tick: () => {}, release: () => -1, resetStats: () => {} },
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
  const none = pool.draw(3, 3, 4); // earth: no earth abilities exist yet
  assert.equal(none.length, 0, 'shard: an empty wuxing returns an empty hand');
  console.log('ok  verdict & shards');
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
