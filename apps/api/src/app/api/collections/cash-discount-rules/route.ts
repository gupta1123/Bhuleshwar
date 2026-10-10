import { withTeamAccess } from '@/lib/access/route-boundary';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  serializeCashDiscountRule,
  toNullableText,
  toNumber,
  toText,
  type CashDiscountRuleRow,
} from "@/lib/collections";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function isMissingTableError(error: unknown) {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  return /cash_discount_rules|relation .* does not exist|schema cache/i.test(message);
}

function normalizeScopeType(value: unknown) {
  const text = toText(value, 40);
  return ["company", "customer_group", "customer", "invoice", "sales_order"].includes(text)
    ? text
    : "company";
}

function normalizeDiscountType(value: unknown) {
  return toText(value, 40) === "fixed_amount" ? "fixed_amount" : "percentage";
}

function normalizeOneOf(value: unknown, allowed: string[], fallback: string) {
  const text = toText(value, 80);
  return allowed.includes(text) ? text : fallback;
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function GETHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId")?.trim() || null;
    const supabase = createSupabaseAdminClient();
    let query = supabase
      .from("cash_discount_rules")
      .select("*")
      .eq("owner_user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(100);

    if (connectionId) {
      query = query.or(`connection_id.eq.${connectionId},connection_id.is.null`);
    }

    const { data, error } = await query;
    if (error) throw error;

    return jsonWithCors(request, {
      rules: ((data ?? []) as unknown as CashDiscountRuleRow[]).map(serializeCashDiscountRule),
      setupRequired: false,
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      return jsonWithCors(request, {
        rules: [],
        setupRequired: true,
        error: "Run the collections cash discount migration before using rules.",
      });
    }

    console.error("Error in GET /api/collections/cash-discount-rules:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

async function POSTHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const ruleName = toText(body.ruleName ?? body.rule_name, 160);
    if (!ruleName) {
      return jsonWithCors(request, { error: "Rule name is required." }, { status: 400 });
    }

    const payload = {
      owner_user_id: user.id,
      connection_id: toNullableText(body.connectionId ?? body.connection_id, 80),
      rule_name: ruleName,
      scope_type: normalizeScopeType(body.scopeType ?? body.scope_type),
      scope_key: toNullableText(body.scopeKey ?? body.scope_key, 240),
      scope_label: toNullableText(body.scopeLabel ?? body.scope_label, 240),
      discount_type: normalizeDiscountType(body.discountType ?? body.discount_type),
      discount_value: toNumber(body.discountValue ?? body.discount_value),
      calculation_base: normalizeOneOf(
        body.calculationBase ?? body.calculation_base,
        ["taxable_value", "invoice_total", "product_value"],
        "invoice_total"
      ),
      eligibility_days: Math.max(0, Math.trunc(toNumber(body.eligibilityDays ?? body.eligibility_days))),
      grace_days: Math.max(0, Math.trunc(toNumber(body.graceDays ?? body.grace_days))),
      payment_condition: normalizeOneOf(
        body.paymentCondition ?? body.payment_condition,
        ["full_payment", "pro_rata", "manual_review"],
        "full_payment"
      ),
      accounting_treatment: normalizeOneOf(
        body.accountingTreatment ?? body.accounting_treatment,
        ["credit_note", "commercial_credit_note", "pre_discounted_invoice", "finance_review"],
        "finance_review"
      ),
      missed_cd_treatment: normalizeOneOf(
        body.missedCdTreatment ?? body.missed_cd_treatment,
        ["no_action", "debit_note_proposal", "follow_up_only", "finance_review"],
        "finance_review"
      ),
      approval_required: body.approvalRequired ?? body.approval_required ?? true,
      label: toText(body.label, 80) || "Cash Discount",
      is_active: body.isActive ?? body.is_active ?? true,
    };

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("cash_discount_rules")
      .insert(payload)
      .select("*")
      .single();

    if (error) throw error;

    return jsonWithCors(
      request,
      { rule: serializeCashDiscountRule(data as unknown as CashDiscountRuleRow) },
      { status: 201 }
    );
  } catch (error) {
    if (isMissingTableError(error)) {
      return jsonWithCors(
        request,
        { error: "Run the collections cash discount migration before creating rules.", setupRequired: true },
        { status: 409 }
      );
    }

    console.error("Error in POST /api/collections/cash-discount-rules:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
export const POST = withTeamAccess(POSTHandler);
