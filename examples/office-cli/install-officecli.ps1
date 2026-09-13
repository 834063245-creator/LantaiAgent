<#
.SYNOPSIS
  OfficeCLI 安装 / 校验器（兰台集成件 · 分发用）。

.DESCRIPTION
  三种来源任选其一（互斥）：
    -FromLocal <exe路径>     从本机已有二进制装（开发机/离线分发）
    -FromPluginDir <目录>    从插件目录自带形态装（目录内 officecli.exe 或 bin/officecli.exe）
    -FromRelease             从 GitHub Releases 下载（按 -Version 取 tag）

  一律做 SHA256 校验后才落位；**校验失败即拒绝安装**（错误不静默）：
    · 版本在下方固定表内 → 用内嵌哈希比对（最强：防篡改 + 防截断）
    · 版本不在表内     → 拉官方 SHA256SUMS 比对，并显式告警「未固定版本」

  幂等：目标已是同哈希 → 报告"无需安装"直接成功。
  升级：目标哈希不同 → 旧件先挪 `officecli.exe.bak-<时间戳>`（不删，可回退），再装新件。

  安装落位（默认）：%USERPROFILE%\.lantai\tools\officecli\
    officecli.exe / SHA256SUMS / VERSION（版本 + 哈希 + 安装时间）

.EXAMPLE
  # 从插件目录自带件装到用户工具位
  .\install-officecli.ps1 -FromPluginDir .\bin

.EXAMPLE
  # 从本机已下载件装（离线）
  .\install-officecli.ps1 -FromLocal D:\downloads\officecli-win-x64.exe

.EXAMPLE
  # 未固定版本（走官方 SHA256SUMS 比对）：离线时用本地清单替代下载
  .\install-officecli.ps1 -FromLocal .\officecli.exe -Version 1.0.148 -SumsOverride .\SHA256SUMS

.NOTES
  实测坑（2026-09-13）：
  · Invoke-WebRequest 的进度条渲染会让同一资产慢一个数量级——脚本已关
    `$ProgressPreference`；网络极慢时优先 `-FromLocal`（手动下载后本地装）。
  · 下载失败会清掉半截临时文件（原先会留 20-30 MB 残件）。
  · 未固定版本的清单拉取失败走**结构化拒绝**（原先异常逃逸，只看到一串栈）。
  · `VERSION` 记**二进制自报版本**为准，请求版本另记 `requested_version`（防假账）。
