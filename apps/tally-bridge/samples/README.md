# Tally Bridge Read-Only Samples

These samples test whether Tally Prime is reachable through XML/HTTP on port `9000`.

They are read-only exports. They do not create vouchers, ledgers, stock items, or any other Tally data.

## Run In Windows PowerShell

Open PowerShell in the Windows machine where Tally Prime is running, then run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
cd "C:\path\to\autodealer-workflow\apps\tally-bridge\samples"
.\read-only-tests.ps1 -TallyUrl "http://localhost:9000"
```

The script saves Tally XML responses to:

```text
.\tally-sample-results
```

## Expected Result

Success means:

- HTTP status is `200`
- Tally returns XML
- at least the ledger/group sample returns data without a `LINEERROR`

If Tally returns a `LINEERROR`, Tally is still reachable, but that specific report/export request needs adjustment for the installed Tally version or current company setup.

## Bank Voucher Import Diagnostics

Use this when Tally reports a bank voucher import error such as `Voucher date is missing`
even though the bridge log shows `<DATE>` and `<EFFECTIVEDATE>`.

From the repository root on the machine where Tally Prime is reachable:

```powershell
node .\apps\tally-bridge\src\bridge.mjs diagnose-bank-voucher `
  --payload-file .\apps\tally-bridge\samples\bank-voucher-payment-diagnostic.json `
  --post true `
  --output-dir .\tally-bank-voucher-diagnostics\payment

node .\apps\tally-bridge\src\bridge.mjs diagnose-bank-voucher `
  --payload-file .\apps\tally-bridge\samples\bank-voucher-receipt-diagnostic.json `
  --post true `
  --output-dir .\tally-bank-voucher-diagnostics\receipt
```

`--post true` sends each XML variant to Tally. If a variant succeeds, Tally may create
or alter a voucher, and the diagnostic stops by default. The output directory contains
one `*.request.xml` and one `*.response.xml` per tested variant.

To only print the generated XML variants without posting to Tally, omit `--post true`.

If every XML-shape variant fails with the same date error, check whether Tally is
rejecting the voucher date range instead of the XML structure:

```powershell
node .\apps\tally-bridge\src\bridge.mjs diagnose-tally-company `
  --company-name "Kalika Test"

node .\apps\tally-bridge\src\bridge.mjs diagnose-bank-voucher-dates `
  --payload-file .\apps\tally-bridge\samples\bank-voucher-payment-diagnostic.json `
  --dates 2026-04-01,2026-06-03,2026-06-04 `
  --output-dir .\tally-bank-voucher-diagnostics\date-probe
```

The date probe posts one diagnostic voucher per date using references such as
`DIAG-Payment-20260401`. Use a test company because successful probes create
vouchers.
