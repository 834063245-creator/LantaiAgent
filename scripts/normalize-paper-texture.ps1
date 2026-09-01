# 纸纹理预处理：暗度压缩/扩幅 out = 1 - k_c*(1-in_c)（k<1 提白，k>1 扩幅放大振幅）
# 用途：src-ui/src/assets/paper/*.jpg 换新图后一次性预处理——两层纹理以
#       background-blend-mode: multiply 相乘（foundation.css body::after 文档级），
#       黄味会复利，故先按通道异权（R .55 / G .40 / B .25）把纹理做成色相中性；
#       再统一扩幅（k=1.6 三通道）补回振幅（提白后方差剩四成）。
#       暖调交由 --paper token carry。参数依据见 docs/design/lantai-design-spec.md §10 法则4。
#       印泥 seal-paste.jpg 同管道另参数：提白 R .306 / G .082 / B .081（成中性灰
#       T.93，色随 --seal token 走）→ 扩幅 1.75 三通道（均值 0.88 / p10-p90 .11）。
#       流区贴纸纹 paper-sheet.jpg：-Sheet 模式，由 paper-fiber.jpg 副本派生——
#       线性扩幅并回中 out = a*in + b（a=1.63 / b=-0.555：振幅 .031→.070 立得住、
#       均值保 .94 不动纸色；2026-09-01 贴纸纹理批，依据 = 流区自纹实机不可见
#       （T2 活体验证），桌面纹/贴纸纹须各有其主）。
# 用法：pwsh -File scripts/normalize-paper-texture.ps1 -Path <jpg 路径>
#       贴纸纹：先 Copy-Item paper-fiber.jpg paper-sheet.jpg，再 -Path <sheet> -Sheet
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [double]$kr = 0.55,
  [double]$kg = 0.40,
  [double]$kb = 0.25,
  [switch]$Sheet,
  [double]$sheetA = 1.63,
  [double]$sheetB = -0.555
)
Add-Type -AssemblyName System.Drawing

$bmp = [System.Drawing.Bitmap]::new($Path)

$cm = New-Object System.Drawing.Imaging.ColorMatrix
if ($Sheet) {
  $cm.Matrix00 = [float]$sheetA; $cm.Matrix11 = [float]$sheetA; $cm.Matrix22 = [float]$sheetA
  $cm.Matrix40 = [float]$sheetB; $cm.Matrix41 = [float]$sheetB; $cm.Matrix42 = [float]$sheetB
} else {
  $cm.Matrix00 = [float]$kr; $cm.Matrix11 = [float]$kg; $cm.Matrix22 = [float]$kb
  $cm.Matrix40 = [float](1 - $kr); $cm.Matrix41 = [float](1 - $kg); $cm.Matrix42 = [float](1 - $kb)
}
$ia = New-Object System.Drawing.Imaging.ImageAttributes
$ia.SetColorMatrix($cm)

$tmpPath = "$Path.tmp.jpg"
$out = New-Object System.Drawing.Bitmap($bmp.Width, $bmp.Height)
$g = [System.Drawing.Graphics]::FromImage($out)
$rect = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
$g.DrawImage($bmp, $rect, 0, 0, $bmp.Width, $bmp.Height, [System.Drawing.GraphicsUnit]::Pixel, $ia)
$g.Dispose()

$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]85)
$out.Save($tmpPath, $jpegCodec, $ep)
$out.Dispose()
$bmp.Dispose()
Move-Item -Force $tmpPath $Path

# 重测均值（定标核对用：两层均值相乘 ≈ 复合压暗因子）——抽样步进直接量，
# 不走 GetThumbnailImage（GDI+ 缩略在该环境下偶发返 null，曾整段假错）
$chk = [System.Drawing.Bitmap]::new($Path)
$r = 0; $gg = 0; $b = 0
$step = 8
for ($y = 0; $y -lt $chk.Height; $y += $step) {
  for ($x = 0; $x -lt $chk.Width; $x += $step) { $c = $chk.GetPixel($x, $y); $r += $c.R; $gg += $c.G; $b += $c.B } }
$n = [math]::Ceiling($chk.Width / $step) * [math]::Ceiling($chk.Height / $step)
$chk.Dispose()
if ($Sheet) {
  "sheet(a=$sheetA b=$sheetB)  normalized: R=$([math]::Round($r/$n)) G=$([math]::Round($gg/$n)) B=$([math]::Round($b/$n))  lum=$([math]::Round((($r+$gg+$b)/(3*$n*255)),3))"
} else {
  "k(R=$kr G=$kg B=$kb)  normalized: R=$([math]::Round($r/$n)) G=$([math]::Round($gg/$n)) B=$([math]::Round($b/$n))  lum=$([math]::Round((($r+$gg+$b)/(3*$n*255)),3))"
}
