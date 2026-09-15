# office-cli —— OfficeCLI × 兰台（C 路：一等 office 域工具）

> 上游：[iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)（Apache-2.0，单二进制 Office 套件）。
> 计划与实测数据：[`docs/plans/office-cli-integration-plan.md`](../../docs/plans/office-cli-integration-plan.md)。
>
> **形态（2026-09-13 C 路改判；2026-09-15 R3 重构）**：读写能力由兰台**内置 office 域工具**
> `office(action,…)` 承担（zod 真源；经 `process_cap` 的 `office_exec` 动作受控 spawn——
> 命令由 Rust 拼装，权限只审声明的目标文件 `file`/`out`，plan 按动作分读写）。**不再需要**
> MCP 挂接，也不需要插件自带二进制。

## 1. 三件套（装一次）

| 件 | 落位 | 说明 |
|---|---|---|
| 二进制 | `%USERPROFILE%\.lantai\tools\officecli\officecli.exe` | pin **v1.0.149**（win-x64 **31.87 MB**，SHA256 `abd82dae…31e2`）；**强制层**定位它（`$OFFICECLI_PATH` → 该标准位 → PATH 兜底） |
| 技能 | `%USERPROFILE%\.lantai\skills\officecli\SKILL.md` | 域工具的权威手册（动作面/铁律/交付门槛覆盖面/四条工作流/坑表）。域工具**不带**技能，技能仍落技能根 |
| 活预览窗（可选） | `examples/plugins/office/` 经「设置 → 插件 → 安装目录」装载 | 想边改边看：**你自己**用绝对路径起 `officecli watch <文件>` + 让 Agent 调 `office_preview_open`（Agent 起不了 watch——它的 shell 里没有 officecli；且 watch 占着的文件别再让 Agent 改，见插件 README ⚠️） |

**office 域工具随兰台出厂**（内置第一方域插件 `office-domain`，buildOrder 29）——不需要你安装任何插件；
`~/.lantai/mcp.json` 里也**不应该**再有 `office` 条目（预检会点名）。

## 2. 装

### 2.1 一条命令（推荐：`install-officecli.ps1`）

三种来源任选其一，**一律 SHA256 校验后才落位**（固定版本用内嵌哈希；非固定版本拉官方
`SHA256SUMS` 比对并显式告警）；幂等（同哈希 → 无需安装）；升级时旧件挪 `.bak-<时间戳>` 不删。

```powershell
.\install-officecli.ps1 -FromRelease                       # 从 GitHub Releases 按 pin 版本下载
.\install-officecli.ps1 -FromLocal D:\dl\officecli-win-x64.exe   # 本机已下载件（离线/内网）
.\install-officecli.ps1 -FromPluginDir <含 officecli.exe 的目录>  # 从别处已装件复制
```

**实测判据**：成功 ✓ / 幂等重跑 ✓ / **篡改件被拒（exit 1 + 点名期望与实际哈希）** ✓ /
来源多选或零选被拒 ✓ / 三来源全部端到端跑通 ✓（`-FromRelease` 实测 624.5 s = 本机 ~44 KB/s 网络现实）。

### 2.2 手工

```powershell
$dest = "$env:USERPROFILE\.lantai\tools\officecli"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item .\officecli.exe "$dest\officecli.exe" -Force
& "$dest\officecli.exe" --version            # 期望 1.0.149

New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.lantai\skills\officecli" | Out-Null
Copy-Item .\SKILL.md "$env:USERPROFILE\.lantai\skills\officecli\SKILL.md" -Force
```

> 用户级技能读取走「沙箱用户数据白名单」——2026-09-13 修掉过一条 verbatim 前缀
> （`\\?\C:\…`）导致豁免恒不命中的沙箱 bug。**未重建壳的旧版本**上可把同一份 SKILL.md 放到
> **项目级** `<工作区>/.lantai/skills/officecli/`（不依赖豁免）。

## 3. 验证

```powershell
.\preflight.ps1     # 只读诊断：二进制/哈希/版本 pin、技能、MCP 退役面、活预览窗、watch、常驻进程
```

关键项（二进制 + pin + 技能）全过 = exit 0；把输出贴回来即可定位问题。

人工验收（重启兰台 → 开新会话）：
1. 让模型跑 `office(action:'create', file:'试.docx')` → 盘上出现文件（域工具带 `flush=each`，**不要**手动 save；
   写完若要吃嘴里的"已落盘"，就用 `view` 读回复核——见下表落盘行）；
2. `office(action:'view', file:'试.docx')` 能读回；`office(action:'validate', …)` 干净；
3. **plan 模式反向判据**：plan 下让它 `set`/`add` → 应被 `[已拦截]`；`view` 应放行（只读动作白名单）；
4. 真文档跑一轮：读 issues → 改一处 → 截图 PNG → `show_asset` 进纸面；
5. **权限面判据（2026-09-15 R3 修后）**：在默认 `ask` 模式下做第 1~4 步——项目内文件**不应弹确认卡**
   （旧实现每次调用都弹且"始终允许"无效）；把目标放到项目外（如桌面）→ **应弹一次**卡，
   点"始终允许"后同一路径**不再弹**。工具级规则面 = `Office`（如 `{"allow":["Office"]}` 整体放行，
   `{"deny":["Office"]}` 整体拒绝）。

## 4. 与退役形态的差异（为什么改判）

| 面 | 旧：MCP 挂接 | 新：office 域工具 |
|---|---|---|
| 参数 | 自由命令行字符串（模型自己拼引号） | zod 收窄的 12 个动作 + 类型化参数 |
| 执行 | MCP 子进程 = **全权用户进程**（不经 fs_cap、不受 os_sandbox 约束） | 经 `process_cap` 能力口的 **`office_exec`** 动作受控 spawn（2026-09-15 R3 重构）：命令由 Rust 拼装（二进制定位 + 引号 + 环境钉扎），门禁为 `OfficeTool`（只审声明的目标文件）+ 动词白名单 + 计划 §11.3 |
| plan 模式 | 整块判为写，连 `view` 都被拦 | `readOnlyActions` 白名单：view/get/query/validate/playbook 放行 |
| 落盘 | 需记得 `save`（否则别的程序读到旧字节） | 工具钉 `OFFICECLI_RESIDENT_FLUSH=each`——**但只对域工具自己持有的那个 resident 生效**：文件此前若被另一个 officecli 进程打开过，回执照样说成功、磁盘字节却可能滞后（2026-09-15 实测，见计划 §11.1）。判定真源 = 写完用 `office(action:'view')` 复核 |
| 能力可见性 | 工具面一条 `mcp__office__officecli` | 进工具契约生成物（域 `office` / 12 动作枚举 / 参数表） |
