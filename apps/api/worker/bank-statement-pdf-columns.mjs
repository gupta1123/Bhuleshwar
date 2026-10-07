// Recover debit, credit and balance from physical PDF columns. These values are
// authoritative because Markdown conversion and AI can collapse empty cells.
function normalizedText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function center(item) {
  return Number(item.x) + Number(item.width) / 2;
}

function money(parts) {
  const value = parts
    .sort((left, right) => right.y - left.y || left.x - right.x)
    .map((part) => part.text)
    .join("")
    .replace(/\s/g, "");
  if (!value || value === "-") return null;
  if (!/^\d[\d,]*\.\d{2}(?:Dr\.?|Cr\.?)?$/i.test(value)) {
    throw new Error("Uncertain PDF amount cell");
  }
  return Number(value.replace(/,/g, "").replace(/(?:Dr\.?|Cr\.?)$/i, "")) *
    (/Dr\.?$/i.test(value) ? -1 : 1);
}

function header(items, ...names) {
  const allowed = new Set(names.map((name) => name.toLowerCase()));
  return items.find((item) => allowed.has(item.text.toLowerCase()));
}

function rowBounds(anchors, index) {
  const distances = anchors
    .slice(0, -1)
    .map((anchor, anchorIndex) => anchor.y - anchors[anchorIndex + 1].y)
    .filter((value) => value > 2)
    .sort((left, right) => left - right);
  const typical = distances.length ? distances[Math.floor(distances.length / 2)] : 72;
  const current = anchors[index];
  const previous = anchors[index - 1];
  const next = anchors[index + 1];
  return {
    top: previous ? (previous.y + current.y) / 2 : current.y + Math.max(16, typical / 2),
    bottom: next ? (current.y + next.y) / 2 : current.y - Math.max(48, typical * 1.15),
  };
}

function columnCell(items, target, left, right, bounds) {
  return items.filter((item) => {
    const itemCenter = center(item);
    return item.y < bounds.top && item.y > bounds.bottom && itemCenter >= left && itemCenter < right &&
      Math.abs(itemCenter - target) <= Math.max(target - left, right - target);
  });
}

function detectPnbLayout(items, page) {
  const debit = header(items, "dr amount");
  const credit = header(items, "cr amount");
  const reference = header(items, "txn no.", "txn no");
  const date = header(items, "txn date");
  const description = header(items, "description", "narration", "particulars");
  const balance = header(items, "balance");
  if (!debit || !credit || !reference || !date || !description || !balance) return null;
  const headerY = [debit, credit, reference, date, description, balance].map((item) => item.y);
  if (Math.max(...headerY) - Math.min(...headerY) > 20) return null;
  const gap = center(credit) - center(debit);
  if (gap < 30 || Math.abs(center(balance) - center(credit) - gap) > gap * 0.2) return null;
  return {
    type: "pnb",
    debit: center(debit),
    credit: center(credit),
    balance: center(balance),
    reference: center(reference),
    date: center(date),
    description: center(description),
    gap,
    width: page.width,
  };
}

function detectCentralBankLayout(items, page) {
  const postDate = header(items, "post date", "posting date", "transaction date", "txn date", "date");
  const valueDate = header(items, "value", "value date");
  const debit = header(items, "debit", "dr amount", "withdrawal", "paid out");
  const credit = header(items, "credit", "cr amount", "deposit", "paid in");
  const balance = header(items, "balance");
  const description = header(items, "transaction description", "description", "particular", "particulars", "narration", "details");
  if (!postDate || !debit || !credit || !balance || !description) return null;
  const headerY = [postDate, debit, credit, balance, description].map((item) => item.y);
  if (Math.max(...headerY) - Math.min(...headerY) > 20) return null;
  if (!(center(debit) < center(credit) && center(credit) < center(balance))) return null;
  return {
    type: /^(?:post|posting) date$/i.test(postDate.text) ? "central_bank" : "generic_statement",
    postDate: center(postDate),
    valueDate: valueDate ? center(valueDate) : null,
    description: center(description),
    debit: center(debit),
    credit: center(credit),
    balance: center(balance),
    width: page.width,
  };
}

