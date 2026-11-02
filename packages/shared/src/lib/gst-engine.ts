// @ts-nocheck — faithful port of GSTReco engine.js; public shapes: gst-types.ts.
/**
 * Matching engine — pure functions, no DOM, no I/O.
 *
 * Input:  CanonicalInvoice[] from books / GSTR-2A / GSTR-2B (+ GSTR-3B summary)
 * Output: { summary, buckets, rows, suppliers, periods, audit }
 *
 * Deterministic: same input + same tolerance = same output, every time.
 */

import * as N from "./gst-normalize";

const TAX_FIELDS = ['taxable', 'cgst', 'sgst', 'igst', 'cess'];

/** Buckets, in display order. `tone` drives the badge colour. */
const BUCKETS = [
  { id: 'matched', label: 'Matched', tone: 'ok', blurb: 'Books, 2B and 2A agree within tolerance' },
  { id: 'valueDiff', label: 'Value mismatch', tone: 'warn', blurb: 'Present in both, amounts differ' },
  { id: 'booksOnly', label: 'Missing in 2B', tone: 'bad', blurb: 'Booked and claimed, but the supplier has not reported it — credit not available' },
  { id: 'portalOnly', label: 'Not in books', tone: 'info', blurb: 'Reported by the supplier but never booked — do not claim' },
  { id: 'ineligible', label: 'Ineligible ITC', tone: 'bad', blurb: 'Blocked or unavailable credit (Section 17(5), POS, non-filer, IMS rejection)' },
  { id: 'rule37A', label: 'Rule 37A', tone: 'bad', blurb: 'In GSTR-2A but not 2B — supplier filed GSTR-1 without GSTR-3B' },
  { id: 'reopened', label: 'Reopened', tone: 'bad', blurb: 'Was supported by 2B before — the portal entry has since been withdrawn' },
  { id: 'periodShift', label: 'Period shift', tone: 'warn', blurb: 'Portal reported it in a later period than our books' },
  { id: 'duplicate', label: 'Duplicate', tone: 'bad', blurb: 'Same supplier invoice booked and claimed more than once' },
];

const BUCKET_MAP = BUCKETS.reduce((acc, b) => ((acc[b.id] = b), acc), {});

