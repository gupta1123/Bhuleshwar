import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode } from "@/lib/local/mode";
import { claimNextLocalTallyCommand } from "@/lib/local/tally-store";
import {
  hashSecret,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
} from "@/lib/tally/connections";
import {
  serializeTallyBridgeCommand,
  type TallyBridgeCommandRow,
} from "@/lib/tally/commands";

function getBridgeToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1] ?? request.headers.get("x-bridge-token") ?? "";
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const bridgeVersion = url.searchParams.get("bridgeVersion") ?? null;
    const requestedLimit = Number(url.searchParams.get("limit") || 1);
    const limit = Math.max(1, Math.min(50, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 1));
    const token = getBridgeToken(request);

    if (!connectionId || !token) {
      return jsonWithCors(request, { error: "Connection id and bridge token are required." }, { status: 400 });
    }

    if (isLocalDbMode()) {
      const commands = [];
      for (let index = 0; index < limit; index += 1) {
        const result = await claimNextLocalTallyCommand({
          connectionId,
          token,
          bridgeVersion,
        });
        if (result.unauthorized) {
          return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
        }
        if (!result.command) break;
        commands.push(serializeTallyBridgeCommand(result.command));
      }
      return jsonWithCors(request, {
        command: commands[0] ?? null,
        commands,
      });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("id", connectionId)
      .maybeSingle();

    if (error) throw error;

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

    if (process.env.TEAM_ACCESS_ENFORCEMENT === 'true') {
      const commands = [];
      for (let index = 0; index < limit; index += 1) {
        const claimed = await supabase.rpc('access_claim_next_command', {
          p_connection: connection.id, p_installation: connection.installation_id,
          p_generation: connection.session_generation, p_bridge_version: bridgeVersion,
        });
        if (claimed.error) {
          return jsonWithCors(request, { error: 'Command authorization or pairing is unavailable.' }, { status: claimed.error.code === '42501' ? 403 : 503 });
        }
        if (!claimed.data) break;
        commands.push(serializeTallyBridgeCommand(claimed.data as TallyBridgeCommandRow));
      }
      return jsonWithCors(request, { command: commands[0] ?? null, commands });
    }

    const now = new Date().toISOString();
    const sessionFilter = `protocol_version.eq.0,and(installation_id.eq.${connection.installation_id},session_generation.eq.${connection.session_generation})`;
    const staleClaimedBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    // A Purchase write may have reached Tally even when the connector result was
    // lost. Never requeue it automatically: preserve the frozen payload and
    // require a read-only verification pass before any later create command.
    const { data: uncertainPurchaseCommands, error: uncertainPurchaseError } = await supabase
      .from("tally_bridge_commands")
      .update({
        status: "failed",
        completed_at: now,
        error: "Purchase write result missing; verify the existing voucher before retrying.",
      })
      .eq("connection_id", connection.id)
      .or(sessionFilter)
      .eq("command_type", "create_purchase_voucher")
      .eq("status", "claimed")
      .lt("claimed_at", staleClaimedBefore)
      .select("id");
    if (uncertainPurchaseError) throw uncertainPurchaseError;
    const uncertainPurchaseIds = (uncertainPurchaseCommands ?? []).map((command) => command.id);
    if (uncertainPurchaseIds.length > 0) {
      const { error: postingUncertainError } = await supabase
        .from("purchase_invoice_tally_postings")
        .update({
          status: "verification_required",
          verification_status: "result_delivery_interrupted",
          last_error: "Tally may already contain this voucher. Run verification before retrying.",
        })
        .in("command_id", uncertainPurchaseIds)
        .in("status", ["approved", "queued", "creating"]);
      if (postingUncertainError) throw postingUncertainError;
    }
    const { error: exhaustedClaimError } = await supabase
      .from("tally_bridge_commands")
      .update({
        status: "failed",
        completed_at: now,
        error: "Bridge claimed this command but did not report a result before the retry limit.",
      })
      .eq("connection_id", connection.id)
      .or(sessionFilter)
      .eq("status", "claimed")
      .neq("command_type", "create_purchase_voucher")
      .lt("claimed_at", staleClaimedBefore)
      .gte("attempts", 3)
      .select("id, command_type");

    if (exhaustedClaimError) throw exhaustedClaimError;
    const { error: staleClaimError } = await supabase
      .from("tally_bridge_commands")
      .update({
        status: "queued",
        claimed_at: null,
        error: "Requeued after the bridge claimed this command but did not report a result.",
      })
      .eq("connection_id", connection.id)
      .or(sessionFilter)
      .eq("status", "claimed")
      .neq("command_type", "create_purchase_voucher")
      .lt("claimed_at", staleClaimedBefore)
      .lt("attempts", 3)
      .select("id, command_type");

    if (staleClaimError) throw staleClaimError;
    const { data: commandData, error: commandError } = await supabase
      .from("tally_bridge_commands")
      .select("*")
      .eq("connection_id", connection.id)
      .or(sessionFilter)
      .eq("status", "queued")
      .lte("available_at", now)
      .lt("attempts", 3)
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (commandError) throw commandError;
    if (!commandData) {
      return jsonWithCors(request, { command: null });
    }

    const command = commandData as unknown as TallyBridgeCommandRow;
    const { data: claimedData, error: claimError } = await supabase
      .from("tally_bridge_commands")
      .update({
        status: "claimed",
        claimed_at: now,
        attempts: command.attempts + 1,
        bridge_version: bridgeVersion,
      })
      .eq("id", command.id)
      .eq("status", "queued")
      .select("*")
      .maybeSingle();

    if (claimError) throw claimError;
    if (!claimedData) {
      return jsonWithCors(request, { command: null });
    }

    if ((claimedData as TallyBridgeCommandRow).command_type === "create_purchase_voucher") {
      await supabase
        .from("purchase_invoice_tally_postings")
        .update({ status: "creating", last_error: null })
        .eq("command_id", (claimedData as TallyBridgeCommandRow).id)
        .in("status", ["approved", "queued", "creating"]);
    }

    return jsonWithCors(request, {
      command: serializeTallyBridgeCommand(claimedData as unknown as TallyBridgeCommandRow),
      commands: [serializeTallyBridgeCommand(claimedData as unknown as TallyBridgeCommandRow)],
    });
  } catch (error) {
    console.error("Error in GET /api/tally/bridge/commands/next:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
