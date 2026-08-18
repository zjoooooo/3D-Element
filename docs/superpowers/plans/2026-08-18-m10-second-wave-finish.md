# M10 把第二波做完:质变节点 + 扇形指示器 Implementation Plan

> **For agentic workers:** 按 CLAUDE.md 的 SDD 循环逐任务执行:断言先行(RED)→ 实现 → 三门绿 → 浏览器逐项 → 独立评审 diff → 修复轮 → 提交。收尾必查后台任务。

**Goal:** M8 交付的十技是"能打但没有纵深"的半成品——**全部十技没有 Lv3/Lv5 质变节点**,而 M9 刚把升级卡拉到手牌的约 47%,于是这十技的升级成了全场最平淡的一档体验。本里程碑把第二波补完:十技各拿两个质变节点,加上它们唯一还欠的判定层可读性——扇形技至今用**直线**指示器预览一个扇形。不开新系统。

**Architecture:** 零新机器。质变走 M6 T12 已建的 `breakpoints.js` 四动词(bpScale/bpAdd/bpReplace/bpFlag)与各 kind 已有的消费点;绝大多数条目是**纯数据**(乘数),只有需要"开关型"变化的少数用既有 `bpFlag` 通道(陨石 extraWave / 冰枪 castTwice 是先例)。扇形指示器在既有 AimIndicator 的 SDF 里加一个形状分支 + `CastShape.CONE`,与 ZONE 的圆形指示器同宗。

**Tech Stack:** 既有;零新依赖。

## Global Constraints

- 数值分层铁律;五字段施放不变量;固定步长;零分配热路径;771ba02 scratch;池化合约;沙盒纯净。
- **M8 通道规则**:按 tick 施加的力/控/伤,语义必须在通道层讲明速率还是冲量。
- **M8/M9 测试规则**:凡为隔离 A 而冻结 B,必须另有一条不冻结 B 的交付测试;无头 lifecycle 循环必须推 `enemies.tick`;**长时间推进的浏览器测试必须处理会冻结世界的 UI**(升级手牌/暂停菜单),否则后半段测在停摆的时钟上;**"某标志在事件后还读得到"这类假设不能用镜像式断言验证**,必须驱动真实帧序。
- 双语 strings(每个质变一条 `bp.<el>.lv3` / `.lv5`);提交自然句 subject + 尾注;推送到 `claude/*` 分支。
- 浏览器验证纪律:pump 模式;验证在飞时禁改 src/settings/check-game。
- **质变条目是本计划新裁**(spec 未逐技指定),勘误标注待用户复核;数值按锚(BASE_DPS 50),质变是**质的变化不是数值膨胀**——每档目标提升约 25-35%,与 v1 十四技的既有档位同量级。

## 实测基线(动工前已量)

| 事实 | 数字 | 来源 |
|---|---|---|
| 全表 30 技中有质变表的 | **14**(全部是 v1 批次) | grep settings.js |
| 第二波十技有质变的 | **0 / 10** | 同上 |
| 升级卡在手牌中的占比(M9 后) | 约 **47%**(2-5 席) | M9 T1 探针 |
| 扇形技的瞄准预览 | 画**直线**,判定是扇形 | M8 T5 勘误自记 |

## 质变设计(每技两档;金木水在 T1,火土在 T2)

| 技 | Lv3 | Lv5 | 动词 |
|---|---|---|---|
| cyclonecut 磁暴 | radius ×1.3 | 拉力 kbMult ×1.6 | bpScale |
| piercelance 破军贯穿 | width ×1.5 | executeBelow ×2.0 | bpScale |
| stormfield 雷暴领域 | radius ×1.25 | boltEvery ×0.7(更密) | bpScale |
| thornroad 荆棘之路 | width ×1.4 | slowFactor → 0.5 | bpScale / bpReplace |
| tidalsurge 潮汐涌浪 | width ×1.3 | knockback ×1.8 | bpScale |
| hailstorm 冰雹风暴 | radius ×1.25 | damage ×1.35 | bpScale |
| flamebreath 烈焰喷吐 | halfAngle ×1.35 | dps ×1.3 | bpScale |
| mortarrain 流火雨 | radius ×1.3 | damage ×1.3 | bpScale |
| sandfield 沙暴领域 | radius ×1.2 | slowFactor → 0.45 | bpScale / bpReplace |
| stonepillar 石柱擎天 | radius ×1.3 | stunTime ×1.6 | bpScale |

> 全部落在**已有消费点**上:每一项在 CombatSystem 或对应类里都已经有 `bpScale(el, key, level)` 的读点(M8 各任务逐个确认过),所以这批是数据 + 断言,不是新代码路径。`boltEvery`/`executeBelow`/`knockback`/`kbMult`/`stunTime` 五个键需要确认读点存在,不存在的当场补读点并单独断言。

---

### Task 1: 金木水六技的质变(+ 键位读点确认)

**Files:** `src/config/settings.js`(六技 breakpoints)/ `src/ui/strings.js`(十二条 bp 串 zh+en)/ 必要时 `src/run/CombatSystem.js` 或对应类(补缺失的 bpScale 读点)/ `scripts/check-game.mjs`

