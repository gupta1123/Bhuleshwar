export type BankBookRow = {
  date: string;
  party: string;
  voucherNumber: string;
  receipt: number;
  payment: number;
};

export function buildBankBookCsv(bank: string, period: string, entries: BankBookRow[], balances?: { opening: number; closing: number }) {
  const escape = (value: string | number) => {
    const text = String(value);
    // Keep ledger names and voucher references literal when opened in Excel.
    const safe = /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return "\uFEFF" + buildBankBookRows(bank, period, entries, balances).map(row => row.map(escape).join(",")).join("\r\n") + "\r\n";
}

export function buildBankBookRows(bank: string, period: string, entries: BankBookRow[], balances?: { opening: number; closing: number }) {
  const money = (cents: number) => cents ? (cents / 100).toFixed(2) : "";
  const rows: (string | number)[][] = [
    [`${bank} Book`, "", "", "", "", "", "", "", ""],
    [period, "", "", "", "", "", "", "", ""],
    ["Date", "To/By", "Particulars", "", "", "Vch Type", "Vch No.", "Debit", "Credit"],
  ];
  let debit = 0, credit = 0;
  if (balances) {
    const opening = Math.round(balances.opening * 100);
    debit += Math.max(opening, 0); credit += Math.max(-opening, 0);
    rows.push([entries[0]?.date || "", opening >= 0 ? "To" : "By", "Opening Balance", "", "", "", "", money(Math.max(opening, 0)), money(Math.max(-opening, 0))]);
  }
  // Stable partition preserves statement order within each voucher type.
  for (const row of [...entries.filter(r => r.receipt > 0), ...entries.filter(r => r.payment > 0)]) {
    const dr = Math.round(row.receipt * 100), cr = Math.round(row.payment * 100);
    debit += dr; credit += cr;
    rows.push([row.date, dr ? "To" : "By", row.party, "", "", dr ? "Receipt" : "Payment", row.voucherNumber, money(dr), money(cr)]);
  }
  rows.push(["", "", "Total", "", "", "", "", money(debit), money(credit)]);
  if (balances) {
    const closing = Math.round(balances.closing * 100);
    rows.push(["", closing >= 0 ? "By" : "To", "Closing Balance", "", "", "", "", money(Math.max(-closing, 0)), money(Math.max(closing, 0))]);
    rows.push(["", "", "Grand Total", "", "", "", "", money(debit + Math.max(-closing, 0)), money(credit + Math.max(closing, 0))]);
  }
  return rows;
}
