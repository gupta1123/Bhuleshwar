// @ts-nocheck — faithful port of GSTReco normalize.js; public shapes: gst-types.ts.
/**
 * Normalization layer — provider payloads -> CanonicalInvoice.
 *
 * This is the ONLY place that knows about Tally field names or GSTN envelope
 * quirks. Everything downstream (engine, views) speaks CanonicalInvoice only.
 */


// --------------------------------------------------------------- primitives
function gstin(value) {
  return String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 15);
}

function isValidGstin(value) {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(gstin(value));
}

/**
 * Invoice-number normalization. The single largest source of false mismatches.
 *   RMW/25-26/0117 · rmw-2526-117 · INV/0117/A
 * Collapses punctuation, merges split FY segments, drops leading zeros.
 */
function invoiceNo(value) {
  let s = String(value == null ? '' : value).toUpperCase().trim();
  if (!s) return '';
  s = s.replace(/\s+/g, '');
  // 25-26 / 25/26 / 2025-26 -> 2526 / 2526 / 2526
  s = s.replace(/(?:^|[^0-9])(\d{2})[\/\-.](\d{2})(?=[^0-9]|$)/g, '$1$2');
  s = s.replace(/[^0-9A-Z]/g, '');
  s = s.replace(/^0+/, '');
  return s;
}

function toISO(value) {
  const s = String(value || '').trim();
  let m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s); // GSTN: dd-mm-yyyy
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); // Tally: yyyy-mm-dd
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return '';
}

function periodFromReturn(value) {
  const s = String(value || '').replace(/[^0-9]/g, '');
  if (s.length !== 6) return '';
  return `${s.slice(2)}-${s.slice(0, 2)}`;
}

const periodOf = (isoDate) => String(isoDate || '').slice(0, 7);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

/** ITC is the tax, never the taxable value. */
const taxTotal = (t) => round((t.cgst || 0) + (t.sgst || 0) + (t.igst || 0) + (t.cess || 0));
const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const key = (g, no, docType) => `${gstin(g)}|${invoiceNo(no)}|${docType || 'inv'}`;

// Human-readable decode of GSTR-2B `rsn` codes.
const REASONS = {
  POS: 'Place of supply does not match your registration state',
  NONF: 'Supplier is a non-filer / registration inactive',
  DUP: 'Duplicate invoice reported by the supplier',
  AMND: 'Amended by the supplier after you claimed',
  CNCL: 'Invoice cancelled by the supplier',
  ISD: 'ISD credit — distribution rules differ',
  IMPG: 'Import of goods — IGST credit via bill of entry',
};

// ------------------------------------------------------------------ helpers
function empty() {
  return { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0 };
}

function makeCanonical(o) {
  const tax = o.tax || empty();
  tax.total = taxTotal(tax);
  tax.value = round((tax.taxable || 0) + tax.total);
  return {
    key: o.key,
    source: o.source,
    gstin: o.gstin,
    supplierName: o.supplierName || o.gstin || '—',
    invoiceNo: o.invoiceNo,
    normNo: invoiceNo(o.invoiceNo),
    invoiceDate: o.invoiceDate,
    period: o.period,
    docType: o.docType || 'inv',
    rcm: !!o.rcm,
    itcAvailable: o.itcAvailable || 'Y',
    reason: o.reason || '',
    reasonLabel: o.reason ? REASONS[o.reason] || o.reason : '',
    pos: o.pos || '',
    /** Recipient's IMS action on the portal: '' | 'A' | 'R' | 'P'. */
    imsAction: o.imsAction || '',
    /** True for ISD/TDS-style credits that belong to a different return. */
    excluded: !!o.excluded,
    tax,
    claimed: o.claimed !== false && o.source === 'books' ? !!o.claimed : false,
    eligibility: o.eligibility || 'eligible',
    voucherNumber: o.voucherNumber || '',
    raw: o.raw || null,
  };
}

/**
 * Sandbox wraps the GSTN payload in up to three `data` envelopes
 * ({ code, data: { status_cd, data: { chksum, data: <return> } } }).
 * Peel them until we reach something that looks like a return.
 */
