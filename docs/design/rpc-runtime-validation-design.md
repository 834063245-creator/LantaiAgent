# RPC 边界运行时校验层设计（typedJsonRpc schema 第三步）

状态：**Draft 立项设计件（2026-09-01，未施工）**。
来源：UI 全面审计批「唯一挂起项」的配套立项（`docs/plans/paper-shell/taste-ledger.md` 2026-09-01 批：
「typedJsonRpc as T 无运行时校验——schema 层架构级，单独立项」）。
定位：宪法 `docs/adr/project-constitution.md` §与拆弹的关系明列病根一根治 =「RPC `Value` 化 **+ 边界 schema**」——
Value 化两步已落地（`docs/landmine-map.md` 根治级段，2026-08-22），本文是那后半句的施工图。

## 0. 一句话

`typedJsonRpc` 的 `JSON.parse(raw) as T` 是盲转——给 JSON 命令加**边界单点**的运行时形状校验：
zod schema 与 `RpcContract` 同址共治，违形即炸（宪法四：错误不静默），未登记命令直通（渐进收编）。

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

### 3.2 typedJsonRpc 签名两阶段升级（向后兼容）

```ts
// 阶段一（重载并存）：
// 有 schema 的命令——T 可省略，schema 即类型源：
typedJsonRpc('workspace_list', {})  // → KnownWorkspace[]（z.infer 推导）
// 无 schema 的命令——维持现状（method: string + T 手写 + 直通），调用点零改动：
typedJsonRpc<Foo>('some_cmd', {})   // → Foo（盲转，收编前过渡态）
```

- 运行时：parse 后查表，命中即 `safeParse`；失败 **throw**（错误信息带方法名 + zod issue 摘要），
  绝不降级放行——RPC 调用本就是 promise，错误沿既有 reject/try 路径可见（宪法四）。
- 双形态都过校验：string 慢路径 parse 后校验；结构化 Value 快路径 safeParse 直上。
- 大体量豁免：`get_graph_snapshot` 类聚合快照可粗检（顶层关键字段 + `passthrough`）或暂不入表——
  未登记 = 直通，收编不阻塞在体量上。
- 签名重载的具体 TS 形态（重载序/泛型约束）施工时定，本文只钉语义。

### 3.3 mock 同源自检（防 mock 漂移）

新增 `tests/rpc-result-schemas.test.ts`：遍历 `mockInvoke` 已登记命令的返回 →
对 `rpcResultSchemas` 同表校验。mock 与 schema 漂移在 vitest 第一时间炸，
浏览器 dev「恒看起来对」的假象根除。

### 3.4 守卫

- `rpcResultSchemas` 键 ⊆ `RpcContract` 键：`satisfies` 编译期钉死，无需反射测试；
- typedJsonRpc 函数体保持单点小函数（现 ~10 行）——绕过校验的 `as` 无处藏身，review 即可见；
- 收编进度表（§5）随批更新，作为「哪些命令还在盲转」的人工可见账。

## 4. 施工路线（三小批，不搞一次性大改造——宪法拆弹纪律）

1. **批一（骨架 + 试金 3 命令）**：`rpcResultSchemas` 立 + typedJsonRpc 重载 +
   `workspace_list`/`sandbox_status`/`background_activity` 收编 + §3.3 测试 +
   schemas 四态测试（合法/缺字段/多字段/类型错）。门禁：全绿 + CDP 首页/设置冒烟。
2. **批二（数据面收编 ~15 个）**：`rpc_result_shape` JsonValue 表内命令逐个核对真机形态后入表；
   大体量命令粗检或暂缓并记录缘由。
3. **批三（收口拍板）**：评估是否收紧为全 JSON 命令强制入表（`Record` 全量 satisfies），
   或长期「未登记=直通」双轨——拍板点留到批三，依赖批一二手感。

## 5. 收编清单

批一施工时建立（初表：`rpc_result_shape` 表 21 个 JsonValue 命令 + workspace 系 6 个 +
read_memory_batch/read_constraints 等），逐命令核对 Ok 路径真实形状后填入——
**本文不预填细节**，防纸上谈兵（形状必须双源核对，见 §7）。

## 6. 备选与否决记录

- **A. zod 同址表（定案）**——既有依赖、契约单文件、家法成熟。
- **B. Rust 结构体 codegen schema（扩 gen-rpc-contract-md.cjs）**——否决：codegen 链路多一层翻译，
  serde Option/attr → zod 语义映射繁琐且产物不可手读；契约本就人肉同步（既存维护纪律），
  schema 同址让人肉同步多看一眼即可，远便宜于养 codegen。
- **C. 调用点各自 zod**——否决：违宪法一边界单点；56 处调用面各写各的，漏写无守卫。
- **D. JSON Schema + AJV 全量运行时**——否决：引新依赖，JSON Schema 与 TS 类型双源更远。

## 7. 风险与代价

- **schema 写错比不写更坏**：入表前必须双源核对（Rust `rpc_result_shape`/结构体定义 + 真机 CDP 实测形态），
  批一的 3 命令即按此流程走通作为范式；
- 双 parse 代价：string 慢路径 parse + safeParse——JSON 命令均为中小体量
  （大头 `get_graph_*` 不入表/粗检），批一实测后定粗检线；
- 长尾：未入表命令维持现状（不比今天坏）；throw 策略的误伤面由「双源核对 + 四态测试」压住。

## 8. 验收

- `tests/rpc-result-schemas.test.ts` 四态全绿 + mock 漂移测试（改 mock 一字段 → 红）；
- 真机 CDP：`workspace_list` 人为缺字段 → 首页显式报错（非静默走错分支）；
- tsc 0 / biome ci 0 / vitest 全量绿。
