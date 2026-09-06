# 科研渲染（scientific-rendering）计划

> 状态：**In progress：4A 正文 LaTeX 完成且真机验收通过（2026-09-07 用户实机确认效果良好）；4B 引用卡施工完成（2026-09）待真机验收（§7 项 3-5）**
> 一句话：按「科研 Agent 渲染 20 种清单」倒查兰台现状，确立**双通道决策模型**（正文 markdown 通道 / 产物资产通道），前置治理渲染↔测量人肉镜像债，首期并行落地 **正文 LaTeX 数学** 与 **引用卡资产 kind** 两条通道样板。
> 决策记录：2026-09 用户拍板——文档范围=完整立项；镜像策略=**优先重构收口镜像**（不是"先上新渲染再补债"）；首期=**数学（markdown 通道）+ 引用卡（资产通道）两项并行**；D1=**不保守（行内 `$...$` 直接上）**；D2=**KaTeX 进场**。**4B 回卷（2026-09）：引用卡链接打开不在本回合考虑**——DOI/PMID/arXiv 以 mono 纯文本标识呈现，等 opener RPC 机制落地再链接化。
> 施工史：2026-09-06 4A 落地——markdown.ts 数学单一解析（块级 `$$` fence 流式容忍 + 行内 `$...$` 界约束不误伤货币/变量/转义）+ renderer-service KaTeX renderToString（.pp-md-math 块级 / .pp-md-math-inline 行内原子，throwOnError:false 错误可见不崩块）+ type-tokens 数学版式 token + measure 静态预算（显式行数 × maxLines 封顶）+ **含公式 markdown 挂 RO**（needsObservedHeight 内容感知，三参向后兼容）+ KaTeX CSS 集中 main.ts 导入。新增 `tests/paper-math-rendering.test.ts` 17 用例（parse/render/measure 三侧对拍）。门禁：vitest 2627 passed · convergence 0 漂移 · biome 0/0 · build ✓（KaTeX 字体资产正确打包）。真机验收清单见 §7。**同日 §5 轮子策略定稿**——现有 9 kind 无一需换 wheel（chart 加 `interactive` 表现而非换）；选型核验表 + 进场路径 + 后续批次见 §5。**2026-09 4B 落地**——asset-kinds.ts 新增 kind `citation`（BibTeX 字段集 schema，atomic，表现 citation）+ components.tsx citation-card 表现原语（标题/作者/venue·年/标识行/<details> 折叠 BibTeX，空数据占位）+ type-tokens 引用卡版式 token（显式 px 行高——asset 组 token 注入带 px 后缀，行高不沿用 *Lh 系数键）+ PaperPanel.css 引用卡款 + measure 静态测高镜像（行高 × 折行数；BibTeX 默认折叠只计 summary 行，展开态 RO 实测兜底——citation 属资产族恒挂 RO）+ PaperPanel KIND_ZH/EN（引用/CITATION）+ asset-renderers 兼容壳。新增 `tests/citation-card.test.ts` 14 用例（kind 注册/render/measure/签名/RO）。门禁：vitest 2650 passed（4B 后全量）· convergence 0 漂移 · biome 0/0 · build ✓ · doc-sync 全对拍。

## 0. 为什么做 / 目标

**输入**：用户提供的「科研 Agent 会话渲染清单」20 种——基础 8（文本/富文本/结构/LaTeX/代码高亮/表格/图片/引用提示框）+ 科研增强 7（参考文献/化学式/数据预览/流程图/统计表/折叠/任务进度）+ 高级 5+（交互图表/分子结构/地理图/自定义 widget/嵌入文档媒体）。科研会话少一种都伤体验。

**目标**：兰台成为"真正懂科研"的渲染面——但**不靠往一套代码里堆 20 种渲染**，而是走双通道决策模型，让每类内容落在它该在的通道上，扩展成本最小、镜像风险最低。

## 0.1 二十种科研渲染 · 现状倒查（对拍表）

