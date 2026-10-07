'use client';
import {apiFetch} from './api-client';
import {accessCacheEpoch,registerAccessCache} from './access-cache';

const urls = new Map<string,number>();
function clearPreviews() {
  for (const url of urls.keys()) URL.revokeObjectURL(url);
  urls.clear();
}
registerAccessCache('protected-document-previews', clearPreviews);
if (typeof window !== 'undefined') window.addEventListener('pagehide',clearPreviews);

export function releaseProtectedPreview(url: string | null | undefined) {
  if (url && urls.delete(url)) URL.revokeObjectURL(url);
}

export async function loadProtectedCasePreview(caseId:string,fileId:string,path:string) {
  const expected = `/api/cases/${caseId}/files?${new URLSearchParams({fileId,content:'1'})}`;
  if(path!==expected)throw new Error('Invalid source preview reference.');
  const epoch=accessCacheEpoch();
  const response=await apiFetch(path,{cache:'no-store'});
  if(!response.ok)throw new Error(response.status===403||response.status===404?'Source preview is no longer accessible.':'Unable to load source preview.');
  const blob=await response.blob();
  if(epoch!==accessCacheEpoch())throw new DOMException('Access changed.','AbortError');
  if(blob.size>25*1024*1024)throw new Error('Source preview is too large.');
  const url=URL.createObjectURL(blob);
  urls.set(url,blob.size);
  // Bounded across pages and source-document popups. Access invalidation and
  // page disposal revoke these too; do not retain every viewed PDF indefinitely.
  while(urls.size>16 || [...urls.values()].reduce((sum,size)=>sum+size,0)>64*1024*1024) {
    const oldest=urls.keys().next().value;
    if(oldest)releaseProtectedPreview(oldest);else break;
  }
  return url;
}
