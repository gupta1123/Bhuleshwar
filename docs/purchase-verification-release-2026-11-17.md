# Purchase verification release — 17 November 2026

Web and API release identifier: `purchase-verification-2026-11-17`. Local Agent: `1.2.49`.

The coordinated change addresses receiving-record classification, duplicate physical pages, shipment grouping, invoice-to-receipt mass reconciliation, GSTIN conflict preservation, date/timestamp retention, e-way expiry at arrival, PO correction precedence, legal buyer versus ship-to roles, trader-chain reconciliation without a PO, review replacement/quarantine precedence, document arithmetic and line-level findings.

Transport and receipt fields now travel through extraction, review, posting and XML readback. Explicit receipt references replace the old weighment-ticket fallback. Address arrays remain separate lines. Reviewed delivery details take precedence over company-address defaults; a company GSTIN mismatch blocks the write. Company reads have an endpoint/company cache key and a 60-second TTL. Consolidated e-way number/date use dedicated voucher UDFs, alongside a readable order reference, rather than pretending to populate an unverified native Tally field.

The UI distinguishes extraction from a passed check, binds line findings to their rows, exposes missing/not-checked evidence and real analysis history, offers re-analysis for unapproved cases, and names posting review selections separately from Tally failures. Upload copy distinguishes local selection, duplicate checking, saved files and analysis. Comparison settings are separate from starting each run. Account loading no longer displays a fictional administrator. Recent-case recovery is available from the workspace.

Re-analysis retains the previous evidence through extraction/review and until both replacement document and finding inserts succeed. Accepted/rejected cases and approved/posted Tally evidence are protected. Existing historical cases are not automatically reanalysed, approved, retried or posted.

Request IDs and Server-Timing spans expose authorization, upload preparation, duplicate lookup, storage and database persistence. Jobs separately record extraction, review, terms and saving phases. Generic legal boilerplate avoids a remote terms assessment; meaningful structured terms remain eligible. These measurements enable subsequent performance comparison; they do not establish a reduction in an unrecorded historical delay.

Validation includes synthetic regression tests, replay of all ten saved packets, purchase-posting and connector suites, packaged native dependency checks, TypeScript checks and production builds. The saved invalid trader fixture continues to produce findings; a corrected legal bill-to/ship-to chain is tested separately with and without a PO. Small 120/140 kg differences retain the existing 0.5%/5 kg tolerance, while a one-tonne difference fails. Split receipts are summed only when explicitly identified and distinct.

Production verification must distinguish a deployed release from a completed voucher write. No synthetic voucher should be posted into real books. The matching historical Tally dataset was unavailable during investigation, so live native screen placement and preservation of the new UDFs require the next authorized real posting to return full readback evidence. A missing requested field yields a verification difference. Connector 1.2.49 is required for new purchase approvals.
