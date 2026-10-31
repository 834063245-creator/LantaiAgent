# 卷名自动命名（A / C / B）· 2026-10-31

> 状态：**A + C 已落地（2026-10-31）；B 未开工（Draft）** —— 用户同日先「先落 PLAN」后「开工」，
> A/C 两批已完成并过门禁；B（LLM 概括）留待下一批。
> 参照真源：`D:\useful\deepseek-harness\packages\session\session-title\`（DSH 的 log-only 标题服务）。
> 结论先说：**兰台已经有这条链的 80%**（真源 / 两个命名时点 / 改名 / 落盘 / 枝卷判据 / 改名即钉死），
> 本计划只补「名字的质量」与「谁起的名字」两件事，**不移植 DSH 的服务架构**。

## 1. 病灶（取证见 §9）

现行自动命名 = `deriveVolumeLabel(text) = text.trim().slice(0, 28) + '…'`，三个可复现缺陷：

1. **换行进名字**。`trim()` 只去首尾，多行来文（粘贴一整段报错或需求）把 `\n` 带进 `label`。
   卷首题字走 `pre-wrap` 测高（`measureTextHeight` 注释原文「换行符是硬换行」）⇒ 卷首**真的变成多行**、
   卷级几何随之变高；窗口标题（`use-document-title`）也带换行。
2. **前缀与围栏进名字**。首句以 ```` ``` ```` / `#` / `- ` / `> ` 开头或带 `@` 引用时，名字带着这层壳。
3. **截断按 UTF-16 code unit**。`slice(0, 28)` 在第 28 位碰上 emoji 会劈开代理对，产出半个字符。

外加一个结构性缺口：**名字只有「派生」一种来源，且不记来源**。要加 LLM 概括时，
没有判据区分「这是用户手起的名（不可覆盖）」与「这是刚才自动派生的名（可以覆盖）」。

## 2. 为什么不抄 DSH 的服务架构

DSH 的 `session-title` 有 revision / AbortController / 投影单元 / provider 注册表 / 终止符清洗 / 80 字节硬顶，
复杂度**来自它的架构前提，不是功能本身**：

| DSH 的件 | 它为什么必须有 | 兰台为什么不需要 |
|---|---|---|
| revision + AbortController supersession | 全局单例服务、多会话并发、自动/显式两条路、可换 provider | 一卷一写者；判据 =「label 空不空 + 来源」，落地前再查一次即可 |
| `title` / `titleInput` 投影单元 | 冷列表要 O(1) 读标题、不打开会话 | 侧栏直接读 store 的 `sessions[]`，卷快照就是缓存 |
| provider 注册表 + first-prompt/all-prompts 双模式 | 生态可换、可插拔 | 兰台只有一个主模型，compaction 已把旁路调用拿稳 |
| 终端转义清洗 + UTF-8 80 字节硬顶 | 标题可能进终端标题/日志 | 标题只进 HTML 显示面：去控制符 + 折叠空白足够 |
| `session/title` 事件 + fold | 要可回放、可审计 | 卷名就是一个字段，落在卷快照里 |

一句话：**DSH 在为「一个服务管所有会话」付代价；兰台是「一卷管自己」，天然无竞争。**

## 3. 目标形状

### 3.1 数据面：一个字段 + 一个来源标记

`ChatSessionMeta` 加 `labelSource?: VolumeLabelSource`（**内存态，不进卷快照**——见 §8 落地修正）。

- **`undefined` = 来源未知**（旧卷 / 读盘卷 / 未命名）⇒ 按 `user` 对待，**永不自动覆盖**（宁可不改，不可误改）；
- 新卷：起卷无名（无 source）→ 发送时派生写 `derived` → B 批可把它覆盖成 `llm`；
- 用户改名一律写 `user`（钉死语义照旧，判据仍由 `isUnnamedVolumeLabel` 一族承担）；
- **缺省写在 store 的写入口**（`renameSession` 第三参不传 = `user`）：记错成 `user` 只让自动命名少改一次，
  记错成 `derived` 会覆盖人起的名——这是安全侧的缺省。

