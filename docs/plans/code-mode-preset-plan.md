# code 模式 preset（2026-11-21 立项）

> 状态：**批 1/2/3 已落地（2026-11-21）**
>
> **2026-11-22 追补**：code preset 改用 fail-closed 的 `directOnly` allowlist（v67），
> 不再维护 `programOnly` 逐工具黑名单；plan-tools / plan-injector 在 code 组合里
> 显式禁用（plan gate 会拦 code_execution，叠用会锁死会话）。
> 触发：用户 2026-11-21 拍板——「我认为应该走 B 选项单独出一个 code mode preset」+
> 「程序内的子调用在纸面上其实是应该显形的，只是我一直没来得及做」。

## 1. 病症（会话实测，不是推断）

\`.lantai/sessions/*.ndjson\` 全量统计（2026-11-21）：

| 观测量 | 数值 |
|---|---|
| \`code_execution\` 占全部工具调用 | **21.7%**（1593 / 7348；单卷最高 98%） |
| 每次程序平均嵌套调用 | **1.99** |
| 只嵌 0~1 次的程序 | **47.5%**（677 / 1446） |
| 单嵌程序中「读了就吐回」的纯套壳 | **63.5%**（430 / 677），p50 程序体 280 字符 |
| 直调里 \`shell\` / \`fs\` 占比 | 60.5% / 28.5% |
| 连续多轮纯域直调（一次没碰 code_execution） | 413 段 / 4549 轮，最长 161 轮 |

两条病灶：

1. **判据缺席**：描述里只有「什么时候该写程序」（loops / fan-out / try-catch），没有反面；
   于是过半调用是「一个读包一层」，多付一次协议往返且零红利。
2. **并发面藏在 schema 里**：C7 的「读类并行」只写在域工具自己的动作枚举里，而域门面
   \`readOnly()\` 恒为 false（全动作才只读）——模型得先猜哪些动作算读才敢写 \`Promise.all\`。

## 2. 裁定（不制造判断题）

| # | 事项 | 裁定 | 理由 |
|---|---|---|---|
| A1 | 收掉工具列表？ | **不**。程序内能 await 什么 = \`visibleTools()\`，收 = 程序内直接 \`unknown-binding\` | \`segments.ts\` 的绑定集就是这张表；「只留 code_execution」物理上等于工具面归零 |
| A2 | 动态裁剪可见面？ | **不**。\`DEFAULT_VISIBLE_TOOLS_LIMIT = 0\` 是刻意取舍（子集重打分击穿前缀缓存，实测单次 ~10 万 tokens 全价） | \`agent.ts\` 注释 + 实测 |
| A3 | 转而做 preset？ | **是**（用户拍板 B 选项）：把「程序优先」做成**用户按环境可选**的组合 | 组合是**静态**字节契约，不吃缓存的亏；\`defaultOff\` / preset 都是既有机制 |
| A4 | 子调用显形 | **是**（用户拍板）：纸面必须能看见程序内发生了什么 | 现在 \`tool/code-dispatch*\` 明确「无消息投影」⇒ 模型折叠 N 次调用，人一次都看不见 |

## 3. 批 1（已落地，2026-11-21）

**只改描述面**（模型可见字节 = \`code_execution\` 的 description）：

1. **直调判据**：「One call is cheaper and clearer as ONE direct tool call … do not wrap it in a program」。
2. **只读动作投影**：绑定目录每条的动作枚举里，只读动作带 \`+\` 前缀（\`fs(action: +read|write; path)\`），
   表头解释 \`+\` 语义（可 \`Promise.all\` 扇出，写串行）。
   - 数据源 = \`Tool.readOnlyActions()\`（活注册表），与 host 的 \`readOnlyFor\` **同源** ⇒ 描述与执行语义不会分家。
   - 这不是「参数说明」——它是 C7 并发契约本身，P1 的「参数说明永不进」纪律不覆盖它。

**测试命运**：\`tests/code-execution.test.ts\` 两条既有断言**故意规格变更**（\`fs(action: read)\` → \`fs(action: +read)\`），
新增 2 例（只读投影 / 直调判据）。convergence 双轨重录（审批记录在
\`src-ui/tests/convergence/baseline-change-request.md\` 首条）。

## 4. 批 2（待施工）：\`code\` preset

**形状**：\`composition/presets.ts\` 内置表加一条（id 用 \`code\`，与 standard/minimal/creator/readonly 并列）：

- 语义 = 「工具面收进程序」：模型**直调**只剩 \`code_execution\`（+ 会话级原语），
  域工具全部改为**程序内可见**（照旧可 \`await tools.fs(...)\`）。
- **不能靠剪行实现**：剪掉行 = 程序内也调不到（绑定集读 visibleTools），
  code mode 会被做成残废。需要的是「直调面 / 程序面」两层的分离。

**机制（新增，但要尽量薄）**：\`ToolRegistry\` 增 \`directTools()\` 与 \`programOnlyNames\` 集合——
\`schemas()\` 改读 \`directTools()\`，\`visibleTools()\`（= 绑定集）不变；直调一个程序内专属名时，
executor 返回**可读引导**（「本卷是 code 模式：请用 code_execution 调 tools.<name>」），
不是「未知工具」的含糊报错。

**提示面**：preset 的 \`prompt.insert\` 一段模式说明（怎么调、写类为什么仍会被门禁打回、
什么时候不该用程序）。

**门禁**：\`blueprint.test.ts\`（若动 capability 表）+ 新增 preset 测试 + convergence
（\`code\` 轨另立 baseline，见 \`helpers/presets.ts\` 的登记规则）。

## 5. 批 3（已落地）：程序内子调用在纸面显形

**现状**：\`tool/code-dispatch-start\` / \`tool/code-dispatch\` 逐条落 session-log（审计完整），
但 \`deriveMessages\` 明确「无消息投影」（\`session-log.ts\`），纸面只有外层一张 \`code\` 块。

**形状（待细化）**：程序执行卡的**体**里增一段「程序内调用」清单——每个子调用一行
（工具名 · 动作 · 结果首行/失败），折叠态只留计数（\`内调 7 次 · 1 失败\`）。
数据源 = 子调用的审计对；**不要**在协议上加第二份表示（同 \`__view\` 的教训）。

**已探明的硬约束**：

- 子调用现在只活在 session-log，**不进 provider 消息**（模型看不到自己的子调用历史）——
  纸面要读它，转译层需要一条新路径（session-log → part/block），不是从 \`part.output\` 反推。
- \`paper/tool-text.ts\` 的 \`codeSections\` 是**展示面解析契约**（逐字匹配信封行），
  若走「结果信封里多一段」，必须同改 \`codeSections\` 与测高/墨迹三处。
- 册页渲染的 \`CodeBody\` / 测高 \`codeOutSections\` / 墨迹 \`inkSourcesFor\` 是**三面镜像**，
  新增段要三面同批（先例：P5 的结构化完成值）。

### 5.1 已探明的边界（登记，不在本批修）

- **子 Agent 不继承 code 模式**：`buildSubAgentTools` clone 的是注册表实例，
  directOnly / programOnly 策略按名字记在每个实例上，且 capability（`code_execution` 本身）
  本就不下放给子 Agent。**刻意不传播标记**——传播了子 Agent 会拿到「请用
  code_execution」却根本没有这个工具的死循环，比现状更坏。
- **plan 模式的只读克隆**（`planRegistry`）按 `readOnly` 收工具，不看
  直调面策略：规划用的只读子 Agent 仍能直调只读工具。这是**想要**的
  （它们没有 code_execution，也没必要绕程序）。
- **冷恢复的旧卷**没有这一段（`uiMessages` 快照缺席）；不凭审计补造，理由见上。

## 6. 边界（本计划不动的东西）

- 不放宽门禁：嵌套调用继续走 planGate / preflight / hooks / 截断，审计逐条落账。
- 不改程序体语言，不做持久 kernel（\`code-execution-upgrade-plan\` §8 的裁定仍然有效）。
- 不把工具面摊平成 DSH 那样（\`D2\` 的反面结论不变）。
