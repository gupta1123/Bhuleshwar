param(
  [string] $TallyUrl = "http://localhost:9000",
  [string] $OutDir = ".\tally-sample-results"
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function New-TallyExportXml {
  param(
    [string] $ReportName,
    [hashtable] $StaticVariables = @{}
  )

  $staticXml = ""
  foreach ($entry in $StaticVariables.GetEnumerator()) {
    $staticXml += "<$($entry.Key)>$([System.Security.SecurityElement]::Escape([string] $entry.Value))</$($entry.Key)>"
  }

  return @"
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>$ReportName</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
        $staticXml
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>
"@
}

function Invoke-TallyReadOnlySample {
  param(
    [string] $Name,
    [string] $Xml
  )

  Write-Host ""
  Write-Host "== $Name ==" -ForegroundColor Cyan

  $response = Invoke-WebRequest `
    -Uri $TallyUrl `
    -Method POST `
    -ContentType "text/xml" `
    -Body $Xml `
    -UseBasicParsing

  $content = [string] $response.Content
  $fileName = ($Name.ToLowerInvariant() -replace "[^a-z0-9]+", "-").Trim("-") + ".xml"
  $path = Join-Path $OutDir $fileName
  Set-Content -Path $path -Value $content -Encoding UTF8

  Write-Host "HTTP: $($response.StatusCode)"
  Write-Host "Saved: $path"

  if ($content -match "<LINEERROR[^>]*>([\s\S]*?)</LINEERROR>") {
    Write-Host "Tally line error: $($Matches[1])" -ForegroundColor Yellow
  } elseif ($content -match "<ENVELOPE|<RESPONSE|<LISTOF") {
    Write-Host "XML response received." -ForegroundColor Green
  } else {
    Write-Host "Response was not recognized as Tally XML." -ForegroundColor Yellow
  }

  $preview = $content.Substring(0, [Math]::Min(600, $content.Length))
  Write-Host $preview
}

$samples = @(
  @{
    Name = "Readiness - List Ledgers";
    Xml = New-TallyExportXml -ReportName "List of Accounts" -StaticVariables @{ AccountType = "Ledgers" };
  },
  @{
    Name = "Readiness - List Groups";
    Xml = New-TallyExportXml -ReportName "List of Accounts" -StaticVariables @{ AccountType = "Groups" };
  },
  @{
    Name = "Readiness - List Stock Items";
    Xml = New-TallyExportXml -ReportName "List of Stock Items";
  }
)

Write-Host "Testing Tally at $TallyUrl"
Write-Host "These samples are read-only exports. They do not create or edit Tally data."

foreach ($sample in $samples) {
  Invoke-TallyReadOnlySample -Name $sample.Name -Xml $sample.Xml
}

Write-Host ""
Write-Host "Done. Review saved XML files in $OutDir"
