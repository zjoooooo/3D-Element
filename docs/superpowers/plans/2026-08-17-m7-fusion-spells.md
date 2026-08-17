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
- Modify: `src/run/CombatSystem.js`(行解析:`isFusionId(element) ? settings.combat.fusions[pairKeyOf(element)] : settings.combat[element]`;wux 解析双属性:融合时 `wux=子系, wuxB=母系` 传入 damage 系调用(与 Interfaces 约定一致;T1 实现即此序))
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

**机制:** 沿瞄准线去程扫(0→1,0.5s):`damageOnce(castId, 采样点, width 1.6, 85, 子2, 母0)` 段采样(M6 sweep 采样式,类内实现;子=水2/母=金0——'0+2' 即 母0+子2,此行原写反,T5 执行时按 f901b73 定案的约定勘正);到头 0.2s 悬停;回程扫(1→0,0.5s)用**第二 castId**(release 旧 id 再 mint,或类内自持 Set 双份)逐敌判定:`enemies.slowed[i] > 0` 的敌 ×2(必暴,damage 单点 250),其余 125。回程判定需要 per-敌读 slowed → 类内经 ctx.enemies 直读(run-only,null-safe 沙盒去化——沙盒只演 VFX 双程)。
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
- 浏览器全项:五融合逐个 fuse→施放→特性逐条亲验(分叉/三弹/破甲/回程暴/回血落雷);光环父融合后常驻停;金卡升级 1→3 伤害缩放;淬炼对子系金融合生效(= 锋岩星阵——'4+0' 子系金;霜刃洪流 '0+2' 子系是水、母系才是金,按 T1 约定 consumeQuench 只看子系故**不**触发——此行原把霜刃也算进去,T5 勘正,母系金是否也该吃淬炼待用户复核);相生轮转以子系入链;共鸣双计;法力 max(双亲);旧 20 技能回归抽查;沙盒零变化。
- 勘误节填写;**询问用户是否推送**(M6 指令是一次性的,不自动延伸)。
- [ ] 全项 → Commit `Five bonds, five true spells: the pairs keep their promises`

---

## Self-Review 结论(已执行)

- **Spec 覆盖**:§4.7 表五行五列逐一入 T2-T6(蔓延分叉/岩浆弹+熔岩晕/研磨破甲/往返必暴/沼泽回血落雷);双属性规则(更优一系/双印引爆基础/挂子系)入 T1;共鸣双计 pin 入 T1;融合等级 1→3 保留。"可引爆两系印记"半条:挂印走子系单印(v1 单印记架构,勘误注明——引爆语义 wux 传子系已可引爆子系生的印,母系印引爆待多印架构,post-v1)。
- **占位符扫描**:无 TBD;所有数值在表;VFX 以既有构件+色值指名。
- **类型一致性**:`pairKeyOf`/`rowFor`/`applyVuln`/`chainHops(enemies, from, hops, radius)`/`onKillAt(x,z,elite)` 签名各任务一致;wux 参数约定全计划统一(wux=子系, wuxB=母系,单属性 wuxB=-1)。

## 执行后勘误(执行会话填写)

### 续作指引(2026-08-17 更新:M7 全部完成)

**M7 收官。** T1-T7 全部完成、逐任务独立评审通过。下一步按用户 2026-08-17 指令:**编写 M8 计划并完整执行,再编写 M9 计划并完整执行**(计划入 docs/superpowers/plans/,体例与本文件一致:Global Constraints/数值表/逐任务断言先行/文末勘误节)。M8 选题(spec §12 v2 顺序 + 本里程碑债务):第二波主动技能一批(全部映射既有 kind 机器)+ 系统清账(ctx.rng 接线回收三处确定性回退/0.5s 刷新窗入行/挤堆溅射与 _applyDebuff 不对称的裁定落地——凡机制级默认按 spec/约定先做并标待复核)。

