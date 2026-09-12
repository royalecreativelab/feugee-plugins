#Requires -Version 5.1
<#
  Feugee Studio - installer & repair (Windows)

  Installs every Feugee panel straight from GitHub into the per-user CEP
  folder, which - unlike the system-wide one a ZXP installer uses - After
  Effects can actually write to. That is what makes live updates work.

  Run Install-Feugee-Plugins.bat, or paste this in PowerShell:
    irm https://raw.githubusercontent.com/royalecreativelab/feugee-plugins/main/install/Install-Feugee-Plugins.ps1 | iex

  No administrator rights needed.
#>
param([switch]$NoPause, [switch]$Force)

$ErrorActionPreference = 'Stop'
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$RAW = 'https://raw.githubusercontent.com/royalecreativelab/feugee-plugins/main/'

$PLUGINS = @(
  [pscustomobject]@{ slug = 'knowledgenuke'; id = 'com.feugee.knowledgenuke'; name = 'Knowledge Nuke' }
  [pscustomobject]@{ slug = 'sidequest';     id = 'com.feugee.sidequest';     name = 'SideQuest' }
  [pscustomobject]@{ slug = 'feugelign';     id = 'com.feugee.feugelign';     name = 'Feugelign' }
  [pscustomobject]@{ slug = 'feugeemotion';  id = 'com.feugee.motion';        name = 'Feugee Motion' }
  [pscustomobject]@{ slug = 'mograph';       id = 'com.feugee.mograph';       name = 'Feugee Mograph' }
)

$USER_EXT = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$SYS_EXT  = @(
  ${env:CommonProgramFiles(x86)}
  $env:CommonProgramFiles
) | Where-Object { $_ } | ForEach-Object { Join-Path $_ 'Adobe\CEP\extensions' } |
    Select-Object -Unique

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Say([string]$s) { Write-Host $s }

