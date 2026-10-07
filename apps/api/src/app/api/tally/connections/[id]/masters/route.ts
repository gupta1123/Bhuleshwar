import { withTeamAccess } from '@/lib/access/route-boundary';
import {datasetSelection,requireMasterDataset} from '@/lib/access/master-store';
import {accessFailureResponse} from '@/lib/access/failures';
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  MASTER_TYPES,
  serializeTallyMaster,
  type TallyMasterRow,
  type TallyMasterType,
} from "@/lib/tally/masters";

function parseMasterType(value: string | null): TallyMasterType | null {
  if (!value) return null;
  return MASTER_TYPES.includes(value as TallyMasterType) ? (value as TallyMasterType) : null;
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const url = new URL(request.url);
    const type = parseMasterType(url.searchParams.get("type"));
    const query = url.searchParams.get("q")?.trim() ?? "";
    const requestedCompanyName = url.searchParams.get("companyName")?.trim() ?? "";
    const rawLimit=Number(url.searchParams.get("limit") || 100);
    const limit = Number.isSafeInteger(rawLimit)?Math.max(1,Math.min(rawLimit,5000)):100;
    const fetchAll = url.searchParams.get("all") === "true";

    const supabase = createSupabaseAdminClient();
    if(process.env.TEAM_ACCESS_ENFORCEMENT==='true') {
      const scope=await requireMasterDataset(request,id,datasetSelection(url));
      if(!scope.dataset)return jsonWithCors(request,{masters:[],masterCount:0,latestSync:null});
      const rows:TallyMasterRow[]=[];
      for(let from=0;from<20001;from+=1000) {
        let q=supabase.from('access_dataset_masters').select('*').eq('dataset_id',scope.dataset.id)
          .eq('is_active',true).order('master_type').order('tally_name').order('id');
        if(type)q=q.eq('master_type',type);
        if(query)q=q.ilike('tally_name',`%${query.replace(/[\\%_]/g,'\\$&')}%`);
        const size=fetchAll?1000:Math.min(1000,limit-from);
        if(size<=0)break;
        const {data,error}=await q.range(from,from+size-1);if(error)throw error;
        rows.push(...(data||[]).map(row=>({...row,connection_id:id,owner_user_id:scope.connection.owner_user_id,
          company_name:scope.link.company_name,sync_run_id:null} as TallyMasterRow)));
        if((data?.length||0)<size)break;
      }
      if(rows.length>20000)return jsonWithCors(request,{error:'Master list exceeds the supported limit.'},{status:413});
      const {data:groups,error:groupError}=type==='ledger'?await supabase.from('access_dataset_masters')
        .select('tally_name,parent_name').eq('dataset_id',scope.dataset.id).eq('master_type','group').limit(5001):{data:[],error:null};
      if(groupError)throw groupError;
      if((groups?.length||0)>5000)return jsonWithCors(request,{error:'Group list exceeds the supported limit.'},{status:413});
      return jsonWithCors(request,{masters:rows.map(row=>serializeTallyMaster(row)),
        masterCount:rows.length,latestSync:{id:scope.dataset.id,status:'completed',company_name:scope.link.company_name,completed_at:scope.dataset.updated_at},datasetId:scope.dataset.id});
    }
    const { data: connection, error: connectionError } = await supabase
      .from("tally_connections")
      .select("id, owner_user_id, last_company_name")
      .eq("id", id)
      .eq("owner_user_id", user.id)
      .maybeSingle();

    if (connectionError) {
      throw connectionError;
    }

    if (!connection) {
      return jsonWithCors(request, { error: "Tally connection not found" }, { status: 404 });
    }
    const companyName = requestedCompanyName || connection.last_company_name || "Unknown company";

    const buildMasterQuery = () => {
      let builder = supabase
        .from("tally_masters")
        .select("*")
        .eq("connection_id", id)
        .eq("owner_user_id", user.id)
        .eq("company_name", companyName)
        .eq("is_active", true)
        .order("master_type", { ascending: true })
        .order("tally_name", { ascending: true });
      if (type) builder = builder.eq("master_type", type);
      if (query) builder = builder.ilike("tally_name", `%${query}%`);
      return builder;
    };

    const masters: TallyMasterRow[] = [];
    if (fetchAll) {
      const pageSize = 1000;
      for (let from = 0; from < 20000; from += pageSize) {
        const { data, error } = await buildMasterQuery().range(from, from + pageSize - 1);
        if (error) throw error;
        const page = (data ?? []) as unknown as TallyMasterRow[];
        masters.push(...page);
        if (page.length < pageSize) break;
        if (from + pageSize >= 20000) {
          throw new Error("Tally master list exceeds the supported 20,000-master safety limit.");
        }
      }
    } else {
      const { data, error } = await buildMasterQuery().limit(limit);
      if (error) throw error;
      masters.push(...((data ?? []) as unknown as TallyMasterRow[]));
    }

    const { data: runData, error: runError } = await supabase
      .from("tally_master_sync_runs")
      .select("id, status, company_name, totals, error, completed_at")
      .eq("connection_id", id)
      .eq("owner_user_id", user.id)
      .eq("company_name", companyName)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (runError) {
      throw runError;
    }

    const groupRows: TallyMasterRow[] = [];
    if (type === "ledger") {
      const pageSize = 1000;
      for (let from = 0; from < 20000; from += pageSize) {
        const { data, error } = await supabase
          .from("tally_masters")
          .select("*")
          .eq("connection_id", id)
          .eq("owner_user_id", user.id)
          .eq("company_name", companyName)
          .eq("master_type", "group")
          .eq("is_active", true)
          .order("tally_name", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw error;
        const page = (data ?? []) as unknown as TallyMasterRow[];
        groupRows.push(...page);
        if (page.length < pageSize) break;
        if (from + pageSize >= 20000) {
          throw new Error("Tally group list exceeds the supported 20,000-master safety limit.");
        }
      }
    }

    return jsonWithCors(request, {
      masters: masters.map((master) => serializeTallyMaster(master)),
      masterCount: masters.length,
      latestSync: runData ?? null,
    });
  } catch (error) {
    const denied=accessFailureResponse(request,error);if(denied)return denied;
    console.error("Error in GET /api/tally/connections/[id]/masters:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
