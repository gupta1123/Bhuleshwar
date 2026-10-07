# PowerShell Tally Live Bridge

Use this when the Windows machine running Tally Prime does not have Node.js/npm installed.

The PowerShell script continuously:

1. Sends a read-only XML probe to local Tally Prime.
2. Checks whether Tally is reachable and whether the configured company responds.
3. Sends the result to the app as a bridge heartbeat.

It does not create, edit, delete, or post anything in Tally. Use the Node bridge for write-back commands such as ledger edits and bank voucher posting.

## Bank Voucher Write-Back

Bank voucher posting is handled by the Node bridge:

```powershell
npm run start --workspace @autodealer/tally-bridge
```

After updating the bridge code, stop the running bridge and start it again. The app should then show bridge version `0.1.1` or newer on the next heartbeat.

## Run

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\tally-live-bridge.ps1 `
  -ApiBase "http://10.211.55.2:3001" `
  -ConnectionId "<connection-id>" `
  -BridgeToken "<bridge-token>" `
  -CompanyName "Test Company"
```

Keep the PowerShell window open while using the app.

## Sync Masters

Run this after the bridge is paired to upload read-only Tally masters into the app:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\tally-sync-masters.ps1 `
  -ApiBase "http://10.211.55.2:3001" `
  -ConnectionId "<connection-id>" `
  -BridgeToken "<bridge-token>" `
  -CompanyName "Test Company"
```
