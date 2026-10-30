# code_execution 执行原语升级（2026-10-29 立项 / 2026-10-30 迭代）

> 状态：**P1 ✅ / P2 ✅ / P3 ✅ 已落地（2026-10-30），P4 待开工** —— 一批一 commit，可单独验收、可单独回退。
> 一句话：现行实现是「code mode v1」（字符串程序 + 运行时桥 + 一次性 worker），**能力不缺，
> 缺四条回路**：模型不知道这一卷里有哪些绑定、也不知道怎么调（P1）· 域工具的只读动作没拿到并发（P2）·
> 失败只剩一句人话（P3）· 超输出预算 = 整段作废（P4）。
>
> **裁定（§0.5，不制造判断题）**：做 **P1-P4**，P5 待触发，类型检查器 / 读面批量 / 基座硬化挂起。
> 依据是下面逐条的代码证据，不是「业界都这么做」——每条都能指到行号，也能被反证推翻。
> **§11 是外部横向校准**（业界四家实况），只用于验伪/背书，**不是本计划的依据来源**；
> 它的结论：P1-P4 的方向被外部证据背书，三条业界做法**明确不采纳**（理由在 §11.3）。

## 1. 病症与证据

| # | 病症 | 证据 | 后果 |
|---|---|---|---|
| 1 | 描述里没有本卷的绑定目录 | `code-run/code-execution-tool.ts:48-56` 是写死字符串，而 `deps.bindings` 就在函参里没用上 | 模型猜名（`tools.fs_write` / `tools.read`），第一次调用才炸 |
| 2 | 域工具的**只读动作没有并发** | 门面 `readOnly()` = 「全部动作只读」才为 true（`agent/tools/domains.ts:492-498`）⇒ `fs` 恒 false ⇒ 程序内 `Promise.all(…read)` 在 `code-run/host.ts:252-257` 排队 | 扇出读退化成串行；描述第 54 行「read-only tools run in parallel」对域工具是**假承诺** |
| 3 | 写锁全局一条链 | `code-run/host.ts:104` 单条 `writeChain` | 改 20 个互不相干的文件 = 20 次全串行 |
| 4 | 错误面只有 `message` | `code-run/protocol.ts:22-24` 的 reply 只有 `message`；bootstrap 里 `new Error(m.message)`（`bootstrap.ts:55`） | 程序内 `catch` 到的 Error 无 `code`/`hint`，未知名 / 参数校验 / 门禁拦截同形，无法按类自纠 |
| 5 | 超输出预算 = 整段作废 | `code-run/host.ts:188-196`（`done` 到达且 `outputLimited` ⇒ 失败、完成值丢弃）、`:197-207`（完成值超预算同样失败）；`code-execution-tool.ts:94` 失败一律以 `[code_execution 失败]` 起头 | 日志里已经有一半答案也作废；模型只看到「这次白跑」，只能重写重跑 |

> **取证纪律**：上表是读码结论，不是实测。P1 的步骤 0 先量「快照 vs 调用时的可见名」；P2 开工前先测一次
> 扇出读的墙钟（确认串行代价真实存在）；P3 先补一行日志看错误分类的真实分布；P4 先量一次「超预算被作废」
> 的真实频次（session-log 里 `[code_execution 失败] kind=output-limit` 的出现次数）——不拿推断当现状。

## 2. 为什么是这四批（而不是别的）

- **P1 是「知道」**：模型写程序时最贵的失败是猜名和猜姿势。把已存在的 `bindings` 投影进描述，
  一次装配、零运行时开销。
- **P2 是「兑现」**：描述已经承诺的并发语义，代码没做到；这是**修承诺**，不是加功能。
- **P3 是「自纠」**：code mode 相对单发工具的红利之一是把往返压进程序内循环——前提是错误**可分类**。
  现在只能把错误文本当字符串截断，模型自纠只能靠再开一轮。
- **P4 是「止损」**：程序跑对了但输出超标，现在连部分结果都不给。截断改「结果」而不是「失败」，
  把一次白跑换成半份答案（§11 里 Cloudflare 的 `--- TRUNCATED ---` 是同一手法）。

