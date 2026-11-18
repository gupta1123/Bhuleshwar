// Planning for "Separate cases" uploads: which queued files go into which case.
// Files are grouped automatically when their names share a document number
// (INV-4471.pdf + DC-4471.pdf); the user can undo a group or move a file.

export type BatchUpload = { id: string; name: string };

export type BatchCasePlan = {
  key: string;
  uploadIds: string[];
  /** The shared number that grouped these files, when grouping was automatic. */
  token: string | null;
  /** True when the user moved at least one file into this case. */
  manual: boolean;
};

export type BatchPlanAdjustments = {
  /** Numbers the user ungrouped. */
  undone: string[];
  /** uploadId -> uploadId of the case it was moved to (itself = its own case). */
  moves: Record<string, string>;
};

// Phone, scanner and messenger names carry dates and counters, not document numbers.
const GENERATED_NAME = /^(img|pxl|dsc|dcim|scan|scanned|camscanner|whatsapp|screenshot|photo|image|doc|document|page)(?![a-z])/i;
const MAX_GROUP_SIZE = 6;

function stem(name: string) {
  return name.replace(/\.[a-z0-9]{2,5}$/i, "").trim();
}

function looksLikeDateOrYear(token: string) {
  if (/^(19|20)\d{2}$/.test(token)) return true;
  if (token.length === 8 && /^(19|20)\d{6}$/.test(token)) return true;
  if (token.length === 8 && /^\d{4}(19|20)\d{2}$/.test(token)) return true;
  return token.length === 6 && /^\d{6}$/.test(token) && Number(token.slice(2, 4)) <= 12 && Number(token.slice(0, 2)) <= 31;
}

/** Document numbers found in a file name: digit runs of 3 to 12 characters, dates and years left out. */
export function fileNameNumbers(name: string): string[] {
  const base = stem(name);
  if (GENERATED_NAME.test(base)) return [];
  const runs = base.match(/\d+/g) ?? [];
  return [...new Set(runs.map((run) => run.replace(/^0+(?=\d{3})/, "")))].filter(
    (run) => run.length >= 3 && run.length <= 12 && !looksLikeDateOrYear(run)
  );
}

export function planBatchCases(uploads: BatchUpload[], adjustments: BatchPlanAdjustments): BatchCasePlan[] {
  const undone = new Set(adjustments.undone);
  const known = new Set(uploads.map((upload) => upload.id));
  const numbers = new Map(uploads.map((upload) => [upload.id, fileNameNumbers(upload.name)]));

  // A number groups files only when 2 to MAX_GROUP_SIZE files share it.
  const holders = new Map<string, string[]>();
  for (const upload of uploads) {
    if (adjustments.moves[upload.id]) continue;
    for (const token of numbers.get(upload.id) ?? []) {
      if (undone.has(token)) continue;
      holders.set(token, [...(holders.get(token) ?? []), upload.id]);
    }
  }

  const autoKey = new Map<string, string>();
  const autoToken = new Map<string, string>();
  for (const upload of uploads) {
    if (adjustments.moves[upload.id]) continue;
    const token = (numbers.get(upload.id) ?? []).find((value) => {
      const count = holders.get(value)?.length ?? 0;
      return count >= 2 && count <= MAX_GROUP_SIZE;
    });
    if (token) {
      autoKey.set(upload.id, `number:${token}`);
      autoToken.set(`number:${token}`, token);
    }
  }

  const keyOf = (id: string, depth = 0): string => {
    const target = adjustments.moves[id];
    if (!target || !known.has(target) || depth > uploads.length) return autoKey.get(id) ?? `file:${id}`;
    if (target === id) return `file:${id}`;
    return keyOf(target, depth + 1);
  };

  const plans = new Map<string, BatchCasePlan>();
  for (const upload of uploads) {
    const key = keyOf(upload.id);
    const plan = plans.get(key) ?? { key, uploadIds: [], token: autoToken.get(key) ?? null, manual: false };
    plan.uploadIds.push(upload.id);
    if (adjustments.moves[upload.id] && adjustments.moves[upload.id] !== upload.id) plan.manual = true;
    plans.set(key, plan);
  }
  return [...plans.values()];
}

export type BatchRowState =
  | "waiting"
  | "uploading"
  | "queued"
  | "running"
  | "ready"
  | "failed"
  | "duplicate";

/** Display order on the tracker: what needs the user first, then finished work, then work in flight. */
export function batchStateRank(state: BatchRowState) {
  return { failed: 0, duplicate: 0, ready: 1, running: 2, uploading: 2, queued: 3, waiting: 3 }[state];
}
