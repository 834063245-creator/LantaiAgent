# 日志可观测性（log-observability）计划

> 状态：**批 0–2 已落地（2026-09-27）· 余批 3/4 + 真机验收（§5 六条）**。
> 落地：批 1 = `06fadbe2`（公共字段 + `agent/obs.ts` 门面 + 唯一漏斗 + `boot`）；批 2 = 本批（`config.load` /
> `panel.providers_reload` / `cred.*` / `llm.*` 四相接缝 + 事件表进长期规范）。批 0 四项经核对**已全部在 HEAD**，
> 无需重做。**规格面已定稿** → [`../design/log-observability-spec.md`](../design/log-observability-spec.md)
> （事件名与字段表的长期规范；本文件此后只是立项与取证记录）。
> 一句话：消灭「**失败默认无痕**」这个类别——让任何让用户看见的失败，日志里至少留一条带层与原始文本的记录。
> 触发事故：2026-09-27，用户报「本地模型（baseUrl `http://127.0.0.1:8080/v1`）配好了却一直无法调用」，附 `ui.log` 一份。
> 事故结论：**那份 log 对该问题的可答信息 = 0 条**——1158 行里 1024 行是同一条无 `method` 的 `invoke`（88%）；87 条
> error 全是路径噪声（找不到目录 / 父目录不存在 / 未打开工作区 / 日志写到项目根外被拒）；provider 痕迹只有
> deepseek 的**成功**日记（2 条 `turn started` + 14 条 `llm response`）；`8080` / `127.0.0.1` / `localhost` 出现 0 次。
> 相关技术债：本改造与 [`../landmine-map.md`](../landmine-map.md) 第十四批（provider 配置面家族）同域——该批四个雷的修复
> 已在 HEAD（批 0 核对确认），是本次事故的直接相关面。

## 0. 为什么做（问题不是"缺日志"，是"失败默认无痕"）

现状不是"没记日志"，而是**失败类别被结构性排除**：

| 面 | 现状 | 证据 |
|---|---|---|
| 日志器 | 无级别过滤（debug 无条件写）、写失败**静默忽略**、buffer 丢条不计数 | `src-ui/src/agent/logger.ts` |
| 唯一漏斗 | **缺位**：回合失败只落界面墓碑，不落盘；只有**可重试**错误才写 `stream retry` | `agent/agent.ts` 非可重试分支直接 `return result`；`app/chat/chat-core.ts` 六处 `markTurnError`（:1173/:1181/:1187、:1488/:1493/:1499）均无日志 |
| 配置装载 | 只在 fatal 时留痕，**成功不留**；且已发布版本的失败留痕还在未提交工作区 | `provider/providers-store.ts` + 第十四批 Q2 |
| 凭据 | **全程无日志**（只有两条 `console.warn`） | `provider/credentials.ts`、`settings-domain/provider-data.ts` |
| 出网 | LLM 反代上游失败只 `eprintln!` 到 stderr，用户抓不到 | `src-tauri/src/llm_proxy.rs:307` |
| 锚定 | 日志不带版本/commit，收到的 log 无法定位代码 | 事故中靠"有无 `method` 字段"反推壳的构建 |
| 健康度 | 不知道日志丢过没有 | 用户 log 里两条 `denied: outside project root` 即静默丢弃现场 |

由此推出本计划的基本纪律：**不按"可能出什么问题"穷举字段，按"结构上的接缝"覆盖。** 接缝数量由架构决定（本批 5 条），
与 bug 数量无关；用户的"问题空间无界"不会传导成"日志字段无界"。

## 1. 目标与验收

**目标**：面对用户一句模糊描述，**仅凭日志**能落到「哪一层 / 哪个判据 / 什么值」。

本次事故的三个问题必须能在日志里被回答：

