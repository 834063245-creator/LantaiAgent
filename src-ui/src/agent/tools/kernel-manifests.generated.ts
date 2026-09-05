// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 生成物 — scripts/gen-plugin-manifests.cjs 从 src-tauri/src/tool_plugins/*/manifest.json 生成。
// 真源在 Rust 侧 manifest；改动请改 manifest 后重新生成（npm run gen:plugin-manifests），勿手改。
// schema 键序 = zod 发射序（convergence 字节契约），生成器逐字保留，勿规整。

import type { KernelToolManifest } from './manifest-tools';

export const KERNEL_MANIFESTS: readonly KernelToolManifest[] = [
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
];
