export type FifoOpenBill = {
  referenceName: string;
  voucherNumber?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  pendingAmount: number;
};

export type FifoBillAllocation = {
  referenceType: "Agst Ref" | "Advance";
  referenceName: string;
  voucherNumber?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  previousPendingAmount?: number | null;
  allocatedAmount: number;
  pendingAmountAfterAllocation?: number | null;
  statusAfterAllocation?: string | null;
};

function billOrderDate(bill: FifoOpenBill) {
  return bill.dueDate || bill.invoiceDate || "9999-12-31";
}

export function allocateReceiptByFifo(
  receiptAmount: number,
  openBills: FifoOpenBill[],
  advanceReference: string,
  preferredReferenceName?: string | null
) {
  const preferredReference = preferredReferenceName?.trim().toLocaleLowerCase() || "";
  const orderedBills = [...openBills].sort((left, right) => {
    const leftPreferred = preferredReference && left.referenceName.trim().toLocaleLowerCase() === preferredReference;
    const rightPreferred = preferredReference && right.referenceName.trim().toLocaleLowerCase() === preferredReference;
    if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
    return (
      billOrderDate(left).localeCompare(billOrderDate(right)) ||
      left.referenceName.localeCompare(right.referenceName)
    );
  });

  let remaining = Number(Math.max(0, receiptAmount).toFixed(2));
  const allocations: FifoBillAllocation[] = [];

  for (const bill of orderedBills) {
    if (remaining <= 0.005) break;
    const pendingAmount = Number(Math.max(0, Number(bill.pendingAmount) || 0).toFixed(2));
    if (pendingAmount <= 0.005) continue;
    const allocatedAmount = Number(Math.min(remaining, pendingAmount).toFixed(2));
    remaining = Number(Math.max(0, remaining - allocatedAmount).toFixed(2));
    allocations.push({
      referenceType: "Agst Ref",
      referenceName: bill.referenceName,
      voucherNumber: bill.voucherNumber,
      invoiceDate: bill.invoiceDate,
      dueDate: bill.dueDate,
      previousPendingAmount: pendingAmount,
      allocatedAmount,
      pendingAmountAfterAllocation: Number((pendingAmount - allocatedAmount).toFixed(2)),
      statusAfterAllocation: pendingAmount - allocatedAmount <= 0.005 ? "cleared" : "partially_settled",
    });
  }

  const newAdvanceAmount = remaining;
  if (newAdvanceAmount > 0.005) {
    allocations.push({
      referenceType: "Advance",
      referenceName: advanceReference,
      allocatedAmount: newAdvanceAmount,
      pendingAmountAfterAllocation: newAdvanceAmount,
      statusAfterAllocation: "advance",
    });
  }

  const totalAllocatedAmount = Number(
    allocations.reduce((total, allocation) => total + allocation.allocatedAmount, 0).toFixed(2)
  );

  return {
    allocations,
    newAdvanceAmount,
    orderedBills,
    totalAllocatedAmount,
    unallocatedAmount: Number(Math.max(0, receiptAmount - totalAllocatedAmount).toFixed(2)),
  };
}

export function applyFifoAllocationsToBills(
  openBills: FifoOpenBill[],
  allocations: FifoBillAllocation[]
) {
  const consumed = new Map<string, number>();
  for (const allocation of allocations) {
    if (allocation.referenceType !== "Agst Ref") continue;
    const key = allocation.referenceName.trim().toLocaleLowerCase();
    consumed.set(key, Number(((consumed.get(key) || 0) + allocation.allocatedAmount).toFixed(2)));
  }
  return openBills.flatMap((bill) => {
    const pendingAmount = Number(Math.max(
      0,
      bill.pendingAmount - (consumed.get(bill.referenceName.trim().toLocaleLowerCase()) || 0)
    ).toFixed(2));
    return pendingAmount > 0.005 ? [{ ...bill, pendingAmount }] : [];
  });
}
