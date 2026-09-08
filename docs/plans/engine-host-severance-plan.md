# 引擎-宿主逻辑全断（engine-host-severance）

> 立项 2026-09-08。状态：In progress。
> 背景：用户审计诉求「图谱 engine 与兰台宿主关系太复杂，想把所有逻辑全断、engine 整个拆出来」。
> 拍板（2026-09-08，用户文字回复为准）：
> 1. **物理形态维持 monorepo**——不拆独立仓库（2026-08-23「monorepo 子目录」拍板延续有效）；本工程只做**逻辑收断**。
> 2. **引擎默认数据目录拍 A**：默认改 `.hologram` + 启动自动搬迁老数据；`.lantai` 从此只装宿主数据（sessions/memory/agents/宿主日志等），两产品彻底分居。

## §1 现状审计（2026-09-08 实测）

进程边界已建成（engine-plugin-extraction Phase 3，2026-08-29）：壳零内嵌引擎
（src-tauri 无 hologram-engine 依赖），每工作区 spawn `hologram-engine.exe serve`
子进程，stdio MCP（engine_transport：惰性 spawn + 死进程重建 + 传输级重启重试一次）。
本工程对象 = 拆到一半的尾巴：

| # | 尾巴 | 位置 |
|---|------|------|
| 1 | 壳攥三个数据 crate path 依赖；其中 StoreHost 生产面零消费（dead_code 豁免注释自认），活用面仅 `is_ignored_path` ×4 | src-tauri/Cargo.toml + app/mod.rs + editor_cap/fs_cap/search_cap/confined_fs |
| 2 | 引擎数据目录写死 `.lantai`（宿主品牌）：db/快照/向量/基线/日志/JSON 回退约 20 处 | engine + hologram-storage + hologram-vector |
| 3 | 引擎侧整目录迁移函数 `migrate_hologram_to_lantai`（会连宿主数据一起搬，职责越界） | engine/src/path_utils.rs（serve 启动兜底调用） |
| 4 | 引擎资产住在壳目录：onnxruntime.dll + models/ 在 src-tauri/；grammars/ 在仓根（tauri.conf 由壳侧引用） | src-tauri/{onnxruntime.dll,models} + grammars/ |
| 5 | 契约描述宿主化：「壳专属」、`.lantai/...` 字样、`[lantai]` 日志前缀 | contract.rs / tools/mod.rs / main.rs / path_utils.rs |
| 6 | 文档陈旧：ARCHITECTURE §2.1 仍在描述已死的应用层 Arc\<Engine\> 形态 | ARCHITECTURE.md |

反向已干净：引擎对兰台零依赖（hologram-engine 不依赖任何兰台 crate）；引擎已有
独立产品形态（CLI + MCP server 36 schema、自有插件契约 v4、release.yml engine-cli
双平台独立发版、dsh-bundle npm 分发）。

## §2 目标形态

拆完后，兰台对引擎的全部知识 = **spawn 一个 exe + MCP 协议**，再无其他。
引擎自包含于 `engine/`（代码 + 语法 DLL + 模型资产 + onnxruntime），数据目录自有
（项目根 `.hologram/`），契约描述 host 中性。壳侧守卫钉死：**壳禁依赖任何
hologram-\* crate**（源码 + Cargo.toml 双扫）。

## §3 批次

### 批 1 数据目录真源
- hologram-graph 新增 `paths::data_dir(root)`（`DATA_DIR_NAME = ".hologram"`）——
  底层类型 crate 作共享词汇真源（vector/storage/engine 全依赖它，无循环）。
- storage（sqlite/snapshot/memory/store）、vector（index 默认路径）、engine
  （pipeline/logging/main/preflight/staleness/audit/契约描述）全量 `.lantai` 数据
  字面量 → `data_dir()`；测试夹具同步。
- **不动**：忽略清单 `.hologram`/`.lantai` 双名共存（永久纪律）；壳侧 `.lantai`
  宿主数据语义（sessions/memory/logs/权限豁免等）。

### 批 2 引擎数据迁移
- engine/path_utils 新增 `migrate_engine_data(root)`：文件级 `.lantai` → `.hologram`。
  - 搬运清单：`hologram.db`（+ `-wal`/`-shm` 随 db 走）、`graph.snapshot(.tmp)`、
    `hologram_graph.json`、`vectors.usearch(.tmp)`、`vectors.slots.json(.tmp)`、
    `baseline.json`、`baseline_violations.json`、`logs/engine.log`。
  - 规则：目标已存在同名文件 → 冲突告警跳过不搬（保数据，绝不覆盖）；源缺 → 跳过；
    幂等；失败非致命（warn 继续）。
- **退役**引擎侧 `migrate_hologram_to_lantai`（整目录搬含宿主数据，职责越界；
  壳侧 utils.rs 的宿主数据迁移原样保留——宿主数据归宿主管）。
