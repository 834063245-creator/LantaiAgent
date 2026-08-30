# T-2 设计件 — 会话焦点态（fs 焦点文件 + desktop 粘性窗口）rev2

> 状态：**已落地（2026-08-30 rev2 当日竣工；与 T-1 同 commit、共享 baseline freeze）**。
> 实施偏差一处：desktop 粘性窗口 fill 从 per-field 改为 **all-or-nothing**（自查缺陷 B——
> per-field 会把不同窗口的 hwnd/title 混进同一 locator；模型给了任一定位字段即不补）。
> **rev2 重裁记录**：rev1 把焦点态放 Rust（session_focus.rs + rpc.rs 臂接线），与 T-1
> 同因归位错误——2026-08-30 用户质询插件化纪律后随 T-1 一并重裁。焦点态是**参数预处理
> + 会话上下文**，归 T-1 rev2 的 per-owner 注册表（`session-context.ts`）统一承载；
> sticky_cwd 先例不构成「焦点也该在 Rust」的论证（cwd 是进程孵化属性，焦点是参数语义）。
> **Rust 零改动**；rpc.rs 各臂原样。来源链：T-1 §2.6 原预告 → 用户质询「Phase2 只预告吗」
> 升格设计件 → 同日二次质询插件化纪律 → rev2 归位 JS。
> 先例对标：sticky_cwd 语义四要素（owner 键控/生命周期清场/自愈失效/`[cwd: ...]` 回显）
> 全部保留，仅实现层位移；`[file: ...]` 回显行 = `[cwd: ...]` 先例的直接推广。

## 1. 问题陈述

两处重述税（sticky_cwd 头注释的同型实账）：

1. **fs 焦点税**：读后即改是 agent 最高频序列，`edit_file` 每次重传完整 `file_path`
   （rpc.rs L484 `req_str` 必传实查）——目标明明就在上一次调用的参数/返回里。
2. **desktop 窗口税**：uia 族 14 个 action 全带窗口定位参数（hwnd/pid/title），probe →
   tree → find → click → type 工作流每步重传（rpc.rs L764-825 逐臂实查）。

设计题与裁决：

| # | 设计题 | 裁决 |
|---|---|---|
| Q1 | 焦点态放哪 | **T-1 rev2 `session-context.ts` per-owner 注册表**（focusPath/focusWindow 字段）——装配期注册、拆卸即清、双工作区天然隔离 |
| Q2 | 焦点存逻辑还是物理路径 | **逻辑绝对路径**（模型可见形态；worktree `forward_map_path` 每调用现算——存物理路径会被二次映射击穿） |
| Q3 | fs 哪些动作吃焦点省缺 | `read`/`edit` 省缺 → 最近读写文件；`write` 保持必传但成功同样设焦；delete/move/rename 不吃不设 |
| Q4 | desktop 粘性窗口更新点与解析序 | per-field 补齐（显式 hwnd/pid/title 优先）；显式定位调用与 `uia_activate` 设焦；`probe` 不设焦（多窗口歧义）；not-found 自愈清焦 |
| Q5 | 结果回显 | fs read/edit/write 成功尾部 `[file: <逻辑路径>]` 行；desktop 不回显（结果 JSON 本含窗口信息） |
| Q6 | graph nodeId 粘性做不做 | **不做**——无既定痛点（graph 查询少有同节点连击），裁决非挂起；将来要加走同一注册表 |

非目标：graph/browser 粘性（Q6）；焦点跨会话持久化（agent 拆卸即清，与注册表生命周期
一致）；sticky_cwd 任何改动。

## 2. 设计

### 2.1 实现层位：域工具包装层（JS），Rust 零改动

焦点逻辑全部落在 `domains.ts` 的域工具 execute 包装（T-1 rev2 §2.3 同一拦截点的
延伸），由声明式 per-domain 表驱动：

```ts
// DOMAIN_SPECS 扩展字段（示意）
fs:     { focusPath:  { set: ['read','edit','write'], fill: ['read','edit'] } }
desktop:{ focusWindow:{ set: ['uia_activate', ...显式定位族], fill: ['uia_tree','uia_find','uia_read','uia_wait','uia_click', ...] } }
```

execute 包装时序：normalizeArgs（T-1）之后 → **fill**（read/edit 的 `filePath` 缺失
→ `ownerContext(ownerId).focusPath` 命中则填入，未命中 → 可行动错误「无焦点文件——
先 fs(read) 或显式传 path」）→ 派发旧工具 → Ok 后 **set**（fs：`focusPath = args.filePath`
解析后的逻辑绝对路径；desktop：显式定位参数 ≥1 项或 activate → `focusWindow`）→
**回显**（fs read/edit/write 结果尾部 `[file: <逻辑路径>]` 行）。

- **owner 身份**：`args._owner_id`（executor 全工具注入，streaming-executor.ts L342-347），
  与 T-1 注册表同键；UI 直调 typedRpc 不经域工具包装 → 焦点对 UI 路径结构性不可见。
- **自愈**：fill 命中的焦点路径 `exists()` 失效（JS fs 探测或派发失败回捞）→ 清焦 +
  可行动报错；desktop 粘性回放 not-found → 清焦 + 「焦点窗口已失效，重新 desktop(probe)」。