| # | 问题 | 现在 | 改造后由谁回答 |
|---|---|---|---|
| 1 | 这行 provider 存不存在、从哪来（文件 or localStorage） | 无痕 | `config.load` |
| 2 | 这行有没有 Key（凭据库 vs 面板内存） | 无痕 | `cred.get` + `panel.providers_reload` |
| 3 | 请求有没有发出去、发给谁、结果如何 | 无痕 | `llm.send/first_byte/done/error` + `turn.failed` |

**覆盖性硬要求（本计划的核心性质）**：

> 任何未知 bug，只要它让用户看见了失败（墓碑 / toast / 面板 fatal），日志里**至少留下一条**，且带**发生层**与**原始错误文本**。

**明确不做**：不做遥测/自动上报；不做全量 debug 常开；不改既有日志字段语义（**只增不改**，旧解析器不破）。

## 2. 设计

### 2.1 公共字段（一次设计，全局适用，不随功能增长）

```jsonc
{"ts":"…Z","level":"error","module":"agent","event":"turn.failed","build":{"v":"1.0.4","commit":"1a38a525"},
 "ids":{"session":"…","agent":"…","turn":"…","run":"…"},
 "dur_ms":1234,"out":"fail",
 "err":{"kind":"MISSING_CREDENTIAL","status":null,"phase":"preflight","raw":"…"},
 "ctx":{ /* 接缝专属字段 */ },
 "message":"人可读一句话"}   // 保留旧字段，向后兼容
```

纪律：`event` 为 ASCII 点分稳定名（`boot` / `config.load` / `cred.get` / `llm.send` / `llm.first_byte` / `llm.done` /
`llm.error` / `turn.failed` / `panel.providers_reload` / `log.self`）；**不再用中文句子当事件名**（既有 `message` 原样保留）；
`ids` 由门面自动注入（从当前会话/回合上下文取）；每条长度上限 4KB（超出截断并标 `truncated:true`）。

### 2.2 事件门面：新增 `src-ui/src/agent/obs.ts`（内核，非插件面）

```ts
obs.boot({...}); obs.configLoad({...}); obs.credGet({...}); obs.credStore({...});
obs.llmSend({...}); obs.llmFirstByte({...}); obs.llmDone({...}); obs.llmError({...});
obs.turnFailed({...}); obs.panelReload({...}); obs.self({...});
```

- **唯一的脱敏审查点**：不记 apiKey/token/消息正文/请求体全文/URL query；只记长度、存在性、`host:port`。
- 事件名与字段表在文件头注释里定死——**新接缝 = 加一个函数，不改散点**。
- 既有 `log.debug/info/warn/error` 保留，不迁移旧调用（本批零回归面）。
- 放内核而非插件面：它是基础设施，不该可被禁用。

### 2.3 唯一漏斗（用户可见失败）

- **接入点**：`app/chat/chat-core.ts` 两处 catch（六处 `markTurnError`）→ 统一调 `obs.turnFailed`；`agent/agent.ts` 回合终局失败出口（非可重试 / 重试耗尽）同理；`showToast(level==='error')` 出口记一条 `ui.toast`（只记前 200 字）。
- **去重**：同一 `(session, turn, phase)` 只写一次（内存 Set，随回合结束清理）——六处出口不许刷屏。
- **`phase` 判定（定位的关键）**：`preflight`（配置/凭据/协议构造/档位断言，请求未发出）/ `stream`（出网 → 首字节 → 中止）/ `tool`（工具层）。

### 2.4 本批覆盖的五条接缝

| 接缝 | 落点 | 字段 |
|---|---|---|
| ① `boot` | logger 初始化完成后一次 | version、commit、platform、tz、workspace、providers.yml 路径、proxy port、各通道可写性 |
| ② `config.load` | `loadProvidersDoc` 出口（**成功也写**）+ `panel.providers_reload`（SettingsPanel 两条重读路径） | path、节数、逐节错误（名+原因）、fatal、empty、投影来源（file/localStorage）、Key 携带 N/M |
| ③ `cred.*` | `resolveApiKey`（hit/miss/len）、`persistSecrets`（逐 provider ok/err）、`removeSecret` | provider 名、有/无、长度、成功失败、失败原文（**无明文**） |
| ④ `llm.*` | 公共面：`plugins/builtin/llm-adapters/retry.ts` 的 `sendWithRetry` + `shared.ts` 的 SSE 读 | provider、model、kind、target `host:port`、tools 数、prompt 估算、首字节 ms、status、总 ms、finish_reason、错误分类标记 |
| ⑤ `turn.failed` | 见 §2.3 | 见 §2.1 |

