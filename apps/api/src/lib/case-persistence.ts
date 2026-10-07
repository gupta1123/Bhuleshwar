import type { CaseDoc, ComparisonOptions, Mismatch, QueuedUpload } from "@/types/pipeline";
import { getQueuedUploadFiles, serializeQueuedUploadGroups } from "@/lib/upload-groups";

export type SavedCaseRecord = {
  id: string;
  slug: string;
  displayName: string;
  buyerName: string | null;
  receiverName: string | null;
  category: string;
  poNumber: string | null;
  invoiceNumber: string | null;
  status: string;
  riskScore: number;
  uploadCount: number;
  documentCount: number;
  mismatchCount: number;
  createdAt: string;
  deletedAt: string | null;
};

export type SavedCaseFile = {
  id: string;
  originalName: string;
  storageBucket: string;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
  signedUrl: string | null;
};

export type SavedCaseDocument = {
  id: string;
  clientDocumentId: string | null;
  sourceFileName: string | null;
  sourceHint: string | null;
  documentType: string;
  title: string;
  pageCount: number;
  extractedFields: Record<string, unknown>;
  markdown: string;
  createdAt: string;
};

export type SavedCaseMismatch = {
  id: string;
  clientMismatchId: string | null;
  fieldName: string;
  values: Array<{ docId?: string; value?: string | number | null }>;
  analysis: string | null;
  fixPlan: string | null;
  createdAt: string;
};

export type SavedCaseDetail = {
  case: SavedCaseRecord & {
    processingMeta?: Record<string, unknown>;
  };
  files: SavedCaseFile[];
  documents: SavedCaseDocument[];
  mismatches: SavedCaseMismatch[];
};

type CreateCaseResponse = {
  case: SavedCaseRecord;
};

type RecentCasesResponse = {
  cases: SavedCaseRecord[];
};

type CaseDetailResponse = SavedCaseDetail;
export type CaseListScope = "active" | "deleted";
export type CaseDecision = "accepted" | "rejected";

const AUTH_SESSION_ERROR =
  "Your session is not active on this device. Sign in again to continue.";

class ApiRequestError extends Error {
  status?: number;
  isAuthError: boolean;

  constructor(message: string, options?: { status?: number; isAuthError?: boolean }) {
    super(message);
    this.name = "ApiRequestError";
    this.status = options?.status;
    this.isAuthError = Boolean(options?.isAuthError);
  }
}

function appendUploadsToFormData(formData: FormData, uploads: QueuedUpload[]) {
  const uploadGroups = serializeQueuedUploadGroups(uploads);

  if (uploadGroups.length) {
    formData.set("uploadGroups", JSON.stringify(uploadGroups));
  }

  for (const upload of uploads) {
    for (const file of getQueuedUploadFiles(upload)) {
      formData.append("files", file, file.name || upload.name);
    }
  }
}

async function readApiResponse<T>(response: Response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const payload = (await response.json().catch(() => ({}))) as Partial<T> & {
      error?: unknown;
    };

    return {
      payload,
      rawText: "",
    };
  }

  return {
    payload: {} as Partial<T> & { error?: unknown },
    rawText: await response.text().catch(() => ""),
  };
}

async function performApiFetch(input: RequestInfo | URL, init?: RequestInit) {
  try {
    return await fetch(input, init);
  } catch {
    throw new ApiRequestError(
      "Unable to reach the server. Check your connection and try again."
    );
  }
}

function isAuthErrorPayload(payload: unknown, status?: number) {
  if (status === 401 || status === 403) {
    return true;
  }

  if (!payload || typeof payload !== "object") {
    return false;
  }

  const errorValue = (payload as { error?: unknown }).error;

  if (typeof errorValue === "string") {
    return /unauthorized|forbidden|session|auth/i.test(errorValue);
  }

  if (errorValue && typeof errorValue === "object") {
    const record = errorValue as Record<string, unknown>;
    const combined = [record.message, record.details, record.hint]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" ");

    return /unauthorized|forbidden|session|auth/i.test(combined);
  }

  return false;
}

