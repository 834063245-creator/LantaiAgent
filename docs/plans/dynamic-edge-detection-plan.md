# 动态边检测（Dynamic Edge Detection）迭代 Plan

> 状态：**superseded**（2026-08-24）——本 plan 已并入
> `v11-analysis-engine-master-plan.md` 第三篇章（D 篇），以主文档为准。
> 本文件保留作历史参考。
>
> 原状态：草案 v1（2026-08-23）
> 定位：图谱从"静态导航图"升级为"静态骨架 + 动态验证层"的双层图。
> 动机：静态分析对动态派发（字符串事件名、IPC channel、回调注册）结构性失明，
> 这是停机问题级别的硬限制。本 plan 不试图"做好静态"，而是在静态之上叠
> 三层递进的动态信号，把假阴性率从"不可知"压到"可度量"。

---

## 0. 问题定义与术语

**动态派发盲区**：调用关系由运行时字符串匹配或注册表查找决定的调用点。
静态图上表现为"无边"，实际运行时表现为"有边"。典型形态：

| 形态 | 兰台代码库内的活例 | openhanako 活例 |
|---|---|---|
| 事件总线 | `src-ui/src/agent/events.ts` AgentEventBus.on | 87 处 `.emit('/.on('` |
| IPC channel | `bridge.ts` rpc/invoke、`rpc-contract.ts` | `ipcMain.handle("invite:redeem")` |
| 命令注册表 | `CommandRegistry.register` | tauri 97 commands |
| 插件 hook | `HookRegistry.register` / cordis events | plugin-sdk 消息面 |
| 回调约定 | `@then_name` 回调 | setTimeout/onAbort |

**三层防线**（递进，非互斥）：

```
L1 插桩静态   字符串字面量模式匹配 → "影子边"（provenance=pattern）
L2 测试运行时 跑测试套件采集调用序列 → "验证边"（provenance=runtime-verified）
L3 影子验证   图谱断言：运行时序列 ⊆ 图边集合，差集 = 漏报清单
```

设计原则（不可妥协）：

1. **影子边永远可区分**：provenance 字段是数据契约的一部分，UI/工具不得抹平
2. **引擎零动态执行**：引擎只消费采集结果，绝不在分析时执行用户代码
3. **增量友好**：新增 provenance 不改变既有边语义；旧图加载不得丢新字段（serde default）

---

## 1. 数据模型扩展

### 1.1 Edge 增加 provenance（最小侵入）

`engine/src/graph/edge.rs`：

```rust
/// 边的来源：静态结构 / 静态模式（影子边）/ 运行时验证 / 运行时发现
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum EdgeProvenance {
    /// tree-sitter 结构分析产出（默认，兼容存量图）
    #[default]
    Static,
    /// L1 字符串模式匹配产出（影子边）
    Pattern,
    /// L2 运行时采集确认（把同名影子边升级）
    RuntimeVerified,
    /// L2 采集到但静态与模式均未发现（纯动态发现边）
    RuntimeDiscovered,
}

impl EdgeProvenance {
    pub fn as_str(&self) -> &'static str {
        match self {
            EdgeProvenance::Static => "static",
            EdgeProvenance::Pattern => "pattern",
            EdgeProvenance::RuntimeVerified => "runtime-verified",
            EdgeProvenance::RuntimeDiscovered => "runtime-discovered",
        }
    }
    pub fn from_str(s: &str) -> Option<Self> { /* 对称实现 */ }
}
```

`Edge` 结构新增字段（serde default，旧快照无损加载）：

```rust
pub struct Edge {
    // ... 既有字段不动 ...
    /// 动态通道名（事件名/IPC channel/命令名），动态边必填
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<SmolStr>,
    /// 首次/末次运行时确认的时间戳（L2 回灌时更新）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<u64>,
}
```

### 1.2 动态边去重与升级规则

同一 (from, to, kind, channel) 四元组唯一：