- [ ] 断言 RED:每技两档存在;**每个键都真的被消费**(Lv1 与 Lv3/Lv5 的实际生效值之比 = 表值,经真实 tick 而非读表);`bp.<el>.lv3/.lv5` 双语齐且中英不同;升级卡在该档显示质变行(不是裸键);未到档位 = 恒等。
- [ ] 实现 → 三门绿 → 浏览器(把一技升到 3/5,卡面出现质变行,效果肉眼可辨)
- [ ] Commit `Six of the second wave learn to change, not just grow`

### Task 2: 火土四技的质变

**Files:** 同上,四技

- [ ] 断言 RED:同 T1 的五类断言;**扇形的 halfAngle 质变必须同时改变画与判**(M8 T5 的画/判对齐是解出来的,不是常数,所以 bpScale 后仍须相等——这条单独钉)。
- [ ] 实现 → 三门绿 → 浏览器 → Commit `The last four of the wave get their turning points`

### Task 3: 扇形瞄准指示器

**Files:** `src/config/settings.js`(`CastShape.CONE` + flamebreath 的 META 改用它)/ `src/effects/AimIndicator.js`(SDF 加扇形分支,读行的 halfAngle/range)/ `src/core/App.js`(castShapeOf 的分支)/ `scripts/check-game.mjs`

**机制:** 扇形技预览画**扇**不画线,张角与射程直接读 combat 行(与判定同源,WYSIWYG),并跟随 bpScale——升到 Lv3 张角变大时预览同步变大。

- [ ] 断言 RED:`castShapeOf('flamebreath') === CastShape.CONE`;指示器的张角/射程 = 行值 × bpScale(与 damageCone 收到的参数逐值相等——**同源钉**);其余技的形状零回归(LINE/ZONE/SELF 各抽一个);沙盒不受影响。
- [ ] 实现 → 三门绿 → 浏览器(举起喷吐:地面画出扇形,张角与实际灼烧范围一致;Lv3 后同步变宽)
- [ ] Commit `Draw the wedge you are about to breathe`

### Task 4: 回归 + 勘误 + 收官

- [ ] 三套件 + sim(质变改变 build 上限,**sim 仍看不见技能表**——照旧如实记录,不当作平衡验证)/ 全表质变覆盖率断言(30 技全有,不许再漏)/ README 段 / 勘误回填 + CLAUDE.md 状态行 / 后台任务清点
- [ ] Commit `Thirty skills, thirty pairs of turning points`

## Self-Review 结论(已执行)

- **立论有据**:0/10 的质变覆盖与 47% 的升级卡占比都是动工前实测,不是感觉。
- **机器复用**:质变全部走 M6 T12 的四动词与各 kind 已有读点;指示器走既有 SDF + CastShape 枚举。新增仅一个枚举值与一个 SDF 分支。
- **风险自查**:①五个键(boltEvery/executeBelow/knockback/kbMult/stunTime)的 bpScale 读点**可能不存在**,T1 第一步就要逐个确认,缺则补并单独断言——否则会出现"卡面承诺、实际无效"的空头质变(M9 T2 删掉 wide 正是为此);②扇形指示器必须与判定同源读值,否则又造一个画/判不一致;③质变数值是新裁,待复核。
- **占位符扫描**:无 TBD;十技二十档全部给了键与倍率;每任务列了 RED 判别点与零回归 pin。

---

## 执行后勘误(M10 收官回填)

### 与计划的实际偏差

| 计划怎么写 | 实际怎么做 | 为什么 |
|---|---|---|
| 扇形指示器加在 `AimIndicator.js` 的 SDF 里 | 加在 **`ZoneIndicator.js`** 的圆盘着色器里 | 扇形就是**加了角度掩膜的圆**——圆盘着色器已经有米制坐标、边界带、刻度、snap-out 全套;箭头的 SDF 是"轴对称长条"那一族,做扇形要重造一遍度量。改一个 uniform(`uHalfAngle`)比新开一个形状分支省得多,且零回归可证(0 = 一字不改的旧环) |
| `App.js` 加 `castShapeOf` 的分支 | App **不需要形状分支**,但需要一处计划没预见的 `levelOf` 注入 | 形状分支全在 AimController 内部;而预览要跟 bpScale 走,指示器就成了 `levelOf` 的第三个消费者(CombatSystem / ability ctx / aim) |
| 每技两档纯数据 | 三处 **读点是补出来的**,不是既有的 | 见下 |

### 一、计划的风险①命中了,而且比预想的深

计划自己写着"五个键的 bpScale 读点**可能不存在**,T1 第一步逐个确认"。确认下来:

- `boltEvery`(雷暴场出闪频率)——**零读点**。
- `kbMult`(磁场吸力)——**零读点**。

两张卡都会是"卡面承诺、实际无效"的空头质变。补上读点后,顺手撞出一个**更老的同类洞**:

> `CombatSystem` 的 **burst 分支从来没有把 `damage` 过 bpScale**,而 sweep 分支一直有。也就是说 v1 十四技里**任何 burst 系技能的伤害档位都是死的**——从 M6 T12 起就是,一直没人看见,只因为在 M10 之前没有一个 burst 技能真的配了 damage 档。

