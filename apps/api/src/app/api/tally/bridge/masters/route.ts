import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {accessFailureResponse} from '@/lib/access/failures';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import {
  hashSecret,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
} from "@/lib/tally/connections";
import {
  MASTER_TYPES,
  normalizeMasterInput,
  toNullableText,
  type TallyMasterInput,
  type TallyMasterType,
} from "@/lib/tally/masters";

const MASTER_INPUT_KEYS: Record<string, TallyMasterType> = {
  ledgers: "ledger",
  groups: "group",
  stockItems: "stock_item",
  units: "unit",
  voucherTypes: "voucher_type",
  gstLedgers: "gst_ledger",
  taxLedgers: "tax_ledger",
};

// Tally companies can contain several thousand masters. A single giant
// upsert creates an unnecessarily large PostgREST request and was the source
// of intermittent generic failures for large client companies.
const MASTER_UPSERT_BATCH_SIZE = 300;

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || "Master sync failed.");
  }
  return String(error || "Master sync failed.");
}

function getBridgeToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1] ?? request.headers.get("x-bridge-token") ?? "";
}

function asMasterInputs(value: unknown): TallyMasterInput[] {
  return Array.isArray(value) ? (value as TallyMasterInput[]) : [];
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function POST(request: Request) {
  let syncFailureContext: {
    supabase: ReturnType<typeof createSupabaseAdminClient>;
    syncRunId: string;
  } | null = null;
  try {
    const token = getBridgeToken(request);
    const body = await request.json().catch(() => ({}));
    const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";

    if (!connectionId || !token) {
      return jsonWithCors(request, { error: "Connection id and bridge token are required." }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("id", connectionId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    const connection = data as unknown as TallyConnectionRow | null;

    if (connection?.revoked_at) {
      return jsonWithCors(
        request,
        { error: "This connector session has been revoked. Reconnect this computer." },
        { status: 409 }
      );
    }
    if (!connection?.bridge_token_hash || hashSecret(token) !== connection.bridge_token_hash) {
      return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
    }

    const mastersPayload = body.masters && typeof body.masters === "object" ? body.masters : {};
    const now = new Date().toISOString();
    const companyName = toNullableText(body.companyName, 240) ?? "Unknown company";
    const companyProfile = body.companyProfile && typeof body.companyProfile === "object"
      ? body.companyProfile as Record<string, unknown>
      : {};
    const companyGstin = toNullableText(companyProfile.gstin, 32);
    const companyStateCode = toNullableText(companyProfile.stateCode, 8);
    const rows: Array<Record<string, unknown>> = [];
    const totals: Record<string, number> = {};
    const syncedTypes = new Set<TallyMasterType>();

    for (const [payloadKey, masterType] of Object.entries(MASTER_INPUT_KEYS)) {
      const items = asMasterInputs((mastersPayload as Record<string, unknown>)[payloadKey]);
      totals[masterType] = items.length;
      if (Array.isArray((mastersPayload as Record<string, unknown>)[payloadKey])) {
        syncedTypes.add(masterType);
      }

      for (const item of items) {
        const normalized = normalizeMasterInput(masterType, item);
        if (!normalized) continue;

        rows.push({
          ...normalized,
          connection_id: connection.id,
          owner_user_id: connection.owner_user_id,
          company_name: companyName,
          is_active: true,
          last_synced_at: now,
        });
      }
    }

    if(process.env.TEAM_ACCESS_ENFORCEMENT==='true') {
      if(!body.commandId||!body.identity)return jsonWithCors(request,{error:'A scoped master-sync command is required. Update the connector and start a sync from Bhuleshwar.'},{status:409});
      if(rows.length>20000||Buffer.byteLength(JSON.stringify(rows))>32*1024*1024)
        return jsonWithCors(request,{error:'Master snapshot exceeds the supported limit.'},{status:413});
      const {data:saved,error:saveError}=await supabase.rpc('access_save_master_snapshot',{
        p_command:body.commandId,p_connection:connection.id,p_token_hash:hashSecret(token),p_identity:body.identity,
        p_types:[...syncedTypes],p_rows:rows,
      });
      if(saveError)throw saveError;
      return jsonWithCors(request,{...saved,totals,masters:[],supportedTypes:MASTER_TYPES});
    }

    const { data: syncRun, error: runError } = await supabase
      .from("tally_master_sync_runs")
      .insert({
        connection_id: connection.id,
        owner_user_id: connection.owner_user_id,
        status: "failed",
        company_name: companyName,
        company_gstin: companyGstin,
        company_state_code: companyStateCode,
        bridge_version: toNullableText(body.bridgeVersion, 80),
        totals,
        error: "Master sync did not complete.",
        completed_at: now,
      })
      .select("id")
      .single();

    if (runError) {
      throw runError;
    }

    const syncRunId = (syncRun as { id: string }).id;
    syncFailureContext = { supabase, syncRunId };

    // This sync can explicitly read a company that is not currently open in
    // Tally. Do not overwrite the heartbeat's active-company value here; doing
    // so would make the UI believe a different company is live.
    await supabase
      .from("tally_connections")
      .update({ last_tested_at: now })
      .eq("id", connection.id);

    const rowsWithRun = rows.map((row) => ({
      ...row,
      sync_run_id: syncRunId,
    }));

    const reportedMasterCount = Object.values(totals).reduce((sum, total) => sum + total, 0);
    if (reportedMasterCount > 0 && rowsWithRun.length === 0) {
      throw new Error(
        "Tally reported masters, but none contained a recognizable name. Update the connector and retry."
      );
    }

    if (rowsWithRun.length > 0) {
      for (let start = 0; start < rowsWithRun.length; start += MASTER_UPSERT_BATCH_SIZE) {
        const batch = rowsWithRun.slice(start, start + MASTER_UPSERT_BATCH_SIZE);
        const { error: upsertError } = await supabase
          .from("tally_masters")
          .upsert(batch, {
            onConflict: "connection_id,company_name,master_type,master_key",
          });

        if (upsertError) {
          const batchNumber = Math.floor(start / MASTER_UPSERT_BATCH_SIZE) + 1;
          throw new Error(`Could not save Tally masters batch ${batchNumber}: ${errorMessage(upsertError)}`);
        }
      }
    }

    // Only retire the prior snapshot after the new rows have been written.
    // This prevents a failed upsert from leaving the company with no active
    // masters, and sync_run_id keeps the just-upserted rows active.
    // A refresh of this company must not invalidate another company's cache.

    if (syncedTypes.size > 0) {
      const { error: priorSnapshotDeactivateError } = await supabase
        .from("tally_masters")
        .update({ is_active: false, last_synced_at: now })
        .eq("connection_id", connection.id)
        .eq("company_name", companyName)
        .in("master_type", Array.from(syncedTypes))
        .or(`sync_run_id.is.null,sync_run_id.neq.${syncRunId}`)
        .eq("is_active", true);
      if (priorSnapshotDeactivateError) throw priorSnapshotDeactivateError;
    }

    const { error: completionError } = await supabase
      .from("tally_master_sync_runs")
      .update({
        status: "completed",
        totals,
        error: null,
        completed_at: now,
      })
      .eq("id", syncRunId)
      .eq("connection_id", connection.id);
    if (completionError) throw completionError;
    syncFailureContext = null;

    await supabase.from("tally_connection_events").insert({
      connection_id: connection.id,
      owner_user_id: connection.owner_user_id,
      event_type: "masters_synced",
      message: "Tally masters synced from bridge.",
      payload: {
        totals,
        syncRunId,
        companyName,
      },
    });

    return jsonWithCors(request, {
      syncRunId,
      totals,
      accepted: rowsWithRun.length,
      // The bridge only needs the acceptance count. Do not echo thousands of
      // rows back over HTTP after a successful sync.
      masters: [],
      supportedTypes: MASTER_TYPES,
    });
  } catch (error) {
    const denied=accessFailureResponse(request,error);if(denied)return denied;
    if (syncFailureContext) {
      await syncFailureContext.supabase
        .from("tally_master_sync_runs")
        .update({
          status: "failed",
          error: errorMessage(error).slice(0, 1000),
          completed_at: new Date().toISOString(),
        })
        .eq("id", syncFailureContext.syncRunId);
    }
    console.error("Error in POST /api/tally/bridge/masters:", error);
    return jsonWithCors(request, {
      error: `Master sync failed: ${errorMessage(error).slice(0, 500)}`,
    }, { status: 500 });
  }
}
