import { withTeamAccess } from '@/lib/access/route-boundary';
import { requireResourceAccess } from '@/lib/access/resources';
import { AccessError } from '@/lib/access/server';
import {accessFailureResponse} from '@/lib/access/failures';
import { listAccessPredicate } from '@/lib/access/list-scope';
import { purchaseFinancialDigest } from '@/lib/access/purchase-digest';
import { createHash } from "node:crypto";
import { readPurchaseDocumentFolder, purchaseDocumentCompanyKeys } from '@/lib/purchase-document-folder';

import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  getPurchaseAccountingSettingsOrDefaults,
  type PurchaseAccountingSettings,
} from "@/lib/purchase-accounting-settings";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  serializeTallyConnectionStatus,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
} from "@/lib/tally/connections";
import {
  compactPurchasePostingReview,
  dedupeLedgerMasters,
  getCanonicalInvoiceDocuments,
  normalizePurchasePostingDate,
  normalizePurchaseDuplicatePart,
  preparePurchasePosting,
  type PurchasePostingDocumentInput,
  type PurchasePostingMappingInput,
  type PurchasePostingMasterInput,
  type PurchasePostingReview,
} from "@/lib/tally/purchase-posting";
import {
  suggestPurchaseLineMasters,
  suggestSupplierLedger,
} from "@/lib/tally/purchase-master-matching";
import { wakeTallyConnector } from "@/lib/tally/command-wake";

type PostingRow = {
  id: string;
  case_id: string;
  invoice_document_id: string | null;
  owner_user_id: string;
  connection_id: string | null;
  master_sync_run_id: string | null;
  command_id: string | null;
  status: string;
  revision: number;
  duplicate_key: string | null;
  idempotency_key: string | null;
  review_patch: Record<string, unknown>;
  approved_payload_hash: string | null;
  approved_at: string | null;
  queued_at: string | null;
  tally_voucher_number: string | null;
  tally_master_id: string | null;
  tally_guid: string | null;
  tally_created_at: string | null;
  verified_at: string | null;
  verification_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type LoadedContext = {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  caseRow: { id: string; status: string; owner_user_id: string };
  documents: PurchasePostingDocumentInput[];
  files: Array<{
    id: string;
    original_name: string;
    storage_bucket: string;
    storage_path: string;
  }>;
  connections: TallyConnectionRow[];
  connection: TallyConnectionRow | null;
  connectionStatus: ReturnType<typeof serializeTallyConnectionStatus> | null;
  liveCompanies: Array<{ companyName: string; isActive: boolean }>;
  selectedCompanyName: string | null;
  masters: PurchasePostingMasterInput[];
  liveMasterCommandId: string | null;
  liveMasterFetchedAt: string | null;
  liveMasterValidatedAt: string | null;
  liveMasterValidation: Record<string, unknown> | null;
  liveMasterTotals: Record<string, unknown>;
  masterSource: "live_purchase" | "synced_fallback" | null;
  liveCompanyProfile: {
    name: string | null;
    guid: string | null;
    gstin: string | null;
    stateCode: string | null;
  } | null;
  mappings: PurchasePostingMappingInput[];
  posting: PostingRow | null;
  sourceFileId: string | null;
  sourceDocumentReference: string | null;
  purchaseAccountingSettings: PurchaseAccountingSettings;
};

const MASTER_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;

function isPostingLocked(status: string | null | undefined) {
  return ["approved", "queued", "creating", "created", "verification_required"].includes(status ?? "");
}

function isFreshTimestamp(value: string | null | undefined, maxAgeMs: number) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp <= maxAgeMs;
}

function hasCompleteMasterSnapshot(context: Pick<LoadedContext, "liveMasterFetchedAt" | "liveMasterValidatedAt" | "liveMasterValidation" | "liveMasterTotals" | "liveCompanyProfile" | "masters">) {
  if (!context.liveMasterFetchedAt || !context.liveMasterValidatedAt) return false;
  const totals = context.liveMasterTotals ?? {};
  const validation = context.liveMasterValidation ?? {};
  const completeTypes = Array.isArray(validation.completeTypes)
    ? validation.completeTypes.map((value) => String(value))
    : [];
  const digest = typeof validation.catalogueDigest === "string" ? validation.catalogueDigest : "";
  const proofGuid = typeof validation.companyGuid === "string" ? validation.companyGuid.trim() : "";
  const profileGuid = context.liveCompanyProfile?.guid?.trim() ?? "";
  const proofFinancialYear = typeof validation.financialYear === "string" ? validation.financialYear.trim() : "";
  return (
    Number(validation.version || 0) >= 1 &&
    ["incremental_alter_id", "full_live_read"].includes(String(validation.mode || "")) &&
    Boolean(proofGuid && profileGuid && proofGuid === profileGuid && proofFinancialYear) &&
    ["ledger", "group", "stock_item", "unit"].every((type) =>
      Object.prototype.hasOwnProperty.call(totals, type) && completeTypes.includes(type)
    ) &&
    /^[a-f0-9]{64}$/i.test(digest) &&
    context.masters.some((master) => master.master_type === "ledger")
  );
}

function isMasterSnapshotFresh(context: Pick<LoadedContext, "liveMasterValidatedAt">) {
  return isFreshTimestamp(context.liveMasterValidatedAt, MASTER_SNAPSHOT_MAX_AGE_MS);
}

function serializeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== "object") return String(error ?? "Unknown error");
  const record = error as Record<string, unknown>;
  return [record.message, record.details, record.hint, record.error]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ") || JSON.stringify(error);
}

function isPurchasePostingSchemaMissing(error: unknown) {
  const message = serializeError(error);
  return /purchase_invoice_tally_postings|company_gstin|company_name.*tally_masters|schema cache|does not exist/i.test(message);
}

function normalizeFileName(value: string | null | undefined) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9.]+/g, "");
}

