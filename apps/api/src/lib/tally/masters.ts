export type TallyMasterType =
  | "ledger"
  | "group"
  | "stock_item"
  | "unit"
  | "voucher_type"
  | "gst_ledger"
  | "tax_ledger";

export type TallyMappingType =
  | "supplier_gstin"
  | "buyer_gstin"
  | "item_hsn"
  | "item_description"
  | "gst_rate"
  | "purchase_ledger"
  | "tds_ledger"
  | "tcs_ledger"
  | "stock_unit"
  | "freight_ledger"
  | "round_off_ledger"
  | "voucher_type"
  | "bank_account_ledger"
  | "bank_narration_ledger"
  | "bank_category_ledger";

export type TallyMasterInput = {
  name?: unknown;
  guid?: unknown;
  parent?: unknown;
  gstin?: unknown;
  bankName?: unknown;
  bankAccountNumber?: unknown;
  closingBalance?: unknown;
  closingBalanceType?: unknown;
  ifscCode?: unknown;
  branchName?: unknown;
  accountHolderName?: unknown;
  email?: unknown;
  phone?: unknown;
  contactPerson?: unknown;
  address?: unknown;
  hsnCode?: unknown;
  unitName?: unknown;
  taxRate?: unknown;
  raw?: unknown;
};

export type TallyMasterRow = {
  id: string;
  connection_id: string;
  owner_user_id: string;
  company_name: string;
  sync_run_id: string | null;
  master_type: TallyMasterType;
  master_key: string;
  tally_guid: string | null;
  tally_name: string;
  parent_name: string | null;
  gstin: string | null;
  hsn_code: string | null;
  unit_name: string | null;
  tax_rate: number | null;
  raw_payload: Record<string, unknown>;
  is_active: boolean;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
};

