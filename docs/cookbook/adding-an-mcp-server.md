# Adding an MCP Server（挂接外部 MCP server）

> 平台契约示例（平台化 Phase 6）。真源：`src/plugins/mcp-bridge.ts`（机器桥）+ `examples/plugins/dataflow-mcp/`（端到端活例子）。

## 声明式挂接（manifest.mcpServers）

```json
{
  "name": "my-mcp",
  "version": "1.0.0",
  "entry": "entry.js",
  "mcpServers": [
    {
      "name": "dataflow",
      "transport": "stdio",
      "command": "node",
      "args": ["./server.cjs"],
      "failurePolicy": "startup-error"
    }
  ]
}
```

- `command` 相对插件目录解析（含分隔符形态）；`args` 的 `./`/`../` 前缀相对插件目录解析，其余原样。
- `failurePolicy`：`startup-error`（装载期急连接验证，失败 = 插件 error）| `lazy`（缺省——首装配连接，失败 = 空集 + 下次装配重试）。
- 一个 server = 一条工具贡献（行 id `plugin/<插件名>/mcp/<server名>`）——**patch/preset 可寻址禁用**。
- 工具名前缀 `mcp__<server名>__<工具名>`；进程 kill 归插件 fiber disposer（链式停）。

## 协议面（MCP JSON-RPC over stdio）

- `initialize` → 返回 capabilities.tools + serverInfo；
- `tools/list` → 工具 schema（name/description/inputSchema）；
- `tools/call` → 结果 `{ content: [{ type: 'text', text }], isError? }`。
- 完整可运行参考：`examples/plugins/dataflow-mcp/server.cjs`（零依赖，直读 .lantai/dataflow/ 文件）。

## 端到端验证

- `tests/plugin-dataflow-mcp-e2e.test.ts`：真实 node 子进程 + 真实 stdio + loader 同款挂接 → `mcp__dataflow__dataflow_query` 工具三路断言（list / 精确 trace / 非法 id 围栏）。
- MCP 是**能力加面路径之一**（不是唯一）——同一能力既可走进程内 seam，也可走外部 MCP server（D1 收口）。
