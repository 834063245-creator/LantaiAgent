# src/ui — chat 编排域核心 + 旧层命令式基础设施

> 定位一句话（eventbus-zero-and-ui-split-plan §3.3）：本目录是**chat 编排域核心 + 旧层命令式基础设施**，
> 不是杂物间。2026-08-19 总线归零 + ui/ 拆分（P0-P3）后的终态残余；**2026-08-22 C13 休眠层 sweep
> 删除 9 个死件**（agent-visualizer/chat-utils/context-menu/file-translator+css/file-viewer/
> markdown-file-preview/message-height/pretext-cache——可达性闭包实测零活引用），现 **14 个文件
> （13 ts + 本 README）**，只减不增（守护 `tests/eventbus-zero-and-ui-split.test.ts`，COMPLETE=true）。

## 目录契约

- **新 zustand store 一律落 `src/state/`**，不要落这里。
- **新 React 组件一律落 `src/app/`**，不要落这里。
- **图谱相关类型与渲染面已随图谱全量退役整删**（`src/scene/` 目录不存在、位置兼容 shim `graph.ts` 已删）——不要再新增星图类型或 shim。
- 本目录文件**不改名**（拆分计划 D8：名字 churn 无功能收益）。

## 文件分簇

| 簇 | 文件 | 说明 |
|---|---|---|
| 冻结（禁改） | `chat-session.ts` `chat-stream.ts` `part-mutator.ts` | chat 编排域核心；`agent/execution-state.ts`（在 agent/）同列 |
| chat 编排域 | `chat-store.ts`（聚合入口）`message-model.ts` `tool-semantics.ts` `agent-panel-store.ts` | 面板级 store 四件套在 `src/state/`（scoped/messages/session/panel/input），聚合编排在此 |
| 命令式基础设施 | `runtime-adapter.ts` `lsp-client.ts` `command-registry.ts` `subagent-sink.ts` `resize-zones.ts` `icons.ts` | imperative-DOM/旧层宿主；LspService 是子系统服务化样板 |

## 依赖方向

`state/`（store）← `ui/`（编排消费 store）。
`ui/` 引用 `state/`、`i18n`、`app/shell-store` 均为既定方向；反向（state import ui/）仅限
`message-model` `icons` 这类旧层锚点（见各文件 import）。

> 2026-08-27 死码清扫：`app-shell.ts` / `debug.ts` 删除——可达性闭包零生产引用
> （各测试套件的 vi.mock 是隔离脚手架，非真实依赖）。