#>
[CmdletBinding()]
param(
  [string]$Version = '1.0.149',
  [string]$Dest = "$env:USERPROFILE\.lantai\tools\officecli",
  [string]$FromLocal,
  [string]$FromPluginDir,
  [switch]$FromRelease,
  [string]$SumsOverride,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest 的进度条渲染是著名的下载税（实测同一资产可慢一个数量级）——
# 关掉它；这是本脚本 `-FromRelease` 的成败关键，不是微优化。
$ProgressPreference = 'SilentlyContinue'

# ── 固定版本表（本仓集成计划 pin 的版本；升级 = 换 tag + 换哈希，同改本文档）──
$PINNED = @{
  '1.0.149' = 'abd82dae417b66aae62d1ec8edbf88ba9d5be7442b55be470b34b764f10731e2'
}
$ASSET = 'officecli-win-x64.exe'

function Fail([string]$msg) {
  Write-Host "[officecli-install] 拒绝：$msg" -ForegroundColor Red
  exit 1
}

# ── 来源解析（三选一，多选/零选都拒）──
$sources = @()
if ($FromLocal) { $sources += 'local' }
if ($FromPluginDir) { $sources += 'plugin' }
if ($FromRelease) { $sources += 'release' }
if ($sources.Count -ne 1) {
  Fail "必须且只能指定一种来源：-FromLocal / -FromPluginDir / -FromRelease（当前 $($sources.Count) 个）"
}

$tempFile = $null
if ($sources[0] -eq 'local') {
  if (-not (Test-Path -LiteralPath $FromLocal -PathType Leaf)) { Fail "本地件不存在：$FromLocal" }
  $srcPath = (Resolve-Path -LiteralPath $FromLocal).Path
}
elseif ($sources[0] -eq 'plugin') {
  # 注意 @(...) 包裹：Where-Object 单命中时返回标量，$cand[0] 会取到首字符（实测踩过）
  $first = @(
    @(
      (Join-Path $FromPluginDir 'officecli.exe'),
      (Join-Path $FromPluginDir 'bin\officecli.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
  ) | Select-Object -First 1
  if (-not $first) { Fail "插件目录里找不到 officecli.exe 或 bin\officecli.exe：$FromPluginDir" }
  $srcPath = (Resolve-Path -LiteralPath $first).Path
}
else {
  $url = "https://github.com/iOfficeAI/OfficeCLI/releases/download/v$Version/$ASSET"
  $releasesKnown = $PINNED.ContainsKey($Version)
  if (-not $releasesKnown) {
    Write-Host "[officecli-install] 告警：$Version 不在固定版本表内——将用官方 SHA256SUMS 比对（不防上游替换）" -ForegroundColor Yellow
  }
  $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) ("officecli-dl-" + [guid]::NewGuid().ToString('N') + ".exe")
  Write-Host "[officecli-install] 下载 $url"
  try {
    Invoke-WebRequest -Uri $url -OutFile $tempFile
  }
  catch {
    # 失败（超时/断流）必须清掉半截文件——否则 %TEMP% 里留一个 20-30 MB 的残件
    if (Test-Path -LiteralPath $tempFile) { Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue }
    Fail "下载失败：$($_.Exception.Message)（网络慢时可先手动下载再用 -FromLocal <文件>）"
  }
  $srcPath = $tempFile
}

# ── 来源形状与哈希校验 ──
$bytes = [System.IO.File]::ReadAllBytes($srcPath)
if ($bytes.Length -lt 2 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
  Fail "来源不是 PE 可执行文件（缺 MZ 魔数）：$srcPath"
}
$hash = (Get-FileHash -LiteralPath $srcPath -Algorithm SHA256).Hash.ToLower()

if ($PINNED.ContainsKey($Version)) {
  $want = $PINNED[$Version]
  if ($hash -ne $want) {
    Fail "SHA256 不匹配（$Version）：期望 $want 实得 $hash —— 下载截断/被替换，拒绝安装"
  }
  Write-Host "[officecli-install] 哈希校验通过（固定版本 $Version）"
}
else {
  $sumsUrl = "https://github.com/iOfficeAI/OfficeCLI/releases/download/v$Version/SHA256SUMS"
  $sumsText = $null
  if ($SumsOverride) {
    # 离线/受限网络：用本地 SHA256SUMS 文件替代官方下载（校验逻辑与逐字相同）
    if (-not (Test-Path -LiteralPath $SumsOverride -PathType Leaf)) { Fail "SHA256SUMS 文件不存在：$SumsOverride" }
    $sumsText = Get-Content -LiteralPath $SumsOverride -Raw
    Write-Host "[officecli-install] 使用本地 SHA256SUMS：$SumsOverride" -ForegroundColor Yellow
  }
  else {
    try {
      $sumsText = (Invoke-WebRequest -Uri $sumsUrl).Content
    }
    catch {
      # 网络问题必须是**清清楚楚的拒绝**，不是未捕获异常逃逸（实测踩过）
      Fail "取官方 SHA256SUMS 失败：$($_.Exception.Message)（网络不稳；可改固定版本 -Version 1.0.149 用内嵌哈希，或离线下载 SHA256SUMS 后用 -SumsOverride <文件>）"
    }
  }
  $want = $null
  foreach ($line in ($sumsText -split "`n")) {
    $parts = $line.Trim() -split '\s+'
    if ($parts.Count -ge 2 -and $parts[-1] -eq $ASSET) { $want = $parts[0].ToLower() }
  }
  if (-not $want) { Fail "官方 SHA256SUMS 里找不到 $ASSET（版本 $Version 存在吗？）" }
  if ($hash -ne $want) { Fail "SHA256 不匹配（官方清单）：期望 $want 实得 $hash" }
  Write-Host "[officecli-install] 哈希校验通过（官方清单，未固定版本 $Version）" -ForegroundColor Yellow
}

# ── 落位（幂等 / 旧件挪 .bak）──
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$target = Join-Path $Dest 'officecli.exe'
if (Test-Path -LiteralPath $target -PathType Leaf) {
  $existing = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower()
  if ($existing -eq $hash) {
    Write-Host "[officecli-install] 目标已是同哈希——无需安装：$target"
    if (-not $Force) { exit 0 }
  }
  else {
    $bak = "$target.bak-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
    Move-Item -LiteralPath $target -Destination $bak -Force
    Write-Host "[officecli-install] 旧件已挪：$bak" -ForegroundColor Yellow
  }
}
Copy-Item -LiteralPath $srcPath -Destination $target -Force
if ($tempFile -and (Test-Path -LiteralPath $tempFile)) { Remove-Item -LiteralPath $tempFile -Force }

# VERSION 记**二进制自报**的版本为首要事实（requested_version 另记）——实测踩过：
# 用未固定版本参数装 1.0.149 的件，若照抄参数会把 VERSION 写成 1.0.148（假账）。
$binaryVersion = (& $target --version | Select-Object -First 1)
$versionLines = @("version=$binaryVersion")
if ($binaryVersion -ne $Version) { $versionLines += "requested_version=$Version" }
$versionLines += @(
  "sha256=$hash"
  "installed_at=$((Get-Date).ToString('s'))"
  "source=$($sources[0])"
)
$versionLines | Set-Content -LiteralPath (Join-Path $Dest 'VERSION') -Encoding ASCII

Write-Host "[officecli-install] 装好：$target"
Write-Host "[officecli-install] 自检 --version → $binaryVersion"
if ($binaryVersion -ne $Version) {
  Write-Host "[officecli-install] 注意：二进制自报版本 $binaryVersion ≠ 请求版本 $Version（VERSION 文件两者都记）" -ForegroundColor Yellow
}
Write-Host "[officecli-install] 下一步：在 ~/.lantai/mcp.json 声明 server（command 用上面的绝对路径，正斜杠形态）"