- pattern 边先落图（带 `channel`）
- runtime 采集命中四元组 → 升级为 RuntimeVerified（不新增边）
- runtime 采集发现新四元组 → 新增 RuntimeDiscovered 边
- 升级只改 provenance + verified_at，**永不降级**（一次验证终身有效，除非显式 rebuild）

### 1.3 快照兼容性

- `from_json_file` 对缺 provenance/channel 的旧快照：serde default 补 `Static`/None
- 快照版本号 +1；旧引擎读新快照忽略未知字段（serde 默认行为已保证）

---

## 2. L1：插桩静态（字符串模式 → 影子边）

### 2.1 新增查询文件：`engine/queries/dynamic_dispatch.scm`（语言无关骨架）

JS/TS 家族先行（复用 `js_ts_dataflow.scm` 的 node 命名惯例）：

```scheme
;; ── 动态派发影子边：字符串字面量调用面 ──
;; 匹配 emit/on/handle/invoke/register 的字符串字面量实参

;; 总线式：bus.emit('name', ...) / emitter.on('name', cb)
(call_expression
  function: (member_expression
    property: (property_identifier) @method
    (#match? @method "^(emit|on|once|off|publish|subscribe|dispatch)$"))
  arguments: (arguments
    (string (string_fragment) @dynamic.channel)))

;; IPC 式：invoke('channel', ...) / handle('channel', handler)
(call_expression
  function: (member_expression
    property: (property_identifier) @method
    (#match? @method "^(invoke|handle|send|rpc|command)$"))
  arguments: (arguments
    (string (string_fragment) @dynamic.channel)))

;; 兄弟实参捕获回调符号（channel → handler 的静态锚点）
(call_expression
  function: (member_expression
    property: (property_identifier) @method
    (#match? @method "^(on|once|handle|subscribe)$"))
  arguments: (arguments
    (string (string_fragment) @dynamic.channel)
    . (_) @dynamic.handler))
```

Rust 家族（`rust_dynamic.scm`，二步走，先覆盖 tauri 场景）：

```scheme
;; tauri command 注册：invoke("cmd_name", ...)
(call_expression
  function: (identifier) @fn
  (#eq? @fn "invoke")
  arguments: (arguments (string_literal (string_content) @dynamic.channel)))
```

### 2.2 引擎侧解析规则

`adapter/query_adapter.rs` 扩展（伪代码，具体挂进既有 capture 管线）：

1. 遇 `dynamic.channel` capture → 记录 `(site, method, channel_literal)`
2. 解析层不做名字合成（channel 不是符号）——**边的主语/宾语是站点符号**
   - emit/on 调用点所在函数 = from 节点
   - `dynamic.handler` capture 的符号（若有）= to 节点
   - 无 handler 侧符号（纯 emit）→ channel 挂到文件级节点，type=Triggers
3. 产出边：`kind=Triggers, provenance=Pattern, channel=Some("mood_start")`
4. **同 channel 的所有 emit 站点 × 所有 on 站点做笛卡尔连接**（保守过近似，
   宁可多连不可漏连；L2 会把真实对验证出来，未验证对在 UI 呈现为虚线）

### 2.3 已知假阴性（如实写进文档，不藏）

- 模板字符串 `` emit(`${prefix}:x`) `` → 跳过并计入 `skipped_dynamic` 计数
- 变量间接 `const ev = 'x'; emit(ev)` → 跳过（L2 兜底）
- 运行时构造的 channel → 只有 L2 能抓

交付物：`skipped_dynamic` 计数进 engine status，MCP `engine_status` 可查，
让"我们漏了多少"从猜测变成数字。

### 2.4 验收标准（Milestone D1）

- [ ] 对 openhanako 全仓跑 L1：产出 ≥ 60 条 pattern 边（87 处调用点理论上限的 70%）
- [ ] 对兰台自身（dogfood）：bridge.ts/rpc-contract/events.ts 全部命中
- [ ] `skipped_dynamic` 计数 < 调用点总数的 30%
- [ ] 旧快照加载回归测试：加载无 provenance 快照 → 全部默认 Static，零 panic
- [ ] 快照 round-trip：新字段序列化/反序列化一致（edge.rs 测试组补 4 个用例）

