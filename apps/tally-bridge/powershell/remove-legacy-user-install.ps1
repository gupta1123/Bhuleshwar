param([Parameter(Mandatory = $true)][string]$AgentExecutable)

# Early Local Agent builds were installed per user under
# %LOCALAPPDATA%\Programs. That copy kept starting with Windows, re-registered
# kalika-tally:// in HKCU (which wins over the machine install) and held the
# single-instance lock, so Reconnect opened the old agent. The folder holds
# program files only; agent data lives in the user data directory and is kept.
$ErrorActionPreference = 'Stop'
$legacyDirectory = Join-Path $env:LOCALAPPDATA 'Programs\Kalika Local Agent'
$legacyExecutable = Join-Path $legacyDirectory 'Kalika Local Agent.exe'

# The old Inno Setup "Kalika Tally Connector" (0.1.x). Its uninstaller removes
# only its program files, Start menu icon and the kalika-tally:// key (which is
# registered again below); user data is left alone. Entries whose uninstaller
# no longer exists are stale Add/Remove Programs rows.
$oldConnectorKey = '{7C2D55CC-4AF4-4E8D-8F7D-77DD3D41A45F}_is1'
foreach ($root in @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)) {
  $entryPath = Join-Path $root $oldConnectorKey
  $entry = Get-ItemProperty -LiteralPath $entryPath -ErrorAction SilentlyContinue
  if (-not $entry) { continue }
  $uninstaller = ([string]$entry.UninstallString).Trim('"')
  if ($uninstaller -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    try {
      $process = Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -PassThru
      if (-not $process.WaitForExit(120000)) { $process.Kill() }
    } catch { }
  }
  if (Test-Path -LiteralPath $entryPath) { Remove-Item -LiteralPath $entryPath -Recurse -Force -ErrorAction SilentlyContinue }
}

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runEntry = (Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue).'com.kalika.local-agent'
if ($runEntry -and $runEntry.IndexOf($legacyDirectory, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
  Remove-ItemProperty -LiteralPath $runKey -Name 'com.kalika.local-agent'
}

if (Test-Path -LiteralPath $legacyExecutable -PathType Leaf) {
  Remove-Item -LiteralPath $legacyDirectory -Recurse -Force
}

# Point Reconnect links at this installation.
$commandKey = 'HKCU:\Software\Classes\kalika-tally\shell\open\command'
New-Item -Path $commandKey -Force | Out-Null
Set-ItemProperty -LiteralPath 'HKCU:\Software\Classes\kalika-tally' -Name '(default)' -Value 'URL:kalika-tally'
Set-ItemProperty -LiteralPath 'HKCU:\Software\Classes\kalika-tally' -Name 'URL Protocol' -Value ''
Set-ItemProperty -LiteralPath $commandKey -Name '(default)' -Value "`"$AgentExecutable`" `"%1`""
