# Copyright (c) 2026 Wenbing Jing. MIT License.
# SPDX-License-Identifier: MIT
#
# visual-probe — 视觉改动的可复算读数器（2026-09-17，P1「图版语汇」批立）
#
# 为什么需要它：兰台不跑视觉模型，agent 看不见自己的产出，而「看着对不对」这类
# 判断又不能靠用户的眼睛逐轮喂（taste-ledger 2026-08-22 点名的结构性瓶颈，
# 2026-08-22 那轮生成到第十一张变体触发止损）。本脚本把「看」换成「量」：
#   headless Edge 渲染 → 像素扫描 → 逐带墨迹区间 + ASCII 墨迹图 + 读数表。
#
# 它抓到过的两类真实病灶（都在产品里活过很久）：
#   ① 声明存在却从未画出来：`border: 2px solid var(--rule-soft)` 展开成非法声明
#      （全仓 49 处），像素上表现为「该有线的位置 0 个墨点」；
#   ② 版心没被用满：chart 3 类柱图被 SVG meet 缩成 213px 居中（两侧各空 253px）。
#
# 用法：
#   pwsh -File scripts/visual-probe.ps1 -Html prototype/asset-cards-ab.html -Width 780
#   pwsh -File scripts/visual-probe.ps1 -Html .lantai/temp/chart-probe.html -Ascii -BandH 8
#
# 读数口径：纸底 = 页面默认背景；「墨」= 亮度低于 -LumMax 的像素。区间是按行带
# 合并出的连续横向墨迹段——**卡片宽 720 而墨迹段只有 ~213** 就是「版心没用满」的实据。

param(
    [Parameter(Mandatory = $true)][string]$Html,
    [int]$Width = 780,
    [int]$Height = 900,
    [int]$BandH = 10,
    [int]$LumMax = 180,
    [string]$Out = "",
    [switch]$Ascii,
    [int]$AsciiCols = 2
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$edge = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "找不到 msedge.exe（headless 渲染需要 Edge）" }