function normalizeCompanyName(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function invoiceBuyerName(documents: PurchasePostingDocumentInput[]) {
  const invoice = getCanonicalInvoiceDocuments(documents)[0];
  if (
    !invoice?.extracted_fields ||
    typeof invoice.extracted_fields !== "object" ||
    Array.isArray(invoice.extracted_fields)
  ) {
    return "";
  }

  const buyerName = (invoice.extracted_fields as Record<string, unknown>)
    .buyerName;
  return typeof buyerName === "string" ? buyerName.trim() : "";
}

function preferredLiveConnection(
  connections: TallyConnectionRow[],
  buyerName: string
) {
  const normalizedBuyerName = normalizeCompanyName(buyerName);
  if (!normalizedBuyerName) return null;

  return (
    connections.find((candidate) => {
      const status = serializeTallyConnectionStatus(candidate);
      return (
        status.bridgeConnected &&
        status.tallyReachable &&
        status.companyLoaded &&
        normalizeCompanyName(status.lastCompanyName) === normalizedBuyerName
      );
    }) ?? null
  );
}

function getSourceFile(
  documents: PurchasePostingDocumentInput[],
  files: LoadedContext["files"],
  selectedInvoiceDocumentId?: string | null
) {
  const canonicalInvoices = getCanonicalInvoiceDocuments(documents);
  const invoice = canonicalInvoices.find((candidate) =>
    selectedInvoiceDocumentId && candidate.id === selectedInvoiceDocumentId
  ) ?? canonicalInvoices[0];
  if (!invoice) return null;
  const sourceName = normalizeFileName(invoice.source_file_name);
  if (sourceName) {
    const exact = files.find((file) => normalizeFileName(file.original_name) === sourceName);
    if (exact) return exact;
    const partial = files.find((file) => {
      const fileName = normalizeFileName(file.original_name);
      return sourceName.includes(fileName) || fileName.includes(sourceName);
    });
    if (partial) return partial;
  }
  return files.length === 1 ? files[0] : null;
}

function duplicateKey(companyName: string, supplierGstin: string, invoiceNumber: string) {
  const raw = [companyName, supplierGstin, invoiceNumber]
    .map(normalizePurchaseDuplicatePart)
    .join(":");
  return createHash("sha256").update(raw.replace(/:+/g, ":")).digest("hex");
}

function idempotencyKey(caseId: string, revision: number, duplicate: string) {
  return createHash("sha256")
    .update(`purchase-voucher:${caseId}:${revision}:${duplicate}`)
    .digest("hex");
}

function asSavedReview(value: unknown): Partial<PurchasePostingReview> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const stringKeys = [
    "selectedInvoiceDocumentId",
    "invoiceNumber",
    "invoiceDate",
    "voucherDate",
    "supplierName",
    "supplierGstin",
    "buyerName",
    "buyerGstin",
    "vehicleNumber",
    "invoiceTotal",
    "gstRate",
    "supplierLedgerName",
    "cgstLedgerName",
    "sgstLedgerName",
    "igstLedgerName",
    "freightAmount",
    "freightGstRate",
    "freightLedgerName",
    "tds194qLedgerName",
    "tds194qRate",
    "tds194qBasisAmount",
    "tds194qRounding",
    "transportTdsLedgerName",
    "transportTdsRate",
    "cgstTdsLedgerName",
    "sgstTdsLedgerName",
    "igstTdsLedgerName",
    "gstTdsRate",
    "tdsLedgerName",
    "tdsRate",
    "tcsLedgerName",
    "tcsAmount",
    "roundOffLedgerName",
    "roundOffAmount",
    "narration",
  ] as const;
  for (const key of stringKeys) {
    if (typeof input[key] === "string") {
      const clean = input[key].trim().slice(0, key === "narration" ? 2000 : 300);
      output[key] = key === "invoiceDate" || key === "voucherDate"
        ? normalizePurchasePostingDate(clean)
        : clean;
    }
  }
  for (const key of ["applyTds194q", "applyTransportTds", "applyGstTds", "tcsReceivable", "sourceReferenceApproved"] as const) {
    if (typeof input[key] === "boolean") output[key] = input[key];
  }
  if (input.ewayBill && typeof input.ewayBill === "object" && !Array.isArray(input.ewayBill)) {
    const eway = input.ewayBill as Record<string, unknown>;
    const clean: Record<string, unknown> = {};
    if (typeof eway.record === "boolean") clean.record = eway.record;
    for (const key of ["number", "date", "fromAddress", "fromPlace", "fromPincode", "fromState", "toPlace", "toPincode", "toState", "transportMode", "vehicleNumber", "distanceKm"] as const) {
      if (typeof eway[key] === "string") {
        const value = eway[key].trim().slice(0, key === "fromAddress" ? 300 : 80);
        clean[key] = key === "date" ? normalizePurchasePostingDate(value) : value;
      }
    }
    output.ewayBill = clean;
  }
  if (Array.isArray(input.lines)) {
    const lineKeys = [
      "lineId",
      "description",
      "hsn",
      "quantity",
      "unit",
      "rate",
      "taxableAmount",
      "stockItemName",
      "purchaseLedgerName",
      "godownName",
      "batchName",
    ] as const;
    output.lines = input.lines.slice(0, 100).flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const record = candidate as Record<string, unknown>;
      if (typeof record.lineId !== "string" || !record.lineId.trim()) return [];
      const line: Record<string, string> = {};
      for (const key of lineKeys) {
        if (typeof record[key] === "string") {
          line[key] = record[key].trim().slice(0, key === "description" ? 500 : 300);
        }
      }
      return [line];
    });
  }
  return output as Partial<PurchasePostingReview>;
}

