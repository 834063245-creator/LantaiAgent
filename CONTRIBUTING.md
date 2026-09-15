# Contributing

感谢你对兰台的兴趣！

兰台是一个 **桌面 Agent 应用（Tauri 2 壳 + TypeScript/React 前端）** 的项目，随包配套一个独立的 **HoloGram 代码图谱引擎**（Rust，stdio MCP，默认关）。开工前请先读根目录 [`CONVENTIONS.md`](CONVENTIONS.md) 与 [`INVARIANTS.md`](INVARIANTS.md)，并按 [`CLAUDE.md`](CLAUDE.md)（唯一权威项目规范）的开工清单执行——[`AGENTS.md`](AGENTS.md) 是它的薄指针。

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

兰台自身就是插件化架构——面板、命令、工具、块渲染器、prompt 段、管道钩子、capability 全部经贡献通道装载，**全部贡献通道 + 可换后端 seam 对外一致开放**（清单与计数以生成物 [`docs/agents/service-catalog.md`](docs/agents/service-catalog.md) 为准，别手抄）。写一个插件不需要碰 Rust 引擎、不需要懂组合层内部，最小路径是一个 `manifest.json` + 一个自包含 ESM 模块：

- **从这开始**：[PLUGINS.md](PLUGINS.md)（根目录插件开发指南——自包含到能照写最小插件，最快 15 分钟跑通）
- 契约全文档：[docs/plugins/README.md](docs/plugins/README.md)（manifest 字段 / 通道 API / 权限与信任模型 / 生效时机）
- 从零到跑通的最小示例：[examples/plugins/hello/](examples/plugins/hello/README.md)（只读该 README 即可装上、看到效果、干净卸载）
- 更省事的路：外部 MCP server 经 manifest `mcpServers` 声明式挂接，零插件代码

### Pull Request 流程

1. Fork 仓库
2. 创建 feature 分支：`git checkout -b feature/your-feature`
3. 写代码（先读 `CONVENTIONS.md`，照抄现有模式；改高 fan-in 文件前先查影响面——应用内图工具面已随图谱内置接线退役，内置 Agent 用 `search` 域 + `fs(read)`；兰台之外的 MCP 客户端仍有引擎图工具 `trace_impact` / `preflight_check`）
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

> **全量结构树与每一层职责的唯一真源 = [`ARCHITECTURE.md`](ARCHITECTURE.md) §9**（含 engine/src、
> src-tauri/src、src-ui/src 与运行时数据目录四处清单，随代码校准）。这里只给顶层地图：

```
engine/          HoloGram 分析引擎（Rust；独立二进制，stdio MCP `serve` + CLI `run <tool> [path]`）
hologram-graph/  图类型层 crate       hologram-storage/  数据家层 crate
hologram-vector/ 向量检索层 crate      src-tauri/         Tauri 2 桌面壳（rpc.rs 单一 IPC 入口）
src-ui/          TypeScript 前端（React 19 + Zustand 5 + Vite + Monaco）
├── src/app/         应用壳与面板（新 UI 落这里）
├── src/state/       zustand 状态层（领域 / 面板 / 信号 store）
├── src/agent/       Agent 运行时、工具层、多 Agent、goal/plan
├── src/composition/ 组合层（贡献通道内核 + 三层装配面 + preset）
├── src/ui/          chat 编排域核心 + 旧层命令式基础设施（目录契约见 src/ui/README.md）
└── tests/           vitest + jsdom
docs/            文档（入口 docs/README.md；`archive/` 是历史勿作现状）
```

树内各目录另有自己的 `README.md` 讲目录契约；**数字（语言数、工具数、用例数、方法数）一律以生成物
或真源为准**——[`docs/facts.generated.md`](docs/facts.generated.md) 是跨文档标量的单一真源。

### 技术栈

| 层 | 技术 |
|---|---|
| 分析引擎 | Rust · tree-sitter（语言清单真源 = `engine/Cargo.toml`）· rayon · parking_lot |
| 存储引擎 | MemoryIndex (CSR) · SQLite + FTS5 · GraphStore · 语义向量（ONNX/usearch） |
| 桌面壳 | Rust · Tauri 2 · portable-pty · MCP 受治进程治理 · 权限引擎 |
| 前端 | TypeScript strict · React 19 · Zustand 5 · Monaco · Vite · zod 4 · Biome |
| 工具链 | cargo test · vitest · tsc/vite · Biome |
| 测试基线 | 见 [`CONVENTIONS.md`](CONVENTIONS.md) §3（数字会漂移，以重新实测为准） |

### 需要帮助？

- 阅读 [README](README.md)
- 文档总索引：[docs/README.md](docs/README.md)
- 插件开发契约：[docs/plugins/README.md](docs/plugins/README.md)（含从零到跑通的最小示例）
- 查看 [GitHub Discussions](https://github.com/834063245-creator/HoloGram/discussions)
- `docs/MULTI_AGENT_ROADMAP.md` 与 `docs/plans/` 是当前工作台

---

**兰台用自己分析自己。** 跑一次 `cd engine && cargo run -- run analyze_project .`，你就能看到自己的贡献在依赖图里怎么连上整个项目。
