"use client";

import { useEffect, useState } from "react";
import {TeamAccessPanel} from '@/components/settings/TeamAccessPanel';
import {
  Check,
  CheckCircle2,
  FileStack,
  Loader2,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Shield,
  Sliders,
  SlidersHorizontal,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { PurchasePostingDefaultsSettings } from "@/components/settings/PurchasePostingDefaultsSettings";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_COMPARISON_FIELD_GROUPS,
  fetchComparisonGroups,
  normalizeComparisonGroupKey,
  saveComparisonGroups,
  sanitizeComparisonGroups,
  type ComparisonFieldGroup,
} from "@/lib/comparison-groups";
import {
  DOC_TYPE_EXTRACTION_FIELDS,
  FIELD_DEFINITIONS,
  FIELD_LABELS,
  IGNORED_PACKET_FIELD_KEYS,
  buildPacketFieldConfiguration,
  setPacketFieldConfiguration,
} from "@/lib/document-schema";
import type { DocType, FieldKey } from "@/types/pipeline";

type ActiveTab = "documents" | "groups" | "accounting" | "team";
type BannerState = {
  tone: "success" | "error";
  text: string;
} | null;

type SettingsResponse = {
  fieldSettings?: Array<{ doc_type: string; field_key: string; enabled: boolean }>;
  docTypeSettings?: Array<{ doc_type: string; enabled: boolean }>;
  error?: string;
};

type PurchaseAccountingSettings = {
  purchaseGoodsTdsEnabled: boolean;
  transporterTdsEnabled: boolean;
  gstTdsEnabled: boolean;
  validationPolicy: PurchaseValidationPolicy;
};

type PurchaseValidationSeverity = "block" | "warn" | "off";
type PurchaseValidationRuleKey =
  | "buyerGstinMissing"
  | "supplierGstinMissing"
  | "supplierLedgerGstinMismatch"
  | "hsnMissing"
  | "stockItemHsnMismatch"
  | "stockItemUnitMismatch"
  | "sourceDocumentMissing"
  | "caseNotAccepted"
  | "staleTallyMasters"
  | "possibleDuplicate";
type PurchaseValidationPolicy = Record<PurchaseValidationRuleKey, PurchaseValidationSeverity>;

const DEFAULT_PURCHASE_VALIDATION_POLICY: PurchaseValidationPolicy = {
  buyerGstinMissing: "warn",
  supplierGstinMissing: "warn",
  supplierLedgerGstinMismatch: "block",
  hsnMissing: "warn",
  stockItemHsnMismatch: "warn",
  stockItemUnitMismatch: "warn",
  sourceDocumentMissing: "warn",
  caseNotAccepted: "block",
  staleTallyMasters: "warn",
  possibleDuplicate: "block",
};

const PURCHASE_VALIDATION_GROUPS = [
  {
    title: "GST identity",
    rules: [
      ["buyerGstinMissing", "Buyer GSTIN missing", "Allows unregistered purchases."],
      ["supplierGstinMissing", "Supplier GSTIN missing", "Allows unregistered suppliers."],
      ["supplierLedgerGstinMismatch", "Supplier and ledger GSTIN differ", "Protects against selecting the wrong supplier ledger."],
    ],
  },
  {
    title: "Item mapping",
    rules: [
      ["hsnMissing", "HSN missing", "Skipped when the Tally item already supplies it."],
      ["stockItemHsnMismatch", "Stock-item HSN differs", "Ask for review when invoice and Tally classification differ."],
      ["stockItemUnitMismatch", "Stock-item unit differs", "Tally may support an alternate unit or conversion."],
    ],
  },
  {
    title: "Workflow",
    rules: [
      ["sourceDocumentMissing", "Source invoice missing", "Controls the Bhuleshwar audit attachment, not voucher balancing."],
      ["caseNotAccepted", "Packet approval pending", "Keeps packet approval separate from accounting approval."],
      ["staleTallyMasters", "Tally snapshot is old", "Allows a reviewer to acknowledge an older master snapshot."],
      ["possibleDuplicate", "Possible duplicate invoice", "Protects against sending the same invoice twice."],
    ],
  },
] as const satisfies ReadonlyArray<{
  title: string;
  rules: ReadonlyArray<readonly [PurchaseValidationRuleKey, string, string]>;
}>;

type PurchaseAccountingResponse = {
  settings?: PurchaseAccountingSettings;
  error?: string;
};

type DocTypeEnabledState = Record<string, boolean>;
type FieldEnabledState = Record<string, Record<string, boolean>>;

const DEFAULT_PURCHASE_ACCOUNTING_SETTINGS: PurchaseAccountingSettings = {
  purchaseGoodsTdsEnabled: false,
  transporterTdsEnabled: false,
  gstTdsEnabled: false,
  validationPolicy: { ...DEFAULT_PURCHASE_VALIDATION_POLICY },
};

const AVAILABLE_DOC_TYPES = (Object.keys(DOC_TYPE_EXTRACTION_FIELDS) as DocType[]).filter(
  (docType) => docType !== "Unknown"
);

const HIDDEN_SETTING_FIELD_KEYS = new Set<string>(IGNORED_PACKET_FIELD_KEYS);
const PRIORITY_FIELD_KEYS = new Set<FieldKey>(
  FIELD_DEFINITIONS.filter((field) => field.important).map((field) => field.key)
);

function getConfigurableFields(docType: string): FieldKey[] {
  const seen = new Set<string>();

  return (DOC_TYPE_EXTRACTION_FIELDS[docType as DocType] ?? []).flatMap((fieldKey) => {
    if (HIDDEN_SETTING_FIELD_KEYS.has(fieldKey) || seen.has(fieldKey)) {
      return [];
    }

    seen.add(fieldKey);
    return [fieldKey];
  });
}

function createDefaultDocTypeState(): DocTypeEnabledState {
  return Object.fromEntries(AVAILABLE_DOC_TYPES.map((docType) => [docType, true]));
}

function createDefaultFieldState(): FieldEnabledState {
  return Object.fromEntries(
    AVAILABLE_DOC_TYPES.map((docType) => [
      docType,
      Object.fromEntries(getConfigurableFields(docType).map((fieldKey) => [fieldKey, true])),
    ])
  );
}

function buildStateFromPayload(payload?: SettingsResponse) {
  const docTypeEnabled = createDefaultDocTypeState();
  const fieldEnabled = createDefaultFieldState();

  for (const setting of payload?.docTypeSettings ?? []) {
    if (setting.doc_type in docTypeEnabled) {
      docTypeEnabled[setting.doc_type] = Boolean(setting.enabled);
    }
  }

  for (const setting of payload?.fieldSettings ?? []) {
    if (!(setting.doc_type in fieldEnabled)) {
      continue;
    }

    if (!(setting.field_key in fieldEnabled[setting.doc_type])) {
      continue;
    }

    fieldEnabled[setting.doc_type][setting.field_key] = Boolean(setting.enabled);
  }

  return { docTypeEnabled, fieldEnabled };
}