预估：查询与适配 3~5 天（含 rust 侧）。

---

## 3. L2：测试运行时采集（opt-in `hologram verify --tests`）

### 3.1 采集器形态：语言分栈，进程外落地

**TS/JS（兰台 src-ui 与 JS 目标项目）**——vitest 插件：

```ts
// tools/runtime-collector/vitest-plugin.ts
import type { Plugin } from 'vite';
// 三类探针：
// 1) EventTarget/addEventListener、自研 bus（按 L1 的方法名清单 patch）
// 2) fetch/XHR 目标 URL（网络侧动态边，channel=url 模式）
// 3) structuredClone/postMessage 目标（worker 边）
// 输出：JSONL，一行一条 {from_site, channel, to_site?, ts, pid}
```

**Rust（兰台 engine/src-tauri 自身）**——`tracing` 扇出：

- 现有 `#[instrument]`/`tracing` 点位补一个 `hologram-dynamic` target 的
  专用事件层；`cargo test` 时经 tracing-subscriber JSON 落地同一格式 JSONL

**Node 通用**——`NODE_OPTIONS=--import ./collector.mjs` 注入
（`diagnostics_channel` 订阅 `process.child_process`、`net`、`http` 主题），
供分析第三方 Node 项目（如 openhanako）时零侵入使用。

### 3.2 数据契约：采集文件格式（v1，冻结）

```jsonl
{"v":1,"ts":1755955200000,"pid":1234,"kind":"channel_call","site":"src/app/chat-core.ts#ChatCore.ask","channel":"agent:status","to":null}
{"v":1,"ts":1755955200001,"pid":1234,"kind":"channel_call","site":".../runtime-adapter.ts","channel":"agent:status","to":"src/state/mode-store.ts#hydrate"}
```

- `site` 格式与静态图 location 键对齐（`path#symbol`，路径相对项目根）
- 采集器不做去重、不做聚合——引擎侧统一处理（采集器保持傻）

### 3.3 回灌：`hologram verify --tests`（CLI + MCP 双入口）

流程：

```
1. 启动 watcher 快照当前图
2. 注入环境变量 → 起 vitest/cargo test 子进程
3. 等待退出，读 JSONL
4. 对每条记录：
   a. site → 定位图节点（按 location 前缀匹配 + symbol 名兜底）
   b. 查 (from,to,kind,channel) 四元组：
      - 已有 pattern 边 → 升级 RuntimeVerified
      - 无 → 新增 RuntimeDiscovered
5. 落快照，输出 verify 报告（见 3.4）
```

MCP 工具面新增（挂进现有 35 工具注册表，schema 走既有注册管线）：

- `verify_graph_run`（跑采集+回灌，长任务，进度走既有 progress 通知）
- `verify_report`（读最近一次报告）

### 3.4 验证报告（verify 报告 = 产品核心交付物）

```
✓ 2,314 条 pattern 边中 1,872 条获运行时确认（80.9%）
△ 运行时新发现 143 条边（静态+模式均未覆盖）
✗ 442 条 pattern 边未被任何测试触碰（盲区清单）
⚠ skipped_dynamic: 27 处字面量外调用点未采
拓扑警报：RuntimeDiscovered 边参与环 → 高置信动态环（升级为红色环）
```

### 3.5 验收标准（Milestone D2）

- [ ] 兰台自身 dogfood：vitest 全量跑完，`agent:status` 等 8 个核心 channel
      全部升级 RuntimeVerified
- [ ] openhanako 试点：抽 `tests/auto-updater.test.ts` 单文件采集，
      `invite:redeem` 系 channel 边出现且 Verified
- [ ] 采集开销：vitest 全量耗时增幅 < 25%
- [ ] 回灌幂等：同一 JSONL 回灌两次，边集合零变化
- [ ] 采集器自身测试 ≥ 40 用例（兰台 2200+ 家族新增）

