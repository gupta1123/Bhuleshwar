import { withTeamAccess } from '@/lib/access/route-boundary';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { companyMappingConnectionIds, readCompanyMappings, type CompanyMappingRow, type CompanyMappingScope } from "@/lib/tally/company-mappings";
import { requireDataset } from '@/lib/access/dataset';
import { accessFailureResponse } from '@/lib/access/failures';

type SupabaseAdmin = ReturnType<typeof createSupabaseAdminClient>;

const ALLOWED_DEFAULTS = new Map([
  ["cgst", { mappingType: "gst_rate", sourceKey: "cgst:9", targetTypes: ["ledger", "gst_ledger", "tax_ledger"] }],
  ["sgst", { mappingType: "gst_rate", sourceKey: "sgst:9", targetTypes: ["ledger", "gst_ledger", "tax_ledger"] }],
  ["igst", { mappingType: "gst_rate", sourceKey: "igst:18", targetTypes: ["ledger", "gst_ledger", "tax_ledger"] }],
  ["tds-194q", { mappingType: "tds_ledger", sourceKey: "194q", targetTypes: ["ledger", "tax_ledger"] }],
  ["transport-tds", { mappingType: "tds_ledger", sourceKey: "transport", targetTypes: ["ledger", "tax_ledger"] }],
  ["cgst-tds", { mappingType: "tds_ledger", sourceKey: "cgst_tds", targetTypes: ["ledger", "tax_ledger"] }],
  ["sgst-tds", { mappingType: "tds_ledger", sourceKey: "sgst_tds", targetTypes: ["ledger", "tax_ledger"] }],
  ["igst-tds", { mappingType: "tds_ledger", sourceKey: "igst_tds", targetTypes: ["ledger", "tax_ledger"] }],
  ["tcs", { mappingType: "tcs_ledger", sourceKey: "receivable", targetTypes: ["ledger", "tax_ledger"] }],
  ["freight", { mappingType: "freight_ledger", sourceKey: "purchase", targetTypes: ["ledger"] }],
  ["round-off", { mappingType: "round_off_ledger", sourceKey: "purchase", targetTypes: ["ledger"] }],
  ["godown", { mappingType: "godown", sourceKey: "purchase", targetTypes: ["godown"] }],
] as const);

// Materials are rows of HSN prefix → stock item, local purchase ledger, interstate purchase ledger.
// MS Scrap (7204) and Sponge Iron (72031000) are always listed; their older material-keyed ledgers
// (ms_scrap:local, ...) are still read, and are replaced when the row is edited.
const STARTER_MATERIALS = [
  { hsn: "7204", name: "MS Scrap", legacyKey: "ms_scrap" },
  { hsn: "72031000", name: "Sponge Iron", legacyKey: "sponge_iron" },
] as const;
const GEOGRAPHIES = ["local", "interstate"] as const;
type Geography = (typeof GEOGRAPHIES)[number];

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function hsnPrefix(value: unknown) {
  const digits = clean(value).replace(/\D/g, "");
  return digits.length >= 2 && digits.length <= 8 ? digits : "";
}

// Same shape as the posting review's master key, so a name-only default still matches live Tally.
function masterKeyFromName(value: unknown) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// A value arrives as "" (clear) or as the master picked from the live Tally list: { name, guid }.
// The posting review re-checks every saved choice against live Tally before using it.
function readTarget(value: unknown) {
  if (typeof value === "string") return { name: clean(value), guid: "" };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return { name: clean(record.name), guid: clean(record.guid) };
  }
  return { name: "", guid: "" };
}

function legacyKeyFor(hsn: string, geography: Geography) {
  const starter = STARTER_MATERIALS.find((material) => material.hsn === hsn);
  return starter ? `${starter.legacyKey}:${geography}` : null;
}

async function verifyConnection(request: Request, ownerUserId: string, connectionId: string, companyName: string) {
  const supabase = createSupabaseAdminClient();
  if (process.env.TEAM_ACCESS_ENFORCEMENT === 'true') {
    const dataset = await requireDataset(request, connectionId, { companyName }, 'settings.manage');
    const scope = { organizationId: dataset.access.organizationId, companyId: dataset.link.company_id };
    const mappingConnectionIds = await companyMappingConnectionIds(supabase, { connectionId, companyName, scope });
    return { supabase, exists: true, scope, mappingConnectionIds };
  }
  const { data, error } = await supabase
    .from("tally_connections")
    .select("id")
    .eq("id", connectionId)
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();
  if (error) throw error;
  return { supabase, exists: Boolean(data), scope: undefined, mappingConnectionIds: undefined };
}

