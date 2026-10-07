import {
  shouldConsiderFieldKey,
  type PacketFieldConfiguration,
} from "@/lib/document-schema";
import { readStoredLineItems } from "@/lib/line-items";
import type { CaseDoc, FieldKey } from "@/types/pipeline";

type PersistedDocumentRow = {
  client_document_id: string | null;
  source_file_name: string | null;
  source_hint: string | null;
  document_type: string;
  title: string | null;
  extracted_fields: unknown;
};

const STRUCTURED_FIELD_KEYS_TO_PRESERVE: FieldKey[] = ["tollTransactionSummary"];

function normalizeIdentity(value?: string | null) {
  return value?.trim().toLowerCase() || null;
}

function toFieldRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function hasMeaningfulValue(value: unknown) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function documentMatchesPersistedRow(document: CaseDoc, row: PersistedDocumentRow) {
  if (document.type !== row.document_type) {
    return false;
  }

  const documentId = normalizeIdentity(document.id);
  const rowClientId = normalizeIdentity(row.client_document_id);
  if (documentId && rowClientId && documentId === rowClientId) {
    return true;
  }

  const documentSourceFileName = normalizeIdentity(document.sourceFileName);
  const rowSourceFileName = normalizeIdentity(row.source_file_name);
  const documentSourceHint = normalizeIdentity(document.sourceHint);
  const rowSourceHint = normalizeIdentity(row.source_hint);
  const documentTitle = normalizeIdentity(document.title);
  const rowTitle = normalizeIdentity(row.title);

  if (documentSourceHint && rowSourceHint && documentSourceHint === rowSourceHint) {
    return true;
  }

  if (
    documentSourceFileName &&
    rowSourceFileName &&
    documentSourceFileName === rowSourceFileName &&
    ((documentTitle && rowTitle && documentTitle === rowTitle) ||
      (documentSourceHint && rowSourceHint && documentSourceHint === rowSourceHint))
  ) {
    return true;
  }

  return Boolean(documentTitle && rowTitle && documentTitle === rowTitle);
}

function findPersistedDocument(document: CaseDoc, rows: PersistedDocumentRow[]) {
  return rows.find((row) => documentMatchesPersistedRow(document, row));
}

function mergeStructuredFields(
  document: CaseDoc,
  row: PersistedDocumentRow,
  fieldConfiguration?: PacketFieldConfiguration
) {
  const persistedFields = toFieldRecord(row.extracted_fields);
  const fields = { ...(document.fields ?? {}) } as Record<string, unknown>;

  for (const key of STRUCTURED_FIELD_KEYS_TO_PRESERVE) {
    if (
      fieldConfiguration &&
      !shouldConsiderFieldKey(key, document.type, fieldConfiguration)
    ) {
      continue;
    }

    if (hasMeaningfulValue(fields[key])) {
      continue;
    }

    const persistedValue = persistedFields[key];
    if (hasMeaningfulValue(persistedValue)) {
      fields[key] = persistedValue;
    }
  }

  return fields as CaseDoc["fields"];
}

export function mergePersistedStructuredData(
  documents: CaseDoc[],
  persistedRows: PersistedDocumentRow[],
  fieldConfiguration?: PacketFieldConfiguration
): CaseDoc[] {
  if (!persistedRows.length) {
    return documents;
  }

  return documents.map((document) => {
    const persistedDocument = findPersistedDocument(document, persistedRows);
    if (!persistedDocument) {
      return document;
    }

    const currentLineItems = document.lineItems ?? [];
    const persistedLineItems = readStoredLineItems(persistedDocument.extracted_fields);
    const lineItems = currentLineItems.length > 0 ? currentLineItems : persistedLineItems;

    return {
      ...document,
      fields: mergeStructuredFields(document, persistedDocument, fieldConfiguration),
      lineItems,
    };
  });
}
