import { withTeamAccess } from '@/lib/access/route-boundary';
import { settingsOrganization } from '@/lib/access/settings';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  getPurchaseAccountingSettings,
  isCompletePurchaseValidationPolicy,
  isPurchaseAccountingSettingsSchemaMissing,
  savePurchaseAccountingSettings,
  type PurchaseAccountingSettings,
} from "@/lib/purchase-accounting-settings";

const MIGRATION_FILE =
  "supabase/migrations/202608200001_purchase_validation_policy.sql";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "Unknown error");
}

function schemaMissingResponse(request: Request) {
  return jsonWithCors(
    request,
    {
      error: `Purchase accounting settings are not installed. Run ${MIGRATION_FILE}.`,
      migrationRequired: true,
      migrationFile: MIGRATION_FILE,
    },
    { status: 409 }
  );
}

function parseSettings(input: unknown): PurchaseAccountingSettings | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const keys = [
    "purchaseGoodsTdsEnabled",
    "transporterTdsEnabled",
    "gstTdsEnabled",
  ] as const;
  if (keys.some((key) => typeof record[key] !== "boolean")) return null;
  if (!isCompletePurchaseValidationPolicy(record.validationPolicy)) return null;
  return {
    purchaseGoodsTdsEnabled: record.purchaseGoodsTdsEnabled as boolean,
    transporterTdsEnabled: record.transporterTdsEnabled as boolean,
    gstTdsEnabled: record.gstTdsEnabled as boolean,
    validationPolicy: record.validationPolicy,
  };
}

async function GETHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });

    const settings = await getPurchaseAccountingSettings(await settingsOrganization(request));
    return jsonWithCors(request, { settings });
  } catch (error) {
    if (isPurchaseAccountingSettingsSchemaMissing(error)) {
      return schemaMissingResponse(request);
    }
    console.error("Error in GET /api/settings/purchase-accounting:", error);
    return jsonWithCors(request, { error: errorMessage(error) }, { status: 500 });
  }
}

async function PUTHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });

    const body = await request.json().catch(() => null);
    const settings = parseSettings(
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).settings
        : null
    );
    if (!settings) {
      return jsonWithCors(
        request,
        { error: "Purchase accounting switches and every validation severity are required." },
        { status: 400 }
      );
    }

    const saved = await savePurchaseAccountingSettings(settings, await settingsOrganization(request));
    return jsonWithCors(request, { success: true, settings: saved });
  } catch (error) {
    if (isPurchaseAccountingSettingsSchemaMissing(error)) {
      return schemaMissingResponse(request);
    }
    console.error("Error in PUT /api/settings/purchase-accounting:", error);
    return jsonWithCors(request, { error: errorMessage(error) }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
export const PUT = withTeamAccess(PUTHandler);