### 3.2 可写判据（全仓唯一一处，落 `volume-name.ts`）

```text
writable = isUnnamedVolumeLabel(label) || labelSource === 'derived'
```

**落地前再判一次**（异步结果回来时用户可能已改名）。这一条 if 就是 DSH 整套 revision /
AbortController 在兰台的等价物——不要为它引入 revision 计数或取消控制器。

取值目前只有 `derived` / `user` 两枚（A/C 批只发这两枚，不为未实现的批次预留死值）；
B 批落地时加第三枚 `refined`（已尝试过自动概括 ⇒ 不再重试），否则派生名会在每轮末重复烧一次调用。

### 3.3 派生面（A 批，已落地）

`state/volume-name.ts` 内新增三个**内部**纯函数（不导出——行为只经 `deriveVolumeLabel` 暴露，不造无消费者的 API）：

- `cleanVolumeLabelText(raw)`：C0/C1 控制符换空格 → 去方向/零宽控制符 → 折叠所有空白（含换行、制表）为单空格 →
  剥行首排版壳（代码围栏 / `#` 标题 / `>` 引用 / `-`·`*`·`+` 列表 / 有序列表，叠用最多剥四层）→ trim；
- `truncateVolumeLabel(text, max)`：按 **code point**（`Array.from`）截断，超限补 `…`——代理对不再被劈开；
- `deriveVolumeLabel = truncate(clean(raw), 28)`（发送时 / 轮末 / 读盘三条路仍是同一把尺子）。

**口径不变**：`VOLUME_LABEL_MAX_CHARS` 仍是 28 **个字符**，`volume-name.test.ts` 既有 28 字断言**零改动**。
（原计划写「改显示宽度、CJK 按 2 计」——**落地时否决**：中文是本产品主语言，按宽计会把中文卷名拦腰砍成 14 字，
是可见回归不是精度提升；理由见 §8。）

### 3.4 LLM 概括（B 批）

**不新增 LLM 管道**。复用 Agent 已有的旁路能力位 `callSummaryLLM(signal, messages, { replay: false })`
（内部 = `streamWithIdleTimeout` 包主模型 + 温度 0.3 + 30s 空闲超时 + 每次调用入账日志）。

- 新文件 `src-ui/src/state/volume-title.ts`：只放纯逻辑
  `buildTitlePrompt()` / `parseTitleReply(text)`（取首个非空行 → 剥整行 `**` 强调 → 去控制符 → 空则 `null`）；
- 调用点：`autoTitleSessionIfDefault` 之后新增 `refineVolumeTitleIfDerived(storeId, sid)`；
  `void` 发起、不阻塞回合；失败 `log.warn` 一条、保留派生名、**不弹 toast**；
- 入参：本卷**自己的**首条来文（沿用 `inheritedMessageCount` 判据，禁新写第二套）；
- 草拟 prompt（B 批实现时以此为准，可调）：

```text
你为兰台的「案卷」起题名——一句概括本次会话要做什么。
只输出题名本身：一行、纯文本、无引号、无前缀、无 Markdown、无句末标点。
用消息本身的语言；中文 8–14 字，英文 4–7 词。
信息不足时给一个最简短的尽力题名（如「问候」），不要解释。
```

- **token 账口径**：本次调用的 usage **不入卷 `tokens`**（那是上下文构成账，标题调用不进上下文），
  只落 `log.info` 一行（provider / model / prompt_tokens / completion_tokens / elapsed）。
  这条要写进注释——否则三年后会有人当漏账补上，污染压力读数与压缩预检。

### 3.5 与版式的接缝

卷名的读者包含卷首题字测高、窗口标题、书脊题名、墨层地志标签。⇒ B 批**只在结果与现值不同才写**，
避免异步落地引发一次无意义的版式抖动。

