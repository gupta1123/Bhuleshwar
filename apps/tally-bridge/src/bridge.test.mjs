import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCollectionExportXml,
  collectCashDiscountCustomerEvidence,
  buildBankVoucherBatchXml,
  buildBankVoucherXml,
  buildPurchaseVoucherXml,
  buildRequestedLedgerFormula,
  cashDiscountFinancialYearRange,
  cashDiscountVoucherDateChunks,
  classifyOpenBillReferenceKind,
  classifyTaxLedgers,
  decodeRealtimeFrame,
  findBankLedgersFromMasters,
  findPartyLedgersFromMasters,
  selectCashDiscountLedgers,
  fetchCustomerOpenBillsFromTally,
  exportTargetedBillEvidenceXml,
  existingPurchaseVoucherAttachmentDifferences,
  openBillPendingFormula,
  parseTallyImportResult,
  openBillBlockRequiresVoucherFallback,
  parseLedgerClosingBalance,
  purchasePayloadMasterNames,
  purchaseVoucherFinancialYearRange,
  purchaseVoucherReadbackComparison,
  getBankVoucherCommandBatchKey,
  resolveBankVoucherLedgerIdentities,
  strictBankTransactionCandidates,
  createReconnectBackoff,
  liveReadMemoryPressure,
  uniqueVoucherBlocks,
  buildOpenBillAmountIndex,
  matchOpenBillsByAmount,
  sharedPurchaseDocumentFileName,
} from "./bridge.mjs";

test("shared-folder purchase PDFs are named <Supplier> <Invoice No>.pdf and fill the Attach Documents add-on", () => {
  assert.equal(sharedPurchaseDocumentFileName({ supplierLedgerName: "Surya Steel Trading Co", supplierInvoiceNumber: "SSTC-26/27-182" }),
    "Surya Steel Trading Co SSTC-26-27-182.pdf");
  assert.equal(sharedPurchaseDocumentFileName({ supplierLedgerName: 'A: "B" <C>', supplierInvoiceNumber: "X|Y?" }), "A- -B- -C- X-Y-.pdf");

  const payload = {
    companyName: "Kalika Steel Alloys Pvt Ltd", voucherDate: "2026-09-21", supplierInvoiceDate: "2026-09-20",
    supplierInvoiceNumber: "SSTC-26/27-182", supplierLedgerName: "Surya Steel Trading Co", finalPayableAmount: "1180",
    items: [{ stockItemName: "M S Scrap & Sponge Iron", purchaseLedgerName: "M.S. Scrap Purchase", hsn: "72044900", unit: "MTS", quantity: "1", rate: "1000", taxableAmount: "1000" }],
    charges: [{ name: "Input ITC CGST 9%", amount: "90" }, { name: "Input ITC SGST 9%", amount: "90" }],
    sourceDocumentFolder: "\\\\ksplserver\\TRANCATION\\PURCHASE",
    sourceDocumentPath: "\\\\ksplserver\\TRANCATION\\PURCHASE\\Surya Steel Trading Co SSTC-26-27-182.pdf",
    sourceDocumentName: "Surya Steel Trading Co SSTC-26-27-182.pdf", sourceDocumentSha256: "ABC", sourceDocumentId: "file-1",
  };
  const xml = buildPurchaseVoucherXml(payload, payload.companyName);
  assert.match(xml, /<UDF:UDFFORSAVEDOCATTACHSAVE\.LIST DESC="`UdfForSaveDocAttachSave`" ISLIST="YES" TYPE="Logical" INDEX="2200"><UDF:UDFFORSAVEDOCATTACHSAVE DESC="`UdfForSaveDocAttachSave`">Yes</);
  assert.match(xml, /<UDF:DOCATTACHDETAIL\.LIST DESC="`DocAttachDetail`" INDEX="21000"><UDF:UDFFORLINKDOCUMENTFILE\.LIST[^>]*INDEX="2697"><UDF:UDFFORLINKDOCUMENTFILE[^>]*>\\\\ksplserver\\TRANCATION\\PURCHASE\\Surya Steel Trading Co SSTC-26-27-182\.pdf</);
  assert.match(xml, /<UDF:UDFVCHTYPELOCATION[^>]*>\\\\ksplserver\\TRANCATION\\PURCHASE\\<\/UDF:UDFVCHTYPELOCATION>/);
  // Without a shared folder the add-on fields are not written.
  assert.doesNotMatch(buildPurchaseVoucherXml({ ...payload, sourceDocumentFolder: "" }, payload.companyName), /DOCATTACHDETAIL/);
});

test("bank lines match parties by an open bill of the same amount and direction", () => {
  const bill = (ledger, name, closing) => `<BILL NAME="${name}"><LEDGERNAME>${ledger}</LEDGERNAME><BILLDATE>20260502</BILLDATE><OPENINGBALANCE>${closing}</OPENINGBALANCE><CLOSINGBALANCE>${closing}</CLOSINGBALANCE></BILL>`;
  const index = buildOpenBillAmountIndex([
    bill("Apex Rebar Projects", "INV/1", "-1231200.00"),   // receivable
    bill("Balaji Rebar Projects", "INV/2", "-50000.50"),   // receivable
    bill("Surya Steel Trading Co", "SSTC/9", "484206.40"), // payable
    ...["A", "B", "C", "D"].map((party) => bill(`Party ${party}`, `X/${party}`, "-1000.00")),
  ].join(""));

  const exact = matchOpenBillsByAmount(index, { amount: 1231200, direction: "receipt" });
  assert.deepEqual(exact.map((entry) => [entry.ledger.name, entry.source, entry.openBill.referenceName]), [["Apex Rebar Projects", "open_bill_amount", "INV/1"]]);

  // A payment of the same amount must not match a receivable, and vice versa.
  assert.deepEqual(matchOpenBillsByAmount(index, { amount: 1231200, direction: "payment" }), []);
  assert.equal(matchOpenBillsByAmount(index, { amount: 484206.40, direction: "payment" })[0].ledger.name, "Surya Steel Trading Co");

  // Within Rs 1 is offered only when there is no exact match, and labelled.
  const near = matchOpenBillsByAmount(index, { amount: 50000, direction: "receipt" });
  assert.deepEqual(near.map((entry) => [entry.ledger.name, entry.source]), [["Balaji Rebar Projects", "open_bill_amount_near"]]);

  // Four parties with the same amount is not a useful signal.
  assert.deepEqual(matchOpenBillsByAmount(index, { amount: 1000, direction: "receipt" }), []);
  assert.deepEqual(matchOpenBillsByAmount(index, { amount: 0, direction: "receipt" }), []);
});

test("windowed Cash Discount evidence keeps each voucher once", () => {
  // Tally ignores the date window on Vouchers : Ledger unions, so each window
  // repeats every voucher; repeats must not double-count receipts.
  const receipt = '<VOUCHER REMOTEID="r-1"><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><AMOUNT>100</AMOUNT></VOUCHER>';
  const sale = '<VOUCHER REMOTEID="s-1"><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME></VOUCHER>';
  const deduped = uniqueVoucherBlocks([receipt, sale, receipt, sale, receipt].join("\n"));
  assert.equal((deduped.match(/REMOTEID="r-1"/g) || []).length, 1);
  assert.equal((deduped.match(/REMOTEID="s-1"/g) || []).length, 1);
});

test("live channel reconnects back off to 60 seconds and log once per outage", () => {
  const backoff = createReconnectBackoff();
  assert.deepEqual(Array.from({ length: 7 }, () => backoff.nextDelay()), [3000, 6000, 12000, 24000, 48000, 60000, 60000]);
  assert.equal(backoff.shouldLog(), true);
  assert.equal(backoff.shouldLog(), false);
  assert.equal(backoff.connected(), true);
  assert.equal(backoff.nextDelay(), 3000);
  assert.equal(backoff.shouldLog(), true);
});

test("live reads are refused only when memory is nearly exhausted", () => {
  const MB = 1024 * 1024;
  assert.equal(liveReadMemoryPressure({ freeBytes: 500 * MB, rssBytes: 250 * MB }), false);
  assert.equal(liveReadMemoryPressure({ freeBytes: 200 * MB, rssBytes: 250 * MB }), true);
  assert.equal(liveReadMemoryPressure({ freeBytes: 2048 * MB, rssBytes: 1100 * MB }), true);
});

