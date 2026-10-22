# Bhuleshwar settings test fixtures

These synthetic two-page packets are for testing the Settings page. Each file contains a tax-invoice page followed by an E-way Bill page.

## Cases

| File | Purpose | Expected result |
| --- | --- | --- |
| `settings-01-clean-match.pdf` | Baseline | No document mismatch. Use for GST TDS, transporter TDS, and clean approval tests. |
| `settings-02-field-toggle.pdf` | Field enable/disable | Disabling vehicle or E-way fields suppresses those comparisons; enabling them restores extraction and comparison. |
| `settings-03-vehicle-mismatch.pdf` | Vehicle mismatch | Vehicle/logistics review group enabled: registration-number issue. Group disabled: no vehicle issue. |
| `settings-04-tax-gstin-mismatch.pdf` | Tax and GST identity mismatch | Commercial/amounts enabled: tax mismatch. Buyer/company GSTIN rule at `block`: approval-blocking identity issue. |

## Test sequence

1. Upload one packet as a new case.
2. Change one setting and save it.
3. Create a fresh case with the same packet.
4. Compare the result with the expected result above.
5. Restore the original setting before testing the next rule.

These are synthetic QA documents and are not valid tax records.
