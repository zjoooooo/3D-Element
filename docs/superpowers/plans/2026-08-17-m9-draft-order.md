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

## 执行后勘误(执行会话填写)

### T1 抽卡权重按类归一(88b487b + 修复轮)
- 根因:`passiveWeights` 被**按候选**计权,某类份额 ∝ 该类卡数 → 注册技能数静默改写抽卡结构。改为两级采样(按类别权重选桶 → 桶内均匀)。
- **数值取自单一状态,读时须带上下文**:计划表里的 68%→77% 与修复后的 35/47/17,都是「4 席 / Lv6 / 尚有空位」这一快照。份额随席位数变化很大(实测:1 席 29/47/24、2 席 45/37/18、3-5 席 49/35/16、满座 75/0/25)——因为**类别权重只在该类有牌可发时兑现**,卡数少于手牌数的类别会在一手内被抽干(开局只有 1 个座位 = 1 张升级卡)。评审另按整局(2→29 级)实测的真实构成是 **upgrade 66.1% / passive 22.7% / new 10.1% / fusion 1.0%**,与快照差约 30 点,同样是因为六席一满 `new` 类整体缺席。
- **订正一处说法**:计划与评审简报都写过「shard 定向手走 `_take` 而非新函数、逐字节零回归」——**这是错的**。定向手同样流经 `while` 循环进 `_takeByCategory`,其 upgrade:new 配比由「按候选」变成「按类别 3:2」。契约(只发该五行、无被动)仍成立且方向与本任务一致,但不是逐字节不变。
- **评审 BLOCK,三个 major 已收**(三处此前都能全绿穿透,现各有 sabotage 验证):
  1. 「空类别归一」原本只钉张数不钉比例 → 把分母改成常量、缺席类权重泄漏给最后一类时,满座手牌从 75/25 变 50/50 而套件全绿。现加**满座 3:1 比例断言**(sabotage 实测 1.02:1 被抓)。
  2. 「桶内均匀」零覆盖 → 改成永远返回 `inKind[0]`(每手新技永远同一个、被动永远 swift)照样全绿。现加**桶内成员多样性断言**(sabotage 实测只见 4 个成员被抓)。
  3. `weightOf` 的兜底 `: w.passive` 让**未知 kind 静默拿到被动权重**——正是本任务要消灭的失效模式在修复自身里的复现;评审按 T2 的形状注入 `'mutation'` 候选,实测静默发出 14.9% 异化卡、无报错无 settings 条目。现改**显式查表 + 未知 kind 抛错**,并加断言。**T2 加 `'mutation'` 时必须同时在 `passiveWeights` 里声明其权重**,否则立刻抛错——这是有意的。
- 顺收 minor:出厂权重 3:2:1 加独立数据钉(原比例断言自指,改权重永远不红);`shares()` 夹具包 try/finally(否则抛异常会让后续两千行断言跑在少十技的注册表上);roster-independence 阈值 0.03 → 0.005(设计上恒为 0,实测漂移 0.00)。
- 未收(记账):`roll <= 0` 的兜底使权重为 0 的首位类别在 `rng()` 恰为 0 时仍可能被选中(与既有 `_take` 同宗);候选上的 `weight` 字段现在身兼类别权重与桶内均匀两职,后者是**偶然性质**——若将来给同类卡不同权重,桶内均匀会失效(已有多样性断言可抓)。
- **结构后果(T2 要补的洞)**:六席坐满后手牌退化成升级/被动两类 75:25,再无横向选择;全满级 + 被动满的极端局会让 `draw()` 返回空手牌走 skip-heal(既有行为,非本任务引入)。

### T2 满级异化(ff6d311)
- **计划的五条异化砍到四条,两条被删并记明理由**(不是遗漏,是范围裁定):
  - `wide`(形状 ×1.25)删除:形状数字散落在约十个自决类里(它们各读各的 settings 块),只在 CombatSystem 里挂一层会让**半数技能吃不到这张卡**,而卡面写着"扩界"。承诺做不到的事不如不做。
  - `pierce`(被克 0.8→0.9)删除:伤害路径只带 **wuxing 不带技能 id**,按技能改克制倍率要把 element 穿过每一个 damage 调用——为一条异化不成比例。
  - 补一条 `overload`(伤害 ×1.6 / 冷却 ×1.5)作取舍型条目。**留下的四条全部只用既有分层**:damageMult(element)、cooldownMult(element)、echoChance(element)。
- 命名避让:`swift`/`echo` 已是被动 id,异化用 `quicken`/`encore`。
- API 变更:`cooldownMult()` 与 `echoChance()` 加可选 element 尾参(缺省 = 原全局值,四个调用点全部改为按技能传);异化**乘在**全局被动之上而非替换(断言钉住)。
- **T1 的护栏当场咬到 T2**:新增 `'mutation'` kind 第一次跑就抛"没有声明类别权重"——正是 T1 修复的设计意图。权重定为 3(与升级同档:满级座位该和升级座位手感一致)。
- 一条既有断言被**有意改写**:M4 的「满级满座只发融合卡」不再成立(满级技现在发异化卡),已改为"融合金卡 + 异化,直到异化也满额才只剩金卡",并注明是行为变更。
- 浏览器 10/10;一处覆盖缺口记账:「异化只作用于自己那一技」在浏览器里因 `#run=quick` 只有一个座位而跳过,无头断言已覆盖。