**施工序 = P1 → P2 → P3 → P4**（不是可并行，是可独立验收）：
P1/P2 都改 `CodeBindingSpec`（`host.ts:28-35`）与同一个构造点（`segments.ts:192-212`）；
P3/P4 都改 `protocol.ts`。**共享文件的两批必须串行**，各自 commit 只碰自己那几行。

## 3. P1 —— 绑定目录进描述

### 3.1 形状

`createCodeExecutionTool` 内新增纯函数，把 `deps.bindings` 投影成一段目录，拼进 description：

```ts
/** 每条绑定一行签名投影：名字 + 必填键 + 动作枚举。无 signature 的绑定只出名字。 */
function renderBindingCatalog(bindings: CodeBindingSpec[]): string
```

输出形如：

```
Available bindings in this session (call as `await tools.<name>(args)`; code_execution itself is not callable):
  fs(action, filePath?)
  shell(cmd, …)
  …
Example: const r = await tools.fs({action: "read", filePath: "x.ts"});
```

**相对 10-29 版的修订：从「只放名字」改为「名字 + 派生签名 + 一条示例」。** 理由：

- 病根不是「不知道有哪些名字」，是「不知道调用姿势」——`tools.fs_write`（拼了个不存在的复合名）和
  `tools.read`（写成顶层函数）是同一次猜测的两个方向，名字清单**只治其中一个方向**。
- **派生 ≠ 第二真源**：签名由 `Tool.parameters()`（JSON Schema，`tool.ts:20`）与 `Tool.actions()`
  （`tool.ts:26`）在**装配期投影**，和模型收到的工具 schema 是同一份数据的两种视图（同 `defineTool`
  的 zod 真源）。**手抄才会漂**；投影不会。
- 只投影三样：**必填键**、`action` 枚举、**名字**。参数**说明**一律不进（那是 schema 的活，抄一份才是真漂）。
- 体量：约 15 条绑定 × ~50 字符 ≈ 1KB 量级（模型工具契约全文 56KB，不重复它）。

### 3.2 步骤（2026-10-30 已落地）

0. **取证**：见 §3.4 —— **结论推翻了「预期一致、保留快照」**，所以下面的形状按实测改了。
1. `tools/define-tool.ts`：`description` 支持 `string | (() => string)`（惰性求值；全仓只有本工具用函数形态）。
2. `code-run/code-execution-tool.ts`：`CodeExecutionDeps.catalog?: () => Tool[]` + `projectBindingEntry` /
   `renderBindingCatalog` / `buildDescription`（基础文案 + 目录块）；两个纯函数导出供测试。
3. `capability-segments/segments.ts`：`catalog: () => scope.tools.visibleTools()` —— **活注册表**，
   不是上面那个 install 期的 `bindings` 快照。
4. baseline：standard + minimal 两轨重录（2026-10-30 用户批准；漂移面 = 描述一行，`parameters` 逐字不变）。

### 3.3 测试

| 用例 | 命运 |
|---|---|
| 投影只取三样：名字 / 动作枚举 / 必填键（`action` 剔除，参数说明不进） | **新增** |
| 渲染：空集为空串 / 按名排序 / 动作超上限缩写为 `…` | **新增** |
| 目录不含 `code_execution` 自身；缺省无 `catalog` 时退化为裸名字（不出空括号） | **新增** |
| **活注册表刷新**：后注册 + 复收敛的动作，下一次描述里就在（§3.4 取证的行为化断言） | **新增** |
| 现有 `tests/code-execution.test.ts` 25 例 | **零改动**（执行路径未动） |
| convergence 双轨 | 重录后对拍（byte 级守护，不需要手写断言） |

### 3.4 取证结论（2026-10-30 实测；临时用例已删）

