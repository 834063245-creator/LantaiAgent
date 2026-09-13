# office —— Office 活预览窗插件（可选件）

给「正在改的那份 Office 文件」开一扇**实时渲染浮窗**：窗里跑的不是插件自己的页面，而是本机
`officecli watch` 服务的环回页（契约 v28 的「环回远端视图」形态）。

> **注意（2026-09-13 C 路改判）**：本插件**不再挂 MCP server**。OfficeCLI 的读写能力已由兰台
> **内置 office 域工具**（`office(action,…)`，经 shell seam → `process_cap` 受沙箱 spawn）承担——
> 沙箱 + Bash 权限类 + 审计 + plan 按 action 分档。本插件只负责"看"。
> 完整计划与实测数据：[`docs/plans/office-cli-integration-plan.md`](../../../docs/plans/office-cli-integration-plan.md) §10。

## 1. 装

```powershell
# ① 二进制（读写能力用；活预览窗的 watch 也从它起）——标准安装位 + 哈希校验
..\..\office-cli\install-officecli.ps1 -FromRelease        # 或 -FromLocal <已下载件>

# ② 技能（office 域工具的权威手册；域工具不带技能，技能仍落技能根）
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.lantai\skills\officecli" | Out-Null
Copy-Item ..\..\office-cli\SKILL.md "$env:USERPROFILE\.lantai\skills\officecli\SKILL.md" -Force

# ③ 本插件（可选的活预览窗）：设置 → 插件 → 安装框填本目录绝对路径 → 安装
```

二进制**不进插件目录**（走标准安装位 `%USERPROFILE%\.lantai\tools\officecli\`），所以本插件目录很小、
换版本只换那一个文件。

## 2. 用

```powershell
# 让 Agent 走 shell 域后台起 watch（或你手动跑），再让它调 office_preview_open 开窗
officecli watch D:\path\to\文档.docx      # 打印 http://localhost:26315
```

- 改文档 → watch 经 SSE 推**增量补丁**（实测约 0.6 s 一条 `word-patch`）→ 窗内自动刷新，
  **不需要轮询、也不需要重开窗**。
- 窗内容是**跨源远端页**：iframe 给 `allow-same-origin`（保住它自己的 origin，同源 SSE/fetch 才通——
  实测该服务不回 CORS 头，opaque origin 下活刷新必死），**但不绑宿主桥**（远端页不是插件代码）。
- 白名单硬边界：只许 127.0.0.1 / localhost / ::1，禁凭据，禁公网，**禁 fullscreen**（远端文档能覆盖
  宿主视觉面，全屏形态把界面辨识度也拿走）。
- 端口变了（`officecli watch --port N`）要同步改 manifest 里的 url——窗指向声明值，不做发现。
- **不想起 watch 的场合**：用截图路（`office(action='screenshot', out=…)` + `show_asset` 原地刷新纸面
  资产块）——零后台进程，代价是图不自动跟。

## 3. 边界（如实列出）

- **模型看不到工具结果里的图**：工具结果契约是纯文本，`screenshot` 产出的是**盘上 PNG**——
  用 `show_asset(kind='file', payload={filePath, ext:'png'})` 交给用户看；模型的机械自检走
  `validate` + `view issues`，视觉终审交人判。
- **watch 进程不随窗自动停**：起/停归 shell 域（Agent 或用户），本插件只开窗。
- 版本漂移快：二进制按 pin 版本（1.0.149）验证；升版本走安装器换哈希 + 重跑
  `src-ui/tests/office-domain.test.ts`。

## 4. 守护测试

`src-ui/tests/office-plugin-example.test.ts`（形状：**不含 mcpServers**、app.url 环回、工具口成对、
二进制不进目录）+ `src-ui/tests/office-plugin-loader.test.ts`（真实装载路径：窗口定义 kind=remote、
工具行在册、**无 MCP 行**、卸载收口）。办公室域工具本身的守护在 `src-ui/tests/office-domain.test.ts`
（13 例，含真 bash × 真 officecli 端到端）。
