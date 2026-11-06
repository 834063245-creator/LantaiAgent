# 上帝文件治理（god-file governance）

> 状态：**P1 已落地（2026-11-06）**——门禁 + 第一刀（chat-session.ts）已进主干；P2 纸壳待开工。
> 门禁 = `src-ui/tests/god-file-budget.test.ts`（未登记文件 ≤ 1000 行；已登记只减不增）。

## 0. 要裁什么（结论在前）

**结论：不是全库腐烂，是几个尖峰在加速。** 产品源码 912 文件 23.8 万行，中位数 103 行；
≥1000 行的 50 个文件占了 34% 代码量。问题不在平均，在**两处热点**——

| 热点 | 实测（2026-11-06） | 为什么算病灶 |
|---|---|---|
| 聊天编排 | `ui/chat-session.ts` 2730 行 / 57 导出 / 8 个职责区；`app/chat/chat-core.ts` 2119 行 / 单类 80+ 方法；`agent/agent.ts` 2486 行 | 一年 97 / 92 / 124 次提交；chat-session 在**冻结名单**上却 7/25 的 1099 行长到 2730（+148%）——冻结只阻止了拆，没阻止长 |
| 纸壳 | `PaperPanel.css` 6778 行 / 804 选择器 / 179 个主题段；`PaperPanel.tsx` 单组件体 1278 行；ComposerDock 61 个 hook 调用 | CSS 两个月 +91%（9/4 3541 → 6778）；一年 122 次提交，当天还在改 |

第三类（Rust 大文件：`lsp_manager.rs` / `query_adapter.rs` / `framework_routes` / `memory.rs` 等 29 个）
是**宽度型**（22 框架检测 / CSR 索引 / 平台沙箱），churn 极低（`memory.rs` 一年 2 次提交）——
**只登记不拆**，不占本线工期。

## 1. 为什么会有今天（三条根因）

1. **纪律只管「文件集」，不管「单文件多大」**：`ui/` 的「只减不增」= 13 个文件不少一个，
   没有一处会因为某个文件写到 3000 行而变红。
2. **目录级水线试过，撤了**：`privileged-zone-freeze.test.ts` 头注（2026-09-24）——多窗口并行施工时，
   别人的正当改动会把目录总量判红（实测立账 15 分钟后 +277 行）。**所以本线不做目录水线。**
3. **拆过又长回来**：`agent.ts` 9/15 收敛到 1905，六周回到 2486；`PaperPanel.tsx` 9/3 拆到 1172，
   六周回到 1739。**没有封顶的拆分只是一次性动作。**

## 2. 门禁口径（三条）

- **物理行数**（末尾换行不算一行），与 `plugin-home-ledger.test.ts` 同一把尺子；
- **未登记文件 ≤ 1000 行**——新文件要长成上帝文件，先拆或先登记；
- **已登记文件只减不增（ratchet）**——要长，必须同 commit 改大数字，让「它又长胖了」
  成为一次有记录的决策；降到 1000 行以下必须销账（文件不存在同理）。

登记表在 `src-ui/tests/god-file-budget.test.ts` 的 `DEBT`，初版 47 条 = 三棵 src 树实测。
扫描面 = `src-ui/src` + `engine/src` + `src-tauri/src`（不含 tests 与生成物）。

## 3. 批次

### P1 ✅ 已落地（2026-11-06）

**① 门禁**：`god-file-budget.test.ts`（见 §2）。

**② 第一刀：`ui/chat-session.ts` 2730 → 67 行公开面**，实现按文件里**既有的分区注释**拆到
`src-ui/src/app/chat/session/`（13 个模块，行数见下）。行为零变更：
公开面由 `ui/chat-session.ts` 原样再导出，**34 个调用方（5 源码 + 29 测试）零改动**——
测试 diff 为零是「行为零漂移」的最强证据。

| 模块 | 行 | 职责 |
|---|---|---|
| `session-types.ts` | 76 | ChatSession / SessionContext / 内部来文判据 |
| `session-registry.ts` | 149 | 面板级注册表访问器（句柄 / exec 账 / 轮次对 / 全量重置） |
| `session-titles.ts` | 125 | 卷名维护（首条来文派生 + 一次模型概括） |
| `session-crud.ts` | 458 | 会话 CRUD（切换 / 懒建句柄 / 关闭 / 新建） |
| `session-paths.ts` | 296 | 工作区会话根 + 卷快照形状 + 发号账 |
| `session-catalog.ts` | 404 | 卷目录投影 + 每卷写链 + 落盘结果账 |
| `session-volume-guard.ts` | 45 | 已删卷写拒绝名单（原 `_removedVolumes` 收成显式 API） |
| `session-save.ts` | 306 | 快照落盘 / 防抖自动存 / 改名即存 |
| `session-read.ts` | 175 | 卷读取（快照 / 清单 / 档号列表） |
| `session-restore.ts` | 401 | 单卷续开 / 批量恢复 / 真删 |
| `session-rebuild.ts` | 302 | 从 provider 会话重建 UI 消息与轮次对 |
| `session-retract.ts` | 131 | 轮次撤回（TurnIdBridge 对位） |
| `session-export.ts` | 79 | 对话导出 |

**拆法纪律**：只搬字节，不改逻辑（唯二改动是把 `_removedVolumes` 的裸 Set 收成
`isVolumeRemoved / markVolumeRemoved / unmarkVolumeRemoved`、把测试重置口收成
`resetIssueLedgersForTests / resetVolumeGuardForTests`——都是同义改名，行为不变）。
模块间存在少量 ESM 环（crud ↔ restore、catalog ↔ save），**只用到函数级**，
没有模块初始化期取值，运行时等价于原单文件。

### P2 ⏳ 待开工：纸壳

1. 先解 **CSS ↔ `measure.ts` 数值镜像**（`type-tokens.ts` 是同因病灶的补丁，先把它扩成唯一真源）；
2. `PaperPanel.css` 按 179 个主题段聚成 6–8 个 `@import` 分片（物理拆，不改选择器语义）；
3. `PaperPanel.tsx` 的单组件体（1278 行）按区域拆 hook 段。

判据：`tests/paper-visual-decisions.test.ts` + `paper-folio-height` + 视觉决定账本零漂移。

### P3 登记不拆（本线不动）

Rust 宽度型大文件（29 个）· 测试巨件（`tests/chat-session.test.ts` 2057 行——P1 拆完它没变，测试面这一批不动）
· `renderers/components.tsx` / `measure.ts` 这类「广度型」模块（10 个块类型 / 68 个测量导出）
——它们的大是覆盖面，不是职责混装；拆了只是把同一张表切成几份。

## 4. 判据

- `cd src-ui && npx vitest run`（含 `god-file-budget.test.ts`）
- `cd src-ui && npm run build` · `npx biome ci .`（0/0）
- `cd src-ui && npm run doc-check`
