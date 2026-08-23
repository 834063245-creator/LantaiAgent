# P4a — DSH 契约调研笔记

> 日期：2026-08-23 · 调研对象：`D:\useful\deepseek-harness` @ `141eb6fef8`（2026-08-19）
> 判据：agent-plugin-architecture-plan C13——最小服务契约子集 + L1/L2 插件依赖面分布。
> **结论一句话：工具面的公共分母是可序列化 JSON Schema，DSH 与兰台的模型面契约三字段完全同构；
> compat 的真实成本在 peer 服务圈（6-7 个），不在工具形状；版本纪律前提（无对外承诺）仍成立，路线 B 先行不变。**

## §1 最小契约子集

### 1.1 工具声明：模型面对拍

DSH 模型可见 schema（`packages/llm/llm/src/types.ts`）：

```ts
interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>   // JSON Schema object
}
```

兰台对应物（`src-ui/src/agent/tool.ts` Tool 接口 + `schemas()`）：`name() / description() / parameters(): Record<string, unknown>`，`ToolRegistry.schemas()` 返回同名字段。**三字段逐一同构，零映射成本。**

### 1.2 工具声明：作者面对拍（defineTool）

| 维度 | DSH `DefineToolOptions`（tools/src/schema.ts:483） | 兰台 defineTool | 判定 |
|---|---|---|---|
| 参数 schema | 自研 JSON-value DSL（ParameterSchemaSpec）→ **编译为 JSON Schema**（`parameterSchemaSpecToJsonSchema` + `assertSupportedJsonSchema`） | zod v4 → JSON Schema | ✅ 公共分母成立：两边规范形态都是可序列化 JSON Schema |
| 输出契约 | 必选 `output{schema, render, presentationMeta?}`——canonical value + 纯渲染投影 | 无（返回 string） | ⚠️ DSH 多一层输出 schema 校验；compat 可用宽松 any-schema 近似 |
| 并发标注 | `isConcurrencySafe?(args)` 显式 opt-in | `readOnly()` 布尔 | 🔶 语义近似方向相反（白名单 vs 黑名单），映射时需保守取交 |
| 执行签名 | `execute(args, exec: ToolRunContext)`（signal/caller/nesting 内嵌） | `execute(args, onProgress?, signal?)` | 🔶 context 形状不同，compat 需适配层 |
| 表现钩子 | `presentCall/presentResult/finalizeContent` | 无（块渲染走 renderer-service） | ➖ 可选钩子，缺省即兜底 |
| 超时 | `timeoutMs?`（策略包装器消费，不进模型面） | 无独立字段 | ➖ |

**schema 库迷思澄清**：schemastery 在 DSH 里是包 config 声明用（几乎所有包的 dependencies），zod 只在个别包（storage-domain/todo）出现——**工具参数声明两者都不用**，用的是自研 JSON-value DSL，编译目标 JSON Schema。兰台的「manifest 用可序列化 JSON Schema」决策与 DSH 规范形态天然对齐。

### 1.3 system prompt section 对拍

| 维度 | DSH `PromptSection`（system-prompt/src/index.ts:53） | 兰台 PromptSection（composition/prompt-sections.ts:39） |
|---|---|---|
| 标识 | `name`（唯一，重复注册抛错） | `id` |
| 排序 | `order: number`（约定：-100 身份 / 0 persona / 100-199 工具指导） | 表序 = 字节契约（前缀缓存依赖） |
| 内容 | `text: string \| (ctx) => string`，支持 `{{variable}}` 后置插值 | `render(ctx)` 产出含自身前导分隔符的完整文本 |
| 开关 | 无（注册即参与）；有 `complete?` 整体替换语义 | `applicable?(ctx)` 条件跳过 |
| 动态上下文 | 另有 PromptContext（user-role 快照，独立通道） | 无独立通道（并入段落） |

同构度高（name/order/render 三要素齐全）；差异集中在分隔符所有权（兰台内嵌字节契约 vs DSH 渲染层拼接）与 order 数字化。compat 映射 section 是机械活。

## §2 依赖面分布（全量 226 内部包扫描）

Top peer 出现频率：

| peer 包 | 次数 | 占比 |
|---|---|---|
| @deepseek-ai/cordis | 226 | 100% |
| @deepseek-ai/dsh-invariants | 225 | ~100% |
| dsh-session | 85 | 38% |
| dsh-llm | 85 | 38% |
| dsh-agent | 64 | 28% |
| dsh-tools | 48 | 21% |
| dsh-client-runtime | 37 | 16% |
| dsh-system-prompt | 31 | 14% |

分层典型值：**L1 纯工具类**（tool-todo/tool-web）peer 5-6 个；**L2 工具+prompt 类**（tool-bash/tool-workflow）peer 8-12 个。计划里「cordis 只占八分之一」的判断被证实且更严峻——cordis+invariants 是全员底座，真正区分层的是 session/llm/agent/tools/system-prompt 这圈。

**compat 层要模拟的最小 peer 面（L1/L2 工具类插件）≈ 6-7 个服务契约**：cordis、invariants、llm、session、tools、system-prompt（+agent 视插件而定）。其中 llm/session/invariants 在兰台没有一一对应物，需要 stub 或最小实现——这是路线 A 的主要工作量所在。

## §3 版本纪律现状

证据：抽样 tool-todo/tool-web/tool-workflow/core-tools 四包 peerDependencies 全部为 `workspace:^`，无一处对外发布版本号；根 package.json version `0.1.0-rc.8`，存在 `publish:npm-baseline` / `release:publish` 脚本——**正在走向 npm 发布但尚未完成公开版本锁定**。

判断：「DSH 无官方版本纪律承诺」前提今日仍成立，但 rc 版本号表明在靠近。跟随时机未到，结论与 D9 换轨一致。

## §4 对两条路线的含义

- **路线 B（自研 manifest 同构 L1 契约）现在就能锁死的字段**：工具声明三字段 name/description/parameters(JSON Schema) 与 DSH ToolSchema 同形；并发标注命名建议直接采用 DSH 语义方向（显式 opt-in 安全并行）以降低未来映射成本；section 注册采用唯一 id + 重复拒绝。
- **路线 A（dsh-compat）还欠的**：① ToolRunContext/exec 形状适配；② output canonical-value 契约近似；③ llm/session/invariants 三服务 stub；④ 版本漂移检测无从做起（没有版本可钉），只能做形状断言（structural drift check）。A 的启动信号应设为「peer 出现非 workspace 版本」而非仅「接口稳定表态」。

## 附：调研方法

DSH 五个实证范本文件（plan §2）本轮复核仍有效；新增一手证据：llm/types.ts ToolSchema 定义、tools/schema.ts DefineToolOptions 编译链、system-prompt PromptSection 全文、226 包 peers 全量统计（原始清单 `D:\tmp\hana-exec-command-a1e1e434ab44f99a.log`，临时文件，已抄录关键数字入本文）。
