# Kalika Tally document add-ons

This folder contains two add-ons:

- `kalika-native-debit-note-export.tdl` lets the connector export one exact
  Debit Note as a native PDF.
- `kalika-purchase-document-attachment.tdl` stores the managed source-PDF
  identity on a Purchase voucher and adds **Open Source PDF** to its display.

One-time installation in TallyPrime:

1. Press `Ctrl+Alt+T` (or `F1: Help > TDL & Add-On`).
2. Select `F4: Manage Local TDLs`.
3. Set **Load selected TDL files on startup** to **Yes**.
4. Select both `.tdl` files from this folder.
5. Accept and restart TallyPrime.

The connector sends the report the voucher `MasterID` and a private output
path. It will fail closed if the native PDF is not written.

For Purchase vouchers, the connector first downloads the approved source PDF
to its managed documents folder. Tally stores the local path, filename,
document ID, and SHA-256 checksum as voucher UDFs. The PDF itself remains a
managed file; include the connector documents folder in workstation backups.
## Kalika Local Agent sync reports

`kalika-agent-sync-reports.tdl` exposes the versioned Local Agent capability
handshake. The agent supplies compact, parameter-bound collection definitions
for incremental masters, open bills, workflow vouchers, and voucher identity
checks. This avoids permanently loading broad collections in Tally and lets the
agent bind every request to the selected company, financial year, AlterID, date
range, and ledger scope.
