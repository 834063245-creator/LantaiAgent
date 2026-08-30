# baseline change request — 工具层上下文腰（T-1/T-2）：fs 可见键归一 + 三域描述换代（2026-08-30）

- **日期**: 2026-08-30
- **请求 Agent**: 工具层人体工学执行 Agent（设计件 `docs/plans/tool-ergonomics/design-1-context-waist.md` rev2 §3 验收 5 / `design-2-session-focus.md` rev2 §3——用户 2026-08-30 拍板「开工」）
- **涉及快照**: `baseline/phase-0/tool-schemas.full.json`、`baseline/phase-0/tool-schemas.plan.json`、`baseline/preset-minimal/phase-0/` 对应物——同一动因的字节漂移
- **状态**: **已批准（用户在 design-1/design-2 rev2 全文在库且明示「唯一流程门槛 = baseline 重录」后指令开工；重录为本设计的落地动作）**

## 变更内容

模型可见工具面三处（fs/git/search 三域 + desktop 描述）：

1. **fs 可见键归一**：`filePath`/`projectPath`/`directory` 三枚同义路径键合并为单键 `path`
   （合并期 canonical 映射）；派发侧 `normalizeArgs` 反向桥保证旧工具仍收原键——
   Rust 参数名与 hidden 工具 schema 零改动。
2. **path 族共享描述**：fs/git/search 的 `path` 键描述统一为「相对 = 工作区根相对；
   允许省缺的 action 省缺 = 工作区根」，取代逐 action 拼接 + `(action: xxx)` 后缀。
3. **域描述换代**：fs/git/search/desktop 四域描述追加相对路径/省缺/焦点语义
   （fs(read)/fs(edit) 省缺 = 最近读写文件；desktop uia_* 省缺定位 = 焦点窗口）；
   各 action 参数逐条描述的 per-action 标注随键归一消失。

## 为什么变

用户反馈「工具参数太多太长」+「工具层智能太低」——绝对路径重复税与 flat schema 键
混乱税的根治。实现 = JS 平台层参数预处理腰（session-context per-owner 注册表），
**Rust 零改动**（enforcement 留 Rust 漏斗，resolution 归 JS）；provider seam 契约收纯
为「provider 恒收解析好的绝对路径」。

## 影响面

- **模型可见表面**：fs 域参数 16 键 → 10 键（路径键归一）；fs/git/search/desktop 四域
  描述换代；git 全族 path / search directory / fs list、glob、constraints 省缺语义新增
  （省缺 = workspace root，JS 填充后 Rust 仍收必传形态）。
- **前缀缓存**：fs/git/search/desktop 四域 schema 字节变化 → 一次性失效（预期内，
  零外部用户无在途成本）。
- **Rust 契约**：零改动（rpc.rs / 命令签名 / frontend-rpc-contract.md 全部不变——
  「cargo diff = 0」列为验收断言）。
- **重录动作**：`npm run record:convergence`（standard）+ `CONVERGENCE_PRESET=minimal
  npm run record:convergence`（minimal），随后 `npm run verify:convergence` 必须 exit 0。

## 附带补录：minimal system-prompt 漂移（56fb9285 漏项，非本批动因）

重录时发现 minimal 侧 `system-prompt.fixture.json` 在 HEAD 即已漂移（engineOff 4038 →
323 字节，withGraph 4816 → 368）——根因 = `56fb9285`（2026-08-28 用户拍板「system prompt
收缩为极简骨架」）自称 standard+minimal 双录，实际 minimal 侧漏录；此后 minimal 套件
不在默认门禁（需 CONVERGENCE_PRESET=minimal 显式运行），漏项潜伏两天未被发现。本批
重录出的 minimal system-prompt 与 56fb9285 的设计目标值逐字节吻合（withGraph 368 /
engineOff 323），属于**补齐漏项**而非新动因——同款先例 5b5c20a9。已独立 worktree
在 30acfeec（本批动工前）复现漂移确认与 T-1/T-2 无关。

---

# baseline change request — 三面解耦：system-prompt 夹具 noGraph 拆为 engineOff + noProject（2026-08-25）

- **日期**: 2026-08-25
- **请求 Agent**: 三面解耦执行 Agent
- **涉及快照**: `baseline/phase-0/system-prompt.fixture.json`、`baseline/preset-minimal/phase-0/system-prompt.fixture.json`——同一动因的结构变更
- **状态**: **已批准（2026-08-25 用户拍板「批准，重录基线」——standard + minimal 双 preset 已重录，verify 双绿）**

## 变更内容

system-prompt 夹具从两面（withGraph / noGraph）扩为三面（withGraph / engineOff / noProject），键名与结构变化：