> 倒查基准：2026-09 代码现状（`paper/markdown.ts` 解析子集 · `renderer-service.tsx` 双通道 · `agent/asset-kinds.ts` kind 注册表 · `plugins/builtin/renderers/components.tsx` 表现原语 · `paper/fold.ts` 折叠 · `paper/type-tokens.ts` 版式真源）。
> 图例：✅ 已覆盖 · ⚠️ 半覆盖（有基础缺关键）· ❌ 硬缺口。
> 4A/4B 落地后计数：✅ 7 · ⚠️ 9 · ❌ 4（见 §0.1 小结）。

### 一、基础渲染（8 种，科研会话底线）

| # | 类型 | 状态 | 证据 / 缺口 |
|---|---|---|---|
| 1 | 普通文本段落 | ✅ | `MdBlock t:'p'` → `pp-md-p`（markdown.ts:35 / renderer-service.tsx:292） |
| 2 | Markdown 富文本（粗/斜/行内码/链接/删） | ✅ | `InlineRuns` 五标志位（renderer-service.tsx:251） |
| 3 | Markdown 结构（标题/列表/分隔线） | ⚠️ 有限 | h1-4（5/6 收 4）+ ul/ol + hr；列表仅一层嵌套（markdown.ts:335,256） |
| 4 | **LaTeX 数学** | ❌ | 解析无 `$`/`$$`/`\(\)` 分支，公式字面量进纸；无 KaTeX/MathJax 依赖。**4A 首期** |
| 5 | **代码块 + 语法高亮** | ⚠️ | 围栏码渲染 ✅（markdown.ts:314）；**lang 捕获但丢弃**，`<pre>` 纯 mono 无 token 着色；highlight.js ^11 依赖躺在 package.json **全仓零引用** |
| 6 | 表格 | ✅ | markdown GFM 表格 + 资产 grid 双通道 |
| 7 | **图片** | ⚠️ | 资产 media 表现 ✅（本地文件 base64 data URI，components.tsx:299）；**markdown `![]()` 语法缺失**——`[` 链接分支吞成 `!`+链接（markdown.ts:157） |
| 8 | **引用块 / 提示框** | ⚠️ | blockquote ✅（`pp-md-quote`）；**callout/警告箱 ❌**——notice kind 只承载会话事件（压缩等），非模型正文可产出 |

### 二、科研增强渲染（7 种，决定"是否真懂科研"）

| # | 类型 | 状态 | 证据 / 缺口 |
|---|---|---|---|
| 9 | **参考文献 / 引用卡片** | ✅ | kind `citation` + citation-card 表现原语已落地（2026-09，§4B/施工史）。DOI/PMID/arXiv 链接化暂缓（opener RPC 未立），以 mono 纯文本标识呈现 |
| 10 | **化学式 / 反应式** | ❌ | mhchem/SMILES/InChI 全无。后续批次（资产 kind） |
| 11 | **数据预览 / CSV / DataFrame** | ⚠️ | grid 资产 ✅、chart ✅；清单要的分页/大表虚拟滚动 ❌——grid 全量平铺，超长靠 CSS 截断（PRE_MAX_H cap，measure.ts:208），无分页 |
| 12 | **流程图 / 模型图** | ⚠️ | graph（分层）/tree（深列树）资产 ✅——但走**结构化 nodes/edges 直通 JSON**（components.tsx:369,485）；**mermaid 文本语法 ❌**（markdown 里是普通围栏码，无 mermaid 依赖） |
| 13 | 统计表 / 模型输出表 | ⚠️ 够用 | grid/GFM 表格能呈现回归表/metrics 表；无显著性/对齐统计语义，不构成阻塞 |
| 14 | 折叠块 / 长输出截断 | ✅ | fold.ts 自有机制（状态派生+用户覆盖，比静态 details 强）+ CSS cap 截断 + truncate.ts 提示 |
| 15 | **任务列表 / 进度** | ⚠️ 部分 | board/timeline 资产 ✅、task 原语 ✅（pending/in_progress/completed）、TaskBoard ✅；**markdown `- [ ]` checkbox ❌、进度条视觉 ❌** |

