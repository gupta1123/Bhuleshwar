import type { QueuedUpload } from "@/types/pipeline";

export const CAMERA_SCAN_SOURCE = "camera_scan" as const;

export type UploadGroupMeta = {
  id: string;
  name: string;
  source?: QueuedUpload["source"];
  fileNames: string[];
  primaryFileName?: string;
  pageCount: number;
  createdAt?: string;
};

export function getQueuedUploadFiles(upload: Pick<QueuedUpload, "file" | "files">): File[] {
  if (upload.files?.length) {
    return upload.files;
  }

  return upload.file ? [upload.file] : [];
}

export function getQueuedUploadPrimaryFile(upload: Pick<QueuedUpload, "file" | "files">) {
  return getQueuedUploadFiles(upload)[0];
}

export function getQueuedUploadPageCount(upload: Pick<QueuedUpload, "file" | "files">) {
  return getQueuedUploadFiles(upload).length || 1;
}

export function serializeQueuedUploadGroups(uploads: QueuedUpload[]): UploadGroupMeta[] {
  return uploads.flatMap((upload) => {
    const files = getQueuedUploadFiles(upload);
    const shouldPersistGroup = upload.source === CAMERA_SCAN_SOURCE || files.length > 1;

    if (!shouldPersistGroup || files.length === 0) {
      return [];
    }

    return [
      {
        id: upload.id,
        name: upload.name,
        source: upload.source,
        fileNames: files.map((file) => file.name),
        primaryFileName: files[0]?.name,
        pageCount: files.length,
        createdAt: new Date().toISOString(),
      },
    ];
  });
}

export function readUploadGroupMeta(value: unknown): UploadGroupMeta[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const fileNames = Array.isArray(record.fileNames)
      ? record.fileNames.filter((fileName): fileName is string => typeof fileName === "string" && fileName.trim().length > 0)
      : [];

    if (!fileNames.length) {
      return [];
    }

    const id = typeof record.id === "string" && record.id.trim().length > 0 ? record.id : crypto.randomUUID();
    const name =
      typeof record.name === "string" && record.name.trim().length > 0
        ? record.name
        : fileNames[0] ?? "Camera document";
    const source =
      record.source === "camera_scan" || record.source === "gallery" || record.source === "file"
        ? record.source
        : undefined;
    const primaryFileName =
      typeof record.primaryFileName === "string" && record.primaryFileName.trim().length > 0
        ? record.primaryFileName
        : fileNames[0];
    const pageCount = Number(record.pageCount);
    const createdAt =
      typeof record.createdAt === "string" && record.createdAt.trim().length > 0 ? record.createdAt : undefined;

    return [
      {
        id,
        name,
        source,
        fileNames,
        primaryFileName,
        pageCount: Number.isFinite(pageCount) && pageCount > 0 ? Math.floor(pageCount) : fileNames.length,
        createdAt,
      },
    ];
  });
}

export function mergeUploadGroupMeta(existing: UploadGroupMeta[], incoming: UploadGroupMeta[]) {
  const merged = new Map<string, UploadGroupMeta>();

  [...existing, ...incoming].forEach((group) => {
    const key = group.id || `${group.name}:${group.fileNames.join("|")}`;
    merged.set(key, group);
  });

  return Array.from(merged.values());
}
