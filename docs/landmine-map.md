# 兰台雷区地图（技术债清单）

> 生成：2026-08-08 · 三路只读审计（前端接缝 / Rust 后端接缝 / 横切面）汇总
> 收录标准：有真实引爆路径。风格问题不收录。
> 拆除成本：S = 1 小时内 · M = 1 天内 · L = 更大

## 背景：雷的家族谱

2026-08-08 凭据毒化事故（256MB IPC 响应击毁 WebView2）教会我们识别雷的指纹：
**接缝处靠人肉纪律维持正确性 + 失败被静默吞掉 + 单测全绿**。以下条目按此指纹排查得出。

---

## P0 — 爆炸半径大且拆除便宜（建议第一批）

| # | 位置 | 雷 | 触发 → 后果 | 护栏 | 成本 |
|---|------|----|------------|------|------|
| 1 | `src-tauri/src/commands/engine_dispatch.rs:9-46` | `hologram_call` 同步内联调度占 tokio worker | Agent 每次引擎工具调用（大图上秒级）直接占住 async worker；并发调用 + UI 轮询叠加 → 线程池耗尽，**全部 IPC 挂起（含权限弹窗）**。main.rs:198 的测试注释明知的病，此入口漏网 | ✅ 已拆（spawn_blocking + 饥饿回归测试） | S（包 spawn_blocking） |
| 2 | `commands/graph.rs:16`、`hologram.rs:16`、`filesystem.rs:80`（read_file_base64）、`git_cmds.rs:65/78/265`、`isolation.rs:60` | **大响应无尺寸上限**——与 256MB 事故同一物理通道 | 大仓库图 JSON / 99MiB 文件 base64（~200MB 转义后）/ minified 文件 diff → 复刻 WebView2 击毁。注：git 系列没有 exec_command 那样的 32KB 截断 | ✅ 已拆（truncate_output 提为共享 + git×3/isolation 截断 + base64 8MiB 上限 + 图 128MB 硬护栏 + 图分页落地：纯传输分页、边按 max(端点页) 增量下发、全量到齐原子换入后一次渲染） | S~M（截断/上限/分页） |
| 3 | `src-tauri/src/utils.rs:1361-1392` | `write_atomic` 的 .bak 残留死锁 | Windows rename 不覆盖：上次崩溃残留 .bak → 对该文件的**所有后续写入永久失败**，直到手工删 .bak | ✅ 已拆（rename 前先删旧 .bak + 回归测试） | S（rename 前先删旧 .bak） |
| 4 | `src-tauri/src/utils.rs:845` | `hologram_graph.json` 非原子写入 + `let _ =` 吞错 | 大图落盘（数百 MB 窗口长）中途崩溃 → 截断 JSON 被冷启动原样读回 → 解析失败，且无声 | ✅ 已拆（write_atomic + 失败 eprintln 告警） | S（换用现成 write_atomic） |
| 5 | `src-tauri/src/permissions/rule.rs:204` | `permissions.json` 非原子读-改-写 | 落盘时崩溃 → 加载端静默返回空规则 → **用户自定义 deny 规则全部丢失，安全 fail-open 无告警** | ✅ 已拆（write_atomic + 读/解析失败告警 + 损坏拒绝追加以免清空规则 + 测试×3） | S |
| 6 | `src-ui/src/agent/message-store.ts:80-83` | **读失败即删数据** | 启动 restore 时 `read_file_content` 因任何瞬时错误失败 → catch 里 delete inbox.json → 跨 Agent 未投递消息静默丢失 | ✅ 已拆（仅「不存在」才清理，读/解析失败保留 + warn；测试×3） | S（区分「不存在」与「读错误」） |
| 7 | `src-ui/src/settings.ts:164-168` × `SettingsPanel.tsx:296` | 凭据写失败 UI 报「已保存」 | DPAPI 写失败被两层 catch 吞掉 + 无条件 setSaved(true) → 重启后 key 消失，用户坚信已保存 | ✅ 已拆（persistSecrets 返回失败列表 + handleSave await 并据实 alert；测试×2） | S（失败列表上抛 + UI 据实提示） |
| 8 | `src-ui/src/ui/react/TimelineHUD.tsx:84-92` | **空时间轴无限 IPC 热循环**（唯一确定性风暴源） | 项目无 timeline 事件 → effect 依赖翻转 → 无退避无上限的 hologram_call 循环，速度=IPC 往返速度，永久轰击引擎 | ✅ 已拆（首次立即 + 2/4/6s 退避 ×3 后停止；组件级 fake-timers 回归测试） | S（尝试计数/退避） |
| 9 | `src-ui/src/settings.ts:134` × `ui/chat-session.ts:429` | localStorage 配额跨存储干扰 | 会话全量备份无界增长 → 配额耗尽 → saveSettings 的 setItem **无 try** 同步抛 → handleSave 在 persistSecrets 之前崩 → key 从未落凭据库 | ✅ 已拆（saveSettings try+warn 不中断；会话备份 >1MB 跳过 localStorage；配额回归测试） | S（上限 + try + 报错） |
| 10 | `src-ui/src/workspace.ts:622-626` | setupAgent 覆盖 runtime 不 dispose | 每次设置保存新建 AgentRuntime 直接覆盖，旧 runtime 的订阅/防抖 flush 定时器仍活着 → 泄漏 + **旧快照可能回写覆盖新看板** | ✅ 已拆（覆盖前 flushAllBoards + disposeAll，复用销毁路径同一顺序） | S（覆盖前 disposeAll） |
| 11 | `src-tauri/src/pty_manager.rs:85-99` | PTY 读取线程持全局锁阻塞 read | 终端无输出时 pty_kill/resize/write 全部拿不到锁 → PTY 子系统假死 | ✅ 已拆（reader 归读取线程独有 + 顺带根治潜伏 bug：ChildKiller drop 在 Windows 不杀进程，reap 显式 kill + 分离线程 drop；测试×2） | S（read 移出锁） |
| 12 | `graph.rs:24`、`filesystem.rs:103` 等 10 处 `state.lock().unwrap()` + `BG_JOBS.lock().unwrap()` 集群 | 锁中毒连锁 | 任一持锁点 panic → 整个 IPC 面 / 后台任务系统全部 panic 变砖。项目里已有 map_err 正确范式但未统一 | ✅ 已拆（lock_or_recover/read_or_recover/write_or_recover 三 helper：中毒恢复 + eprintln 告警；57 处 Mutex + 6 处 RwLock 全量替换；中毒回归测试） | S（统一 lock_or_err helper） |

