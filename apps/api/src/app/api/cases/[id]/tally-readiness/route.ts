import { withTeamAccess } from '@/lib/access/route-boundary';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { readStoredLineItems } from "@/lib/line-items";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { TallyMappingRow, TallyMappingType } from "@/lib/tally/masters";
import type { CommercialLineItem, FieldKey } from "@/types/pipeline";

type PacketDocumentRow = {
  id: string;
  document_type: string;
  extracted_fields: unknown;
};

type TallyConnectionRow = {
  id: string;
  display_name: string;
  status: string;
  last_company_name: string | null;
  last_tally_reachable: boolean | null;
  last_company_loaded: boolean | null;
  last_heartbeat_at: string | null;
  updated_at: string;
};

type ReadinessCheck = {
  key: string;
  label: string;
  status: "ok" | "missing" | "warning";
  sourceValue: string | null;
  targetName: string | null;
  message: string;
};

function normalizeSource(value: unknown) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

function normalizeRate(value: unknown) {
  const text = normalizeSource(value)?.replace(/%/g, "");
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return Number.isInteger(parsed) ? String(parsed) : String(parsed).replace(/0+$/, "").replace(/\.$/, "");
}

function readFields(row: PacketDocumentRow) {
  if (!row.extracted_fields || typeof row.extracted_fields !== "object" || Array.isArray(row.extracted_fields)) {
    return {};
  }
  return row.extracted_fields as Record<string, unknown>;
}

function firstFieldValue(rows: PacketDocumentRow[], field: FieldKey) {
  for (const row of rows) {
    const value = normalizeSource(readFields(row)[field]);
    if (value) return value;
  }
  return null;
}

function collectLineItems(rows: PacketDocumentRow[]) {
  return rows.flatMap((row) => readStoredLineItems(row.extracted_fields));
}

function firstTaxRate(rows: PacketDocumentRow[], lineItems: CommercialLineItem[]) {
  const fieldNames = ["taxRate", "igstRate", "cgstRate", "sgstRate"];

  for (const row of rows) {
    const fields = readFields(row);
    for (const fieldName of fieldNames) {
      const rate = normalizeRate(fields[fieldName]);
      if (rate) return rate;
    }
  }

  for (const item of lineItems) {
    for (const fieldName of fieldNames) {
      const rate = normalizeRate(item[fieldName as keyof CommercialLineItem]);
      if (rate) return rate;
    }
  }

  return null;
}

function firstLineItemHsn(lineItems: CommercialLineItem[]) {
  for (const item of lineItems) {
    const hsn = normalizeSource(item.hsnSac);
    if (hsn) return hsn;
  }
  return null;
}

function buildMappingLookup(rows: TallyMappingRow[]) {
  const lookup = new Map<string, TallyMappingRow>();
  for (const row of rows) {
    if (row.status !== "active") continue;
    lookup.set(`${row.mapping_type}:${row.source_key.trim().toLowerCase()}`, row);
  }
  return lookup;
}

function findMapping(
  lookup: Map<string, TallyMappingRow>,
  mappingType: TallyMappingType,
  sourceValue: string | null
) {
  if (!sourceValue) return null;
  return lookup.get(`${mappingType}:${sourceValue.trim().toLowerCase()}`) ?? null;
}

