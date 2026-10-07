export type MismatchResolutionStatus = "pending" | "accepted" | "rejected";

export function isMismatchResolutionSchemaMissing(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : "";
  const message = [
    record.message,
    record.error,
    record.details,
    record.hint,
    record.error_description,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");

  const mentionsResolutionColumns = /resolution_status|resolved_at/i.test(message);
  const isMissingColumnError =
    /schema cache|could not find|column .* does not exist|42703|PGRST/i.test(`${code} ${message}`);

  return mentionsResolutionColumns && isMissingColumnError;
}

export function getCaseStatusForMismatchResolutions(
  statuses: readonly MismatchResolutionStatus[]
) {
  return statuses.length > 0 && statuses.every((status) => status === "accepted")
    ? "accepted"
    : "completed";
}

export function getMismatchResolutionStatusForCaseDecision(
  decision: "accept" | "reject"
): MismatchResolutionStatus {
  return decision === "accept" ? "accepted" : "rejected";
}