## P1 — 第二批（中等半径或 M 成本）

| # | 位置 | 雷 | 成本 | 护栏 |
|---|------|----|------|------|
| 13 | `agent-store.ts:168-184` | index.json 读-改-写跨异步无锁，多 Agent 并发 saveState 互相覆盖；state/session/index 三文件可留下矛盾现场 | M（写链串行化，参照 BoardPersistence._writeChain） | ✅ 已拆（_indexChain 串行链：_upsertIndex/delete 的读-改-写包进链内，并发后写者在最新值上追加；测试×4） |
| 14 | `chat-session.ts:519-537` | localStorage 回退使已删会话「复活」——与 null 复活同构（删除只删了一个存储） | M（复活前要求磁盘文件存在） | ✅ 已拆（三处 localStorage 采纳前验磁盘文件存在且非 deleted；残留顺手清理；测试×3+1 既有改规格） |
| 15 | `agent.ts:792` + `agent-store.ts:93` | 每轮对话全量重写会话（O(全量) 写放大；聊天侧已有增量 NDJSON，agent 侧没有） | M | ✅ 已拆（agent_session_append NDJSON 增量 + 增量游标；撤回/替换时 rewrite 重建；load 兼容 NDJSON+旧 JSON；测试×6） |
| 16 | `commands/shell.rs:258-318` | exec_command 非流式路径 `try_wait`+sleep 忙等，最长占 worker 300s | S~M | ✅ 已拆（等待段抽 wait_child_blocking 移入 spawn_blocking；测试×3） |
| 17 | `utils.rs:305-325` | bash_wait 非 shared 分支**持 BG_JOBS 锁做阻塞管道读**；非 Windows 可继承管道 → 孙进程持写端 → 永久阻塞 → bash_* 全瘫（Windows 靠不可继承管道幸免） | M | ✅ 已拆（BgJob.shared 改必填字段，阻塞读分支从类型上删除；read_bg_output/wait_bg/kill_bg 三处只读 Arc；测试×2） |
| 18 | `commands/isolation.rs:8-164` | worktree 生命周期操作全部是阻塞进程等待内联在 worker 上 | S | ✅ 已拆（六命令改 &WorkspaceState 签名 + rpc.rs 全部 spawn_blocking；测试×2） |
| 19 | `external.rs:25-43` + `mcp_manager.rs:120` | MCP start 持锁最长 600s；此时 stop_mcp try_lock **静默跳过** → 旧 serve 进程残留 + 新 start 卡死 =「切换项目卡死」 | M | ✅ 已拆（start 拆 begin/finish 两阶段 + 纪元戳，长等待不持锁不占 worker；stop_mcp 改阻塞取锁；测试×3） |
| 20 | `lsp_manager.rs:87-92` | LSP 初始化失败/超时返回 Err 前不杀子进程，每次重试泄漏一个语言服务器 | S | ✅ 已拆（reap_failed_child kill+wait，含 stdout/stdin take 失败路径；测试×1） |
| 21 | `shell.rs:73` | 前台 exec_command 子进程不进 ledger；非 Windows 无 Job Object → 孤儿进程（平台盲区） | M | ✅ 已拆（register_fg_child 前台注册进 BG_JOBS，流式/非流式皆注册，完成/超时/被杀后移除；kill_all_bg 可终止前台命令；测试×2。⚠️ 平台盲区保留：非 Windows kill_tree 只杀直接子进程，进程组孤儿根治需 setsid） |
| 22 | `agent/board-persistence.ts:57-81` | _ensureDir 失败后照样 `_dirReady=true` → board 永不落盘且永不再试，重启全丢，零信号 | S | ✅ 已拆（后端 create_dir_all 幂等故任何抛错都是真实失败：不置位+下次重试+warn 信号；测试×2） |
| 23 | `src-tauri/src/audit.rs:34-45` | 审计日志写失败静默 → deny/审批不留痕，安全功能失效无法取证 | S（eprintln + 计数） | ✅ 已拆（eprintln 告警含丢失记录摘要 + AtomicU64 计数；测试×2） |
| 24 | `ui/FileTranslatorPanel.tsx:352` | read_file_content 缓存路径漏 stripLineNumbers → 翻译缓存 100% 不命中（已在坏，无声烧钱） | S | ✅ 已拆（stripLineNumbers + 顺带拆 computeStats 身份导致的 IPC 热循环；测试×1） |
| 25 | `ui/react/ChatFooter.tsx` × `settings.ts:saveSettings` × `events.ts:agent:config-changed` | **持久化函数兼职控制总线**：模式按钮靠 saveSettings 生效，但 Agent 重建链挂在独立槽 getOnSettingsSave——两条订阅通道并存，任何新增 saveSettings 调用点都可能漏重建链 | 规划按钮高亮但 Agent 不变只读（已真实引爆）；同类调用点会静默失效，单测全绿拦不住 | ✅ 已根治：`saveSettings` 回归纯持久化；设置面板/模型切换/模式按钮统一发 `agent:config-changed`，main.ts 单一监听 → `Workspace.applyAgentConfig` 决定是否重建（重建前先存会话）；权限模式不发事件 | S~M |
| 26 | `paper/canvas-math.ts` `layoutFlow` × `state/canvas-store.ts` `loadCanvas` × `PaperPanel.tsx` `adaptBlocks` | **NaN 布局级联**：流区宽脏（磁盘恢复透传无校验 / 运行态异常）→ 块宽 NaN → 测高 NaN → 布局游标被污染 → **坏块及其上方所有块 y 全 NaN** → 虚拟化二分失效、块消失、排版打碎（症状：「追加输入后来文消失 + 从坏点起全乱」，合卷重摊开自愈） | 偶发，触发源未 100% 锁定（运行态 NaN 来源存疑；磁盘侧已封） | ✅ 已拆（三层兜底：loadCanvas 恢复校验 width∈[720,2160]/anchor 有限数；adaptBlocks 宽兜底；layoutFlow h/w 兜底宁可压扁单块不级联全卷）。排查全档见 `docs/paper-stream-region-cascade-bug.md`（含取证手册——再复现先抓证据） | S |
| 27 | `plugins/builtin/paper-shell/use-paper-regions.ts`（regions memo 的 regionTop 段；拆解前 `PaperPanel.tsx`） | **哨兵值冒充数据**：`let top = 0; for (…) top = Math.min(top, g.y)`——0 是「无块」的初值，零块卷却把它当 regionTop 用 → **空卷纸面钉在世界原点**（`top = regionTop - folioH`），与锚点无关：新建卷摊开时纸画在别处，首句落墨才跳回锚点（用户症状「新建卷第一句话之前位置不对」）。同族：`let ex0 = Infinity` 那组靠 `!Number.isFinite` 兜底才没炸，而 `Math.min(0, …)` 恒有限数——**兜底检查查不出「合法但语义错」的哨兵** | 每个新建卷必现（200px 量级的视觉错位，不崩不报错，测试全绿） | ✅ 已拆（无 flow 块 → regionTop = anchorY − `EMPTY_REGION_CONTENT_H`（paper/space 单一真源），空卷也是一张贴在锚点上的纸；空卷 extent 兜底同源，测试钉 `top`/`height` 绝对值） | S |
| 28 | `composition/space-service.ts:expand` × `ui/chat-session.ts:loadSessionFromDisk`（原 `Promise<void>`） | **失败路径照样发后续请求**：`loadSessionFromDisk` 用 `Promise<void>` 抹掉了成败——卷已删/墓碑/坏档时它 toast 后 return，`expand` 却照旧 `requestFocus` → 失败卷永远不进摊开集，**定位请求永不兑现也永不自清**（只能靠用户平移/滚轮顺手清掉）；调用侧还各自再无条件补一次（同病灶三份） | 点已删卷（案头签条架「续写」签条来自磁盘列表；侧边栏合卷行）→ 视角不动且挂着一个永不兑现的请求；`Promise<void>` 的 void 是根因载体 | ✅ 已拆（`loadSessionFromDisk` → `Promise<boolean>`（true = 已在案头）；`expand` = 摊开+定位单一权威入口，成功才 requestFocus；调用侧三处无条件 requestFocus 删除；`onNew` 建卷失败不再飞上一个活跃卷）。同族纪律：**返回 void 的异步命令若下游还有依赖其成败的动作，void 就是在埋这个雷** | S |

