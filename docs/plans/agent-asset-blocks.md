# Agent 资产块（block as asset）— Agent 生成块的协议与通道

> 状态：**WO-1..8 竣工 + 渲染跟上批（2026-09-06）落地**——本批五项：confirm 真实回调面
> （WO-7 欠账清偿）/ deps_impact 空数据占位 / board+timeline 两表现原语（§2.9 补齐）/
> graph 分层布局（A5 二期兑现）/ 产物通道装配断层对账（装载失败可见性）。
> 性质：纸壳块协议（「一张纸」§3.2）的闭环设计——补上「Agent → 块」这条缺失通路：
> Agent 随时生成**可被引用/更新的资产块**（一块 = 一个组件实例），语义与表现双维度正交，
> 渲染层插件化承接。
> 先例对标：参考 HanaAgent（openhanako）的 show_card 交互卡片通道【对照先例 §8】；
> 既有资产对齐：第五贡献通道 ctx.renderers（renderer-service.tsx V3b）、part-mutator
> ponytail 语义（ToolProgress/ToolResult）、plan 卡 _callback 重绑先例、translate 增量转译缓存、
> PaperPanel 孤儿钉处理（unpinLabel==='删除'）。
> 范围：**协议 + 通道 + 首发渲染器 + 沙箱逃生舱**；宽泛事项见「非目标」§6。

## 拍板记录（全量，2026 设计会话逐项裁决）

| # | 设计题 | 裁决 |
|---|---|---|
| Q1 | 资产要不要身份（被 Agent 后续引用/更新） | **要**——assetId 进协议，show_asset / update_asset 两原语（§2.5） |
| Q2 | payload 流式吗 | **按 kind 契约声明**——协议统一 append/replace 两段式（§2.4），streamable: 'append'/'atomic' |
| Q3 | 未知 kind 的处理 | **工具层硬报错 + 报错带窗**（错误信息含可用清单摘要）——绝不「只关门不开窗」；渲染层另有兜底不崩（§2.7） |
| Q4 | 到底有多少种块 | **不是数字而是结构**——判据 + 7 族 + 逃生舱，且语义/表现**双维度正交**（§2.1/§2.8） |
| A1 | presentation 放权的形状 | **受控白名单**——kind 声明可用表现列表，Agent 只能在白名单里选；选错报错带窗（§2.6） |
| A2 | html/svg 卡的权限门 | **默认放行**（沙箱三要素够硬）；能力面可裁剪（capability 通道 Ask/Deny）；联网口挂同一面（§2.12） |
| A3 | html 卡在流里的高度 | **flow 限高 1000px 可滚动；pinned 不限**（纸上的纸，用户自己摆）（§2.12） |
| A4 | update_asset 能否换 kind | **可换 presentation（换皮肤），不可换 kind（换语义）**——kind 变了就开新资产（§2.5） |
| A5 | graph 的形态 | **轻量自绘 SVG**——tree 布局首发（影响面树直通，trace_impact 输出自带层级）、layered 确定性布局二期；**力导向不做**；不做重交互（§2.10） |
| A6 | 文本内引用资产 | **v1 不做**；会话级资产表为其埋查找面种子（§2.5/A7） |
| A7 | pinned 孤儿资产 × update | **会话级资产表**：assetId 索引 + 更新广播，流内块与 pinned 孤儿一并刷新（§2.5） |
| — | 3D 场景 | **走 html 逃生舱，不做罐头**——scene 罐头判死（§2.12） |
| — | 地图 | **v1 不做**；沙箱留 network capability 口子（never/ask/allow，v1 全 never，权限引擎挂载留待后用）（§2.12） |
| — | 表现层放权 | **放**——「做一个东西给你看」由 Agent 随时选择表现形态（§2.6） |

## 实施进度

