# 卡片引用（夹签）落地方案

> **状态**：P0 已落地（2026-11-19）· **P1 的「点引用」全套动效已落地（2026-11-20）**；P1 余项 = 长按拖拽改归属
> **落地记录**：`state/card-quote.ts`（纯数据面 + 摘要模板）/ `state/input-store.ts`（`attachedCards`
> 槽 + 5 个方法，含跨槽递送 `addAttachedCardToSlot`）/ `app/chat/chat-core.ts`（发送前落快照、
> 逐枚降级、写盘失败不发送）/ `paper-shell`（块操作条「引用」+ 架阁「引」）/ `compose-dock`（夹签轨）。
> 测试：`card-quote.test.ts` / `card-quote-draft.test.ts` / `card-quote-send.test.ts` /
> `card-quote-target.test.ts` / `composer-quote-rail.test.tsx`。
> **动效面（§6.1 + §6.4 降级）已落地**：`paper-shell/quote-flight.ts`（起点=卡、终点=夹签轨，
> 二次弧线 240ms，落地即摘除；量不到任一端不画）+ `paper-composer.css` 的归位动画与
> `prefers-reduced-motion` 分支；测试 `card-quote-flight.test.ts`。
> **P1 余项 = 长按拖拽改归属（§2.2 态二 / §6.2）+ 撕掉的反向动效（§6.3）**；
> 拖拽的写入口已备好（`input-store` 的 `addAttachedCardToSlot`，已有测试），只差手势与命中检测。
> **一句话**：点/长按「引用」→ 卡片以**夹签分身**落进目标卷的夹签槽（本体不动）→ 发送时落一份快照 + 一段固定摘要进上下文 → Agent 要细节、要改，用**现成工具**自己去取。
> **本文档是施工单**：拿到就能开工，不需要再问设计意图。

---

## 0. 开工前必读（三条，先说死）

1. **不新增任何模型工具、不新增 RPC 方法。**
   摘要里给的是现成工具能解的地址（`fs(read)` / `list_block_kinds` / `update_asset`）。
   一旦有人想「加个 card_list 工具」，方案就失败了——那等于给 Agent 一把库房钥匙，而不是一次通行证。
2. **卡片本体永不动。**
   引用是拓印，不是搬家。任何「引用后卡从画布上消失 / 被收进槽 / 被折叠」的实现，直接返工。
3. **动效不是装饰，是因果可视化。**
   每个位移必须有起点和终点，禁止凭空生灭；全程 ≤ 320ms。

---

## 1. 全局原则

> **兰台没有「搬家」，只有「拓印」。**

现有动作全是这个语义：

| 动作 | 本体 | 副本 |
|---|---|---|
| 入阁 | 留在卷里 | 进架阁 |
| 钉住 | 留在卷里 | 上画布 |
| **引用（本方案）** | **留在画布/卷里** | **进夹签槽** |

由此推出两条硬纪律：

- 引用后原卡的**可见状态、位置、折叠与否一律不变**
- 引用内容 = **发送那一刻的快照**；之后原卡怎么改，不影响已发出的引用

---

## 2. 用户可见行为（规格）

### 2.1 引用入口（两个地方）

| 入口 | 位置 | 说明 |
|---|---|---|
| 块操作条 | 卡片块的动作行，与「入阁」并排 | 会话里的卡 |
| 架阁卡片 | 架阁列表项的操作 | 库里的卡 |

按钮文案：**引用**

> ⛔ 本期不做：消息正文选文字引用。

### 2.2 两个态

**态一 · 点一下（快路）**
- 目标 = 当前 `liveOwner` 的槽
- `liveOwner` 为空（画布上既没有卷也没有纸）→ 按钮**禁用**，tooltip：「先展开一卷或落一张纸」

**态二 · 长按（准路）**
- 长按 **320ms** 触发（`pointerdown` 起计时；位移超过 8px 取消长按、转正常滚动）
- 触发后卡片「离纸」浮起，**所有卷进入可投放态**
- 拖到某一卷上方松手 → 落进**那一卷**的槽
- **不切换活跃卷、不抢输入焦点**（用户还在 A 卷干活，只是把卡递给了 B）
- 落在空白 → 夹签飞回原位

