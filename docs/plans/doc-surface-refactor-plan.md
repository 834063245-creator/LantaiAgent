# 文档面大重构（打磨收尾）— 施工单

> 立项 2026-09-16（用户拍板根 README 对外定位 = 乙：桌面 Agent 工作台为主、引擎降配套）。
> 状态：**P0-P3 已落地**；P4 在推（P4a ADR/cookbook/research 三索引已落，余 docs/README 唯一入口重写）。
> 门禁：`cd src-ui && npm run doc-check`（非零即拦）；`npm run doc-check:report` 看全量漂移清单。
> 真源：`scripts/doc-facts.cjs`（事实导出）+ `scripts/doc-check.cjs`（六查）+ `scripts/doc-check-exemptions.json`（在册豁免账）。

## 0. 一句话

文档面缺的不是「整理」，而是代码面早就有的那两样东西：**单一权威源 + 门禁对拍**。
代码面有四条架构约定、convergence 快照、doc-sync 对拍；文档面的事实此前全是手抄 + 靠自觉，
于是出现「同一数字改了两处漏两处」（AgentConfig 28 已更正 AGENTS/CLAUDE，ARCHITECTURE×2 与
根 README 仍写 31）、「入口文档讲已退役的世界」（README 的领域工具清单含 graph/ops/lsp）。

## 1. 目标形态（读者 × 权威 × 生命周期 四层，每层一个硬规矩）

| 层 | 内容 | 硬规矩 |
|---|---|---|
| L0 注入层 | `CLAUDE.md`（唯一权威）+ `AGENTS.md` 薄指针 | 字节预算硬上限；长表格/里程碑/字段清单一律外移，只留硬约束 + 门禁命令 + 指针 |
| L1 规则层 | CONVENTIONS · INVARIANTS · adr-constitution · landmine-map | 每条事实只在这里写一次，别处只准指 |
| L2 现状层 | ARCHITECTURE · CONTEXT · docs/plugins · docs/composition · design 定稿 | 禁止复述机器可读数字——数字只准来自 L3 或写指针 |
| L3 生成层 | 六份生成物（工具契约 / service·event 目录 / 开放面指纹 / 引擎契约 / **facts**） | doc-sync 逐字节对拍 |
| L4 过程层 | `plans/`（只活在办项）→ `archive/`（竣工即移）· `research/`（证据冻结） | plans/ 挂竣工横幅 = 红 |

## 2. 完成判据（收尾成立 = 全绿）

1. `npm run doc-check` 无未豁免违规，**且豁免账归零**（永久豁免只留「不属于本项目文档面」的文件）。
2. L0 实测 ≤32KB/文件、合计 ≤64KB 预算的一半余量以上，且确实进上下文（本轮实测 AGENTS.md 已被丢弃）。
3. 断链 0 · 孤儿 0 · 索引单元格 ≤500 字符 · 单行 ≤1000 字符。
4. `plans/` 只剩在办项，竣工文档全在 `archive/`。
5. 全仓事实 100% 有真源（新增事实 = 在 `doc-facts.cjs` 加一行 + 在 `doc-check.cjs` 加一条断言）。
6. 一个没读过本项目历史的 Agent 能只靠 L0+L1+L2 接手。

## 3. 批序与判据

| 批 | 做什么 | 判据 |
|---|---|---|
| **P0 立尺** ✅ | facts 导出器（9 条事实）+ doc-check 六查 + 豁免账先绿 + doc-sync 登记 | `doc-sync` 与 `doc-check` 双绿；漂移清单可复现 |
| **P1 注入层** ✅ | CLAUDE+AGENTS 去重合一（AGENTS 变薄指针）、长表格外移、预算门禁上牙 | L0 合计 ≤32KB；`budget` 豁免条目删净 |
| **P2 现状层** ✅ | ARCHITECTURE / 根 README（乙定位）/ plans 索引 / docs 索引 按真源重写；数字改为指针 | `facts` 与 `links` 豁免条目删净 |
| **P3 归档大扫除** ✅ | 竣工文档 git mv → archive/，索引瘦身（单元格 ≤500），HISTORY 补时间轴 | `archive` 豁免删净；plans/ 只剩在办项 |
| **P3b 补批** ✅ | 「代码全竣工但头注没写横幅」的计划（archive 查的漏网件）11 件归档 + 引用同步 | 同上；`pretext-typography-plan` 留在办（P2a 待实机拍板） |
| **P4 索引重建** ✅ | docs/README 两轴唯一入口 + 三处目录索引（adr/cookbook/research） | `orphans` 豁免删净 → 孤儿 23 → **0**（P4a 落地） |

