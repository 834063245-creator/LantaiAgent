# RPC 边界运行时校验层设计（typedJsonRpc schema 第三步）

状态：**已竣工合入 main（批一 2026-09-01 当日设计当日施工，commit ea1606b6；worktree 分支合入后已删）**。
批二（§4 长尾）按定案无施工日——未来首个调用者被签名强制入表。
**批后演化（2026-09-05 kernel-capability R 批次）**：收编面 12→6 命令——list_directory /
list_directory_flat / read_memory_batch 随 fs 域收口迁 fs_cap 助手内联 zod（dirEntryArraySchema，
kernelListDirectory 族内消费）；shell_env / git_status 随 shell/git 域收口迁 process_cap /
git_cap 文本路径（消费方 parseJson / porcelain 解析；aura_init 更早已随 AURA 记忆系统拆除退役）。
校验面随命令迁移不消失；签名守卫与三重守护测试（tests/rpc-result-schemas.test.ts）原样存续，
§8 验收全项达成（CDP 项降维组件测试 sessions-home-fault.test.tsx——违形 → 首页显式报错态）。
来源：UI 全面审计批「唯一挂起项」的配套立项（`docs/plans/paper-shell/taste-ledger.md` 2026-09-01 批：
「typedJsonRpc as T 无运行时校验——schema 层架构级，单独立项」）。
定位：宪法 `docs/adr/project-constitution.md` §与拆弹的关系明列病根一根治 =「RPC `Value` 化 **+ 边界 schema**」——
Value 化两步已落地（`docs/landmine-map.md` 根治级段，2026-08-22），本文是那后半句的施工图。

> **修订（2026-09-01，用户质疑「真的有必要向后兼容吗」成立）**：§3.2 初版的
> 「两阶段重载并存」判死——实测调用面 22 处 / 9 命令 / 方法名全字面量，
> 兼容期要保护的动态调用面不存在，逃生舱只是让 `as T` 盲转按设计续命。
> 签名改**一刀切收紧**，详见 §3.2 与 §6-E 否决记录。

> **施工实核（2026-09-01 批一竣工修订）**：①全量普查修正——调用面实为
> **26 处 / 12 命令**（§3.2 普查 22/9 漏了 shell_env/git_status 各 1 处，
> hologram_call 实 7 非 8、list_directory 实 6 非 4、workspace_list 实 3 非 2）；
> 收紧结论不变（方法名全字面量、零动态分发），批一按 12 命令全量入表。
> ②形状双源核对修正样例：sandbox_status 实有 `available` 且 `reason` 恒在
> （§3.1 样例 `{degraded,reason?}` 不准）；workspace_list 的 `dir_exists`/
> `graph_engine` 键恒在（后者 `bool|null`）。③批一顺带修复三处泛型盲转时代
> 的既有静默断点：load_graph_json 真机结构化后 workspace.ts 仍 parseJson
> （图谱预热假死）/ skills.ts 读 `e.type`（Rust 发 `is_dir`，项目技能真机恒
> 不加载）/ formatGitStatus 读 `f.file`（Rust 发 `path`）。④hologram_tools_list
> 的 `readOnly`/properties.description 取 optional——引擎 mcp_value 恒写但
> 浏览器 mock 面缺省且被 convergence/tool-contract 基线钉住，schema 兼容两态
> 而不动模型可见面。⑤mock 补齐 5 命令真实形状（sandbox_status/shell_env/
> git_status/read_memory_batch 此前落 Unhandled 回退垃圾形）。

## 0. 一句话

`typedJsonRpc` 的 `JSON.parse(raw) as T` 是盲转——给 JSON 命令加**边界单点**的运行时形状校验：
zod schema 与 `RpcContract` 同址共治，违形即炸（宪法四：错误不静默）；签名一刀切收紧，
调用未登记命令 = 编译错（无兼容期，判由见 §6-E）。

## 1. 问题陈述

三入口共同现状：**编译期有约束（方法名/参数/形状注释），运行时零校验**。

| 入口 | 编译期 | 运行时 |
|---|---|---|
| `typedRpc<M>` | 方法名+参数受 `RpcContract` 约束 | result: string 直通（text 类合理） |
| `typedJsonRpc<T>` | method 是裸 `string`（同 agentInvoke 哲学） | parse 后 `as T` 盲转 |
| `typedListen<E>` | 事件名+payload 受 `EventContract` 约束 | payload 直通 |

`as T` 盲转的三种失守面：

1. **后端漂移**：Rust 改结构忘同步 `RpcContract`——string 里的形状编译器看不见；
2. **mock 漂移**：`mockInvoke` 手写响应与真机形态分叉——浏览器 dev 恒「看起来对」；
3. **Ok-but-wrong**：Rust Ok 路径产错形——出口只保「Ok 恒为合法 JSON」，不保形状。