## P2 — 存疑/低危（记录在案，暂不拆）

- `agent/goal-manager.ts:123,206`：parse 有 try 但无形状校验（:143 有正确示范没跟上）
- `message-bus.ts:158`：unregister 删 inbox 失败 → 死 agent 的 request 消息重启复活（消费路径未证实，存疑）
- `DataflowPanel.tsx:313-322`：typeof==='string'?parse:原样 的双重编码启发式残留
- 87 个死 `#[tauri::command]` 属性（未注册进 invoke_handler——实测 87，非原记 ~30；invoke_handler 只注册 `rpc::rpc` + `get_active_project`）——谁误注册谁把重活带上 UI 主线程；**留待专项核签**：函数可能用 `tauri::State`/`Window` 参数，删注解需逐个验签名（30+ 文件）
- `agent-identity.test.ts:62` 把「saveState 吞错不抛」**当规格断言固化**——拆 ① 类吞错时需先松绑测试

## 已确认健康（不要再动）

- 凭据/设置接缝：读写单一入口 + parseRpcString 集中 + 长度/null 四护栏（三轮事故修复后最健康的区域）
- 前端 95 处 JSON.parse 的 try 覆盖率很高——**解析层已吸取教训，写入层还没有**
- `write_atomic` 范式、`confined_fs` 100MiB/超时/spawn_blocking 三件套、shell 输出 32KB 截断——正确范式已建立，问题是覆盖不全

## 根治级（L，另立项目）

