import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type PurchaseAccountingSettings = {
  purchaseGoodsTdsEnabled: boolean;
  transporterTdsEnabled: boolean;
  gstTdsEnabled: boolean;
  validationPolicy: PurchaseValidationPolicy;
};

export const PURCHASE_VALIDATION_RULE_KEYS = [
  "companyGstinMissing",
  "companyGstinInvalid",
  "buyerGstinMissing",
  "supplierGstinMissing",
  "buyerCompanyGstinMismatch",
  "supplierLedgerGstinMismatch",
  "hsnMissing",
  "stockItemHsnMismatch",
  "stockItemUnitMismatch",
  "sourceDocumentMissing",
  "caseNotAccepted",
  "staleTallyMasters",
  "possibleDuplicate",
] as const;

export type PurchaseValidationRuleKey =
  (typeof PURCHASE_VALIDATION_RULE_KEYS)[number];
export type PurchaseValidationSeverity = "block" | "warn" | "off";
export type PurchaseValidationPolicy = Record<
  PurchaseValidationRuleKey,
  PurchaseValidationSeverity
>;

type PurchaseAccountingSettingsRow = {
  organization_id: string;
  purchase_goods_tds_enabled: boolean;
  transporter_tds_enabled: boolean;
  gst_tds_enabled: boolean;
  validation_policy?: unknown;
};

export const DEFAULT_PURCHASE_VALIDATION_POLICY: PurchaseValidationPolicy = {
  companyGstinMissing: "warn",
  companyGstinInvalid: "warn",
  buyerGstinMissing: "warn",
  supplierGstinMissing: "warn",
  buyerCompanyGstinMismatch: "block",
  supplierLedgerGstinMismatch: "block",
  hsnMissing: "warn",
  stockItemHsnMismatch: "warn",
  stockItemUnitMismatch: "warn",
  sourceDocumentMissing: "warn",
  caseNotAccepted: "block",
  staleTallyMasters: "warn",
  possibleDuplicate: "block",
};

export const DEFAULT_PURCHASE_ACCOUNTING_SETTINGS: PurchaseAccountingSettings = {
  purchaseGoodsTdsEnabled: false,
  transporterTdsEnabled: false,
  gstTdsEnabled: false,
  validationPolicy: { ...DEFAULT_PURCHASE_VALIDATION_POLICY },
};

const DEFAULT_ORG_ID = "default";
const CACHE_TTL_MS = 60_000;

const cache = new Map<
  string,
  { value: PurchaseAccountingSettings; expiresAt: number }
>();
const pendingReads = new Map<
  string,
  Promise<PurchaseAccountingSettings>
>();

function fromRow(
  row: PurchaseAccountingSettingsRow | null
): PurchaseAccountingSettings {
  if (!row) return defaultPurchaseAccountingSettings();
  return {
    purchaseGoodsTdsEnabled: Boolean(row.purchase_goods_tds_enabled),
    transporterTdsEnabled: Boolean(row.transporter_tds_enabled),
    gstTdsEnabled: Boolean(row.gst_tds_enabled),
    validationPolicy: normalizePurchaseValidationPolicy(row.validation_policy),
  };
}

export function defaultPurchaseAccountingSettings(): PurchaseAccountingSettings {
  return {
    ...DEFAULT_PURCHASE_ACCOUNTING_SETTINGS,
    validationPolicy: { ...DEFAULT_PURCHASE_VALIDATION_POLICY },
  };
}

export function normalizePurchaseValidationPolicy(
  input: unknown
): PurchaseValidationPolicy {
  const source = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  return Object.fromEntries(
    PURCHASE_VALIDATION_RULE_KEYS.map((key) => {
      const value = source[key];
      return [
        key,
        value === "block" || value === "warn" || value === "off"
          ? value
          : DEFAULT_PURCHASE_VALIDATION_POLICY[key],
      ];
    })
  ) as PurchaseValidationPolicy;
}

export function isCompletePurchaseValidationPolicy(
  input: unknown
): input is PurchaseValidationPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  return PURCHASE_VALIDATION_RULE_KEYS.every((key) =>
    record[key] === "block" || record[key] === "warn" || record[key] === "off"
  );
}

function serializeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== "object") return String(error ?? "Unknown error");
  const record = error as Record<string, unknown>;
  return [record.message, record.details, record.hint, record.code]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
}

export function isPurchaseAccountingSettingsSchemaMissing(error: unknown) {
  return /purchase_accounting_settings|validation_policy|schema cache|does not exist|PGRST205|42703/i.test(
    serializeError(error)
  );
}

function readCached(orgId: string) {
  const cached = cache.get(orgId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    cache.delete(orgId);
    return null;
  }
  return cached.value;
}

function storeCached(orgId: string, value: PurchaseAccountingSettings) {
  cache.set(orgId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function readFromDatabase(orgId: string) {
  const supabase = createSupabaseAdminClient();
  const result = await supabase
    .from("purchase_accounting_settings")
    .select(
      "organization_id, purchase_goods_tds_enabled, transporter_tds_enabled, gst_tds_enabled, validation_policy"
    )
    .eq("organization_id", orgId)
    .maybeSingle();
  let data = result.data;
  if (result.error && /validation_policy|42703/i.test(serializeError(result.error))) {
    const legacy = await supabase
      .from("purchase_accounting_settings")
      .select(
        "organization_id, purchase_goods_tds_enabled, transporter_tds_enabled, gst_tds_enabled"
      )
      .eq("organization_id", orgId)
      .maybeSingle();
    if (legacy.error) throw legacy.error;
    data = legacy.data as typeof data;
  } else if (result.error) {
    throw result.error;
  }

  const settings = fromRow(data as PurchaseAccountingSettingsRow | null);
  storeCached(orgId, settings);
  return settings;
}

export async function getPurchaseAccountingSettings(
  orgId: string = DEFAULT_ORG_ID
) {
  const cached = readCached(orgId);
  if (cached) return cached;

  const pending = pendingReads.get(orgId);
  if (pending) return pending;

  const read = readFromDatabase(orgId).finally(() => pendingReads.delete(orgId));
  pendingReads.set(orgId, read);
  return read;
}

export async function getPurchaseAccountingSettingsOrDefaults(
  orgId: string = DEFAULT_ORG_ID
) {
  try {
    return await getPurchaseAccountingSettings(orgId);
  } catch (error) {
    if (isPurchaseAccountingSettingsSchemaMissing(error)) {
      return defaultPurchaseAccountingSettings();
    }
    throw error;
  }
}

export async function savePurchaseAccountingSettings(
  settings: PurchaseAccountingSettings,
  orgId: string = DEFAULT_ORG_ID
) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("purchase_accounting_settings")
    .upsert(
      {
        organization_id: orgId,
        purchase_goods_tds_enabled: settings.purchaseGoodsTdsEnabled,
        transporter_tds_enabled: settings.transporterTdsEnabled,
        gst_tds_enabled: settings.gstTdsEnabled,
        validation_policy: settings.validationPolicy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id" }
    )
    .select(
      "organization_id, purchase_goods_tds_enabled, transporter_tds_enabled, gst_tds_enabled, validation_policy"
    )
    .single();
  if (error) throw error;

  const saved = fromRow(data as PurchaseAccountingSettingsRow);
  storeCached(orgId, saved);
  return saved;
}
