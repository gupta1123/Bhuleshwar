import { withTeamAccess } from '@/lib/access/route-boundary';
import { optionsWithCors } from '@/lib/api/cors';
import { finishBooksRead, queueBooksRead, readSavedBooks } from '@/lib/gst/books';
import { gstRoute } from '@/lib/gst/route';

export const OPTIONS = optionsWithCors;

function periodOf(body: Record<string, unknown>) {
  const period = String(body.period || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('period must be YYYY-MM.');
  return period;
}

// GET: saved books for a month, or (with commandId) finish a read the connector completed.
export const GET = withTeamAccess(async (request: Request) => gstRoute(request, async (scope, body) => {
  const period = periodOf(body);
  const commandId = String(body.commandId || '');
  if (commandId) return finishBooksRead(scope, { connectionId: String(body.connectionId), commandId, period });
  return { books: await readSavedBooks(scope, period, body.payload === '1') };
}));

// POST: ask the connector to read the month again from Tally.
export const POST = withTeamAccess(async (request: Request) => gstRoute(request, async (scope, body) => {
  const period = periodOf(body);
  return queueBooksRead(scope, { connectionId: String(body.connectionId), companyName: String(body.companyName), period });
}));