### T7 回归收官(2026-08-17)
- sim 报数(200 局/档):新手 0% · 基线 win 59% 死亡中位 **14.0min** · 熟练/高手 100% 等级中位 **29**——全部带内,未调参。
- README 融合段重写为五专属形态一览;verdict top-3 经 `fusionName` 解析(T2 起裸显 fusion id 的既有缺口,本任务一行修复,浏览器断言覆盖)。
- 集成浏览器过项:光环父(bladeorbit)融合后常驻停;金卡 Lv2 → fusionMult 1.25;相生轮转以子系入链(融合后 thunder 半冷却);同局双融合共存;旧技(冰枪/雷枪)回归;沙盒零变化。共鸣双计/法力 max(双亲)/淬炼线在 T1/T4/T5 已各自钉住。
- 移交 M8 的债务台账:ctx.rng 三处确定性回退归拢接线;marsh slow 刷新窗 0.5s 入行;挤堆点打溅射(chainbolt 同族)是否 damageOnce 化;_applyDebuff latest-wins 与 applyVuln 弱不降级强的不对称;vulnStrong(0.25)与锋岩星阵 vulnAmt(0.25)的同幅耦合;MAX_CONCURRENT 驱逐后地贴按自身 life 残留;母系金是否吃淬炼(机制级,须回流 spec)。

<details><summary>已完成任务的旧指引(T6 时点,存档)</summary>