| 观察 | 结果 |
|---|---|
| 装配期快照 vs 最终可见名 | `["fs"]` vs `["fs","agent"]` —— **快照会缺整个域** |
| 域门面实例的动作集 | 后注册的动作**看不见**（`["spawn"]` 冻结）；复收敛才变（`["spawn","merge"]`） |
| 反复复收敛 | 只重建同名，名字集合稳定 |

机制：`buildDomainTool`（`tools/domains.ts:486-501`）在构建时把 `actions` / `readOnlyActions` / `parameters`
算死；`convergeRegistry` 先 unregister 再 register **新实例** ⇒ 旧实例是过期投影。而 `code-execution-tool`
（段 9）装配在 `converge-tools`（段 10）之前，快照必然晚一次收敛。

结论：**目录与签名都必须在生成描述时读活注册表** ⇒ `defineTool.description` 函数形态 + `deps.catalog`。
**副作用提醒（P2 施工点）**：`readOnlyFor` 若读快照实例的 `readOnlyActions()` 同样会过期——P2 实现必须按名字
从活注册表取 Tool（`scope.tools.get(name)`），不要闭包捕获构造期实例。

## 4. P2 —— 并发面：按动作只读 + 键控写锁（2026-10-30 已落地）

### 4.1 形状（`host.ts` + `segments.ts`）

```ts
export interface CodeBindingSpec {
  name: string;
  readOnly: boolean;
  /** 按本次参数判定是否只读（域工具；缺省回落 readOnly）。 */
  readOnlyFor?: (args: Record<string, unknown>) => boolean;
  /** 写锁键：null = 不加锁；'*' = 排他闸；其余 = 键控（同键串行、异键并行）。缺省 '*'。 */
  lockKey?: (args: Record<string, unknown>) => string | null;
  invoke: (args: Record<string, unknown>) => Promise<{ output: string; isError: boolean }>;
}
```

host 侧调度：读类不进任何链（与今天一致）；写类按 `lockKey` 分片：

- `'file:<abs path>'` → 同键串行、异键并行（`Map<string, Promise>`）；
- `'*'` → **排他闸**：等在途键控写排空 → 阻塞新键控写 → 自己跑完 → 放行（跨工具安全网，如 shell / git）；
- `null` → 不加锁（仅测试与显式声明用，生产不采用）。

`finish()` 改为等在途链全部排空（今天等的是一条 `writeChain`，审计完整性是同一条纪律）。

### 4.2 绑定集声明（`segments.ts`，已落地）

```ts
readOnlyFor: (args) => {
  const live = scope.tools.get(t.name());          // 活注册表，不是快照实例（§3.4）
  const ro = live?.readOnlyActions?.() ?? [];
  if (ro.length === 0) return live?.readOnly?.() ?? t.readOnly();
  const action = typeof args.action === 'string' ? args.action : undefined;
  return action !== undefined && ro.includes(action);
},
lockKey: (args) => {
  const p = args.filePath;
  return typeof p === 'string' && p.length > 0
    ? `file:${codeWriteKey(scope.ctx.projectPath, p)}`   // 归一化见下
    : '*';
},
```

**保守名单**：只有 `filePath` 键分片（`fs` 的 read/write/edit 等）。`mv`/`rm`/`shell` 一律 `'*'` ——
路径不明确的分片等于把「串行」换成「race」。

**键归一化（`codeWriteKey`，施工时补的形状）**：工作区相对 → 绝对（拼 `ctx.projectPath`）、
去 `./`、`..` 折叠、统一分隔符、**小写折叠**。折叠方向是**过度串行**（`Foo.ts` 与 `foo.ts` 并成一把锁）——
安全的错误方向；漏串行才是 race。不做归一的话，`x.ts` / `./x.ts` / 绝对路径会被认成三把不同的锁，
并行写同一文件。

### 4.3 测试（已落地 2026-10-30，4/4 绿）

