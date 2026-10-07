import Link from "next/link";
import { ArrowUpRight, CheckCircle2, PackageOpen, TriangleAlert } from "lucide-react";

import type { ShipmentBatchCase } from "@/lib/case-persistence";
import { cn } from "@/lib/utils";

type ShipmentBatchPanelProps = {
  shipments?: ShipmentBatchCase[];
};

function getShipmentState(shipment: ShipmentBatchCase) {
  if (shipment.status === "accepted") return { label: "Approved", className: "text-emerald-700" };
  if (shipment.status === "rejected") return { label: "Rejected", className: "text-rose-700" };
  if (shipment.mismatchCount > 0) {
    return {
      label: `${shipment.mismatchCount} issue${shipment.mismatchCount === 1 ? "" : "s"}`,
      className: "text-amber-700",
    };
  }
  return { label: "Ready", className: "text-emerald-700" };
}

export function ShipmentBatchPanel({ shipments = [] }: ShipmentBatchPanelProps) {
  if (shipments.length <= 1) return null;

  const needingReview = shipments.filter(
    (shipment) => shipment.status !== "accepted" && shipment.status !== "rejected" && shipment.mismatchCount > 0
  ).length;
  const ready = shipments.filter(
    (shipment) => shipment.status === "completed" && shipment.mismatchCount === 0
  ).length;

  return (
    <section className="mb-3 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm sm:mb-4">
      <div className="flex flex-col gap-2 border-b border-slate-100 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-sky-50 text-sky-700">
            <PackageOpen className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-slate-950">Shipments from this upload</h2>
            <p className="text-xs text-slate-500">
              {shipments.length} organized shipments{needingReview ? ` · ${needingReview} need review` : ""}
              {ready ? ` · ${ready} ready` : ""}
            </p>
          </div>
        </div>
        <span className="w-fit rounded-full bg-slate-100 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-slate-600">
          This shipment
        </span>
      </div>

      <div className="divide-y divide-slate-100">
        {shipments.map((shipment) => {
          const state = getShipmentState(shipment);
          return (
            <Link
              key={shipment.id}
              href={`/cases/${shipment.id}`}
              aria-current={shipment.isCurrent ? "page" : undefined}
              className={cn(
                "group grid gap-2 px-3 py-3 transition-colors hover:bg-slate-50 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-4 sm:px-4",
                shipment.isCurrent && "bg-sky-50/60"
              )}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-xs text-slate-400">{shipment.shipmentIndex}.</span>
                  <span className="truncate text-sm text-slate-900">{shipment.displayName}</span>
                  {shipment.isCurrent ? (
                    <span className="shrink-0 rounded-full border border-sky-200 bg-white px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-sky-700">
                      Open
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-slate-500">
                  <span>{shipment.invoiceNumber || "Invoice reference unavailable"}</span>
                  <span>{shipment.documentCount} docs</span>
                </div>
              </div>
              <span className={cn("flex items-center gap-1.5 text-xs font-medium", state.className)}>
                {shipment.mismatchCount > 0 ? <TriangleAlert className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                {state.label}
              </span>
              <ArrowUpRight className="hidden h-4 w-4 text-slate-400 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 sm:block" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}
