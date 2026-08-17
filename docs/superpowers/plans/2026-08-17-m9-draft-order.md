# M9 抽卡秩序 + 满级异化 + 无尽续玩 + 通道清账 Implementation Plan

> **For agentic workers:** 按 CLAUDE.md 的 SDD 循环逐任务执行:断言先行(RED)→ 实现 → 三门绿 → 浏览器逐项 → 独立评审 diff → 修复轮 → 提交。收尾必查后台任务。

**Goal:** 让 M8 交付的 30 技在**局中后半段**真正可玩——修好被十技静默改坏的抽卡结构,给满级技一个去处,给胜利一个续篇,并把 M8 立下的通道规则补完到最后一个没守的位点。

**Architecture:** 零新系统。四件事各自落在已有机器上:抽卡权重从**按候选计权**改为**按类别计权**(UpgradePool 内一处采样改写);满级异化是 UpgradePool 的**第四种卡面** + Modifiers 的一层 per-skill 修正(复用既有 damageMult/cooldownMult 分层,不碰 settings);无尽是 RunManager 判定 + 一个续玩开关;通道清账是 `EnemySystem.damage()` 补 `kbScale` 尾参(镜像 damageRing/damageCone 已有的形状),zoneTick/lineTick 传速率、burst 传冲量。

**Tech Stack:** 既有;零新依赖。

## Global Constraints

- 数值分层铁律:生效值 = settings 基值 × 局内修正层;任何代码不写 settings。
- 五字段施放不变量;固定步长;零分配热路径;771ba02 scratch 铁律;池化合约;沙盒纯净。
- **M8 通道规则(本里程碑要把它守完)**:任何按 tick 施加的力/控/伤,数值语义必须在通道层讲明是每秒速率还是单次冲量。
- **M8 测试规则**:凡为隔离 A 而冻结 B,必须另有一条不冻结 B 的交付测试;无头 lifecycle 循环必须推 `enemies.tick`。
- 双语 strings;提交自然句 subject + Co-Authored-By 尾注;推送到 `claude/*` 分支。
- 浏览器验证纪律:pump 模式;验证在飞时禁改 src/settings/check-game。
- **机制级新设计(异化条目)按 spec 缺省裁定,勘误标注待用户复核**;纯数值按锚(BASE_DPS 50)。

## 实测基线(本计划的立论依据,已量)

| 现象 | 实测 | 位置 |
|---|---|---|
| 十技入池后新技卡占比(4 席、Lv6) | 68% → **77%**;升级 20%→15%,被动 12%→9% | `UpgradePool.draw` 按候选计权 |
| 同上(2 席) | 78% → **83%** | 同上 |
| snare(zoneTick)逐帧基线冲量 | 峰值 **29.4 m/s** | `EnemySystem.damage()` 无 kbScale |
| 满级技对抽卡的贡献 | **0 张**(`isMaxed` 直接 skip) | `UpgradePool.draw` 升级支 |

---

### Task 1: 抽卡权重按类归一

**Files:** `src/run/UpgradePool.js`(候选按 kind 分桶,先按类别权重选桶、再桶内均匀取;`settings.upgrades.passiveWeights` 语义改为**类别**权重,注释写明)/ `src/config/settings.js`(注释)/ `scripts/check-game.mjs`

**机制:** 现状 `candidates.push({weight, card})` 后整体加权采样 → 类别份额 ∝ 该类候选数,所以注册技能数会静默改变抽卡结构(实测 +9 个百分点)。改为两级:类别按 `passiveWeights` 权重抽,桶内均匀抽。可用类别为空则按剩余类别重新归一(不能因为满座就抽不出牌)。

- [ ] 断言 RED:类别份额**与已注册技能数无关**(注册数翻倍,新技份额浮动 < 3 个百分点);三类权重 3:2:1 在**类别层**兑现(大样本比例检验);空类别归一(满座时新技类缺席而手牌仍满 3 张);既有里程碑保证牌(`milestones` 必出新技)零回归;shard 定向手(`onlyWuxing`)零回归。
- [ ] 实现 → 三门绿 → 浏览器(升到 6 级连抽,肉眼见升级/被动不再被淹没)
- [ ] Commit `Draw by category, not by how many cards happen to exist`

### Task 2: 满级异化(给满级技一个去处)

**Files:** `src/run/Modifiers.js`(新 `mutations: Map<element, Set<id>>` + `mutationMult(element, key)` 查询;沿用 damageMult 的分层)/ `src/run/UpgradePool.js`(第四种 kind `'mutation'`:仅对**已满级且未取满异化**的座位产生)/ `src/config/settings.js`(`upgrades.mutations` 表:通用异化条目 + 每技可取上限)/ `src/ui/strings.js`(异化名/描述 zh+en)/ `src/run/CombatSystem.js` 与各自决类(读 mutationMult)/ `scripts/check-game.mjs`

**机制(本计划新裁,待用户复核):** 满级(平元素 Lv5 / 融合 Lv3)后,该座位改为提供**异化卡**。异化是**通用条目**而非每技定制(30 技定制不可维护),每技最多取 `upgrades.mutationMax` 条,条目从一张小表里抽:
| id | 名 | 效果 | 适用 |
|---|---|---|---|
| swift | 疾发 | cooldown ×0.75 | 全部 |
| heavy | 沉重 | damage/dps ×1.3 | 全部 |
| wide | 扩界 | radius/width/range ×1.25 | 有形状字段的 |
| echo | 回响 | 该技 15% 概率立即再放一次 | 非常驻 |
| pierce | 洞彻 | 无视 0.5 的被克惩罚(0.8 → 0.9) | 全部 |
异化**不写 settings**,只进 Modifiers 的局内修正层(数值分层铁律)。