function Write-TextFile([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

# Must match the macOS installer and the in-panel updater exactly, or the
# remote-debug port changes every time someone reinstalls on the other OS.
function Get-DebugPort([string]$BundleId) {
  $h = 0
  foreach ($c in $BundleId.ToCharArray()) { $h = ($h * 31 + [int]$c) % 900 }
  return 8100 + $h
}

function Get-DebugXml([string]$BundleId, [int]$Port) {
  # Joined explicitly rather than written as a here-string: this file ships with
  # CRLF endings, and a here-string would bake those into .debug, so the file
  # would differ byte-for-byte from the one the macOS installer writes.
  $lines = @(
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<ExtensionList>'
    ('  <Extension Id="' + $BundleId + '.panel">')
    '    <HostList>'
    ('      <Host Name="AEFT" Port="' + $Port + '"/>')
    '    </HostList>'
    '  </Extension>'
    '</ExtensionList>'
  )
  return (($lines -join "`n") + "`n")
}

function Get-RemoteText([string]$Url) {
  $bust = $Url + '?_t=' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $last = $null
  foreach ($attempt in 1..3) {
    try {
      return (Invoke-WebRequest -Uri $bust -UseBasicParsing -TimeoutSec 90 `
                -Headers @{ 'Cache-Control' = 'no-cache' }).Content
    } catch {
      $last = $_
      Start-Sleep -Seconds ($attempt)
    }
  }
  throw $last
}

Say ''
Say '  FEUGEE STUDIO - plugin installer'
Say '  --------------------------------'
Say ''

if (Get-Process -Name 'AfterFX' -ErrorAction SilentlyContinue) {
  if ($Force) {
    Say '  ! After Effects is running. Installing anyway (-Force)...'
    Say ''
  } else {
    Say '  ! After Effects is running. Quit it first, or run with -Force.'
    Say ''
    if (-not $NoPause) { Read-Host '  Press Enter to close' | Out-Null }
    exit 1
  }
}

$tmp = Join-Path $env:TEMP ('feugee-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

Say ('  target: ' + $USER_EXT)
Say ''

$installed = 0
$failed    = @()
$shadowed  = @()

foreach ($p in $PLUGINS) {
  Say ('  ' + $p.name)

  try {
    $bundle = Get-RemoteText ($RAW + 'bundles/' + $p.slug + '.json') | ConvertFrom-Json
  } catch {
    Say ('    download failed: ' + $_.Exception.Message)
    $failed += ($p.name + ' (download)')
    continue
  }

  if (-not $bundle -or -not $bundle.files) {
    $failed += ($p.name + ' (empty bundle)')
    continue
  }

  # Stage first, then swap in. A half-written panel is worse than none, and on
  # Windows an antivirus scanner interrupting mid-write is a real failure mode.
  $stage = Join-Path $tmp $p.id
  New-Item -ItemType Directory -Path $stage -Force | Out-Null

  $entries = @($bundle.files.PSObject.Properties)
  $ok = $true
  foreach ($f in $entries) {
    $rel = $f.Name -replace '/', '\'
    try {
      Write-TextFile (Join-Path $stage $rel) $f.Value
    } catch {
      Say ('    could not write ' + $f.Name + ': ' + $_.Exception.Message)
      $ok = $false
      break
    }
  }
  if (-not $ok) { $failed += ($p.name + ' (write)'); continue }

  $port = Get-DebugPort $p.id
  Write-TextFile (Join-Path $stage '.debug') (Get-DebugXml $p.id $port)

  $dest = Join-Path $USER_EXT $p.id
  try {
    if (-not (Test-Path -LiteralPath $USER_EXT)) {
      New-Item -ItemType Directory -Path $USER_EXT -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath $dest)) {
      New-Item -ItemType Directory -Path $dest -Force | Out-Null
    }
    # Copy contents over the top: keeps feugee-update.log and anything the
    # panel wrote for itself, same as the macOS installer does.
    Copy-Item -Path (Join-Path $stage '*') -Destination $dest -Recurse -Force
  } catch {
    Say ('    install failed: ' + $_.Exception.Message)
    $failed += ($p.name + ' (install)')
    continue
  }

  foreach ($sys in $SYS_EXT) {
    if (Test-Path -LiteralPath (Join-Path $sys $p.id)) {
      $shadowed += (Join-Path $sys $p.id)
    }
  }

  Say ('    installed v' + $bundle.version + ' (' + $entries.Count + ' files, debug port ' + $port + ')')
  $installed++
}

Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

Say ''
Say '  enabling live-update mode (CEP PlayerDebugMode)...'
$regFailed = @()
foreach ($i in 9..26) {
  $key = "HKCU:\SOFTWARE\Adobe\CSXS.$i"
  try {
    if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
    # Must be REG_SZ. CEP ignores a DWORD here and the panels stay invisible.
    New-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' `
      -PropertyType String -Force | Out-Null
  } catch {
    $regFailed += $i
  }
}
if ($regFailed.Count) { Say ('    failed for CSXS ' + ($regFailed -join ', ')) }
else { Say '    done (CSXS.9 - CSXS.26)' }

Say ''
Say ('  ' + $installed + '/' + $PLUGINS.Count + ' plugins installed')
if ($failed.Count) { Say ('  failed: ' + ($failed -join ', ')) }

$shadowed = @($shadowed | Select-Object -Unique)
if ($shadowed.Count) {
  Say ''
  Say '  ! An older system-wide copy still exists and will clash:'
  $shadowed | ForEach-Object { Say ('      ' + $_) }
  Say '    Remove it once, in an Administrator PowerShell:'
  Say ('      Remove-Item -Recurse -Force ' + (($shadowed | ForEach-Object { '"' + $_ + '"' }) -join ', '))
}

Say ''
Say '  Open After Effects -> Window > Extensions.'
Say '  From now on the update button installs new versions in place.'
Say ''

if (-not $NoPause) { Read-Host '  Press Enter to close' | Out-Null }
if ($failed.Count) { exit 1 }