function redirectToLogin(message: string) {
  if (typeof window === "undefined") {
    return;
  }

  const loginUrl = new URL("/login", window.location.origin);
  const next = `${window.location.pathname}${window.location.search}`;

  if (next && next !== "/login") {
    loginUrl.searchParams.set("next", next);
  }

  loginUrl.searchParams.set("message", message);
  window.location.assign(loginUrl.toString());
}

function extractApiError(
  payload: unknown,
  fallback: string,
  options?: { status?: number; rawText?: string }
) {
  if (isAuthErrorPayload(payload, options?.status)) {
    return AUTH_SESSION_ERROR;
  }

  if (!payload || typeof payload !== "object") {
    const rawText = options?.rawText?.trim() || "";

    if (
      options?.status === 413 ||
      /payload|request entity too large|body exceeded|content length/i.test(rawText)
    ) {
      return "Selected image is too large to upload. Try again after using a smaller image or fewer pages.";
    }

    return fallback;
  }

  const errorValue = (payload as { error?: unknown }).error;
  if (typeof errorValue === "string" && errorValue.trim().length > 0) {
    return errorValue;
  }

  if (errorValue && typeof errorValue === "object") {
    const record = errorValue as Record<string, unknown>;
    const parts = [record.message, record.details, record.hint]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);

    if (parts.length > 0) {
      return parts.join(" ");
    }
  }

  if (
    options?.status === 413 ||
    /payload|request entity too large|body exceeded|content length/i.test(options?.rawText || "")
  ) {
    return "Selected image is too large to upload. Try again after using a smaller image or fewer pages.";
  }

  return fallback;
}

function toApiRequestError(
  payload: unknown,
  fallback: string,
  options?: { status?: number; rawText?: string }
) {
  const isAuthError = isAuthErrorPayload(payload, options?.status);
  const message = extractApiError(payload, fallback, options);

  if (isAuthError) {
    redirectToLogin(message);
  }

  return new ApiRequestError(message, {
    status: options?.status,
    isAuthError,
  });
}

export async function persistProcessedCase(params: {
  uploads: QueuedUpload[];
  documents: CaseDoc[];
  mismatches: Mismatch[];
  comparisonOptions?: ComparisonOptions;
}): Promise<CreateCaseResponse> {
  const formData = new FormData();
  formData.set("documents", JSON.stringify(params.documents));
  formData.set("mismatches", JSON.stringify(params.mismatches));
  if (params.comparisonOptions) {
    formData.set("comparisonOptions", JSON.stringify(params.comparisonOptions));
  }

  appendUploadsToFormData(formData, params.uploads);

  const response = await performApiFetch("/api/cases", {
    method: "POST",
    body: formData,
  });

  const { payload, rawText } = await readApiResponse<CreateCaseResponse>(response);

  if (!response.ok || !payload.case) {
    throw toApiRequestError(payload, "Failed to save processed case to Supabase.", {
      status: response.status,
      rawText,
    });
  }

  return { case: payload.case };
}

export async function createDraftCase(params: {
  uploads: QueuedUpload[];
}): Promise<CreateCaseResponse> {
  const formData = new FormData();
  formData.set("mode", "draft");

  appendUploadsToFormData(formData, params.uploads);

  const response = await performApiFetch("/api/cases", {
    method: "POST",
    body: formData,
  });

  const { payload, rawText } = await readApiResponse<CreateCaseResponse>(response);

  if (!response.ok || !payload.case) {
    throw toApiRequestError(payload, "Failed to create draft case.", {
      status: response.status,
      rawText,
    });
  }

  return { case: payload.case };
}

export async function appendCaseFiles(
  caseId: string,
  uploads: QueuedUpload[],
  mode: "append" | "overwrite" = "append"
): Promise<CreateCaseResponse> {
  const formData = new FormData();
  formData.set("mode", mode);

  appendUploadsToFormData(formData, uploads);

  const response = await performApiFetch(`/api/cases/${caseId}/files`, {
    method: "POST",
    body: formData,
  });

  const { payload, rawText } = await readApiResponse<CreateCaseResponse>(response);

  if (!response.ok || !payload.case) {
    throw toApiRequestError(payload, "Failed to add files to case.", {
      status: response.status,
      rawText,
    });
  }

  return { case: payload.case };
}