// -------------------------------------------------------------- utilities
const round = N.round;

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const k = keyFn(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

const sumTax = (inv) => (inv ? inv.tax.total : 0);

/**
 * Sec 16(4): the earlier of 30 November following the financial year, or the
 * annual-return (GSTR-9) due date.
 */
function fyStartYear(period) {
  const y = Number(String(period).slice(0, 4));
  const m = Number(String(period).slice(5, 7));
  return m >= 4 ? y : y - 1;
}

function fyLabel(period) {
  const y = fyStartYear(period);
  return `${y}-${String(y + 1).slice(2)}`;
}

function itcDeadline(period, annualReturnDates) {
  const start = fyStartYear(period);
  const statutory = `${start + 1}-11-30`;
  const annual = annualReturnDates && annualReturnDates[fyLabel(period)];
  return annual && annual < statutory ? annual : statutory;
}

function daysLeft(deadline, asOf) {
  return N.daysBetween(asOf, deadline);
}

function toleranceFor(value, tolerance) {
  return Math.max(tolerance.amount || 0, (Math.abs(value) * (tolerance.percent || 0)) / 100);
}

/**
 * Compare two tax blocks. Returns per-field deltas and whether every field
 * (and the invoice date) is inside tolerance.
 */
function compare(book, portal, tolerance) {
  const deltas = {};
  let within = true;
  let gross = 0;
  for (const f of TAX_FIELDS) {
    const b = Number(book.tax[f] || 0);
    const p = Number(portal.tax[f] || 0);
    const d = round(b - p);
    deltas[f] = d;
    gross += Math.abs(d);
    if (Math.abs(d) > toleranceFor(Math.max(Math.abs(b), Math.abs(p)), tolerance)) within = false;
  }
  deltas.total = round(book.tax.total - portal.tax.total);
  const dateDelta = book.invoiceDate && portal.invoiceDate
    ? N.daysBetween(portal.invoiceDate, book.invoiceDate)
    : 0;
  if (Math.abs(dateDelta) > (tolerance.dateWindowDays || 0)) within = false;
  return { within, deltas, dateDelta, grossDelta: round(gross) };
}

function pickPrimary(list) {
  if (!list || !list.length) return null;
  if (list.length === 1) return list[0];
  // Amendments land in a later period under the same key — the latest
  // portal position wins, not the biggest number.
  return list.slice().sort((a, b) =>
    String(b.period).localeCompare(String(a.period)) ||
    Math.abs(sumTax(b)) - Math.abs(sumTax(a)))[0];
}

// ---------------------------------------------------------- filing calendar
const QUARTER_ENDS = { '03': '03', '06': '06', '09': '09', '12': '12' };
const isQuarterEndMonth = (period) => !!QUARTER_ENDS[String(period).slice(5, 7)];

function quarterEndYM(period) {
  const y = String(period).slice(0, 4);
  const m = Number(String(period).slice(5, 7));
  const qe = m <= 3 ? '03' : m <= 6 ? '06' : m <= 9 ? '09' : '12';
  return `${y}-${qe}`;
}

/**
 * A quarterly (QRMP) supplier's month-1/2 invoices only reach GSTR-2B with
 * the quarter-end filing. Missing + filing not yet due = awaited, not chased.
 */
function isAwaited(period, freq, asOf) {
  if (freq !== 'quarterly') return false;
  if (isQuarterEndMonth(period)) return false;
  return quarterEndYM(period) >= String(asOf).slice(0, 7);
}

// ------------------------------------------------------------- fuzzy pass
const digitTail = (no) => {
  const m = /(\d+)$/.exec(String(no || ''));
  return m ? m[1].replace(/^0+/, '') : '';
};

/**
 * Suppliers file "MPL/198" for what we booked as "MPL/25-26/0198".
 * Same GSTIN + one number being a suffix of the other + matching amount and
 * date is a safe enough link, and it is always marked so a human can look.
 */
function tailCompatible(a, b) {
  const ta = digitTail(a);
  const tb = digitTail(b);
  if (ta.length < 3 || tb.length < 3) return false;
  return ta === tb || ta.endsWith(tb) || tb.endsWith(ta);
}

function fuzzyLink(books, portalList, tolerance, windowDays) {
  if (!books.length || !portalList.length) return;
  const portalKeys = new Set(portalList.map((p) => p.key));
  const bookKeys = new Set(books.map((b) => b.key));

  const unmatchedBooks = books.filter((b) => !portalKeys.has(b.key))
    .slice().sort((x, y) => x.key.localeCompare(y.key));
  const openPortal = groupBy(portalList.filter((p) => !bookKeys.has(p.key)), (p) => p.gstin);
  const used = new Set();

  for (const book of unmatchedBooks) {
    const candidates = openPortal.get(book.gstin) || [];
    let best = null;
    let bestDelta = Infinity;
    for (const cand of candidates) {
      if (used.has(cand.key)) continue;
      if (cand.docType !== book.docType) continue;
      if (!tailCompatible(book.normNo, cand.normNo)) continue;
      const limit = toleranceFor(Math.max(Math.abs(book.tax.total), Math.abs(cand.tax.total)), tolerance);
      if (Math.abs(book.tax.total - cand.tax.total) > limit) continue;
      const delta = Math.abs(N.daysBetween(cand.invoiceDate, book.invoiceDate));
      if (delta > (windowDays || 60)) continue;
      if (delta < bestDelta) { best = cand; bestDelta = delta; }
    }
    if (best) {
      used.add(best.key);
      best.linkedFrom = best.key;
      best.linkedBy = 'fuzzy';
      best.key = book.key;
    }
  }
}

// ------------------------------------------------------------------- main
function reconcile(input) {
  const books = input.books || [];
  const a2 = input.a2 || [];
  const b2 = input.b2 || [];
  const g3b = input.g3b || [];

  const opts = input.opts || {};
  const tolerance = Object.assign({ amount: 1, percent: 0, dateWindowDays: 7 }, opts.tolerance || {});
  const asOf = opts.asOf || new Date().toISOString().slice(0, 10);
  const annualReturnDates = opts.annualReturnDates || {};
  const includeA2 = opts.includeA2 !== false;
  /** Prior run, per key: { b: bucket, p: 1 if 2B supported it }. Pure data in, pure data out. */
  const prior = opts.prior || {};

  const freqMap = {};
  for (const s of input.suppliers || []) {
    if (s && s.gstin) freqMap[N.gstin(s.gstin)] = s.filingFrequency || 'monthly';
  }

  if (opts.fuzzy !== false) {
    fuzzyLink(books, b2, tolerance, opts.fuzzyWindowDays);
    if (includeA2) fuzzyLink(books, a2, tolerance, opts.fuzzyWindowDays);
  }

  const booksIndex = groupBy(books, (i) => i.key);
  const b2Index = groupBy(b2, (i) => i.key);
  const a2Index = includeA2 ? groupBy(a2, (i) => i.key) : new Map();

  const keys = new Set([...booksIndex.keys(), ...b2Index.keys(), ...a2Index.keys()]);

  const rows = [];
  const byBucket = BUCKETS.reduce((acc, b) => ((acc[b.id] = 0), acc), {});

  for (const key of keys) {
    const bookList = booksIndex.get(key) || [];
    const b2List = b2Index.get(key) || [];
    const a2List = a2Index.get(key) || [];

    const book = pickPrimary(bookList);
    const portal = pickPrimary(b2List);
    const portalA2 = pickPrimary(a2List);

    const claimedEntries = bookList.filter((b) => b.claimed);
    const duplicateClaim = bookList.length > 1 && claimedEntries.length > 1;

    let bucket;
    let reason = '';
    let comparison = null;

    // Same key reported in several periods = the supplier amended via GSTR-1.
    const multiPortal = new Set(b2List.map((e) => e.period)).size > 1;

    if (duplicateClaim) {
      bucket = 'duplicate';
      reason = `${bookList.length} vouchers booked for one supplier invoice (${bookList.map((v) => v.voucherNumber).join(', ')})`;
      if (portal) comparison = compare(book, portal, tolerance);
    } else if (book && portal) {
      comparison = compare(book, portal, tolerance);
      if (portal.period && book.period && portal.period !== book.period && !multiPortal) {
        bucket = 'periodShift';
        reason = `Booked in ${book.period}, reported by the supplier in ${portal.period}`;
      } else if (portal.itcAvailable === 'N') {
        bucket = 'ineligible';
        reason = portal.reasonLabel || 'Reported as unavailable by the portal';
      } else if (comparison.within) {
        bucket = 'matched';
      } else {
        bucket = 'valueDiff';
        const lost = round(Math.abs(comparison.deltas.total));
        reason = comparison.grossDelta > toleranceFor(book.tax.total, tolerance)
          ? `Differs from GSTR-2B by ₹${lost.toLocaleString('en-IN')}`
          : `Invoice date is ${Math.abs(comparison.dateDelta)} days from the portal date`;
      }
    } else if (book && !portal) {
      const rejectedByUs = portalA2 && portalA2.imsAction === 'R';
      if (rejectedByUs) {
        bucket = 'ineligible';
        reason = 'You rejected this invoice in IMS — the portal excludes it from GSTR-2B by your own action';
      } else if (portalA2) {
        bucket = 'rule37A';
        reason = 'Present in GSTR-2A but not in GSTR-2B — supplier filed GSTR-1 without GSTR-3B';
      } else {
        bucket = 'booksOnly';
        reason = 'Not reported by the supplier in GSTR-2B';
      }
    } else {
      const only = portal || portalA2;
      if (only && only.excluded) {
        bucket = 'portalOnly';
        reason = 'ISD credit — claimed through the ISD return, not purchase ITC';
      } else {
        bucket = 'portalOnly';
        reason = portal
          ? 'Reported in GSTR-2B but never booked'
          : 'Reported in GSTR-2A only (not filed in 3B) and never booked';
      }
    }

    // A credit the portal used to support, now withdrawn (amended or
    // cancelled via GSTR-1A): was fine, now broken. Overrides the bucket.
    const wasSupported = !!(prior[key] && prior[key].p);
    const nowSupported = !!portal;
    const reopened = wasSupported && !nowSupported && !!book;
    if (reopened) {
      bucket = 'reopened';
      reason = 'Previously supported by GSTR-2B — the supplier has since withdrawn or amended the invoice. Reverse the credit.';
    }

    const reference = book || portal || portalA2;
    const claimedTax = round(claimedEntries.reduce((s, v) => s + sumTax(v), 0));
    const duplicateExtra = duplicateClaim
      ? round(claimedEntries.slice(1).reduce((s, v) => s + sumTax(v), 0))
      : 0;

    const freq = freqMap[reference.gstin] || 'monthly';
    const awaited = (bucket === 'booksOnly' || bucket === 'rule37A') &&
      isAwaited(book ? book.period : reference.period, freq, asOf);

    const atRiskBuckets = ['booksOnly', 'rule37A', 'reopened', 'ineligible', 'duplicate'];
    const isAtRisk = atRiskBuckets.indexOf(bucket) >= 0 && !awaited;
    const deadline = itcDeadline(reference.period, annualReturnDates);
    const remaining = daysLeft(deadline, asOf);

    let availableTax = portal && portal.itcAvailable === 'Y' ? sumTax(portal) : 0;
    if (duplicateClaim) availableTax = Math.min(availableTax, claimedTax);

    const portalPeriods = [...new Set([...b2List, ...a2List].map((e) => e.period))];
    const row = {
      key,
      gstin: reference.gstin,
      invoiceNo: book ? book.invoiceNo : (portal ? portal.invoiceNo : portalA2.invoiceNo),
      invoiceDate: reference.invoiceDate,
      period: book ? book.period : reference.period,
      portalPeriod: portal ? portal.period : (portalA2 ? portalA2.period : null),
      docType: reference.docType,
      bucket,
      bucketLabel: BUCKET_MAP[bucket].label,
      tone: awaited ? 'stone' : BUCKET_MAP[bucket].tone,
      blurb: BUCKET_MAP[bucket].blurb,
      reason,
      books: book,
      b2: portal,
      a2: portalA2,
      claims: bookList.length,
      comparison,
      claimedTax,
      availableTax: round(availableTax),
      atRiskTax: !isAtRisk ? 0 : round(bucket === 'duplicate' ? duplicateExtra : claimedTax),
      duplicateExtra,
      fuzzyLinked: !!(portal && portal.linkedBy === 'fuzzy'),
      amended: portalPeriods.length > 1,
      rcm: !!(portal && portal.rcm),
      imsRejected: !!((portalA2 && portalA2.imsAction === 'R') || (portal && portal.imsAction === 'R')),
      awaited,
      supplierFreq: freq,
      reopened,
      deadline,
      daysLeft: remaining,
      expired: remaining < 0,
      itcAvailable: portal ? portal.itcAvailable : (book ? (book.eligibility === 'ineligible' ? 'N' : 'Y') : 'Y'),
      review: 'open', // open | accepted | rejected — set by the UI
    };

    if (book) row.supplierName = book.supplierName;
    else if (portal) row.supplierName = portal.supplierName;
    else row.supplierName = portalA2.supplierName;

    rows.push(row);
    byBucket[bucket] += 1;
  }

  // ----------------------------------------------------------- summaries
  let claimedTotal = 0;
  for (const b of books) if (b.claimed) claimedTotal += sumTax(b);

  let availableTotal = 0;
  for (const p of b2) if (p.itcAvailable === 'Y') availableTotal += sumTax(p);

  let atRisk = 0;
  let timing = 0;
  let diffExposure = 0;
  let expiringSoon = 0;
  let expired = 0;
  let matchedTax = 0;
  let awaited = 0;
  let awaitedTax = 0;

  for (const row of rows) {
    if (row.awaited) {
      awaited += 1;
      awaitedTax += row.claimedTax;
    }
    if (row.atRiskTax) {
      atRisk += row.atRiskTax;
      const remaining = row.daysLeft;
      if (remaining < 0) expired += row.atRiskTax;
      else if (remaining <= 180) expiringSoon += row.atRiskTax;
    }
    if (row.bucket === 'periodShift') timing += row.claimedTax;
    if (row.bucket === 'valueDiff' && row.comparison && row.comparison.deltas.total > 0) {
      diffExposure += row.comparison.deltas.total;
    }
    if (row.bucket === 'matched') matchedTax += sumTax(row.books || row.b2);
  }

  // GSTR-3B cross-check per period.
  const filed = [];
  const claimedByPeriod = new Map();
  for (const b of books) {
    if (!b.claimed) continue;
    claimedByPeriod.set(b.period, round((claimedByPeriod.get(b.period) || 0) + sumTax(b)));
  }
  for (const g of g3b) {
    const fromBooks = claimedByPeriod.get(g.period) || 0;
    filed.push({
      period: g.period,
      filedOn: g.filedOn,
      declaredIn3B: g.claimed,
      perBooks: round(fromBooks),
      delta: round(fromBooks - g.claimed),
      reversedIn3B: g.reversed,
    });
  }

  const summary = {
    asOf,
    claimed: round(claimedTotal),
    available: round(availableTotal),
    gap: round(claimedTotal - availableTotal),
    matchedTax: round(matchedTax),
    atRisk: round(atRisk),
    timing: round(timing),
    overClaimed: round(atRisk + timing),
    diffExposure: round(diffExposure),
    expiringSoon: round(expiringSoon),
    expired: round(expired),
    awaited,
    awaitedTax: round(awaitedTax),
    totalInvoices: rows.length,
    exceptions: rows.length - byBucket.matched,
  };

  // ------------------------------------------------------------ movement
  // Open = anything that isn't a clean match. Compared key-by-key against
  // the previous run so the client sees resolved / new / still-open.
  const OPEN = new Set(['booksOnly', 'rule37A', 'reopened', 'ineligible', 'duplicate', 'valueDiff', 'periodShift', 'portalOnly']);
  const movement = { resolved: 0, opened: 0, stillOpen: 0, reopened: 0, hasPrior: Object.keys(prior).length > 0 };
  for (const row of rows) {
    const nowOpen = OPEN.has(row.bucket);
    const prev = prior[row.key];
    const wasOpen = !!(prev && OPEN.has(prev.b));
    if (nowOpen && !wasOpen) movement.opened += 1;
    else if (!nowOpen && wasOpen) movement.resolved += 1;
    else if (nowOpen && wasOpen) movement.stillOpen += 1;
    if (row.bucket === 'reopened') movement.reopened += 1;
  }

  // ----------------------------------------------------------- suppliers
  const supplierMap = new Map();
  for (const row of rows) {
    let s = supplierMap.get(row.gstin);
    if (!s) {
      s = {
        gstin: row.gstin,
        name: row.supplierName,
        invoices: 0,
        exceptions: 0,
        claimed: 0,
        available: 0,
        atRisk: 0,
        buckets: {},
        filer: 'regular',
      };
      supplierMap.set(row.gstin, s);
    }
    s.invoices += 1;
    s.claimed += row.claimedTax;
    s.available += row.availableTax;
    s.atRisk += row.atRiskTax;
    s.buckets[row.bucket] = (s.buckets[row.bucket] || 0) + 1;
    if (row.bucket !== 'matched') s.exceptions += 1;
  }
  const suppliers = [...supplierMap.values()]
    .map((s) => Object.assign(s, {
      claimed: round(s.claimed),
      available: round(s.available),
      atRisk: round(s.atRisk),
      filer: s.buckets.booksOnly || s.buckets.rule37A ? 'non-filer' : (s.exceptions > 1 ? 'irregular' : 'regular'),
    }))
    .sort((a, b) => b.atRisk - a.atRisk || b.exceptions - a.exceptions);

  return {
    summary,
    movement,
    buckets: BUCKETS.map((b) => Object.assign({}, b, { count: byBucket[b.id] })),
    rows,
    suppliers,
    filed,
    periods: [...new Set(rows.map((r) => r.period).concat(filed.map((f) => f.period)))].sort(),
    audit: {
      runAt: new Date().toISOString(),
      asOf,
      tolerance,
      includeA2,
      booksRows: books.length,
      a2Rows: a2.length,
      b2Rows: b2.length,
      g3bPeriods: g3b.length,
    },
  };
}

// ------------------------------------------------------------------ helpers
function csvRows(result) {
  const header = [
    'GSTIN', 'Supplier', 'Invoice No', 'Invoice Date', 'Books Period', 'Portal Period',
    'Doc Type', 'Bucket', 'Reason', 'Books Taxable', 'Portal Taxable',
    'Books CGST', 'Portal CGST', 'Books SGST', 'Portal SGST', 'Books IGST', 'Portal IGST',
    'ITC Claimed', 'ITC Available', 'At Risk', 'ITC Deadline', 'Days Left',
  ];
  const lines = [header];
  for (const r of result.rows) {
    const b = r.books ? r.books.tax : null;
    const p = r.b2 ? r.b2.tax : null;
    lines.push([
      r.gstin, r.supplierName, r.invoiceNo, r.invoiceDate, r.period, r.portalPeriod || '',
      r.docType, r.bucketLabel, r.reason,
      b ? b.taxable : '', p ? p.taxable : '',
      b ? b.cgst : '', p ? p.cgst : '',
      b ? b.sgst : '', p ? p.sgst : '',
      b ? b.igst : '', p ? p.igst : '',
      r.claimedTax, r.availableTax, r.atRiskTax, r.deadline, r.daysLeft,
    ]);
  }
  return lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n');
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export { reconcile, BUCKETS, BUCKET_MAP, itcDeadline, fyStartYear, fyLabel, daysLeft, compare, csvRows };
