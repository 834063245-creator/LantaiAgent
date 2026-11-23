# 插件契约·一页纸（contract card）

> 目的：**读完这一页就能开始写插件**。全文与逐字段说明在 [`README.md`](README.md)；
> 形状真源 = `src-ui/src/plugins/types.ts`（zod）；机器可读形状 =
> [`manifest.schema.json`](manifest.schema.json)（编辑器补全用）。
> 规则优先级：`docs/adr/project-constitution.md` > `INVARIANTS.md` > `CONVENTIONS.md` > 本页。

## 1. 能写什么（manifest 顶层 12 字段，多一个都没有）

| 字段 | 一句话 |
|---|---|
| `name` / `version` / `description` | id（小写字母数字连字符，可带一段 `/`）、语义化版本、一句话说明 |
| `entry` | 插件模块（相对 ESM 路径，如 `entry.js`）；默认导出 `{ name, apply }`，`name` 与目录名逐字一致 |
| `inject` | 依赖的 ctx 服务名（缺 = 插件停在等待态，不静默） |
| `permissions` | 声明要用到的权限类（`read`/`edit`/`bash`/`git`/`web`）；声明了但未授权 = 不装载（`blocked`，设置页可见缺哪几类） |
| `tools` | 声明式工具（`name`/`description`/`parameters` JSON Schema/`readOnly`），执行体在 entry 的 `toolHandlers` |
| `mcpServers` | 挂外部 MCP server（stdio/http）；条目加 `governed: true` = 受治进程（就绪握手带时限 / 空闲回收 / 可在崩溃时按 `restart: 'on-crash'` 退避自愈） |
| `app` | 一扇窗：`entry`（自包含 HTML）**或** `url`（环回 http(s) 页）二选一；`title`/`mode`；`documents: true` 才可读宿主文档 |
| `dataDir` | 声明 `true` = 装载即分配 `<数据根>/<插件名>/`（经宿主桥 fs 读写，卸载随插件挪 `.trash`） |
| `activation` | 登记 ≠ 激活：`{ lazy?, resources?, exclusive? }`，副作用挪到组合装配期按引用计数启停 |
| `displace` | 与同名内置产物共用一个贡献 id（第三方覆盖内置的显式声明） |

**新增字段的门槛**：≥2 个真实消费者，或一个明确产品承诺（`tests/plugin-surface-budget.test.ts` 钉死白名单，加字段必须改它、diff 必可见）。

## 2. 宿主保证什么（这些别自己实现）

- **生命周期**：插件 fiber 的 `ctx.effect` 逆序释放；卸载 = 工具行注销 + 窗口全关 + 受治进程树终止 + 数据目录保留。
- **进程监督**：受治进程的拉起/空闲回收/崩溃退避重启、`service_not_ready` 的 fail-fast（宿主永不阻塞等就绪）。
- **窗口**：注册/实例化/焦点/层级/关窗收口；窗内容真隔离（iframe），窗内要能力走 postMessage 白名单桥。
- **安装/卸载/禁用/授权**：`plugin_install` / `plugin_uninstall` / `plugin_set_enabled` + `plugins.json` 的 `granted` 段。
- **信任边界**：插件目录是全信任代码（可读写文件、起子进程、调全部 RPC）——宿主不替你过滤，只负责让失败可见。

## 3. 不能做什么（永不下放）

- 自己拉起/监督进程、自己仲裁窗口、自己装自己、自己画窗框（chrome）。
- 通用插件设置表单（配置住插件窗内；宿主最多给 secret 存储）。
- 用裸 `import` 引第三方包（插件模块必须自包含：没有包管理器、没有 import map）。
- 在 `apply` 里做 UI 副作用（装载期只做注册动作）。

## 4. 怎么调

```bash
# 1) 验形状（与装载器同一份判据；退出码 0 = 可装载）
cd src-ui && npm run plugin:validate -- ../examples/plugins/_template

# 2) JSON 输出（给脚本/CI 用）
npm run plugin:validate -- <插件目录> --json

# 3) 重新生成 manifest JSON Schema（改了 zod schema 之后；doc-sync 会对拍）
npm run gen:plugin-schema
```

编辑器里想要补全：把 `docs/plugins/manifest.schema.json` 绑到 `manifest.json`
（VS Code：`"json.schemas": [{ "fileMatch": ["**/plugins/**/manifest.json"], "url": "./docs/plugins/manifest.schema.json" }]`）。

**JSON Schema 只表达形状**：跨字段约束（`governed` 与 `restart` 的配对、`app` 入口二态、
环回 URL 白名单、退役字段的具名拒绝）在 refine 里，schema 表达不了——一律以
`validateManifest` / `npm run plugin:validate` 为准。

## 5. 退役即具名拒绝（不留兼容层）

删掉的字段不会静默剥掉：写它 = 装载期报错并给出迁移写法。当前退役表：

| 退役形状 | 具名报错 | 改成 |
|---|---|---|
| `mcpServers[].lifecycle`（`lazy`/`eager`/`with-window` 三档） | `mcpServers[].lifecycle: 已退役…` | `governed: true`（只剩一档语义：装配/调用/开窗拉起 + 空闲回收） |
| `tools[].async`（+ 宿主桥 `deferred.complete`） | `tools[].async: 已退役…` | 插件自带 MCP server，完成时发 `lantai/deferred` 通知 |

## 6. 去哪读全文

| 想找什么 | 去哪 |
|---|---|
| 逐通道 API（panels/commands/tools/renderers/prompts/hooks/capabilities/steps/activation） | [`README.md`](README.md) §3 |
| 软件级插件（窗口/数据地盘/受治进程/后台唤醒） | [`README.md`](README.md) §10 · [`../cookbook/plugin-as-software.md`](../cookbook/plugin-as-software.md) |
| 信任模型与安装面 | [`README.md`](README.md) §5–§6 |
| 完整范本 | [`../../examples/plugins/notes-app/`](../../examples/plugins/notes-app/)（带 MCP 后端）· [`../../examples/plugins/_template/`](../../examples/plugins/_template/)（最小） |
| 契约版本与变更记录 | [`../agents/open-surface-contract.md`](../agents/open-surface-contract.md) |
