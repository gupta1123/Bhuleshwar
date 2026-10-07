import { apiFetch } from "@/lib/api-client";

export type ComparisonFieldGroup = {
  id?: string;
  groupKey: string;
  label: string;
  fields: string[];
  enabled: boolean;
  sortOrder: number;
};

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

export function normalizeComparisonGroupKey(value: string, fallback: string) {
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

      return {
        id: typeof record.id === "string" ? record.id : undefined,
        groupKey: normalizeComparisonGroupKey(
          typeof record.groupKey === "string" ? record.groupKey : label,
          `group_${index + 1}`
        ),
        label,
        fields: sanitizeFields(record.fields),
        enabled: record.enabled !== false,
        sortOrder: typeof record.sortOrder === "number" ? record.sortOrder : (index + 1) * 10,
      };
    })
    .filter((group) => group.fields.length > 0);
}

async function getResponseError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: string };
    if (payload?.error) return payload.error;
  } catch {}
  return `Request failed with status ${response.status}`;
}

export async function fetchComparisonGroups() {
  const response = await apiFetch("/api/settings/comparison-groups", {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await getResponseError(response));
  }

  const payload = (await response.json()) as { groups?: unknown };
  return sanitizeComparisonGroups(payload.groups);
}

export async function saveComparisonGroups(groups: ComparisonFieldGroup[]) {
  const response = await apiFetch("/api/settings/comparison-groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groups: sanitizeComparisonGroups(groups) }),
  });

  if (!response.ok) {
    throw new Error(await getResponseError(response));
  }

  return response.json() as Promise<{ success: boolean; groups: ComparisonFieldGroup[] }>;
}
