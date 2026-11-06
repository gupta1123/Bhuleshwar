"use client";

import { useCallback, useEffect, useState } from "react";
import { Plug, Users } from "lucide-react";
import { ago, gstCall, inr, type GstRun, type GstScopeInput } from "@/lib/gst-client";
import { Alert, btn, btnPrimary, Empty, inputCls, Panel, Pill, td, th } from "./gst-ui";

type Supplier = { gstin: string; legalName: string | null; tradeName: string | null; status: string; taxpayerType: string; verifiedAt: string; warning: string | null };

export function SuppliersView({ run, scope }: { run: GstRun | null; scope: GstScopeInput }) {
  const [profiles, setProfiles] = useState<Record<string, Supplier>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const suppliers = run?.run.totals.suppliers ?? [];
  const gstins = suppliers.map((s) => s.gstin).join(",");

  useEffect(() => {
    if (!gstins) return;
    gstCall<{ suppliers: Supplier[] }>("GET", "/api/gst/suppliers", scope, { gstins })
      .then((r) => setProfiles(Object.fromEntries(r.suppliers.map((s) => [s.gstin, s]))))
      .catch(() => undefined);
  }, [gstins, scope]);

  async function check(gstin: string, refresh: boolean) {
    setBusy(gstin); setError("");
    try {
      const r = await gstCall<{ profile: Supplier }>("POST", "/api/gst/suppliers", scope, { gstin, refresh });
      setProfiles((cur) => ({ ...cur, [gstin]: r.profile }));
    } catch (e) { setError(e instanceof Error ? e.message : "Lookup failed."); } finally { setBusy(""); }
  }

  if (!run) return <Empty icon={<Users className="h-7 w-7" />} title="No suppliers yet" text="Suppliers appear here after the first reconciliation." />;
  return (
    <div className="space-y-3">
      <p className="text-[11.5px] text-[#6b6157]">A status check uses one GST call and is saved for 60 days. It runs only when you press Check.</p>
      {error && <Alert tone="bad">{error}</Alert>}
      <section className="overflow-hidden rounded-xl border border-[#ded8d0] bg-white">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-left">
          <thead>
            <tr><th className={th}>Supplier</th><th className={`${th} text-right`}>Invoices</th><th className={`${th} text-right`}>Open</th><th className={`${th} text-right`}>Claimed</th><th className={`${th} text-right`}>At risk</th><th className={th}>Filing</th><th className={th}>Portal status</th></tr>
          </thead>
          <tbody>
            {suppliers.map((s) => {
              const profile = profiles[s.gstin];
              return (
                <tr key={s.gstin} className="h-[52px] border-b border-[#ece6dc]">
                  <td className={td}><span className="block max-w-[30ch] truncate text-[12.5px] font-medium text-[#1a1a1a]">{s.name || profile?.legalName || s.gstin}</span><span className="font-mono text-[11.5px] text-[#6b6157]">{s.gstin}</span></td>
                  <td className={`${td} text-right tabular-nums`}>{s.invoices}</td><td className={`${td} text-right tabular-nums`}>{s.exceptions}</td><td className={`${td} text-right tabular-nums`}>{inr(s.claimed)}</td>
                  <td className={`${td} text-right font-semibold tabular-nums ${s.atRisk ? "text-[#991b1b]" : "text-[#b5a99a]"}`}>{s.atRisk ? inr(s.atRisk) : "—"}</td>
                  <td className={td}><Pill tone={s.filer === "regular" ? "ok" : s.filer === "irregular" ? "warn" : s.filer === "non-filer" ? "bad" : "stone"}>{s.filer ? s.filer.charAt(0).toUpperCase() + s.filer.slice(1) : "Unknown"}</Pill></td>
                  <td className={td}>
                    {profile ? (
                      <div>
                        <Pill tone={profile.warning ? "bad" : "ok"}>{profile.status} · {profile.taxpayerType || "n/a"}</Pill>
                        <div className="mt-0.5 text-[11.5px] text-[#6b6157]">checked {ago(profile.verifiedAt)}</div>
                        {profile.warning && <div className="text-[11.5px] text-[#991b1b]">{profile.warning}</div>}
                      </div>
                    ) : (
                      <button disabled={!!busy} onClick={() => check(s.gstin, false)} className={btn}>
                        {busy === s.gstin ? "Checking…" : "Check"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </section>
    </div>
  );
}

type Status = {
  connected: boolean; defaults?: { gstin: string; username: string } | null; gstin?: string; username?: string; status?: string; sessionExpiry?: string; verifiedAt?: string;
  callsLast24h?: number; dailyCap?: number; snapshots?: { returnType: string; period: string; fetchedAt: string; isFinal: boolean }[];
};

export function ConnectView({ scope }: { scope: GstScopeInput }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [gstin, setGstin] = useState("");
  const [username, setUsername] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => gstCall<Status>("GET", "/api/gst/status", scope).then(setStatus).catch((e: Error) => setMessage(e.message)), [scope]);
  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true); setMessage("");
    try { await action(); setMessage(done); await load(); } catch (e) { setMessage(e instanceof Error ? e.message : "Failed."); } finally { setBusy(false); }
  }

  const active = status?.connected && status.status === "active";
  const known = status?.connected ? { gstin: status.gstin ?? "", username: status.username ?? "" } : status?.defaults ?? null;
  const [editing, setEditing] = useState(false);
  return (
    <div className="space-y-4">
      <Panel title="GST account" action={status?.connected ? <Pill tone={active ? "ok" : "bad"}>{active ? "Connected" : "Session ended"}</Pill> : undefined}>
        {!status ? <p className="text-xs text-[#6b6157]">Loading…</p> : status.connected ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-xs">
            <dt className="text-[#756b60]">GSTIN</dt><dd className="font-mono text-[#1a1a1a]">{status.gstin}</dd>
            <dt className="text-[#756b60]">Portal user</dt><dd className="text-[#1a1a1a]">{status.username}</dd>
            <dt className="text-[#756b60]">Session</dt><dd className="text-[#1a1a1a]">{active ? `Valid until ${new Date(status.sessionExpiry ?? "").toLocaleDateString("en-IN")}` : "Ended. Send a new OTP below."}</dd>
            <dt className="text-[#756b60]">GST calls</dt><dd className="text-[#1a1a1a]">{status.callsLast24h} of {status.dailyCap} in the last 24 hours</dd>
          </dl>
        ) : <Empty icon={<Plug className="h-7 w-7" />} title="No GST account connected" text="Connect this company's GST portal login to fetch GSTR-2B, 2A and 3B." />}
      </Panel>
      {!active && (
        <Panel title="Connect with OTP" sub="The OTP goes to the phone registered on the GST portal. One OTP keeps the connection alive for about a month.">
          <div className="flex flex-wrap items-center gap-2">
            {known && !editing ? (
              <p className="text-xs text-[#756b60]">Account <span className="font-mono text-[#1a1a1a]">{known.gstin}</span> · {known.username} <button className="ml-1 underline" onClick={() => setEditing(true)}>Change</button></p>
            ) : (<>
            <input className={inputCls} placeholder="GSTIN" value={gstin || known?.gstin || ""} onChange={(e) => setGstin(e.target.value.toUpperCase())} />
            <input className={inputCls} placeholder="GST portal username" value={username || known?.username || ""} onChange={(e) => setUsername(e.target.value)} />
            </>)}
            <button className={btnPrimary} disabled={busy} onClick={() => run(async () => {
              await gstCall("POST", "/api/gst/otp", scope, { gstin: gstin || known?.gstin, username: username || known?.username }); setSent(true);
            }, "OTP sent.")}>Send OTP</button>
            {sent && (
              <>
                <input className={inputCls} placeholder="6-digit OTP" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} />
                <button className={btnPrimary} disabled={busy || otp.length !== 6} onClick={() => run(() => gstCall("POST", "/api/gst/otp/verify", scope, { gstin: gstin || known?.gstin, username: username || known?.username, otp }), "Connected.")}>Verify</button>
              </>
            )}
          </div>
        </Panel>
      )}
      {message && <Alert>{message}</Alert>}
      {status?.snapshots && status.snapshots.length > 0 && (
        <Panel title="Saved GST returns">
          <div className="overflow-x-auto"><table className="w-full min-w-[420px] text-left text-xs">
            <thead><tr className="text-[11.5px] font-bold text-[#6b6157]"><th className="pb-2 font-bold">Month</th><th className="pb-2 font-bold">GSTR-2B</th><th className="pb-2 font-bold">GSTR-3B</th><th className="pb-2 font-bold">GSTR-2A</th></tr></thead>
            <tbody>
              {Array.from(new Set(status.snapshots.map((s) => s.period))).sort().map((period) => (
                <tr key={period} className="border-t border-[#ece6dc]">
                  <td className="py-2 font-medium text-[#1a1a1a]">{period}</td>
                  {(["gstr2b", "gstr3b", "gstr2a"] as const).map((rt) => {
                    const snap = (status.snapshots ?? []).find((x) => x.period === period && x.returnType === rt);
                    return <td key={rt} className="py-2">{snap ? <span className="text-[#065f46]">Saved {ago(snap.fetchedAt)}{snap.isFinal ? "" : " (provisional)"}</span> : <span className="text-[#b5a99a]">Not saved</span>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table></div>
        </Panel>
      )}
    </div>
  );
}

type Settings = { tolerance: { amount: number; percent: number; dateWindowDays: number }; includeA2: boolean; fuzzy: boolean; dailyCallCap: number; minRefreshMinutes: number };

export function SettingsView({ scope }: { scope: GstScopeInput }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => { gstCall<Settings>("GET", "/api/gst/settings", scope).then(setSettings).catch((e: Error) => setMessage(e.message)); }, [scope]);
  if (!settings) return <Panel><p className="text-xs text-[#6b6157]">{message || "Loading…"}</p></Panel>;

  const num = (value: string) => Math.max(0, Number(value) || 0);
  const save = async () => {
    try { setSettings(await gstCall<Settings>("POST", "/api/gst/settings", scope, { ...settings })); setMessage("Saved. They apply to the next reconcile."); }
    catch (e) { setMessage(e instanceof Error ? e.message : "Could not save."); }
  };
  const field = (label: string, hint: string, value: number, set: (n: number) => void) => (
    <label className="block text-xs">
      <span className="font-medium text-[#3d3530]">{label}</span><span className="ml-2 text-[11.5px] text-[#6b6157]">{hint}</span>
      <input className={`${inputCls} mt-1.5 block w-40`} type="number" min={0} value={value} onChange={(e) => set(num(e.target.value))} />
    </label>
  );
  return (
    <div className="grid items-start gap-3 lg:grid-cols-2">
    <Panel title="Matching rules" sub="Applied on the next reconciliation" className="space-y-4">
      {field("Amount tolerance (₹)", "differences up to this still match", settings.tolerance.amount, (n) => setSettings({ ...settings, tolerance: { ...settings.tolerance, amount: n } }))}
      {field("Percent tolerance (%)", "0 means exact", settings.tolerance.percent, (n) => setSettings({ ...settings, tolerance: { ...settings.tolerance, percent: n } }))}
      {field("Date window (days)", "invoice date may differ by this much", settings.tolerance.dateWindowDays, (n) => setSettings({ ...settings, tolerance: { ...settings.tolerance, dateWindowDays: n } }))}
      <label className="flex items-center gap-2 text-xs text-[#3d3530]"><input type="checkbox" className="h-[15px] w-[15px] accent-[#2d2d2d]" checked={settings.fuzzy} onChange={(e) => setSettings({ ...settings, fuzzy: e.target.checked })} /> Link invoices with slightly different numbers</label>
      <label className="flex items-center gap-2 text-xs text-[#3d3530]"><input type="checkbox" className="h-[15px] w-[15px] accent-[#2d2d2d]" checked={settings.includeA2} onChange={(e) => setSettings({ ...settings, includeA2: e.target.checked })} /> Also compare with GSTR-2A</label>
    </Panel>
    <Panel title="GST call limits" sub="Every call to the GST portal costs money" className="space-y-4">
      {field("Daily call limit", "stops runaway cost", settings.dailyCallCap, (n) => setSettings({ ...settings, dailyCallCap: n }))}
      {field("Minimum minutes between refreshes", "of the same return", settings.minRefreshMinutes, (n) => setSettings({ ...settings, minRefreshMinutes: n }))}
      <div className="flex items-center gap-3"><button className={btnPrimary} onClick={save}>Save settings</button>{message && <span className="text-[11.5px] text-[#5a5046]">{message}</span>}</div>
    </Panel>
    </div>
  );
}
