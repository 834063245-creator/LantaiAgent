# AGENTS.md — 兰台（Lantai）项目 · 薄指针

> **本文件不是规则正文。规则正文 = [`CLAUDE.md`](CLAUDE.md)**（唯一权威 L0 文件，与内置兰台 Agent、
> Claude Code 注入的是同一份）。**读 AGENTS.md 的 Agent（Codex / 其他项目级 Agent）：开工前必读
> `CLAUDE.md`，再读 [`CONVENTIONS.md`](CONVENTIONS.md) 与 [`INVARIANTS.md`](INVARIANTS.md)。**
>
> 2026-09-16 文档面重构 P1：本文件原 49 KB 正文与 CLAUDE.md 大量重复，两份合计 74 KB **超过 harness
> 的 64 KB 指令预算**（实测：AGENTS.md 被整份丢弃 = 手册根本没进上下文）。瘦身为指针后二者合计
> ~17 KB，两份都能进上下文。原正文在 git 史里（`git log -- AGENTS.md`）；其中**规则类**内容已迁
> `CONVENTIONS.md` §2.4 / §2.5 / §3 尾注，**现状类**内容归 `ARCHITECTURE.md`。

## 三条铁律（摘要——全文与细则见 `CLAUDE.md`）

1. **开工顺序**：动任何代码前先读 `CONVENTIONS.md`；碰 `src-ui/src/ui/**` · `src-ui/src/agent/**` · Rust 接缝
   前读 `INVARIANTS.md` 并 grep 目标文件的 `⚠️ INVARIANT` 注释；先抄同类文件，不发明新状态/通信/工具定义。
2. **破坏性操作已授权**（2026-08-25 用户拍板）：不合理的行为、兼容层、死抽象默认**拆除**而非兼容，
   一切由测试工程兜底、以结果论对错；授权范围与测试面铁律见 `CLAUDE.md` 头部。
3. **门禁不过不 commit**；提问纪律见 `CONVENTIONS.md` §0.5（**每批次最多一个问题**，只上交「只有用户能给
   的输入 / 不可逆且代价大 / 证据两边打平」三类）；文档体量纪律见 §4（入口必须小、重复即负债）。

## 门禁速查

| 改动 | 命令 |
|---|---|
| 前端 | `cd src-ui && npm run build` |
| 前端逻辑 | `cd src-ui && npx vitest run`（本机先 `$env:NODE_ENV='test'`） |
| Agent 运行时 / 组合层 | `cd src-ui && npm run verify:convergence`（双轨 standard + minimal） |
| 前端格式 | `cd src-ui && npx biome ci .`（0/0 保持） |
| 引擎 / 壳 | `cd engine && cargo test` / `cd src-tauri && cargo test` |
| 生成物文档 | `cd src-ui && npm run doc-sync` |
| 文档面 | `cd src-ui && npm run doc-check`（逐查清单见 `scripts/doc-check.cjs` 头注；`--report` 看漂移） |

> 基线数字与测试运行纪律（含 `cargo` 假挂、`hologram-engine.exe` 禁杀等本机实测）见
> `CONVENTIONS.md` §3；数字会漂移，以重新实测为准。

## 现状去哪读（只信这些）

| 想找什么 | 去哪 |
|---|---|
| 规则与雷区 | `CONVENTIONS.md` · `INVARIANTS.md` · `docs/adr/project-constitution.md`（四条最高架构约定） |
| 架构 / 目录结构 / 引擎面 / 验证基线 | `ARCHITECTURE.md` |
| 现在在哪 / 还剩什么 / 谁判断 | `docs/plans/README.md`（时间轴 `docs/plans/HISTORY.md`） |
| 文档总索引 | `docs/README.md` |
| 跨文档数字（字段数 / 插件数 / 契约版本 / 域数） | `docs/facts.generated.md`（生成物——**禁手抄**，改真源后重跑 `npm run gen:doc-facts`） |
| 模型可见工具面 | `docs/agents/model-tool-contract.md`（生成物·勿手改） |
| 插件契约 / 用户向插件指南 | `docs/plugins/README.md` · `PLUGINS.md` |
| 组合层与 preset / 插件激活 | `docs/composition/README.md` · `docs/plugins/README.md` |
| 技术债与拆弹状态 | `docs/landmine-map.md` |
| 应用级词汇 | `CONTEXT.md` |
| 历史（不是现状） | `docs/archive/README.md` |
