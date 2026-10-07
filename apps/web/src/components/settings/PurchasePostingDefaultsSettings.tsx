"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PurchaseDocumentFolderSettings } from './PurchaseDocumentFolderSettings';
import { apiFetch } from "@/lib/api-client";
import { runCashDiscountLiveRequest } from "@/lib/cash-discount-live";
import { readPreferredTallyConnectionId } from "@/lib/tally-company-selection";

type Connection = { id: string; displayName?: string | null };
type Company = { id: string; companyName: string; companyGuid?: string | null; financialYear?: string | null };
type Master = { id: string; type: string; name: string; parent: string | null };
type Defaults = Record<string, string>;

type LiveMaster = {
  guid?: unknown;
  name?: unknown;
  parent?: unknown;
};

type LivePurchaseMasterResult = {
  source?: unknown;
  companyName?: unknown;
  fetchedAt?: unknown;
  masters?: {
    ledgers?: unknown;
    stockItems?: unknown;
  };
  totals?: Record<string, unknown>;
};

const SECTIONS = [
  {
    title: "Items",
    description: "HSN 7204 includes longer scrap codes such as 72044900.",
    fields: [
      ["ms-scrap-item", "MS Scrap · HSN 7204…", "stock"],
      ["sponge-iron-item", "Sponge Iron · HSN 72031000", "stock"],
    ],
  },
  {
    title: "Purchase ledgers",
    description: "Local means supplier and buyer states match; otherwise interstate is used.",
    fields: [
      ["ms-scrap-local", "MS Scrap · Maharashtra", "ledger"],
      ["ms-scrap-interstate", "MS Scrap · outside Maharashtra", "ledger"],
      ["sponge-local", "Sponge Iron · Maharashtra", "ledger"],
      ["sponge-interstate", "Sponge Iron · outside Maharashtra", "ledger"],
    ],
  },
  {
    title: "GST and deductions",
    description: "These are defaults only; every voucher is still reconciled before posting.",
    fields: [
      ["cgst", "Input CGST 9%", "ledger"],
      ["sgst", "Input SGST 9%", "ledger"],
      ["igst", "Input IGST 18%", "ledger"],
      ["tds-194q", "Section 194Q TDS", "ledger"],
      ["cgst-tds", "CGST TDS 1%", "ledger"],
      ["sgst-tds", "SGST TDS 1%", "ledger"],
      ["igst-tds", "IGST TDS 2%", "ledger"],
      ["freight", "Freight inward", "ledger"],
      ["round-off", "Round off", "ledger"],
    ],
  },
] as const;

