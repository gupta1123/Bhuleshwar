"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Database, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";

import { PurchaseDocumentFolderSettings } from './PurchaseDocumentFolderSettings';
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SelectDropdown } from "@/components/ui/select-dropdown";
import { apiFetch } from "@/lib/api-client";
import { runCashDiscountLiveRequest } from "@/lib/cash-discount-live";
import { readPreferredTallyConnectionId } from "@/lib/tally-company-selection";

type Connection = { id: string; displayName?: string | null };
type Company = { id: string; companyName: string; companyGuid?: string | null; financialYear?: string | null };
type MasterKind = "ledger" | "stock" | "godown";
type Master = { guid: string; kind: MasterKind; name: string; parent: string | null };
type Defaults = Record<string, string>;
type DeductionKey = "purchaseGoodsTdsEnabled" | "transporterTdsEnabled" | "gstTdsEnabled";
export type DeductionSwitches = Record<DeductionKey, boolean>;

type LiveMaster = {
  guid?: unknown;
  name?: unknown;
  parent?: unknown;
};

type LivePurchaseMasterResult = {
  source?: unknown;
  validatedAt?: unknown;
  fetchedAt?: unknown;
  masters?: {
    ledgers?: unknown;
    stockItems?: unknown;
    godowns?: unknown;
  };
};

type FieldDefinition = { id: string; label: string; hint: string; kind: MasterKind; requires?: DeductionKey };

type Material = {
  hsn: string;
  name: string;
  starter: boolean;
  stockItem: string;
  localLedger: string;
  interstateLedger: string;
};
type MaterialField = "stockItem" | "localLedger" | "interstateLedger";

const MATERIAL_COLUMNS: ReadonlyArray<{ field: MaterialField; label: string; kind: MasterKind }> = [
  { field: "stockItem", label: "Stock item", kind: "stock" },
  { field: "localLedger", label: "Purchase ledger · within Maharashtra", kind: "ledger" },
  { field: "interstateLedger", label: "Purchase ledger · outside Maharashtra", kind: "ledger" },
];

const SECTIONS: ReadonlyArray<{ title: string; fields: ReadonlyArray<FieldDefinition> }> = [
  {
    title: "Godown",
    fields: [
      { id: "godown", label: "Default godown", hint: "Used when the documents name no godown", kind: "godown" },
    ],
  },
  {
    title: "GST, freight and round off",
    fields: [
      { id: "cgst", label: "Input CGST 9%", hint: "Same-state purchases", kind: "ledger" },
      { id: "sgst", label: "Input SGST 9%", hint: "Same-state purchases", kind: "ledger" },
      { id: "igst", label: "Input IGST 18%", hint: "Purchases from another state", kind: "ledger" },
      { id: "freight", label: "Freight inward", hint: "Transport charges billed on the invoice, booked once", kind: "ledger" },
      { id: "round-off", label: "Round off", hint: "Paise difference to the invoice total", kind: "ledger" },
    ],
  },
  {
    title: "TDS and TCS",
    fields: [
      { id: "tds-194q", label: "Section 194Q TDS", hint: "0.1% on goods", kind: "ledger", requires: "purchaseGoodsTdsEnabled" },
      { id: "transport-tds", label: "TDS on goods transport", hint: "1% or 2% on freight", kind: "ledger", requires: "transporterTdsEnabled" },
      { id: "cgst-tds", label: "CGST TDS 1%", hint: "GST TDS on scrap, same state", kind: "ledger", requires: "gstTdsEnabled" },
      { id: "sgst-tds", label: "SGST TDS 1%", hint: "GST TDS on scrap, same state", kind: "ledger", requires: "gstTdsEnabled" },
      { id: "igst-tds", label: "IGST TDS 2%", hint: "GST TDS on scrap, another state", kind: "ledger", requires: "gstTdsEnabled" },
      { id: "tcs", label: "TCS receivable", hint: "When the supplier collects TCS", kind: "ledger" },
    ],
  },
];

const SEARCH_PLACEHOLDER: Record<MasterKind, string> = {
  ledger: "Search ledgers…",
  stock: "Search stock items…",
  godown: "Search godowns…",
};