- `engine_init` 顶部接线（单漏斗，覆盖 serve / run / 全部 CLI 入口）。

### 批 3 壳摘 crate 依赖
- StoreHost 退役：app/mod.rs 删 `store_host` 字段与 `StoreHost::open`；
  `ContextInfo.ready` 语义改「引擎子进程已拉起」（`remote.is_some()`）——
  无前端消费面（rpc-contract 仅注册类型），契约形状不变。
- `is_ignored_path` 内联：壳新增 `ignored_paths.rs`（原样搬 hologram-graph::ignore
  语义 + vendor/bin 与 venv 前缀教训注释 + 测试）；四处调用点换 import。
  壳的文件忽略语义从此与引擎各自演化（本就是两个关注点）。
- src-tauri/Cargo.toml 删 hologram-graph/storage/vector 三条 path 依赖。
- 守卫升级：`shell_storage_vector_refs_use_dedicated_crates` →
  「壳源码 + Cargo.toml 零 hologram_\* crate 引用」；engine 全局直连守卫保留。

### 批 4 资产归位 engine/
- `src-tauri/onnxruntime.dll` → `engine/onnxruntime.dll`（git mv；顺带修复
  dsh-bundle pack-bin.mjs——其源头本就写 `engine/onnxruntime.dll`，现状静默 skip）。
- `src-tauri/models/all-MiniLM-L6-v2/` → `engine/models/all-MiniLM-L6-v2/`
  （vocab git mv；model.onnx gitignored，文件系统搬移 + .gitignore 条目改）。
- `grammars/` → `engine/grammars/`（git mv；引擎动态语法资产随引擎走）。
- 候选路径更新：minilm.rs（dll/模型候选去 src-tauri 变体、加 engine 变体）、
  wordpiece.rs 测试路径、grammar_loader `find_grammar_dir` 加 engine 侧候选。
- 打包面：tauri.conf.json resources 改 `../engine/...`；release.yml 模型下载路径
  改 `engine/models/...`；ci.yml 不动（实测无资产路径引用）。

### 批 5 契约描述去宿主化 + 文档写回
- 「壳专属」→ host 中性描述；`[lantai]` 前缀 → `[engine]`；壳 utils.rs 迁移注释同步
  （引擎侧副本已退役）。
- 文档：ARCHITECTURE §2.1 改 transport 现状 + 数据目录/资产位置同步；
  hologram-storage crate 头注释（宿主创建注入 → 引擎独有数据家）；hologram-graph
  ignore.rs 头注释（壳共享理由退役）；docs/plans/README.md 加本计划索引。

## §4 验收判据

| 门 | 命令 | 预期 |
|----|------|------|
| 引擎族 | `cargo test -p hologram-graph -p hologram-vector -p hologram-storage -p hologram-engine` | 全绿（705+，含新迁移用例） |
| 壳 | src-tauri `cargo test`（先 `cargo build -p hologram-engine` 供 transport e2e） | 全绿（新守卫零 crate 引用 + 旧守卫不回归） |
| 前端 | src-ui `$env:NODE_ENV='test'; npx vitest run` | 全绿（前端零改动预期） |
| 构建 | workspace `cargo build` + src-ui `npm run build` | 零错 |

真机验收（用户，待跑）：
1. 老项目（`.lantai` 有引擎数据）打开 → 引擎数据自动搬到 `.hologram` →
   图查询 / 向量召回 / 时间线 / preflight 如常；
2. 新项目 → 直接 `.hologram`，不产生 `.lantai` 引擎文件；
3. MCP 直连（.mcp.json）老项目同样自动搬迁；
4. 冲突项目（两目录都有 hologram.db）→ 告警不搬，引擎用 `.hologram` 不崩。

## §5 发现但不修（本工程范围外）

- ~~desktop release 的 tauri bundle resources 未见 `hologram-engine.exe` 打包条目~~
  **2026-09-09 已修**（见 §6 实施偏差第 5 条收口：beforeBuild/DevCommand 链引擎构建 + bundle resources 落 exe 同级）。
- `--tcp` 9777 旧协议（engine-plugin-extraction §8 留专项）原样。
- 版本号：摘依赖后锁步已无意义，维持 10.4.0 不动。

## §6 竣工记录（2026-09-08）

**五 commit 竣工**（门禁全绿后落库）：

| Commit | 内容 |
|---|---|
| `ecd64595` | 批 1+2：data_dir 真源 + 全量路径切换 + migrate_engine_data 启动搬迁 |
| `2cd4d751` | 批 3：壳摘三条 crate 依赖 + StoreHost 退役 + 向量召回改走子进程 + 守卫升级 |
| `8f6b3439` | 批 4：资产归位 engine/ + 打包面 map 钉落点 |
| `495b6652` | 批 5：契约描述与文档去宿主化 |
| `777d4600` | 附带修复：oauth 冻结基线补录（6575c04c 漏更致 HEAD 红，非本工程面） |

