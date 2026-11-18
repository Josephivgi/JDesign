# Install (or update) the locally built Cutline AppX and show how Windows now
# sees it: a package with identity, listed on the privacy pages by name with
# its own microphone and camera switches.
#
# Same-version Remove-AppxPackage drops camsvc grants. ConsentStore restore is
# not a grant. Prefer a higher Identity Version so Add-AppxPackage updates in
# place and Allow stays. Remove only when the incoming version matches.
$ErrorActionPreference = "Stop"
# Launched from a PowerShell 7 shell, Windows PowerShell inherits a module path
# that lists PowerShell 7 folders first, and Get-AuthenticodeSignature then
# fails to load. Keep only Windows PowerShell's own module folders.
if ($PSVersionTable.PSEdition -eq "Desktop") {
  $env:PSModulePath = ($env:PSModulePath -split ';' |
    Where-Object { $_ -and $_ -notmatch '\\PowerShell\\Modules|powershell_7' }) -join ';'
}
$root = Join-Path $PSScriptRoot ".."
$pkg = Get-ChildItem (Join-Path $root "dist-app") -Filter "*.appx" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $pkg) { throw "No .appx in dist-app. Run `npm run build:appx` first." }

# electron-builder has signed the .appx while makeappx was still writing it,
# which leaves the final file unsigned and Add-AppxPackage fails with
# 0x800B0100 ("must be digitally signed"). Check now and re-sign with the dev
# cert instead of letting the deployment die on a cryptic HRESULT.
function Find-Signtool {
  $kits = "C:\Program Files (x86)\Windows Kits\10\bin"
  if (-not (Test-Path $kits)) { return $null }
  Get-ChildItem $kits -Directory |
    Where-Object { $_.Name -match '^10\.\d+\.\d+\.\d+$' } |
    Sort-Object { [Version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName "x64\signtool.exe" } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
}
$sig = Get-AuthenticodeSignature $pkg.FullName -ErrorAction SilentlyContinue
if (-not $sig -or $sig.Status -ne "Valid") {
  $tool = Find-Signtool
  $pfx = Join-Path $root "build\dev-cert\cutline-dev.pfx"
  $pwFile = Join-Path $root "build\dev-cert\password.txt"
  if (-not $tool -or -not (Test-Path $pfx) -or -not (Test-Path $pwFile)) {
    $state = $(if ($sig) { $sig.Status } else { "missing" })
    throw "Package $($pkg.Name) signature is $state and no signtool or dev cert is available to fix it. Rebuild with `npm run build:appx`."
  }
  $pw = (Get-Content $pwFile -Raw).Trim()
  Write-Host "Package signature is $($sig.Status); re-signing $($pkg.Name) with the dev cert"
  & $tool sign /fd sha256 /f $pfx /p $pw $pkg.FullName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "signtool exited $LASTEXITCODE re-signing $($pkg.Name)" }
}

function Backup-AppPrivacy($family) {
  if (-not $family) { return @{} }
  $saved = @{}
  $base = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore"
  foreach ($cap in "microphone", "webcam", "graphicsCaptureProgrammatic", "graphicsCaptureWithoutBorder") {
    $key = Join-Path $base "$cap\$family"
    if (Test-Path $key) {
      $saved[$cap] = Get-ItemProperty $key
    }
  }
  return $saved
}

function Restore-AppPrivacy($family, $saved) {
  if (-not $family -or -not $saved) { return }
  $base = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore"
  foreach ($cap in $saved.Keys) {
    $key = Join-Path $base "$cap\$family"
    $props = $saved[$cap]
    if (-not $props) { continue }
    if (-not (Test-Path $key)) {
      New-Item -Path $key -Force | Out-Null
    }
    if ($props.Value) {
      Set-ItemProperty -Path $key -Name Value -Value $props.Value
    }
    if ($props.PSObject.Properties.Name -contains "LastUsedTimeStart") {
      Set-ItemProperty -Path $key -Name LastUsedTimeStart -Value $props.LastUsedTimeStart
    }
    if ($props.PSObject.Properties.Name -contains "LastUsedTimeStop") {
      Set-ItemProperty -Path $key -Name LastUsedTimeStop -Value $props.LastUsedTimeStop
    }
  }
}

function Get-AppxFileVersion($appxPath) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($appxPath)
  try {
    $entry = $zip.GetEntry("AppxManifest.xml")
    if (-not $entry) { throw "AppxManifest.xml missing in $appxPath" }
    $stream = $entry.Open()
    try {
      $reader = New-Object System.IO.StreamReader($stream)
      try {
        $xml = New-Object System.Xml.XmlDocument
        $xml.LoadXml($reader.ReadToEnd())
        $identity = $xml.GetElementsByTagName("Identity") | Select-Object -First 1
        if (-not $identity) { throw "Identity missing in AppxManifest.xml" }
        return [Version]$identity.GetAttribute("Version")
      } finally {
        $reader.Close()
      }
    } finally {
      $stream.Close()
    }
  } finally {
    $zip.Dispose()
  }
}

$incoming = Get-AppxFileVersion $pkg.FullName
$existing = Get-AppxPackage -Name "Cutline.Desktop" -ErrorAction SilentlyContinue
$privacyBackup = Backup-AppPrivacy $existing.PackageFamilyName
$mustRemove = $false
if ($existing) {
  $have = [Version]$existing.Version
  if ($incoming -gt $have) {
    Write-Host "Updating $($existing.PackageFullName) -> $incoming"
  } elseif ($incoming -eq $have) {
    # Windows refuses a different package with the same version. Last resort:
    # remove first. This drops camsvc grants. Restore only paints ConsentStore.
    Write-Host "Removing $($existing.PackageFullName) (same version, new contents)"
    Get-Process Cutline -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*WindowsApps*" } | Stop-Process -Force
    $mustRemove = $true
  } else {
    throw "Incoming AppX $incoming is older than installed $have. Rebuild."
  }
}
if ($mustRemove) {
  Remove-AppxPackage -Package $existing.PackageFullName
}
Add-AppxPackage -Path $pkg.FullName -ForceUpdateFromAnyVersion -ForceApplicationShutdown
$installed = Get-AppxPackage -Name "Cutline.Desktop"
# Space-separated args. Restore-AppPrivacy(a, b) is one array argument, so $saved
# is empty and Allow never comes back after a same-version remove.
Restore-AppPrivacy $installed.PackageFamilyName $privacyBackup
Write-Host "Installed $($installed.PackageFullName)"
Write-Host "Family   $($installed.PackageFamilyName)"
Write-Host "Launch   explorer.exe shell:AppsFolder\$($installed.PackageFamilyName)!Cutline"

foreach ($cap in "microphone", "webcam", "graphicsCaptureProgrammatic", "graphicsCaptureWithoutBorder") {
  $key = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\$cap\$($installed.PackageFamilyName)"
  $val = (Get-ItemProperty $key -ErrorAction SilentlyContinue).Value
  Write-Host ("Privacy  {0,-28} {1}" -f $cap, ($(if ($val) { $val } else { "(not yet registered)" })))
}