**rpc 返回值 Value 化**：`rpc` 命令返回 `serde_json::Value` 替代预序列化 String，删除前端全部启发式解析。一次拆掉整个「双重编码」bug 家族。
✅ **已拍板立项（2026-08-08）**——用户确认必须做，不再等「下次大动 IPC 层」的自然触发（该前提可能永不出现：新功能都是往 rpc 加 match 分支，不会大动通道）。
✅ **第一步已落地（2026-08-22，commit be8bba85）**：① Rust 出口 Value 化——rpc 命令返回 `Result<Value, String>`，commands 层零改动，出口 `str_to_value` **纯包装 Value::String、故意不 parse**；② 前端 `typedJsonRpc<T>`——typedRpc+parseJson 的组合收敛单函数，20 处调用点双重编码消灭；agentInvoke 直通 string，agent 工具链零改动。真机验证：CDP 实测 invoke 返回 string 形态字节精确。
🔶 **第二步已落地（2026-08-22，B 路线出口分派）**：Rust 出口建「命令→形态」分派表（rpc.rs `rpc_result_shape`，基于前端同源答案卷逐命令核对 Ok 路径）：**JsonValue 命令**（21 个：hologram_tools_list/analyze_and_load/get_graph_meta/engine_impact/git_status/git_log/list_directory/list_directory_flat/user_sessions_list/search_content/glob/web_search/shell_env/background_activity/credential_get/agent_isolation_create/status/diff/sandbox_status/plugin_install/lsp_request/desktop_status/desktop_audit）Ok 路径 parse 成真结构化 Value（parse 失败=违反「Ok 恒为合法 JSON」契约，转 Err 可见）；**其余全部 Text** 字节精确直通（保守铁律：Text 误标 JsonValue 才是字节级破坏，反向只是慢路径）。动态形态命令一律 Text（hologram_call 元命令/get_graph_page 体积/dataflow_query 磁盘直通/drain_bg_notifications 空串/exec_command 双形态）。前端两入口配套：`typedJsonRpc` 双形态 shim（结构化透传 / 字符串 parse 慢路径——浏览器 mock 兼容）；`agentInvoke` 对结构化返回回卷 JSON 字符串（agent 工具链 string 世界零改动）。回归钉死：Rust `dispatch_result_to_value_shapes`（4 形态×Ok/Err）+ 前端 `tests/rpc-value-shapes.test.ts`（双形态 shim + 回卷链）。附带收益：契约注释漂移校正（git_diff 系实际是 git stdout 文本、sandbox_status/read_memory_batch 实际是 JSON）；gen 脚本 singleRe 起点限制在 match 之后（shape 表单行分支同形，曾被误列进契约表）。**真机验证通过（2026-08-22 双轮）**：① CDP 直 invoke——JsonValue 命令（shell_env/get_graph_meta/list_directory/sandbox_status）返结构化 VALUE、Text 命令（read_file_content 带行号原文/llm_proxy_port）返字节精确 STRING、Err 路径人话报错照常 reject；② 用户填 key 真实会话——Agent 全工具链（文件/搜索/git 等）实测通过，回卷链无 [object Object]/双重编码症状。
✅ **第三步已竣工（2026-09-01 设计当日施工，commit ea1606b6 合入 main）**：边界 schema——`typedJsonRpc` 的 `JSON.parse(raw) as T` 盲转收进运行时形状校验（UI 全面审计批唯一挂起项，taste-ledger 2026-09-01；设计件 [`../design/rpc-runtime-validation-design.md`](../design/rpc-runtime-validation-design.md)——zod 同址表定案，初版「重载并存渐进收编」经用户质疑判死改一刀切）。落地：`rpcResultSchemas` 与 `RpcContract` 同址共治（`satisfies` 钉键拼写）+ 签名收紧 `M extends keyof typeof rpcResultSchemas`（未登记命令 = 编译错；泛型盲转 `typedJsonRpc<` 全库零残留，终态守卫钉死不回潮）+ parse 后 safeParse 违形即 throw（错误带方法名 + zod issue 摘要，宪法四）+ 三重守护 `tests/rpc-result-schemas.test.ts`（mock 同源自检 / schema 四态 / `typedJsonRpc<` 残留守卫）；§8 CDP 真机验收降维组件测试 `sessions-home-fault.test.tsx`（违形 → 首页显式报错态，绝不静默落「还没有工作区」空态）。批二长尾按设计无施工日——未来首个调用者被签名强制入表。R 批次演化（2026-09-05）：收编面 12→6 命令——list_directory/list_directory_flat/read_memory_batch 随 fs 域收口迁 fs_cap 助手内联 zod（dirEntryArraySchema）、shell_env/git_status 随 shell/git 域收口迁 process_cap/git_cap 文本路径（aura_init 更早已随 AURA 记忆系统拆除退役），校验面随命令迁移不消失。
📌 **前置已就位（2026-08-12，第二批）**：前端 138 处裸 `rpc` 调用已全量收敛到 `typedRpc`（rpc-contract.ts 单一入口，契约 result 一律 string，biome 禁令防新增）——届时 Value 化只需改 `typedRpc`/`rpc-contract.ts` 单点 + 收敛各调用点的 JSON.parse，不需要再全库扫调用面。

## 建议拆弹顺序

1. **第一批（P0 全部，~1 天）**：12 颗全是 S 级，每颗配回归测试，一次一颗小 commit ✅ 已完成
2. **第二批（P1 的 16/17/19/22/23，~1 天）**：阻塞持锁与吞错类 ✅ 已完成
3. **第三批（P1 剩余，按需）**：写放大与竞态类（13/14/15/21），需要设计，别赶工 ✅ 已完成（2026-08-08，cargo 226 · tsc 0 · vitest 798）
4. **第四批（已立项，待排期）**：rpc 返回值 Value 化（L 级，独立项目，见根治级段）——开工前先清 P2 双重编码残留热身

---

## 第二批审计（2026-08-17）— 工作区生命周期/状态管理家族

> 来源：四路并行只读审计（workspace 对称性 / 模块级状态 / 异步竞态 / 单例与会话资源），
> 触发点是 state-inject 缓存修复（commit `176f4873`）暴露的同族病。
> 家族指纹：**全局单例 + fire-and-forget 在途 + 工作区切换无代际/无清理**——
> 「工作区存活期」没有结构体，deactivate 靠人肉枚举清理对象，枚举必然漂移。

### P0 — 高危（有真实引爆路径）

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| H1 | `ui/lsp-client.ts:36` + `:47` | `diagnosticsCache` 永不清、无界、`stopAllLsp()` 不清；`getDiagnosticsForFile` 有 basename 尾匹配 | 旧项目诊断注入新项目 Agent 上下文（经 setDiagnosticsSource → state hooks）；同项目同名不同目录文件互串 | ✅ 已拆（Commit `f0f38731`：stopAllLsp 清 cache+warned、全路径精确比较、listen 幂等化） |
| H2 | `ui/file-viewer.tsx:47` + `lsp-client.ts:167` | 第二份私有 `lspSessions`（stopAllLsp 清不到）+ `startLsp` 在途 resolve 无代际 | 切换后 LSP 永久假死且状态栏显示已连接；在途 resolve 把 B 项目文件内容发进 A 的 tsserver | ✅ 已拆（Commit `ede255d1`：会话表单一事实源 `getLspSession` + startLsp epoch 防护） |
| H3 | `workspace.ts` `forceClearState()` | deactivate 超时走紧急路径时恰恰不调 `disposeAll()` | 60s 巡检 timer 永久存活，`_enforceTTL` 继续发 `agent_isolation_discard`（真实删 worktree）；saveState 不落盘留 'running' 死账 | ✅ 已拆（Commit `d4a800e6`：forceClearState 补 disposeAll+auraShutdown+resetAgentCaches） |
| H4 | `workspace.ts:898` `runCheck` | 在途 RPC resolve 后无 `_active` 守卫；finally 在清理后重新武装 checkTimer | 旧项目检查结果写进新项目 dock store + 自动弹面板；与新项目自身 runCheck 竞争 | ✅ 已拆（Commit `1926cf73`：runCheck/scheduleCheck/finally 三处 `_active` 守卫） |
| H5 | `ui/chat-session.ts:549`（冻结文件） | `autoRestoreLastSession` fire-and-forget 跨 await 不校验项目；`_autoSaveTimers` 捕获旧 projectPath | A 的会话列表覆盖 B 的面板（拿 B 的 factory 灌 A 的消息）；新会话可被写进旧项目目录 | ✅ 已拆（Commit `462b2ea1`：最小外科手术 — 三处 epoch 校验） |