$htmlPath = (Resolve-Path $Html).Path
if (-not $Out) {
    $Out = Join-Path $env:TEMP ("visual-probe-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + ".png")
}

$uri = "file:///" + ($htmlPath -replace '\\', '/')
& $edge --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 `
    "--screenshot=$Out" "--window-size=$Width,$Height" $uri 2>$null | Out-Null
Start-Sleep -Milliseconds 600
if (-not (Test-Path $Out)) { throw "Edge 未产出截图（$Out）" }

$bmp = [System.Drawing.Bitmap]::FromFile($Out)
try {
    Write-Output ("[visual-probe] {0}" -f $htmlPath)
    Write-Output ("[visual-probe] 截图 {0}×{1} · 亮度阈值 {2} · 输出 {3}" -f $bmp.Width, $bmp.Height, $LumMax, $Out)

    # 预扫：整页墨迹包围盒 + 墨点总数（一眼看出「这页有没有画出来」）
    $xMinAll = $bmp.Width; $xMaxAll = -1; $yMinAll = $bmp.Height; $yMaxAll = -1; $inkAll = 0
    $bandRows = @()
    for ($y0 = 0; $y0 -lt $bmp.Height; $y0 += $BandH) {
        $y1 = [Math]::Min($y0 + $BandH, $bmp.Height)
        # 逐列标记（行主序会把 x 归零，必须先聚成列集合再按 x 升序合并区间）
        $col = New-Object 'bool[]' $bmp.Width
        $ink = 0
        for ($y = $y0; $y -lt $y1; $y++) {
            for ($x = 0; $x -lt $bmp.Width; $x++) {
                $p = $bmp.GetPixel($x, $y)
                if ((($p.R + $p.G + $p.B) / 3) -lt $LumMax) {
                    if (-not $col[$x]) { $col[$x] = $true }
                    $ink++
                    $inkAll++
                    if ($x -lt $xMinAll) { $xMinAll = $x }
                    if ($x -gt $xMaxAll) { $xMaxAll = $x }
                    if ($y -lt $yMinAll) { $yMinAll = $y }
                    if ($y -gt $yMaxAll) { $yMaxAll = $y }
                }
            }
        }
        if ($ink -gt 0) {
            # 连续横向墨迹段（间隔 > 12px 视为断开）——「卡片 720 宽但只有一段 213」即此读出
            $runs = @(); $start = -1; $prev = -1
            for ($x = 0; $x -lt $bmp.Width; $x++) {
                if (-not $col[$x]) { continue }
                if ($start -lt 0) { $start = $x; $prev = $x; continue }
                if ($x - $prev -gt 12) {
                    $runs += ("{0}-{1}({2})" -f $start, $prev, ($prev - $start + 1))
                    $start = $x
                }
                $prev = $x
            }
            if ($start -ge 0) { $runs += ("{0}-{1}({2})" -f $start, $prev, ($prev - $start + 1)) }
            $bandRows += [pscustomobject]@{
                Y0 = $y0; Y1 = $y1; Ink = $ink; Runs = ($runs -join " ")
            }
        }
    }

    if ($inkAll -eq 0) {
        Write-Output "[visual-probe] ⚠ 整页零墨点——要么页面是空的，要么**声明存在但没生效**（先查非法 CSS 声明）"
    }
    else {
        Write-Output ("[visual-probe] 整页墨迹包围盒 x {0}..{1}（宽 {2}）· y {3}..{4}（高 {5}）· 墨点 {6}" -f `
                $xMinAll, $xMaxAll, ($xMaxAll - $xMinAll + 1), $yMinAll, $yMaxAll, ($yMaxAll - $yMinAll + 1), $inkAll)
    }

    Write-Output ""
    Write-Output "== 逐带墨迹区间（y 起止 · 墨点 · 连续段[x0-x1(宽)]）=="
    foreach ($b in $bandRows) {
        Write-Output ("  y {0,4}-{1,-4}  {2,6}  {3}" -f $b.Y0, $b.Y1, $b.Ink, $b.Runs)
    }

    # 空白带（> 2 带高无墨）——「该有线的位置什么都没有」就靠这段读出来
    $gaps = @(); $cursor = 0
    foreach ($b in $bandRows) {
        if ($b.Y0 - $cursor -gt 2 * $BandH) { $gaps += ("{0}-{1}" -f $cursor, $b.Y0) }
        $cursor = $b.Y1
    }
    if ($bmp.Height - $cursor -gt 2 * $BandH) { $gaps += ("{0}-{1}" -f $cursor, $bmp.Height) }
    if ($gaps.Count -gt 0) {
        Write-Output ("[visual-probe] 空白带 y：{0}（该有墨却零墨的位置 = 声明可能没生效）" -f ($gaps -join " "))
    }

    if ($Ascii) {
        Write-Output ""
        Write-Output "== ASCII 墨迹图（# 重墨 / + 淡墨 / . 空）=="
        $cols = [Math]::Floor($bmp.Width / $AsciiCols)
        for ($r = 0; $r -lt [Math]::Floor($bmp.Height / $BandH); $r++) {
            $line = ""
            for ($c = 0; $c -lt $cols; $c++) {
                $ink = 0; $dark = 0
                for ($y = $r * $BandH; $y -lt [Math]::Min(($r + 1) * $BandH, $bmp.Height); $y += 2) {
                    for ($x = $c * $AsciiCols; $x -lt [Math]::Min(($c + 1) * $AsciiCols, $bmp.Width); $x++) {
                        $p = $bmp.GetPixel($x, $y)
                        $l = ($p.R + $p.G + $p.B) / 3
                        if ($l -lt $LumMax) { $ink++; if ($l -lt 120) { $dark++ } }
                    }
                }
                $line += if ($dark -ge 1) { '#' } elseif ($ink -ge 1) { '+' } else { '.' }
            }
            Write-Output ("  {0,4} {1}" -f ($r * $BandH), $line)
        }
    }
}
finally {
    $bmp.Dispose()
}
