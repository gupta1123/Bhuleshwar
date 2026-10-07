type JsonRecord = Record<string, unknown>;

export function getJsonRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return { ...(value as JsonRecord) };
}

export function getRecycleBinDeletedAt(processingMeta: unknown): string | null {
  const meta = getJsonRecord(processingMeta);
  const recycleBin = getJsonRecord(meta.recycleBin);
  const deletedAt = recycleBin.deletedAt;

  return typeof deletedAt === "string" && deletedAt.trim().length > 0 ? deletedAt : null;
}

export function isCaseRecycled(processingMeta: unknown) {
  return Boolean(getRecycleBinDeletedAt(processingMeta));
}

export function withRecycleBinMetadata(
  processingMeta: unknown,
  deletedAt: string,
  deletedByUserId: string
) {
  const meta = getJsonRecord(processingMeta);
  const recycleBin = getJsonRecord(meta.recycleBin);

  return {
    ...meta,
    recycleBin: {
      ...recycleBin,
      deletedAt,
      deletedByUserId,
    },
  };
}

export function withoutRecycleBinMetadata(processingMeta: unknown) {
  const meta = getJsonRecord(processingMeta);
  const recycleBin = getJsonRecord(meta.recycleBin);

  delete recycleBin.deletedAt;
  delete recycleBin.deletedByUserId;

  if (Object.keys(recycleBin).length > 0) {
    return {
      ...meta,
      recycleBin,
    };
  }

  delete meta.recycleBin;
  return meta;
}