| 阶段 | 状态 | 关键产物 |
|---|---|---|
| 设计定稿 + 拍板 | ✅ | 本文件（14 项裁决全齐） |
| WO-1 协议与类型 | ✅ | BlockPart（ui/message-model.ts）+ Asset/AssetDelta 事件（agent/agent-types.ts）+ part-mutator 路由 + findBlockPart；tests/asset-blocks.test.ts（8 用例） |
| WO-2 工具三件套 | ✅ | agent/asset-kinds.ts（7 内置 kind + 校验带窗）+ agent/asset-store.ts（会话资产表最小版）+ agent/tools/show-asset.ts（三工具）+ executor 资产通道 + hugram/asset-domain 插件装配；tests/asset-tools.test.ts（16 用例）；**baseline 变更已获批并 record**（BCR 追加于 docs/archive/agent-core-convergence） |
| WO-3 | ✅ | paper/block-model.ts（开放 union + BlockAssetMeta + payload 松绑）+ paper/translate.ts（BlockPart→1 块映射，含 subagent 拍平）+ measure.ts 兜底；tests/asset-translate.test.ts（7 用例） |
| WO-4 | ✅ | renderer-service.tsx 内置 `*` 兜底 JsonBody（漂亮 JSON）+ PaperPanel 文类签 + .pp-json CSS；tests/asset-render.test.ts（4 用例） |
| WO-5 | ✅ | state/asset-store.ts（会话资产表 + 可从消息重建）+ canvas-store PinSnapshot.asset + refreshPinnedAssetSnapshots + part-mutator 原位更新 + chat-stream Asset 广播 + 生命周期接线；tests/asset-broadcast.test.ts（9 用例） |
| WO-6 | ✅ | asset-renderers.tsx（grid/chart/metric/media/graph/tree/html/form 纯 CSS+SVG 表现原语）+ resolveAssetBlock + PaperPanel 接入；tests/asset-primitives.test.ts（12 用例） |
| WO-7 | ✅ | 会话快照新增 uiMessages（含 BlockPart）+ rebuildMessagesFromMessages 保留资产块 + 资产表重建；tests/asset-persistence.test.ts（2 用例） |
| WO-8 | ✅ | HtmlBody 沙箱 iframe + buildHtmlCardDocument（sandbox + 文档 CSP，network never）+ 高度上报 + 512KB 上限 + spike 结论落档；tests/asset-primitives.test.ts 含 html 沙箱断言 |
| 渲染跟上批（2026-09-06） | ✅ | ①confirm 真实回调面：executor 执行前预发卡（onResponse 随 Asset 事件进 BlockPart._confirmCallback）+ confirm-registry 阻塞决议（5 分钟超时，无 UI 通道立即 no_ui）+ FormBody 三钮交互（复用拟策卡钤印语言）+ 决议终态 confirmResolution 持久化（重载只读态）；tests/asset-confirm.test.ts（8 用例）②deps_impact 查询式/空数据 → 「数据不可用」占位（不再空白 SVG）；③board/timeline 两表现原语 + kind + CSS + measure 镜像 + 文类签；④graph 表现换确定性分层布局（tree 保留树布局）+ measure 镜像；⑤plugins/loader.ts 装配断层对账（第一方 feature 清单逐名对账，缺记录 → error 记录 + console.error——boot 审计只见 fiber，从未装载的产物原是盲区） |

---

## 1. 问题陈述

现在 Agent 在会话里能留下的「物」只有三类 part（reasoning / text / tool，part-mutator
只处理这几种；plan 是旁路卡片）。Agent 无法产出**有身份、可更新、形态独立**的产物——
图表、表格、指标卡、图谱视图、图片、看板、时间轴……全部只能挤在 markdown 文本或工具行里。
纸壳的「钉住/拖出/引用」威力只对「散装文本」生效，对「产物」不存在。

设计文档（「一张纸」§3.2 块协议）早已钦定方向：**Agent 输出语义声明，宿主渲染任意形态**
——逻辑/表现分离，同一份语义可以画成 diff 卡片、乒乓球、力导向小图或纯文本。渲染层的一
半已经落地（ctx.renderers 第五通道 + 8 个内置渲染器 + '*' 兜底），缺的是上游：**系统化的
「Agent → 块」通路 + 资产管理语义 + 表现选择权的协议化**。

## 2. 设计

### 2.1 双维度总览：语义 kind 与表现 presentation 正交

「一种块 = 一个组件」是一维清单，会随想象力无限膨胀。拆成两个正交维度后，两端各自收敛：

~~~
语义维度（kind）：数据意味着什么 —— 无限（Agent 面对的是这个）
   财务周报 / 依赖影响面 / todo 看板 / 项目燃尽图 / …
   每种 kind = 一行注册：{ schema, presentations[], defaultPresentation }
表现维度（presentation）：怎么画 —— 有限（≈13 个表现原语，可插拔可换）
   text / code / diff / grid / board / tree / timeline / chart / metric /
   form / graph / media / html  →  各一个通用组件 + payload schema
~~~

- **表现原语**是一次写好的通用组件（tree 画任何树、chart 画任何数据序列、board 画任何
  列卡结构）——有限集，一次性施工
- **语义 kind** 是薄绑定：'file_tree' = {schema, presentations: ['tree'], default: 'tree'}、
  'deps_impact' = {schema, presentations: ['graph','tree','table']}——**一行注册 =
  一种资产**，不需要新组件
- 你的想象力从此直接变成注册表条目：想到「燃尽图」就是 {kind:'burndown', presentation:'chart', payload}
  一行，且自动进 Agent 的发现通道

数据流：

