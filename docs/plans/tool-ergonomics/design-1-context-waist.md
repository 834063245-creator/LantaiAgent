# T-1 设计件 — 工具层上下文腰与参数减负（fs/git/search 三域）rev2

> 状态：**自查模式待实施**（2026-08-30 rev2）。
> **rev2 重裁记录**：rev1 把解析腰放在 Rust 漏斗（path_resolve.rs），2026-08-30 用户质询
> 「费尽心思做了插件化改造，为什么还往 Rust 写特权代码」。重审后 rev1 归位错误成立：
> enforcement（Rust 沙箱/权限/worktree 映射，不动）与 resolution（参数预处理，本件）
> 是两件事；解析移入 JS 平台层后 **Rust 零改动**，且 D11 seam 契约反而更纯
> （provider 收到的恒为解析好的绝对路径——rev1 的 Rust 腰会把特性埋进默认 provider
> 后端，换 MCP/远程 provider 即失效）。三处惯性逐条驳斥见文末自查记录。
> 先例对标：`activeFsProviders()` 模块级可变态（CONVENTIONS §1.10 第 3 类既有归类）、
> executor 注入 `_owner_id`（streaming-executor.ts L342-347，既有身份管道）、
> domains.ts `normalizeArgs`（既有别名桥，本件扩展职责面）。
> 范围铁律：引擎侧 hologram_* MCP 工具面不动；Rust 侧零改动。

## 1. 问题陈述

两笔税（notes 实账）：①绝对路径重复税——fs read/write/edit 契约即 "Absolute path"
（coding.ts L97/L109/L125），git 13 action 的 `path` 全必传（rpc.rs 逐臂 `req_str` 实查），
search 的 `directory` 同样；每次调用模型都要重新生成 `D:\HoloGramHG\...` 全前缀。
②flat schema 键混乱税——域折叠后 fs 可见面同义键三枚（`filePath`/`path`/`projectPath`），
合并器逐 key 拼描述加 `(action: xxx)` 后缀（domains.ts `domainParametersSchema`）；
normalizeArgs 的存在本身就是模型混键的实账。

设计题与裁决：

| # | 设计题 | 裁决 |
|---|---|---|
| Q1 | 解析腰放 Rust 漏斗还是 JS 平台层 | **JS 平台层**（rev2 重裁，§2.1） |
| Q2 | 相对路径基准 = workspace root 还是 sticky cwd | **workspace root**（跨域不耦合 shell 状态；与 glob 根相对语义一致） |
| Q3 | 哪些参数吃「省缺 → workspace root」 | **git 全族 path / search directory / fs list、constraints projectPath**（JS 填充，Rust 签名零改动） |
| Q4 | 可见面同义键归一怎么做 | **域 schema 合并期 canonical 映射 + normalizeArgs 无条件归一** |
| Q5 | per-owner 上下文（root/焦点/窗口）挂哪、键控与生命周期 | **per-owner 注册表，Agent 装配期注册、拆卸即清**（§2.2——比代际计数更贴 L1 per-workspace 实例化） |
| Q6 | `(action: xxx)` 描述噪音怎么减 | **path 族单条共享描述；专属键才保留 per-action 标注** |

非目标：oneOf 判别联合（DeepSeek 400 已裁）；引擎 MCP 工具面；sticky_cwd 语义改动
（cwd 是进程孵化属性，留在 Rust 是对的）；focus/粘性窗口（design-2 另件）。

## 2. 设计

### 2.1 enforcement / resolution 分离（rev2 核心论证）

Rust 漏斗（require_read/require_write/require_git/forward_map_path/沙箱）是**强制层**：
校验最终到达的路径——这个职责一个字不动。本件做的是**便利层**：在参数进入强制层
之前，把模型给的相对路径/省缺补全为逻辑绝对路径。约束「Rust 收到的必须是绝对路径」
由 JS 腰满足；「谁送来的都照查」由 Rust 保持——强制层不旁路（D11 铁律）语义不变。
**收益**：解析逻辑进平台层 = 插件可观察可参与；任何替代 FsProvider/ShellProvider
收到的都是解析好的参数（seam 契约收严为「provider 恒收绝对路径」）；纯 JS 可 vitest。