function serializeSettings(docTypeEnabled: DocTypeEnabledState, fieldEnabled: FieldEnabledState) {
  return JSON.stringify({
    docTypeSettings: AVAILABLE_DOC_TYPES.map((docType) => [docType, docTypeEnabled[docType] ?? true]),
    fieldSettings: AVAILABLE_DOC_TYPES.flatMap((docType) =>
      getConfigurableFields(docType).map((fieldKey) => [
        docType,
        fieldKey,
        fieldEnabled[docType]?.[fieldKey] ?? true,
      ])
    ),
  });
}

function serializeComparisonGroups(groups: ComparisonFieldGroup[]) {
  return JSON.stringify(
    sanitizeComparisonGroups(groups).map((group, index) => ({
      groupKey: group.groupKey,
      label: group.label,
      fields: group.fields,
      enabled: group.enabled,
      sortOrder: group.sortOrder || (index + 1) * 10,
    }))
  );
}

function serializePurchaseAccountingSettings(settings: PurchaseAccountingSettings) {
  return JSON.stringify(settings);
}

function normalizePurchaseAccountingSettings(
  settings: PurchaseAccountingSettings | undefined
): PurchaseAccountingSettings {
  return {
    purchaseGoodsTdsEnabled: Boolean(settings?.purchaseGoodsTdsEnabled),
    transporterTdsEnabled: Boolean(settings?.transporterTdsEnabled),
    gstTdsEnabled: Boolean(settings?.gstTdsEnabled),
    validationPolicy: {
      ...DEFAULT_PURCHASE_VALIDATION_POLICY,
      ...(settings?.validationPolicy ?? {}),
    },
  };
}

const AVAILABLE_GROUP_FIELDS = FIELD_DEFINITIONS.filter(
  (field) => !HIDDEN_SETTING_FIELD_KEYS.has(field.key)
);
const AVAILABLE_GROUP_FIELD_KEYS = new Set(AVAILABLE_GROUP_FIELDS.map((field) => field.key));

function getFirstGroupFieldDocType(fieldKey: string) {
  return AVAILABLE_DOC_TYPES.find((docType) => getConfigurableFields(docType).includes(fieldKey as FieldKey));
}

const GROUP_FIELD_SECTIONS = AVAILABLE_DOC_TYPES.map((docType) => ({
  docType,
  fields: getConfigurableFields(docType).filter(
    (fieldKey) =>
      AVAILABLE_GROUP_FIELD_KEYS.has(fieldKey) && getFirstGroupFieldDocType(fieldKey) === docType
  ),
})).filter((section) => section.fields.length > 0);

function SwitchControl({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
        checked ? "bg-[#2b1a10]" : "bg-[#ded8d0]"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </span>
  );
}