| 用例 | 命运 |
|---|---|
| 现有「读并行写串行：两个写调用的 end 序 = start 序」（`tests/code-execution.test.ts:185`） | **零改动**——写缺省仍是 `'*'`，语义逐字不变（这是本批「零漂移」的证据） |
| 同键两写串行（锁内 start/end 序） | **新增** |
| 异键两写并行（start 交错、end 按提交序） | **新增** |
| 域工具只读动作不进写链（`readOnlyFor` 命中即并行） | **新增** |
| `'*'` 与键控写互斥（排他闸） | **新增** |

### 4.4 门禁

`vitest`（`code-execution` + `domains-convergence`）+ `build` + `biome ci` + `verify:convergence` 双轨
（本批**不动模型可见字节**，convergence 必须零漂移——若红了就是误改了 schema/描述）。

**实测（2026-10-30）**：64 例绿（code-execution 33 + domains-convergence 31，其中「读并行写串行」零改动通过）
+ build ✅ + biome 0 error + convergence 双轨**零漂移**（不重录即通过 ⇒ 未误动 schema/描述）。

## 5. P3 —— 错误面：可分类的失败（2026-10-30 已落地）

### 5.1 形状

1. **协议**（`protocol.ts`）：reply 增可选 `code?: 'unknown-binding' | 'invalid-args' | 'blocked' | 'tool-error'`、
   `hint?: string`。这两个字段是**程序内 API 的一部分**（`catch (e) { if (e.code === …) }`），一旦发布就按契约对待。
2. **bootstrap**：`ok:false` 时构造 Error 后挂 `code`/`hint`（`Object.assign`），message 保持人读文本不变。
3. **host**：未知绑定 → `unknown-binding` + 最近邻（Levenshtein，阈值保守）+ 可用清单；参数非无损 JSON →
   `invalid-args`。
4. **码在源头定（施工时改了计划的分工）**：原计划让 segments 按文本嗅探分类，实做改为
   `Agent.dispatchNestedTool` 在**每一个失败返回点直接给码**——未知名/已淘汰 → `unknown-binding`；
   planGate 打回、HIGH 预检打回 → `blocked`；工具抛错 → `invalid-args`（`参数校验失败` 前缀）或
   `tool-error`。理由：门禁文案会改，嗅探器跟着漂；源头知道自己拦了什么，下游不该再猜。
   **全链只剩一处文本判据**（zod 校验错误在 `defineTool` 内抛出、没有类型面能带码出来），已在该行注释标明
   「改前缀同改这里」。segments 只做透传（`invoke` 返回 `CodeBindingOutcome`，含可选 `code`/`hint`）。
5. **bootstrap 的 `tools` 改 Proxy**：访问未知属性返回「调用即抛」的函数——`e.code='unknown-binding'`，
   message 带最近邻与清单。`then` / `toJSON` / `Symbol.*` 等协议键放行（返回 `undefined`），否则 `await tools`
   或 `JSON.stringify(tools)` 会被误伤。**不抛在 get 上，抛在调用上**——属性探测（`'x' in tools`）保持可用。

**不加**：`retryable` / `severity` 之类的第二判据——分类信息已经在 `code` + `message` 里，
多一个布尔字段等于给模型两套互斥的判据，没人会用。

### 5.2 测试（已落地 2026-10-30，5 绿 + 1 改写）

| 用例 | 命运 |
|---|---|
| 未知绑定：程序内直接抛出（无宿主往返） | **新增** |
| 未知绑定：宿主侧回 `code`/`hint`（动态 `tools[n]` 路径） | **新增** |
| `catch (e) { e.code === 'invalid-args' }` 分支可用 | **新增** |
| `await tools` / `JSON.stringify(tools)` / `'fs' in tools` 不炸 | **新增** |
| 现有用例 | **1 条改写**（唯一一条）：`敌意校验：未声明绑定名` 原断言 `TypeError: is not a function`，
现断言 `e.code === 'unknown-binding'` + 仍然零宿主往返——**故意规格变更，commit message 已声明** |
| 其余现有用例 | **零改动** |

### 5.3 门禁

`vitest` + `build` + `biome ci` + `verify:convergence`（描述字节不变 ⇒ 应零漂移）。

