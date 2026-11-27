"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { fetchTallyPurchasePosting, type TallyPostingResponse } from "@/lib/tally-purchase-posting";

export function CaseVoucherQuickView({caseId, close}: {caseId: string; close: () => void}) {
  const [data, setData] = useState<TallyPostingResponse | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetchTallyPurchasePosting(caseId, null, null, controller.signal)
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message || "Voucher unavailable."); });
    return () => controller.abort();
  }, [caseId]);
  const r = data?.review;
  return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="max-h-[85vh] max-w-3xl overflow-auto">
    <DialogTitle>Purchase voucher{r?.invoiceNumber ? " ? " + r.invoiceNumber : ""}</DialogTitle>
    {error ? <p role="alert">{error}</p> : !data ? <p role="status">Loading voucher?</p> : !r ? <p>No purchase voucher details available.</p> : <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm">
        {data.posting?.tallyVoucherNumber && <><dt>Tally voucher no.</dt><dd>{data.posting.tallyVoucherNumber}</dd></>}
        <dt>Posting status</dt><dd>{data.posting?.status.replaceAll("_", " ") || "Not posted"}</dd>
        <dt>Supplier</dt><dd>{r.supplierName}</dd><dt>Party ledger</dt><dd>{r.supplierLedgerName || "Unselected"}</dd>
        <dt>Voucher date</dt><dd>{r.voucherDate}</dd><dt>Invoice total</dt><dd>?{r.invoiceTotal}</dd>
      </dl>
      <table className="w-full text-left text-sm"><thead><tr><th>Item</th><th>Quantity</th><th>Purchase ledger</th><th>Taxable amount</th></tr></thead>
      <tbody>{r.lines.map(line => <tr key={line.lineId}><td>{line.description}</td><td>{line.quantity} {line.unit}</td><td>{line.purchaseLedgerName || "Unselected"}</td><td>{line.taxableAmount}</td></tr>)}</tbody></table>
      {data.calculation && <dl className="grid grid-cols-[auto_1fr] gap-x-5 text-sm">
        <dt>GST</dt><dd>?{data.calculation.gstAmount}</dd><dt>Withholding</dt><dd>?{data.calculation.totalWithholdingAmount}</dd>
        <dt>Net payable</dt><dd>?{data.calculation.calculatedPayable}</dd>
      </dl>}
      {r.narration && <p>{r.narration}</p>}
    </>}
    <Link className="underline" href={`/cases/${caseId}/mismatches`}>Open full Tally review</Link>
  </DialogContent></Dialog>;
}
