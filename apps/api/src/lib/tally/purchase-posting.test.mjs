import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function loadPurchasePostingModule() {
  const sharedCalculatorSource = readFileSync(
    new URL("../../../../../packages/shared/src/lib/purchase-voucher.ts", import.meta.url),
    "utf8"
  );
  const sharedCalculatorUrl = dataUrl(transpile(sharedCalculatorSource));
  const lineItemsSource = readFileSync(new URL("../line-items.ts", import.meta.url), "utf8");
  const lineItemsUrl = dataUrl(transpile(lineItemsSource));
  const commercialFieldsSource = readFileSync(
    new URL("../invoice-commercial-fields.ts", import.meta.url),
    "utf8"
  );
  const commercialFieldsUrl = dataUrl(transpile(commercialFieldsSource));
  const postingSource = readFileSync(new URL("./purchase-posting.ts", import.meta.url), "utf8")
    .replace('from "@/lib/line-items"', `from "${lineItemsUrl}"`)
    .replace(
      'from "@/lib/invoice-commercial-fields"',
      `from "${commercialFieldsUrl}"`
    )
    .replace(
      'from "@autodealer/shared/lib/purchase-voucher"',
      `from "${sharedCalculatorUrl}"`
    );
  return import(dataUrl(transpile(postingSource)));
}

const {
  compactPurchasePostingReview,
  preparePurchasePosting,
  getCanonicalInvoiceDocuments,
  getPurchaseInvoiceCandidates,
  purchaseVoucherNumber,
  transportTdsRateForPayee,
} = await loadPurchasePostingModule();

test("purchase voucher number matches the frontend invoice/date reference", () => {
  assert.equal(
    purchaseVoucherNumber("SSTC/INV/26-27/G01", "2026-08-21"),
    "SSTC/INV/26-27/G01 / 21-Aug-26"
  );
});

const supplierGstin = "27AAAAA0000A1Z5";
const maharashtraBuyerGstin = "27BBBBB0000B1Z5";
const gujaratBuyerGstin = "24BBBBB0000B1Z5";

function master(master_type, tally_name, extra = {}) {
  return {
    id: `${master_type}:${tally_name}`,
    master_type,
    master_key: tally_name.toLowerCase(),
    tally_name,
    parent_name: null,
    gstin: null,
    hsn_code: null,
    unit_name: null,
    tax_rate: null,
    is_active: true,
    ...extra,
  };
}

const completeMasters = [
  master("ledger", "Scrap Supplier", { gstin: supplierGstin }),
  master("ledger", "M.S. Scrap Purchase"),
  master("ledger", "O.M.S. Scrap Purchase"),
  master("stock_item", "M S Scrap & Sponge Iron", { unit_name: "MTS" }),
  master("gst_ledger", "Input ITC CGST 9%"),
  master("gst_ledger", "Input ITC SGST 9%"),
  master("gst_ledger", "Input ITC IGST 18%"),
  master("ledger", "Transportation Inward @ 18.00%"),
  master("tax_ledger", "TDS Payable @ 0.10% (194Q)"),
  master("tax_ledger", "Tds on Goods Transport"),
  master("tax_ledger", "CGST TDS PAYABLE 1%"),
  master("tax_ledger", "SGST TDS PAYABLE 1%"),
  master("tax_ledger", "IGST TDS PAYABLE 2%"),
  master("tax_ledger", "TCS Receivable"),
  master("ledger", "Round Off"),
];

function invoiceDocument({
  id = "invoice-1",
  hsn = "72044900",
  buyerGstin = maharashtraBuyerGstin,
  totalAmount = "1159.00",
  taxAmount = "180.00",
  tdsAmount = "1.00",
  lines,
} = {}) {
  const invoiceLines = lines ?? [{
    description: hsn === "72031000" ? "Sponge Iron" : "MS Scrap",
    hsnSac: hsn,
    quantity: "1",
    unit: "MT",
    rate: "1000.00",
    taxableAmount: "1000.00",
    taxAmount,
  }];
  return {
    id,
    document_type: "Tax Invoice",
    source_file_name: "invoice.pdf",
    source_hint: "invoice.pdf",
    title: "Purchase invoice",
    extracted_fields: {
      invoiceNumber: "INV-100",
      documentDate: "27/07/2026",
      vendorName: "Scrap Supplier",
      supplierGstin,
      buyerName: "Configured Buyer",
      buyerGstin,
      taxRate: "18",
      vehicleNumber: "MH12AB1234",
      totalTaxableAmount: "1000.00",
      taxAmount,
      totalAmount,
      tdsAmount,
      tds194qAmount: tdsAmount,
      tds194qRate: "0.1",
      cgstTdsAmount: hsn.startsWith("7204") && buyerGstin.slice(0, 2) === supplierGstin.slice(0, 2) ? "10.00" : "",
      sgstTdsAmount: hsn.startsWith("7204") && buyerGstin.slice(0, 2) === supplierGstin.slice(0, 2) ? "10.00" : "",
      __lineItems: invoiceLines,
    },
  };
}

function prepare(document, options = {}) {
  const base = preparePurchasePosting({
    documents: [document],
    masters: options.masters ?? completeMasters,
    mappings: options.mappings ?? [],
    savedReview: Object.prototype.hasOwnProperty.call(options, "savedReview")
      ? options.savedReview
      : {
          sourceReferenceApproved: true,
          applyTds194q: Boolean(document.extracted_fields.tds194qAmount) &&
            options.accountingSettings?.purchaseGoodsTdsEnabled !== false,
          tds194qRounding: "paise",
        },
    caseStatus: "accepted",
    connectionReady: true,
    companyName: "Test Company",
    companyGstin: options.companyGstin ?? document.extracted_fields.buyerGstin,
    sourceDocumentReference: "https://app.example/cases/case-1?sourceFileId=file-1",
    duplicateExists: options.duplicateExists ?? false,
    accountingSettings: options.accountingSettings ?? {
      purchaseGoodsTdsEnabled: true,
      transporterTdsEnabled: true,
      gstTdsEnabled: true,
    },
  });
  return base;
}

test("invoice total after round-off is not mistaken for the round-off amount", () => {
  const document = invoiceDocument({
    totalAmount: "1179.60",
    taxAmount: "180.00",
    tdsAmount: "",
  });
  document.extracted_fields.roundOffAmount = "1179.60";
  document.extracted_fields.cgstTdsAmount = "";
  document.extracted_fields.sgstTdsAmount = "";
  document.markdown = "Invoice total after round-off INR 1,179.60";

  const result = prepare(document);

  assert.equal(result.source.invoiceRoundOffAmount, "-0.40");
  assert.equal(result.review.roundOffAmount, "-0.40");
  // The printed round-off reconciles the invoice; the Tally payable is already whole.
  assert.equal(result.calculation.roundOffAmount, "0.00");
  assert.equal(result.calculation.totalDifference, "0.00");
});

test("72044900 maps to the combined client stock and Maharashtra purchase rules", () => {
  const document = invoiceDocument();
  // Some invoices/OCR return the combined GST-TDS rate as 2%. Tally's
  // intrastate ledgers must still receive 1% CGST and 1% SGST individually.
  document.extracted_fields.gstTdsRate = "2";
  const result = prepare(document);
  assert.equal(result.review.lines[0].stockItemName, "M S Scrap & Sponge Iron");
  assert.equal(result.review.lines[0].unit, "MT");
  assert.equal(result.tallyPayload.items[0].unit, "MTS");
  assert.equal(result.review.lines[0].purchaseLedgerName, "M.S. Scrap Purchase");
  assert.equal(result.review.lines[0].hsn, "72044900");
  assert.equal(result.calculation.taxMode, "cgst_sgst");
  assert.equal(result.calculation.cgstAmount, "90.00");
  assert.equal(result.calculation.sgstAmount, "90.00");
  assert.equal(result.calculation.tds194qAmount, "1.00");
  assert.equal(result.calculation.cgstTdsAmount, "10.00");
  assert.equal(result.calculation.sgstTdsAmount, "10.00");
  assert.equal(result.calculation.gstTdsRate, "1");
  assert.ok(result.tallyPayload.withholdings
    .filter((entry) => entry.kind === "cgst_tds" || entry.kind === "sgst_tds")
    .every((entry) => entry.rate === "1"));
  assert.deepEqual(result.blockers, []);
});