### 三、高级 / 可扩展（5+ 种，高阶价值）

| # | 类型 | 状态 | 证据 / 缺口 |
|---|---|---|---|
| 16 | **交互式图表** | ❌（有逃生舱） | chart 是静态自绘 SVG（bar/line/pie/scatter）；无 Plotly/ECharts；html kind 沙箱可现场发明（CSP connect-src 'none' 无网络） |
| 17 | 分子结构查看器 | ❌ | 无 |
| 18 | 地理空间图 / 地图 | ❌ | 无 |
| 19 | 自定义 Widget / 表单 | ⚠️ 部分 | confirm 卡 form 表现（表决：批准/修改/拒绝）✅（components.tsx:615）；无通用参数调节 widget 通道；html 沙箱可绕行 |
| 20 | **嵌入 PDF/Office/视频/网页** | ⚠️ 部分 | media 图片/视频 ✅（components.tsx:299）；**PDF/Office 只有文件壳引用无内嵌查看**（components.tsx:342 未知扩展名走文件行）；任意网页 iframe ❌（html 沙箱禁导航禁网络） |

### 对拍小结

- ✅ 已覆盖 7：文本、富文本、LaTeX（4A ✅）、表格、参考文献/引用卡（4B ✅）、折叠截断、（统计表半满足）
- ⚠️ 半覆盖 9：结构、代码高亮、图片、提示框、数据预览、流程图、任务列表、widget、嵌入
- ❌ 硬缺口 4：化学式、交互图表、分子查看器、地理图

**架构判断**：缺口大多不是渲染管线问题，是**科研 kind/presentation 目录**缺失。必须动 A 通道（测量镜像面）的只有正文内科学内容（LaTeX），其余全可落 B 资产通道零镜像风险。

**明确不做**（本计划范围外）：
- 不做 markdown 渲染器整体替换（react-markdown 黑盒无法镜像测量，2026-08-30 已判，见 `paper/markdown.ts` 头注）
- 不动数据管线（`chat-stream.ts` / `part-mutator.ts` / `message-model.ts` 冻结文件）
- 不做渲染层与测量层"合并成一份"的伪重构（画 DOM 与算高度语义不同，双消费是架构使然，合并不可能也不该）

## 1. 现状管线（改哪 / 不改哪）

兰台会话渲染是**双通道**，倒查必须分开看：

### 通道 A：markdown 正文（模型自由输出即渲染）

```
Agent 流式事件 → part-mutator 追加 → SourcedBlock(kind:'markdown')
→ BlockView → resolveRenderer('markdown') → MarkdownBody
```

- 单一解析真源：`paper/markdown.ts` `parseMarkdown` / `parseMarkdownIncremental`
- 两个消费者：`renderer-service.tsx` `renderMdBlock`（画 DOM）+ `measure.ts` `measureMarkdownBody`（canvas 算高）——**消费同一结构模型，不是各写解析**
- 解析子集（现状）：ATX h1-4 / 段落 / 一层嵌套列表 / 引用 / 围栏码（lang 捕获未消费）/ GFM 表格 / 分隔线 / 行内粗斜删、行内码、链接
- **缺口**：LaTeX 公式（`$`/`$$`）、markdown 图片 `![]()`、checkbox `- [ ]`、mermaid 围栏
- 版式数字单一真源：`paper/type-tokens.ts`（MD_TOKENS/CHROME_TOKENS → CSS `var(--pp-*)` 注入 + measure `*DERIVED` 派生；`paper-token-audit.test.ts` 钉无悬空 var）

### 通道 B：资产块（显式 `show_asset` 产出，协议 `docs/plans/agent-asset-blocks.md`）

```
show_asset(kind, presentation, payload) → BlockPart → SourcedBlock(asset 元数据)
→ BlockView → resolveAssetBlock(kind, presentation) → 表现原语组件
```

