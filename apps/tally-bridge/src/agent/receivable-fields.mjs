// Customer dues as fields instead of Tally XML.
//
// Bills and vouchers are read into plain fields once, when they are stored,
// so Cash Discount, Payment Follow-ups and bank matching never parse XML.
// The helpers in the first part are copied verbatim from bridge.mjs, so each
// field holds exactly what the XML-based calculation reads; the tests compare
// both calculations on the same records.

function decodeXmlEntities(value) {
  let decoded = String(value ?? "");
  for (let index = 0; index < 3; index += 1) {
    const next = decoded
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
        const parsed = Number.parseInt(code, 16);
        return Number.isFinite(parsed) && parsed >= 32 ? String.fromCodePoint(parsed) : " ";
      })
      .replace(/&#(\d+);/g, (_, code) => {
        const parsed = Number.parseInt(code, 10);
        return Number.isFinite(parsed) && parsed >= 32 ? String.fromCodePoint(parsed) : " ";
      })
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'");
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function cleanXmlText(value) {
  return decodeXmlEntities(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTagText(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? cleanXmlText(match[1]) : null;
}

function getAttribute(block, attributeName) {
  const match = block.match(new RegExp(`\\b${attributeName}\\s*=\\s*"([^"]*)"`, "i"));
  return match ? cleanXmlText(match[1]) : null;
}

function extractBlocks(xml, tagName) {
  const blocks = [];
  const regex = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi");
  let match = regex.exec(xml);

  while (match) {
    blocks.push(match[0]);
    match = regex.exec(xml);
  }

  return blocks;
}

function parseTallyAmount(value) {
  const cleaned = String(value ?? "")
    .replace(/,/g, "")
    .replace(/\s*(Dr|Cr)$/i, "")
    .trim();
  if (!cleaned) return null;
  const negative = cleaned.startsWith("-") || /^\(.*\)$/.test(cleaned);
  const normalized = cleaned.replace(/[()]/g, "").replace(/^-/, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function parseTallyDate(value) {
  const raw = String(value ?? "").trim();
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return raw || null;
}

function billReferenceType(block) {
  return (
    getTagText(block, "BILLTYPE") ||
    getTagText(block, "TYPEOFREF") ||
    getTagText(block, "REFERENCE_TYPE") ||
    ""
  ).trim();
}

function billLedgerName(block) {
  return (
    getTagText(block, "LEDGERNAME") ||
    getTagText(block, "PARTYLEDGERNAME") ||
    getTagText(block, "PARENT") ||
    getTagText(block, "LEDGER") ||
    ""
  ).trim();
}

function normalizeLooseName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function emptyOpenBillBucket(ledgerName) {
  return {
    ledgerName,
    openBills: [],
    existingAdvances: [],
    rawCount: 0,
  };
}

function classifyOpenBillReferenceKind({
  billType,
  sourceVoucherType,
  referenceName,
  knownInvoice = false,
  knownAdvance = false,
} = {}) {
  const type = String(billType || "").toLowerCase();
  if (type.includes("advance")) return "advance";
  if (knownInvoice) return "bill";
  if (knownAdvance) return "advance";

  // Some Tally Bill collection exports omit BillType for receipt advances.
  // ADV-prefixed references are a controlled fallback only when no Sales
  // invoice with that reference was found.
  const looksLikeAdvanceReference = /^(?:adv|advance)(?:[-/\s]|\d)/i.test(String(referenceName || "").trim());
  if (looksLikeAdvanceReference && (/receipt/i.test(String(sourceVoucherType || "")) || !sourceVoucherType)) {
    return "advance";
  }
  return "bill";
}

function openBillNarrationKey(ledgerName, referenceName) {
  return `${normalizeLooseName(ledgerName)}|${normalizeLooseName(referenceName)}`;
}

function voucherBillAllocations(entryBlock) {
  return extractBlocks(entryBlock, "BILLALLOCATIONS.LIST")
    .map((allocation) => {
      const referenceName = getTagText(allocation, "NAME");
      const amount = Math.abs(parseTallyAmount(getTagText(allocation, "AMOUNT")) ?? 0);
      return {
        referenceName,
        billType: getTagText(allocation, "BILLTYPE") || getTagText(allocation, "TYPEOFREF") || null,
        amount,
      };
    })
    .filter((allocation) => allocation.referenceName && allocation.amount > 0);
}

function voucherLedgerEntries(block) {
  return extractBlocks(block, "ALLLEDGERENTRIES.LIST")
    .map((entry) => {
      const rawAmount = parseTallyAmount(getTagText(entry, "AMOUNT")) ?? 0;
      const isDeemedPositive = /^yes$/i.test(getTagText(entry, "ISDEEMEDPOSITIVE"));
      return {
        ledgerName: getTagText(entry, "LEDGERNAME"),
        amount: Math.abs(rawAmount),
        // Tally marks debit entries as deemed-positive. The amount sign is a
        // useful fallback for companies whose export omits that flag.
        isDebit: isDeemedPositive || rawAmount < 0,
        billAllocations: voucherBillAllocations(entry),
      };
    })
    .filter((entry) => entry.ledgerName && entry.amount > 0);
}

function isLikelyTaxLedgerName(ledgerName) {
  return /(?:^|\s)(?:gst|cgst|sgst|igst|utgst|cess|tax)(?:\s|$)/i.test(String(ledgerName || ""));
}

// ---- Fields ----------------------------------------------------------------
// Everything below reads a record once, with the helpers above, into plain
// fields; the calculation then never touches XML again.

// One open bill (Tally <BILL>).
export function billFields(xml) {
  const text = (tag) => getTagText(xml, tag);
  return {
    ref: getAttribute(xml, "NAME") || text("NAME") || text("BILLREF"),
    ledger: billLedgerName(xml),
    billType: billReferenceType(xml),
    isAdvance: /^yes$/i.test(text("ISADVANCE")),
    closing: parseTallyAmount(text("CLOSINGBALANCE")),
    balance: parseTallyAmount(text("BALANCE")),
    pending: parseTallyAmount(text("PENDINGAMOUNT")),
    amount: parseTallyAmount(text("AMOUNT")),
    opening: parseTallyAmount(text("OPENINGBALANCE")),
    voucherType: text("VOUCHERTYPENAME") || text("VOUCHERTYPE") || null,
    voucherNumber: text("VOUCHERNUMBER"),
    date: parseTallyDate(text("DATE") || text("BILLDATE")),
    billDate: parseTallyDate(text("BILLDATE")),
    dueDate: parseTallyDate(text("DUEDATE")),
  };
}

// One invoice, receipt or other voucher touching a customer (Tally <VOUCHER>).
export function voucherFields(xml) {
  const text = (tag) => getTagText(xml, tag);
  return {
    type: text("VOUCHERTYPENAME") || getAttribute(xml, "VCHTYPE") || "",
    date: text("DATE"),
    effectiveDate: text("EFFECTIVEDATE"),
    number: text("VOUCHERNUMBER"),
    reference: text("REFERENCE"),
    narration: text("NARRATION"),
    party: text("PARTYLEDGERNAME"),
    masterId: text("MASTERID"),
    alterId: text("ALTERID"),
    guid: text("GUID"),
    cancelled: /^yes$/i.test(text("ISCANCELLED")),
    optional: /^yes$/i.test(text("ISOPTIONAL")),
    // Every ledger and bill-allocation name on the voucher, as the invoice
    // matching reads them (including zero-amount lines).
    entryLedgers: extractBlocks(xml, "ALLLEDGERENTRIES.LIST").map((entry) => getTagText(entry, "LEDGERNAME")).filter(Boolean),
    allocationNames: extractBlocks(xml, "BILLALLOCATIONS.LIST").map((allocation) => getTagText(allocation, "NAME")).filter(Boolean),
    // Ledger lines with amount, debit/credit and bill allocations.
    entries: voucherLedgerEntries(xml),
  };
}

// toOpenBill on fields.
export function openBillFromFields(bill, ledgerName, evidence = {}) {
  const referenceName = bill.ref;
  if (!referenceName) return null;
  if (bill.ledger && normalizeLooseName(bill.ledger) !== normalizeLooseName(ledgerName)) return null;
  const closing = bill.closing ?? bill.balance ?? bill.pending ?? bill.amount;
  const pendingAmount = Math.abs(closing ?? 0);
  if (pendingAmount <= 0) return null;
  const sourceVoucherType = bill.voucherType;
  const kind = classifyOpenBillReferenceKind({
    billType: bill.isAdvance ? "Advance" : bill.billType,
    sourceVoucherType,
    referenceName,
    knownInvoice: evidence.knownInvoice === true,
    knownAdvance: evidence.knownAdvance === true,
  });
  const common = {
    referenceName,
    voucherNumber: bill.voucherNumber || referenceName,
    invoiceDate: bill.date,
    dueDate: bill.dueDate,
    originalAmount: Math.abs(bill.opening ?? pendingAmount),
    settledAmount: null,
    pendingAmount,
    sourceVoucherType,
    status: "open",
  };
  if (kind === "advance") {
    return { kind: "advance", referenceName, receiptDate: common.invoiceDate, pendingAdvanceAmount: pendingAmount, status: "unadjusted" };
  }
  return { kind: "bill", ...common };
}

function isPartyInvoiceType(type) {
  const value = String(type || "").toLowerCase();
  return /sales|purchase|invoice/.test(value) && !/debit|credit|receipt|payment/.test(value);
}
function isPartySettlementType(type) {
  return /receipt|payment/.test(String(type || "").toLowerCase());
}

// indexInvoiceNarrations on fields.
function indexInvoiceEvidence(vouchers, requestedLedgerByKey) {
  const narrationByBill = new Map();
  const invoiceReferencesByLedger = new Map();
  const invoiceReferenceKeys = new Set();
  const advanceReferenceKeys = new Set();
  const salesLedgerByBill = new Map();

  for (const voucher of vouchers) {
    if (!isPartyInvoiceType(voucher.type)) continue;
    const ledgerNames = [voucher.party, ...voucher.entryLedgers].filter(Boolean);
    const billReferences = [voucher.number, voucher.reference, ...voucher.allocationNames].filter(Boolean);
    for (const ledgerName of ledgerNames) {
      const requestedLedgerName = requestedLedgerByKey.get(normalizeLooseName(ledgerName));
      if (!requestedLedgerName) continue;
      // salesLedgerFromInvoiceVoucher: first non-tax credit line of another ledger.
      const salesLedgerName = voucher.entries
        .filter((entry) => normalizeLooseName(entry.ledgerName) !== normalizeLooseName(requestedLedgerName))
        .find((entry) => !entry.isDebit && !isLikelyTaxLedgerName(entry.ledgerName))?.ledgerName || null;
      for (const billReference of billReferences) {
        const key = openBillNarrationKey(requestedLedgerName, billReference);
        invoiceReferenceKeys.add(key);
        if (voucher.narration) narrationByBill.set(key, voucher.narration);
        if (salesLedgerName) salesLedgerByBill.set(key, salesLedgerName);
        const references = invoiceReferencesByLedger.get(requestedLedgerName) || new Set();
        references.add(billReference);
        invoiceReferencesByLedger.set(requestedLedgerName, references);
      }
    }
  }

  // A receipt's bill allocation is the strongest evidence that a payment was
  // applied to a particular invoice.
  const receiptEvidenceByBill = new Map();
  for (const voucher of vouchers) {
    if (!isPartySettlementType(voucher.type)) continue;
    const receiptDate = parseTallyDate(voucher.effectiveDate || voucher.date);
    if (!receiptDate) continue;
    const normalizedVoucherText = normalizeLooseName([voucher.number, voucher.reference, voucher.narration].join(" "));
    for (const entry of voucher.entries) {
      const requestedLedgerName = requestedLedgerByKey.get(normalizeLooseName(entry.ledgerName));
      if (!requestedLedgerName) continue;
      const references = invoiceReferencesByLedger.get(requestedLedgerName) || new Set();
      const referenceByKey = new Map([...references].map((reference) => [normalizeLooseName(reference), reference]));
      let matchedAllocation = false;
      for (const allocation of entry.billAllocations) {
        const allocationKey = openBillNarrationKey(requestedLedgerName, allocation.referenceName);
        const allocationLooksLikeAdvance =
          /advance/i.test(String(allocation.billType || "")) ||
          (/^(?:adv|advance)(?:[-/\s]|\d)/i.test(allocation.referenceName) && !invoiceReferenceKeys.has(allocationKey));
        if (allocationLooksLikeAdvance) advanceReferenceKeys.add(allocationKey);
        const invoiceReference = referenceByKey.get(normalizeLooseName(allocation.referenceName));
        if (!invoiceReference) continue;
        const key = openBillNarrationKey(requestedLedgerName, invoiceReference);
        const existing = receiptEvidenceByBill.get(key);
        receiptEvidenceByBill.set(key, {
          lastReceiptDate: !existing || receiptDate > existing.lastReceiptDate ? receiptDate : existing.lastReceiptDate,
          matchedReceiptAmount: (existing?.matchedReceiptAmount || 0) + allocation.amount,
        });
        matchedAllocation = true;
      }
      // Older Tally versions can omit allocation blocks; explicit reference
      // text is the fallback for that case only.
      if (matchedAllocation) continue;
      for (const invoiceReference of references) {
        const normalizedReference = normalizeLooseName(invoiceReference);
        if (normalizedReference.length < 8 || !normalizedVoucherText.includes(normalizedReference)) continue;
        const key = openBillNarrationKey(requestedLedgerName, invoiceReference);
        const existing = receiptEvidenceByBill.get(key);
        receiptEvidenceByBill.set(key, {
          lastReceiptDate: !existing || receiptDate > existing.lastReceiptDate ? receiptDate : existing.lastReceiptDate,
          matchedReceiptAmount: (existing?.matchedReceiptAmount || 0) + entry.amount,
        });
      }
    }
  }
  return { narrationByBill, receiptEvidenceByBill, salesLedgerByBill, invoiceReferenceKeys, advanceReferenceKeys };
}

// Open bills and advances per customer: the same byLedger result the XML
// calculation (fetchCustomerOpenBillsFromTally) builds, from fields.
export function openBillsByLedgerFromFields(ledgerNames, bills, vouchers) {
  const requestedLedgerByKey = new Map(ledgerNames.map((ledgerName) => [normalizeLooseName(ledgerName), ledgerName]));
  const evidence = indexInvoiceEvidence(vouchers, requestedLedgerByKey);
  const byLedger = Object.fromEntries(ledgerNames.map((ledgerName) => [ledgerName, emptyOpenBillBucket(ledgerName)]));
  let billCount = 0;
  for (const bill of bills) {
    const requestedLedgerName = requestedLedgerByKey.get(normalizeLooseName(bill.ledger));
    if (!requestedLedgerName) continue;
    billCount += 1;
    const referenceKey = openBillNarrationKey(requestedLedgerName, bill.ref);
    const entry = openBillFromFields(bill, requestedLedgerName, {
      knownInvoice: evidence.invoiceReferenceKeys.has(referenceKey),
      knownAdvance: evidence.advanceReferenceKeys.has(referenceKey),
    });
    if (!entry) continue;
    if (entry.kind === "bill") {
      const byReference = openBillNarrationKey(requestedLedgerName, entry.referenceName);
      const byVoucher = openBillNarrationKey(requestedLedgerName, entry.voucherNumber);
      entry.narration = evidence.narrationByBill.get(byReference) || evidence.narrationByBill.get(byVoucher) || null;
      entry.sourceSalesLedgerName = evidence.salesLedgerByBill.get(byReference) || evidence.salesLedgerByBill.get(byVoucher) || null;
      const receiptEvidence = evidence.receiptEvidenceByBill.get(byReference) || evidence.receiptEvidenceByBill.get(byVoucher) || null;
      entry.receiptDate = receiptEvidence?.lastReceiptDate || null;
      entry.matchedReceiptAmount = receiptEvidence?.matchedReceiptAmount || null;
      if (receiptEvidence && entry.originalAmount > 0) {
        const settledAmount = Math.min(entry.originalAmount, Math.max(0, receiptEvidence.matchedReceiptAmount));
        entry.settledAmount = settledAmount;
        entry.pendingAmount = Math.max(0, Number((entry.originalAmount - settledAmount).toFixed(2)));
      }
    }
    if (entry.kind === "bill" && entry.pendingAmount <= 0.01) continue;
    const { kind, ...openBillEntry } = entry;
    const bucket = byLedger[requestedLedgerName] || emptyOpenBillBucket(requestedLedgerName);
    bucket.rawCount += 1;
    (kind === "advance" ? bucket.existingAdvances : bucket.openBills).push(openBillEntry);
    byLedger[requestedLedgerName] = bucket;
  }
  return { byLedger, billCount };
}

// buildOpenBillAmountIndex on fields: open bills by amount in paise.
export function openBillAmountIndexFromFields(bills) {
  const byPaise = new Map();
  for (const bill of bills) {
    const ledgerName = bill.ledger;
    const open = ledgerName ? openBillFromFields(bill, ledgerName) : null;
    if (!open || open.kind !== "bill") continue;
    const closing = bill.closing ?? bill.pending ?? bill.amount;
    if (!closing) continue;
    const paise = Math.round(open.pendingAmount * 100);
    const entry = { ledgerName, referenceName: open.referenceName, invoiceDate: open.invoiceDate, pendingAmount: open.pendingAmount,
      direction: closing < 0 ? "receipt" : "payment" };
    byPaise.set(paise, [...(byPaise.get(paise) || []), entry]);
  }
  return byPaise;
}

export { normalizeLooseName as receivableNameKey, parseTallyDate as receivableTallyDate };
