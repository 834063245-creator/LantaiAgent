# 引擎 / LSP 运行期加固与归因修复（2026-09-25 排查 → 2026-09-26 落地）

> **状态**：代码已落地（三条 commit，门禁全绿）；**余两件明账**——#9 `.lantai/` 遗留三件等用户裁定、
> #4 后果 B（孤儿舰队回收）判定为**不做**（理由见文末）。
>
> **由来**：一次排查把四件事串成同一条链——「引擎/LSP 在长任务中途静默消失」+「语义搜索一直在旧快照上跑」
> +「工具把人引去装一个已经装好的 LSP」+「进程没了却查不出为什么」。共 9 条发现，分三档：
> 一档是根因（不修，二档会复发），二档是被根因放大的后果，三档是各自成立的独立缺陷。
>
> **证据出处**：`.hologram/logs/engine.log`（引擎侧）与 `.lantai/logs/bridge.log`（宿主侧）
> —— 2026-09-25 实测：最后一次 MCP 调用 18:56:43 + 5 分钟空闲预算 = 19:01:43，
> `engine.log` 末条 19:01:28（差 15 秒，正好卡在两批嵌入之间），`lspd` 无 `shutdown requested` / `exited`
> 告别 = 硬杀。

## 裁定（判断与理由，逐条可翻案）

1. **#1 空闲回收误杀 = 总闸**。续期口 `touch()` 全文件唯一调用点 = `acquireForCall()`（调用**发起**
   那一刻）⇒ 任务跑起来之后再没人摁计时器，`idleTimeoutMs` 到点无条件 `stop()`。修法**两条都上**：
   ① 受治面加**在途调用计数**（调用 settle 前不布防——它管的是「调用本身跑很久」）；
   ② 引擎**显式声明更长的静默预算**（`ENGINE_IDLE_TIMEOUT_MS = 30 min`——它管的是「调用返回之后
   仍在跑的后台线程」，如 `pipeline.rs` 的向量索引重建，在途计数**保护不到**）。两者覆盖的是两类
   不同的长尾，缺一不可；且预算**有上界**（不是永不回收，内存仍能回来）。
2. **#2 停止必须留痕**。`stop()` 改成**原因必填参数**（`GovernorStopReason`）——新增停止路径不填原因
   编译不过；原因一路透传到 Rust 桥落 `bridge.log`，进程「怎么没的」有**持久**证据（此前只有
   `spawned` 一条，退出面彻底静默）。同时 Rust 侧补退出守护线程（真实退出码）与「kill 请求 + 原因」。
3. **#6 空结果 ≠ 没装 LSP**。`Ok(空列表)` 原本不记 error ⇒ 一路落进「路径 2：无原生 LSP 可用」⇒
   吐 `Install an LSP server for .rs`。分成四句：答了但空（位置错）/ 忙·冷启动（稍后重试）/
   装了但起不来（看原因，重装没用）/ 真没装（安装指引）。
4. **#7 首次查询的必然空结果**。首次查询触发 lazy warm 后服务器仍在索引项目，`textDocument/definition`
   如实回空。修法用引擎**已有的** `cold_window`（spawn 后 150s）：窗口内空结果转 `LSP busy`
   ⇒ 工具层给「稍后重试」；同时 `lsp_has_real_reference` 因此不会把「还在索引」判成「确认死代码」。
5. **#5 状态要说四态**。旧的 `warm in progress or silent failure — retry if persists` 把
   「从未 warm（懒加载正常初态）/ 正在 warm / warm 失败」糊成一句，且措辞把人引向「它坏了」。
   立 `LspServerState` 五态为**单一归因源**（engine_status、`ops(status)` 的 `missing` 列表、工具降级
   文案同源），`missing` 自此只装**真的用不上**的（没装 / 起不来）。
6. **#8 滞后必须报警**。`nodes` 与 `vectors` 两数并列摆着却不报警 = 没人知道语义搜索在旧快照上跑
   （实测 22244 vs 21760，差 484 无人发现）。`status.vector_index` 增 `lag_nodes` / `stale`，
   顶层增 `warnings`；`phase != ready` 时文案标注「分析中，属预期」。