- kind 注册表：`agent/asset-kinds.ts`（table/chart/metric/file/deps_impact/html/confirm/board/timeline/citation 10 种，schema 校验）
- 表现原语：`plugins/builtin/renderers/components.tsx`（grid/chart/metric/media/graph/tree/html/form/board/timeline/citation 11 个，纯 CSS+SVG 自绘零依赖；插件通道后注册胜）
- **动态高安全网**：`measure.ts:744`——媒体图加载 / html 卡 iframe 上报 / 拟策反馈框三类"动态高"静态镜像结构性失明，走 **ResizeObserver 实测回写、实测优先于静态镜像**（未挂载窗口期用静态估算兜底）
- **资产通道加新 kind/presentation 不碰测量镜像**（新渲染器 + RO 实测即可）

### 「三处同步」澄清（为什么不会一改就崩）

| 层 | 性质 | 现状 |
|---|---|---|
| 解析逻辑 | **单一真源**（markdown.ts 一份） | 无镜像 |
| 渲染↔测量 | **双消费**（同一模型各一个 switch，case 语义本不同：画 vs 算高） | 加块类型两边各加 case，属必然非负担 |
| 版式数字 | **单一真源**（type-tokens.ts，CSS var + measure 派生） | 2026-08-30 已收口 + token-audit 钉死 |
| CSS `.pp-md-*` ↔ measure 几何 | **人肉镜像残留**（renderer-service.tsx:248 自注「改版式三处同步」） | 低频；paper-markdown / paper-visual-decisions 测试对拍兜底 |
| host 三处同步（host.ts / host.aliased / faceDeps） | 产物域依赖面 | tsc 对拍 + face-keys.test + plugin-face-bridge.test 双门禁；**本计划不新增宿主键即不碰** |

**结论**：心慌的机制根源（解析多处手抄）不存在；真正的债是「CSS 视觉 ↔ measure 几何」这对低频人肉镜像，由第 3 节治理。新渲染内容应优先落**不碰测量镜像的通道**。

## 2. 通道决策模型（科研类型 → 走哪条通道）

| 科研渲染类型 | 通道 | 理由 |
|---|---|---|
| 正文内联科学符号（LaTeX `$...$`/`$$`） | **A markdown 通道** | 模型自由输出即渲染；混在正文里必须进单一解析模型 |
| markdown 图片 `![]()` | **A markdown 通道** | 正文内嵌语法；注意 media 资产已是真路径 base64 预览的旁路 |
| 参考文献 / 引用卡片（BibTeX/DOI/PMID/arXiv） | **B 资产通道** | 独立产物对象，可被引用/更新；kind + 渲染器即够 |
| 化学式 / 反应式（mhchem/SMILES/InChI） | **B 资产通道** | 独立结构对象；渲染器可接 mhchem 或 SMILES 转 2D |
| 数据预览 / DataFrame / 大表 | **B 资产通道** | grid 已有；分页/虚拟滚动作为 grid 表现增强 |
| 流程图 / 模型图（mermaid/graphviz） | **决策点 D3** | graph/tree 资产已覆盖结构化直通 JSON；mermaid 文本语法若走 A 通道需动解析+渲染+测量；倾向 B 资产 kind 承载 mermaid 源码（模型围栏输出 → 建议转 show_asset 或资产 kind 直取） |
| 统计表 / 回归表 / metrics | **B 资产通道（grid/metric 已有）** | 半满足；统计语义（显著性等）可作表现增强 |
| 折叠块 / 长输出截断 | **已覆盖**（fold.ts 自有机制） | markdown `details` 语法不解析，但兰台折叠是状态驱动自有机制，更强 |
| 任务列表 checkbox / 进度 | **决策点 D4** | `- [ ]` 走 A 通道（小解析增量）；进度条走 B 资产 kind |
| 交互式图表（Plotly/ECharts） | **B 资产通道** | chart 资产静态 SVG 已有；交互版=新表现或依赖增强（html 沙箱逃生舱可绕行，但 CSP 禁网络） |
| 分子结构查看器 / 地理图 | **B 资产通道** | kind + 渲染器扩展 |
| 嵌入 PDF/Office/网页 | **B 资产通道（media 扩展）** | media 已覆盖图片/视频；PDF/Office 内嵌查看=media 表现增强 |

