# Publishing a Plugin to a Registry（三方发布路径）

> 平台化 Phase 6 · "第三方优先"落地收口（2026-08-28）。插件从零到 registry 发布
> 的完整路径——发布 = npm 包，安装 = `plugin_install`（registry 源）。

## 1. 从零做一个插件（hello 级）

1. 看范本：`examples/plugins/hello/`（1 面板 + 1 命令 + 2 工具——ctx.tools 代码通道 +
   manifest.tools 声明通道双通道，`src-ui/tests/plugin-hello-e2e.test.ts` 自动化半边钉住机制）。
2. 结构（插件必须自包含——无裸 import）：

```
my-plugin/
├── manifest.json   # name（npm scope 风格，≤2 段）/ version（semver）/ entry / inject? / permissions? / tools? / mcpServers?
├── entry.js        # export { name, apply(ctx) }（apply 只做注册动作）
└── (assets)        # 自包含 ESM；需要 React 用宿主桥 window.__lantai_plugin_host__.createElement
```

3. 本地安装测试：设置面板「插件」tab 输入本地目录路径（或 tarball）→ 立即装载（D6 运行时生效）。

## 2. 带后端能力的插件（MCP / provider）

- 外部 MCP server：manifest `mcpServers` 声明（见 `docs/cookbook/adding-an-mcp-server.md`）；
  端到端参考 `examples/plugins/dataflow-mcp/`。
- 后端 provider（fs/shell/session/graph/llm/subagents）：插件 entry 经 `ctx.<seam>.register`
  贡献（见 `docs/cookbook/` 各 seam 指南）。

## 3. 发布到 registry（npm）

`plugin_install` 的 registry 源按 npm 约定下载 tarball：`<registry>/<name>/-/<name>-<version>.tgz`。

```bash
# 在插件目录打包（npm pack 产 tarball——registry 源与 tarball 源同一校验路径）
npm pack
# 发布（普通 npm 发布流程；registry 缺省 https://registry.npmjs.org，可用 --registry 指定镜像）
npm publish --access public
```

安装：设置面板输入包名 → `plugin_install`（registry 源）→ 立即装载。
**同名重装走版本守卫**（P3）：升级 = 原子换装；同版本/降级拒绝；`force` 显式逃生。

## 4. 安装后的信任面（必读）

- **静态插件完全信任 = v1 已知债**（`docs/plugins/README.md` §6）：装进来拥有你本机账户
  全部能力——只装你信任来源的插件。安装 UI 常驻供应链警告。
- 声明面（manifest.permissions）与逐调用强制（Rust 权限咽喉）照常生效；授予门禁
  （plugins.json granted 段）未覆盖 = 不装载（blocked 状态）。
- **动态插件（cordis 域）= approval + 沙箱**：模型运行时定义的插件首激活经用户批准 +
  沙箱三层防线（见 `docs/cookbook/adding-a-dynamic-plugin.md`）。

## 5. 契约与版本

- 开放面契约版本：`docs/agents/open-surface-contract.md`（插件 manifest schema / seam 接口
  变更必须升版 + 记录——守护测试红着就是没改完）。
- 平台契约总览：`docs/plugins/README.md`（本文件是插件面唯一人类契约）。
