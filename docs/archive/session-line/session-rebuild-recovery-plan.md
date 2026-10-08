# session-rebuild-recovery — 卷重建丢卡根治（块恢复 + 开卷落盘）

> **已归档（2026-10-08 · 会话线追加）**——① 重建块恢复 + ② 开卷落盘已落地，门禁全绿
> （vitest 416 文件 / 4429 用例 + build + biome 0/0）；真机验收两条在
> [`plans/README.md`](../../plans/README.md) 欠账表（**唯一在办真值**）。
> 现状承接：代码（`ui/chat-session.ts` / `ui/part-mutator.ts`）+ 回归
> `tests/session-rebuild-recovery.test.ts` / `tests/chat-session.test.ts`；族索引 [`README.md`](README.md)。

> 状态：**已归档（2026-10-08；当日立项 · 当日施工 · 当日归档）**
> 触发：用户报「51 号案卷出现 asset 卡片与拟策卡片丢失」——同日侦察取证（见 §1）。

## 一句话

卷重建（快照判陈旧 → 从 provider 消息重造 UI）只重造文字/工具卡——资产块与拟策块被丢弃；
且重建产物不落盘、快照永远追不上日志，循环复发。本批：① 重建从工具回执/结果恢复两类块；
② 开卷后把快照追上（断开判陈旧循环）。

## §1 现象与取证（2026-10-08 真机）

- **丢失面**：案卷 51（`D:\HoloGramHG\.lantai\sessions\51.json`）UI 快照中，3 张资产卡
  （16:23 / 16:54 / 17:20 的表格）与 1 张拟策卡（16:55 提交 · 已批准）整体缺失。
- **未死面**：事件日志（`51.ndjson`）与 provider 消息里三次 `show_asset` 回执、
  `enter/exit_plan_mode` 调用与结果全量健在——数据未死，只丢 UI 块。
- **重建产物指纹**（对照 52 号卷实时快照）：143 个工具块无 `startedAt`/`truncated`、
  只读工具 `readOnly:false`（重建硬编码）、无任何 block/plan part。
- **时间链**：16:23–17:20 卡片产生 → 17:38 起 5 次开卷（adopt 事件各自 +1 seq、均未落快照）→
  某次判陈旧触发重建 → 19:45:49 关窗退出 flush 把缺卡状态固化 → 20:22 再开（采信缺卡快照）。

## §2 根因（三层）

1. **能力缺口**：`rebuildMessagesFromMessages`（`ui/chat-session.ts`）只重建 reasoning/text/tool 三种 part；
   block 仅从「现有 msgStore」捡（开卷场景 msgStore 刚被清空，捡不到）；plan 无任何保留逻辑。
2. **触发条件**：`readVolumeData` 新鲜度判据 `cache.seq >= log.lastSeq`——开卷的 adopt reset
   推进 lastSeq 而不写快照 ⇒ 快照必然落后 ⇒ 下次开卷判陈旧 ⇒ 重建。
3. **固化**：重建后任意一次保存（本例 = 关窗退出 flush）把缺卡状态写进快照 ⇒ 此后打开永久无卡。

## §3 处方（本批施工）

### ① 重建恢复块

- **资产**：`show_asset`/`update_asset` 工具回执经 `parseAssetEventOutput`（单一解析真源，
  与 executor 终值事件同源）解析 → `applyAssetFinal`（part-mutator 本批导出）把 BlockPart 补回
  （紧跟该工具卡之后；update 的原位置换语义天然成立）。
- **拟策**：`exit_plan_mode` 结果解析计划全文（marker `## 已批准计划：` / `## 计划：`——依赖
  plan-tools.ts 的文案契约，测试钉住）；`options` 自调用参数恢复；`status` 保持 `'pending'`
  （对齐实时行为：审批不写回 part，只读态渲染既定）。
- **宁缺勿造**：结果不含全文（修改/拒绝/超时/留档）⇒ 不产卡（负例测试钉住）。

### ② 开卷落盘（断循环）

- `loadSessionFromDisk` 有句柄路径末尾 `void saveSessionById(ctx, projectPath, sid)`：
  开卷（含 adopt）推进的状态落盘 ⇒ 快照 seq 追上 ⇒ 下次开卷判新鲜（采信）⇒ 重建循环断开。
- **未覆盖（边界，观察）**：无句柄开卷 / 批恢复的卷（`saveSessionById` 因 no-handle 跳过）——
  重复重建无害（块恢复已兜底）、有句柄时自然收敛。

## §4 不做（记录）

- 「内容游标」判据改造（把 adopt 类头级事件排除出新鲜度）：动 SessionLog 契约面风险大；
  ② 落地后循环已断，不需要。
- 拟策 content 的 plan 文件回读（revise/rejected/留档 场景正文补全）：引入异步 IO，另批再说。
- 不动 `readVolumeData` 判据 / 不变更存储格式 / 不改 provider 消息面。

## §5 门禁与验收

- 门禁：`cd src-ui && npx vitest run`（全量）+ `npm run build` + `npx biome ci .`（0/0）；
  不动 `agent/**`、`composition/**` ⇒ convergence 不在面（若触碰则补跑）。
- 真机验收（用户）：打开 51 号卷 → 3 张表格卡 + 1 张拟策卡恢复出现（拟策只读态）；
  「开卷 → 不操作 → 关」循环后重开：卡片仍在（快照已对齐，不再判陈旧）。
