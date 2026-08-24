# v11 分析引擎总 Plan：动态边 + 查询预算 + 降噪分级（合并版）

> 状态：草案 v1（2026-08-24）
> 本文档是唯一的 v11 分析引擎迭代计划，合并原先可能拆分的三份内容：
> 动态边检测（补盲区）、查询预算制（控流量）、降噪分级（换分辨率）。
> 背景：3D 星图与旧前端已整体退役（星图源码零残留，仅 docs/archive 留档），
> 渲染枷锁解除；图谱的第一消费者从 GPU 变为 Agent 上下文。
> 新瓶颈不是"画得下"，是"装得进上下文"——本 plan 三个篇章全部服务于此。

---

## 0. 勘查基线（2026-08-24 实测，非拍脑门）

写任何计划前先记账，以下是引擎现状的实测事实：

| 资产 | 状态 | 证据 |
|---|---|---|
| `Edge` 结构 | 已有 `coupling_depth`(L1-L4)、`lsp_resolved: bool`、`is_synthesized`、`temporal_delay_sec`、`metadata` | `engine/src/graph/edge.rs:106-136` |
| dataflow 引擎 | **在役非雪藏**：21 pub fn，17 语言配置矩阵（python→r 全覆盖），6 处调用（preflight/graph/analysis/stress×2/engine mod） | `engine/src/analysis/dataflow_engine.rs` |
| `trace_dataflow` | **已注册已接线**：`tools/mod.rs:111,179` → `handlers::handler_dataflow`，三个 `_note` 引导使用 | mod.rs 注册表 |
| limit 机制 | 普遍存在但为**截断式**：fragile 默认 5、timeline 100、list_flows 50(.min 200) | 各 handler |
| token 预算制 | **零**——无任何 handler 有 budget 概念 | 全 handlers grep |
| lsp_resolved 用途 | 仅存储与统计（graph_stats 解析率），**不参与任何查询排序** | handlers 排序均为 score/count/heat |
| LSP 管线 | `lsp_manager.rs` 1381 行在役，4 语言 server（rust/go/python/typescript） | engine_status |
| 旧星图 | 源码零残留；`.hologram`→`.lantai` 已改名迁移 | git log 3e18cce3 |

三个既有 `_note` 承诺了"按需深化"的图景（resolve_call / trace_dataflow / async_edges），
本 plan 就是把这张口头支票兑现成体系。

---

## 第一篇章：查询预算制（P 篇）——一切的其他篇章的阀门

### P0. 设计原则

- **预算是引擎的保证，不是调用方的猜测**：`token_budget` 参数由引擎执行，
  返回体确保 ≤ 预算，Agent 不需要自己试错
- **降级保真不砍头**：超预算时按边优先级裁剪，不是 `truncate` 前N条
- **默认值保守**：未传参时统一 2000 token 预算（约为一次合理工具返回的经验值）

### P1. 预算执行算法（统一输出层）

所有返回节点/边列表的 handler 走同一个 `BudgetedOutput` 层（新文件
`engine/src/tools/output_budget.rs`）：

```
edge_priority(e):
  环参与边(participates in cycle)          → P0
  桥接边(community 间)                      → P1
  lsp_resolved == true                      → P0（置信度直接进优先级）
  is_synthesized == true                    → P3（最后砍）
  fan-out 噪声边(目标为叶子)                → P3
  其余                                      → P2

render(view, budget):
  summary 视图按域聚合计数（几乎不占预算）
  critical 视图只渲染 P0/P1 边
  full 视图从 P0 到 P3 逐级填，预算耗尽即停并附 truncated 统计
  每次截断必返回 {budget_used, budget_total, dropped_by_priority} 三元组
```

关键点：**lsp_resolved 从"统计字段"升格为"排序权重"**——这是勘查发现的最大
免费改进，数据早就在图里躺着，只差进排序路径。

### P2. 改造清单（按现状参数逐个落）

| Handler | 现状 | 改造 |
|---|---|---|
| `trace_impact` (graph.rs:108) | depth 默认 3，全量 layers | + `token_budget`；layers 逐层填预算，最深层最先进 P3 |
| `find_dep_path` (graph.rs:155) | depth 20 全量路径 | + `token_budget`；路径按最短优先填 |
| `get_neighbors` (graph.rs:12) | 无 limit | + `token_budget` + view |
| `fragile_modules` (analysis.rs:10) | limit=5 截断 | 保留 limit，+ summary/critical 视图 |
| `trace_dataflow` (analysis.rs:178) | 全量 df_results | + `token_budget`（起步就做对） |
| `coupling_report` / `detect_cycles` | cycles 全量节点名单 | 大环（>100 节点）只报 `size + 参与域 + 前 20 成员`，`full` 视图才展开 |
| `list_flows` (flows.rs) | limit 50/min(200) | detail_level 已有 minimal——纳入统一预算层 |
| `find_unused` | limit 20 | + view（summary 只给计数） |

