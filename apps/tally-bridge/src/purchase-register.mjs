// Read-only purchase register for GST reconciliation: one month of Purchase and
// Debit Note vouchers from a Tally company, in the books payload shape the
// reconciliation engine reads (see packages/shared gst-normalize fromBooks).

const SPECIAL_GROUPS = { "purchase accounts": "taxable", "duties & taxes": "tax" };
const TAX_HEADS = [
  [/igst/i, "igst"],
  [/cgst/i, "cgst"],
  [/sgst|utgst/i, "sgst"],
  [/cess/i, "cess"],
];

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

function decode(value) {
  return String(value ?? "")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&").replace(/&#(\d+);/g, (_, code) => (Number(code) >= 32 ? String.fromCodePoint(Number(code)) : " "))
    .replace(/\s+/g, " ").trim();
}

function escapeXml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function blocks(xml, tag) {
  return [...String(xml).matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g"))].map((match) => match[0]);
}

function field(block, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`).exec(block);
  return match ? decode(match[1]) : "";
}

function attribute(block, name) {
  const match = new RegExp(`^<[A-Z]+\\b[^>]*\\b${name}="([^"]*)"`).exec(block);
  return match ? decode(match[1]) : "";
}

const isoFromTally = (value) => (/^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : "");

export function monthRange(period) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(period));
  if (!match) throw new Error("Purchase register period must be YYYY-MM.");
  const last = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
  return { from: `${match[1]}${match[2]}01`, to: `${match[1]}${match[2]}${String(last).padStart(2, "0")}` };
}

