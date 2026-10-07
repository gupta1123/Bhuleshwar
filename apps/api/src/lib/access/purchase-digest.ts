import { createHash } from 'node:crypto';

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

/** Includes financial inputs, not changing transport timestamps or processing status. */
export function purchaseFinancialDigest(documents: Array<{ id: string; document_type: string; extracted_fields: unknown }>, review: unknown, routing: unknown) {
  return createHash('sha256').update(stable({ version: 1, documents: [...documents].sort((a, b) => a.id.localeCompare(b.id)), review, routing })).digest('hex');
}