export type TallyMappingRow = {
  id: string;
  connection_id: string;
  owner_user_id: string;
  company_name: string;
  mapping_type: TallyMappingType;
  source_key: string;
  source_label: string;
  target_master_type: string;
  target_master_key: string;
  target_master_name: string;
  status: "active" | "inactive";
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export const MASTER_TYPES: TallyMasterType[] = [
  "ledger",
  "group",
  "stock_item",
  "unit",
  "voucher_type",
  "gst_ledger",
  "tax_ledger",
];

export const MAPPING_TYPES: TallyMappingType[] = [
  "supplier_gstin",
  "buyer_gstin",
  "item_hsn",
  "item_description",
  "gst_rate",
  "purchase_ledger",
  "tds_ledger",
  "tcs_ledger",
  "stock_unit",
  "freight_ledger",
  "round_off_ledger",
  "voucher_type",
  "bank_account_ledger",
  "bank_narration_ledger",
  "bank_category_ledger",
];

// Saved masters are only a short-lived safety cache. Review and posting flows
// must refresh Tally rather than silently relying on an old snapshot.
export const TALLY_MASTER_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

export function tallyMasterFreshnessCutoff(now = Date.now()) {
  return new Date(now - TALLY_MASTER_CACHE_MAX_AGE_MS).toISOString();
}

export function toNullableText(value: unknown, maxLength = 500) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

export function toRequiredText(value: unknown, fallback = "") {
  const text = toNullableText(value);
  return text ?? fallback;
}

export function toNullableNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/%/g, "").trim();
  if (!normalized) return null;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function getMasterInputValue(input: TallyMasterInput, ...fieldNames: string[]) {
  const values = input as Record<string, unknown>;
  const normalizedFields = new Map(
    Object.entries(values).map(([key, value]) => [
      key.toLowerCase().replace(/[^a-z0-9]/g, ""),
      value,
    ])
  );

  for (const fieldName of fieldNames) {
    const value = normalizedFields.get(fieldName.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return undefined;
}

export function normalizeMasterKey(input: {
  masterType: TallyMasterType;
  name: string;
  guid?: string | null;
}) {
  const source = input.guid || input.name;
  return `${input.masterType}:${source.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export function normalizeMasterInput(masterType: TallyMasterType, input: TallyMasterInput) {
  // Connector builds and PowerShell helpers have historically emitted both
  // camelCase and Tally-style uppercase keys. Normalize field names here so a
  // valid read cannot be reported as a successful sync with zero accepted rows.
  const name = toRequiredText(getMasterInputValue(input, "name"));
  if (!name) return null;

  const guid = toNullableText(getMasterInputValue(input, "guid"), 160);
  const parent = toNullableText(getMasterInputValue(input, "parent"), 240);
  const rawInput = getMasterInputValue(input, "raw");
  const raw = rawInput && typeof rawInput === "object" ? rawInput : input;

  return {
    master_type: masterType,
    master_key: normalizeMasterKey({ masterType, name, guid }),
    tally_guid: guid,
    tally_name: name.slice(0, 500),
    parent_name: parent,
    gstin: toNullableText(
      getMasterInputValue(input, "gstin", "partyGstin", "gstRegistrationNumber"),
      32
    ),
    hsn_code: toNullableText(getMasterInputValue(input, "hsnCode", "gstHsnCode"), 32),
    unit_name: toNullableText(
      getMasterInputValue(input, "unitName", "baseUnits", "originalBaseUnits"),
      80
    ),
    tax_rate: toNullableNumber(
      getMasterInputValue(input, "taxRate", "gstTaxRate", "rateOfTaxCalculation")
    ),
    raw_payload: raw as Record<string, unknown>,
  };
}

export function serializeTallyMaster(row: TallyMasterRow) {
  const raw =
    row.raw_payload && typeof row.raw_payload === "object" && !Array.isArray(row.raw_payload)
      ? row.raw_payload
      : {};

  return {
    id: row.id,
    connectionId: row.connection_id,
    companyName: row.company_name,
    type: row.master_type,
    key: row.master_key,
    guid: row.tally_guid,
    name: row.tally_name,
    parent: row.parent_name,
    gstin: row.gstin,
    bankName: typeof raw.bankName === "string" ? raw.bankName : null,
    bankAccountNumber: typeof raw.bankAccountNumber === "string" ? raw.bankAccountNumber : null,
    ifscCode: typeof raw.ifscCode === "string" ? raw.ifscCode : null,
    branchName: typeof raw.branchName === "string" ? raw.branchName : null,
    accountHolderName: typeof raw.accountHolderName === "string" ? raw.accountHolderName : null,
    closingBalance:
      typeof raw.closingBalance === "number" && Number.isFinite(raw.closingBalance)
        ? raw.closingBalance
        : toNullableNumber(raw.closingBalance),
    closingBalanceType:
      raw.closingBalanceType === "Dr" || raw.closingBalanceType === "Cr"
        ? raw.closingBalanceType
        : null,
    email: typeof raw.email === "string" ? raw.email : null,
    phone: typeof raw.phone === "string" ? raw.phone : null,
    contactPerson: typeof raw.contactPerson === "string" ? raw.contactPerson : null,
    address: typeof raw.address === "string" ? raw.address : null,
    billWiseEnabled: typeof raw.billWiseEnabled === "boolean" ? raw.billWiseEnabled : null,
    ledgerType:
      row.master_type === "ledger" && typeof row.parent_name === "string" && /sundry\s+debtors/i.test(row.parent_name)
        ? "customer"
        : row.master_type === "ledger" && typeof row.parent_name === "string" && /sundry\s+creditors/i.test(row.parent_name)
          ? "supplier"
          : "other",
    hsnCode: row.hsn_code,
    unitName: row.unit_name,
    taxRate: row.tax_rate,
    isActive: row.is_active,
    lastSyncedAt: row.last_synced_at,
  };
}

export function serializeTallyMapping(row: TallyMappingRow) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    companyName: row.company_name,
    mappingType: row.mapping_type,
    sourceKey: row.source_key,
    sourceLabel: row.source_label,
    targetMasterType: row.target_master_type,
    targetMasterKey: row.target_master_key,
    targetMasterName: row.target_master_name,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