> 选公共面而非逐方言插桩：以后加第 4 个方言，日志**自动继承**——这是「不穷举」的机制本身。

### 2.5 批 3/4（本次不执行，先记设计）

- **Rust 侧出网**（`llm_proxy.rs`）：三处 `eprintln!` → `tracing::warn!/error!`（落 `bridge.log`），记 `target_host` / `status` / 错误原文；目标 URL 只记 `host:port`，凭据头与 query 不落盘。诊断时 `bridge.log` + `ui.log` 合并看。
- **级别与运行时开关**：默认 `info`，`debug` **默认丢弃**（现在是无条件写，即那 88% 噪声来源）；优先级 `LANTAI_LOG_LEVEL` 环境变量 > `localStorage['lantai.log.level']` > 默认；打开 debug 后纳入 `bridge` 的 rpc invoke（含 `method`）。设置页 UI 开关留到下一批。
- **日志健康度**：写失败计数 + 首次 `console.error`；下一条成功写入补 `log.self{dropped:N}`；通道不可用由 `boot` 如实记 `log_channel:"unavailable"`。**轮转/保留窗口**（现状 `Rotation::NEVER` 会无限增长）与**诊断包导出**（带可信度段：通道可用性 / 断档区间 / 文件 mtime / 字段来源标签）同属下一批。

## 3. 前置条件（批 0）：先提交工作区里的四项修复

与批 1–2 **同文件**，且是本次事故的直接相关面：

| 文件 | 修复 | 为什么必须先落 |
|---|---|---|
| `src-ui/src/bridge.ts` | rpc invoke 日志补 `method` 字段 | 「provider 文件到底写没写」的唯一分辨面；也是判断壳构建时间的锚 |
| `plugins/builtin/settings-domain/SettingsPanel.tsx` | `withCarriedKeys`（重读时把内存里的 Key 带过去） | 修完「Key 栏显示」才可信——事故里的岔路口（面板冲键 vs 凭据库真没 Key）就靠它 |
| `provider/providers-store.ts` | `providersFileReady()` 补 `!state.empty` | 空文档夺权威 ⇒ 行表被清空（"之前配好的供应商没了"） |
| `src-tauri/src/{sandbox,utils/path_resolve}.rs` | `Sandbox::user_data_read/write`（工作区无关入口） | 用户级 `~/.lantai/providers.yml` 建不出来（Q2） |

## 4. 实施步骤（分批，每批独立可验收）

**批 0（半天）**：提交 §3 四项。

**批 1（半天）**：§2.1 公共字段 + §2.2 `obs.ts` 门面 + §2.3 唯一漏斗 + ①`boot`。
→ 产出性质：**任何用户可见失败 ≥1 条日志**（覆盖性达成）。

**批 2（一天）**：②`config.load` + ③`cred.*` + ④`llm.*` 三条接缝 + 面板重读日志。
→ 产出性质：本次事故的三个问题全部可答。

**批 3（半天，后续）**：Rust 出网日志 + 级别开关 + 健康度。

**批 4（下一批，不在本计划）**：诊断包导出 + 日志轮转。

> 用户已批准范围 = **批 0–2**（约 2 天）。批 3/4 留着，等这次的真机验收过了再说。

## 5. 测试与验证

