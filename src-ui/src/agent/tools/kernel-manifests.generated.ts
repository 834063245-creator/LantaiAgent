// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 生成物 — scripts/gen-plugin-manifests.cjs 从 src-tauri/src/tool_plugins/*/manifest.json 生成。
// 真源在 Rust 侧 manifest；改动请改 manifest 后重新生成（npm run gen:plugin-manifests），勿手改。
// schema 键序 = zod 发射序（convergence 字节契约），生成器逐字保留，勿规整。

import type { KernelToolManifest } from './manifest-tools';

export const KERNEL_MANIFESTS: readonly KernelToolManifest[] = [
  {
    "id": "builtin.constraints",
    "version": "1.0.0",
    "trust": "system",
    "description": "约束配置读写（自 commands/constraints.rs 拆出，kernel-plugin-runtime P2-1）",
    "capabilities": [
      "filesystem_read",
      "filesystem_write"
    ],
    "tools": [
      {
        "name": "read_constraints",
        "description": "Read the current constraint configuration (hologram.constraints.yaml) for the project. Returns the YAML content. Use to check routing rules, thresholds, and allowlist/denylist settings.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "projectPath": {
              "type": "string",
              "description": "Project root directory path"
            }
          },
          "required": [
            "projectPath"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "write_constraints",
        "description": "Write the constraint configuration (hologram.constraints.yaml) for the project — replaces the whole file. Use after check_boundaries (graph domain) reveals violations worth encoding as standing rules: routing rules, thresholds, allowlist/denylist. Read the current config with fs(constraints) first so you extend existing rules rather than drop them.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "projectPath": {
              "type": "string",
              "description": "Project root directory path"
            },
            "content": {
              "type": "string",
              "description": "Full YAML content to write"
            }
          },
          "required": [
            "projectPath",
            "content"
          ],
          "additionalProperties": {}
        }
      }
    ]
  },
  {
    "id": "builtin.editor",
    "version": "1.0.0",
    "trust": "system",
    "description": "代码编辑器（自 commands/editor.rs 拆出，kernel-plugin-runtime P2-1）",
    "capabilities": [
      "filesystem_read",
      "filesystem_write"
    ],
    "tools": [
      {
        "name": "edit_file",
        "description": "Perform exact string replacement in a file. The old_string must match exactly (including indentation and whitespace) and must be unique in the file (unless replace_all is true). This is the preferred way to modify code — safer and cheaper than rewriting the entire file.",
        "read_only": false,
        "permission": {
          "family": "Edit",
          "path_key": "filePath"
        },
        "schema": {
          "type": "object",
          "properties": {
            "filePath": {
              "type": "string",
              "description": "Absolute path to the file to modify"
            },
            "oldString": {
              "type": "string",
              "description": "The exact text to find and replace (must match the file exactly, including whitespace)"
            },
            "newString": {
              "type": "string",
              "description": "The text to replace it with (must be different from oldString)"
            },
            "replaceAll": {
              "default": false,
              "description": "Replace all occurrences instead of just the first (default: false). Use when the old_string appears multiple times.",
              "type": "boolean"
            },
            "_forceGate": {
              "description": "Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.",
              "type": "boolean"
            }
          },
          "required": [
            "filePath",
            "oldString",
            "newString"
          ],
          "additionalProperties": {}
        }
      }
    ]
  },
  {
    "id": "builtin.lsp",
    "version": "1.0.0",
    "trust": "system",
    "description": "LSP 语言服务器会话（自 rpc.rs LSP 分区拆出，kernel-plugin-runtime P2-6）",
    "capabilities": [
      "lsp"
    ],
    "tools": [
      {
        "name": "lsp_start",
        "description": "Start an LSP server for a language over a workspace root. Returns the numeric session id.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "language": {
              "type": "string",
              "description": "Language id (e.g. typescript, rust, python)"
            },
            "root_uri": {
              "type": "string",
              "description": "Workspace root file:// URI"
            }
          },
          "required": [
            "language",
            "root_uri"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "lsp_request",
        "description": "Send a JSON-RPC request/notification to an LSP session. Returns the JSON-RPC result.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "session_id": {
              "type": "integer",
              "description": "LSP session id"
            },
            "method": {
              "type": "string",
              "description": "JSON-RPC method"
            },
            "params": {
              "type": "object",
              "description": "JSON-RPC params (optional for notifications)"
            }
          },
          "required": [
            "session_id",
            "method"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "lsp_stop",
        "description": "Stop an LSP server session.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "session_id": {
              "type": "integer",
              "description": "LSP session id"
            }
          },
          "required": [
            "session_id"
          ],
          "additionalProperties": {}
        }
      }
    ]
  },
  {
    "id": "builtin.pty",
    "version": "1.0.0",
    "trust": "system",
    "description": "PTY 终端会话（自 rpc.rs PTY 分区拆出，kernel-plugin-runtime P2-6）",
    "capabilities": [
      "pty"
    ],
    "tools": [
      {
        "name": "pty_spawn",
        "description": "Spawn an interactive PTY shell session. Returns the numeric session id.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "cwd": {
              "type": "string",
              "description": "Working directory for the shell"
            },
            "shell": {
              "type": "string",
              "description": "Optional shell command (default: cmd.exe on Windows)"
            },
            "cols": {
              "type": "integer",
              "description": "Initial terminal width in columns"
            },
            "rows": {
              "type": "integer",
              "description": "Initial terminal height in rows"
            }
          },
          "required": [
            "cwd",
            "cols",
            "rows"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "pty_write",
        "description": "Write raw input data to a PTY session.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "session_id": {
              "type": "integer",
              "description": "PTY session id"
            },
            "data": {
              "type": "string",
              "description": "Input data to write"
            }
          },
          "required": [
            "session_id",
            "data"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "pty_resize",
        "description": "Resize a PTY session terminal window.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "session_id": {
              "type": "integer",
              "description": "PTY session id"
            },
            "cols": {
              "type": "integer",
              "description": "New width in columns"
            },
            "rows": {
              "type": "integer",
              "description": "New height in rows"
            }
          },
          "required": [
            "session_id",
            "cols",
            "rows"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "pty_kill",
        "description": "Terminate a PTY session and its child process tree.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "session_id": {
              "type": "integer",
              "description": "PTY session id"
            }
          },
          "required": [
            "session_id"
          ],
          "additionalProperties": {}
        }
      }
    ]
  },
  {
    "id": "builtin.web",
    "version": "1.0.0",
    "trust": "system",
    "description": "Web 搜索与抓取（自 commands/web.rs 拆出，kernel-plugin-runtime Phase 1 续批）",
    "capabilities": [
      "network"
    ],
    "tools": [
      {
        "name": "web_search",
        "description": "Search the internet for real-time information. Uses a free anonymous search API first; if it fails, automatically falls back to Bing/DuckDuckGo scraping. No API key required.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Search keywords"
            },
            "maxResults": {
              "default": 10,
              "description": "Number of results to return (default 10, max 10)",
              "type": "integer",
              "minimum": 1,
              "maximum": 10
            }
          },
          "required": [
            "query"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "web_fetch",
        "description": "Fetch a URL and return its text content. HTML pages are reduced to readable text (scripts, styles, tags stripped). JSON / plain text / markdown pass through verbatim. Use to read documentation, API responses, or source files hosted on the web. 15s timeout, 1 MiB max.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "url": {
              "type": "string",
              "description": "The URL to fetch (HTTPS or HTTP only)"
            }
          },
          "required": [
            "url"
          ],
          "additionalProperties": {}
        }
      }
    ]
  },
];
