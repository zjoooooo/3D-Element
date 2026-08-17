# 五行降世 (Wuxing Descends) — 项目定向

Three.js + Vite + 手写 GLSL 的幸存者式五行肉鸽,建在原 VFX 沙盒之上。除角色 FBX 外全程序化,零运行时依赖新增。

## 权威文档(按此顺序读)

1. **设计 spec**:`docs/superpowers/specs/2026-08-14-wuxing-roguelike-design.md` — 一切机制争议以此为准;机制级变更须回流改 spec。
2. **当前计划**:`docs/superpowers/plans/2026-08-17-m7-fusion-spells.md`(M7 融合专属化)— 文末「执行后勘误」含**续作指引**(下一个任务从哪开始、已完成任务的教训)。历史计划 M1-M6 同目录,各自文末勘误是当时的真实偏差记录。
3. 数值即文档:`src/config/settings.js` 是活的调参台账。

## 当前状态(交接时更新此行)

v1.0 已发布(tag v1.0)。M7 进行中:T1-T5 已完成,**下一步 = M7 Task 6 回春雷泽**,随后 T7 回归收官。细节见计划勘误节的续作指引。

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

- 提交:自然句 subject(不用 feat: 前缀)+ 尾注 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- **只提交,推送前问用户**(远端 `3d-element` = github.com/zjoooooo/3D-Element)。
- 文案双语:所有玩家可见字符串走 `src/ui/strings.js` zh+en。
- 角色资产不覆盖:`public/models/` 里 `Standing Idle.fbx / diffuse2.png(已转 .jpg)/ Fast Run-2.fbx / Standing 1H Magic Attack 02.fbx / Stand To Roll.fbx` 是用户手工管线产物,只增不改。
- 机制级选择:按 spec 先做、在报告/勘误里标记待用户复核,不停车等答复;纯数值按锚直接裁(锚:BASE_DPS = combat.ice.damage / ice.cooldown = 50)。
