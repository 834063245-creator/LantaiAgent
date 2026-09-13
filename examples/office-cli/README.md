# office-cli —— OfficeCLI × 兰台（A 路零代码挂接）

> 上游：[iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)（Apache-2.0，单二进制 Office 套件，
> 无 Office 依赖，内置渲染引擎 + 公式/透视引擎）。
> 计划与拍板记录：[`docs/plans/office-cli-integration-plan.md`](../../docs/plans/office-cli-integration-plan.md)。

**本目录是集成件（不是插件）**：三样东西挂上去即可用——二进制 + 用户级 MCP 声明 + 兰台技能。
零代码、零内核改动；设计理由与实测数据见计划 §1/§3/§7。

## 1. 三件套

| 件 | 落位 | 内容 |
|---|---|---|
| 二进制 | `%USERPROFILE%\.lantai\tools\officecli\officecli.exe` | **v1.0.149（pin）**，win-x64 **31.87 MB**，SHA256 `abd82dae…31e2`（与官方 `SHA256SUMS` 一致）；同目录留 `SHA256SUMS` 与 `VERSION`（版本/哈希/安装时间/来源） |
| MCP 声明 | `%USERPROFILE%\.lantai\mcp.json` | 一条 stdio server，受治进程（`lifecycle: lazy` + `restart: on-crash`）——工具名 `mcp__office__officecli` |
| 兰台技能 | **项目级** `<工作区>/.lantai/skills/officecli/SKILL.md`（推荐，任何情况下可读）或用户级 `%USERPROFILE%\.lantai\skills\officecli\SKILL.md`（需沙箱豁免修复到位——见下） | 本目录同名文件（兰台化改写版：调用面 / 兰台铁律 / 三层策略 / help 优先 / 交付门槛 / 专项技能 / 四条工作流（含纸面活预览）/ 坑表） |

> **技能放哪**：项目级 = 只对该工作区生效、**不依赖沙箱豁免**（最稳）；用户级 = 跨工作区个人技能，但其读取
> 走「用户数据目录豁免」——2026-09-13 修掉过一个 verbatim 前缀（`\\?\C:\…`）导致豁免恒不命中的沙箱 bug
> （报 `is outside project directory`），修在 `src-tauri/src/sandbox.rs`；**未重建壳的旧版本上请用项目级**。

## 2. 安装

### 2.1 一条命令（推荐：`install-officecli.ps1`）

三种来源任选其一，**一律 SHA256 校验后才落位**（固定版本用内嵌哈希；非固定版本拉官方
`SHA256SUMS` 比对并显式告警）；幂等（同哈希 → 无需安装）；升级时旧件挪 `.bak-<时间戳>` 不删。

```powershell
# a) 插件目录自带形态（bin/officecli.exe 或根 officecli.exe）
.\install-officecli.ps1 -FromPluginDir <插件目录> -Dest "$env:USERPROFILE\.lantai\tools\officecli"

# b) 本机已下载件（离线/内网）
.\install-officecli.ps1 -FromLocal D:\downloads\officecli-win-x64.exe

# c) 从 GitHub Releases 按 pin 版本下载
.\install-officecli.ps1 -FromRelease
```

**实测判据**（本轮跑过）：成功路径 ✓ / 幂等重跑 ✓ / **篡改件被拒（exit 1 + 点名期望与实际哈希）** ✓ /
来源多选或零选被拒 ✓ / 插件目录两种形态均可 ✓ / 目录无二进制被拒 ✓。

### 2.2 手工三步

```powershell
# ① 二进制（下载后校验哈希，再放到目标位）
$dest = "$env:USERPROFILE\.lantai\tools\officecli"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item .\officecli.exe "$dest\officecli.exe" -Force
& "$dest\officecli.exe" --version     # 期望 1.0.149

# ② MCP 声明（缺文件时新建；已有 mcp.json 则把 mcpServers 数组里加一条）
#    command 用绝对路径（正斜杠形态即可——桥的 resolveCommand 认 ^[a-zA-Z]:[\\/]）

# ③ 技能
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.lantai\skills\officecli" | Out-Null
Copy-Item .\SKILL.md "$env:USERPROFILE\.lantai\skills\officecli\SKILL.md" -Force
```

