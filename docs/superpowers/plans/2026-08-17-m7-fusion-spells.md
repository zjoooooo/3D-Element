# M7 融合专属化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 五个相生融合从 v1 的"双亲齐射+fusionMult"占位实现,升级为 spec §4.7 表定义的**专属形态**(机制+VFX 一体),一个融合 = 一个真技能。

**Architecture:** 融合施放从"per-parent 循环 spawn"改为"单一 bespoke ability(element = fusion id)";CombatSystem 通过 pair-key 解析融合 combat 行;命中层新增**双属性判定**(克制取对目标更优一系,挂印取子系);五个融合类全部**组合 M6 已建机器**(burst 多波/aura 环带静置/sweep 采样/chainHops/burn DoT/onDeath 钩/healDue 路由),不造新轮子。光环父技被融合后**停止常驻**(两技合一,spec 语义)。

**Tech Stack:** 既有 Three.js + 手写 GLSL 管线;零新依赖;全程序化。

## Global Constraints

- 数值分层铁律:生效值 = settings 基值 × 修正层;任何代码不写 settings(勘误 §2)。
- 五字段施放不变量:cooldown / _applySequence / autocast / fusionMult / quenched 每次成功施放显式写;门败全不写(M6 T3 语义)。
- 零分配热路径:per-tick/per-frame 不 new(模块级 scratch;实例级复用 Set/数组)。
- 池化合约:abilities.onRetire → combat.release → enemies.releaseCast;永久体除外(光环先例)。
- 沙盒纯净:`#run` 之外一帧不变——融合只在 run 模式可达(Loadout.fuse 是 run 系统),класс仍须 null-safe(ctx.enemies/ctx.levelOf 缺省不炸)。
- InstancedMesh 世界系实例一律 `frustumCulled = false`(27b8397 惯例)。
- 锚(D-M6-1):BASE_DPS = settings.combat.ice.damage / settings.ice.cooldown = 50;融合预算 = 50 × cd × **1.25 融合溢价**(两席并一席+腾一槽的定价);融合行 EXEMPT 于锚2带检查(self/bespoke 先例),但计划内数值按预算表列明。
- 融合等级:金卡升级仍走 loadout 等级(1→3);伤害缩放 `fusionMult = 1 + settings.fusion.levelMult × (lv-1)`(budget 1.2 退役,溢价已烘进 Lv1 基值)。
- 法力:维持 T3 裁定——融合成本 = max(双亲 manaCost),施放处一次收取。
- 双语:所有新 strings 键 zh + en。
- Commit 风格:自然句 subject + 尾注 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`;只提交不推送(推送在里程碑收官时问用户)。

## 数值表(锚定,控制器已裁)

| pair | 名 | cd | range | 预算(50×cd×1.25) | 关键数值 |
|---|---|---|---|---|---|
| 1+3 | 业火燎原 | 6 | 10 | 375 | 主区 dps 45×4s=180;分叉区 dps 27(×0.6),分叉数 2,全场区上限 5;radius 2.2 |
| 3+4 | 地心火山 | 8 | 9 | 500 | 岩浆弹 3 发 ×95,bombRadius 2.0,散布 ≤4m,喷发期 2.5s;熔岩池 dps 30×4s,lavaRadius 1.6;stunTime 0.8 |
| 4+0 | 锋岩星阵 | 7 | 9 | 437 | 研磨 dps 85×3s=255,radius 3.5(实心盘);破甲 vulnAmt 0.25 / 3s(经既有 vuln 通道,放大一切来源伤害) |
| 0+2 | 霜刃洪流 | 5 | 11(线) | 312 | 去程 85(damageOnce),回程 125,回程对 slowed>0 敌 ×2(必暴);width 1.6 |
| 2+1 | 回春雷泽 | 7 | 10 | 437 | 沼泽 4s:slowFactor 0.45 每 tick 刷;落雷每 0.8s 一道,首击 20、3 跳 ×0.85(≈5 道 ×51=255);玩家在内回血 6/s |

预算核对:业火 180+2×27×4≈396(分叉满打折算 ~85% 达成)✓;火山 285+~120=405≤500(晕+池控场补足)✓;星阵 255×(1+0.25 vuln 自增幅)≈319+全队增伤外溢 ✓;霜刃 85+125×1.5均值≈272 ✓;雷泽 255+heal+slow 控场 ✓。战术档强度,合意。

---

### Task 1: 双属性命中 + 融合施放骨架

**Files:**
- Modify: `src/run/EnemySystem.js`(damage/damageOnce/damageRing 增 `wuxingB = -1` 尾参;`_applyWux(i, amount, wuxing, wuxingB)`)
- Modify: `src/run/Targets.js`(三个透传补尾参)
- Modify: `src/run/fusions.js`(增 `pairKeyOf(fusionId)`:由双亲 wuxingOf 得 `'母+子'` key;增 `FUSION_ROWS` 常量名单导出可选)
- Modify: `src/run/CombatSystem.js`(行解析:`isFusionId(element) ? settings.combat.fusions[pairKeyOf(element)] : settings.combat[element]`;wux 解析双属性:融合时 `wuxA=母系, wuxB=子系` 传入 damage 系调用)
- Modify: `src/core/App.js`(`_quickCast` 融合瞄准借用改读 `settings.fusions[pairKey].range`;`_quickCastToward` 融合支:删 per-parent 循环,spawn 单 ability(element=fusionId),`fusionMult = 1 + settings.fusion.levelMult×(lv-1)`,cd = `settings.fusions[pairKey].cooldown × cooldownMult`,castAnim = 'cast1';`_syncAuras` 融合父不再产常驻;dash 部件钩删除(bespoke 融合无位移——`_castsDash` 相应收窄回 `element === 'dashstrike'`))
- Modify: `src/config/settings.js`(新 `fusions` 顶层块 5 行(cd/range/VFX 参数,数值表照抄);`settings.combat.fusions` 5 行 combat 数据;`settings.fusion.budget` 删除,注释改写)
- Modify: `src/abilities/AbilityManager.js`(registry:fusion id → pair-key → 类映射;T2-T6 类未到前先占 null→cast 返回 null 安全)
- Test: `scripts/check-game.mjs`

**Interfaces:**
- Produces: `pairKeyOf(id): '1+3'` 等;`EnemySystem.damage(point, r, amt, wux, wuxB)`(матchup = 对该敌更优一系:先各算倍率取大;挂印/引爆用 wux **子系**——调用约定:**wux 传子系,wuxB 传母系**,保持既有单属性调用(wuxB 缺省 -1)语义零变);CombatSystem 行解析函数 `rowFor(element)` 导出供断言。
- 共鸣计数保持:Modifiers 席位计数对融合席**两系各 +1**(读现状——M4 已如此则加 pin,不是则修)。

- [ ] **断言先行(RED)**:`_applyWux` 双属性——furnace 场景:火敌(element 3),攻方 wux=(子 0 金, 母 2 水):金被火克 ×0.8、水克火 ×1.25 → 取 1.25;挂印 = 金(子);单属性调用回归不变。`pairKeyOf('fusion:thunder+fireball')==='1+3'`。`rowFor` 融合 id 命中 `settings.combat.fusions['1+3']`。共鸣双计 pin。
- [ ] 实现;融合施放骨架切换(此刻融合施放出 null ability——类未注册,但 cd/蓝/五字段全走通,断言驱动:门败不写、成功写全五)。
- [ ] `npm run check:game` + `npm run check` 绿;浏览器:fuse 后金席施放→cd 转、蓝扣、无报错、无双亲 VFX(过渡态,T2-T6 补类);光环父融合后常驻消失;沙盒零变化。
- [ ] Commit `Teach every hit to weigh two elements and the fusion to cast as one`

---

### Task 2: 业火燎原(木+火)——燃烧藤蔓自蔓延

**Files:**
- Create: `src/abilities/fusions/VineBlazeSkill.js`
- Modify: `src/abilities/AbilityManager.js`(注册 '1+3')
- Modify: `src/run/RunManager.js`(kill 钩广播:`onKillAt` 监听表,death 处理处 fan-out `(x, z, elite)`;fusion ctx 注入订阅句柄)
- Test: `scripts/check-game.mjs`

**机制:** 落点生**主燃区**(radius 2.2,dps 45,持续 4s,burn 类 DoT 走类内 self-resolved 记账:accumulate ≥1 → `targets.damage(pos, r, amt, 子wux, 母wux)` + book);燃区内敌死亡 → 在尸位 **分叉** 2 个子燃区(dps 27,寿命取剩余主区寿命,全场同 cast 燃区上限 5,含主区);子区不再分叉(防指数)。kill 钩:RunManager 死亡处理 fan-out,类 spawn 时订阅、onRetire 时退订(数组 swap-remove,零分配稳态)。
**VFX:** 藤蔓 SDF 地贴(GroundDecals 新 vine 形状或复用 crack 换色 #74d7a8→#e86f4f 渐变)+ 余烬粒子(ParticleSystem 预设)+ 低强度橙光(LightPool);分叉时子区绽放动画(scale 0→1 0.3s)。
**断言:** 燃区 tick 数学(dps×step 累积);死亡分叉(注入 fake kill 事件→子区数+上限截断);子区不分叉;retire 退订(订阅表长度回落)。
**浏览器:** 施放入群→主区烧、怪死处窜出子区、上限 5 截断可见;VFX 辨识(绿藤+橙焰)。

- [ ] 断言 RED → 实现 → 双套件绿 + 浏览器 → Commit `Let the blaze walk the vine and fork at every corpse`

---

### Task 3: 地心火山(火+土)——喷吐岩浆弹

**Files:**
- Create: `src/abilities/fusions/VolcanoSkill.js`
- Modify: `src/abilities/AbilityManager.js`(注册 '3+4')
- Modify: `src/run/CombatSystem.js`(burst 增可选 `waves: [{delay, damageMult, radiusMult}]` 通用化——extraWave 先例升级为数据表;meteor 的 extraWave 标志改走同一通道,行为逐字节不变(断言锁))
- Test: `scripts/check-game.mjs`

**机制:** 落点升起火山锥(0.4s),随后 2.5s 内喷 3 发岩浆弹,各自落在 ≤4m 随机散布点(种子走 runRng 注入,可测),每发 bomb: burst 95 dmg / radius 2.0 + `stunTime 0.8`(既有 slow 通道)+ 落点留熔岩池(lavaDps 30 / lavaRadius 1.6 / 4s,burn DoT 走 combat 行 burnDps 既有机器)。combat 行:`kind:'burst'` + waves 表达 3 弹(delay 0.6/1.5/2.4,damageMult 1,radiusMult 1)+ burnDps/burnTime;弹着散布由类控制 position 每波前挪(CombatSystem waves 读 ability.position——类在 wave 窗口间移动 position 到下一散布点,波序号经 ability 暴露)。
**VFX:** 岩锥 ProceduralGeometry(crystal 重色 #b58f5e 暗岩+顶部熔口辉光);弹道 BurstSphere fire 模式小径抛物线;熔岩池 GroundDecals 辉光贴花(#e86f4f);喷发粒子。
**断言:** waves 通用化(3 波各 95、时点、radius);meteor extraWave 回归逐字节(旧断言不动+新通道等价 pin);stun 挂载;熔岩 DoT 记账;散布 ≤4m(种子固定)。
**浏览器:** 三弹三池、晕怪可见、锥体起落;性能无掉帧(池上限)。

- [ ] 断言 RED → 实现 → 双套件绿 + 浏览器 → Commit `Raise the cone and let the earth spit fire three times`

---

### Task 4: 锋岩星阵(土+金)——棱晶阵研磨破甲

**Files:**
- Create: `src/abilities/fusions/PrismArraySkill.js`
- Modify: `src/abilities/AbilityManager.js`(注册 '4+0')
- Modify: `src/run/CombatSystem.js`(aura kind 增可选 `vulnAmt/vulnTime` 行字段:tick 命中同时经 targets 挂 vuln——EnemySystem 增 `applyVuln(point, radius, amt, time)` 小方法走既有 vulnT/vulnAmt 通道,Targets 透传)
- Modify: `src/run/EnemySystem.js` / `src/run/Targets.js`(applyVuln)
- Test: `scripts/check-game.mjs`

**机制:** 目标点静置阵(3s):combat 行 `kind:'aura'` + radius 3.5 + band = radius(实心盘——band≥radius 时 damageRing 内缘 ≤0 即实心,加断言钉住该退化)+ dps 85;类**不**把 position 挪向玩家(静置=aura kind 直接复用,零 CombatSystem 新 kind);行带 vulnAmt 0.25 / vulnTime 3 → 阵内敌持续破甲(易伤放大一切来源,即"破甲+暴击"的实现语义)。
**VFX:** 5 根金棱晶(LineSweep 晶簇几何重色 #d8b46a)星形起落循环(相位错开),研磨火花粒子,金色五角地贴(GroundDecals)。
**断言:** 实心盘退化(band=radius→圆心敌也吃);vuln 挂载与放大(阵内敌被外源打→×1.25);3s 到期棱晶回收;aura kind 静置(position 不追玩家——пин ability.position 不变)。
**浏览器:** 阵内怪掉血+身上被其它技能打出更大数字;星阵起落可辨。

- [ ] 断言 RED → 实现 → 双套件绿 + 浏览器 → Commit `Plant the five prisms and grind the armour off the horde`

---

### Task 5: 霜刃洪流(金+水)——剑潮往返必暴

**Files:**
- Create: `src/abilities/fusions/BladeTideSkill.js`(self-resolved,fireball 先例:类内 targets+book)
- Modify: `src/abilities/AbilityManager.js`(注册 '0+2')
- Test: `scripts/check-game.mjs`

**机制:** 沿瞄准线去程扫(0→1,0.5s):`damageOnce(castId, 采样点, width 1.6, 85, 子0, 母2)` 段采样(M6 sweep 采样式,类内实现);到头 0.2s 悬停;回程扫(1→0,0.5s)用**第二 castId**(release 旧 id 再 mint,或类内自持 Set 双份)逐敌判定:`enemies.slowed[i] > 0` 的敌 ×2(必暴,damage 单点 250),其余 125。回程判定需要 per-敌读 slowed → 类内经 ctx.enemies 直读(run-only,null-safe 沙盒去化——沙盒只演 VFX 双程)。
**VFX:** 冰晶剑群(swordrain 细刃几何,#6fb8e8 冰蓝+#d8b46a 金边)成潮涌动,去程密回程更密,霜雾 ribbon 尾迹;回程暴击敌头上冰晶炸裂小花。
**断言:** 去程 damageOnce 去重;回程对 slowed 敌 250 / 未减速 125;去回两程同敌各吃一次(双 castId);沙盒 null-safe。
**浏览器:** 冰枪先挂减速再放洪流→回程大数字;往返视觉清晰。

- [ ] 断言 RED → 实现 → 双套件绿 + 浏览器 → Commit `Send the blade tide out and bring it home twice as sharp`

---

### Task 6: 回春雷泽(水+木)——雷雨沼泽

**Files:**
- Create: `src/abilities/fusions/ThunderMarshSkill.js`
- Modify: `src/abilities/AbilityManager.js`(注册 '2+1')
- Modify: `src/run/CombatSystem.js`(tick 增尾参 `playerPos = null`;新行字段组 kind:'marsh':每 tick `slow(position, radius, slowFactor, 0.5)` 刷新 + `playerPos && dist<radius → healDue += healInside×step`;落雷不在 CombatSystem——类内 self-resolved)
- Modify: `src/run/RunManager.js`(combat.tick 调用处传玩家坐标)
- Test: `scripts/check-game.mjs`

**机制:** 落点沼泽 4s:combat 行 `kind:'marsh'`(radius 3.5 / slowFactor 0.45 / healInside 6);落雷:类内每 0.8s 从沼泽内随机敌(runRng)起 `chainHops(enemies, from, 3, 6)`(T6 导出的纯函数直用)逐跳 `targets.damage(单点, 20×0.85^k, 子1, 母2)` + book;无敌可击则该道空过。
**VFX:** 水面贴花(#6fb8e8 半透池)+ 雨丝粒子下落 + 每道落雷复用 ChainBolt 弧光 ribbon(#7ee08a)+ 玩家在内时脚下绿色回春光环小贴花。
**断言:** marsh 行为(slow 刷新到期自然衰减;healInside 只在半径内计入 healDue——tick 传假 playerPos 内/外各测);落雷用 chainHops 且衰减正确;雨落时序(0.8s 间隔,4s ≈5 道);CombatSystem tick 旧调用(不传 playerPos)零回归。
**浏览器:** 站进沼泽血瓶回升可见;雷连环劈;怪在沼里变慢。

- [ ] 断言 RED → 实现 → 双套件绿 + 浏览器 → Commit `Pool the rain, slow the horde, and let the sky answer five times`

---

### Task 7: 回归 + 勘误 + 收官

**Files:** `README.md`(融合段落更新:五融合专属形态一览)/ 本计划文末勘误节 / `scripts/check-game.mjs`(整备)

- 三套件 + sim 复核(融合溢价 1.2→1.25 与 bespoke 形态改变 build 空间;带内即过,越带停下报数)。
- 浏览器全项:五融合逐个 fuse→施放→特性逐条亲验(分叉/三弹/破甲/回程暴/回血落雷);光环父融合后常驻停;金卡升级 1→3 伤害缩放;淬炼对子系金融合生效(锋岩星阵/霜刃洪流 = 子系金→consumeQuench 路径);相生轮转以子系入链;共鸣双计;法力 max(双亲);旧 20 技能回归抽查;沙盒零变化。
- 勘误节填写;**询问用户是否推送**(M6 指令是一次性的,不自动延伸)。
- [ ] 全项 → Commit `Five bonds, five true spells: the pairs keep their promises`

---

## Self-Review 结论(已执行)

- **Spec 覆盖**:§4.7 表五行五列逐一入 T2-T6(蔓延分叉/岩浆弹+熔岩晕/研磨破甲/往返必暴/沼泽回血落雷);双属性规则(更优一系/双印引爆基础/挂子系)入 T1;共鸣双计 pin 入 T1;融合等级 1→3 保留。"可引爆两系印记"半条:挂印走子系单印(v1 单印记架构,勘误注明——引爆语义 wux 传子系已可引爆子系生的印,母系印引爆待多印架构,post-v1)。
- **占位符扫描**:无 TBD;所有数值在表;VFX 以既有构件+色值指名。
- **类型一致性**:`pairKeyOf`/`rowFor`/`applyVuln`/`chainHops(enemies, from, hops, radius)`/`onKillAt(x,z,elite)` 签名各任务一致;wux 参数约定全计划统一(wux=子系, wuxB=母系,单属性 wuxB=-1)。

## 执行后勘误(执行会话填写)

(留空)
