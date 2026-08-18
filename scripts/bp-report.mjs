/**
 * 质变节点复核报告 — what each Lv3/Lv5 breakpoint actually does, measured.
 *
 * A breakpoint table is twenty-odd numbers in `settings.js`, and reading them
 * tells you what was *intended*, not what the engine delivers. This drives a
 * real run in a real browser and casts every skill at Lv1 / Lv3 / Lv5 into an
 * identical ring of bodies, then writes down what changed.
 *
 *   npm run report:bp            # → docs/breakpoint-review.md
 *
 * Needs Playwright, which is deliberately NOT in package.json — this repo
 * ships with zero browser-automation dependencies and the two suites that gate
 * every commit (`check:game`, `check`) are pure Node. Install it where you
 * want it and point the script at it:
 *
 *   npm i -D playwright && npx playwright install chromium
 *   # or, if it lives somewhere else already:
 *   NODE_PATH=/path/to/node_modules npm run report:bp
 *
 * `BP_BASE` overrides the dev-server URL, `BP_CHROMIUM` the browser binary.
 *
 * What is measured, per cast (one cast, then 2s of pumped frames so channels
 * and fields finish):
 *
 *   伤害   total hp removed across every body
 *   命中   how many distinct bodies lost any hp
 *   触及   furthest body that took damage, metres from the caster
 *   控制   strongest slow applied (1.00 = a stun) and the longest slow timer
 *   推开   furthest a body was displaced from where it was standing
 *
 * The bodies are NOT frozen. They seek, separate and get shoved exactly as
 * they do in a fight, because M8's whole lesson was that a pinned fixture
 * reports a number the player never sees (a field that throws its own targets
 * clear reads as full damage against pinned dummies and a sixth of it against
 * live ones). The cost of that honesty is noise: two runs of the same skill
 * will not agree to the last point, so treat a Δ under ~5% as no signal.
 *
 * The report says what the engine does. Whether a tier is a *质变* rather than
 * a bigger number is the judgement this is meant to inform, not replace.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  // ESM resolution ignores NODE_PATH; CommonJS resolution honours it, which is
  // what makes the escape hatch above actually work for an install that lives
  // outside this repo.
  try {
    const { createRequire } = await import('node:module');
    ({ chromium } = createRequire(import.meta.url)('playwright'));
  } catch { /* fall through to the message below */ }
}
if (!chromium) {
  console.error(
    'bp-report needs Playwright, which this repo does not depend on.\n' +
    '  npm i -D playwright && npx playwright install chromium\n' +
    '  # or point Node at an existing install:\n' +
    '  NODE_PATH=/path/to/node_modules npm run report:bp'
  );
  process.exit(1);
}

const BASE = process.env.BP_BASE ?? 'http://localhost:5173';
const OUT = fileURLToPath(new URL('../docs/breakpoint-review.md', import.meta.url));
const LEVELS = [1, 3, 5];

const browser = await chromium.launch(
  process.env.BP_CHROMIUM ? { executablePath: process.env.BP_CHROMIUM } : {}
);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(`${BASE}/#run=quick`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.app?.runMode && window.app.run?.active, null, { timeout: 60000 });

