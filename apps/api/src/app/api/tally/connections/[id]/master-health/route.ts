import { withTeamAccess } from '@/lib/access/route-boundary';
import {requireMasterDataset,datasetSelection} from '@/lib/access/master-store';
import {accessFailureResponse} from '@/lib/access/failures';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { TallyMasterRow } from "@/lib/tally/masters";

type HealthSeverity = "critical" | "warning";

type HealthIssue = {
  id: string;
  type:
    | "duplicate_ledger_name"
    | "possible_duplicate_ledger"
    | "missing_party_gstin"
    | "gst_ledger_parent"
    | "gst_ledger_tax_config";
  severity: HealthSeverity;
  confidence: number;
  title: string;
  message: string;
  recommendation: string;
  masters: Array<{
    id: string;
    type: TallyMasterRow["master_type"];
    name: string;
    parent: string | null;
    gstin: string | null;
    key: string;
  }>;
};

const PARTY_LEDGER_PARENTS = new Set(["sundry creditors", "sundry debtors"]);
const SYSTEM_LEDGER_NAMES = new Set([
  "cash",
  "profit loss ac",
  "profit and loss ac",
  "round off",
  "rounding off",
]);

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeName(value: unknown) {
  return cleanText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bac\b/g, "account")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function displaySafeName(value: unknown) {
  return normalizeName(value).replace(/\baccount\b/g, "ac");
}

function tokenSet(value: string) {
  return new Set(value.split(" ").filter(Boolean));
}

