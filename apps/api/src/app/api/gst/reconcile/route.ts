import { withTeamAccess } from '@/lib/access/route-boundary';
import { optionsWithCors } from '@/lib/api/cors';
import { gstRoute } from '@/lib/gst/route';
import { decisionHistory, readRun, recentRuns, runReconcile } from '@/lib/gst/recon';

export const OPTIONS = optionsWithCors;

// GET: latest run (or runId), or history=1 for past runs. POST: reconcile on saved data.
export const GET = withTeamAccess(async (request: Request) => gstRoute(request, async (scope, body) => {
  if (body.history === '1') return { runs: await recentRuns(scope) };
  if (body.itemKey) return { decisions: await decisionHistory(scope, String(body.itemKey)) };
  return { result: await readRun(scope, body.runId ? String(body.runId) : undefined) };
}));
export const POST = withTeamAccess(async (request: Request) => gstRoute(request, (scope, body) => runReconcile(scope, body)));