test("supplier ledger cannot also be selected as an item purchase ledger", () => {
  const document = invoiceDocument();
  const initial = prepare(document);
  const result = prepare(document, {
    savedReview: {
      ...initial.review,
      lines: initial.review.lines.map((line) => ({
        ...line,
        purchaseLedgerName: initial.review.supplierLedgerName,
      })),
    },
  });

  assert.ok(
    result.blockers.some((blocker) => blocker.code === "PURCHASE_LEDGER_MATCHES_SUPPLIER")
  );
});

test("supplier ledger cannot be reused as an active tax ledger", () => {
  const document = invoiceDocument();
  const initial = prepare(document);
  const result = prepare(document, {
    savedReview: {
      ...initial.review,
      cgstLedgerName: initial.review.supplierLedgerName,
    },
  });

  assert.ok(
    result.blockers.some((blocker) => blocker.code === "SUPPLIER_LEDGER_ROLE_COLLISION")
  );
});

test("printed G02 godown is matched from live Tally and reaches the voucher payload", () => {
  const document = invoiceDocument();
  document.extracted_fields.termsAndConditions =
    "PAYMENT TERMS: 30 days; STORAGE / DELIVERY LOCATION: Main Location; COMMERCIAL CLASSIFICATION: Local purchase";
  document.markdown = `${document.markdown ?? ""}\n## Visible Text\nDELIVERY LOCATION Main Location SUPPLIER BATCH / LOT Not stated`;
  const result = prepare(document, {
    masters: [
      ...completeMasters,
      master("godown", "Main Location"),
    ],
  });

  assert.equal(result.source.godownName, "Main Location");
  assert.equal(result.review.lines[0].godownName, "Main Location");
  assert.equal(result.tallyPayload.items[0].godownName, "Main Location");
  assert.equal(result.tallyPayload.items[0].batchName, "");
  assert.equal(result.blockers.some((blocker) => blocker.code === "GODOWN_REQUIRED"), false);
});

test("printed G02 godown auto-selects when the live godown catalogue is temporarily empty", () => {
  const document = invoiceDocument();
  document.extracted_fields.termsAndConditions =
    "PAYMENT TERMS: 30 days; STORAGE / DELIVERY LOCATION: Main Location; COMMERCIAL CLASSIFICATION: Local purchase";

  const result = prepare(document);

  assert.equal(result.source.godownName, "Main Location");
  assert.equal(result.review.lines[0].godownName, "Main Location");
  assert.equal(result.tallyPayload.items[0].godownName, "Main Location");
  assert.equal(result.blockers.some((blocker) => blocker.code === "GODOWN_REQUIRED"), false);
});

test("reviewer can disable all applicable GST TDS deductions for a voucher", () => {
  const document = invoiceDocument();
  const result = prepare(document, {
    savedReview: {
      sourceReferenceApproved: true,
      applyGstTds: false,
    },
  });

  assert.equal(result.review.applyGstTds, false);
  assert.equal(result.calculation.cgstTdsAmount, "0.00");
  assert.equal(result.calculation.sgstTdsAmount, "0.00");
  assert.equal(result.calculation.igstTdsAmount, "0.00");
  assert.equal(
    result.tallyPayload.withholdings.some((entry) =>
      ["cgst_tds", "sgst_tds", "igst_tds"].includes(entry.kind)
    ),
    false
  );
});

test("invoice evidence automatically selects every applicable purchase adjustment", () => {
  const document = invoiceDocument({ totalAmount: "1857.00" });
  document.extracted_fields.freightAmount = "700.00";
  document.extracted_fields.freightGstRate = "0";
  document.extracted_fields.transportTdsAmount = "7.00";
  document.extracted_fields.transportTdsRate = "1";
  document.extracted_fields.tcsAmount = "5.00";

  const result = prepare(document, { savedReview: null });

  assert.equal(result.review.applyTds194q, true);
  assert.equal(result.review.applyTransportTds, true);
  assert.equal(result.review.applyGstTds, true);
  assert.equal(result.review.tcsReceivable, true);
  assert.equal(result.calculation.tds194qAmount, "1.00");
  assert.equal(result.calculation.transportTdsAmount, "7.00");
  assert.equal(result.calculation.cgstTdsAmount, "10.00");
  assert.equal(result.calculation.sgstTdsAmount, "10.00");
  assert.equal(result.calculation.tcsAmount, "5.00");
  assert.deepEqual(
    result.tallyPayload.withholdings.map((entry) => entry.kind).sort(),
    ["cgst_tds", "sgst_tds", "tds_194q", "transport_tds"]
  );
  assert.deepEqual(result.tallyPayload.ledgers.tcs, {
    name: "TCS Receivable",
    amount: "5.00",
  });
  assert.equal(result.calculation.calculatedPayable, "1857.00");
  assert.equal(result.blockers.length, 0);
});

test("manual switches remove and restore every optional adjustment in the Tally payload", () => {
  const document = invoiceDocument({ totalAmount: "1157.00" });
  document.extracted_fields.transportTdsAmount = "7.00";
  document.extracted_fields.transportTdsRate = "1";
  document.extracted_fields.tcsAmount = "5.00";
  const detected = prepare(document, { savedReview: null });

  const removed = prepare(document, {
    savedReview: {
      ...detected.review,
      applyTds194q: false,
      applyTransportTds: false,
      applyGstTds: false,
      tcsReceivable: false,
    },
  });
  assert.equal(removed.calculation.tds194qAmount, "0.00");
  assert.equal(removed.calculation.transportTdsAmount, "0.00");
  assert.equal(removed.calculation.cgstTdsAmount, "0.00");
  assert.equal(removed.calculation.sgstTdsAmount, "0.00");
  assert.equal(removed.calculation.igstTdsAmount, "0.00");
  assert.equal(removed.calculation.tcsAmount, "0.00");
  assert.deepEqual(removed.tallyPayload.withholdings, []);
  assert.equal(removed.tallyPayload.ledgers.tcs, null);

  const restored = prepare(document, {
    savedReview: {
      ...removed.review,
      applyTds194q: true,
      applyTransportTds: true,
      applyGstTds: true,
      tcsReceivable: true,
    },
  });
  assert.deepEqual(
    restored.tallyPayload.withholdings.map((entry) => entry.kind).sort(),
    ["cgst_tds", "sgst_tds", "tds_194q", "transport_tds"]
  );
  assert.equal(restored.tallyPayload.ledgers.tcs?.amount, "5.00");
  assert.equal(restored.calculation.calculatedPayable, "1157.00");
});

