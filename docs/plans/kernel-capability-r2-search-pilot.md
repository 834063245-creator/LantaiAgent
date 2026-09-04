# R2 —— 薄域编排回 TS：search 试点迁移方案（设计件）

> 状态：**设计件（2026-09-04，R2 开批前定稿）**。锚：kernel-plugin-architecture-decision.md
> v3（五层：工具编排 TS / 策略 TS / 能力口+强制 Rust / 沙箱 Rust / 引擎进程外）。
> R1 已拍板并落地（permission-policy 单真源 + biome 0/0，commit a185f096）。
> 本文件 = R2 试点（search 域）的完整迁移方案。审后即动代码，批 = commit 界。

## 0. R2 目标（v3 执行序表 R2 行）

> R2 | 薄域编排先回 TS（search/web/constraints/editor：schema zod + 编排迁域插件）
>     + 能力实现并入 Rust 能力口 | 全门禁

**试点选 search**（v3 §6 建议 search 最薄试点候选之一；实际勘察后确认 constraints 最薄
但 search 是「能力口变体」的典型——v3 明说 search/glob 全文扫描 = fs 能力族变体）。
search = 1 工具（search_content），Rust 425 行，无句柄/无 spawn，纯读。

## 1. 现状（R1 后勘察核实）

### 1.1 调用链（当前）

```
模型/UI search_content
  → TS: manifest-tools manifestTool('builtin.search','search_content')
      schema 字节 = kernel-manifests.generated.ts（镜像 Rust manifest.json）
  → exec('tool_call', { plugin:'builtin.search', tool:'search_content', args })
  → rpc.rs tool_call 分支 → dispatch_tool_call
  → PluginRegistry 查 builtin.search → PluginToolAdapter 权限闸（is_agent）
  → builtin.search::search_content（425 行：glob 正则/ignore 遍历/预算/向量召回）
```

### 1.2 「编排」与「能力实现」的当前混杂（v3 要拆的）

builtin.search::search_content 内：
- **能力实现（留 Rust 能力口）**：ignore::WalkBuilder 遍历（.gitignore 尊重）、
  skip_extensions 表、扫描预算（MAX_SCAN_FILES 20k / TIME_BUDGET 60s）、
  is_ignored_path、**向量召回 append_vector_hits（hologram-vector 进程内缓存索引）**。
- **编排（回 TS）**：参数提取/缺省（maxResults.clamp、ctx_lines.min、output_mode）、
  glob_filter 编译、正则/子串匹配选择、输出三形态组装（content/files_with_matches/count）、
  head/offset 分页、truncated 判定、vector_hits 注入字段组织。

### 1.3 消费面（改动波及）

- TS 工具面：`agent/tools/manifest-tools.ts createSearchTools` → 改为 zod + 直呼能力口。
- 域折叠：`agent/tools/domains.ts` search 域（action 'content' → 'search_content'）。
- 装配：`plugins/builtin/search-domain`（host 重导出）+ `host-modules.ts`。
- schema 生成物：`kernel-manifests.generated.ts`（builtin.search 条目退役）。
- Rust：`tool_plugins/search/mod.rs` 425 行退役；能力口 = 新增 search 能力实现
  （或并入 fs 能力口变体）；manifest.json + registry 注册退役。
- 测试：15+ 文件引用 search_content / createSearchTools / kernel-manifests。
- 收敛基线：工具面字节契约（T-1/T-2）重录——**schema 键/序/默认值必须逐字节等价**
  否则 baseline 审批。R2 采用「manifest schema → zod 逐字节转录 + 工具面行为零漂移」。

## 2. 目标形态（search 试点后）

```
模型/UI search_content
  → TS 域插件（search-domain）：schema zod（manifest 逐字节转录）+ 编排
      （参数缺省/匹配选择/输出组装/分页/vector_hits 字段组织）
  → Rust 能力口 search_cap.scan {directory, pattern, fileTypes, useRegex, ...}
      （物理执行 + 强制：路径 resolve + 预算 + 忽略 + 向量召回 + 审计）
```

**编排 = TS**（缺省值、三输出形态、分页、截断判定、结果字段——这些是工具业务）。
**能力 = Rust search 能力口**（扫描 + 匹配 + 向量召回 = fs 能力族变体，v3 §4）。

### 2.1 能力口 RPC 面设计（D-A 裁决：独立 search_cap 方法）

按 C-3 §7 D-A 两个选项，R2 试点裁决 = **独立能力口 RPC 方法 `search_cap`**（不是改造
tool_call 单入口）：
- tool_call 信封是 P0-2 脚手架（PluginRegistry + manifest 寻址），v3 拆除令要退役它；
  在它上面加 capability 分派 = 给将拆的壳再叠一层。
