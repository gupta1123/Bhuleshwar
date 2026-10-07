import { jsonWithCors, optionsWithCors } from '@/lib/api/cors';
import { AccessError } from '@/lib/access/server';
import { requireResourceAccess } from '@/lib/access/resources';
import { purchaseFinancialDigest } from '@/lib/access/purchase-digest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const OPTIONS = optionsWithCors;
const reply = (request: Request, value: unknown, status = 200) => jsonWithCors(request, value, { status, headers: { 'Cache-Control': 'private, no-store' } });
function fail(request: Request, error: unknown) {
  return reply(request, { error: error instanceof AccessError ? error.message : 'Could not update purchase approval.' }, error instanceof AccessError ? error.status : 500);
}
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { db } = await requireResourceAccess(request, 'case', id, 'purchases.view');
    const result = await db.from('access_purchase_workflows').select('*').eq('case_id', id).maybeSingle();
    if (result.error) throw new AccessError('Approval infrastructure is unavailable.', 503);
    return reply(request, { workflow: result.data });
  } catch (error) { return fail(request, error); }
}
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const raw = await request.text();
    if (raw.length > 4096) throw new AccessError('Request too large.', 413);
    let body;
    try { body = JSON.parse(raw); } catch { throw new AccessError('Invalid request.', 400); }
    if (!body || Array.isArray(body) || !['prepare', 'submit', 'approve', 'return'].includes(body.action) || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new AccessError('An action and current revision are required.', 400);
    const permission = body.action === 'prepare' ? 'purchases.prepare' : body.action === 'submit' ? 'purchases.submit' : 'purchases.approve';
    const { db, access, scope } = await requireResourceAccess(request, 'case', id, permission);
    // Preparation is read from saved business records. Never approve a client-supplied digest.
    const [docs, posting] = await Promise.all([
      db.from('packet_documents').select('id,document_type,extracted_fields').eq('case_id', id),
      db.from('purchase_invoice_tally_postings').select('review_patch,connection_id,status').eq('case_id', id).maybeSingle(),
    ]);
    if (docs.error || posting.error) throw new AccessError('Could not read the current purchase revision.', 503);
    if (!docs.data?.length || !posting.data) throw new AccessError('Prepare and save the purchase details first.', 409);
    if (['created', 'queued', 'creating', 'sending', 'verification_required'].includes(posting.data.status)) throw new AccessError('A posted or in-flight voucher cannot enter a new approval workflow.', 409);
    const digest = purchaseFinancialDigest(docs.data, posting.data.review_patch, { companyId: scope.company_id, connectionId: posting.data.connection_id });
    const result = await db.rpc('access_purchase_transition', {
      p_actor: access.member.user_id, p_org: access.organizationId, p_case: id, p_action: body.action,
      p_revision: body.revision, p_digest: digest, p_reason: typeof body.reason === 'string' ? body.reason : null,
      p_source_revision: scope.source_revision,
    });
    if (result.error) {
      const status = result.error.code === '42501' ? 403 : ['40001', '55000'].includes(result.error.code) ? 409 : 400;
      throw new AccessError(status === 403 ? 'Another approver must review this purchase, or your access has changed.' : 'Purchase state or revision changed. Reload before continuing.', status);
    }
    return reply(request, { workflow: result.data });
  } catch (error) { return fail(request, error); }
}
