/**
 * Headless difficulty simulator for the wuxing roguelike (spec §8 anchors).
 *
 * Simulates 15-minute runs at 1s ticks with a bot of a given skill level, and
 * reports win rate, median death time, level reached and the pressure
 * crossover — the minute the spawn pressure overtakes the player's kill rate.
 * Monte-Carlo over seeded RNG, so every balance question becomes "run 200
 * simulated games and look at the histogram" instead of guesswork.
 *
 *   npm run sim
 *
 * M11 T2: this file used to keep its own copy of every number in the spec, with
 * a note saying it should read settings once the implementation landed. It had,
 * long ago, and the copy had started to lie — M11 T1 changed the xp curve and
 * `npm run sim` reported four identical anchors, because it was still dividing
 * by `22 * 1.13^level`. It was describing a game that no longer existed.
 *
 * Everything below that HAS a settings source now reads it. What remains is
 * marked, and is genuinely model-only: aggregates the settings layer does not
 * express (one "volley" standing in for every ranged enemy's own cadence), and
 * constants calibrated against playtest rather than derived from anything.
 * Those cannot track settings, and pretending otherwise is how the last copy
 * rotted — so they are labelled instead.
 */
import { pathToFileURL } from 'node:url';

import { settings } from '../src/config/settings.js';

/** Deterministic RNG (spec: seedable gameplay randomness). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const R = settings.run;
const E = settings.enemies;

const P = {
  /* ---- read straight off settings: change the game, the model follows ---- */
  duration: R.duration,
  spawnPerMin: (m) => R.spawnBase + R.spawnQuad * m * m,
  popCap: R.enemyCap,
  mix: {
    swarm: 1 - E.mix.rangedShare - E.mix.tankShare,
    ranged: E.mix.rangedShare,
    tank: E.mix.tankShare
  },
  hpMult: { swarm: E.swarm.hpMult, ranged: E.ranged.hpMult, tank: E.tank.hpMult },
  swarmHp: (m) => E.hpBase * (1 + E.hpPerMinute * m),
  playerHp: R.playerHp,
  gemElite: E.elites.gemValue,
  xpNeed: (level) => R.xpBase * Math.pow(R.xpGrowth, level),

  // 首领战 (M11 T6). The model was blind to it — the boss landed and `npm run
  // sim` printed four identical anchors, which is the same way the xp curve
  // lied one task ago. Its hp and its arrival read settings; what it does to
  // the run is the model's own: while it stands, the player's damage goes into
  // it instead of into the horde, and the horde keeps arriving.
  bossAt: settings.tides.length * R.boss.afterTides,
  bossHp: (m) => E.hpBase * (1 + E.hpPerMinute * m) * E.boss.hpMult,
  /**
   * What the boss does to you, per second, averaged over its cooldowns.
   *
   * NOT its contact damage. The first cut of this modelled the boss as a
   * constant `contactDamage` dps and every difficulty band died the instant it
   * landed, at any hp from 100× to 900× — the tell that the hp was irrelevant
   * and the pressure term was doing all the killing. A boss walking at 1.15
   * m/s is something you step away from; what actually reaches the player is
   * its MOVES, on their own cadences, and both of them telegraph (so kiting
   * mitigates them like everything else here).
   */
  bossMoveDps: E.boss.fight.charge.damage / E.boss.fight.charge.every +
    E.boss.fight.quake.damage / E.boss.fight.quake.every,
  /** …and its summons are bodies, which the crowd term already knows how to price. */
  bossSummonPerSec: E.boss.fight.summon.count / E.boss.fight.summon.every,

  /* ---- model-only: no settings field means this, and none ever will ----
   *
   * These are aggregates and calibrations, not mirrors. `contactDpsAtCap` is
   * what a capped horde does per second in total, which the per-enemy
   * `contactDamage` fields cannot state; `volleyEvery`/`volleyDamage` collapse
   * every ranged enemy's own `fireEvery` into one periodic bite; `baseDps` is
   * the whole player's damage at level zero, calibrated against playtest — it
   * is NOT `combat.ice.damage / ice.cooldown` (that anchor reads 50) and must
   * not be quietly rewired to it, because the two mean different things and
   * swapping them would silently re-balance every number in this file.
   */
  elitesPerTide: 2,
  volleyEvery: 60,
  volleyDamage: 8,
  contactDpsAtCap: 33, // 被围致死 ~4s (锚1), scaled by (pop/cap)^crowdExponent
  crowdExponent: 1.4,
  baseDps: 42,
  /** Share of the player's damage that goes into the boss while it is up. Not
   *  a settings value — how much a player commits to a boss is behaviour. */
  /** Share of the player's output that also lands on the boss while it is up —
   *  overlap, not diversion (see the kill-rate note in `simulate`). */
  bossOverlap: 0.6,
  /** How much of a telegraphed move still lands, on top of the general kite
   *  term. Model-only: this is player behaviour, not a settings value. */
  bossTelegraphed: 0.35,
  gemSwarm: (m) => 1 + 0.12 * m,
  tideGold: 150 // gold-gem rain at each tide end (5 tides)
};

/**
 * One simulated run.
 * @param {number} seed
 * @param {object} bot  { gain: DPS multiplier per upgrade, kite: 0..1 damage avoided }
 */