function unwrap(payload) {
  let p = payload;
  for (let i = 0; i < 4 && p && typeof p === 'object'; i += 1) {
    if (p.docdata || p.b2b || p.cdn || p.cdnr || p.itc_elg || p['4A5_itcAvailable'] !== undefined) return p;
    p = p.data;
  }
  return p && typeof p === 'object' ? p : null;
}

/** GSTR-2B IMS status -> our action code. 'N' means no action taken yet. */
const IMS = { A: 'A', R: 'R', P: 'P', N: '' };

/**
 * Tax for one portal document, whichever shape it arrives in:
 * fixture `items[]`, GSTR-2A `itms[].itm_det`, or GSTR-2B flat fields.
 */
function docTax(doc) {
  if (Array.isArray(doc.items)) return itemsToTax(doc.items);
  if (Array.isArray(doc.itms)) return itemsToTax(doc.itms.map((it) => it.itm_det || it));
  return {
    taxable: round(Number(doc.txval || 0)),
    cgst: round(Number(doc.cgst || 0)),
    sgst: round(Number(doc.sgst || 0)),
    igst: round(Number(doc.igst || 0)),
    cess: round(Number(doc.cess || 0)),
  };
}

function itemsToTax(items) {
  const sum = empty();
  for (const it of items || []) {
    sum.taxable += Number(it.txval || 0);
    sum.cgst += Number(it.camt || 0);
    sum.sgst += Number(it.samt || 0);
    sum.igst += Number(it.iamt || 0);
    sum.cess += Number(it.csamt || 0);
  }
  return {
    taxable: round(sum.taxable), cgst: round(sum.cgst), sgst: round(sum.sgst),
    igst: round(sum.igst), cess: round(sum.cess),
  };
}

// ------------------------------------------------------------------ sources
/** Tally purchase register -> CanonicalInvoice[] */
function fromBooks(payload) {
  if (!payload || !Array.isArray(payload.vouchers)) return [];
  return payload.vouchers.map((v) => makeCanonical({
    key: key(v.partyGSTIN, v.supplierInvoiceNo, v.docType === 'crn' ? 'crn' : (v.docType === 'imp' ? 'imp' : 'inv')),
    source: 'books',
    gstin: gstin(v.partyGSTIN),
    supplierName: v.partyName,
    invoiceNo: v.supplierInvoiceNo,
    invoiceDate: toISO(v.supplierInvoiceDate || v.voucherDate),
    period: payload.period,
    docType: v.docType === 'crn' ? 'crn' : (v.docType === 'imp' ? 'imp' : 'inv'),
    tax: {
      taxable: Number(v.taxableValue || 0),
      cgst: Number(v.cgst || 0),
      sgst: Number(v.sgst || 0),
      igst: Number(v.igst || 0),
      cess: Number(v.cess || 0),
    },
    claimed: v.itcClaimedIn3B,
    eligibility: v.itcEligibility,
    voucherNumber: v.voucherNumber,
    raw: v,
  }));
}

/**
 * GSTR-2A / 2B -> CanonicalInvoice[]. Reads both the fixture shape and the
 * live GSTN shape: 2B nests sections under `docdata`, 2A puts them at the
 * top level; 2A dates are `idt`/`nt_dt` with `itms[]`, 2B uses `dt` with
 * flat tax fields and `ntnum`/`typ` on notes.
 */