三个读点各自用"再拿掉一次"验证过:冰雹不再变重、磁场的吸力变平、雷暴两边都只落十道。

**教训(与 M9 T2 删 `wide` 同宗)**:数据驱动的质变系统里,"加一行配置"和"这行配置有人读"是两件事。**每新增一个 breakpoint 键,必须有一条断言证明拿掉读点会红**——否则加的是文案不是机制。

### 二、T3 的主缺陷:断言把生产代码忘了注入的依赖自己补上了

T3 的无头断言全绿、沙盒浏览器全绿,而**局内 Lv3 的预览仍然是 Lv1 宽**——判定 0.7425 rad,画出来 0.55 rad,喷吐比它画的扇形宽 35%。正是这个任务要消灭的那类缺陷,原样复现在自己的交付里。

成因:`AimController` 需要 `levelOf` 注入,**App 从来没注入过**。而测试是这么写的:

```js
const aim = new AimController(null);
aim.levelOf = () => level;      // ← 测试自己把生产代码缺的那根线接上了
```

**这是 M9"镜像式断言"教训换了一件衣服**:M9 那次是断言抄了一遍公式所以看不见公式改错;这次是断言**替生产代码提供了它忘了注入的依赖**,所以看不见依赖没接。两者同一个根:**fixture 补齐了生产环境里不存在的东西**。

抓到它的是浏览器那条"局内 Lv3 张角随质变变宽"。修法两条:App 只定义一次 `levelOf` 并发给全部三个消费者;`check-game` 加一条**接线钉**(读 App.js 源码,钉住"一个定义、指示器拿的是同一个"),并在注释里写明它钉的是接线不是行为、行为归浏览器那条。

> **本里程碑立下的测试规则(每个新任务都要守)**:
> **凡在断言里给被测对象注入依赖(`levelOf`/`mods`/`targets`…),必须另有一条不由测试注入的验证**——浏览器逐项、或一条钉住生产接线的断言。测试能替生产代码补的每一根线,都是一个断言看不见的缺陷洞。

### 三、自评审抓到的三条(修复轮)

1. **`get cone()` 每帧分配一个对象字面量**——`update()` 是每帧路径,`{halfAngle, range}` 是分配,违反"零分配热路径"硬性不变量(对象字面量也算)。改成两个标量 getter(`coneHalfAngle` / `coneRange`),与 CombatSystem `_dot/_take` 的标量拆分同范式。
2. **atan 接缝**:`abs(atan(p.x, p.y))` 在角色**正后方**换行,那一像素的 `fwidth` 会飙到 ~TAU,不夹的话 smoothstep 的过渡宽度会超过 π,扇形外亮起一个像素。`min(0.2, fwidth(off))` 夹死。
3. **射程环冗余**:扇形钉在角色脚下,它自己的弧**就是**射程线;再画一整圈同半径的环等于承诺扇形打不到的方向。`halfAngle > 0` 时关掉。

### 四、T4 发现:覆盖率守卫本身可以空转

`for (const el of ELEMENTS) { if (!ABILITY_TYPES[el]) continue; assert(...) }` 这种写法,**注册表一空就整条真空通过**。补了两条:castable 计数钉死 30;每张表的 lv3/lv5 都必须存在且非空(`lv5: {}` 会红)。两条都用破坏验证过。

### 五、回归与实测

- 三门全绿(`check:game` / `check` / `build`)。
- 浏览器 14 项全过,console error 0(GLSL 编译干净)。截图:Lv1 与 Lv3 的扇形肉眼可见变宽,顶点在脚下,弧上有刻度。
- `npm run sim`:新手 0% / 基线死亡中位 **14.0min** / 熟练 100% / 等级中位 **29** —— 四个锚全部在带内。
  **照旧如实记录**:`scripts/sim-run.mjs` 既不读技能表也不读抽卡池,所以"在带内"只说明**难度模型没被动过**,**不等于本里程碑的质变数值是平衡的**。质变的平衡只能靠实机。

### 六、明账未收(待用户复核 / 留给后续里程碑)

1. **二十档质变数值是本计划新裁的**(spec 未逐技指定),按锚 BASE_DPS 50、每档 25-35% 的量级裁定。**待用户复核**。
2. **burst 伤害档位从 M6 T12 起就是死的**——现在通了,意味着 v1 批次里配了 `damage` 档的 burst 技能**行为发生了变化**(变强)。没有回头重裁那些数值,记在这里。
3. **扇形指示器只服务一个技能**(烈焰喷吐)。`castShapeOf(el) === CONE ⟺ combat[el].kind === 'coneTick'` 已断言,第二个扇形技零成本接入。
4. **扇形的 `valid` 红染仍走 zone 的老路**:没有指针/退化解算时 `valid=false`,扇形会红一下。扇形技 `minRange` 为 0,本不该有"太近"的概念。留作小瑕。
5. **`quickCast` 对扇形仍按直线处理**(取满射程),行为与 M8 一致、无回归,但语义上扇形的 `distance` 本身没有意义。没有改动,记在这里。
