import { withTeamAccess } from '@/lib/access/route-boundary';
import {datasetSelection,requireMasterDataset,saveDatasetMapping} from '@/lib/access/master-store';
import {accessFailureResponse} from '@/lib/access/failures';
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  MAPPING_TYPES,
  serializeTallyMapping,
  toNullableText,
  toRequiredText,
  type TallyMappingRow,
  type TallyMappingType,
} from "@/lib/tally/masters";

function parseMappingType(value: unknown): TallyMappingType | null {
  if (typeof value !== "string") return null;
  return MAPPING_TYPES.includes(value as TallyMappingType) ? (value as TallyMappingType) : null;
}

async function requireConnection(ownerUserId: string, connectionId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("tally_connections")
    .select("id, owner_user_id, last_company_name")
    .eq("id", connectionId)
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
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
    if(process.env.TEAM_ACCESS_ENFORCEMENT==='true') {
      const scope=await requireMasterDataset(request,id,datasetSelection(new URL(request.url)));
      if(!scope.dataset)return jsonWithCors(request,{mappings:[],datasetId:null});
      const {data,error}=await createSupabaseAdminClient().from('access_dataset_mappings').select('*')
        .eq('dataset_id',scope.dataset.id).order('updated_at',{ascending:false}).limit(5001);
      if(error)throw error;
      if((data?.length||0)>5000)return jsonWithCors(request,{error:'Mapping list exceeds the supported limit.'},{status:413});
      return jsonWithCors(request,{mappings:(data||[]).map(row=>({...serializeTallyMapping({
        ...row,connection_id:id,owner_user_id:scope.connection.owner_user_id,company_name:scope.link.company_name,
      } as TallyMappingRow),revision:row.revision})),datasetId:scope.dataset.id});
    }
    const connection = await requireConnection(user.id, id);
    if (!connection) {
      return jsonWithCors(request, { error: "Tally connection not found" }, { status: 404 });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_mapping_settings")
      .select("*")
      .eq("connection_id", id)
      .eq("owner_user_id", user.id)
      .eq("company_name", connection.last_company_name ?? "Unknown company")
      .order("updated_at", { ascending: false });

    if (error) {
      throw error;
    }

    return jsonWithCors(request, {
      mappings: ((data ?? []) as unknown as TallyMappingRow[]).map(serializeTallyMapping),
    });
  } catch (error) {
    const denied=accessFailureResponse(request,error);if(denied)return denied;
    console.error("Error in GET /api/tally/connections/[id]/mappings:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const team=process.env.TEAM_ACCESS_ENFORCEMENT==='true';
    const connection = team?null:await requireConnection(user.id, id);
    if (!team && !connection) {
      return jsonWithCors(request, { error: "Tally connection not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const mappingType = parseMappingType(body.mappingType);
    const sourceKey = toRequiredText(body.sourceKey).slice(0, 240);
    const sourceLabel = toRequiredText(body.sourceLabel || body.sourceKey).slice(0, 500);
    const targetMasterType = toRequiredText(body.targetMasterType).slice(0, 80);
    const targetMasterKey = toRequiredText(body.targetMasterKey).slice(0, 500);
    const targetMasterName = toRequiredText(body.targetMasterName).slice(0, 500);

    if (!mappingType || !sourceKey || !sourceLabel || !targetMasterType || !targetMasterKey || !targetMasterName) {
      return jsonWithCors(request, { error: "Mapping type, source, and target master are required." }, { status: 400 });
    }

    if(team) {
      const {scope,mapping}=await saveDatasetMapping(request,id,body,{
        mapping_type:mappingType,source_key:sourceKey,source_label:sourceLabel,target_master_type:targetMasterType,
        target_master_key:targetMasterKey,target_master_name:targetMasterName,status:body.status==='inactive'?'inactive':'active',
        notes:toNullableText(body.notes,1000),
      });
      return jsonWithCors(request,{mapping:{...serializeTallyMapping({...mapping,connection_id:id,
        owner_user_id:scope.connection.owner_user_id,company_name:scope.link.company_name} as TallyMappingRow),revision:mapping.revision}});
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_mapping_settings")
      .upsert(
        {
          connection_id: id,
          owner_user_id: user.id,
          company_name: connection!.last_company_name ?? "Unknown company",
          mapping_type: mappingType,
          source_key: sourceKey,
          source_label: sourceLabel,
          target_master_type: targetMasterType,
          target_master_key: targetMasterKey,
          target_master_name: targetMasterName,
          status: body.status === "inactive" ? "inactive" : "active",
          notes: toNullableText(body.notes, 1000),
        },
        {
          onConflict: "connection_id,company_name,mapping_type,source_key",
        }
      )
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    await supabase.from("tally_connection_events").insert({
      connection_id: id,
      owner_user_id: user.id,
      event_type: "mapping_saved",
      message: "Tally mapping saved.",
      payload: {
        mappingType,
        sourceKey,
        targetMasterType,
        targetMasterName,
      },
    });

    return jsonWithCors(request, {
      mapping: serializeTallyMapping(data as unknown as TallyMappingRow),
    });
  } catch (error) {
    const denied=accessFailureResponse(request,error);if(denied)return denied;
    console.error("Error in POST /api/tally/connections/[id]/mappings:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
export const POST = withTeamAccess(POSTHandler);
