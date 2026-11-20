# Build AppX tile and splash PNGs from renderer/logo.png.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$src = Join-Path $root "renderer\logo.png"
$out = Join-Path $root "build\appx"
$bg = [System.Drawing.Color]::FromArgb(0x18, 0x1b, 0x22)

if (-not (Test-Path $src)) { throw "Missing $src" }
New-Item -ItemType Directory -Force -Path $out | Out-Null

function Save-PngAsset([string]$name, [int]$width, [int]$height, [bool]$fill = $false) {
  $dest = Join-Path $out $name
  $srcImg = [System.Drawing.Image]::FromFile($src)
  $bmp = New-Object System.Drawing.Bitmap $width, $height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear($bg)
  if ($fill) {
    $g.DrawImage($srcImg, 0, 0, $width, $height)
  } else {
    $scale = [Math]::Min($width / $srcImg.Width, $height / $srcImg.Height)
    $nw = [int][Math]::Round($srcImg.Width * $scale)
    $nh = [int][Math]::Round($srcImg.Height * $scale)
    $x = [int](($width - $nw) / 2)
    $y = [int](($height - $nh) / 2)
    $g.DrawImage($srcImg, $x, $y, $nw, $nh)
  }
  $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  $srcImg.Dispose()
  Write-Host "Wrote $name"
}

Save-PngAsset "StoreLogo.png" 50 50
Save-PngAsset "Square44x44Logo.png" 44 44
Save-PngAsset "Square150x150Logo.png" 150 150
Save-PngAsset "Wide310x150Logo.png" 310 150
Save-PngAsset "SplashScreen.png" 620 300
