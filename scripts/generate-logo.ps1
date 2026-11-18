# Draw renderer/logo.png: the JV letter mark on the blue rounded tile.
# Drawn at 1024 px and scaled down to 256 px for clean edges.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$dest = Join-Path $root "renderer\logo.png"
$big = 1024
$blue = [System.Drawing.Color]::FromArgb(255, 0x24, 0x52, 0xa8)
$white = [System.Drawing.Brushes]::White

$bmp = New-Object System.Drawing.Bitmap $big, $big
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

# Tile
$x = 40; $y = 40; $w = 944; $r = 176
$tile = New-Object System.Drawing.Drawing2D.GraphicsPath
$tile.AddArc($x, $y, 2 * $r, 2 * $r, 180, 90)
$tile.AddArc($x + $w - 2 * $r, $y, 2 * $r, 2 * $r, 270, 90)
$tile.AddArc($x + $w - 2 * $r, $y + $w - 2 * $r, 2 * $r, 2 * $r, 0, 90)
$tile.AddArc($x, $y + $w - 2 * $r, 2 * $r, 2 * $r, 90, 90)
$tile.CloseFigure()
$g.FillPath((New-Object System.Drawing.SolidBrush $blue), $tile)

$top = 272; $bottom = 780; $stroke = 120

# J: stem plus a half ring hook
$j = New-Object System.Drawing.Drawing2D.GraphicsPath
$stemL = 330; $stemR = $stemL + $stroke
$hookCx = 300; $hookCy = 630; $outer = 150; $inner = 30
$j.AddLine($stemL, $top, $stemR, $top)
$j.AddLine($stemR, $top, $stemR, $hookCy)
$j.AddArc($hookCx - $outer, $hookCy - $outer, 2 * $outer, 2 * $outer, 0, 180)
$j.AddLine($hookCx - $outer, $hookCy, $hookCx - $inner, $hookCy)
$j.AddArc($hookCx - $inner, $hookCy - $inner, 2 * $inner, 2 * $inner, 180, -180)
$j.AddLine($stemL, $hookCy, $stemL, $top)
$j.CloseFigure()
$g.FillPath($white, $j)

# V: two slanted strokes meeting on a flat foot
$pts = @(
  (New-Object System.Drawing.PointF 520, $top),
  (New-Object System.Drawing.PointF 640, $top),
  (New-Object System.Drawing.PointF 700, 526),
  (New-Object System.Drawing.PointF 760, $top),
  (New-Object System.Drawing.PointF 880, $top),
  (New-Object System.Drawing.PointF 760, $bottom),
  (New-Object System.Drawing.PointF 640, $bottom)
)
$g.FillPolygon($white, [System.Drawing.PointF[]]$pts)
$g.Dispose()

$small = New-Object System.Drawing.Bitmap 256, 256
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g2.Clear([System.Drawing.Color]::Transparent)
$g2.DrawImage($bmp, 0, 0, 256, 256)
$g2.Dispose()
$small.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
$small.Dispose()
$bmp.Dispose()
Write-Host "Wrote logo.png"