**架构判断**：兰台缺的不是渲染管线，是**科研 kind/presentation 目录**——双通道 + 插件通道 + 折叠 + RO 实测全部现成。真正要动 A 通道（测量镜像面）的只有**混进正文的科学内容**（LaTeX 是唯一首期必须走 A 的）。

## 3. 镜像治理前置（用户拍板：优先重构收口）

> 用户 2026-09 决策：**优先收口镜像债**，再谈上新渲染。范围收敛为可执行动作，不是伪重构。

**治理对象**：第 1 节表的第 4 行——CSS `.pp-md-*` 排版规则 ↔ measure 几何镜像的人肉对映。

**动作清单**：
1. **新增块类型的模板纪律**：任何 markdown 新块类型必须同时产出 parse/render/measure 三侧测试（paper-markdown.test 侧钉解析产物 + measure 侧钉测高记账 + 渲染用例钉 DOM 结构）——把"双消费一致性"从人肉自觉变成门禁。
2. **版式收口查漏**：新块版式数字一律进 `type-tokens.ts`（MD_TOKENS/CHROME/ASSET），CSS 用 var 引用、measure 用派生——零散写、零 CSS 内联数字；`paper-token-audit.test.ts` 自动覆盖新键。
3. **动态高走实测**：凡是渲染后高度不确定的新块（公式块首当其冲），静态镜像只做窗口期估算，挂载后走 `reportObservedBlockHeight` RO 实测回写（复用 measure.ts:744 机制，列为"第四类动态高"）。
4. **可选（评估成本后定）**：CSS↔measure 几何的类名契约收口或至少补审计测试；若成本高则本计划先以 1-3 为界，不强行合流。

**产出**：科研渲染的地基清单——任何新块类型都落在"单一解析 + 双消费 + token 版式 + RO 实测"四件套内。

## 4. 首期：两项并行（用户拍板）

### 4A 正文 LaTeX 数学（markdown 通道）

**已拍板（2026-09）**：D2=KaTeX 进场（不自绘）；D1=不保守——行内 `$...$` 直接支持，界约束两侧 CJK/空白/标点不歧义（`e=5$`、`$5和6$` 等字面保留）。

**改动面**：
- `paper/markdown.ts`：解析新增 **math 块类型**——块级 `$$...$$` 独立成块；行内 `$...$` 进 MdInline（界约束：开标记后、闭标记前不允许紧贴数字/中文/全角字符，防货币与普通 `$` 误伤）
- `renderer-service.tsx`：`renderMdBlock` 加 math case → KaTeX（依赖已拍板进场）渲染
- `measure.ts`：`measureMarkdownBody` 加 math case——**静态估算 + RO 实测回写**（第 3 节动作 3），不要求预先精确镜像
- `type-tokens.ts`：公式版式（字号/行距/上下距）进 MD_TOKENS/MD_DERIVED
- 流式容忍：未闭合 `$$` 按已闭合产出（对齐现有围栏容忍语义）

**新增测试**：parse（行内/块级/未闭合/歧义字面量/货币不误伤）+ render（DOM 结构）+ measure（测高记账，mock pretext 同 paper-markdown.test 样板）+ token 审计自动覆盖。

### 4B 引用卡 / 科研对象（资产通道）

> **✅ 已施工（2026-09）**：kind `citation` + citation-card 表现原语落地，见 §1 施工史。
> 工具零改动（show_asset / list_block_kinds 通吃注册表）；measure 零镜像负担
> （citation 属资产族恒挂 RO，静态镜像只服务未挂载窗口期）。

**改动面**（零测量镜像，RO 实测天然覆盖）：
- `agent/asset-kinds.ts`：新增 kind **`citation`**——schema 覆盖 BibTeX 字段集（title/authors/year/venue/doi/pmid/arxiv/url/bibtex）+ 验证链（协议 §2.7 带窗）；可再增 `chem`（SMILES/InChI）作为同批或后批
- 表现原语（components.tsx 或新插件产物）：**citation-card**——标题/作者/venue·年/标识行 + 展开 BibTeX 原文（`<details>` 原生折叠，无 JS 状态，历史卡与活卡同构只读）
- 工具面：show_asset / list_block_kinds 已通，**只加 kind + 渲染器**，工具零改动（如加 chem kind，list_block_kinds 自动带出 schema）