function extractPnbRows(items, page, layout) {
  const references = items
    .filter((item) => /^[A-Z][A-Z0-9]{5,}$/i.test(item.text) && Math.abs(center(item) - layout.reference) < 28)
    .sort((left, right) => right.y - left.y);
  const rows = [];
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const date = items.find((item) => /^\d{2}-\d{2}-\d{4}$/.test(item.text) && Math.abs(item.y - reference.y) < 4 && Math.abs(center(item) - layout.date) < 28);
    if (!date) {
      throw new Error("PNB transaction/date alignment is uncertain");
    }
    const bounds = rowBounds(references, index);
    const debitAmount = money(columnCell(items, layout.debit, layout.debit - layout.gap / 2, layout.debit + layout.gap / 2, bounds));
    const creditAmount = money(columnCell(items, layout.credit, layout.credit - layout.gap / 2, layout.credit + layout.gap / 2, bounds));
    const balanceAmount = money(columnCell(items, layout.balance, layout.balance - layout.gap / 2, layout.balance + layout.gap / 2, bounds));
    if (Number(debitAmount > 0) + Number(creditAmount > 0) !== 1 || balanceAmount === null) {
      throw new Error("PNB transaction columns are incomplete");
    }
    // PNB descriptions wrap within roughly two text lines around the row
    // anchor. Tighten only the narration bounds so the final transaction does
    // not absorb the disclaimer immediately below the table.
    const narrationBounds = {
      top: Math.min(bounds.top, reference.y + 36),
      bottom: Math.max(bounds.bottom, reference.y - 36),
    };
    const narration = columnCell(
      items,
      layout.description,
      (layout.date + layout.description) / 2,
      layout.debit - layout.gap / 2,
      narrationBounds
    )
      .sort((left, right) => right.y - left.y || left.x - right.x)
      .map((item) => item.text)
      .join(" ")
      .trim();
    if (!narration) throw new Error("PNB transaction narration is incomplete");
    rows.push({
      reference: reference.text.toUpperCase(),
      sourceDate: date.text,
      narration,
      debitAmount,
      creditAmount,
      balanceAmount,
      page: page.pageNumber,
    });
  }
  return rows;
}

function extractCentralBankRows(items, page, layout) {
  const dates = items
    .filter((item) => /^\d{2}\/\d{2}\/\d{4}$/.test(item.text) && Math.abs(center(item) - layout.postDate) < 28)
    .sort((left, right) => right.y - left.y);
  const debitCreditBoundary = (layout.debit + layout.credit) / 2;
  const creditBalanceBoundary = (layout.credit + layout.balance) / 2;
  const rows = [];
  for (let index = 0; index < dates.length; index += 1) {
    const bounds = rowBounds(dates, index);
    const debitAmount = money(columnCell(items, layout.debit, layout.debit - (layout.credit - layout.debit) / 2, debitCreditBoundary, bounds));
    const creditAmount = money(columnCell(items, layout.credit, debitCreditBoundary, creditBalanceBoundary, bounds));
    const balanceAmount = money(columnCell(items, layout.balance, creditBalanceBoundary, page.width + 1, bounds));
    const narration = columnCell(
      items,
      layout.description,
      layout.valueDate
        ? (layout.valueDate + layout.description) / 2
        : (layout.postDate + layout.description) / 2,
      layout.debit - 20,
      bounds
    )
      .sort((left, right) => right.y - left.y || left.x - right.x)
      .map((item) => item.text)
      .join(" ")
      .trim();
    if (Number(debitAmount > 0) + Number(creditAmount > 0) !== 1 || balanceAmount === null) {
      throw new Error("Central Bank transaction columns are incomplete");
    }
    rows.push({
      reference: "",
      sourceDate: dates[index].text,
      narration,
      debitAmount,
      creditAmount,
      balanceAmount,
      page: page.pageNumber,
    });
  }
  return rows;
}

export function extractBankStatementPhysicalColumns(pages) {
  let layout = null;
  let detected = false;
  const rows = [];
  for (const page of pages) {
    const items = page.items
      .filter((item) => item.str?.trim())
      .map((item) => ({ text: normalizedText(item.str), x: item.transform[4], y: item.transform[5], width: item.width }));
    const detectedLayout = detectPnbLayout(items, page) || detectCentralBankLayout(items, page);
    if (detectedLayout) {
      if (layout && layout.type !== detectedLayout.type) throw new Error("Bank statement layout changed between pages");
      layout = detectedLayout;
      detected = true;
    }
    if (!layout) continue;
    if (Math.abs(page.width - layout.width) > 1) throw new Error(`${layout.type === "pnb" ? "PNB" : "bank statement"} continuation page width changed`);
    rows.push(...(layout.type === "pnb" ? extractPnbRows(items, page, layout) : extractCentralBankRows(items, page, layout)));
  }
  if (detected && rows.length === 0) throw new Error("Physical transaction columns were detected but no complete rows were found");
  if (detected && layout?.type === "pnb" && new Set(rows.map((row) => row.reference)).size !== rows.length) {
    throw new Error("PNB transaction references are incomplete or duplicated");
  }
  return { detected, layout: layout?.type ?? null, matchByOrder: false, rows, openingBalance: null };
}

export const extractPnbPhysicalColumns = extractBankStatementPhysicalColumns;

export async function readBankStatementPhysicalColumns(bytes, workerSrc, maxPages = 300) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 }).promise;
  try {
    if (pdf.numPages > maxPages) throw new Error("PDF page limit exceeded");
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const text = await page.getTextContent();
      pages.push({ pageNumber, width: page.view[2] - page.view[0], items: text.items });
      page.cleanup();
    }
    return extractBankStatementPhysicalColumns(pages);
  } finally {
    await pdf.destroy();
  }
}

export const readPnbPhysicalColumns = readBankStatementPhysicalColumns;

