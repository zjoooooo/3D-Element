# 五行降世 (Wuxing Descends) — 项目定向

Three.js + Vite + 手写 GLSL 的幸存者式五行肉鸽,建在原 VFX 沙盒之上。除角色 FBX 外全程序化,零运行时依赖新增。

## 权威文档(按此顺序读)

1. **设计 spec**:`docs/superpowers/specs/2026-08-14-wuxing-roguelike-design.md` — 一切机制争议以此为准;机制级变更须回流改 spec。
2. **当前计划**:`docs/superpowers/plans/2026-08-18-m10-second-wave-finish.md`(M10 三十技质变 + 扇形指示器)— 文末「执行后勘误」含真实偏差与五条未收项,并立下**注入依赖的测试规则**。M8 的勘误(同目录)立下了通道规则与冻结测试规则。历史计划 M1-M9 同目录,各自文末勘误是当时的真实偏差记录。
3. 数值即文档:`src/config/settings.js` 是活的调参台账。

## 当前状态(交接时更新此行)

v1.0 已发布(tag v1.0)。**M7 融合专属化已完成**(T1-T7)。**M8 第二波主动已完成**(T1-T7,十技全部注册)。**M9 已完成**(T1 抽卡按类归一 / T2 满级异化 / T3 无尽续玩 / T4 damage() 通道清账 / T5 收官)。**M10 已完成**(T1-T2 三十技各两档质变、三处缺失读点补齐 / T3 扇形瞄准指示器与判定同源 / T4 收官;计划 `docs/superpowers/plans/2026-08-18-m10-second-wave-finish.md`,勘误节末列有五条明账未收项)。用户指令的后续队列:**M11 → M12(需先写计划)→ 全任务复核**。

> **M8 立下的通道规则(每个新任务都要守)**:任何按 tick 施加的力/控/伤,数值语义必须在**通道层**先讲明是「每秒速率」还是「单次冲量」——本里程碑同一错误在 sweep / aura / coneTick 三个通道各犯一次(见 M8 勘误)。配套的测试规则:**凡为隔离 A 而冻结 B,必须另有一条不冻结 B 的交付测试**;无头 lifecycle 循环必须推 `enemies.tick`,否则"把目标推出判定域"类缺陷完全不可见。
>
> **M10 立下的注入规则(测试三连的第三条)**:**凡在断言里给被测对象注入依赖**(`levelOf` / `mods` / `targets`…)**,必须另有一条不由测试注入的验证**——浏览器逐项,或一条钉住生产接线的断言。M10 T3 的无头断言自己把 App 忘了注入的 `levelOf` 接上,于是全绿交付了一个局内 Lv3 只画 Lv1 宽的扇形(判定比它画的宽 35%)。这与 M9 的镜像式断言同根:**fixture 补齐了生产环境里不存在的东西,断言就瞎了**。配套的配置规则:**每新增一个 breakpoint 键,必须有一条断言证明拿掉读点会红**——否则加的是文案不是机制(M10 撞出 burst 分支的 damage 档从 M6 T12 起就是死的)。

## 命令

```bash
npm run dev          # Vite 开发服(浏览器验证用;#run 进游戏,#run=quick 跳过标题)
npm run check:game   # 游戏逻辑无头断言套件(改逻辑必须绿)
npm run check        # 角色/动画剪辑装载套件
npm run sim          # Monte-Carlo 难度模拟(带:新手0%/基线死亡中位~14min/熟练100%/等级中位~29;越带停下报数,不要自行调参)
npm run build        # 发布构建
```

浏览器无头验证用 pump 模式:`app.time.tick = () => 1/60; for(…) app.frame()`(后台标签页会挂起 rAF)。

## 执行流程(SDD)

逐任务循环:**断言先行(RED)→ 实现 → 双套件绿 → 浏览器逐项 → 独立评审 diff → 修复轮 → 复审 → 提交**;里程碑末全支终审 + 勘误节回填。有 superpowers 插件就用 `subagent-driven-development` 技能;没有也不影响——流程如上,辅助脚本已 vendor 在仓库:

```bash
scripts/sdd/task-brief <计划文件> <任务号>     # 抽取单任务全文 → .superpowers/sdd/task-N-brief.md
scripts/sdd/review-package <BASE> <HEAD>      # 生成评审 diff 包 → .superpowers/sdd/review-*.diff
```

(二者 MIT,vendored from superpowers 插件,© Jesse Vincent。`.superpowers/` 是 gitignored 的本地工作台。)

## 硬性不变量(每个任务都要守;违反过的都成过 Critical)

- **数值分层**:生效值 = settings 基值 × 局内修正层;任何代码不写 settings。
- **五字段施放不变量**:cooldown / `_applySequence` / autocast / fusionMult / quenched 每次成功施放显式写;门败(法力/独占通道)全不写。光环(装备即常驻)是唯一豁免。
- **固定步长**:逻辑 60Hz tick + 渲染插值(GameClock);判定与帧率无关。
- **零分配热路径**:per-tick/per-frame 不分配——对象字面量也算(CombatSystem `_dot/_take` 的标量拆分是范式)。
- **重入 scratch 铁律**:凡按引用递入「可能触发同步重入」的调用(damage → 击杀 → onKillAt 监听)的 scratch 向量,重入路径必须用**独立** scratch(M7 T2 修复 771ba02;M4 反应队列同宗)。
- **沙盒纯净**:`#run` 之外一帧不变;类须 null-safe(ctx.enemies/levelOf/playerState 缺省不炸)。
- **世界系 InstancedMesh 一律 `frustumCulled = false`**(实例变换不进包围球;27b8397 教训:漏一个=整队隐形)。
- **双属性约定**(M7 起):damage 系尾参 `wux=子系, wuxB=母系`;挂印/减益/引爆只看子系,克制取双系对目标更优的一个。
- **WYSIWYG**:所见即所判(spec §3);视觉范围≈判定范围,任何"看着打到了却没伤"都是修复项。

## 约定

- 提交:自然句 subject(不用 feat: 前缀)+ 尾注 `Co-Authored-By: Claude <noreply@anthropic.com>`。**尾注不带模型标识**(用户 2026-08-18 指示);M10 及之前的历史提交仍带旧字样,未回改。
- **只提交,推送前问用户**(远端 `3d-element` = github.com/zjoooooo/3D-Element)。
- 文案双语:所有玩家可见字符串走 `src/ui/strings.js` zh+en。
- 角色资产不覆盖:`public/models/` 里 `Standing Idle.fbx / diffuse2.png(已转 .jpg)/ Fast Run-2.fbx / Standing 1H Magic Attack 02.fbx / Stand To Roll.fbx` 是用户手工管线产物,只增不改。
- 机制级选择:按 spec 先做、在报告/勘误里标记待用户复核,不停车等答复;纯数值按锚直接裁(锚:BASE_DPS = combat.ice.damage / ice.cooldown = 50)。
- **收尾必查后台任务**:每个任务/里程碑收尾时点一遍还在跑的后台进程,只留下确实还要用的(通常只有一个 `npm run dev`),其余全部杀掉。M8 末尾清出 9 个僵尸等待循环 + 1 个重复 dev 服——**成因值得记住:`until ! pgrep -f verify-xxx; do sleep; done` 里的 `pgrep -f` 会匹配到轮询者自己的命令行,条件永不成立,循环永不退出**。等后台命令要么直接 `run_in_background` 跑那条命令本身、等完成通知,要么按 PID 等(`while kill -0 $PID`),不要按脚本名轮询。