**单测（vitest，`src-ui/tests/`）**：门面字段完整性与脱敏（key 永不出现）、事件名稳定、长度截断、`turn.failed` 去重（六出口只一条）、
logger 级别过滤与写失败计数、`config.load`（成功 / 逐节错误 / fatal 各一条）、`cred.get`（命中 / 未命中 / IPC 抛错不缓存三条路径）、
`llm.*` 四条字段（mock fetch）。新增模块需同步 `host-surface` 基线（`npm run gen:host-surface` 视需要重录）与 `doc-check`。

**Rust 测**：现有假上游用例扩展——上游连接失败时断言落盘日志字段（必要时把日志出口做成可注入 sink）。

**端到端真机验收（最终判据）**：
1. 空 Key 的 provider → `cred.get(miss)` + `turn.failed{phase:preflight, kind:MISSING_CREDENTIAL}`；
2. 起 `127.0.0.1:8080` mock OpenAI 端点 → `llm.send/first_byte/done` 三条齐全；
3. 关掉 mock → `llm.error{target:"127.0.0.1:8080", status:502}`；
4. 慢速 mock（首个 token 等 60s）→ 空闲守卫超时 + 重试链 + `turn.failed{phase:stream}` 可见；
5. 外部手改 `providers.yml` → `config.load` + `panel.providers_reload` 两条都可见（含 Key 携带 N/M）；
6. **重演本次事故**：只给一份新 `ui.log`，5 分钟内定位到「哪一层 / 哪个判据 / 什么值」——做到即验收通过。

## 6. 风险与纪律

| 风险 | 处置 |
|---|---|
| 泄露密钥/正文 | 脱敏集中在 `obs.ts` 一处（唯一审查点）+ 字段白名单 + 长度上限；评审只审这一个文件 |
| 性能 | debug 关闭时早返回（零成本）；写入沿用现有 buffer + 2s flush |
| 旧解析器破 | 只增字段不改既有字段，`message` 保留 |
| 契约/基线漂移 | 新增模块可能触发 `host-surface` 基线、`doc-check`；纳入批 1 的完成定义 |
| 一次做太大 | 分 4 批，批 1 即有覆盖性收益 |
| 与未提交改动打架 | 批 0 先提交（§3） |

## 7. 决议点（2026-09-27 用户裁定，三项全定）

1. **范围**：已定 = 批 0–2（批 0 经核对已在 HEAD；批 1/2 已落地）。
2. `obs.ts` 归属：**内核** `src-ui/src/agent/obs.ts`（用户裁定——基础设施，不该可被禁用）。
   产物域经宿主面 `./host` + `faceDeps` 取用（`host-modules.ts` 登记；改面须同 commit
   跑 `npm run gen:host-surface`）。
3. 事件名与字段表：**做长期规范**——落 [`../design/log-observability-spec.md`](../design/log-observability-spec.md)
   （L2 现状层定稿），规则指针在 `CONVENTIONS.md` §1.11。不重复进 `facts.generated.md`
   （那里只放跨文档复述的标量）。

## 8. 证据索引（本次事故的可复核事实）

- 用户 log 全量读数：`ui.log` 1158 行；模块 `bridge` 1111 / `agent` 43 / `runtime` 4；error 87 条（43× `stat … 系统找不到指定的文件`、21× `parent directory not found`、10× `未打开工作区，请先打开项目`、2× `ui.log … denied: outside project root`）；`8080` / `127.0.0.1` / `localhost` / `http` 各 0 次。
- 唯一一条服务商侧异常：`2026-09-16T09:19:18.507Z` `stream retry 1 in 1048ms`，`error:"[响应超时] 30 秒内未收到服务商任何数据…"`，`elapsed_ms:67827`，provider 仍是 deepseek。
- 硬门禁位置：`provider/live.ts`（`MISSING_CREDENTIAL` 拦在请求前）、`plugins/builtin/settings-domain/ProviderPage.tsx:356`（`请先填写 API Key` 读面板内存）、`provider/idle-stream.ts`（`STREAM_IDLE_TIMEOUT_MS = 30_000` 硬编码）。