async function errorText(response: Response) {
  const payload = await response.json().catch(() => ({})) as { error?: string };
  return payload.error || `Request failed with status ${response.status}`;
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function describeSyncedCopy(value: LivePurchaseMasterResult) {
  const checkedAt = new Date(cleanText(value.validatedAt) || cleanText(value.fetchedAt));
  if (Number.isNaN(checkedAt.getTime())) return "Read through the connector";
  const when = checkedAt.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `Last checked with Tally ${when}`;
}

function mastersFromLiveResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as LivePurchaseMasterResult;
  if (result.source !== "live_tally" || !result.masters) return null;

  const convert = (values: unknown, kind: MasterKind) =>
    (Array.isArray(values) ? values : []).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const row = value as LiveMaster;
      const name = cleanText(row.name);
      if (!name) return [];
      return [{ guid: cleanText(row.guid), kind, name, parent: cleanText(row.parent) || null } satisfies Master];
    });

  const ledgers = convert(result.masters.ledgers, "ledger");
  if (ledgers.length === 0) return null;
  return [...ledgers, ...convert(result.masters.stockItems, "stock"), ...convert(result.masters.godowns, "godown")];
}

function cardClass() {
  return "rounded-xl border border-[#ded8d0] bg-white shadow-[0_1px_2px_rgba(52,42,32,0.04)]";
}

