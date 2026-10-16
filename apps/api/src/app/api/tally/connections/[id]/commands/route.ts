import { withTeamAccess } from '@/lib/access/route-boundary';
import {readTeamCommands} from '@/lib/access/command-results';
import {queueTeamRead} from '@/lib/access/queue-read';
import {accessFailureResponse} from '@/lib/access/failures';
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { isLocalDbMode } from "@/lib/local/mode";
import {
  createLocalTallyCommand,
  getLocalTallyConnection,
  listLocalTallyCommands,
} from "@/lib/local/tally-store";
import {
  serializeTallyBridgeCommand,
  TALLY_BRIDGE_COMMAND_TYPES,
  type TallyBridgeCommandRow,
  type TallyBridgeCommandType,
} from "@/lib/tally/commands";
import { toNullableText, toRequiredText, type TallyMasterRow } from "@/lib/tally/masters";
import { wakeTallyConnector } from "@/lib/tally/command-wake";
import {
  acquireTallyMasterSyncLock,
  releaseTallyMasterSyncLock,
} from "@/lib/tally/master-sync-lock";

function parseCommandType(value: unknown): TallyBridgeCommandType | null {
  if (typeof value !== "string") return null;
  return TALLY_BRIDGE_COMMAND_TYPES.includes(value as TallyBridgeCommandType)
    ? (value as TallyBridgeCommandType)
    : null;
}

function uniqueTextValues(values: unknown[], maxLength: number) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const text = toRequiredText(value).slice(0, maxLength).trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }

  return result;
}

