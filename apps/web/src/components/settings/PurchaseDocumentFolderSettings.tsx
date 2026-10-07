"use client";

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { runCashDiscountLiveRequest } from '@/lib/cash-discount-live';

export function PurchaseDocumentFolderSettings({ connectionId, companyName, companyGuid, financialYear }: {
  connectionId: string; companyName: string; companyGuid?: string | null; financialYear?: string | null;
}) {
  const [folderPath, setFolderPath] = useState('');
  const [busy, setBusy] = useState('loading');
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setFolderPath(''); setLoaded(false); setNotice(null); setBusy('loading');
    if (!connectionId || !companyName) { setBusy(''); return; }
    const query = new URLSearchParams({ connectionId, companyName });
    if (companyGuid) query.set('companyGuid', companyGuid);
    if (financialYear) query.set('financialYear', financialYear);
    void apiFetch(`/api/settings/purchase-document-folder?${query}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load folder settings.');
        if (generation.current === current) { setFolderPath(data.folderPath || ''); setLoaded(true); }
      }).catch(error => {
        if (!controller.signal.aborted && generation.current === current) setNotice({ error: true, text: error.message });
      }).finally(() => { if (generation.current === current) setBusy(''); });
    return () => { ++generation.current; controller.abort(); };
  }, [connectionId, companyName, companyGuid, financialYear]);

  async function act(action: 'save' | 'test') {
    const current = generation.current;
    setBusy(action); setNotice(null);
    try {
      if (action === 'test') {
        await runCashDiscountLiveRequest({ connectionId, companyName, companyGuid, financialYear,
          operation: 'test_purchase_document_folder', payload: { folderPath } });
      } else {
        const response = await apiFetch('/api/settings/purchase-document-folder', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectionId, companyName, companyGuid, financialYear, folderPath }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not save folder.');
        if (generation.current === current) setFolderPath(data.folderPath);
      }
      if (generation.current === current) setNotice({ error: false, text: action === 'test'
        ? 'The connector can read and write this folder. Tally users also need read access.'
        : 'Purchase invoice folder saved.' });
    } catch (error) {
      if (generation.current === current) setNotice({ error: true, text: error instanceof Error ? error.message : 'Folder operation failed.' });
    } finally { if (generation.current === current) setBusy(''); }
  }

  return <section className="rounded-[10px] border border-[#e8e5de] bg-white px-6 py-5">
    <h3 className="text-sm font-bold text-[#111827]">Purchase invoice folder</h3>
    <p className="mt-1 text-xs text-[#8a7f72]">Save PDFs to a shared LAN folder before posting. All Tally users should be able to open this location.</p>
    <label className="mt-4 block text-xs font-medium text-[#5b4b3d]">Shared folder path
      <input className="mt-1 h-10 w-full rounded-lg border border-[#ddd7cc] px-3" value={folderPath}
        placeholder={'\\\\AccountsServer\\Invoices\\Kalika'} disabled={Boolean(busy) || !loaded}
        onChange={event => { setFolderPath(event.target.value); setNotice(null); }} />
    </label>
    <p className="mt-2 text-xs text-[#8a7f72]">Leave empty to keep connector-local storage. A configured shared folder must be accessible before posting.</p>
    <div className="mt-3 flex gap-2">
      <Button variant="outline" disabled={Boolean(busy) || !loaded || !folderPath.trim()} onClick={() => void act('test')}>
        {busy === 'test' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Test folder access
      </Button>
      <Button disabled={Boolean(busy) || !loaded} onClick={() => void act('save')}>
        {busy === 'save' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save folder
      </Button>
    </div>
    {busy === 'loading' && <p className="mt-2 text-xs">Loading folder settings…</p>}
    {notice && <p role="status" className={`mt-3 text-xs ${notice.error ? 'text-rose-700' : 'text-emerald-700'}`}>{notice.text}</p>}
  </section>;
}