### P1 — 中危

| # | 位置 | 雷 | 状态 |
|---|------|----|------|
| M1 | `ui/agent-panel-store.ts` + `workspace.ts:492` | `runtimeRef`/`currentSessionId`/`messageFlow`/`alerts` 切换不重置 → 2s 轮询拿旧会话 id 在新 runtime 建错位 board | ✅ 已拆（Commit `e4abde23`：bag 登记 setRuntime(null)+currentSessionId+清看板） |
| M2 | `agent/agent-session-state.ts:233` | 清理挂在下一个 setupAgent 而非 deactivate；setupAgent 失败路径死引用残留 | ✅ 已拆（Commit `e4abde23`：deactivate bag 内 clearPanelState(storeId)） |
| M3 | `agent/memory.ts:91` | `initAura` 在途晚于 deactivate 的 `auraShutdown` 落地 → 新项目语义召回静默禁用 | ✅ 已消解（先 Commit `e4abde23` epoch 校验；2026-09-02 AURA SDK 语义记忆系统整体拆除，initAura/auraShutdown 载体不复存在） |
| M4 | `ui/chat-store.ts:91` | `disposePanelStores` 零调用 → 每会话 messages store 只增不减，无界内存 | ✅ 已拆（2026-08-24：三死亡路径接线——合卷 closeSession 拆单卷（disposeSessionMessagesStore）；resetSessionState 全量重置与 setAgent(null) 拆整批（disposeMessagesStores 前缀清除，同时根治跨工作区撞号卷读到旧消息）；换卷不拆（摊开集内即时切换依赖内存态）；4 回归用例钉死 in tests/chat-session.test.ts M4 describe） |
| M5 | `app/chat/chat-core.ts:282` | 无 API key 时切换工作区，旧项目会话列表/消息面板原样残留 | ✅ 已拆（Commit `462b2ea1`：setAgent(null) 清会话列表+activeIdx） |
| M6 | `main.ts:250` `resetCheckPanelState` | deactivate 清完缓存后又回填人造「✅ 通过」进 checkCache → 未检过的项目注入假简报 | ✅ 已消解（2026-08-24 核实：`resetCheckPanelState` 随 V5 拆除 + C14 check 面退役全库零匹配；现行 `resetAgentCaches` 清空 checkCache、`setCheckResult` 仅喂真结果——人造✅注入点不存在） |

### P2 — 低危（记录在案，暂不拆）

- ~~`agent/runtime/agent-builder.ts:561`：`_snapshotRefreshTimer` 模块级单槽，切换后白打一轮引擎查询（写孤儿 ctx，无污染）~~ ✅ 已拆（Commit `e4abde23`：`cancelEngineSnapshotRefresh()` 导出并登记进 Workspace bag）
- `agent/logger.ts:23`：`initLogger` 未 await，交错时漏一个 2s interval
- `main.ts:302` vs `shell-store`：`_diffActive` 双份标志切换不重置，首次 toggleDiff 语义反转
- `lib/pretext/measurement.js:3,13`：测量缓存无界缓增（清理函数零调用）
- `agent/coordinator.ts:87`：SubAgentPool `_aliasToInternal` 只增不减（限单工作区寿命）
- `agent/agent.ts:2526`：FileOwnership 按会话主 Agent 各一份，并行会话子 Agent 互不知晓（Rust 临界区兜底，设计缝隙记录）
- `lsp-client.ts:165`：`lspWarned` 无清理（有界，仅告警提示）

### 本家族已确认健康（审计覆盖，不要再动）

- workspace 监听器/总线订阅全进 `_unlisteners` 双路径消费；后端 watcher 三段防护（deactivate 停 + Drop 兜底 + 先停旧线程）
- runtime 重建先 flushAllBoards + disposeAll（P0-10 已拆）；SubAgentPool stopAll 双路径；agentSessionState 工厂注销链完整
- `loadGraphPages` 逐页 `ws.active` + `source_root` 对拍（epoch 防护教科书）；graph-scene-lifecycle 代际 + safety timer
- cache-store 全量（epoch + resetAgentCaches 双路径 + buildResult 归属，commit `176f4873`）
- scoped-store 分区机制、runtime per-session board 注册表、MessageBus inbox、子 Agent finally 链、board-persistence `_destroyed` 标志

---

## 第三批审计（2026-09-10）— 打包资源残留家族

> 来源：实机事故（进入工作区报「会话核心未初始化，无法绑定目录」）+ CDP 实机取证。
> 家族指纹：**构建工具的合并不清空 + 装载通道照单全收 + boot-gate fail-loud 一票否决**——
> 三层接缝叠加，任何「源里删除、目标目录残留」的产物退役都会复刻。

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| B1 | `target/<profile>/_up_/src-ui/dist-plugins/`（cargo tauri build/dev 的资源拷贝落点） | Tauri 资源拷贝**合并不清空**——源侧 `src-ui/dist-plugins`（build-builtin-plugins 每次 `rmSync` 全量重建、永远干净）删除/改名的产品目录，在 exe 侧资源目录永久残留成僵尸 | 图谱退役（51047f99 删 engine-domain/graph-builtin）后 17:02 重新打包 → 两僵尸残留 → 产物通道照常装载（装配断层对账只查「缺」不查「多」）→ graph-builtin inject 的服务已删 → fiber 永停 PENDING → **boot-gate fail-loud 杀掉 bootShell** → chatPanel 永空 → 进任何工作区报「会话核心未初始化，无法绑定目录」；首页其余一切正常（工作区列表走独立 RPC，症状极具迷惑性） | ✅ 已拆僵尸（2026-09-10 实机删除 `target\release\_up_` 与 `target\debug\_up_` 两侧残留，CDP 验证 boot 全绿 43 fiber 全 ACTIVE + 端到端进工作区「✨ 工作区已就绪」）。复发防线 = **拍板 A：纪律**——退役/改名产品时顺手删两侧 `_up_\src-ui\dist-plugins\builtin\hologram\<产品>` 对应目录（2026-09-10 用户拍板；b = build.cmd 前置清理、c = 装载器拒载非第一方 `hologram/*` 通道产物，两案备而未拍） |

