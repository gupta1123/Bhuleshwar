import { setEnabledFields, resetEnabledFields } from "@/lib/document-schema";

const DEFAULT_ENABLED_FIELDS = new Set<string>();

export async function initializeFieldSettings() {
  try {
    const response = await fetch("/api/settings/init", { 
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