**回卷（2026-09）**：DOI/PMID/arXiv **链接化跳转不在本回合做**（用户：这会不想考虑浏览器问题）——
以 mono 纯文本标识行呈现；待 opener RPC 机制（跨层 http/https 白名单 + 系统浏览器）落地后再链接化。
引用卡测试落 `tests/citation-card.test.ts`（14 用例：kind 注册 + show_asset/list_block_kinds +
render 全字段/作者串形态/空占位/只读 + measure 行高镜像/占位高/RO/签名）。

**真机验收**（§7 项 3-5 待用户跑）

## 5. 轮子策略：换 vs 加 vs 补（2026-09 用户问询 + 选型核验）

> 用户问：现有 kind 是否需要换现成 wheel？结论：**不需要换**。判定通过时 9 个 kind 无一需要替换（4B 增 citation 后 10 kind 依旧成立——citation 是「补」的实例）——
> 换 = 体积 + 网页风重调 + 测高镜像重做，纯负收益。真缺口是「补」不是「换」。

### 5.1 判定标准：换 wheel 的三个正当理由

1. **功能自绘做不到 / 做起来极贵**（交互缩放、3D 结构、领域格式解析）
2. **性能不够**（几千行大表、大量数据点）
3. **是「领域格式解析」不是「渲染」**（SMILES→2D、BibTeX→结构化——解析该借库，渲染形态仍自绘）

**不成立的动机**：有轮子、别人都用、显得高级。现有实现是「纯 CSS/SVG 自绘 + 纸面墨色 token + 测高镜像 + 确定性布局」，换通用库会全丢。

### 5.2 现有 kind 判定表（逐项过；4B 增 citation 后 10 kind）

| kind / 表现 | 现状 | 判 | 理由 |
|---|---|---|---|
| metric / board / timeline | 纯 CSS 排版件 | **不换** | 是排版不是图表，轮子不如 CSS，纸面风格是它的一部分 |
| file / media | base64 本地预览 | **不换** | 无 wheel 可换，走 Rust fs 能力口 |
| confirm / form | 审批表决卡 | **不换** | 产品语义（plan 审批泛化）——表决/回调/持久化是领域形状，轮子做不了 |
| html | 沙箱 iframe | **不换** | 已经是最强轮子（浏览器内核）+ 自包含沙箱，是独有资产 |
| deps_impact / graph / tree | 确定性 SVG 分层布局 | **不换** | **核心差异**——确定性布局 = 布局级测试可钉 + 流式刚体可保；通用图库力导向自布局会丢确定性，纯负收益 |
| table / grid | CSS 表格 | **暂不换** | 渲染 CSV/结果集够；真需求是「几千行大表」→ **加虚拟滚动层**，不是替换 grid |
| **chart** | 自绘 SVG 四件套 | **加表现，不换** | 唯一值得动的——协议支持同 kind 多表现（见 5.3） |
| **citation**（4B 新增） | 引用卡（纯 CSS 排版 + `<details>` 折叠） | **不换** | 是排版件，轮子不如 CSS（citation-js 的解析面留作可选补强——模型直交结构化字段已够）；DOI/arXiv 链接化待 opener RPC |

### 5.3 chart 的正确姿势：加 presentation，不动 kind

`agent-asset-blocks.md` 的 kind 语义 × presentation 表现**双维度正交**给免费能力——换表现不动 kind 契约 / payload / 历史块：

```
chart kind（payload {type, data, config} 不变）
  ├─ presentation: 'chart'        → 现自绘静态 SVG（默认，纸面风格零依赖，保持）
  └─ presentation: 'interactive'  → ECharts（新增：tooltip/缩放/图例交互）
```