**取证备忘**：boot 期错误不落 ui.log——`initLogger` 挂在 `Workspace.open`（workspace.ts），boot 被杀 → 永远进不了工作区 → logPath 恒空 → 错误只进 WebView console。唯一取证面 = CDP：`tauri.conf.json` `additionalBrowserArgs: "--remote-debugging-port=9222"` 已开，`http://127.0.0.1:9222/json/list` 取 webview target，WebSocket + `Runtime.enable` 即可收 console——且 Runtime.enable 会**重放上一轮 boot 的全部 console 历史**（含旧故障现场），区分「历史重放」与「本次 boot」勿误判。

---

## 第四批审计（2026-09-14）— 回复链路活性家族

> 来源：用户报「发出消息到收到回复的 pipeline 有断点、模型经常不响应，模型通讯是通的」。
> 定性结论（重要，别记错）：**本次症状的真凶是链路挂起**（HTTP 通了但一个字节不回）——
> 09-12 的 `7dac038b`（挂起走时间预算）就修好了，只是当时在跑的是 09-11 02:19 的旧
> exe，修复没编进二进制；换上新二进制后症状消失。下面是同族病灶（不是本次症状）。
> 家族指纹：**活性保障只有一层、且只认一种失败形态**——`idle-stream` 的 30s 守卫只会
> `ctrl.abort()` 一个 fetch，掐不断不理会 signal 的 await；而"是不是用户主动停止"
> 全靠错误文本猜。两者叠加的后果统一为：**用户看见「发出去没回应」，案卷里留下悬空
> 来文，日志里连一行都没有**。

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| L1 | `agent/retry.ts:52` + `app/chat/chat-core.ts:1042/1370` | 「用户停止」靠 `msg.includes('aborted')` 猜（三处同款） | 非用户的中止（`BodyStreamBuffer was aborted` 这类传输被切断）被当成用户意图 → 不重试 + 不落墓碑 → 案卷留下悬空来文，只闪一条 6.4s toast；且任何含 `aborted` 子串的失败（上游 "request aborted by upstream"）都会被静默吞掉 = 宪法四「错误不静默」违规 | ✅ 已拆（Commit `02b90400`）：① 用户中止判据改为一桩**事实**——本轮 signal 是否被中止（chat-core 两处 catch + streamOnce 全改 `signal.aborted`，不读任何错误文本）；② 非用户中止的「中止族」失败在 streamOnce 织入 `[传输中断]` 分类标记 → 计数预算重试 3 次 → 重试耗尽落可见墓碑（`isRetryable` 拆掉 `msg.includes('aborted')`）；③ `markTurnError` 补齐「第一个 token 之前就失败」形态——流式助手缺席时**补建墓碑消息**（旧行为只弹 toast）。验收环 `tests/chat-send-liveness.test.ts` 4 例（含守门：用户主动停止仍静默）。**验证方法备忘**：当时工作区有并行窗口的 token-meter 在途改动压在同两个函数上，故按「HEAD + 本 commit 的 10 个 hunk」在独立 worktree 做隔离验证（tsc + 45 测试 + convergence 全绿），并行改动全程未被触碰、未被提交 |
| L2 | `provider/transport.ts` / `provider/credentials.ts` | 上路本机 IPC 无超时 + 失败结果永久缓存（含负缓存） | 一次瞬态故障被伪装成「配置事实」且不可恢复：`getProxyPort` 钉在 0 → 此后恒走直连（CORS 不放行的厂商全废）；`resolveApiKey` 把 IPC 抛错记成「没有 Key」→ 恒报 MISSING_CREDENTIAL 而设置里 Key 明明在；`resolveOauthToken` 同款（瞬态故障记成「未登录」）。三条都只能重启自愈、日志无痕 | ✅ 已拆（Commit `4c4a8206`：三处改 `typedRpcWithTimeout`（5s/10s/30s）+ 失败不落缓存，真负结果（确实无 Key / 真是 OAUTH_NO_GRANT）仍缓存；同批修 `proxyFetch` 吞掉 abort 后回退重发。钉子 `tests/provider-cap-liveness.test.ts` 8 例） |
| L3 | `provider/idle-stream.ts` + `agent/agent.ts:stream()` | 无「请求硬截止」：全链路唯一的活性守卫只会 abort fetch | 卡在非 fetch 的 await（本机 IPC / 凭据解析 / 任何不理会 signal 的等待）时，30s 守卫是**空操作** → 回合永久挂起：无错误、无重试、无日志、无 UI 反馈，UI 永卡运行态直到重启 | ⏳ 未立项（②.2）。复现配方（L2 已把最容易命中的入口堵上，但通用缺口仍在）：假 provider 的 `stream()` 里 `await new Promise(()=>{})` 永不落定且不理会 signal，推进假时钟 120s，`agent.run()` 仍不 settle。落点需动重试循环核心（被遗弃的尝试仍可能往 executor 塞工具），要定参数并处理遗弃语义——单独立项，别顺手做 |
| L4 | `workspace.ts:840` (`onSessionPersisted`) + `:778` (`subAgentSpawner`) | 注释声称「已改用本工厂闭包捕获的 agent，不再经共享 `agentRef.current`」，代码里仍是 `agentRef.current?.insertMessage(...)` | 多会话并发时 turn-start 块 / 子 Agent 派生落进「最后创建的卷」= 注入错卷（与 2026-08-13 多会话错位事故同族）。半径小（只影响提醒注入与 spawn 归属），但注释与代码不符，下次读代码的人会被误导 | ⏳ 未拆（低危，记录在案） |