- [ ] 断言 RED:满级前无异化卡、满级后有;每技上限;`mutationMult` 默认 1(未取即恒等,沙盒/旧调用零回归);swift 折算进 App 的 cooldownMult 链;heavy 折算进 CombatSystem `_amp` 与自决类的手写 amp 链(**两条链都要钉**——M8 T4 教训);wide 对 radius/width/range 三处;pierce 改被克倍率而不动克制倍率;strings 双语齐。
- [ ] 实现 → 三门绿 → 浏览器(把一技升满 → 出异化卡 → 取 swift 后 CD 肉眼变短且 HUD 冷却环同步)
- [ ] Commit `Give a maxed skill somewhere left to go`

### Task 3: 胜利后无尽续玩

**Files:** `src/run/RunManager.js`(`won` 后不停机:新 `endless` 标志,`duration` 之后潮汐继续轮转、难度按分钟继续爬)/ `src/core/App.js`(verdict 面板加"继续"支;续玩中再死 = 正常结算,标注已通关)/ `src/ui/VerdictPanel` 或等价 UI(按钮 + 文案)/ `src/ui/strings.js` / `scripts/check-game.mjs`

**机制:** 到 `settings.run.duration` 判 `won` 并弹结算(现状不变);结算面板多一个「无尽续玩」。选它则 `run.endless = true`、清 verdict、继续跑;此后 tick 不再判 won,潮汐用 `elapsed % 周期` 继续轮,敌人 hp 继续按分钟线性爬。再死时结算标注「已通关 + 无尽 N 分」。

- [ ] 断言 RED:`duration` 前后 verdict 迁移(playing → won);`endless` 后 tick 恒 'playing'(不再重复判 won);潮汐在 duration 之后继续给出合法 wuxing(不越界);hp 缩放在 duration 之后继续增长;续玩中死亡仍判 'dead' 且带通关标记;旧调用(不进无尽)逐字节零回归。
- [ ] 实现 → 三门绿 → 浏览器(pump 到 duration → 见结算 → 点续玩 → 继续打、潮汐照转)
- [ ] Commit `Let a won run keep going for anyone who wants to see how far`

### Task 4: 通道清账(最后一个没守规则的位点)

**Files:** `src/run/EnemySystem.js`(`damage(point, radius, amount, wux, wuxB, kbScale = 1)`——镜像 damageRing/damageCone 已有形状)/ `src/run/Targets.js`(透传)/ `src/run/CombatSystem.js`(burst 传 1 = 单次冲量;zoneTick/lineTick 传 `step`;marsh/自决类同理按语义)/ `scripts/check-game.mjs`

**机制:** `damage()` 是唯一还在无条件施加整发冲量的入口,而 zoneTick/lineTick 每 tick 调它一次(实测 snare 峰值 29.4 m/s)。补 `kbScale` 尾参、缺省 1(**所有既有单次调用逐字节不变**),按 tick 的通道传 `step`。

- [ ] 断言 RED:snare 峰值 |kb| 降到 ≤1 m/s 且伤害不变;burst(boulder/quake)冲量逐字节不变;`damage()` 缺省调用零回归(全库 grep 出的每个调用点各一条);自决类(fireball/dashstrike/chainbolt/破军/雷暴/流火雨/业火/火山/霜刃/雷泽)各自语义显式裁定并注释;**测试必须推 `enemies.tick`**(M8 规则)。
- [ ] 实现 → 三门绿 → 浏览器(站进 snare 不再被推飞、伤害如常)
- [ ] Commit `The last channel learns the difference between a push and a shove`

### Task 5: 回归 + 勘误 + 收官

- [ ] 三套件 + sim(抽卡结构与异化都改变 build 空间,**这次 sim 仍看不见技能表**——如实记录,不得当作平衡验证)/ 抽卡份额复测(T1 的探针脚本入库 or 断言化)/ README 段 / 勘误回填 + CLAUDE.md 状态行 / 后台任务清点
- [ ] Commit `The back half of a run finally has shape`

## Self-Review 结论(已执行)

- **立论有据**:四件事里两件(抽卡稀释、snare 冲量)是本计划**动工前实测**的,数字在上表;两件(异化、无尽)出自 spec §12 v2 清单原文。
- **机器复用**:异化走 Modifiers 既有分层;无尽走 RunManager 既有 verdict;通道清账是把 damageRing/damageCone 已有的 `kbScale` 形状补到 damage();抽卡改的是一处采样。零新系统、零新依赖。
- **风险自查**:①异化条目表是**新设计**(spec 只给了名字),勘误须标注待复核;②`damage()` 加尾参触及全库最热的调用点,必须逐调用点断言零回归;③无尽会让 hp 无限爬,需确认不产生 NaN/溢出(断言钉 60 分钟);④抽卡改采样会影响既有 milestones/shard 定向手,两者都要零回归钉。
- **占位符扫描**:无 TBD;异化五条各有明确倍率与适用面;每任务列了 RED 判别点与零回归 pin。
