import { requireDataset } from '@/lib/access/dataset';
import { requireRequestUser } from '@/lib/api/request-auth';
import { purchaseDocumentCompanyKeys } from '@/lib/purchase-document-folder';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export type GstScope = { organizationId: string; companyKey: string; userId: string };

export class GstScopeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// Same organization and company key the purchase-document settings use, so a GST
// connection follows the Tally company across connector re-pairs.
export async function resolveGstScope(request: Request, body: Record<string, unknown>): Promise<GstScope> {
  const user = await requireRequestUser(request);
  if (!user) throw new GstScopeError('Unauthorized', 401);
  const connectionId = String(body.connectionId || '');
  const companyName = String(body.companyName || '').trim();
  if (!connectionId || !companyName) throw new GstScopeError('Select a workstation and company.', 400);

  if (process.env.TEAM_ACCESS_ENFORCEMENT === 'true') {
    const { access, link } = await requireDataset(request, connectionId, {
      companyName,
      companyGuid: body.companyGuid as string | undefined,
      financialYear: body.financialYear as string | undefined,
    }, 'purchases.view');
    return { organizationId: access.organizationId, companyKey: link.company_id, userId: user.id };
  }

  const { data, error } = await createSupabaseAdminClient().from('tally_connections').select('id')
    .eq('id', connectionId).eq('owner_user_id', user.id).is('revoked_at', null).maybeSingle();
  if (error || !data) throw new GstScopeError('Connection unavailable.', 404);
  const [companyKey] = purchaseDocumentCompanyKeys(undefined, connectionId, companyName, typeof body.companyGuid === 'string' ? body.companyGuid : null);
  return { organizationId: user.id, companyKey, userId: user.id };
}