function fromPortal(input, source) {
  const payload = unwrap(input);
  if (!payload) return [];
  const docs = payload.docdata || (payload.b2b || payload.cdn || payload.cdnr ? payload : null);
  if (!docs) return [];
  const period = periodFromReturn(payload.rtnprd || payload.fp) || '';
  const out = [];

  for (const group of docs.b2b || []) {
    for (const inv of group.inv || []) {
      out.push(makeCanonical({
        key: key(group.ctin, inv.inum, 'inv'),
        source,
        gstin: gstin(group.ctin),
        supplierName: group.trdnm || group.ctin,
        invoiceNo: inv.inum,
        invoiceDate: toISO(inv.idt || inv.dt),
        period,
        docType: 'inv',
        rcm: (inv.rev || inv.rchrg) === 'Y',
        itcAvailable: inv.itcavl === 'N' ? 'N' : 'Y',
        reason: inv.itcavl === 'N' ? inv.rsn : '',
        pos: inv.pos,
        imsAction: inv.ims || IMS[inv.imsStatus] || '',
        tax: docTax(inv),
        raw: inv,
      }));
    }
  }

  for (const group of docs.cdnr || docs.cdn || []) {
    for (const note of group.nt || []) {
      const docType = (note.ntty || note.typ) === 'D' ? 'dbn' : 'crn';
      const noteNo = note.nt_num || note.ntnum;
      out.push(makeCanonical({
        key: key(group.ctin, noteNo, docType),
        source,
        gstin: gstin(group.ctin),
        supplierName: group.trdnm || group.ctin,
        invoiceNo: noteNo,
        invoiceDate: toISO(note.nt_dt || note.dt),
        period,
        docType,
        rcm: (note.rev || note.rchrg) === 'Y',
        itcAvailable: note.itcavl === 'N' ? 'N' : 'Y',
        reason: note.itcavl === 'N' ? note.rsn : '',
        pos: note.pos,
        imsAction: note.ims || IMS[note.imsStatus] || '',
        tax: docTax(note),
        raw: note,
      }));
    }
  }

  // Imports: no supplier GSTIN — the bill of entry is the key.
  for (const entry of docs.impg || []) {
    out.push(makeCanonical({
      key: key('', entry.boenum, 'imp'),
      source,
      gstin: '',
      supplierName: 'Imports — bill of entry',
      invoiceNo: entry.boenum,
      invoiceDate: toISO(entry.boedt),
      period,
      docType: 'imp',
      tax: {
        taxable: Number(entry.txval || 0),
        cgst: 0, sgst: 0,
        igst: Number(entry.igst || 0),
        cess: 0,
      },
      raw: entry,
    }));
  }

  // ISD / TDS credits ride along in 2A/2B but belong to a different return.
  for (const entry of docs.isd || []) {
    out.push(makeCanonical({
      key: key(entry.ctin || 'ISD', entry.docnum, 'isd'),
      source,
      gstin: gstin(entry.ctin || ''),
      supplierName: entry.trdnm || 'ISD credit',
      invoiceNo: entry.docnum,
      invoiceDate: toISO(entry.docdt),
      period,
      docType: 'isd',
      excluded: true,
      tax: {
        taxable: 0, cgst: 0, sgst: 0,
        igst: Number(entry.igst || 0),
        cess: 0,
      },
      raw: entry,
    }));
  }

  return out;
}

const from2A = (payload) => fromPortal(payload, '2a');
const from2B = (payload) => fromPortal(payload, '2b');

/** Sum every tax head across a GSTR-3B table (an array of rows, or one row). */
const sum3B = (rows) => round([].concat(rows || []).reduce(
  (s, r) => s + Number(r.iamt || 0) + Number(r.camt || 0) + Number(r.samt || 0) + Number(r.csamt || 0), 0));

function from3B(input) {
  const payload = unwrap(input);
  if (!payload) return null;
  // Live GSTN shape: Table 4 lives under itc_elg (4A available, 4B reversed, 4C net).
  if (payload.itc_elg) {
    const e = payload.itc_elg;
    return {
      period: periodFromReturn(payload.ret_period),
      claimed: sum3B(e.itc_avl),
      reversed: sum3B(e.itc_rev),
      net: sum3B(e.itc_net),
      filedOn: '',
    };
  }
  return {
    period: periodFromReturn(payload.ret_period),
    claimed: Number(payload['4A5_itcAvailable'] || 0),
    reversed: Number(payload['4D2_itcReversed'] || 0),
    net: Number(payload['4D1_netItcAvailed'] || 0),
    filedOn: toISO(payload.filedOn),
  };
}

export { gstin, isValidGstin, invoiceNo, toISO, periodOf, periodFromReturn, daysBetween, taxTotal, round, key, REASONS, fromBooks, from2A, from2B, from3B };
