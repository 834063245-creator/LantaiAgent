# ADR: 项目宪法 — 四条架构约定

状态：**已采纳（2026-08-08）** · **修订（2026-08-25）增补第五条「平台边界」**

## 决策

以下五条约定是本仓库的最高工程纪律。新代码（含 AI 生成）违反任一条，审查即打回；旧代码违反，登记进 `docs/landmine-map.md` 按批拆除，不搞一次性大改造。

### 一、类型边界 — 禁止 String 当合约

跨层数据（IPC / RPC / 落盘）必须用类型化结构，序列化/反序列化只允许发生在边界单点。

- Rust↔前端：Tauri command 与 engine RPC 以 `serde_json::Value` 或强类型结构为合约，禁止 `Result<String, String>` 传 JSON 再让对面自己 parse。
- 落盘：每个文件格式有**唯一** encode/decode 函数对，其余代码不得自行拼/解。
- 判定问题：「这段字符串的结构，有几处代码知道？」答案 >1 即违例。

### 二、单一权威源 — 每份状态只有一个家

每份状态有唯一权威存储；其他地方只能是指向它的引用或一次性快照。

- 禁止双写；禁止「读回再回写」驱动器（loop-purity 的存储版）。
- 密钥权威 = `credentials.enc`；设置权威 = `settings.json`；`localStorage` 只是缓存——启动时单向加载，运行时不回写。
- 判定问题：「这个值变了，要改几个地方才算改完？」答案 >1 即违例。

### 三、异步纪律 — tokio worker 只跑异步

- 阻塞操作（文件 IO、加解密、子进程等待、引擎调用）一律 `spawn_blocking`，不得内联在 tokio worker 上执行。
- 锁内不 await、不阻塞 IO；持锁只做内存操作。
- `Mutex::lock().unwrap()` 禁止；统一 `lock_or_err`（src-tauri 域，utils.rs helper）；engine 域锁解锁用 `unwrap_or_else(|e| e.into_inner())`（std PoisonError 降级，先例 `engine/src/graph/id.rs`）。两条路都要求生产代码零裸 unwrap（2026-08-12 达成，见 CONVENTIONS.md）。
- 判定问题：「这行代码会让 tokio worker 停着不动吗？」会即违例。

### 四、错误不静默 — 失败必须可见

- 解析/读取失败不得返回 `None`/默认值冒充成功；要么传播，要么显式降级 + warn 日志。
- 写失败必须让调用方知道（UI 据实提示），禁止「失败报成功」。
- 重试必须有退避和上限，禁止无限热循环。
- 判定问题：「这一步失败时，用户/日志/调用方谁能知道？」都不知道即违例。

### 五、平台边界 — 强制层特权，能力契约全开

2026-08-25 增补（`docs/archive/agent-platformization-plan.md` Phase 0）。软件以平台为方向：能拆的都要拆成行 / provider，特权区只减不增。

- **强制层（特权，永不插件化）**：cordis 内核 + 根引导、Loader + 组合引擎本体（roster/patch/行生命周期）、slot/注册表机制（全部 `ctx.*` 服务的注册机制）、React root + 壳容器、RPC 平台面（`rpc.rs` 冻结契约 + 权限咽喉 + agentInvoke + biome 受权出口）、沙箱内核、审计、Workspace 原语（fiber·epoch·scoped store）、星图 scene（GPU 资源豁免）。
- **能力契约层（线外）**：一切功能面均为行 / provider。**能力实现不是特权**——fs / shell / subprocess / session 持久化 / graph 分析 / LLM / 子代理 / agent loop 均为 seam，Rust / engine 是默认 provider 后端，可被配置替换或叠加。
- **新能力加面规则**：优先开放面（前端 seam / 外部 MCP / 动态插件）；**强制层外不得新增 Rust 命令**（守卫测试 `src-tauri/tests/platform_boundary_test.rs` 钉住）；必须改动强制层（权限/沙箱/审计/IPC/组合引擎）时，须显式标注 + 宪法审查。
- **判定问题**：「这个能力能不能被配置换成另一实现？」不能且不该 → 强制层；能 → 必须走开放面，禁止写在特权代码里。
- 权威扩展：强制层/能力契约层清单与施工顺序以 `docs/archive/agent-platformization-plan.md` 为准，本条约不自行演化。

## 背景

2026-08-08 凭据毒化案（`credentials.enc` 双重编码至 256MB 击毁 WebView2）结案后，三路审计（`docs/landmine-map.md`）发现 24 颗雷全部可归入此四根。反证同样成立：凡立过约定的地方（`write_atomic` 原子写、GoalManager 状态隔离、R 系列句柄化）零雷——约定有效，缺的只是全面性。

## 与拆弹的关系

P0 逐颗拆除时，每颗顺手落实对应约定并配回归测试。全部 P0 拆完后，另立专项目做两根最贵的根治：

- 病根一 → RPC `Value` 化 + 边界 schema（雷区地图 L 级条目）
- 病根二 → settings 单一权威源

## 不做

- ❌ 为约定而重构健康代码（健康区见雷区地图，不碰）
- ❌ 一次性大改造——约定只在拆弹和新代码中生效