~~~
Agent 调 show_asset{kind, presentation?, title?, payload?, stream?}
  → 工具结果 details = {assetId, kind, presentation, payload}
  → AgentEvent.Asset（append 型另见 AssetDelta）→ part-mutator 建 BlockPart
  → translate.ts 映射成块（活引用 source.part = part，id 稳定 pb:{msg}:{i}）
  → PaperPanel BlockView → resolve(kind, presentation) → 原语组件渲染
  → 更新（update_asset）→ 资产表替换 + 广播 → 流内块与 pinned 孤儿同刷（§2.5）
~~~

### 2.2 消息模型：BlockPart（AssistantPart 联合新增一员）

~~~ts
// ui/message-model.ts
export interface BlockPart {
  type: 'block';
  /** 资产身份——Agent 后续引用/更新的唯一键（会话内唯一） */
  assetId: string;
  /** 资产 kind（语义）——kind 注册表的键，update 不可变更 */
  kind: string;
  /** 表现形态（presentation）——kind 白名单内的表现原语名；可随 update 更换（换皮肤） */
  presentation: string;
  /** 面向用户的标题（文类签展示语义，可空） */
  title?: string;
  /** 资产 payload——纯 JSON；流式累计时是部分 payload */
  payload: unknown;
  /** 流式最终化标记（对齐 TextPart.finalised 语义） */
  finalised: boolean;
}
~~~

纪律：
- **payload 必须纯 JSON**（可持久化）。回调一律不进 payload——PlanPart._callback 先例：
  会话日志存数据，加载时按 assetId 重绑（施工单 WO-7）。
- assetId 在部分内不变（update 只换 payload/presentation/finalised，不换 assetId、
  不换 part 位置、不换 kind）。
- 渲染层对 BlockPart 的判别：kind ∈ 注册表 → 组件渲染；未命中（历史/退化）→ 兜底
  JSON 视图；presentation 不在白名单（脏数据）→ 回落 kind 的 defaultPresentation。

### 2.3 Agent 事件：Asset / AssetDelta

~~~ts
// agent/agent-types.ts 新增
export enum EventKind { ..., Asset = 'asset', AssetDelta = 'asset_delta' }

export interface AssetEvent {
  kind: EventKind.Asset;
  asset: { assetId: string; kind: string; presentation: string; payload: unknown };
}
export interface AssetDeltaEvent {
  kind: EventKind.AssetDelta;
  asset: { assetId: string; kind: string; chunk: string };
}
~~~

- **Asset（终值，权威）**：一次性交付完整 payload（含 presentation）。原子型 kind 只有这个。
- **AssetDelta（增量，append 型）**：chunk 追加到已存在的 BlockPart.payload（字符串累加器
  语义——与 TextPart 追加同构；类型化增量（行/点）留扩展位，不预防性实现）。
- 产出方：show_asset 工具执行路径（onProgress 路由，见 WO-2）；update_asset 只走 Asset。

### 2.4 流式（Q2 裁决落地）

- 协议只有一套：**append（AssetDelta）/ replace（Asset 终值）两段式**——不做「全流式
  JSON 分片协议」，也不要求每 kind 都流式。对齐既有 ponytail 先例（ToolProgress 增量 /
  ToolResult 权威替换，part-mutator.ts 80-135 行）。
- 流式与否由 **kind 契约声明**：kindDef.streamable = 'append' | 'atomic'（缺省 atomic）。
- 渲染器的表现约束：finalised 之前只做廉价增量渲染（append 文本、表格行累积），
  finalise 之后才做昂贵布局（图表一次成型、度量重排）。
- 首发 append 型只有 table（行累积）与长文卡（预留）；chart/graph/metric/image/confirm/html 全 atomic。

### 2.5 资产身份、资产表与更新（Q1 + A4 + A7 裁决落地）

**assetId 生成**（对齐 openhanako show_card 的 'c_{ts}_{seq}_{rand}'）：

~~~ts
let seq = 0;
function nextAssetId(): string {
  return 'as_' + Date.now().toString(36) + '_' + (++seq).toString(36)
       + '_' + Math.random().toString(36).slice(2, 6);
}
~~~

**会话级资产表（A7）**：一张轻量索引 assetId → {kind, presentation, payload, ts}。
payload 随 show_asset 进会话 JSONL（持久化现成），资产表只是「按 assetId 定位记录」的
索引——**可从日志重建，不是第二真相**；块依然活引用（引用目标从「消息 part」扩展为
「资产记录」）。

- 路由：show_asset → 写资产表 + emit Asset 事件（part-mutator 建块）；
  update_asset → 替换资产记录 + 广播 assetId 变更信号 → 渲染层按 assetId 找到所有引用
  它的块（流内的 + **pinned 孤儿**——源 part 已被压缩清理的钉住块，PaperPanel 孤儿钉
  语义的同路人）一并刷新。块 id / 坐标 / 钉住状态全不动。
