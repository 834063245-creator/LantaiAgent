# Build tree-sitter grammar DLLs for HoloGram dynamic loading.
# Usage: .\build.ps1 <language>
#        .\build.ps1 -All        # batch build from grammars.txt list
#
# Requires: git, gcc/g++ (mingw64)
# Note:    markdown requires -DTREE_SITTER_MARKDOWN_AVOID_CRASH for C++ scanner
# Output:  grammars/tree-sitter-<lang>.dll

param(
    [string]$Language,
    [switch]$All
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BuildDir  = Join-Path $ScriptDir "build"
$OutDir    = $ScriptDir  # grammars/ directory

function Build-Grammar($lang) {
    $repoUrl = "https://github.com/tree-sitter-grammars/tree-sitter-$lang.git"
    $repoDir = Join-Path $BuildDir "tree-sitter-$lang"
    $dllName = "tree-sitter-$lang.dll"
    $dllPath = Join-Path $OutDir $dllName

    Write-Host "=== Building $lang ===" -ForegroundColor Cyan

    # Clone if not already present
    if (-not (Test-Path $repoDir)) {
        Write-Host "  cloning $repoUrl ..."
        $prev = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        cmd /c "git clone --depth 1 $repoUrl $repoDir 2>&1 >NUL"
        $ErrorActionPreference = $prev
    }

    # Find parser.c — flat repos (kotlin, toml) 递归找即可；markdown 是 monorepo，
    # 里面有**两个**语法（block 与 inline），导出符号不同名
    # （tree_sitter_markdown vs tree_sitter_markdown_inline），而产物文件名一律是
    # tree-sitter-markdown.dll —— 引擎按 `tree_sitter_{grammar}` 找符号，选中 inline
    # 就等于发一个永远加载不上的库。递归枚举顺序不保证，故钉死 block（与 build.sh 同源）。
    if ($lang -eq "markdown") {
        $parserC = Join-Path $repoDir "tree-sitter-markdown\src\parser.c"
        if (-not (Test-Path $parserC)) {
            Write-Host "  ERROR: no parser.c found at $parserC" -ForegroundColor Red
            return
        }
        $srcDir = Split-Path -Parent $parserC
    } else {
        $found = Get-ChildItem -Path $repoDir -Filter "parser.c" -Recurse -File | Select-Object -First 1
        if (-not $found) {
            Write-Host "  ERROR: no parser.c found in $repoDir" -ForegroundColor Red
            return
        }
        $srcDir = $found.Directory.FullName
        $parserC = $found.FullName
    }
    $scannerC = Join-Path $srcDir "scanner.c"
    $scannerCC = Join-Path $srcDir "scanner.cc"

    $srcFiles = @($parserC)
    if (Test-Path $scannerC)  { $srcFiles += $scannerC }
    if (Test-Path $scannerCC) { $srcFiles += $scannerCC }

    $gccArgs = @(
        "-shared", "-o", $dllPath,
        "-I", $srcDir,
        "-fPIC", "-O2",
        "-static-libgcc", "-static-libstdc++"
    ) + $srcFiles

    # markdown 的 C++ scanner 需要这个 flag（见文件头注释）。纯 C 的
    # kotlin / toml 不受影响，只出 unused-function 警告。
    if ($lang -eq "markdown") {
        $gccArgs += "-DTREE_SITTER_MARKDOWN_AVOID_CRASH"
    }

    Write-Host "  gcc $($gccArgs -join ' ')"
    & gcc @gccArgs

    if ($LASTEXITCODE -ne 0) {
        Write-Host "  FAILED" -ForegroundColor Red
    } else {
        $size = [math]::Round((Get-Item $dllPath).Length / 1KB, 0)
        Write-Host "  OK -> $dllName ($size KB)" -ForegroundColor Green
    }
}

if ($All) {
    $listFile = Join-Path $ScriptDir "grammars.txt"
    if (-not (Test-Path $listFile)) {
        Write-Host "No grammars.txt found. Create one with one language per line." -ForegroundColor Yellow
        exit 1
    }
    Get-Content $listFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            Build-Grammar $line
        }
    }
} elseif ($Language) {
    Build-Grammar $Language
} else {
    Write-Host @"
Usage:
  .\build.ps1 kotlin        # build one grammar
  .\build.ps1 -All          # batch build from grammars.txt

Requires: git, gcc (mingw64)
Output:   grammars/tree-sitter-<lang>.dll
"@
}
