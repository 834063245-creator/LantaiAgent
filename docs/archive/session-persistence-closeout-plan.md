# 会话存盘换轨 · 收口施工单（2026-10-29）

> **状态：已竣工（2026-10-29 当日收口，八项全清；门禁全绿）**——本单已归档。
> 起因：用户「今天就专门做换轨的收口，目标全清」。
> 判据来源：`session-persistence-dsh-port-plan.md` §三「换轨后仍留的口子」+
> `docs/session-persistence-audit.md` §9 + `docs/landmine-map.md` 第六批 S7/S8 +
> 2026-10-29 逐条对码复核（不是照抄文档——文档有多处过期）。

## 0. 余项清单与裁定（决定在前）

| # | 余项 | 我的裁定 | 判据（收口证据） |
|---|---|---|---|
| 1 | 跨进程/多实例未裁决 | **裁「单写者 = 单实例」并强制**：启动期用户级文件锁，第二实例提示后退出。不引依赖（Rust 1.89 起 `File::try_lock` 是 std） | Rust 锁测试（同进程两句柄：第二把必须 `WouldBlock`）+ INVARIANTS 新条 |
| 2 | 读面没走链 | 读前**排空同路径写面**（写后队列的屏障就是静默点）：`_live` 改按路径寻址，`loadSessionLogFile` 的两条调用路径先 `flush` 再读；`openSessionLog` 的截断因此永远落在已静默的文件上 | 新增用例：活写面 + 并发读到「写到一半的尾巴」→ 不得截断掉在途批次 |
| 3 | 日志体积无压实 | **治源头而非事后压缩**：`adopt` 的系统提示与日志头部逐字节相同时不再重复写全文（实测 63 号卷 6 次开卷 = 210KB 全是同一条 36KB 系统提示的副本）；旧卷不迁移（既定口径）。chunk packing / zstd 判**不做**（无体积证据：本机 716 事件 ≈ 1.5MB ≈ 2KB/事件，DSH 那一层是可选优化）；补尺寸观测（单卷超阈值 warn） | adopt 去重测试 + 开卷后文件增量断言（同提示 = 事件 < 200B） |
| 4 | 物化写不 fsync | `write_log` 走 durable 变体（tmp 写 + `sync_all` + 原子替换）；投影缓存（`save_volume`）不升级——它是缓存不是真源 | Rust `write_text_durable` + 失败可见 |
| 5 | 单卷读失败 = 「卷不存在」 | 读路径**区分缺失与失败**：缺失（ENOENT）→ 空；读取失败 → 抛，消费面保留上次结果并可见（沿用侧栏载入批的范式） | 用例：坏卷读失败不得被当成「卷不存在」而移出摊开集 |
| 6 | 死码：`agent_session_append` RPC / `goal-resume`·`goal-parked` | 直接删（零产线调用方；`goal-*` 两个 reason 零 call site） | 契约再生成 + `cargo test` + 全量 vitest |
| 7 | 测试面 S7 两项 | 补：①**断尾注入**（真实字节：半行 UTF-8 / 半 JSON 尾巴 → 打开即截断 + 补悬空调用）；②**写放大断言**（append 只增长批次字节；读面零写） | 新测试文件 + 实测数字进本单 §3 |
| 8 | 文档尾巴 | 本单即新家：收口完归档 `session-persistence-dsh-port-plan.md`，回写 plans/README / HISTORY / landmine S7·S8 / audit §9 | `npm run doc-check` 绿 |

**已裁定不做（别再翻）**：`.bak` 只读回退 · 墓碑删除 · 旧 `.json` 卷兼容读 · 卷级 revision 版本化 · 日志 zstd/chunk packing。

## 1. 批次与门禁

| 批 | 内容 | 门禁 |
|---|---|---|
| A | 死码两笔 + 物化 durable + adopt 去重 | `vitest`（session-log* / sessions-seam）+ `cargo test`（壳）+ `build` |
| B | 读面串行化 + detach 退订 + 读失败可见 | `vitest`（chat-session / session-log-store / session-restore-snapshot / sessions-seam） |
| C | 单实例守卫 | `cargo test`（壳）+ INVARIANTS 条目 |
| D | 断尾注入 / 写放大 / 尺寸观测 + 实测 | `vitest` |
| E | 文档归档 + 全量门禁 | `vitest` + `build` + `biome ci` + `verify:convergence` + `doc-check` |

## 2. 关键实现决定

- **读面屏障**：`_live` 由 `Set<SessionLogStore>` 改 `Map<path, SessionLogStore>`；读入口
  `readVolumeLogMessages` / `openSessionLog` 先 `await store.flush()` 再读。理由：写后队列是
  该文件**唯一**写入面，屏障 = 文件确实静默，不需要第二个锁原语（DSH `readStableFile`
  的 revision 双 stat 在「单进程单写面」下是同一件事的两种实现，选屏障是因为它同时
  覆盖了紧凑窗口）。
- **同卷两个写面**：`attachSessionLogStore` 若发现同路径已有别的活写面 —— 先退休旧的
  （flush + 退订 + 断 sink）再挂新的，并 warn 一次；两个写面并行 = 两份独立 seq 游标
  写同一文件（必坏），退休是唯一安全解。
- **detach 必须退订**：`onEvent` 返回 Disposer，现状丢弃 ⇒ detach 后事件仍进队列。
- **单实例锁**：`~/.lantai/instance.lock`，`try_lock` 失败 → `MessageBoxW` 提示 + 退出
  （复用 `purge.rs` 的 message_box 写法）。锁句柄进程内 `mem::forget`（活到退出）。

## 3. 实测数字（收口前 → 收口后）

| 观测 | 收口前 | 收口后 |
|---|---|---|
| 63 号卷 6 次开卷写入 | 6 × ~35.5KB ≈ 210KB（全是同一系统提示的副本，占该卷 580KB 的 36%） | 每次一条零字节事实事件（≈100B；同提示不重复写，不同才写一次） |
| 66 号卷（716 事件 / 1.52MB） | append 只写批次 | 同（`tests/session-log-store.test.ts` 断言：200KB 卷追加一条 = 一条事件的字节数，读面零写） |
| 读 1.5MB 日志一次 | 扫描 + 重放 | 同（读前多一次屏障；无在途写面时 = no-op，稳态零成本） |
| 日志尺寸观测 | 无 | 单卷累计写入 >8 MiB 时 warn 一次（不自动压缩——append-only 真相 + 旧数据不迁移） |

**原始证据（2026-10-29 对 `.lantai/sessions` 实测）**：63 号卷 `session/reset` 7 条共 234KB
（其中 6 条 `adopt` = 210KB，均载同一条 36KB 系统提示）；66 号卷 716 事件 1.52MB
（`tool/result` 661KB + `assistant/text` 615KB 是内容本身，不是重复）。