async function getResponseError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: string };
    if (payload?.error) {
      return payload.error;
    }
  } catch {}

  try {
    const text = await response.text();
    if (text) {
      return text;
    }
  } catch {}

  return `Request failed with status ${response.status}`;
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("documents");
  useEffect(()=>{const tab=new URLSearchParams(window.location.search).get('tab');if(tab==='team')setActiveTab(tab);},[]);
  const [selectedDocType, setSelectedDocType] = useState<string>(AVAILABLE_DOC_TYPES[0] ?? "");
  const [docTypeEnabled, setDocTypeEnabled] = useState<DocTypeEnabledState>(() =>
    createDefaultDocTypeState()
  );
  const [fieldEnabled, setFieldEnabled] = useState<FieldEnabledState>(() => createDefaultFieldState());
  const [comparisonGroups, setComparisonGroups] = useState<ComparisonFieldGroup[]>(() =>
    DEFAULT_COMPARISON_FIELD_GROUPS
  );
  const [purchaseAccountingSettings, setPurchaseAccountingSettings] =
    useState<PurchaseAccountingSettings>(DEFAULT_PURCHASE_ACCOUNTING_SETTINGS);
  const [selectedGroupKey, setSelectedGroupKey] = useState(
    DEFAULT_COMPARISON_FIELD_GROUPS[0]?.groupKey ?? ""
  );
  const [savedSignature, setSavedSignature] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<BannerState>(null);
  const [docSearch, setDocSearch] = useState("");
  const [groupFieldSearch, setGroupFieldSearch] = useState("");

  useEffect(() => {
    let cancelled = false;

    const loadSettings = async () => {
      try {
        setLoading(true);
        setBanner(null);

        const [response, loadedGroups, accountingResponse] = await Promise.all([
          apiFetch("/api/settings/field", {
            method: "GET",
            cache: "no-store",
          }),
          fetchComparisonGroups(),
          apiFetch("/api/settings/purchase-accounting", {
            method: "GET",
            cache: "no-store",
          }),
        ]);

        if (!response.ok) {
          throw new Error(await getResponseError(response));
        }

        const payload = (await response.json()) as SettingsResponse;
        const hydratedState = buildStateFromPayload(payload);
        let loadedAccountingSettings = DEFAULT_PURCHASE_ACCOUNTING_SETTINGS;
        let accountingLoadError: string | null = null;
        if (accountingResponse.ok) {
          const accountingPayload = (await accountingResponse.json()) as PurchaseAccountingResponse;
          loadedAccountingSettings = normalizePurchaseAccountingSettings(
            accountingPayload.settings
          );
        } else {
          accountingLoadError = await getResponseError(accountingResponse);
        }

        if (cancelled) {
          return;
        }

        setDocTypeEnabled(hydratedState.docTypeEnabled);
        setFieldEnabled(hydratedState.fieldEnabled);
        setComparisonGroups(loadedGroups);
        setPurchaseAccountingSettings(loadedAccountingSettings);
        setSelectedGroupKey(loadedGroups[0]?.groupKey ?? "");
        setSavedSignature(
          `${serializeSettings(hydratedState.docTypeEnabled, hydratedState.fieldEnabled)}:${serializeComparisonGroups(loadedGroups)}:${serializePurchaseAccountingSettings(loadedAccountingSettings)}`
        );
        if (accountingLoadError) {
          setBanner({
            tone: "error",
            text: `${accountingLoadError}. Purchase accounting rules are shown with safe defaults.`,
          });
        }
      } catch (error) {
        const fallbackDocTypeState = createDefaultDocTypeState();
        const fallbackFieldState = createDefaultFieldState();
        const fallbackGroups = DEFAULT_COMPARISON_FIELD_GROUPS;

        if (cancelled) {
          return;
        }

        setDocTypeEnabled(fallbackDocTypeState);
        setFieldEnabled(fallbackFieldState);
        setComparisonGroups(fallbackGroups);
        setPurchaseAccountingSettings(DEFAULT_PURCHASE_ACCOUNTING_SETTINGS);
        setSelectedGroupKey(fallbackGroups[0]?.groupKey ?? "");
        setSavedSignature(
          `${serializeSettings(fallbackDocTypeState, fallbackFieldState)}:${serializeComparisonGroups(fallbackGroups)}:${serializePurchaseAccountingSettings(DEFAULT_PURCHASE_ACCOUNTING_SETTINGS)}`
        );
        setBanner({
          tone: "error",
          text:
            error instanceof Error
              ? `${error.message}. Showing default settings.`
              : "Could not load saved settings. Showing default settings.",
        });
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  const currentSignature = `${serializeSettings(docTypeEnabled, fieldEnabled)}:${serializeComparisonGroups(comparisonGroups)}:${serializePurchaseAccountingSettings(purchaseAccountingSettings)}`;
  const hasUnsavedChanges = savedSignature !== currentSignature;

  const selectedDocTypeEnabled = docTypeEnabled[selectedDocType] ?? true;
  const selectedFields = getConfigurableFields(selectedDocType);
  const selectedFieldMap = fieldEnabled[selectedDocType] ?? {};
  const selectedPriorityFields = selectedFields.filter((fieldKey) =>
    PRIORITY_FIELD_KEYS.has(fieldKey)
  );
  const selectedStandardFields = selectedFields.filter(
    (fieldKey) => !PRIORITY_FIELD_KEYS.has(fieldKey)
  );

  const enabledDocTypeCount = AVAILABLE_DOC_TYPES.filter(
    (docType) => docTypeEnabled[docType] ?? true
  ).length;
  const totalFieldCount = AVAILABLE_DOC_TYPES.reduce(
    (count, docType) => count + getConfigurableFields(docType).length,
    0
  );
  const enabledFieldCount = AVAILABLE_DOC_TYPES.reduce(
    (count, docType) =>
      count +
      getConfigurableFields(docType).filter((fieldKey) => fieldEnabled[docType]?.[fieldKey] ?? true)
        .length,
    0
  );
  const selectedGroup =
    comparisonGroups.find((group) => group.groupKey === selectedGroupKey) ?? comparisonGroups[0] ?? null;
  const enabledGroupCount = comparisonGroups.filter((group) => group.enabled).length;
  const filteredDocTypes = AVAILABLE_DOC_TYPES.filter((docType) =>
    docType.toLowerCase().includes(docSearch.trim().toLowerCase())
  );
  const normalizedGroupFieldSearch = groupFieldSearch.trim().toLowerCase();
  const filteredGroupFieldSections = GROUP_FIELD_SECTIONS.map((section) => ({
    ...section,
    fields: section.fields.filter((fieldKey) => {
      if (!normalizedGroupFieldSearch) {
        return true;
      }

      return (
        section.docType.toLowerCase().includes(normalizedGroupFieldSearch) ||
        fieldKey.toLowerCase().includes(normalizedGroupFieldSearch) ||
        (FIELD_LABELS[fieldKey] ?? "").toLowerCase().includes(normalizedGroupFieldSearch)
      );
    }),
  })).filter((section) => section.fields.length > 0);

  function handleToggleDocType(docType: string) {
    setBanner(null);
    setDocTypeEnabled((current) => ({
      ...current,
      [docType]: !(current[docType] ?? true),
    }));
  }

  function handleToggleField(docType: string, fieldKey: FieldKey) {
    setBanner(null);
    setFieldEnabled((current) => ({
      ...current,
      [docType]: {
        ...current[docType],
        [fieldKey]: !(current[docType]?.[fieldKey] ?? true),
      },
    }));
  }

  function handleSetAllFields(docType: string, enabled: boolean) {
    setBanner(null);
    setFieldEnabled((current) => ({
      ...current,
      [docType]: Object.fromEntries(
        getConfigurableFields(docType).map((fieldKey) => [fieldKey, enabled])
      ),
    }));
  }

  function handleTogglePurchaseAccountingRule(
    key: "purchaseGoodsTdsEnabled" | "transporterTdsEnabled" | "gstTdsEnabled"
  ) {
    setBanner(null);
    setPurchaseAccountingSettings((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }

  function handleSetPurchaseValidationSeverity(
    key: PurchaseValidationRuleKey,
    severity: PurchaseValidationSeverity
  ) {
    setBanner(null);
    setPurchaseAccountingSettings((current) => ({
      ...current,
      validationPolicy: {
        ...current.validationPolicy,
        [key]: severity,
      },
    }));
  }

  function handleResetDefaults() {
    setBanner(null);
    if (activeTab === "accounting") {
      setPurchaseAccountingSettings(DEFAULT_PURCHASE_ACCOUNTING_SETTINGS);
      return;
    }
    if (activeTab === "groups") {
      setComparisonGroups(DEFAULT_COMPARISON_FIELD_GROUPS);
      setSelectedGroupKey(DEFAULT_COMPARISON_FIELD_GROUPS[0]?.groupKey ?? "");
      return;
    }

    setDocTypeEnabled(createDefaultDocTypeState());
    setFieldEnabled(createDefaultFieldState());
  }

  function handleAddGroup() {
    setBanner(null);
    const index = comparisonGroups.length + 1;
    const group: ComparisonFieldGroup = {
      groupKey: `custom_group_${Date.now()}`,
      label: `New Group ${index}`,
      fields: [],
      enabled: true,
      sortOrder: index * 10,
    };
    setComparisonGroups((current) => [...current, group]);
    setSelectedGroupKey(group.groupKey);
    setActiveTab("groups");
  }

  function handleUpdateGroup(groupKey: string, updates: Partial<ComparisonFieldGroup>) {
    setBanner(null);
    setComparisonGroups((current) =>
      current.map((group) => (group.groupKey === groupKey ? { ...group, ...updates } : group))
    );
  }

  function handleRenameGroup(groupKey: string, label: string) {
    const nextKey = normalizeComparisonGroupKey(label, groupKey);
    setBanner(null);
    setComparisonGroups((current) =>
      current.map((group) =>
        group.groupKey === groupKey
          ? {
              ...group,
              label,
              groupKey: nextKey,
            }
          : group
      )
    );
    setSelectedGroupKey(nextKey);
  }

  function handleToggleGroupField(groupKey: string, fieldKey: string) {
    setBanner(null);
    setComparisonGroups((current) =>
      current.map((group) => {
        if (group.groupKey !== groupKey) return group;
        const fields = group.fields.includes(fieldKey)
          ? group.fields.filter((field) => field !== fieldKey)
          : [...group.fields, fieldKey];
        return { ...group, fields };
      })
    );
  }

  function handleDeleteGroup(groupKey: string) {
    setBanner(null);
    setComparisonGroups((current) => {
      const next = current.filter((group) => group.groupKey !== groupKey);
      if (selectedGroupKey === groupKey) {
        setSelectedGroupKey(next[0]?.groupKey ?? "");
      }
      return next;
    });
  }

  async function handleSave() {
    try {
      setSaving(true);
      setBanner(null);

      const docTypeSettingsPayload = AVAILABLE_DOC_TYPES.map((docType) => ({
        docType,
        enabled: docTypeEnabled[docType] ?? true,
      }));

      const fieldSettingsPayload = AVAILABLE_DOC_TYPES.flatMap((docType) =>
        getConfigurableFields(docType).map((fieldKey) => ({
          docType,
          fieldKey,
          enabled: fieldEnabled[docType]?.[fieldKey] ?? true,
        }))
      );

      const [docTypeResponse, fieldResponse, groupResponse, accountingResponse] = await Promise.all([
        apiFetch("/api/settings/doctype", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ settings: docTypeSettingsPayload }),
        }),
        apiFetch("/api/settings/field", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ settings: fieldSettingsPayload }),
        }),
        saveComparisonGroups(
          comparisonGroups.map((group, index) => ({
            ...group,
            sortOrder: (index + 1) * 10,
          }))
        ),
        apiFetch("/api/settings/purchase-accounting", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ settings: purchaseAccountingSettings }),
        }),
      ]);

      if (!docTypeResponse.ok) {
        throw new Error(await getResponseError(docTypeResponse));
      }

      if (!fieldResponse.ok) {
        throw new Error(await getResponseError(fieldResponse));
      }

      if (!groupResponse.success) {
        throw new Error("Failed to save comparison groups.");
      }

      if (!accountingResponse.ok) {
        throw new Error(await getResponseError(accountingResponse));
      }

      const accountingPayload = (await accountingResponse.json()) as PurchaseAccountingResponse;
      const savedAccountingSettings = normalizePurchaseAccountingSettings(
        accountingPayload.settings ?? purchaseAccountingSettings
      );

      setPacketFieldConfiguration(
        buildPacketFieldConfiguration({
          docTypeSettings: docTypeSettingsPayload.map((setting) => ({
            doc_type: setting.docType,
            enabled: setting.enabled,
          })),
          fieldSettings: fieldSettingsPayload.map((setting) => ({
            doc_type: setting.docType,
            field_key: setting.fieldKey,
            enabled: setting.enabled,
          })),
        })
      );

      const savedGroups = sanitizeComparisonGroups(groupResponse.groups);
      setComparisonGroups(savedGroups);
      setPurchaseAccountingSettings(savedAccountingSettings);
      const nextSignature = `${serializeSettings(docTypeEnabled, fieldEnabled)}:${serializeComparisonGroups(savedGroups)}:${serializePurchaseAccountingSettings(savedAccountingSettings)}`;
      setSavedSignature(nextSignature);
      setBanner({
        tone: "success",
        text: "Settings saved. New reviews will use these document, comparison, and purchase accounting rules.",
      });
    } catch (error) {
      setBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to save settings.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell>
      <div className="min-h-full bg-[#f7f4ef] px-4 py-5 text-[#111827] sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-[1540px] flex-col gap-4">
          <PageHeader
            title="Settings"
            subtitle="Extraction rules, review groups, and accounting policies"
            badge={
              <div className="flex items-center gap-1.5 rounded-lg border border-[#e6ded2] bg-[#fbfaf8] px-2.5 py-1 text-xs font-medium text-[#5b4b3d] shadow-sm">
                <Shield className="h-3 w-3 text-[#8a7f72]" />
                <span>Admin view</span>
              </div>
            }
            actions={
              activeTab !== "team" ? (
                <div className="flex items-center gap-2">
                  <Button
                    className="h-8 rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 text-xs font-medium text-[#3d3530] shadow-sm transition hover:bg-[#ede6d9]"
                    disabled={loading || saving}
                    onClick={handleResetDefaults}
                    type="button"
                    variant="ghost"
                  >
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5 text-[#8a7f72]" />
                    Reset defaults
                  </Button>
                  <Button
                    className="h-8 rounded-lg bg-[#2b1a10] px-4 text-xs font-medium text-white shadow-sm transition hover:bg-[#3d2718]"
                    disabled={loading || saving || !hasUnsavedChanges}
                    onClick={handleSave}
                    type="button"
                  >
                    {saving ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="mr-1.5 h-3.5 w-3.5" />
                        Save changes
                      </>
                    )}
                  </Button>
                </div>
              ) : null
            }
          />


          {banner ? (
            <div
              className={`rounded-xl border px-4 py-3 text-sm font-medium ${
                banner.tone === "success"
                  ? "border-[#10b981]/25 bg-[#ecfdf5] text-[#047857]"
                  : "border-[#ef4444]/25 bg-[#fff1f2] text-[#b91c1c]"
              }`}
            >
              {banner.text}
            </div>
          ) : null}

          {/* ── Warm Earthen Tab Bar ── */}
          <div className="inline-flex flex-wrap max-w-fit items-center gap-1 rounded-lg border border-[#e0d8cc] bg-[#ede6d9]/60 p-1">
            <button
              className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition ${
                activeTab === "documents"
                  ? "bg-white text-[#111827] shadow-2xs"
                  : "text-[#6b5d50] hover:text-[#111827]"
              }`}
              onClick={() => setActiveTab("documents")}
              type="button"
            >
              Documents & fields
            </button>
            <button
              className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition ${
                activeTab === "groups"
                  ? "bg-white text-[#111827] shadow-2xs"
                  : "text-[#6b5d50] hover:text-[#111827]"
              }`}
              onClick={() => setActiveTab("groups")}
              type="button"
            >
              Review groups
            </button>
            <button
              className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition ${
                activeTab === "accounting"
                  ? "bg-white text-[#111827] shadow-2xs"
                  : "text-[#6b5d50] hover:text-[#111827]"
              }`}
              onClick={() => setActiveTab("accounting")}
              type="button"
            >
              Purchase accounting
            </button>
            <button type="button" className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition ${activeTab==='team'?'bg-white text-[#111827] shadow-2xs':'text-[#6b5d50] hover:text-[#111827]'}`} onClick={() => setActiveTab('team')}>Team &amp; Access</button>
          </div>

          <div>
            <div className="flex flex-col gap-5 md:flex-row md:items-start">
              {activeTab === "team" ? <TeamAccessPanel/> : activeTab === "documents" ? (
                <>
                  <aside className="w-full shrink-0 rounded-xl border border-[#ded8d0] bg-white p-3 shadow-2xs md:w-[280px]">
                    <div className="relative mb-2.5">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8a7f72]" />
                      <input
                        className="w-full rounded-lg border border-[#ded8d0] bg-[#fbfaf8] py-1.5 pl-8 pr-3 text-xs text-[#111827] outline-none transition placeholder:text-[#a89e92] focus:border-[#2b1a10] focus:bg-white"
                        onChange={(event) => setDocSearch(event.target.value)}
                        placeholder="Search documents..."
                        type="search"
                        value={docSearch}
                      />
                    </div>

                    <div className="max-h-[560px] space-y-1 overflow-y-auto pr-1">
                      {filteredDocTypes.map((docType) => {
                        const docFields = getConfigurableFields(docType);
                        const docEnabledFieldCount = docFields.filter(
                          (fieldKey) => fieldEnabled[docType]?.[fieldKey] ?? true
                        ).length;
                        const isSelected = selectedDocType === docType;
                        const isEnabled = docTypeEnabled[docType] ?? true;

                        return (
                          <button
                            key={docType}
                            className={`w-full rounded-lg px-2.5 py-2 text-left transition ${
                              isSelected
                                ? "bg-[#ede6d9] text-[#2b1a10] font-medium shadow-2xs"
                                : "text-[#3d3530] hover:bg-[#f7f4ef]"
                            }`}
                            onClick={() => setSelectedDocType(docType)}
                            type="button"
                          >
                            <div className="flex items-center justify-between gap-2.5">
                              <div className="min-w-0">
                                <div className="truncate text-xs font-semibold">{docType}</div>
                                <div className="mt-0.5 text-[11px] font-normal text-[#8a7f72]">
                                  {docEnabledFieldCount}/{docFields.length} fields active
                                </div>
                              </div>
                              <span
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleToggleDocType(docType);
                                }}
                              >
                                <SwitchControl checked={isEnabled} />
                              </span>
                            </div>
                          </button>
                        );
                      })}
                      {filteredDocTypes.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-[#ded8d0] p-4 text-center text-xs text-[#8a7f72]">
                          No document types found.
                        </div>
                      ) : null}
                    </div>
                  </aside>

                  <main className="min-w-0 flex-1">
                    {/* ── Contextual KPIs for Documents & Fields ── */}
                    <div className="mb-4 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-xl border border-[#ded8d0] bg-white p-3.5 shadow-2xs">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a7f72]">
                          Document Types
                        </div>
                        <div className="mt-1 text-xl font-bold tracking-tight text-[#111827]">
                          {enabledDocTypeCount} / {AVAILABLE_DOC_TYPES.length}
                        </div>
                        <div className="mt-0.5 text-xs text-[#8a7f72]">
                          Enabled document types participating in checks
                        </div>
                      </div>
                      <div className="rounded-xl border border-[#ded8d0] bg-white p-3.5 shadow-2xs">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a7f72]">
                          Active Field Checks
                        </div>
                        <div className="mt-1 text-xl font-bold tracking-tight text-[#111827]">
                          {enabledFieldCount} / {totalFieldCount}
                        </div>
                        <div className="mt-0.5 text-xs text-[#8a7f72]">
                          Extraction & reconciliation checks turned on
                        </div>
                      </div>
                    </div>

                    {loading ? (
                      <div className="space-y-3">
                        <div className="h-16 animate-pulse rounded-xl bg-[#ede6d9]/50" />
                        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                          {Array.from({ length: 12 }).map((_, index) => (
                            <div key={index} className="h-12 animate-pulse rounded-lg bg-[#ede6d9]/50" />
                          ))}
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="mb-4 rounded-xl border border-[#ded8d0] bg-white px-5 py-4 shadow-2xs">
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                            <div>
                              <div className="flex items-center gap-2">
                                <h2 className="text-base font-bold tracking-tight text-[#111827]">{selectedDocType}</h2>
                                <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${
                                  selectedDocTypeEnabled
                                    ? "bg-[#ecfdf5] text-[#047857] border border-[#a7f3d0]"
                                    : "bg-[#fef2f2] text-[#b91c1c] border border-[#fecaca]"
                                }`}>
                                  {selectedDocTypeEnabled ? "Included in checks" : "Excluded"}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-[#5b4b3d]">
                                Control whether this document type participates in extraction, comparison, and mismatch reconciliation.
                              </p>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                aria-pressed={selectedDocTypeEnabled}
                                className="flex items-center gap-2 rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 py-1.5 text-xs font-medium text-[#2b1a10] shadow-sm transition hover:bg-[#ede6d9]"
                                onClick={() => handleToggleDocType(selectedDocType)}
                                type="button"
                              >
                                <SwitchControl checked={selectedDocTypeEnabled} />
                                <span>{selectedDocTypeEnabled ? "Included" : "Excluded"}</span>
                              </button>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-xl border border-[#ded8d0] bg-white px-5 py-4 shadow-2xs">
                          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-[#f0ece4] pb-3">
                            <span className="text-xs font-semibold uppercase tracking-wider text-[#8a7f72]">
                              Field Extraction Checks
                            </span>
                            <div className="flex gap-2">
                              <Button
                                className="h-7 rounded-md border-[#ded8d0] bg-[#fbfaf8] px-2.5 text-xs font-medium text-[#3d3530] shadow-2xs hover:bg-[#ede6d9]"
                                onClick={() => handleSetAllFields(selectedDocType, true)}
                                type="button"
                                variant="outline"
                              >
                                Enable all
                              </Button>
                              <Button
                                className="h-7 rounded-md border-[#ded8d0] bg-[#fbfaf8] px-2.5 text-xs font-medium text-[#3d3530] shadow-2xs hover:bg-[#ede6d9]"
                                onClick={() => handleSetAllFields(selectedDocType, false)}
                                type="button"
                                variant="outline"
                              >
                                Disable all
                              </Button>
                            </div>
                          </div>

                          {selectedDocTypeEnabled ? null : (
                            <div className="mb-4 rounded-lg border border-[#f59e0b]/25 bg-[#fff7e6] px-3.5 py-2.5 text-xs font-medium text-[#a16207]">
                              Excluded documents are ignored by the workflow until included again.
                            </div>
                          )}

                          <div className="space-y-5">
                            <section>
                              <div className="mb-2.5 flex items-end justify-between gap-3">
                                <div>
                                  <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#8a7f72]">
                                    Essential fields
                                  </h3>
                                  <p className="text-xs text-[#8a7f72]">
                                    Key fields checked most often for reconciliation.
                                  </p>
                                </div>
                                <span className="text-xs font-medium text-[#8a7f72]">
                                  {
                                    selectedPriorityFields.filter(
                                      (fieldKey) => selectedFieldMap[fieldKey] ?? true
                                    ).length
                                  }
                                  /{selectedPriorityFields.length} active
                                </span>
                              </div>

                              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                                {selectedPriorityFields.map((fieldKey) => {
                                  const isEnabled = selectedFieldMap[fieldKey] ?? true;

                                  return (
                                    <button
                                      key={fieldKey}
                                      aria-pressed={isEnabled}
                                      className={`flex min-h-10 items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${
                                        isEnabled
                                          ? "border-[#ded8d0] bg-[#fdfcfa] hover:border-[#c8bfb0]"
                                          : "border-[#e8e2d8] bg-[#f9f8f6] opacity-60"
                                      } ${selectedDocTypeEnabled ? "hover:bg-[#f5f1eb]" : "opacity-40"}`}
                                      disabled={!selectedDocTypeEnabled}
                                      onClick={() => handleToggleField(selectedDocType, fieldKey)}
                                      type="button"
                                    >
                                      <span
                                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                                          isEnabled
                                            ? "border-[#2b1a10] bg-[#2b1a10] text-white"
                                            : "border-[#ded8d0] bg-white text-transparent"
                                        }`}
                                      >
                                        <Check className="h-3 w-3" />
                                      </span>
                                      <span className="min-w-0 truncate text-xs font-medium text-[#111827]">
                                        {FIELD_LABELS[fieldKey]}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                            </section>

                            <section>
                              <div className="mb-2.5 flex items-end justify-between gap-3">
                                <div>
                                  <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#8a7f72]">
                                    Optional fields
                                  </h3>
                                  <p className="text-xs text-[#8a7f72]">
                                    Additional fields available for this document type.
                                  </p>
                                </div>
                                <span className="text-xs font-medium text-[#8a7f72]">
                                  {
                                    selectedStandardFields.filter(
                                      (fieldKey) => selectedFieldMap[fieldKey] ?? true
                                    ).length
                                  }
                                  /{selectedStandardFields.length} active
                                </span>
                              </div>

                              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                                {selectedStandardFields.map((fieldKey) => {
                                  const isEnabled = selectedFieldMap[fieldKey] ?? true;

                                  return (
                                    <button
                                      key={fieldKey}
                                      aria-pressed={isEnabled}
                                      className={`flex min-h-10 items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${
                                        isEnabled
                                          ? "border-[#ded8d0] bg-[#fdfcfa] hover:border-[#c8bfb0]"
                                          : "border-[#e8e2d8] bg-[#f9f8f6] opacity-60"
                                      } ${selectedDocTypeEnabled ? "hover:bg-[#f5f1eb]" : "opacity-40"}`}
                                      disabled={!selectedDocTypeEnabled}
                                      onClick={() => handleToggleField(selectedDocType, fieldKey)}
                                      type="button"
                                    >
                                      <span
                                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                                          isEnabled
                                            ? "border-[#2b1a10] bg-[#2b1a10] text-white"
                                            : "border-[#ded8d0] bg-white text-transparent"
                                        }`}
                                      >
                                        <Check className="h-3 w-3" />
                                      </span>
                                      <span className="min-w-0 truncate text-xs font-medium text-[#111827]">
                                        {FIELD_LABELS[fieldKey]}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                            </section>
                          </div>
                        </div>
                      </>
                    )}
                  </main>
                </>
              ) : activeTab === "groups" ? (
                <>
                  <aside className="w-full shrink-0 rounded-xl border border-[#ded8d0] bg-white p-3 shadow-2xs md:w-[280px]">
                    <div className="mb-2.5 flex items-center justify-between px-1">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-[#8a7f72]">
                        Review Groups
                      </span>
                      <span className="text-xs font-semibold text-[#8a7f72]">
                        {comparisonGroups.length}
                      </span>
                    </div>

                    <div className="max-h-[calc(100vh-260px)] space-y-1.5 overflow-y-auto pr-1">
                      {comparisonGroups.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-[#ded8d0] p-4 text-center text-xs text-[#8a7f72]">
                          No groups configured.
                        </div>
                      ) : (
                        comparisonGroups.map((group) => {
                          const isSelected = selectedGroup?.groupKey === group.groupKey;

                          return (
                            <button
                              key={group.groupKey}
                              className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
                                isSelected
                                  ? "border-[#c8bfb0] bg-[#ede6d9] text-[#2b1a10] shadow-2xs font-medium"
                                  : "border-[#ded8d0] bg-[#fbfaf8] text-[#3d3530] hover:bg-[#f3eee7]"
                              }`}
                              onClick={() => setSelectedGroupKey(group.groupKey)}
                              type="button"
                            >
                              <div className="flex items-center justify-between gap-2.5">
                                <div className="min-w-0">
                                  <div className="truncate text-xs font-semibold">{group.label}</div>
                                  <div className="mt-0.5 text-[11px] font-normal text-[#8a7f72]">
                                    {group.fields.length} field{group.fields.length === 1 ? "" : "s"}
                                  </div>
                                </div>
                                <span
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleUpdateGroup(group.groupKey, {
                                      enabled: !group.enabled,
                                    });
                                  }}
                                >
                                  <SwitchControl checked={group.enabled} />
                                </span>
                              </div>
                            </button>
                          );
                        })
                      )}
                      <button
                        className="w-full rounded-lg border border-dashed border-[#ded8d0] bg-[#fbfaf8] px-3 py-2 text-center text-xs font-medium text-[#5b4b3d] transition hover:border-[#2b1a10] hover:text-[#2b1a10]"
                        onClick={handleAddGroup}
                        type="button"
                      >
                        + Add review group
                      </button>
                    </div>
                  </aside>

                  <main className="min-w-0 flex-1 space-y-4">
                    {/* ── Contextual KPIs for Review Groups ── */}
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-xl border border-[#ded8d0] bg-white p-3.5 shadow-2xs">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a7f72]">
                          Active Groups
                        </div>
                        <div className="mt-1 text-xl font-bold tracking-tight text-[#111827]">
                          {enabledGroupCount} / {comparisonGroups.length}
                        </div>
                        <div className="mt-0.5 text-xs text-[#8a7f72]">
                          Comparison families enabled for mismatch grouping
                        </div>
                      </div>
                      <div className="rounded-xl border border-[#ded8d0] bg-white p-3.5 shadow-2xs">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a7f72]">
                          Grouped Fields
                        </div>
                        <div className="mt-1 text-xl font-bold tracking-tight text-[#111827]">
                          {comparisonGroups.reduce((acc, g) => acc + g.fields.length, 0)} fields
                        </div>
                        <div className="mt-0.5 text-xs text-[#8a7f72]">
                          Total fields mapped across all review families
                        </div>
                      </div>
                    </div>

                    <div className="rounded-xl border border-[#ded8d0] bg-white p-5 shadow-2xs">
                      {loading ? (
                      <div className="space-y-3">
                        <div className="h-16 animate-pulse rounded-xl bg-[#ede6d9]/50" />
                        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                          {Array.from({ length: 12 }).map((_, index) => (
                            <div key={index} className="h-12 animate-pulse rounded-lg bg-[#ede6d9]/50" />
                          ))}
                        </div>
                      </div>
                    ) : selectedGroup ? (
                      <div>
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                          <label className="min-w-0 flex-1">
                            <div className="mb-1.5 text-xs font-bold uppercase tracking-wider text-[#8a7f72]">
                              Group name
                            </div>
                            <input
                              className="h-9 w-full rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 text-sm font-semibold text-[#111827] outline-none transition focus:border-[#2b1a10] focus:bg-white"
                              onChange={(event) =>
                                handleRenameGroup(selectedGroup.groupKey, event.target.value)
                              }
                              value={selectedGroup.label}
                            />
                            <p className="mt-1.5 text-xs text-[#8a7f72]">
                              Reviewers will see these related fields together whenever any one of them shows a mismatch.
                            </p>
                          </label>

                          <div className="flex shrink-0 items-center gap-3 pt-6">
                            <button
                              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                                selectedGroup.enabled
                                  ? "border-[#a7f3d0] bg-[#ecfdf5] text-[#047857]"
                                  : "border-[#fecaca] bg-[#fef2f2] text-[#b91c1c]"
                              }`}
                              onClick={() =>
                                handleUpdateGroup(selectedGroup.groupKey, {
                                  enabled: !selectedGroup.enabled,
                                })
                              }
                              type="button"
                            >
                              {selectedGroup.enabled ? "Group Enabled" : "Group Disabled"}
                            </button>
                            <button
                              className="text-xs font-medium text-[#b91c1c] transition hover:text-[#991b1b]"
                              onClick={() => handleDeleteGroup(selectedGroup.groupKey)}
                              type="button"
                            >
                              Delete
                            </button>
                          </div>
                        </div>

                        <div className="mt-4 rounded-lg border border-[#e8e2d8] bg-[#fbfaf8] p-3">
                          {selectedGroup.fields.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                              {selectedGroup.fields.map((fieldKey) => (
                                <span
                                  key={fieldKey}
                                  className="inline-flex max-w-full items-center truncate rounded-md border border-[#ded8d0] bg-white px-2.5 py-1 text-xs font-medium text-[#2b1a10] shadow-2xs"
                                >
                                  {FIELD_LABELS[fieldKey as FieldKey] ?? fieldKey}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-[#8a7f72]">
                              No fields selected yet. Pick from the list below.
                            </span>
                          )}
                        </div>

                        <section className="mt-5">
                          <div className="mb-3">
                            <h3 className="text-xs font-bold uppercase tracking-wider text-[#8a7f72]">
                              Fields in group
                            </h3>
                            <p className="mt-0.5 text-xs text-[#8a7f72]">
                              Pick every field that should be reviewed as one issue family, across all documents.
                            </p>
                          </div>

                          <div className="relative mb-3 max-w-md">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8a7f72]" />
                            <input
                              className="w-full rounded-lg border border-[#ded8d0] bg-[#fbfaf8] py-1.5 pl-8 pr-3 text-xs text-[#111827] outline-none transition placeholder:text-[#a89e92] focus:border-[#2b1a10] focus:bg-white"
                              onChange={(event) => setGroupFieldSearch(event.target.value)}
                              placeholder="Search fields..."
                              type="search"
                              value={groupFieldSearch}
                            />
                          </div>

                          <div className="max-h-[400px] overflow-y-auto rounded-lg border border-[#ded8d0]">
                            {filteredGroupFieldSections.map((section) => (
                              <div key={section.docType}>
                                <div className="sticky top-0 z-10 border-b border-[#e8e2d8] bg-[#ede6d9]/80 backdrop-blur-xs px-3.5 py-1.5 text-[11px] font-bold tracking-wider text-[#5b4b3d]">
                                  {section.docType}
                                </div>
                                {section.fields.map((fieldKey) => {
                                  const isSelected = selectedGroup.fields.includes(fieldKey);
                                  const otherGroup = comparisonGroups.find(
                                    (group) =>
                                      group.groupKey !== selectedGroup.groupKey &&
                                      group.fields.includes(fieldKey)
                                  );

                                  return (
                                    <button
                                      key={`${section.docType}-${fieldKey}`}
                                      aria-pressed={isSelected}
                                      className="flex w-full items-center gap-3 border-b border-[#f0ece4] px-3.5 py-2 text-left transition hover:bg-[#fbfaf8]"
                                      onClick={() =>
                                        handleToggleGroupField(selectedGroup.groupKey, fieldKey)
                                      }
                                      type="button"
                                    >
                                      <span
                                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition ${
                                          isSelected
                                            ? "border-[#2b1a10] bg-[#2b1a10] text-white"
                                            : "border-[#ded8d0] bg-white text-transparent"
                                        }`}
                                      >
                                        <Check className="h-3 w-3" />
                                      </span>
                                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-[#111827]">
                                        {FIELD_LABELS[fieldKey]}
                                        {otherGroup ? (
                                          <span className="text-[#8a7f72]">
                                            {" "}
                                            — in {otherGroup.label}
                                          </span>
                                        ) : null}
                                      </span>
                                      <span className="shrink-0 font-mono text-[11px] text-[#8a7f72]">
                                        {fieldKey}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                            ))}
                            {filteredGroupFieldSections.length === 0 ? (
                              <div className="px-4 py-8 text-center text-xs text-[#8a7f72]">
                                No fields found.
                              </div>
                            ) : null}
                          </div>
                        </section>
                      </div>
                    ) : (
                      <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-[#ded8d0] bg-[#fbfaf8] text-xs font-medium text-[#8a7f72]">
                        Create a group to start.
                      </div>
                    )}
                    </div>
                  </main>
                </>
              ) : activeTab === "accounting" ? (
                <main className="w-full space-y-4">
                  {/* ── Contextual KPIs for Purchase Accounting ── */}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-[#ded8d0] bg-white p-3.5 shadow-2xs">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a7f72]">
                        Deductions Handled
                      </div>
                      <div className="mt-1 text-xl font-bold tracking-tight text-[#111827]">
                        {[
                          purchaseAccountingSettings.purchaseGoodsTdsEnabled,
                          purchaseAccountingSettings.transporterTdsEnabled,
                          purchaseAccountingSettings.gstTdsEnabled,
                        ].filter(Boolean).length} / 3 Active
                      </div>
                      <div className="mt-0.5 text-xs text-[#8a7f72]">
                        Goods TDS, Transporter TDS & GST TDS rules
                      </div>
                    </div>
                    <div className="rounded-xl border border-[#ded8d0] bg-white p-3.5 shadow-2xs">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a7f72]">
                        Validation Policies
                      </div>
                      <div className="mt-1 text-xl font-bold tracking-tight text-[#111827]">
                        {Object.values(purchaseAccountingSettings.validationPolicy).filter((s) => s === "block").length} Blocking · {Object.values(purchaseAccountingSettings.validationPolicy).filter((s) => s === "warn").length} Warning
                      </div>
                      <div className="mt-0.5 text-xs text-[#8a7f72]">
                        Purchase voucher validation criteria
                      </div>
                    </div>
                  </div>

                  <section className="rounded-xl border border-[#ded8d0] bg-white p-5 shadow-2xs">
                    <div className="max-w-3xl">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-[#8a7f72]">
                        Purchase voucher deductions
                      </p>
                      <h2 className="mt-1 text-base font-bold tracking-tight text-[#111827]">
                        Choose which deductions Bhuleshwar should handle
                      </h2>
                      <p className="mt-1 text-xs text-[#5b4b3d]">
                        Leave a rule off when your business does not use it.
                      </p>
                    </div>

                    <div className="mt-4 divide-y divide-[#f0ece4] rounded-lg border border-[#ded8d0]">
                      {[
                        {
                          key: "purchaseGoodsTdsEnabled" as const,
                          label: "Purchase TDS on goods",
                          description: "Applies 0.1% Section 194Q on the reviewer-confirmed basis. One invoice cannot prove annual eligibility.",
                        },
                        {
                          key: "transporterTdsEnabled" as const,
                          label: "Transporter TDS",
                          description: "Posts transporter TDS to the TDS ledger. Freight is included only when billed on the invoice.",
                        },
                        {
                          key: "gstTdsEnabled" as const,
                          label: "GST TDS, including metal scrap",
                          description: "Withholds 2% GST TDS on qualifying MS scrap purchases (from 10 Oct 2024). Other cases stay invoice-confirmed.",
                        },
                      ].map((rule) => {
                        const enabled = purchaseAccountingSettings[rule.key];
                        return (
                          <button
                            aria-pressed={enabled}
                            className={`flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition ${
                              enabled ? "bg-[#fdfcfa]" : "hover:bg-[#fbfaf8]"
                            }`}
                            key={rule.key}
                            onClick={() => handleTogglePurchaseAccountingRule(rule.key)}
                            type="button"
                          >
                            <span className="min-w-0">
                              <span className="block text-xs font-semibold text-[#111827]">{rule.label}</span>
                              <span className="mt-0.5 block text-xs leading-5 text-[#6b5d50]">{rule.description}</span>
                            </span>
                            <span className="flex shrink-0 items-center gap-2">
                              <span className={`text-xs font-medium ${enabled ? "text-[#047857]" : "text-[#8a7f72]"}`}>
                                {enabled ? "On" : "Off"}
                              </span>
                              <SwitchControl checked={enabled} />
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                  <section className="overflow-hidden rounded-xl border border-[#ded8d0] bg-white shadow-2xs">
                    <div className="flex flex-col gap-2 border-b border-[#f0ece4] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-[11px] font-bold uppercase tracking-wider text-[#8a7f72]">Validation policy</p>
                        <h2 className="mt-1 text-base font-bold tracking-tight text-[#111827]">Set blocking and warning rules</h2>
                      </div>
                      <div className="flex items-center gap-4 text-xs font-medium text-[#746d63]" aria-label="Validation severity legend">
                        <span className="inline-flex items-center"><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-rose-500" />Block</span>
                        <span className="inline-flex items-center"><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-amber-400" />Warn</span>
                        <span className="inline-flex items-center"><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-slate-300" />Off</span>
                      </div>
                    </div>
                    <div className="divide-y divide-[#f0ece4]">
                      {PURCHASE_VALIDATION_GROUPS.map((group) => (
                        <div className="grid gap-2 px-5 py-3.5 lg:grid-cols-[160px_1fr]" key={group.title}>
                          <h3 className="pt-2 text-xs font-bold text-[#5b4b3d]">{group.title}</h3>
                          <div className="divide-y divide-[#f5f1eb]">
                            {group.rules.map(([key, label, description]) => {
                              const selected = purchaseAccountingSettings.validationPolicy[key];
                              return (
                                <div className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between" key={key}>
                                  <div className="min-w-0 pr-3">
                                    <p className="text-xs font-semibold text-[#111827]">{label}</p>
                                    <p className="mt-0.5 text-xs text-[#8a7f72]">{description}</p>
                                  </div>
                                  <div className="grid shrink-0 grid-cols-3 rounded-lg border border-[#e0d8cc] bg-[#ede6d9]/60 p-0.5" role="group" aria-label={`${label} severity`}>
                                    {(["block", "warn", "off"] as const).map((severity) => (
                                      <button
                                        aria-pressed={selected === severity}
                                        className={`min-w-[56px] rounded-md px-2 py-1 text-xs font-semibold capitalize transition ${
                                          selected === severity
                                            ? severity === "block"
                                              ? "bg-white text-rose-700 shadow-2xs"
                                              : severity === "warn"
                                                ? "bg-white text-amber-700 shadow-2xs"
                                                : "bg-white text-slate-700 shadow-2xs"
                                            : "text-[#8a7f72] hover:text-[#111827]"
                                        }`}
                                        key={severity}
                                        onClick={() => handleSetPurchaseValidationSeverity(key, severity)}
                                        type="button"
                                      >
                                        {severity}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="border-t border-[#f0ece4] bg-[#fbfaf8] px-5 py-2.5 text-xs text-[#8a7f72]">
                      Accounting integrity checks—balanced totals, valid dates, and required posting ledgers—always block and cannot be disabled.
                    </p>
                  </section>
                  <PurchasePostingDefaultsSettings />
                </main>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
