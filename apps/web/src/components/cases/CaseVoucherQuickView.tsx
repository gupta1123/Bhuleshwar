"use client";

import dynamic from "next/dynamic";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

const VoucherPanel = dynamic(
  () => import("./TallyPurchasePostingPanel").then(module => module.TallyPurchasePostingPanel),
  { loading: () => <p className="p-4 text-sm" role="status">Loading voucher...</p> }
);

export function CaseVoucherQuickView({caseId, title, close}: {caseId: string; title: string; close: () => void}) {
  return (
    <Dialog open onOpenChange={open => { if (!open) close(); }}>
      <DialogContent placement="right" aria-describedby={undefined} className="max-w-4xl gap-0 p-0">
        <DialogTitle className="border-b px-5 py-4 pr-16 text-base">Voucher for {title}</DialogTitle>
        <div className="min-h-0 flex-1 overflow-y-auto bg-[#f7f4ef]">
          <VoucherPanel key={caseId} caseId={caseId} quickView />
        </div>
      </DialogContent>
    </Dialog>
  );
}
