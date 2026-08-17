# M8 第二波主动 + 系统清账 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development(或按 CLAUDE.md 的 SDD 循环手工执行)。逐任务:断言先行(RED)→ 实现 → 双套件绿 → 浏览器逐项 → 独立评审 diff → 修复轮 → 提交。

**Goal:** spec §12 v2 首批——十个新主动(每系两个,§4.3 矩阵内),全部踩既有机器落地;同时清 M7 移交的系统债(ctx.rng 接线、marsh 字面量入行、负拉力 pin)。

**Architecture:** 零新依赖、零新模板类膨胀:四技纯数据挂现有模板(ZoneBurstSkill/LineSweepSkill),两技共享一个新的 TimedAuraSkill 小模板(T4 锋岩星阵机器的登记化),三技各一个小类(处决线/随机落雷/迫击弹幕——全部由 M6/M7 已建构件拼装),**唯一的新判定形状是扇形**('coneTick' kind + `EnemySystem.damageCone`,烈焰喷吐)。CombatSystem 三个 case 各加一个可选行字段(sweep.knockback / lineTick.slowFactor / aura.slowFactor),全部 boulder-式"可选字段,缺省语义零变"先例。

**Tech Stack:** 既有 Three.js + 手写 GLSL;程序化几何/贴花/粒子/丝带复用。

## Global Constraints