test("enabled optional adjustments with no invoice amount do not block or create zero-value entries", () => {
  const document = invoiceDocument({
    hsn: "72031000",
    buyerGstin: gujaratBuyerGstin,
    totalAmount: "1180.00",
    tdsAmount: "",
  });
  const result = prepare(document, {
    companyGstin: gujaratBuyerGstin,
    savedReview: {
      sourceReferenceApproved: true,
      applyTransportTds: true,
      applyGstTds: true,
      tcsReceivable: true,
      tcsAmount: "",
      tcsLedgerName: "",
    },
  });

  assert.equal(result.calculation.transportTdsAmount, "0.00");
  assert.equal(result.calculation.igstTdsAmount, "0.00");
  assert.equal(result.calculation.tcsAmount, "0.00");
  assert.equal(
    result.blockers.some((entry) =>
      ["TCS_AMOUNT_REQUIRED", "TCS_LEDGER_REQUIRED"].includes(entry.code)
    ),
    false
  );
  assert.equal(
    result.tallyPayload.withholdings.some((entry) =>
      ["transport_tds", "cgst_tds", "sgst_tds", "igst_tds"].includes(entry.kind)
    ),
    false
  );
  assert.equal(result.tallyPayload.ledgers.tcs, null);
  assert.equal(
    result.tallyPayload.charges.some((entry) => entry.kind === "tcs"),
    false
  );
});

test("live Tally metadata discovers non-client-specific purchase, GST, and withholding masters", () => {
  const genericMasters = [
    master("ledger", "Vendor Ledger A", {
      gstin: supplierGstin,
      parent_name: "Regional Trade Creditors",
      group_path: "Primary > Sundry Creditors > Regional Trade Creditors",
    }),
    master("ledger", "Local Raw Material Purchases", {
      parent_name: "Purchase Accounts",
      group_path: "Primary > Purchase Accounts",
    }),
    master("stock_item", "Ferrous Metal Scrap", {
      parent_name: "Scrap Materials",
      hsn_code: "72044900",
      unit_name: "MTS",
    }),
    master("gst_ledger", "Central Input Credit 9", {
      parent_name: "Duties & Taxes",
      group_path: "Primary > Duties & Taxes > GST",
      tax_rate: 9,
      raw_payload: { taxType: "GST", gstDutyHead: "CGST" },
    }),
    master("gst_ledger", "State Input Credit 9", {
      parent_name: "Duties & Taxes",
      group_path: "Primary > Duties & Taxes > GST",
      tax_rate: 9,
      raw_payload: { taxType: "GST", gstDutyHead: "SGST" },
    }),
    master("gst_ledger", "Integrated Input Credit 18", {
      parent_name: "Duties & Taxes",
      group_path: "Primary > Duties & Taxes > GST",
      tax_rate: 18,
      raw_payload: { taxType: "GST", gstDutyHead: "IGST" },
    }),
    master("tax_ledger", "Purchase withholding section 194Q 0.10%"),
    master("tax_ledger", "Central tax deducted on scrap"),
    master("tax_ledger", "State tax deducted on scrap"),
  ];

  const result = prepare(invoiceDocument(), { masters: genericMasters });

  assert.equal(result.review.supplierLedgerName, "Vendor Ledger A");
  assert.equal(result.review.lines[0].stockItemName, "Ferrous Metal Scrap");
  assert.equal(result.review.lines[0].purchaseLedgerName, "Local Raw Material Purchases");
  assert.equal(result.review.cgstLedgerName, "Central Input Credit 9");
  assert.equal(result.review.sgstLedgerName, "State Input Credit 9");
  assert.equal(result.review.tds194qLedgerName, "Purchase withholding section 194Q 0.10%");
  assert.equal(result.review.cgstTdsLedgerName, "Central tax deducted on scrap");
  assert.equal(result.review.sgstTdsLedgerName, "State tax deducted on scrap");
  assert.equal(result.blockers.length, 0);
});

test("qualifying Maharashtra MS Scrap automatically deducts 1% CGST and 1% SGST without invoice-printed TDS", () => {
  const document = invoiceDocument({
    totalAmount: "354000.00",
    taxAmount: "54000.00",
    tdsAmount: "",
    lines: [{
      description: "MS Scrap",
      hsnSac: "72044900",
      quantity: "10",
      unit: "MT",
      rate: "30000.00",
      taxableAmount: "300000.00",
      taxAmount: "54000.00",
    }],
  });
  delete document.extracted_fields.cgstTdsAmount;
  delete document.extracted_fields.sgstTdsAmount;

  const result = prepare(document, {
    accountingSettings: {
      purchaseGoodsTdsEnabled: false,
      transporterTdsEnabled: false,
      gstTdsEnabled: true,
    },
  });

  assert.equal(result.calculation.scrapGstTdsEligible, true);
  assert.equal(result.calculation.gstTdsAutomatic, true);
  assert.equal(result.calculation.gstTdsBasisAmount, "300000.00");
  assert.equal(result.calculation.gstTdsRate, "1");
  assert.equal(result.calculation.cgstTdsAmount, "3000.00");
  assert.equal(result.calculation.sgstTdsAmount, "3000.00");
  assert.equal(result.calculation.calculatedPayable, "348000.00");
  assert.equal(result.calculation.totalDifference, "0.00");
  assert.ok(!result.blockers.some((blocker) => /INVOICE_EVIDENCE_REQUIRED$/.test(blocker.code)));
  assert.ok(result.tallyPayload.withholdings.some((entry) =>
    entry.kind === "cgst_tds" && entry.taxableBasis === "300000.00" && entry.amount === "3000.00"
  ));
  assert.equal(result.blockers.length, 0);
});

test("qualifying interstate MS Scrap automatically deducts 2% IGST TDS", () => {
  const document = invoiceDocument({
    buyerGstin: gujaratBuyerGstin,
    totalAmount: "354000.00",
    taxAmount: "54000.00",
    tdsAmount: "",
    lines: [{
      description: "MS Scrap",
      hsnSac: "72044900",
      quantity: "10",
      unit: "MT",
      rate: "30000.00",
      taxableAmount: "300000.00",
      taxAmount: "54000.00",
    }],
  });

  const result = prepare(document, {
    companyGstin: gujaratBuyerGstin,
    accountingSettings: {
      purchaseGoodsTdsEnabled: false,
      transporterTdsEnabled: false,
      gstTdsEnabled: true,
    },
  });

  assert.equal(result.calculation.gstTdsAutomatic, true);
  assert.equal(result.calculation.gstTdsRate, "2");
  assert.equal(result.calculation.igstTdsAmount, "6000.00");
  assert.equal(result.calculation.calculatedPayable, "348000.00");
  assert.equal(result.calculation.totalDifference, "0.00");
  assert.equal(result.blockers.length, 0);
});

test("qualifying MS Scrap is blocked instead of silently posting when GST TDS is disabled", () => {
  const document = invoiceDocument({
    totalAmount: "354000.00",
    taxAmount: "54000.00",
    tdsAmount: "",
    lines: [{
      description: "MS Scrap",
      hsnSac: "72044900",
      quantity: "10",
      unit: "MT",
      rate: "30000.00",
      taxableAmount: "300000.00",
      taxAmount: "54000.00",
    }],
  });
  delete document.extracted_fields.cgstTdsAmount;
  delete document.extracted_fields.sgstTdsAmount;

  const result = prepare(document, {
    accountingSettings: {
      purchaseGoodsTdsEnabled: false,
      transporterTdsEnabled: false,
      gstTdsEnabled: false,
    },
  });

  assert.equal(result.calculation.scrapGstTdsEligible, true);
  assert.equal(result.calculation.gstTdsAutomatic, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === "SCRAP_GST_TDS_DISABLED"));
});

test("source PDF attachment is automatic and legacy link approval no longer blocks posting", () => {
  const document = invoiceDocument();
  const result = prepare(document, {
    savedReview: {
      sourceReferenceApproved: false,
      narration: `Purchase invoice ${document.extracted_fields.invoiceNumber} imported from the packet-matching case.`,
    },
  });

  assert.equal(result.review.sourceReferenceApproved, true);
  assert.equal(
    result.review.narration,
    "MH12AB1234 HSN: 72044900"
  );
  assert.ok(!result.blockers.some((blocker) => blocker.code === "SOURCE_REFERENCE_APPROVAL_REQUIRED"));
  assert.equal("sourceDocumentReference" in result.tallyPayload, false);
});

