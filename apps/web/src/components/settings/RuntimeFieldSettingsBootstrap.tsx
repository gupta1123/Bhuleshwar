"use client";

import { useEffect } from "react";
import { apiFetch } from "@/lib/api-client";

import { buildPacketFieldConfiguration, resetEnabledFields, setPacketFieldConfiguration } from "@/lib/document-schema";

type SettingsResponse = {
  fieldSettings?: Array<{ doc_type: string; field_key: string; enabled: boolean }>;
  docTypeSettings?: Array<{ doc_type: string; enabled: boolean }>;
};

export function RuntimeFieldSettingsBootstrap() {
  useEffect(() => {
    let active = true;

    const loadRuntimeFieldSettings = async () => {
      try {
        const response = await apiFetch("/api/settings/field", {
          method: "GET",
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = (await response.json()) as SettingsResponse;
        if (!active) {
          return;
        }

        setPacketFieldConfiguration(
          buildPacketFieldConfiguration({
            fieldSettings: payload.fieldSettings,
            docTypeSettings: payload.docTypeSettings,
          })
        );
      } catch {
        if (!active) {
          return;
        }
        resetEnabledFields();
      }
    };

    void loadRuntimeFieldSettings();

    return () => {
      active = false;
    };
  }, []);

  return null;
}