## 4. 批次与改动面

| 批 | 内容 | 生产文件 | 测试 |
|---|---|---|---|
| **A** ✅ | 清洗 + code point 截断 | `state/volume-name.ts` | `tests/volume-name.test.ts` +4 例（多行 / 围栏与列表前缀 / 控制符 / emoji 边界），既有 28 字断言零改动 |
| **C** ✅ | `labelSource` 贯通（**内存态**） | `state/volume-name.ts`（类型）、`state/session-store.ts`（字段 + 写入口缺省）、`ui/chat-session.ts`（轮末派生写 `derived`）、`app/chat/chat-core.ts`（发送时派生写 `derived`） | `tests/volume-naming.test.ts` 补派生 → `derived` / 改名 → `user` / 起卷 → `undefined` / store 写入口缺省 = `user` |
| **B** | 一次旁路调用 | 新增 `state/volume-title.ts`；`ui/chat-session.ts` 新函数 | 新 `tests/volume-title.test.ts`（纯函数）+ `volume-naming.test.ts` 行为 3 例：覆盖 `derived` / 用户改名后不落地 / 调用失败保留派生名 |

顺序：**A + C 同批已落地**（2026-10-31，一个工作树）→ **B 单独一批**（唯一引入模型不确定性的改动）。

**C 的落地修正**：`labelSource` 不落盘。原计划要带 4 处快照写点（合卷 `:495` / 保存单卷 `:1493` /
批量保存 `:1531` / 改名 `:1596`）+ 2 处读面，等于去动冻结文件 `ui/chat-session.ts` 的持久化面；
而 B 只需要「本进程内知道这个名字是不是刚派生的」，内存态够用。代价见 §8，收益 = 冻结文件零持久化改动。

## 5. 钉值

| 面 | 断言（✅ = 已落地） |
|---|---|
| 派生（纯函数）✅ | 多行来文 → 单行；围栏/标题/引用/列表前缀被剥（含叠用）；控制符换空格、方向符去掉；emoji 边界不劈开代理对；28 字边界与全空白断言**零改动** |
| 来源（行为）✅ | 发送时与轮末派生 → `derived`；用户改名 → `user`；起卷未命名 → `undefined`；store 写入口缺省 = `user` |
| 概括（行为） | `derived` 名在 LLM 结果回来后被打上 `refined`；**用户改名后飞行中的结果不落地**；调用抛错 → 保留派生名 + 一条 warn |
| 枝卷（回归）✅ | 立枝后子卷仍按自己的首条来文命名（`session-branch.test.ts` 既有三例零改动，实测仍绿） |

## 6. 门禁

每批：`npm run build` · `npx biome ci .`（0/0）· `npx vitest run`（全量，不许只跑局部）。
B 批额外：真机看一次「首条来文很长」的卷（A 批已覆盖的短句不应再有变化）。
文档面：本页与索引同步后跑 `npm run doc-check`。

## 7. 明确不做

- **不移植** DSH 的 provider 注册表、`automatic: first-prompt | all-prompts` 双模式、投影单元、
  `session/title` 事件与 fold、终止符转义表、UTF-8 字节硬顶、「单一 provider」注册器；
- **不做**「每条消息都重命名」（`all-prompts` 语义）——兰台的卷名是题名，不是实时摘要；
- **不做** 名字删除/搜索索引/重命名历史；
- **不改** 命名真源（仍是一个字段）、两个命名时点、显示兜底「案卷 N」、枝卷判据。

## 8. 风险与偏差

- **落地否决：不按显示宽度截断**（原计划 §3.3 的口径）。28 个 CJK 字按宽计会变成 14 字——中文卷名拦腰砍半，
  是可见回归。改成按 code point 截断、字数口径不变：既修了 emoji 劈半，又打回**零个**既有断言。