### 2.3 夹签槽（归属模型 · 本方案的核心）

**槽是每卷一份，不是全局一份。**

复用现有输入草稿机制：`SessionDraft` 增加 `attachedCards`，随卷保存 / 恢复（`claimLive` 换手时自动带走）。

- 点引用 → 进 `liveOwner` 那份
- 长按拖到 B 卷 → 写进 `sessionDrafts['s:<B>']`（B 卷的草稿），**不影响 live 那份**
- 切到 B 卷 → `claimLive('s:B')` 把夹签带出来，用户看得见

**推论（必须接受，不是 bug）**：给 B 卷的夹签，在 A 卷**看不到**。这正是「归属」的意思。

### 2.4 槽的形态

坞的附件区新增一条**夹签轨**（`pp-card-rail`），与现有附图轨（`pp-image-rail`）并列、同风格。

每枚夹签 = 巴掌大的缩略纸：

- 左上角：类型签（汉字，复用 `plateSignOf`：卡 / 图 / 表 / 板…）
- 中间：标题（单行省略）
- 右上角：× 撕掉
- 悬停：浮起 + 显示来源（本卷 / 架阁）

### 2.5 去重

同一张卡（同一 `assetId` 或同一 `cardId`）在同一槽内只允许一枚。
再次引用 → 不新增；槽里那枚**闪一下**（180ms 高亮）+ toast「已在夹签槽里」。

### 2.6 发送

- `canSend` 判据加：`attachedCards.length > 0`（只有夹签也能发）
- 顺序：**正文在前，夹签摘要在后**，一行分隔
- 发送成功 → 槽清空
- 发送失败 → **槽保留**（不能丢用户的引用）

### 2.7 撕掉

点 × → 夹签缩小淡出 + 槽收拢，**不留空洞**。只影响槽，不动任何盘上文件（此时也还没写）。

---

## 3. 数据模型

### 3.1 夹签（内存）

```ts
export interface QuoteCard {
  refId: string;              // q-<yyyymmdd-hhmmss>-<4位随机>
  origin: 'session' | 'shelf';
  assetId?: string;           // origin = session
  cardId?: string;            // origin = shelf
  sourceSessionId?: string;
  kind: string;               // 卡片 kind
  title: string;              // 可空串
  bytes: number;              // payload 序列化字节数
  at: string;                 // ISO，引用时刻
}
```

**只存元数据，不存 payload**——payload 可能几百 KB，槽里放不下。

### 3.2 输入槽扩展（`src-ui/src/state/input-store.ts`）

```ts
interface SessionDraft { /* …原字段… */ attachedCards: QuoteCard[] }
interface InputStore {
  attachedCards: QuoteCard[];
  setAttachedCards / addAttachedCard / removeAttachedCard / clearAttachedCards
}
```

**必须同步的构造点（漏一个就丢夹签）**：

- `snapshotDraft()`
- `emptyDraft()`
- `claimLive()` 的换手逻辑（自动带，但要写测试验证）
- 三处 `clearSessionDraft` 调用点（`session-crud.ts` / `chat-core.ts` / `session-restore.ts`）：删卷时一并丢弃

### 3.3 引用快照（盘上）

**时机：发送时写，引用时不写。**
理由：用户可能反悔；只有真发出去的才值得落盘，否则 `refs/` 全是垃圾。

- 路径：`{工作区}/.lantai/refs/<refId>.json`
- 写入：`kernelWriteFile()`（`rpc-contract.ts` 已有，原子写、自动建父目录）

内容：

```json
{
  "refId": "q-20261119-1052-a1b2",
  "at": "2026-11-19T10:52:13.000Z",
  "origin": { "kind": "shelf", "cardId": "card-...", "sessionId": null },
  "card": { "kind": "html", "title": "示例标题", "payload": { "code": "..." } },
  "state": null,
  "note": "引用时快照；原卡此后改动不影响本文件"
}
```

`state` 默认 `null`（**不带**用户填写）。P2 才提供「含我的填写」勾选。

### 3.4 内容来源

| origin | 发送时怎么取 payload | 摘要里给的地址 |
|---|---|---|
| `session` | 渲染层从 block / 该卷消息表取 | `assetId` |
| `shelf` | `readCard(cardId)` RPC → `card.json` | 库内绝对路径 |

