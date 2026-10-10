import { withTeamAccess } from '@/lib/access/route-boundary';
import { requireDataset } from '@/lib/access/dataset';
import { accessFailureResponse } from '@/lib/access/failures';
import { requireRequestUser } from '@/lib/api/request-auth';
import { jsonWithCors, optionsWithCors } from '@/lib/api/cors';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const OPTIONS = optionsWithCors;
async function record(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request,{error:'Unauthorized'},{status:401});
    const body = await request.json();
    if (!/^[a-f0-9-]{36}$/i.test(String(body.requestId)) || !['completed','failed','cancelled'].includes(body.status))
      return jsonWithCors(request,{error:'Invalid scan summary'},{status:400});
    const db = createSupabaseAdminClient();
    let ownerUserId = user.id;
    if (process.env.TEAM_ACCESS_ENFORCEMENT === 'true') {
      const scope = await requireDataset(request,body.connectionId,{companyName:body.companyName,financialYear:body.financialYear},'discounts.prepare');
      ownerUserId = scope.connection.owner_user_id;
    } else {
      const {data,error} = await db.from('tally_connections').select('id').eq('id',body.connectionId).eq('owner_user_id',user.id).maybeSingle();
      if(error) throw error;
      if(!data) return jsonWithCors(request,{error:'Connection not found'},{status:404});
    }
    const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0,Math.min(value,1e12)) : null;
    const {error} = await db.from('tally_connection_events').insert({
      connection_id:body.connectionId, owner_user_id:ownerUserId,
      event_type:'cash_discount_scan_finished', message:`Cash Discount scan ${body.status}`,
      payload:{requestId:body.requestId,status:body.status,companyName:String(body.companyName||'').slice(0,240),
        financialYear:String(body.financialYear||'').slice(0,20),elapsedMs:finite(body.elapsedMs),
        completed:finite(body.completed),total:finite(body.total),complete:body.complete===true,
        callCount:finite(body.callCount),responseBytes:finite(body.responseBytes),peakRssBytes:finite(body.peakRssBytes),minimumSystemFreeBytes:finite(body.minimumSystemFreeBytes),
        failureClass:['timeout','disconnected','cancelled','other'].includes(body.failureClass)?body.failureClass:null},
    });
    if(error)throw error;
    return jsonWithCors(request,{recorded:true});
  } catch(error) {
    return accessFailureResponse(request,error) ?? jsonWithCors(request,{error:'Could not record scan summary'},{status:500});
  }
}
export const POST = withTeamAccess(record);
