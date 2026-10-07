param(
  [Parameter(Mandatory = $true)]
  [string] $ApiBase,

  [Parameter(Mandatory = $true)]
  [string] $ConnectionId,

  [Parameter(Mandatory = $true)]
  [string] $BridgeToken,

  [string] $TallyUrl = "http://localhost:9000",
  [string] $CompanyName = ""
)

$ErrorActionPreference = "Stop"

function Escape-XmlText {
  param([string] $Value)

  if ([string]::IsNullOrEmpty($Value)) {
    return ""
  }

  return [System.Security.SecurityElement]::Escape($Value)
}

function New-CollectionXml {
  param(
    [string] $CollectionName,
    [string] $TallyType,
    [string] $Fetch
  )

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
    <ID>$CollectionName</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        $companyVariable
        <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="$CollectionName" ISMODIFY="No">
            <TYPE>$TallyType</TYPE>
            <FETCH>$Fetch</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
"@
}

function Invoke-TallyCollection {
  param(
    [string] $CollectionName,
    [string] $TallyType,
    [string] $Fetch,
    [string] $NodeName
  )

  $xml = New-CollectionXml -CollectionName $CollectionName -TallyType $TallyType -Fetch $Fetch
  $response = Invoke-WebRequest `
    -Uri $TallyUrl `
    -Method POST `
    -ContentType "text/xml" `
    -Body $xml `
    -TimeoutSec 30 `
    -UseBasicParsing

  $content = [string] $response.Content

  if ($content -match "<LINEERROR[^>]*>([\s\S]*?)</LINEERROR>") {
    throw "Tally error for ${CollectionName}: $([System.Net.WebUtility]::HtmlDecode($Matches[1]).Trim())"
  }

  $document = New-Object System.Xml.XmlDocument
  $document.PreserveWhitespace = $false
  $document.LoadXml($content)

  return $document.SelectNodes("//*[local-name()='$NodeName']")
}

function Get-Text {
  param(
    [System.Xml.XmlNode] $Node,
    [string] $Name
  )

  $match = $Node.SelectSingleNode("*[local-name()='$Name']")
  if ($null -eq $match) {
    return $null
  }

  $value = [string] $match.InnerText
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $null
  }

  return $value.Trim()
}

function Get-Attribute {
  param(
    [System.Xml.XmlNode] $Node,
    [string] $Name
  )

  $attribute = $Node.Attributes[$Name]
  if ($null -eq $attribute) {
    return $null
  }

  $value = [string] $attribute.Value
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $null
  }

  return $value.Trim()
}

function Get-Name {
  param([System.Xml.XmlNode] $Node)

  $attributeName = Get-Attribute -Node $Node -Name "NAME"
  if (-not [string]::IsNullOrWhiteSpace($attributeName)) {
    return $attributeName.Trim()
  }

  return Get-Text -Node $Node -Name "NAME"
}

function Convert-Ledger {
  param([System.Xml.XmlNode] $Node)

  $parent = Get-Text -Node $Node -Name "PARENT"
  $name = Get-Name -Node $Node

  return @{
    name = $name
    guid = Get-Text -Node $Node -Name "GUID"
    parent = $parent
    gstin = (Get-Text -Node $Node -Name "PARTYGSTIN")
    raw = @{
      parent = $parent
      reservedName = Get-Attribute -Node $Node -Name "RESERVEDNAME"
    }
  }
}

function Convert-StockItem {
  param([System.Xml.XmlNode] $Node)

  return @{
    name = Get-Name -Node $Node
    guid = Get-Text -Node $Node -Name "GUID"
    parent = Get-Text -Node $Node -Name "PARENT"
    hsnCode = Get-Text -Node $Node -Name "GSTHSNCODE"
    unitName = Get-Text -Node $Node -Name "BASEUNITS"
    raw = @{
      gstApplicable = Get-Text -Node $Node -Name "GSTAPPLICABLE"
    }
  }
}

function Convert-SimpleMaster {
  param([System.Xml.XmlNode] $Node)

  return @{
    name = Get-Name -Node $Node
    guid = Get-Text -Node $Node -Name "GUID"
    parent = Get-Text -Node $Node -Name "PARENT"
    raw = @{}
  }
}

$ApiBase = $ApiBase.TrimEnd("/")

Write-Host "Reading masters from Tally..."
Write-Host "Tally: $TallyUrl"
Write-Host "Company: $CompanyName"

$ledgerNodes = Invoke-TallyCollection `
  -CollectionName "Autodealer Ledgers Sync" `
  -TallyType "Ledger" `
  -Fetch "Name,Parent,GUID,PartyGSTIN" `
  -NodeName "LEDGER"

$groupNodes = Invoke-TallyCollection `
  -CollectionName "Autodealer Groups Sync" `
  -TallyType "Group" `
  -Fetch "Name,Parent,GUID" `
  -NodeName "GROUP"

$stockItemNodes = Invoke-TallyCollection `
  -CollectionName "Autodealer Stock Items Sync" `
  -TallyType "StockItem" `
  -Fetch "Name,Parent,GUID,GSTHSNCode,BaseUnits,GSTApplicable" `
  -NodeName "STOCKITEM"

$unitNodes = Invoke-TallyCollection `
  -CollectionName "Autodealer Units Sync" `
  -TallyType "Unit" `
  -Fetch "Name,GUID" `
  -NodeName "UNIT"

$voucherTypeNodes = Invoke-TallyCollection `
  -CollectionName "Autodealer Voucher Types Sync" `
  -TallyType "VoucherType" `
  -Fetch "Name,Parent,GUID" `
  -NodeName "VOUCHERTYPE"

$ledgers = @($ledgerNodes | ForEach-Object { Convert-Ledger $_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_.name) })
$groups = @($groupNodes | ForEach-Object { Convert-SimpleMaster $_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_.name) })
$stockItems = @($stockItemNodes | ForEach-Object { Convert-StockItem $_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_.name) })
$units = @($unitNodes | ForEach-Object { Convert-SimpleMaster $_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_.name) })
$voucherTypes = @($voucherTypeNodes | ForEach-Object { Convert-SimpleMaster $_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_.name) })

$gstLedgers = @($ledgers | Where-Object {
  ($_.name -match "GST|CGST|SGST|IGST") -or ($_.parent -match "Duties|Taxes")
})

$payload = @{
  connectionId = $ConnectionId
  companyName = $CompanyName
  bridgeVersion = "powershell-0.1.0"
  masters = @{
    ledgers = $ledgers
    groups = $groups
    stockItems = $stockItems
    units = $units
    voucherTypes = $voucherTypes
    gstLedgers = $gstLedgers
  }
} | ConvertTo-Json -Depth 8

Write-Host "Uploading masters..."

$result = Invoke-RestMethod `
  -Uri "$ApiBase/api/tally/bridge/masters" `
  -Method POST `
  -ContentType "application/json" `
  -Headers @{ Authorization = "Bearer $BridgeToken" } `
  -Body $payload

Write-Host "Master sync completed."
Write-Host "Ledgers: $($ledgers.Count)"
Write-Host "Groups: $($groups.Count)"
Write-Host "Stock items: $($stockItems.Count)"
Write-Host "Units: $($units.Count)"
Write-Host "Voucher types: $($voucherTypes.Count)"
Write-Host "GST ledgers: $($gstLedgers.Count)"
$result
