# M12 五行祭坛 + 角色本命 + 掉落清账 Implementation Plan

> **For agentic workers:** 按 CLAUDE.md 的 SDD 循环逐任务执行:断言先行(RED)→ 实现 → 三门绿 → 浏览器逐项 → 独立评审 diff → 修复轮 → 提交。收尾必查后台任务。

**Goal:** spec §12 v2 清单还欠的两件**局内深度**(五行祭坛、角色本命被动),加上 M11 明账里最疼的一条(首领奖励被拾取上限静默吞掉),和复核报告的光环盲区。这是全任务复核前的最后一个内容里程碑,收官时要把台面清干净。

**范围裁定(按 spec 先做、标记待用户复核,不停车)**:v2 清单剩下的项里,**第三波十技**在 M11 实测过(名册 10→30 全程,一局装上 5.3 / 满级 1.8 纹丝不动)——单局收益近零,不做;**BGM** 是程序化作曲,自成一个里程碑的体量,不塞;**异步多人**的排行榜需要后端,每日种子+分享卡虽可纯前端但属市场面,留给用户点名。这三条都记在文末明账。

**Architecture:** 零新机制层。祭坛的位置**就是**已有的五座法阵石碑(`Arena` 的 `bearingOf` 环),点亮逻辑**就是**已有的 `steleGlowAt` 三档(current/next/idle);认领的奖励走 `onShardHand` 同款定向手牌机器。本命走 `Modifiers.bumpPassive` 已有的 37 被动表——每个角色送一层被动,零新通道。掉落清账在 `PickupSystem.dropAt` 一处改驱逐策略。

**Tech Stack:** 既有;零新依赖。

## Global Constraints

- 数值分层铁律;五字段施放不变量;固定步长;零分配热路径;771ba02 scratch;沙盒纯净。
- **M8 通道规则**:按 tick 的力/控/伤先讲明速率还是冲量。祭坛的引导计时是**时长**(秒),不是每 tick 累积。
- **M8/M9 冻结规则**:冻结 B 隔离 A 必须另有不冻结的交付测试;无头循环推 `enemies.tick`;长推进处理冻结 UI。
- **M10 注入规则**:断言注入的依赖必须另有不注入的验证;新配置键必须有"拿掉读点会红"。
- **M11 镜像规则**:抄 settings 的模型必须能被扰动验证;祭坛给的额外手牌会动成长节奏,**sim 必须看得见**(否则又是四锚哑火)。
- **M11 建模规则**:建模先问是不是单体游戏。
- 双语 strings;提交自然句 subject + 尾注(不带模型标识);浏览器 pump 模式;验证在飞禁改 src。

## 实测基线(动工前已量)

| 事实 | 数字 | 来源 |
|---|---|---|
| 拾取上限 `CAP` | 512,**满员时新掉落静默丢弃** | `PickupSystem.js:54` 自注释 "oldest-gem eviction is M3 polish if ever needed" |
| 满员时丢 14 颗首领宝石,落地几颗 | **0 颗**(全损;浏览器那次 11/14 只因还没满) | headless 探针 |
| 五座石碑的位置 | `bearingOf(i)` 环,半径 = `run.arenaRadius` = **40m** | `Arena.js:108` |
| 走到石碑的代价 | walkSpeed 4.2 m/s → 单程 **~9.5s**;刷怪半径 26m,一路有怪 | settings |
| 每潮时长 | 180s(`tides.length`)——认领窗口真实存在但不白给 | settings |
| 石碑点亮 | `steleGlowAt` 已有 current/next/idle 三档,**当前潮的碑已经在发光** | `Arena.js:40` |
| 定向手牌机器 | `onShardHand`(精英碎片)已存在,`draw(…, onlyWuxing)` 已支持 | `App.js:520` |
| 角色 | **classic / sorcerer** 两个,title 可选;sorcerer 独占翻滚 | `CharacterController.js:28` |
| 本命元素 | `_chosenElement` 已记住、`startRun(element)` 已入席 0 | `App.js:446/665` |
| 被动表 | 37 被动全量,`bumpPassive` 即生效 | `Modifiers.js` |

## Task 1: 首领奖励不再被拾取上限吞掉

**Files:** `src/run/PickupSystem.js` / `scripts/check-game.mjs`

**机制:** `dropAt` 满员时不再一律丢弃:带**显式 value** 的掉落(首领宝石、金雨)驱逐场上**价值最低**的一颗顶替;普通小宝石(kind 0 无显式 value)维持满员即弃——为最常见的掉落做 O(n) 扫描不值得,为全场最贵的一次值得。