⚠ **跨卷引用**（A 卷引用 B 卷的卡）时渲染层拿不到 B 卷的 block：P0 按 `assetId` 从 `regionsRef` 里找目标卷的 blocks；**取不到就如实降级**（见 §4 规则 3），不假装成功。

---

## 4. 摘要格式（逐字 · 固定模板）

每张引用卡在 user message 里渲染成这一段。**模板固定，不随卡片变化**：

```
〔引卡〕<类型汉字>《<标题或"未命名">》
· 快照：<yyyy-mm-dd hh:mm>（此后原卡改动不影响本次引用）
· 来源：本卷第 N 张 / 架阁 card-xxxxx
· 规模：payload 4,524 字符
· 原文：D:/HoloGramHG/.lantai/refs/q-20261119-1052-a1b2.json（用 fs read 取）
· 改本体：update_asset({"assetId":"as_xxx"})        ← 仅 origin=session 时出现
```

规则：

1. **规模用千分位**——一眼看出是不是大件
2. **原文必须是绝对路径**——模型不知道 home 在哪
3. **降级文案（取不到 payload 时）**：
   `· 原文：未落快照（跨卷引用且未能取到内容）——如需内容，请让用户重新引用`
4. 多张卡之间**空一行，不编号**（编号会让模型误以为有顺序语义）

---

## 5. 发送链路

### 5.1 拼装位置

```
<用户正文>

——以下为引用卡片——

〔引卡〕...
〔引卡〕...
```

理由：不打断用户说的话；材料附在后面，模型读起来是「任务 + 附材料」。

### 5.2 实现要点

- 在 `use-composer-send.ts` 组装文本时拼接，**不改消息 part 结构**（本期不碰消息模型）
- 写快照是异步的 → **先 `await` 全部写完再发消息**，保证模型拿到摘要时文件已在盘上
- 写盘失败 → **不发送**，toast「引用快照写入失败：<错误>」，槽保留

### 5.3 前缀缓存纪律

引用内容是**新的 user message 的一部分**，不改历史前缀 → 不违反字节契约。
**禁止**把引用内容插入历史消息或系统提示。

---

## 6. 动效分镜

### 6.1 点引用（快路 · 总 260ms）

| 帧 | 时长 | 内容 | 缓动 |
|---|---|---|---|
| 1 | 0–80ms | 卡本体 scale 1→0.99（「让开」），**不位移、不透明变化** | ease-out |
| 2 | 0–80ms | 夹签在卡中心生成：scale 0.6、opacity 0 | — |
| 3 | 80–260ms | 夹签沿**二次贝塞尔弧线**飞向槽（起点=卡中心，终点=槽中心，控制点上抬 40px），scale 0.6→1，opacity 0→1 | `cubic-bezier(.22,1,.36,1)` |
| 4 | 200–260ms | 槽高度展开（0→实际高度），已有夹签轻微左移让位 | ease-out |
| 5 | 260ms | 卡本体 scale 回 1 | ease-out |

**必须**：卡本体全程可见、不位移、不淡出。

### 6.2 长按（准路）

| 阶段 | 时长 | 内容 |
|---|---|---|
| 按住 | 0–320ms | 卡轻微下沉（scale 0.99）+ 一圈**进度环**沿卡边描出（这就是「按住」的可见回执） |
| 触发 | 120ms | 卡抬起：scale 1.03 + 投影加深 + 光标变「拿着」态 |
| 同时 | 180ms | **所有卷**边界描线浮现（opacity 0→1）+ 各卷夹签槽显形（高度 0→24px 占位） |
| 拖动 | 实时 | 夹签跟随光标（带 12px 偏移，不遮手指）；悬停的卷：描线加粗 + 底色加深 8% |
| 松手（有效） | 180ms | 夹签下沉落槽 + 回弹（scale 1.03→1）+ 其他卷描线淡出 |
| 松手（无效） | 300ms | 夹签**飞回原位**（沿来路反向）+ 卷描线淡出 |

### 6.3 撕掉（140ms）

夹签 scale 1→0.85、opacity 1→0，同时槽高度收拢。**不留空洞**。

