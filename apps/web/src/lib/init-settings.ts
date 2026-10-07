import { setEnabledFields, resetEnabledFields } from "@/lib/document-schema";
import { apiFetch } from "@/lib/api-client";

const DEFAULT_ENABLED_FIELDS = new Set<string>();

export async function initializeFieldSettings() {
  try {
    const response = await apiFetch("/api/settings/init", {
      method: "GET",
      cache: "no-store"
    });
    
    if (response.ok) {
      return;
    }
  } catch (error) {
    console.warn("Could not load custom field settings, using defaults:", error);
  }
  
  resetEnabledFields();
}
