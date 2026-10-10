/** Never silently omit financial history because the Data API capped a response. */
export async function readCompleteHistory<T>(readPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const rows: T[] = [];
  const pageSize = 500;
  for (let page = 0; page < 100; page++) {
    const result = await readPage(page * pageSize, (page + 1) * pageSize - 1);
    if (result.error) throw result.error;
    const batch = result.data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  throw new Error('Debit-note history exceeds the safe read limit. Narrow the company/year scope before continuing.');
}