test("recovers vehicle and explicit withholding evidence from invoice text", () => {
  const document = invoiceDocument({
    buyerGstin: gujaratBuyerGstin,
    totalAmount: "1159.00",
    tdsAmount: "1.00",
  });
  delete document.extracted_fields.vehicleNumber;
  delete document.extracted_fields.tdsAmount;
  delete document.extracted_fields.tds194qAmount;
  document.markdown = [
    "**Vehicle:** MH12AB1234",
    "| Less: TDS 194Q @ 0.10% | -1.00 |",
    "| Less: IGST TDS @ 2% | -20.00 |",
  ].join("\n");

  const result = prepare(document, { companyGstin: gujaratBuyerGstin });
  assert.equal(result.source.vehicleNumber, "MH12AB1234");
  assert.equal(result.source.invoiceTds194qAmount, "1.00");
  assert.equal(result.source.invoiceTds194qRate, "0.1");
  assert.equal(result.source.invoiceIgstTdsAmount, "20.00");
  assert.equal(result.source.invoiceGstTdsRate, "2");
  assert.ok(!result.blockers.some((blocker) => /INVOICE_EVIDENCE_REQUIRED$/.test(blocker.code)));
});

test("recovers one consistent vehicle number from linked packet documents", () => {
  const document = invoiceDocument();
  delete document.extracted_fields.vehicleNumber;
  const result = preparePurchasePosting({
    documents: [
      document,
      {
        id: "challan-1",
        document_type: "Delivery Challan",
        source_file_name: "packet.pdf",
        source_hint: "packet.pdf",
        title: "Delivery challan",
        extracted_fields: { vehicleNumber: "MH12AB1234" },
      },
      {
        id: "eway-1",
        document_type: "E-Way Bill",
        source_file_name: "packet.pdf",
        source_hint: "packet.pdf",
        title: "E-way bill",
        extracted_fields: { vehicleNumber: "MH12 AB 1234" },
      },
    ],
    masters: completeMasters,
    mappings: [],
    savedReview: { sourceReferenceApproved: true },
    caseStatus: "accepted",
    connectionReady: true,
    companyName: "Test Company",
    companyGstin: maharashtraBuyerGstin,
    sourceDocumentReference: "https://app.example/cases/case-1?sourceFileId=file-1",
    duplicateExists: false,
  });
  assert.equal(result.source.vehicleNumber, "MH12AB1234");
  assert.equal(result.review.vehicleNumber, "MH12AB1234");
});

test("an absent freight charge is not included in the Tally payload", () => {
  const result = prepare(invoiceDocument(), {
    savedReview: {
      sourceReferenceApproved: true,
      freightAmount: "100.00",
      freightGstRate: "18",
      freightLedgerName: "Transportation Inward @ 18.00%",
    },
  });
  assert.equal(result.review.freightAmount, "");
  assert.equal(result.tallyPayload.charges.some((entry) => entry.kind === "freight"), false);
  assert.equal(result.tallyPayload.withholdings.some((entry) => entry.kind === "transport_tds"), false);
});

test("round-off is invoice-driven and cannot be added only through the review", () => {
  const withoutEvidence = prepare(invoiceDocument(), {
    savedReview: {
      sourceReferenceApproved: true,
      roundOffAmount: "0.50",
      roundOffLedgerName: "Round Off",
    },
  });
  assert.equal(withoutEvidence.review.roundOffAmount, "");
  assert.equal(withoutEvidence.calculation.roundOffAmount, "0.00");
  assert.equal(withoutEvidence.tallyPayload.ledgers.roundOff, null);

  const document = invoiceDocument({ totalAmount: "1158.50" });
  document.extracted_fields.roundOffAmount = "-0.50";
  const withEvidence = prepare(document);
  assert.equal(withEvidence.review.roundOffAmount, "-0.50");
  assert.equal(withEvidence.calculation.totalDifference, "0.00");
  // Tally rounds only the final payable, which is already a whole rupee here.
  assert.equal(withEvidence.calculation.roundOffAmount, "0.00");
  assert.equal(withEvidence.tallyPayload.ledgers.roundOff, null);
});

test("freight is a separate charge, expands the GST basis, and has its own TDS", () => {
  const document = invoiceDocument({
    taxAmount: "198.00",
    totalAmount: "1276.00",
  });
  document.extracted_fields.freightAmount = "100.00";
  document.extracted_fields.freightGstRate = "18";
  document.extracted_fields.transportTdsAmount = "1.00";
  document.extracted_fields.transportTdsRate = "1";

  const result = prepare(document, { savedReview: { applyTransportTds: true } });
  assert.equal(result.review.freightLedgerName, "Transportation Inward @ 18.00%");
  assert.equal(result.calculation.gstTaxableAmount, "1100.00");
  assert.equal(result.calculation.gstAmount, "198.00");
  assert.equal(result.calculation.transportTdsAmount, "1.00");
  assert.equal(result.calculation.calculatedPayable, "1276.00");
  assert.ok(result.tallyPayload.charges.some((entry) => entry.kind === "freight"));
  assert.ok(result.tallyPayload.withholdings.some((entry) => entry.kind === "transport_tds"));
  assert.equal(result.blockers.length, 0);
});

test("72031000 uses the combined stock, O.M.S. purchase, IGST, and no scrap deduction", () => {
  const document = invoiceDocument({
    hsn: "72031000",
    buyerGstin: gujaratBuyerGstin,
    totalAmount: "1180.00",
    tdsAmount: "",
  });
  const result = prepare(document, { companyGstin: gujaratBuyerGstin });
  assert.equal(result.review.lines[0].stockItemName, "M S Scrap & Sponge Iron");
  assert.equal(result.review.lines[0].purchaseLedgerName, "O.M.S. Scrap Purchase");
  assert.equal(result.calculation.taxMode, "igst");
  assert.equal(result.calculation.igstAmount, "180.00");
  assert.equal(result.calculation.tdsAmount, "0.00");
  assert.equal(result.blockers.length, 0);
});

test("TCS is opt-in and changes the visible payable only when selected", () => {
  const document = invoiceDocument({ totalAmount: "1164.00" });
  const initial = prepare(document);
  assert.equal(initial.calculation.tcsAmount, "0.00");
  const selected = prepare(document, {
    savedReview: {
      ...initial.review,
      sourceReferenceApproved: true,
      tcsReceivable: true,
      tcsAmount: "5.00",
      tcsLedgerName: "TCS Receivable",
    },
  });
  assert.equal(selected.calculation.tcsAmount, "5.00");
  assert.equal(selected.calculation.calculatedPayable, "1164.00");
  assert.equal(selected.blockers.length, 0);
});

test("mixed-item invoices calculate reviewer-enabled 194Q on the confirmed voucher basis", () => {
  const document = invoiceDocument({
    totalAmount: "1169.00",
    tdsAmount: "1.00",
    lines: [
      { description: "MS Scrap", hsnSac: "72044900", quantity: "1", unit: "MT", rate: "500", taxableAmount: "500", taxAmount: "90" },
      { description: "Sponge Iron", hsnSac: "72031000", quantity: "1", unit: "MT", rate: "500", taxableAmount: "500", taxAmount: "90" },
    ],
  });
  document.extracted_fields.cgstTdsAmount = "5.00";
  document.extracted_fields.sgstTdsAmount = "5.00";
  const initial = prepare(document);
  const result = prepare(document, {
    savedReview: {
      ...initial.review,
      sourceReferenceApproved: true,
      tds194qRate: "0.1",
      lines: initial.review.lines,
    },
  });
  assert.equal(result.calculation.tds194qAmount, "1.00");
  assert.equal(result.calculation.cgstTdsAmount, "5.00");
  assert.equal(result.calculation.sgstTdsAmount, "5.00");
  assert.deepEqual(result.blockers, []);
});

