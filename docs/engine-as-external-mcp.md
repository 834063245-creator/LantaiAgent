# 引擎作为外部 MCP 接入兰台

> 图谱功能全量退役（2026-09-09）后，兰台不再内置任何引擎接线——
> `hologram-engine.exe` 保留为独立二进制，回归纯 MCP 供外部消费。
> 本文是把它接回兰台 Agent 工具面的唯一官方路径。

## 前提

- 引擎二进制：仓库 `engine/` 构建产物 `hologram-engine.exe`（或安装目录下的同名文件）。
- 引擎数据目录 `.hologram/`（在目标项目根下，`engine serve --project-root` 启动时自动创建/迁移）。
- 一个引擎实例绑定一个项目根（`--project-root`），启动即自动分析并自带文件 watcher 增量更新。

## 接入方式一：用户级 mcp.json（推荐）

编辑 `~/.lantai/mcp.json`（可在 设置 → MCP 页图形化编辑），加一条 stdio server：

```json
{
  "mcpServers": {
    "hologram-myproject": {
      "type": "stdio",
      "command": "D:/path/to/hologram-engine.exe",
      "args": ["serve", "--project-root", "D:/works/myproject"]
    }
  }
}
```

保存后新会话的 Agent 工具面即出现引擎的 36+ 图谱工具（graph/ops/lsp 族）。

## 接入方式二：插件 manifest mcpServers

外部/本地插件可在 manifest 里声明（S4-4 乙机器桥，stdio 受治进程）：

```json
{
  "name": "my-hologram",
  "mcpServers": [
    {
      "name": "hologram-myproject",
      "type": "stdio",
      "command": "hologram-engine.exe",
      "args": ["serve", "--project-root", "D:/works/myproject"]
    }
  ]
}
```

## 形态限制（必读）

- **静态配置**：一条配置绑一个 `--project-root`。引擎实例不自适应兰台的工作区切换——多个项目要么配多条 server，要么切项目时改配置。
- **生命周期**：server 进程随兰台装载该配置/插件而拉起、随关停/禁用而终止（治理字段 restart/lifecycle 见插件 schema）。
- **权限**：外部 MCP 工具走兰台通用 MCP 权限面（TS 执行器 + permissions 规则），与其它外部 MCP server 同款。
- **约束文件**：`hologram.constraints.yaml`（项目根或安装根的默认件）由引擎侧 `run_check` 消费——兰台不再提供读写它的工具面，需要改动时直接编辑文件。

## 验证

1. 兰台打开任一会话，工具面应出现 `hologram_call` 等引擎工具（或经域工具 `graph(...)` 寻址，取决于引擎 schema）。
2. 引擎侧：`engine serve --project-root <root>` 单独启动，用任意 MCP 客户端连接可列 schema——回归纯 MCP 形态验证即此。
