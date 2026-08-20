# WO-S0B — 插件内核（loader + manifest + plugin-store + 正式装载通道）

> 施工单：自包含。前置：**WO-S0A spike 必须已通过**（装载通道假设已证实）。
> 本单交付插件机制的内核；四条贡献通道（panels/commands/tools/providers）是 S1，不在本单。
> 高 fan-in 提醒：动 `main.ts`（904 行入口）前先跑内置 `graph(preflight)`（AGENTS.md §0-4）。

## 交付物

### 1. Rust：正式静态路由（~100 行）

`src-tauri/src/llm_proxy.rs` 的 spike 分支正式化（建议抽 `plugin_assets.rs` 模块保持文件专注）：

- 路由：`GET /plugins/<id>/<相对路径>` → `~/.hologram/plugins/<id>/<相对路径>`
- 根目录常量与启用态持久化共用同一解析函数（`dirs::home_dir()` + `.hologram/plugins`）
- 安全三件套：路径遍历拒绝（resolve + 前缀校验，含符号链接逃逸测试）、仅 GET、仅 loopback（绑定保证 + 测试钉住）
- MIME 映射同 spike；加 `.wasm` → `application/wasm`（前瞻，本阶段无消费者）
- 错误语义：404（缺文件）/ 403（遍历）/ 405（非 GET），JSON body 带原因
- `cargo test`：遍历拒绝 / MIME / 404 / 符号链接（Windows 下用 junction）四条

### 2. TS：`src-ui/src/plugins/` 三文件

**`types.ts`**（宿主无关规范层，D0 拍板——manifest 形状设计为将来可迁移）：
```ts
export interface PluginManifest {
  name: string        // 唯一 id，npm scope 风格，/^[a-z0-9-]+(/[a-z0-9-]+)?$/
  version: string     // semver
  description?: string
  entry: string       // 相对插件根目录的 ESM 入口，如 "entry.js"
  inject?: string[]   // 依赖的 ctx service 名，装载期校验存在性（缺 → error 状态）
}
export interface HologramPlugin {
  name: string
  apply(ctx: Context): void | Promise<void>
}
```
zod v4 校验 manifest（`defineTool` 同款纪律：一个 schema 产出校验 + 类型）。

**`loader.ts`**：
- 入口 `loadExternalPlugins(root: Context): Promise<void>`
- 流程：读 `~/.hologram/plugins/` 子目录 → 各自 `manifest.json` 校验 → 读 `plugins.json` disabled 集 → 跳过 disabled → `await import(/* @vite-ignore */ `http://127.0.0.1:14570/plugins/${name}/${entry}`)` → 取 `default` 或模块本身为 plugin 对象 → `root.plugin(obj)`（cordis fiber 记录生命周期）
- **失败隔离**：单个插件任何一步抛错 → 记入 plugin-store `{ status: 'error', error }`，继续下一个；loader 本身永不 reject
- **端口来源**：从 `llm_proxy` 现有导出/共享常量取 14570，不硬编码两处
- 导出 `PLUGIN_ASSETS_ORIGIN` 常量供测试与将来 preset 文档引用

**`plugin-store.ts`**（zustand，放 `src/state/`，遵循分层铁律）：`{ name, manifest, status: 'active'|'error'|'disabled', error? }[]`。

### 3. main.ts 接线（净增 <15 行）

`initCordisKernel()` 之后：装载第一方插件表（本阶段 `[]` 占位，S3 起填充）；`createRoot(...).render(...)` 之后：`void loadExternalPlugins(root)`（异步不阻塞首帧，错误只进 store 不进 console.exception）。

### 4. 测试（vitest，loader 用 URL 注入 mock）

- manifest 校验：合法/缺 name/坏 version/坏 entry
- 失败隔离：两个插件一个抛错 → 另一个 active，store 有 error 记录
- disabled 跳过：plugins.json 列出 → 不 import（mock 断言未调用）
- fiber dispose：`root.plugin(obj)` 注册的 effect 在 fiber dispose 后清理（用现有 workspace-fiber 测试同款模式）
- Rust：见交付物 1

## 验收（全部满足才算完）

1. 手动：往 `~/.hologram/plugins/` 放一个 manifest 合法但 entry 抛错的坏插件 → `cargo tauri dev` 应用正常起，plugin-store 里 status=error 可见
2. 手动：放一个合法插件（console.log 即可）→ devtools 看到」[plugin] loaded」
3. `cd src-tauri && cargo test` 全绿；`cd src-ui && npm run build && npx vitest run` 全绿
4. `npx biome check` 改动文件零新增
5. **生产 origin 验证**：`cargo tauri build` 一次，安装包里重复验收 1-2（spike 只证了 dev origin，这一条补生产 `tauri.localhost` origin 的模块 import）
6. `npm run verify:convergence` 绿（本单不触 agent 工具面，此条是防回归哨兵）

## 红线（触碰即返工）

- 不碰冻结文件（chat-session / chat-stream / part-mutator / execution-state）
- 不改 AgentConfig（31 字段冻结）；不注册任何工具/面板/命令（那是 S1）
- 不引入事件总线 / window.dispatchEvent（事件总线禁令）
- plugin-store 放 `src/state/`，不放 `src/ui/`
- 装载期**不执行**任何插件 UI 副作用——apply 里只有注册动作，本阶段能注册的只有 cordis 原生能力（effect 等），因为四 service 还不存在

## 完成后

- `docs/plans/README.md` 状态表更新（S0 Done — Landed，剩生产打包验证若已做则 Done）
- 下一单：S1（先读 `designs/S1-convergence-per-preset.md`，设计已备好）
