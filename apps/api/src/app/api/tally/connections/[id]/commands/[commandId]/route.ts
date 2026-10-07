import { withTeamAccess } from '@/lib/access/route-boundary';
import {readTeamCommands} from '@/lib/access/command-results';
import {accessFailureResponse} from '@/lib/access/failures';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

// Fast status lookup for a known command. Ownership is enforced on the
// command row itself, avoiding the former connection read + command read.
async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string; commandId: string }> }
) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });

    const { id, commandId } = await context.params;
    if(process.env.TEAM_ACCESS_ENFORCEMENT==='true') {
      const [command]=await readTeamCommands(request,id,[commandId],1);
      return jsonWithCors(request,{command:command?{
        id:command.id,status:command.status,result:command.result,error:command.error,
        completedAt:command.completed_at,updatedAt:command.updated_at,compactProgress:command.compact_progress,
      }:null});
    }
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_bridge_commands")
      .select("id, status, result, error, completed_at, updated_at, compact_progress")
      .eq("id", commandId)
      .eq("connection_id", id)
      .eq("owner_user_id", user.id)
      .maybeSingle();
    if (error) throw error;

    return jsonWithCors(request, {
      command: data ? {
        id: data.id,
        status: data.status,
        result: data.result,
        error: data.error,
        completedAt: data.completed_at,
        updatedAt: data.updated_at,
        compactProgress: data.compact_progress,
      } : null,
    });
  } catch (error) {
    console.error("Error in GET /api/tally/connections/[id]/commands/[commandId]:", error);
    const accessFailure=accessFailureResponse(request,error);if(accessFailure)return accessFailure;
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