1. 旧 `noGraph`（null 图 + 有路径，147 字节简短面）同参调用现落**关引擎面**——夹具改名 `engineOff`：与 withGraph 同输入内容（memory/claudeMd/env 齐备）、仅 graphData=null。含 17 条行为规则/协作模式/多 Agent 指南/记忆库/项目规范 + 新增模型身份段「图谱引擎已停用」行（4038 字节）。
2. 新增 `noProject`（path='' 零目录面）：内容 = 旧 `noGraph` 简短面字节原样（147 字节）——"当前没有加载项目"在此面才是真话。
3. `withGraph`（完整面）**字节零漂移**。

## 为什么变

三面解耦的根因修复：此前 `graphData==null` 一刀切二分——绑了目录但关图谱引擎（2026-08-22 能力）的 Agent 被错塞进零目录简短面，17 条行为规则/协作模式/项目规范全部陪葬，且"当前没有加载项目"在绑定目录时是假话。解耦后 hasProject（绑目录）与 hasGraph（图数据）独立判段。生产影响：绑目录 + 引擎关的会话提示词从 147 字节恢复到完整面（约 4KB 行为规则回归）——这是**本变更的目的**，不是回归。

## 影响面

- **模型可见表面**：仅"绑目录 + 关引擎"会话的提示词变完整（引擎停用行明确告知 graph/lsp 缺席）；完整面与零目录面字节不变。
- **前缀缓存**：关引擎会话一次性失效（预期内；零外部用户无在途成本）。
- **重录动作**：批准后 `npm run record:convergence`（standard）+ `CONVERGENCE_PRESET=minimal npm run record:convergence`（minimal），随后 `npm run verify:convergence` 与 minimal 对应命令必须 exit 0。

---



- **日期**: 2026-08-22
- **请求 Agent**: 更名执行 Agent（用户直接指令「杀死旧名，一次做彻底」——本 CR 即审批记录，用户在场拍板）
- **涉及快照**: `baseline/phase-0/system-prompt.fixture.json`、`baseline/preset-minimal/phase-0/system-prompt.fixture.json`、`baseline/phase-0/tool-schemas.plan.json`、`baseline/phase-0/tool-schemas.full.json`（及 minimal 对应物）——**全部为同一动因的字节漂移**
- **状态**: **已批准（2026-08-22 用户指令执行更名，重录为本流程的落地动作）**

## 变更内容

产品更名 兰台 / Lantai（identifier `com.lantai.app`；HoloGram 降级为图谱引擎专名保留——工具域 `hologram(...)` 与 MCP 工具名 `hologram_*` **不在本次变更内**）。模型可见表面随之变化：

1. persona：`你是 HoloGram 的编码 Agent。` → `你是兰台的编码 Agent。`；`你是 HoloGram 的 AI 编码助手` → `你是兰台的 AI 编码助手`
2. 模型身份行：`由 HoloGram 调度` → `由兰台调度`；`运行在 HoloGram 调度框架中` → `运行在兰台调度框架中`
3. browser/desktop 工具 schema 描述：`HoloGram webview` → `兰台 webview`、`HoloGram UI` → `兰台 UI`（语义不变——指应用自身 webview 的只读自检通道）

## 为什么变

旧产品名在全量更名后不得残留在任何模型可见面；persona 是每会话必发的最高频表面。工具域与引擎命名空间按用户决定保留 HoloGram（能力可单独命名），故 `hologram_*` 工具名、DOMAIN_SPECS、engine-tool-surface 三层对齐零变化。

## 影响面

- **漂移范围**：仅上述字符串替换及其长度字段（noGraphLength 163→147 等）；行为规则、图纪律段、多 Agent 协作段、工具清单全部逐字节不变
- **前缀缓存**：一次性全量失效（预期内，零外部用户无在途成本）
- **重录动作**：`npm run record:convergence`（standard）+ `CONVERGENCE_PRESET=minimal npm run record:convergence`（minimal），随后 `npm run verify:convergence` 必须 exit 0

---

# baseline change request — S4-1b：session `preset/selected` 首事件 + minimal preset baseline freeze

- **日期**: 2026-08-20
- **请求 Agent**: S4 执行 Agent（设计件 `docs/plans/composition-architecture/designs/S4-preset-realm-distribution.md` §2.4/§3 批间审批门）
- **涉及快照**: 两项——(a) `session-log` 冻结面扩展（事件 kind 新增）；(b) 新增 `baseline/preset-minimal/`（per-preset 收敛协议首次 freeze）
- **状态**: **已批准（2026-08-20 用户拍板「批准全项」——(a) + (b) 全部实施）**

## 变更内容（两项合一份 CR，按设计件 §3 批表）

### (a) 新事件 kind：`preset/selected`

