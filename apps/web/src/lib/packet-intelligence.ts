export type PacketIntelligenceKind =
  | "single_shipment"
  | "duplicate_document_copies"
  | "duplicate_upload"
  | "multi_shipment_same_company"
  | "multi_shipment_different_companies"
  | "seller_chain"
  | "needs_review";

export type PacketIntelligenceTone = "neutral" | "success" | "warning" | "danger";
export type PacketIntelligenceConfidence = "high" | "medium" | "low";

export type PacketIntelligenceSignal = {
  label: string;
  value: string;
  tone?: PacketIntelligenceTone;
};

export type PacketIntelligenceCheck = {
  key: string;
  label: string;
  status: "clear" | "attention" | "blocked";
  detail: string;
  documentIds?: string[];
};

export type PacketCopyGroup = {
  key: string;
  label: string;
  documentType: string;
  keptDocumentId: string;
  documentIds: string[];
  sourceLabels: string[];
};

export type PacketShipmentGroup = {
  key: string;
  label: string;
  company: string | null;
  invoiceNumber: string | null;
  buyerName: string | null;
  supplierName: string | null;
  documentIds: string[];
  role: "primary" | "context" | "split_candidate";
  reason: string;
};

export type PacketDuplicateReference = {
  id: string;
  displayName: string;
  status: string;
  createdAt: string;
};

export type PacketIntelligence = {
  kind: PacketIntelligenceKind;
  label: string;
  tone: PacketIntelligenceTone;
  confidence: PacketIntelligenceConfidence;
  summary: string;
  recommendedAction: string;
  primaryDocumentIds: string[];
  contextDocumentIds: string[];
  collapsedCopyGroups: PacketCopyGroup[];
  shipmentGroups: PacketShipmentGroup[];
  duplicateCases: PacketDuplicateReference[];
  checks: PacketIntelligenceCheck[];
  signals: PacketIntelligenceSignal[];
};