/* Install the measurement harness in the page once, then call it per skill. */
await page.evaluate(async () => {
  const app = window.app;
  const settingsModule = await import('/src/config/settings.js');
  window.__bpSettings = settingsModule.settings;
  // A FUNCTION, derived off the combat table — not a hand-kept list.
  window.__bpPermanent = new Set(settingsModule.permanentAuraElements());
  app.time.tick = () => 1 / 60;

  // Ninety casts x 180 frames x a hundred bodies is sixteen thousand frames of
  // full post-processing for a report that never looks at a pixel. Software GL
  // makes that the entire runtime (measured: 45 min and not finished), so the
  // composer is stubbed for the duration. The simulation never reads back from
  // the GL context, so every number below is identical with it or without it.
  const realPost = app.post.render.bind(app.post);
  const realShadows = app.contactShadows.render.bind(app.contactShadows);
  app.post.render = () => {};
  app.contactShadows.render = () => {};
  window.__bpRestoreRender = () => {
    app.post.render = realPost;
    app.contactShadows.render = realShadows;
  };

  const pump = (k) => {
    for (let i = 0; i < k; i++) {
      // Pinned every frame, not once: ninety-six bodies on the caster's face
      // kill it mid-measurement, the run stops, and everything after reads a
      // stopped clock (the M11 count-fix verification hit exactly this — an
      // aura that "dealt 0" because its owner had been dead for two seconds).
      app.playerState.hp = app.playerState.maxHp;
      app.frame();
      // The level-up hand freezes the world (M9 T3's lesson), and casting
      // hands out xp.
      if (app.upgradeUi?.isOpen) app.upgradeUi.close?.();
    }
  };

  // One identical ring every time: eight radii × twelve bearings, so a tier
  // that widens a radius has bodies to find and a tier that lengthens a reach
  // has bodies further out.
  const RADII = [1.5, 3, 4.5, 6, 8, 10, 13, 16];
  const BEARINGS = 12;
  const HP = 50000; // not 1e9 — a Float32's ulp up there is ~64, so small hits vanish

  window.__bpMeasure = (element, level) => {
    const es = app.enemySystem;

    // A clean slate per skill. There are only six seats, so the seventh
    // `acquire()` fails silently — and then `while (levelOf < level)
    // upgrade()` spins on a skill that was never seated. The first cut of
    // this script sat at 100% CPU on skill seven for forty minutes for
    // exactly that reason. Clearing is safer than trying to free one seat.
    app.loadout.seats.fill(null);
    app.loadout._levels = Object.create(null);
    // A previous aura row's ring must retire before the next skill measures —
    // seats are empty now, so this sync is the retirement.
    app._syncAuras?.();
    // acquire() returns the SEAT INDEX, and seat 0 is a perfectly good seat —
    // `if (!acquire(...))` reads a success into seat zero as a failure.
    if (app.loadout.acquire(element) === -1) throw new Error(`bp-report: acquire(${element}) failed`);
    for (let guard = 0; app.loadout.levelOf(element) < level; guard++) {
      // Loud, not silent: a level that cannot be reached is a broken report,
      // not a row to quietly fill with Lv1 numbers.
      if (guard > 20 || !app.loadout.upgrade(element)) {
        throw new Error(`bp-report: ${element} stuck at Lv${app.loadout.levelOf(element)}, wanted Lv${level}`);
      }
    }

    // Put the caster back at the origin so every skill measures from the same
    // spot, and give it the resources to fire.
    app.character.root.position.set(0, app.character.root.position.y, 0);
    app.playerState.mana = 9999;
    app.playerState.hp = app.playerState.maxHp ?? app.playerState.hp;
    app.cooldowns.set(element, 0);

    es.clear();
    const spawn = [];
    for (const r of RADII) {
      for (let b = 0; b < BEARINGS; b++) {
        const a = (b / BEARINGS) * Math.PI * 2;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const i = es.spawnAt(x, z, 0, 0, 0, 0);
        es.hp[i] = HP;
        spawn.push({ i, x, z, hp: HP });
      }
    }

    // M12 T4: an aura is 装备即常驻 — it exists because it is SEATED, and a
    // cast is a no-op for it. Seat-and-sync is the whole measurement; for
    // everything else, cast straight down +x (radially symmetric ring, so
    // the bearing only matters for directional shapes). Shields ride the
    // cast path too: what the ring can see of them is their damage side
    // (石肤's reflect, 冰甲's shatter), which needs bodies actually hitting
    // the player — the ring's own seeking provides that, and the hp pin
    // above keeps the owner alive through it.
    // Only the PERMANENT rings (装备即常驻) measure by seating — 沙暴/环刃斩
    // ride the aura combat kind but are timed CASTS, and the first cut of
    // this branch swallowed 沙暴's cast whole: it went from 945 damage to a
    // flat 0, which is the report un-measuring a skill it used to see.
    if (window.__bpPermanent.has(element)) {
      app._syncAuras?.();
      pump(30); // let the ring stand up before the clock starts
    } else {
      app._quickCastToward(element, 12, 0, false);
    }

    let maxSlow = 0;
    let maxSlowT = 0;
    // 3s. The longest payload in settings.combat is 流火雨's fifth wave at
    // t+2.5s, so a shorter window would quietly under-report a whole skill.
    pump(180);
    for (const s of spawn) {
      if (es.slowed[s.i] > maxSlow) maxSlow = es.slowed[s.i];
      if (es.slowT[s.i] > maxSlowT) maxSlowT = es.slowT[s.i];
    }

    let damage = 0;
    let hits = 0;
    let reach = 0;
    let shove = 0;
    for (const s of spawn) {
      const lost = s.hp - es.hp[s.i];
      if (lost > 0.5) {
        damage += lost;
        hits++;
        const d = Math.hypot(s.x, s.z);
        if (d > reach) reach = d;
      }
      const moved = Math.hypot(es.x[s.i] - s.x, es.z[s.i] - s.z);
      if (moved > shove) shove = moved;
    }
    es.clear();
    return { damage, hits, reach, shove, maxSlow, maxSlowT };
  };
});

