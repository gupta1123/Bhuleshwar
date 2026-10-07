import { listAccessPredicate } from '@/lib/access/list-scope';
import { withTeamAccess } from '@/lib/access/route-boundary';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  getCaseStatusForMismatchResolutions,
  isMismatchResolutionSchemaMissing,
  type MismatchResolutionStatus,
} from "@/lib/mismatch-resolution";
import { isCaseRecycled } from "@/lib/recycle-bin";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.error, record.details, record.hint]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);

    if (parts.length > 0) {
      const combined = parts.join(" ");
      if (/resolution_status|resolved_at/i.test(combined)) {
        return `${combined} Run the mismatch resolution migration in Supabase using supabase/packet_mismatch_resolution_backend_v8.sql, then retry.`;
      }
      return combined;
    }
  }

  return String(error ?? "Unknown error");
}

async function PATCHHandler(
  request: Request,
  context: { params: Promise<{ id: string; mismatchId: string }> }
) {
  try {
    const { id, mismatchId } = await context.params;
    const payload = (await request.json().catch(() => ({}))) as { action?: string };

    if (!["accept", "reject"].includes(payload.action ?? "")) {
      return jsonWithCors(request, { error: "Unsupported mismatch action." }, { status: 400 });
    }

    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createSupabaseAdminClient();
    const now = new Date().toISOString();
    const nextResolutionStatus =
      payload.action === "accept"
        ? ("accepted" as const)
        : ("rejected" as const);

    const { data: caseRow, error: caseError } = await supabase
      .from("packet_cases")
      .select("id, status, processing_meta")
      .eq("id", id)
      .or(await listAccessPredicate(request, user.id, 'purchases.view'))
      .single();

    if (caseError) {
      if (caseError.code === "PGRST116") {
        return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
      }
      throw caseError;
    }

    if (isCaseRecycled(caseRow.processing_meta)) {
      return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
    }

    if (caseRow.status === "accepted" || caseRow.status === "rejected") {
      return jsonWithCors(
        request,
        { error: "This case already has a final decision." },
        { status: 409 }
      );
    }

    if (caseRow.status !== "completed") {
      return jsonWithCors(
        request,
        { error: "Mismatch decisions are only available after analysis completes." },
        { status: 409 }
      );
    }

    const { data: mismatchRow, error: mismatchError } = await supabase
      .from("packet_mismatches")
      .select("id")
      .eq("id", mismatchId)
      .eq("case_id", id)
      .single();

    if (mismatchError) {
      if (mismatchError.code === "PGRST116") {
        return jsonWithCors(request, { error: "Mismatch not found." }, { status: 404 });
      }
      throw mismatchError;
    }

    const { data: updatedMismatch, error: updateMismatchError } = await supabase
      .from("packet_mismatches")
      .update({
        resolution_status: nextResolutionStatus,
        resolved_at: now,
      })
      .eq("id", mismatchId)
      .eq("case_id", id)
      .select("id, resolution_status, resolved_at")
      .single();

    if (updateMismatchError) {
      if (isMismatchResolutionSchemaMissing(updateMismatchError)) {
        return jsonWithCors(
          request,
          {
            error:
              "Mismatch resolution schema is not installed. Run supabase/packet_mismatch_resolution_backend_v8.sql, then retry.",
          },
          { status: 409 }
        );
      }
      throw updateMismatchError;
    }

    const { data: caseMismatchRows, error: statusQueryError } = await supabase
      .from("packet_mismatches")
      .select("resolution_status")
      .eq("case_id", id);

    if (statusQueryError) {
      if (isMismatchResolutionSchemaMissing(statusQueryError)) {
        return jsonWithCors(
          request,
          {
            error:
              "Mismatch resolution schema is not installed. Run supabase/packet_mismatch_resolution_backend_v8.sql, then retry.",
          },
          { status: 409 }
        );
      }
      throw statusQueryError;
    }

    const nextCaseStatus = getCaseStatusForMismatchResolutions(
      (caseMismatchRows ?? [])
        .map((row) => row.resolution_status)
        .filter(
          (status): status is MismatchResolutionStatus =>
            status === "pending" || status === "accepted" || status === "rejected"
        )
    );

    const { error: updateCaseError } = await supabase
      .from("packet_cases")
      .update({ status: nextCaseStatus })
      .eq("id", id)
      .or(await listAccessPredicate(request, user.id, 'purchases.view'));

    if (updateCaseError) {
      throw updateCaseError;
    }

    return jsonWithCors(request, {
      caseStatus: nextCaseStatus,
      mismatch: {
        id: updatedMismatch.id,
        resolutionStatus: updatedMismatch.resolution_status,
        resolvedAt: updatedMismatch.resolved_at,
      },
    });
  } catch (error) {
    return jsonWithCors(request, { error: serializeError(error) }, { status: 500 });
  }
}

export async function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export const PATCH = withTeamAccess(PATCHHandler);