- 能力口 = 极少数稳定面（fs/process/credential/句柄/search），独立 RPC 方法 =
  真源清晰、rpc-contract 类型化、与 tool_call 解耦。
- 但**权限闸**：search 是只读 fs 族。能力口内用现成 `resolve_read_*`（Agent 过闸 /
  UI 只解析）——C-2 已核实这是能力口闸门现成实现。search_cap 复用同一闸。

### 2.2 schema 真源（D-C 裁决：schema 回 TS zod）

v3 §2 拆除令：schema 回 TS zod（INVARIANTS #8 原版）。试点落地：
- search_content schema 从 manifest.json 迁移为 TS zod（**逐字节转录**：键名 camelCase、
  描述、默认值、max 200/min 约束——与 manifest 字节一致，保 convergence 零漂移）。
- manifest.json + 生成器 + generated 镜像中 builtin.search 条目退役（R5 全量拆，R2
  先试点域退役）。
- 运行时校验回 zod（defineTool 产出 JSON Schema / 校验 / 类型参数）。

## 3. 迁移步骤（批 = commit 界）

| 步 | 内容 | 门禁 |
|---|---|---|
| R2-a | Rust 新增 search 能力口：`rpc.rs search_cap` 分支 + `commands/capability/search.rs`（从 builtin.search 迁扫描/预算/忽略/向量实现 + resolve_read 闸）+ rpc-contract 类型 | cargo test |
| R2-b | TS search-domain 插件 schema zod 转录 + execute 改直呼 `search_cap`（不再 tool_call）；manifest-tools createSearchTools 换源；domains.ts 不动（工具名不变） | vitest + convergence（工具面字节不动） |
| R2-c | Rust builtin.search 退役：mod.rs/manifest.json/registry 注册删；generated 镜像 builtin.search 条目删；doc-sync 生成器对拍更新 | cargo test + vitest + biome |
| R2-d | 编排完整回 TS：把 glob_filter 编译/输出形态/分页挪 TS（若 R2-b 已含则本步并）；search 能力口收窄为纯扫描返回原始命中 | 全门禁 |
| 收口 | R2 交接落账（含向量召回归属裁定：留在 search 能力口 = fs 族变体） | — |

> R2-a/b/c 是「物理能力口 + 信封换直呼 + 脚手架条目退役」最小试点；R2-d 是「编排
> 真回 TS」的本体。若窗内 R2-d 做不完，R2-a/b/c 已构成可独立 commit 的试点成果
> （工具面零漂移、能力实现已在 Rust 能力口、builtin.search 信封已退役）。

## 4. 风险与缓释

- **工具面字节契约漂移**：schema 逐字节转录 + 输出形状不动 → convergence T-1/T-2
  零漂移；若有差异走 baseline-change-request 审批（R2 尽量不触发）。
- **向量召回归属**：append_vector_hits 直连 hologram-vector（进程内缓存索引）——
  物理实现留 Rust 能力口（v3：fs 族变体），TS 只透传结果。若 hologram-vector 消费
  需要 WorkspaceState 上下文，能力口内注入。
- **UI 路径**：search_content 若被 UI 内部直呼（非 Agent），现 tool_call 只过
  Agent 闸；search_cap 能力口同样分流（resolve_read 的 is_agent 语义）——行为不变。
- **progress 流**：search_content 无增量输出（一次性返回），无 tool_call:progress
  消费——能力口不需要进度通道。
- **权限回归**：search 只读、无 permission 声明（v1 Passthrough，真权 = resolve_read
  路径授权）——search_cap 复用 resolve_read 闸 = 同一真权路径，无回归。

## 5. 测试

- Rust：search_cap 能力口单测（glob/忽略/预算沿用现有 tests 迁入）+ rpc 分支测试。
- TS：search-domain 插件单测（schema zod 转录对拍 manifest 字节）+ 消费方测试更新
  （manifest-tools 换源后 createSearchTools 仍产同名工具）。
- 收敛：verify:convergence 零漂移（工具面字节不动前提）。

## 6. 待执行时定（R2-d 前）

- glob_filter 编译（正则生成）留 Rust 能力口 vs 迁 TS——留 Rust（能力实现，
  TS 有现成 glob 库也可，但为最小漂移倾向留能力口）。
- 三输出形态组装（content/files/count）在 TS 编排 vs 能力口返回原始命中 + TS 组装——
  倾向后者（真编排回 TS），但需能力口先返回足够原始数据（行号/上下文/命中行）——
  与现能力口形状兼容性评估后定。

## 7. 平台边界守卫更新（R2-a 强制层裁定）

