# Lantai window-screenshot OCR anchors (computer use batch 4, P1-2).
# Keep this file pure ASCII: PowerShell 5.1 reads .ps1 as ANSI.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ocr_anchors.ps1 -Png <path> -Ox <n> -Oy <n>
# Output: one-line JSON: { engine: "<lang-tag>|none", lines: [{ text, words: [{text,x,y,w,h}] }] }
#         Coordinates stay image-local; the caller adds -Ox/-Oy (window origin) itself.
param(
  [Parameter(Mandatory = $true)][string]$Png,
  [int]$Ox = 0,
  [int]$Oy = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

# PS 5.1 has no await: wait on WinRT IAsyncOperation via AsTask reflection.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

# Engine candidates: user profile languages first, then zh-Hans-CN (self-drawn UIs are
# usually Chinese). Pick the engine that yields the most lines (blank image = ties on 0).
$engines = @()
try {
  $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -ne $e) { $engines += $e }
} catch {}
try {
  $lang = New-Object Windows.Globalization.Language 'zh-Hans-CN'
  $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  if ($null -ne $e) { $engines += $e }
} catch {}

if ($engines.Count -eq 0) {
  Write-Output '{"engine":"none","lines":[]}'
  exit 0
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Png)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$best = $null
foreach ($eng in $engines) {
  $res = Await ($eng.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $n = @($res.Lines).Count
  if ($null -eq $best -or $n -gt $best.N) {
    $best = [pscustomobject]@{ N = $n; Res = $res; Lang = $eng.RecognizerLanguage.LanguageTag }
  }
}

$lines = @()
foreach ($line in $best.Res.Lines) {
  $words = @()
  foreach ($word in $line.Words) {
    $r = $word.BoundingRect
    $words += [pscustomobject]@{
      text = $word.Text
      x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height
    }
  }
  $lines += [pscustomobject]@{ text = $line.Text; words = $words }
}

$payload = [pscustomobject]@{ engine = $best.Lang; ox = $Ox; oy = $Oy; lines = $lines }
Write-Output ($payload | ConvertTo-Json -Depth 6 -Compress)