export function PurchasePostingDefaultsSettings({ deductions }: { deductions?: DeductionSwitches | null }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [masters, setMasters] = useState<Master[]>([]);
  const [defaults, setDefaults] = useState<Defaults>({});
  const [materials, setMaterials] = useState<Material[]>([]);
  const [newHsn, setNewHsn] = useState("");
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [masterSource, setMasterSource] = useState("");
  const [savingField, setSavingField] = useState("");
  const [savedField, setSavedField] = useState("");
  const [notice, setNotice] = useState("");
  const company = companies.find((entry) => entry.companyName === companyName);

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
        if (next.length === 0) setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setNotice(error instanceof Error ? error.message : "Could not load Tally connections.");
        setLoading(false);
      });
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
        setCompanyName(next.find((entry) => entry.id === payload.selectedCompanyId)?.companyName || next[0]?.companyName || "");
        if (next.length === 0) setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setNotice(error instanceof Error ? error.message : "Could not load Tally companies.");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [connectionId]);

  // Masters come through the connector. Opening the tab uses the connector's synced copy (fast);
  // Refresh asks the connector to check Tally for changed masters first, the same as the posting
  // review does. Godowns are always read directly from Tally.
  const refreshLiveMasters = useCallback(async (checkTally = false) => {
    if (!connectionId || !companyName) return;
    setRefreshing(true);
    setNotice("");
    try {
      const livePayload = await runCashDiscountLiveRequest<LivePurchaseMasterResult>({
        connectionId,
        companyName,
        companyGuid: company?.companyGuid,
        financialYear: company?.financialYear,
        operation: "ledger_masters",
        payload: {
          requestedMasterTypes: ["ledger", "group", "stock_item"],
          includeInventoryLocations: true,
          ...(checkTally ? { requireFresh: true } : {}),
        },
      });
      const live = mastersFromLiveResult(livePayload);
      if (!live) throw new Error("Tally returned no usable ledgers for this company.");
      setMasters(live);
      setMasterSource(checkTally ? "Checked with Tally just now" : describeSyncedCopy(livePayload));
    } catch (error) {
      setNotice(`${error instanceof Error ? error.message : "Could not read ledgers from Tally."} Saved choices are still shown — open the company in Tally and refresh to change them.`);
    } finally {
      setRefreshing(false);
    }
  }, [companyName, connectionId, company?.companyGuid, company?.financialYear]);

  useEffect(() => {
    if (!connectionId || !companyName) return;
    let cancelled = false;
    setLoading(true);
    setNotice("");
    setMasters([]);
    setMasterSource("");
    const query = new URLSearchParams({ connectionId, companyName });
    void apiFetch(`/api/settings/purchase-posting-defaults?${query}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorText(response));
        const payload = await response.json() as { defaults?: Defaults; materials?: Material[] };
        if (cancelled) return;
        setDefaults(payload.defaults ?? {});
        setMaterials(payload.materials ?? []);
      })
      .catch((error) => {
        if (!cancelled) setNotice(error instanceof Error ? error.message : "Could not load saved choices.");
      })
      .finally(() => !cancelled && setLoading(false));
    void refreshLiveMasters();
    return () => { cancelled = true; };
  }, [companyName, connectionId, refreshLiveMasters]);

  const mastersByKind = useMemo(() => {
    const group = (kind: MasterKind) => {
      const seen = new Set<string>();
      return masters
        .filter((master) => master.kind === kind && !seen.has(master.name) && Boolean(seen.add(master.name)))
        .sort((left, right) => left.name.localeCompare(right.name));
    };
    return { ledger: group("ledger"), stock: group("stock"), godown: group("godown") };
  }, [masters]);

  async function saveField(id: string, kind: MasterKind, name: string) {
    const previous = defaults[id] ?? "";
    if (name === previous) return;
    const picked = mastersByKind[kind].find((option) => option.name === name);
    setDefaults((current) => ({ ...current, [id]: name }));
    setSavingField(id);
    setSavedField("");
    setNotice("");
    try {
      const response = await apiFetch("/api/settings/purchase-posting-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, companyName, defaults: { [id]: name ? { name, guid: picked?.guid ?? "" } : "" } }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      setSavedField(id);
    } catch (error) {
      setDefaults((current) => ({ ...current, [id]: previous }));
      setNotice(error instanceof Error ? error.message : "Could not save this choice.");
    } finally {
      setSavingField("");
    }
  }

  async function putChange(body: Record<string, unknown>) {
    const response = await apiFetch("/api/settings/purchase-posting-defaults", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId, companyName, ...body }),
    });
    if (!response.ok) throw new Error(await errorText(response));
  }

  async function saveMaterialCell(material: Material, field: MaterialField, kind: MasterKind, name: string) {
    if (name === material[field]) return;
    const key = `${material.hsn}:${field}`;
    const picked = mastersByKind[kind].find((option) => option.name === name);
    const apply = (value: string) =>
      setMaterials((current) => current.map((row) => (row.hsn === material.hsn ? { ...row, [field]: value } : row)));
    apply(name);
    setSavingField(key);
    setSavedField("");
    setNotice("");
    try {
      await putChange({ material: { hsn: material.hsn, name: material.name, field, value: name ? { name, guid: picked?.guid ?? "" } : "" } });
      setSavedField(key);
    } catch (error) {
      apply(material[field]);
      setNotice(error instanceof Error ? error.message : "Could not save this choice.");
    } finally {
      setSavingField("");
    }
  }

  async function removeMaterial(material: Material) {
    const hasValues = Boolean(material.stockItem || material.localLedger || material.interstateLedger);
    setMaterials((current) => current.filter((row) => row.hsn !== material.hsn));
    if (!hasValues) return;
    setNotice("");
    try {
      await putChange({ removeMaterial: material.hsn });
    } catch (error) {
      setMaterials((current) => [...current, material].sort((left, right) => left.hsn.localeCompare(right.hsn)));
      setNotice(error instanceof Error ? error.message : "Could not remove this material.");
    }
  }

  function addMaterial() {
    const hsn = newHsn.replace(/\D/g, "");
    if (hsn.length < 2 || hsn.length > 8) {
      setNotice("Enter an HSN code of 2 to 8 digits, for example 7308 or 72142000.");
      return;
    }
    if (materials.some((row) => row.hsn === hsn)) {
      setNotice(`HSN ${hsn} is already in the list.`);
      return;
    }
    setNotice("");
    setMaterials((current) =>
      [...current, { hsn, name: newName.trim(), starter: false, stockItem: "", localLedger: "", interstateLedger: "" }]
        .sort((left, right) => left.hsn.localeCompare(right.hsn))
    );
    setNewHsn("");
    setNewName("");
  }

  // An empty cell falls back to the longest shorter HSN row that has a value, as posting does.
  function inheritedValue(material: Material, field: MaterialField) {
    return materials
      .filter((row) => row.hsn !== material.hsn && material.hsn.startsWith(row.hsn) && row[field])
      .sort((left, right) => right.hsn.length - left.hsn.length)[0];
  }

  const disabled = loading || !connectionId || !companyName;
  const counts = `${mastersByKind.ledger.length.toLocaleString("en-IN")} ledgers · ${mastersByKind.stock.length} items · ${mastersByKind.godown.length} godowns`;

  return (
    <>
      <section className={cardClass()}>
        <header className="flex flex-col gap-4 border-b border-[#e8e2db] px-5 py-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-bold tracking-tight text-[#111827]">Tally ledgers and items</h2>
            <p className="mt-1 max-w-2xl text-xs text-[#5b4b3d]">
              Filled in on every Purchase voucher for this company. Supplier ledgers are learned by GSTIN from confirmed vouchers. Choices save as soon as you pick them.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {connections.length > 1 ? (
              <SelectDropdown
                className="w-44"
                onChange={(value) => { setCompanyName(""); setCompanies([]); setConnectionId(value); }}
                options={connections.map((connection) => ({ value: connection.id, label: connection.displayName || "Tally workstation" }))}
                value={connectionId}
              />
            ) : null}
            {companies.length > 1 ? (
              <SelectDropdown
                className="w-64"
                onChange={setCompanyName}
                options={companies.map((entry) => ({ value: entry.companyName, label: entry.companyName }))}
                value={companyName}
              />
            ) : null}
            <button
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-[#ded8d0] bg-[#faf8f5] px-3 text-xs font-semibold text-[#332c26] transition hover:bg-[#f3eee8] disabled:cursor-not-allowed disabled:opacity-45"
              disabled={disabled || refreshing}
              onClick={() => void refreshLiveMasters(true)}
              type="button"
            >
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh from Tally
            </button>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[#f0ece4] bg-[#faf8f5] px-5 py-2.5 text-xs text-[#675d54]">
          <span className="inline-flex items-center gap-1.5 font-semibold text-[#2b1a10]">
            <Database className="h-3.5 w-3.5 text-[#8a7f72]" />
            {companyName || "No Tally company"}
          </span>
          {refreshing ? (
            <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />Reading Tally masters…</span>
          ) : masters.length ? (
            <>
              <span className="text-[#c8bfb0]">•</span>
              <span>{counts}</span>
              <span className="text-[#c8bfb0]">•</span>
              <span>{masterSource}</span>
            </>
          ) : null}
        </div>

        {notice ? (
          <p className="mx-5 mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{notice}
          </p>
        ) : null}

        {loading ? (
          <div className="space-y-2 px-5 py-5">
            {Array.from({ length: 6 }).map((_, index) => <div className="h-9 animate-pulse rounded-lg bg-[#ede6d9]/50" key={index} />)}
          </div>
        ) : (
          <div className="px-5 pb-2">
            <div className="flex flex-wrap items-end justify-between gap-2 pb-2 pt-5">
              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#8a7f72]">Materials by HSN</h3>
                <p className="mt-1 text-[11px] text-[#8a7f72]">The longest matching HSN wins. An empty cell uses the shorter row above it, e.g. 72044900 uses 7204.</p>
              </div>
            </div>
            <div className="overflow-hidden rounded-lg border border-[#e8e2db]">
              <div className="hidden grid-cols-[minmax(0,180px)_repeat(3,minmax(0,1fr))_28px] gap-3 border-b border-[#e8e2db] bg-[#faf8f5] px-3 py-2 text-[11px] font-semibold text-[#675d54] lg:grid">
                <span>HSN</span>
                {MATERIAL_COLUMNS.map((column) => <span key={column.field}>{column.label}</span>)}
                <span />
              </div>
              <div className="divide-y divide-[#f3efe9]">
                {materials.map((material) => (
                  <div className="grid gap-3 px-3 py-2.5 lg:grid-cols-[minmax(0,180px)_repeat(3,minmax(0,1fr))_28px] lg:items-center" key={material.hsn}>
                    <div className="min-w-0">
                      <span className="inline-flex rounded-md border border-[#ded8d0] bg-[#faf8f5] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[#2b1a10]">{material.hsn}</span>
                      <p className="mt-1 truncate text-xs font-semibold text-[#111827]" title={material.name}>{material.name || "Custom material"}</p>
                    </div>
                    {MATERIAL_COLUMNS.map((column) => {
                      const value = material[column.field];
                      const key = `${material.hsn}:${column.field}`;
                      const options = mastersByKind[column.kind];
                      const missing = Boolean(value && masters.length && !options.some((option) => option.name === value));
                      const inherited = value ? null : inheritedValue(material, column.field);
                      return (
                        <div className="min-w-0" key={column.field}>
                          <p className="mb-1 text-[11px] font-medium text-[#8a7f72] lg:hidden">{column.label}</p>
                          <div className="flex items-center gap-1.5">
                            <SearchableSelect
                              aria-label={`${column.label} for HSN ${material.hsn}`}
                              disabled={disabled || savingField === key}
                              emptyMessage={options.length ? "No matching master." : "Tally masters are not loaded. Use Refresh from Tally."}
                              invalid={missing}
                              onChange={(next) => void saveMaterialCell(material, column.field, column.kind, next)}
                              options={options.map((option) => ({ value: option.name, label: option.name, hint: option.parent }))}
                              placeholder={inherited ? `Uses ${inherited.hsn}: ${inherited[column.field]}` : "Not set"}
                              searchPlaceholder={SEARCH_PLACEHOLDER[column.kind]}
                              value={value}
                            />
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                              {savingField === key ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[#8a7f72]" />
                                : savedField === key ? <Check className="h-3.5 w-3.5 text-emerald-600" />
                                  : missing ? <AlertTriangle className="h-3.5 w-3.5 text-amber-600" /> : null}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                    <div className="flex justify-end">
                      {material.starter ? null : (
                        <button
                          aria-label={`Remove HSN ${material.hsn}`}
                          className="rounded-md p-1.5 text-[#776b61] transition hover:bg-[#f3eee8] hover:text-red-700 disabled:opacity-35"
                          disabled={disabled}
                          onClick={() => void removeMaterial(material)}
                          title="Remove material"
                          type="button"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <form
                className="flex flex-col gap-2 border-t border-[#e8e2db] bg-[#fdfcfa] px-3 py-2.5 sm:flex-row sm:items-center"
                onSubmit={(event) => { event.preventDefault(); addMaterial(); }}
              >
                <input
                  aria-label="New material HSN"
                  className="h-8 w-full rounded-lg border border-[#ded8d0] bg-white px-2.5 font-mono text-xs outline-none placeholder:font-sans placeholder:text-[#a89e92] focus:border-[#b9aa99] sm:w-36"
                  inputMode="numeric"
                  maxLength={10}
                  onChange={(event) => setNewHsn(event.target.value)}
                  placeholder="HSN, e.g. 7308"
                  value={newHsn}
                />
                <input
                  aria-label="New material name"
                  className="h-8 w-full rounded-lg border border-[#ded8d0] bg-white px-2.5 text-xs outline-none placeholder:text-[#a89e92] focus:border-[#b9aa99] sm:w-56"
                  maxLength={60}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="Name (optional), e.g. Structurals"
                  value={newName}
                />
                <button
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-[#ded8d0] bg-[#faf8f5] px-3 text-xs font-semibold text-[#332c26] transition hover:bg-[#f3eee8] disabled:opacity-45"
                  disabled={disabled || !newHsn.trim()}
                  type="submit"
                >
                  <Plus className="h-3.5 w-3.5" />Add material
                </button>
              </form>
            </div>

            {SECTIONS.map((section) => (
              <div key={section.title}>
                <h3 className="pb-1 pt-5 text-[11px] font-bold uppercase tracking-[0.14em] text-[#8a7f72]">{section.title}</h3>
                <div className="divide-y divide-[#f3efe9]">
                  {section.fields.map((field) => {
                    const saved = defaults[field.id] || "";
                    const options = mastersByKind[field.kind];
                    const missing = Boolean(saved && masters.length && !options.some((option) => option.name === saved));
                    const switchedOff = Boolean(field.requires && deductions && !deductions[field.requires]);
                    return (
                      <div className={`grid items-center gap-x-4 gap-y-1.5 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,340px)_16px] ${switchedOff ? "opacity-55" : ""}`} key={field.id}>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-[#111827]">{field.label}</p>
                          <p className="mt-0.5 text-[11px] text-[#8a7f72]">
                            {switchedOff ? "Not used while this deduction is switched off above" : missing ? <span className="text-amber-700">Not found in this Tally company — choose another</span> : field.hint}
                          </p>
                        </div>
                        <SearchableSelect
                          aria-label={field.label}
                          disabled={disabled || savingField === field.id}
                          emptyMessage={options.length ? "No matching master." : "Tally masters are not loaded. Use Refresh from Tally."}
                          invalid={missing}
                          onChange={(value) => void saveField(field.id, field.kind, value)}
                          options={options.map((option) => ({ value: option.name, label: option.name, hint: option.parent }))}
                          placeholder={refreshing && !options.length ? "Reading Tally…" : "Not set"}
                          searchPlaceholder={SEARCH_PLACEHOLDER[field.kind]}
                          value={saved}
                        />
                        <span className="hidden h-4 w-4 items-center justify-center sm:flex">
                          {savingField === field.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-[#8a7f72]" />
                          ) : savedField === field.id ? (
                            <Check className="h-3.5 w-3.5 text-emerald-600" />
                          ) : missing ? (
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                          ) : null}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={`${cardClass()} px-5 py-4`}>
        <PurchaseDocumentFolderSettings connectionId={connectionId} companyName={companyName}
          companyGuid={company?.companyGuid} financialYear={company?.financialYear} />
      </section>
    </>
  );
}