test("optional deductions and their prompts are omitted when organization rules are off", () => {
  const document = invoiceDocument();
  document.extracted_fields.transportTdsAmount = "7.00";
  document.extracted_fields.cgstTdsAmount = "10.00";
  document.extracted_fields.sgstTdsAmount = "10.00";

  const result = prepare(document, {
    accountingSettings: {
      purchaseGoodsTdsEnabled: false,
      transporterTdsEnabled: false,
      gstTdsEnabled: false,
    },
  });

  assert.equal(result.calculation.tds194qAmount, "0.00");
  assert.equal(result.calculation.transportTdsAmount, "0.00");
  assert.equal(result.calculation.cgstTdsAmount, "0.00");
  assert.equal(result.calculation.sgstTdsAmount, "0.00");
  assert.deepEqual(result.tallyPayload.withholdings, []);
  assert.ok(!result.warnings.some((warning) => warning.code.includes("TDS_DISABLED")));
});

test("validation policy warns for unknown HSN while structural and duplicate checks block", () => {
  const unknown = prepare(invoiceDocument({ hsn: "99999999", totalAmount: "1180.00", tdsAmount: "" }));
  assert.ok(unknown.warnings.some((warning) =>
    warning.code === "HSN_MAPPING_REQUIRED" && warning.requiresAcknowledgement
  ));

  const strictUnknown = prepare(invoiceDocument({ hsn: "99999999", totalAmount: "1180.00", tdsAmount: "" }), {
    accountingSettings: {
      purchaseGoodsTdsEnabled: true,
      transporterTdsEnabled: true,
      gstTdsEnabled: true,
      validationPolicy: { hsnMissing: "block" },
    },
  });
  assert.ok(strictUnknown.blockers.some((blocker) => blocker.code === "HSN_MAPPING_REQUIRED"));

  const missingMaster = prepare(invoiceDocument(), { masters: [] });
  assert.ok(missingMaster.blockers.some((blocker) => blocker.code === "STOCK_ITEM_REQUIRED"));
  assert.ok(missingMaster.blockers.some((blocker) => blocker.code === "PURCHASE_LEDGER_REQUIRED"));

  const duplicate = prepare(invoiceDocument(), { duplicateExists: true });
  assert.ok(duplicate.blockers.some((blocker) => blocker.code === "DUPLICATE_INVOICE"));
});

test("duplicate copies of the same invoice are collapsed, distinct invoices are not", () => {
  const first = invoiceDocument();
  const copy = { ...invoiceDocument({ id: "invoice-copy" }), markdown: "more complete copy" };
  assert.equal(getCanonicalInvoiceDocuments([first, copy]).length, 1);
  const other = invoiceDocument({ id: "invoice-2" });
  other.extracted_fields = { ...other.extracted_fields, invoiceNumber: "INV-101" };
  assert.equal(getCanonicalInvoiceDocuments([first, other]).length, 2);
});

test("mother bills are identified and the one invoice billed to the active company is selected", () => {
  const intermediaryGstin = "27CCCCC0000C1Z5";
  const mother = invoiceDocument({ id: "mother" });
  mother.extracted_fields = {
    ...mother.extracted_fields,
    invoiceNumber: "AURA-001",
    vendorName: "Aura Supplier",
    supplierGstin,
    buyerName: "Ankit Intermediary",
    buyerGstin: intermediaryGstin,
  };
  const downstream = invoiceDocument({ id: "downstream" });
  downstream.extracted_fields = {
    ...downstream.extracted_fields,
    invoiceNumber: "ANKIT-001",
    vendorName: "Ankit Intermediary",
    supplierGstin: intermediaryGstin,
    buyerName: "Configured Buyer",
    buyerGstin: maharashtraBuyerGstin,
  };
  const candidates = getPurchaseInvoiceCandidates([mother, downstream], maharashtraBuyerGstin);
  assert.equal(candidates.find((candidate) => candidate.documentId === "mother").role, "mother_bill");
  assert.equal(candidates.find((candidate) => candidate.documentId === "downstream").recommended, true);

  const result = preparePurchasePosting({
    documents: [mother, downstream],
    masters: [
      ...completeMasters,
      master("ledger", "Ankit Intermediary", { gstin: intermediaryGstin }),
    ],
    savedReview: { sourceReferenceApproved: true },
    caseStatus: "accepted",
    connectionReady: true,
    companyName: "Configured Buyer",
    companyGstin: maharashtraBuyerGstin,
    sourceDocumentReference: "https://app.example/cases/mother-bill",
    accountingSettings: {
      purchaseGoodsTdsEnabled: true,
      transporterTdsEnabled: true,
      gstTdsEnabled: true,
    },
  });
  assert.equal(result.canonicalInvoiceCount, 2);
  assert.equal(result.source.documentId, "downstream");
  assert.equal(result.review.selectedInvoiceDocumentId, "downstream");
  assert.ok(!result.blockers.some((blocker) => blocker.code === "MULTIPLE_INVOICES"));
});

test("voucher-level 194Q toggle calculates 0.1% and rounds to the nearest rupee", () => {
  const document = invoiceDocument({
    hsn: "72031000",
    totalAmount: "472755.20",
    taxAmount: "72115.20",
    tdsAmount: "",
    lines: [{
      description: "Sponge Iron",
      hsnSac: "72031000",
      quantity: "12.52",
      unit: "MTS",
      rate: "32000",
      taxableAmount: "400640.00",
      taxAmount: "72115.20",
    }],
  });
  const result = prepare(document, {
    savedReview: {
      sourceReferenceApproved: true,
      applyTds194q: true,
      tds194qBasisAmount: "400640.00",
      tds194qRate: "0.1",
      tds194qRounding: "nearest_rupee",
    },
  });
  assert.equal(result.calculation.tds194qBasisAmount, "400640.00");
  assert.equal(result.calculation.tds194qAmount, "401.00");
  assert.equal(result.tallyPayload.withholdings.find((entry) => entry.kind === "tds_194q").amount, "401.00");
  assert.ok(result.warnings.some((warning) => warning.code === "TDS_194Q_USER_CONFIRMED"));
});

test("missing invoice lines recover only from one strongly linked supporting document", () => {
  const invoice = invoiceDocument();
  invoice.extracted_fields = { ...invoice.extracted_fields };
  delete invoice.extracted_fields.__lineItems;
  const eway = {
    id: "eway-1",
    document_type: "E-Way Bill",
    source_file_name: "packet.pdf",
    source_hint: "packet.pdf (page 2)",
    title: "E-Way Bill",
    extracted_fields: {
      referenceInvoiceNumber: "INV-100",
      supplierGstin,
      buyerGstin: maharashtraBuyerGstin,
      totalTaxableAmount: "1000.00",
      __lineItems: [{
        description: "MS Scrap",
        hsnSac: "72044900",
        quantity: "1",
        unit: "MT",
        rate: "1000.00",
        taxableAmount: "1000.00",
        taxAmount: "180.00",
      }],
    },
  };
  const result = preparePurchasePosting({
    documents: [invoice, eway],
    masters: completeMasters,
    mappings: [],
    savedReview: { sourceReferenceApproved: true, invoiceDate: "" },
    caseStatus: "accepted",
    connectionReady: true,
    masterDataReady: true,
    companyName: "Test Company",
    companyGstin: maharashtraBuyerGstin,
    sourceDocumentReference: "https://app.example/cases/case-1?sourceFileId=file-1",
  });
  assert.equal(result.source.lineRecovery, "linked_document");
  assert.equal(result.source.lineSourceDocumentId, "eway-1");
  assert.equal(result.review.lines.length, 1);
  assert.equal(result.review.lines[0].purchaseLedgerName, "M.S. Scrap Purchase");
  assert.ok(result.warnings.some((warning) => warning.code === "INVOICE_LINES_RECOVERED_FROM_LINKED_DOCUMENT"));
});

