# 纸纹理预处理：暗度压缩/扩幅 out = 1 - k_c*(1-in_c)（k<1 提白，k>1 扩幅放大振幅）
# 用途：src-ui/src/assets/paper/*.jpg 换新图后一次性预处理——两层纹理以
#       background-blend-mode: multiply 相乘（foundation.css body::after 文档级），
#       黄味会复利，故先按通道异权（R .55 / G .40 / B .25）把纹理做成色相中性；
#       再统一扩幅（k=1.6 三通道）补回振幅（提白后方差剩四成）。
#       暖调交由 --paper token carry。参数依据见 docs/design/lantai-design-spec.md §10 法则4。
# 用法：pwsh -File scripts/normalize-paper-texture.ps1 -Path <jpg 路径>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [double]$kr = 0.55,
  [double]$kg = 0.40,
  [double]$kb = 0.25
)
Add-Type -AssemblyName System.Drawing

$bmp = [System.Drawing.Bitmap]::new($Path)

$cm = New-Object System.Drawing.Imaging.ColorMatrix
$cm.Matrix00 = [float]$kr; $cm.Matrix11 = [float]$kg; $cm.Matrix22 = [float]$kb
$cm.Matrix40 = [float](1 - $kr); $cm.Matrix41 = [float](1 - $kg); $cm.Matrix42 = [float](1 - $kb)
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

# 重测均值（定标核对用：两层均值相乘 ≈ 复合压暗因子）
$chk = [System.Drawing.Bitmap]::new($Path)
$small = $chk.GetThumbnailImage(64, 64, $null, [IntPtr]::Zero)
$sb = [System.Drawing.Bitmap]::new($small)
$r = 0; $gg = 0; $b = 0
for ($y = 0; $y -lt 64; $y++) { for ($x = 0; $x -lt 64; $x++) { $c = $sb.GetPixel($x, $y); $r += $c.R; $gg += $c.G; $b += $c.B } }
$n = 64 * 64
"k(R=$kr G=$kg B=$kb)  normalized: R=$([math]::Round($r/$n)) G=$([math]::Round($gg/$n)) B=$([math]::Round($b/$n))  lum=$([math]::Round((($r+$gg+$b)/(3*$n*255)),3))"
$sb.Dispose(); $small.Dispose(); $chk.Dispose()
