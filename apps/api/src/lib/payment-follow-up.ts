export const PAYMENT_FOLLOW_UP_GRACE_DAYS = 7;

export type PaymentFollowUpAgeBasis = "due_date" | "invoice_date" | "missing_dates";

export type PaymentFollowUpTiming = {
  eligible: boolean;
  ageBasis: PaymentFollowUpAgeBasis;
  ageDays: number | null;
  ageLabel: string;
  dueDate: string | null;
  invoiceDate: string | null;
};

export type PaymentFollowUpStatus =
  | "debit_note_required"
  | "needs_follow_up"
  | "escalate"
  | "needs_review";

type BillDates = {
  dueDate?: string | null;
  invoiceDate?: string | null;
};

type PriorityFollowUp = {
  followUpStatus: PaymentFollowUpStatus;
  ageBasis: PaymentFollowUpAgeBasis;
  ageDays: number | null;
  outstandingAmount: number;
  partyLedgerName: string;
};

export function isCollectionOnlyPaymentFollowUp(row: { followUpStatus: PaymentFollowUpStatus }) {
  return row.followUpStatus !== "debit_note_required";
}

function validDateText(value: string | null | undefined) {
  const dateText = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return null;
  const parsed = Date.parse(`${dateText}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10) === dateText ? dateText : null;
}

function elapsedDays(fromDate: string, toDate: string) {
  return Math.floor(
    (Date.parse(`${toDate}T00:00:00.000Z`) - Date.parse(`${fromDate}T00:00:00.000Z`)) /
      86_400_000
  );
}

export function derivePaymentFollowUpTiming(
  bill: BillDates,
  today: string,
  graceDays = PAYMENT_FOLLOW_UP_GRACE_DAYS
): PaymentFollowUpTiming {
  const currentDate = validDateText(today);
  const dueDate = validDateText(bill.dueDate);
  const invoiceDate = validDateText(bill.invoiceDate);

  if (!currentDate) {
    return {
      eligible: false,
      ageBasis: "missing_dates",
      ageDays: null,
      ageLabel: "Current business date unavailable",
      dueDate,
      invoiceDate,
    };
  }

  if (dueDate) {
    const ageDays = elapsedDays(dueDate, currentDate);
    const shownDays = Math.max(ageDays, 0);
    return {
      eligible: ageDays >= graceDays,
      ageBasis: "due_date",
      ageDays,
      ageLabel: `${shownDays} day${shownDays === 1 ? "" : "s"} overdue`,
      dueDate,
      invoiceDate,
    };
  }

  if (invoiceDate) {
    const ageDays = elapsedDays(invoiceDate, currentDate);
    const shownDays = Math.max(ageDays, 0);
    return {
      eligible: ageDays >= graceDays,
      ageBasis: "invoice_date",
      ageDays,
      ageLabel: `${shownDays} day${shownDays === 1 ? "" : "s"} since invoice`,
      dueDate: null,
      invoiceDate,
    };
  }

  return {
    eligible: true,
    ageBasis: "missing_dates",
    ageDays: null,
    ageLabel: "Invoice and due dates missing",
    dueDate: null,
    invoiceDate: null,
  };
}

export function sortPaymentFollowUpsByPriority<T extends PriorityFollowUp>(rows: T[]) {
  const basisRank: Record<PaymentFollowUpAgeBasis, number> = {
    due_date: 1,
    invoice_date: 2,
    missing_dates: 3,
  };

  return [...rows].sort((left, right) => {
    const leftRank = basisRank[left.ageBasis];
    const rightRank = basisRank[right.ageBasis];
    if (leftRank !== rightRank) return leftRank - rightRank;

    const ageDifference = (right.ageDays ?? -1) - (left.ageDays ?? -1);
    if (ageDifference !== 0) return ageDifference;

    const amountDifference = right.outstandingAmount - left.outstandingAmount;
    if (amountDifference !== 0) return amountDifference;

    return left.partyLedgerName.localeCompare(right.partyLedgerName);
  });
}
