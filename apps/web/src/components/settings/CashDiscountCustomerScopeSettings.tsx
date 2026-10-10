"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Layers3,
  Loader2,
  Monitor,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-client";
import { runCashDiscountLiveRequest } from "@/lib/cash-discount-live";
import { readPreferredTallyConnectionId } from "@/lib/tally-company-selection";

type Mode = "automatic" | "custom" | "strict";
type Scope = {
  mode: Mode;
  selectedGroupNames: string[];
  includeNestedGroups: boolean;
  detectSalesLinkedExceptions: boolean;
  excludedGroupNames: string[];
  excludedLedgerNames: string[];
};
type Connection = { id: string; displayName?: string | null; lastCompanyName?: string | null; bridgeConnected?: boolean };
type Company = { id: string; connectionId: string; companyName: string; isActive?: boolean };
type Group = { id: string; name: string; parent: string | null };
type GroupMastersPayload = {
  masters?: Group[];
  latestSync?: { completed_at?: string | null } | null;
};

const DEFAULT_SCOPE: Scope = {
  mode: "automatic",
  selectedGroupNames: ["Sundry Debtors"],
  includeNestedGroups: true,
  detectSalesLinkedExceptions: true,
  excludedGroupNames: [],
  excludedLedgerNames: [],
};

function normalizedName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function looksLikeCustomerGroup(group: Group) {
  return /debtor|receivable|customer|dealer|distributor|trade debtor/i.test(
    `${group.name} ${group.parent || ""}`
  );
}

async function responseError(response: Response) {
  const payload = await response.json().catch(() => ({})) as { error?: string };
  return payload.error || `Request failed with status ${response.status}`;
}

async function refreshTallyGroups(connectionId: string, companyName: string) {
  const live = await runCashDiscountLiveRequest<{ groups?: Group[] }>({
    connectionId,
    companyName,
    operation: "ledger_masters",
  });
  return {
    masters: live.groups ?? [],
    latestSync: { completed_at: new Date().toISOString() },
  } satisfies GroupMastersPayload;
}

function formatGroupRefreshTime(value: string | null) {
  if (!value) return "Saved groups loaded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Saved groups loaded";
  return `Last refreshed ${new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)}`;
}

function Toggle({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden="true" className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${checked ? "bg-[#2b1a10]" : "bg-[#ded8d0]"}`}>
      <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${checked ? "translate-x-4" : "translate-x-0"}`} />
    </span>
  );
}

