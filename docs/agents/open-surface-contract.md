# 开放面契约（Open Surface Contract）

> 平台化 Phase 3 · P3-C4（2026-08-27）。seam 接口面是三方（外部插件 / 动态
> 插件 / MCP 之上的 provider 层）共同依赖的契约——变更必须显式升版 + 记录，
> 不得静默改约。机制对齐 DSH `SESSION_FORMAT_VERSION`。
>
> **本文件由守护测试对拍**（`tests/seam-contract-version.test.ts` +
> `doc-sync` 门禁里的 `check:contract-fingerprint`）：契约文件清单的 sha256
> 指纹记录在下方标记行，**文件变更未升版/未更新指纹 = 红**。

当前版本：1

<!-- contract-fingerprint: 9f1f1a3030e7d6bde3a3207f87361db096f970c6b9b7f4a2383b08fe192a6aa6 -->

## 契约面载体（`src/composition/contract-version.ts` 单一真源）

| 文件 | 契约内容 |
|---|---|
| `src/composition/services.ts` | `ctx.llm`（`LlmAdapterContribution`）+ ContributionRegistry 内核 + panels/commands/tools 通道 def 形状 |
| `src/composition/fs-service.ts` | `ctx.fs`（`FsProvider` / `FsAction` 11 动作 / `FsCallOptions` dispatch 腰） |
| `src/composition/shell-service.ts` | `ctx.shell`（`ShellProvider` / `ShellAction` 四动作；subprocess 并入） |
| `src/composition/session-persistence-service.ts` | `ctx.sessionPersistence`（六动词 provider + `sessionExecute` 消费单点） |
| `src/composition/graph-service.ts` | `ctx.graph`（`GraphProvider.invoke` + `graphExecute` 消费单点） |
| `src/composition/subagent-service.ts` | `ctx.subagents`（`SubagentProvider` / `SubAgentSpawnArgs·Outcome`） |
| `src/composition/seam-resolution.ts` | seam 裁剪面（`SEAM_DOMAINS` 七域 / `SeamDisabledMap` / patch `seam/<域>` 域契约） |
| `src/agent/events.ts` | D4 事件面（`AGENT_EVENT_MAP` mode 表 / `LoopEventPayload` 载荷形状 / 监听契约） |
| `src/plugins/types.ts` | 插件 manifest schema（name/version/inject/permissions/tools/mcpServers） |

## 变更记录

| 版本 | 日期 | 变更 | 依据 |
|---|---|---|---|
| 1 | 2026-08-27 | 初版：六 seam + 裁剪面 + 事件面 + manifest 契约入册（P3-C4） | agent-platformization-plan Phase 3 |

## 变更流程（guard 红 → 修复四步）

1. 改契约文件（接口形状 / 注册契约 / 事件载荷 / manifest schema）；
2. `src/composition/contract-version.ts` 的 `OPEN_SURFACE_CONTRACT_VERSION` +1；
3. 本文件「变更记录」加一行（版本 / 日期 / 变更内容 / 依据）；
4. `npm run gen:contract-fingerprint` 更新指纹标记行——四步同 commit。

指纹是**粗粒度**的（原文 sha256——注释改动也会变指纹）：契约面宁可多升版，
不静默漂移；这是刻意取舍不是缺陷。纯注释整理不涉及语义时，同样走四步
（变更记录里如实写「注释整理，无语义变更」即可）。