- **write 必传不省缺**（覆盖风险），但成功设焦（写新文件后接 edit 是常见序列）。

### 2.2 模型可见契约

- zod：read/edit 的 `filePath` → optional，描述「Omit to target the file from your most
  recent fs(read)/fs(edit)」；write 保持 required。
- 域描述：fs 共享 path 描述（T-1 常量）补焦点句；desktop 域描述补「定位参数省缺 =
  当前焦点窗口（由上一次显式定位或 activate 设定）」。
- 两处均为描述/required 变化 → 随 T-1 同批 baseline freeze（§3）。

### 2.3 强制层论证

焦点只产生「参数缺省」：fill 发生在 executor 强制管道（planGate/preflight/hooks）**之前**
的参数准备段，管道与 Rust 漏斗收到的仍是完整显式参数；权限/Ask/沙箱逐调用照旧执行
（desktop_check 每臂都在，rpc.rs 实查）。焦点不跨 owner 串（注册表键控）；不跨工作区
残留（agent 拆卸即清）。插件视角：焦点语义可观察（域包装层即平台层），未来插件自定义
焦点策略有明确挂点（per-domain 表即扩展面）。

## 3. 实施批与验收口径

| 文件 | 改动 |
|---|---|
| `src-ui/src/agent/session-context.ts` | focusPath/focusWindow 字段 + 自愈（在 T-1 新建文件上扩展，~60 行） |
| `src-ui/src/agent/tools/domains.ts` | per-domain focus 表 + execute 包装（fill/set/回显） |
| `src-ui/src/agent/tools/coding.ts` | read/edit filePath optional + 描述换代 |
| `src-ui/tests/` | 焦点端到端（见验收） |
| `docs/agents/model-tool-contract.md` | 随批重录 |
| `docs/plugins/` 相关 + notes | 状态行换代 |

**验收口径（同 commit；门禁同 T-1 §3，cargo 恒零 diff）**：

1. 注册表扩展单测：focusPath/focusWindow set/get/自愈失效/agent 拆卸即清/双 owner 不串。
2. 域面端到端：fs(read, path) 成功 → 焦点落 + `[file:]` 行；fs(edit) 省缺 → 焦点命中
   （Rust 收到的 file_path 与焦点一致）；无焦点省缺 → 可行动错误；write 省缺 → 报错
   但 write 成功后焦点更新。
3. desktop 端到端：显式 hwnd 调用设焦 → 后续 uia_* 全省缺命中（per-field 补齐）；
   activate 设焦；probe 后无焦；not-found 清焦 + 提示文案。
4. baseline：与 T-1 同窗共享一次 freeze commit（两批 diff 都在冻结点内）；跨窗各自走
   baseline-change-request（`src-ui/tests/convergence/baseline-change-request.md`）。

## 4. 风险表

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 焦点指错文件（读 A 读 B 后 edit 省缺） | 语义钉死「最近一次 read/edit」+ `[file:]` 回显每步可见 + 显式 path 恒可覆盖；错文件编辑被 old_string 不匹配 loudly 拒绝 |
| R2 | worktree Agent 二次映射 | 焦点存逻辑路径（Q2），forward_map 每调用现算；端到端钉 worktree 场景 |
| R3 | 双工作区焦点互串 | per-owner 键控（T-1 注册表）+ 并行单测 |
| R4 | UI 直调污染/误享焦点 | UI 不经域工具包装 → 结构性不可见（比 rev1 的「owner_key 缺失旁路」更强——连代码路径都不经过） |
| R5 | 焦点使模型偷懒致意图模糊 | 回显行显式落点 + 危险动作不吃省缺（Q3）+ 错误 loudly |
| R6 | 焦点路径已删除 | fill 前 exists() 探测 + 派发失败回捞双保险，清焦 + 可行动报错 |
| R7 | per-domain 表与 action 集漂移（新增 action 忘配 role） | 表构建期对照 actions 枚举机器校验（未知 action 名 = 装配期报错）+ 守护测试 |
| R8 | baseline 二次冻结成本 | §3 验收 4：同窗共享 freeze；跨窗如实走流程 |

---

> **自查记录（2026-08-30 rev2）**：承重断言逐条对照代码库——①fs 臂必传与 `_agent_id`
> 提取形态（rpc.rs L483-489 / L1196）；desktop 族臂逐臂 `desktop_check` 逐调用权限
> （L764-825）——焦点只补参数不改权限语义；②`_owner_id` 全工具注入
> （streaming-executor.ts L342-347）且域工具 execute 包装可读 args（domains.ts 既有
> normalizeArgs 同点位）；③UI 直调 typedRpc 不经域工具包装（rpc-contract.ts 调用面）→
> R4 结构性隔离成立；④sticky_cwd 四要素在库模板（sticky_cwd.rs 头注释 + get() 自愈 +
> shell.rs `[cwd: ...]` 回显）；⑤rev1 自查曾把焦点更新点放 Rust 漏斗（拿不到 owner_key
> 且服务非焦点命令）——rev2 层位再上移到域包装层后该问题结构性消失；⑥rev1→rev2 的
> Rust 零改动重裁与 T-1 同源（文首重裁记录），批内 Rust diff = 0 本身列为验收断言。
