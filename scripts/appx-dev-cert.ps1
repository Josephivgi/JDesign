# Make a self-signed code signing certificate for local AppX (MSIX) builds and
# trust it for sideloading. The subject must equal build.appx.publisher in
# package.json. Run from an elevated PowerShell (the TrustedPeople import is
# machine wide). Output lands in build/dev-cert (gitignored).
$ErrorActionPreference = "Stop"
$subject = "CN=Cutline Dev"
$root = Join-Path $PSScriptRoot ".."
$outDir = Join-Path $root "build\dev-cert"
$pfx = Join-Path $outDir "cutline-dev.pfx"
$cer = Join-Path $outDir "cutline-dev.cer"
$pwFile = Join-Path $outDir "password.txt"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$existing = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $subject } | Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $existing) {
  $existing = New-SelfSignedCertificate -Type Custom -Subject $subject -KeyUsage DigitalSignature `
    -FriendlyName "Cutline dev AppX signing" -CertStoreLocation Cert:\CurrentUser\My `
    -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}") -NotAfter (Get-Date).AddYears(3)
  Write-Host "Created certificate $($existing.Thumbprint)"
} else {
  Write-Host "Reusing certificate $($existing.Thumbprint)"
}

if (-not (Test-Path $pwFile)) {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [Convert]::ToBase64String($bytes) | Set-Content -NoNewline $pwFile
}
$password = ConvertTo-SecureString -String (Get-Content -Raw $pwFile) -Force -AsPlainText
Export-PfxCertificate -Cert $existing -FilePath $pfx -Password $password | Out-Null
Export-Certificate -Cert $existing -FilePath $cer | Out-Null
Write-Host "Wrote $pfx"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  $trusted = Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object { $_.Thumbprint -eq $existing.Thumbprint }
  if (-not $trusted) {
    Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
    Write-Host "Trusted for sideload (LocalMachine\TrustedPeople)"
  } else {
    Write-Host "Already trusted for sideload"
  }
} else {
  Write-Host "Not elevated. To trust the package for install, run as admin:"
  Write-Host "  Import-Certificate -FilePath `"$cer`" -CertStoreLocation Cert:\LocalMachine\TrustedPeople"
}
