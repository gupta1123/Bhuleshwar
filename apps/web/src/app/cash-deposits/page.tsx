"use client";

import { AppShell } from "@/components/dashboard/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sparkles,
  Receipt,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  CalendarDays,
  TrendingUp,
  Download,
  Filter,
} from "lucide-react";
import { useState } from "react";

export default function CashDepositsPage() {
  const [syncing, setSyncing] = useState(false);

  const mockDeposits = [
    { id: "1", date: "2026-07-06", amount: 45000, bank: "Kotak Mahindra Bank", status: "matched", desc: "Cash deposit - Branch 12" },
    { id: "2", date: "2026-07-05", amount: 85000, bank: "State Bank of India", status: "matched", desc: "Cash deposit - Daily collection" },
    { id: "3", date: "2026-07-03", amount: 12000, bank: "Kotak Mahindra Bank", status: "pending", desc: "Cash deposit - Counter 3" },
    { id: "4", date: "2026-07-02", amount: 35000, bank: "State Bank of India", status: "matched", desc: "Cash deposit - Counter 1" },
    { id: "5", date: "2026-07-01", amount: 95000, bank: "Kotak Mahindra Bank", status: "flagged", desc: "Discrepancy in counter deposit slip" },
  ];

  const handleSync = () => {
    setSyncing(true);
    setTimeout(() => setSyncing(false), 1500);
  };

  return (
    <AppShell>
      <main className="min-h-screen bg-[#f7f7f5] px-4 py-6 text-[#1a1a1a] sm:px-8 sm:py-8">
        <div className="mx-auto max-w-7xl space-y-6">
          
          {/* Header */}
          <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between border-b border-[#e5ddd0] pb-6">
            <div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 border border-amber-200/50 text-[10px] font-bold uppercase tracking-wider text-amber-800">
                <Sparkles className="h-3 w-3 text-amber-600 animate-spin duration-3000" />
                Deposit Reconciliation
              </div>
              <h1 className="text-3xl font-black tracking-tight text-[#1a1a1a] mt-2 flex items-center gap-2">
                Cash Deposits
              </h1>
              <p className="text-xs font-semibold text-slate-500 mt-1">
                Monitor counter cash collections, slips, and tally discrepancies against physical bank deposits.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSync}
                disabled={syncing}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-[#e5ddd0] bg-white px-4 text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm transition-all disabled:opacity-50"
              >
                {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TrendingUp className="h-3.5 w-3.5" />}
                Sync Tally Vouchers
              </button>
              <button
                className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-[#2d2d2d] px-4 text-xs font-bold text-white hover:bg-[#1a1a1a] shadow-sm transition-all"
              >
                <Download className="h-3.5 w-3.5" />
                Export Report
              </button>
            </div>
          </header>

          {/* Cards metrics */}
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Total Deposited", value: "₹2,72,000", desc: "This Month", icon: Receipt, iconColor: "text-amber-600 bg-amber-50 border-amber-200/50" },
              { label: "Auto-Matched", value: "₹1,65,000", desc: "4 transactions", icon: CheckCircle2, iconColor: "text-emerald-700 bg-emerald-50 border-emerald-200/50" },
              { label: "Pending Match", value: "₹12,000", desc: "Requires slip match", icon: CalendarDays, iconColor: "text-blue-700 bg-blue-50 border-blue-200/50" },
              { label: "Flagged Discrepancies", value: "₹95,000", desc: "Slip amount mismatch", icon: AlertTriangle, iconColor: "text-rose-700 bg-rose-50 border-rose-200/50" }
            ].map((metric) => {
              const Icon = metric.icon;
              return (
                <div key={metric.label} className="rounded-2xl border border-[#e5ddd0] bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.02)] transition hover:shadow-md">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{metric.label}</span>
                    <div className={`flex h-8 w-8 items-center justify-center rounded-xl border ${metric.iconColor}`}>
                      <Icon className="h-4.5 w-4.5" />
                    </div>
                  </div>
                  <div className="mt-3 text-2xl font-black text-[#1a1a1a]">{metric.value}</div>
                  <div className="mt-1 text-[11px] font-semibold text-slate-400">{metric.desc}</div>
                </div>
              );
            })}
          </section>

          {/* Deposits Log Table */}
          <section className="overflow-hidden rounded-2xl border border-[#e5ddd0] bg-white shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
            <div className="border-b border-[#e5ddd0] px-5 py-4 flex items-center justify-between">
              <h3 className="text-sm font-extrabold text-[#1a1a1a]">Deposits History</h3>
              <button className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] transition-all">
                <Filter className="h-3.5 w-3.5" />
                Filter Logs
              </button>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="bg-[#fcfbfa] text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="px-5 py-3">Date</th>
                    <th className="px-5 py-3">Narration / Counter</th>
                    <th className="px-5 py-3">Deposit Account</th>
                    <th className="px-5 py-3 text-right">Amount</th>
                    <th className="px-5 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#e5ddd0] text-slate-600 font-semibold">
                  {mockDeposits.map((row) => (
                    <tr key={row.id} className="align-middle hover:bg-[#fcfbfa]/60 transition-colors">
                      <td className="px-5 py-4 text-xs font-bold text-slate-500">{row.date}</td>
                      <td className="px-5 py-4">
                        <div className="text-sm font-extrabold text-[#1a1a1a]">{row.desc}</div>
                      </td>
                      <td className="px-5 py-4 text-xs font-bold text-[#1a1a1a]">{row.bank}</td>
                      <td className="px-5 py-4 text-right text-xs font-extrabold text-[#1a1a1a]">₹{row.amount.toLocaleString("en-IN")}</td>
                      <td className="px-5 py-4">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                            row.status === "matched"
                              ? "border-emerald-250 bg-emerald-50 text-emerald-800"
                              : row.status === "pending"
                                ? "border-blue-200 bg-blue-50 text-blue-800"
                                : "border-rose-250 bg-rose-50 text-rose-800"
                          }`}
                        >
                          {row.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          
        </div>
      </main>
    </AppShell>
  );
}
