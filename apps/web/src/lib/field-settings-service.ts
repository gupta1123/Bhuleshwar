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

export async function getFieldSettings(orgId: string = DEFAULT_ORG_ID) {
  const supabase = createSupabaseAdminClient();
  
  const { data: fieldSettings, error: fieldError } = await supabase
    .from("field_settings")
    .select("*")
    .eq("organization_id", orgId);

  if (fieldError) {
    console.error("Error fetching field settings:", fieldError);
    return null;
  }

  const { data: docTypeSettings, error: docError } = await supabase
    .from("doc_type_settings")
    .select("*")
    .eq("organization_id", orgId);

  if (docError) {
    console.error("Error fetching doc type settings:", docError);
    return null;
  }

  return {
    fieldSettings: fieldSettings as FieldSettingRow[],
    docTypeSettings: docTypeSettings as DocTypeSettingRow[],
  };
}

export async function getPersistedPacketFieldConfiguration(
  orgId: string = DEFAULT_ORG_ID
): Promise<PacketFieldConfiguration> {
  const settings = await getFieldSettings(orgId);

  if (!settings) {
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

  return true;
}

export async function initializeDefaultSettings() {
  const supabase = createSupabaseAdminClient();
  
  const { error } = await supabase.from("field_settings").upsert(
    [],
    { onConflict: "organization_id,doc_type,field_key" }
  );
  
  return !error;
}