### 6.4 全局纪律

- **≤ 320ms**，超时视为拖沓
- **有来处、有去处**：禁止 opacity 0→1 凭空出现
- **可逆**：拖错能拖回去；撕掉能重来
- **连点幂等**：飞行中的夹签不响应第二次点击（`refId` 去重 + 飞行锁）
- **降级**：`prefers-reduced-motion: reduce` → 全部改为 120ms 原地淡入淡出，取消飞行弧线

---

## 7. 实现落点

| 文件 | 改动 | 备注 |
|---|---|---|
| `src-ui/src/state/input-store.ts` | `SessionDraft` / `InputStore` 加 `attachedCards` + 5 个方法（含跨槽递送 `addAttachedCardToSlot` = P1 长按拖拽的写入口）；`snapshotDraft` / `emptyDraft` 同步 | 内核模块，零 UI 依赖 |
| `src-ui/src/state/card-quote.ts`（新） | `QuoteCard` 类型、`newRefId()`、`renderQuoteBlock()`（摘要模板）、`buildQuoteSnapshot()` | 纯函数为主，可单测。**写盘拆出去**：本件被纸壳/坞两个产物内联 ⇒ 必须无状态无 IO，落盘归宿主 `chat-core` 的 `kernelWriteFile` |
| `src-ui/src/plugins/builtin/paper-shell/use-block-ops.ts` | 动作行加 `quote`（与 `shelve` 并排） | `onQuote` + `quoteReady` 两个入参（后者让空画布时置灰而非消失） |
| `src-ui/src/plugins/builtin/paper-shell/quote-target.ts`（新） | `quoteSlotOf()` / `useQuoteReady()`：夹签落给谁 | 未认领时按活跃卷认领——不认领会被下一次换手写回旧主的卷 |
| `src-ui/src/plugins/builtin/paper-shell/use-paper-panel.ts` | 接线 `quoteBlockAsset`：读 block payload → 建 QuoteCard → `addAttachedCard` | 与 `shelveBlockAsset` 同构 |
| `src-ui/src/plugins/builtin/paper-shell/ShelfOverlay.tsx` | 架阁项加「引用」：`readCard` → 建 QuoteCard | |
| `src-ui/src/plugins/builtin/compose-dock/composer-rows.tsx` | 渲染夹签轨（`pp-card-rail`）；`canSend` 加判据 | 与 `pp-image-rail` 同构 |
| ~~`compose-dock/surface/use-composer-send.ts`~~ → **实际落 `app/chat/chat-core.ts` 的 `sendMessage`** | 发送前 `await` 写快照 → 拼摘要 → 发 | **施工勘误（2026-11-19）**：发送编排的真源在 `ChatCore.sendMessage`（视图层只管点）；放坞的 hook 里会让目标自动轮 / 命令驱动轮绕过引用快照。失败不发送 |
| `src-ui/src/plugins/builtin/paper-shell/paper-composer.css` | 夹签轨样式 + 全部动效 keyframes | 动效统一在此 |
| `src-ui/src/plugins/builtin/paper-shell/`（新增长按拖拽件） | 长按计时、浮层、卷命中检测 | 可复用现有拖拽的命中逻辑 |

### 7.1 构建与门禁

- `compose-dock` / `paper-shell` 是**内置产物** → 改完必须 `npm run build:builtin-plugins`
- `input-store` 是内核 → 产物若要读，走既有宿主面（faceDeps），**不要新增裸 import**
- 门禁：`cd src-ui && npx vitest run` + `npm run build` + `npx biome ci .`（0/0）
- **不碰 `agent/**` 与 `composition/**`** → 不需要 `verify:convergence`
- 若最终动了宿主面（faceDeps），按 `docs/plugins/README.md` 的封蜡流程走

---

## 8. 边界与失败态

