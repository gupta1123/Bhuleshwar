// No company-wide Bill collection: native Bills/ChildOf scopes bound each read.
export async function readScopedOpenBills({ names, read, check, freeMemory, batchLimit, progress, now = () => performance.now(), maxBytes = 8 * 1024 * 1024 }) {
  const unique = [...new Set(names)];
  const parts = [];
  let bytes = 0;
  let offset = 0;
  let adaptiveLimit = 50;
  while (offset < unique.length) {
    check();
    // Batches already shrink with free memory; stop only when nearly exhausted.
    if (freeMemory() < 256 * 1024 * 1024) throw new Error('Open-bill discovery paused: less than 256 MB memory is available.');
    const size = Math.max(1, Math.min(50, batchLimit(), adaptiveLimit));
    const batch = unique.slice(offset, offset + size);
    progress?.(`Reading open bills: ${offset} of ${unique.length} ledger scopes checked...`);
    const started = now();
    // Never retry after a timeout: HTTP cancellation may not stop Tally's work.
    const xml = await read(batch, parts.length + 1);
    bytes += Buffer.byteLength(xml);
    if (bytes > maxBytes) throw new Error('Open-bill discovery exceeded its safe response size limit.');
    parts.push(xml);
    offset += batch.length;
    if (now() - started > 5000) adaptiveLimit = Math.max(1, Math.floor(size / 2));
  }
  return { xml: parts.join('\n'), batchCount: parts.length, queryMode: 'native_scoped_open_bills' };
}
