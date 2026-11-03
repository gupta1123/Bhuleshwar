"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

// Visual language shared with the GSTReco prototype: warm cream surfaces,
// quiet borders, one dark action colour, tone-coded pills.
export type Tone = "ok" | "warn" | "bad" | "info" | "stone";

export const TONE: Record<Tone, string> = {
  ok: "border-[#a7f3d3] bg-[#ecfdf5] text-[#065f46]",
  warn: "border-[#fde68a] bg-[#fffbeb] text-[#78350f]",
  bad: "border-[#fecaca] bg-[#fef2f2] text-[#991b1b]",
  info: "border-[#bae6fd] bg-[#e0f2fe] text-[#0369a1]",
  stone: "border-[#e7e5e4] bg-[#f5f5f4] text-[#57534e]",
};

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-[#065f46]", warn: "text-[#78350f]", bad: "text-[#991b1b]", info: "text-[#0369a1]", stone: "text-[#57534e]",
};

export const TONE_BAR: Record<Tone, string> = {
  ok: "bg-[#7fc4a0]", warn: "bg-[#e3b667]", bad: "bg-[#dd9a95]", info: "bg-[#8fc0e0]", stone: "bg-[#b8ac9a]",
};

// Left edge colour on table rows, so the eye can scan for trouble.
export const TONE_EDGE: Record<Tone, string> = {
  ok: "shadow-[inset_3px_0_0_#a7f3d3]", warn: "shadow-[inset_3px_0_0_#fde68a]", bad: "shadow-[inset_3px_0_0_#fecaca]",
  info: "shadow-[inset_3px_0_0_#bae6fd]", stone: "",
};

export const BUCKET_TONE: Record<string, Tone> = {
  matched: "ok", valueDiff: "warn", periodShift: "warn", booksOnly: "bad", ineligible: "bad",
  rule37A: "bad", reopened: "bad", duplicate: "bad", portalOnly: "info",
};
export const toneOf = (bucket: string): Tone => BUCKET_TONE[bucket] ?? "stone";

export const card = "rounded-xl border border-[#ded8d0] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]";
export const inputCls = "h-8 rounded-lg border border-[#ded8d0] bg-white px-2.5 text-xs text-[#1a1a1a] outline-none focus:border-[#c9a86a] focus:ring-2 focus:ring-[#fef3c7]";
export const btn = "inline-flex min-h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 text-xs font-medium text-[#3d3530] shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:bg-[#ede6d9] disabled:cursor-not-allowed disabled:opacity-50";
export const btnPrimary = "inline-flex min-h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[#2f2924] bg-[#2f2924] px-3.5 text-xs font-semibold text-white hover:bg-[#1f1b18] disabled:cursor-not-allowed disabled:opacity-50";

export function Pill({ tone = "stone", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-[3px] text-[10.5px] font-semibold leading-[1.35] ${TONE[tone]}`}>{children}</span>;
}

export function Kpi({ label, value, note, icon, tone }: { label: string; value: string; note?: string; icon: ReactNode; tone?: Tone }) {
  return (
    <div className={`flex min-h-[112px] flex-col justify-between p-4 ${card}`}>
      <span className={`grid h-[30px] w-[30px] place-items-center rounded-lg border ${tone ? TONE[tone] : "border-[#ded8d0] bg-[#fbfaf8] text-[#5b4b3d]"}`}>{icon}</span>
      <div>
        <div className="text-[11px] font-medium text-[#8a7f72]">{label}</div>
        <div className={`mt-0.5 text-[23px] font-bold leading-tight tracking-tight tabular-nums ${tone === "bad" ? "text-[#991b1b]" : "text-[#1a1a1a]"}`}>{value}</div>
        {note && <div className="mt-1 text-[10.5px] text-[#8a7f72]">{note}</div>}
      </div>
    </div>
  );
}

export function Panel({ title, sub, action, children, className = "" }: { title?: string; sub?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`${card} p-4 ${className}`}>
      {(title || action) && (
        <header className="mb-3 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-[13px] font-semibold text-[#2b1a10]">{title}</h2>}
            {sub && <p className="mt-0.5 text-[11px] text-[#8a7f72]">{sub}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Alert({ tone = "stone", children }: { tone?: Tone; children: ReactNode }) {
  return <div role={tone === "bad" ? "alert" : undefined} className={`rounded-lg border px-3 py-2.5 text-[11.5px] leading-relaxed ${TONE[tone]}`}>{children}</div>;
}

export function Empty({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-[#ded8d0] bg-white px-5 py-12 text-center">
      <span className="text-[#b5a99a]">{icon}</span>
      <h3 className="text-[13px] font-semibold text-[#3d3530]">{title}</h3>
      <p className="max-w-[46ch] text-[11.5px] leading-relaxed text-[#8a7f72]">{text}</p>
      {action}
    </div>
  );
}

export const th = "sticky top-0 z-[1] h-9 whitespace-nowrap border-b border-[#e0d8cc] bg-[#f7f4ef] px-3 text-left text-[10.5px] font-bold uppercase tracking-[0.04em] text-[#3d3530]";
export const td = "px-3 py-2 text-xs text-[#5a5046] align-middle";

// Slide-over used for the invoice comparison.
export function Drawer({ open, onClose, title, subtitle, badges, footer, children }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; badges?: ReactNode; footer?: ReactNode; children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-[60] bg-[rgba(20,15,10,0.3)]" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-modal="true" className="fixed bottom-0 right-0 top-0 z-[61] flex w-[760px] max-w-[96vw] flex-col border-l border-[#ded8d0] bg-white shadow-[-16px_0_44px_rgba(0,0,0,0.12)]">
        <div className="flex items-start justify-between gap-3 border-b border-[#ece6dc] px-[18px] py-4">
          <div className="min-w-0">
            <h2 className="truncate font-mono text-sm font-semibold">{title}</h2>
            {subtitle && <p className="mt-1 text-[11.5px] text-[#8a7f72]">{subtitle}</p>}
          </div>
          <div className="flex flex-none items-center gap-1.5">
            {badges}
            <button onClick={onClose} aria-label="Close" className="grid h-7 w-7 place-items-center rounded-lg text-[#6f655a] hover:bg-[#fbfaf8]"><X className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-[18px] py-4">{children}</div>
        {footer && <div className="border-t border-[#ece6dc] bg-[#fbfaf8] px-[18px] py-3">{footer}</div>}
      </aside>
    </>
  );
}