预估：TS 侧 2 周；Rust 侧 +1 周。

---

## 4. L3：影子验证与图谱断言（pre-flight 升级）

### 4.1 `preflight_check` 增维

现状：输入改动文件 → 影响面。升级：叠加动态层置信度。

- 改动文件若命中 **Verified 边端点** → 报告附"运行时已确认影响链"
- 改动若命中 **Discovered 边端点** → 升级风险等级（静态图看不见的传播路径）
- 改动若命中 **未验证 pattern 边** → 提示"此通道无测试覆盖"

### 4.2 断言模式（CI 可用）

`hologram assert --no-unverified-dynamic --channel agent:*` 语义：
`agent:*` 命名的所有 channel 边必须 ≥ RuntimeVerified，否则退出码非零。
用途：把"关键事件必须有测试覆盖"从约定变成 CI 门禁（吃自己的狗粮先）。

### 4.3 验收标准（Milestone D3）

- [ ] preflight 报告在兰台自身一次真实改动上产出三层置信度标注
- [ ] assert 子命令进入 ci.yml（先跑自身 `bridge.ts` 的 channel 断言）
- [ ] 3D 星图：pattern 边虚线渲染、Verified 实线加微光、Discovered 红色（视觉规格另行细化）

预估：2 周（含星图渲染）。

---

## 5. 里程碑与依赖序

```
D1 插桩静态 ────┐
                ├─→ D2 运行时采集 ─→ D3 影子验证
（先行，无依赖）─┘    （依赖 D1 的 channel 字段）   （依赖 D2 的报告数据）
```

| 里程碑 | 内容 | 预估 | 累计 |
|---|---|---|---|
| D1 | .scm 影子边 + provenance 数据模型 + skipped 计数 | 1 周 | 1 周 |
| D2 | vitest 插件 + Rust tracing 扇出 + verify 回灌 + MCP 工具 | 3 周 | 4 周 |
| D3 | preflight 增维 + assert 门禁 + 星图分层渲染 | 2 周 | 6 周 |

并行推进项：D2 的采集器可与 D1 后半周重叠（数据契约已冻结）。

## 6. 风险与边界

| 风险 | 缓解 |
|---|---|
| 笛卡尔连接在大 channel 项目爆边量 | channel 边不计入 degree 排名；UI 可折叠同 channel 边组 |
| 采集器影响测试稳定性 | 严格 opt-in；vitest 插件走独立 pool 隔离 |
| site 定位失败（重命名后） | 位置匹配失败降级为 symbol 名匹配；再失败入 `unresolved_sites` 报告项 |
| 运行时边泄露路径隐私（分析他人项目） | 采集文件仅存本地 .hologram/，报告脱敏为相对路径 |
| 双 provenance 字段膨胀快照 | channel 用 SmolStr intern；skip_serializing_if 压缩 |

## 7. 非目标（本轮明确不做）

- 常驻生产探针（低采样率采集）——性价比未证，观察 D2 数据后再议
- 跨进程 trace 传播（traceparent 关联）——L2 单进程内闭合即可
- 字符串拼接 channel 的静态求值——明确放弃，交给 L2

## 8. Dogfood 路线（贯穿全程）

- D1 完成当天：对 openhanako 跑一遍，把 87 处 emit/on 的覆盖数发进 repo issue 当基准
- D2 完成：拿兰台自己的 1472 个 TS 用例当第一批语料
- D3 完成：ci.yml 挂 assert，本仓库 `bridge.ts` 的 rpc channel 率先进门禁

## 9. 本 plan 与既有资产的衔接

- 复用 `js_ts_dataflow.scm`/`ts_structure.scm` 的 capture 惯例（@read/@write/@scope_*）
- provenance 落 `edge.rs`，测试风格对齐 `test_edge_serde_roundtrip` 家族
- MCP 注册走既有 registry（`engine/src/mcp.rs` 的 handler 表），不另起炉灶
- 文档落位遵循 docs/plans/ 现有命名（*-plan.md）
