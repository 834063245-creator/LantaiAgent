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
    "id": "builtin.uia",
    "version": "1.0.0",
    "trust": "system",
    "description": "Windows 桌面 UIA 控制（自 rpc.rs desktop 分区拆出，kernel-plugin-runtime P2-5）",
    "capabilities": [
      "desktop"
    ],
    "tools": [
      {
        "name": "desktop_probe",
        "description": "Snapshot current machine process tree + top-level windows + visible console windows, WITH per-window channel routing advice (route.channel: \"cdp\" for Chromium windows → browser tools; \"uia\" for standard-control windows → desktop_uia_*; \"vision\" for self-drawn apps → uia_window_shot + multimodal). Returns {processes:[{pid,ppid,name,is_chromium}], windows:[{pid,name,title,visible,hwnd,route}], visible_console_windows}. route:false param skips UIA probing for a faster bare snapshot. Use to find which window to operate and HOW to operate it. Read-only; no persistent monitoring. Privacy: only process names (not full command lines); no cross-session/RDP probing.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "route": {
              "description": "Attach per-window channel routing advice (default true); false = bare snapshot, faster",
              "type": "boolean"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_screenshot",
        "description": "Capture a full-screen screenshot of the current desktop (requires an interactive desktop session). Saved to a temp file; returns {path, bytes, note}. High-privacy: may contain arbitrary on-screen content, so this asks for approval EVERY time. With a text-only model the image is not visible; hand the path to the user for confirmation.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {},
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_tree",
        "description": "Read the Windows UI Automation control tree of a desktop window — interactive controls only by default (buttons, inputs, lists, menus...), paginated. Returns {window:{pid,title,hwnd}, refs, generation, total, offset, count, truncated, tree:\"[ref] Type \\\"Name\\\"\", controls:[{ref,name,type,automation_id,enabled,rect,depth}]}. Locate the window by ONE of: hwnd (exact, from desktop_probe), pid, title (fuzzy), or omit all for the foreground window. all:true includes non-interactive layout elements; depth:N limits tree levels; offset/max_results paginate (default 80/page). refs index the FULL tree and stay reusable across actions and pages; if the window changed and a ref went stale, the action auto-refreshes once — only re-read the tree when that fails. Reading never touches focus or cursor. Self-drawn controls (WeChat/QQ/DingTalk etc.) expose an empty tree — use desktop_uia_window_shot + a vision model instead.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "hwnd": {
              "description": "Window handle from desktop_probe (hwnd field)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id - resolves to its main window",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring (fuzzy, first match)",
              "type": "string"
            },
            "depth": {
              "description": "Limit tree to N levels (real hierarchy with indentation)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "all": {
              "description": "Include non-interactive layout elements (default false = interactive only)",
              "type": "boolean"
            },
            "offset": {
              "description": "Skip this many listed controls (for paging; default 0)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "max_results": {
              "description": "Max controls per page (default 80)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_find",
        "description": "Find controls inside a desktop window by criteria (name fuzzy / control_type / automation_id / enabled). Interactive controls only by default (all:true for everything). Returns matching controls with their refs for later actions. Use instead of a full tree when you already know what kind of control you need — cheaper than uia_tree.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "hwnd": {
              "description": "Window handle from desktop_probe",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            },
            "name": {
              "description": "Control name substring (case-insensitive)",
              "type": "string"
            },
            "control_type": {
              "description": "e.g. Button, Edit, ListItem, MenuItem, CheckBox",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "enabled": {
              "description": "Filter by enabled state",
              "type": "boolean"
            },
            "all": {
              "description": "Include non-interactive elements (default false)",
              "type": "boolean"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_read",
        "description": "Read full detail of ONE control: value (password-masked), toggle state, expand state, scroll percents, rect, and the list of patterns it supports. Use after an action to verify the result (feedback loop), or before acting to see which patterns are available. Locate by ref or selector, same as the action tools. Read-only.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "ref": {
              "description": "Control ref from desktop_uia_tree/find",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "name": {
              "description": "Control name, exact match case-insensitive",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType, e.g. Button, Edit",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_wait",
        "description": "Wait until a control satisfies a condition: until \"exists\" (appears), \"enabled\", or \"value\" (equals the given value). Polls every 150ms up to timeout_ms (default 10000, max 30000). Returns {found, until, waited_ms} — found:false on timeout is NOT an error. Use after clicking async-triggering buttons (e.g. dialogs that take a moment).",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "until": {
              "type": "string",
              "enum": [
                "exists",
                "enabled",
                "value"
              ],
              "description": "Condition to wait for"
            },
            "value": {
              "description": "Expected value (required when until=value)",
              "type": "string"
            },
            "timeout_ms": {
              "description": "Max wait in ms (default 10000, max 30000)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "ref": {
              "description": "Control ref from desktop_uia_tree/find",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "name": {
              "description": "Control name, exact match case-insensitive",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "required": [
            "until"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_click",
        "description": "Click a control in a desktop window. Locate by EITHER ref (from desktop_uia_tree/find) OR selector: name/automation_id/control_type - any combination. Triggers via InvokePattern/TogglePattern/SelectionItemPattern when available (no focus stealing), else real coordinate click (physical input). Returns world-change feedback: {done, method, target, changed:{window_title/focused/value/toggle before→after}, hint}. Permissions: first write into a window asks once (window takeover); sensitive targets (submit/pay/delete/confirm text) and coordinate clicks ask separately every time. Check \"changed\" to verify the click did what you expected; use desktop_uia_read/wait to double-check.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "ref": {
              "description": "Control ref from desktop_uia_tree/find (use instead of name/automation_id/control_type)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "name": {
              "description": "Control name, exact match case-insensitive (e.g. \"Equals\", \"Seven\")",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id (e.g. \"equalButton\", \"num7Button\")",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType, e.g. Button, Edit, ListItem, MenuItem, CheckBox",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle (re-locate if tree changed)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_right_click",
        "description": "Right-click a control — opens the context menu at the control center. Pure physical input (no UIA pattern for right-click), always asks. Locate by ref or selector (see desktop_uia_click). After the menu opens, read it with desktop_uia_tree and click items by ref.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "ref": {
              "description": "Control ref from desktop_uia_tree/find",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "name": {
              "description": "Control name, exact match case-insensitive",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType, e.g. Button, Edit, ListItem",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_type",
        "description": "Type text into a control. ValuePattern.SetValue when supported (instant, no focus), else focus + clipboard paste (physical input, asks separately). Returns world-change feedback incl. value before→after (password fields masked). Typing into a pre-filled input or a password field is classified sensitive and asks separately.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "ref": {
              "description": "Control ref (usually an Edit/ComboBox)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "text": {
              "type": "string",
              "description": "Text to type"
            },
            "name": {
              "description": "Control name, exact match case-insensitive",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType, e.g. Edit, ComboBox",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "required": [
            "text"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_scroll",
        "description": "Scroll a scrollable control (ScrollPattern when available, else mouse wheel — wheel is physical input and asks separately). Returns world-change feedback incl. scroll percents before→after. Scroll itself is non-destructive; with window takeover granted it flows without asking.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "ref": {
              "description": "Control ref (scrollable pane/list)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "direction": {
              "type": "string",
              "enum": [
                "up",
                "down",
                "left",
                "right"
              ],
              "description": "Scroll direction"
            },
            "amount": {
              "description": "Scroll amount (>=1 large step, <1 small step; wheel ticks); default 1",
              "type": "number"
            },
            "name": {
              "description": "Control name, exact match case-insensitive",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType, e.g. Pane, List, ScrollBar",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "required": [
            "direction"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_select",
        "description": "Explicitly select a list item / tree item / tab (SelectionItemPattern.Select). Cleaner than clicking list entries — use for ListItems, TreeItems, TabItems, radio-like items. Returns world-change feedback.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "ref": {
              "description": "Control ref (the ListItem/TreeItem/TabItem to select)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "name": {
              "description": "Item name, exact match case-insensitive",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType: ListItem, TreeItem, TabItem...",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_expand",
        "description": "Expand/collapse a ComboBox dropdown or tree node (ExpandCollapsePattern, idempotent toggle: expanded→collapse, collapsed→expand). After expanding a combo, read the item list with desktop_uia_tree/find and select with desktop_uia_select. Returns world-change feedback incl. expand state before→after.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "ref": {
              "description": "Control ref (the ComboBox/TreeItem to toggle)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "name": {
              "description": "Control name, exact match case-insensitive",
              "type": "string"
            },
            "automation_id": {
              "description": "Exact automation id",
              "type": "string"
            },
            "control_type": {
              "description": "ControlType: ComboBox, TreeItem...",
              "type": "string"
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_keys",
        "description": "Send a hotkey to a window (SendInput, real keyboard injection): key + modifiers (ctrl/alt/shift/meta). Examples: Ctrl+A, Delete, Enter, F5. Physical input — asks every time and is serialized globally (input lease) so concurrent agents cannot interleave keystrokes. Prefer pattern actions (click/type/select) whenever possible; use keys only for shortcuts UIA cannot reach.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "key": {
              "type": "string",
              "description": "Key name (Enter/Tab/Escape/Backspace/Delete/ArrowUp/F1-F12/single char)"
            },
            "modifiers": {
              "description": "Modifier keys held (e.g. [\"ctrl\"] + key \"a\" = Ctrl+A)",
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "ctrl",
                  "alt",
                  "shift",
                  "meta"
                ]
              }
            },
            "hwnd": {
              "description": "Window handle",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "required": [
            "key"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_activate",
        "description": "Bring a window to the foreground (restore if minimized + SetForegroundWindow). Physical input — asks every time. Needed before coordinate clicks / clipboard paste into apps that require focus; pattern actions (Invoke/SetValue/Select) work without activation.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "hwnd": {
              "description": "Window handle from desktop_probe",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_uia_window_shot",
        "description": "Capture a screenshot of a single window rect (not the full screen) - smaller privacy surface than desktop_screenshot, read-only. Locate window as in desktop_uia_tree (hwnd/pid/title/foreground). Returns {path, bytes, rect, window}. With a text-only model hand the path to the user; with a vision model read the image to see self-drawn controls that UIA cannot see.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "hwnd": {
              "description": "Window handle from desktop_probe",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "pid": {
              "description": "Process id",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "title": {
              "description": "Window title substring",
              "type": "string"
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_audit",
        "description": "Read the desktop operation audit log — which agent did what (click/type/keys/activate), when, against which control/window, and the outcome. Mirrors browser_audit. Use to review what the Agent has done on the desktop.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "limit": {
              "description": "Max entries (default 50)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          },
          "additionalProperties": {}
        }
      },
      {
        "name": "desktop_status",
        "description": "Current desktop control state: active window-takeover grants per agent (with TTL) and the global input lease holder. Use to check who is currently allowed to operate which windows, or who holds the physical input lease.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {},
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