**实测（2026-10-30）**：68 例绿（code-execution 37 + domains-convergence 31）+ build ✅ + biome 0 error
+ convergence 双轨**零漂移**。

## 6. P4 —— 输出预算：截断是结果，不是失败

### 6.1 形状

1. **语义切分**：`exception / timeout / aborted / substrate / invalid-output` 仍是**失败**；
   `output-limit` 从 `error.kind` 联合里**退役**（`protocol.ts:57`）——超预算不再等于失败。
2. **结果形状**：`CodeRunResult` 增 `truncated?: { droppedBytes: number; valueDropped: boolean }`。
3. **host**（`host.ts:188-207`）：预算耗尽后**继续跑到 `done`**；完成值按剩余额度在 **UTF-8 边界**切开，
   超出字节数记进 `droppedBytes`；完全放不下则 `valueDropped: true`。日志的逐条截断行为**不变**
   （`chargeLog` 不动），`finish()` 照旧等写链排空。
4. **tool 信封**（`code-execution-tool.ts:85-102`）：
   - `── result (truncated: 丢弃 N 字节) ──`；
   - `valueDropped` 时 `── result (dropped: 超输出预算，完成值已丢弃——return 摘要或分批返回) ──`；
   - `[code_execution 失败]` 只留给真失败。
5. **worker 侧 `{t:'output-limit'}` 消息保留**（宿主独立计账的双保险，语义不变——它是信号，不是错误）。

### 6.2 测试（本计划唯一的故意规格变更）

| 用例 | 命运 |
|---|---|
| `C8-预算超限：日志爆炸 → output-limit 失败，已发日志保留`（`tests/code-execution.test.ts:128-134`，断言 `error.kind === 'output-limit'`） | **改写**——唯一一条既有断言要动。**故意规格变更**：截断从「失败」改为「结果 + 标记」，commit message 必须写明模型可见行为变更（超预算不再报失败，改为 `truncated` + 部分结果） |
| 完成值超预算：切在 UTF-8 边界、`droppedBytes` 准确、不抛错 | **新增** |
| 完成值全丢：`valueDropped=true` + 信封给可行动提示 | **新增** |
| 日志爆炸但完成值放得下：日志截断、完成值完整、**非失败** | **新增** |
| `exception` / `timeout` / `aborted` 信封逐字不变 | **零改动** |

### 6.3 门禁

`vitest`（`code-execution`）+ `build` + `biome ci` + `verify:convergence` **零漂移**
（信封不是 schema，模型可见的工具定义字节不变；若红了说明误动了描述）。

## 7. P5（待触发）——结构化完成值

**内容**：程序 `return { __view: 'table' | 'diff', … }` 时，纸面把结果段渲成真表格/差异块，而不是一坨 JSON 文本。

**触发条件**：用户明确要「程序结果直接出表格/图」时才开工。不进首批的理由：要动协议（`done.view`）、
纸面判据（`paper/translate.ts` 的 `name === 'code_execution'` 分支）、`paper/block-model.ts` 的 `code` 族，
三件一起改的验证面远大于 P1-P4 之和，而收益是**展示**不是**能力**。

（外部对照见 §11：业界的等价物是 MCP 的 `structuredContent` + 生成式 UI，方向一致——但那是**渲染层**
的活，兰台的纸面本身就是渲染层，比外挂 UI 资源省事，所以它更适合当「有空就做」而不是「等用户开口」。）

## 8. 挂起（明确不做，附理由）