### 2.2 `agent/session-context.ts`：per-owner 上下文注册表

```ts
// 模块级可变态（CONVENTIONS §1.10 第 3 类，activeFsProviders 同款归类）
interface OwnerContext { workspaceRoot: string; focusPath?: string; focusWindow?: WindowLocator; }
const registry = new Map<string, OwnerContext>();            // key = owner id（bus id）
export function registerOwnerContext(ownerId: string, workspaceRoot: string): () => void;
export function ownerContext(ownerId: string | undefined): OwnerContext | undefined;
```

- **注册点**：Agent 装配期。`AgentRuntime(this.path, ...)`（workspace.ts L780）已持工作区
  根，agent 构造出 bus id（host.id）后一行注册；拆卸（agent 结束/工作区切换）= registry
  删行——**生命周期即注册表生命周期**，不需要 sticky_cwd 式 generation 计数。
- **双工作区隔离**：registry 按 owner 键控（R7 显式参数 threading 教训的同款应用——
  不做全局单根），双工作区并行各解析各的根，串不了场。
- **无上下文环境**（单测/无引导装配）：`ownerContext()` 返回 undefined → 相对路径
  loudly 报错、省缺不填充（Rust `req_str` 照旧报错）——绝静默兜底。

### 2.3 参数预处理腰（normalizeArgs 扩展，单拦截点）

`buildDomainTool.execute → normalizeArgs` 是全部域调用的既有必经点（domains.ts），
扩展三规则，由**声明式 role 表**驱动（按域按参数，机器可对照旧 schema 校验）：

| role | 语义 | 应用面 |
|---|---|---|
| `resolve` | 相对 → `path.resolve(root, p)`（纯函数，盘符/斜杠归一） | fs 全部路径参数 + git path + search directory |
| `resolve+default` | 省缺 → workspace root | git 13 action path、search directory、fs list/constraints projectPath |
| （无 role） | 原样透传 | content/oldString/pattern 等非路径参数 |

- 键归一（Q4）：canonical 映射 `{ filePath→path, projectPath→path, directory→path }`
  应用于合并期可见 schema；normalizeArgs 反向桥从「只补 required」放宽为 path 族
  无条件归一（旧工具键名零改动，rename 三处契约测试不动）。
- 可见面 fs 参数 16 键 → 10 键；zod optional 化 + 描述换代在 coding.ts（git path /
  search directory / list / constraints projectPath → optional，描述注明省缺语义）。
- **Rust 零改动**：git/search/list 的 Rust 参数保持 `String` 必传——JS 腰保证省缺时
  已填充；rpc 契约文档零变化。

### 2.4 描述瘦身（同 rev1）

path 族可见面共享单条跨域描述常量（「目标路径；相对 = 相对工作区根；标注省缺者
省缺 = 工作区根」）；`(action: xxx)` 后缀只保留给真专属键（staged/count/branch 等）。
域 schema 由合并器从旧 zod 现算，optional 化自动传导。

## 3. 实施批（单批）与验收口径

| 文件 | 改动 |
|---|---|
| `src-ui/src/agent/session-context.ts` | 新建（注册表 + 纯路径解析函数，~100 行） |
| `src-ui/src/workspace.ts` | Agent 装配处 register/dispose 接线（~2 行） |
| `src-ui/src/agent/tools/domains.ts` | role 表 + normalizeArgs 扩展 + canonical 映射 + path 共享描述 |
| `src-ui/src/agent/tools/coding.ts` | zod optional 化 + 描述换代（git/search/list/constraints） |
| `src-ui/tests/` | session-context 单测 + 域面端到端（见验收） |
| `docs/agents/model-tool-contract.md` | 生成物重录（gen:tool-contract），同 commit |
| `docs/plugins/` 相关 + notes | 状态行换代 |