- 由此 pinned 孤儿成为资产的**长期驻留形态**：用户在纸上的钉 = 资产最自然的收藏夹。
- 种子价值：将来「文本引用资产」（A6 暂缓）的查找面（assetId → 块/坐标）已存在；
  「跨轮引用」（Agent 说「把我上周那张图更新一下」）的对话框也在这里。

**原语**（工具，defineTool + zod）：

| 工具 | 签名（草） | 语义 |
|---|---|---|
| show_asset | {kind, presentation?, title?, payload?, stream?} | 创建资产块；details 返回 assetId；stream:true 且 kind 为 append 型走 AssetDelta 流式 |
| update_asset | {assetId, presentation?, payload} | 原位置换 payload（presentation 可换=换皮肤；kind 不可换——换语义就开新资产，报错写明此规矩）；无此 assetId → 明确报错 |
| list_block_kinds | {} | kind 注册表全量：kind + payload JSON Schema + presentations 白名单 + default + streamable + 一行话描述（§2.7「窗」） |

**更新与钉住**：BlockPart 原位更新（part 索引不变）→ 消息对象引用变化 → 增量重转译
只重建该消息的块 → 块 id（pb:{msg}:{i}）稳定 → **pinned 位置按 id 续命**（translate.ts
pinnedPositions 机制，零改动红利）。用户随手拖出的任意坐标不受协议影响——坐标是纸壳的
事，update 只碰 payload，永远不碰 x/y。

### 2.6 表现层放权（A1 裁决落地）——受控白名单

- 'presentation' 是 Agent 可选的第二参数：**不放 = 用 kind 的 defaultPresentation；
  放 = 在 kind 白名单 presentations[] 里选一个**。
- 语义：同一个 'deps_impact'（payload = nodes/edges）可以画成 graph、tree 或 table——
  Agent 按「给你看什么」自选。这兑现了「一张纸」§3.2 的渲染自由。
- 校验：show_asset 执行时校验 kind ∈ 注册表 且 presentation ∈ kindDef.presentations；
  任一不满足 → 硬报错带窗（列出该 kind 可用表现列表；未注册 kind 列出全量 kind 摘要）。
- 换皮肤：update_asset 可带新 presentation（同白名单校验）——块 id 不变，表现层热换。

### 2.7 错误政策（Q3 裁决落地）——关门的每一处都带窗

两层分离，各司其职：

- **工具层（Agent 面对的错误）= 硬报错，且报错即导航**。show_asset / update_asset 对
  注册表校验 kind 与 presentation：未知 → throw，错误文本 = 「kind 'xyz' 未注册。当前
  可用：…（完整 schema 用 list_block_kinds 查询）」；presentation 越界 → 「kind 'xyz'
  支持的表现：graph/tree/table（default: graph）」。校验失败不是「静默降级」——Agent
  必须能自纠（换参数或先 list）。
- **渲染层（历史块/旧会话面对的降级）= 兜底不崩**。kind 未注册 → '*' 兜底渲染器升级为
  「漂亮 JSON」视图（结构化展示 payload + kind 文类签 + 一键展开原始语义——契约层 §3.2
  的「信息保真」义务）；presentation 脏数据 → 回落 defaultPresentation；文类签未知名
  回退 block.kind 字面（PaperPanel 现有 ?? block.kind 兜底，补样式即可）。
- **发现通道常驻**：list_block_kinds 返回**随注册表实时变化**的快照——插件新贡献的
  kind 立刻可见可生成，Agent 永远有「现在能生成什么、能画成什么样」的窗口。

### 2.8 判据与家族（Q4 裁决落地）——「说话用 markdown，交付用块」

**判据（决定「值不值得成为块」的唯一问题）**：块 = 名词（可被钉住、引用、更新的产物），
文本 = 动词（叙事与论证）。命中任一即值得：

1. 需要**身份**（Agent 后续引用/更新它）
2. 需要**被钉住/布局**（空间资产——纸的强项）
3. 需要**交互**（按钮/折叠/选择/审批）
4. 渲染形态与文本流**显著不同**
5. 是**产物**不是**过程**（过程 = 工具行已承接；工具输出不该批量升格成块）

**家族（7 族——语义归类，不是渲染器数量）**：

| 族 | 语义 | 现状（兰台） | 参照（openhanako） |
|---|---|---|---|
| ① 文本族 | 话语类 | markdown / reasoning / notice ✅ | text / thinking / mood |
| ② 代码族 | 过程产物 | diff / code / tool ✅ | tool_group / artifact |
| ③ 数据族 | 结构化数据渲染 | **缺失（最大缺口）** | interactive_card（表格/仪表盘） |
| ④ 媒体族 | 图片/视频/文件 | **缺失** | file / screenshot / media_generation |
| ⑤ 交互族 | 审批/确认/表单 | plan ✅ | cron_confirm / suggestion_card / settings_confirm |
| ⑥ 结构化族 | 流程/子代理/目录 | **缺失**（subagent 拍平） | subagent / workflow / interlude |
| ⑦ 关系族 | 图/影响面/依赖链 | **缺失（兰台差异化）** | 无对应（无图谱） |

