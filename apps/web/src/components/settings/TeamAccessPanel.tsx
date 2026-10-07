'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Search, Shield, Users, Loader2 } from 'lucide-react';
import { useAccess } from '@/components/access/AccessProvider';
import { apiFetch } from '@/lib/api-client';
import { MODULES, PERMISSIONS, canAccess, accessSummary, type AccessMember, type AccessRole, type ModuleKey } from '@autodealer/shared/lib/access';

const inputClass = 'h-9 w-full rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 py-2 text-xs font-medium text-[#111827] outline-none placeholder:text-[#b5aaa0] transition focus:border-[#2b1a10] focus:bg-white focus:ring-2 focus:ring-[#ede6d9]';
const warmBtn = 'inline-flex items-center justify-center rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 py-2 text-xs font-medium text-[#3d3530] shadow-sm transition hover:bg-[#ede6d9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ede6d9] disabled:cursor-not-allowed disabled:opacity-40';
const warmBtnPrimary = 'inline-flex items-center justify-center rounded-lg bg-[#2b1a10] px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#3b271a] disabled:cursor-not-allowed disabled:opacity-40';
const tabActive = 'bg-white text-[#111827] shadow-2xs';
const tabInactive = 'text-[#6b5d50] hover:text-[#111827]';

export function TeamAccessPanel() {
  const access = useAccess(); const s = access.snapshot;
  const [tab, setTab] = useState<'team' | 'roles'>('team'); const [query, setQuery] = useState(''); const [page, setPage] = useState(1); const [total, setTotal] = useState(0);
  const [members, setMembers] = useState<AccessMember[]>([]); const [roles, setRoles] = useState<AccessRole[]>([]); const [member, setMember] = useState<AccessMember | null>(null); const [role, setRole] = useState<AccessRole | null>(null); const [clone, setClone] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [confirmation, setConfirmation] = useState<{ message: string; run: () => Promise<void> } | null>(null);
  const canTeam = canAccess(s, 'team.manage'); const canRoles = canAccess(s, 'roles.manage');
  const roleCache = useRef<{ key: string; roles: AccessRole[] } | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!s || (!canTeam && !canRoles)) return;
    setListLoading(true);
    try {
      const key = `${s.organizationId}:${s.revision}`;
      const rolesTask = roleCache.current?.key === key ? Promise.resolve(roleCache.current.roles) : (async () => {
        const response = await apiFetch('/api/access/roles', { signal, headers: { 'X-Kalika-Organization': s.organizationId } });
        const data = await response.json(); if (!response.ok) throw Error(data.error); return data.roles as AccessRole[];
      })();
      const teamTask = canTeam ? (async () => {
        const response = await apiFetch(`/api/access/team?page=${page}&q=${encodeURIComponent(query)}`, { signal, headers: { 'X-Kalika-Organization': s.organizationId } });
        const data = await response.json(); if (!response.ok) throw Error(data.error); return data;
      })() : Promise.resolve(null);
      const [nextRoles, nextTeam] = await Promise.all([rolesTask, teamTask]);
      if (signal?.aborted) return;
      roleCache.current = { key, roles: nextRoles }; setRoles(nextRoles);
      if (nextTeam) { setMembers(nextTeam.members); setTotal(nextTeam.total); } setError('');
    } catch (e) { if (!signal?.aborted) setError((e as Error).message); }
    finally { if (!signal?.aborted) setListLoading(false); }
  }, [s, canTeam, canRoles, page, query]);
  useEffect(() => { const c = new AbortController(); const t = setTimeout(() => void load(c.signal), 250); return () => { clearTimeout(t); c.abort(); }; }, [load]);
  useEffect(() => { setMember(null); setRole(null); setConfirmation(null); setMembers([]); setRoles([]); setPage(1); }, [s?.organizationId]);
  async function save(path: string, body: unknown) { setBusy(true); setError(''); try { const r = await apiFetch(`/api/access/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kalika-Organization': s!.organizationId }, body: JSON.stringify({ accessRevision: s?.revision, ...body as Record<string, unknown> }) }); const d = await r.json(); if (!r.ok) throw Error(d.error); setMember(null); setRole(null); setConfirmation(null); await access.refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function reviewSuspension() {
    if (!member) return; setBusy(true); setError('');
    try { const r = await apiFetch(`/api/access/team/${member.user_id}/impact`); const impact = await r.json(); if (!r.ok) throw Error(impact.error);
      setConfirmation({ message: `${member.status === 'active' ? 'Suspend' : 'Restore'} ${member.display_name}? ${impact.openPurchases} open purchases will be rechecked.`, run: () => save(`team/${member.user_id}`, { revision: member.revision, accessRevision: impact.accessRevision, status: member.status === 'active' ? 'suspended' : 'active' }) });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function reviewRole() { if (!role) return; try { let count = 0; let accessRevision = s?.revision; if (!clone) { const r = await apiFetch(`/api/access/roles/${role.id}/impact`); const d = await r.json(); if (!r.ok) throw Error(d.error); count = d.total; accessRevision = d.accessRevision; }
    setConfirmation({ message: clone ? `Create “${role.name}”?` : `Change “${role.name}” — ${count} teammate${count === 1 ? '' : 's'} affected.`, run: () => save(clone ? 'roles' : `roles/${role.id}`, { name: role.name, permissions: role.permissions, cloneId: role.id, revision: role.revision, accessRevision }) });
  } catch (e) { setError((e as Error).message); } }

  return <div className="w-full space-y-4">
    {/* Header — minimal, low copy */}
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#ded8d0] bg-white px-4 py-3 shadow-2xs">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-lg border border-[#e8e2db] bg-[#faf8f5] text-[#8a7f72]"><Users className="h-4 w-4" /></span>
        <div>
          <h2 className="text-base font-bold tracking-tight text-[#111827]">Team</h2>
          <p className="text-xs text-[#8a7f72]">{total || members.length ? `${total || members.length} members · ${roles.length} roles` : `${roles.length} roles`} {s && <span className={`ml-1.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${s.sharingEnabled ? 'border-[#c3dfcb] bg-[#ebf5ee] text-[#1b4332]' : 'border-[#f9d8a7] bg-[#fef6e9] text-[#78350f]'}`}>{s.sharingEnabled ? 'Sharing on' : 'Setup only'}</span>}</p>
        </div>
      </div>
      {access.organizations.length > 1 && (
        <select aria-label="Organization" className="h-9 rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 text-xs font-medium text-[#111827] outline-none focus:border-[#2b1a10] focus:bg-white">
          <option value="" disabled>Select organization</option>
          {access.organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      )}
    </section>

    {listLoading && <p role="status" className="flex items-center gap-2 text-xs font-medium text-[#8a7f72]"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading team access…</p>}

    {access.loading ? <div className="rounded-xl border border-[#ded8d0] bg-white p-6 shadow-2xs"><div className="flex items-center gap-2 text-xs font-medium text-[#5b4b3d]"><Loader2 className="h-4 w-4 animate-spin text-[#8a7f72]" /> Checking…</div></div>
      : access.error ? <section className="rounded-xl border border-[#ded8d0] bg-white p-6 shadow-2xs"><h2 className="text-sm font-bold tracking-tight text-[#111827]">Setup needed</h2><p className="mt-1 text-xs text-[#5b4b3d]">{access.error}</p><button className={`${warmBtn} mt-3 h-7`} onClick={() => void access.refresh()}>Retry</button></section>
        : !canTeam && !canRoles ? <div className="rounded-xl border border-[#ded8d0] bg-white p-6 text-center shadow-2xs"><p className="text-sm font-medium text-[#5b4b3d]">You do not have access to manage this team.</p></div>
          : <>
            {!s?.sharingEnabled && <div className="rounded-lg border border-[#f9d8a7] bg-[#fef6e9] px-3 py-2 text-xs font-medium text-[#78350f]">Sharing off — setup only.</div>}
            {error && <p role="alert" className="rounded-lg border border-[#f2c7c4] bg-[#fbf0ef] px-3 py-2 text-xs font-medium text-[#8c1d18]">{error}</p>}

            {/* Warm tab bar like Settings outer tabs */}
            <div className="inline-flex max-w-fit items-center gap-1 rounded-lg border border-[#e0d8cc] bg-[#ede6d9]/60 p-1">
              {canTeam && <button className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition ${tab === 'team' ? tabActive : tabInactive}`} aria-pressed={tab === 'team'} onClick={() => setTab('team')}>Team</button>}
              <button className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition ${tab === 'roles' ? tabActive : tabInactive}`} aria-pressed={tab === 'roles'} onClick={() => setTab('roles')}>Roles</button>
            </div>

            {tab === 'team' && canTeam ? (
              <section className="overflow-hidden rounded-xl border border-[#ded8d0] bg-white shadow-2xs">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#f0ece4] bg-[#fbfaf8] px-4 py-3">
                  <label className="relative flex-1 max-w-sm">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8a7f72]" />
                    <input aria-label="Search teammates" className="w-full rounded-lg border border-[#ded8d0] bg-white py-2 pl-8 pr-3 text-xs font-medium text-[#111827] outline-none placeholder:text-[#b5aaa0] transition focus:border-[#2b1a10] focus:ring-2 focus:ring-[#ede6d9]" placeholder="Search name or email" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} />
                  </label>
                  <span className="text-xs font-medium text-[#8a7f72]">{total} teammates</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-[#e0d8cc] bg-transparent">
                        {['Person', 'Role', 'Companies', 'Access', ''].map((h) => <th key={h} className="px-4 py-3 text-xs font-semibold tracking-wide text-[#3d3530]">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {members.map(m => (
                        <tr key={m.user_id} className="border-b border-[#ece6dc] last:border-0 transition hover:bg-[#ede6d9]/40">
                          <td className="px-4 py-3">
                            <p className="text-xs font-semibold text-[#111827]">{m.display_name}{m.is_owner ? <span className="ml-1.5 inline-flex items-center rounded-md border border-[#e6ded2] bg-[#fbfaf8] px-1.5 py-0.5 text-[10px] font-medium text-[#5b4b3d]">Owner</span> : null}</p>
                            <p className="text-xs font-normal text-[#8a7f72]">{m.email}</p>
                          </td>
                          <td className="px-4 py-3 text-xs font-medium text-[#5b4b3d]">{roles.find(r => r.id === m.role_id)?.name || '—'}</td>
                          <td className="px-4 py-3 text-xs text-[#5b4b3d]">{m.all_companies ? <span className="inline-flex items-center rounded-full border border-[#c3dfcb] bg-[#ebf5ee] px-2 py-0.5 text-xs font-medium text-[#1b4332]">All companies</span> : <span className="text-xs font-medium text-[#5b4b3d]">{m.company_ids.length} selected</span>}</td>
                          <td className="px-4 py-3"><span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${m.status === 'active' ? 'border-[#c3dfcb] bg-[#ebf5ee] text-[#1b4332]' : 'border-[#f9d8a7] bg-[#fef6e9] text-[#78350f]'}`}><span className={`h-1.5 w-1.5 rounded-full ${m.status === 'active' ? 'bg-[#2d6a4f]' : 'bg-[#b45309]'}`} />{m.status === 'active' ? 'Active' : 'Suspended'}</span></td>
                          <td className="px-4 py-3 text-right"><button className={warmBtn} disabled={!s?.member.is_owner && (m.is_owner || m.user_id === s?.member.user_id)} onClick={() => setMember({ ...m })}>Manage<span className="sr-only"> {m.display_name}</span></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!members.length && <div className="border-t border-[#ece6dc] p-6 text-center text-xs text-[#8a7f72]">No matches.</div>}
                <footer className="flex items-center justify-end gap-2 border-t border-[#ece6dc] bg-[#fbfaf8] px-4 py-2.5">
                    <button className={`${warmBtn} h-7 px-2.5 text-xs`} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
                    <span className="px-1 text-xs font-medium text-[#3d3530]">{page}</span>
                    <button className={`${warmBtn} h-7 px-2.5 text-xs`} disabled={page * 20 >= total} onClick={() => setPage(p => p + 1)}>Next</button>
                </footer>
              </section>
            ) : (
              <section className="space-y-2.5">
                {roles.filter(r => !r.archived).map(r => (
                  <article key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#ded8d0] bg-white px-4 py-3.5 shadow-2xs">
                    <div className="min-w-0">
                      <h2 className="flex items-center gap-2 text-sm font-semibold text-[#111827]"><Shield className="h-3.5 w-3.5 text-[#8a7f72]" />{r.name}</h2>
                      <p className="text-xs text-[#8a7f72]">{r.permissions.length} perms{r.template_key ? ' · template' : ''}</p>
                    </div>
                    {canRoles && <div className="flex gap-2"><button className={`${warmBtn} h-7 text-xs`} onClick={() => { setClone(true); setRole({ ...r, name: `${r.name} copy` }); }}>Clone</button>{!r.template_key && <button className={`${warmBtnPrimary} h-7`} onClick={() => { setClone(false); setRole({ ...r }); }}>Edit</button>}</div>}
                  </article>
                ))}
                {roles.filter(r => !r.archived).length === 0 && <div className="rounded-xl border border-dashed border-[#ded8d0] bg-[#fbfaf8] p-6 text-center text-xs text-[#8a7f72]">No roles.</div>}
              </section>
            )}

            {s?.member.is_owner && (
              <details className="rounded-xl border border-[#ded8d0] bg-white p-4 shadow-2xs">
                <summary className="cursor-pointer text-xs font-semibold text-[#111827]">Approval policy</summary>
                <p className="mt-2 text-xs text-[#8a7f72]">Block self-approval when possible.</p>
                <button className={`${warmBtn} mt-3 h-7 px-2.5 text-xs`} onClick={() => setConfirmation({ message: `${s.allowSelfApproval ? 'Disable' : 'Enable'} self-approval?`, run: () => save('policy', { revision: s.revision, allowSelfApproval: !s.allowSelfApproval }) })}>{s.allowSelfApproval ? 'Disable' : 'Allow'} self-approval</button>
              </details>
            )}
          </>
    }

    {(member || role) && <Dialog open onOpenChange={open => { if (!open && !busy && !confirmation) { setMember(null); setRole(null); } }}><DialogContent showClose={false} className="max-h-[90dvh] overflow-y-auto border-[#ded8d0] bg-[#fbfaf8] p-0 sm:max-w-[620px]" onInteractOutside={e => e.preventDefault()}>
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[#ece6dc] bg-white px-6 py-4">
        <DialogTitle className="text-base font-bold tracking-tight text-[#111827]">{member ? 'Manage teammate' : clone ? 'Create custom role' : 'Edit role'}</DialogTitle>
        <button className={warmBtn} onClick={() => { setMember(null); setRole(null); }}>Close</button>
      </div>
      <DialogDescription className="sr-only">Review scope and permissions before saving.</DialogDescription>
      <div className="space-y-5 bg-white px-6 py-6">
        {member && <>
          <h2 className="text-lg font-bold tracking-tight text-[#111827]">{member.display_name}</h2>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-[#3d3530]">Role</span>
            <select className={inputClass} value={member.role_id} onChange={e => setMember({ ...member, role_id: e.target.value })}>{roles.filter(r => !r.archived && (s?.member.is_owner || r.permissions.every(p => s?.role.permissions.includes(p)))).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          </label>
          <fieldset className="space-y-2 rounded-lg border border-[#ece6dc] bg-[#faf8f5] p-3">
            <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-[#8a7f72]">Modules</legend>
            {Object.entries(MODULES).map(([key, label]) => <label key={key} className="flex items-center gap-2 text-xs text-[#111827]"><input type="checkbox" className="h-4 w-4 rounded border-[#c8bfb0] accent-[#2b1a10]" disabled={!s?.member.is_owner && !s?.member.modules.includes(key as ModuleKey)} checked={member.modules.includes(key as ModuleKey)} onChange={e => setMember({ ...member, modules: e.target.checked ? [...member.modules, key as ModuleKey] : member.modules.filter(m => m !== key) })} />{label}</label>)}
          </fieldset>
          <fieldset className="space-y-2 rounded-lg border border-[#ece6dc] bg-[#faf8f5] p-3">
            <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-[#8a7f72]">Companies</legend>
            <label className="flex items-center gap-2 text-xs text-[#111827]"><input type="checkbox" className="h-4 w-4 rounded border-[#c8bfb0] accent-[#2b1a10]" disabled={!s?.member.is_owner && !s?.member.all_companies} checked={member.all_companies} onChange={e => setMember({ ...member, all_companies: e.target.checked })} />All companies</label>
            {!member.all_companies && s?.companies.map(c => <label className="flex items-center gap-2 text-xs text-[#111827]" key={c.id}><input type="checkbox" className="h-4 w-4 rounded border-[#c8bfb0] accent-[#2b1a10]" checked={member.company_ids.includes(c.id)} onChange={e => setMember({ ...member, company_ids: e.target.checked ? [...member.company_ids, c.id] : member.company_ids.filter(id => id !== c.id) })} />{c.name}</label>)}
          </fieldset>
          <p className="rounded-lg border border-[#e6ded2] bg-[#faf8f5] px-3 py-2 text-xs text-[#5b4b3d]">{accessSummary(member, roles.find(r => r.id === member.role_id) || { name: 'Unknown role', permissions: [] })}</p>
          <button className={warmBtnPrimary} disabled={busy} onClick={() => setConfirmation({ message: `Save for ${member.display_name}?`, run: () => save(`team/${member.user_id}`, { roleId: member.role_id, companyIds: member.company_ids, modules: member.modules, allCompanies: member.all_companies, revision: member.revision }) })}>Save</button>
          <details className="rounded-lg border border-[#ece6dc] bg-[#fbfaf8] p-3">
            <summary className="cursor-pointer text-xs font-medium text-[#3d3530]">More</summary>
            <div className="mt-2 flex flex-wrap gap-2">
              <button className={`${warmBtn} h-7 border-[#f2c7c4] bg-[#fbf0ef] text-[#8c1d18]`} disabled={busy} onClick={() => void reviewSuspension()}>{member.status === 'active' ? 'Suspend' : 'Restore'}</button>
              {s?.member.is_owner && <button className={`${warmBtn} h-7`} disabled={busy} onClick={() => setConfirmation({ message: `${member.is_owner ? 'Remove' : 'Grant'} owner for ${member.display_name}?`, run: () => save(`ownership/${member.user_id}`, { revision: member.revision, isOwner: !member.is_owner }) })}>{member.is_owner ? 'Remove owner' : 'Make owner'}</button>}
            </div>
          </details>
        </>}
        {role && <>
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-[#3d3530]">Role name</span>
            <input className={inputClass} maxLength={80} value={role.name} onChange={e => setRole({ ...role, name: e.target.value })} placeholder="e.g. Purchase reviewer" />
          </label>
          {Object.entries(MODULES).map(([module, label]) => <fieldset className="space-y-2 rounded-lg border border-[#ece6dc] bg-[#faf8f5] p-4" key={module}><legend className="text-xs font-bold tracking-wide text-[#3d3530]">{label}</legend>{Object.entries(PERMISSIONS).filter(([key]) => key.startsWith(`${module}.`)).map(([key, text]) => <label className="flex items-start gap-3 rounded-md px-2 py-1 text-xs font-medium text-[#111827] hover:bg-white" key={key}><input className="mt-0.5 h-4 w-4 rounded border-[#c8bfb0] accent-[#2b1a10]" type="checkbox" disabled={!s?.member.is_owner && !s?.role.permissions.includes(key)} checked={role.permissions.includes(key)} onChange={e => { const next = new Set(role.permissions); if (e.target.checked) { next.add(key); next.add(`${module}.view`); if (key.endsWith('.submit')) next.add(`${module}.prepare`); } else { next.delete(key); if (key.endsWith('.view')) for (const p of next) if (p.startsWith(`${module}.`)) next.delete(p); if (key.endsWith('.prepare')) next.delete(`${module}.submit`); } setRole({ ...role, permissions: [...next] }); }} />{text.split(': ')[1]}</label>)}</fieldset>)}
          <details className="rounded-lg border border-[#ece6dc] bg-[#faf8f5] p-4">
            <summary className="cursor-pointer text-xs font-semibold text-[#3d3530]">Team and settings</summary>
            <div className="mt-3 space-y-2">
              {Object.entries(PERMISSIONS).filter(([key]) => !Object.keys(MODULES).includes(key.split('.')[0])).map(([key, text]) => <label key={key} className="flex items-start gap-3 rounded-md px-2 py-1 text-xs font-medium text-[#111827] hover:bg-white"><input type="checkbox" className="h-4 w-4 rounded border-[#c8bfb0] accent-[#2b1a10]" checked={role.permissions.includes(key)} onChange={e => setRole({ ...role, permissions: e.target.checked ? [...role.permissions, key] : role.permissions.filter(p => p !== key) })} />{text}</label>)}
            </div>
          </details>
          <button className={warmBtnPrimary} disabled={busy || !role.name.trim()} onClick={() => void reviewRole()}>Review changes</button>
          {!clone && <details className="mt-2 rounded-lg border border-[#ece6dc] bg-[#fbfaf8] p-4"><summary className="cursor-pointer text-xs font-semibold text-[#3d3530]">More actions</summary><button className={`${warmBtn} mt-3 border-[#f2c7c4] bg-[#fbf0ef] text-[#8c1d18] hover:bg-[#f2c7c4]/50`} onClick={() => setConfirmation({ message: 'Archive this role? All teammates must be reassigned first.', run: () => save(`roles/${role.id}/archive`, { revision: role.revision }) })}>Archive role</button></details>}
        </>}
      </div>
    </DialogContent></Dialog>}
    {confirmation && <Dialog open onOpenChange={open => { if (!open && !busy) setConfirmation(null); }}><DialogContent showClose={false} className="border-[#ded8d0] bg-white p-6 sm:max-w-[520px]" onInteractOutside={e => e.preventDefault()}><DialogTitle className="text-base font-bold tracking-tight text-[#111827]">Confirm access change</DialogTitle><DialogDescription className="mt-2 text-xs leading-5 text-[#5b4b3d]">{confirmation.message}</DialogDescription>{error && <p role="alert" className="mt-3 rounded-lg border border-[#f2c7c4] bg-[#fbf0ef] px-3 py-2 text-xs font-medium text-[#8c1d18]">{error}</p>}<div className="mt-6 flex justify-end gap-2"><button className={warmBtn} disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button><button className={warmBtnPrimary} disabled={busy} onClick={() => void confirmation.run()}>{busy ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Saving…</> : 'Confirm'}</button></div></DialogContent></Dialog>}
  </div>;
}