function collectionXml(company, type, fetch) {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>GstRecoColl</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE><COLLECTION NAME="GstRecoColl" ISMODIFY="No"><TYPE>${type}</TYPE><FETCH>${fetch}</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export const buildLedgerMasterXml = (company) => collectionXml(company, "Ledger", "NAME,PARENT,PARTYGSTIN");
export const buildGroupMasterXml = (company) => collectionXml(company, "Group", "NAME,PARENT");
export const buildVoucherTypeXml = (company) => collectionXml(company, "VoucherType", "NAME,PARENT");

export function buildDayBookXml(company, from, to) {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Day Book</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY><SVFROMDATE>${from}</SVFROMDATE><SVTODATE>${to}</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
}

// A voucher collection answers for any company period; the Day Book report returns
// nothing when the date range is outside the period Tally has open for that company.
export const buildVoucherCollectionXml = (company) => collectionXml(company, "Voucher",
  "DATE,VOUCHERTYPENAME,VOUCHERNUMBER,REFERENCE,REFERENCEDATE,PARTYLEDGERNAME,PARTYGSTIN,NARRATION,ISCANCELLED,ISOPTIONAL," +
  "LEDGERENTRIES.LEDGERNAME,LEDGERENTRIES.AMOUNT,ALLLEDGERENTRIES.LEDGERNAME,ALLLEDGERENTRIES.AMOUNT," +
  "ALLINVENTORYENTRIES.ACCOUNTINGALLOCATIONS.LEDGERNAME,ALLINVENTORYENTRIES.ACCOUNTINGALLOCATIONS.AMOUNT");

function parseNamedParents(xml, tag, extra) {
  const map = new Map();
  for (const block of blocks(xml, tag)) {
    const name = attribute(block, "NAME") || field(block, "NAME");
    if (name) map.set(name.toLowerCase(), { name, parent: field(block, "PARENT"), ...(extra ? extra(block) : {}) });
  }
  return map;
}

export const parseLedgerMasters = (xml) => parseNamedParents(xml, "LEDGER", (block) => ({ gstin: field(block, "PARTYGSTIN").toUpperCase() }));
export const parseGroups = (xml) => parseNamedParents(xml, "GROUP");
export const parseVoucherTypes = (xml) => parseNamedParents(xml, "VOUCHERTYPE");

// Walk up a parent chain until a name in `targets` is reached.
function ancestor(map, start, targets) {
  let name = String(start || "").toLowerCase();
  for (let depth = 0; name && depth < 12; depth += 1) {
    if (targets.has(name)) return name;
    name = String(map.get(name)?.parent || "").toLowerCase();
  }
  return "";
}

export function ledgerKind(ledgerName, ledgers, groups) {
  const ledger = ledgers.get(String(ledgerName).toLowerCase());
  if (!ledger) return "";
  const group = ancestor(groups, ledger.parent, new Set(Object.keys(SPECIAL_GROUPS)));
  const kind = SPECIAL_GROUPS[group];
  if (kind === "taxable") return "taxable";
  if (kind !== "tax" || /\b(tds|tcs)\b/i.test(ledger.name)) return "";
  return TAX_HEADS.find(([pattern]) => pattern.test(ledger.name))?.[1] ?? "";
}

function voucherEntries(voucher) {
  const ledgerBlocks = blocks(voucher, "ALLLEDGERENTRIES\\.LIST");
  const entries = ledgerBlocks.length ? ledgerBlocks : blocks(voucher, "LEDGERENTRIES\\.LIST");
  return [...entries, ...blocks(voucher, "ACCOUNTINGALLOCATIONS\\.LIST")];
}

export function parsePurchaseRegister(dayBookXml, { ledgers, groups, voucherTypes, period }) {
  const vouchers = [];
  const skipped = { noGstin: [], cancelled: 0 };
  for (const block of blocks(dayBookXml, "VOUCHER")) {
    const typeName = field(block, "VOUCHERTYPENAME") || attribute(block, "VCHTYPE");
    const base = ancestor(voucherTypes, typeName, new Set(["purchase", "debit note"]));
    if (!base) continue;
    if (/^yes$/i.test(field(block, "ISCANCELLED")) || /^yes$/i.test(field(block, "ISOPTIONAL"))) {
      skipped.cancelled += 1;
      continue;
    }
    const date = isoFromTally(field(block, "DATE"));
    if (date.slice(0, 7) !== period) continue;

    const party = field(block, "PARTYLEDGERNAME");
    const gstin = (field(block, "PARTYGSTIN") || ledgers.get(party.toLowerCase())?.gstin || "").toUpperCase();
    const number = field(block, "VOUCHERNUMBER");
    if (!gstin) {
      skipped.noGstin.push({ voucherNumber: number, partyName: party });
      continue;
    }

    const tax = { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
    for (const entry of voucherEntries(block)) {
      const kind = ledgerKind(field(entry, "LEDGERNAME"), ledgers, groups);
      if (kind) tax[kind] += Math.abs(Number(field(entry, "AMOUNT")) || 0);
    }
    for (const key of Object.keys(tax)) tax[key] = round2(tax[key]);
    const taxSum = round2(tax.cgst + tax.sgst + tax.igst);
    const narration = field(block, "NARRATION");
    vouchers.push({
      voucherNumber: number,
      voucherType: base === "debit note" ? "Debit Note" : "Purchase",
      voucherDate: date,
      partyGSTIN: gstin,
      partyName: party,
      supplierInvoiceNo: field(block, "REFERENCE"),
      supplierInvoiceDate: isoFromTally(field(block, "REFERENCEDATE")) || date,
      docType: base === "debit note" ? "crn" : "inv",
      taxRate: tax.taxable ? Math.round((taxSum / tax.taxable) * 100) : 0,
      taxableValue: tax.taxable, cgst: tax.cgst, sgst: tax.sgst, igst: tax.igst, cess: tax.cess,
      roundOff: 0,
      grandTotal: round2(tax.taxable + taxSum + tax.cess),
      natureOfTransaction: base === "debit note" ? "Debit Note" : "Purchase",
      // Tally has no "claimed in 3B" flag; vouchers are treated as claimed.
      itcClaimedIn3B: true,
      itcEligibility: "eligible",
      narration,
    });
  }
  return { vouchers, skipped };
}

// `exportXml(xml, label)` posts one request to Tally and returns the response text.
export async function fetchPurchaseRegister({ exportXml, company, period }) {
  if (!company) throw new Error("Purchase register read requires a Tally company.");
  const { from, to } = monthRange(period);
  // Tally answers one request at a time, so these run in sequence.
  const ledgers = parseLedgerMasters(await exportXml(buildLedgerMasterXml(company), "GST register ledgers"));
  const groups = parseGroups(await exportXml(buildGroupMasterXml(company), "GST register groups"));
  const voucherTypes = parseVoucherTypes(await exportXml(buildVoucherTypeXml(company), "GST register voucher types"));
  let dayBook = await exportXml(buildVoucherCollectionXml(company), "GST register vouchers");
  if (!blocks(dayBook, "VOUCHER").length) dayBook = await exportXml(buildDayBookXml(company, from, to), "GST register day book");
  const { vouchers, skipped } = parsePurchaseRegister(dayBook, { ledgers, groups, voucherTypes, period });
  return {
    companyName: company,
    period,
    system: "Tally (live)",
    generatedAt: new Date().toISOString(),
    vouchers,
    skipped,
  };
}
