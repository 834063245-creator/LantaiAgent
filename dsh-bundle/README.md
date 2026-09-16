# @a834063245/hologram-dsh

HoloGram 的代码依赖分析引擎，作为 **DeepSeek Harness bundle 插件** 分发。

装完即在 agent 工具箱里多出一族图查询工具（`mcp__hologram__*`）——直查依赖图，不用让 LLM 逐文件猜源码。
工具面清单以生成物 [`docs/agents/engine-plugin-contract.md`](../docs/agents/engine-plugin-contract.md) 为准，
本页不复述数量。

> 2026-09-16：本包原先还带一个 DSH 侧边栏 3D 星图（viewer + client 半 + `/hologram` 同源路由）。渲染内核随主仓
> 「图谱内置接线退役」删除后，它已无法构建，遂整量拆除——**本包只提供引擎 + MCP 工具面**。
> 施工记录见 [`docs/archive/dsh-viewer-phase2-*.md`](../docs/archive/README.md)。

## 安装

前置：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 且 `dsh` 可用。

```sh
dsh plugin --profile web add @a834063245/hologram-dsh
dsh web
```

postinstall 会按平台从 GitHub Releases 下载引擎二进制（当前：**Windows x64**；Linux/macOS 支持在路上）。
**重启后**生效：`mcp__hologram__*` 工具进入 agent 工具箱（`explore_deps`、`trace_impact`、`preflight_check`、
`detect_cycles`、`fragile_modules`、`analyze_project`、`engine_status` 等）。

> 引擎分析的项目根默认取 DSH 进程的 cwd，可在 profile 的 `cordis.patch.yml` 里覆盖
> `hologram-engine` 行的 `config.projectRoot`（见下「项目根覆盖示例」）。

## 它怎么接进来的（机制）

DSH 的 profile 插件机制：npm 包在 `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
即为一个 bundle。`cordis.patch.yml` 注入两行：

| 行 id | 包 | 作用 |
|-------|----|------|
| `hologram-engine` | 本包 | 解析引擎二进制路径，提供 `hologramEngine` 服务 |
| `hologram-mcp` | `@deepseek-ai/dsh-mcp-client` | stdio 拉起 `hologram-engine serve --project-root <root>`，注册 MCP 工具 |

`failOnStartupError: false`：引擎临时不可用（二进制缺失 / 启动失败）不会拖垮整棵 harness 树。

## 数据生命周期

- **存量优先**：引擎从项目根的 `.hologram/`（SQLite + 快照 + 向量索引）读回已有图，源码未变即秒回
- **watcher 增量**：文件变更走增量更新，图始终新鲜（失败自动回退全量）
- **显式全量**：MCP 侧 `analyze_project` 触发重扫

## 项目根覆盖示例

在 profile 的 `cordis.patch.yml`（或 `$DSH_HOME/cordis.patch.yml`）追加：

```yaml
- id: hologram-engine
  config:
    projectRoot: D:/some/project
```

## 维护边界（重要）

dsh-bundle 是 HoloGram 的**薄发布适配层**，不拥有产品资产：

- 引擎二进制：来自主仓 `engine/` 构建产物（GitHub Release 附件，`scripts/install.mjs` 下载）
- 本包自有代码：`src/index.ts`（host glue）+ `cordis.patch.yml` + `scripts/install.mjs`

## 发布流程（维护者）

1. 本地构建：`cd engine && cargo build --release` → `cd ../dsh-bundle && npm install --ignore-scripts && npm run pack:bin && npm run build`
2. 打 tag `v<version>` 并 push → GitHub Actions `dsh-bundle` job 构建引擎二进制并传到 Release 附件 `hologram-engine-win32-x64.exe`
3. `npm publish`（壳包 ~几十 KB；postinstall 按版本号从 Release 下载二进制）

npm 包：`@a834063245/hologram-dsh`（公开）
二进制：GitHub Release 附件（`https://github.com/834063245-creator/LantaiAgent/releases/download/v<version>/hologram-engine-win32-x64.exe`）

## 本地开发（file: 安装）

```sh
# 1. 构建引擎 + 插件（先装依赖：dsh-bundle 用 --ignore-scripts，避免 postinstall 拉二进制）
cd engine && cargo build --release
cd ../dsh-bundle && npm install --ignore-scripts && npm run pack:bin && npm run build

# 2. 从 DSH checkout 用 file: 装到测试 profile
node --import tsx/esm apps/cli/src/bin.ts plugin --profile hologram-test add file:D:/HoloGramHG/dsh-bundle
```

> 注意：`file:` 是复制语义，改包后需 remove + add 刷新本地副本。
> 包完整性门禁（本机可跑）：`node scripts/ci-verify.mjs`。