- 数值分层铁律:生效值 = settings 基值 × 局内修正层;任何代码不写 settings。
- 五字段施放不变量(cooldown/_applySequence/autocast/fusionMult/quenched);光环(装备即常驻)豁免;**本批"限时光环型"(磁暴/沙暴)是普通施放**,不豁免(锋岩星阵先例)。
- 固定步长、零分配热路径、771ba02 scratch 铁律、InstancedMesh 世界系 `frustumCulled = false`、池化合约、沙盒纯净(新类 bare-ctx 500 tick 不炸)。
- 锚2:新技 damage ≈ BASE_DPS(50) × cd × 形状系数(窄线1.3/宽线1.0/小圈1.1/大圈0.8/弹道1.2);**扇形系数本计划裁 1.1**(小圈级:波及小、贴脸风险高,待复核);持续型(dps×寿命)对同一预算折算;带检查表(check-game 锚2)EXEMPT/SHAPE_COEF 同步扩容,新技必须入检不许静默豁免。
- 法力档:本批六个"强档"技 manaCost 30(磁暴/破军贯穿/冰雹风暴/流火雨/雷暴领域/石柱擎天),四个"持续/轻档"0(荆棘之路/潮汐涌浪/沙暴领域/烈焰喷吐);既有"exactly five tactical @30"断言**有意**改写为档位表驱动(裁定待复核)。
- 双语 strings;提交规范同 M7(自然句 subject + Co-Authored-By 尾注);每任务提交,推送按环境交付要求走 claude/* 分支。
- 浏览器验证纪律(M7 勘误):pump 模式;测试敌 hp 抬高防换索引;机制窗对齐敌滞留时段;量测窗严格跨界;**验证在飞时禁改 src/settings/check-game**(vite 全量重载)。

## 数值表(锚定;dps 型按 dps×寿命≈预算折算;utility 重的行伤害占预算 55-75%)

> **表中的击退/拉力列是计划锚值,不是最终值。** 执行中两处按通道语义改过(潮汐 knockback、磁暴 kbMult/band)——单位(速率 vs 冲量)与实际数字以各任务勘误为准,T7 回归收官请勿从本表反推。

| id | 名 | 系 | 形 | kind | cd | mana | 关键数值(预算) |
|---|---|---|---|---|---|---|---|
| cyclonecut | 磁暴 | 金0 | 小圈1.1 | aura(timed) | 6 | 30 | life 2.5, radius 3.0, band 0.8(环带), dps 80(200/330), **kbMult -1.2 拽向圆心** |
| piercelance | 破军贯穿 | 金0 | 窄线1.3 | self | 8 | 30 | 线长 14, width 0.8, damage 320(/520), **executeBelow 90**(绝对斩杀线,金禁咒同语义) |
| stormfield | 雷暴领域 | 木1 | 大圈0.8 | self | 9 | 30 | life 6, radius 4.5, 每 0.75s 一雷单击 52(7-8 雷 ≈390/360, 略超以补无控) |
| thornroad | 荆棘之路 | 木1 | 持续线 | lineTick | 7 | 0 | life 4(类相位), width 1.2, dps 55(220), **slowFactor 0.3/1s 缠绕**(lineTick 新可选字段) |
| tidalsurge | 潮汐涌浪 | 水2 | 宽线1.0 | sweep | 5 | 0 | damage 190(/250), width 2.6, **knockback 7 水墙推退**(sweep 新可选字段) |
| hailstorm | 冰雹风暴 | 水2 | 大圈0.8 | burst | 8 | 30 | waves 6×{delay 0.35k, damageMult 1/6, radiusMult 0.6→1.0}, 总 320(/320), radius 3.8, slowFactor 0.25/1s |
| flamebreath | 烈焰喷吐 | 火3 | 扇形1.1 | **coneTick** | 6 | 0 | life 1.2, halfAngle 0.55rad, range 5.5, dps 200(240/330, 贴脸补偿) |
| mortarrain | 流火雨 | 火3 | 弹道1.2 | burst+waves | 7 | 30 | 5 弹×80(400/420), bombRadius 1.6, 散布 ≤3.5m(类挪 position, 地心火山机器), burn 无 |
| sandfield | 沙暴领域 | 土4 | 大圈0.8 | aura(timed) | 9 | 0 | life 4, radius 4.2, band=radius 实心, dps 55(220/360), **slowFactor 0.3/0.8s 迟钝**(aura 新可选字段), kbMult 0 研磨 |
| stonepillar | 石柱擎天 | 土4 | 小圈1.1 | burst | 7 | 30 | damage 300(/385), radius 2.6, **knockback 12 抛飞**, stunTime 0.5 |

预算核对:磁暴 200+聚怪 ✓;破军 320+处决 ✓;雷暴 390 纯伤无控 ✓;荆棘 220+缠绕 ✓;潮汐 190+全线推退 ✓;冰雹 320 ✓;喷吐 240+熄灭近战联动 ✓;流火 400 ✓;沙暴 220+迟钝+研磨挂印 ✓;石柱 300+抛飞+晕 ✓。战术档强度一致。

---

### Task 1: 清账 + 十技骨架(ELEMENTS/settings/strings/带检查)

**Files:** `src/core/App.js`(run ctx 注入 `rng: this.runRng` — 沙盒不注)/ `src/abilities/fusions/VineBlazeSkill.js`+`ThunderMarshSkill.js`(rng 在场时走随机支,回退保留)/ `src/config/settings.js`(marsh 0.5 → `combat.fusions['2+1'].slowHold`;十技顶层块+combat 行+wuxingOf+ELEMENTS+ELEMENT_META;`settings.combat` 带检查所需字段齐)/ `src/ui/strings.js`(十技 zh+en)/ `src/run/CombatSystem.js`(marsh 读 slowHold)/ `scripts/check-game.mjs`(锚2 SHAPE_COEF/EXEMPT 扩容;mana 档位表断言改写;rng 注入断言:沙盒 ctx 无 rng pin)

- [ ] 断言 RED:wuxingOf 十行;ELEMENT_META 十行含双语;锚2 新表逐技带内;mana 档位表;marsh slowHold 行为逐字节等价(0.5);ctx.rng:假 rng 注入后 forkPlacement/雷种子走随机支、不注入回退确定性(既有断言不动)。
- [ ] 实现(kind 未实现的技先由 registry null 安全 no-op——M7 T1 先例);双套件绿;浏览器:升级池能刷出新技卡(至少抽查 2 张)、施放 null-op 不炸、沙盒零变化。
- [ ] Commit `Seed ten new arts on the roster and pay the machine debts down`

### Task 2: 纯数据四技(冰雹风暴/石柱擎天 → ZoneBurstSkill;潮汐涌浪/荆棘之路 → LineSweepSkill)

**Files:** `src/abilities/AbilityManager.js`(四注册)/ `src/run/CombatSystem.js`(sweep 增可选 `knockback`(burst 同构);lineTick 增可选 `slowFactor/slowTime`(zoneTick 同构))/ `scripts/check-game.mjs`

- [ ] 断言 RED:sweep-kb(潮汐行敌被推、无 kb 行零回归)/lineTick-slow(荆棘减速、beam 行零回归)/冰雹六波时点与总额/石柱 kb+晕;四技经 CombatSystem 全链 dps 落账。
- [ ] 实现+双套件+浏览器(四技逐个施放:水墙推退可见/雹幕六响/石柱抛飞/荆棘藤路缠绕)→ Commit `Four arts ride the old templates: surge, hail, thorn and pillar`

### Task 3: TimedAuraSkill 模板 + 磁暴/沙暴领域

**Files:** Create `src/abilities/templates/TimedAuraSkill.js`(锋岩星阵机器登记化:onSpawn 停点/静置/impactDuration=life/棱晶换风沙与刃环两套外观参数化)/ `src/abilities/AbilityManager.js` / `src/run/CombatSystem.js`(aura 增可选 `slowFactor/slowTime`)/ `scripts/check-game.mjs`

- [ ] 断言 RED:aura-slow 字段(沙暴敌迟钝、bladeorbit 零回归);磁暴负 kbMult 拉向圆心(kbX 指向圆心 pin,T4 kbScale 负值语义首用);环带 0.8 环切几何;沙暴实心盘+kbMult 0;两技 3s/4s 到期回收;PrismArraySkill 不受模板化影响(如提取共性,锋岩星阵断言逐字节不动)。
- [ ] 实现+双套件+浏览器 → Commit `One timed-ring template, two new fields: the magnet and the sandstorm`

### Task 4: 破军贯穿 + 雷暴领域(两小类)

**Files:** Create `src/abilities/PierceLanceSkill.js`(dashLineHits 采样 + `enemies.executeBelow(线上各采样点, 90)`——金禁咒机器)/ Create `src/abilities/StormFieldSkill.js`(ThunderMarsh 雷机器去池化:每 0.75s 单击 52,rng 种子,T1 接线后随机)/ 注册 / `scripts/check-game.mjs`

- [ ] 断言 RED:破军线伤 once 去重+斩杀线(89hp 敌死、91hp 敌活);雷暴 6s ≈8 雷、单击无链、域外不落;两类 bare-ctx 500 tick。
- [ ] 实现+双套件+浏览器 → Commit `A lance that finishes and a field where the sky keeps answering`

### Task 5: 扇形判定全链 + 烈焰喷吐

**Files:** `src/run/EnemySystem.js`(`damageCone(origin, dirX, dirZ, halfAngle, range, amt, wux, wuxB)`——角度判定 `cos⁻¹(dot)`≤halfAngle 且 dist≤range+敌半径 pad;damage 循环同构含 kb/flash/_applyWux)/ `src/run/Targets.js`(透传)/ `src/run/CombatSystem.js`(新 case 'coneTick':travel+impact 窗,dps×step,读 ability.position+direction)/ Create `src/abilities/FireBreathSkill.js`(1.2s 引导,锥形粒子+光)/ 注册 / `scripts/check-game.mjs`

- [ ] 断言 RED:锥几何(正前中/侧缘 pad 内中/背后与超距不中);coneTick dps 记账;窗外(fade)不判;沙盒退化;喷吐全链落账。
- [ ] 实现+双套件+浏览器(龙息扇面所见即所判)→ Commit `Teach the horde what a cone of fire means`

### Task 6: 流火雨(迫击弹幕)

**Files:** Create `src/abilities/MortarRainSkill.js`(地心火山 waves+散布机器:类挪 position 至各弹落点,无锥无熔岩)/ 注册 / `scripts/check-game.mjs`

- [ ] 断言 RED:五弹时点/散布 ≤3.5(rng 注入与回退双支)/waveIndex 手交;浏览器五响五圈。
- [ ] Commit `Let the sky mortar the field five shells deep`

### Task 7: 回归 + 勘误 + 收官

- [ ] 三套件 + sim(带内即过,越带停下报数——十技入池改变 build 空间,重点看基线中位与熟练胜率)/ README 技能矩阵段更新 / 浏览器全项(十技逐个+两三个旧技抽查+融合回归抽查+沙盒)/ 勘误节回填+CLAUDE.md 状态行 → Commit `Ten more arts take the field and the ledger closes clean`

## Self-Review 结论(已执行)

- **Spec 覆盖**:十技全部出自 §4.3 矩阵原文,机制描述逐条对应(拽向圆心+环切/处决残血/随机落雷/缠绕/水墙推退/持续轰击/扇形龙息/迫击炮弹幕/研磨+迟钝/石柱抛飞——「转向迟钝」以 slow 近似,裁定待复核);§12 分期顺序(其余主动分批第一批)与「模板类×数据配置」实现分层原文一致。
- **机器复用核对**:aura-timed(T4)/waves(T3)/散布挪位(T3)/chainbolt 雷(T6)/executeBelow(M5 禁咒)/dashLineHits(M6)/kbScale(T4)全部既有;新增仅 'coneTick' 一个 kind、三个可选行字段、一个登记化模板类。
- **占位符扫描**:无 TBD;数值全表;每任务断言列表含 RED 判别点与零回归 pin。
- **风险自查**:mana 档位断言改写是既有测试的**有意**变更(表驱动+注释,勘误标注);TimedAuraSkill 提取不许动锋岩星阵一字节(断言锁);扇形系数 1.1 是本计划新裁(锚2 表原无扇形)。

## 执行后勘误(执行会话填写)

### T1 清账 + 十技骨架(664cc21)
- 十技以数据先落地(ELEMENTS/META/combat 行/wuxingOf/cast 块 + light 三件套),类未注册前经 `cast()` 与升级池双闸 inert;锚2 第二块自带 shape 表与解算器(waves 求和、timed dps×life/cd),M6 块相应**限域到它自己的十三技**(计数 pin 单一来源迁至 M8 块)。
- 三笔 M7 债清:`ctx.rng` 接线(App run 支注入 `runRng`,沙盒不注)、marsh `slowHold` 入行、负拉力 `kbMult` 先例入 '4+0' 之外的平元素行。
- **评审 SHIP,带出五项**(逐条已在 T2 处理,见下)。另记两条 Info:hailstorm 以「每波满伤 ×6」表达(53.4×6=320.4,较表 320 +0.13%);计划 T1 的浏览器项「升级池能刷出新技卡」在池门下**不可能达成**——条目本身写错,实际验证的是"未注册 id 永不入池"。
- rng 接线的**顺带影响**:地心火山散布、业火燎原分叉在 run 内由金角回退切换为种子随机(类文档本意如此,但计划只点名两处,故记此)。

### T2 纯数据四技 + 两个可选行字段
- 潮汐涌浪/荆棘之路挂 LineSweepSkill,冰雹风暴/石柱擎天挂 ZoneBurstSkill(BURST_MODE 补 FROST/EARTH);sweep 增可选 `knockback`、lineTick 增可选 `slowFactor/slowTime`,均 boulder 式"缺省语义零变"(beam/rockspikes 零回归断言)。
- **命名统一**:LineSweep 家族的站立时长字段是 `lifetime`,M7 融合家族是 `life`;thornroad 两界都沾,裁定**从模板名 `lifetime`**(不造重复字段),锚2 解算器改读 `life ?? lifetime`——原写法会让 thornroad 以"永续 dps"蒙混过带(实际 55 落在 [30,70] 内属侥幸,已修正为折算 31.4)。
- **浏览器抓出真 bug(WYSIWYG)**:sweep 的 `knockback` 按 tick 施加,而 7 是按单次冲量定的 → 水墙把敌推飞 9.91m、**跑赢自己的伤害**(kbX 20.71,零伤)。裁定:**sweep 的击退是速率(×step),burst 的是单次冲量**——墙持续推过,爆发只炸一次;断言改钉 `knockback/60`。此前另三条 FAIL 是测试自身错误(减速在过期后才量、石柱敌摆在圆心使击退方向退化),已修正。
- **T1 评审五项处理**:①[Major] `kind:'aura'` 被 App 的常驻光环推导吞掉(入座即免费常驻,无 CD 无蓝)——磁暴/沙暴是限时施放,若不修则 T3 注册即撞墙。修法:新导出 `permanentAuraElements()` =「aura 行且**无 life**」,App 五处门统一走它(锋岩星阵靠 fusion id 侥幸躲过,平元素躲不了);②[Medium] 升级卡在 Lv3/Lv5 无条件拼 `bp.<el>.lv3`,第二波无 breakpoints 表 → 卡面漏裸键,改为**该档存在才拼**(sabotage 验证有判别力);③[Minor] VolcanoSkill 陈旧 rng 注释已改(VineBlaze/ThunderMarsh 两处同病同轮已改);④[Minor] SHAPE2 完备性钉已补(每个 wave-2 id 要么受检要么具名豁免);⑤[Minor] `slowHold ?? 0.5` 回退删除——刚收走的字面量不该由回退复活。
- **第二轮浏览器又抓一条同源设计问题**:`targets.knockback` 是**径向**推离给定点,把中心放在波前 → 波未及时把敌推前、掠过后立刻往回拽,净效为零(实测 kbX -0.23)。裁定:**击退中心置于波前后方一个 width**,半径 width×2——墙正在扫过的目标恒在该中心外侧,推力方向即"墙带着走";断言钉住中心坐标(否则回退到波前无人发现)。教训记入:**径向 API 表达"定向推"时,中心点的选择就是方向设计的一部分**。
- 两条 FAIL 属测量误差已修:击退是一次冲量、按 6/s 指数衰减(半秒后只剩十分之一)→ 改**峰值采样**;`slowed` 是 Float32Array,土克水先挂淤塞使击晕 1.0 被翻倍并**封顶 0.9**,而 0.9 存回读为 0.89999998 → 断言改 `> 0.89` 并注明封顶来由。
- **纪律违规自记**:浏览器验证在飞时改了 src(vite 全量重载),污染了那一轮——这正是 M7 勘误里自己写下的禁令,重跑修正。

### T3 TimedAuraSkill + 磁暴/沙暴领域
- 新模板 `TimedAuraSkill`(限时领域:停点/静置/impactDuration=life/环带中线绕行碎片+行半径地贴),注册 cyclonecut/sandfield;aura 行增可选 `slowFactor/slowTime`(沙暴迟钝;三永久环零回归断言)。
- **负 kbMult 首次实用**:T4 建的 `kbScale` 通道传负值即把"推离"翻成"拽向圆心"(磁暴)。~~初版为 -1.2、band 0.8、断言钉「-1.2× 基线」的镜像关系~~ —— **这三项已被下方 Critical 条目全部推翻**(值改 -3.0/s、band 改 2.0、断言改比值 = kbMult/60);读续作指引时以下面那条为准。
- **取舍记录:PrismArraySkill 未重构上模板**。计划措辞是"锋岩星阵机器登记化",但同一节的验收条件是"锋岩星阵断言逐字节不动"。裁定:**新模板独立成文**,已发布并两轮评审过的融合类保持原样——两者共享的是时序契约(停点/静置/life 窗)而非视觉,重构收益是约 40 行样板,风险是动一个已上线机制。若日后第三个限时领域出现,再把三家的共性一次性下沉。
- 两技的"限时非常驻"由 T2 的 `permanentAuraElements()`(aura 行且无 life)保证——这正是 T1 评审预警的埋雷,T3 落地时已是既成事实,注册即安全。
- **Critical(评审+浏览器双路命中):冲量当速率用,第三次。** 磁暴 `kbMult -1.2` 按 60Hz 逐 tick 施加 → 拉力累到约 -45 m/s,敌人 0.1-0.2s 内被吸穿自己的切割环带、进入免疫环眼后彻底空转:实测仅交付 3-11% 预算(浏览器:磁暴 -9 vs 沙暴 -69)。**通道级裁定:aura 的 kbMult 与 sweep 的 knockback 一样是速率(×step),burst 的才是单次冲量**;行值改 -3.0/s。同时 **band 0.8 → 2.0**(环眼 1.0m,窄于一个身位)——"拉向圆心 + 圆心免疫"本身自相矛盾,把眼收窄到聚拢后仍在刀口上。
  **教训(已三犯,记为通道设计规则)**:任何"每 tick 施加"的力/控/伤,数值语义必须在**通道层**明确是速率还是单次;新通道上线时第一件事就是问这句话。M7 T4(研磨基线击退)、M8 T2(水墙 knockback)、M8 T3(磁暴 kbMult)三次同源。
- **地贴族选错(WYSIWYG 反了)**:SHOCKWAVE/DUSTRING 的 GLSL 是一次性外扩环(`radius = pow(age, 0.55)`、`alpha ∝ 1-age`),给 2.5s 的静置场用,前半程把环画在**免疫环眼里**、末段几乎透明却仍满 dps。改用 CRACK 族(`1 - smoothstep(0.55, 1, age)`,前 55% 保持满 alpha)——限时静置场只能用"守得住"的地贴族。
- **其余评审项**:视觉半径/环带补 `bpScale`(平元素真会拿到 breakpoints,融合类的先例在此不成立);aura 的新减速改为**尊重环带内缘**(控制与伤害必须对场的形状给同一个答案,`slow` 增可选 `innerRadius`);删 `instanceCount` 虚报(普通 Mesh 非实例几何);补 sibling 交叉引用注释。
- **测试盲区四补**(评审 sabotage 全绿穿透):kbMult 数据 fixture(原断言自指:两侧读同一个 settings 值,改 -1.0 照绿)、地贴半径 = 行半径、碎片环 = 环带中线、shardCount 存在性。
- **复审 SHIP,残留四 minor 已在 T4 一并收掉**:①永久环零回归无断言(stub 丢第 7 参)→ stub 收全参 + 钉「无 kbMult 行仍是基线 1」;②slow 内缘三种拆法全绿(唯一带 slowFactor 的行是实心盘,新参从未以非零执行)→ stub 收第 5 参 + 合成环带行钉传 `radius - band`;③**单位分叉**:`kbMult` 缺省=冲量、存在=速率,一个字段两套单位,恰是自己刚立的规则的反例 → **三永久环显式写 `kbMult: 60`**(60 × 1/60 = 原冲量,数学等价)、通道收敛为 `(c.kbMult ?? 60) * step`,并加"每个 aura 行必须显式声明 kbMult"的完备性钉;④勘误自相矛盾行已划掉重写。两条新钉均 sabotage 验证有判别力。

### T4 破军贯穿 + 雷暴领域
- 两技均 `kind:'self'`(类内自决),锚2 具名豁免、预算在各自 lifecycle 断言里钉(320/8≈40 对窄线带,52×8/9≈46 对大圈带)。
- 破军:线判定复用 `dashLineHits`(castId = this,DashStrike 先例),**处决沿同一串采样点扫**`executeBelow`——处决脚印严格等于伤害脚印,线外绝不被处决;onDestroy 自行 `releaseCast(this)`(RunManager 的 release 链只认 CombatSystem 铸的数字 id)。浏览器实测整条线四具各吃一次 400、线外零伤、残血被处决 +1 kill。
- 雷暴:每 0.75s 一雷、追帧循环补跳帧;目标选取走 `ctx.rng`(种子可复现)/无 rng 时轮询回退;**按位置打击**(kill-swap 免疫,ThunderMarsh 同宗)。无头钉 6s = 8 道精确;浏览器整轮账面 988(19 道当量)——差额是密堆点打溅射(chainbolt 同族语义,M7 T6 已记),分散摆位下与无头一致。
- 测试夹具教训:处决线断言的"应存活"敌血量必须把**克制加成**算进去(金克木 ×1.25 使 320→400,首版恰好落在阈值线上被误杀)。

### T5 扇形判定 + 烈焰喷吐
- **本里程碑唯一的新判定形状**:`EnemySystem.damageCone(point, dirX, dirZ, halfAngle, range, amt, wux, wuxB, kbScale)` 镜像 damage() 的循环(flash / _applyWux / 反应 flush;击退经 kbScale 门控)。~~首版角判定走点积、并对 dist≈0 开特例~~ → **终版按沿轴/横轴分解**:`offset ≤ along·tanHalf + r`,体半径**两边都 pad**(tank 压边不再零伤),`tanHalf` 循环外算一次,贴脸由 `along≈0 && offset≤r` 天然覆盖(特例已删)。Targets 对无 cone 种群**不降级为圆**(降级成圆会烧到背后),沙盒假人静默贡献 0。
- `coneTick` case:窗口 travel+impact(限时形状规则)、dps×step、顶点取 `ability.origin` 而非 position——龙息从嘴里出来沿瞄准线张开。~~"`spread` 直接取行的 halfAngle,画的扇即判的扇"~~ **这句是错的**:`spread` 是 0..1 抖动不是弧度,详见下方 major 条与终版闭式换算。
- 类是纯 VFX(机制全在行),所以**无头测试必须同时驱动 CombatSystem** 才能看到伤害——首版只推 ability 得 0,是测试写法问题而非实现缺陷。
- **Critical(评审):冲量当速率,第四次。** `damageCone` 内用的是单次冲量击退,却被 coneTick 每 tick 调一次 → 峰值 |kb| 29.5 m/s,喷口前 1.5m 的敌人被吹到 8.15m(飞出 5.5m 扇形),整条引导只交付 **17% 预算**。修:`damageCone` 补 `kbScale` 尾参(镜像 damageRing)、coneTick 传 `(c.kbMult ?? 0) * step`、行显式 `kbMult: 0`(**龙息只烧不推**),并加"每个 coneTick 行必须显式声明 kbMult"的完备性钉。**至此四个通道(sweep/aura/coneTick + 老 damage 基线)全部按同一规则统一。**
- **教训(比 bug 本身更重要):我的浏览器验证把这个 bug 掩盖了。** 为隔离扇形几何,我每帧把测试敌钉回原位并清零 kbX/kbZ——恰好也抹掉了击退,于是读到 243/240"达标"。评审的独立探针(不钉位置 + 驱动 `enemies.tick`)才测出 17%。**规则:凡为隔离 A 而冻结 B,必须另有一条不冻结 B 的交付测试**;无头 lifecycle 循环也必须推 `enemies.tick`,否则任何"把目标推出判定域"的缺陷都不可见。已按此补齐两处(无头一行 + 浏览器一段)。
- **画的扇 ≠ 判的扇(major)**:`ParticleSystem.emit` 的 `spread` 是 0..1 的方向抖动**不是弧度**(实测传 0.55 时 10.2% 的火焰飞出判定扇、内三分之一偏稀),且 `speed = range/life` 忽略了 `uDrag` 的解析阻尼(羽流只到 3.79m / 判定 5.5m,最后 1.5m"看不见火却满伤")。修:引入 `SPREAD_PER_RADIAN = 1/1.61`(经验换算,让羽流外缘落在判定边)与 `plumeSpeed = range·k/(1-e^{-k·life})`(解阻尼方程,19.0 m/s)。
- **角向 pad**:原点积判定只在距离上加体半径、角度上不加,tank(r 0.7)在 5m 处需要 0.14 rad 角向 pad 才公平。改为**沿轴/横轴分解**(`offset ≤ along·tan(half) + r`),两边都 pad、零三角函数于循环内、顺带天然覆盖贴脸例外。
- 其余评审项:补 kbMult 完备性钉、`range` 单一来源钉(施法块与 combat 行必须同值)、贴脸钉、去未用 import。

### T4 评审残留(与 T5 修复轮同押)
- **[major] 自指断言 + 一句不成立的注释**:stormfield/piercelance 是锚2 具名豁免,而 T4 的断言两侧都读同一个 settings 值 —— 把 boltDamage 改成 520、处决线改成 900 **双双全绿**;锚2 的豁免注释却写着"已被 lifecycle 断言钉住"。补数据 fixture(damage/cd/executeBelow/boltDamage/boltEvery/life 六条)。
- **[minor] 处决脚印裸奔**:把 `executeBelow` 的采样半径放大 20 倍、甚至改成全场一发,套件照绿——因为测试里唯一的线外敌满血。补"线外 3.5m、hp 10 的旁观者必须活"。
- **[minor] 五因子 amp 链裸奔**:整条 amp 删成裸 damage 也全绿(夹具里每个因子都是 1)。补淬炼 ×1.5 的比值钉(靶必须用**不被自己克制**的元素,否则首发留下的易伤会把比值抬到 1.725)。
- **[minor] 种子分支无判别**:彻底无视 `ctx.rng` 也全绿(原三条只验各自可复现)。补"常数 rng 必定砸同一具、且与回退序列不同"。
- **[minor] 地贴族又选错一半**:雷暴用 ARC,其前沿 `pow(age, 0.35)` 使 6s 场在 1.5s 时只画到 63% 半径,而落雷从第 0 秒就按满半径选靶 → 改 CRACK(T3 同一教训的复发)。
- 三条 sabotage(击退回退为冲量 / 处决脚印放大 20× / 无视 rng)复核后**均被新钉当场击杀**。
- 待办(记入 T7):`damage()` 自带的基线冲量对 `zoneTick`/`lineTick` 同样逐 tick 施加(实测 snare 峰值 28.7 m/s、thornroad 19.1、beam 17.2)——M8 之前的老账,但本里程碑刚立的通道规则把它变成明账;雷暴"单击"实为 0.5m 溅射盘(密堆下均 3.65 具),文档措辞需回填。

### T6 流火雨
- 地心火山的**波次挪位契约**原样复用、把火山本身拿掉:行的 `waves` 说何时炸、`ability.waveIndex` 说炸过几发、类在每波落地前把 `position` 挪到该发落点——这套握手与火山无关,所以本类只是同一支舞的简版(无锥、无熔岩、五个弹坑走位)。散布走 `forkPlacement`(种子/回退双支,与火山、业火同源)。
- 断言覆盖:五发时点、散布 ≤3.5、**每发在自己的落点炸**(而非都落在瞄准点——这是本类存在的唯一理由)、五坑确实散开、种子双支可区分且可复现、沙盒 null-safe。
- 至此**十技全部注册**;浏览器同轮验了「十技逐个可施放」与「旧技抽查」。
