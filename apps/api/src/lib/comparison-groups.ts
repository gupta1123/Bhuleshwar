import { createSupabaseAdminClient } from "./supabase/admin";

export type ComparisonFieldGroup = {
  id?: string;
  groupKey: string;
  label: string;
  fields: string[];
  enabled: boolean;
  sortOrder: number;
};

export type ComparisonFieldGroupRow = {
  id: string;
  organization_id: string | null;
  group_key: string;
  label: string;
  fields: unknown;
  enabled: boolean;
  sort_order: number | null;
  created_at: string;
  updated_at: string;
};

const DEFAULT_ORG_ID = "default";

export const DEFAULT_COMPARISON_FIELD_GROUPS: ComparisonFieldGroup[] = [
  {
    groupKey: "commercial_amounts",
    label: "Commercial / Amounts",
    fields: ["subtotal", "taxAmount", "totalAmount", "paidAmount", "statementAmount", "currency"],
    enabled: true,
    sortOrder: 10,
  },
  {
    groupKey: "party_identity",
    label: "Party / Identity Details",
    fields: [
      "vendorName",
      "supplierGstin",
      "buyerName",
      "buyerGstin",
      "ownerName",
      "driverName",
      "holderName",
      "fatherName",
      "panNumber",
    ],
    enabled: true,
    sortOrder: 20,
  },
  {
    groupKey: "weight_quantity",
    label: "Weight / Quantity",
    fields: ["grossWeight", "tareWeight", "netWeight", "itemQuantity", "unit"],
    enabled: true,
    sortOrder: 30,
  },
  {
    groupKey: "references",
    label: "Document References",
    fields: ["poNumber", "referencePoNumber", "invoiceNumber", "referenceInvoiceNumber", "receiptNumber"],
    enabled: true,
    sortOrder: 40,
  },
  {
    groupKey: "vehicle_logistics",
    label: "Vehicle / Logistics",
    fields: ["vehicleNumber", "registrationNumber", "lorryReceiptNumber", "fastagReference", "eWayBillNumber"],
    enabled: true,
    sortOrder: 50,
  },
];

function normalizeGroupKey(value: string, fallback: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || fallback;
}

function sanitizeFields(fields: unknown) {
  if (!Array.isArray(fields)) return [];
  return Array.from(
    new Set(
      fields
        .filter((field): field is string => typeof field === "string")
        .map((field) => field.trim())
        .filter(Boolean)
    )
  );
}

export function sanitizeComparisonGroups(groups: unknown): ComparisonFieldGroup[] {
  if (!Array.isArray(groups)) {
    return DEFAULT_COMPARISON_FIELD_GROUPS;
  }

  return groups
    .map((group, index) => {
      const record = group as Record<string, unknown>;
      const label =
        typeof record.label === "string" && record.label.trim().length > 0
          ? record.label.trim()
          : `Group ${index + 1}`;
      const groupKey = normalizeGroupKey(
        typeof record.groupKey === "string" ? record.groupKey : label,
        `group_${index + 1}`
      );

      return {
        id: typeof record.id === "string" ? record.id : undefined,
        groupKey,
        label,
        fields: sanitizeFields(record.fields),
        enabled: record.enabled !== false,
        sortOrder: typeof record.sortOrder === "number" ? record.sortOrder : (index + 1) * 10,
      };
    })
    .filter((group) => group.fields.length > 0);
}

function rowToGroup(row: ComparisonFieldGroupRow): ComparisonFieldGroup {
  return {
    id: row.id,
    groupKey: row.group_key,
    label: row.label,
    fields: sanitizeFields(row.fields),
    enabled: row.enabled !== false,
    sortOrder: row.sort_order ?? 0,
  };
}

export async function getComparisonGroups(orgId: string = DEFAULT_ORG_ID) {
  const supabase = createSupabaseAdminClient();

  const { data, error } = await supabase
    .from("comparison_field_groups")
    .select("*")
    .eq("organization_id", orgId)
    .order("sort_order", { ascending: true })
    .order("label", { ascending: true });

  if (error) {
    const message = `${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`;
    if (/comparison_field_groups|schema cache|could not find|does not exist/i.test(message)) {
      return DEFAULT_COMPARISON_FIELD_GROUPS;
    }
    console.error("Error fetching comparison groups:", error);
    return DEFAULT_COMPARISON_FIELD_GROUPS;
  }

  const groups = (data as ComparisonFieldGroupRow[] | null)?.map(rowToGroup) ?? [];
  return groups.length > 0 ? groups : DEFAULT_COMPARISON_FIELD_GROUPS;
}

export async function saveComparisonGroups(
  groups: ComparisonFieldGroup[],
  orgId: string = DEFAULT_ORG_ID
) {
  const supabase = createSupabaseAdminClient();
  const sanitizedGroups = sanitizeComparisonGroups(groups);
  const now = new Date().toISOString();
  const records = sanitizedGroups.map((group, index) => ({
    organization_id: orgId,
    group_key: group.groupKey,
    label: group.label,
    fields: group.fields,
    enabled: group.enabled,
    sort_order: group.sortOrder || (index + 1) * 10,
    updated_at: now,
  }));

  const { error: upsertError } = await supabase.from("comparison_field_groups").upsert(records, {
    onConflict: "organization_id,group_key",
  });

  if (upsertError) {
    console.error("Error saving comparison groups:", upsertError);
    return false;
  }

  const retainedKeys = records.map((record) => record.group_key);
  const deleteQuery = supabase.from("comparison_field_groups").delete().eq("organization_id", orgId);
  const { error: deleteError } =
    retainedKeys.length > 0
      ? await deleteQuery.not("group_key", "in", `(${retainedKeys.map((key) => `"${key}"`).join(",")})`)
      : await deleteQuery;

  if (deleteError) {
    console.error("Error pruning comparison groups:", deleteError);
    return false;
  }

  return true;
}
