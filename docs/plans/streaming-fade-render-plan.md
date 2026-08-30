# 流式渐显渲染（streaming-fade-render）计划

> 状态：**In progress：Phase 1-3 已落地（2026-08-30），真机验收待用户跑**
> 一句话：给兰台流式文本装上 Claude Code 桌面端式的「增量淡入」，覆盖 markdown 正文 / reasoning / notice / user 全文本 kind，正文与夹注统一，不割裂。
> 施工史：2026-08-30 Phase 1-3 一次性施工（方案 B）——渲染器 ref 增量识别（startsWith 判追加，零数据层侵入）+ 三级切分（稳定段零动画 / 行内续写接末块 / 换行后成新块）+ `pp-ink-delta` CSS（0.72→1 起墨、--glide 0.3s）；新测试 `tests/paper-streaming-fade.test.tsx` 7 用例 + taste-ledger 落账；门禁 tsc / biome 0-0 / convergence 通过 / 渲染相关 73+7 全绿。**真机验收清单见 §5，等用户跑**。

## 0. 为什么做 / 目标

**现状**：兰台流式文本是打字机式，新 token 直接刷入，观感是「印刷体排队出现」。与纸壳的书写美学脱节，读起来冷。

**目标**：内容永远清晰的前提下，新到达的文本以极轻的淡入「浮现」出来，像有人在纸上续写。方向已在 demo 验证（`D:\useful\ink-demo\index.html`，用户判：比打字机好太多）。

**明确不做**：
- 不做真笔顺（Make Me a Hanzi 数据重、秒级动画与 token 流节奏冲突，之前已否）
- 不做墨迹晕染重特效（表演盖内容，用户已否）
- 不动数据管线（part-mutator / chat-stream / message-model 冻结文件一根手指不碰）

## 1. 现状管线（改哪 / 不改哪）

```
Agent 流式事件 → part-mutator.ts 原地追加（last.text += ev.text）
→ chat-stream.ts bump → PaperPanel translate → SourcedBlock[]
→ BlockView → composition/renderer-service.tsx → .pp-body
```

**关键事实**（已实测确认）：
- `SourcedBlock` 已带 `finalised` 字段（translate.ts:326 直映 `part.finalised`），渲染器能判断「此块是否还在流式中」。流式中 `finalised === false`，`Message` 事件后置 true。
- `BlockRendererProps` 目前只有 `{ block, folded? }`，**没有增量信息**。渲染器拿到的永远是「完整最新文本」，不知道这次多了哪几个字。
- 内置 8 kind 渲染器：user / markdown / reasoning / notice / diff / plan / tool / code。文本类 = markdown / reasoning / notice / user 四个，本次全部覆盖。

**不动**：`src/ui/chat-stream.ts`、`src/ui/part-mutator.ts`、`src/ui/message-model.ts`、`paper/translate.ts`（数据形状不动）。

**动**：`src/composition/renderer-service.tsx`（MarkdownBody / TextBody / UserBody）+ 纸壳 CSS（`--obs-*` token 体系）。增量识别收在渲染器内部，不污染数据层。

## 2. 方案

### 2.1 增量识别（渲染器内自持，不改数据层）

每个文本类渲染器内部用 `useRef` 记住「上次渲染的文本长度 lastLen」。每次渲染对比：

- `newLen > lastLen` 且 `block.finalised === false`（流式中）→ 有增量，进入增量渲染
- 否则 → 整块静止渲染，`lastLen` 不更新（finalised 回填历史时不闪）

增量区间的归属按「字符偏移」落到 markdown 的块/行结构上：

| 区间 | 处理 |
|---|---|
| 偏移 < lastLen 的完整块 | **旧块，零动画**（绝对不闪） |
| 增长区第一个块（正在长的块） | 块内按行切：lastLen 前的行稳定，之后的行淡入；若最后一行行内续写，按字符偏移切，只对新增字符包淡入 span |
| 增长区其余块 | 整块包淡入 span |