test("ambiguous supporting documents do not silently recover invoice lines", () => {
  const invoice = invoiceDocument();
  invoice.extracted_fields = { ...invoice.extracted_fields };
  delete invoice.extracted_fields.__lineItems;
  const linked = {
    id: "eway-1",
    document_type: "E-Way Bill",
    source_file_name: "packet.pdf",
    source_hint: "packet.pdf",
    title: "E-Way Bill",
    extracted_fields: {
      referenceInvoiceNumber: "INV-100",
      supplierGstin,
      totalTaxableAmount: "1000.00",
      __lineItems: [{
        description: "MS Scrap",
        hsnSac: "72044900",
        quantity: "1",
        unit: "MT",
        rate: "1000.00",
        taxableAmount: "1000.00",
      }],
    },
  };
  const result = preparePurchasePosting({
    documents: [invoice, linked, { ...linked, id: "delivery-1", document_type: "Delivery Challan" }],
    masters: completeMasters,
    mappings: [],
    savedReview: { sourceReferenceApproved: true, invoiceDate: "" },
    caseStatus: "accepted",
    connectionReady: true,
    masterDataReady: true,
    companyName: "Test Company",
    companyGstin: maharashtraBuyerGstin,
    sourceDocumentReference: "https://app.example/cases/case-1?sourceFileId=file-1",
  });
  assert.equal(result.source.lineRecovery, "invoice");
  assert.equal(result.review.lines.length, 0);
  assert.ok(result.blockers.some((blocker) => blocker.code === "LINE_ITEMS_REQUIRED"));
});

test("new live masters fill previously blank saved master selections", () => {
  const result = prepare(invoiceDocument(), {
    savedReview: {
      sourceReferenceApproved: true,
      supplierLedgerName: "",
      cgstLedgerName: "",
      sgstLedgerName: "",
      tds194qLedgerName: "",
    },
  });
  assert.equal(result.review.supplierLedgerName, "Scrap Supplier");
  assert.equal(result.review.cgstLedgerName, "Input ITC CGST 9%");
  assert.equal(result.review.sgstLedgerName, "Input ITC SGST 9%");
  assert.equal(result.review.tds194qLedgerName, "TDS Payable @ 0.10% (194Q)");
});

test("classification copies of one physical ledger do not block automatic selection", () => {
  const duplicatedMasters = [
    ...completeMasters,
    master("ledger", "Input ITC CGST 9%"),
    master("tax_ledger", "Input ITC CGST 9%"),
    master("ledger", "Input ITC SGST 9%"),
    master("tax_ledger", "Input ITC SGST 9%"),
    master("ledger", "TDS Payable @ 0.10% (194Q)"),
    master("gst_ledger", "TDS Payable @ 0.10% (194Q)"),
  ];

  const result = prepare(invoiceDocument(), {
    masters: duplicatedMasters,
    savedReview: {
      sourceReferenceApproved: true,
      cgstLedgerName: "",
      sgstLedgerName: "",
      tds194qLedgerName: "",
    },
  });

  assert.equal(result.review.cgstLedgerName, "Input ITC CGST 9%");
  assert.equal(result.review.sgstLedgerName, "Input ITC SGST 9%");
  assert.equal(result.review.tds194qLedgerName, "TDS Payable @ 0.10% (194Q)");
  assert.ok(!result.blockers.some((blocker) =>
    ["CGST_LEDGER_REQUIRED", "SGST_LEDGER_REQUIRED", "TDS_194Q_LEDGER_REQUIRED"].includes(blocker.code)
  ));
});

test("review persistence keeps only user changes and reconstructs the full review", () => {
  const document = invoiceDocument();
  const defaults = prepare(document, { savedReview: {} });
  const reviewed = {
    ...defaults.review,
    narration: "User-approved purchase narration.",
    sourceReferenceApproved: true,
    lines: defaults.review.lines.map((line, index) =>
      index === 0 ? { ...line, rate: "123.45" } : line
    ),
  };

  const patch = compactPurchasePostingReview(defaults.review, reviewed);
  assert.deepEqual(Object.keys(patch).sort(), ["lines", "narration"]);
  assert.deepEqual(patch.lines, [{ lineId: reviewed.lines[0].lineId, rate: "123.45" }]);

  const reconstructed = prepare(document, { savedReview: patch });
  assert.deepEqual(reconstructed.review, reviewed);
});

test("generic TDS evidence is not misclassified as Section 194Q", () => {
  const document = invoiceDocument({
    totalAmount: "1170.00",
    tdsAmount: "",
  });
  delete document.extracted_fields.documentDate;
  document.markdown = [
    "TAX INVOICE",
    "Invoice No: INV-100",
    "Date: 27.07.2026",
    "TDS base: INR 1,000.00",
    "TDS on MS Scrap basic @ 1% -10.00",
  ].join("\n");
  const result = prepare(document, { savedReview: { sourceReferenceApproved: true } });
  assert.equal(result.review.invoiceDate, "2026-07-27");
  assert.equal(result.review.tds194qRate, "0.1");
  assert.equal(result.source.invoiceTdsAmount, "10.00");
  assert.equal(result.source.invoiceTds194qAmount, "");
  assert.equal(result.review.applyTds194q, false);
  assert.equal(result.calculation.tds194qAmount, "0.00");
  assert.ok(!result.blockers.some((blocker) => blocker.code === "INVOICE_DATE_REQUIRED"));
});

test("Tally-style Dated label beside Invoice No recovers a named-month invoice date", () => {
  const document = invoiceDocument();
  delete document.extracted_fields.documentDate;
  document.markdown = [
    "TAX INVOICE",
    "Invoice No.",
    "SSTC-26/27-182",
    "e-Way Bill No.",
    "202263373954",
    "Dated",
    "11-Aug-26",
  ].join("\n");

  const result = prepare(document, { savedReview: { sourceReferenceApproved: true } });

  assert.equal(result.source.invoiceDate, "2026-08-11");
  assert.equal(result.review.invoiceDate, "2026-08-11");
  assert.ok(!result.blockers.some((blocker) => blocker.code === "INVOICE_DATE_REQUIRED"));
});

test("manually supplied day-first review dates are normalized before validation", () => {
  const result = prepare(invoiceDocument(), {
    savedReview: {
      sourceReferenceApproved: true,
      invoiceDate: "11-08-2026",
      voucherDate: "17/08/2026",
    },
  });

  assert.equal(result.review.invoiceDate, "2026-08-11");
  assert.equal(result.review.voucherDate, "2026-08-17");
  assert.ok(!result.blockers.some((blocker) => blocker.code === "INVOICE_DATE_REQUIRED"));
  assert.ok(!result.blockers.some((blocker) => blocker.code === "VOUCHER_DATE_REQUIRED"));
});

test("linked E-Way Bill supplies one unambiguous missing invoice date", () => {
  const invoice = invoiceDocument();
  delete invoice.extracted_fields.documentDate;
  invoice.markdown = "TAX INVOICE\\nInvoice No: INV-100";
  const eway = {
    id: "eway-date",
    document_type: "E-Way Bill",
    source_file_name: "packet.pdf",
    source_hint: "packet.pdf (page 5)",
    title: "E-Way Bill",
    extracted_fields: {
      referenceInvoiceNumber: "INV-100",
      documentDate: "20-07-2026 08:57 PM",
    },
  };
  const result = preparePurchasePosting({
    documents: [invoice, eway],
    masters: completeMasters,
    mappings: [],
    savedReview: { sourceReferenceApproved: true },
    caseStatus: "accepted",
    connectionReady: true,
    masterDataReady: true,
    companyName: "Test Company",
    companyGstin: maharashtraBuyerGstin,
    sourceDocumentReference: "https://app.example/cases/case-1?sourceFileId=file-1",
  });
  assert.equal(result.review.invoiceDate, "2026-07-20");
  assert.ok(!result.blockers.some((blocker) => blocker.code === "INVOICE_DATE_REQUIRED"));
});

