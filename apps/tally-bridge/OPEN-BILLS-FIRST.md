# Open-bills-first workflow reads

Cash Discount and Payment Follow-ups share the collections scan. Each fresh
scan reads a names-only ledger directory, then live pending bills through bounded
native Bills/ChildOf collections. It resolves full master details only for the
represented parties and walks only those parties' ancestor groups. The names-only
directory replaces the formerly unbounded company-wide Bill export; it does not
fetch balances, contacts or vouchers. No ledger is excluded because its net
balance is zero or its bill-wise setting was later changed.

2026-09-07: discovery batches adapt down after a five-second response and obey
the existing 10/25/50 resource cap, 750 MB admission floor, 20-second per-read
limit and overall scan deadline. A timeout is not retried. No lower date bound
is applied, preserving carry-forward bills. Results are not reported complete
unless every discovery batch succeeds. This changes query construction, not the
business rules. Native Tally response compatibility and full-scan speed still
require a live benchmark; a large ledger directory can still exhaust the overall
deadline. An HTTP abort does not guarantee that Tally stopped server-side work.

Named-master requests contain at most 50 static objects and execute sequentially.
Missing, mismatched or unidentified masters fail the scan rather than producing
an authoritative empty result. Customer roots and excluded groups still apply.
Existing bounded voucher-evidence reads supply narration and receipt allocations.

This optimization does not require a warm workflow snapshot. Explicit interrupted
scan resume behavior remains unchanged. It does not add historical recovery for
fully settled invoices absent from the outstanding-bill set.

Validation on 2026-09-04: 43 bridge/targeted-master tests and 19 Cash Discount /
Payment Follow-up business-rule tests passed. A live single-party lookup and its
ancestor-group reads completed in 1,606 ms. This is a small read-only smoke test,
not an end-to-end speedup measurement. The runtime suite separately has an
existing expired-job error-message assertion mismatch.

Install the rebuilt Local Agent before measuring a complete scan. Preserve data
and pairing during reinstall. Compare open-bill, targeted-master and voucher
evidence timings separately; do not infer full-scan latency from the smoke test.