test("bank posting resolves stale display names by stable Tally GUID", () => {
  const [resolved] = resolveBankVoucherLedgerIdentities([{
    bankLedgerName: "HDFC Bank",
    bankLedgerGuid: "bank-guid",
    counterpartyLedgerName: "Task Metcorp Global (Opc) Private Limited ? Jalna",
    counterpartyLedgerGuid: "party-guid",
  }], [
    { name: "HDFC Bank", guid: "BANK-GUID" },
    { name: "Task Metcorp Global (Opc) Private Limited – Jalna", guid: "PARTY-GUID" },
  ]);
  assert.equal(resolved.counterpartyLedgerName, "Task Metcorp Global (Opc) Private Limited – Jalna");
  assert.throws(() => resolveBankVoucherLedgerIdentities([{
    bankLedgerName: "HDFC Bank", bankLedgerGuid: "bank-guid",
    counterpartyLedgerName: "Missing", counterpartyLedgerGuid: "missing-guid",
  }], [{ name: "HDFC Bank", guid: "bank-guid" }]), /not present in the active Tally company/);
});

test("bank voucher batch puts fifty mixed statement vouchers in one Tally request", () => {
  const common = {
    companyName: "Solution Nyx",
    voucherDate: "2026-08-22",
    bankLedgerName: "Axis Bank",
    amount: 1000,
  };
  const payloads = Array.from({ length: 50 }, (_, index) => ({
    ...common,
    voucherType: index % 3 === 0 ? "Receipt" : index % 3 === 1 ? "Payment" : "Contra",
    counterpartyLedgerName: index % 3 === 2 ? "Cash" : `Party ${index + 1}`,
    counterpartyIsPartyLedger: index % 3 !== 2,
    bankLedgerEntryIsDebit: index % 3 === 0,
    referenceNumber: `BATCH-REF-${index + 1}`,
    billAllocations: index === 0
      ? [{ referenceName: "INV-1", referenceType: "Agst Ref", amount: 1000 }]
      : [],
  }));
  const xml = buildBankVoucherBatchXml(payloads, null);
  assert.equal((xml.match(/<TALLYMESSAGE\b/g) || []).length, 50);
  assert.equal((xml.match(/<VOUCHER\b/g) || []).length, 50);
  assert.match(xml, /<VOUCHERNUMBER>BATCH-REF-1<\/VOUCHERNUMBER>/);
  assert.match(xml, /<VOUCHERNUMBER>BATCH-REF-50<\/VOUCHERNUMBER>/);
  assert.equal(new Set(payloads.map((payload) => getBankVoucherCommandBatchKey(payload))).size, 1);
});

test("Supabase binary broadcast wake frames decode without financial payloads", () => {
  const topic = "realtime:tally-command:522c18c7-95fa-41ff-a6fe-ed27d8675ed7";
  const event = "command_queued";
  const payload = Buffer.from(JSON.stringify({ wake: true }), "utf8");
  const topicBytes = Buffer.from(topic, "utf8");
  const eventBytes = Buffer.from(event, "utf8");
  const frame = Buffer.concat([
    Buffer.from([4, topicBytes.length, eventBytes.length, 0, 1]),
    topicBytes,
    eventBytes,
    payload,
  ]);

  assert.deepEqual(decodeRealtimeFrame(frame), [
    null,
    null,
    topic,
    "broadcast",
    { event, payload: { wake: true } },
  ]);
});

test("purchase master preflight covers every selected ledger and stock item once", () => {
  assert.deepEqual(purchasePayloadMasterNames({
    supplierLedgerName: "Supplier A",
    items: [
      { stockItemName: "Item One", purchaseLedgerName: "Purchase Local" },
      { stockItemName: "Item One", purchaseLedgerName: "Purchase Local" },
      { stockItemName: "Item Two", purchaseLedgerName: "Purchase Interstate" },
    ],
    charges: [{ name: "Freight Inward" }],
    withholdings: [{ name: "TDS 194Q" }],
    ledgers: {
      cgst: { name: "Input CGST" },
      sgst: { name: "Input SGST" },
      repeated: { name: "Supplier A" },
    },
  }), {
    ledgerNames: [
      "Supplier A",
      "Purchase Local",
      "Purchase Interstate",
      "Freight Inward",
      "TDS 194Q",
      "Input CGST",
      "Input SGST",
    ],
    stockItemNames: ["Item One", "Item Two"],
    godownNames: [],
  });
});

test("ledger closing balances preserve Tally Dr and Cr meaning", () => {
  assert.deepEqual(parseLedgerClosingBalance("1,24,500.00 Dr"), {
    amount: 124500,
    type: "Dr",
    raw: "1,24,500.00 Dr",
  });
  assert.deepEqual(parseLedgerClosingBalance("842300 Cr"), {
    amount: 842300,
    type: "Cr",
    raw: "842300 Cr",
  });
  assert.deepEqual(parseLedgerClosingBalance("-950"), {
    amount: 950,
    type: "Dr",
    raw: "-950",
  });
  assert.deepEqual(parseLedgerClosingBalance(""), {
    amount: null,
    type: null,
    raw: null,
  });
});

test("outgoing supplier payments create Payment vouchers with bill allocations", () => {
  const xml = buildBankVoucherXml({
    companyName: "Solution Nyx",
    voucherType: "Payment",
    voucherDate: "2026-08-17",
    bankLedgerName: "State Bank of India",
    counterpartyLedgerName: "Mahavir Steel Corporation",
    counterpartyIsPartyLedger: true,
    bankLedgerEntryIsDebit: false,
    amount: 94000,
    referenceNumber: "SB61708260002",
    billAllocations: [
      { referenceType: "Agst Ref", referenceName: "MSC/26-27/403", amount: 75000 },
      { referenceType: "Agst Ref", referenceName: "MSC/26-27/404", amount: 19000 },
    ],
  });

  assert.match(xml, /<VOUCHERTYPENAME>Payment<\/VOUCHERTYPENAME>/);
  assert.match(xml, /<LEDGERNAME>Mahavir Steel Corporation<\/LEDGERNAME>/);
  assert.match(xml, /<NAME>MSC\/26-27\/403<\/NAME>/);
  assert.match(xml, /<NAME>MSC\/26-27\/404<\/NAME>/);
  assert.match(xml, /<LEDGERNAME>State Bank of India<\/LEDGERNAME>/);
});

test("direct party posting creates an Advance without settling an existing bill", () => {
  const xml = buildBankVoucherXml({
    companyName: "Solution Nyx",
    voucherType: "Receipt",
    voucherDate: "2026-08-17",
    bankLedgerName: "State Bank of India",
    counterpartyLedgerName: "Aarohi Steel Distributors",
    counterpartyIsPartyLedger: true,
    bankLedgerEntryIsDebit: true,
    amount: 5977,
    referenceNumber: "SBS01010900001",
    billAllocations: [
      { referenceType: "Advance", referenceName: "ADV-20260817-0900001", amount: 5977 },
    ],
  });

  assert.match(xml, /<VOUCHERTYPENAME>Receipt<\/VOUCHERTYPENAME>/);
  assert.match(xml, /<NAME>ADV-20260817-0900001<\/NAME>/);
  assert.match(xml, /<BILLTYPE>Advance<\/BILLTYPE>/);
  assert.doesNotMatch(xml, /<BILLTYPE>Agst Ref<\/BILLTYPE>/);
});

test("outgoing Contra vouchers debit the destination and credit the statement bank", () => {
  const xml = buildBankVoucherXml({
    companyName: "Solution Nyx",
    voucherType: "Contra",
    voucherDate: "2026-08-17",
    bankLedgerName: "State Bank of India",
    counterpartyLedgerName: "HDFC Bank",
    bankLedgerEntryIsDebit: false,
    amount: 50000,
    referenceNumber: "TRANSFER-1",
  });

  assert.match(xml, /<VOUCHERTYPENAME>Contra<\/VOUCHERTYPENAME>/);
  assert.match(xml, /<LEDGERNAME>HDFC Bank<\/LEDGERNAME>[\s\S]*?<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>/);
  assert.match(xml, /<LEDGERNAME>State Bank of India<\/LEDGERNAME>[\s\S]*?<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>/);
  assert.ok(xml.indexOf("<LEDGERNAME>HDFC Bank</LEDGERNAME>") < xml.indexOf("<LEDGERNAME>State Bank of India</LEDGERNAME>"));
});