function normalizeCompanyName(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function activeTallyCompanyError(
  connection: {
    last_company_name: string | null;
    last_tally_reachable: boolean | null;
    last_company_loaded: boolean | null;
  },
  requestedCompanyName: string | null
) {
  const activeCompanyName = toNullableText(connection.last_company_name, 240);
  if (connection.last_tally_reachable !== true || connection.last_company_loaded !== true || !activeCompanyName) {
    return "Tally must be connected with an active company before reading company data.";
  }
  if (
    requestedCompanyName &&
    normalizeCompanyName(requestedCompanyName) !== normalizeCompanyName(activeCompanyName)
  ) {
    return `Tally is currently open to ${activeCompanyName}. Switch Tally to ${requestedCompanyName} before reading its data.`;
  }
  return null;
}

async function requireConnection(ownerUserId: string, connectionId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("tally_connections")
    .select("id, owner_user_id, status, last_company_name, last_tally_reachable, last_company_loaded, revoked_at")
    .eq("id", connectionId)
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();

  if (error) throw error;
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
      const url=new URL(request.url);
      const ids=(url.searchParams.get('ids')||'').split(',').map(v=>v.trim()).filter(Boolean);
      const commands=await readTeamCommands(request,id,ids,Number(url.searchParams.get('limit')||20));
      return jsonWithCors(request,{commands:commands.map(serializeTallyBridgeCommand)});
    }
    const connection = isLocalDbMode()
      ? await getLocalTallyConnection(id, user.id)
      : await requireConnection(user.id, id);
    if (!connection) {
      return jsonWithCors(request, { error: "Tally connection not found" }, { status: 404 });
    }
    if (connection.revoked_at) {
      return jsonWithCors(
        request,
        { error: "This Tally connection is no longer active. Reconnect this computer." },
        { status: 409 }
      );
    }

    const url = new URL(request.url);
    const requestedCommandIds = (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 100);
    const requestedLimit = Number(url.searchParams.get("limit") ?? "");
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
      : requestedCommandIds.length > 0
        ? requestedCommandIds.length
        : 20;

    if (isLocalDbMode()) {
      return jsonWithCors(request, {
        commands: (await listLocalTallyCommands({
          connectionId: id,
          ownerUserId: user.id,
          ids: requestedCommandIds,
          limit,
        })).map(serializeTallyBridgeCommand),
      });
    }

    const supabase = createSupabaseAdminClient();
    let query = supabase
      .from("tally_bridge_commands")
      .select("*")
      .eq("connection_id", id)
      .eq("owner_user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (requestedCommandIds.length > 0) {
      query = query.in("id", requestedCommandIds);
    }

    const { data, error } = await query;

    if (error) throw error;

    return jsonWithCors(request, {
      commands: ((data ?? []) as unknown as TallyBridgeCommandRow[]).map(serializeTallyBridgeCommand),
    });
  } catch (error) {
    console.error("Error in GET /api/tally/connections/[id]/commands:", error);
    const accessFailure=accessFailureResponse(request,error);if(accessFailure)return accessFailure;
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
    if(process.env.TEAM_ACCESS_ENFORCEMENT==='true') {
      return jsonWithCors(request,await queueTeamRead(request,id,await request.json()));
    }
    const connection = isLocalDbMode()
      ? await getLocalTallyConnection(id, user.id)
      : await requireConnection(user.id, id);
    if (!connection) {
      return jsonWithCors(request, { error: "Tally connection not found" }, { status: 404 });
    }
    if (connection.revoked_at) {
      return jsonWithCors(
        request,
        { error: "This Tally connection is no longer active. Reconnect this computer." },
        { status: 409 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const commandType = parseCommandType(body.commandType);
    if (!commandType) {
      return jsonWithCors(request, { error: "Unsupported Tally command type." }, { status: 400 });
    }

    const rawPayload = body.payload && typeof body.payload === "object"
      ? (body.payload as Record<string, unknown>)
      : {};

    if (commandType === "sync_masters") {
      const companyName =
        toNullableText(rawPayload.companyName, 240) ??
        toNullableText(connection.last_company_name, 240);
      const liveCompanyError = activeTallyCompanyError(connection, companyName);
      if (liveCompanyError) {
        return jsonWithCors(request, { error: liveCompanyError }, { status: 409 });
      }
      const supportedMasterTypes = new Set(["ledger", "group", "stock_item", "unit", "voucher_type", "gst_ledger", "tax_ledger"]);
      const requestedMasterTypes = Array.isArray(rawPayload.requestedMasterTypes)
        ? rawPayload.requestedMasterTypes.filter((value): value is string => typeof value === "string" && supportedMasterTypes.has(value))
        : ["ledger", "group", "stock_item", "unit", "voucher_type", "gst_ledger", "tax_ledger"];
      if (requestedMasterTypes.length === 0) {
        return jsonWithCors(request, { error: "Choose at least one supported Tally master type." }, { status: 400 });
      }
      const payload = {
        companyName,
        requestedMasterTypes,
        mode: "ledger_accuracy",
      };

      if (isLocalDbMode()) {
        const lock = await acquireTallyMasterSyncLock({
          supabase: null,
          local: true,
          connectionId: id,
          ownerUserId: user.id,
          companyName: companyName ?? "Unknown company",
        });
        if (!lock.acquired) {
          return jsonWithCors(request, { error: "A Tally company refresh is already running. Wait for it to finish before trying again." }, { status: 409 });
        }
        let command;
        try {
          command = await createLocalTallyCommand({
            connectionId: id,
            ownerUserId: user.id,
            commandType,
            payload: { ...payload, syncLockToken: lock.token },
            priority: 10,
          });
        } catch (error) {
          await releaseTallyMasterSyncLock({ supabase: null, local: true, connectionId: id, token: lock.token });
          throw error;
        }

        return jsonWithCors(request, {
          command: serializeTallyBridgeCommand(command),
        });
      }

      const supabase = createSupabaseAdminClient();
      const lock = await acquireTallyMasterSyncLock({
        supabase,
        connectionId: id,
        ownerUserId: user.id,
        companyName: companyName ?? "Unknown company",
      });
      if (!lock.acquired) {
        return jsonWithCors(request, { error: "A Tally company refresh is already running. Wait for it to finish before trying again." }, { status: 409 });
      }
      const { data, error } = await supabase
        .from("tally_bridge_commands")
        .insert({
          connection_id: id,
          owner_user_id: user.id,
          command_type: commandType,
          status: "queued",
          priority: 10,
          payload: { ...payload, syncLockToken: lock.token },
        })
        .select("*")
        .single();

      if (error) {
        await releaseTallyMasterSyncLock({
          supabase,
          connectionId: id,
          token: lock.token,
        });
        throw error;
      }

      await Promise.all([
        supabase.from("tally_connection_events").insert({
          connection_id: id,
          owner_user_id: user.id,
          event_type: "command_queued",
          message: "Tally master sync queued for bridge.",
          payload: {
            commandType,
            companyName,
            requestedMasterTypes,
          },
        }),
        wakeTallyConnector(id),
      ]);

      return jsonWithCors(request, {
        command: serializeTallyBridgeCommand(data as unknown as TallyBridgeCommandRow),
      });
    }

    if (commandType === "fetch_bank_ledgers") {
      const requestedCompanyNames = uniqueTextValues(
        [
          ...(Array.isArray(rawPayload.companyNames) ? rawPayload.companyNames : []),
          rawPayload.companyName,
          connection.last_company_name,
        ],
        240
      );

      const payload = {
        companyName: requestedCompanyNames[0] ?? null,
        companyNames: requestedCompanyNames,
      };

      if (isLocalDbMode()) {
        const command = await createLocalTallyCommand({
          connectionId: id,
          ownerUserId: user.id,
          commandType,
          payload,
          priority: 15,
        });

        return jsonWithCors(request, {
          command: serializeTallyBridgeCommand(command),
        });
      }

      const supabase = createSupabaseAdminClient();
      const { data, error } = await supabase
        .from("tally_bridge_commands")
        .insert({
          connection_id: id,
          owner_user_id: user.id,
          command_type: commandType,
          status: "queued",
          priority: 15,
          payload,
        })
        .select("*")
        .single();

      if (error) throw error;

      await supabase.from("tally_connection_events").insert({
        connection_id: id,
        owner_user_id: user.id,
        event_type: "command_queued",
        message: "Tally bank ledger fetch queued for bridge.",
        payload: {
          commandType,
          companyNames: requestedCompanyNames,
        },
      });

      return jsonWithCors(request, {
        command: serializeTallyBridgeCommand(data as unknown as TallyBridgeCommandRow),
      });
    }

    if (commandType === "fetch_purchase_masters") {
      const companyName =
        toNullableText(rawPayload.companyName, 240) ??
        toNullableText(connection.last_company_name, 240);
      const liveCompanyError = activeTallyCompanyError(connection, companyName);
      if (liveCompanyError) {
        return jsonWithCors(request, { error: liveCompanyError }, { status: 409 });
      }

      const payload = {
        companyName: companyName ?? "Unknown company",
        purpose: "purchase_posting_dropdowns",
        // Keep the live Tally evidence for the known reproduction masters in
        // the command result. This is intentionally limited to two names so
        // diagnostics never copy the entire Tally catalogue into the API.
        diagnostics: {
          masterNames: uniqueTextValues(
            Array.isArray(rawPayload.diagnosticMasterNames)
              ? rawPayload.diagnosticMasterNames
              : ["KTC-260707 Test Supplier", "M.S. Scrap & Sponge Iron"],
            500
          ).slice(0, 10),
        },
      };

      if (isLocalDbMode()) {
        const command = await createLocalTallyCommand({
          connectionId: id,
          ownerUserId: user.id,
          commandType,
          payload,
          priority: 18,
        });
        return jsonWithCors(request, {
          command: serializeTallyBridgeCommand(command),
        });
      }

      const supabase = createSupabaseAdminClient();
      const { data, error } = await supabase
        .from("tally_bridge_commands")
        .insert({
          connection_id: id,
          owner_user_id: user.id,
          command_type: commandType,
          status: "queued",
          priority: 18,
          payload,
        })
        .select("*")
        .single();
      if (error) {
        throw error;
      }

      await supabase.from("tally_connection_events").insert({
        connection_id: id,
        owner_user_id: user.id,
        event_type: "command_queued",
        message: "Live Purchase-posting masters requested from Tally.",
        payload: { commandType, companyName },
      });

      return jsonWithCors(request, {
        command: serializeTallyBridgeCommand(data as unknown as TallyBridgeCommandRow),
      });
    }

    if (commandType === "alter_ledger") {
      const masterKey = toRequiredText(rawPayload.masterKey).slice(0, 500);
      const newName = toRequiredText(rawPayload.newName).slice(0, 500);

      if (!masterKey || !newName) {
        return jsonWithCors(request, { error: "Ledger and new name are required." }, { status: 400 });
      }

      const supabase = createSupabaseAdminClient();
      const { data: masterData, error: masterError } = await supabase
        .from("tally_masters")
        .select("*")
        .eq("connection_id", id)
        .eq("owner_user_id", user.id)
        .eq("company_name", toNullableText(connection.last_company_name, 240) ?? "Unknown company")
        .eq("master_key", masterKey)
        .in("master_type", ["ledger", "gst_ledger"])
        .eq("is_active", true)
        .maybeSingle();

      if (masterError) throw masterError;
      if (!masterData) {
        return jsonWithCors(request, { error: "Synced ledger was not found." }, { status: 404 });
      }

      const master = masterData as unknown as TallyMasterRow;
      if (master.tally_name.trim().toLowerCase() === newName.trim().toLowerCase()) {
        return jsonWithCors(request, { error: "New ledger name is the same as the current name." }, { status: 400 });
      }

      const payload = {
        masterType: master.master_type,
        masterKey: master.master_key,
        tallyGuid: master.tally_guid,
        oldName: master.tally_name,
        newName,
        parentName: master.parent_name,
        companyName: toNullableText(connection.last_company_name, 240),
      };

      const { data, error } = await supabase
        .from("tally_bridge_commands")
        .insert({
          connection_id: id,
          owner_user_id: user.id,
          command_type: commandType,
          status: "queued",
          payload,
        })
        .select("*")
        .single();

      if (error) throw error;

      await supabase.from("tally_connection_events").insert({
        connection_id: id,
        owner_user_id: user.id,
        event_type: "command_queued",
        message: "Tally ledger edit queued for bridge.",
        payload: {
          commandType,
          oldName: master.tally_name,
          newName,
        },
      });

      return jsonWithCors(request, {
        command: serializeTallyBridgeCommand(data as unknown as TallyBridgeCommandRow),
      });
    }

    if (commandType === "create_ledger") {
      const name = toRequiredText(rawPayload.name).slice(0, 500);
      const parentName = toRequiredText(rawPayload.parentName).slice(0, 240);

      if (!name || !parentName) {
        return jsonWithCors(request, { error: "Ledger name and parent group are required." }, { status: 400 });
      }

      const supabase = createSupabaseAdminClient();
      const { data: existing, error: existingError } = await supabase
        .from("tally_masters")
        .select("id")
        .eq("connection_id", id)
        .eq("owner_user_id", user.id)
        .eq("company_name", toNullableText(connection.last_company_name, 240) ?? "Unknown company")
        .eq("master_type", "ledger")
        .ilike("tally_name", name)
        .eq("is_active", true)
        .limit(1);

      if (existingError) throw existingError;
      if ((existing ?? []).length > 0) {
        return jsonWithCors(request, { error: "A synced ledger with this name already exists." }, { status: 409 });
      }

      const payload = {
        name,
        parentName,
        companyName: toNullableText(connection.last_company_name, 240),
      };

      const { data, error } = await supabase
        .from("tally_bridge_commands")
        .insert({
          connection_id: id,
          owner_user_id: user.id,
          command_type: commandType,
          status: "queued",
          priority: 30,
          payload,
        })
        .select("*")
        .single();

      if (error) throw error;

      await supabase.from("tally_connection_events").insert({
        connection_id: id,
        owner_user_id: user.id,
        event_type: "command_queued",
        message: "Tally ledger create queued for bridge.",
        payload: {
          commandType,
          name,
          parentName,
        },
      });

      return jsonWithCors(request, {
        command: serializeTallyBridgeCommand(data as unknown as TallyBridgeCommandRow),
      });
    }

    if (commandType === "fetch_customer_open_bills") {
      const requestedLedgerNames = uniqueTextValues(
        [
          ...(Array.isArray(rawPayload.ledgerNames) ? rawPayload.ledgerNames : []),
          rawPayload.ledgerName,
        ],
        500
      );
      if (requestedLedgerNames.length === 0) {
        return jsonWithCors(request, { error: "Party ledger name is required." }, { status: 400 });
      }

      const companyName =
        toNullableText(rawPayload.companyName, 240) ??
        toNullableText(connection.last_company_name, 240);
      const liveCompanyError = activeTallyCompanyError(connection, companyName);
      if (liveCompanyError) {
        return jsonWithCors(request, { error: liveCompanyError }, { status: 409 });
      }

      const payload = {
        ledgerName: requestedLedgerNames[0],
        ledgerNames: requestedLedgerNames,
        companyName,
        scanId: toNullableText(rawPayload.scanId, 120),
      };

      if (isLocalDbMode()) {
        const command = await createLocalTallyCommand({
          connectionId: id,
          ownerUserId: user.id,
          commandType,
          payload,
          priority: 25,
        });

        return jsonWithCors(request, {
          command: serializeTallyBridgeCommand(command),
        });
      }

      const supabase = createSupabaseAdminClient();
      const { data, error } = await supabase
        .from("tally_bridge_commands")
        .insert({
          connection_id: id,
          owner_user_id: user.id,
          command_type: commandType,
          status: "queued",
          priority: 25,
          payload,
        })
        .select("*")
        .single();

      if (error) throw error;

      await supabase.from("tally_connection_events").insert({
        connection_id: id,
        owner_user_id: user.id,
        event_type: "command_queued",
        message: "Party open bill fetch queued for bridge.",
        payload: {
          commandType,
          ledgerNames: requestedLedgerNames,
        },
      });

      return jsonWithCors(request, {
        command: serializeTallyBridgeCommand(data as unknown as TallyBridgeCommandRow),
      });
    }

    if (commandType === "verify_bank_transaction") {
      const rawTransactions = Array.isArray(rawPayload.transactions)
        ? rawPayload.transactions.slice(0, 250)
        : [];
      const companyName =
        toNullableText(rawPayload.companyName, 240) ??
        toNullableText(connection.last_company_name, 240);
      const liveCompanyError = activeTallyCompanyError(connection, companyName);
      if (liveCompanyError) {
        return jsonWithCors(request, { error: liveCompanyError }, { status: 409 });
      }

      if (rawTransactions.length > 0) {
        const transactions = rawTransactions.flatMap((value, index) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return [];
          const row = value as Record<string, unknown>;
          const voucherDate = toRequiredText(row.voucherDate).slice(0, 20);
          const amount = Number(String(row.amount ?? "").replace(/,/g, ""));
          const expectedDirection = toRequiredText(row.expectedDirection).toLowerCase();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(voucherDate)) {
            throw new Error(`Bank statement row ${index + 1} requires a valid date.`);
          }
          if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error(`Bank statement row ${index + 1} requires a positive amount.`);
          }
          if (expectedDirection !== "incoming" && expectedDirection !== "outgoing") {
            throw new Error(`Bank statement row ${index + 1} requires a debit/credit direction.`);
          }
          return [{
            transactionId: toNullableText(row.transactionId, 200),
            voucherDate,
            amount,
            debitAmount: Number(String(row.debitAmount ?? "0").replace(/,/g, "")) || 0,
            creditAmount: Number(String(row.creditAmount ?? "0").replace(/,/g, "")) || 0,
            balanceAmount: row.balanceAmount === null || row.balanceAmount === undefined || row.balanceAmount === ""
              ? null
              : Number(String(row.balanceAmount).replace(/,/g, "")),
            expectedDirection,
            counterpartyLedgerName: toNullableText(row.counterpartyLedgerName, 500),
            narration: toNullableText(row.narration, 2000),
            referenceNumber: toNullableText(row.referenceNumber, 500),
          }];
        });
        const bankLedgerName = toRequiredText(rawPayload.bankLedgerName).slice(0, 500);
        if (!bankLedgerName) {
          return jsonWithCors(request, { error: "Bank ledger name is required." }, { status: 400 });
        }
        if (transactions.length !== rawTransactions.length) {
          return jsonWithCors(request, { error: "Every bank statement row must be valid." }, { status: 400 });
        }

        const payload = {
          companyName,
          bankLedgerName,
          transactions,
          source: "bank_statement_batch_review_check",
        };
        if (isLocalDbMode()) {
          const command = await createLocalTallyCommand({
            connectionId: id,
            ownerUserId: user.id,
            commandType,
            payload,
            priority: 20,
          });
          return jsonWithCors(request, { command: serializeTallyBridgeCommand(command) });
        }

        const supabase = createSupabaseAdminClient();
        const { data, error } = await supabase
          .from("tally_bridge_commands")
          .insert({
            connection_id: id,
            owner_user_id: user.id,
            command_type: commandType,
            status: "queued",
            priority: 20,
            payload,
          })
          .select("*")
          .single();
        if (error) throw error;
        return jsonWithCors(request, {
          command: serializeTallyBridgeCommand(data as unknown as TallyBridgeCommandRow),
        });
      }

      const voucherDate = toRequiredText(rawPayload.voucherDate).slice(0, 20);
      const bankLedgerName = toRequiredText(rawPayload.bankLedgerName).slice(0, 500);
      const amount = Number(String(rawPayload.amount ?? "").replace(/,/g, ""));

      if (!/^\d{4}-\d{2}-\d{2}$/.test(voucherDate)) {
        return jsonWithCors(request, { error: "A valid voucher date is required." }, { status: 400 });
      }
      if (!bankLedgerName) {
        return jsonWithCors(request, { error: "Bank ledger name is required." }, { status: 400 });
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        return jsonWithCors(request, { error: "A positive transaction amount is required." }, { status: 400 });
      }

      const payload = {
        companyName,
        voucherDate,
        bankLedgerName,
        amount,
        counterpartyLedgerName: toNullableText(rawPayload.counterpartyLedgerName, 500),
        matchedLedgerName: toNullableText(rawPayload.matchedLedgerName, 500),
        narration: toNullableText(rawPayload.narration, 2000),
        referenceNumber: toNullableText(rawPayload.referenceNumber, 500),
        transactionType: toNullableText(rawPayload.transactionType, 120),
        category: toNullableText(rawPayload.category, 120),
        counterpartyName: toNullableText(rawPayload.counterpartyName, 500),
        expectedDirection: "outgoing",
        source: "bank_statement_review_check",
      };

      if (isLocalDbMode()) {
        const command = await createLocalTallyCommand({
          connectionId: id,
          ownerUserId: user.id,
          commandType,
          payload,
          priority: 20,
        });

        return jsonWithCors(request, {
          command: serializeTallyBridgeCommand(command),
        });
      }

      const supabase = createSupabaseAdminClient();
      const { data, error } = await supabase
        .from("tally_bridge_commands")
        .insert({
          connection_id: id,
          owner_user_id: user.id,
          command_type: commandType,
          status: "queued",
          priority: 20,
          payload,
        })
        .select("*")
        .single();

      if (error) throw error;

      await supabase.from("tally_connection_events").insert({
        connection_id: id,
        owner_user_id: user.id,
        event_type: "command_queued",
        message: "Outgoing bank transaction verification queued for bridge.",
        payload: {
          commandType,
          bankLedgerName,
          amount,
          voucherDate,
        },
      });

      return jsonWithCors(request, {
        command: serializeTallyBridgeCommand(data as unknown as TallyBridgeCommandRow),
      });
    }

    return jsonWithCors(request, { error: "Unsupported Tally command type." }, { status: 400 });
  } catch (error) {
    console.error("Error in POST /api/tally/connections/[id]/commands:", error);
    const accessFailure=accessFailureResponse(request,error);if(accessFailure)return accessFailure;
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
export const POST = withTeamAccess(POSTHandler);