后果形态：不炸在边界，而是**毒化下游 state**（炸点远离病灶）或静默渲染残缺（违宪法四）。
本审计批现场实例：`SessionsHome` 的 `typedJsonRpc<KnownWorkspace[]>('workspace_list')`——
若后端漏 `dir_exists` 字段，UI 拿 `undefined` 走「目录已丢失」分支，全程无报错。

既有防线盘点（各管一段，没人管形状）：

- Rust 出口：合法性已钉（parse 失败转 Err），形状未钉；
- `rpc_result_shape` 表：管运输形态（Text/JsonValue）分派，不管内容形状；
- `tests/rpc-value-shapes.test.ts`：钉双形态 shim 行为，不钉各命令形状。

## 2. 非目标

- `agentInvoke` 动态工具分发不进本设计（工具面已有 zod define-tool 体系，另一条线）；
- **params 入参不校验**：Rust 侧 serde 反序列化已是强校验边界，前端入参错形在 Rust 侧 Err 可见；
- Text 类命令（`read_file_content`/git stdout 等）不校验（内容本身非契约）;
- 不做 Rust→前端 schema codegen（否决记录见 §6-B）。

## 3. 定案

### 3.1 schema 与契约同址（单一权威源不破）

`RpcContract` 是方法契约唯一权威源（文件头维护纪律：后端加/改方法同步更新本文件）。
schema **追加在同一文件**，不另立 schema 文件——防契约与 schema 互漂：

```ts
// rpc-contract.ts
export interface RpcContract { /* …既有… */ }

/** 运行时契约：JSON 命令 result 形状（与 RpcContract 的 `// JSON` 注释同源维护）。
 *  键集 = 已收编命令集；未登记命令 = 未校验直通（§4 渐进收编）。 */
export const rpcResultSchemas = {
  workspace_list: z.array(
    z.object({
      path: z.string(),
      name: z.string().nullable(),
      last_opened_at: z.string(),
      pinned: z.boolean(),
      session_count: z.number(),
      latest_saved_at: z.string().nullable(),
      dir_exists: z.boolean().optional(),
      graph_engine: z.boolean().nullable().optional(),
    }),
  ),
  sandbox_status: z.object({ degraded: z.boolean(), reason: z.string().optional() }),
  // …
} satisfies Partial<Record<RpcMethodName, z.ZodType>>;
```

要点：

- `satisfies Partial<Record<RpcMethodName, …>>` ——键拼写错/方法名不存在编译期炸；
  `keyof typeof rpcResultSchemas` 免费得到「已收编 JSON 命令」子集类型，**不另立清单**（防第三张表）。
- 只有 `// JSON` 注释条目许入表；`// text` 禁入（收编进度人工清单挂 §5）。
- schema 是 result 注释的**运行时投影**：字段可选性以后端 Ok 路径真实形态为准（入表前双源核对，见 §7）。
- 依赖：zod ^4.4.3 **既有**（23 文件在用，家法成熟），零新依赖。

### 3.2 签名一刀切收紧（无兼容期——2026-09-01 修订）

```ts
export async function typedJsonRpc<M extends keyof typeof rpcResultSchemas>(
  method: M,
  params?: RpcParamsOf<M>,
): Promise<z.infer<(typeof rpcResultSchemas)[M]>> { /* … */ }
```

- **T 泛型整体退役**，method 从裸 `string` 收紧为已登记命令集——新调用未入表命令
  = 编译错，签名即守卫（§3.4 的人工收编账由此退役）。
- **判由（2026-09-01 实测全库）**：typedJsonRpc 调用共 22 处 / 9 命令
  （hologram_call×8、list_directory×4、workspace_list×2、load_graph_json×2、
  list_directory_flat/read_memory_batch/hologram_tools_list/
  get_last_project/sandbox_status 各 1），方法名**全为字面量、零动态分发**——
  收紧即编译器逐个点名全部迁移点，兼容期一寸工都省不下（完整否决论证见 §6-E）。
- **迁移 = 9 个 schema + 22 处删手写泛型**：调用点改动几乎全是
  `typedJsonRpc<KnownWorkspace[]>(…)` → `typedJsonRpc(…)`（类型改由 schema 推导）。
- **hologram_call 特例（唯一粗检条目）**：载荷形状随工具（36+ 工具动态），表内入
  `z.unknown()` 级粗检 + 注记「载荷校验归 define-tool 工具面体系，边界只保
  合法 JSON」——门保持唯一，**不设 raw 逃生后门**（后门即第二个盲转入口）。
- 运行时：parse 后查表 `safeParse`；失败 **throw**（错误信息带方法名 + zod issue
  摘要），绝不降级放行——RPC 调用本就是 promise，错误沿既有 reject/try 路径
  可见（宪法四）。
- 双形态都过校验：string 慢路径 parse 后校验；结构化 Value 快路径 safeParse 直上。
- 大体量命令（`get_graph_snapshot` 类聚合快照）：粗检（顶层关键字段 + `passthrough`）
  或暂不入表——无调用点者本就不在强制面内；未来首个调用者入表时按体量选粗检档。