test("collection exports apply Tally-side formula filters", () => {
  const xml = buildCollectionExportXml({
    collectionName: "Filtered Bills",
    tallyType: "Bill",
    fetchFields: "Name,LedgerName,ClosingBalance",
    companyName: "Solution Nyx",
    dateTo: "2026-08-17",
    formulae: [{ name: "RequestedLedger", formula: '$$IsEqual:$LedgerName:"Customer A"' }],
    filterNames: ["RequestedLedger"],
  });

  assert.match(xml, /<FILTER>RequestedLedger<\/FILTER>/);
  assert.match(xml, /<SYSTEM TYPE="Formulae" NAME="RequestedLedger"/);
  assert.match(xml, /\$\$IsEqual:\$LedgerName:&quot;Customer A&quot;/);
  assert.match(xml, /<SVTODATE TYPE="Date">20260817<\/SVTODATE>/);
});

test("ledger filters remain targeted and deduplicated", () => {
  const ledgerFormula = buildRequestedLedgerFormula(["Customer A", "Customer A", "Customer B"], ["$LedgerName"]);
  assert.equal((ledgerFormula.match(/Customer A/g) || []).length, 1);
  assert.equal((ledgerFormula.match(/Customer B/g) || []).length, 1);
});

test("cash discount keeps short voucher periods in one Tally request", () => {
  assert.deepEqual(cashDiscountVoucherDateChunks("2026-08-01", "2026-08-31"), [
    { dateFrom: "2026-08-01", dateTo: "2026-08-31" },
  ]);
});