| 项 | 不做的理由（不是「以后再说」） |
|---|---|
| 类型检查器（tsc / vfs in worker） | 目录（P1）+ 未知名精确报错（P3）已覆盖八成；引 tsc = 体积 + 冷启动 + 违约「程序体 = 纯 JS」，要做得整条契约升版。**外部对照**：业界也没人在沙箱里跑 tsc，类型只当提示（§11.2） |
| 读面批量化 / project 只读挂载 | 收益要先量：P2 落地后测嵌套调用延迟占比，若 `fs` 读占主导再立项，否则是猜 |
| 基座硬化（sidecar / WASI / QuickJS） | 威胁模型没变——工具不出宿主、门禁在宿主，Worker 够用；真沙箱是「放开网络/裸 fs」的前置条件，不是当前痛点。**外部对照**：四家的底座各不相同（microVM / gVisor / V8 isolate / QuickJS-WASM），共识只有一条——**进沙箱的只有绑定，没有网络、没有凭证**（§11.1）。哪天要放开联网/裸读文件，必须先换底座，这是硬闸门 |
| 持久 kernel（Jupyter 式跨调用变量） | 与「一次调用 = 一段可审计、可复现的程序」直接对冲（`host.ts:5-7` 明写一次性 worker 是为了免去跨 run 清理）；要状态就落工作区或走显式缓存绑定。**外部对照**：OpenAI 明确每次全新运行时、Cloudflare 明确 executor 无状态、Pi 把状态放会话记录——**共识正是「状态放沙箱外」**（§11.2） |
| 程序内暂停等审批（pause-for-approval） | 已知差距，但当前不痛。现行门禁语义 = **打回**（`blocked`）+ 模型改程序重试，而业界的暂停-恢复需要 durable runtime（Cloudflare 用 SQLite 存 pending approvals，OpenAI 用 fingerprint 续跑）。真要做，前置条件是**先有逐调用审批 UI**，否则只是把「打回」换成「挂着等一个没人看的对话框」 |

## 9. 门禁与提交纪律

| 批次 | 门禁 |
|---|---|
| P1 | `cd src-ui && npm run build` + `npx vitest run tests/code-execution.test.ts` + `npx biome ci .` + `npm run verify:convergence`（**需先重录**） |
| P2 / P3 / P4 | 同上（同样在 `src-ui` 下），但 convergence **必须零漂移**（不重录即通过） |

**baseline 流程（P1 专有）**：`src-ui/tests/convergence/baseline-change-request.md` 追加一条（变更内容 = 描述里
多了绑定目录与一条示例，模型可见面唯一变化；用户可感知行为 = 无）→ 批准 → standard 与 minimal 两轨各重录 →
`verify:convergence` 双轨绿。**record 永不上 CI**，重录动作单独一个 commit，不夹带代码。

**提交纪律**：一批一 commit，按 P1 → P2 → P3 → P4 串行（共享 `host.ts` / `segments.ts` / `protocol.ts`，
并行施工必撞）；P1 的「重录」与「代码」分开，便于逐行对拍 diff 形状；P4 的 commit message 必须写明
**模型可见行为变更**（§6.2）。

## 10. 边界（本计划不动的东西）

- 不动表序（`segments.ts` 的段序 = 字节契约，D7）。
- 不改程序体语言（纯 JS / async 函数体），不做运行时类型擦除。
- 不放宽门禁：嵌套调用继续走 planGate / preflight / hooks / 截断，审计逐条落账。
- **不放宽预算**：P4 只是把「超限 = 作废」改成「超限 = 截断 + 标记」，64KB 上限一字不改。
- 不加第二判据（`retryable` / `severity`，§5.1）与第二真源（手抄参数说明，§3.1）。

---

## 11. 附录 · 业界横向（外部证据，非依据）

> **口径**：以下全部来自公开文档与官方博客的**读**（核实日 2026-10-30），未跑基准、未复现其数字；
> 引用时带「其文档称」的语气。本附录只做两件事：给 P1-P4 验伪、给挂起项找反证。

### 11.1 四家实况