test("linked E-Way date enables automatic intrastate GST TDS for qualifying scrap", () => {
  const invoice = invoiceDocument({
    totalAmount: "492979.60",
    taxAmount: "75200.40",
    tdsAmount: "",
    lines: [{
      description: "MS SCRAP",
      hsnSac: "72044900",
      quantity: "12.66",
      unit: "MT",
      rate: "33000.00",
      taxableAmount: "417780.00",
      taxAmount: "75200.40",
    }],
  });
  delete invoice.extracted_fields.documentDate;
  delete invoice.extracted_fields.cgstTdsAmount;
  delete invoice.extracted_fields.sgstTdsAmount;
  const eway = {
    id: "eway-surya-date",
    document_type: "E-Way Bill",
    source_file_name: "packet.pdf",
    source_hint: "packet.pdf (page 5)",
    title: "E-Way Bill",
    extracted_fields: {
      referenceInvoiceNumber: "INV-100",
      documentDate: "11/08/2026 08:57 PM",
    },
  };

  const result = preparePurchasePosting({
    documents: [invoice, eway],
    masters: completeMasters,
    mappings: [],
    savedReview: { sourceReferenceApproved: true },
    caseStatus: "accepted",
    connectionReady: true,
    masterDataReady: true,
    companyName: "Test Company",
    companyGstin: maharashtraBuyerGstin,
    sourceDocumentReference: "https://app.example/cases/case-1?sourceFileId=file-1",
    accountingSettings: {
      purchaseGoodsTdsEnabled: true,
      transporterTdsEnabled: false,
      gstTdsEnabled: true,
    },
  });

  assert.equal(result.review.invoiceDate, "2026-08-11");
  assert.equal(result.calculation.scrapGstTdsEligible, true);
  assert.equal(result.calculation.gstTdsAutomatic, true);
  assert.equal(result.calculation.cgstTdsAmount, "4177.80");
  assert.equal(result.calculation.sgstTdsAmount, "4177.80");
  assert.deepEqual(
    result.tallyPayload.withholdings
      .filter((entry) => entry.kind === "cgst_tds" || entry.kind === "sgst_tds")
      .map((entry) => [entry.kind, entry.amount]),
    [["cgst_tds", "4177.80"], ["sgst_tds", "4177.80"]]
  );
});

test("supplier invoice total stays separate from the post-TDS payable", () => {
  const document = invoiceDocument({
    totalAmount: "492980.00",
    taxAmount: "75200.40",
    tdsAmount: "",
    lines: [{
      description: "MS SCRAP",
      hsnSac: "72044900",
      quantity: "12.66",
      unit: "MT",
      rate: "33000.00",
      taxableAmount: "417780.00",
      taxAmount: "75200.40",
    }],
  });
  document.extracted_fields.documentDate = "2026-08-11";
  document.extracted_fields.roundOffAmount = "-0.40";
  delete document.extracted_fields.cgstTdsAmount;
  delete document.extracted_fields.sgstTdsAmount;

  const result = prepare(document, {
    savedReview: {
      sourceReferenceApproved: true,
      applyTds194q: true,
      tds194qRate: "0.1",
      tds194qRounding: "nearest_rupee",
    },
  });

  // Supplier rounds before TDS (-0.40); Tally rounds the post-TDS payable
  // 4,84,206.80 to 4,84,207.00, like the client's manual vouchers.
  assert.equal(result.calculation.roundOffAmount, "0.20");
  assert.equal(result.calculation.calculatedInvoiceTotal, "492980.00");
  assert.equal(result.calculation.totalWithholdingAmount, "8773.60");
  assert.equal(result.calculation.calculatedPayable, "484207.00");
  assert.deepEqual(result.tallyPayload.ledgers.roundOff, { name: "Round Off", amount: "0.20" });
  assert.equal(result.calculation.totalDifference, "0.00");
});

test("printed GST, 194Q, and GST TDS reconcile as separate deductions", () => {
  const document = invoiceDocument({
    totalAmount: "289750.00",
    taxAmount: "",
    tdsAmount: "",
    lines: [{
      description: "MS Scrap",
      hsnSac: "72044900",
      quantity: "10",
      unit: "MT",
      rate: "25000.00",
      taxableAmount: "250000.00",
      taxAmount: "",
    }],
  });
  delete document.extracted_fields.documentDate;
  delete document.extracted_fields.cgstTdsAmount;
  delete document.extracted_fields.sgstTdsAmount;
  document.markdown = [
    "INVOICE DATE 28/07/2026",
    "CGST 9% INR 22,500.00",
    "SGST 9% INR 22,500.00",
    "Invoice value INR 295,000.00",
    "TDS Payable @ 0.10% (194Q) INR 250.00",
    "CGST TDS PAYABLE 1% INR 2,500.00",
    "SGST TDS PAYABLE 1% INR 2,500.00",
    "Net amount payable INR 289,750.00",
  ].join("\n");

  const result = prepare(document, {
    savedReview: {
      sourceReferenceApproved: true,
      applyTds194q: true,
      tds194qBasisAmount: "250000.00",
      tds194qRate: "0.1",
      tds194qRounding: "paise",
    },
  });

  assert.equal(result.source.invoiceTaxAmount, "45000");
  assert.equal(result.source.invoiceTds194qAmount, "250.00");
  assert.equal(result.review.tds194qRate, "0.1");
  assert.equal(result.review.cgstLedgerName, "Input ITC CGST 9%");
  assert.equal(result.review.sgstLedgerName, "Input ITC SGST 9%");
  assert.equal(result.review.tds194qLedgerName, "TDS Payable @ 0.10% (194Q)");
  assert.equal(result.calculation.gstAmount, "45000.00");
  assert.equal(result.calculation.tds194qAmount, "250.00");
  assert.equal(result.calculation.cgstTdsAmount, "2500.00");
  assert.equal(result.calculation.sgstTdsAmount, "2500.00");
  assert.equal(result.calculation.calculatedPayable, "289750.00");
  assert.equal(result.calculation.gstDifference, "0.00");
  assert.equal(result.calculation.totalDifference, "0.00");
});

test("line arithmetic and supplier identity block while stock HSN follows warning policy", () => {
  const document = invoiceDocument();
  const initial = prepare(document);
  const mismatchedMasters = completeMasters.map((item) => {
    if (item.tally_name === "Scrap Supplier") return { ...item, gstin: "27CCCCC0000C1Z5" };
    if (item.tally_name === "M S Scrap & Sponge Iron") return { ...item, hsn_code: "72031000" };
    return item;
  });
  const result = prepare(document, {
    masters: mismatchedMasters,
    savedReview: {
      ...initial.review,
      sourceReferenceApproved: true,
      lines: initial.review.lines.map((line) => ({ ...line, taxableAmount: "998.00" })),
    },
  });
  assert.ok(result.blockers.some((blocker) => blocker.code === "SUPPLIER_LEDGER_GSTIN_MISMATCH"));
  assert.ok(result.warnings.some((warning) =>
    warning.code === "STOCK_ITEM_HSN_MISMATCH" && warning.requiresAcknowledgement
  ));
  assert.ok(result.blockers.some((blocker) => blocker.code === "LINE_TAXABLE_MISMATCH"));
});