function tokenSimilarity(left: string, right: string) {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;

  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

function levenshtein(left: string, right: string) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function similarity(left: string, right: string) {
  const maxLength = Math.max(left.length, right.length);
  if (!maxLength) return 1;

  const editScore = 1 - levenshtein(left, right) / maxLength;
  const tokenScore = tokenSimilarity(left, right);
  return Math.max(editScore, tokenScore);
}

function masterSummary(master: TallyMasterRow): HealthIssue["masters"][number] {
  return {
    id: master.id,
    type: master.master_type,
    name: master.tally_name,
    parent: master.parent_name,
    gstin: master.gstin,
    key: master.master_key,
  };
}

function issueId(type: HealthIssue["type"], masters: TallyMasterRow[]) {
  return `${type}:${masters
    .map((master) => master.master_key)
    .sort()
    .join("|")}`;
}

function createIssue(input: Omit<HealthIssue, "id" | "masters"> & { masters: TallyMasterRow[] }): HealthIssue {
  return {
    id: issueId(input.type, input.masters),
    type: input.type,
    severity: input.severity,
    confidence: input.confidence,
    title: input.title,
    message: input.message,
    recommendation: input.recommendation,
    masters: input.masters.map(masterSummary),
  };
}

function isPartyLedger(master: TallyMasterRow) {
  return PARTY_LEDGER_PARENTS.has(normalizeName(master.parent_name));
}

function isSystemLedger(master: TallyMasterRow) {
  const reservedName = cleanText(master.raw_payload?.reservedName);
  return Boolean(reservedName) || SYSTEM_LEDGER_NAMES.has(displaySafeName(master.tally_name));
}

function analyzeLedgerHealth(masters: TallyMasterRow[]) {
  const ledgers = masters.filter((master) => master.master_type === "ledger");
  const gstLedgers = masters.filter((master) => master.master_type === "gst_ledger");
  const issues: HealthIssue[] = [];

  const ledgersByName = new Map<string, TallyMasterRow[]>();
  for (const ledger of ledgers) {
    const normalized = normalizeName(ledger.tally_name);
    if (!normalized) continue;
    const group = ledgersByName.get(normalized) ?? [];
    group.push(ledger);
    ledgersByName.set(normalized, group);
  }

  for (const sameNameLedgers of ledgersByName.values()) {
    if (sameNameLedgers.length < 2) continue;
    issues.push(
      createIssue({
        type: "duplicate_ledger_name",
        severity: "critical",
        confidence: 1,
        title: "Duplicate ledger name",
        message: `Duplicate ledger name "${sameNameLedgers[0]?.tally_name}" appears ${sameNameLedgers.length} times.`,
        recommendation: "Merge or rename duplicate ledgers before voucher posting so invoices map to one exact party.",
        masters: sameNameLedgers,
      })
    );
  }

  const partyLedgers = ledgers.filter((ledger) => isPartyLedger(ledger) && !isSystemLedger(ledger));
  for (const ledger of partyLedgers) {
    if (ledger.gstin) continue;
    issues.push(
      createIssue({
        type: "missing_party_gstin",
        severity: "warning",
        confidence: 0.85,
        title: "Party GSTIN missing",
        message: `${ledger.tally_name} is under ${ledger.parent_name ?? "a party group"} but has no GSTIN.`,
        recommendation: "Add GSTIN for vendor/customer ledgers when available. This prevents wrong supplier matching.",
        masters: [ledger],
      })
    );
  }

  let possibleDuplicateCount = 0;
  let comparedPairs = 0;
  let duplicateScanLimited = false;
  for (let i = 0; i < partyLedgers.length; i += 1) {
    if (possibleDuplicateCount >= 25 || duplicateScanLimited) break;

    const left = partyLedgers[i];
    const leftName = normalizeName(left.tally_name);
    if (!left || !leftName) continue;

    for (let j = i + 1; j < partyLedgers.length; j += 1) {
      if (possibleDuplicateCount >= 25) break;

      const right = partyLedgers[j];
      const rightName = normalizeName(right.tally_name);
      if (!right || !rightName || leftName === rightName) continue;
      if (left.gstin && right.gstin && left.gstin !== right.gstin) continue;
      // Bound quadratic fuzzy work independently of how many matches are found.
      if (++comparedPairs > 25000) { duplicateScanLimited = true; break; }

      const score = similarity(leftName, rightName);
      if (score < 0.86) continue;

      possibleDuplicateCount += 1;
      issues.push(
        createIssue({
          type: "possible_duplicate_ledger",
          severity: "warning",
          confidence: Number(score.toFixed(2)),
          title: "Possible duplicate ledger",
          message: `"${left.tally_name}" and "${right.tally_name}" look like possible duplicate party ledgers.`,
          recommendation: "Review spelling, GSTIN, and parent group. Keep one canonical ledger for posting.",
          masters: [left, right],
        })
      );
    }
  }

  for (const gstLedger of gstLedgers) {
    const parent = normalizeName(gstLedger.parent_name);
    if (parent && parent !== "duties and taxes") {
      issues.push(
        createIssue({
          type: "gst_ledger_parent",
          severity: "critical",
          confidence: 0.95,
          title: "GST ledger under wrong group",
          message: `${gstLedger.tally_name} is a GST ledger but sits under ${gstLedger.parent_name}.`,
          recommendation: "Move GST ledgers under Duties & Taxes so Tally treats tax accounting correctly.",
          masters: [gstLedger],
        })
      );
    }

    const rawTaxType = cleanText(gstLedger.raw_payload?.taxType || gstLedger.raw_payload?.typeOfDutyTax);
    const hasExplicitTaxConfig =
      Boolean(rawTaxType) ||
      gstLedger.tax_rate !== null ||
      /\b(cgst|sgst|igst|gst|cess)\b/i.test(gstLedger.tally_name);

    if (!hasExplicitTaxConfig) {
      issues.push(
        createIssue({
          type: "gst_ledger_tax_config",
          severity: "warning",
          confidence: 0.75,
          title: "GST tax configuration unclear",
          message: `${gstLedger.tally_name} does not expose a clear GST tax type/rate in synced data.`,
          recommendation: "Verify the ledger's Type of Duty/Tax and tax rate in Tally before using it for posting.",
          masters: [gstLedger],
        })
      );
    }
  }

  const criticalCount = issues.filter((issue) => issue.severity === "critical").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const score = Math.max(0, Math.min(100, 100 - criticalCount * 25 - warningCount * 10));

  return {
    summary: {
      totalLedgers: ledgers.length,
      totalGstLedgers: gstLedgers.length,
      issueCount: issues.length,
      criticalCount,
      warningCount,
      score,
      duplicateScanLimited,
    },
    issues,
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
    if(process.env.TEAM_ACCESS_ENFORCEMENT==='true') {
      const scope=await requireMasterDataset(request,id,datasetSelection(new URL(request.url)),'connections.manage');
      if(!scope.dataset)return jsonWithCors(request,{...analyzeLedgerHealth([]),syncRequired:true});
      // Explicit pages avoid PostgREST's default row limit truncating health results.
      const masters:TallyMasterRow[]=[];
      for(let offset=0;offset<20000;offset+=1000) {
        const {data,error}=await supabase.from('access_dataset_masters').select('*')
          .eq('dataset_id',scope.dataset.id).eq('is_active',true).in('master_type',['ledger','gst_ledger'])
          .order('id',{ascending:true}).range(offset,offset+999);
        if(error)throw error;
        masters.push(...(data||[]) as unknown as TallyMasterRow[]);
        if((data?.length||0)<1000)break;
      }
      return jsonWithCors(request,analyzeLedgerHealth(masters));
    }

    const { data: connection, error: connectionError } = await supabase
      .from("tally_connections")
      .select("id, owner_user_id")
      .eq("id", id)
      .eq("owner_user_id", user.id)
      .maybeSingle();

    if (connectionError) {
      throw connectionError;
    }

    if (!connection) {
      return jsonWithCors(request, { error: "Tally connection not found" }, { status: 404 });
    }

    const { data, error } = await supabase
      .from("tally_masters")
      .select("*")
      .eq("connection_id", id)
      .eq("owner_user_id", user.id)
      .eq("is_active", true)
      .in("master_type", ["ledger", "gst_ledger"])
      .order("master_type", { ascending: true })
      .order("tally_name", { ascending: true });

    if (error) {
      throw error;
    }

    return jsonWithCors(request, analyzeLedgerHealth((data ?? []) as unknown as TallyMasterRow[]));
  } catch (error) {
    const failure=accessFailureResponse(request,error);if(failure)return failure;
    console.error("Error in GET /api/tally/connections/[id]/master-health:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