**逃生舱** = 'html' 表现原语：Agent 现场发明任意视觉（含 3D、SVG、报表、微应用）的
出口，不占 kind 注册表名额（§2.12）。语义上它宣告「本块无语义契约，只有表现」——契约
层对它天然不成立，这是它该被收敛使用的原因，但它保证「开窗」永远存在。

### 2.9 表现原语（presentation 注册表——有限集，一次性施工）

> 交付状态（2026-09-06 渲染跟上批后）：grid/board/tree/timeline/chart/metric/form/graph/media/html
> **10 原语全部在仓**（text/code/diff 是内置文类块的自留地，不走资产通道）。
> timeline 的 streamable 原稿标 append，实装为 **atomic**——append 通道当前只对
> 字符串 payload 有意义（AssetDelta 字符串累加器），对象 payload 的行级增量留
> §7.4 扩展位，不为不存在的通道谎报契约。

| 原语 | 画什么 | payload 抽象 | streamable（实装） |
|---|---|---|---|
| text | 长文/散文 | {text} | append（内置文类，非资产原语） |
| code | 程序/配置块 | {lang, code} | append（同上） |
| diff | 增删行着色 | {lang?, text} | append（同上） |
| grid | 表格（二维数据） | {columns?, rows, caption?} | append |
| board | 看板（列+卡） | {columns: [{title, cards: [{label, body?, tone?}]}]} | atomic |
| tree | 文件树/任意嵌套 | {nodes, root?} | atomic |
| timeline | 时间轴/事件流 | {items: [{ts, title, body?}]} | atomic |
| chart | 柱/线/饼/散点 | {type, data, config?} | atomic |
| metric | 指标卡组 | {items: [{label, value, unit?, tone?}]} | atomic |
| form | 确认卡（选项+三钮） | {title, body, options?, confirmLabel?} | atomic |
| graph | 有向图/依赖链 | {nodes, edges} | atomic |
| media | 图片/视频/文件引用 | 会话文件引用 | atomic |
| html | 任意 HTML/SVG 片段（沙箱） | {code} | atomic |

> 初心纪律：chart/graph/tree/board/timeline 全部**纯 CSS+SVG 自绘，零新依赖**（纸壳
> 墨色体系可控、不拖 bundle、测试可钉死）。graph 不做力导向、不做重交互——「Agent 读了
> 顺便画出来」的场景里，好看易读即可；交互留给纸壳的钉住/拖出。
> graph/tree 双布局（2026-09-06 A5 二期兑现）：'tree' 表现 = 深度列树布局（首发形态）；
> 'graph' 表现 = 确定性分层布局（最长路径分层 + 表序排布，环防御 = 松弛轮数封顶）。
> 空数据（查询式 {nodeId, depth} 无直通数据 / 空 nodes）→ 「数据不可用」占位，
> 不画空白 SVG（错误不静默——chart 同款先例）。

### 2.10 首发 kind 绑定（注册表增量——v1 交付面 + 2026-09-06 增补）

| kind | schema（草） | presentations | default | streamable |
|---|---|---|---|---|
| table | {columns?: string[], rows: unknown[][], caption?} | [grid] | grid | append |
| chart | {type: 'bar'/'line'/'pie'/'scatter', data, config?} | [chart] | chart | atomic |
| metric | {items: [...], caption?} | [metric, grid] | metric | atomic |
| file | 会话文件引用（fileId/filePath/label/ext） | [media] | media | atomic |
| deps_impact | {nodeId, depth?} 或引擎 nodes/edges 直通 | [graph, tree, table] | graph | atomic |
| html | {code} | [html] | html | atomic |
| confirm | {title, body, options?, confirmLabel?} | [form] | form | atomic |
| board | {columns: [{title, cards: [{label, body?, tone?}]}]} | [board] | board | atomic |
| timeline | {items: [{ts, title, body?}]} | [timeline] | timeline | atomic |

