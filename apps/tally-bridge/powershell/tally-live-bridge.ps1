param(
  [Parameter(Mandatory = $true)]
  [string] $ApiBase,

  [Parameter(Mandatory = $true)]
  [string] $ConnectionId,

  [Parameter(Mandatory = $true)]
  [string] $BridgeToken,

  [string] $TallyUrl = "http://localhost:9000",
  [string] $CompanyName = "",
  [int] $IntervalSeconds = 15
)

$ErrorActionPreference = "Stop"

function Escape-XmlText {
  param([string] $Value)

  if ([string]::IsNullOrEmpty($Value)) {
    return ""
  }

  return [System.Security.SecurityElement]::Escape($Value)
}

function New-TallyProbeXml {
  param([string] $CompanyName)

  $companyVariable = ""
  if (-not [string]::IsNullOrWhiteSpace($CompanyName)) {
    $companyVariable = "<SVCurrentCompany>$(Escape-XmlText $CompanyName)</SVCurrentCompany>"
  }

  return @"
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>Autodealer Ledgers Probe</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        $companyVariable
        <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="Autodealer Ledgers Probe" ISMODIFY="No">
            <TYPE>Ledger</TYPE>
            <FETCH>Name,Parent,GUID</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
"@
}

function New-AlterLedgerXml {
  param([object] $Payload)

  $oldName = [string] $Payload.oldName
  $newName = [string] $Payload.newName
  $parentName = [string] $Payload.parentName
  $payloadCompany = [string] $Payload.companyName

  if ([string]::IsNullOrWhiteSpace($payloadCompany)) {
    $payloadCompany = $CompanyName
  }

  if ([string]::IsNullOrWhiteSpace($oldName) -or [string]::IsNullOrWhiteSpace($newName)) {
    throw "Ledger edit command is missing oldName or newName."
  }

  $companyVariable = ""
  if (-not [string]::IsNullOrWhiteSpace($payloadCompany)) {
    $companyVariable = "<SVCurrentCompany>$(Escape-XmlText $payloadCompany)</SVCurrentCompany>"
  }

  $parentBlock = ""
  if (-not [string]::IsNullOrWhiteSpace($parentName)) {
    $parentBlock = "<PARENT>$(Escape-XmlText $parentName)</PARENT>"
  }

  return @"
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          $companyVariable
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="$(Escape-XmlText $oldName)" ACTION="Alter">
            <NAME>$(Escape-XmlText $newName)</NAME>
            $parentBlock
            <LANGUAGENAME.LIST>
              <NAME.LIST TYPE="String">
                <NAME>$(Escape-XmlText $newName)</NAME>
              </NAME.LIST>
              <LANGUAGEID TYPE="Number">1033</LANGUAGEID>
            </LANGUAGENAME.LIST>
          </LEDGER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
"@
}

function Invoke-TallyXml {
  param([string] $Xml)

  $response = Invoke-WebRequest `
    -Uri $TallyUrl `
    -Method POST `
    -ContentType "text/xml" `
    -Body $Xml `
    -TimeoutSec 30 `
    -UseBasicParsing

  $content = [string] $response.Content
  $lineError = $null
  $errors = $null
  $altered = $null
  $created = $null

  if ($content -match "<LINEERROR[^>]*>([\s\S]*?)</LINEERROR>") {
    $lineError = [System.Net.WebUtility]::HtmlDecode($Matches[1]).Trim()
  }

  if ($content -match "<ERRORS[^>]*>([^<]+)</ERRORS>") {
    $errors = [int] $Matches[1].Trim()
  }

  if ($content -match "<ALTERED[^>]*>([^<]+)</ALTERED>") {
    $altered = [int] $Matches[1].Trim()
  }

  if ($content -match "<CREATED[^>]*>([^<]+)</CREATED>") {
    $created = [int] $Matches[1].Trim()
  }

  $success = $response.StatusCode -ge 200 -and $response.StatusCode -lt 300 -and
    [string]::IsNullOrWhiteSpace($lineError) -and
    (($null -eq $errors) -or $errors -eq 0)

  return @{
    success = $success
    error = $lineError
    result = @{
      httpStatus = $response.StatusCode
      altered = $altered
      created = $created
      errors = $errors
      response = $content.Substring(0, [Math]::Min($content.Length, 4000))
    }
  }
}