| 情形 | 行为 | 用户看到 |
|---|---|---|
| 无卷无纸（`liveOwner=''`） | 引用按钮禁用 | tooltip「先展开一卷或落一张纸」 |
| 同一卡重复引用 | 不新增 | 槽内那枚闪一下 + toast「已在夹签槽里」 |
| 来源卡已被删 | 允许留在槽里 | 缩略纸标「来源已删」；发送时降级 |
| 跨卷引用且取不到 payload | 发送时降级 | 摘要写「未落快照」 |
| 快照写盘失败（盘满/权限） | **不发送** | toast 具体错误 + 槽保留 |
| 长按拖拽中途 Esc | 取消，飞回原位 | — |
| 拖到卷外空白 | 飞回原位 | — |
| 应用重启 | 夹签槽内容丢失（草稿不落盘） | 可接受，见 §12 |
| 发送失败（模型报错） | 槽保留 | 用户可重发 |

---

## 9. 测试与验收

### 9.1 单测

- `card-quote.test.ts`（新）
  - `renderQuoteBlock` 模板**逐字**对拍（含降级文案）
  - `newRefId` 唯一性与格式
  - 多卡渲染：空行分隔、无编号
- `input-store` 相关
  - `attachedCards` 增删去重
  - `snapshotDraft` / `claimLive` 往返后夹签**不丢**（最容易漏的一条）
  - `clearSessionDraft` 连带清理

### 9.2 组件测试

- 夹签轨渲染（空 / 一枚 / 多枚 / 超长标题省略）
- `canSend`：只有夹签也能发
- 发送拼装顺序：正文 → 分隔行 → 夹签块

### 9.3 动效验收

```
npm run motion:film
```

出帧图，逐帧检查：

- [ ] 点引用：卡本体可见且不位移；夹签起点在卡、终点在槽
- [ ] 长按：进度环可见；卷描线在 180ms 内浮现
- [ ] 松手落空：夹签确实飞回原位（不是淡出）
- [ ] 撕掉：槽收拢，不留空洞

### 9.4 真机验收清单

1. 会话卡点引用 → 夹签出现 → 发送 → 助手消息里能看到它读到了摘要
2. 问助手「这张卡的原文在哪」→ 它能 `fs` 读到 refs 文件
3. 让助手改这张卡 → 它用 `update_asset` 改本体，**夹签不复活**
4. 长按卡 → 拖到另一卷 → 切过去 → 夹签在那里
5. **引用后原卡仍在画布原位**（最重要的回归点）
6. 开系统「减少动效」→ 全部降级为原地淡入淡出

---

## 10. 分期

| 期 | 内容 | 完成判据 |
|---|---|---|
| **P0** | 点引用 + 夹签槽 + 发送落快照 + 固定摘要 + 撕掉 + 去重 | 9.4 的 1 / 2 / 3 / 5 通过 |
| **P1** | 长按拖拽改归属 + 全套动效 + 降级 | 9.3 全绿 + 9.4 的 4 / 6 通过 |
| **P2**（可选） | 「含我的填写」勾选（引用 state）、消息级引用 chip、refs 清理策略 | 用户明确要才做 |

**P1 必须等 P0 真机跑通**——动效建在不稳的地基上会白做。

---

## 11. 不做的事（明确排除）

- ❌ 不给模型加任何卡片库工具（读 / 写 / 列）——引用是**用户授权的一次窄口**，不是新通道
- ❌ 不做「引用后原卡收起」——违反拓印原则
- ❌ 不改消息模型（P0/P1 都用文本摘要，不加 part 类型）
- ❌ 不做跨卷批量引用
- ❌ 不把卡片渲染成图片再引用（那会丢数据面）

---

## 12. 已知债务（写进交付说明）

1. **夹签槽不持久化**：应用重启丢失（与现有草稿同命）。refs 文件在盘上，但槽不记得它们。
2. **`refs/` 无清理**：只增不减。P2 补（卷删除时清理该卷 refs，或 >90 天清理）。
3. **跨卷引用降级是常态**：取决于源卷是否还在内存。如实降级，不假装成功。
4. **无消息级元数据**：回看时只能从正文文本看出引了什么，没有 chip。

---

## 附：给施工者的三条提醒

1. **先跑一遍现状测试**（`npx vitest run`）拿到基线绿，再动刀。
2. **`compose-dock` 与 `paper-shell` 都是产物**——改完记得 `build:builtin-plugins`，否则真机看不到变化。
3. **动手前 grep `attachedImages` 的全部使用点**，照着同一套模式加 `attachedCards`，不要发明新写法。