function simulate(seed, bot) {
  const rand = mulberry32(seed);
  let pop = 0, hp = P.playerHp, xp = 0, level = 0, kills = 0;
  /** null until it turns up, then its remaining hp; 0 once beaten. */
  let bossHp = null;
  let dps = P.baseDps * (0.9 + 0.2 * rand());
  // A given player's kiting varies game to game — bad days happen.
  const kite = Math.min(0.9, Math.max(0.1, bot.kite + (rand() - 0.5) * 0.16));
  let crossover = null;

  for (let t = 0; t < P.duration; t++) {
    const m = t / 60;

    // Spawns (jittered ±20%), capped.
    const rate = (P.spawnPerMin(m) / 60) * (0.8 + 0.4 * rand());
    pop = Math.min(P.popCap, pop + rate);

    // 首领战: it turns up once, soaks damage that would otherwise thin the
    // horde, and leans on the player the whole time it is up. This is the
    // pressure T2 deferred — the run had lost its crossover entirely and the
    // boss is what was supposed to give it back.
    if (bossHp === null && t >= P.bossAt) bossHp = P.bossHp(m);
    const fightingBoss = bossHp !== null && bossHp > 0;
    // Its summons join the horde like anything else — the crowd term prices
    // them without a second rule.
    if (fightingBoss) pop = Math.min(P.popCap, pop + P.bossSummonPerSec);

    // Kills: DPS spread over the weighted average enemy HP of this minute.
    const avgHp = P.swarmHp(m) * (P.mix.swarm * 1 + P.mix.ranged * 2 + P.mix.tank * 6);
    // Damage is SHARED here, not split. The first cut of this subtracted the
    // boss's share from the horde's kill rate, and every band below 高手 died
    // the minute it landed at any boss hp from 70x to 900x. That is a
    // single-target game's model: in this one almost every skill is an area,
    // so a sweep through the boss cuts the swarm standing around it in the
    // same tick. The boss soaks what happens to overlap it; the field keeps
    // clearing at the rate it already was.
    if (fightingBoss) bossHp -= dps * P.bossOverlap;
    const killRate = Math.min(pop, dps / avgHp);
    pop -= killRate;
    kills += killRate;
    if (crossover === null && m > 1 && rate > killRate) crossover = m;

    // XP income → levels → upgrades.
    xp += killRate * P.gemSwarm(m);
    if (t > 0 && t % 180 === 0) xp += P.tideGold + P.elitesPerTide * P.gemElite;
    while (xp >= P.xpNeed(level + 1)) {
      xp -= P.xpNeed(level + 1);
      level++;
      dps *= bot.gain * (0.97 + 0.06 * rand()); // draw luck
    }

    // Incoming damage: crowding plus periodic ranged volleys, mitigated by kiting.
    let incoming = P.contactDpsAtCap * Math.pow(pop / P.popCap, P.crowdExponent) * (1 - kite);
    // Telegraphed moves are more avoidable than being surrounded, and the model
    // has one avoidance number for everything. `bossTelegraphed` is the extra
    // discount a drawn warning circle earns — without it the fight took 70% of
    // a 100 hp player's bar and every band below 高手 died the minute it
    // landed, at any boss hp from 70× to 900×, which is the tell that the term
    // was doing all the work.
    if (fightingBoss) incoming += P.bossMoveDps * (1 - kite) * P.bossTelegraphed;
    if (t > 60 && t % P.volleyEvery === 0)
      incoming += P.volleyDamage * (1 + 0.12 * m) * (1 - kite) * (0.5 + rand());
    hp -= incoming;
    if (hp <= 0) return { win: false, deathAt: t, level, kills, crossover };
  }
  return { win: true, deathAt: P.duration, level, kills, crossover };
}

function runBatch(name, bot, runs = 200) {
  const out = [];
  for (let i = 0; i < runs; i++) out.push(simulate(1000 + i * 7919, bot));
  const wins = out.filter((r) => r.win).length;
  const deaths = out.filter((r) => !r.win).map((r) => r.deathAt / 60).sort((a, b) => a - b);
  const med = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);
  const levels = out.map((r) => r.level).sort((a, b) => a - b);
  const cross = out.map((r) => r.crossover).filter((v) => v !== null).sort((a, b) => a - b);
  console.log(
    `${name.padEnd(18)} win ${String(Math.round((100 * wins) / runs)).padStart(3)}%` +
      `  死亡中位 ${med(deaths) ? med(deaths).toFixed(1) + 'min' : '  —  '}` +
      `  等级中位 ${med(levels)}` +
      `  击杀中位 ${Math.round(med(out.map((r) => r.kills).sort((a, b) => a - b)))}` +
      `  反超点 ${med(cross) ? med(cross).toFixed(1) + 'min' : '无'}`
  );
  return { winRate: wins / runs, medianLevel: med(levels) };
}

/**
 * Exported so `check-game.mjs` can assert that the model's economy really is
 * the game's — the copy that rotted was invisible precisely because nothing
 * could see it from outside. Running the batches is gated on being the entry
 * point, so importing this costs nothing.
 */
export { P, simulate, runBatch };

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  console.log('=== 五行肉鸽 难度模拟 (200 局/档) ===\n');
  runBatch('新手 (乱选+站桩)', { gain: 1.08, kite: 0.3 });
  runBatch('基线 (普通操作)', { gain: 1.12, kite: 0.55 });
  runBatch('熟练 (好build+走位)', { gain: 1.15, kite: 0.72 });
  runBatch('高手 (完美)', { gain: 1.18, kite: 0.85 });
}