### T3 无尽续玩(ff6d311)
- **`tideAt` 会钳在最后一个潮汐**——局内看不出来(五个潮汐正好覆盖 15 分钟,索引够不到边界),无尽下潮汐会永远冻住、`timeLeft` 钉死在 0。已改为**回绕**,并断言钉住局内行为不变。
- `run.endless` 标志:置位后 tick 恒不再判 'won',死亡仍判 'dead';`stop()` 只翻标志不清状态,所以恢复是安全的。
- 入口用 **N 键**(Space 已被翻滚占用、Enter 是重开);结算面板按 `canContinue = won && !endless` 给出入口,续玩后死亡的结算标注「已通关」。offer 只给一次。
- **浏览器抓出一个真 bug(无头测试结构性看不见)**:续玩的门原本写成 `this._verdict.value === 'won'`,而 App **每帧把 `_verdict.value` 重置为 `'playing'`**——那段代码自己的注释就写着「是否在结算画面只能由 `!run.active` 如实回答」,我没读到就用了它。结果:面板给出入口、按 N 毫无反应,`active=false endless=false`。修法:在结算那一刻把结果记进 `this._wonThisRun`(那是唯一为真的时刻),门改读它。
  **为什么无头测试抓不到**:T3 的无头断言用 `offer(won, endless)` 手工镜像了 App 的两个标志,而没有驱动 App 本身——镜像出来的是我以为的逻辑,不是实际跑的逻辑。**教训:凡"某标志在事件后还读得到"这类假设,必须由真实帧序验证,镜像式断言对它天然无效。** 已补一条无头钉,钉住"事后可读的是 `run.active`/`run.endless` 而非 verdict 值"。
- **第二轮浏览器又红三条,这次是测试自身的问题**:推进 60 步(模拟十二分钟)会让玩家升级、**升级手牌弹出并冻结世界**,`run.tick` 停摆,于是后续的死亡登记不了、结算不出现。取证两步:先做隔离探针(单独走一遍死亡 → 一帧就正常结算,证明机制没坏),再把那段循环加回探针 → 复现且 `frozen: true`。修法是让测试像真人一样处理手牌(弹出就选掉),并加一条 `世界未被手牌冻住` 的前置断言,免得同一陷阱换个面目再来。终局 13/13,结算标题实测「倒下了 · 已通关」。
  **教训**:长时间推进的浏览器测试必须处理**会冻结世界的 UI**(升级手牌、暂停菜单),否则后半段的断言全部测在停摆的时钟上——失败信息只会说"没发生",不会说"因为世界停了"。

### T4 通道清账(ab5ecfb)
- `EnemySystem.damage()` 补 `kbScale = 1` 尾参(镜像 damageRing/damageCone 已有形状),Targets 透传。**三处按 tick 的调用传 `step`**(lineTick / zoneTick / burst 的燃烧 dot);**detonation 保持整发冲量**(缺省值,所有一次性调用逐字节不变);**燃烧地面传 0**(业火燎原燃区、地心火山熔岩池——一摊火不推人,沿用沙暴"研磨不推"的裁定)。
- 实测 snare 峰值 **30.6 → <1.5 m/s**,伤害不变。至此**四个通道全部按同一规则统一**(M7 T4 研磨 / M8 T2 水墙 / M8 T3 磁暴+龙息 / M9 T4 damage)。
- **夹具两次踩坑,都值得记**:①场摆在场地中央会在一秒内被走空、量到的是"走出去"而不是"被推开"(M8 已立的规则,自己又犯一次)→ 场要摆在敌人汇聚点;②测试假人给 1e9 血**根本吃不到伤害**——hp 是 Float32Array,1e9 处 ulp 约 64,亚 1 点的 DoT tick 全被浮点吃掉,看起来像"场是哑的"。

### T5 收官
- 三套件绿;`npm run sim` 四锚全中(新手 0% / 基线死亡中位 14.0min / 熟练 100% / 等级中位 29)。
- **同一条诚实限制照旧**:sim 既不读技能表**也不读抽卡池**(纯抽象模型,每级 `dps *= bot.gain`),所以它对 T1 的抽卡结构改动、T2 的异化、T3 的无尽**全都看不见**。四锚全中只说明难度模型未被改动,**不构成对本里程碑任何一项的平衡验证**。
- 未收(明账,交给后续里程碑):
  1. 异化目前是**通用四条**,不是每技定制——spec 只给了"满级异化"这个名字,条目表是本计划新裁,**待用户复核**。
  2. 满座且全满级全异化时手牌仍会退化为空 → skip-heal(既有行为)。
  3. `wide`/`pierce` 两类异化若要做,前置是"形状读取集中化"与"伤害路径带技能 id",都是独立工作量。
  4. 无尽的难度曲线是线性外推(hp 按分钟线性爬),没有专门的无尽平衡;跑够久必然不可生存,这是设计取舍不是缺陷。
