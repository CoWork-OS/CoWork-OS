# CoWork OS Windows installer.
#
# Usage (one line, in PowerShell):
#   irm https://coworkosapp.com/install.ps1 | iex
#
# With options:
#   & ([scriptblock]::Create((irm https://coworkosapp.com/install.ps1))) -Version 0.5.60 -NoLaunch
#
# Or download it first, read it, then run it:
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1
#
# What it does:
#   1. Downloads the release's updater metadata (latest.yml) from GitHub
#      Releases and reads the installer name and SHA-512 from it.
#   2. Downloads the NSIS installer, verifies its SHA-512 against the metadata,
#      and stops if they differ.
#   3. Runs the installer silently for the current user (no admin prompt),
#      waits for it to finish, then opens CoWork OS.
#
# Release builds are not code signed, so a browser download of the installer
# shows a SmartScreen "Windows protected your PC" warning. That warning is
# attached to files carrying the browser's Mark of the Web; this script
# downloads with PowerShell and checks the published hash instead. It does not
# change any SmartScreen, Defender or execution-policy setting.
#
# Re-run the same command to update. Settings and data live outside the
# install directory and are kept.

param(
  [string]$Version = $env:COWORK_INSTALL_VERSION,
  [string]$Repo = $(if ($env:COWORK_INSTALL_REPO) { $env:COWORK_INSTALL_REPO } else { 'CoWork-OS/CoWork-OS' }),
  [string]$Installer = $env:COWORK_INSTALL_INSTALLER,
  [string]$Metadata = $env:COWORK_INSTALL_METADATA,
  [switch]$NoLaunch,
  [switch]$DryRun,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$AppName = 'CoWork OS'

function Write-Log([string]$Message) { Write-Host "[cowork-install] $Message" }

function Stop-Install([string]$Message) {
  Write-Host "[cowork-install] error: $Message" -ForegroundColor Red
  throw "cowork-install: $Message"
}

function Show-Usage {
  @"
CoWork OS Windows installer

Usage:
  irm https://coworkosapp.com/install.ps1 | iex
  & ([scriptblock]::Create((irm https://coworkosapp.com/install.ps1))) [options]

Options:
  -Version X.Y.Z     Install a specific release instead of the latest one.
  -NoLaunch          Do not open the app after installing.
  -DryRun            Resolve the release and print what would happen.
  -Repo OWNER/NAME   GitHub repository to install from. Default: CoWork-OS/CoWork-OS.
  -Installer PATH    Use an already downloaded CoWork-OS-Setup-*.exe.
  -Metadata PATH     Use a local latest.yml instead of downloading it.
  -Help              Show this help.

Environment equivalents: COWORK_INSTALL_VERSION, COWORK_INSTALL_REPO,
COWORK_INSTALL_INSTALLER, COWORK_INSTALL_METADATA.

Re-run the installer to update. Uninstall from Settings > Apps > Installed apps.
"@
}

# Reads electron-builder's latest.yml. Only top-level keys are used: the
# indented "files:" entries repeat the same values and are skipped.
function Read-ReleaseMetadata([string]$Text) {
  $result = @{ Version = $null; Path = $null; Sha512 = $null }
  foreach ($line in ($Text -split "`r?`n")) {
    if ($line -match '^version:\s*(.+?)\s*$') { $result.Version = $Matches[1].Trim("'", '"') }
    elseif ($line -match '^path:\s*(.+?)\s*$') { $result.Path = $Matches[1].Trim("'", '"') }
    elseif ($line -match '^sha512:\s*(.+?)\s*$') { $result.Sha512 = $Matches[1].Trim("'", '"') }
  }
  if (-not $result.Version -or -not $result.Path -or -not $result.Sha512) {
    Stop-Install 'The release metadata is missing version, path or sha512.'
  }
  if ($result.Path -notmatch '^[A-Za-z0-9._-]+\.exe$') {
    Stop-Install "Unexpected installer name in release metadata: $($result.Path)"
  }
  return $result
}

function Get-MetadataUrl([string]$RepoName, [string]$RequestedVersion) {
  if ($RequestedVersion) {
    $tag = 'v' + $RequestedVersion.TrimStart('v')
    return "https://github.com/$RepoName/releases/download/$tag/latest.yml"
  }
  return "https://github.com/$RepoName/releases/latest/download/latest.yml"
}

function Get-InstallerUrl([string]$RepoName, [string]$ReleaseVersion, [string]$FileName) {
  return "https://github.com/$RepoName/releases/download/v$ReleaseVersion/$FileName"
}

# electron-builder publishes base64 SHA-512 digests.
function Get-FileSha512Base64([string]$FilePath) {
  $sha = [System.Security.Cryptography.SHA512]::Create()
  $stream = [System.IO.File]::OpenRead($FilePath)
  try {
    return [Convert]::ToBase64String($sha.ComputeHash($stream))
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

function Test-Sha512([string]$FilePath, [string]$Expected) {
  return (Get-FileSha512Base64 $FilePath) -eq $Expected
}

# Turns an uninstall entry into the app's executable path. electron-builder's
# per-user NSIS installer writes DisplayIcon ("...\CoWork OS.exe,0") but not
# InstallLocation, so DisplayIcon is read first.
function Get-ExePathFromUninstallEntry($Entry) {
  if (-not $Entry) { return $null }
  if ($Entry.DisplayIcon) {
    $icon = ([string]$Entry.DisplayIcon).Trim()
    $icon = $icon -replace ',\s*-?\d+$', ''
    $icon = $icon.Trim('"')
    if ($icon -like '*.exe') { return $icon }
  }
  if ($Entry.InstallLocation) {
    return [System.IO.Path]::Combine(([string]$Entry.InstallLocation).Trim('"'), "$AppName.exe")
  }
  return $null
}

# Finds the installed app through its uninstall entry, falling back to the
# per-user default install folder.
function Find-InstalledApp {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
      $entry = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
      if ($entry -and $entry.DisplayName -like "$AppName*") {
        $exe = Get-ExePathFromUninstallEntry $entry
        if ($exe -and (Test-Path -LiteralPath $exe)) { return $exe }
      }
    }
  }
  if ($env:LOCALAPPDATA) {
    $fallback = [System.IO.Path]::Combine($env:LOCALAPPDATA, 'Programs', 'cowork-os', "$AppName.exe")
    if (Test-Path -LiteralPath $fallback) { return $fallback }
  }
  return $null
}

# Starting the app directly from this PowerShell session would hand it the
# console, so its startup log would print into the user's window. Explorer
# starts it as a separate desktop process instead.
function Get-LaunchCommand([string]$ExePath) {
  $explorer = if ($env:WINDIR) { [System.IO.Path]::Combine($env:WINDIR, 'explorer.exe') } else { 'explorer.exe' }
  return @{ FilePath = $explorer; ArgumentList = '"' + $ExePath + '"' }
}

function Invoke-CoworkInstall {
  if ($Help) {
    Show-Usage
    return
  }
  if ($Repo -notmatch '^[^/\s]+/[^/\s]+$') {
    Stop-Install "-Repo must look like OWNER/NAME, got: $Repo"
  }

  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("cowork-install-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    if ($Metadata) {
      $metadataText = Get-Content -Raw -Path $Metadata
    } else {
      $metadataUrl = Get-MetadataUrl $Repo $Version
      Write-Log "Reading release metadata: $metadataUrl"
      $metadataText = (Invoke-WebRequest -UseBasicParsing -Uri $metadataUrl).Content
      if ($metadataText -is [byte[]]) { $metadataText = [Text.Encoding]::UTF8.GetString($metadataText) }
    }
    $release = Read-ReleaseMetadata $metadataText
    if ($Version -and $release.Version -ne $Version.TrimStart('v')) {
      Stop-Install "Asked for $Version but the metadata describes $($release.Version)."
    }

    $installerUrl = Get-InstallerUrl $Repo $release.Version $release.Path
    if ($DryRun) {
      Write-Log "Would install $AppName $($release.Version) from $installerUrl"
      return
    }

    if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
      Stop-Install "This installer is for Windows. On macOS run: curl -fsSL https://coworkosapp.com/install.sh | bash. Elsewhere: npm install -g cowork-os."
    }
    if ([Environment]::Is64BitOperatingSystem -eq $false) {
      Stop-Install 'CoWork OS needs 64-bit Windows.'
    }

    if ($Installer) {
      $installerPath = $Installer
    } else {
      $installerPath = Join-Path $tmp $release.Path
      Write-Log "Downloading $AppName $($release.Version)..."
      Invoke-WebRequest -UseBasicParsing -Uri $installerUrl -OutFile $installerPath
    }

    if (-not (Test-Sha512 $installerPath $release.Sha512)) {
      Stop-Install 'SHA-512 of the downloaded installer does not match the release metadata. Nothing was installed.'
    }
    Write-Log 'Checksum verified.'

    Write-Log 'Installing for the current user...'
    $process = Start-Process -FilePath $installerPath -ArgumentList '/S' -Wait -PassThru
    if ($process.ExitCode -ne 0) {
      Stop-Install "The installer exited with code $($process.ExitCode)."
    }
    Write-Log "$AppName $($release.Version) installed."

    if (-not $NoLaunch) {
      $exe = Find-InstalledApp
      if ($exe) {
        $launch = Get-LaunchCommand $exe
        Start-Process -FilePath $launch.FilePath -ArgumentList $launch.ArgumentList
      } else {
        Write-Log "Open $AppName from the Start menu."
      }
    }
  } finally {
    Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
  }
}

# Tests dot-source this file with COWORK_INSTALL_SOURCE_ONLY=1 to reach the
# functions without installing anything.
if ($env:COWORK_INSTALL_SOURCE_ONLY -ne '1') {
  Invoke-CoworkInstall
}