**从 Task 6(回春雷泽)开始。** T1-T5 已完成、已评审。执行顺序:T6 → T7 回归收官。流程:每任务 = 断言 RED → 实现 → 双套件绿(`npm run check:game` + `npm run check`)→ 浏览器逐项 → 评审(独立视角审 diff)→ 修复轮 → 提交;里程碑末 T7 后做全支终审。提交规范见 Global Constraints;**推送需问用户**(本里程碑执行会话按环境交付要求推送到 claude/* 工作分支,主线合并仍由用户裁)。

T6 执行要点(计划正文之外的上下文,T5 会话留):
- 'marsh' 是 CombatSystem 新 kind:tick 增尾参 `playerPos = null`,RunManager 调用处传玩家坐标;旧调用(不传)零回归断言。healInside 走 tick 返回的 healDue 通道(lifebloom 先例——RunManager 花钱,CombatSystem 不碰 player)。
- 落雷类内 self-resolved:`chainHops(enemies, from, 3, 6)` 纯函数直用(ChainBoltSkill 导出);每 0.8s 一道,runRng 选起点敌——注意 ctx.rng 至今**没有**接线(VineBlaze forkPlacement 的勘误注),雷起点若需 rng 要么走确定性回退要么这次真把 ctx.rng 接上(接上要过评审:沙盒不注入)。
- wux=(子1木, 母2水)('2+1' = 母2水+子1木,水生木);挂印/轮转子系木。
- 浏览器验证教训(T4/T5 通用):敌向玩家汇聚,测试敌 hp 抬高防死亡换索引;把机制窗放在敌仍在判定域内的时段;测量窗严格跨过边界再量(T4 栅栏错误);60Hz damage 流的基线击退是否该关要显式决策(T4 kbMult 先例——沼泽 slow 刷新不产击退,但落雷 damage 单点会推,雷是离散打击,保留合理)。
- 双 castId/私有键的 _hitMemory 清理:BladeTide 先例(onDestroy releaseCast 自清);雷的逐跳 damage 不去重(chainbolt 先例)则无此虑。

</details>

### T6 回春雷泽 ThunderMarshSkill
- hybrid 成立(Volcano 同族):池 = combat 行 `kind:'marsh'`(每 tick slow 0.45/0.5s 刷新 + 玩家在内 healDue += 6×amp×step,lifebloom 路由;timed 窗 = travel+impact,T4 规则);雷 = 类内 self-resolved。`CombatSystem.tick` 增尾参 `playerPos=null`(旧 2 参调用零回归,断言钉住),RunManager 一行穿线(tick 本就带 playerPos)。marsh 不碰 damage 族——T1 的 no-op pin 改写为永久语义 pin。
- **数值锚裁定**:计划正文「首击 20、3 跳 ×0.85」与数值表「≈5 道 ×51=255」矛盾(4 击=63.7/道→318)。按 CLAUDE.md「数值即文档」以数值表锚裁定:每道 **3 击**(20+17+14.45=51.45),`boltHits: 3` 为总击数,chainHops 传 boltHits-1。待用户复核。
- **打击按位置不按索引**:chainHops 返回索引,但任一击可击杀→swap-remove→后续索引换体。规划期(零副作用)先取样全链坐标,打击期逐点 `damage(点, 0.05)`——点打命中站在那里的本体,索引腐坏免疫。per-bolt 的 chainHops 返回数组是 per-event 分配(≤5/cast,_critPop 先例);seen Set 实例复用清空。
- ctx.rng 第三次沿用确定性回退(_boltSeq 轮询池内候选)——App 不在文件单,接线待复核(三处回退后建议 T7/M8 真接 `ctx.rng = App.runRng` 一并回收三处)。
- 降级项:计划的「玩家在内脚下回春光环小贴花」跳过——ability ctx 无玩家坐标(App 不在文件单);回血已有血珠/血条反馈。待后续把 playerPos 进 ctx 再补。
- 字面量两处:slow 刷新窗 0.5s(计划正文原字)留在代码(下次触碰时入行为 slowTime);点打半径已提为署名常量 `STRIKE_RADIUS`(ChainBolt HIT_RADIUS 先例)。
- 评审修复轮(测试盲区两钉):①数值锚判别钉——链不饱和(池内 4 敌)下断言每道恰 boltHits=3 次调用、金额 20/17/14.45(「3 跳=4 击」误读必红);②kill-swap 结局契约钉——1-hp 种子被首击杀死、swap-remove 洗牌中途,按 id 断言两跳恰 17/14.45、最后 spawn 的远敌纹丝不动。评审 sabotage 六项中四项本被套件击杀,这两项穿透 → 补钉后闭环。
- 浏览器教训(第三次栽同一坑):远置沼泽里的被减速敌 ~2s 仍会走出池外,后续雷**合法空过**(spec:从沼泽内敌起)——测「5 道全落」须把沼泽施在玩家身上让汇聚敌滞留;基础技(thunder)无 manaCost 字段,期望式要 `?? 0`。另:**浏览器验证在飞时严禁编辑 src/settings/check-game**——vite 全量重载会把截图段炸成加载屏(T5/T6 两次截图废片的真因)。
- **浏览器实测发现(交 T7 sim 复核)**:敌群挤在玩家身上(分离力 vs 汇聚的平衡密度 <0.5m)时,落雷点打的体半径 pad 使单击同时命中相拥多具——实测 5 道在三敌挤堆上落 471(名义 257,×1.83)。chainbolt 同族既有语义(其 HIT_RADIUS 0.6 更宽),数值表按名义链定价;堆叠多付是全点打技的共性,是否收紧(damageOnce 化)待用户/平衡复核。首道在散开阵型下 51.45 精确,名义链无误。

### T1 双属性命中 + 融合施放骨架(ed951a0 + 修复 09d8ab1)
- 约定定案:damage 系尾参 **wux=子系, wuxB=母系**(单属性 wuxB=-1 语义零变);матchup 取双系更优(双被克时取 0.8,不落底 1);挂印/减益/引爆只看子系。计划正文一处母子写反已勘正(f901b73)。
- 融合施放:单 bespoke ability(element=fusion id),row cd × cooldownMult,fusionMult = 1+0.25×(lv-1)(budget 1.2 退役),淬炼子系一次,轮转子系;光环父融合后停常驻(equippedList 驱动,融合 id 不再展开)。
- 修复轮:AimController 暴露 `rawDistance`(_resolve 单命中支同步写,退化时沿用旧值同 direction 约定)→ 融合快速施放落在光标点(近点 3.75m 精确浮点、远点钳 row.range);pairKeyOf 加有界 Map 缓存;'1+3'/'0+2' 补 kind:'self' 哨兵。
- 共鸣双计 M4 起就对(_refreshResonance flatMap),已加 pin;demo 流不触融合卡(已验证)。

### T2 业火燎原 VineBlazeSkill(a3db173 + 70ab21d + 771ba02,两轮修复)
- 主燃区 r2.2/dps45/4s;区内击杀 → 尸位分叉 2 子区(dps27,寿命=主区余量,每 cast 上限 5,子区不再分叉);RunManager 新 `onKillAt` 监听表 fan-out(spawn 订阅/retire 退订,swap-remove)。fusionMult 必须在 **onImpact 读**(onSpawn 先于五字段盖章执行——实现者自查出并 pin)。
- 修复 1:zoneTick 每帧对象字面量分配 → 标量返回/原位累加(CombatSystem._dot/_take 先例);真实链路重入回归测试(区自身 tick 击杀 → 循环中分叉)。
- 修复 2(评审复审实证抓出):模块级 scratch `_pos` 按引用递入 EnemySystem.damage(逐敌重读 point.x/z),重入 _spawnZone 中途改写 → 迭代后段敌人按错圆心判定静默零伤(实证:邻敌死否翻转幸存者 18.3↔20)。修法:重入路径专用 `_forkPos`。**铁律(M4 反应队列教训的姊妹):凡递入可触发重入调用的 scratch,重入路径必须用独立 scratch**——T3 起各融合类均须遵守。
- 分叉全链到上限的实机观察受浏览器节流所限,以真实类头绪化+变异测试证明(报告存档)。

### T5 霜刃洪流 BladeTideSkill(与 T5/T7 计划笔误勘正同押)
- self-resolved 三拍时间线全在类内(impactDuration = out 0.5 + hover 0.2 + back 0.5;fade 纯化妆):去程 M6 sweep 采样式(damageOnce 步距 width,去重免费),悬停零伤,回程逐敌判定(线投影落本帧 [u_now, u_prev] 窗 + 侧距 ≤ width+敌体半径),slowed>0 吃 125×2 必暴、余 125。掉帧跨界各接缝有 flush(out→hover/hover→back/back→fade 三处 + fade 0-flush)。
- **双 dedup 身份防泄漏**:去程键 = `this`(DashStrike castId 先例),回程键 = 构造期单件 `_backKey`;onDestroy 自行 `releaseCast` 两键——RunManager 的 onRetire→release 链只认 CombatSystem 铸的数字 id,类私有键必须自清(断言:destroy 后 `_hitMemory.size === 0`)。
- **wux 勘正(机制级,已按约定执行)**:计划正文 T5 行原写 `(子0, 母2)`,与 pairKeyOf('0+2' = 母0金+子2水)矛盾——f901b73 定案的约定(wux=子系=parents[1])胜出,实现为 **(子2水, 母0金)**,断言钉住两程全部调用。连带 T7 清单「淬炼对…霜刃洪流(子系金)」同错已勘正:'0+2' 子系是水,consumeQuench 不触发(浏览器断言:armQuench 后施放,quenched=false 且充能仍在)。**母系金是否也该吃淬炼,待用户复核**(若要,属机制级变更须回流 spec §4.8 淬炼条目)。
- **回程贴身邻居溅射角(评审 major,修复轮)**:damageOnce 点判按目标体半径 pad,贴身 <0.5m 可互吃对方的点并被对方键值抢记。「slowed pass 先行」只护同帧窗——slowed 敌若在 plain 敌下线恰一帧窗,先被 125 溅射抢记 → **少领必暴**(违反「只朝玩家有利方向错」)。修法:slowed pass 窗口下界前瞻一个最大溅射半径(`look=(0.1+max体半径)/length`),保证 slowed 敌总先被自己的 250 认领;残余错向只剩 unslowed 贴身者多领(允许)。回归钉:贴身对 S=335 精确 / U≥210 下限(U 可被 250 溅射合法多领,断言只钉底)。**教训:凡「按次序消错向」的论证,必须问一句次序在跨帧窗下还成不成立。**
- 评审顺手项同押:dispose 补 `blades.dispose()`(InstancedMesh 实例缓冲,ZoneBurst 先例);fade 分支补对称 out flush 与 ribbon 透明度缓出;wux 记录器测试补双程金额显式钉(防某程静默不跑时 every() 空真);e4 挪到名义带外/体 pad 内的真边界。评审遗留记 T7:两程判定域在线段端点盘凸出/带边收缩处不完全重合(计划字面自带的边缘不对称);`_syncRibbon` options 字面量承袭 DashStrike 已合入先例(每帧一次,若日后收紧零分配铁律到该处,两家一起改)。
- 浏览器实测:去程两敌各 85 精确、回程 85+250/85+125 精确(首轮把冰枪当挂速源污染了参照敌——冰枪是线扫,沿线全被挂速;换小半径直接减速后干净);`_hitMemory` 在**全部 cast 退场后**退净(首轮在冰枪 cast 仍 fading 时量,误报泄漏);armQuench 后施放 quenched=false 且充能保留(子系水不吃淬炼,T7 名单勘正的实证)。

### T4 锋岩星阵 PrismArraySkill(与修复轮同押一提交)
- aura kind 复用成立:band=radius 实心盘退化(断言钉住)+ 行字段 vulnAmt/vulnTime;**研磨窗收窄为 travel+impact**——常驻光环永不进 fade(advance 恒 false、retire 直达 IDLE,评审实读确认),行为逐字节不变;限时阵的 fade 只演棱晶沉降。vuln 施加排在 damageRing 之后(当 tick 不自增幅,次 tick 起自增幅——预算行已计入),幅度传行平值不过 _amp/bpScale(评审补测:fusionMult=2 下 ring amt ×2 而 vuln amt 不动)。
- 类是**首个纯 VFX 融合类**:零 targets 调用,机制全在 combat 行。onSpawn 即停 position 到瞄准点——帧序:combat.tick(App.frame 的 gameClock.advance)先于 abilities.update,手动施放会被以 travel 相位观察到一帧,停点保证那一帧的盘已在目标而非脚下(断言钉住 spawn 后未 update 即就位)。静置=此后无人写 position。
- `applyVuln(point, innerRadius, radius, amt, time)`:镜像 damageRing 环带判定含内缘敌体半径 pad;规则=弱不降级强(幅度**与计时**都不动)/等强刷新计时/更强覆盖并带走计时/过期幅度不挡新申请(vulnT 是唯一活性信号);入口 `Math.fround(amt)`(评审抓:float32 通道下 0.3 类非二进制精确幅度会「强于自身」→ 静默停刷计时)。
- **Critical(浏览器验证抓出,无头复现存档):60Hz 基线击退流弹飞研磨目标。** damageRing 每 tick 每命中记满额基线击退,汇聚敌开局被弹 ~7m、其后 rim-juggle:3s 实落 33 伤 vs 预算 319,仅 19/180 tick 在盘内。修法:damageRing 尾参 `kbScale=1`(默认逐字节同义;0 只关击退,flash/matchup/vuln/挂印不动)→ aura case 传 `row.kbMult ?? 1` → '4+0' 行 `kbMult: 0`。修后 3s 318.4 ≈ 319、180/180 在盘内;bladeorbit 等无 kbMult 行不变。**教训:把 damage 系当 60Hz DoT 流用的新形态,必须显式决定基线击退要不要跟着 60Hz**(glacier/熔岩等既有流的幻想是墙/池,推开合理;「困住研磨」类必须关)。
- 评审遗留(不阻塞,待 T7/用户复核):(a) `_applyDebuff` 仍 latest-wins——阵外残留期,金/木克制命中会以 0.15/4 覆盖阵留的 0.25(阵内每 tick 自愈无感);通道两写手规则不对称,是否统一「弱不降级强」待用户裁;(b) vulnStrong.amount 与阵 vulnAmt 同为 0.25:等强路径会把熔甲尾巴「刷新」成 3s,单边调参时留意;(c) 结算 top-3 直接显示 fusion id 原串(App.js verdict 未走 fusionName,T2 起既有)→ T7 收口;(d) MAX_CONCURRENT 驱逐截断 3s 窗时 CRACK 地贴按自身 life 残留(Vine/Volcano 同族既有);(e) `scripts/sdd/review-package` 的 git diff 不含 untracked 新文件——评审含新类的任务须 `git add -N` 先行或评审员实读工作区。

### T3 地心火山 VolcanoSkill(502c30e,一次通过)
- burst `waves` 通用化:行级可选 `waves:[{delay,damageMult,radiusMult}]`,per-cast 游标 Map 随 release 清理;时序保证:时钟先于 abilities.update,类以 0.25s FLIGHT_TIME 提前挪 position(5× dt 钳幅裕度);纯数据行(无类)也可多波。陨石 Lv5 extraWave 迁移到同通道**逐字节等价**(测试文件 0 删除;_extraDetonated 机器退役)。
- 3 弹 0.6/1.5/2.4 @95/r2.0/晕0.8(晕在 wave 循环内=每波);熔岩池类内自决(VineBlaze 区模式,上限 3,30/1.6/4s;行字段迁至 settings.fusions['3+4'].lavaDps/lavaRadius/lavaLife——combat 行的 burnDps 形状不适配三个独立出格池,已按计划数值表归位);wux (4子土,3母火) 双路径一致;散布种子化(Math.random 仅锥体装饰 yaw)。
