# 前端 RPC 契约（生成物）

> 由 `scripts/gen-rpc-contract-md.cjs` 从 `src-tauri/src/rpc.rs` 生成 — 勿手改。
> 生成时间：2026-09-05T11:00:17.472Z
> 方法总数：56（rpc.rs 头注释为历史数字，以此表为准）

前端类型化入口：`src-ui/src/rpc-contract.ts`（`typedRpc` / `typedListen`，编译期接线检查）。

约定：参数键一律 snake_case；返回均为字符串，`JSON 字符串` 类需 `JSON.parse`（`null` 为 unit 返回）。


## 应用层：数据上下文（L1）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `context_list` | — | — | 字符串 |

## Engine 调度

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `hologram_call` | tool | workspace, args | 字符串 |
| `hologram_tools_list` | — | — | 字符串 |

## Graph

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `load_graph_json` | — | path | 字符串 |
| `analyze_and_load` | path | force | 字符串 |
| `get_graph_snapshot` | — | — | 字符串 |
| `hologram_file_nodes` | file | — | 字符串 |

## 内核插件运行时（tool_call）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `tool_call` | plugin, tool | is_agent, args | 字符串 |
| `plugin_tool_manifests` | — | — | 字符串 |

## 能力口（search_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `search_cap` | directory, pattern | is_agent, agent_id, _agent_id, file_types, use_regex, collect_lines, glob_filter, max_matches, max_files, context_lines | 字符串 |

## 能力口（fs_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `fs_cap` | action | is_agent, agent_id, _agent_id, path, from, to, file_path, pattern, dir, content, line_numbers, filter_ignored, workspace_root, paths | 字符串 |

## 能力口（git_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `git_cap` | action, repo_path | is_agent, agent_id, _agent_id, file, message, branch, files, count | 字符串 |

## 能力口（process_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `process_cap` | action | is_agent, agent_id, _agent_id, owner_id, _owner_id, command, cwd, sticky_cwd, run_in_background, stream_tool_id, interpreter, capture_cwd, timeout_ms, job_id, wait_timeout_ms | 字符串 |

## 能力口（browser_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `browser_cap` | action | is_agent, agent_id, _agent_id | 字符串 |

## 能力口（uia_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `uia_cap` | action | is_agent, agent_id, _agent_id | 字符串 |

## 能力口（web_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `web_cap` | action | is_agent, agent_id, _agent_id | 字符串 |
| `constraints_cap` | action | is_agent, agent_id, _agent_id | 字符串 |
| `pty_cap` | action | is_agent, agent_id, _agent_id | 字符串 |
| `lsp_cap` | action | is_agent, agent_id, _agent_id | 字符串 |

## 能力口（constraints_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `editor_cap` | action | is_agent, agent_id, _agent_id | 字符串 |

## 能力口（pty_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `protocol_bridge_spawn` | id, command, args | — | 字符串 |
| `protocol_bridge_write` | id, line | — | 字符串 |
| `protocol_bridge_kill` | id | — | 字符串 |

## 能力口（lsp_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `permission_ask_response` | request_id, allow | remember, rule_to_add, rule_behavior | `null`（unit） |
| `set_permission_mode` | mode | — | `null`（unit） |
| `credential_store` | provider, key | — | `null`（unit） |
| `credential_get` | provider | — | JSON 字符串 |
| `credential_delete` | provider | — | `null`（unit） |
| `llm_proxy_port` | — | — | 字符串 |

## 能力口（editor_cap）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `plugin_install` | — | expect_name, force | JSON 字符串 |
| `plugin_uninstall` | name | — | `null`（unit） |
| `plugin_dir` | name | — | JSON 字符串 |
| `plugin_set_enabled` | name, enabled | — | `null`（unit） |

## MCP / ACP stdio 桥

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `agent_isolation_create` | agent_id | — | 字符串 |
| `agent_isolation_diff` | agent_id | — | 字符串 |
| `agent_isolation_merge` | agent_id | — | 字符串 |
| `agent_isolation_discard` | agent_id | — | 字符串 |
| `agent_isolation_status` | — | — | 字符串 |
| `agent_isolation_force_purge` | agent_id | — | 字符串 |

## 身份认证 / 权限

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `sandbox_status` | — | — | 字符串 |

## 插件安装通道

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `hologram_run_check` | — | path | 字符串 |
| `hologram_record_event` | event_type, summary | file | `null`（unit） |

## Agent 隔离（worktree）

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `workspace_activate` | path | graph_engine | `null`（unit） |
| `workspace_deactivate` | — | — | `null`（unit） |
| `workspace_start_watcher` | — | — | `null`（unit） |
| `get_last_project` | — | — | JSON 字符串 |
| `workspace_list` | — | — | JSON 字符串 |
| `workspace_rename` | path, name | — | `null`（unit） |
| `workspace_toggle_pin` | path | — | `null`（unit） |
| `workspace_remove` | path | — | `null`（unit） |
| `workspace_set_graph_engine` | path | — | `null`（unit） |
| `workspace_create_dir` | name | — | JSON 字符串 |

## 外部服务

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `agent_session_append` | project_path, agent_id | — | `null`（unit） |

## Hologram 遗留命令

| 方法 | 必选参数 | 可选参数 | 返回 |
|------|----------|----------|------|
| `dataflow_save` | query | content, explore_result, dataflow_result | 字符串 |
| `dataflow_query` | — | trace_id, list | 字符串 |
| `dataflow_delete` | trace_id | — | 字符串 |

## 事件（Rust 侧 emit → 前端 listen）

payload 类型见 `src-ui/src/rpc-contract.ts` 的 `EventContract`（前端类型化入口 `typedListen`）。

| 事件名 | 发射源 |
|--------|--------|
| `analyze-heartbeat` | src-tauri/src/workspace.rs |
| `analyze-phase` | src-tauri/src/workspace.rs |
| `analyze-progress` | src-tauri/src/workspace.rs |
| `composition:changed` | src-tauri/src/composition_watcher.rs |
| `graph-updated` | src-tauri/src/workspace.rs |
| `lsp-message` | src-tauri/src/lsp_manager.rs |
| `permission-ask` | src-tauri/src/utils/path_resolve.rs |
| `protocol-bridge:exit` | src-tauri/src/commands/protocol_bridge.rs |
| `pty-output` | src-tauri/src/pty_manager.rs |
| `shell:done` | src-tauri/src/commands/process_cap.rs |
| `shell:output` | src-tauri/src/commands/process_cap.rs |

> `goal:state` 等事件为前端内部 EventBus（非 IPC），不走 listen。
