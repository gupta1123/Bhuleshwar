import { withTeamAccess } from '@/lib/access/route-boundary';
import { optionsWithCors } from '@/lib/api/cors';
import { gstRoute } from '@/lib/gst/route';
import { lookupSupplier, savedSuppliers } from '@/lib/gst/recon';

export const OPTIONS = optionsWithCors;

// GET: saved supplier statuses for gstins=a,b,c (no calls). POST: look one up, using the saved copy while it is under 60 days old.
export const GET = withTeamAccess(async (request: Request) => gstRoute(request, async (_scope, body) => ({
  suppliers: await savedSuppliers(String(body.gstins || '').split(',').map((v) => v.trim()).filter(Boolean)),
})));
export const POST = withTeamAccess(async (request: Request) => gstRoute(request, async (scope, body) => lookupSupplier(scope, String(body.gstin || ''), body.refresh === true)));
