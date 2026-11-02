import { withTeamAccess } from '@/lib/access/route-boundary';
import { optionsWithCors } from '@/lib/api/cors';
import { gstRoute } from '@/lib/gst/route';
import { readSettings, saveSettings } from '@/lib/gst/recon';

export const OPTIONS = optionsWithCors;

export const GET = withTeamAccess(async (request: Request) => gstRoute(request, (scope) => readSettings(scope)));
export const POST = withTeamAccess(async (request: Request) => gstRoute(request, (scope, body) => saveSettings(scope, body)));