---

## 第五批审计（2026-09-15）— 域工具 × shell 命令串家族

> 来源：用户报「Agent 用 office cli 时行为很不可控，连问题都描述不出来」→ 翻会话 23 实测复盘
> （`docs/plans/office-cli-integration-plan.md` §11）。
> 家族指纹：**能力被包装成 shell 命令串过 Bash 家族闸**——闸的路径检查按「token 含 `/` 就当
> 文件系统路径」的启发式，凡 argv 里有非路径的「/ 开头」内容（DOM 寻址 / JSON 载荷 / `BIN=${…}`
> 赋值段）全部解析失败 ⇒ 判「项目外路径」⇒ Ask，而该判定**先于** allow 规则匹配 ⇒ 规则写进去
> 也无效。后果不是"报错"而是**静默降级**：默认模式下工具每次调用都弹卡（只有 yolo 能跑），
> 于是模型改走 shell / code_execution 绕路，人在界面上只看到"Agent 不听话"。
> 已立规：`INVARIANTS.md` #15。

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| O1 | `permissions/bash.rs::check`（步骤 3 路径提取）× `agent/tools/office.ts`（旧 `BIN_RESOLVE`）+ `process_cap::exec_command` | 命令串里三处 token 各自独立触发「项目外路径 → Ask」：`BIN=${OFFICECLI_PATH:-$HOME/…}` 赋值段、DOM 路径 `/body/p[1]`、batch 的 JSON 载荷（内含 `/Sheet1/A1`）；且精确 allow 与裸 `Bash` allow 两条规则**都压不住**（路径判定提前返回） | 默认（ask）/ auto 模式下 office 域工具**每次调用都弹权限卡**（含只读 `view`），「始终允许」点了也白点 ⇒ 用户那次测试恰是 yolo，事故被完全遮住；模型实测 76 次调用只有 5 次用该工具，其余全在绕路（shell / code_execution），最后用 Node 脚本直驱 CLI 收场 | ✅ 已拆（Commit `f207e5f4`，强制层改动 + 宪法审查）：`process_cap::office_exec` 专用动作（命令由 Rust 拼装 + 动词白名单 + 口只收 argv 不收命令行串）+ `tools::OfficeTool`（只审声明的目标文件，走 fs 家族同一套策略）。**否定论证也记在案**：放宽 bash::check（跳过含 `$` 的 token / Windows 跳过 `/` 开头 token）会直接开洞，见 INVARIANTS #15 |
| O2 | `agent/tools/office.ts::cleanShellOutput`（旧 `/command not found\|No such file or directory/i`） | 判定过宽：任何"文件找不到"（目标文件不存在、路径写错）都被当成"officecli 没装"，并追加安装指引 | 把模型推去装二进制 / 找二进制，制造与 O1 叠加的绕路；实测会话里模型为找二进制跑了全盘 `find /` 并被用户中断 | ✅ 已拆（`4412ce87`）：收窄为 `officecli(.exe)` 与错误文案相邻；负例入测试 |
| O3 | `agent/tools/office.ts::execute`（旧无条件落盘脚注）+ batch 无 argv 上限 | ① 写动作结果**失败也**追加「改动已落盘（resident 立即 flush）」；② 一次塞 2174 项（>100KB argv，超 Windows 命令行 32767 字符上限被**静默截断**） | 实测：`[exit 1]` + `Batch complete: 0 succeeded` 后面紧跟"已落盘"，模型据此当成功继续；2174 项回执"零失败"而磁盘只落 19/180 行，全程零报错 | ✅ 已拆（`4412ce87`）：脚注改退出码感知（成功/失败/未知三态）；batch >100 项或 >12KB 自动切块、失败停在原地并报「前 N 批已落盘」 |
| O4 | `examples/office-cli/SKILL.md` + officecli 自带 playbook（`office(action:'playbook')` 返回的正文） | 交付给模型的权威指引要求**在 shell 里跑 officecli**（playbook 488 行里 101 条命令 + 开头强制的 Help-First Rule），而产品环境 PATH 里没有该二进制、域工具也刻意不暴露 CLI | 模型照指引下 shell → `command not found` → 转去找二进制 → 另起 resident 与域工具抢同一文件 ⇒ 写入静默丢失（报零失败、磁盘丢行）。**这是那场测试的第一块多米诺** | ✅ 已拆（`4412ce87`）：playbook 返回时前置护栏头（翻译成域工具动作 + 禁止下 shell + 最小 batch 替代 help）；SKILL.md 删掉五处"走 shell 域调 officecli"的逃生舱指引。**未拆的根**：playbook 正文由上游二进制产出、不在本仓（要彻底解决需自写一份动作面手册或改上游） |
| O5 | `agent/tools/office.ts` schema：`items: z.array(z.unknown())` | `batch` 是动作面里最复杂的参数，而模型可见 schema **零形状提示**（真实要求是 `{command,parent,path,selector,type,props,to,path2}` 那一套）；形状只存在于 playbook 正文与一条运行时缺参报错里 | 模型只能猜——实测会话里 2174 项 batch 就是这么拼出来的；猜错时拿到的是 officecli 的原始报错而非字段级提示 | ⏳ 未拆（低危，记录在案）：修它要改模型可见 schema ⇒ `phase-0/tool-schemas.*` 快照漂移 ⇒ 必须走 `baseline-change-request` 审批 + 两轨 record。当下缓解 = 运行时缺参报错带完整形状（`4412ce87`）+ SKILL.md 写清上限与形状 |

---

## 第六批审计（2026-09-15）— 会话存盘家族