- [ ] 断言 RED:满员时丢 14 颗 value=40 的宝石,**14 颗全部落地**,且被顶掉的是场上最便宜的(总价值净增)。
- [ ] 断言 RED:满员时普通宝石仍然丢弃(现行为零回归);未满时两类都直落。
- [ ] 断言 RED:驱逐不破坏数组紧致性(count 不变、无空洞)。
- [ ] 实现 → 三门绿 → 破坏验证(把驱逐改回丢弃 → 红)
- [ ] Commit `The most valuable drop in the game deserves better than the rule for the commonest`

## Task 2: 五行祭坛

**Files:** `src/run/AltarSystem.js`(新)/ `src/config/settings.js`(`run.altar` 块)/ `src/run/RunManager.js`(tick 接线)/ `src/core/App.js`(认领→定向手牌)/ `src/run/RunHud.js` 或 toast / `src/ui/strings.js` / `scripts/check-game.mjs`

**机制:** 每潮**当前元素**的那座石碑成为祭坛:站进碑前 `claimRadius`(~3m)持续 `channelTime`(~1.5s,**时长语义**,离开就清零)即认领,**每潮一次**;奖励 = 一手**该元素的定向牌**(走 `onShardHand` 同款路径)。潮汐换向,上一座熄灭、下一座点亮——`steleGlowAt` 的视觉语言已经在说这件事,现在它说的是真的。危险即代价:碑在 40m 环上、刷怪在 26m,去不去是每潮一次的决策。

- [ ] 断言 RED:认领判定由潮汐推导(当前潮的碑可认领,其余四座不可);`channelTime` 是**秒**(1/60 与 1/6 步长下认领耗时相同——M8 通道规则);离开圈清零重来;每潮恰好一次,换潮重置。
- [ ] 断言 RED:认领回调携带正确元素;真 `RunManager` 驱动(不手工 tick——M10/M11 注入规则);重开局全部复位。
- [ ] 断言 RED:**sim 看得见祭坛**(M11 镜像规则):模型在每潮加一次成长节拍,扰动 `tides.length` 模型跟着动。
- [ ] 断言 RED:`run.altar` 每个键拿掉读点会红(M10 配置规则)。
- [ ] 实现 → 三门绿 → 浏览器(走到当前潮的碑前站 1.5s → 定向手牌弹出;别的碑站着没反应;同潮第二次没反应;换潮后新碑可认领;截图)
- [ ] Commit `The steles were already glowing, now they mean it`

## Task 3: 角色本命被动

**Files:** `src/config/settings.js`(`character.natal` 表)/ `src/core/App.js`(startRun 接线)/ `src/ui/` title 提示 / `src/ui/strings.js` / `scripts/check-game.mjs`

**机制:** 每个角色一条本命被动,开局免费送一层,走 `bumpPassive` 既有通道:**sorcerer → swift**(翻滚角色,机动本命)、**classic → vitality**(站桩角色,厚血本命)。表驱动(`character.natal: { classic: 'vitality', sorcerer: 'swift' }`),加角色即加行。

- [ ] 断言 RED:startRun 后本命被动为 1 层(另一角色的不受影响);`modifiers.reset()` 后重开局**再次**生效(顺序缺陷高发处);被动等级上限不被本命层突破(natal + 抽满 = 仍钳在 max)。
- [ ] 断言 RED:表里的被动 id 必须存在于 `PASSIVES`(防拼错静默无效——M10 配置规则的变体)。
- [ ] 断言 RED:沙盒零影响(无 run 不发)。
- [ ] 实现 → 三门绿 → 浏览器(title 选角色 → 开局 build 摘要里能看到本命行;切角色换行)
- [ ] Commit `Each body arrives knowing one thing`

## Task 4: 复核报告的光环盲区

**Files:** `scripts/bp-report.mjs`

**机制:** 光环/护盾整技在报告里全零(量程盲区第 1 条)。T0 清账时的验证脚本已经证明了正确测法:**落座 + `_syncAuras` + 钉血 pump**,而不是施放。报告对 `kind: aura` 的行改用该测法;护盾里能打伤害的(石肤反噬、冰甲碎裂)顺带收进来,纯护盾明确标注「量程外」而不是留零。

- [ ] 报告重跑:剑域/日轮/燃阵/沙暴各档不再是 0,`count` 修复(×1.40/×1.33)在报告表里可见。
- [ ] Commit `The report stops being blind to the rings`