// Replaces a company's choice on every connection, so an older connection's value can never
// reappear after this one is cleared or changed.
async function replaceMapping(supabase: SupabaseAdmin, params: {
  ownerUserId: string;
  connectionId: string;
  companyName: string;
  mappingType: string;
  sourceKeys: string[];
  sourceLabel: string;
  targetType: string;
  target: { name: string; guid: string };
  scope?: CompanyMappingScope;
  mappingConnectionIds?: string[];
}) {
  const ids = params.scope ? params.mappingConnectionIds : null;
  if (params.scope && !ids?.includes(params.connectionId)) throw new Error('Verified company defaults scope is required.');
  let deletion = supabase
    .from("tally_mapping_settings")
    .delete()
    .ilike("company_name", escapeLikePattern(params.companyName))
    .eq("mapping_type", params.mappingType)
    .in("source_key", params.sourceKeys);
  deletion = ids ? deletion.in('connection_id', ids) : deletion.eq('owner_user_id', params.ownerUserId);
  const { error: deleteError } = await deletion;
  if (deleteError) throw deleteError;
  if (!params.target.name) return;
  const { error } = await supabase.from("tally_mapping_settings").insert({
    connection_id: params.connectionId,
    owner_user_id: params.ownerUserId,
    company_name: params.companyName,
    mapping_type: params.mappingType,
    source_key: params.sourceKeys[0],
    source_label: params.sourceLabel,
    target_master_type: params.targetType,
    target_master_key: params.target.guid || masterKeyFromName(params.target.name),
    target_master_name: params.target.name,
    status: "active",
    notes: "Configured in Purchase accounting settings.",
  });
  if (error) throw error;
}

function buildMaterials(rows: CompanyMappingRow[]) {
  const prefixes = new Set<string>(STARTER_MATERIALS.map((material) => material.hsn));
  const learnedNames = new Map<string, string>();
  for (const row of rows) {
    const key = row.source_key.trim().toLowerCase();
    if (row.mapping_type === "item_hsn" && hsnPrefix(key)) prefixes.add(hsnPrefix(key));
    const hsnLedger = row.mapping_type === "purchase_ledger" ? /^hsn:(\d{2,8}):(local|interstate)$/.exec(key) : null;
    if (hsnLedger) prefixes.add(hsnLedger[1]);
    const prefix = row.mapping_type === "item_hsn" ? hsnPrefix(key) : hsnLedger?.[1];
    const label = clean(row.source_label).split(" · ")[0];
    if (prefix && label && !/^(?:hsn\s+)?\d+$/i.test(label) && !/^(?:ms-scrap|sponge)/.test(label) && !learnedNames.has(prefix)) {
      learnedNames.set(prefix, label);
    }
  }
  const find = (mappingType: string, sourceKey: string | null) =>
    sourceKey ? rows.find((row) => row.mapping_type === mappingType && row.source_key.trim().toLowerCase() === sourceKey)?.target_master_name ?? "" : "";
  return [...prefixes]
    .sort((left, right) => left.localeCompare(right))
    .map((hsn) => {
      const starter = STARTER_MATERIALS.find((material) => material.hsn === hsn);
      const ledger = (geography: Geography) =>
        find("purchase_ledger", `hsn:${hsn}:${geography}`) || find("purchase_ledger", legacyKeyFor(hsn, geography));
      return {
        hsn,
        name: starter?.name ?? learnedNames.get(hsn) ?? "",
        starter: Boolean(starter),
        stockItem: find("item_hsn", hsn),
        localLedger: ledger("local"),
        interstateLedger: ledger("interstate"),
      };
    });
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function GETHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    const url = new URL(request.url);
    const connectionId = clean(url.searchParams.get("connectionId"));
    const companyName = clean(url.searchParams.get("companyName"));
    if (!connectionId || !companyName) {
      return jsonWithCors(request, { error: "Tally connection and company are required." }, { status: 400 });
    }
    const { supabase, exists, scope } = await verifyConnection(request, user.id, connectionId, companyName);
    if (!exists) return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    const rows = await readCompanyMappings(supabase, { connectionId, companyName, ownerUserId: user.id, scope });
    const defaults = Object.fromEntries([...ALLOWED_DEFAULTS].map(([id, definition]) => [
      id,
      rows.find((row) => row.mapping_type === definition.mappingType && row.source_key === definition.sourceKey)
        ?.target_master_name ?? "",
    ]));
    return jsonWithCors(request, { defaults, materials: buildMaterials(rows) });
  } catch (error) {
    const denied = accessFailureResponse(request, error); if (denied) return denied;
    console.error("Error loading Purchase posting defaults:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not load defaults." }, { status: 500 });
  }
}

