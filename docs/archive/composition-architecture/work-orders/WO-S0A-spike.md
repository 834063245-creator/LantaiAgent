# WO-S0A — 装载通道验证 spike（第一刀，小时级）

> 施工单：自包含，执行 agent 可直接开工。前置阅读：`docs/plans/composition-architecture/README.md` S0 节。
> **结果：✅ 分支 1（假设证实，2026-08-20）**——dev webview（127.0.0.1:1420）从 `http://127.0.0.1:14570` 动态 import 磁盘 ES module 成功，console 证据 `[spike] import ok: {"ok":true,"from":"disk-es-module"}`。spike 代码（Rust 分支/前端临时代码/磁盘模块）已全量清除；生产 origin 验证随 WO-S0B 验收 5 补齐。
> 目标：**验证一个假设，不是建一个功能**——「Tauri webview 能从 `http://127.0.0.1:14570` 动态 import ES module」。
> 该假设是整个 S0（乃至插件机制）的物理前提；在跑通之前它是假设不是事实（v1 计划正是在同类假设上翻车的，不犯第二次）。

## 为什么先做这个

生产 webview 从 `tauri.localhost` 加载静态 dist，全部 import 是编译期 vite chunk；磁盘上的插件文件没有任何通道变成可执行模块。`llm_proxy.rs`（127.0.0.1:14570）是现成的本地 HTTP 服务（已带 CORS 头），给它加静态文件路由即可解锁——但「即可」必须先被一个 spike 证明。

## 施工步骤

### 1. Rust：静态路由分支（llm_proxy.rs，~40 行，标注 `// SPIKE` 注释）

位置：`src-tauri/src/llm_proxy.rs` 的 `handle_inner`，**在 `x-hologram-target` 头检查之前**插入分支（现状：GET 也被要求带 target 头，静态请求没有这个头）：

```rust
// SPIKE: GET /plugins/* → 静态文件（S0B 会重写为正式实现）
if req.method() == Method::GET {
    if let Some(path) = req.uri().path().strip_prefix("/plugins/") {
        return serve_spike_static(path).await;
    }
}
```

`serve_spike_static` 要求：
- 根目录：用户主目录下 `.lantai/plugins-spike/`（`dirs` crate 或读环境变量；spike 期间硬编码亦可，S0B 正式化）
- **路径遍历防护**：拒绝含 `..` 的段；resolve 后必须仍以根目录为前缀
- **MIME 映射**（ES module import 对 MIME 严格）：`.js`/`.mjs` → `application/javascript`，`.json` → `application/json`，`.css` → `text/css`，其余 → `application/octet-stream`
- 响应带与代理一致的 CORS 头（`access-control-allow-origin: *`；确认 `cors_response` 是否含 `access-control-allow-private-network: true`，不含则手动加——WebView2 的 PNA 预检需要）
- 仅 loopback 由服务器绑定天然保证（14570 只绑 127.0.0.1）

### 2. 磁盘：放一个 spike 模块

`~/.lantai/plugins-spike/hello/entry.js`：
```js
export const spike = { ok: true, from: 'disk-es-module' }
console.log('[spike] disk plugin module executed')
```

### 3. 前端：临时验证代码（main.ts 末尾，`init()` 之后）

```ts
// SPIKE: 装载通道验证——验证后删除
void (async () => {
  try {
    const mod = await import(/* @vite-ignore */ 'http://127.0.0.1:14570/plugins/hello/entry.js')
    console.log('[spike] import ok:', mod.spike)
  } catch (e) {
    console.error('[spike] import FAILED:', e)
  }
})()
```

注意：URL 必须走变量或完整字面量 + `@vite-ignore`，防止 vite 把它当编译期依赖分析。

### 4. 跑

`cargo tauri dev`（dev 模式 origin 是 127.0.0.1:1420，与 14570 同为 loopback，CORS/MIME/PNA 机制与生产等价；生产 origin 的最终验证放 WO-S0B 验收）。开 webview devtools 看 console。

## 结果判定（三分支）

| 结果 | 动作 |
|---|---|
| ✅ `[spike] import ok` | 假设证实 → 删除 spike 代码（Rust 分支可留作 S0B 起点），直接开 WO-S0B |
| ❌ MIME/CORS 类报错 | 按报错修 `serve_spike_static` 的头/MIME；重跑（预期 1-2 轮内通） |
| ❌ 模块 import 被根本性阻断（非头/MIME 能解） | **停**：转自定义协议方案（`register_uri_scheme_protocol`）另立 spike 单；loader 的 TS 侧设计不白做（URL 前缀换掉即可） |

## 门禁

- `cd src-tauri && cargo check && cargo test`（路径遍历防护写一条测试）
- 不动 `src-ui` 任何非 spike 代码；spike 代码全量标注 `// SPIKE`，验证完删

## 明确不做

不建 loader / manifest / plugin-store（WO-S0B 的活）；不建四 service（S1 的活）；spike 代码不留正式痕迹。