## Task 5: 回归 + 勘误 + 收官(全任务复核的台面)

- [ ] 三套件 + sim(锚:新手0%/基线死亡中位~13min/熟练100%/等级中位~37;祭坛入模后按实报数)/ `report:bp` 重跑 / README 段 / 勘误回填 + CLAUDE.md 状态行(队列指向「全任务复核」)/ 后台任务清点
- [ ] Commit `The board is clean for the audit`

## Self-Review 结论(已执行)

- **立论有据**:满员全损 0/14 是跑出来的;石碑位置/走路代价/认领窗口全部量过;两角色与本命接线点都核实过。
- **机器复用**:祭坛 = 石碑(已有)+ steleGlow(已有)+ 定向手牌(已有);本命 = bumpPassive(已有);清账 = dropAt 一处。全里程碑唯一新文件是 `AltarSystem.js`。
- **风险自查**:①祭坛给的额外手牌动了成长经济,sim 不入模就是 M11 哑火重演——已立断言;②本命在 `modifiers.reset()` 之后生效的顺序是最容易错的一处,restart 路径单独断言;③认领计时是时长不是累积,M8 规则断言;④满员驱逐别把 O(n) 扫描带进普通宝石的热路径。
- **占位符扫描**:无 TBD。

## 明账(动工前就记)

1. **第三波十技不做**:M11 实测名册规模对单局三指标零影响。要做等用户点名。
2. **BGM 不做**:程序化作曲自成体量。**待用户复核**是否要排。
3. **异步多人不做**:排行榜要后端;每日种子+分享卡可纯前端,**待用户点名**再排。
4. **祭坛奖励选了定向手牌而不是临时元素增伤**:增伤对没带该系技能的玩家是死奖励,手牌永远有意义,且复用既有机器。**机制级新裁,待用户复核**。
5. **本命被动选了送被动层而不是本命系增伤**:走既有 37 被动表,零新通道;sorcerer→swift / classic→vitality 的配对是新裁。**待用户复核**。

---

## 执行后勘误(M12 收官回填)

### 一、与计划的实际偏差

| 计划怎么写 | 实际怎么做 | 为什么 |
|---|---|---|
| 祭坛认领接 App 新代码 | **App 零新接线**:`RunManager.start` 里 `altar.onClaim = onShardHand` | 精英碎片的定向手牌路径连冻结门/死局守卫/空手回血全带着,一行借完 |
| 本命只在 startRun 发一层 | 还得先让 `character.id` **存在** | `CharacterController` 从不记录台上是谁——`grantNatal(mods, undefined)` 会对所有人静默不发。M10 注入规则的浏览器半边抓到的,source-pin 半边看不见 |
| T1 三条断言 | 第二条夹具磨了一轮 | 同分钟填场+同分钟掉落,价值相等被「不亏本换」守卫挡住——**等值夹具分不出「普通宝石不驱逐」和「普通宝石拒绝平换」**。换成晚 7 分钟的宝石才红 |

### 二、破坏验证记分

- T1:3 条,S3 初测绿(上面那条夹具课),补后全红。
- T2:**7 条一次全红**(tick 计数 / 存钱罐 / 一潮两领 / 公式抄漂 / 不推 / 不接线 / 节奏写死)。
- T3:4 条全红(不发 / reset 前发 / 表拼错 / 跳上限)。

### 三、重标(祭坛入模后)

四锚全部保持:**新手 0% / 基线死亡中位 13.0min / 熟练 100% / 等级中位 37**。
基线胜率 27%→34%——祭坛手牌的收益,方向正确(它就是给基线档兜底的)。
祭坛在模型里是「每潮一次、按 kite 概率认领、值半级」;`altarEvery()` 是函数不是快照,扰动 `tides.length` 模型跟着动(M11 镜像规则)。

### 四、明账未收

1. **祭坛奖励选了定向手牌**(不是临时元素增伤)——增伤对没带该系的玩家是死奖励。**机制级新裁,待用户复核**。
2. **本命配对 sorcerer→疾行 / classic→活力 是新裁**。**待用户复核**。
3. **纯护盾量仍在报告量程外**(`amount`/`duration`/`healPlayer` 作用在玩家身上);报告脚注已改口,不再把这些空白记作缺陷。
4. **第三波十技 / BGM / 异步多人 本里程碑明确不做**,理由见计划头。每日种子+分享卡可纯前端,**待用户点名**。
5. 祭坛没有专属音效(认领共用手牌音);属打磨项。