async function errorText(response: Response) {
  const payload = await response.json().catch(() => ({})) as { error?: string };
  return payload.error || `Request failed with status ${response.status}`;
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function mastersFromLiveResult(value: unknown): {
  masters: Master[];
  ledgerCount: number;
  stockItemCount: number;
  fetchedAt: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as LivePurchaseMasterResult;
  if (result.source !== "live_tally" || !result.masters) return null;

  const convert = (values: unknown, type: "ledger" | "stock_item") =>
    (Array.isArray(values) ? values : []).flatMap((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const row = value as LiveMaster;
      const name = cleanText(row.name);
      if (!name) return [];
      const guid = cleanText(row.guid);
      return [{
        id: guid || `live:${type}:${index}:${name.toLocaleLowerCase()}`,
        type,
        name,
        parent: cleanText(row.parent) || null,
      } satisfies Master];
    });

  const ledgers = convert(result.masters.ledgers, "ledger");
  const stockItems = convert(result.masters.stockItems, "stock_item");
  if (ledgers.length === 0) return null;
  return {
    masters: [...ledgers, ...stockItems],
    ledgerCount: ledgers.length,
    stockItemCount: stockItems.length,
    fetchedAt: cleanText(result.fetchedAt),
  };
}

export function PurchasePostingDefaultsSettings() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [masters, setMasters] = useState<Master[]>([]);
  const [defaults, setDefaults] = useState<Defaults>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [liveSummary, setLiveSummary] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiFetch("/api/tally/connections", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorText(response));
        return response.json() as Promise<{ connections?: Connection[] }>;
      })
      .then((payload) => {
        if (cancelled) return;
        const next = payload.connections ?? [];
        const preferred = readPreferredTallyConnectionId();
        setConnections(next);
        setConnectionId(next.find((connection) => connection.id === preferred)?.id || next[0]?.id || "");
      })
      .catch((error) => !cancelled && setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load Tally connections." }))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!connectionId) {
      setCompanies([]);
      setCompanyName("");
      return;
    }
    let cancelled = false;
    void apiFetch(`/api/tally/companies?connectionId=${encodeURIComponent(connectionId)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorText(response));
        return response.json() as Promise<{ companies?: Company[]; selectedCompanyId?: string | null }>;
      })
      .then((payload) => {
        if (cancelled) return;
        const next = payload.companies ?? [];
        setCompanies(next);
        setCompanyName(next.find((company) => company.id === payload.selectedCompanyId)?.companyName || next[0]?.companyName || "");
      })
      .catch((error) => !cancelled && setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load Tally companies." }));
    return () => { cancelled = true; };
  }, [connectionId]);

  const refreshLiveMasters = useCallback(async () => {
    if (!connectionId || !companyName) return;
    setRefreshing(true);
    setNotice(null);
    setLiveSummary("");
    try {
      const livePayload = await runCashDiscountLiveRequest<LivePurchaseMasterResult>({
        connectionId,
        companyName,
        operation: "ledger_masters",
        payload: { requestedMasterTypes: ["ledger", "group", "stock_item"] },
      });
      const live = mastersFromLiveResult(livePayload);
      if (!live) throw new Error("Tally returned no usable ledgers for this company.");
      setMasters(live.masters);
      const summary = `${live.ledgerCount} ledgers and ${live.stockItemCount} items loaded live from Tally`;
      setLiveSummary(summary);
      setNotice({ tone: "success", text: summary + "." });
    } catch (error) {
      setNotice({
        tone: "error",
        text: `${error instanceof Error ? error.message : "Could not refresh live Tally masters."} Any last synced choices remain available below.`,
      });
    } finally {
      setRefreshing(false);
    }
  }, [companyName, connectionId]);

  useEffect(() => {
    if (!connectionId || !companyName) return;
    let cancelled = false;
    setLoading(true);
    setNotice(null);
    setLiveSummary("");
    const query = new URLSearchParams({ connectionId, companyName });
    void Promise.all([
      apiFetch(`/api/settings/purchase-posting-defaults?${query}`, { cache: "no-store" }),
      apiFetch(`/api/tally/connections/${connectionId}/masters?all=true&companyName=${encodeURIComponent(companyName)}`, { cache: "no-store" }),
    ]).then(async ([defaultsResponse, mastersResponse]) => {
      if (!defaultsResponse.ok) throw new Error(await errorText(defaultsResponse));
      if (!mastersResponse.ok) throw new Error(await errorText(mastersResponse));
      const defaultsPayload = await defaultsResponse.json() as { defaults?: Defaults };
      const mastersPayload = await mastersResponse.json() as { masters?: Master[] };
      if (cancelled) return;
      setDefaults(defaultsPayload.defaults ?? {});
      const cachedMasters = mastersPayload.masters ?? [];
      setMasters(cachedMasters);
      // A new company may not have a persisted snapshot yet. Populate the
      // controls once through the direct live channel, never by queueing a
      // background command and polling old command rows.
      if (cachedMasters.length === 0) {
        await refreshLiveMasters();
      }
    }).catch((error) => {
      if (!cancelled) setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load Purchase defaults." });
    }).finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [companyName, connectionId, refreshLiveMasters]);

  const ledgerOptions = useMemo(() => masters.filter((master) => ["ledger", "gst_ledger", "tax_ledger"].includes(master.type)), [masters]);
  const stockOptions = useMemo(() => masters.filter((master) => master.type === "stock_item"), [masters]);

  async function save() {
    if (!connectionId || !companyName) return;
    setSaving(true);
    setNotice(null);
    try {
      const response = await apiFetch("/api/settings/purchase-posting-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, companyName, defaults }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      setNotice({ tone: "success", text: `Purchase defaults saved for ${companyName}.` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not save Purchase defaults." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-5 space-y-4">
      <section className="rounded-[10px] border border-[#e8e5de] bg-white px-6 py-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a7f72]">Per-company Tally defaults</p>
        <h2 className="mt-1 text-base font-bold tracking-tight text-[#111827]">Choose the masters used for Purchase vouchers</h2>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-[#5b4b3d]">Supplier ledgers remain searchable from the complete Tally catalogue and are remembered by GSTIN after confirmation.</p>
          <Button
            disabled={loading || refreshing || !connectionId || !companyName}
            onClick={() => void refreshLiveMasters()}
            size="sm"
            variant="outline"
          >
            {refreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh from Tally
          </Button>
        </div>
        {liveSummary ? <p className="mt-2 text-xs font-medium text-emerald-700"><Check className="mr-1 inline h-4 w-4" />{liveSummary}</p> : null}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-[#5b4b3d]">Tally workstation
            <select className="mt-1 h-10 w-full rounded-lg border border-[#ddd7cc] bg-white px-3" onChange={(event) => { setCompanyName(''); setCompanies([]); setConnectionId(event.target.value); }} value={connectionId}>
              {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName || "Tally workstation"}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-[#5b4b3d]">Tally company
            <select className="mt-1 h-10 w-full rounded-lg border border-[#ddd7cc] bg-white px-3" onChange={(event) => setCompanyName(event.target.value)} value={companyName}>
              {companies.map((company) => <option key={company.id} value={company.companyName}>{company.companyName}</option>)}
            </select>
          </label>
        </div>
      </section>

      <PurchaseDocumentFolderSettings connectionId={connectionId} companyName={companyName}
        companyGuid={companies.find(company => company.companyName === companyName)?.companyGuid}
        financialYear={companies.find(company => company.companyName === companyName)?.financialYear} />
      {loading ? <div className="flex items-center justify-center rounded-lg border border-[#e8e5de] bg-white p-8 text-xs text-[#5b4b3d]"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading saved Tally masters…</div> : SECTIONS.map((section) => (
        <section className="rounded-[10px] border border-[#e8e5de] bg-white px-6 py-5" key={section.title}>
          <h3 className="text-sm font-bold text-[#111827]">{section.title}</h3>
          <p className="mt-1 text-xs text-[#8a7f72]">{section.description}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {section.fields.map(([id, label, kind]) => {
              const options = kind === "stock" ? stockOptions : ledgerOptions;
              return <label className="text-xs font-medium text-[#5b4b3d]" key={id}>{label}
                <select className="mt-1 h-10 w-full rounded-lg border border-[#ddd7cc] bg-white px-3 text-xs" onChange={(event) => setDefaults((current) => ({ ...current, [id]: event.target.value }))} value={defaults[id] || ""}>
                  <option value="">Choose from Tally…</option>
                  {options.map((option) => <option key={`${option.type}:${option.id}`} value={option.name}>{option.name}{option.parent ? ` — ${option.parent}` : ""}</option>)}
                </select>
              </label>;
            })}
          </div>
        </section>
      ))}

      {notice ? <div className={`rounded-lg border px-4 py-3 text-sm ${notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-700"}`}>{notice.tone === "success" ? <Check className="mr-2 inline h-4 w-4" /> : null}{notice.text}</div> : null}
      <div className="flex justify-end"><Button disabled={loading || refreshing || saving || !connectionId || !companyName} onClick={() => void save()}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Save Purchase defaults</Button></div>
    </div>
  );
}