### 3.3 mock 同源自检（防 mock 漂移）

新增 `tests/rpc-result-schemas.test.ts`：遍历 `mockInvoke` 已登记命令的返回 →
对 `rpcResultSchemas` 同表校验。mock 与 schema 漂移在 vitest 第一时间炸，
浏览器 dev「恒看起来对」的假象根除。

### 3.4 守卫

- `rpcResultSchemas` 键 ⊆ `RpcContract` 键：`satisfies` 编译期钉死，无需反射测试；
- typedJsonRpc 函数体保持单点小函数（现 ~10 行）——绕过校验的 `as` 无处藏身，review 即可见；
- 签名收紧后**守卫即编译器**：新调用未登记命令直接编译错，人工收编账退役；
  另加一条可 grep 终态守卫：全库 `typedJsonRpc<` 泛型残留必须为零。

## 4. 施工路线（两批，一刀切不带过渡态）

1. **批一（收紧 + 9 命令全量入表，一个 commit 序列做完）**：9 命令形状双源核对 →
   `rpcResultSchemas` 全表 + 签名收紧 + 22 调用点删泛型 + §3.3 mock 自检测试 +
   schemas 四态测试（合法/缺字段/多字段/类型错）。门禁：tsc/biome ci/vitest 全绿 +
   CDP 首页/设置冒烟。体量=一天内（9 个 schema 是主要工作量，调用点改动机械）。
2. **批二（长尾 = 无施工日）**：契约里其余 ~20 个 JSON 命令当前无 typedJsonRpc 调用点，
   不预收编——未来首个调用者写 schema 方可编译（签名强制），粗检档按体量自选。

## 5. 收编清单（批一定案，全量即此 9 命令）

| 命令 | 调用点 | 形状档 |
|---|---|---|
| hologram_call | 8 | 粗检（z.unknown() 级——载荷随工具，校验归工具面） |
| list_directory | 4 | 全检 |
| workspace_list | 2 | 全检 |
| load_graph_json | 2 | 视体量全检或粗检（批一实测定） |
| list_directory_flat / read_memory_batch / hologram_tools_list / get_last_project / sandbox_status | 各 1 | 全检 |

形状均须双源核对后落笔（Rust `rpc_result_shape`/结构体 + 真机 CDP 实测，见 §7）。

## 6. 备选与否决记录

- **A. zod 同址表（定案）**——既有依赖、契约单文件、家法成熟。
- **B. Rust 结构体 codegen schema（扩 gen-rpc-contract-md.cjs）**——否决：codegen 链路多一层翻译，
  serde Option/attr → zod 语义映射繁琐且产物不可手读；契约本就人肉同步（既存维护纪律），
  schema 同址让人肉同步多看一眼即可，远便宜于养 codegen。
- **C. 调用点各自 zod**——否决：违宪法一边界单点；56 处调用面各写各的，漏写无守卫。
- **D. JSON Schema + AJV 全量运行时**——否决：引新依赖，JSON Schema 与 TS 类型双源更远。
- **E. 两阶段向后兼容（重载并存，本文初版方案）**——**否决（2026-09-01 用户质疑成立）**：
  ①逃生舱保活的正是要杀的病——`as T` 盲转在「未登记命令」名下合法化，缺陷按设计续命；
  ②实测调用面 22 处 / 9 命令 / 方法名全字面量，签名收紧即编译器点名全部迁移点，
  兼容期一寸工省不下；③同一函数「登记与否双行为」的中间态 API 反增心智；
  ④本仓过渡态长期化有先例（Value 化双形态 shim 即一例）——无强制收敛的过渡态 = 永久态。
  兼容期唯一假想收益是保护「动态方法名调用面」，实测为零，故整段拆除。

## 7. 风险与代价

- **schema 写错比不写更坏**：入表前必须双源核对（Rust `rpc_result_shape`/结构体定义 + 真机 CDP 实测形态），
  9 命令一次做完，无一豁免；
- 双 parse 代价：string 慢路径 parse + safeParse——JSON 命令均为中小体量
  （大头 `get_graph_*` 无 typedJsonRpc 调用点，未来首调用时按体量选粗检档），批一实测后定粗检线；
- throw 策略的误伤面由「双源核对 + 四态测试」压住；hologram_call 粗检条目保证
  动态载荷不会被形状校验误杀。

## 8. 验收

- `tests/rpc-result-schemas.test.ts` 四态全绿 + mock 漂移测试（改 mock 一字段 → 红）；
- 真机 CDP：`workspace_list` 人为缺字段 → 首页显式报错（非静默走错分支）；
- 全库 `rg "typedJsonRpc<"` 零残留（泛型盲转终态守卫）；
- tsc 0 / biome ci 0 / vitest 全量绿。
