# Workspace 翻转 + V5 机制半 — 施工设计件

> 状态：**Draft（待用户批准后施工）** · 拟稿：agent（2026-08-22）
> 依据：`docs/adr/workspace-concept-ownership.md`（方向 Accepted）+ `interviews/W1-2026-08-22.md`（粒度 D-R4-1…4，历史编号保留）
> 工程纪律：每批 commit 前全绿（build + vitest + biome 改动文件零新增；触 agent 装配面加 verify:convergence；本文档动 workspace.ts——INVARIANTS #12 高危区，每批前 preflight）

## 0. 一句话

把「打开软件 → 选项目 → 等分析 → 看星图」翻转为「打开软件 → 会话列表/新会话 → 立刻对话 →（绑目录后）图谱后台预热」，并把 bootShell 的 composition 断线接完（V5 机制半）——同窗施工（D-R4-4）。

## 1. 现状事实（2026-08-22 实查，设计以此为准）

| # | 事实 | 出处 |
|---|---|---|
| F1 | 视图二值 `view: 'welcome' \| 'graph'`；欢迎页是 index.html 静态 DOM（非 React），唯一按钮 = INITIALIZE WORKSPACE（选目录） | shell-store.ts:32 / index.html:19 / cold-start.ts:26 |
| F2 | 冷启动逻辑：有缓存图谱 → 直接 `switchWorkspace(root, {skipAnalysis})`；无 → 欢迎页 + `setupPlaceholderAgent()`（占位 Workspace + 完整 Agent 装配，仅通用聊天） | cold-start.ts:37-91 |
| F3 | `Workspace.open` 的**热路径 await**：workspace_activate → 监听器 → `analyze_and_load`（全量分析挡在 open 里）→ 拉页/文件图谱 → …；`setupAgent` 在 open 返回后由 switchWorkspace 调 | workspace.ts:243-343 / rows/workspace.ts:148 |
| F4 | 会话按目录存储：`sessionsDir = <project>/.hologram/sessions/`；**占位工作区（path=''）的会话没有落盘目录**——今天零目录会话不持久 | chat-session.ts:413 |
| F5 | `bootShell(flowDeps?, composition?)` 的第二参从未被喂（main.ts `void bootShell()`）；boot 内 `rows = composition?.shell ?? builtinShellRows()`——参数位存在、数据流断线 | main.ts:43 / shell/boot.ts:78 |
| F6 | preset 体系已能解析 shell 域条目（resolveRoster 四域含 shell），但「纸壳 preset」不存在——内置表只有 standard/minimal | composition/roster.ts:93 / presets.ts:65 |
| F7 | 占位工作区 `Workspace.placeholder()` 已存在（path='' 永不激活）——零目录会话的运行时载体已有雏形 | workspace.ts:234 |

## 2. 目标形态（终局，D-R4 拍板合成）

```
启动 ──→ 会话首页（React 化）
          ├─ 最近会话列表（跨目录聚合 + 零目录会话）
          ├─ [新会话] ──→ 零目录通用会话（立刻可聊）
          └─ [新会话 + 绑定目录] ──→ 选目录 ──→ 秒进会话，图谱后台预热
会话中 ──→ 绑目录动作随时可用（会话内属性，非打开软件的前置）
图谱  ──→ 分析中：graph 工具返回诚实提示；完成：27 动作全量可用（harness 基石不砍）
壳    ──→ bootShell 消费 composition-store.resolved.shell（preset 可裁剪壳行）
          + 纸壳 preset（内置表加行）+ 主视图落点可切换（观测台/纸）
```

## 3. 批次序列（六批，每批独立全绿）

### 批 1（W1）— 会话首页 React 化

**做什么**：新组件 `app/SessionsHome.tsx`（或改造 welcome）——最近会话列表 + 「新会话」双入口（零目录/绑定目录）。`view` 类型扩为 `'welcome' \| 'graph'` → `'home' \| 'graph'`（保留 'welcome' 作别名过渡或直接迁移）。

- 会话索引数据源：新增「最近会话」聚合（Rust 侧一条 RPC：扫各已知项目 sessions 目录 + 零目录会话目录，按 savedAt 排序取前 N）——**只读聚合，不搬既有会话文件**（按目录存储的现状 F4 保持，零迁移）
- 零目录会话存储：`~/.hologram/sessions/`（用户级，不走项目目录）——D-R4-2 的「通用会话场景」落地；占位工作区 path='' 时 sessionsDir 路由到此
- 欢迎页静态 DOM 退役：index.html 的 welcome div 移除，SessionsHome 经 React 渲染（App.tsx 按 view 切换）

**不动**：switchWorkspace 流、Workspace.open、冷启动缓存路径（批 3 动）。

### 批 2（W2）— 零目录会话一等化

**做什么**：占位工作区从「永不激活的兜底」升格为「通用会话的家」。

- `Workspace.placeholder()` 路径语义扩展：path='' 持续活跃（会话可持久化到 `~/.hologram/sessions/`）；workspace_activate('') 已有（F2 现状），补会话读写路由
- 「新会话」零目录分支：直接 `setupPlaceholderAgent()` + 空会话——**已是现状**（F2），本批只补持久化 + 列表可见
- 会话内绑目录：通用会话里首次需要 fs/图谱时，触发目录选择 → 转 `switchWorkspace(path)`（会话内容跟随工作区切换的语义 = 现有切换语义，无新结构）

**风险点**：placeholder 激活态变化波及 INVARIANTS #12 家族（fiber/epoch）——placeholder 从不参与到常驻，deactivate 路径要复检。测试补：零目录会话存取往返、绑目录迁移。