## 4. 首轮实测台账（P0 立尺当日，可 `npm run doc-check:report` 复现）

| 查 | 命中 | 性质 | 去向 |
|---|---|---|---|
| budget | 1 | L0 合计 74242 B > 65536 B 预算，AGENTS.md 已被 harness 丢弃 | P1 |
| facts | 6 | ARCHITECTURE 写 31 字段（真源 28）· 根 README 写 12 域（真源 11，含已退役 graph/ops/lsp）· plugins/README 写 29 产物（真源 30）· plans 索引写 14 内核（真源 13） | P2 / P3 |
| links | 1 | landmine-map 断链 `../design/...` | P2 |
| size | 52 | 单行 >1000（AGENTS 6 / taste-ledger 15 / 索引两页 18 …） | P1 / P2 / P3 |
| orphans | 23 | ADR 四篇 · cookbook 四篇 · 设计件两篇 · 计划正文七篇 …「有正文没入口」 | P2 / P3 / P4 |
| archive | 7 | 已竣工文档仍留在 `plans/`（CONVENTIONS §4 未执行） | P3 |

### 4.1 P1 落账（2026-09-16）

| 项 | 前 | 后 |
|---|---|---|
| `CLAUDE.md`（唯一权威 L0） | 24259 B / 最长行 4286 字符 | 15256 B / 最长行 796 字符 |
| `AGENTS.md` | 49489 B（**被 harness 整份丢弃**） | 3538 B（薄指针，强制加载 CLAUDE.md） |
| L0 合计 vs 64 KB 预算 | 74242 B ✗ | 18794 B ✓（留 71% 余量） |

- 独有内容去处（迁移完整性已抽检 14 个关键词全部有归宿）：规则类 → `CONVENTIONS.md` **§2.4 内核工具面与
  能力口**、**§2.5 多 Agent 并发纪律 + Plan 模式**、**§3 尾注（convergence 双轨 / NODE_ENV 两刀 / 测试运行纪律）**；
  现状类 → 指针（`ARCHITECTURE.md`）；`AGENTS.md` 原正文留在 git 史（`git log -- AGENTS.md`）。
- 顺手清掉两处**已退役事实**：`graph(preflight)` 作为内置 Agent 的开工入口（图谱内置接线 2026-09-09 退役）·
  定位段「把代码库变成可对话的 3D 依赖星图」。
- **P2 承接（P1 删除的清单块，由 P2 在现状层按真源重建）**：① 目录结构树（含 `.lantai/` 运行时目录）② 数据流视图
  （引擎 stdio MCP transport，旧图写的是已退役的 TCP 9777）③ 引擎能力与工具面 ④ 验证基线表（数字改为
  facts 指针或标注实测日期）。**未重建前这些清单的权威副本 = git 史**。

### 4.2 P2 落账（2026-09-16）

| 文件 | 前 | 后 | 关键动作 |
|---|---|---|---|
| `ARCHITECTURE.md`（L2） | 64.5 KB / 最长行 1232 | 49.7 KB / 最长行 170 | 按真源逐节校准（crate 布局 / 数据目录分居 / 能力口 10 / ResourceLedger 7 / Hooks 图谱类已删 / `ToolResponse` 四态 / 删三个互相矛盾的 RPC 方法数）；**§11 验证基线整表改指针**；重建 P1 删除的四处清单（目录树 → §9 五段 · 数据流 mermaid → §2.1 · 引擎与工具面 → 指针 · 基线 → 指针） |
| 根 `README.md`（用户门面） | 29.5 KB / 411 行 | 14.8 KB / 259 行 | **乙定位落地**：桌面 Agent 工作台为主叙事，引擎降为「随包配套的独立进程」一节；删 12 类陈旧主张（12 个领域工具含 graph/ops/lsp · 31 字段 · TCP 9777 架构图 · install.cmd 安装步 · `hologram` CLI 旧名 · 35/36 schema legacy 机制 · 约束治理小节 · 「先问图」工作流 · 手抄标量 27 语法/9 节点/24 框架/77 模型/153 RPC 方法…） |
| `CONTRIBUTING.md` | 手抄结构树 + 旧基线 | 顶层地图 + 指针 | 结构树改为指向 `ARCHITECTURE.md` §9；技术栈去 Three.js/worktree 旧述；测试基线行改指 `CONVENTIONS.md` §3；顺手校准「九条通道 / 1339 用例 / 134 RPC 方法 / 10 LifecycleService」四处手抄 |

