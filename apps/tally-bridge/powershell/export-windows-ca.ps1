param(
  [Parameter(Mandatory = $true)]
  [string] $OutputPath
)

Import-Module Microsoft.PowerShell.Security -ErrorAction Stop

$stores = @(
  "Cert:\CurrentUser\Root",
  "Cert:\LocalMachine\Root",
  "Cert:\CurrentUser\CA",
  "Cert:\LocalMachine\CA"
)
$certificates = @(
  Get-ChildItem -Path $stores -ErrorAction Stop |
    Sort-Object -Property Thumbprint -Unique
)
if ($certificates.Count -eq 0) {
  throw "Windows did not return any trusted certificates."
}

$lines = foreach ($certificate in $certificates) {
  "-----BEGIN CERTIFICATE-----"
  [Convert]::ToBase64String(
    $certificate.RawData,
    [Base64FormattingOptions]::InsertLineBreaks
  )
  "-----END CERTIFICATE-----"
}

$directory = Split-Path -Parent $OutputPath
if ($directory) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
[IO.File]::WriteAllLines($OutputPath, $lines, [Text.Encoding]::ASCII)
