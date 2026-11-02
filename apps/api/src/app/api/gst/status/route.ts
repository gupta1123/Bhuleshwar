import { withTeamAccess } from '@/lib/access/route-boundary';
import { optionsWithCors } from '@/lib/api/cors';
import { gstRoute } from '@/lib/gst/route';
import { gstStatus } from '@/lib/gst/service';

export const OPTIONS = optionsWithCors;

async function handler(request: Request) {
  return gstRoute(request, (scope) => gstStatus(scope));
}
export const GET = withTeamAccess(handler);
