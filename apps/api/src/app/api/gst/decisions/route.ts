import { withTeamAccess } from '@/lib/access/route-boundary';
import { optionsWithCors } from '@/lib/api/cors';
import { gstRoute } from '@/lib/gst/route';
import { recordDecision } from '@/lib/gst/recon';

export const OPTIONS = optionsWithCors;

export const POST = withTeamAccess(async (request: Request) => gstRoute(request, (scope, body) => recordDecision(scope, body)));
