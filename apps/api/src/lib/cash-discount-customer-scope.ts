import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type CashDiscountCustomerScopeMode = "automatic" | "custom" | "strict";

export type CashDiscountCustomerScope = {
  mode: CashDiscountCustomerScopeMode;
  selectedGroupNames: string[];
  includeNestedGroups: boolean;
  detectSalesLinkedExceptions: boolean;
  excludedGroupNames: string[];
  excludedLedgerNames: string[];
};

type ScopeRow = {
  company_name_key?: string;
  mode: CashDiscountCustomerScopeMode;
  selected_group_names: string[] | null;
  include_nested_groups: boolean;
  detect_sales_linked_exceptions: boolean;
  excluded_group_names: string[] | null;
  excluded_ledger_names: string[] | null;
};

export const DEFAULT_CASH_DISCOUNT_CUSTOMER_SCOPE: CashDiscountCustomerScope = {
  mode: "automatic",
  selectedGroupNames: ["Sundry Debtors"],
  includeNestedGroups: true,
  detectSalesLinkedExceptions: true,
  excludedGroupNames: [],
  excludedLedgerNames: [],
};

function cleanNames(value: unknown, fallback: string[] = []) {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const name = typeof item === "string" ? item.trim().slice(0, 240) : "";
    const key = name.toLowerCase().replace(/\s+/g, " ");
    if (!name || seen.has(key)) return [];
    seen.add(key);
    return [name];
  }).slice(0, 200);
}

export function normalizeCashDiscountCustomerScope(input: unknown): CashDiscountCustomerScope {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const mode: CashDiscountCustomerScopeMode =
    record.mode === "custom" || record.mode === "strict" ? record.mode : "automatic";
  const selectedGroupNames = cleanNames(
    record.selectedGroupNames,
    DEFAULT_CASH_DISCOUNT_CUSTOMER_SCOPE.selectedGroupNames
  );
  return {
    mode,
    selectedGroupNames: selectedGroupNames.length > 0
      ? selectedGroupNames
      : [...DEFAULT_CASH_DISCOUNT_CUSTOMER_SCOPE.selectedGroupNames],
    includeNestedGroups: record.includeNestedGroups !== false,
    detectSalesLinkedExceptions:
      mode !== "strict" && record.detectSalesLinkedExceptions !== false,
    excludedGroupNames: cleanNames(record.excludedGroupNames),
    excludedLedgerNames: cleanNames(record.excludedLedgerNames),
  };
}

function fromRow(row: ScopeRow | null) {
  if (!row) return { ...DEFAULT_CASH_DISCOUNT_CUSTOMER_SCOPE };
  return normalizeCashDiscountCustomerScope({
    mode: row.mode,
    selectedGroupNames: row.selected_group_names,
    includeNestedGroups: row.include_nested_groups,
    detectSalesLinkedExceptions: row.detect_sales_linked_exceptions,
    excludedGroupNames: row.excluded_group_names,
    excludedLedgerNames: row.excluded_ledger_names,
  });
}

function serializedError(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const record = error as Record<string, unknown>;
  return [record.message, record.details, record.hint, record.code]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

export function isCashDiscountCustomerScopeSchemaMissing(error: unknown) {
  return /cash_discount_customer_scope_settings|schema cache|does not exist|PGRST205/i.test(
    serializedError(error)
  );
}

export async function getCashDiscountCustomerScope(params: {
  ownerUserId: string;
  connectionId: string;
  companyName: string;
}) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("cash_discount_customer_scope_settings")
    .select("mode, selected_group_names, include_nested_groups, detect_sales_linked_exceptions, excluded_group_names, excluded_ledger_names")
    .eq("owner_user_id", params.ownerUserId)
    .eq("connection_id", params.connectionId)
    .eq("company_name_key", params.companyName.trim().toLowerCase().replace(/\s+/g, " "))
    .maybeSingle();
  if (error) throw error;
  return fromRow(data as ScopeRow | null);
}

export async function getCashDiscountCustomerScopeOrDefault(params: {
  ownerUserId: string;
  connectionId: string;
  companyName: string;
}) {
  try {
    return await getCashDiscountCustomerScope(params);
  } catch (error) {
    if (isCashDiscountCustomerScopeSchemaMissing(error)) {
      return { ...DEFAULT_CASH_DISCOUNT_CUSTOMER_SCOPE };
    }
    throw error;
  }
}

export async function getCashDiscountCustomerScopesByCompany(params: {
  ownerUserId: string;
  connectionId: string;
}) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("cash_discount_customer_scope_settings")
    .select("company_name_key, mode, selected_group_names, include_nested_groups, detect_sales_linked_exceptions, excluded_group_names, excluded_ledger_names")
    .eq("owner_user_id", params.ownerUserId)
    .eq("connection_id", params.connectionId);
  if (error) {
    if (isCashDiscountCustomerScopeSchemaMissing(error)) return {};
    throw error;
  }
  return Object.fromEntries(
    ((data ?? []) as ScopeRow[]).flatMap((row) => {
      const key = String(row.company_name_key ?? "").trim();
      return key ? [[key, fromRow(row)] as const] : [];
    })
  );
}

export async function saveCashDiscountCustomerScope(params: {
  ownerUserId: string;
  connectionId: string;
  companyName: string;
  settings: CashDiscountCustomerScope;
}) {
  const settings = normalizeCashDiscountCustomerScope(params.settings);
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("cash_discount_customer_scope_settings")
    .upsert({
      owner_user_id: params.ownerUserId,
      connection_id: params.connectionId,
      company_name: params.companyName.trim(),
      company_name_key: params.companyName.trim().toLowerCase().replace(/\s+/g, " "),
      mode: settings.mode,
      selected_group_names: settings.selectedGroupNames,
      include_nested_groups: settings.includeNestedGroups,
      detect_sales_linked_exceptions: settings.detectSalesLinkedExceptions,
      excluded_group_names: settings.excludedGroupNames,
      excluded_ledger_names: settings.excludedLedgerNames,
      updated_at: new Date().toISOString(),
    }, { onConflict: "owner_user_id,connection_id,company_name_key" })
    .select("mode, selected_group_names, include_nested_groups, detect_sales_linked_exceptions, excluded_group_names, excluded_ledger_names")
    .single();
  if (error) throw error;
  return fromRow(data as ScopeRow);
}
