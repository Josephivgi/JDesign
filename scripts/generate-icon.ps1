# Regenerate renderer/icon.ico from renderer/logo.png for the window/taskbar icon.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$src = Join-Path $root "renderer\logo.png"
$dest = Join-Path $root "renderer\icon.ico"
$sizes = @(16, 24, 32, 48, 64, 128, 256)

$srcImg = [System.Drawing.Image]::FromFile($src)
$images = New-Object System.Collections.Generic.List[System.Drawing.Bitmap]
foreach ($size in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($srcImg, 0, 0, $size, $size)
  $g.Dispose()
  $images.Add($bmp)
}
$srcImg.Dispose()

$fs = [System.IO.File]::Open($dest, [System.IO.FileMode]::Create)
try {
  $writer = New-Object System.IO.BinaryWriter $fs
  $writer.Write([UInt16]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]$images.Count)
  $offset = 6 + (16 * $images.Count)
  foreach ($img in $images) {
    $width = if ($img.Width -ge 256) { 0 } else { $img.Width }
    $height = if ($img.Height -ge 256) { 0 } else { $img.Height }
    $writer.Write([Byte]$width)
    $writer.Write([Byte]$height)
    $writer.Write([Byte]0)
    $writer.Write([Byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $ms = New-Object System.IO.MemoryStream
    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose()
    $writer.Write([UInt32]$bytes.Length)
    $writer.Write([UInt32]$offset)
    $offset += $bytes.Length
  }
  foreach ($img in $images) {
    $ms = New-Object System.IO.MemoryStream
    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $writer.Write($ms.ToArray())
    $ms.Dispose()
    $img.Dispose()
  }
} finally {
  $fs.Dispose()
}
Write-Host "Wrote icon.ico"