> 来源：用户报「会话内容的存盘有问题，各种意外退出甚至正常退出会导致会话丢内容」
> → 全链审计 + 本机运行时物证，见 `docs/session-persistence-audit.md`（含复核命令）。
> 家族指纹：**「会话什么时候算已持久化」从未被定义**——全部落盘触发点都是偶然时机
> （轮次结束回调 / 500ms 防抖 / 合卷 / 失活 / 退出钩子），而唯一的设计件
> `docs/session-checkpoint-design.md` 自述「定稿未实施」；退出路径的纸面保证
> （beforeunload 全卷保存 + localStorage 同步兜底）在 2026-08-25 拆 localStorage 后就不成立了。
> 实测代价：2026-09-15 一轮 1h47m 的工作（2333 次工具调用）在磁盘上**零痕迹**，
> 随后用户正常关机 → 全部消失。

| # | 位置 | 雷 | 触发 → 后果 | 状态 |
|---|------|----|------------|------|
| S1 | `src-ui/src/shell/rows/persistence.ts`（旧 beforeunload 块）+ `src-tauri/src/main.rs:72-92` | 退出收尾只有 `beforeunload`（WebView2/Tauri 关窗**不触发**，上游 #3217/#2996），块内 `scheduleAutoSave` 只是「clear 再 setTimeout(500ms)」= 把待落盘推迟到窗口消失之后，`saveAllSessions().catch(()=>{})` 是未 await 的 fire-and-forget 且静默吞错；Rust 侧 `Destroyed` → `drain` → `std::process::exit(0)` 直接腰斩在途写 | 正常关窗 = 未落盘内容随进程消失；系统关机 = 强杀（实测应用活到关机那一刻）。注释还留着「localStorage 同步写兜底」化石（该链 2026-08-25 已拆） | ✅ 已拆（本批）：一条 flush 三入口（`watchWindowClose` preventDefault→flush→destroy / `pagehide`+`visibilitychange(hidden)` 兜底 / `beforeunload` 保留）+ 2500ms 硬预算 + 逐卷异常可见（不再静默吞）；能力位 `core:window:allow-destroy` 已入 capabilities |
| S2 | 落盘时机全表（`ui/chat-stream.ts:500` finishTurn、turn-done 订阅壳行、合卷、改名、失活） | 全部在**轮次结束之后**——一轮从用户输入到流收尾之间磁盘上零痕迹；`docs/session-checkpoint-design.md` §3.1/§3.2 的两个语义时刻检查点从未接线（会话事件 NDJSON 第二写面也已随 agent-store 内存化退役） | 崩溃/退出/关机丢**整轮**（用户消息 + 助手输出 + 全部工具结果） | ✅ 触发点 A 已接线（本批，loop 监听面 `request/start`——不改 agent-loop 契约文件、在途合并、fail-open 可见）；⏳ 触发点 B（工具副作用前）仍未接线 |
| S3 | `ui/chat-session.ts::writeSessionSnapshot` + `src-tauri/src/confined_fs.rs::write_atomic` | 同卷多写者（防抖/后台卷/改名/合卷/失活/退出 `Promise.all`）**无串行化**，而 `write_atomic` 不是临界区（对照 `editor_cap.rs:72` 有进程级锁） | 迟到的旧快照覆盖新快照 = 静默回滚；撤掉写链实测复现「v1 覆盖 v2」（`src-ui/tests/session-exit-flush.test.ts` 真变红） | ✅ 已拆（本批）：每卷写链（键 = 目标路径）+ `drainVolumeWrites()` 退出前 drain |
| S4 | `src-tauri/src/confined_fs.rs:129-142` + `plugins/builtin/sessions-builtin/index.ts:36-43` | `write_atomic` = `target→.bak` → `tmp→target` → 删 `.bak`：两次 rename 之间进程死 ⇒ 卷文件**整体消失**（内容只在 `.bak`/`.tmp.N`）；读面只认 `{id}.json`（无回退）、`list_volumes` 只列 `.json`，`restoreCanvasSpread` 还会把它从 `canvas.json` 剪掉；无 fsync | 崩溃/强杀撞上写窗口 = 卷「消失」，用户视角像永久删除（本机 22 卷暂无 `.bak`/`.tmp` 残留 ⇒ 目前是风险不是已发生事故） | ⏳ 未拆（P1，用户已批「`.bak` 只读回退」）：先决 = 把该决策写回 `session-checkpoint-design.md` §6.6/§9.3（原文裁定「不做卷版本化/.bak 多副本」） |
| S5 | `ui/chat-session.ts::saveActiveSession` / `saveSessionById`（旧 `if (!agent) return`） | 句柄缺席（未水合卷 / 工厂失败 / 切 preset 拆句柄）时**静默跳过**落盘：无日志无提示；`saveAllSessions` 又只遍历案头摊开的卷 | 「卷还在、内容旧」——退出即丢该卷内存里的全部内容，用户零信号 | ✅ 已拆（本批）：`SessionSaveOutcome` 五态 + 一次性 warn + `flushSessionsForExit` 逐卷汇总（退出路径可见报异常卷） |
| S6 | `ui/chat-session.ts::workspaceSessionsDir` + `listSavedSessions` | `projectPath=''` 时拼出 `/.lantai/sessions`（相对进程 CWD 解析，`ui.log` 实证落到 `D:\.lantai\sessions` 被安全闸拒绝）；读面单卷失败/10s 总超时**静默少一卷**（只 console） | 启动早期读写全废；侧栏「卷不见了」（同族已在画布面修过 `51758e94`，卷列表面未修） | 路径守卫 ✅ 已拆（本批：空路径响亮报错，消费方降级为空集）；⏳ 读面可见化未拆（P1） |
| S7 | 测试面（`src-ui/tests/`） | 六项保证零覆盖：退出 flush / 同卷并发写顺序 / 在途轮次 / 原子写崩溃窗口 / 无句柄卷语义 / 退出时防抖 | 改这块代码没有任何测试会变红（既有 108 用例只钉「落盘目标路径 + 快照字段 + 空卷跳过 + 墓碑形状 + seam 四动作 + 防抖 per-panel」） | 四项已补（本批 `tests/session-exit-flush.test.ts` 8 例，含撤掉修复即真变红的负向验证）；⏳ 真实崩溃注入（kill 在两次 rename 之间）与大卷写放大实测仍缺 |