`tests/platform_boundary_test.rs::capability_command_modules_are_frozen` 钉住
src/commands/ 模块清单冻结（agent-platformization-plan D1：强制层外不得新增 Rust
命令模块）。R2-a 新增 `commands/search_cap.rs` 属 **v3 能力口强制层**（kernel-plugin-
architecture-decision.md §3：fs 能力族变体 + resolve_read 强制闸 + 物理扫描/向量召回，
webview 越不过的最后闸）——不是业务命令，不在「走开放面」禁止之列。裁定：
- 测试基线加入 `search_cap`（承认其合法强制层模块身份）；
- commit message 显式标注「强制层改动 + v3 能力口宪法依据」；
- v3 后的新能力口（fs_cap/process_cap 等）同样按此更新基线，禁止向 commands/
  塞业务命令。

## 8. 施工进度（2026-09-04 窗，R2-d(1)+R2-c 收口；R2-d(2) 余量交接）

| 步 | 状态 | commit | 说明 |
|---|---|---|---|
| R2-a | ✅ 已落地 | 789aef86 | search 能力口建立：commands/search_cap.rs + rpc.rs search_cap 分支 + shape 表（JsonValue）+ rpc-contract 类型；platform_boundary 冻结清单更新（§7）。扫描体从 builtin.search 迁入，含预算/忽略/glob/向量召回。 |
| R2-b | ✅ 已落地 | 789aef86 | TS 换轨：manifest-tools searchCapTool + createSearchTools 换源（execute 从 tool_call 信封换 search_cap 直呼）。schema 仍取 manifest 字节（零漂移）。 |
| R2-c | ✅ 已落地 | d524f124 | builtin.search 退役：Rust tool_plugins/search/ 删（mod.rs 467 行 + manifest.json）、registry.rs 注册行删、tool_plugins/mod.rs 模块声明删、manifest.rs 出厂锚测试改指向 builtin.fs；连带清 ToolContext::resolve_read 死代码（search 唯一消费方）；gen-plugin-manifests 重跑（镜像 10 个 manifest，builtin.search 条目消失）；doc-sync 全对拍。 |
| R2-d(1) | ✅ 已落地 | fe91f016 | schema zod 真源回 TS：search_content schema 在 manifest-tools 域内 zod 转录（不再读 kernel-manifests 镜像），逐键等价退役前 manifest 发射，收敛零漂移。**连带修复 R2-a 键位回归**（见下）。 |
| R2-d(2) | ⬜ 未做 | — | 编排真回 TS：glob_filter 编译/输出三形态/分页目前**仍整体在 Rust search_cap.rs**（R2-a 把 builtin.search 扫描体整套迁入能力口，含编排；设计 §1.2「编排回 TS」的分类与实际代码不符——能力口返回的是最终输出形状而非原始命中）。本步 = 能力口收窄为纯扫描返回原始命中 + TS 域内重建编排（schema 真源 + 编排同域），**能力口契约变更**，独立开批。 |

**R2-a 键位回归（2026-09-04 发现并修复，fe91f016）**：searchCapTool 曾摊平 camelCase
参数直呼 search_cap——bridge.rpc()（src-ui/src/bridge.ts）顶层把 camelCase 键强制转
snake_case（fileTypes→file_types 等），而 rpc.rs search_cap 分支读 camelCase 键 →
Agent 路径 search 全部可选参数 + agent_id 静默丢失（仅单字键 directory/pattern 幸免）。
修复 = schema 面维持 camelCase（模型契约零漂移）+ execute 出口 camelCase→snake_case
映射 + rpc.rs 分支改读 snake_case（对齐全仓 IPC 约定）+ agent_id 兼容 `_agent_id`
（worktree 隔离子 Agent 身份不丢）。R2-a 门禁全绿是测试停在 exec 桩层、未穿透真
rpc() 所致——本修复补了穿透断言（kernel-manifest-tools execute 钉测 snake 键）。

**R2-d(2) 推进障碍（下窗注意）**：编排回 TS 需要能力口收窄 + 结果形状调整，牵动
search_cap.rs 重构 + rpc-contract 结果面 + 输出消费方（search 域工具 execute 组装）+
Rust 能力口单测重写。建议独立开批，与本窗 R2-d(1)/R2-c（schema 真源 + 信封退役）
不混合——本窗已把「schema 真源回 TS zod」与「builtin.search 信封退役」做成可独立
交付的试点成果。

**本窗 R2 交付价值**：能力口 = v3 强制层落地范式（search 先例：入口即裁决 + 物理执行 +
审计位）；信封换直呼验证 tool_call 可被能力口取代（R5 拆 tool_call/PluginRegistry 的前置
证据）；schema 真源回 TS zod（R2-d(1)）验证「zod 转录 = manifest 字节零漂移」，是
R3-R5 其余域（web/git/fs/shell/browser/uia/pty/lsp）schema 迁回的前置范式。门禁全绿：
cargo bin 436 passed + lib + platform_boundary、vitest 2441 passed / 4 skipped、biome
0/0、convergence 零漂移、build 全绿、doc-sync 全对拍。
