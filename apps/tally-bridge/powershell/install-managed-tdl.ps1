param([Parameter(Mandatory = $true)][string]$AgentResourceDirectory)

$ErrorActionPreference = 'Stop'
$managedFiles = @(
  'kalika-native-debit-note-export.tdl',
  'kalika-purchase-document-attachment.tdl',
  'kalika-agent-sync-reports.tdl'
)
# The installer is a 32-bit process, so $env:ProgramFiles resolves to
# "Program Files (x86)" here. ProgramW6432 is the real 64-bit folder where
# TallyPrime is normally installed; without it this script silently found
# nothing and never updated the TDLs.
# Outer @() keeps a single match as an array; otherwise [0] is its first letter.
$candidateDirectories = @(@(
  $env:ProgramW6432,
  $env:ProgramFiles,
  ${env:ProgramFiles(x86)}
) | Where-Object { $_ } | ForEach-Object { Join-Path $_ 'TallyPrime' } | Select-Object -Unique |
  Where-Object { Test-Path -LiteralPath $_ -PathType Container })

if (-not $candidateDirectories.Count) { exit 0 }
$tallyDirectory = $candidateDirectories[0]
$iniPath = Join-Path $tallyDirectory 'tally.ini'
$sourceDirectory = Join-Path $AgentResourceDirectory 'tdl'
foreach ($fileName in $managedFiles) {
  $source = Join-Path $sourceDirectory $fileName
  if (Test-Path -LiteralPath $source -PathType Leaf) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $tallyDirectory $fileName) -Force
  }
}

if (-not (Test-Path -LiteralPath $iniPath -PathType Leaf)) { exit 0 }
$backup = "$iniPath.kalika-backup-$(Get-Date -Format yyyyMMddHHmmss)"
Copy-Item -LiteralPath $iniPath -Destination $backup -Force
$lines = [System.Collections.Generic.List[string]]::new()
Get-Content -LiteralPath $iniPath | ForEach-Object { [void]$lines.Add($_) }
$userTdlIndex = -1
for ($index = 0; $index -lt $lines.Count; $index++) {
  if ($lines[$index].Trim() -match '^User TDL\s*=') { $userTdlIndex = $index; break }
}
if ($userTdlIndex -ge 0) { $lines[$userTdlIndex] = 'User TDL=Yes' } else { $lines.Add('User TDL=Yes') }
foreach ($fileName in $managedFiles) {
  $target = Join-Path $tallyDirectory $fileName
  $line = "TDL=$target"
  $found = $false
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index].Trim() -match '^TDL\s*=' -and $lines[$index].IndexOf($fileName, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $lines[$index] = $line; $found = $true
    }
  }
  if (-not $found) { $lines.Add($line) }
}
[IO.File]::WriteAllLines($iniPath, $lines, [Text.UTF8Encoding]::new($false))