`detect_cycles` 特别说明：openhanako 实测出现过 5,607 节点环、兰台 1,470 环，
全量名单本身就是上下文炸弹，此改造有真实事故案例背书。

### P3. 验收标准

- [ ] 上表 8 个 handler 全部接入 BudgetedOutput，返回体含预算三元组
- [ ] 对 openhanako 图（21,867 节点/90,972 边）跑 `trace_impact(session-coordinator)`：
      默认预算下返回 ≤ 2000 token，且环参与边零丢失
- [ ] 对兰台自身 `detect_cycles`：大环默认返回聚合视图，`view=full` 行为不变
- [ ] output_budget.rs 单测 ≥ 25 用例（优先级矩阵 + 预算边界）

预估：2 周（含统一输出层基建）。

---

## 第二篇章：降噪与分辨率（N 篇）——同一个图的三个镜头

### N1. view 参数语义（冻结契约）

```
view=summary   聚合体：域级计数、环数、桥接点名单——回答"有多大"
view=critical  精华体：P0/P1 边 + 桥接点 + 环参与节点——回答"哪里要命"
view=full      全量体：现状行为——回答"全部细节"（默认仍为 full，兼容既有调用）
```

summary/critical 是**新增能力**，full 是兼容底线。所有 view 与 token_budget
正交组合（view 先选内容池，budget 再控体积）。

### N2. lsp_resolved 置信度排序（P 篇已并入 edge_priority）

不再单列——实现上就是 edge_priority 的一条规则，此处仅记录设计意图：
查询结果的可靠性排序 = LSP 已解析 > tree-sitter 启发式 > synthesized。
未来动态边（D 篇）的 provenance=pattern 影子边自然排在这三级之后。

### N3. 聚合不是降维（summary 视图的实现纪律）

summary 视图禁止丢信息：聚合必须可下钻——summary 报 "A 域↔B 域 342 条调用"时，
该行附带 `drill: get_neighbors(node, view=critical, filter=community_pair:A,B)`。
Agent 的二跳查询路径必须在 summary 返回体里自描述。

预估：1.5 周（大量逻辑与 P 篇共享）。

---

## 第三篇章：动态边检测（D 篇）——补静态盲区

> 本篇章即原 dynamic-edge-detection-plan.md 的内容并入。原独立文件
> `docs/plans/dynamic-edge-detection-plan.md` 保留但标记 superseded，以本文为准。

### D1. 数据模型扩展

`engine/src/graph/edge.rs` 新增（serde default，旧快照无损）：

```rust
pub enum EdgeProvenance { Static, Pattern, RuntimeVerified, RuntimeDiscovered }

pub struct Edge {
    // ...既有字段不动...
    pub provenance: EdgeProvenance,          // 默认 Static
    pub channel: Option<SmolStr>,            // 动态通道名（事件/IPC/命令名）
    pub verified_at: Option<u64>,            // L2 回灌时间戳
}
```

四元组 `(source, target, kind, channel)` 唯一；升级只进不退：
Pattern → RuntimeVerified（命中采集）、RuntimeDiscovered（新发现）。

### D2. L1 插桩静态（影子边）

新查询 `engine/queries/dynamic_dispatch.scm`（js_ts 家族先行，rust/tauri 次之）：

```scheme
;; bus.emit('name') / emitter.on('name', cb) / invoke('channel') / handle('channel', h)
(call_expression
  function: (member_expression
    property: (property_identifier) @method
    (#match? @method "^(emit|on|once|off|publish|subscribe|dispatch|invoke|handle|send|rpc|command)$"))
  arguments: (arguments (string (string_fragment) @dynamic.channel)))
```

解析规则：
- emit/on 调用点所在函数 = source 节点；handler 实参符号 = target（若有）
- 产出 `kind=Triggers, provenance=Pattern, channel=Some(...)`
- 同 channel 所有 emit 站点 × on 站点做保守笛卡尔连接（P 篇的优先级排序
  保证这种过近似不会再撑爆上下文——两篇章在此咬合）
- 模板字符串/变量间接/运行时构造三类假阴性如实计入 `skipped_dynamic`
  计数，进 engine_status——"漏了多少"从猜测变数字

### D3. L2 测试运行时采集（`hologram verify --tests`）

- TS：vitest 插件（patch bus/invoke/fetch 面，JSONL 落地
  `{v,ts,pid,kind:channel_call,site,channel,to?}`）
