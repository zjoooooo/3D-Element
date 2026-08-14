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
 * The numbers here mirror docs/superpowers/specs/2026-08-14-wuxing-roguelike-design.md;
 * when implementation lands they should be read from settings instead.
 */

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

const P = {
  duration: 900, // seconds
  // --- spawning ---
  spawnPerMin: (m) => 20 + 2.2 * m * m, // gentle start, fierce final tide
  popCap: 300,
  mix: { swarm: 0.7, ranged: 0.2, tank: 0.1 }, // spec §5 behaviour mix
  hpMult: { swarm: 1, ranged: 2, tank: 6 }, // × swarm HP
  elitesPerTide: 2,
  // --- enemy stats (spec 锚3) ---
  swarmHp: (m) => 20 * (1 + 0.16 * m),
  volleyEvery: 60, // ranged volley chip damage, seconds
  volleyDamage: 8,
  contactDpsAtCap: 33, // 被围致死 ~4s (锚1), scaled by (pop/cap)^crowdExponent
  crowdExponent: 1.4,
  // --- player (spec 锚2/锚4) ---
  playerHp: 100,
  baseDps: 42, // 冰枪当量: 20dmg/1.2s × ~2.5 targets
  // --- XP economy ---
  gemSwarm: (m) => 1 + 0.12 * m, // gem value scales with the minute it drops
  gemElite: 15,
  tideGold: 150, // gold-gem rain at each tide end (5 tides)
  xpNeed: (level) => 22 * Math.pow(1.13, level),
};

/**
 * One simulated run.
 * @param {number} seed
 * @param {object} bot  { gain: DPS multiplier per upgrade, kite: 0..1 damage avoided }
 */
function simulate(seed, bot) {
  const rand = mulberry32(seed);
  let pop = 0, hp = P.playerHp, xp = 0, level = 0, kills = 0;
  let dps = P.baseDps * (0.9 + 0.2 * rand());
  // A given player's kiting varies game to game — bad days happen.
  const kite = Math.min(0.9, Math.max(0.1, bot.kite + (rand() - 0.5) * 0.16));
  let crossover = null;

  for (let t = 0; t < P.duration; t++) {
    const m = t / 60;

    // Spawns (jittered ±20%), capped.
    const rate = (P.spawnPerMin(m) / 60) * (0.8 + 0.4 * rand());
    pop = Math.min(P.popCap, pop + rate);

    // Kills: DPS spread over the weighted average enemy HP of this minute.
    const avgHp = P.swarmHp(m) * (P.mix.swarm * 1 + P.mix.ranged * 2 + P.mix.tank * 6);
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

console.log('=== 五行肉鸽 难度模拟 (200 局/档) ===\n');
runBatch('新手 (乱选+站桩)', { gain: 1.08, kite: 0.3 });
runBatch('基线 (普通操作)', { gain: 1.12, kite: 0.55 });
runBatch('熟练 (好build+走位)', { gain: 1.15, kite: 0.72 });
runBatch('高手 (完美)', { gain: 1.18, kite: 0.85 });
