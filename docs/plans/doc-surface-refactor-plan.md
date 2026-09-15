# 文档面大重构（打磨收尾）— 施工单

> 立项 2026-09-16（用户拍板根 README 对外定位 = 乙：桌面 Agent 工作台为主、引擎降配套）。
> 状态：**P0 立尺 + P1 注入层已落地**，P2-P4 待推。
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
| **P2 现状层** | ARCHITECTURE / 根 README（乙定位）/ plans 索引 / docs 索引 按真源重写；数字改为指针 | `facts` 与 `links` 豁免条目删净 |
| **P3 归档大扫除** | 竣工文档 git mv → archive/，索引瘦身（单元格 ≤500），HISTORY 补时间轴 | `archive` 豁免删净；plans/ 只剩在办项 |
| **P4 索引重建** | docs/README 重写为唯一入口（角色 × 任务两轴），孤儿全部挂上 | `orphans` 豁免删净 |

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
  构建链已断（待用户拍产品面去留）；根 `.lantai/` 残留目录待取证。
- **豁免账：P2 类目清零**（facts-arch-31 / facts-readme-domains / size-current-layer / links-landmine /
  facts-plugins-29 / orphans-top / size-design-spec / size-landmine / size-open-surface 全部清偿）。

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