- **事实更正**（子代理实测推翻我 P0/P1 简报里的两条，已在 L0 同步）：
  ① `engine_transport.rs` **已随图谱退役删除**（2026-09-09）——壳只做二进制只读探测，拉起由前端
  `plugins/bundled-engine.ts` → `mcp-bridge.ts` 受治进程 → Rust `protocol_bridge` stdio，**默认关、一进程一根**；
  ② `src-ui/src/scene/` 目录**已整个删除**（`graph-types.ts` 不存在），L0 不再引用它。
- 复核纠正一处子代理结论：权限裁决是**四态**（`PermissionResult` = Allow / Deny / Ask / Passthrough，
  真源 `src-tauri/src/permissions/mod.rs:111`），README 已按四态写。
- `docs/landmine-map.md` 第八批审计：`src-ui/src/ui/README.md` 陈旧计数与死引用已修；`dsh-bundle/viewer`
  构建链已断（**2026-09-16 收口：整量拆除，见下 §4.6**）；根 `.lantai/` 残留目录待取证。
- **豁免账：P2 类目清零**（facts-arch-31 / facts-readme-domains / size-current-layer / links-landmine /
  facts-plugins-29 / orphans-top / size-design-spec / size-landmine / size-open-surface 全部清偿）。

### 4.3 P3 落账（2026-09-16 · 归档大扫除 + 索引瘦身）

**归档**（`git mv`，21 个文件位移；archive 是既定机制，未真删、git 史在）：

| 源 | 目的 |
|---|---|
| `docs/plans/composition-architecture/`（整树 16 件：README + HISTORY + designs×5 + reports×2 + work-orders×7） | `docs/archive/composition-architecture/` |
| `docs/plans/agent-platformization-plan.md` | `docs/archive/agent-platformization-plan.md` |
| `docs/plans/plugin-bundle-retirement-plan.md` | `docs/archive/plugin-bundle-retirement-plan.md` |
| `docs/plans/builtin-plugin-roster-single-source.md` | `docs/archive/builtin-plugin-roster-single-source.md` |
| `docs/plans/frontend-overlay-a11y-plan.md` | `docs/archive/frontend-overlay-a11y-plan.md` |
| `docs/plans/handoff-p2-window.md`（内核插件运行时 Phase 2 交接窗——该线已随 v3 拆除令作废） | `docs/archive/handoff-p2-window.md` |

- 14 件补「已归档（2026-09-16 · P3）」横幅 + 现状指针（`docs/README.md` 维护规则第 5 条）；**S7「真面板并排」随线归档并在
  `docs/plans/README.md` 注明重启方式**（取回重新立项）。
- 引用同步 11 处（`CLAUDE.md` / `CONVENTIONS.md` / `docs/adr/composition-boundaries.md`×2 / `docs/adr/project-constitution.md`×2 /
  `docs/composition/README.md` / `docs/plugins/README.md` / 两份 plan 内裸文件名 / 被移文件内部自身路径×3）。

**索引瘦身**：

| 文件 | 前 | 后 |
|---|---|---|
| `docs/plans/README.md` | 122 行 · 最长行 4979 · 最长单元格 1988 | **127 行 · 最长行 462 · 最长单元格 373**（骨架保留；真机欠账 12 行逐行保留；竣工线压成「点名 + archive 指针」） |
| `docs/plans/HISTORY.md` | 最长单元格 945（8 处 >500） | 最长单元格 492（8 处全压，里程碑语义保留 + 指针） |

**长行拆分（内容零改动）**：`taste-ledger.md` 15 行 · `scientific-rendering-plan.md` 1 行（4714 字符）· `stream-rhythm-plan.md` 1 行——
在句界 / `**标签**：` 边界插换行 + 缩进；校验法 = 从 `git show HEAD:<file>` 取原文、重跑同一拆分算法，
**与工作区逐字节比对相等**（工作区 = 原文 + 仅换行缩进，3 份文件全等）。