/* The roster and the card text are read in Node, off the same modules the game
 * imports — no second copy of either. */
const { settings, ELEMENTS } = await import('../src/config/settings.js');
const { ABILITY_TYPES } = await import('../src/abilities/AbilityManager.js');
const { STRINGS } = await import('../src/ui/strings.js');

const roster = ELEMENTS.filter((el) => ABILITY_TYPES[el]);
const rows = [];

for (const el of roster) {
  const per = {};
  for (const level of LEVELS) {
    // Each level gets a fresh page state for the skill: `loadout.upgrade` only
    // goes up, so measuring 1 → 3 → 5 in order needs no reset, and reloading
    // between every one of ninety casts would triple the runtime for nothing.
    per[level] = await page.evaluate(
      ([e, lv]) => window.__bpMeasure(e, lv),
      [el, level]
    );
  }
  rows.push({ el, per });
  console.log(`  ${String(rows.length).padStart(2)}/${roster.length}  ${el}`);
}

await page.evaluate(() => window.__bpRestoreRender?.());
await browser.close();

/* ------------------------------------------------------------------ */

const pct = (now, base) => {
  if (!base) return now ? '—' : '0%';
  const d = (now / base - 1) * 100;
  const s = `${d >= 0 ? '+' : ''}${d.toFixed(0)}%`;
  return Math.abs(d) < 5 ? `(${s})` : `**${s}**`;
};
const n0 = (v) => Math.round(v).toLocaleString('en-US');
const cardText = (el, tier) => STRINGS.zh?.[`bp.${el}.${tier}`] ?? '—';
const tierOf = (el, tier) => JSON.stringify(settings[el].breakpoints[tier]).replace(/[{}"]/g, '').replace(/,/g, ', ');

let md = `# 质变节点复核报告

> 自动生成:\`npm run report:bp\`。**不要手改这个文件**——改了下次跑就没了。
> 生成时的 HEAD:见 git log。

三十技各两档质变,每一档在这里都有一行**实测**。测法:每次施放前重置到同一个环形靶场
(半径 1.5/3/4.5/6/8/10/13/16 m × 12 个方位 = 96 个假人,各 50000 hp),角色站原点、法力拉满、
冷却清零,朝 +x 放一次,推 120 帧(2 秒)让通道/立场跑完,然后读:

| 列 | 读的是什么 |
|---|---|
| **伤害** | 所有假人掉的血总和 |
| **命中** | 有掉血的假人个数 |
| **触及** | 掉过血的假人里离施法者最远的那个,米 |
| **控制** | 施加过的最强减速系数(\`1.00\` = 眩晕)/ 最长减速计时 |
| **推开** | 任何一个假人被推离原位最远的距离,米 |

**假人不冻结**——它们照常寻敌、互斥、被击退。M8 的教训就是钉死的靶子会报出一个玩家永远看不到的数字
(一个把目标推出自己判定域的立场,对钉死的假人满伤,对活的只交付六分之一)。代价是噪声:
同一技能两次跑不会完全一致,**Δ 小于 5% 的当作没有信号**(下表里这类用括号标出,达到信号的加粗)。

这张表说的是**引擎实际做了什么**。至于每一档算不算「质变而非数值膨胀」——那是这张表要辅助的判断,
不是替代它。

---

| 技能 | kind | 档 | 配置 | 卡面(zh) | 伤害 | Δ伤害 | 命中 | 触及 | 控制 | 推开 |
|---|---|---|---|---|---|---|---|---|---|---|
`;

for (const { el, per } of rows) {
  const kind = settings.combat[el]?.kind ?? '—';
  const base = per[1];
  for (const level of LEVELS) {
    const m = per[level];
    const tier = level === 3 ? 'lv3' : level === 5 ? 'lv5' : null;
    const ctrl = m.maxSlow > 0 ? `${m.maxSlow.toFixed(2)} / ${m.maxSlowT.toFixed(1)}s` : '—';
    md += `| ${level === 1 ? `**${el}**` : ''} | ${level === 1 ? kind : ''} | Lv${level} `
      + `| ${tier ? `\`${tierOf(el, tier)}\`` : '基线'} `
      + `| ${tier ? cardText(el, tier) : '—'} `
      + `| ${n0(m.damage)} | ${level === 1 ? '—' : pct(m.damage, base.damage)} `
      + `| ${m.hits} | ${m.reach.toFixed(1)}m | ${ctrl} | ${m.shove.toFixed(1)}m |\n`;
  }
}

md += `
---

## 怎么读这张表

- **伤害档**(\`damage\` / \`dps\`):Δ伤害应当≈配置倍率。对不上就是读点或放大层出了问题。
- **范围档**(\`radius\` / \`width\` / \`band\` / \`halfAngle\` / \`range\`):看 **命中** 和 **触及**——
  伤害跟着涨是副作用,涨的是覆盖。
- **控制档**(\`slowFactor\` / \`slowTime\` / \`stunTime\`):看 **控制** 列;伤害不动是正常的。
  注意 \`slowFactor\` 是 \`bpReplace\`(整值替换)不是倍率。
- **计数档**(\`count\` / \`hops\`):\`bpAdd\`(加法)不是倍率。**注意**:\`count\` 在剑雨/剑域/日轮
  这三技上加的是**掉落/环绕的刀刃个数**,而伤害走 CombatSystem 的 burst / aura 分支、
  只读 \`damage\`/\`dps\`/\`radius\`——所以这三档加的是视觉密度,不是判定。见下方「已知盲区」④。
- **开关档**(\`castTwice\` / \`extraWave\`):看 伤害 与 命中 是否整段跳。

## 已知盲区(这张表**看不见**什么)

这些空白与零是**量程问题,不是缺陷**——不要照着它们去改数值。

1. **光环自 M12 T4 起测得到**(落座 + \`_syncAuras\` + 钉血 pump,而不是施放)。护盾行
   看到的只是它的**伤害面**(石肤反噬、冰甲碎裂)——需要靶人真的打到玩家,数值随接触节奏
   波动;纯护盾量(\`amount\` / \`duration\` / \`healPlayer\`)仍在量程外,那些行的空白照旧
   不是缺陷。
2. **「推开」这一列基本饱和**:假人不冻结,3 秒里的寻敌与互斥位移远大于技能的击退,
   所以几乎每行都读到 ~9.6m。**击退档不要看这一列**——要单独量。
3. **靶场的环间距会吃掉小幅范围变化**:靶人只在 1.5/3/4.5/6/8/10/13/16 m 这八圈上。
   一个 2.2m 的爆炸放大到 3.08m,如果两圈之间没有人,命中数一动不动——
   陨石、落石、生命绽放、火弹的 \`radius\` 档出现 0% 多半是这个原因,不是读点死了。
4. ~~\`count\` 档只加视觉~~ —— M11 T0 已修:\`bpCountMult\` 从画出来的数量派生伤害倍率,
   剑雨/剑域/日轮 的行现在直接量得到它(剑雨增势实测 +29%)。
5. **落点型技能(zone cast)落在光标处**,而光标固定在 (12, 0)——那一带靶人稀疏,
   所以流火雨/石柱这类会读到 1~3 个命中,负的 Δ 是纯噪声。

一档若三列都没动,先对照上面五条排除量程,再怀疑读点。
`;

writeFileSync(OUT, md);
console.log(`wrote ${OUT}`);
console.log(`skills: ${rows.length}  console errors during the run: ${errs.length}`);
for (const e of errs.slice(0, 5)) console.log('  ! ' + e.slice(0, 200));