> **confirm kind 阻塞语义（2026-09-06 起生效，plan 审批模式泛化的完整兑现）**：
> show_asset(kind=confirm) 由 executor **执行前预发卡**（终值事件常规通道从工具输出
> 解析，而 confirm 阻塞等决议——卡必须先于决议存在）；卡面带活回调
> （Asset 事件 onResponse → BlockPart._confirmCallback → block.asset._confirm），
> 用户表决（选项/确认/修改/拒绝）→ confirm-registry 决议送达等待中的工具 →
> **决议作为工具结果回传模型**。等待上限 5 分钟（plan 同款防死锁）；无 UI 通道
> （嵌套 dispatch / headless）立即 no_ui 放行，不空等。决议终态写
> BlockPart.confirmResolution（纯 JSON 随会话持久化——重载后「已处理」只读态）；
> 活回调本身不持久化（PlanPart._callback 先例，历史卡只读）。
>
> 增量纪律：新 kind 只靠两条路长——插件贡献（进 list_block_kinds 发现面）、首发清单
> 迭代（用户拍板）。不为「穷举所有场景」建目录（访谈 R1 结论：范式不靠穷举靠结构）。
> 游戏规则：**想 100 种就有 100 种，每个成本一行，全部自动可发现**。

### 2.11 渲染器注册表扩展（已落地通道的增量改动）

~~~ts
// composition/renderer-service.tsx
/** 表现原语注册：按 presentation 键的全局组件（任何 kind 的白名单都可引用） */
export interface RendererContribution {
  id: string;                     // '<源>/<presentation>'（如 'builtin/tree'、'plugin/x/heatmap'）
  presentation: string;
  component: ComponentType<BlockRendererProps>;
}

/** 语义 kind 注册：薄绑定——schema + 表现白名单 */
export interface AssetKindDef {
  id: string;
  description: string;              // list_block_kinds 展示 + prompt 引导
  schema: Record<string, unknown>;  // payload JSON Schema（draft-7，defineTool 同款）
  presentations: string[];
  defaultPresentation: string;
  streamable: 'append' | 'atomic';
}

/** 解析：kind → 白名单回落 → presentation → 组件；全无 → 兜底 JSON 视图 */
export function resolveAssetBlock(kind: string, presentation: string | undefined): ComponentType | undefined;
~~~

- 既有 8 种 builtin 块（markdown/reasoning/diff/tool/code/plan/notice/user）**概念上 =
  单表现 kind（presentation 恒等于 kind），实现上零迁移**——老 resolveRenderer(kind)
  路径原样保留，资产走新路径，两套并存互不干扰（零回归纪律）。
- 注册内核、后注册胜、'*' 兜底、同 id 内置胜——全部沿用 V3b 既有机制。
- 新增 list_block_kinds 的数据源：kind 表 + presentation 表快照读取面。

### 2.12 html 逃生舱与沙箱（A2/A3 + 3D + 地图裁决落地）

**html 表现原语** = 沙箱 iframe 渲染 Agent 提供的 HTML/SVG 片段（3D 场景、报表、任意
复杂视觉都走这里——scene 罐头判死，不设第二个 3D 通道）。

- **权限门（A2）**：默认放行——沙箱三要素（无网络 / 无父页 DOM 访问 / 禁导航禁表单）
  够硬；但 html 卡渲染器作为一个 capability 行进能力面，可被组合 patch 改 Ask/Deny。
- **载体（施工 spike 前置）**：openhanako 的教训是 srcdoc/blob 会继承渲染进程 CSP 导致
  内联脚本被静默阻断，必须真实 http origin——兰台是 Tauri webview，施工时先做 spike
  验证（自定义协议 / CSP 白名单 / webview 配置三选一），前提与结论记入 WO-8。
- **高度（A3）**：flow 限高 1000px 内滚动；pinned 不限（纸上的纸，用户自摆）。高度上报
  = postMessage 协议（对齐 Hanako card-resize，兰台命名）+ 宿主 load 后 ping 兜底。
- **主题**：注入兰台墨色 tokens（--ink/--paper/--accent/--pass/--fail 系）到 iframe
  :root 的 CSS 变量（采集方式 = 宿主 computed style，同 Hanako varsCss 思路）。
- **网络口（地图裁决）**：沙箱 capability 声明 network: 'never'/'ask'/'allow'，
  **v1 全 never**；ask/allow 通道与权限引擎（Allow/Deny/Ask）的挂接留待将来有真实需求
  （瓦片地图等）时单独立法。口子只留形状，不预实现。
- **体积上限**：code/payload ≤ 512KB（对齐先例），注册表与渲染器自重防滥用。

> **WO-8 spike 结论（2026-08-29 施工）**：兰台 `src-tauri/tauri.conf.json` 当前未配置
> 全局 CSP（WebView2 无 `script-src 'self'` 顶层约束），因此 v1 采用
> `iframe sandbox="allow-scripts"` + `srcDoc` + 文档内 `<meta CSP>`（
> `default-src 'none'` / `connect-src 'none'` / `form-action 'none'` / `base-uri 'none'`）
> 已满足无网络 / 无父页 DOM / 禁导航禁表单三要素。若未来给 Tauri 加全局 CSP，
> 必须切换到「真实 http origin / 自定义协议」路径（openhanako 教训），并把本文档
> 的结论同步更新。

## 3. 接缝施工单（按依赖序）

