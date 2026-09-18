# 引擎作为外部 MCP 接入兰台

> 图谱功能全量退役（2026-09-09）后，兰台不再内置任何引擎接线——
> `hologram-engine.exe` 保留为独立二进制，回归纯 MCP 供外部消费。
> 本文是把它接回兰台 Agent 工具面的路径。

## 前提

- 引擎二进制：仓库 `engine/` 构建产物 `hologram-engine.exe`（**或兰台安装目录下的同名文件**）。
- 引擎数据目录 `.hologram/`（在目标项目根下，`engine serve --project-root` 启动时自动创建/迁移）。
- 一个引擎实例绑定一个项目根（`--project-root`），启动即自动分析并自带文件 watcher 增量更新。

## 接入方式零：随包引擎（推荐，v10.4+）

**兰台安装包里自带引擎**（`bundle.resources`：exe + grammars + onnxruntime + 模型，
实测约 196MB），所以多数用户**不需要**下面的一/二两种手动配置：

1. 打开 **设置 → MCP** 页，找到「**随包图谱引擎**」区块
2. 区块会显示探测到的引擎路径；勾选「启用随包图谱引擎」
3. **下次打开工作区**生效——引擎按该工作区的根启动，Agent 工具面出现图谱工具

细节：

- **默认关**：尊重 2026-09-09 图谱工具面退役决策，不启用则工具面零变化
- **生命周期**：懒启动（首次调用才拉起进程）+ 崩溃自愈重启 + 空闲回收；
  **离开工作区即停**（切工作区 = 按新根另起实例，这是引擎「一进程一根」契约决定的）
- **数据落点**：工作区根下 `.hologram/`（引擎自管；与兰台 `.lantai/` 分居）
- 开关存 `localStorage`，探测走 `engine_bundled_info` RPC（**只读探测，不启动进程**）
- 实现：`src-ui/src/plugins/bundled-engine.ts` + `src-tauri/src/engine_assets.rs`

手动配置（一/二）仍然可用——适合引擎在别处、想连多个项目、或想指定独立实例的场景。

## 接入方式一：用户级 mcp.json（手动）

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

保存后新会话的 Agent 工具面即出现引擎的图查询工具（清单以生成物
[`agents/engine-plugin-contract.md`](agents/engine-plugin-contract.md) 为准）。

### 工具面形态：域 + action（引擎契约 v6）

引擎 `tools/list` 恒定返回 **7 个工具**，不是几十个：只读工具折叠成
`graph` / `analysis` / `lsp` / `ops` 四个域，调用形态
`graph {"action": "impact", "nodeId": "…"}`；写操作（`analyze_project` /
`import_scip` / `rename_symbol`）留在顶层。**原名一个没删**——`tools/call`
仍可按 `search_symbols` / `preflight_check` 等原名直达（老客户端零破坏）。

每个域另带保留动作 `action:"help"`：回该域**全部动作的完整说明书**
（完整描述 / 参数表 / 必填字段）。折叠是无损的——原文只是从常驻上下文
挪到按需一问，需要细节时问一次即可。

可见面**没有档位开关**：`HOLOGRAM_MCP_TOOLS` 已随契约 v6 退役（它当初用于
裁剪 36 个扁平工具的可见面，折叠后用途消失，而插件 manifest 与用户
`mcp.json` 的 schema 都没有 env 字段，没有宿主通道能设它）。设了不再生效。

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

- **静态配置**：一条手动配置绑一个 `--project-root`。引擎实例不自适应兰台的工作区切换——多个项目要么配多条 server，要么切项目时改配置。**（方式零的随包接线不受此限**——它在工作区打开时按该工作区的根注册，离开即释放。**）
- **生命周期**：server 进程随兰台装载该配置/插件而拉起、随关停/禁用而终止（治理字段 restart/lifecycle 见插件 schema）。
- **权限**：外部 MCP 工具走兰台通用 MCP 权限面（TS 执行器 + permissions 规则），与其它外部 MCP server 同款。
- **约束文件**：`hologram.constraints.yaml`（项目根或安装根的默认件）由引擎侧 `run_check` 消费——兰台不再提供读写它的工具面，需要改动时直接编辑文件。

## 验证

1. 兰台打开任一会话，工具面应出现引擎的图查询工具（缺省 = 引擎契约 v6 的域面：
   `mcp__hologram__graph` / `__analysis` / `__lsp` / `__ops` + 三个写工具
   `mcp__hologram__analyze_project` / `__import_scip` / `__rename_symbol`）。
   注意：兰台**内置**的同名 `graph` / `ops` / `lsp` 域工具已随图谱内置接线退役
   （2026-09-09）——现在看到的 `graph` 是引擎自己的域，与兰台内置域无关。
2. 引擎侧：`engine serve --project-root <root>` 单独启动，用任意 MCP 客户端连接可列 schema；
   `hologram-engine run --list` 打印域面与每个动作对应的原名。回归纯 MCP 形态验证即此。
