param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference = 'Stop'
$dir = (Resolve-Path -LiteralPath $Directory).Path
$version = (Get-Content "$PSScriptRoot/package.json" -Raw | ConvertFrom-Json).version
$file = Join-Path $dir "BhuleshwarLocalAgent-$version-x64.exe"
$feed = Join-Path $dir 'latest.yml'
$yaml = [IO.File]::ReadAllText($feed)
$sha = [Security.Cryptography.SHA512]::Create()
$stream = [IO.File]::OpenRead($file)
try { $digest = [Convert]::ToBase64String($sha.ComputeHash($stream)) } finally { $stream.Dispose(); $sha.Dispose() }
if ($yaml -notmatch "(?m)^version: $([regex]::Escape($version))\s*$" -or $yaml -notmatch "(?m)^sha512: $([regex]::Escape($digest))\s*$") { throw 'Installer and feed do not match' }
$public = New-Object Security.Cryptography.X509Certificates.X509Certificate2("$PSScriptRoot/release-cert.pem")
$cert = Get-Item "Cert:/CurrentUser/My/$($public.Thumbprint)"
$key = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
try {
  $payload = [Text.Encoding]::UTF8.GetBytes("com.bhuleshwar.local-agent`nwin32-x64`n$version`n$digest")
  $signature = [Convert]::ToBase64String($key.SignData($payload, 'SHA256', [Security.Cryptography.RSASignaturePadding]::Pkcs1))
} finally { $key.Dispose() }
$yaml = ($yaml -replace '(?m)^bhuleshwarSignature:.*\r?\n?', '').TrimEnd()
[IO.File]::WriteAllText($feed, "$yaml`nbhuleshwarSignature: $signature`n")
