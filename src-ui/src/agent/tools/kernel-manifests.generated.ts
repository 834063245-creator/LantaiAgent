// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 生成物 — scripts/gen-plugin-manifests.cjs 从 src-tauri/src/tool_plugins/*/manifest.json 生成。
// 真源在 Rust 侧 manifest；改动请改 manifest 后重新生成（npm run gen:plugin-manifests），勿手改。
// schema 键序 = zod 发射序（convergence 字节契约），生成器逐字保留，勿规整。

import type { KernelToolManifest } from './manifest-tools';

export const KERNEL_MANIFESTS: readonly KernelToolManifest[] = [
  {
    "id": "builtin.search",
    "version": "1.0.0",
    "trust": "system",
    "description": "代码内容搜索（自 commands/search.rs search_content 拆出，kernel-plugin-runtime Phase 1 首个插件）",
    "capabilities": [
      "filesystem_read"
    ],
    "tools": [
      {
        "name": "search_content",
        "description": "Search for a text pattern across all source files. Supports literal substring (default, case-insensitive) and regex. Returns matching lines with optional context lines, file lists, or counts. Skips binary files, hidden dirs, and build artifacts. Prefer this over run_shell grep — it is faster and respects .gitignore-style exclusions.",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "directory": {
              "type": "string",
              "description": "Absolute path to the directory to search in"
            },
            "pattern": {
              "type": "string",
              "description": "Text or regex pattern to search for (case-insensitive)"
            },
            "fileTypes": {
              "description": "Optional comma-separated file extensions to filter (e.g. \".ts,.py,.rs\")",
              "type": "string"
            },
            "maxResults": {
              "default": 50,
              "description": "Maximum number of results to return (default: 50, max: 200)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 200
            },
            "useRegex": {
              "default": false,
              "description": "Set to true to interpret pattern as a regex (e.g. \"function\\\\s+\\\\w+\"). Default: false (literal substring)",
              "type": "boolean"
            },
            "contextLines": {
              "default": 0,
              "description": "Number of context lines before and after each match (like grep -C). Default: 0. Max: 10.",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "outputMode": {
              "default": "content",
              "description": "Output mode: \"content\" = matching lines with context, \"files_with_matches\" = just file paths, \"count\" = match counts per file. Default: content.",
              "type": "string",
              "enum": [
                "content",
                "files_with_matches",
                "count"
              ]
            },
            "showLineNumbers": {
              "default": true,
              "description": "Include line numbers in output (default: true)",
              "type": "boolean"
            },
            "headLimit": {
              "default": 250,
              "description": "Max results/files to return (default: 250, 0 = unlimited)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "offset": {
              "default": 0,
              "description": "Skip first N results for pagination (default: 0)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "globFilter": {
              "description": "Additional glob filter on file paths (e.g. \"**/*.rs\", \"src/**/*.ts\")",
              "type": "string"
            }
          },
          "required": [
            "directory",
            "pattern"
          ],
          "additionalProperties": {}
        }
      }
    ]
  },
];
