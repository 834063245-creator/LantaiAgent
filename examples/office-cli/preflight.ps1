<#
.SYNOPSIS
  OfficeCLI × 兰台 集成预检（只读诊断，不改任何东西）。

.DESCRIPTION
  把「真机验收清单」变成一条命令：逐项检查二进制/挂接件/技能/活预览服务/进程卫生，
  每项给 ✓/✗ + 一句怎么修。**不写任何文件、不起任何进程**——纯诊断。
  验收时把整段输出贴回来即可定位问题。

.EXAMPLE
  .\preflight.ps1
  .\preflight.ps1 -WatchPort 26315
#>
[CmdletBinding()]
param(
  [string]$Version = '1.0.149',
  [int]$WatchPort = 26315,
  [string]$ToolsDir = (Join-Path $env:USERPROFILE '.lantai\tools\officecli'),
  [string]$UserLantaiDir = (Join-Path $env:USERPROFILE '.lantai'),
  [string]$PluginDir = (Join-Path $PSScriptRoot '..\plugins\office')
)

$ErrorActionPreference = 'Continue'

# 与 install-officecli.ps1 同一张固定版本表（升级 = 两处同改）
$PINNED = @{
  '1.0.149' = 'abd82dae417b66aae62d1ec8edbf88ba9d5be7442b55be470b34b764f10731e2'
}
$TOOLS_DIR = $ToolsDir
$BIN = Join-Path $TOOLS_DIR 'officecli.exe'
$MCP_JSON = Join-Path $UserLantaiDir 'mcp.json'
$SKILL = Join-Path $UserLantaiDir 'skills\officecli\SKILL.md'

$results = @()
function Check([string]$name, [bool]$ok, [string]$detail, [string]$fix) {
  $script:results += [pscustomobject]@{ name = $name; ok = $ok; detail = $detail; fix = $fix }
}

Write-Host ''
Write-Host '══ OfficeCLI × 兰台 集成预检 ══' -ForegroundColor Cyan

# ── 1. 二进制 ──
if (Test-Path -LiteralPath $BIN -PathType Leaf) {
  $hash = (Get-FileHash -LiteralPath $BIN -Algorithm SHA256).Hash.ToLower()
  $want = $PINNED[$Version]
  $hashOk = ($null -eq $want) -or ($hash -eq $want)
  $ver = (& $BIN --version 2>$null | Select-Object -First 1)
  Check '二进制在位' $true "$BIN（$([math]::Round((Get-Item -LiteralPath $BIN).Length/1MB,2)) MB，--version=$ver）" ''
  Check '哈希与 pin 一致' $hashOk "期望 $want / 实得 $hash" '重跑 install-officecli.ps1（会拒绝坏件并重装）'
  Check '版本与 pin 一致' ($ver -eq $Version) "期望 $Version / 实得 $ver" "换装 pin 版本：install-officecli.ps1 -FromRelease -Version $Version（命令面在长，漂移版本要重跑验收清单）"
}
else {
  Check '二进制在位' $false "缺：$BIN" '跑 examples/office-cli/install-officecli.ps1 -FromRelease（或 -FromLocal <已下载件>）'
}

# ── 2. 挂接件：用户级 mcp.json（A 路）──
if (Test-Path -LiteralPath $MCP_JSON -PathType Leaf) {
  try {
    $raw = Get-Content -LiteralPath $MCP_JSON -Raw | ConvertFrom-Json
    $servers = @($raw.mcpServers)
    $office = @($servers | Where-Object { $_.name -eq 'office' })
    $detail = if ($office.Count -gt 0) {
      $o = $office[0]
      "server=office transport=$($o.transport) command=$($o.command) lifecycle=$($o.lifecycle) restart=$($o.restart) readOnly=$(if ($null -eq $o.readOnly) { '(未声明→按写)' } else { $o.readOnly })"
    }
    else { "文件在但无 name=office 条目（现有：$((@($servers | ForEach-Object { $_.name }) -join ', '))）" }
    Check 'mcp.json 可解析' $true $detail ''
    Check 'mcp.json 含 office server' ($office.Count -gt 0) $detail '或改用插件形态（设置→插件→安装 examples/plugins/office/）'
  }
  catch {
    Check 'mcp.json 可解析' $false "解析失败：$($_.Exception.Message)" '检查 JSON 语法（可删文件改用插件形态）'
  }
}
else {
  Check 'mcp.json 存在' $false "缺：$MCP_JSON（A 路形态）" '想走 A 路就按 examples/office-cli/README.md 建；想走插件形态则此项可不理'
}