function Test-Tally {
  param(
    [string] $TallyUrl,
    [string] $CompanyName
  )

  try {
    $xml = New-TallyProbeXml -CompanyName $CompanyName
    $response = Invoke-WebRequest `
      -Uri $TallyUrl `
      -Method POST `
      -ContentType "text/xml" `
      -Body $xml `
      -TimeoutSec 10 `
      -UseBasicParsing

    $content = [string] $response.Content
    $looksLikeXml = $content -match "<\?xml|<ENVELOPE|<RESPONSE|<LISTOF|<COLLECTION"
    $lineError = $null
    $status = $null

    if ($content -match "<LINEERROR[^>]*>([\s\S]*?)</LINEERROR>") {
      $lineError = [System.Net.WebUtility]::HtmlDecode($Matches[1]).Trim()
    }

    if ($content -match "<STATUS[^>]*>([^<]+)</STATUS>") {
      $status = $Matches[1].Trim()
    }

    if (-not $looksLikeXml) {
      return @{
        tallyReachable = $true
        companyLoaded = $false
        companyName = $CompanyName
        error = "Tally responded, but the response was not XML."
      }
    }

    return @{
      tallyReachable = $true
      companyLoaded = (($status -eq "1") -and [string]::IsNullOrEmpty($lineError))
      companyName = $CompanyName
      error = $lineError
    }
  } catch {
    return @{
      tallyReachable = $false
      companyLoaded = $false
      companyName = $CompanyName
      error = $_.Exception.Message
    }
  }
}

function Receive-NextCommand {
  try {
    $bridgeVersion = [uri]::EscapeDataString("powershell-0.2.0")
    return Invoke-RestMethod `
      -Uri "$ApiBase/api/tally/bridge/commands/next?connectionId=$ConnectionId&bridgeVersion=$bridgeVersion" `
      -Method GET `
      -Headers @{ Authorization = "Bearer $BridgeToken" }
  } catch {
    Write-Host "Command poll failed: $($_.Exception.Message)"
    return $null
  }
}

function Send-CommandResult {
  param(
    [string] $CommandId,
    [bool] $Success,
    [object] $Result,
    [string] $ErrorMessage
  )

  $payload = @{
    connectionId = $ConnectionId
    status = $(if ($Success) { "succeeded" } else { "failed" })
    success = $Success
    result = $Result
    error = $ErrorMessage
  } | ConvertTo-Json -Depth 8

  Invoke-RestMethod `
    -Uri "$ApiBase/api/tally/bridge/commands/$CommandId/result" `
    -Method POST `
    -ContentType "application/json" `
    -Headers @{ Authorization = "Bearer $BridgeToken" } `
    -Body $payload | Out-Null
}

function Invoke-BridgeCommand {
  param([object] $Command)

  if ($null -eq $Command) {
    return
  }

  $commandId = [string] $Command.id
  $commandType = [string] $Command.commandType

  try {
    if ($commandType -eq "alter_ledger") {
      $xml = New-AlterLedgerXml -Payload $Command.payload
      $tallyResult = Invoke-TallyXml -Xml $xml
      Send-CommandResult `
        -CommandId $commandId `
        -Success ([bool] $tallyResult.success) `
        -Result $tallyResult.result `
        -ErrorMessage $tallyResult.error

      if ($tallyResult.success) {
        Write-Host "Command $commandId completed: ledger altered."
      } else {
        Write-Host "Command $commandId failed: $($tallyResult.error)"
      }
      return
    }

    Send-CommandResult `
      -CommandId $commandId `
      -Success $false `
      -Result @{} `
      -ErrorMessage "Unsupported command type: $commandType"
  } catch {
    Send-CommandResult `
      -CommandId $commandId `
      -Success $false `
      -Result @{} `
      -ErrorMessage $_.Exception.Message
    Write-Host "Command $commandId failed: $($_.Exception.Message)"
  }
}

function Send-Heartbeat {
  param([hashtable] $Probe)

  $payload = @{
    connectionId = $ConnectionId
    tallyUrl = $TallyUrl
    bridgeVersion = "powershell-0.1.0"
    tallyReachable = [bool] $Probe.tallyReachable
    companyLoaded = [bool] $Probe.companyLoaded
    companyName = $Probe.companyName
    error = $Probe.error
  } | ConvertTo-Json

  Invoke-RestMethod `
    -Uri "$ApiBase/api/tally/bridge/heartbeat" `
    -Method POST `
    -ContentType "application/json" `
    -Headers @{ Authorization = "Bearer $BridgeToken" } `
    -Body $payload | Out-Null
}

$ApiBase = $ApiBase.TrimEnd("/")

Write-Host "Starting Tally live bridge"
Write-Host "API: $ApiBase"
Write-Host "Connection: $ConnectionId"
Write-Host "Tally: $TallyUrl"
Write-Host "Company: $CompanyName"
Write-Host "Interval: $IntervalSeconds seconds"
Write-Host "Press Ctrl+C to stop."

while ($true) {
  $probe = Test-Tally -TallyUrl $TallyUrl -CompanyName $CompanyName
  Send-Heartbeat -Probe $probe

  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $message = "[$timestamp] Tally reachable: $($probe.tallyReachable); Company loaded: $($probe.companyLoaded)"
  if (-not [string]::IsNullOrEmpty($probe.error)) {
    $message += "; Error: $($probe.error)"
  }

  Write-Host $message

  $next = Receive-NextCommand
  if ($next -and $next.command) {
    Invoke-BridgeCommand -Command $next.command
  }

  Start-Sleep -Seconds $IntervalSeconds
}
