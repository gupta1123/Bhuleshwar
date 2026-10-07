import { createSupabaseAdminClient } from "./supabase/admin";
import { buildPacketFieldConfiguration, type PacketFieldConfiguration } from "./document-schema";

export type FieldSettingRow = {
  id: string;
  organization_id: string | null;
  doc_type: string;
  field_key: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type DocTypeSettingRow = {
  id: string;
  organization_id: string | null;
  doc_type: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

const DEFAULT_ORG_ID = "default";
const FIELD_SETTINGS_CACHE_TTL_MS = 60_000;

type FieldSettingsPayload = {
  fieldSettings: FieldSettingRow[];
  docTypeSettings: DocTypeSettingRow[];
};

const fieldSettingsCache = new Map<string, { value: FieldSettingsPayload; expiresAt: number }>();
const pendingFieldSettingsReads = new Map<string, Promise<FieldSettingsPayload | null>>();

function getCachedFieldSettings(orgId: string) {
  const cached = fieldSettingsCache.get(orgId);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    fieldSettingsCache.delete(orgId);
    return null;
  }

  return cached.value;
}

function cacheFieldSettings(orgId: string, value: FieldSettingsPayload) {
  fieldSettingsCache.set(orgId, {
    value,
    expiresAt: Date.now() + FIELD_SETTINGS_CACHE_TTL_MS,
  });
}

function clearFieldSettingsCache(orgId: string = DEFAULT_ORG_ID) {
  fieldSettingsCache.delete(orgId);
}

export async function getFieldSettings(orgId: string = DEFAULT_ORG_ID) {
  const cached = getCachedFieldSettings(orgId);
  if (cached) {
    return cached;
  }

  const pending = pendingFieldSettingsReads.get(orgId);
  if (pending) {
    return pending;
  }

  const readPromise = readFieldSettings(orgId).finally(() => {
    pendingFieldSettingsReads.delete(orgId);
  });
  pendingFieldSettingsReads.set(orgId, readPromise);
  return readPromise;
}

async function readFieldSettings(orgId: string): Promise<FieldSettingsPayload | null> {
  const supabase = createSupabaseAdminClient();

  const [fieldResult, docTypeResult] = await Promise.all([
    supabase
      .from("field_settings")
      .select("*")
      .eq("organization_id", orgId),
    supabase
      .from("doc_type_settings")
      .select("*")
      .eq("organization_id", orgId),
  ]);

  const { data: fieldSettings, error: fieldError } = fieldResult;

  if (fieldError) {
    console.error("Error fetching field settings:", fieldError);
    return null;
  }

  const { data: docTypeSettings, error: docError } = docTypeResult;

  if (docError) {
    console.error("Error fetching doc type settings:", docError);
    return null;
  }

  const payload = {
    fieldSettings: fieldSettings as FieldSettingRow[],
    docTypeSettings: docTypeSettings as DocTypeSettingRow[],
  };

  cacheFieldSettings(orgId, payload);
  return payload;
}

export async function getPersistedPacketFieldConfiguration(
  orgId: string = DEFAULT_ORG_ID
): Promise<PacketFieldConfiguration> {
  const settings = await getFieldSettings(orgId);

  if (!settings) {
    if(process.env.TEAM_ACCESS_ENFORCEMENT==='true')throw new Error('Organization field configuration is unavailable.');
    return buildPacketFieldConfiguration();
  }

  return buildPacketFieldConfiguration({
    fieldSettings: settings.fieldSettings,
    docTypeSettings: settings.docTypeSettings,
  });
}

export async function saveFieldSettings(
  settings: Array<{ docType: string; fieldKey: string; enabled: boolean }>,
  orgId: string = DEFAULT_ORG_ID
) {
  const supabase = createSupabaseAdminClient();
  
  const records = settings.map((s) => ({
    organization_id: orgId,
    doc_type: s.docType,
    field_key: s.fieldKey,
    enabled: s.enabled,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("field_settings")
    .upsert(records, {
      onConflict: "organization_id,doc_type,field_key",
    });

  if (error) {
    console.error("Error saving field settings:", error);
    return false;
  }

  clearFieldSettingsCache(orgId);
  return true;
}

export async function saveDocTypeSettings(
  settings: Array<{ docType: string; enabled: boolean }>,
  orgId: string = DEFAULT_ORG_ID
) {
  const supabase = createSupabaseAdminClient();
  
  const records = settings.map((s) => ({
    organization_id: orgId,
    doc_type: s.docType,
    enabled: s.enabled,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("doc_type_settings")
    .upsert(records, {
      onConflict: "organization_id,doc_type",
    });

  if (error) {
    console.error("Error saving doc type settings:", error);
    return false;
  }

  clearFieldSettingsCache(orgId);
  return true;
}

export async function initializeDefaultSettings() {
  const supabase = createSupabaseAdminClient();
  
  const { error } = await supabase.from("field_settings").upsert(
    [],
    { onConflict: "organization_id,doc_type,field_key" }
  );

  clearFieldSettingsCache();
  return !error;
}