function serializePosting(
  row: PostingRow | null,
  prepared: Awaited<ReturnType<typeof prepareContext>>["prepared"],
  context: LoadedContext
) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    invoiceDocumentId: row.invoice_document_id,
    connectionId: row.connection_id,
    masterSyncRunId: row.master_sync_run_id,
    commandId: row.command_id,
    status: row.status,
    revision: row.revision,
    companyName: context.selectedCompanyName ?? null,
    companyGstin: context.liveCompanyProfile?.gstin ?? null,
    invoiceNumber: prepared.review?.invoiceNumber ?? null,
    supplierGstin: prepared.review?.supplierGstin ?? null,
    approvedAt: row.approved_at,
    queuedAt: row.queued_at,
    tallyVoucherNumber: row.tally_voucher_number,
    tallyMasterId: row.tally_master_id,
    tallyGuid: row.tally_guid,
    tallyCreatedAt: row.tally_created_at,
    verifiedAt: row.verified_at,
    verificationResult: row.verification_status
      ? { verificationStatus: row.verification_status }
      : {},
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function masterOption(master: PurchasePostingMasterInput) {
  const raw = master.raw_payload ?? {};
  const parsedClosingBalance = raw.closingBalance === null || raw.closingBalance === undefined
    ? Number.NaN
    : Number(raw.closingBalance);
  return {
    id: master.id,
    type: master.master_type,
    key: master.master_key,
    name: master.tally_name,
    parent: master.parent_name,
    gstin: master.gstin,
    hsnCode: master.hsn_code,
    unitName: master.unit_name,
    taxRate: master.tax_rate,
    groupPath: master.group_path ?? master.parent_name,
    taxType: typeof raw.taxType === "string" ? raw.taxType : null,
    gstDutyHead: typeof raw.gstDutyHead === "string" ? raw.gstDutyHead : null,
    closingBalance: Number.isFinite(parsedClosingBalance) ? parsedClosingBalance : null,
    closingBalanceType:
      raw.closingBalanceType === "Dr" || raw.closingBalanceType === "Cr"
        ? raw.closingBalanceType
        : null,
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").replace(/%/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function livePurchaseMasters(resultValue: unknown): {
  companyName: string | null;
  fetchedAt: string | null;
  validatedAt: string | null;
  validation: Record<string, unknown> | null;
  totals: Record<string, unknown>;
  companyProfile: LoadedContext["liveCompanyProfile"];
  masters: PurchasePostingMasterInput[];
} | null {
  const result = recordValue(resultValue);
  const mastersValue = recordValue(result?.masters);
  if (!result || result.source !== "live_tally" || !mastersValue) return null;

  const groups = Array.isArray(mastersValue.groups) ? mastersValue.groups : [];
  const groupParentByName = new Map<string, string | null>();
  for (const value of groups) {
    const row = recordValue(value);
    const name = textValue(row?.name);
    if (name) groupParentByName.set(normalizeCompanyName(name), textValue(row?.parent));
  }
  const groupPath = (parentValue: unknown) => {
    const path: string[] = [];
    const visited = new Set<string>();
    let current = textValue(parentValue);
    while (current && path.length < 20) {
      const key = normalizeCompanyName(current);
      if (!key || visited.has(key)) break;
      visited.add(key);
      path.unshift(current);
      current = groupParentByName.get(key) ?? null;
    }
    return path.join(" > ") || null;
  };

  const convert = (values: unknown, masterType: "ledger" | "group" | "stock_item" | "unit" | "godown") =>
    (Array.isArray(values) ? values : []).flatMap((value, index) => {
      const row = recordValue(value);
      const name = textValue(row?.name);
      if (!row || !name) return [];
      const raw = recordValue(row.raw) ?? {};
      const guid = textValue(row.guid);
      return [{
        id: guid || `live:${masterType}:${index}:${normalizeCompanyName(name)}`,
        master_type: masterType,
        master_key: guid || normalizeCompanyName(name),
        tally_name: name,
        parent_name: textValue(row.parent),
        gstin: textValue(row.gstin),
        hsn_code: textValue(row.hsnCode),
        unit_name: textValue(row.unitName),
        tax_rate: numberValue(row.taxRate),
        group_path: textValue(row.groupPath) ?? groupPath(row.parent),
        raw_payload: {
          ...raw,
          closingBalance: row.closingBalance ?? raw.closingBalance,
          closingBalanceType: row.closingBalanceType ?? raw.closingBalanceType,
        },
        is_active: true,
      } satisfies PurchasePostingMasterInput];
    });

  const profile = recordValue(result.companyProfile);
  const validation = recordValue(result.validation);
  return {
    companyName: textValue(result.companyName),
    fetchedAt: textValue(result.fetchedAt),
    validatedAt: textValue(result.validatedAt) ?? textValue(validation?.validatedAt),
    validation,
    totals: recordValue(result.totals) ?? {},
    companyProfile: profile ? {
      name: textValue(profile.name),
      guid: textValue(profile.guid),
      gstin: textValue(profile.gstin),
      stateCode: textValue(profile.stateCode),
    } : null,
    masters: [
      ...convert(mastersValue.ledgers, "ledger"),
      ...convert(mastersValue.groups, "group"),
      ...convert(mastersValue.stockItems, "stock_item"),
      ...convert(mastersValue.units, "unit"),
      ...convert(mastersValue.godowns, "godown"),
    ],
  };
}

type PurchaseMappingProposal = PurchasePostingMappingInput & {
  source_label: string;
  target_master_type: string;
  target_master_key: string;
};

function purchaseMappingProposals(
  context: LoadedContext,
  review: Partial<PurchasePostingReview>,
  prepared: ReturnType<typeof preparePurchasePosting>
): PurchaseMappingProposal[] {
  const proposals: PurchaseMappingProposal[] = [];
  const seen = new Set<string>();
  const masterByName = new Map(
    context.masters.map((master) => [normalizeCompanyName(master.tally_name), master])
  );
  const add = (mappingType: string, sourceKey: string, sourceLabel: string, targetName: unknown) => {
    const target = masterByName.get(normalizeCompanyName(targetName));
    const cleanSourceKey = String(sourceKey ?? "").trim().slice(0, 240);
    if (!target || !cleanSourceKey) return;
    const key = `${mappingType}:${normalizeCompanyName(cleanSourceKey)}`;
    if (seen.has(key)) return;
    seen.add(key);
    proposals.push({
      mapping_type: mappingType,
      source_key: cleanSourceKey,
      source_label: sourceLabel.slice(0, 500),
      target_master_type: target.master_type,
      target_master_key: target.master_key,
      target_master_name: target.tally_name,
      status: "active",
    });
  };

  if (review.supplierLedgerName) {
    add(
      "supplier_gstin",
      review.supplierGstin || review.supplierName || "",
      review.supplierName || review.supplierGstin || "Invoice supplier",
      review.supplierLedgerName
    );
  }

  const calculation = prepared.calculation;
  const geography = calculation?.taxMode === "cgst_sgst"
    ? "local"
    : calculation?.taxMode === "igst"
      ? "interstate"
      : null;
  const hasAmount = (value: unknown) => {
    const amount = Number(String(value ?? "").replace(/,/g, ""));
    return Number.isFinite(amount) && Math.abs(amount) > 0.000001;
  };
  for (const line of review.lines ?? []) {
    const hsn = String(line.hsn ?? "").replace(/\D/g, "").slice(0, 8);
    const material = hsn.startsWith("7204") ? "ms_scrap" : hsn === "72031000" ? "sponge_iron" : "unknown";
    if (line.stockItemName) {
      add(
        hsn ? "item_hsn" : "item_description",
        hsn || line.description,
        line.description || hsn || "Invoice item",
        line.stockItemName
      );
    }
    if (line.purchaseLedgerName && material !== "unknown" && geography) {
      add(
        "purchase_ledger",
        `${material}:${geography}`,
        `${line.description || material} · ${geography} purchase`,
        line.purchaseLedgerName
      );
    }
  }

  const gstRate = Number(review.gstRate || 0);
  if (gstRate > 0 && calculation?.taxMode === "cgst_sgst") {
    if (review.cgstLedgerName) add("gst_rate", `cgst:${gstRate / 2}`, `Input CGST ${gstRate / 2}%`, review.cgstLedgerName);
    if (review.sgstLedgerName) add("gst_rate", `sgst:${gstRate / 2}`, `Input SGST ${gstRate / 2}%`, review.sgstLedgerName);
  } else if (gstRate > 0 && calculation?.taxMode === "igst" && review.igstLedgerName) {
    add("gst_rate", `igst:${gstRate}`, `Input IGST ${gstRate}%`, review.igstLedgerName);
  }
  if (hasAmount(calculation?.freightAmount) && review.freightLedgerName) {
    add("freight_ledger", "purchase", "Purchase freight", review.freightLedgerName);
  }
  if (hasAmount(calculation?.tds194qAmount) && review.tds194qLedgerName) {
    add("tds_ledger", "194q", "Purchase TDS 194Q", review.tds194qLedgerName);
  }
  if (hasAmount(calculation?.transportTdsAmount) && review.transportTdsLedgerName) {
    add("tds_ledger", "transport", "Transport TDS", review.transportTdsLedgerName);
  }
  if (hasAmount(calculation?.cgstTdsAmount) && review.cgstTdsLedgerName) {
    add("tds_ledger", "cgst_tds", "CGST TDS", review.cgstTdsLedgerName);
  }
  if (hasAmount(calculation?.sgstTdsAmount) && review.sgstTdsLedgerName) {
    add("tds_ledger", "sgst_tds", "SGST TDS", review.sgstTdsLedgerName);
  }
  if (hasAmount(calculation?.igstTdsAmount) && review.igstTdsLedgerName) {
    add("tds_ledger", "igst_tds", "IGST TDS", review.igstTdsLedgerName);
  }
  if (review.tcsReceivable && hasAmount(calculation?.tcsAmount) && review.tcsLedgerName) {
    add("tcs_ledger", "receivable", "TCS receivable", review.tcsLedgerName);
  }
  if (hasAmount(calculation?.roundOffAmount) && review.roundOffLedgerName) {
    add("round_off_ledger", "purchase", "Purchase round-off", review.roundOffLedgerName);
  }
  return proposals;
}

async function loadContext(
  request: Request,
  caseId: string,
  ownerUserId: string,
  requestedConnectionId?: string | null,
  requestedCompanyName?: string | null,
  liveMasterResult?: unknown,
  options: { loadMappings?: boolean } = {}
): Promise<LoadedContext> {
  const supabase = createSupabaseAdminClient();
  const team = process.env.TEAM_ACCESS_ENFORCEMENT === 'true'
    ? await requireResourceAccess(request, 'case', caseId, 'purchases.view') : null;
  const casePredicate = await listAccessPredicate(request, ownerUserId, 'purchases.view');
  let connectionPredicate = `owner_user_id.eq.${JSON.stringify(ownerUserId)}`;
  if (team) {
    const links = await supabase.from('access_company_links').select('connection_id')
      .eq('organization_id', team.access.organizationId).eq('company_id', team.scope.company_id!);
    if (links.error) throw new AccessError('Verified company routing is unavailable.', 503);
    const ids = [...new Set((links.data || []).map(row => row.connection_id as string))];
    if (requestedConnectionId && !ids.includes(requestedConnectionId)) throw new AccessError('Connection is outside the purchase company.', 403);
    connectionPredicate = ids.length ? `id.in.(${ids.map(id => JSON.stringify(id)).join(',')})` : 'id.is.null';
  }
  const loadMappings = options.loadMappings !== false;
  const earlyMappingsResultPromise = loadMappings && requestedConnectionId && requestedCompanyName
    ? supabase
        .from("tally_mapping_settings")
        .select("mapping_type, source_key, target_master_type, target_master_key, target_master_name, status")
        .eq("connection_id", requestedConnectionId)
        .ilike("company_name", requestedCompanyName)
        .eq("status", "active")
    : Promise.resolve({ data: [], error: null });
  const [caseResult, purchaseAccountingSettings, documentsResult, filesResult, connectionsResult, postingResult, earlyMappingsResult] = await Promise.all([
    supabase
      .from("packet_cases")
      .select("id, status, owner_user_id")
      .eq("id", caseId)
      .or(casePredicate)
      .maybeSingle(),
    getPurchaseAccountingSettingsOrDefaults(team?.access.organizationId ?? 'default'),
    supabase
      .from("packet_documents")
      .select("id, document_type, source_file_name, source_hint, title, extracted_fields, markdown")
      .eq("case_id", caseId)
      .order("created_at", { ascending: true }),
    supabase
      .from("packet_case_files")
      .select("id, original_name, storage_bucket, storage_path")
      .eq("case_id", caseId)
      .order("created_at", { ascending: true }),
    supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .or(connectionPredicate)
      .is("revoked_at", null)
      .not("bridge_token_hash", "is", null)
      .not("installation_id", "is", null)
      .not("paired_at", "is", null)
      .order("updated_at", { ascending: false })
      .limit(25),
    supabase
      .from("purchase_invoice_tally_postings")
      .select("*")
      .eq("case_id", caseId)
      .or(team ? 'id.not.is.null' : `owner_user_id.eq.${JSON.stringify(ownerUserId)}`)
      .maybeSingle(),
    earlyMappingsResultPromise,
  ]);

  if (caseResult.error) throw caseResult.error;
  if (!caseResult.data) throw new Error("CASE_NOT_FOUND");
  if (documentsResult.error) throw documentsResult.error;
  if (filesResult.error) throw filesResult.error;
  if (connectionsResult.error) throw connectionsResult.error;
  if (postingResult.error) throw postingResult.error;
  if (earlyMappingsResult.error) throw earlyMappingsResult.error;

  const caseRow = caseResult.data;
  const documents = (documentsResult.data ?? []) as PurchasePostingDocumentInput[];
  const files = filesResult.data ?? [];
  const allConnections = (connectionsResult.data ?? []) as unknown as TallyConnectionRow[];
  const connections = allConnections
    .filter((row) =>
      Boolean(row.bridge_token_hash) &&
      Boolean(row.installation_id) &&
      Boolean(row.paired_at) &&
      !row.revoked_at
    );
  const posting = postingResult.data as PostingRow | null;
  const usableConnectionIds = new Set(connections.map((candidate) => candidate.id));
  // Keep an in-flight or completed posting on its original connector while that
  // connector still exists. If it has been superseded/revoked, allow the page
  // to recover onto the owner's current live connector instead of selecting an
  // ID that was intentionally excluded above and returning a false 409.
  const lockedConnectionId =
    isPostingLocked(posting?.status) &&
    posting?.connection_id &&
    usableConnectionIds.has(posting.connection_id)
      ? posting.connection_id
      : null;
  const requestedUsableConnectionId =
    requestedConnectionId && usableConnectionIds.has(requestedConnectionId)
      ? requestedConnectionId
      : null;
  const savedUsableConnectionId =
    posting?.connection_id && usableConnectionIds.has(posting.connection_id)
      ? posting.connection_id
      : null;
  const buyerMatchedConnection = preferredLiveConnection(
    connections,
    invoiceBuyerName(documents)
  );
  const healthyConnections = connections.filter((candidate) => {
    const status = serializeTallyConnectionStatus(candidate);
    return (
      status.bridgeConnected &&
      status.tallyReachable &&
      status.companyLoaded &&
      !status.heartbeatStale
    );
  });
  const selectedConnectionId =
    lockedConnectionId ||
    requestedUsableConnectionId ||
    savedUsableConnectionId ||
    buyerMatchedConnection?.id ||
    // Historical/stale rows must not make an otherwise unambiguous live
    // connector look unselected. This is common on client PCs after pairing
    // again or replacing an installation.
    (healthyConnections.length === 1 ? healthyConnections[0].id : null) ||
    (connections.length === 1 ? connections[0].id : null);
  const connection = selectedConnectionId
    ? allConnections.find((candidate) => candidate.id === selectedConnectionId) ?? null
    : null;
  if (selectedConnectionId && !connection) {
    throw new Error("TALLY_CONNECTION_NOT_FOUND");
  }
  const connectionStatus = connection ? serializeTallyConnectionStatus(connection) : null;
  // The connection row is updated by every bridge heartbeat. Reading the event
  // table again added an entire hosted-DB round trip without improving the
  // active-company decision used by this purchase flow.
  const liveCompanies: Array<{ companyName: string; isActive: boolean }> =
    connectionStatus?.bridgeConnected &&
    connectionStatus.tallyReachable &&
    connectionStatus.lastCompanyName
      ? [{ companyName: connectionStatus.lastCompanyName, isActive: true }]
      : [];
  const requestedLiveCompany = liveCompanies.find(
    (company) =>
      normalizeCompanyName(company.companyName) ===
      normalizeCompanyName(requestedCompanyName)
  );
  const buyerLiveCompany = liveCompanies.find(
    (company) =>
      normalizeCompanyName(company.companyName) ===
      normalizeCompanyName(invoiceBuyerName(documents))
  );
  const selectedCompanyName =
    requestedLiveCompany?.companyName ??
    buyerLiveCompany?.companyName ??
    liveCompanies.find((company) => company.isActive)?.companyName ??
    null;
  const companyName = selectedCompanyName;

  let masters: PurchasePostingMasterInput[] = [];
  let mappings: PurchasePostingMappingInput[] = [];
  let liveMasterCommandId: string | null = null;
  let liveMasterFetchedAt: string | null = null;
  let liveMasterValidatedAt: string | null = null;
  let liveMasterValidation: Record<string, unknown> | null = null;
  let liveMasterTotals: Record<string, unknown> = {};
  let liveCompanyProfile: LoadedContext["liveCompanyProfile"] = null;
  let masterSource: LoadedContext["masterSource"] = null;
  if (connection && companyName) {
    const live = livePurchaseMasters(liveMasterResult);
    if (
      live &&
      normalizeCompanyName(live.companyName) === normalizeCompanyName(companyName)
    ) {
      masters = live.masters;
      liveMasterCommandId = `live:${live.validatedAt ?? live.fetchedAt ?? new Date().toISOString()}`;
      liveMasterFetchedAt = live.fetchedAt;
      liveMasterValidatedAt = live.validatedAt;
      liveMasterValidation = live.validation;
      liveMasterTotals = live.totals;
      liveCompanyProfile = live.companyProfile;
      masterSource = "live_purchase";
    }

    if (loadMappings) {
      const canUseEarlyMappings =
        connection.id === requestedConnectionId &&
        normalizeCompanyName(companyName) === normalizeCompanyName(requestedCompanyName);
      if (canUseEarlyMappings) {
        mappings = (earlyMappingsResult.data ?? []) as PurchasePostingMappingInput[];
      } else {
        const mappingsResult = await supabase
          .from("tally_mapping_settings")
          .select("mapping_type, source_key, target_master_type, target_master_key, target_master_name, status")
          .eq("connection_id", connection.id)
          .ilike("company_name", companyName)
          .eq("status", "active");
        if (mappingsResult.error) throw mappingsResult.error;
        mappings = (mappingsResult.data ?? []) as PurchasePostingMappingInput[];
      }
    }
  }

  const sourceFile = getSourceFile(
    documents,
    files,
    asSavedReview(posting?.review_patch)?.selectedInvoiceDocumentId
  );
  const webBase = String(
    process.env.WEB_BASE_URL ||
    process.env.NEXT_PUBLIC_WEB_BASE_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
  const sourceDocumentReference = sourceFile
    ? `${webBase}/cases/${caseId}?sourceFileId=${encodeURIComponent(sourceFile.id)}`
    : null;

  return {
    supabase,
    caseRow,
    documents,
    files,
    connections,
    connection,
    connectionStatus,
    liveCompanies,
    selectedCompanyName,
    masters,
    liveMasterCommandId,
    liveMasterFetchedAt,
    liveMasterValidatedAt,
    liveMasterValidation,
    liveMasterTotals,
    masterSource,
    liveCompanyProfile,
    mappings,
    posting,
    sourceFileId: sourceFile?.id ?? null,
    sourceDocumentReference,
    purchaseAccountingSettings,
  };
}

async function hasDuplicateClaim(params: {
  context: LoadedContext;
  ownerUserId: string;
  duplicate: string | null;
}) {
  if (!params.duplicate) return false;
  const { data, error } = await params.context.supabase
    .from("purchase_invoice_tally_postings")
    .select("id")
    .eq("owner_user_id", params.ownerUserId)
    .eq("duplicate_key", params.duplicate)
    .in("status", ["approved", "queued", "creating", "created"])
    .neq("case_id", params.context.caseRow.id)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

function prepareLoadedContext(
  context: LoadedContext,
  savedReview: Partial<PurchasePostingReview> | null | undefined,
  duplicateExists: boolean
) {
  const companyName = context.selectedCompanyName ?? "";
  const activeCompanyName = context.connectionStatus?.lastCompanyName ?? "";
  const companyGstin = context.liveCompanyProfile?.gstin ?? "";
  const masterSnapshotComplete = hasCompleteMasterSnapshot(context);
  const selectedSourceFile = getSourceFile(
    context.documents,
    context.files,
    savedReview?.selectedInvoiceDocumentId
  );
  const webBase = String(
    process.env.WEB_BASE_URL ||
    process.env.NEXT_PUBLIC_WEB_BASE_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
  const selectedSourceReference = selectedSourceFile
    ? `${webBase}/cases/${context.caseRow.id}?sourceFileId=${encodeURIComponent(selectedSourceFile.id)}`
    : null;
  return preparePurchasePosting({
    documents: context.documents,
    masters: context.masters,
    mappings: context.mappings,
    savedReview,
    caseStatus: context.caseRow.status,
    connectionReady: Boolean(
      context.connectionStatus?.bridgeConnected &&
      context.connectionStatus?.tallyReachable &&
      context.connectionStatus?.companyLoaded &&
      companyName &&
      normalizeCompanyName(companyName) ===
        normalizeCompanyName(activeCompanyName)
    ),
    masterDataReady: Boolean(
      context.liveMasterCommandId &&
      isMasterSnapshotFresh(context) &&
      masterSnapshotComplete
    ),
    companyName,
    companyGstin,
    sourceDocumentReference: selectedSourceReference,
    duplicateExists,
    accountingSettings: context.purchaseAccountingSettings,
  });
}

async function prepareContext(
  context: LoadedContext,
  ownerUserId: string,
  savedReview?: Partial<PurchasePostingReview> | null,
  options: { checkDuplicate?: boolean } = {}
) {
  const companyGstin = context.liveCompanyProfile?.gstin ?? "";
  const canonicalInvoices = getCanonicalInvoiceDocuments(context.documents);
  const source = canonicalInvoices.find((candidate) =>
    savedReview?.selectedInvoiceDocumentId === candidate.id
  ) ?? canonicalInvoices[0];
  const sourceFields = source?.extracted_fields && typeof source.extracted_fields === "object"
    ? source.extracted_fields as Record<string, unknown>
    : {};
  const draftInvoice = String(savedReview?.invoiceNumber ?? sourceFields.invoiceNumber ?? "");
  const draftSupplier = String(savedReview?.supplierGstin ?? sourceFields.supplierGstin ?? "");
  const companyIdentity = companyGstin || context.selectedCompanyName || "";
  const supplierIdentity = draftSupplier || String(
    savedReview?.supplierLedgerName ??
    sourceFields.supplierName ??
    sourceFields.vendorName ??
    ""
  );
  const duplicate = companyIdentity && draftInvoice && supplierIdentity
    ? duplicateKey(companyIdentity, supplierIdentity, draftInvoice)
    : null;
  const duplicateExists = options.checkDuplicate === false
    ? false
    : await hasDuplicateClaim({ context, ownerUserId, duplicate });
  return {
    prepared: prepareLoadedContext(context, savedReview, duplicateExists),
    duplicate,
    duplicateExists,
  };
}

function responseBody(
  context: LoadedContext,
  prepared: Awaited<ReturnType<typeof prepareContext>>["prepared"],
  options: { includeMasterOptions?: boolean } = {}
) {
  // A verified voucher is an immutable accounting result. Normal GETs do not
  // include the ephemeral live-master catalogue, so revalidating the frozen
  // selections would incorrectly report every selected master as missing.
  const postingVerified = context.posting?.status === "created";
  const blockers = postingVerified ? [] : prepared.blockers;
  const warnings = postingVerified ? [] : prepared.warnings;
  const connectionOptions = context.connection && context.connectionStatus
    ? context.liveCompanies.map((company) => {
    const status = context.connectionStatus!;
    return {
      id: `${context.connection!.id}::${encodeURIComponent(company.companyName)}`,
      connectionId: context.connection!.id,
      displayName: status.displayName,
      machineName: status.bridgeMachineName,
      status: status.status,
      companyName: company.companyName,
      isActive: company.isActive,
      bridgeConnected: status.bridgeConnected,
      tallyReachable: status.tallyReachable,
      companyLoaded: status.companyLoaded,
      heartbeatStale: status.heartbeatStale,
      connectorUpdateRequired: status.connectorUpdateRequired,
      lastHeartbeatAt: status.lastHeartbeatAt,
      lastError: status.lastError,
    };
  })
    : [];
  return {
    caseStatus: context.caseRow.status,
    hasSavedReview: Boolean(context.posting?.review_patch),
    posting: serializePosting(context.posting, prepared, context),
    eligibility: {
      eligible: prepared.eligible,
      canonicalInvoiceCount: prepared.canonicalInvoiceCount,
      invoiceCandidates: prepared.invoiceCandidates,
    },
    selectedConnectionId: context.connection?.id ?? null,
    selectedCompanyName: context.selectedCompanyName,
    connectionOptions,
    connection: context.connection && context.connectionStatus ? {
      id: context.connection.id,
      displayName: context.connectionStatus.displayName,
      machineName: context.connectionStatus.bridgeMachineName,
      status: context.connectionStatus.status,
      bridgeConnected: context.connectionStatus.bridgeConnected,
      heartbeatStale: context.connectionStatus.heartbeatStale,
      connectorUpdateRequired: context.connectionStatus.connectorUpdateRequired,
      lastError: context.connectionStatus.lastError,
      companyName: context.selectedCompanyName,
      activeCompanyName: context.connectionStatus.lastCompanyName,
      tallyReachable: context.connectionStatus.tallyReachable,
      companyLoaded: context.connectionStatus.companyLoaded,
      lastHeartbeatAt: context.connectionStatus.lastHeartbeatAt,
      masterSyncRunId: context.liveMasterCommandId,
      masterSyncedAt: context.liveMasterFetchedAt,
      masterValidatedAt: context.liveMasterValidatedAt,
      masterSnapshotFresh: isMasterSnapshotFresh(context),
      masterSnapshotComplete: hasCompleteMasterSnapshot(context),
      masterTotals: context.liveMasterTotals,
      masterSource: context.masterSource,
      companyGstin: context.liveCompanyProfile?.gstin ?? null,
      companyStateCode: context.liveCompanyProfile?.stateCode ?? null,
    } : null,
    sourceFileId: context.sourceFileId,
    sourceDocumentReference: context.sourceDocumentReference,
    accountingSettings: context.purchaseAccountingSettings,
    source: prepared.source,
    review: prepared.review,
    calculation: prepared.calculation,
    blockers,
    warnings,
    tallyPayload: prepared.tallyPayload,
    readyForApproval: postingVerified || blockers.length === 0,
    masterOptions: options.includeMasterOptions === false
      ? { ledgers: [], stockItems: [], units: [], godowns: [] }
      : {
          ledgers: dedupeLedgerMasters(context.masters).map(masterOption),
          stockItems: context.masters
            .filter((master) => master.master_type === "stock_item")
            .map(masterOption),
          units: context.masters
            .filter((master) => master.master_type === "unit")
            .map(masterOption),
          godowns: context.masters
            .filter((master) => master.master_type === "godown")
            .map(masterOption),
        },
    events: [],
  };
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function GETHandler(request: Request, contextParam: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    const { id } = await contextParam.params;
    const searchParams = new URL(request.url).searchParams;
    const requestedConnectionId = searchParams.get("connectionId");
    const requestedCompanyName = searchParams.get("companyName");
    const context = await loadContext(request,
      id,
      user.id,
      requestedConnectionId,
      requestedCompanyName,
      undefined,
      { loadMappings: false }
    );
    const { prepared } = await prepareContext(
      context,
      user.id,
      asSavedReview(context.posting?.review_patch),
      { checkDuplicate: false }
    );
    return jsonWithCors(request, responseBody(context, prepared));
  } catch (error) {
    const denied=accessFailureResponse(request,error);if(denied)return denied;
    if (serializeError(error) === "CASE_NOT_FOUND") {
      return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
    }
    if (serializeError(error) === "TALLY_CONNECTION_NOT_FOUND") {
      return jsonWithCors(request, { error: "The selected Tally connection is unavailable." }, { status: 409 });
    }
    if (isPurchasePostingSchemaMissing(error)) {
      return jsonWithCors(request, {
        error: "Purchase posting schema is not installed. Run supabase/migrations/202607270001_purchase_invoice_tally_posting.sql.",
        migrationRequired: true,
      }, { status: 409 });
    }
    console.error("Error in GET /api/cases/[id]/tally-posting:", error);
    return jsonWithCors(request, { error: serializeError(error) }, { status: 500 });
  }
}

async function PATCHHandler(request: Request, contextParam: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    const { id } = await contextParam.params;
    const body = await request.json().catch(() => ({}));
    const requestedReview = asSavedReview(body.review);
    const requestedConnectionId =
      typeof body.connectionId === "string" && body.connectionId.trim()
        ? body.connectionId.trim()
        : null;
    const requestedCompanyName =
      typeof body.companyName === "string" && body.companyName.trim()
        ? body.companyName.trim()
        : null;
    if (!requestedReview) {
      return jsonWithCors(request, { error: "A Tally posting review is required." }, { status: 400 });
    }
    const context = await loadContext(request,
      id,
      user.id,
      requestedConnectionId,
      requestedCompanyName,
      body.liveMasters
    );
    if (context.posting && isPostingLocked(context.posting.status)) {
      return jsonWithCors(request, { error: "This approved or posted revision is locked." }, { status: 409 });
    }
    if (!context.connection) {
      return jsonWithCors(request, { error: "Select the exact Tally company before saving this review." }, { status: 409 });
    }
    const [defaultsResult, preliminaryResult] = await Promise.all([
      prepareContext(context, user.id, undefined, { checkDuplicate: false }),
      prepareContext(context, user.id, requestedReview),
    ]);
    const mappingProposals = purchaseMappingProposals(
      context,
      requestedReview,
      preliminaryResult.prepared
    );
    const proposalKeys = new Set(
      mappingProposals.map((mapping) => `${mapping.mapping_type}:${normalizeCompanyName(mapping.source_key)}`)
    );
    const effectiveContext: LoadedContext = {
      ...context,
      mappings: [
        ...mappingProposals,
        ...context.mappings.filter((mapping) =>
          !proposalKeys.has(`${mapping.mapping_type}:${normalizeCompanyName(mapping.source_key)}`)
        ),
      ],
    };
    const defaults = defaultsResult.prepared;
    const duplicate = preliminaryResult.duplicate;
    const prepared = mappingProposals.length > 0
      ? prepareLoadedContext(effectiveContext, requestedReview, preliminaryResult.duplicateExists)
      : preliminaryResult.prepared;
    if (!prepared.source || !prepared.review) {
      return jsonWithCors(request, responseBody(context, prepared, {
        includeMasterOptions: body.compactResponse !== true,
      }), { status: 409 });
    }

    const nextRevision = context.posting ? context.posting.revision + 1 : 1;
    const row = {
      case_id: id,
      invoice_document_id: prepared.source.documentId,
      owner_user_id: user.id,
      connection_id: context.connection?.id ?? null,
      master_sync_run_id: null,
      command_id: null,
      status: prepared.suggestedStatus,
      revision: nextRevision,
      duplicate_key: duplicate,
      idempotency_key: null,
      review_patch: compactPurchasePostingReview(defaults.review, prepared.review),
      approved_payload_hash: null,
      approved_at: null,
      queued_at: null,
      verification_status: null,
      last_error: null,
    };
    const result = context.posting
      ? await context.supabase
          .from("purchase_invoice_tally_postings")
          .update(row)
          .eq("id", context.posting.id)
          .eq("owner_user_id", user.id)
          .select("*")
          .single()
      : await context.supabase
          .from("purchase_invoice_tally_postings")
          .insert(row)
          .select("*")
          .single();
    if (result.error) throw result.error;
    if (mappingProposals.length > 0) {
      const { error: mappingError } = await context.supabase
        .from("tally_mapping_settings")
        .upsert(
          mappingProposals.map((mapping) => ({
            connection_id: context.connection!.id,
            owner_user_id: user.id,
            company_name: context.selectedCompanyName ?? "Unknown company",
            mapping_type: mapping.mapping_type,
            source_key: mapping.source_key,
            source_label: mapping.source_label,
            target_master_type: mapping.target_master_type,
            target_master_key: mapping.target_master_key,
            target_master_name: mapping.target_master_name,
            status: "active",
            notes: "Confirmed from Purchase posting review.",
          })),
          { onConflict: "connection_id,company_name,mapping_type,source_key" }
        );
      if (mappingError) throw mappingError;
    }
    const posting = result.data as PostingRow;
    const refreshed = await loadContext(request,
      id,
      user.id,
      posting.connection_id,
      context.selectedCompanyName,
      body.liveMasters
    );
    const refreshedPrepared = prepareLoadedContext(
      refreshed,
      asSavedReview(posting.review_patch),
      preliminaryResult.duplicateExists
    );
    return jsonWithCors(request, {
      ...responseBody(refreshed, refreshedPrepared, {
        includeMasterOptions: body.compactResponse !== true,
      }),
      liveMatchingComplete: Boolean(body.liveMasters),
    });
  } catch (error) {
    const denied=accessFailureResponse(request,error);if(denied)return denied;
    if (serializeError(error) === "TALLY_CONNECTION_NOT_FOUND") {
      return jsonWithCors(request, { error: "The selected Tally connection is unavailable." }, { status: 409 });
    }
    if (isPurchasePostingSchemaMissing(error)) {
      return jsonWithCors(request, {
        error: "Purchase posting schema is not installed. Run supabase/migrations/202607270001_purchase_invoice_tally_posting.sql.",
        migrationRequired: true,
      }, { status: 409 });
    }
    console.error("Error in PATCH /api/cases/[id]/tally-posting:", error);
    return jsonWithCors(request, { error: serializeError(error) }, { status: 500 });
  }
}

async function POSTHandler(request: Request, contextParam: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    const { id } = await contextParam.params;
    const body = await request.json().catch(() => ({}));
    if (body.action === "verify_existing") {
      const requestedConnectionId = typeof body.connectionId === "string" ? body.connectionId : null;
      const requestedCompanyName = typeof body.companyName === "string" ? body.companyName : null;
      const initial = await loadContext(request, id, user.id, requestedConnectionId, requestedCompanyName);
      const context = initial.posting?.connection_id
        ? await loadContext(request, id, user.id, initial.posting.connection_id, requestedCompanyName)
        : initial;
      if (!context.posting || context.posting.status !== "verification_required" || !context.posting.command_id) {
        return jsonWithCors(request, { error: "This Purchase voucher is not awaiting verification." }, { status: 409 });
      }
      if (!context.connection || context.connection.id !== context.posting.connection_id) {
        return jsonWithCors(request, { error: "Reconnect the same Tally company before verifying this voucher." }, { status: 409 });
      }
      if (!context.connectionStatus?.agentCapabilities?.includes("purchase-strict-readback-v1")) {
        return jsonWithCors(request, { error: "Update and reconnect the Kalika Local Agent before verification." }, { status: 409 });
      }
      const requestedAt = new Date().toISOString();
      const team = process.env.TEAM_ACCESS_ENFORCEMENT === "true"
        ? await requireResourceAccess(request, "case", id, "purchases.post")
        : null;
      const queued = team
        ? await context.supabase.rpc("access_enqueue_purchase_verification", {
            p_actor: user.id,
            p_org: team.access.organizationId,
            p_case: id,
            p_connection: context.connection.id,
            p_requested_at: requestedAt,
          })
        : await context.supabase.rpc("queue_purchase_invoice_tally_verification", {
            p_posting_id: context.posting.id,
            p_owner_user_id: user.id,
            p_connection_id: context.connection.id,
            p_previous_command_id: context.posting.command_id,
            p_requested_at: requestedAt,
          });
      if (queued.error) throw queued.error;
      const commandId = String(queued.data);
      await Promise.all([
        context.supabase.from("tally_connection_events").insert({
          connection_id: context.connection.id,
          owner_user_id: context.connection.owner_user_id,
          event_type: "command_queued",
          message: "Read-only Purchase voucher verification queued.",
          payload: { commandType: "create_purchase_voucher", verificationOnly: true, commandId, caseId: id },
        }),
        wakeTallyConnector(context.connection.id),
      ]);
      const { prepared } = await prepareContext(context, user.id, asSavedReview(context.posting.review_patch), { checkDuplicate: false });
      return jsonWithCors(request, responseBody({
        ...context,
        posting: {
          ...context.posting,
          command_id: commandId,
          status: "queued",
          queued_at: requestedAt,
          last_error: null,
          updated_at: requestedAt,
        },
      }, prepared, { includeMasterOptions: false }));
    }
    if (body.action === "prepare_live_context") {
      const requestedConnectionId = typeof body.connectionId === "string" ? body.connectionId : null;
      const requestedCompanyName = typeof body.companyName === "string" ? body.companyName : null;
      const context = await loadContext(request,
        id,
        user.id,
        requestedConnectionId,
        requestedCompanyName,
        body.liveMasters
      );
      if (
        !context.connection ||
        !hasCompleteMasterSnapshot(context) ||
        (body.allowStalePreview !== true && !isMasterSnapshotFresh(context))
      ) {
        return jsonWithCors(request, { error: "The live Tally master read is incomplete or stale." }, { status: 409 });
      }
      const savedReview = asSavedReview(context.posting?.review_patch);
      const first = await prepareContext(context, user.id, savedReview, { checkDuplicate: false });
      const draft = first.prepared.review;
      if (!draft) return jsonWithCors(request, responseBody(context, first.prepared, {
        includeMasterOptions: body.compactResponse !== true,
      }));

      const supplierLedgerMatch = suggestSupplierLedger({
        supplierName: draft.supplierName,
        supplierGstin: draft.supplierGstin,
        ledgers: dedupeLedgerMasters(context.masters),
      });
      const supplierStateCode = String(draft.supplierGstin ?? "").match(/^\d{2}/)?.[0] ?? null;
      const buyerStateCode = String(context.liveCompanyProfile?.gstin ?? draft.buyerGstin ?? "").match(/^\d{2}/)?.[0] ?? null;
      const lineMasterMatches = await suggestPurchaseLineMasters({
        lines: draft.lines.map((line) => ({
          lineId: line.lineId,
          description: line.description,
          hsn: line.hsn,
          unit: line.unit,
          supplierStateCode,
          buyerStateCode,
          needsStockItem: !line.stockItemName.trim(),
          needsPurchaseLedger: !line.purchaseLedgerName.trim(),
        })),
        stockItems: context.masters.filter((master) => master.master_type === "stock_item"),
        ledgers: dedupeLedgerMasters(context.masters),
      });
      const lineMatches = new Map(lineMasterMatches.map((match) => [match.lineId, match]));
      const matchedReview: PurchasePostingReview = {
        ...draft,
        supplierLedgerName:
          draft.supplierLedgerName ||
          (supplierLedgerMatch.matchType === "direct_match" ? supplierLedgerMatch.ledgerName ?? "" : ""),
        lines: draft.lines.map((line) => {
          const match = lineMatches.get(line.lineId);
          return {
            ...line,
            stockItemName:
              line.stockItemName ||
              (match?.stockItem.matchType === "direct_match" ? match.stockItem.masterName ?? "" : ""),
            purchaseLedgerName:
              line.purchaseLedgerName ||
              (match?.purchaseLedger.matchType === "direct_match" ? match.purchaseLedger.masterName ?? "" : ""),
          };
        }),
      };
      const final = await prepareContext(context, user.id, matchedReview, { checkDuplicate: false });
      return jsonWithCors(request, {
        ...responseBody(context, final.prepared, {
          includeMasterOptions: body.compactResponse !== true,
        }),
        supplierLedgerMatch,
        lineMasterMatches,
        liveMatchingComplete: true,
      });
    }
    if (body.action === "match_purchase_masters") {
      const requestedConnectionId = typeof body.connectionId === "string" ? body.connectionId : null;
      const requestedCompanyName = typeof body.companyName === "string" ? body.companyName : null;
      const context = await loadContext(request, id, user.id, requestedConnectionId, requestedCompanyName, body.liveMasters);
      if (
        !context.connection ||
        !hasCompleteMasterSnapshot(context) ||
        !isMasterSnapshotFresh(context)
      ) {
        return jsonWithCors(request, { error: "Refresh the live Tally company data before matching invoice items." }, { status: 409 });
      }
      const review = asSavedReview(body.review);
      const lines = Array.isArray(review?.lines) ? review.lines.slice(0, 50) : [];
      const unresolved = lines.filter((line) =>
        !line.stockItemName?.trim() || !line.purchaseLedgerName?.trim()
      );
      if (unresolved.length === 0) {
        return jsonWithCors(request, { lineMasterMatches: [] });
      }
      const supplierStateCode = String(review?.supplierGstin ?? "").match(/^\d{2}/)?.[0] ?? null;
      const buyerStateCode = String(context.liveCompanyProfile?.gstin ?? review?.buyerGstin ?? "").match(/^\d{2}/)?.[0] ?? null;
      const lineMasterMatches = await suggestPurchaseLineMasters({
        lines: unresolved.map((line) => ({
          lineId: line.lineId,
          description: line.description ?? "",
          hsn: line.hsn ?? "",
          unit: line.unit ?? "",
          supplierStateCode,
          buyerStateCode,
          needsStockItem: !line.stockItemName?.trim(),
          needsPurchaseLedger: !line.purchaseLedgerName?.trim(),
        })),
        stockItems: context.masters.filter((master) => master.master_type === "stock_item"),
        ledgers: dedupeLedgerMasters(context.masters),
      });
      return jsonWithCors(request, { lineMasterMatches });
    }
    if (body.action === "match_supplier_ledger") {
      const requestedConnectionId = typeof body.connectionId === "string" ? body.connectionId : null;
      const requestedCompanyName = typeof body.companyName === "string" ? body.companyName : null;
      const context = await loadContext(request, id, user.id, requestedConnectionId, requestedCompanyName, body.liveMasters);
      if (
        !context.connection ||
        !hasCompleteMasterSnapshot(context) ||
        !isMasterSnapshotFresh(context)
      ) {
        return jsonWithCors(request, { error: "Refresh the selected Tally company's masters before matching the supplier." }, { status: 409 });
      }

      const supplierName = String(body.supplierName ?? "").trim().slice(0, 300);
      const supplierGstin = String(body.supplierGstin ?? "").trim().toUpperCase().slice(0, 30);
      if (!supplierName && !supplierGstin) {
        return jsonWithCors(request, { error: "A supplier name or GSTIN is required for ledger matching." }, { status: 400 });
      }

      const ledgerMasters = dedupeLedgerMasters(context.masters);
      const suggestion = suggestSupplierLedger({
        supplierName,
        supplierGstin,
        ledgers: ledgerMasters,
      });
      return jsonWithCors(request, { supplierLedgerMatch: suggestion });
    }
    if (body.action !== "approve_and_queue") {
      return jsonWithCors(request, { error: "Unsupported Tally posting action." }, { status: 400 });
    }
    const requestedConnectionId =
      typeof body.connectionId === "string" && body.connectionId.trim()
        ? body.connectionId.trim()
        : null;
    const requestedCompanyName =
      typeof body.companyName === "string" && body.companyName.trim()
        ? body.companyName.trim()
        : null;
    const initial = await loadContext(request,
      id,
      user.id,
      requestedConnectionId,
      requestedCompanyName,
      body.liveMasters
    );
    const context = initial.posting?.connection_id && isPostingLocked(initial.posting.status)
      ? await loadContext(request, id, user.id, initial.posting.connection_id, requestedCompanyName, body.liveMasters)
      : initial;
    if (!context.posting) {
      return jsonWithCors(request, { error: "Save the Tally review before approving it." }, { status: 409 });
    }
    if (["queued", "creating", "created"].includes(context.posting.status)) {
      const { prepared } = await prepareContext(context, user.id, asSavedReview(context.posting.review_patch));
      return jsonWithCors(request, responseBody(context, prepared, {
        includeMasterOptions: body.compactResponse !== true,
      }));
    }
    if (
      context.posting.status === "verification_required" ||
      context.posting.tally_created_at
    ) {
      return jsonWithCors(request, {
        error: "Tally may already contain this voucher. Verify or correct the existing voucher before creating another command.",
      }, { status: 409 });
    }
    const { prepared, duplicate } = await prepareContext(context, user.id, asSavedReview(context.posting.review_patch));
    if (!prepared.source || !prepared.review || !prepared.tallyPayload) {
      return jsonWithCors(request, { error: "This case does not have one eligible invoice." }, { status: 409 });
    }
    const allowedBlockerKeys = new Set(
      Array.isArray(body.allowedBlockerKeys)
        ? body.allowedBlockerKeys.filter(
            (key: unknown): key is string => typeof key === "string" && Boolean(key.trim())
          )
        : []
    );
    const blockerKey = (blocker: typeof prepared.blockers[number]) =>
      `${blocker.code}:${blocker.lineId ?? blocker.scope}`;
    const allowedBlockers = prepared.blockers.filter((blocker) => allowedBlockerKeys.has(blockerKey(blocker)));
    const unallowedBlockers = prepared.blockers.filter((blocker) => !allowedBlockerKeys.has(blockerKey(blocker)));
    if (unallowedBlockers.length > 0) {
      return jsonWithCors(request, {
        error: "Resolve every Tally posting blocker before approval.",
        blockers: unallowedBlockers,
      }, { status: 409 });
    }
    const acknowledgedWarningCodes = new Set(
      Array.isArray(body.acknowledgedWarningCodes)
        ? body.acknowledgedWarningCodes.filter(
            (code: unknown): code is string => typeof code === "string" && Boolean(code.trim())
          )
        : []
    );
    const acknowledgementWarnings = prepared.warnings.filter(
      (warning) => warning.requiresAcknowledgement
    );
    const unacknowledgedWarnings = acknowledgementWarnings.filter(
      (warning) => !acknowledgedWarningCodes.has(warning.code)
    );
    if (unacknowledgedWarnings.length > 0) {
      return jsonWithCors(request, {
        error: "Acknowledge every configured validation warning before approval.",
        warnings: unacknowledgedWarnings,
      }, { status: 409 });
    }
    if (!context.connection || !duplicate) {
      return jsonWithCors(request, { error: "An active Tally company and invoice identity are required." }, { status: 409 });
    }
    if (
      Number(prepared.tallyPayload?.canonicalVersion || 0) >= 2 &&
      !context.connectionStatus?.agentCapabilities?.includes("purchase-canonical-v2")
    ) {
      return jsonWithCors(request, {
        error: "Update and reconnect the Kalika Local Agent before posting this Purchase voucher.",
      }, { status: 409 });
    }

    const now = new Date().toISOString();
    const idem = idempotencyKey(id, context.posting.revision, duplicate);
    const sourceFile = context.sourceFileId
      ? context.files.find((file) => file.id === context.sourceFileId) ?? null
      : null;
    let sourceDocument: {
      id: string;
      name: string;
      downloadUrl: string;
    } | null = null;
    if (sourceFile) {
      const signedUrlResult = await context.supabase.storage
        .from(sourceFile.storage_bucket)
        .createSignedUrl(sourceFile.storage_path, 7 * 24 * 60 * 60);
      if (signedUrlResult.error || !signedUrlResult.data?.signedUrl) {
        throw signedUrlResult.error ?? new Error("Could not prepare the source invoice for Tally.");
      }
      sourceDocument = {
        id: sourceFile.id,
        name: sourceFile.original_name,
        downloadUrl: signedUrlResult.data.signedUrl,
      };
    }
    const calculationDigest = createHash("sha256")
      .update(JSON.stringify({
        version: prepared.calculation?.calculationVersion ?? 1,
        calculation: prepared.calculation,
        items: prepared.tallyPayload?.items,
        charges: prepared.tallyPayload?.charges,
        withholdings: prepared.tallyPayload?.withholdings,
        finalPayableAmount: prepared.tallyPayload?.finalPayableAmount,
      }))
      .digest("hex");
    const team = process.env.TEAM_ACCESS_ENFORCEMENT === 'true'
      ? await requireResourceAccess(request, 'case', id, 'purchases.post') : null;
    if (team && !Number.isSafeInteger(body.workflowRevision)) {
      return jsonWithCors(request, { error: 'Reload the approved purchase revision before posting.' }, { status: 409 });
    }
    const sourceDocumentFolder = await readPurchaseDocumentFolder(
      team?.access.organizationId ?? user.id,
      purchaseDocumentCompanyKeys(team?.scope.company_id ?? undefined, context.connection.id, context.selectedCompanyName || '',
        context.liveCompanyProfile?.guid)
    );
    if (sourceDocumentFolder && !context.connectionStatus?.agentCapabilities?.includes('purchase-shared-folder-v1')) {
      return jsonWithCors(request, { error: 'Update and reconnect the connector to use the configured shared invoice folder.' }, { status: 409 });
    }
    const frozenPayload = {
      ...prepared.tallyPayload,
      calculationDigest,
      catalogueIdentity: recordValue(recordValue(body.liveMasters)?.catalogueIdentity),
      postingId: context.posting.id,
      caseId: id,
      sourceFileId: sourceFile?.id ?? null,
      sourceDocument,
      sourceDocumentFolder,
      revision: context.posting.revision,
      idempotencyKey: idem,
      duplicateKey: duplicate,
      masterSyncRunId: null,
      purchaseMasterCommandId: context.liveMasterCommandId,
      approvedAt: now,
      validationAcknowledgement: acknowledgementWarnings.length > 0 ? {
        acknowledgedBy: user.id,
        acknowledgedAt: now,
        warnings: acknowledgementWarnings.map((warning) => ({
          code: warning.code,
          label: warning.label,
          policyRule: warning.policyRule ?? null,
        })),
      } : null,
      validationOverrides: allowedBlockers.length > 0 ? {
        allowedBy: user.id,
        allowedAt: now,
        blockers: allowedBlockers.map((blocker) => ({
          code: blocker.code,
          label: blocker.label,
          scope: blocker.scope,
          lineId: blocker.lineId ?? null,
        })),
      } : null,
    };
    const approvedPayloadHash = createHash("sha256")
      .update(JSON.stringify(frozenPayload))
      .digest("hex");
    const queueArgs = {
      p_posting_id: context.posting.id,
      p_owner_user_id: user.id,
      p_connection_id: context.connection.id,
      p_master_sync_run_id: null,
      p_duplicate_key: duplicate,
      p_idempotency_key: idem,
      p_approved_payload_hash: approvedPayloadHash,
      p_approved_at: now,
      p_tally_payload: frozenPayload,
      p_revision: context.posting.revision,
    };
    const commandResult = team
      ? await context.supabase.rpc('access_enqueue_purchase', {
          p_actor: user.id, p_org: team.access.organizationId, p_case: id,
          p_workflow_revision: body.workflowRevision, p_source_revision: team.scope.source_revision,
          p_financial_digest: purchaseFinancialDigest(context.documents.map(({id,document_type,extracted_fields}) => ({id,document_type,extracted_fields})), context.posting.review_patch, { companyId: team.scope.company_id, connectionId: context.connection.id }),
          p_args: queueArgs,
        })
      : await context.supabase.rpc('queue_purchase_invoice_tally_posting', queueArgs);
    if (commandResult.error) {
      if (/duplicate|unique/i.test(serializeError(commandResult.error))) {
        return jsonWithCors(request, { error: "This supplier invoice is already claimed by another Tally posting." }, { status: 409 });
      }
      throw commandResult.error;
    }

    const commandId = String(commandResult.data);
    await Promise.all([
      context.supabase.from("tally_connection_events").insert({
        connection_id: context.connection.id,
        owner_user_id: user.id,
        event_type: "command_queued",
        message: "Purchase voucher creation queued from packet review.",
        payload: {
          commandType: "create_purchase_voucher",
          commandId,
          caseId: id,
          postingId: context.posting.id,
          validationAcknowledgement: acknowledgementWarnings.length > 0 ? {
            warningCodes: acknowledgementWarnings.map((warning) => warning.code),
            policyRules: acknowledgementWarnings.map((warning) => warning.policyRule).filter(Boolean),
          } : null,
          validationOverrides: allowedBlockers.length > 0 ? {
            blockerKeys: allowedBlockers.map(blockerKey),
          } : null,
        },
      }),
      wakeTallyConnector(context.connection.id),
    ]);

    // The RPC already froze the revision and queued the command atomically.
    // A second full Supabase context load here added several seconds to the
    // approval click without changing the response.
    const queuedContext: LoadedContext = {
      ...context,
      posting: {
        ...context.posting,
        connection_id: context.connection.id,
        command_id: commandId,
        status: "queued",
        duplicate_key: duplicate,
        idempotency_key: idem,
        approved_payload_hash: approvedPayloadHash,
        approved_at: now,
        queued_at: now,
        last_error: null,
        updated_at: now,
      },
    };
    return jsonWithCors(request, {
      ...responseBody(queuedContext, prepared, {
        includeMasterOptions: body.compactResponse !== true,
      }),
      liveMatchingComplete: Boolean(body.liveMasters),
    });
  } catch (error) {
    const denied=accessFailureResponse(request,error);if(denied)return denied;
    if (serializeError(error) === "TALLY_CONNECTION_NOT_FOUND") {
      return jsonWithCors(request, { error: "The selected Tally connection is unavailable." }, { status: 409 });
    }
    if (isPurchasePostingSchemaMissing(error)) {
      return jsonWithCors(request, {
        error: "Purchase posting schema is not installed. Run supabase/migrations/202607270001_purchase_invoice_tally_posting.sql.",
        migrationRequired: true,
      }, { status: 409 });
    }
    console.error("Error in POST /api/cases/[id]/tally-posting:", error);
    return jsonWithCors(request, { error: serializeError(error) }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
export const PATCH = withTeamAccess(PATCHHandler);
export const POST = withTeamAccess(POSTHandler);