# ── 3. 载体现（插件形态，可选）──
$pluginBin = Join-Path $PluginDir 'bin\officecli.exe'
$pluginDirShown = try { (Resolve-Path -LiteralPath $PluginDir -ErrorAction Stop).Path } catch { $PluginDir }
if (Test-Path -LiteralPath $pluginBin -PathType Leaf) {
  $ph = (Get-FileHash -LiteralPath $pluginBin -Algorithm SHA256).Hash.ToLower()
  Check '载体现二进制就位' $true "$pluginBin" ''
  Check '载体现哈希与 pin 一致' ($ph -eq $PINNED[$Version]) "期望 $($PINNED[$Version]) / 实得 $ph" '重跑 install-officecli.ps1 -Dest <插件目录>\bin'
}
else {
  Check '载体现二进制（可选）' $false "未放：$pluginDirShown\bin\officecli.exe" '要用插件形态：install-officecli.ps1 -FromRelease -Dest <插件目录>\bin'
}

# ── 4. 技能 ──
if (Test-Path -LiteralPath $SKILL -PathType Leaf) {
  $text = Get-Content -LiteralPath $SKILL -Raw
  $hasFm = $text.StartsWith('---') -and $text.Contains('name:') -and $text.Contains('description:')
  Check '技能文件在位' $true "$SKILL（$((Get-Item -LiteralPath $SKILL).Length) B）" ''
  Check '技能 frontmatter 完整' $hasFm '需含 name / description（YAML 围栏）' '从 examples/office-cli/SKILL.md 重新拷一份'
}
else {
  Check '技能文件在位' $false "缺：$SKILL" 'Copy-Item examples\office-cli\SKILL.md <该路径>（目录需先建）'
}

# ── 5. 活预览服务（watch）──
$listening = $false
try {
  $listening = (Test-NetConnection -ComputerName 127.0.0.1 -Port $WatchPort -InformationLevel Quiet -WarningAction SilentlyContinue)
}
catch { $listening = $false }
if ($listening) {
  $status = ''
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$WatchPort/" -TimeoutSec 5 -UseBasicParsing
    $status = "HTTP $($resp.StatusCode) / $([math]::Round($resp.RawContentLength/1KB)) KB"
  }
  catch { $status = "端口在听但 HTTP 取不到：$($_.Exception.Message)" }
  Check "活预览服务（127.0.0.1:$WatchPort）" $true "在听；$status" ''
}
else {
  Check "活预览服务（127.0.0.1:$WatchPort）" $false '未在听（= 没起 watch；截图刷新路不需要它）' "officecli watch <文件>（或让 Agent 走 shell 后台起）；之后 office_preview_open 才有东西可显示"
}

# ── 6. 进程卫生（信息项）──
$procs = @(Get-Process officecli -ErrorAction SilentlyContinue)
Check '常驻进程' $true "officecli 进程数：$($procs.Count)（resident 缓存，60s 空闲自退；交付前记得 save/close）" ''

# ── 汇总 ──
Write-Host ''
foreach ($r in $results) {
  $mark = if ($r.ok) { '✓' } else { '✗' }
  $color = if ($r.ok) { 'Green' } else { 'Yellow' }
  Write-Host ("  {0} {1}：{2}" -f $mark, $r.name, $r.detail) -ForegroundColor $color
  if (-not $r.ok -and $r.fix) { Write-Host ("      → {0}" -f $r.fix) -ForegroundColor DarkGray }
}

# 关键项（二进制 + pin 一致 + 技能）决定退出码；可选/信息项不计
$critical = @('二进制在位', '哈希与 pin 一致', '版本与 pin 一致', '技能文件在位')
$failed = @($results | Where-Object { -not $_.ok -and $_.name -in $critical })
$hookOk = @($results | Where-Object { $_.ok -and ($_.name -in @('mcp.json 含 office server', '载体现二进制就位')) }).Count -gt 0
Write-Host ''
if ($failed.Count -eq 0 -and $hookOk) {
  Write-Host '预检结论：关键项全过（二进制 + 挂接 + 技能）——重启兰台后开新会话即可验收。' -ForegroundColor Green
  Write-Host '  真机验收五条见 docs/plans/office-cli-integration-plan.md §8（含 plan 模式反向判据）。' -ForegroundColor DarkGray
  exit 0
}
Write-Host '预检结论：有未过项（见上方 → 提示）。' -ForegroundColor Yellow
exit 1
