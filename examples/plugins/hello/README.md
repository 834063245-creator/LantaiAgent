# hello — HoloGram 插件三通道最小示例

> 这是 HoloGram 插件体系的「从零到跑通」示例（组合架构 S4 验收工装）。
> **验收口径：你只需要读本文件（不需要读 HoloGram 源码）就能装上它、看到
> 三通道全部工作、再干净卸载。** 如果哪一步卡住了，那就是我们的文档缺口。

## 这个插件演示什么

| 通道 | 效果 | 生效时机 |
|---|---|---|
| 面板 `ctx.panels` | 右侧 dock 轨道出现「Hello」面板（三通道状态卡片） | 装载后**即时** |
| 命令 `ctx.commands` | 命令面板（Ctrl+K）出现「Hello：打个招呼」，点击后状态栏弹通知 | 装载后**即时** |
| 工具 `ctx.tools` | 模型工具 `hello_greet`（Agent 可调用，返回问候） | **下次 Agent 装配**（新会话） |

生效时差是平台契约：面板/命令是即时生效面，工具要等下一次 Agent 装配
（S1 起的既定语义——工具面变更 = 前缀缓存边界，只发生在会话边界）。

## 前置

- HoloGram 桌面应用已构建并运行（`cargo tauri build` 产物或 `cargo tauri dev`）。
- 知道你的插件目录：`~/.hologram/plugins/`（Windows：
  `%USERPROFILE%\.hologram\plugins\`）。

## 安装（三选一）

### 方式 A：本地目录安装（开发期最常用）

把本目录（`examples/plugins/hello/`，含 `manifest.json` + `entry.js`）整个
复制或克隆到 `~/.hologram/plugins/hello/`，重启应用。

或用设置面板：设置（Ctrl+,）→「插件」→ 安装框填本目录的绝对路径
（`.../examples/plugins/hello`）→ 点「安装」→ 重启应用。

### 方式 B：tarball 安装（模拟 npm 分发）

在某个临时目录打包：

```bash
# 在 examples/plugins/ 下（package 前缀是 npm tarball 惯例，安装时会自动剥掉）
tar -czf hello.tgz --transform 's,^hello,package,' hello
```

设置面板 →「插件」→ 安装框填 tarball 的绝对路径 → 「安装」→ 重启。
（npm 真包同理：安装框直接填包名，如 `some-published-hello`——走
registry.npmjs.org 下载。）

### 方式 C：手动放置

直接把 `hello/` 目录放进 `~/.hologram/plugins/`，重启应用。（= 方式 A
的手动版。）

## 验证三通道

1. **面板**：右侧轨道出现「Hello」图标 → 点击 → 卡片展示。
2. **命令**：Ctrl+K → 输入 `hello` → 「Hello：打个招呼」→ 点击 → 状态栏
   出现「Hello 插件向你打个招呼 👋」。
3. **工具**：开一个**新**聊天会话，对 Agent 说「用 hello_greet 工具问候我」
   → 工具返回 `Hello, <你的名字>!`。

如果通道 3 报「unknown tool」，先确认你开的是新会话（旧会话的工具面在
创建时点冻结——这是前缀缓存纪律，不是 bug）。

## 卸载

设置面板 →「插件」→ hello 卡片 →「卸载」→ 重启应用。
（或手动删 `~/.hologram/plugins/hello/` 目录。）

卸载后：面板图标消失、命令从命令面板消失、`hello_greet` 不再进新会话的
工具面——三通道干净退出（disposer 链经插件 fiber 释放）。

## ⚠️ 安装前必读（完全信任模型）

**插件是本机全信任代码：可读写文件、起子进程、调用全部 RPC。** npm 上的
包 ≠ 审核过的包——只安装你信任来源的插件。这与你手动改本机文件是同一
信任级别（详见 HoloGram 的 `docs/plugins/README.md`）。

## 写自己的插件

最小形状就两个文件：

```
~/.hologram/plugins/<你的插件名>/
├── manifest.json   # {"name": "<插件名>", "version": "1.0.0", "entry": "entry.js"}
└── entry.js        # export default { name, inject, apply(ctx) }
```

`apply(ctx)` 里经 `ctx.panels / ctx.commands / ctx.tools` 注册贡献，每个
注册的返回值（disposer）经 `ctx.effect(() => disposer, '标签')` 登记——
这是插件生命周期的全部纪律。

**平台硬约束**：`entry.js` 经 webview 动态 import 装载——**不能有裸
import**（`'react'`、`'zod'` 这类包名解析不了：插件运行时没有包管理器
也没有 import map）。要么零依赖自包含，要么经宿主桥
`globalThis.__hologram_plugin_host__`（`createElement` / `notify`）取宿主
能力——本示例就是标准写法。工具 schema 在插件侧手写 JSON shape + 入参
校验（`defineTool` 是编译期工具链，运行时模块用不了）。

完整 API 文档：`docs/plugins/README.md`。