Agent 想要交互图用 `show_asset(kind:'chart', presentation:'interactive')`，否则落默认静态。静态 SVG 不受打扰、历史块不重渲；ECharts 只在该表现里按需 import。

### 5.4 选型核验表（2026-09 联网核验，落项前再查维护状态/体积）

| 科研类型 | 轮子 | 通道 | 核验结论 |
|---|---|---|---|
| #5 代码高亮 | **highlight.js**（已在依赖，零引用） | A markdown（code 块补 token 层） | 轻量/易设/离线 ✓（[PkgPulse 对比](https://www.pkgpulse.com/guides/shiki-vs-prismjs-vs-highlightjs-syntax-highlighting-2026)）；Shiki 更准但要 WASM 偏重（[mdBook 讨论](https://github.com/rust-lang/mdBook/issues/2467)）——**接 hljs 先满足，Shiki 留档** |
| #9 引用卡 | **citation-js**（解析/转换） | B 资产 kind | BibTeX/DOI → CSL-JSON → 各格式，浏览器/sever 均可（[Citation.js](https://citation.js.org/) / [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC7924481/)）；**解析借它，卡形态仍自绘** |
| #10 化学式 | **smiles-drawer**（SMILES→2D） | B 资产 kind | 小/高性能/MIT（[smilesDrawer](https://github.com/reymond-group/smilesDrawer)）；Kekule.js 老牌但重（[ResearchGate](https://www.researchgate.net/publication/303707990_Kekulejs_An_Open_Source_JavaScript_Chemoinformatics_Toolkit)）——**smiles-drawer 优先** |
| #12 流程图 | **mermaid**（文本→图） | B 资产 kind（D3） | 活跃、文本定义正对模型输出（[mermaid](https://github.com/mermaid-js/mermaid)） |
| #16 交互图表 | **ECharts**（echarts-for-react） | B chart 加表现（5.3） | 开箱功能多（[对比](https://www.reddit.com/r/vuejs/comments/1mjaix1/chart_library_chartjs_or_apache_echarts/)），模块化按需 import 压体积（[echarts-for-react](https://www.npmjs.com/package/echarts-for-react)）；静态够用就不上 |
| #11 大表 | **TanStack 虚拟化** | B grid 增强 | 处理大表滚动（[SO](https://stackoverflow.com/questions/78443179/how-to-improve-scroll-performance-of-react-tanstack-table-with-virtualization)）；先量化需求再动 |
| #17 分子 3D | **3Dmol.js / Mol*** | B kind | 重资产（WebGL 大包）；Mol* 最全但大（[指南](https://www.linkedin.com/pulse/web-3d-molecular-viewers-short-guide-joshua-reuben-2am7f)）——**后置** |
| #18 地理图 | **Leaflet / MapLibre** | B kind | 都要瓦片源；兰台 html 沙箱禁网络 → 特殊处理——**后置** |

### 5.5 进场路径（两个渲染域都能用轮子，不用手写）

| 渲染域 | 代表 | 第三方依赖怎么进 | 证据 |
|---|---|---|---|
| 内核渲染器（bundle 域） | renderer-service.tsx | vite 直接 import，打包进应用 | KaTeX 已如此进场（4A） |
| 资产渲染器（esbuild 产物域） | plugins/builtin/renderers/ | esbuild `bundle:true` npm 依赖**自动内联** | react-bridge.cjs 注释（@react-aria 先例）+ 构建脚本自包含校验只禁静态裸 import |

约束三条：走 A 通道的轮子高度不可测要 RO；插件产物自包含（依赖内联 OK）但 html 沙箱禁网络；轮子网页风要包墨色 token 协调（4A 给 KaTeX 的做法）。

### 5.6 后续批次（挂起，按需立——每项开工前重查维护状态/体积）

