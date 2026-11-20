# Draw renderer/logo.png: the JD letter mark, white J and iris D on a dark
# rounded tile with a light edge, transparent outside the tile.
# Drawn at 1024 px and scaled down to 256 px for clean edges.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$dest = Join-Path $root "renderer\logo.png"
$big = 1024
$tile = [System.Drawing.Color]::FromArgb(255, 0x18, 0x1b, 0x22)
$edgeColor = [System.Drawing.Color]::FromArgb(255, 0x3a, 0x40, 0x4e)
$iris = [System.Drawing.Color]::FromArgb(255, 0x7c, 0x6c, 0xff)
$ink = [System.Drawing.Color]::FromArgb(255, 0xf4, 0xf6, 0xf8)

$bmp = New-Object System.Drawing.Bitmap $big, $big
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

# Tile: flat dark rounded square with a lighter edge, corners transparent
$x = 64; $y = 64; $w = 896; $r = 210
$tilePath = New-Object System.Drawing.Drawing2D.GraphicsPath
$tilePath.AddArc($x, $y, 2 * $r, 2 * $r, 180, 90)
$tilePath.AddArc($x + $w - 2 * $r, $y, 2 * $r, 2 * $r, 270, 90)
$tilePath.AddArc($x + $w - 2 * $r, $y + $w - 2 * $r, 2 * $r, 2 * $r, 0, 90)
$tilePath.AddArc($x, $y + $w - 2 * $r, 2 * $r, 2 * $r, 90, 90)
$tilePath.CloseFigure()
$tileBrush = New-Object System.Drawing.SolidBrush $tile
$g.FillPath($tileBrush, $tilePath)
$edgePen = New-Object System.Drawing.Pen $edgeColor, 8
$g.DrawPath($edgePen, $tilePath)
$edgePen.Dispose()
$tilePath.Dispose()
$inkBrush = New-Object System.Drawing.SolidBrush $ink
$irisBrush = New-Object System.Drawing.SolidBrush $iris

$top = 300; $bottom = 780; $stroke = 118

# J: stem plus a half ring hook
$j = New-Object System.Drawing.Drawing2D.GraphicsPath
$stemL = 340; $stemR = $stemL + $stroke
$hookCx = 310; $hookCy = $bottom - 140; $outer = 140; $inner = $outer - $stroke
$j.AddLine($stemL, $top, $stemR, $top)
$j.AddLine($stemR, $top, $stemR, $hookCy)
$j.AddArc($hookCx - $outer, $hookCy - $outer, 2 * $outer, 2 * $outer, 0, 180)
$j.AddLine($hookCx - $outer, $hookCy, $hookCx - $inner, $hookCy)
$j.AddArc($hookCx - $inner, $hookCy - $inner, 2 * $inner, 2 * $inner, 180, -180)
$j.AddLine($stemL, $hookCy, $stemL, $top)
$j.CloseFigure()
$g.FillPath($inkBrush, $j)
$j.Dispose()

# D: outer shape = stem + right half disc, counter knocked out in the tile color
$dStemL = 505; $dCx = 622; $dOuter = ($bottom - $top) / 2
$d = New-Object System.Drawing.Drawing2D.GraphicsPath
$d.AddLine($dStemL, $top, $dCx, $top)
$d.AddArc($dCx - $dOuter, $top, 2 * $dOuter, 2 * $dOuter, 270, 180)
$d.AddLine($dCx, $bottom, $dStemL, $bottom)
$d.CloseFigure()
$g.FillPath($irisBrush, $d)
$d.Dispose()

$dInner = $dOuter - $stroke
$counter = New-Object System.Drawing.Drawing2D.GraphicsPath
$cL = $dStemL + $stroke
$counter.AddLine($cL, $top + $stroke, $dCx, $top + $stroke)
$counter.AddArc($dCx - $dInner, $top + $stroke, 2 * $dInner, 2 * $dInner, 270, 180)
$counter.AddLine($dCx, $bottom - $stroke, $cL, $bottom - $stroke)
$counter.CloseFigure()
$g.FillPath($tileBrush, $counter)
$counter.Dispose()

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
