/** Explicit permission policy for user-authenticated API entry points.
 * Protocol callbacks retain their separate bridge/job-token authentication.
 * This boundary does not replace SQL row scoping or dispatch-time checks.
 */
export type RoutePolicy = { permissions: string[]; resource?: { type: 'case'|'bank_import'|'proposal'|'connection'; id: string }; inspectAction?: boolean };
const commandPermissions: Record<string,string> = {
  alter_ledger:'connections.manage', create_ledger:'connections.manage', sync_masters:'connections.manage', sync_bank_masters:'bank.prepare',
  fetch_bank_ledgers:'bank.prepare', fetch_purchase_masters:'purchases.prepare',
  post_bank_voucher:'bank.post', verify_bank_transaction:'bank.prepare',
  fetch_customer_open_bills:'discounts.prepare', create_debit_note:'discounts.post', export_debit_note_pdf:'discounts.export',
  // Purchase writes must use the case endpoint's atomic approved-revision path.
  // Do not permit a generic raw command to bypass that transaction.
  agent_sync_dataset:'connections.manage', agent_reconcile_dataset:'connections.manage',
  agent_parse_document:'bank.prepare', agent_vector_suggest:'bank.prepare',
  agent_cache_maintenance:'connections.manage', agent_clear_cache:'connections.manage', agent_update_settings:'connections.manage',
  agent_rebuild_cache:'connections.manage', agent_diagnostics:'connections.manage',
  agent_query_open_bills:'discounts.prepare', agent_query_workflow_vouchers:'discounts.prepare', agent_voucher_identity:'purchases.view',
};
export function userRoutePolicy(path: string, method: string, action?: string, commandType?: string): RoutePolicy | null {
  const read = method === 'GET' || method === 'HEAD';
  const resource = (type: NonNullable<RoutePolicy['resource']>['type'], id:string, permission:string, inspectAction=false):RoutePolicy => ({permissions:[permission],resource:{type,id},inspectAction});
  const simple = (...permissions:string[]):RoutePolicy => ({permissions});
  let m:RegExpMatchArray|null;
  if (path.startsWith('/api/settings/')) return simple('settings.manage');
  if (path === '/api/ai/openrouter') return simple('purchases.prepare');
  if (path === '/api/cases') return simple(read ? 'purchases.view' : 'purchases.prepare');
  if ((m=path.match(/^\/api\/cases\/([^/]+)(?:\/(.*))?$/))) {
    const tail=m[2]||'';
    if (tail==='approval') return resource('case',m[1],read?'purchases.view':action==='prepare'?'purchases.prepare':action==='submit'?'purchases.submit':'purchases.approve',!read);
    if (tail==='tally-posting') return resource('case',m[1],read?'purchases.view':method==='POST'&&action==='approve_and_queue'?'purchases.post':'purchases.prepare',method==='POST');
    if (!tail && method==='PATCH') return resource('case',m[1],action==='restore'?'purchases.recycle':'purchases.approve',true);
    if (!tail && method==='DELETE') return resource('case',m[1],action==='permanent'?'purchases.delete':'purchases.recycle',true);
    if (['','files','analysis','analysis/status','mismatches','tally-readiness'].includes(tail)||/^mismatches\/[^/]+$/.test(tail)) return resource('case',m[1],read?'purchases.view':'purchases.prepare');
    return null;
  }
  if ((m=path.match(/^\/api\/bank-statements\/imports\/([^/]+)(?:\/(confirm|local-upload-failed))?$/))) return resource('bank_import',m[1],read?'bank.view':'bank.prepare');
  if (path.startsWith('/api/bank-statements/')) {
    if (/^\/api\/bank-statements\/jobs\/[^/]+\/access$/.test(path) && method==='POST') return simple('bank.view');
    if (path==='/api/bank-statements/pdf-preview') return simple('bank.view');
    if (path==='/api/bank-statements/tally/queue'||/^\/api\/bank-statements\/tally\/queue-jobs\/[^/]+\/run$/.test(path)) return simple('bank.post');
    if (['accounts','imports','transactions','parsing-policy'].some(p=>path===`/api/bank-statements/${p}`)||/^\/api\/bank-statements\/tally\/queue-jobs\/[^/]+$/.test(path)) return simple(read?'bank.view':'bank.prepare');
    return null;
  }
  if ((m=path.match(/^\/api\/collections\/debit-note-proposals\/([^/]+)\/(approve|native-pdf|whatsapp)$/))) return resource('proposal',m[1],m[2]==='approve'?'discounts.approve':'discounts.export');
  if (path.startsWith('/api/collections/')) {
    if(path==='/api/collections/follow-ups/pipelines') return read?simple('followups.view'):action?simple(action==='history'||action==='statuses'?'followups.view':action==='send_once'||action==='send'||action==='preview'?'followups.export':action==='save_template'?'settings.manage':'followups.prepare'):{permissions:['followups.view'],inspectAction:true};
    if (path==='/api/collections/follow-ups') return simple('followups.view');
    if (path==='/api/collections/follow-ups/analyse'||path==='/api/collections/follow-ups/analysis-context') return simple('followups.prepare');
    if (['cash-discount-rules','whatsapp/templates'].some(p=>path===`/api/collections/${p}`)) return simple(read?'discounts.view':'settings.manage');
    if (['live/prepare-debit-note','live/confirm-debit-note','tally-debit-notes/approve'].some(p=>path===`/api/collections/${p}`)) return simple('discounts.post');
    if (path==='/api/collections/live/session') return simple('@connection-status');
    if (path==='/api/collections/debit-note-proposals') return simple(read?'discounts.view':'discounts.prepare');
    if (['dashboard','dashboard/version'].some(p=>path===`/api/collections/${p}`)) return simple('discounts.view');
    if (['live/analyse','live/analysis-context','live/analyse-preview','live/queue-scan','live/scan-event'].some(p=>path===`/api/collections/${p}`)) return simple('discounts.prepare');
    return null;
  }
  if (path==='/api/tally/agent/jobs') return commandType&&commandPermissions[commandType]?simple(commandPermissions[commandType]):{permissions:[],inspectAction:true};
  if (path==='/api/tally/agent/embeddings') return simple('bank.prepare');
  if (path==='/api/tally/companies'||path==='/api/tally/connections') return simple(read?'@connection-status':'connections.manage');
  if(path==='/api/tally/connections/disconnect-others') return simple('connections.manage');
  if ((m=path.match(/^\/api\/tally\/connections\/([^/]+)\/(.+)$/))) {
    const tail=m[2];
    if(tail==='commands'&&!read) return commandType&&commandPermissions[commandType]?resource('connection',m[1],commandPermissions[commandType]):{permissions:[],resource:{type:'connection',id:m[1]},inspectAction:true};
    if(['status','agent-status','master-health','masters','mappings'].includes(tail)&&read) return resource('connection',m[1],'@connection-status');
    if((tail==='commands'||/^commands\/[^/]+$/.test(tail))&&read) return resource('connection',m[1],'@connection-status');
    if(['disconnect','pair','test','mappings','masters'].includes(tail)) return resource('connection',m[1],'connections.manage');
    return null;
  }
  return null;
}

export const CONNECTION_STATUS_PERMISSIONS = ['connections.manage','purchases.view','bank.view','discounts.view','followups.view'];