test("output GST ledgers cannot be used for a purchase voucher", () => {
  const outputMasters = completeMasters.map((item) => {
    if (item.tally_name === "Input ITC CGST 9%") return { ...item, tally_name: "Output CGST 9%" };
    if (item.tally_name === "Input ITC SGST 9%") return { ...item, tally_name: "Output SGST 9%" };
    return item;
  });
  const result = prepare(invoiceDocument(), {
    masters: outputMasters,
    savedReview: { sourceReferenceApproved: true },
  });
  assert.ok(result.blockers.some((blocker) => blocker.code === "CGST_LEDGER_REQUIRED"));
  assert.ok(result.blockers.some((blocker) => blocker.code === "SGST_LEDGER_REQUIRED"));
});

test("a transportation row is booked once as freight with transport TDS on it", () => {
  const document = invoiceDocument({
    totalAmount: "1416.00",
    taxAmount: "216.00",
    tdsAmount: "",
    lines: [
      { description: "MS Scrap", hsnSac: "72044900", quantity: "1", unit: "MT", rate: "1000.00", taxableAmount: "1000.00" },
      { description: "TRANSPORTATION CHARGES", taxableAmount: "200.00" },
    ],
  });
  document.extracted_fields.cgstTdsAmount = "";
  document.extracted_fields.sgstTdsAmount = "";

  const result = prepare(document, { savedReview: { sourceReferenceApproved: true, applyGstTds: false } });

  assert.equal(result.review.lines.length, 1);
  assert.equal(result.review.freightAmount, "200.00");
  assert.equal(result.review.applyTransportTds, true);
  assert.equal(result.calculation.gstAmount, "216.00");
  // Test supplier PAN AAAAA0000A is not an individual or HUF, so 2%.
  assert.equal(result.review.transportTdsRate, "2");
  assert.equal(result.calculation.transportTdsAmount, "4.00");
  assert.equal(result.calculation.transportTdsDifference, "0.00");
  for (const code of ["STOCK_ITEM_REQUIRED", "LINE_ACCOUNTING_FIELDS_REQUIRED", "GST_MISMATCH", "TOTAL_MISMATCH"]) {
    assert.equal(result.blockers.some((blocker) => blocker.code === code), false, code);
  }
});

test("a wrong transport TDS ledger is named and the right one is suggested", () => {
  const document = invoiceDocument({
    totalAmount: "1416.00",
    taxAmount: "216.00",
    tdsAmount: "",
    lines: [
      { description: "MS Scrap", hsnSac: "72044900", quantity: "1", unit: "MT", rate: "1000.00", taxableAmount: "1000.00" },
      { description: "TRANSPORTATION CHARGES", taxableAmount: "200.00" },
    ],
  });
  document.extracted_fields.cgstTdsAmount = "";
  document.extracted_fields.sgstTdsAmount = "";

  const result = prepare(document, {
    savedReview: { sourceReferenceApproved: true, applyGstTds: false, transportTdsLedgerName: "Transportation Inward @ 18.00%" },
  });
  const blocker = result.blockers.find((item) => item.code === "TRANSPORT_TDS_LEDGER_REQUIRED");
  assert.ok(blocker);
  assert.match(blocker.message, /Transportation Inward @ 18\.00% is not a goods-transport TDS ledger/);
  assert.equal(blocker.suggestion, "Tds on Goods Transport");
});

test("transport TDS rate follows the payee type in the GSTIN's PAN", () => {
  assert.equal(transportTdsRateForPayee("27ABMPS1459G1ZA"), "1"); // P: individual (Bhawana)
  assert.equal(transportTdsRateForPayee("27AAAHK1234A1Z5"), "1"); // H: HUF
  assert.equal(transportTdsRateForPayee("27AACCK1502A1ZD"), "2"); // C: company
  assert.equal(transportTdsRateForPayee("27AAAFA1234A1Z5"), "2"); // F: firm
  assert.equal(transportTdsRateForPayee(""), "1");
});

test("the case's e-way bill page is read for the voucher and only sent when valid", () => {
  const invoice = invoiceDocument();
  const eway = {
    id: "eway-1", document_type: "E-Way Bill", source_file_name: "invoice.pdf", source_hint: "invoice.pdf", title: "E-Way Bill",
    extracted_fields: {
      eWayBillNumber: "2622 6409 7358", referenceInvoiceNumber: "INV-100", documentDate: "12/08/2026 07:13 PM",
      vehicleNumber: "MH21X7266",
      dispatchFrom: "PLOT NO 22, MIDC AREA HINGNA ROAD, NAGPUR, NAGPUR,MAHARASHTRA-440016",
      shipTo: "C-7&8 ADDITIONAL MIDC AREA, JALNA, JALNA,MAHARASHTRA-431203",
    },
    markdown: "eWay Bill No: 2622 6409 7358\nMode: Road\nApprox Distance: 437km",
  };
  const run = (savedReview) => preparePurchasePosting({
    documents: [invoice, eway], masters: completeMasters, mappings: [], savedReview,
    caseStatus: "accepted", connectionReady: true, companyName: "Test Company",
    companyGstin: invoice.extracted_fields.buyerGstin, sourceDocumentReference: "https://app.example/x",
    duplicateExists: false, accountingSettings: { purchaseGoodsTdsEnabled: true, transporterTdsEnabled: true, gstTdsEnabled: true },
  });

  const result = run({ sourceReferenceApproved: true });
  assert.deepEqual(
    { ...result.review.ewayBill, fromAddress: undefined },
    { record: true, number: "262264097358", date: "2026-08-12", fromAddress: undefined, fromPlace: "NAGPUR", fromPincode: "440016",
      fromState: "Maharashtra", toPlace: "JALNA", toPincode: "431203", toState: "Maharashtra", transportMode: "1 - Road",
      vehicleNumber: "MH21X7266", distanceKm: "437" }
  );
  assert.equal(result.tallyPayload.ewayBill.number, "262264097358");

  const invalid = run({ sourceReferenceApproved: true, ewayBill: { number: "12345" } });
  assert.equal(invalid.tallyPayload.ewayBill, undefined);
  assert.ok(invalid.warnings.some((warning) => warning.code === "EWAY_BILL_NUMBER_INVALID"));

  const off = run({ sourceReferenceApproved: true, ewayBill: { record: false } });
  assert.equal(off.tallyPayload.ewayBill, undefined);
});

test("a missing godown blocks with a suggestion only when the company has several godowns", () => {
  const document = invoiceDocument({
    totalAmount: "2360.00",
    taxAmount: "360.00",
    tdsAmount: "",
    lines: [
      { description: "MS Scrap", hsnSac: "72044900", quantity: "1", unit: "MT", rate: "1000.00", taxableAmount: "1000.00" },
      { description: "Waste and Scrap", hsnSac: "72045000", quantity: "1", unit: "MT", rate: "1000.00", taxableAmount: "1000.00" },
    ],
  });
  document.extracted_fields.cgstTdsAmount = "";
  document.extracted_fields.sgstTdsAmount = "";
  const firstLineId = `${document.id}:1`;
  const saved = { sourceReferenceApproved: true, applyGstTds: false, lines: [{ lineId: firstLineId, godownName: "Main Location" }] };

  const several = prepare(document, { savedReview: saved, masters: [...completeMasters, master("godown", "Main Location"), master("godown", "Factory")] });
  const blockers = several.blockers.filter((blocker) => blocker.code === "GODOWN_REQUIRED");
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].lineId, `${document.id}:2`);
  assert.equal(blockers[0].suggestion, "Main Location");

  const single = prepare(document, { savedReview: saved, masters: [...completeMasters, master("godown", "Main Location")] });
  assert.equal(single.blockers.some((blocker) => blocker.code === "GODOWN_REQUIRED"), false);
});