**验收口径（全部同 commit）**：

1. 纯函数单测：相对/绝对/盘符大小写/正反斜杠混用/`..` 拒绝（穿越序列不得借腰逃逸
   ——解析只做 join，`..` 留给 Rust 沙箱拒绝，但腰不得规范化掉 `..` 制造假安全）。
2. 注册表单测：register/dispose 生命周期；双 owner 并行互不串；无注册 loudly 报错。
3. 域面端到端（rpc 探针）：模型发 `{action:'read', path:'src/x.ts'}` → Rust 收
   `file_path` 绝对路径；`git(action:'status')` 省缺 → Rust 收 workspace root 绝对路径；
   发旧键 `filePath` 仍命中；Rust 命令签名零变化（rpc 契约文档零 diff 钉面）。
4. 门禁：`$env:NODE_ENV='test'` vitest 全量 / tsc / biome / gen:tool-contract 重录 /
   doc-sync；cargo **零改动零重跑**（无 Rust diff 本身是断言）。
5. **convergence baseline**：可见 schema required/描述变化 → baseline-change-request
   （`src-ui/tests/convergence/baseline-change-request.md`）+ standard/minimal 双 preset
   重录 + 独立 freeze commit（design-2 同窗共享）。

## 4. 风险表

| # | 风险 | 缓解 |
|---|---|---|
| R1 | JS 路径解析与 Rust 语义漂移（盘符/斜杠/UNC） | 纯函数 + 全枚举单测（验收 1）；绝对性最终仍由 Rust canonicalize 把关——腰错只报错，不越界 |
| R2 | `..` 穿越借腰洗白 | 腰只 join 不规范化；沙箱既有拒绝逻辑原样拦截；单测钉「腰输出保留 `..`」 |
| R3 | 双工作区串场 | per-owner 键控 + 并行单测（§2.2）；拒绝全局单根方案 |
| R4 | 无注册环境静默错解析 | ownerContext() undefined → loudly 报错 + 省缺不填充；绝静默兜底 |
| R5 | 模型习惯旧键 | normalizeArgs 无条件归一桥 + 描述教新键 + 端到端钉面 |
| R6 | baseline 字节变化打断前缀缓存 | 走 baseline-change-request 流程（验收 5），design-2 同窗共享 freeze |
| R7 | 插件工具不受腰益 | 插件经 ctx.tools 贡献的工具走同一 registry 收敛（convergeRegistry 对贡献工具同折域）；不折域的插件工具自带契约，不强加 |
| R8 | 模块级可变态回归（CONVENTIONS §1.10） | 归类第 3 类既有先例（activeFsProviders 同款）+ dispose 纪律 + 守护测试 |

---

> **自查记录（2026-08-30 rev2）**：承重断言逐条对照代码库——①JS 侧持有工作区根：
> `Workspace.path`（workspace.ts L115）、`new AgentRuntime(this.path, ...)`（L780）、
> executor 为装配链产物（default-loop.ts L161 `new StreamingToolExecutor(...)`）；
> ②executor 全工具注入 `_owner_id`（streaming-executor.ts L342-347）= per-owner 键控
> 管道现成；③normalizeArgs 为全部域调用既有必经点且 aliasMap 已含 filePath↔path/
> projectPath↔path（domains.ts L96-103）；④git/search/list Rust 参数必传由 rpc.rs 臂
> `req_str` 承担（L483-489 等实查）——JS 恒填充即无需动 Rust；⑤强制层不变式：腰输出
> 逻辑绝对路径 → 既有 require_read/forward_map/沙箱原样消费（path_resolve.rs L267-345）；
> ⑥模块级可变态有在库归类与先例（fs-service.ts「CONVENTIONS §1.10 第 3 类」注释）；
> ⑦rev1→rev2 驳斥三惯性（漏斗位置/sticky_cwd 先例/workspace_path 不可得）+ 一处真约束
> 接错对象（「Rust 收到绝对路径」≠「解析在 Rust」），已在文首重裁记录留痕。