function mappedCheck(params: {
  key: string;
  label: string;
  mappingType: TallyMappingType;
  sourceValue: string | null;
  lookup: Map<string, TallyMappingRow>;
  missingSourceMessage: string;
  missingMappingMessage: string;
}): ReadinessCheck {
  if (!params.sourceValue) {
    return {
      key: params.key,
      label: params.label,
      status: "warning",
      sourceValue: null,
      targetName: null,
      message: params.missingSourceMessage,
    };
  }

  const mapping = findMapping(params.lookup, params.mappingType, params.sourceValue);
  if (!mapping) {
    return {
      key: params.key,
      label: params.label,
      status: "missing",
      sourceValue: params.sourceValue,
      targetName: null,
      message: params.missingMappingMessage,
    };
  }

  return {
    key: params.key,
    label: params.label,
    status: "ok",
    sourceValue: params.sourceValue,
    targetName: mapping.target_master_name,
    message: "Mapped",
  };
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
    const supabase = createSupabaseAdminClient();

    const { data: caseRow, error: caseError } = await supabase
      .from("packet_cases")
      .select("id, status, owner_user_id")
      .eq("id", id)
      .eq("owner_user_id", user.id)
      .maybeSingle();

    if (caseError) throw caseError;
    if (!caseRow) {
      return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
    }

    const [{ data: connectionData, error: connectionError }, { data: documentsData, error: documentsError }] =
      await Promise.all([
        supabase
          .from("tally_connections")
          .select("id, display_name, status, last_company_name, last_tally_reachable, last_company_loaded, last_heartbeat_at, updated_at")
          .eq("owner_user_id", user.id)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("packet_documents")
          .select("id, document_type, extracted_fields")
          .eq("case_id", id)
          .order("created_at", { ascending: true }),
      ]);

    if (connectionError) throw connectionError;
    if (documentsError) throw documentsError;

    const connection = connectionData as TallyConnectionRow | null;
    if (!connection) {
      return jsonWithCors(request, {
        status: "no_connection",
        connection: null,
        checks: [],
        missingCount: 0,
        warningCount: 0,
        ready: false,
      });
    }

    const { data: mappingsData, error: mappingsError } = await supabase
      .from("tally_mapping_settings")
      .select("*")
      .eq("connection_id", connection.id)
      .eq("owner_user_id", user.id)
      .eq("company_name", connection.last_company_name ?? "Unknown company")
      .eq("status", "active");

    if (mappingsError) throw mappingsError;

    const documents = (documentsData ?? []) as PacketDocumentRow[];
    const lineItems = collectLineItems(documents);
    const lookup = buildMappingLookup((mappingsData ?? []) as unknown as TallyMappingRow[]);

    const supplierSource =
      firstFieldValue(documents, "supplierGstin") || firstFieldValue(documents, "vendorName");
    const buyerSource = firstFieldValue(documents, "buyerGstin") || firstFieldValue(documents, "buyerName");
    const gstRate = firstTaxRate(documents, lineItems);
    const itemHsn = firstLineItemHsn(lineItems);

    const checks: ReadinessCheck[] = [
      mappedCheck({
        key: "supplier_ledger",
        label: "Supplier ledger",
        mappingType: "supplier_gstin",
        sourceValue: supplierSource,
        lookup,
        missingSourceMessage: "No supplier GSTIN or supplier name detected in the case.",
        missingMappingMessage: "Map this supplier to a Tally ledger in Settings.",
      }),
      mappedCheck({
        key: "gst_ledger",
        label: "GST ledger",
        mappingType: "gst_rate",
        sourceValue: gstRate,
        lookup,
        missingSourceMessage: "No GST rate detected in the case.",
        missingMappingMessage: "Map this GST rate to a Tally GST ledger in Settings.",
      }),
    ];

    if (buyerSource) {
      checks.push(
        mappedCheck({
          key: "buyer_ledger",
          label: "Buyer ledger",
          mappingType: "buyer_gstin",
          sourceValue: buyerSource,
          lookup,
          missingSourceMessage: "No buyer GSTIN or buyer name detected in the case.",
          missingMappingMessage: "Map this buyer to a Tally ledger in Settings.",
        })
      );
    }

    if (itemHsn) {
      checks.push(
        mappedCheck({
          key: "stock_item",
          label: "Stock item",
          mappingType: "item_hsn",
          sourceValue: itemHsn,
          lookup,
          missingSourceMessage: "No HSN detected in line items.",
          missingMappingMessage: "Map this HSN to a Tally stock item in Settings.",
        })
      );
    }

    const missingCount = checks.filter((check) => check.status === "missing").length;
    const warningCount = checks.filter((check) => check.status === "warning").length;
    const connectionReady = Boolean(connection.last_tally_reachable && connection.last_company_loaded);
    const accepted = caseRow.status === "accepted";
    const ready = accepted && connectionReady && missingCount === 0;

    const status = !accepted
      ? "accept_case_first"
      : !connectionReady
        ? "connection_not_ready"
        : missingCount > 0
          ? "mapping_required"
          : "ready_to_post";

    return jsonWithCors(request, {
      status,
      ready,
      missingCount,
      warningCount,
      connection: {
        id: connection.id,
        displayName: connection.display_name,
        status: connection.status,
        companyName: connection.last_company_name,
        tallyReachable: connection.last_tally_reachable,
        companyLoaded: connection.last_company_loaded,
        lastHeartbeatAt: connection.last_heartbeat_at,
      },
      extracted: {
        supplierSource,
        buyerSource,
        gstRate,
        itemHsn,
        lineItemCount: lineItems.length,
        documentCount: documents.length,
      },
      checks,
    });
  } catch (error) {
    console.error("Error in GET /api/cases/[id]/tally-readiness:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
