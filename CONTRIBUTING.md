# Contributing

感谢你对兰台的兴趣！

兰台是一个 **Rust 分析引擎 + Tauri 2 桌面壳 + TypeScript/React 前端** 的项目。开工前请先读根目录 [`CONVENTIONS.md`](CONVENTIONS.md) 与 [`INVARIANTS.md`](INVARIANTS.md)，并按 [`AGENTS.md`](AGENTS.md) 的开工清单执行。

## 行为准则

- 保持友善和专业
- 对新人耐心
- 建设性批评

## 如何贡献

### 报告 Bug

1. 在 [Issues](https://github.com/834063245-creator/HoloGram/issues) 搜索是否已有相同报告
2. 使用 Bug Report 模板
3. 提供：
   - 操作系统和版本
   - 兰台版本
   - 最小复现步骤
   - 实际行为 vs 预期行为

### 功能请求

开 Issue 前先在 Discussions 讨论。大的功能请求最好先确认方向。

### 写插件（不改引擎也能贡献）

兰台自身就是插件化架构——面板、命令、工具、块渲染器、prompt 段、管道钩子、capability 全部经贡献通道装载，八条通道对外一致开放。写一个插件不需要碰 Rust 引擎、不需要懂组合层内部，最小路径是一个 `manifest.json` + 一个自包含 ESM 模块：

- **从这开始**：[PLUGINS.md](PLUGINS.md)（根目录插件开发指南——自包含到能照写最小插件，最快 15 分钟跑通）
- 契约全文档：[docs/plugins/README.md](docs/plugins/README.md)（manifest 字段 / 八通道 API / 权限与信任模型 / 生效时机）
- 从零到跑通的最小示例：[examples/plugins/hello/](examples/plugins/hello/README.md)（只读该 README 即可装上、看到效果、干净卸载）
- 更省事的路：外部 MCP server 经 manifest `mcpServers` 声明式挂接，零插件代码

### Pull Request 流程

1. Fork 仓库
2. 创建 feature 分支：`git checkout -b feature/your-feature`
3. 写代码（先读 `CONVENTIONS.md`，照抄现有模式；改高 fan-in 文件前先跑图工具的 preflight/impact）
4. **引擎改动**：
   ```bash
   cd engine && cargo test
   ```
5. **前端改动**：
   ```bash
   cd src-ui && npm run build        # tsc --noEmit + vite build
   cd src-ui && npx vitest run       # 逻辑/契约测试
   cd src-ui && npx biome check --write <改动文件>
   ```
   > 全仓 biome 已于 2026-08-24 清零（0 errors / 0 warnings）：改动文件过 `biome check --write` 后提交，勿引入新违例或 CRLF 行尾。
6. **Agent 运行时改动**（`src-ui/src/agent/**`，agent-core-convergence 门禁）：
   ```bash
   cd src-ui && npm run verify:convergence   # T0 静态 + 8 baseline 对拍；失败即返工
   ```
   > baseline 变更走 `docs/archive/agent-core-convergence/baseline-change-request.md` 审批（record 永不上 CI）。
7. **Tauri 壳改动**：
   ```bash
   cd src-tauri && cargo test        # 权限/生命周期/隔离等
   # 快验：cd src-tauri && cargo check
   ```
8. **桌面发布验证**（涉及打包/发布时）：
   ```bash
   cd src-tauri && cargo tauri build
   ```
   不要用 `cargo build --release` 代替。
9. Commit 遵循 [Conventional Commits](https://www.conventionalcommits.org/)：
   ```
   feat(engine): ...
   fix(ui): ...
   chore(ci): ...
   docs(readme): ...
   ```
10. 推送并发起 PR

### 项目结构

```
engine/               Rust 分析引擎（可独立 serve 为 MCP server）
├── src/
│   ├── graph/        图模型、合并、diff、resolver、句柄化 NodeId/EdgeId
│   ├── adapter/      27 种 tree-sitter 语言适配（18 族专用 .scm 结构查询，共 38 个查询文件）
│   ├── analysis/     耦合/数据流/循环/盲点/explore/flows/框架路由
│   ├── community/    Leiden/Louvain 社区检测
│   ├── pipeline/     发现/解析/并行合并流水线
│   ├── routing/      约束校验与变更路由
│   ├── storage/      MemoryIndex(CSR) + SQLite/FTS5 + GraphStore + 增量更新
│   ├── vector/       MiniLM ONNX 语义向量 + usearch
│   ├── tools/        MCP 工具注册表（36 schema，默认暴露 35）
│   ├── mcp.rs        MCP JSON-RPC 服务
│   └── lsp_manager.rs 原生 LSP 子进程管理
└── queries/          各语言结构/数据流 .scm 查询

src-tauri/            Rust / Tauri 2 桌面壳
├── src/
│   ├── rpc.rs        单一 IPC 入口（134 个方法）
│   ├── commands/     命令实现（graph/git/filesystem/shell/search/web/…）
│   ├── permissions/  权限引擎
│   ├── tools/        Tool trait（Read/Edit/Bash/Git/WebFetch/Browser/Desktop）
│   ├── lifecycle.rs  ResourceLedger + 10 个 LifecycleService
│   ├── llm_proxy.rs  LLM 本地反向代理（绕 CORS）
│   └── utils/        IPC 护栏 / 锁降级 / 路径解析
└── tauri.conf.json

src-ui/               TypeScript 前端（React 19 + Zustand 5 + Three.js + Monaco）
├── src/
│   ├── app/          新观测台壳（单 React 根；新 UI 落这里）
│   ├── ui/           星图 scene + 领域 stores + React 组件
│   ├── agent/        Agent 运行时、领域工具、多 Agent、goal/plan
│   │                 （含 blueprint capability 表 / session-log 事件溯源 / DisposerBag+epoch 生命周期原语）
│   ├── composition/  组合层（S1）：工具行表 tool-rows + prompt-sections + 四 service 注册表
│   ├── provider/     LLM Provider 抽象 + 9 个模型目录（73 模型）+ thinking 档位适配
└── tests/            vitest + jsdom（1339 用例 / 136 文件）
```

### 技术栈

| 层 | 技术 |
|---|---|
| 分析引擎 | Rust · tree-sitter（27 静态语法 + 动态加载）· rayon · parking_lot |
| 存储引擎 | MemoryIndex (CSR) · SQLite + FTS5 · GraphStore · 语义向量（ONNX/usearch） |
| 桌面壳 | Rust · Tauri 2 · portable-pty · worktree 隔离 |
| 前端 | TypeScript strict · React 19 · Zustand 5 · Three.js · Monaco · Vite · zod 4 |
| 工具链 | cargo test · vitest · tsc/vite · Biome |
| 测试基线 | engine 697 · src-tauri 322（bin 308 + 集成 14，全绿）· 前端 1201（2026-08-17 实测） |

### 需要帮助？

- 阅读 [README](README.md)
- 文档总索引：[docs/README.md](docs/README.md)
- 插件开发契约：[docs/plugins/README.md](docs/plugins/README.md)（含从零到跑通的最小示例）
- 查看 [GitHub Discussions](https://github.com/834063245-creator/HoloGram/discussions)
- `docs/MULTI_AGENT_ROADMAP.md` 与 `docs/plans/` 是当前工作台

---

**兰台用自己分析自己。** 跑一次 `cd engine && cargo run -- run analyze_project .`，你就能看到自己的贡献在依赖图里怎么连上整个项目。