这样把动画限制在「正在长出来的那一小段」，观感接近 Claude Code：正文整体稳定，只有新内容轻轻浮现。整段文本仍走一次完整 `parseMarkdown`，块结构不失真；增量只是决定「哪些节点包动画」，不影响 markdown 解析正确性。

### 2.2 覆盖面（全 kind 统一，不割裂）

| kind | 渲染器 | 增量动画 |
|---|---|---|
| markdown（正文） | MarkdownBody | ✅ 按 2.1 块/行/字符三级切分 |
| reasoning（思考） | TextBody | ✅ 纯文本，行级切分即可 |
| notice（通知） | TextBody | ✅ 同 reasoning |
| user（来文） | UserBody | ✅ 行级切分；【词】朱砂圈 span 保持结构，增量只影响圈标记判断 |

diff / plan / tool / code 不做增量淡入（非连续文本流，tool/code 已有自身状态动画），保持现状。

### 2.3 动画参数（进 taste-ledger，用户终审）

- 透明度：0.72 → 1（不从 0 全透明，避免闪烁感；Claude Code 就是这个「轻」）
- 时长：约 0.2s，ease-out
- 位移：可选极轻微上移 1px（可关，默认先不上位移，保持纸壳静止美学）
- **不用 blur**（demo 里试过，纸壳阅读场景偏特效，待用户裁决是否保留极轻 blur）

参数以 CSS 变量形式落在 `--obs-*` token 体系，动画名一个 `ink-enter`，钉值进 `tests/paper-visual-decisions.test.ts`（对齐现有视觉钉值惯例）。

## 3. 施工阶段

**Phase 1 — 纯文本 kind 先行**（reasoning / notice / user）：行级增量淡入，验证「旧块稳定 + 新段浮现」的核心观感与性能。改动小，先跑通链路。
**Phase 2 — markdown 正文**：块/行/字符三级切分，处理流式中 markdown 结构截断（列表项、代码块、引用在流式中半成型的渲染正确性）。
**Phase 3 — 打磨收口**：CSS 变量化 + 钉值测试 + 折叠态/钉住态边界 + 全量门禁 + 真机验收。

## 4. 验证门禁（不过不交付）

- `cd src-ui && npx vitest run`（含新增增量渲染测试）
- `cd src-ui && npm run build`（tsc + vite）
- `cd src-ui && npx biome ci .`（0/0）
- `cd src-ui && npm run verify:convergence`（renderer-service 属 composition 层，硬门禁）
- 新增测试按用户操作序列写（样板 `tests/session-repro-ghost-volume.test.ts`），不写实现形状

## 5. 真机验收清单（用户跑）

1. 一段长回答流式输出：正文只在「新长出的小段」淡入，旧文本全程稳定不闪
2. 思考块与正文同时流式：两边渐显风格一致，不割裂
3. 流式中 markdown 半成型（列表/代码块写到一半）渲染不破版
4. 回答结束（finalised）后：整块静止，回填/重排不闪
5. 钉住块（pinned）+ 折叠思考态下行为正常

## 6. 风险与决策点

- **决策点 D1**：方案 A（块级淡入，简单）vs 方案 B（行/字符级三级切分，更精细）。本计划默认 B；若 Phase 1 观感已达标且用户满意，Phase 2 可降级 A 省成本。
- **决策点 D2**：动画参数（透明度起点 / 时长 / 是否位移 / 是否 blur），用户终审。
- **风险 1**：markdown 流式中最后一块结构截断，行级/字符级切分要保证旧段尾部渲染不破版。Phase 2 重点压测。
- **风险 2**：增量判断每帧成本。`lastLen` 对比是 O(1)，切分只在有增量时发生，性能可控。
- **风险 3**：思考块折叠态（folded 预览）下不触发增量动画，避免折叠展开闪动。

## 7. 谁判断

| 项 | 谁判断 |
|---|---|
| 方案 A / B 取舍 | 用户 |
| 动画参数终审 | 用户 |
| 施工与门禁 | Agent |
| 真机验收 | 用户 |