async function PUTHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const connectionId = clean(body.connectionId);
    const companyName = clean(body.companyName);
    if (!connectionId || !companyName) {
      return jsonWithCors(request, { error: "Tally connection and company are required." }, { status: 400 });
    }
    const { supabase, exists, scope, mappingConnectionIds } = await verifyConnection(request, user.id, connectionId, companyName);
    if (!exists) return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    const base = { ownerUserId: user.id, connectionId, companyName, scope, mappingConnectionIds };

    // Single defaults (GST, TDS, freight, ...): only the ones present in the request change.
    const defaults = body.defaults && typeof body.defaults === "object" && !Array.isArray(body.defaults)
      ? body.defaults as Record<string, unknown>
      : {};
    for (const [id, definition] of ALLOWED_DEFAULTS) {
      if (!(id in defaults)) continue;
      await replaceMapping(supabase, {
        ...base,
        mappingType: definition.mappingType,
        sourceKeys: [definition.sourceKey],
        sourceLabel: id,
        targetType: definition.targetTypes[0],
        target: readTarget(defaults[id]),
      });
    }

    // One cell of a material row: { hsn, field: "stockItem" | "localLedger" | "interstateLedger", value }.
    if (body.material && typeof body.material === "object" && !Array.isArray(body.material)) {
      const material = body.material as Record<string, unknown>;
      const hsn = hsnPrefix(material.hsn);
      if (!hsn) return jsonWithCors(request, { error: "Enter an HSN code of 2 to 8 digits." }, { status: 400 });
      const target = readTarget(material.value);
      const label = clean(material.name) || `HSN ${hsn}`;
      if (material.field === "stockItem") {
        await replaceMapping(supabase, { ...base, mappingType: "item_hsn", sourceKeys: [hsn], sourceLabel: label, targetType: "stock_item", target });
      } else if (material.field === "localLedger" || material.field === "interstateLedger") {
        const geography: Geography = material.field === "localLedger" ? "local" : "interstate";
        const legacy = legacyKeyFor(hsn, geography);
        await replaceMapping(supabase, {
          ...base,
          mappingType: "purchase_ledger",
          sourceKeys: [`hsn:${hsn}:${geography}`, ...(legacy ? [legacy] : [])],
          sourceLabel: `${label} · ${geography} purchase`,
          targetType: "ledger",
          target,
        });
      } else {
        return jsonWithCors(request, { error: "Unknown material field." }, { status: 400 });
      }
    }

    // Remove a material row entirely (starter rows are only emptied).
    const removeHsn = hsnPrefix(body.removeMaterial);
    if (removeHsn) {
      const empty = { name: "", guid: "" };
      await replaceMapping(supabase, { ...base, mappingType: "item_hsn", sourceKeys: [removeHsn], sourceLabel: "", targetType: "stock_item", target: empty });
      for (const geography of GEOGRAPHIES) {
        const legacy = legacyKeyFor(removeHsn, geography);
        await replaceMapping(supabase, {
          ...base,
          mappingType: "purchase_ledger",
          sourceKeys: [`hsn:${removeHsn}:${geography}`, ...(legacy ? [legacy] : [])],
          sourceLabel: "",
          targetType: "ledger",
          target: empty,
        });
      }
    }

    return jsonWithCors(request, { saved: true });
  } catch (error) {
    const denied = accessFailureResponse(request, error); if (denied) return denied;
    console.error("Error saving Purchase posting defaults:", error);
    return jsonWithCors(request, { error: error instanceof Error ? error.message : "Could not save defaults." }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
export const PUT = withTeamAccess(PUTHandler);
