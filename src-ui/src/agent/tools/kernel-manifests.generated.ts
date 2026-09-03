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
    "id": "builtin.fs",
    "version": "1.0.0",
    "trust": "system",
    "description": "文件系统操作（自 commands/filesystem.rs + search.rs 的 glob 拆出，kernel-plugin-runtime P2-2）",
    "capabilities": [
      "filesystem_read",
      "filesystem_write"
    ],
    "tools": [
      {
        "name": "list_directory",
        "description": "List files and subdirectories in a directory (recursive up to 4 levels deep). Returns name, path, type (file/dir), and size for each entry.",
        "read_only": true,
        "permission": {
          "family": "Read",
          "path_key": "path"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the directory to list"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "list_directory_flat",
        "description": "List the immediate files and subdirectories of a directory (non-recursive). Internal consumer tool (not model-facing).",
        "read_only": true,
        "permission": {
          "family": "Read",
          "path_key": "path"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the directory to list"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "read_file_content",
        "description": "Read the content of a file on disk. Returns text in cat -n format (6-digit line number + tab + content). Use offset and limit to read a specific range of lines (0-indexed). Use to inspect source code files when analyzing dependencies or investigating violations.",
        "read_only": true,
        "permission": {
          "family": "Read",
          "path_key": "filePath"
        },
        "schema": {
          "type": "object",
          "properties": {
            "filePath": {
              "type": "string",
              "description": "Absolute path to the file to read"
            },
            "offset": {
              "description": "Line number to start reading from (0-indexed, default: 0)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "limit": {
              "description": "Maximum number of lines to return (default: all lines)",
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "filePath"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "read_memory_batch",
        "description": "Read multiple memory files under .lantai in one call. Internal consumer tool (not model-facing).",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {
            "paths": {
              "description": "Absolute file paths to read",
              "items": {
                "type": "string"
              },
              "type": "array"
            }
          },
          "required": [
            "paths"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "read_file_base64",
        "description": "Read a file and return its content base64-encoded (for in-app media rendering). Internal consumer tool (not model-facing).",
        "read_only": true,
        "permission": {
          "family": "Read",
          "path_key": "filePath"
        },
        "schema": {
          "type": "object",
          "properties": {
            "filePath": {
              "type": "string",
              "description": "Absolute path to the file to read"
            }
          },
          "required": [
            "filePath"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "write_file_content",
        "description": "Create or overwrite a file with the given content. Creates parent directories if needed. Use to write new files or modify existing ones.",
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
              "description": "Absolute path to the file to create or overwrite"
            },
            "content": {
              "type": "string",
              "description": "Full file content to write"
            },
            "_forceGate": {
              "description": "Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.",
              "type": "boolean"
            }
          },
          "required": [
            "filePath",
            "content"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "log_append",
        "description": "Append content to a log file (create if missing). Internal consumer tool (not model-facing).",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the log file"
            },
            "content": {
              "type": "string",
              "description": "Content to append"
            }
          },
          "required": [
            "path",
            "content"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "create_directory",
        "description": "Create a new directory (and any missing parent directories). Use before writing new files into a directory that may not exist yet.",
        "read_only": false,
        "permission": {
          "family": "Edit",
          "path_key": "path"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the directory to create"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "get_global_memory_dir",
        "description": "Return the global memory directory path. Internal consumer tool (not model-facing).",
        "read_only": true,
        "schema": {
          "type": "object",
          "properties": {},
          "additionalProperties": {}
        }
      },
      {
        "name": "delete_file_or_dir",
        "description": "Delete a file or directory at the specified path. Use to clean up temporary files or remove unwanted code. DANGEROUS — cannot be undone. Verify with user if deleting important files.",
        "read_only": false,
        "permission": {
          "family": "Edit",
          "path_key": "path"
        },
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the file or directory to delete"
            },
            "_forceGate": {
              "description": "Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.",
              "type": "boolean"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "rename_file_or_dir",
        "description": "Rename a file or directory (keep it in the same parent directory). For moving to a different directory, use move_file instead.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "Absolute path to the file/directory to rename"
            },
            "new_name": {
              "type": "string",
              "description": "New name (not path, just the name)"
            },
            "_forceGate": {
              "description": "Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.",
              "type": "boolean"
            }
          },
          "required": [
            "path",
            "new_name"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "move_file",
        "description": "Move or rename a file or directory. The destination path determines the new name/location.",
        "read_only": false,
        "schema": {
          "type": "object",
          "properties": {
            "from": {
              "type": "string",
              "description": "Source path"
            },
            "to": {
              "type": "string",
              "description": "Destination path"
            },
            "_forceGate": {
              "description": "Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.",
              "type": "boolean"
            }
          },
          "required": [
            "from",
            "to"
          ],
          "additionalProperties": {}
        }
      },
      {
        "name": "glob",
        "description": "Fast file pattern matching using glob patterns. Returns matching file paths sorted by modification time. Supports ** for recursive matching (e.g. \"**/*.rs\", \"src/**/*.ts\", \"*.json\"). Use this instead of run_shell to find files by name pattern — it is faster and respects .gitignore-style exclusions.",
        "read_only": true,
        "permission": {
          "family": "Read",
          "path_key": "path"
        },
        "schema": {
          "type": "object",
          "properties": {
            "pattern": {
              "type": "string",
              "description": "Glob pattern to match file paths against (e.g. \"**/*.rs\", \"src/**/agent*.ts\", \"*.json\")"
            },
            "path": {
              "description": "Directory to search in. Defaults to the current workspace root.",
              "type": "string"
            }
          },
          "required": [
            "pattern"
          ],
          "additionalProperties": {}
        }
      }
    ]
  },
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
