# 开发热更工作流（dev 模式）

> 制定 2026-08-30 · 落地 first-party-hot-reload-plan P0
> 一句话：改前端代码 → 保存 → 秒级看到效果，无需重新打包。

## 为什么之前「改代码要重打包」

兰台是 Tauri 桌面应用：生产包把前端编译进安装产物，改代码必须重新
`cargo tauri build`（分钟级）。但项目一直具备 Vite dev server 的 HMR
（热模块替换）能力——`tauri.conf.json` 配了 `devUrl: http://127.0.0.1:1420`
+ `beforeDevCommand: npm run dev`。只是日常跑生产包，感受不到。

## 怎么进 dev 模式

```
dev.cmd
```

一条命令（Windows，Git Bash / cmd / PowerShell 均可）：
1. 先自动起 Vite dev server（HMR 就绪）；
2. 再编译并启动 Rust 壳 + 打开开发窗口。

> 首次冷启动 Rust 编译要几分钟（与 build 相同）；编译完成后窗口即开。
> 窗口标题栏会连接到 `127.0.0.1:1420` 的 dev server。

## 生效语义

| 改动 | 生效方式 | 速度 |
|---|---|---|
| 前端代码（组件/CSS/逻辑，含 `src-ui/src/**`） | Vite HMR：连着的窗口内即时替换 | 秒级 |
| 插件渲染器（P1：`plugins/builtin/renderers/` 源码） | 构建插件产物（秒级）+ 设置面板「重新加载」 | 秒级 |
| Rust 壳代码（`src-tauri/**`） | `cargo tauri dev` 自动重编译重启 | 分钟级 |
| 引擎代码（`engine/**`） | 需重启 dev 进程（关闭窗口后重跑 `dev.cmd`） | 分钟级 |
| 组合配置（`~/.lantai/composition/roster.patch.yml`） | 1-2 秒自动热加载（composition_watcher） | 秒级 |

## 与生产包的差异（如实声明）

- **前端始终是 dev 构建**：模块未压缩、未做 tree-shaking 的最终形态。
  性能和体积不代表生产。
- **前端代码路径不同**：开发窗口从 dev server 拉 HTML/JS；生产包从
  `dist/` 读取。个别环境相关行为（如资源路径）可能不同。
- **发版前必须重跑生产构建**：`build.cmd`（内部 = `cargo tauri build`，
  会先跑完整前端构建 + tsc 类型检查）。dev 模式通过 ≠ 生产可发布。

## 常见问题

- **改了 React 组件但窗口没反应**：HMR 有时会 fallback 到整页刷新，属正常；
  若完全没变化，检查终端里 Vite 输出有没有报错（红字）。
- **Rust 改动自动重启后窗口丢失**：正常——Rust 进程重启，窗口重建，
  前端状态（聊天记录等）是持久化的，重进即可。
- **端口被占**：`strictPort: true`——1420 被别的进程占用时 Vite 直接
  报错退出。关掉占用程序后重跑。
- **看错误日志**：Vite 错误在跑 `dev.cmd` 的终端里；Rust 日志在终端；
  应用内错误看状态栏日志（展开可查）。

## 验收清单

- [ ] `dev.cmd` 一条命令进开发窗口（无需手工起 Vite）
- [ ] 改 `src-ui/src/app/**` 或 `src-ui/src/composition/**` 等前端文件，
      保存后窗口内行为即时更新，无重编译
- [ ] 生产包可用 `build.cmd` 正常发布（dev 不替代发布门禁）