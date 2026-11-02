import { withTeamAccess } from '@/lib/access/route-boundary';
import { optionsWithCors } from '@/lib/api/cors';
import { gstRoute } from '@/lib/gst/route';
import { dataReadiness } from '@/lib/gst/recon';

export const OPTIONS = optionsWithCors;

// What is saved per month (books, 2B, 2A, 3B). Reads only; costs no GST calls.
export const GET = withTeamAccess(async (request: Request) => gstRoute(request, async (scope, body) => ({
  months: await dataReadiness(scope, String(body.periods || '').split(',').filter(Boolean)),
})));
