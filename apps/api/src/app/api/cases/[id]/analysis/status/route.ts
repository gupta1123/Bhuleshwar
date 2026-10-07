import { listAccessPredicate } from '@/lib/access/list-scope';
import { withTeamAccess } from '@/lib/access/route-boundary';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { getLatestProcessingJob, mapProcessingJob } from "@/lib/processing/jobs";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const user = await requireRequestUser(request);

    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createSupabaseAdminClient();
    const { data: caseRow, error: caseError } = await supabase
      .from("packet_cases")
      .select("id, status")
      .eq("id", id)
      .or(await listAccessPredicate(request, user.id, 'purchases.view'))
      .maybeSingle();

    if (caseError) {
      throw caseError;
    }

    if (!caseRow) {
      return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
    }

    const job = await getLatestProcessingJob(id);
    return jsonWithCors(request, {
      caseStatus: caseRow.status,
      job: mapProcessingJob(job),
    });
  } catch (error) {
    return jsonWithCors(
      request,
      { error: error instanceof Error ? error.message : String(error ?? "Unknown error") },
      { status: 500 }
    );
  }
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export const GET = withTeamAccess(GETHandler);
