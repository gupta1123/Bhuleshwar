import { withTeamAccess } from '@/lib/access/route-boundary';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { wakeTallyConnector } from "@/lib/tally/command-wake";
import { serializeTallyBridgeCommand, type TallyBridgeCommandRow } from "@/lib/tally/commands";
import { toNullableText } from "@/lib/tally/masters";
import { getCashDiscountCustomerScopeOrDefault } from "@/lib/cash-discount-customer-scope";

function normalize(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function scanIdempotencyKey(
  operation: "cash_discount_scan" | "cash_discount_revalidate",
  companyName: string,
  financialYear: string | null,
  proposal: Record<string, unknown> | null
) {
  const parts = ["cash-discount-v2", operation, normalize(companyName), normalize(financialYear)];
  if (operation === "cash_discount_revalidate") {
    parts.push(normalize(proposal?.partyLedgerName), normalize(proposal?.linkedInvoiceNumber));
  }
  return parts.join("|").slice(0, 500);
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function POSTHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const connectionId = toNullableText(body.connectionId, 80);
    const companyName = toNullableText(body.companyName, 240);
    const operation = body.operation === "revalidate" ? "cash_discount_revalidate" : "cash_discount_scan";
    const proposal = body.proposal && typeof body.proposal === "object"
      ? (body.proposal as Record<string, unknown>)
      : null;
    const financialYear = toNullableText(body.financialYear ?? proposal?.financialYear, 20);
    if (!connectionId || !companyName) {
      return jsonWithCors(request, { error: "The live Tally company is required." }, { status: 400 });
    }
    if (operation === "cash_discount_revalidate" && !toNullableText(proposal?.partyLedgerName, 500)) {
      return jsonWithCors(request, { error: "The customer ledger is required for revalidation." }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    // These reads are independent. Running them together saves one full
    // Supabase round trip on every refresh.
    const [connectionResult, customerScope] = await Promise.all([
      supabase
        .from("tally_connections")
        .select("id, owner_user_id, last_company_name, last_tally_reachable, last_company_loaded, revoked_at")
        .eq("id", connectionId)
        .eq("owner_user_id", user.id)
        .maybeSingle(),
      getCashDiscountCustomerScopeOrDefault({
        ownerUserId: user.id,
        connectionId,
        companyName,
      }),
    ]);
    const { data: connection, error: connectionError } = connectionResult;
    if (connectionError) throw connectionError;
    if (!connection || connection.revoked_at) {
      return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    }
    if (
      connection.last_tally_reachable !== true ||
      connection.last_company_loaded !== true ||
      normalize(connection.last_company_name) !== normalize(companyName)
    ) {
      return jsonWithCors(
        request,
        { error: `Tally must be open to ${companyName} before Cash Discounts can be refreshed.` },
        { status: 409 }
      );
    }

    const idempotencyKey = scanIdempotencyKey(operation, companyName, financialYear, proposal);
    const activeCommandQuery = () => supabase
      .from("tally_bridge_commands")
      .select("*")
      .eq("connection_id", connectionId)
      .eq("owner_user_id", user.id)
      .eq("command_type", "fetch_customer_open_bills")
      .eq("idempotency_key", idempotencyKey)
      .in("status", ["queued", "claimed"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Insert first. The partial unique index is the concurrency guard; doing a
    // read before every insert added a cloud round trip to the normal path.
    const { data: insertedCommand, error: commandError } = await supabase
      .from("tally_bridge_commands")
      .insert({
        connection_id: connectionId,
        owner_user_id: user.id,
        // Reuse the established read-only command type so older database
        // constraints remain compatible. The transport marker selects the
        // optimized one-pass Cash Discount snapshot in the connector.
        command_type: "fetch_customer_open_bills",
        idempotency_key: idempotencyKey,
        status: "queued",
        priority: operation === "cash_discount_revalidate" ? 40 : 25,
        payload: {
          transport: "cash_discount_snapshot_v2",
          operation,
          companyName,
          financialYear,
          proposal,
          customerScope,
        },
      })
      .select("*")
      .single();
    let commandData = insertedCommand;
    if (commandError?.code === "23505") {
      const { data: racedCommand, error: racedCommandError } = await activeCommandQuery();
      if (racedCommandError) throw racedCommandError;
      commandData = racedCommand;
    } else if (commandError) {
      throw commandError;
    }
    if (!commandData) throw new Error("The Cash Discount scan could not be queued.");

    await Promise.all([
      supabase.from("tally_connection_events").insert({
        connection_id: connectionId,
        owner_user_id: user.id,
        event_type: "command_queued",
        message: operation === "cash_discount_revalidate"
          ? "Cash Discount revalidation queued for bridge."
          : "Cash Discount live snapshot queued for bridge.",
        payload: { commandType: "fetch_customer_open_bills", transport: "cash_discount_snapshot_v2" },
      }),
      wakeTallyConnector(connectionId),
    ]);

    return jsonWithCors(request, {
      command: serializeTallyBridgeCommand(commandData as unknown as TallyBridgeCommandRow),
      reused: Boolean(commandError),
    });
  } catch (error) {
    console.error("Error in POST /api/collections/live/queue-scan:", error);
    return jsonWithCors(
      request,
      { error: error instanceof Error ? error.message : "Could not queue the Cash Discount scan." },
      { status: 500 }
    );
  }
}

export const POST = withTeamAccess(POSTHandler);
