# 引擎扩展 manifest 示例（免编译扩展面 · engine-plugin-extraction Phase 4）

本目录是 `HOLOGRAM_PLUGIN_DIR` 的示例扩展集：**三份 manifest，零行 Rust**，
展示引擎三类免编译扩展的完整写法。

## 试跑

```powershell
$env:HOLOGRAM_PLUGIN_DIR = "D:<仓库路径>\examples\engine-plugins"
hologram-engine.exe serve --project-root <任意项目根>
# 另一会话经 MCP：engine_status → extensions 字段可见三份已装载扩展
```

目录缺省查找顺序：`HOLOGRAM_PLUGIN_DIR` env（设了就用）→ `<project_root>/plugins`（存在才用）→ 无扩展。

## 三类扩展

### 1. `mylang.yml` — 语言扩展

声明新扩展名 `.myl`：复用已静态注册的 python 语法（`grammar.builtin`），
结构/数据流分析走本目录的 `.scm` 查询（运行时读盘，非编译期 include_str!）。

```yaml
manifest_version: 1
kind: language
name: mylang
extensions: [".myl"]
grammar:
  builtin: python          # 复用静态语法；或 dll: <路径> + symbol: <导出符号>
queries:
  structure: ./queries/mylang_structure.scm
  dataflow: ./queries/mylang_dataflow.scm
func_kinds: [function_definition]
class_kinds: [class_definition]
```

- `grammar.dll`：显式 cdylib（相对 manifest 文件解析路径，`symbol` 缺省
  `tree_sitter_{name}`）——即 grammar_loader 的 libloading 通道。
- 与内置扩展名冲突 → 装载期报错（`engine_status.extensions.errors` 可见），不静默遮蔽。

### 2. `pagesfw.yml` — 框架扩展

路由候选模式（glob，`**` 跨目录 / `*` `?` 单段）：命中文件注入 route 节点
（URL = 剥模式前缀 + 剥扩展名）。属性 `framework: pagesfw`。

```yaml
manifest_version: 1
kind: framework
name: pagesfw
routes:
  - pattern: "pages/**/*.page.myl"
    method: GET            # 缺省 GET
```

### 3. `mytools.yml` — 工具扩展

新增模型可见工具：schema 由 manifest 声明，执行复用既有 handler
（`handler` 必须是 `tools::builtin_handler` 注册表内的 id；壳专属方法不入表）。
**不引入任意代码执行**——manifest 工具 = 既有能力的新 schema 面。

```yaml
manifest_version: 1
kind: tool
name: myfw_list_pages
description: List pages known to the pagesfw framework
read_only: true
handler: search_symbols     # 按 id 复用内置 handler
params:
  - name: query
    ptype: string
    description: symbol name query
    required: true
```

## 失败语义

单份 manifest 装载失败（坏 yaml / 未知字段 / 未知版本 / 撞名 / 缺文件）只记入
`engine_status.extensions.errors` + warn 日志，**不阻断引擎启动**；其余 manifest 照常装载。

## 兼容管控

- `manifest_version`：引擎只认自己支持的版本，未知版本 = 该 manifest 报错拒绝。
- 引擎开放面（`ENGINE_CONTRACT_VERSION`）变更记录见 `engine/src/contract.rs`。