**孤儿清偿**：P3 起始 23 项 → **0**。归档消化 16 项；索引挂链消化 6 项（canvas-space 阶段件 3 · 并发会话 · LSP 舰队 · 出厂产物归家 ·
纸壳交互承接 · 内核能力口设计件 4 · 纸壳表面清单 · v11 分析引擎）；**豁免账 P3 类目清零**（facts-plans-14 / size-plans-active /
size-plans-tree / orphans-plans / orphans-plans-tree / archive-plans 六条全删，账上只剩 1 条永久豁免 = `CODELY.md`）。

### 4.4 P3b 落账（2026-09-16 · 竣工无横幅件补批）

archive 查只看计划头部 15 行的「已竣工/已归档」**字面量**，于是这批「代码全竣工但头注没写横幅」的计划一直漏在
`plans/` 里——**本批就是被这个漏网点漏掉的**。逐条取证（头注 + `plans/README.md` 欠账表）后归档 11 件：
`engine-plugin-extraction` · `layering-rework-plan` · `first-party-hot-reload-plan` · `agent-asset-blocks` ·
`multimodal-image-plan` · `browser-cdp-suite-review-round2` · `session-persistence-seam-wiring-plan` ·
`tool-ergonomics-notes` · `paper-shell/paper-panel-split-plan` · `tool-ergonomics/design-1` + `design-2`（后三件镜像子目录）。

- 每件第 3 行插归档横幅 + 现状指针；**两处头注过期由横幅显式订正**（会话持久化 seam「待施工」→ 2026-09-05 三 commit 竣工 ·
  CDP 二轮「剩余 E2E 待跑」→ 2026-08-22 实跑 35/35 结清）。
- 引用同步 19 处（含 `INVARIANTS.md` · 两份 ADR · `docs/agents/open-surface-contract.md` 散文单元格（`doc-sync` 复跑指纹未受影响）·
  `HISTORY.md` · 三份在办计划）；冻结层 7 处只修死链不重写内容。
- `plans/README.md`：130 行 / 最长行 462 / 最长单元格 373；**真机验证欠账表逐行零删项**（HEAD vs 现在独立比对：13 项 → 13 项，
  丢失项空、新增项空）；`pretext-typography-plan.md` 从被删清单移入「待执行但已立项」（在办）。
- 门禁抓到并修掉 4 个问题：3 处搬进 archive 后的**跨目录相对链接断链** + 1 处「（已归档）」措辞**误触发 archive 查**
  —— links 与 archive 两查都证明了自身价值。

### 4.5 完成判据终态（2026-09-16 实测）

| # | 判据 | 实测 | 证据 |
|---|---|---|---|
| 1 | `doc-check` 无未豁免违规 | ✅ **exit 0** | 六查 facts / links / orphans / archive **四栏整栏消失**；size 仅剩 1 条**永久**豁免（CODELY.md）；账目卫生栏消失（无闲置豁免） |
| 2 | L0 ≤32KB/文件 且进上下文 | ✅ **19291 B 合计**（CLAUDE.md 15753 + AGENTS.md 3538）/ 预算 65536 B = 29% | 改造前 74242 B（AGENTS.md 被 harness 整份丢弃） |
| 3 | 断链 0 · 索引单元格 ≤500 · 单行 ≤1000 | ✅ | links 栏 0；`plans/README` 最长单元格 373 / 最长行 462；全仓仅 CODELY.md 一条永久豁免长行 |
| 4 | `plans/` 只剩在办项 | ✅ | 32 件竣工件已归档（P3 21 + P3b 11）；余 45 份 = 在办线 + 6 件「代码竣工但真机欠账在办」（欠账逐行在 `plans/README.md` 欠账表） |
| 5 | 事实有真源 | ✅ 8 条跨文档标量（fields/kernel/products/first-party/domains/两道契约版本/壳方法/默认工具）gate-enforced + 生成物 doc-sync 对拍 | `docs/facts.generated.md`；新增事实 = `doc-facts.cjs` 加解析器 + `doc-check.cjs` 加断言。**报道层** 108 行「未登记候选」逐行判过、5 处真漂移已修、余者有意保留（见 §4.6） |
| 6 | 没读过历史的 Agent 能接手 | ✅ | 入口链 = L0（CLAUDE.md 规则+门禁+指针）→ L1（CONVENTIONS/INVARIANTS/ADR）→ L2（ARCHITECTURE）→ 索引（`docs/README.md` 两轴 + `plans/README.md` 现状） |

