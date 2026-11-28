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

export async function loadProtectedCasePreview(caseId:string,fileId:string,path:string,signal?:AbortSignal) {
  const expected = `/api/cases/${caseId}/files?${new URLSearchParams({fileId,content:'1'})}`;
  if(path!==expected)throw new Error('Invalid source preview reference.');
  const epoch=accessCacheEpoch();
  const response=await apiFetch(path,{cache:'no-store',signal});
  if(!response.ok)throw new Error(response.status===403||response.status===404?'Source preview is no longer accessible.':'Unable to load source preview.');
  const contentType = response.headers.get('content-type')?.split(';')[0].trim();
  if (contentType === 'application/json') {
    // Legacy installations return a storage URL for this same GET.
    const payload = await response.json();
    if (epoch !== accessCacheEpoch()) throw new DOMException('Access changed.', 'AbortError');
    if (payload.fileId !== fileId || typeof payload.signedUrl !== 'string' ||
        !/^https?:\/\//i.test(payload.signedUrl)) throw new Error('Invalid source preview reference.');
    return payload.signedUrl as string;
  }
  if (!['application/pdf','image/png','image/jpeg','image/webp','image/gif'].includes(contentType ?? '')) {
    throw new Error('Unsupported source preview response.');
  }
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