| | Anthropic PTC | OpenAI PTC | Cloudflare Code Mode | Pi Codemode |
|---|---|---|---|---|
| 程序跑在哪 | Python 容器 | 每次**全新** V8（用完即销毁） | V8 isolate（每次一片） | QuickJS in WASM |
| 目录怎么给模型 | 文件树 + `search_tools`（名字 / +描述 / 全量三档） | `tool_search` + `defer_loading` | schema **生成 TypeScript 声明**塞进描述（`{{types}}` / `{{example}}` 占位符） | 同类 |
| 状态留不留 | **留**（容器复用，Python 变量还在） | 明确不留 | executor 不留；durable runtime 用 SQLite 记执行/审批 | 存会话记录（宿主侧） |
| 错误面 | 异常 | 异常 | **上游错误 = 程序能 catch 的异常** | 异常 |
| 结果上限 | — | — | 约 6000 token，超出打 `--- TRUNCATED ---` | — |
| 硬边界 | 容器无网络；**`allowed_callers` 文档明写「不是安全边界」** | 无 Node / 无网络 / 无文件系统 / 无 console | `fetch`/`connect` 默认抛错；**binding 屏蔽 API key** | 无网络 / 无文件 / 无定时器 |

### 11.2 对账

| 本计划的判断 | 外部实况 | 裁决 |
|---|---|---|
| P1 **只**放名字（10-29 版） | 业界放类型声明 + 调用样例；Anthropic 称 Tool Use Examples 把复杂参数准确率 72%→90% | **已按 §3.1 修订**：名字 + 派生签名 + 一条示例；但**不抄全量 schema** |
| P2 按动作只读 + 键控写锁 | **没有一家做这个**；OpenAI 反而建议「写操作默认走直调，保住授权边界」 | 本地发明，收益真实但**模型不可见** ⇒ §4.2 的保守名单（只有 `filePath` 分片）是硬纪律 |
| P3 错误加 `code` / `hint` | 业界只到「异常 + 人读文本」，**无人给枚举** | 我们**往前一步**，不是落后；发布即契约，见 §5.1 |
| P4 截断当结果 | Cloudflare 同一手法（`--- TRUNCATED ---`） | 采纳（§6） |
| 门禁不豁免（嵌套调用照走） | Anthropic：「客户端要能接住直调」；Cloudflare：「`codeMcpServer` 不做逐调用审批，请在上游 handler 自己加」 | 我们比两家**更严**，可引为背书 |
| 挂起：持久 kernel | 共识是「状态放沙箱外」 | 判断正确（§8） |
| 挂起：类型检查器 | 无人做 | 判断正确（§8） |
| 挂起：基座硬化 | 底座各异，共识只有「沙箱内无网络、只有绑定」 | 判断正确 + 一条硬闸门（§8） |

**一处结构性差异（本计划的本地特例）**：四家的痛点是「外部工具目录挤爆上下文」（Anthropic 称见过
134K token），所以要把目录做成可检索/可渐进披露。而本仓库的绑定 = **模型自己手里那批工具的可见面快照**
（`segments.ts:192` 的 `visibleTools()`），schema 早已在工具清单里 ⇒ **生成全量类型声明是重复计费**。
所以行业通用做法在这里只对一半：**投影签名对，全量声明错**。

### 11.3 明确不采纳的三条（附理由，不是「以后再说」）

| 业界做法 | 不采纳的理由 |
|---|---|
| 全量 TypeScript 类型声明进描述 | 绑定 ⊂ 模型已有工具 ⇒ 重复（§11.2 末段）；我们的工具契约全文 56KB，塞进任何描述都是灾难 |
| `search` + `execute` 双工具（渐进披露） | 那是「几千个操作」的解法；本卷绑定约 15 条、目录约 1KB，加一层检索 = 多一跳、多一个猜错点 |
| durable runtime（执行记录 / 审批 / 回放） | 兰台的等价物已在：session-log 审计 + 宿主门禁（更严）。缺的只有「暂停等审批」，而它前置要审批 UI（§8） |

### 11.4 出处

- Anthropic, *Code execution with MCP*（2025-11-04）；*Introducing advanced tool use*（2025-11-24）
- Cloudflare, *Code Mode: the better way to use MCP*（2025-09-26）；Agents 文档 *Build a Code Mode MCP server*（2026-10-27 更新）
- OpenAI, *Programmatic Tool Calling* / Codex `features.code_mode`（经第三方汇总转述，未见官方原文细节）
- Pi, *What is Codemode*（2026-10-06，作者自述）
