"use client";

import React, { useMemo } from "react";
import { FIELD_SECTION_ORDER, getFieldSection, type FieldSectionKey } from "@/lib/field-sections";
import styles from "@/components/cases/CaseDetailPage.module.css";

export type ExtractedFieldItem = {
  key: string;
  label: string;
  value: string;
  hasMismatch?: boolean;
};

export type ExtractedFieldsPanelProps = {
  fields: ExtractedFieldItem[];
  lineItemCount: number;
  activeComparisonFieldKey: string | null;
  onCompareField: (field: { key: string; label: string }) => void;
  activeDataView: "fields" | "lineItems" | "terms";
  onDataViewChange: (view: "fields" | "lineItems" | "terms") => void;
  termsCount?: number;
  lineItemsContent?: React.ReactNode;
  termsContent?: React.ReactNode;
  hasFailureState?: boolean;
};

export function ExtractedFieldsPanel({
  fields,
  lineItemCount,
  activeComparisonFieldKey,
  onCompareField,
  activeDataView,
  onDataViewChange,
  termsCount = 0,
  lineItemsContent,
  termsContent,
  hasFailureState = false,
}: ExtractedFieldsPanelProps) {
  // Group fields by section
  const groupedSections = useMemo(() => {
    const map = new Map<FieldSectionKey, ExtractedFieldItem[]>();

    for (const field of fields) {
      const section = getFieldSection(field.key);
      const existing = map.get(section) || [];
      existing.push(field);
      map.set(section, existing);
    }

    return FIELD_SECTION_ORDER.map((section) => ({
      section,
      fields: map.get(section) || [],
    })).filter((group) => group.fields.length > 0);
  }, [fields]);

  const hasAnyCheckMismatch = useMemo(() => {
    return fields.some((f) => getFieldSection(f.key) === "CHECKS" && f.hasMismatch) || hasFailureState;
  }, [fields, hasFailureState]);

  return (
    <div className={styles.splitDataPaneRoot}>
      {/* ── Header ── */}
      <div className={styles.splitDataHeader}>
        <h2 className={styles.splitDataTitle}>Extracted data</h2>

        {/* ── Optional View Tabs (if line items or terms exist) ── */}
        {(lineItemCount > 0 || termsCount > 0) && (
          <div className={styles.splitDataTabs}>
            <button
              type="button"
              className={activeDataView === "fields" ? styles.splitDataTabActive : styles.splitDataTab}
              onClick={() => onDataViewChange("fields")}
            >
              Fields ({fields.length})
            </button>
            {lineItemCount > 0 && (
              <button
                type="button"
                className={activeDataView === "lineItems" ? styles.splitDataTabActive : styles.splitDataTab}
                onClick={() => onDataViewChange("lineItems")}
              >
                Line items ({lineItemCount})
              </button>
            )}
            {termsCount > 0 && (
              <button
                type="button"
                className={activeDataView === "terms" ? styles.splitDataTabActive : styles.splitDataTab}
                onClick={() => onDataViewChange("terms")}
              >
                PO terms ({termsCount})
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Main Scrollable Body ── */}
      <div className={styles.splitDataScroll}>
        {activeDataView === "fields" ? (
          groupedSections.length > 0 ? (
            groupedSections.map(({ section, fields: sectionFields }) => {
              const isChecks = section === "CHECKS";
              return (
                <section key={section} className={styles.splitSection}>
                  <div className={styles.splitSectionHeader}>
                    <span className={styles.splitSectionTitle}>{section}</span>
                    {isChecks && hasAnyCheckMismatch ? (
                      <span className={styles.splitFailureState}>Failure state</span>
                    ) : null}
                  </div>

                  <div className={styles.splitFieldList}>
                    {sectionFields.map((field) => {
                      const isComparisonActive = activeComparisonFieldKey === field.key;
                      const isFalseCheck =
                        isChecks &&
                        (field.value.toLowerCase() === "no" || field.value.toLowerCase() === "false");

                      return (
                        <div
                          key={field.key}
                          className={`${styles.splitFieldItem} ${
                            isComparisonActive ? styles.splitFieldItemComparisonActive : ""
                          }`}
                          data-document-comparison-trigger={field.key}
                          onClick={() => onCompareField({ key: field.key, label: field.label })}
                          tabIndex={0}
                          role="button"
                          aria-pressed={isComparisonActive}
                          aria-label={`Compare ${field.label} across documents`}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onCompareField({ key: field.key, label: field.label });
                            }
                          }}
                        >
                          <div className={styles.splitFieldTopRow}>
                            <span className={styles.splitFieldLabel}>{field.label}</span>
                            {field.hasMismatch ? (
                              <span className={styles.badgeMismatch}>mismatch</span>
                            ) : isFalseCheck ? (
                              <span className={styles.badgeNeutral}>not detected</span>
                            ) : (
                              <span
                                className={styles.badgeCrossChecked}
                                aria-label="Cross-checked"
                                title="Cross-checked"
                              >
                                ✓
                              </span>
                            )}
                          </div>
                          <div className={styles.splitFieldValue}>
                            {field.value || "Not detected"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })
          ) : (
            <div className={styles.redesignDataEmpty}>
              No scalar fields were extracted for this document.
            </div>
          )
        ) : activeDataView === "lineItems" ? (
          lineItemsContent
        ) : (
          termsContent
        )}
      </div>
    </div>
  );
}
