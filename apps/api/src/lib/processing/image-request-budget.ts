export const IMAGE_REQUEST_BUDGET_BYTES = 12 * 1024 * 1024;
export const IMAGE_REQUEST_MAX_PAGES = 4;

export function imageDataBytes(image: string): number {
  const comma = image.indexOf(",");
  if (!image.startsWith("data:image/") || comma < 0) {
    throw new Error("Packet page images must use local data URLs for size validation.");
  }
  const data = image.slice(comma + 1);
  return Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

export function isImageSizeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /Downloaded image content cannot exceed|image.*(?:too large|size limit|above the .*provider limit)|packet image request exceeds|payload.too.large|request (?:body|entity).*too large/i.test(message);
}

// One shared boundary page lets document grouping see continuations without
// ever sending the entire packet in one request.
export function planImageBatches(images: string[], pageCount = images.length) {
  const batches: Array<{ start: number; end: number; bytes: number }> = [];
  let start = 0;
  while (start < pageCount) {
    let end = start;
    let bytes = 0;
    while (end < pageCount && end - start < IMAGE_REQUEST_MAX_PAGES) {
      const nextBytes = images[end] ? imageDataBytes(images[end]) : 0;
      if (nextBytes > IMAGE_REQUEST_BUDGET_BYTES) {
        throw new Error("Packet image request exceeds the safe image budget for a single page.");
      }
      if (end > start && bytes + nextBytes > IMAGE_REQUEST_BUDGET_BYTES) break;
      bytes += nextBytes;
      end++;
    }
    batches.push({ start, end, bytes });
    if (end === pageCount) break;
    start = end - start > 1 ? end - 1 : end;
  }
  return batches;
}

type Group = {
  documentType: string; pageStart: number; pageEnd: number;
  documentNumber?: string; primaryPartyName?: string; vehicleNumber?: string;
};
const identity = (value?: string) => value?.toUpperCase().replace(/[^A-Z0-9]/g, "") || "";

export function mergeOverlappingPageGroups<T extends Group>(groups: T[]): T[] {
  const result: T[] = [];
  for (const group of [...groups].sort((a, b) => a.pageStart - b.pageStart || a.pageEnd - b.pageEnd)) {
    const match = result.find((previous) => {
      if (previous.documentType !== group.documentType) return false;
      const keys = ["documentNumber", "primaryPartyName", "vehicleNumber"] as const;
      if (keys.some((key) => identity(previous[key]) && identity(group[key]) && identity(previous[key]) !== identity(group[key]))) return false;
      const overlaps = previous.pageStart <= group.pageEnd && group.pageStart <= previous.pageEnd;
      const sameDocument = identity(previous.documentNumber) && identity(previous.documentNumber) === identity(group.documentNumber);
      return overlaps || Boolean(sameDocument && previous.pageEnd + 1 === group.pageStart);
    });
    if (match) {
      match.pageEnd = Math.max(match.pageEnd, group.pageEnd);
      for (const key of ["documentNumber", "primaryPartyName", "vehicleNumber"] as const) {
        if (!match[key] && group[key]) match[key] = group[key];
      }
    } else result.push({ ...group });
  }
  return result;
}

export async function runWithImageSizeFallback<T>(
  start: number, end: number, run: (start: number, end: number) => Promise<T[]>,
): Promise<T[]> {
  try { return await run(start, end); }
  catch (error) {
    if (!isImageSizeError(error) || end - start <= 1) throw error;
    const middle = start + Math.ceil((end - start) / 2);
    const left = await runWithImageSizeFallback(start, middle, run);
    const right = await runWithImageSizeFallback(end - start > 2 ? middle - 1 : middle, end, run);
    return [...left, ...right];
  }
}
