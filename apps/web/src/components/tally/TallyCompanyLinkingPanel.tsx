"use client";

import { useCallback, useEffect, useState } from "react";
import { Link2, Loader2, ShieldCheck } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

type ObservedCompany = {
  companyGuid: string;
  companyName: string;
  financialYear: string;
  isActive: boolean;
  linkedCompanyId: string | null;
  linkedCompanyName: string | null;
};
type Payload = {
  observedCompanies?: ObservedCompany[];
  activeUnlinked?: ObservedCompany[];
  mappingConflicts?: Array<{ companyGuid: string; financialYear: string; companyIds: string[] }>;
  availableCompanies?: Array<{ id: string; name: string }>;
  error?: string;
};

export function TallyCompanyLinkingPanel({ connectionId, onLinked }: { connectionId: string; onLinked: () => void | Promise<void> }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const load = useCallback(async () => {
    const response = await apiFetch(`/api/tally/connections/${connectionId}/company-links`, { cache: "no-store" });
    const next = await response.json().catch(() => ({})) as Payload;
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      setHidden(true); return;
    }
    if (!response.ok) throw new Error(next.error || "Could not load company mapping.");
    setPayload(next); setHidden(false);
  }, [connectionId]);
  useEffect(() => { void load().catch((error) => setMessage(error instanceof Error ? error.message : "Could not load company mapping.")); }, [load]);
  // Inactive observations are retained by the API for history and diagnostics,
  // but they must not interrupt the normal connection flow.
  const unlinked = payload?.activeUnlinked || payload?.observedCompanies?.filter((company) => company.isActive && !company.linkedCompanyId) || [];
  if (hidden || (payload && unlinked.length === 0)) return null;
  const link = async (company: ObservedCompany) => {
    const key = `${company.companyGuid}\u0000${company.financialYear}`;
    const chosen = selection[key];
    if (!chosen) return;
    setBusyKey(key); setMessage(null);
    try {
      const response = await apiFetch(`/api/tally/connections/${connectionId}/company-links`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: chosen === "__create__" ? undefined : chosen,
          createCompany: chosen === "__create__",
          companyGuid: company.companyGuid,
          financialYear: company.financialYear,
        }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not link this company.");
      setMessage(`${company.companyName} is linked. Future reconnects on this connector will restore it automatically.`);
      await load();
      await onLinked();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not link this company.");
    } finally { setBusyKey(null); }
  };
  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-amber-700"><ShieldCheck className="h-5 w-5" /></div>
        <div>
          <h3 className="text-sm font-semibold text-[#24140c]">Link this Tally company once</h3>
          <p className="mt-1 text-xs leading-5 text-amber-900/75">Confirm which Kalika company owns each exact Tally GUID and financial year. The connector installation will remember this mapping across reconnects and updates.</p>
        </div>
      </div>
      <div className="mt-4 space-y-3">
        {unlinked.map((company) => {
          const key = `${company.companyGuid}\u0000${company.financialYear}`;
          return <div key={key} className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-white p-4 lg:flex-row lg:items-center">
            <div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-[#24140c]">{company.companyName}</p><p className="mt-1 text-[11px] text-[#8a7f72]">{company.financialYear} · GUID {company.companyGuid}</p></div>
            <select aria-label={`Application company for ${company.companyName}`} className="h-9 min-w-56 rounded-lg border border-[#d8ccbc] bg-white px-3 text-xs" value={selection[key] || ""} onChange={(event) => setSelection((current) => ({ ...current, [key]: event.target.value }))}>
              <option value="">Choose company…</option>
              {(payload?.availableCompanies || []).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
              <option value="__create__">Create “{company.companyName}”</option>
            </select>
            <Button className="h-9 rounded-lg text-xs" disabled={!selection[key] || busyKey === key} onClick={() => void link(company)}>
              {busyKey === key ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Link2 className="mr-1.5 h-3.5 w-3.5" />}Link company
            </Button>
          </div>;
        })}
      </div>
      {message ? <p className="mt-3 text-xs text-amber-900">{message}</p> : null}
    </section>
  );
}
