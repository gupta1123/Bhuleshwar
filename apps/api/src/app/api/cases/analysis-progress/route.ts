import { listAccessPredicate } from '@/lib/access/list-scope';
import { withTeamAccess } from '@/lib/access/route-boundary';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const MAX_CASE_IDS = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Live progress for the cases list: one call covers every case that is queued or running.
async function GETHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const ids = (new URL(request.url).searchParams.get("ids") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => UUID_PATTERN.test(value))
      .slice(0, MAX_CASE_IDS);
    if (!ids.length) {
      return jsonWithCors(request, { progress: {} });
    }

    const supabase = createSupabaseAdminClient();
    const { data: cases, error } = await supabase.from("packet_cases")
      .select("id,packet_processing_jobs(id,status,progress,stage,error)")
      .in("id", ids)
      .is("deleted_at", null)
      .eq("packet_processing_jobs.job_type", "case_analysis")
      .or(await listAccessPredicate(request, user.id, 'purchases.view'))
      .order("created_at", { referencedTable: "packet_processing_jobs", ascending: false })
      .limit(1, { referencedTable: "packet_processing_jobs" });
    if (error) throw error;
    const progress: Record<string, { id: string; status: string; progress: number; stage: string | null; error: string | null; queuePosition?: number | null }> = Object.fromEntries((cases ?? []).filter(row => row.packet_processing_jobs.length)
      .map(row => [row.id, row.packet_processing_jobs[0]]));
    if (Object.values(progress).some(job => job.status === "queued")) {
      const { data: waiting, error: queueError } = await supabase.from("packet_processing_jobs")
        .select("id,attempt_count,max_attempts")
        .eq("status", "queued")
        .lte("next_run_at", new Date().toISOString())
        .order("created_at", { ascending: true })
        .limit(1000);
      if (!queueError) {
        const positions = new Map((waiting ?? []).filter(job => job.attempt_count < job.max_attempts)
          .map((job, index) => [job.id, index + 1]));
        for (const job of Object.values(progress)) {
          if (job.status === "queued") job.queuePosition = positions.get(job.id) ?? null;
        }
      }
    }
    return jsonWithCors(request, { progress });
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
