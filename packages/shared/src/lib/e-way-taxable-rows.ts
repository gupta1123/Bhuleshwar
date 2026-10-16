/** Read printed monetary row totals, never quantities, from an E-Way Bill goods table. */
export function eWayTaxableRows(text: string): { total: number; rowCount: number } | null {
  const start = text.search(/\b(?:goods\s+(?:and\s+)?services|goods\s+details)\b/i);
  if (start < 0) return null;
  const tail = text.slice(start);
  const end = tail.search(/\b(?:references\s+and\s+transport|transportation\s+details|transport\s+details|part\s*[-–]?\s*b)\b/i);
  const table = end < 0 ? tail : tail.slice(0, end);
  if (!/\bHSN\s*\/?\s*SAC\b/i.test(table) || !/\bTaxable\s+(?:amount|value)\b/i.test(table)) return null;

  let totalPaise = 0;
  let rowCount = 0;
  for (const line of table.split(/\r?\n/)) {
    if (!/^\s*\|?\s*\d{1,3}\s*(?:\||\s)/.test(line) || !/\b\d{4,8}\b/.test(line)) continue;
    const amounts = [...line.matchAll(/(?:\bINR\b|\bRs\.?|₹)\s*(-?\d[\d,]*(?:\.\d{1,2})?)/gi)];
    // The first amount is normally the rate. The final amount is the printed
    // taxable row value; one isolated price is not sufficient evidence.
    if (amounts.length < 2) continue;
    const taxable = Number(amounts[amounts.length - 1][1].replace(/,/g, ""));
    if (!Number.isFinite(taxable) || taxable < 0 || taxable > 1_000_000_000) continue;
    totalPaise += Math.round(taxable * 100);
    rowCount += 1;
  }
  return rowCount ? { total: totalPaise / 100, rowCount } : null;
}