### 批 3（W3）— 打开流重排：分析出关键路径（D-R4-3 核心）

**做什么**：`Workspace.open` 拆两段——**急段**（秒回）+ **缓段**（后台）。

```
急段（await，目标 < 1s）：workspace_activate → 监听器登记 → 会话就绪 → setupAgent
缓段（fire-and-forget，fiber effect 登记 + epoch 守卫）：analyze_and_load → 拉页 →
  graph-updated 事件 → graphData 就绪 → graph 工具解禁
```

- graphData 未就绪时 graph 工具（agent-builder 的 graph hooks）：返回结构化提示「图谱分析中（后台预热），约 N 秒后可用」——**不静默失败**（宪法第 4 条）
- analyzing 状态已有（shell-store `AnalyzingKind`），补「图谱预热中」状态位供 UI 呈现
- 冷启动缓存路径（F2 skipAnalysis 分支）收敛进同一两段模型（缓存 = 缓段的快路径）
- **不动**：deactivate/forceClearState 的 fiber+epoch 语义（INVARIANTS #12 铁律）；星图渲染（缓段完成后照旧；观测台退役是 V5 判断半的事，本批不碰）

**验收**：大目录打开 → 对话秒进可聊；图谱预热中 graph 工具有诚实提示；预热完自动可用（无重开会话）。

### 批 4（V5a）— bootShell 组合接线（断线接完，F5）

**做什么**：`main.ts` 把 `useCompositionStore.getState().resolved` 喂给 `bootShell(_, composition)`。

- boot 时序调整：bootShell 第 2 步（组合链）完成后再取 resolved（此刻 patch+preset 已应用——现状 bootShell 内部就是先组合后 shell 行，只需把 resolved 传出喂给第 3 步，**改动 ~5 行**）
- shell 行禁用涟漪已在 S2 设计件 §2.8 声明——本批让它真实生效（preset 禁壳行 = boot 跳过该行接线）
- 测试：mock composition 禁某壳行 → boot 后该行接线不发生

### 批 5（V5b）— 纸壳 preset + 主视图落点

**做什么**：内置 preset 表加 `paper` 行 + 主视图切换消费。

- `presets.ts` BUILTIN_PRESETS 加 `paper`：patch 禁星图相关壳行（`hologram/shell-graph` 等——具体清单批内定，以「纸壳用户不需要的观测台接线」为准）
- 主视图落点：preset 含 `paper` 时，view 初始值 = 纸面板打开（或 home→paper 直通）——落点逻辑落在 bootShell/壳行，不改 view 类型本质
- 设置面板 preset 选择器已存在（S4-2）——选 paper 重启即纸壳优先；共居不破坏（Ctrl+P 随时可切回观测台面板）
- **不做**：纸壳 preset 的工具面裁剪（minimal 已示范工具域禁用语法，纸壳要不要裁是 V5 判断半之后的产品决策）

### 批 6 — 文档回写 + 基线刷新

- ADR 状态 → 施工完成；paper-shell README（V5 机制半竣工 + S3 解锁声明）；composition-architecture README（S3 前置「白纸执行层外化」完成）；AGENTS/CLAUDE/CONVENTIONS 增量同步；vitest 基线数字刷新

## 4. 明确不做（本窗边界）

- **观测台退役/降级**——R3/V5 判断半；星图照常渲染（批 3 只是把分析挪后台，不砍渲染）
- **S3 面板行化**——批 5 完成即解锁，但逐域迁移等纸真的需要（settings 先行是预判）
- **双根所有权**（D-R4-2 否决）；**图谱分析前置**（D-R4-3 否决）
- **会话文件迁移**——按目录存储的现状保持，零目录只是新增一个存储位
- **纸壳视觉**——V2/V4 的事

## 5. 风险表

| # | 风险 | 对策 |
|---|---|---|
| R1 | workspace.ts 是 INVARIANTS #12 高危区（fiber/epoch 家族炸过 N 次） | 每批前 preflight_check；批 3 拆段时「缓段」全部走既有 fire-and-forget 纪律（effect 登记 + epoch 校验）；每批 vitest 全量跑 |
| R2 | 打开流重排改变冷启动行为（老用户缓存路径回归） | 批 3 保留 skipAnalysis 快路径语义（缓存=缓段快路径），冷启动 e2e（CDP 冒烟）对拍 |
| R3 | 零目录会话存储新增用户级数据文件（毒化风险 INVARIANTS #11.2） | 读取容忍毒化（跳过坏条目）；写入走既有 sessions 序列化；长度护栏 |
| R4 | boot 时序变更波及 12 壳行的既有顺序契约 | 批 4 只喂参不改序（bootShell 内部组合链先行已是现状）；壳行禁用涟漪测试新增 |
| R5 | view 类型迁移波及 App.tsx/冷启动/escLayer 等消费面 | 批 1 用全仓 grep 逐点迁移；类型收紧由 tsc 守护 |

## 6. 验收清单（全批次完成时）

- [ ] 启动落会话首页（非选项目）；零目录会话创建/持久化/重开往返
- [ ] 通用会话内绑目录 → 秒进编码会话，图谱后台预热不挡对话
- [ ] 大仓库打开：对话可用时间 < 1s 量级；graph 工具在预热期有诚实提示
- [ ] preset 选 paper → 重启后纸壳优先；选 standard → 观测台照旧（零漂移）
- [ ] roster patch 禁壳行 → boot 真实跳过（涟漪生效）
- [ ] verify:convergence 零漂移（standard）；vitest 全绿；build 绿
- [ ] ADR/两计划 README/AGENTS/CLAUDE 文档回写