### 4.6 已知边界

**已处置（收尾二批，2026-09-16）**

1. ✅ **archive 查补强**（`7bfccde9`）：观察窗 15 → 30 行 + 认「状态：…竣工」句式 + **活跃标记否定项**
   （在办/在产/进行中/拍板/未执行/Draft）。**语义裁定**：「竣工即归档」判的是「过程文档是否还活着」，
   不是「验收跑没跑完」——真机欠账由 `plans/README.md` 欠账表承载（先例：`archive/session-ledger-plan.md`
   的欠账行早就指进 archive）⇒「待实机 / 验收 / 欠账」不算在办。
   顺带用新规则抓并订正 2 处状态不自洽：`kernel-capability-c3-design.md` 标**在产设计件** ·
   `paper-shell/README.md` 状态行改「V5 竣工；**当前在办 = R5 打磨环**」。
   **实测 recall 上限**：对 P3b 那 11 件的归档前版本回放，新规则直接命中 **3/11**（其余 8 件头部含
   「验收/欠账」等词，按上述语义不构成在办）——本查是**兜底网，不是完备判定**；完备判定要等给
   每个计划加机器可读状态行（下一步，见下）。
2. ✅ **代码注释旧计划路径**（`a29e04bc`）：22 文件 / 23 处 `docs/plans/<plan>.md` → `docs/archive/…`
   （tsc / biome 0-0 / cargo check 全绿）。**有意不动**：另 103 处是「design tag」式裸名引用
   （如 `（multimodal-image-plan B3）`）——不是可循路径，改它要动 97 个文件且零收益。
3. ✅ **候选归并**（`1ef1aae4`）：114 行逐行判过 → 修 5 处真漂移（ADR 的「133 方法 / 37 工具」·
   composition README 的「14 域工具」· CONVENTIONS 的「ui/ 25 文件」· dev-workflow 的「31 个插件」·
   mcp-acp 设计件的「35 个工具」），全部改为指针；**余 108 行有意保留**（带日期的取证记录 / 提案快照 /
   单文件契约数字 / 修辞）——逐个登记成 fact 断言 = 为一次性散文造长期维护债。

**仍开着（下一批 / 待用户）**

4. **机器可读状态行**：给 `plans/` 每个计划定一行 `> 状态：在办 | 在产设计件 | 搁置 | 竣工（日期）`，
   doc-check 按它判归档（取代现在的散文分类）——这是把第 1 条的「兜底网」升级成「完备判定」的正路。
5. ✅ **对外发布面两处待用户拍板 → 2026-09-16 全部收口**（记 `docs/landmine-map.md` 第八批）：`release-bin/`
   缺失致 release staging 断链（B3，裁定「不要」⇒ 删那 5 行，引擎包只发裸二进制）· `dsh-bundle/viewer`
   构建链已断（裁定「拆掉」⇒ viewer + client 半 + `/hologram` 路由 + 9777 数据面整量拆除，npm 发布链随之解堵；
   同批修掉 `cordis.patch.yml` 的服务名错配）。详见 `docs/landmine-map.md` B3 与「已裁定」节。
6. **树内 README 顾问查**：13 份 `src/**/README.md` 走「报道不上牙」通道（改代码的 commit 不该被文档债
   拦住），现为 0 问题；是否上牙待定。

## 5. 门禁用法与维护纪律

```
cd src-ui
npm run doc-check          # 门禁：未豁免违规即非零退出
npm run doc-check:report   # 漂移清单（含在册豁免 + 未登记候选），exit 0
npm run gen:doc-facts      # 真源变了重生成 docs/facts.generated.md（doc-sync 会对拍）
```

- **新增事实**：在 `scripts/doc-facts.cjs` 的 `FACTS` 表加解析器 → 在 `scripts/doc-check.cjs` 的
  `CLAIMS` 加断言（宁窄勿宽：误报会把门禁变噪声，先靠 `--report` 的候选栏人工归并）。
- **豁免纪律**：`scripts/doc-check-exemptions.json` 每条必须写 `reason` + `payoff`；对应批次落地
  时同步删条目。**豁免是账，不是免罪符。**
- **作用域纪律**：L4（archive / research / plans 正文）默认豁免事实对拍——那是历史，时态是过去；
  只看现在时口吻的层。冻结层（archive / research）不重排排版（改历史只产生 diff 噪声）。