- #9 引用卡（kind `citation`）——**✅ 2026-09 已落地**（解析未借 citation-js——本期模型直接交付结构化字段；DOI/PMID/arXiv 链接化待 opener RPC 机制）；剩余：链接化 + 可选 citation-js 兜底解析
- #10 化学式（kind `chem`）：SMILES→2D 借 smiles-drawer
- #16 交互图表：chart 加 `interactive` 表现（ECharts 按需 import），静态默认不动
- #11 大表虚拟滚动：grid 增强表现（先量化真需求）
- #5 代码高亮：markdown code 块补 hljs token 层（A 通道，测高镜像同 4A 纪律）
- #20 嵌入 PDF/Office：media 表现增强
- #17/18 分子 3D / 地理图：后置（重资产 + 网络约束）

## 6. 验证门禁（不过不交付）

- `cd src-ui && npx vitest run`（新增 parse/render/measure 对拍测试 + kind 校验测试）
- `cd src-ui && npm run build`（tsc --noEmit + vite）
- `cd src-ui && npx biome ci .`（0/0）
- `cd src-ui && npm run verify:convergence`（renderer-service / 工具面属 composition 层，硬门禁）
- 新增测试按用户操作序列写，不写实现形状（仓库纪律）

## 7. 真机验收清单（用户跑）

4A（数学）相关项用户 2026-09-07 实机确认通过：

1. ✅ 科研回答流式输出含 `$$...$$` 公式：渲染为排版公式，流式半程不破版、finalised 后不闪（**2026-09-07 实机确认**）
2. ✅ 行内 `$...$`（如 $E=mc^2$）在中文正文混排正常、不误伤货币/普通 `$`（**2026-09-07 实机确认**）
3. Agent 调 show_asset 出引用卡：标题/作者/venue·年/标识行整齐、BibTeX 可折叠展开、历史卡只读不崩（DOI/arXiv **可点开暂缓**——本回合不做浏览器跳转，标识为 mono 文本）（**4B 后验**）
4. 公式块/引用卡钉住（pinned）+ 折叠态下行为正常、无叠字空跳（公式部分随 4A 已过；引用卡部分 **4B 后验**）
5. 旧卷回放（历史会话含科研内容）过新管线渲染正常（含公式卷已验；引用卡卷 **4B 后验**）

## 8. 风险与决策点

- **D1（已拍板 2026-09）**：行内公式分隔符歧义策略——**不保守**：`$...$` 直接支持，界约束（开标记后/闭标记前不紧贴数字/中文/全角标点）防货币与普通 `$` 误伤；真机验收项 2 兜底验证。
- **D2（已拍板 2026-09）**：公式渲染引擎——**KaTeX 进场**（行业标准、可静态估高、离线可打包；用户拍板不自绘）。
- **D3**：mermaid/graphviz 文本流程图走 A 通道（动解析）还是 B 资产 kind（推荐，模型围栏输出经 show_asset 直取）——待真机看模型产出习惯再定。
- **D4**：任务列表 checkbox——A 通道小解析增量（`- [ ]` → task 块）vs 保持 B 通道 board/task 语义。倾向 A 但排后批。
- **风险 1**：公式块高度估算误差 → RO 实测回写兜底（第 3 节动作 3），未挂载窗口期宁可略高不叠字。
- **风险 2**：KaTeX 与纸壳视觉（宋体墨色/楷书圈点）冲突 → 公式墨色走 token、字体栈与正文协调，钉值进 paper-visual-decisions。
- **风险 3**：markdown.ts 是冻结文件 `ui/` 域外的 paper 核心，动解析须跑全量 paper 域测试（现 23 无头用例 + 渲染用例全绿为基线）。

## 9. 谁判断

| 项 | 谁判断 |
|---|---|
| 镜像治理范围（第 3 节动作 1-3 vs 4） | Agent 建议 + 用户拍板动作 4 取舍 |
| wheel 选型（§5 表——每项开工前重查维护/体积） | Agent 调研 + 用户拍板进场（4A KaTeX 先例） |
| 依赖进场（KaTeX 等，D2） | 用户（**已拍板：KaTeX 进场**） |
| D1/D3/D4 策略 | 用户（D1 **已拍板：不保守，行内 `$...$` 直接上**；D3/D4 真机反馈驱动） |
| 施工与门禁 | Agent |
| 真机验收 | 用户 |