## 逐条状态

| # | 发现 | 状态 | 落地位置 |
|---|---|---|---|
| 1 | idle 回收误杀长任务（总闸） | ✅ 修 | `mcp-bridge.ts`（inFlight + `release`）+ `wiring.ts`（`ENGINE_IDLE_TIMEOUT_MS`） |
| 2 | 进程消失零日志（眼睛） | ✅ 修 | `mcp-bridge.ts` `stop(reason)` + `protocol_bridge.rs`（退出守护 + kill 原因落 bridge.log） |
| 3 | 向量索引永远追不完 | ✅ 随 #1 缓解 | 全量重建 ≈13.7 min（22k 节点 @26.5/s）现在跑得完；**嵌入缓存是进程内的，被杀即清零**（实测命中率 2%）——持久化缓存未做，见下「未做」 |
| 4 | LSP 舰队反复重索引 + 孤儿泄漏 | ⚠️ 部分 | 后果 A（拉起→吃 3GB→被杀→重来）随 #1 消除；后果 B（孤儿）**不做回收**，理由见文末 |
| 5 | LSP 兜底文案误导 | ✅ 修 | `lsp_manager.rs` `LspServerState` 五态 + `lsp_status()` |
| 6 | 空结果误报「去装 LSP」 | ✅ 修 | `resolve.rs` `lsp_degraded()` 四路分流（call / type / implementations / references） |
| 7 | 首次查询必然拿不到结果 | ✅ 修 | `lsp_manager.rs` `LspProcess::cold_start_note()`（冷窗口内空结果转 busy） |
| 8 | `status` 面缺「滞后」告警 | ✅ 修 | `audit.rs` `vector_lag_warnings()` + `store` → `active_index` 改名 |
| 9 | `.lantai/` 遗留三件 | ⏳ 待裁定 | 见下 |

**契约面**：#8 的行为变更动了 `ops(status)` 的输出键与工具描述 ⇒ 引擎契约升 **v10**
（`contract.rs` 沿革块记全部形状变更 + 指纹更新 + `npm run gen:engine-contract` 同步生成物）。

## 未做（明账）

- **#3 附带的嵌入缓存低命中率（2%）**：根因是 `hologram-vector` 的 `VECTOR_CACHE` 是**进程内**
  缓存——进程被杀即清零，下次全量重来。随 #1 缓解（不再被杀 ⇒ 同进程内后续重建近乎全命中），
  但**跨重启仍是 0**。持久化嵌入缓存是需要设计的独立议题（缓存键 / 版本失效 / 磁盘占用），
  不在本批。
- **#4 后果 B 孤儿舰队回收**：**判定不做**。理由：① 孤儿的产生条件正是 #1 的硬杀，已消除；
  ② 实测孤儿**没挡路**（新拉的 rust-analyzer 工作完全正常）；③ 「启动时按 root 清理陈旧舰队」
  要按进程名 + 命令行匹配去杀别人的进程，误杀风险大于收益（可能杀掉 IDE 自己的语言服务器）。
  若再观察到孤儿堆积，正确入口是**让 lspd 有优雅退出出口**（它现在被硬杀时没有机会跑
  `shutdown_all()`），而不是事后按名字清理。
- **#9 `.lantai/` 遗留三件**（`hologram.db` 68MB / `vectors.usearch` 24MB / `vectors.slots.json` 1MB，
  均 2026-09-02）：**已确认无人读取**——全部读路径走 `hologram_graph::data_dir()`（`.hologram/`），
  唯一碰旧路径的代码是 `path_utils.rs` 的搬迁逻辑本身（目标同名已存在 ⇒ 冲突告警、**不搬不覆盖**，
  注释明写「留在原地由用户手决」）。它们是**设计上留给用户的**，代价只是每次引擎启动一条冲突告警。
  处置（归档 / 删除 / 保留）**等用户一句话**——引擎自己的代码就把这个决定权写成用户的。