export function CashDiscountCustomerScopeSettings() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [scope, setScope] = useState<Scope>(DEFAULT_SCOPE);
  const [savedScope, setSavedScope] = useState<Scope>(DEFAULT_SCOPE);
  const [query, setQuery] = useState("");
  const [showAllGroups, setShowAllGroups] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expandedGroupNames, setExpandedGroupNames] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshingGroups, setRefreshingGroups] = useState(false);
  const [groupRefreshError, setGroupRefreshError] = useState<string | null>(null);
  const [groupsRefreshedAt, setGroupsRefreshedAt] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch("/api/tally/connections", { cache: "no-store" });
        if (!response.ok) throw new Error(await responseError(response));
        const payload = await response.json() as { connections?: Connection[] };
        const next = payload.connections ?? [];
        const preferred = readPreferredTallyConnectionId();
        if (!cancelled) {
          setConnections(next);
          setConnectionId(next.find((item) => item.id === preferred)?.id || next[0]?.id || "");
        }
      } catch (error) {
        if (!cancelled) setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load Tally connections." });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!connectionId) {
      setCompanies([]);
      setCompanyName("");
      return;
    }
    let cancelled = false;
    void (async () => {
      const response = await apiFetch(`/api/tally/companies?connectionId=${encodeURIComponent(connectionId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const payload = await response.json() as { companies?: Company[]; selectedCompanyId?: string | null };
      const next = (payload.companies ?? []).filter((company, index, all) =>
        all.findIndex((candidate) =>
          normalizedName(candidate.companyName) === normalizedName(company.companyName)
        ) === index
      );
      if (!cancelled) {
        setCompanies(next);
        setCompanyName(next.find((item) => item.id === payload.selectedCompanyId)?.companyName || next[0]?.companyName || "");
      }
    })().catch((error) => {
      if (!cancelled) setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load Tally companies." });
    });
    return () => { cancelled = true; };
  }, [connectionId]);

  useEffect(() => {
    if (!connectionId || !companyName) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setNotice(null);
      const params = new URLSearchParams({ connectionId, companyName });
      const [settingsResponse, groupsResponse] = await Promise.all([
        apiFetch(`/api/settings/cash-discount-customer-scope?${params}`, { cache: "no-store" }),
        apiFetch(`/api/tally/connections/${connectionId}/masters?type=group&all=true`, { cache: "no-store" }),
      ]);
      let nextScope = DEFAULT_SCOPE;
      if (settingsResponse.ok) {
        const payload = await settingsResponse.json() as { settings?: Scope };
        nextScope = payload.settings ?? DEFAULT_SCOPE;
      } else if (settingsResponse.status === 409) {
        setNotice({ tone: "info", text: "Database setup is required before this scope can be saved. The safe Sundry Debtors default remains active meanwhile." });
      } else {
        throw new Error(await responseError(settingsResponse));
      }
      if (!groupsResponse.ok) throw new Error(await responseError(groupsResponse));
      const groupPayload = await groupsResponse.json() as GroupMastersPayload;
      let loadedGroups = groupPayload.masters ?? [];
      if (!cancelled) {
        setScope(nextScope);
        setSavedScope(nextScope);
        setGroups(loadedGroups);
        setGroupsRefreshedAt(groupPayload.latestSync?.completed_at ?? null);
        setLoading(false);
      }
      if (loadedGroups.length === 0 && !cancelled) {
        setRefreshingGroups(true);
        setNotice({ tone: "info", text: `Reading customer groups live from Tally for ${companyName}…` });
        try {
          const refreshedPayload = await refreshTallyGroups(connectionId, companyName);
          loadedGroups = refreshedPayload.masters ?? [];
          setGroupsRefreshedAt(refreshedPayload.latestSync?.completed_at ?? new Date().toISOString());
        } catch (refreshError) {
          setGroupRefreshError(refreshError instanceof Error ? refreshError.message : "Could not read live Tally groups.");
        } finally {
          setRefreshingGroups(false);
        }
      }
      if (!cancelled) {
        setScope(nextScope);
        setSavedScope(nextScope);
        setGroups(loadedGroups);
        const parentByGroup = new Map(loadedGroups.map((group) => [normalizedName(group.name), group.parent]));
        const initiallyExpanded = new Set<string>();
        for (const selectedName of nextScope.selectedGroupNames) {
          let current = selectedName;
          while (current) {
            const key = normalizedName(current);
            if (!key || initiallyExpanded.has(key)) break;
            initiallyExpanded.add(key);
            current = parentByGroup.get(key) || "";
          }
        }
        setExpandedGroupNames(initiallyExpanded);
        setQuery("");
        setShowAllGroups(false);
      }
    })().catch((error) => {
      if (!cancelled) setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load the customer scope." });
    }).finally(() => {
      if (!cancelled) {
        setLoading(false);
        setRefreshingGroups(false);
      }
    });
    return () => { cancelled = true; };
  }, [connectionId, companyName]);

  const groupView = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const selectedKeys = new Set(scope.selectedGroupNames.map(normalizedName));
    const groupByName = new Map(groups.map((group) => [normalizedName(group.name), group]));
    const childrenByParent = new Map<string, Group[]>();
    for (const group of groups) {
      const parentKey = normalizedName(group.parent || "");
      const bucket = childrenByParent.get(parentKey) || [];
      bucket.push(group);
      childrenByParent.set(parentKey, bucket);
    }
    for (const children of childrenByParent.values()) {
      children.sort((left, right) => left.name.localeCompare(right.name));
    }
    const recommended = groups.filter((group) =>
      looksLikeCustomerGroup(group) || selectedKeys.has(normalizedName(group.name))
    );
    const includedKeys = new Set<string>();
    const includeWithAncestors = (group: Group) => {
      let current: Group | undefined = group;
      const visited = new Set<string>();
      while (current) {
        const key = normalizedName(current.name);
        if (!key || visited.has(key)) break;
        visited.add(key);
        includedKeys.add(key);
        const parentKey = normalizedName(current.parent || "");
        current = groupByName.get(parentKey);
      }
    };
    if (needle) {
      groups
        .filter((group) => `${group.name} ${group.parent || ""}`.toLowerCase().includes(needle))
        .forEach(includeWithAncestors);
    } else if (!showAllGroups) {
      recommended.forEach(includeWithAncestors);
    }

    type TreeRow = { group: Group; depth: number; childCount: number; expanded: boolean };
    const visible: TreeRow[] = [];
    const visited = new Set<string>();
    const walk = (group: Group, depth: number) => {
      const key = normalizedName(group.name);
      if (!key || visited.has(key)) return;
      visited.add(key);
      const children = childrenByParent.get(key) || [];
      const expanded = needle ? true : expandedGroupNames.has(key);
      const groupVisible = (needle && includedKeys.has(key)) || (!needle && (showAllGroups || includedKeys.has(key)));
      if (groupVisible) {
        visible.push({ group, depth, childCount: children.length, expanded });
      }
      if (groupVisible && expanded) {
        children.forEach((child) => walk(child, depth + 1));
      }
    };
    const roots = groups
      .filter((group) => !groupByName.has(normalizedName(group.parent || "")))
      .sort((left, right) => left.name.localeCompare(right.name));
    roots.forEach((group) => walk(group, 0));
    return { recommended, visible };
  }, [expandedGroupNames, groups, query, scope.selectedGroupNames, showAllGroups]);

  const descendantGroupCount = useMemo(() => {
    const parentByName = new Map(groups.map((group) => [normalizedName(group.name), group.parent]));
    const selectedKeys = new Set(scope.selectedGroupNames.map(normalizedName));
    return groups.filter((group) => {
      const visited = new Set<string>();
      let parent = group.parent;
      while (parent) {
        const key = normalizedName(parent);
        if (!key || visited.has(key)) return false;
        if (selectedKeys.has(key)) return true;
        visited.add(key);
        parent = parentByName.get(key) || null;
      }
      return false;
    }).length;
  }, [groups, scope.selectedGroupNames]);

  const inheritedSelectionByGroup = useMemo(() => {
    const inherited = new Map<string, string>();
    if (!scope.includeNestedGroups) return inherited;
    const parentByName = new Map(groups.map((group) => [normalizedName(group.name), group.parent]));
    const selectedByKey = new Map(scope.selectedGroupNames.map((name) => [normalizedName(name), name]));
    for (const group of groups) {
      const groupKey = normalizedName(group.name);
      if (selectedByKey.has(groupKey)) continue;
      const visited = new Set<string>();
      let parent = group.parent;
      while (parent) {
        const parentKey = normalizedName(parent);
        if (!parentKey || visited.has(parentKey)) break;
        const selectedAncestor = selectedByKey.get(parentKey);
        if (selectedAncestor) {
          inherited.set(groupKey, selectedAncestor);
          break;
        }
        visited.add(parentKey);
        parent = parentByName.get(parentKey) || null;
      }
    }
    return inherited;
  }, [groups, scope.includeNestedGroups, scope.selectedGroupNames]);

  const manualSelection = scope.mode !== "automatic";
  const hasUnsavedChanges = JSON.stringify(scope) !== JSON.stringify(savedScope);
  const unusualSelectedGroups = groups.filter((group) =>
    scope.selectedGroupNames.some((name) => normalizedName(name) === normalizedName(group.name)) &&
    !looksLikeCustomerGroup(group)
  );
  const recommendedGroupName =
    groups.find((group) => normalizedName(group.name) === "sundry debtors")?.name ||
    groupView.recommended[0]?.name ||
    "Sundry Debtors";

  function toggleGroup(name: string) {
    setScope((current) => ({
      ...current,
      selectedGroupNames: current.selectedGroupNames.some((item) => item.toLowerCase() === name.toLowerCase())
        ? current.selectedGroupNames.filter((item) => item.toLowerCase() !== name.toLowerCase())
        : [...current.selectedGroupNames, name],
    }));
  }

  async function refreshGroupsManually() {
    if (!connectionId || !companyName || refreshingGroups) return;
    setRefreshingGroups(true);
    setGroupRefreshError(null);
    try {
      const payload = await refreshTallyGroups(connectionId, companyName);
      const refreshedGroups = payload.masters ?? [];
      setGroups(refreshedGroups);
      setGroupsRefreshedAt(payload.latestSync?.completed_at ?? new Date().toISOString());
      setNotice({ tone: "success", text: `${refreshedGroups.length} groups refreshed from live Tally.` });
    } catch (error) {
      setGroupRefreshError(error instanceof Error ? error.message : "Could not refresh groups from Tally.");
    } finally {
      setRefreshingGroups(false);
    }
  }

  async function save() {
    if (!connectionId || !companyName) return;
    if (scope.selectedGroupNames.length === 0) {
      setNotice({ tone: "error", text: "Choose at least one Tally group to scan." });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const response = await apiFetch("/api/settings/cash-discount-customer-scope", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId, companyName, settings: scope }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const payload = await response.json() as { settings?: Scope };
      const saved = payload.settings ?? scope;
      setScope(saved);
      setSavedScope(saved);
      setNotice({ tone: "success", text: `Customer scope saved for ${companyName}. The next refresh will use it live.` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not save customer scope." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="w-full space-y-4">
      <section className="rounded-[10px] border border-[#e8e5de] bg-white px-6 py-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="max-w-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a7f72]">Cash Discount discovery</p>
            <h2 className="mt-1 text-base font-bold tracking-tight text-[#111827]">Choose where customer ledgers live</h2>
            <p className="mt-1 text-xs text-[#5b4b3d]">Saved separately for each Tally company.</p>
          </div>
          <div className="min-w-[280px] space-y-3">
            {connections.length > 1 ? (
              <label className="block">
                <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a7f72]">
                  <Monitor className="h-3.5 w-3.5" /> Tally workstation
                </span>
                <select className="h-10 w-full rounded-lg border border-[#ddd8ce] bg-white px-3 text-[13px] outline-none focus:border-[#1f6b52]" onChange={(event) => setConnectionId(event.target.value)} value={connectionId}>
                  {connections.map((connection, index) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.displayName || `Workstation ${index + 1}`}
                      {connection.lastCompanyName ? ` — ${connection.lastCompanyName}` : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {companies.length > 1 ? (
              <label className="block">
                <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a7f72]">
                  <Building2 className="h-3.5 w-3.5" /> Tally company
                </span>
                <select className="h-10 w-full rounded-lg border border-[#ddd8ce] bg-white px-3 text-[13px] outline-none focus:border-[#1f6b52]" onChange={(event) => setCompanyName(event.target.value)} value={companyName}>
                  {companies.map((company) => <option key={company.id} value={company.companyName}>{company.companyName}</option>)}
                </select>
              </label>
            ) : companyName ? (
              <div className="rounded-xl border border-[#cfe5da] bg-[#f2faf6] px-4 py-3">
                <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-[#477160]">
                  <Building2 className="h-3.5 w-3.5" /> Applying to Tally company
                </span>
                <span className="mt-1 block text-sm font-semibold text-[#173f32]">{companyName}</span>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-[#d8d4c9] bg-[#faf9f6] px-4 py-3 text-xs text-[#7b746a]">
                Connect and open a Tally company to configure this rule.
              </div>
            )}
          </div>
        </div>
      </section>

      {notice ? <div className={`rounded-xl border px-4 py-3 text-sm font-medium ${notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : notice.tone === "info" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-red-200 bg-red-50 text-red-800"}`}>{notice.text}</div> : null}

      <section className="rounded-[10px] border border-[#e8e5de] bg-white p-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a7f72]">Step 1</p>
          <h3 className="mt-1 text-sm font-bold text-[#111827]">How should Kalika find customers?</h3>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2" role="radiogroup" aria-label="Customer discovery method">
          <button
            aria-checked={!manualSelection}
            className={`group rounded-xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1f6b52]/40 ${!manualSelection ? "border-[#1f6b52] bg-[#f2faf6] shadow-sm" : "border-[#e8e5de] hover:border-[#b9cfc5]"}`}
            onClick={() => setScope((current) => ({
              ...current,
              mode: "automatic",
              selectedGroupNames: [recommendedGroupName],
              includeNestedGroups: true,
              detectSalesLinkedExceptions: true,
            }))}
            role="radio"
            type="button"
          >
            <span className="flex items-start justify-between gap-4">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#dff1e8] text-[#1f6b52]"><ShieldCheck className="h-4 w-4" /></span>
              {!manualSelection ? <Check className="h-4 w-4 text-[#1f6b52]" /> : null}
            </span>
            <span className="mt-3 block text-sm font-bold text-[#111827]">Recommended</span>
            <span className="mt-1 block text-xs text-[#5b4b3d]">Use {recommendedGroupName} and its subgroups.</span>
          </button>
          <button
            aria-checked={manualSelection}
            className={`group rounded-xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1f6b52]/40 ${manualSelection ? "border-[#1f6b52] bg-[#f2faf6] shadow-sm" : "border-[#e8e5de] hover:border-[#b9cfc5]"}`}
            onClick={() => setScope((current) => ({
              ...current,
              mode: current.detectSalesLinkedExceptions ? "custom" : "strict",
            }))}
            role="radio"
            type="button"
          >
            <span className="flex items-start justify-between gap-4">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#f1eee7] text-[#665f55]"><SlidersHorizontal className="h-4 w-4" /></span>
              {manualSelection ? <Check className="h-4 w-4 text-[#1f6b52]" /> : null}
            </span>
            <span className="mt-3 block text-sm font-bold text-[#111827]">Choose groups manually</span>
            <span className="mt-1 block text-xs text-[#5b4b3d]">Use this when your company keeps customers in custom Tally groups.</span>
          </button>
        </div>
      </section>

      {!manualSelection ? (
        <section className="rounded-[10px] border border-[#cfe5da] bg-[#f7fcf9] p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold text-[#173f32]"><ShieldCheck className="h-4 w-4" />Recommended scope is ready</p>
              <p className="mt-1 text-xs leading-5 text-[#526b61]">{recommendedGroupName}{descendantGroupCount > 0 ? ` + ${descendantGroupCount} nested group${descendantGroupCount === 1 ? "" : "s"}` : ""}.</p>
            </div>
            <button className="text-left text-xs font-semibold text-[#1f6b52] underline-offset-4 hover:underline" onClick={() => setScope((current) => ({ ...current, mode: "custom" }))} type="button">Customize groups</button>
          </div>
        </section>
      ) : (
        <section className="rounded-[10px] border border-[#e8e5de] bg-white p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a7f72]">Step 2</p>
              <h3 className="mt-1 text-sm font-bold text-[#111827]">Which Tally groups contain customers?</h3>
              <p className="mt-1 text-xs text-[#5b4b3d]">You can choose any Tally group.</p>
            </div>
            <div className="flex flex-col items-stretch gap-2 sm:items-end">
              <div className="flex flex-wrap items-center justify-end gap-2">
                <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#ddd8ce] bg-[#faf9f6] px-3 focus-within:border-[#1f6b52] focus-within:ring-2 focus-within:ring-[#1f6b52]/10 sm:flex-none">
                  <Search className="h-4 w-4 shrink-0 text-[#777a72]" />
                  <input aria-label="Search Tally groups" className="min-w-0 bg-transparent text-xs text-[#20201c] outline-none placeholder:text-[#888b83] sm:w-44" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search all Tally groups" />
                </label>
                <button
                  className="flex h-10 shrink-0 items-center gap-2 rounded-lg border border-[#cfc9bd] bg-white px-3 text-xs font-semibold text-[#245b47] transition hover:border-[#8eb5a4] hover:bg-[#f2faf6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1f6b52]/30 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={loading || refreshingGroups || !connectionId || !companyName}
                  onClick={refreshGroupsManually}
                  type="button"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${refreshingGroups ? "animate-spin" : ""}`} />
                  {refreshingGroups ? "Refreshing" : "Refresh groups"}
                </button>
              </div>
              <p className={`text-[11px] ${groupRefreshError ? "text-red-700" : refreshingGroups ? "text-[#1f6b52]" : "text-[#777a72]"}`} role={groupRefreshError ? "alert" : undefined}>
                {groupRefreshError || (refreshingGroups ? "Checking live Tally for the latest groups…" : formatGroupRefreshTime(groupsRefreshedAt))}
              </p>
            </div>
          </div>

          {scope.selectedGroupNames.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg bg-[#f6f4ee] px-3 py-2.5">
              <span className="mr-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a7f72]">Selected</span>
              {scope.selectedGroupNames.map((name) => <span className="rounded-full border border-[#cfe5da] bg-white px-2.5 py-1 text-xs font-medium text-[#245b47]" key={name}>{name}</span>)}
              <span className="ml-auto text-xs text-[#686b64]">{scope.includeNestedGroups ? `${descendantGroupCount} nested included` : "Nested groups excluded"}</span>
            </div>
          ) : null}

          {unusualSelectedGroups.length > 0 ? (
            <div className="mt-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span><strong>{unusualSelectedGroups.map((group) => group.name).join(", ")}</strong> is unusual for customers, but will be used as selected.</span>
            </div>
          ) : null}

          <div className="mt-4 overflow-hidden rounded-lg border border-[#e8e5de]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e8e5de] bg-[#fbfaf7] px-4 py-2.5">
              <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.13em] text-[#71695f]"><Layers3 className="h-3.5 w-3.5" />{query ? "Search results" : showAllGroups ? "All Tally groups" : "Recommended for customers"}</span>
              <span className="flex items-center gap-3">
                {showAllGroups && !query ? (
                  <button
                    className="text-xs font-medium text-[#686b64] hover:text-[#20201c] hover:underline"
                    onClick={() => setExpandedGroupNames((current) => current.size > 0 ? new Set() : new Set(groups.map((group) => normalizedName(group.name))))}
                    type="button"
                  >
                    {expandedGroupNames.size > 0 ? "Collapse all" : "Expand all"}
                  </button>
                ) : null}
                {!query ? <button className="text-xs font-semibold text-[#1f6b52] hover:underline" onClick={() => setShowAllGroups((current) => !current)} type="button">{showAllGroups ? "Show recommended" : `Show all ${groups.length} groups`}</button> : null}
              </span>
            </div>
            <div>
              {loading ? <div className="flex items-center justify-center gap-2 py-10 text-sm text-[#656860]"><Loader2 className="h-4 w-4 animate-spin" />Loading saved company groups</div> : groupView.visible.map(({ group, depth, childCount, expanded }) => {
                const explicitlySelected = scope.selectedGroupNames.some((item) => normalizedName(item) === normalizedName(group.name));
                const inheritedFrom = inheritedSelectionByGroup.get(normalizedName(group.name));
                const effectivelySelected = explicitlySelected || Boolean(inheritedFrom);
                return (
                  <div
                    className={`flex min-h-14 items-center border-b border-[#eeeae2] pr-3 transition last:border-0 ${explicitlySelected ? "bg-[#eaf7f0]" : inheritedFrom ? "bg-[#f5fbf7]" : "hover:bg-[#faf9f6]"}`}
                    key={group.id || group.name}
                    style={{ paddingLeft: `${12 + Math.min(depth, 5) * 22}px` }}
                  >
                    {childCount > 0 ? (
                      <button
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Collapse" : "Expand"} ${group.name}`}
                        className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[#777a72] hover:bg-[#e9e6de] hover:text-[#20201c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1f6b52]/40"
                        onClick={() => setExpandedGroupNames((current) => {
                          const next = new Set(current);
                          const key = normalizedName(group.name);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })}
                        type="button"
                      >
                        <ChevronRight className={`h-4 w-4 transition ${expanded ? "rotate-90" : ""}`} />
                      </button>
                    ) : <span className="mr-1 h-8 w-8 shrink-0" />}
                    <button
                      aria-disabled={Boolean(inheritedFrom)}
                      aria-pressed={effectivelySelected}
                      className={`flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1f6b52]/40 ${inheritedFrom ? "cursor-default" : ""}`}
                      disabled={Boolean(inheritedFrom)}
                      onClick={() => { if (!inheritedFrom) toggleGroup(group.name); }}
                      title={inheritedFrom ? `${group.name} is included through ${inheritedFrom}.` : undefined}
                      type="button"
                    >
                      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${explicitlySelected ? "border-[#1f6b52] bg-[#1f6b52] text-white" : inheritedFrom ? "border-[#72a58f] bg-[#dff1e8] text-[#1f6b52]" : "border-[#bbb5aa] bg-white"}`}>{effectivelySelected ? <Check className="h-3.5 w-3.5" /> : null}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-[#111827]">
                          {group.name}
                          {childCount > 0 ? <span className="text-[11px] font-medium text-[#8a7f72]">{childCount} direct subgroup{childCount === 1 ? "" : "s"}</span> : null}
                        </span>
                        <span className="block text-xs text-[#8a7f72]">Under {group.parent || "Primary"}</span>
                      </span>
                      {inheritedFrom ? <span className="hidden shrink-0 rounded-full border border-[#cfe5da] bg-white px-2 py-1 text-[10px] font-semibold text-[#2d664f] sm:inline">Included via {inheritedFrom}</span> : looksLikeCustomerGroup(group) ? <span className="hidden shrink-0 rounded-full bg-[#e8f4ed] px-2 py-1 text-[10px] font-semibold text-[#2d664f] sm:inline">Likely customer group</span> : null}
                    </button>
                  </div>
                );
              })}
              {!loading && groupView.visible.length === 0 ? <div className="py-10 text-center text-sm text-[#656860]">No Tally groups match this search.</div> : null}
            </div>
          </div>

          <button aria-pressed={scope.includeNestedGroups} type="button" onClick={() => setScope((current) => ({ ...current, includeNestedGroups: !current.includeNestedGroups }))} className="mt-4 flex w-full items-center justify-between gap-4 rounded-lg border border-[#e8e5de] px-4 py-3 text-left hover:bg-[#faf9f6]"><span><span className="block text-xs font-semibold text-[#111827]">Include nested subgroups</span><span className="mt-0.5 block text-xs text-[#8a7f72]">Includes subgroups split by region, channel, or salesperson.</span></span><Toggle checked={scope.includeNestedGroups} /></button>
        </section>
      )}

      {manualSelection ? <section className="overflow-hidden rounded-[10px] border border-[#e8e5de] bg-white">
        <button aria-expanded={showAdvanced} className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left hover:bg-[#faf9f6]" onClick={() => setShowAdvanced((current) => !current)} type="button">
          <span><span className="block text-sm font-bold text-[#111827]">Advanced safety</span><span className="mt-0.5 block text-xs text-[#8a7f72]">Safety net for ledgers outside your groups.</span></span>
          <ChevronDown className={`h-4 w-4 text-[#71695f] transition ${showAdvanced ? "rotate-180" : ""}`} />
        </button>
        {showAdvanced ? (
          <div className="border-t border-[#e8e5de] px-5 py-4">
            <button
              aria-pressed={scope.detectSalesLinkedExceptions}
              className="flex w-full items-center justify-between gap-4 text-left"
              onClick={() => setScope((current) => {
                const enabled = !current.detectSalesLinkedExceptions;
                return { ...current, detectSalesLinkedExceptions: enabled, mode: current.mode === "automatic" ? "automatic" : enabled ? "custom" : "strict" };
              })}
              type="button"
            >
              <span><span className="flex items-center gap-2 text-xs font-semibold text-[#111827]"><ShieldCheck className="h-4 w-4 text-[#1f6b52]" />Include verified customers outside these groups</span><span className="mt-1 block text-xs text-[#5b4b3d]">Only include an outside ledger when its open bill links to an actual Sales voucher. Turn this off to scan selected groups only.</span></span>
              <Toggle checked={scope.detectSalesLinkedExceptions} />
            </button>
          </div>
        ) : null}
      </section> : null}

      <div className="sticky bottom-4 z-10 flex flex-col gap-3 rounded-xl border border-[#d9d4c9] bg-white/95 px-4 py-3 shadow-[0_12px_36px_rgba(45,39,30,0.14)] backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#777065]">What Kalika will scan</p>
          <p className="mt-0.5 truncate text-xs font-semibold text-[#111827]">{scope.selectedGroupNames.join(", ") || "No customer group selected"}{scope.includeNestedGroups ? ` · ${descendantGroupCount} nested` : ""}{scope.detectSalesLinkedExceptions ? " · verified outside customers" : " · selected groups only"}</p>
          <p className={`mt-0.5 text-xs ${hasUnsavedChanges ? "text-amber-700" : "text-[#777a72]"}`}>{hasUnsavedChanges ? "You have unsaved changes." : "Saved."}</p>
        </div>
        <Button type="button" disabled={loading || saving || !connectionId || !companyName || !hasUnsavedChanges || scope.selectedGroupNames.length === 0} onClick={save} className="h-10 shrink-0 rounded-lg bg-[#2b1a10] px-5 text-white hover:bg-[#3b271a]">{saving ? <><Loader2 className="h-4 w-4 animate-spin" />Saving</> : "Save customer scope"}</Button>
      </div>
    </main>
  );
}
