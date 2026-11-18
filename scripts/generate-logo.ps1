# Draw renderer/logo.png: the JD letter mark, blue J and red D on a white rounded tile.
# Drawn at 1024 px and scaled down to 256 px for clean edges.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$dest = Join-Path $root "renderer\logo.png"
$big = 1024
$blue = [System.Drawing.Color]::FromArgb(255, 0x1f, 0x4f, 0xb0)
$red = [System.Drawing.Color]::FromArgb(255, 0xd4, 0x3a, 0x3a)
$white = [System.Drawing.Brushes]::White

$bmp = New-Object System.Drawing.Bitmap $big, $big
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::White)

# Tile: flat white rounded square with a light edge, on a solid white background
$x = 40; $y = 40; $w = 944; $r = 176
$tile = New-Object System.Drawing.Drawing2D.GraphicsPath
$tile.AddArc($x, $y, 2 * $r, 2 * $r, 180, 90)
$tile.AddArc($x + $w - 2 * $r, $y, 2 * $r, 2 * $r, 270, 90)
$tile.AddArc($x + $w - 2 * $r, $y + $w - 2 * $r, 2 * $r, 2 * $r, 0, 90)
$tile.AddArc($x, $y + $w - 2 * $r, 2 * $r, 2 * $r, 90, 90)
$tile.CloseFigure()
$g.FillPath([System.Drawing.Brushes]::White, $tile)
$edge = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 0xd5, 0xd9, 0xdf)), 10
$g.DrawPath($edge, $tile)
$blueBrush = New-Object System.Drawing.SolidBrush $blue
$redBrush = New-Object System.Drawing.SolidBrush $red

$top = 272; $bottom = 780; $stroke = 120

# J: stem plus a half ring hook (shifted so J + D are centred on the tile)
$j = New-Object System.Drawing.Drawing2D.GraphicsPath
$stemL = 338; $stemR = $stemL + $stroke
$hookCx = 308; $hookCy = 630; $outer = 150; $inner = 30
$j.AddLine($stemL, $top, $stemR, $top)
$j.AddLine($stemR, $top, $stemR, $hookCy)
$j.AddArc($hookCx - $outer, $hookCy - $outer, 2 * $outer, 2 * $outer, 0, 180)
$j.AddLine($hookCx - $outer, $hookCy, $hookCx - $inner, $hookCy)
$j.AddArc($hookCx - $inner, $hookCy - $inner, 2 * $inner, 2 * $inner, 180, -180)
$j.AddLine($stemL, $hookCy, $stemL, $top)
$j.CloseFigure()
$g.FillPath($blueBrush, $j)

# D: outer shape = stem + right half disc (radius 254), counter cut out in the tile white
$dStemL = 506; $dCx = 612; $dOuter = 254; $dInner = 134
$d = New-Object System.Drawing.Drawing2D.GraphicsPath
$d.AddLine($dStemL, $top, $dCx, $top)
$d.AddArc($dCx - $dOuter, $top, 2 * $dOuter, 2 * $dOuter, 270, 180)
$d.AddLine($dCx, $bottom, $dStemL, $bottom)
$d.CloseFigure()
$g.FillPath($redBrush, $d)

$counter = New-Object System.Drawing.Drawing2D.GraphicsPath
$cL = $dStemL + $stroke
$counter.AddLine($cL, $top + $stroke, $dCx, $top + $stroke)
$counter.AddArc($dCx - $dInner, $top + $stroke, 2 * $dInner, 2 * $dInner, 270, 180)
$counter.AddLine($dCx, $bottom - $stroke, $cL, $bottom - $stroke)
$counter.CloseFigure()
$g.FillPath([System.Drawing.Brushes]::White, $counter)

$g.Dispose()

$small = New-Object System.Drawing.Bitmap 256, 256
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g2.Clear([System.Drawing.Color]::White)
$g2.DrawImage($bmp, 0, 0, 256, 256)
$g2.Dispose()
$small.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
$small.Dispose()
$bmp.Dispose()
Write-Host "Wrote logo.png"