| # | 施工项 | 落点 | 判据（测试钉死） |
|---|---|---|---|
| WO-1 | 协议与类型：BlockPart + EventKind.Asset/AssetDelta + part-mutator 路由 | message-model.ts / agent-types.ts / part-mutator.ts | **✅ 已竣工**——判据全钉：tests/asset-blocks.test.ts（8 用例：终值建 part / 占位追加 / 终值替换翻转 / update 原位替换 / finalised 防御 / findBlockPart）；tsc + 相邻回归 28 用例全绿 |
| WO-2 | 工具三件套（show_asset / update_asset / list_block_kinds）+ kind/presentation 注册表校验 + onProgress→AssetDelta 路由 | agent/tools/show-asset.ts（新）+ streaming-executor 路由 | **✅ 已竣工**——tests/asset-tools.test.ts（16 用例：校验带窗 / update 语义 / 注册表实时性 / executor 事件序 ToolDispatch→AssetDelta→Asset→ToolResult）全绿；**baseline 已按流程获批（BCR 追加 + record 执行，tool-schemas 15→18/17→20）**；装配回归 82/82 + tsc + biome ci 全绿；生成物（model-tool-contract / event-catalog / plugin-loader 计数 44 / manifest 44）同步 |
| WO-3 | block-model 开放 kind + translate 映射 | block-model.ts（开放 union + payload 松绑）/ translate.ts | **✅ 已竣工**——映射 1:1；id 稳定；update 后重转译 id 不变；钉住续命；tests/asset-translate.test.ts（7 用例） |
| WO-4 | 兜底渲染器升级（漂亮 JSON） + PaperPanel 文类签 | renderer-service.tsx / PaperPanel.tsx + css | **✅ 已竣工**——未知 kind 显示 JSON 视图不崩；签不破版；tests/asset-render.test.ts（4 用例） |
| WO-5 | **会话级资产表（A7）**：assetId 索引 + update 广播 + pinned 孤儿刷新 | 会话 store / 持久化服务 / 纸壳消费面 | **✅ 已竣工**——更新流内块与孤儿钉同刷；坐标/钉住不变；资产表可从日志重建；tests/asset-broadcast.test.ts（9 用例） |
| WO-6 | 首发渲染器：grid → chart → metric → media → graph（SVG tree）→ html → form(confirm) | renderer-service.tsx + 组件（每原语一个） | **✅ 已竣工**——每原语渲染单测 + schema 生效；graph 树布局确定性强断言；tests/asset-primitives.test.ts（12 用例） |
| WO-7 | 持久化/回放 | 会话持久化服务 | **✅ 已竣工**——重启后资产块还原（StoredSession.uiMessages + rebuild 保留 BlockPart）；payload 纯 JSON 断言；tests/asset-persistence.test.ts（2 用例）；~~form 回调重绑留待 confirm 真实回调面~~（2026-09-06 渲染跟上批清偿——决议终态 confirmResolution 持久化 + 活回调瞬态，见渲染跟上批行） |
| WO-8 | html 沙箱卡（逃生舱）独立施工单 | 新渲染器 + 沙箱面 | **✅ 已竣工**——spike 结论落档；安全审计三要素 + 高度上报 + 限高/pinned 语义 + capability 行注册（HTML_CARD_CAPABILITY network: never） |
| 渲染跟上批（2026-09-06） | ①confirm 真实回调面 ②deps_impact 空数据占位 ③board/timeline 原语 ④graph 分层布局 ⑤产物通道装配断层对账 | agent/confirm-registry.ts（新）+ streaming-executor 预发卡 + show-asset confirm 分支 + part-mutator 回调挂接 + components.tsx（FormBody 交互化/GraphLayeredBody/BoardBody/TimelineBody/空数据占位）+ asset-kinds.ts（board/timeline）+ measure/type-tokens/PaperPanel.css/PaperPanel 文类签 + plugins/loader.ts 对账 | **✅ 已竣工**——tests/asset-confirm.test.ts（8 用例：注册表 no_ui/决议/幂等 + executor 预发卡事件序/决议回传 + part-mutator 挂接/回调存续/持久化契约）+ asset-primitives 增批（graph 分层几何断言/空数据占位/board/timeline/form 双态）；tsc 全绿 |

## 4. 铁律

- **payload 必须纯 JSON**——回调不持久化，加载按 assetId 重绑（plan 先例）。
- **渲染器只渲染块体**——壳件（签/手柄/钉住/占位）不进注册表（V3b 纪律延伸）。
- **update 不换 assetId、不换 part 位置、不换 kind**（presentation 可换）——块 id 稳定
  = 钉住续命的前提；kind 换了语义就开新资产。