- **来源是内存态**：`labelSource` 不进卷快照 ⇒ 重启后所有卷的来源都是 `undefined`（按 `user` 对待），
  即「已派生、尚未概括」的卷重启后不再自动概括。取舍：宁可少改一次，也不去动冻结文件的持久化面。
  B 批的体感只在「同一进程内新起的卷」上验收，别当成功能没生效。
- **旁路调用依赖 compaction 产物**：`callSummaryLLM` 经 `requireCompactionImplementation()` 取实现
  （service 类产物，不可禁用）。缺产物时 fail-loud → B 批的 `try/catch` 必须包住它，
  降级为「保留派生名」，不得打断会话。
- **max_tokens 沿用摘要的 8192 上限**（不是标题专用的 64）：这是复用现成能力位的代价，属已知偏差。
  真要收窄需给 compaction 契约加参数——**第一版不做**（会动 `compaction-contract.ts` 的接口面）。
- **版式抖动**：见 §3.5，靠「不同才写」兜住；若真机仍可见跳动，退路是只在下一轮开始前落地（不作第一版）。

## 9. 已验事实（2026-10-31 取证）

- 命名真源：`src-ui/src/state/volume-name.ts` —— `isUnnamedVolumeLabel:32` / `volumeDisplayName:41` /
  `deriveVolumeLabel:47`（`trim().slice(0, 28)`，无清洗）。
- 命名时点两处：发送时 `src-ui/src/app/chat/chat-core.ts:1543-1549`（`isUnnamedVolumeLabel` 判据 +
  `renameSession`）、轮末 `src-ui/src/ui/chat-stream.ts:572` → `src-ui/src/ui/chat-session.ts:224`
  （`autoTitleSessionIfDefault`）。
- 改名：`plugins/builtin/canvas-nav/SessionSidebar.tsx:557` → `app/chat/chat-core.ts:819`（store）/
  `:828`（落盘）→ `ui/chat-session.ts:1572` 的 `renameSessionFile`（只覆盖 `label`，保留
  `tokens` / `compose`——该函数注释记录了「重建卷对象抹掉 tokens」的历史事故）。
- 「改名即钉死」已有测试：`src-ui/tests/volume-naming.test.ts:119`（「已命名的卷不被自动命名覆盖」）。
- 枝卷判据：`ui/chat-session.ts:241` 用 `inheritedMessageCount` 跳过继承前缀
  （病修过两次：session-tree §12.6 / §12.12）。
- 卷首测高：`plugins/builtin/paper-shell/measure.ts:497` 的 `measureFolioHeadHeight` →
  `:445` `measureTextHeight`（`pre-wrap`，换行是硬换行，见 `:431` 注释）。
- 窗口标题：`src-ui/src/app/use-document-title.ts:35`（`volumeDisplayName`）。
- 旁路调用范本：`plugins/builtin/compaction/agent-compaction.ts:903` 的 `callSummaryLLMImpl`
  （`streamWithIdleTimeout` + 温度 0.3 + 30s 空闲 + 入账日志）；能力位在
  `agent/agent.ts:2361`（`summaryProvider`）/ `:2367`（`callSummaryLLM`）。
- 会话元数据：`src-ui/src/state/session-store.ts:10` 的 `ChatSessionMeta` 目前只有
  `id` / `label` / `createdAt`。
- **A/C 落地取证（2026-10-31 同日）**：`volume-name.ts` 新增 `cleanVolumeLabelText` / `truncateVolumeLabel`
  （28 字口径不变、按 code point 截断）；`ChatSessionMeta` 增 `labelSource?: VolumeLabelSource`（内存态）；
  两个派生点（`app/chat/chat-core.ts` 发送时、`ui/chat-session.ts` 轮末）各写 `derived`，
  store 写入口缺省 `user`。门禁：`npm run build` ✅ · `npx biome ci .` ✅（exit 0，1099 文件）·
  `npx vitest run` **445 文件 4779 例全绿** · `doc-check` 见 §6。
