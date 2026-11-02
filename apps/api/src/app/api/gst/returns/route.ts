import { withTeamAccess } from '@/lib/access/route-boundary';
import { optionsWithCors } from '@/lib/api/cors';
import { gstRoute, readReturnRequest } from '@/lib/gst/route';
import { pullGstReturn } from '@/lib/gst/service';

export const OPTIONS = optionsWithCors;

// GET reads the saved return and goes to the portal only if none is saved.
// POST is an explicit Refresh, subject to the daily cap and the minimum gap.
function handlerFor(refresh: boolean) {
  return async (request: Request) => gstRoute(request, async (scope, body) => {
    const { returnType, period } = readReturnRequest(body);
    const result = await pullGstReturn(scope, { returnType, period, refresh });
    const withPayload = body.payload === '1' || body.payload === true;
    return {
      returnType, period, source: result.source, calls: result.calls,
      fetchedAt: result.snapshot.fetchedAt, isFinal: result.snapshot.isFinal, fetchCount: result.snapshot.fetchCount,
      ...(withPayload ? { payload: result.snapshot.payload } : {}),
    };
  });
}
export const GET = withTeamAccess(handlerFor(false));
export const POST = withTeamAccess(handlerFor(true));