`mcp.json` 形状（受治进程语义见 `docs/plugins/README.md` §10 / S2）：

```json
{
  "mcpServers": [
    {
      "name": "office",
      "transport": "stdio",
      "command": "C:/Users/<你>/.lantai/tools/officecli/officecli.exe",
      "args": ["mcp"],
      "lifecycle": "lazy",
      "restart": "on-crash"
    }
  ]
}
```

**不要声明 `readOnly`**：officecli 写文件，条目级 `readOnly: true` 会让它的写动作在 plan 模式被放行
（这正是 P0 修掉的洞）。缺省不表态 = fail-closed 视为写 —— 这是**期望行为**。

生效时机：`mcp.json` 与技能都是**启动期**装载 —— 重启兰台 + 开新会话后可见。

## 3. 验证清单

**先跑预检**（只读诊断，不改任何东西——把输出贴回来即可定位问题）：

```powershell
.\preflight.ps1        # 逐项 ✓/✗：二进制/哈希/版本 pin、mcp.json、载体现、技能、watch 服务、进程卫生
```

本机实测输出示例与判读见 `docs/plans/office-cli-integration-plan.md` §9；退出码：关键项（二进制 + pin 一致 + 技能）全过 = 0。

人工验收五条（重启兰台、开新会话后）：

1. `office` server 出现在设置 → MCP / 插件面，工具 `mcp__office__officecli` 可用；
2. `Skill` 工具能列出并载入 `officecli`；
3. 让模型跑：`{"command": ["create", "试.docx"]}` → `view 试.docx outline` → `save 试.docx`；
4. 截图入纸面：`["view","试.docx","screenshot","-o","<绝对路径>.png"]` → `show_asset(kind='file', payload={filePath, ext:'png'})`；
   改完 `save` → 重截**同一路径** → `update_asset(assetId, …)` 原地刷新（纸面活预览最小形态）；
5. **P0 反向判据**：plan 模式下让模型调它写动作 → 应被 `[已拦截]`（而不是落盘）。

> 机器可判定的部分已由 `src-ui/tests/office-cli-e2e.test.ts` 覆盖（8 例：装载/只读语义/真写盘/截图/
> 交付物/注疏回写/xlsx/预览刷新；二进制缺席自动跳过）。上面五条是**人判**部分（兰台 UI 面）。

## 4. 已知边界（如实列出）

| 边界 | 说明 |
|---|---|
| 沙箱外 | MCP 挂接的子进程是**全权用户进程**——不经 `fs_cap`、不受 `os_sandbox` 约束（可写任意路径）。需要沙箱/权限类/审计的动作应走 shell 域。 |
| 模型看不到工具结果里的图 | `view screenshot` 返回图片内容块，兰台工具结果契约是纯文本 ⇒ 图被丢。要看效果只能落盘 PNG + `show_asset` 交人判。 |
| 渲染外链 | `view html` 的 KaTeX/Three.js 走 `d.officecli.ai`/jsdelivr CDN——离线环境公式与 3D 降级（截图路已实测可用）。 |
| resident flush | officecli 自己读总见最新，**别的程序读的是盘上字节** ⇒ 兰台回读/交付前必须 `save`/`close`（技能铁律 1）。 |
| 文件锁 | 目标文件被 Word/WPS 打开时写入报 `file_locked`。 |
| 自动更新/安装 | 不要跑 `officecli install`（会写 ~/.claude、Cursor 等目录）；部署设 `OFFICECLI_SKIP_UPDATE=1`。 |

## 5. 回退

删 `%USERPROFILE%\.lantai\mcp.json` 里那条 server（或整个文件）+ 删 `%USERPROFILE%\.lantai\skills\officecli\`，
重启即回到未集成状态；二进制目录可一并删除。兰台侧零改动、零残留。