**门禁实测**：引擎 592 全绿；三库 53+46+16 全绿；壳 460 + 集成 1 全绿
（新守卫 `shell_has_zero_hologram_crate_refs` 含内）；前端 vitest 282 文件
2812 过 / 4 跳 / 0 红 + `npm run build` 零错（前端零改动，基线复核）。

**实施中的偏差与决定**：

1. **审计漏项——search_cap 向量召回**（守卫在批 6 验证时抓出）：壳的
   `append_vector_hits` 以 `use hologram_vector as vector` 别名形态进程内
   直读引擎索引文件 + 自载 MiniLM——`as` 别名躲过 `::` 形态依赖扫描。
   已改走 transport 调 `semantic_search` 模型工具，映射回既有 vector_hits
   形状（前端契约不变；非工作区目录不为其拉引擎，边车缺席）。
   **教训：依赖扫描必须含 `use X as Y` 别名形态**（守卫按 `::` 路径扫
   即可覆盖——别名 import 必然伴随 `X::` 全路径出现；本案例外是旧守卫
   只扫三个 crate 名，漏了 `hologram_engine::`，新守卫四名全扫）。
2. **「壳专属」术语保留**：实施判定其为 SHELL_METHODS 契约词汇
   （host-exclusive、泛指任意 MCP host，非兰台品牌），只改其中的
   `.lantai` 路径字面量——原计划的「措辞替换」收窄，避免契约面无谓翻动。
3. **并行窗口收编**：grammars 搬移使 kotlin DLL 在测试位可达，两个引擎
   测试旧假设失效（kotlin「恒 pending」、.md「恒非源码」）——并行窗口
   已改为环境无关断言（装载器注册面双臂分支 / 非源样本 .txt），本窗口
   审阅后照单收编入 `8f6b3439`。
4. **tauri 资源 map 形式**：dist-plugins 映射回现行 `_up_` 落点（探测面
   零变）；grammars 借 map 修正为 exe 同级——顺带修复打包态引擎探不到
   动态语法的隐性错位（list 形式下越界资源落 `_up_/grammars/`，引擎
   `<exe>/grammars` 探测永远落空）。
5. **desktop release 未见 hologram-engine.exe 打包条目**：§5 疑点原样
   在册（非本工程面，待另核实）。
   → **2026-09-09 已收口**（实机事故立法：当晚 target 清理 + `cargo tauri
   build` 只产壳不产引擎 → `hologram-engine.exe` 全树缺席 → 引擎起不来 →
   冷启动恢复链挂死状态机 → 首页一切工作区点击被 isBusy 守卫拦截，用户被
   锁死）。修复：tauri.conf `beforeDevCommand`/`beforeBuildCommand` 链上
   `cargo build -p hologram-engine`（dev 档 debug、build 档 release——引擎
   增量构建秒级，冷编一次后无感）+ `bundle.resources` 补
   `../target/release/hologram-engine.exe → hologram-engine.exe`（安装包
   落 exe 同级 = engine_exe_path 候选 1）。配套：恢复链卡死护栏
   （switchWorkspace 尾部 RPC 全 withTimeout 有界 + 首页「强制重置」逃生
   口，见 tests/workspace-lifecycle.test.ts「恢复链卡死护栏」）。

**真机验收清单（用户待跑）**——即 §4 四项：① 老项目自动搬迁后图查询/
向量召回/时间线如常；② 新项目直落 `.hologram`；③ MCP 直连老项目同样
自动搬迁；④ 冲突项目告警不搬、引擎用 `.hologram` 不崩。

## §7 附批：宿主引擎面死面清理（2026-09-08，用户拍板 B）

竣工后用户追问「宿主还有没有必要消费引擎」，给出 A 全退役 / B 清死面 /
C 去特例化（引擎降级用户自配 MCP server）三向，用户拍 **B**。审计
宿主引擎面 11 个 RPC 方法：**活 9 / 死 2**。

- **退役 2 条死链**：`hologram_record_event`（时间线记录的活路径是
  Rust 侧 record_timeline_transport_detached 直达 transport，不经 RPC
  往返）与 `dataflow_delete`（engine-domain 插件的模型工具只注册
  save/query 两件）——rpc 分支 / 命令壳 / 服务体 / TS 契约条目全链移除。
- **附带修复生成器失同步**：oauth 提交（6575c04c）在 rpc.rs 加的
  「OAuth 订阅平面」箱线组漏登 gen-rpc-contract-md.cjs 的 SECTIONS——
  其后所有方法在生成文档错挂一节、数据流整节被 section 溢出**静默丢表**；
  补位恢复 1:1（22 分区）。与该 commit 漏更冻结基线同属一类配套遗漏。
- **结论**：引擎面 rpc 除两死例外全部活跃（workspace_start_watcher、
  图谱开关、merge-gate 对 run_check 的复用皆在册）——「全下线」是
  产品级决定，未采纳；A/C 方向留档待用户将来重开。
