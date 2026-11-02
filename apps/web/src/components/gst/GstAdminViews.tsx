"use client";

import { useCallback, useEffect, useState } from "react";
import { ago, gstCall, inr, type GstRun, type GstScopeInput } from "@/lib/gst-client";

const card = "rounded-2xl border border-[#e5ddd0] bg-white p-5 shadow-sm";
const input = "h-9 rounded-lg border border-[#e5ddd0] bg-white px-3 text-xs";
const button = "h-9 rounded-lg bg-[#2d2d2d] px-4 text-xs font-bold text-white disabled:opacity-50";

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

  if (!run) return <div className={`${card} text-sm font-semibold text-slate-500`}>No reconciliation yet.</div>;
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-slate-500">Status checks use one GST call each and are saved for 60 days. They run only when you press Check.</p>
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800">{error}</p>}
      <section className="overflow-x-auto rounded-2xl border border-[#e5ddd0] bg-white shadow-sm">
        <table className="w-full min-w-[820px] text-left text-xs">
          <thead className="bg-[#fcfbfa] text-[10px] font-bold uppercase tracking-wider text-slate-400">
            <tr><th className="px-4 py-3">Supplier</th><th>Invoices</th><th>Open</th><th>Claimed</th><th>At risk</th><th>Filing pattern</th><th className="pr-4">Portal status</th></tr>
          </thead>
          <tbody className="font-semibold">
            {suppliers.map((s) => {
              const profile = profiles[s.gstin];
              return (
                <tr key={s.gstin} className="border-t border-[#efe8dc]">
                  <td className="px-4 py-3"><div className="font-extrabold">{s.name || profile?.legalName || s.gstin}</div><div className="text-slate-400">{s.gstin}</div></td>
                  <td>{s.invoices}</td><td>{s.exceptions}</td><td>{inr(s.claimed)}</td><td>{s.atRisk ? inr(s.atRisk) : "-"}</td>
                  <td className="capitalize">{s.filer}</td>
                  <td className="pr-4">
                    {profile ? (
                      <div>
                        <span className={profile.warning ? "text-rose-700" : "text-emerald-700"}>{profile.status} · {profile.taxpayerType || "n/a"}</span>
                        <div className="text-[10px] text-slate-400">checked {ago(profile.verifiedAt)}</div>
                        {profile.warning && <div className="text-[10px] text-rose-700">{profile.warning}</div>}
                      </div>
                    ) : (
                      <button disabled={!!busy} onClick={() => check(s.gstin, false)} className="rounded-lg border border-[#e5ddd0] px-3 py-1 text-[11px] font-bold disabled:opacity-50">
                        {busy === s.gstin ? "Checking…" : "Check"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

type Status = {
  connected: boolean; gstin?: string; username?: string; status?: string; sessionExpiry?: string; verifiedAt?: string;
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
  return (
    <div className="space-y-4">
      <section className={card}>
        <h3 className="text-sm font-extrabold">GST account</h3>
        {!status ? <p className="mt-2 text-xs text-slate-500">Loading…</p> : status.connected ? (
          <div className="mt-2 space-y-1 text-xs font-semibold text-slate-600">
            <div>GSTIN {status.gstin} · user {status.username}</div>
            <div className={active ? "text-emerald-700" : "text-rose-700"}>
              {active ? `Connected until ${new Date(status.sessionExpiry ?? "").toLocaleDateString("en-IN")}` : "Session ended. Send a new OTP below."}
            </div>
            <div>GST calls used in the last 24 hours: {status.callsLast24h} of {status.dailyCap}</div>
          </div>
        ) : <p className="mt-2 text-xs font-semibold text-slate-500">No GST account connected for this company yet.</p>}
      </section>
      {!active && (
        <section className={card}>
          <h3 className="text-sm font-extrabold">Connect with OTP</h3>
          <p className="mt-1 text-xs text-slate-500">The OTP goes to the phone registered on the GST portal. One OTP keeps the connection alive for about a month.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input className={input} placeholder="GSTIN" value={gstin || status?.gstin || ""} onChange={(e) => setGstin(e.target.value.toUpperCase())} />
            <input className={input} placeholder="GST portal username" value={username || status?.username || ""} onChange={(e) => setUsername(e.target.value)} />
            <button className={button} disabled={busy} onClick={() => run(async () => {
              await gstCall("POST", "/api/gst/otp", scope, { gstin: gstin || status?.gstin, username: username || status?.username }); setSent(true);
            }, "OTP sent.")}>Send OTP</button>
            {sent && (
              <>
                <input className={input} placeholder="6-digit OTP" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} />
                <button className={button} disabled={busy || otp.length !== 6} onClick={() => run(() => gstCall("POST", "/api/gst/otp/verify", scope, { gstin: gstin || status?.gstin, username: username || status?.username, otp }), "Connected.")}>Verify</button>
              </>
            )}
          </div>
        </section>
      )}
      {message && <p className="rounded-lg bg-[#f1eee6] px-3 py-2 text-xs font-semibold">{message}</p>}
      {status?.snapshots && status.snapshots.length > 0 && (
        <section className={`${card} overflow-x-auto`}>
          <h3 className="text-sm font-extrabold">Saved GST returns</h3>
          <table className="mt-3 w-full min-w-[420px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-slate-400"><tr><th className="py-2">Return</th><th>Month</th><th>Fetched</th><th>Final</th></tr></thead>
            <tbody className="font-semibold">
              {status.snapshots.map((s) => (
                <tr key={`${s.returnType}${s.period}`} className="border-t border-[#efe8dc]"><td className="py-2 uppercase">{s.returnType}</td><td>{s.period}</td><td>{ago(s.fetchedAt)}</td><td>{s.isFinal ? "Yes" : "No"}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

type Settings = { tolerance: { amount: number; percent: number; dateWindowDays: number }; includeA2: boolean; fuzzy: boolean; dailyCallCap: number; minRefreshMinutes: number };

export function SettingsView({ scope }: { scope: GstScopeInput }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => { gstCall<Settings>("GET", "/api/gst/settings", scope).then(setSettings).catch((e: Error) => setMessage(e.message)); }, [scope]);
  if (!settings) return <div className={`${card} text-xs text-slate-500`}>{message || "Loading…"}</div>;

  const num = (value: string) => Math.max(0, Number(value) || 0);
  const save = async () => {
    try { setSettings(await gstCall<Settings>("POST", "/api/gst/settings", scope, { ...settings })); setMessage("Saved. They apply to the next reconcile."); }
    catch (e) { setMessage(e instanceof Error ? e.message : "Could not save."); }
  };
  const field = (label: string, hint: string, value: number, set: (n: number) => void) => (
    <label className="block text-xs font-semibold">
      <span className="font-extrabold">{label}</span><span className="ml-2 text-slate-400">{hint}</span>
      <input className={`${input} mt-1 block w-40`} type="number" min={0} value={value} onChange={(e) => set(num(e.target.value))} />
    </label>
  );
  return (
    <section className={`${card} space-y-4`}>
      <h3 className="text-sm font-extrabold">Matching rules</h3>
      {field("Amount tolerance (₹)", "differences up to this still match", settings.tolerance.amount, (n) => setSettings({ ...settings, tolerance: { ...settings.tolerance, amount: n } }))}
      {field("Percent tolerance (%)", "0 means exact", settings.tolerance.percent, (n) => setSettings({ ...settings, tolerance: { ...settings.tolerance, percent: n } }))}
      {field("Date window (days)", "invoice date may differ by this much", settings.tolerance.dateWindowDays, (n) => setSettings({ ...settings, tolerance: { ...settings.tolerance, dateWindowDays: n } }))}
      <label className="flex items-center gap-2 text-xs font-semibold"><input type="checkbox" checked={settings.fuzzy} onChange={(e) => setSettings({ ...settings, fuzzy: e.target.checked })} /> Link invoices with slightly different numbers</label>
      <label className="flex items-center gap-2 text-xs font-semibold"><input type="checkbox" checked={settings.includeA2} onChange={(e) => setSettings({ ...settings, includeA2: e.target.checked })} /> Also compare with GSTR-2A</label>
      <h3 className="pt-2 text-sm font-extrabold">GST call limits</h3>
      {field("Daily call limit", "stops runaway cost", settings.dailyCallCap, (n) => setSettings({ ...settings, dailyCallCap: n }))}
      {field("Minimum minutes between refreshes", "of the same return", settings.minRefreshMinutes, (n) => setSettings({ ...settings, minRefreshMinutes: n }))}
      <div className="flex items-center gap-3"><button className={button} onClick={save}>Save settings</button>{message && <span className="text-xs font-semibold text-slate-600">{message}</span>}</div>
    </section>
  );
}