会话构造（`session/reset` init）时**必发首条** `preset/selected` 事件——首条即
创建时点事实（设计件 §2.4 首事件方案；DSH header 深冻的同构语义位，HoloGram
无 header 概念——SessionLog 仅 events 流）。空白会话期改选 preset → 追加
同名事件；重建时 newest-wins（倒序扫描，照抄 `resolveSessionPreset` 模式，
无 header 兜底——首事件承担该位）。

**reset 语义（设计件三轮复审 §7.1-8）**：被 reset 的会话若中途改选过
preset，reset 重开发出的是**当前生效选择**（重读默认值），不继承被清掉
那个会话的改选。倒序扫描天然安全：`session/reset` 事件本身是段分界，
旧段事件不可能跨边界泄漏。

五项同步（Phase 5 立规的完整清单）：

1. `SESSION_EVENT_KINDS`：加 `'preset/selected'`（封闭枚举扩展）；
2. `SessionEventDataMap`：`'preset/selected': { presetId: string }`（无裸
   对象嵌套——投影面最小化，`deriveMessages` 不消费此 kind）；
3. spec AST 白名单：`specs/phase-5` 的变异入口断言（若首事件经
   `_replaceSession` 后单独 append 则需新入口登记；若并入 init 的
   `_replaceSession` 载荷则白名单不动——实现时按实际路径定，两者都在
   立规框架内）；
4. gate 计数：`gate.mjs` phase-5 T0 的 `this.session.push` 计数（当前恰
   1 次）不因新事件变化（事件走 `_sessionLog.append` 不走 session 数组
   直改）；
5. 差分矩阵：phase-5 spec 补「改选 → reset → 重建用默认」场景（设计件
   §2.4 明示的单测义务）。

### (b) minimal preset 的 convergence baseline freeze

S2 §6 遗留兑现：`tests/convergence/helpers/presets.ts` 登记从**运行时
preset 表**（`src/composition/presets.ts` 的 minimal——禁 browser-desktop/
web 工具行 + graph-hooks capability）派生的 minimal 定义 →

```bash
CONVERGENCE_PRESET=minimal npm run record:convergence   # 生成 baseline/preset-minimal/
```

→ 独立 freeze commit（per-preset 收敛协议的首次全流程实测——standard
快照零漂移全程不受影响，minimal 是新增目录不是改 standard）。

## 为什么变（动机）

「模型可见 ⟺ 已记录」是 DSH 那条纪律的原样移植（设计件 §2.1 表）：
**preset 决定模型看到的 schema/段，必须可重建**。S4-1a 已交付装配机制
（preset → 工具面/prompt/capabilities），但选择事实不进会话日志——
会话恢复后无法对拍「这个会话当时用的什么组合」。minimal freeze 则是
per-preset 前缀缓存语义（S1 §2.2 铺的地基）的首次实数收口。

## 影响面

- **模型可见表面**：零变化（`preset/selected` 不进 deriveMessages 投影，
  不进 system prompt，不进工具 schema——8 个既有 baseline 快照零漂移，
  本 CR 只**新增** `baseline/preset-minimal/` 目录）。
- **session-log 持久化**：每会话多 1..n 条事件（构造 1 条 + 改选追加），
  ndjson 体积影响可忽略；旧会话文件无此 kind——回放器按封闭枚举校验，
  **旧日志回放兼容**（无该事件 = 视为 standard——缺省即当前行为）。
- **不可静默回滚**（设计件 §4）：事件写入真实会话后，回滚需先确认无
  在途会话依赖。

## 前缀缓存影响

无（事件不触模型可见面）。minimal freeze 本身就是前缀缓存 per-preset
语义的守护基建。

## 待人类决定

1. **批准** → S4-1b 开工：实施五项同步 + 差分矩阵场景 + minimal
   record/freeze（独立 commit）；`CONVERGENCE_PRESET=minimal` 的 verify
   进批内门禁。
2. **拒绝事件项、保留 freeze 项** → 只做 (b)（minimal baseline 照 freeze，
   会话记录留未决项——「模型可见 ⟺ 已记录」纪律缺口如实登记）。
3. **整体延期** → S4 以主体六批收口（现状），S4-1b 并入 S5+/V5 前置。
4. **改设计** → 反馈方向（如 data 形状、reset 语义、泛化为 `session/init`
   的触发时机提前）。

---

> **执行注**：S4 主体（S4-0/1a/1.5/2/3/5）已全部落地并每批独立全绿
> （6 commits：`c7e089ff`…`50a1f532`）——本 CR 不阻塞任何已交付能力；
> hello 三通道、热重载、安装通道、preset 装配机制均已在 main。本 CR
> 批准后的 S4-1b 是「会话可重建性 + minimal 收敛实数」的补全批。