test("cash discount splits long voucher periods into bounded sequential requests", () => {
  const chunks = cashDiscountVoucherDateChunks("2026-01-01", "2026-12-31");
  assert.equal(chunks.length, 12);
  assert.equal(chunks[0].dateFrom, "2026-01-01");
  assert.equal(chunks.at(-1).dateTo, "2026-12-31");
  for (const [index, chunk] of chunks.entries()) {
    const days = ((Date.parse(`${chunk.dateTo}T00:00:00.000Z`) - Date.parse(`${chunk.dateFrom}T00:00:00.000Z`)) / 86_400_000) + 1;
    assert.ok(days <= 31);
    if (index > 0) assert.equal(chunk.dateFrom, new Date(Date.parse(`${chunks[index - 1].dateTo}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10));
  }
});

test("cash discount bounds scans to the selected Indian financial year", () => {
  assert.deepEqual(cashDiscountFinancialYearRange("2026-27", "2026-08-16"), {
    financialYear: "2026-27",
    dateFrom: "2026-04-01",
    dateTo: "2026-08-16",
  });
});

test("open Bill exports filter empty and zero pending balances in Tally", () => {
  const formula = openBillPendingFormula();
  assert.match(formula, /\$ClosingBalance/);
  assert.match(formula, /\$PendingAmount/);
  assert.match(formula, /\$Balance/);
  assert.match(formula, /NOT \$\$IsEqual/);
});

test("timed-out voucher periods split into smaller date slices", async () => {
  const calls = [];
  const result = await exportTargetedBillEvidenceXml(
    "http://127.0.0.1:9000",
    { companyName: "Solution Nyx", ledgerNames: ["Customer A"], dateFrom: "2026-08-01", dateTo: "2026-08-08" },
    async (_url, options) => {
      calls.push(options);
      if (options.dateFrom === "2026-08-01" && options.dateTo === "2026-08-08") {
        throw new Error("Tally export timed out after 60 seconds.");
      }
      return "<ENVELOPE><STATUS>1</STATUS></ENVELOPE>";
    }
  );
  assert.equal(calls.length, 3);
  assert.equal(result.batchCount, 2);
  assert.equal(result.retrySplitCount, 1);
  assert.equal(result.dateChunkCount, 2);
});

test("one-day timed-out voucher evidence splits the ledger batch", async () => {
  const calls = [];
  const result = await exportTargetedBillEvidenceXml(
    "http://127.0.0.1:9000",
    { companyName: "Solution Nyx", ledgerNames: ["Customer A", "Customer B"], dateFrom: "2026-08-01", dateTo: "2026-08-01" },
    async (_url, options) => {
      calls.push(options);
      if (options.formulae[0].formula.includes("Customer A") && options.formulae[0].formula.includes("Customer B")) {
        throw new Error("Tally export timed out after 60 seconds.");
      }
      return "<ENVELOPE><STATUS>1</STATUS></ENVELOPE>";
    }
  );
  assert.equal(calls.length, 3);
  assert.equal(result.batchCount, 2);
  assert.equal(result.retrySplitCount, 1);
});

test("voucher fallback is required only for incomplete Bill exports", () => {
  const complete = '<BILL NAME="INV-1"><LEDGERNAME>Customer A</LEDGERNAME><BILLTYPE>New Ref</BILLTYPE><CLOSINGBALANCE>500</CLOSINGBALANCE></BILL>';
  const missingType = '<BILL NAME="INV-1"><LEDGERNAME>Customer A</LEDGERNAME><CLOSINGBALANCE>500</CLOSINGBALANCE></BILL>';
  const missingPending = '<BILL NAME="INV-1"><LEDGERNAME>Customer A</LEDGERNAME><BILLTYPE>New Ref</BILLTYPE><OPENINGBALANCE>500</OPENINGBALANCE></BILL>';
  assert.equal(openBillBlockRequiresVoucherFallback(complete), false);
  assert.equal(openBillBlockRequiresVoucherFallback(missingType), true);
  assert.equal(openBillBlockRequiresVoucherFallback(missingPending), true);
});

test("zero targeted bills returns an authoritative empty result without fetching vouchers", async () => {
  const calls = [];
  const result = await fetchCustomerOpenBillsFromTally(
    { tallyUrl: "http://127.0.0.1:9000" },
    { companyName: "Solution Nyx", ledgerNames: ["Customer A"], asOfDate: "2026-08-17" },
    {
      exportCollection: async (_url, options) => {
        calls.push(options);
        return "<ENVELOPE><STATUS>1</STATUS></ENVELOPE>";
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].tallyType, "Bill");
  assert.deepEqual(result.result.openBills, []);
  assert.equal(result.result.queryDiagnostics.voucherFallbackUsed, false);
});

test("complete targeted Bill data avoids the voucher fallback", async () => {
  const calls = [];
  const result = await fetchCustomerOpenBillsFromTally(
    { tallyUrl: "http://127.0.0.1:9000" },
    { ledgerNames: ["Customer A"] },
    {
      exportCollection: async (_url, options) => {
        calls.push(options);
        return '<ENVELOPE><STATUS>1</STATUS><BILL NAME="INV-1"><LEDGERNAME>Customer A</LEDGERNAME><BILLTYPE>New Ref</BILLTYPE><DATE>20260801</DATE><OPENINGBALANCE>500</OPENINGBALANCE><CLOSINGBALANCE>500</CLOSINGBALANCE></BILL></ENVELOPE>';
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(result.result.openBills.length, 1);
  assert.equal(result.result.openBills[0].pendingAmount, 500);
  assert.equal(result.result.queryDiagnostics.voucherFallbackUsed, false);
});

test("cash discount reuses discovery and reads only the customer's native voucher collection", async () => {
  const calls = [];
  const billXml = '<ENVELOPE><STATUS>1</STATUS><BILL NAME="INV-1"><LEDGERNAME>Customer A</LEDGERNAME><BILLTYPE>New Ref</BILLTYPE><DATE>20260801</DATE><OPENINGBALANCE>500</OPENINGBALANCE><CLOSINGBALANCE>500</CLOSINGBALANCE></BILL></ENVELOPE>';
  const result = await fetchCustomerOpenBillsFromTally(
    { tallyUrl: "http://127.0.0.1:9000" },
    { companyName: "Solution Nyx", ledgerNames: ["Customer A"], asOfDate: "2026-08-17" },
    {
      billExport: { xml: billXml, batchCount: 1, queryMode: "open_bills_first" },
      forceVoucherEvidence: true,
      exportCollection: async (_url, options) => {
        calls.push(options);
        return '<ENVELOPE><STATUS>1</STATUS><VOUCHER><DATE>20260801</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>INV-1</VOUCHERNUMBER><NARRATION>1% cash discount within 15 days</NARRATION><PARTYLEDGERNAME>Customer A</PARTYLEDGERNAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer A</LEDGERNAME><AMOUNT>-500</AMOUNT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><BILLALLOCATIONS.LIST><NAME>INV-1</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-500</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST></VOUCHER></ENVELOPE>';
      },
    }
  );

  assert.deepEqual(calls.map((call) => call.tallyType), ["Vouchers : Ledger"]);
  assert.equal(calls[0].childOf, '"Customer A"');
  assert.equal(calls[0].collectionName, "Kalika Cash Discount Ledger Evidence");
  assert.equal(calls[0].timeoutMs, 20_000);
  assert.deepEqual(calls[0].filterNames, undefined);
  assert.equal(result.result.queryDiagnostics.billQueryMode, "open_bills_first");
  assert.equal(result.result.queryDiagnostics.voucherEvidenceMode, "required");
  assert.equal(result.result.queryDiagnostics.voucherQueryMode, "ledger_scoped");
  assert.equal(result.result.queryDiagnostics.voucherBatchCount, 1);
  assert.equal(result.result.openBills[0].narration, "1% cash discount within 15 days");
});

test("cash discount combines many native customer voucher collections into one bounded union", async () => {
  const calls = [];
  const ledgerNames = Array.from({ length: 45 }, (_, index) => `Customer ${index + 1}`);
  const billXml = ledgerNames.map((ledgerName, index) =>
    `<BILL NAME="INV-${index + 1}"><LEDGERNAME>${ledgerName}</LEDGERNAME><BILLTYPE>New Ref</BILLTYPE><DATE>20260401</DATE><OPENINGBALANCE>500</OPENINGBALANCE><CLOSINGBALANCE>500</CLOSINGBALANCE></BILL>`
  ).join("");
  const result = await fetchCustomerOpenBillsFromTally(
    { tallyUrl: "http://127.0.0.1:9000" },
    {
      companyName: "Solution Nyx",
      ledgerNames,
      dateFrom: "2026-04-01",
      asOfDate: "2027-03-31",
    },
    {
      billExport: {
        xml: `<ENVELOPE><STATUS>1</STATUS>${billXml}</ENVELOPE>`,
        batchCount: 1,
        queryMode: "open_bills_first",
      },
      forceVoucherEvidence: true,
      exportXml: async (_url, xml, label) => {
        calls.push({ xml, label });
        return "<ENVELOPE><STATUS>1</STATUS></ENVELOPE>";
      },
    }
  );

  assert.ok(calls.length >= 5);
  assert.ok(calls.every(call => (call.xml.match(/<TYPE>Vouchers : Ledger<\/TYPE>/g) || []).length <= 50));
  assert.equal(calls.reduce((sum,call) => sum + (call.xml.match(/<TYPE>Vouchers : Ledger<\/TYPE>/g) || []).length,0), 45 * 5);
  assert.match(calls[0].xml, /<SVFROMDATE TYPE="Date">20260401<\/SVFROMDATE>/);
  assert.match(calls[0].xml, /<SVTODATE TYPE="Date">20260629<\/SVTODATE>/);
  assert.match(calls.at(-1).xml, /<SVTODATE TYPE="Date">20270331<\/SVTODATE>/);
  assert.equal(result.result.queryDiagnostics.requestedLedgerCount, 45);
  assert.equal(result.result.queryDiagnostics.voucherBatchCount, calls.length);
  assert.equal(result.result.queryDiagnostics.voucherQueryMode, "native_ledger_union_windowed");
  assert.equal(result.result.queryDiagnostics.voucherDateChunkCount, 5);
});

test("incomplete Bill data performs one targeted sequential voucher fallback", async () => {
  const calls = [];
  const result = await fetchCustomerOpenBillsFromTally(
    { tallyUrl: "http://127.0.0.1:9000" },
    { ledgerNames: ["Customer A"], asOfDate: "2026-08-17" },
    {
      exportCollection: async (_url, options) => {
        calls.push(options);
        if (options.tallyType === "Bill") {
          return '<ENVELOPE><STATUS>1</STATUS><BILL NAME="INV-1"><LEDGERNAME>Customer A</LEDGERNAME><DATE>20260801</DATE><OPENINGBALANCE>500</OPENINGBALANCE></BILL></ENVELOPE>';
        }
        return '<ENVELOPE><STATUS>1</STATUS><VOUCHER><DATE>20260801</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>INV-1</VOUCHERNUMBER><PARTYLEDGERNAME>Customer A</PARTYLEDGERNAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer A</LEDGERNAME><AMOUNT>-500</AMOUNT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><BILLALLOCATIONS.LIST><NAME>INV-1</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-500</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST></VOUCHER></ENVELOPE>';
      },
    }
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.tallyType), ["Bill", "Voucher"]);
  assert.equal(result.result.queryDiagnostics.voucherFallbackUsed, true);
  assert.equal(result.result.queryDiagnostics.voucherFallbackLedgerCount, 1);
});

test("bank checks keep 51 parties scoped in sequential batches", async () => {
  const calls = [];
  const ledgerNames = Array.from({ length: 51 }, (_, index) => `Customer ${index + 1}`);
  const result = await fetchCustomerOpenBillsFromTally(
    { tallyUrl: "http://127.0.0.1:9000" },
    { ledgerNames, queryPurpose: "bank_statement_match" },
    {
      exportCollection: async (_url, options) => {
        calls.push(options);
        return "<ENVELOPE><STATUS>1</STATUS></ENVELOPE>";
      },
    }
  );

  assert.equal(calls.length, 3);
  for (const call of calls) assert.deepEqual(call.filterNames, ["AutodealerPendingBill", "AutodealerRequestedBillLedger"]);
  assert.equal(result.result.queryDiagnostics.billQueryMode, "targeted");
});

test("a failed Bill query is not misreported as an empty successful result", async () => {
  await assert.rejects(
    () => fetchCustomerOpenBillsFromTally(
      { tallyUrl: "http://127.0.0.1:9000" },
      { ledgerNames: ["Customer A"], queryPurpose: "bank_statement_match" },
      { exportCollection: async () => { throw new Error("Tally timed out"); } }
    ),
    /Tally timed out/
  );
});

test("cash discount includes ledgers nested under Sundry Debtors subgroups", () => {
  const ledgers = [
    { name: "Direct Customer", parent: "Sundry Debtors" },
    { name: "Dealer Customer", parent: "North Dealers" },
    { name: "Supplier", parent: "Sundry Creditors" },
  ];
  const groups = [
    { name: "North Dealers", parent: "Dealers" },
    { name: "Dealers", parent: "Sundry Debtors" },
  ];
  assert.deepEqual(
    findPartyLedgersFromMasters(ledgers, groups, "Sundry Debtors").map((ledger) => ledger.name),
    ["Direct Customer", "Dealer Customer"]
  );
});

test("cash discount customer scope supports custom roots, nesting, and strict mode", () => {
  const groups = [
    { name: "Trade Receivables", parent: "Current Assets" },
    { name: "Export Customers", parent: "Trade Receivables" },
    { name: "Suppliers", parent: "Current Liabilities" },
  ];
  const ledgers = [
    { name: "Domestic Buyer", parent: "Trade Receivables" },
    { name: "Overseas Buyer", parent: "Export Customers" },
    { name: "Vendor", parent: "Suppliers" },
  ];

  const selected = selectCashDiscountLedgers(ledgers, groups, {
    mode: "strict",
    selectedGroupNames: ["Trade Receivables"],
    includeNestedGroups: true,
  });
  assert.deepEqual(selected.map((ledger) => ledger.name), ["Domestic Buyer", "Overseas Buyer"]);
  assert.ok(selected.every((ledger) => ledger.cashDiscountCustomerScope.source === "selected_group"));
});

test("cash discount automatic scope marks outside ledgers for Sales-evidence verification", () => {
  const groups = [
    { name: "Sundry Debtors", parent: "Current Assets" },
    { name: "Other Parties", parent: "Current Assets" },
  ];
  const ledgers = [
    { name: "Standard Customer", parent: "Sundry Debtors" },
    { name: "Unusual Customer", parent: "Other Parties" },
    { name: "Excluded Customer", parent: "Other Parties" },
  ];

  const selected = selectCashDiscountLedgers(ledgers, groups, {
    mode: "automatic",
    selectedGroupNames: ["Sundry Debtors"],
    detectSalesLinkedExceptions: true,
    excludedLedgerNames: ["Excluded Customer"],
  });
  assert.deepEqual(selected.map((ledger) => [ledger.name, ledger.cashDiscountCustomerScope.source]), [
    ["Standard Customer", "selected_group"],
    ["Unusual Customer", "sales_linked_exception"],
  ]);
});

function bankVoucher({ reference = "", party = "Customer A" } = {}) {
  return {
    date: "20260801",
    effectiveDate: "20260801",
    reference,
    bankReferences: reference ? [reference] : [],
    partyLedgerName: party,
    ledgerNames: [party, "ICICI Current Account"],
    ledgerEntries: [
      { ledgerName: "ICICI Current Account", amount: 1250, isDebit: true },
      { ledgerName: party, amount: 1250, isDebit: false },
    ],
  };
}

test("strict bank presence uses exact reference independently of a wrong selected party", () => {
  const result = strictBankTransactionCandidates(
    [bankVoucher({ reference: "UTR-123456", party: "Actual Customer" })],
    {
      voucherDate: "2026-08-01",
      amount: 1250,
      expectedDirection: "incoming",
      referenceNumber: "UTR-123456",
      counterpartyLedgerName: "Wrong Customer",
    },
    "ICICI Current Account",
    new Set()
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.hasUsableReference, true);
});

test("strict bank presence requires the exact party when no usable reference exists", () => {
  const result = strictBankTransactionCandidates(
    [bankVoucher({ party: "Actual Customer" })],
    {
      voucherDate: "2026-08-01",
      amount: 1250,
      expectedDirection: "incoming",
      counterpartyLedgerName: "Wrong Customer",
    },
    "ICICI Current Account",
    new Set()
  );
  assert.equal(result.baseCandidateCount, 1);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.hasUsableCounterparty, true);
});

test("strict bank presence marks same-date amount evidence insufficient for Suspense", () => {
  const result = strictBankTransactionCandidates(
    [bankVoucher({ party: "Actual Customer" })],
    {
      voucherDate: "2026-08-01",
      amount: 1250,
      expectedDirection: "incoming",
      counterpartyLedgerName: "Suspense",
    },
    "ICICI Current Account",
    new Set()
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.identityInsufficient, true);
});

test("open-bill classification preserves invoices and recovers exported advances", () => {
  assert.equal(
    classifyOpenBillReferenceKind({ billType: "Advance", referenceName: "RCPT-1" }),
    "advance"
  );
  assert.equal(
    classifyOpenBillReferenceKind({ referenceName: "ADV-0007", sourceVoucherType: "Receipt" }),
    "advance"
  );
  assert.equal(
    classifyOpenBillReferenceKind({ referenceName: "ADV-0007", knownInvoice: true }),
    "bill"
  );
  assert.equal(
    classifyOpenBillReferenceKind({ referenceName: "INV-0007", sourceVoucherType: "Sales" }),
    "bill"
  );
});

test("bank discovery returns ledgers nested below Bank Accounts, never groups", () => {
  const groups = [
    { name: "Current Assets", parent: "Primary" },
    { name: "Bank Accounts", parent: "Current Assets" },
    { name: "QA Current Accounts", parent: "Bank Accounts" },
    { name: "Deeply Nested Banks", parent: "QA Current Accounts" },
    { name: "Sundry Debtors", parent: "Current Assets" },
  ];
  const ledgers = [
    { name: "Direct Bank", parent: "Bank Accounts" },
    { name: "Nested HDFC Bank", parent: "QA Current Accounts" },
    { name: "Deep Bank", parent: "Deeply Nested Banks" },
    { name: "Ordinary Customer", parent: "Sundry Debtors" },
    { name: "Metadata Bank", parent: "Current Assets", bankAccountNumber: "50123456789" },
  ];

  assert.deepEqual(
    findBankLedgersFromMasters(ledgers, groups).map((item) => item.name),
    ["Direct Bank", "Nested HDFC Bank", "Deep Bank", "Metadata Bank"]
  );
});

test("bank discovery terminates safely when custom group ancestry contains a cycle", () => {
  const groups = [
    { name: "Cycle A", parent: "Cycle B" },
    { name: "Cycle B", parent: "Cycle A" },
  ];
  const ledgers = [{ name: "Not A Bank", parent: "Cycle A" }];

  assert.deepEqual(findBankLedgersFromMasters(ledgers, groups), []);
});

function ledger(name, { dutyHead = "", taxType = "", parent = "Duties & Taxes" } = {}) {
  return {
    name,
    guid: `guid:${name}`,
    parent,
    raw: { dutyHead, taxType },
  };
}

test("GST and withholding ledgers are classified independently", () => {
  const inputCgst = ledger("Input CGST 9%", { dutyHead: "CGST", taxType: "GST" });
  const inputSgst = ledger("Input SGST 9%", { dutyHead: "SGST/UTGST", taxType: "GST" });
  const tdsPayable = ledger("TDS Payable - Scrap", { taxType: "TDS" });
  const tcsReceivable = ledger("TCS Receivable", { taxType: "TCS" });
  const roundOff = ledger("Round Off");

  const result = classifyTaxLedgers([
    inputCgst,
    inputSgst,
    tdsPayable,
    tcsReceivable,
    roundOff,
  ]);

  assert.deepEqual(result.gstLedgers.map((item) => item.name), [
    "Input CGST 9%",
    "Input SGST 9%",
  ]);
  assert.deepEqual(result.taxLedgers.map((item) => item.name), [
    "TDS Payable - Scrap",
    "TCS Receivable",
  ]);
});

test("Purchase vouchers use Tally's item-invoice envelope and allocation tags", () => {
  const xml = buildPurchaseVoucherXml({
    companyName: "Solution Nyx",
    voucherDate: "2026-07-29",
    supplierInvoiceDate: "2026-07-28",
    supplierInvoiceNumber: "VIS/26-27/0142",
    useCustomVoucherNumber: true,
    voucherNumber: "VIS/26-27/0142 / 28-Jul-26",
    supplierLedgerName: "Vertex Industrial Supplies",
    sourceDocumentPath: "C:\\Kalika Documents\\VIS-0142.pdf",
    sourceDocumentName: "VIS-0142.pdf",
    sourceDocumentSha256: "ABC123",
    sourceDocumentId: "file-1",
    vehicleNumber: "MH11AL4972",
    sourceDocumentReference: "https://app.example/cases/case-1?sourceFileId=file-1",
    postingId: "internal-posting-id",
    finalPayableAmount: 292500,
    items: [{
      stockItemName: "M S Scrap & Sponge Iron",
      purchaseLedgerName: "M.S. Scrap Purchase",
      description: "Mild Steel Scrap - HMS",
      hsn: "72044900",
      quantity: 10,
      unit: "MTS",
      rate: 25000,
      taxableAmount: 250000,
    }],
    charges: [
      { kind: "freight", name: "Transportation Inward @ 18.00%", amount: 1000 },
      { kind: "cgst", name: "Input ITC CGST 9%", amount: 22590 },
      { kind: "sgst", name: "Input ITC SGST 9%", amount: 22590 },
    ],
    withholdings: [
      { kind: "tds_194q", name: "TDS Payable @ 0.10% (194Q)", rate: "0.10", amount: 250 },
      { kind: "transport_tds", name: "Tds on Goods Transport", rate: "0.10", amount: 10 },
      { kind: "cgst_tds", name: "CGST TDS PAYABLE 1%", rate: "1", amount: 2500 },
      { kind: "sgst_tds", name: "SGST TDS PAYABLE 1%", rate: "1", amount: 2500 },
    ],
    ledgers: {
      roundOff: { name: "Round Off", amount: -0.4 },
    },
  });

  assert.match(xml, /<TALLYREQUEST>Import<\/TALLYREQUEST><TYPE>Data<\/TYPE><ID>Vouchers<\/ID>/);
  assert.match(xml, /<DATA><TALLYMESSAGE/);
  assert.match(xml, /<LEDGERENTRIES\.LIST>/);
  assert.doesNotMatch(xml, /<ALLLEDGERENTRIES\.LIST>/);
  assert.doesNotMatch(xml, /Main Location|Primary Batch|BATCHALLOCATIONS\.LIST|GODOWNNAME/);
  assert.match(xml, /<GSTHSNINFERAPPLICABILITY>Specify Details Here<\/GSTHSNINFERAPPLICABILITY>/);
  assert.match(xml, /<GSTHSNNAME>72044900<\/GSTHSNNAME>/);
  assert.match(xml, /<DATE>20260729<\/DATE>/);
  assert.match(xml, /<REFERENCEDATE>20260728<\/REFERENCEDATE>/);
  assert.match(xml, /<VOUCHERNUMBER>VIS\/26-27\/0142 \/ 28-Jul-26<\/VOUCHERNUMBER>/);
  assert.match(
    xml,
    /<BILLALLOCATIONS\.LIST><NAME>VIS\/26-27\/0142<\/NAME><BILLTYPE>New Ref<\/BILLTYPE><BILLDATE>20260729<\/BILLDATE><AMOUNT>292500\.00<\/AMOUNT><\/BILLALLOCATIONS\.LIST>/
  );
  assert.match(xml, /<LEDGERNAME>Transportation Inward @ 18\.00%<\/LEDGERNAME>/);
  assert.match(xml, /<LEDGERNAME>TDS Payable @ 0\.10% \(194Q\)<\/LEDGERNAME>/);
  assert.match(xml, /<LEDGERNAME>CGST TDS PAYABLE 1%<\/LEDGERNAME>/);
  assert.match(xml, /<STOCKITEMNAME>M S Scrap &amp; Sponge Iron<\/STOCKITEMNAME>[\s\S]*?<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>[\s\S]*?<AMOUNT>-250000\.00<\/AMOUNT>/);
  assert.match(xml, /<LEDGERNAME>Input ITC CGST 9%<\/LEDGERNAME>[\s\S]*?<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-22590\.00<\/AMOUNT>/);
  // TDS stays a credit (positive AMOUNT) but sits on the item side of the
  // invoice (ISDEEMEDPOSITIVE Yes), so Tally subtracts it from the bill total.
  assert.match(xml, /<LEDGERNAME>TDS Payable @ 0\.10% \(194Q\)<\/LEDGERNAME>[\s\S]*?<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>250\.00<\/AMOUNT>/);
  assert.match(xml, /<LEDGERNAME>Vertex Industrial Supplies<\/LEDGERNAME>[\s\S]*?<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>292500\.00<\/AMOUNT>/);
  assert.match(
    xml,
    /<BASICRATEOFINVOICETAX\.LIST TYPE="Number"><BASICRATEOFINVOICETAX>-0\.10<\/BASICRATEOFINVOICETAX><\/BASICRATEOFINVOICETAX\.LIST><ROUNDTYPE\/><LEDGERNAME>TDS Payable @ 0\.10% \(194Q\)<\/LEDGERNAME>/
  );
  assert.match(
    xml,
    /<BASICRATEOFINVOICETAX\.LIST TYPE="Number"><BASICRATEOFINVOICETAX>-1\.00<\/BASICRATEOFINVOICETAX><\/BASICRATEOFINVOICETAX\.LIST><ROUNDTYPE\/><LEDGERNAME>CGST TDS PAYABLE 1%<\/LEDGERNAME>/
  );
  assert.ok(
    xml.indexOf("<LEDGERNAME>Input ITC SGST 9%</LEDGERNAME>") <
      xml.indexOf("<LEDGERNAME>TDS Payable @ 0.10% (194Q)</LEDGERNAME>")
  );
  assert.ok(
    xml.indexOf("<LEDGERNAME>SGST TDS PAYABLE 1%</LEDGERNAME>") <
      xml.indexOf("<LEDGERNAME>Round Off</LEDGERNAME>")
  );
  assert.match(xml, /<UDF:KALIKASOURCEDOCUMENTPATH\.LIST[^>]*INDEX="30001">/);
  assert.match(xml, /C:\\Kalika Documents\\VIS-0142\.pdf/);
  assert.match(xml, /<UDF:KALIKASOURCEDOCUMENTSHA256[^>]*>ABC123<\/UDF:KALIKASOURCEDOCUMENTSHA256>/);
  assert.match(xml, /<UDF:KALIKASOURCEDOCUMENTID[^>]*>file-1<\/UDF:KALIKASOURCEDOCUMENTID>/);
  assert.match(xml, /<UDF:KALIKAVEHICLENUMBER[^>]*>MH11AL4972<\/UDF:KALIKAVEHICLENUMBER>/);
  assert.doesNotMatch(xml, /Source: https:\/\/app\.example/);
  assert.doesNotMatch(xml, /Posting: internal-posting-id/);
  assert.equal(
    [...xml.matchAll(/<LEDGERNAME>Vertex Industrial Supplies<\/LEDGERNAME>/g)].length,
    1,
    "the supplier must be represented by exactly one party ledger entry"
  );
  assert.ok(
    xml.indexOf("<LEDGERNAME>Vertex Industrial Supplies</LEDGERNAME>") <
      xml.indexOf("<ALLINVENTORYENTRIES.LIST>"),
    "the supplier party entry must precede inventory allocations so Tally binds it to the Party A/c header"
  );
});

test("Purchase vouchers reject a supplier reused as another accounting ledger", () => {
  assert.throws(
    () => buildPurchaseVoucherXml({
      companyName: "Solution Nyx",
      voucherDate: "2026-08-21",
      supplierInvoiceDate: "2026-08-20",
      supplierInvoiceNumber: "TEST/ROLE-COLLISION",
      supplierLedgerName: "Supplier A",
      finalPayableAmount: 100,
      items: [{
        stockItemName: "MS Scrap",
        purchaseLedgerName: "Supplier A",
        hsn: "72044900",
        quantity: 1,
        unit: "MTS",
        rate: 100,
        taxableAmount: 100,
      }],
    }),
    /selected as both the supplier and purchase ledger/i
  );
});

test("Purchase vouchers only include an explicitly selected Tally godown", () => {
  const xml = buildPurchaseVoucherXml({
    companyName: "Solution Nyx",
    voucherDate: "2026-08-21",
    supplierInvoiceDate: "2026-08-20",
    supplierInvoiceNumber: "TEST/1",
    supplierLedgerName: "Supplier",
    finalPayableAmount: 100,
    items: [{
      stockItemName: "MS Scrap",
      purchaseLedgerName: "Scrap Purchase",
      hsn: "72044900",
      quantity: 1,
      unit: "MTS",
      rate: 100,
      taxableAmount: 100,
      godownName: "Warehouse A",
      batchName: "Lot 1",
    }],
  });

  assert.match(
    xml,
    /<BATCHALLOCATIONS\.LIST><GODOWNNAME>Warehouse A<\/GODOWNNAME><BATCHNAME>Lot 1<\/BATCHNAME><DESTINATIONGODOWNNAME>Warehouse A<\/DESTINATIONGODOWNNAME>/
  );
});

test("Purchase vouchers do not invent Main Location when no godown is selected", () => {
  const xml = buildPurchaseVoucherXml({
    companyName: "Kalika Steel Alloys Pvt Ltd - (25-26)",
    voucherDate: "2026-09-21",
    supplierInvoiceDate: "2026-08-11",
    supplierInvoiceNumber: "SSTC-26/27-182",
    supplierLedgerName: "Surya Steel Trading Co",
    finalPayableAmount: 100,
    items: [{
      stockItemName: "M S Scrap & Sponge Iron",
      purchaseLedgerName: "M.S. Scrap Purchase",
      hsn: "72044900",
      quantity: 1,
      unit: "MTS",
      rate: 100,
      taxableAmount: 100,
      godownName: "",
      batchName: "",
    }],
  });

  assert.doesNotMatch(xml, /Main Location|Primary Batch|BATCHALLOCATIONS\.LIST|GODOWNNAME/);
});

test("Purchase duplicate checks cover the complete Indian financial year", () => {
  assert.deepEqual(purchaseVoucherFinancialYearRange("2026-08-21"), {
    dateFrom: "2026-04-01",
    dateTo: "2027-03-31",
  });
  assert.deepEqual(purchaseVoucherFinancialYearRange("2027-02-15"), {
    dateFrom: "2026-04-01",
    dateTo: "2027-03-31",
  });
});

test("Purchase narration does not append a vehicle already present in the review narration", () => {
  const xml = buildPurchaseVoucherXml({
    companyName: "Solution Nyx",
    voucherDate: "2026-08-21",
    supplierInvoiceDate: "2026-07-20",
    supplierInvoiceNumber: "DSM/26-27/087",
    supplierLedgerName: "Deccan Sponge and Minerals",
    vehicleNumber: "KA34AB2094",
    narration: "KA34AB2094 HSN: 72031000",
    finalPayableAmount: 327096,
    items: [{
      stockItemName: "M S Scrap & Sponge Iron",
      purchaseLedgerName: "O.M.S. Scrap Purchase",
      description: "Sponge Iron Lumps",
      hsn: "72031000",
      quantity: 12,
      unit: "MTS",
      rate: 23100,
      taxableAmount: 277200,
    }],
    charges: [{ kind: "igst", name: "Input ITC IGST 18%", amount: 49896 }],
    withholdings: [],
  });
  assert.match(xml, /<NARRATION>KA34AB2094 HSN: 72031000<\/NARRATION>/);
  assert.doesNotMatch(xml, /Vehicle: KA34AB2094/);
});

test("Tally import exceptions are reported as failures", () => {
  const outcome = parseTallyImportResult(
    "<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><EXCEPTIONS>1</EXCEPTIONS></RESPONSE>",
    200
  );

  assert.equal(outcome.success, false);
  assert.equal(outcome.result.exceptions, 1);
  assert.match(outcome.error, /1 import exception/);
});

test("Purchase voucher verification includes the attached source PDF identity", () => {
  const payload = {
    voucherDate: "2026-07-29",
    supplierInvoiceDate: "2026-07-28",
    supplierInvoiceNumber: "VIS/26-27/0142",
    supplierLedgerName: "Vertex Industrial Supplies",
    finalPayableAmount: 292500,
    items: [],
    charges: [],
    withholdings: [],
    sourceDocumentPath: "C:\\Kalika Documents\\VIS-0142.pdf",
    sourceDocumentName: "VIS-0142.pdf",
    sourceDocumentSha256: "ABC123",
    sourceDocumentId: "file-1",
    vehicleNumber: "MH11AL4972",
  };
  const voucher = {
    date: "20260729",
    reference: "VIS/26-27/0142",
    referenceDate: "20260728",
    inventoryEntries: [],
    ledgerEntries: [{
      ledgerName: "Vertex Industrial Supplies",
      amount: 292500,
    }],
    billAllocations: [{
      referenceName: "VIS/26-27/0142",
      billType: "New Ref",
      billDate: "20260729",
      amount: 292500,
    }],
    sourceDocumentPath: payload.sourceDocumentPath,
    sourceDocumentName: payload.sourceDocumentName,
    sourceDocumentSha256: payload.sourceDocumentSha256,
    sourceDocumentId: payload.sourceDocumentId,
    vehicleNumber: payload.vehicleNumber,
  };

  assert.deepEqual(purchaseVoucherReadbackComparison(voucher, payload), []);
  assert.ok(
    existingPurchaseVoucherAttachmentDifferences(
      { ...voucher, sourceDocumentPath: null },
      payload
    ).some((difference) => /pdf path was not attached/i.test(difference)),
    "a duplicate voucher without the approved PDF must require attachment repair"
  );
  assert.deepEqual(
    purchaseVoucherReadbackComparison(
      { ...voucher, voucherNumber: "3285" },
      { ...payload, voucherNumber: "VIS/26-27/0142 / 28-Jul-26" }
    ),
    [],
    "Tally automatic numbering must not fail an otherwise verified voucher"
  );
  assert.ok(
    purchaseVoucherReadbackComparison(
      { ...voucher, sourceDocumentSha256: null },
      payload
    ).some((difference) => /checksum/i.test(difference))
  );
  assert.ok(
    purchaseVoucherReadbackComparison(
      {
        ...voucher,
        ledgerEntries: [...voucher.ledgerEntries, { ...voucher.ledgerEntries[0] }],
      },
      payload
    ).some((difference) => /expected one supplier ledger allocation/i.test(difference))
  );
  assert.ok(
    purchaseVoucherReadbackComparison(
      {
        ...voucher,
        billAllocations: [{ ...voucher.billAllocations[0], billDate: "20260728" }],
      },
      payload
    ).some((difference) => /outstanding bill date/i.test(difference))
  );
  assert.ok(
    purchaseVoucherReadbackComparison(
      { ...voucher, vehicleNumber: "MH12WRONG" },
      payload
    ).some((difference) => /vehicle number/i.test(difference))
  );
  assert.deepEqual(
    purchaseVoucherReadbackComparison(
      {
        ...voucher,
        date: "20260821",
        billAllocations: [{ ...voucher.billAllocations[0], billDate: "20260821" }],
        sourceDocumentPath: null,
        sourceDocumentName: null,
        sourceDocumentSha256: null,
        sourceDocumentId: null,
        vehicleNumber: null,
        narration: "Vehicle MH11AL4972",
      },
      payload,
      {
        ignoreVoucherDate: true,
        ignoreBillDate: true,
        ignoreSourceDocumentIdentity: true,
      }
    ),
    []
  );
});

test("Purchase PDF verification does not require the Kalika TDL", () => {
  const payload = {
    voucherDate: "2026-07-29",
    supplierInvoiceDate: "2026-07-28",
    supplierInvoiceNumber: "VIS/26-27/0142",
    supplierLedgerName: "Vertex Industrial Supplies",
    finalPayableAmount: 292500,
    items: [],
    charges: [],
    withholdings: [],
    sourceDocumentPath: "\\\\ksplserver\\TRANCATION\\PURCHASE\\Vertex Industrial Supplies VIS-26-27-0142.pdf",
    sourceDocumentName: "Vertex Industrial Supplies VIS-26-27-0142.pdf",
    sourceDocumentSha256: "ABC123",
    sourceDocumentId: "file-1",
  };
  const voucher = {
    date: "20260729",
    reference: "VIS/26-27/0142",
    referenceDate: "20260728",
    inventoryEntries: [],
    ledgerEntries: [{ ledgerName: "Vertex Industrial Supplies", amount: 292500 }],
    billAllocations: [{ referenceName: "VIS/26-27/0142", billType: "New Ref", billDate: "20260729", amount: 292500 }],
  };
  const pdfDifferences = (voucherValue, payloadValue) =>
    purchaseVoucherReadbackComparison(voucherValue, payloadValue).filter((difference) => /pdf|document/i.test(difference));

  // No Kalika TDL and no shared folder: nothing in Tally can hold the PDF.
  assert.deepEqual(pdfDifferences(voucher, payload), []);
  // Shared folder configured: the client's Attach Documents path must match.
  const withFolder = { ...payload, sourceDocumentFolder: "\\\\ksplserver\\TRANCATION\\PURCHASE" };
  assert.deepEqual(pdfDifferences({ ...voucher, linkDocumentPath: payload.sourceDocumentPath }, withFolder), []);
  assert.ok(pdfDifferences(voucher, withFolder).some((difference) => /pdf path was not attached/i.test(difference)));
  assert.ok(pdfDifferences({ ...voucher, linkDocumentPath: "\\\\ksplserver\\other.pdf" }, withFolder).length > 0);
});

test("canonical Purchase vouchers reject an unbalanced approved representation", () => {
  assert.throws(() => buildPurchaseVoucherXml({
    canonicalVersion: 2,
    companyName: "Solution Nyx",
    voucherDate: "2026-09-05",
    supplierInvoiceDate: "2026-09-05",
    supplierInvoiceNumber: "INV-UNBALANCED",
    supplierLedgerName: "Supplier",
    finalPayableAmount: 119,
    items: [{
      stockItemName: "MS Scrap",
      purchaseLedgerName: "Scrap Purchase",
      hsn: "72044900",
      quantity: 1,
      unit: "MTS",
      rate: 100,
      taxableAmount: 100,
    }],
    charges: [{ kind: "igst", name: "Input IGST", amount: 18 }],
    withholdings: [],
  }), /not balanced/i);
});

test("Purchase read-back rejects every substantive canonical mutation regardless of ordering", () => {
  const payload = {
    canonicalVersion: 2,
    voucherDate: "2026-09-05",
    supplierInvoiceDate: "2026-09-05",
    supplierInvoiceNumber: "INV-STRICT-1",
    supplierLedgerName: "Supplier",
    finalPayableAmount: 117.5,
    items: [{
      stockItemName: "MS Scrap",
      purchaseLedgerName: "Scrap Purchase",
      hsn: "72044900",
      quantity: 1,
      unit: "MTS",
      rate: 100,
      taxableAmount: 100,
      godownName: "Warehouse A",
      batchName: "Lot 1",
    }],
    charges: [
      { kind: "cgst", name: "Input CGST", amount: 9 },
      { kind: "sgst", name: "Input SGST", amount: 9 },
    ],
    withholdings: [{ kind: "tds_194q", name: "TDS 194Q", amount: 1 }],
    ledgers: { roundOff: { name: "Round Off", amount: 0.5 } },
  };
  const voucher = {
    date: "20260905",
    reference: "INV-STRICT-1",
    referenceDate: "20260905",
    inventoryEntries: [{
      stockItemName: "MS Scrap",
      purchaseLedgerName: "Scrap Purchase",
      hsn: "72044900",
      quantity: "1 MTS",
      rate: "100 / MTS",
      signedAmount: -100,
      amount: 100,
      godownName: "Warehouse A",
      batchName: "Lot 1",
    }],
    ledgerEntries: [
      { ledgerName: "Scrap Purchase", amount: -100 },
      { ledgerName: "Input SGST", amount: -9 },
      { ledgerName: "Supplier", amount: 117.5 },
      { ledgerName: "TDS 194Q", amount: 1 },
      { ledgerName: "Round Off", amount: -0.5 },
      { ledgerName: "Input CGST", amount: -9 },
    ],
    billAllocations: [{ referenceName: "INV-STRICT-1", billType: "New Ref", billDate: "20260905", amount: 117.5 }],
  };
  assert.deepEqual(purchaseVoucherReadbackComparison(voucher, payload), []);

  const mutations = [
    ["quantity", { inventoryEntries: [{ ...voucher.inventoryEntries[0], quantity: "2 MTS" }] }],
    ["rate", { inventoryEntries: [{ ...voucher.inventoryEntries[0], rate: "101 / MTS" }] }],
    ["unit", { inventoryEntries: [{ ...voucher.inventoryEntries[0], quantity: "1 KG" }] }],
    ["tax ledger", { ledgerEntries: voucher.ledgerEntries.map((row) => row.ledgerName === "Input CGST" ? { ...row, ledgerName: "Wrong CGST" } : row) }],
    ["accounting direction", { inventoryEntries: [{ ...voucher.inventoryEntries[0], signedAmount: 100 }] }],
    ["round-off", { ledgerEntries: voucher.ledgerEntries.map((row) => row.ledgerName === "Round Off" ? { ...row, amount: 0.5 } : row) }],
    ["godown", { inventoryEntries: [{ ...voucher.inventoryEntries[0], godownName: "Warehouse B" }] }],
    ["batch", { inventoryEntries: [{ ...voucher.inventoryEntries[0], batchName: "Lot 2" }] }],
    ["bill type", { billAllocations: [{ ...voucher.billAllocations[0], billType: "Agst Ref" }] }],
    ["extra entry", { ledgerEntries: [...voucher.ledgerEntries, { ledgerName: "Unexpected", amount: -1 }] }],
  ];
  for (const [name, mutation] of mutations) {
    assert.notDeepEqual(
      purchaseVoucherReadbackComparison({ ...voucher, ...mutation }, payload),
      [],
      `${name} mutation must fail verification`
    );
  }
});

test("purchase vouchers record the supplier e-way bill as reference, like the client's own export", () => {
  const payload = {
    companyName: "Kalika Steel Alloys Pvt Ltd", voucherDate: "2026-08-12", supplierInvoiceDate: "2026-08-12",
    supplierInvoiceNumber: "BST/26-27/635", supplierLedgerName: "BHAWANA STEEL TRADERS Nagpur (SCRAP)", finalPayableAmount: "1180",
    items: [{ stockItemName: "M S Scrap & Sponge Iron", purchaseLedgerName: "M.S. Scrap Purchase", hsn: "72044900", unit: "MTS", quantity: "1", rate: "1000", taxableAmount: "1000" }],
    charges: [{ name: "Input ITC CGST 9%", amount: "90" }, { name: "Input ITC SGST 9%", amount: "90" }],
    ewayBill: {
      record: true, number: "262264097358", date: "2026-08-12",
      fromAddress: "PLOT NO 22, MIDC AREA HINGNA ROAD, NAGPUR, NAGPUR,MAHARASHTRA-440016",
      fromPlace: "NAGPUR", fromPincode: "440016", fromState: "Maharashtra",
      toPlace: "JALNA", toPincode: "431203", toState: "Maharashtra",
      transportMode: "1 - Road", vehicleNumber: "MH21X7266", distanceKm: "437",
      consignee: { address: "C-7 & 8, Addl. M.I.D.C. Area, Jalna", pincode: "431203", state: "Maharashtra" },
    },
  };
  const xml = buildPurchaseVoucherXml(payload, payload.companyName);
  assert.match(xml, /<ISEWAYBILLAPPLICABLE>No<\/ISEWAYBILLAPPLICABLE><OVRDNEWAYBILLAPPLICABILITY>No<\/OVRDNEWAYBILLAPPLICABILITY><EWAYBILLDETAILS\.LIST>/);
  assert.match(xml, /<BILLNUMBER>262264097358<\/BILLNUMBER>/);
  assert.match(xml, /<BILLDATE>20260812<\/BILLDATE><DOCUMENTTYPE>Tax Invoice<\/DOCUMENTTYPE>/);
  assert.match(xml, /<CONSIGNEEADDRESS>C-7 &amp; 8, Addl\. M\.I\.D\.C\. Area, Jalna<\/CONSIGNEEADDRESS>/);
  assert.match(xml, /<CONSIGNORPLACE>NAGPUR<\/CONSIGNORPLACE><CONSIGNORPINCODE>440016<\/CONSIGNORPINCODE><CONSIGNEEPLACE>JALNA<\/CONSIGNEEPLACE>/);
  assert.match(xml, /<TRANSPORTDETAILS\.LIST><TRANSPORTMODE>1 - Road<\/TRANSPORTMODE><VEHICLENUMBER>MH21X7266<\/VEHICLENUMBER><DISTANCE> 437<\/DISTANCE><\/TRANSPORTDETAILS\.LIST>/);
  // No e-way bill, or an invalid number: the voucher is exactly as before.
  assert.doesNotMatch(buildPurchaseVoucherXml({ ...payload, ewayBill: undefined }, payload.companyName), /EWAYBILL/);
  assert.doesNotMatch(buildPurchaseVoucherXml({ ...payload, ewayBill: { ...payload.ewayBill, number: "12345" } }, payload.companyName), /EWAYBILL/);
});

test("two items on one purchase ledger verify against Tally's single combined ledger row", () => {
  const item = (quantity, amount) => ({ stockItemName: "M S Scrap & Sponge Iron", purchaseLedgerName: "M.S. Scrap Purchase",
    hsn: "72044900", unit: "MTS", quantity, rate: "34300", taxableAmount: amount, godownName: "Main Location" });
  const payload = {
    voucherDate: "2026-09-30", supplierInvoiceDate: "2026-08-12", supplierInvoiceNumber: "BST/26-27/635",
    supplierLedgerName: "Tawari Vasundhara Steel Enterprises, Kolhapur", finalPayableAmount: "1051638",
    items: [item("18.690", "641067"), item("11.970", "410571")], charges: [], withholdings: [],
  };
  const inventory = (quantity, amount) => ({ stockItemName: "M S Scrap & Sponge Iron", purchaseLedgerName: "M.S. Scrap Purchase",
    hsn: "72044900", quantity: `${quantity} MTS`, rate: "34300.00/MTS", amount, signedAmount: -amount, godownName: "Main Location" });
  const voucher = {
    date: "20260930", reference: "BST/26-27/635", referenceDate: "20260812",
    inventoryEntries: [inventory("18.690", 641067), inventory("11.970", 410571)],
    billAllocations: [{ referenceName: "BST/26-27/635", billType: "New Ref", billDate: "20260930", amount: 1051638 }],
  };
  const withLedgers = (rows) => purchaseVoucherReadbackComparison({ ...voucher, ledgerEntries: [
    { ledgerName: payload.supplierLedgerName, amount: 1051638 }, ...rows] }, payload);

  // Tally combines both items into one row on the purchase ledger.
  assert.deepEqual(withLedgers([{ ledgerName: "M.S. Scrap Purchase", amount: -1051638 }]), []);
  // Split per item is accepted as well.
  assert.deepEqual(withLedgers([{ ledgerName: "M.S. Scrap Purchase", amount: -641067 }, { ledgerName: "M.S. Scrap Purchase", amount: -410571 }]), []);
  // A wrong total is still a mismatch.
  assert.ok(withLedgers([{ ledgerName: "M.S. Scrap Purchase", amount: -1000000 }]).some((text) => /M\.S\. Scrap Purchase purchase ledger/.test(text)));
});