- Rust：`tracing` 扇出（`hologram-dynamic` target，cargo test 落同格式 JSONL）
- Node 三方项目：`NODE_OPTIONS=--import collector.mjs` 零侵入注入
- 回灌：site 定位图节点 → 四元组匹配 → 升级 Verified / 新增 Discovered
- 新 MCP 工具：`verify_graph_run`（长任务走既有 progress 通知）、`verify_report`

采集器保持傻（不去重不聚合），引擎侧统一处理。

### D4. L3 影子验证

- `preflight_check` 增维：改动命中 Verified 边端点 → 附运行时确认链；
  命中 Discovered 边 → 风险升级；命中未验证 pattern 边 → 提示无测试覆盖
- `hologram assert --no-unverified-dynamic --channel <glob>`：CI 门禁语义，
  退出码非零即拦截——先吃自己狗粮（本仓 bridge.ts 的 rpc channel）

### D5. 验收标准

- [ ] D2：对 openhanako 全仓跑 L1，产出 ≥ 60 条 pattern 边（87 调用点 70%）；
      skipped_dynamic < 30%；兰台自身 bridge/events 全命中
- [ ] D3：兰台 vitest 全量采集，8 个核心 channel 升级 Verified；openhanako
      抽 auto-updater.test.ts 单文件试点，`invite:redeem` 边出现且 Verified
- [ ] 采集开销 < 25% 耗时增幅；回灌幂等（同 JSONL 两次，边集合零变化）
- [ ] D4：ci.yml 挂 assert 跑自身 channel 断言
- [ ] edge.rs serde round-trip 测试组 +4；旧快照加载回归零 panic

预估：D2 一周、D3 三周、D4 两周（可与 P/N 篇并行，见排期）。

---

## 4. 总排期与依赖序

```
P 篇(预算制) ──2周──┐
                    ├─→ N 篇(降噪/视图) ─1.5周─→ D3(L2 采集)
D2(L1 影子边) ─1周──┘   （与 P 共享 edge_priority）      │
                                                      ▼
                                              D4(assert 门禁)
```

| 周次 | 主线 | 并行 |
|---|---|---|
| W1-W2 | P：output_budget 基建 + 8 handler 接入 | D2 动态 .scm（无依赖） |
| W3-W4 | N：view 三视图 + 聚合下钻 | D3 采集器 TS 栈 |
| W5-W6 | D3：回灌 + verify MCP 工具 | D4 preflight 增维 |
| W7 | D4：assert 进 CI + 全量 dogfood 收官 | — |

总周期 7 周。P 先行的理由在 0 节已论证：没有预算制，D 篇新增边与 N 篇
聚合体都是上下文炸弹的放大器。

## 5. 风险与边界

| 风险 | 缓解 |
|---|---|
| 笛卡尔连接爆边量 | channel 边不入 degree 排名；critical 视图天然折叠；预算层兜底 |
| view 参数增加调用方心智 | 默认值保持现状兼容（full + 2000 token）；summary 在 description 里自推荐 |
| 采集器影响测试稳定性 | 严格 opt-in；独立 vitest pool |
| site 定位失败 | 位置匹配降级 symbol 名匹配；失败入 unresolved_sites 报告项 |
| 旧快照兼容 | serde default 全覆盖；快照版本 +1；round-trip 测试组 |

## 6. 非目标（本轮明确不做）

- 常驻生产探针（低采样采集）——观察 D3 数据后再议
- 跨进程 trace 传播（traceparent）——L2 单进程闭合
- 字符串拼接 channel 的静态求值——明确放弃，L2 兜底
- 3D 渲染回归——星图已退役，本轮不为任何渲染需求设计

## 7. Dogfood 路线（贯穿）

- W2 末：P 篇对 openhanako 图跑第一批预算查询，结果存 docs/benchmarks/
- W4 末：N 篇 summary 视图回答"openhanako 巨环有多大致命"，与人工解读比对
- W6 末：D 篇跑 openhanako L1+L2，87 处 emit 覆盖数进 issue 当基准
- W7：本仓库 ci.yml 挂 `hologram assert`，兰台自身 rpc channel 率先进门禁

## 8. 资产衔接清单

- 复用 `js_ts_dataflow.scm` capture 惯例（@read/@write/@scope_*）
- dataflow_engine 17 语言配置矩阵直接服务 D 篇与 P 篇的 trace_dataflow
- MCP 注册走 `tools/mod.rs` 既有 match 表（HOLOGRAM_MCP_TOOLS 开关沿用）
- provenance 落 edge.rs，测试对齐 `test_edge_serde_roundtrip` 家族
- 文档唯一落点：本文档；原 dynamic-edge-detection-plan.md 标记 superseded