export async function saveCaseAnalysis(
  caseId: string,
  params: {
    documents: CaseDoc[];
    mismatches: Mismatch[];
    comparisonOptions?: ComparisonOptions;
  }
): Promise<CreateCaseResponse> {
  const formData = new FormData();
  formData.set("documents", JSON.stringify(params.documents));
  formData.set("mismatches", JSON.stringify(params.mismatches));
  if (params.comparisonOptions) {
    formData.set("comparisonOptions", JSON.stringify(params.comparisonOptions));
  }

  const response = await performApiFetch(`/api/cases/${caseId}/analysis`, {
    method: "POST",
    body: formData,
  });

  const { payload, rawText } = await readApiResponse<CreateCaseResponse>(response);

  if (!response.ok || !payload.case) {
    throw toApiRequestError(payload, "Failed to save case analysis.", {
      status: response.status,
      rawText,
    });
  }

  return { case: payload.case };
}

export async function fetchRecentCases(limit = 12): Promise<RecentCasesResponse> {
  const query = new URLSearchParams();
  query.set("limit", String(limit));
  query.set("scope", "active");

  const response = await performApiFetch(`/api/cases?${query.toString()}`, {
    cache: "no-store",
  });
  const { payload, rawText } = await readApiResponse<RecentCasesResponse>(response);

  if (!response.ok || !Array.isArray(payload.cases)) {
    throw toApiRequestError(payload, "Failed to load saved cases.", {
      status: response.status,
      rawText,
    });
  }

  return { cases: payload.cases };
}

export async function fetchCasesByScope(
  scope: CaseListScope,
  limit = 100
): Promise<RecentCasesResponse> {
  const query = new URLSearchParams();
  query.set("limit", String(limit));
  query.set("scope", scope);

  const response = await performApiFetch(`/api/cases?${query.toString()}`, {
    cache: "no-store",
  });
  const { payload, rawText } = await readApiResponse<RecentCasesResponse>(response);

  if (!response.ok || !Array.isArray(payload.cases)) {
    throw toApiRequestError(payload, "Failed to load saved cases.", {
      status: response.status,
      rawText,
    });
  }

  return { cases: payload.cases };
}

async function mutateCase(
  caseId: string,
  init: RequestInit,
  fallback: string,
  path = `/api/cases/${caseId}`
): Promise<{ case: SavedCaseRecord }> {
  const response = await performApiFetch(path, init);
  const { payload, rawText } = await readApiResponse<CreateCaseResponse>(response);

  if (!response.ok || !payload.case) {
    throw toApiRequestError(payload, fallback, {
      status: response.status,
      rawText,
    });
  }

  return { case: payload.case };
}

export async function recycleCase(caseId: string) {
  return mutateCase(
    caseId,
    { method: "DELETE" },
    "Failed to move case to the recycle bin."
  );
}

export async function restoreCase(caseId: string) {
  return mutateCase(
    caseId,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore" }),
    },
    "Failed to restore case from the recycle bin."
  );
}

export async function updateCaseDecision(caseId: string, decision: CaseDecision) {
  return mutateCase(
    caseId,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: decision === "accepted" ? "accept" : "reject" }),
    },
    `Failed to ${decision === "accepted" ? "accept" : "reject"} case.`
  );
}

export async function deleteCaseForever(caseId: string) {
  return mutateCase(
    caseId,
    { method: "DELETE" },
    "Failed to permanently delete case.",
    `/api/cases/${caseId}?mode=hard`
  );
}

export async function fetchCaseDetail(caseId: string): Promise<CaseDetailResponse> {
  const response = await performApiFetch(`/api/cases/${caseId}`, { cache: "no-store" });
  const { payload, rawText } = await readApiResponse<CaseDetailResponse>(response);

  if (
    !response.ok ||
    !payload.case ||
    !Array.isArray(payload.files) ||
    !Array.isArray(payload.documents) ||
    !Array.isArray(payload.mismatches)
  ) {
    throw toApiRequestError(payload, "Failed to load case details.", {
      status: response.status,
      rawText,
    });
  }

  return {
    case: payload.case,
    files: payload.files,
    documents: payload.documents,
    mismatches: payload.mismatches,
  };
}