- **工具层硬报错带窗、渲染层兜底不崩**——Agent 的错误永远可自纠，用户的界面永远不炸。
- **过程不进块**——工具行承接过程；块是产物级的东西。
- **新 kind 只有两条路**：插件贡献（进发现面）或首发清单迭代（用户拍板）——不预防性造目录。
- **语义与表现正交**——kind 只声明「数据意味着什么」，画法交给 presentation 白名单；
  Agent 放权但受控（白名单校验带窗）。
- **沙箱默认无网络**；任何联网能力 = capability 显式立法（v1 全 never）。

## 5. 与既有架构的关系

- ctx.renderers：通道已存在，本设计在其上加 presentation 原语注册面 + kind 薄绑定表；
  内置 8 种老路径零迁移。
- part-mutator / AgentEvent：加两个事件分支，不动既有分支（零回归面）。
- translate / 纸壳：零搜索改动——只加「BlockPart → 块」一条映射规则；钉住/坐标续命
  全部现成（增量转译 + pinnedPositions）。
- 组合层 roster：show_asset/update_asset/list_block_kinds 走既有插件工具行通道
  （plugin/<插件>/<域名>），可裁剪；html 卡 capability 行挂能力面。
- 图谱内化（ADR workspace-concept-ownership）：deps_impact kind 兑现「影响面图/依赖
  路径图作为 Agent 产出的块出现」——七族中的护城河，形态按 A5 轻量执行。

## 6. 非目标（本设计不做）

- **不做 Agent 自定义组件代码注入**——「Agent 写任意组件」≠「Agent 生成任意块」：
  前者是 dynamic-runner/code_execution 的领地（真开窗 = html 卡沙箱 + 插件贡献表现原语）。
- **不做 scene 罐头**——3D 一律走 html 逃生舱。
- **地图/联网瓦片 v1 不做**——network capability 只留形状（never/ask/allow）。
- **不做跨会话资产库**——资产会话作用域；跨会话引用是未来课题（纸的桌面上已可跨卷
  拖拽钉住，语义待另立）。
- **不做文件系统资产落盘**——资产 = 块本体 + 资产表（都在会话 JSONL 内），不是文件。
- **不做文本内引用资产（A6）**——资产表埋好查找面种子，等纸壳真实需求再立。
- **不为未知 kind 静默兜底对 Agent 隐藏**——渲染兜底 ≠ 工具层放行（§2.7 边界）。

## 7. 开放问题（实施期边做边定，不阻塞开工）

1. **html 沙箱载体 spike（WO-8 前置）**：Tauri webview 下 srcdoc/CSP 行为实验
   （openhanako 的「真实 http origin」教训为对照；三选一方案见 §2.12）——✅ 已结（WO-8 结论落档 §2.12）。
2. 高度上报协议细节（载荷形状、ping 周期）——施工自决，命名对齐兰台（lantai.*）——✅ 已结（lantai.card-resize / lantai.card-ping）。
3. 主题变量注入清单（--ink/--paper/--accent/--pass/--fail 全量枚举）——施工自决——✅ 已结（buildHtmlCardDocument 内置基础款：--f-song/--ink-1；全量注入待真实需求）。
4. 流式类型化增量（行/点级 append）——留扩展位，有真实需求再实现（timeline 实装 atomic 的原因即此——见 §2.9 注记）。
5. ~~graph layered 布局（二期）：确定性分层排布算法选型（Sugiyama 简化/分层环排）~~——✅ 已结（2026-09-06 渲染跟上批）：选型 = 最长路径分层（Sugiyama 去交叉前半段）+ 表序排布 + 松弛轮数封顶环防御；无交叉优化（A5 轻量裁决不变）。
6. 文本引用资产的交互形态（A6 解冻时）：scrollIntoView / 纸面聚焦 / 高亮。
7. ACP 宿主的 confirm 卡转发（session/update 协议扩展）——ACP 面当前不转发 Asset 事件，
   ACP 会话里的 confirm 走 5 分钟超时放行（与 plan 审批同款行为）；真实 ACP 需求出现再立。

## 8. 对照先例（openhanako，可读源码）

| 机制 | 参考文件 |
|---|---|
| show_card 工具（agent 生成卡片的协议形状） | lib/tools/show-card-tool.ts |
| 设计手册工具（发现/开窗通道——等价 list_block_kinds） | lib/tools/card-guide-tool.ts |
| 卡片 iframe 加载的真实 origin 论证 | desktop/src/react/components/chat/InteractiveCard.tsx（文件头注释） |
| 服务端卡片文档包壳 + 高度上报 | server/cards/card-document.ts |
| 卡片 CSP（default-src 'none' 系列） | server/routes/cards.ts |
| 占位替换语义（等价 update_asset + 资产表广播） | desktop/src/react/hooks/use-stream-buffer.ts resolveBlockByTaskId |

（对照仅为机制参考——兰台协议是自身的判据与结构产物，不移植其实现。）
