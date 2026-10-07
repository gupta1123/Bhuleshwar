import { withTeamAccess } from '@/lib/access/route-boundary';
import { requireDataset } from '@/lib/access/dataset';
import { jsonWithCors, optionsWithCors } from '@/lib/api/cors';
import { requireRequestUser } from '@/lib/api/request-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { purchaseDocumentCompanyKeys, readPurchaseDocumentFolder, validatePurchaseDocumentFolder } from '@/lib/purchase-document-folder';

export const OPTIONS = optionsWithCors;

async function handler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: 'Unauthorized' }, { status: 401 });
    const body = request.method === 'GET' ? Object.fromEntries(new URL(request.url).searchParams) : await request.json();
    const connectionId = String(body.connectionId || '');
    const companyName = String(body.companyName || '').trim();
    if (!connectionId || !companyName) throw new Error('Select a workstation and company.');
    const db = createSupabaseAdminClient();
    let organizationId: string, companyKey: string, companyKeys: string[];
    if (process.env.TEAM_ACCESS_ENFORCEMENT === 'true') {
      const { access, link } = await requireDataset(request, connectionId, {
        companyName, companyGuid: body.companyGuid, financialYear: body.financialYear,
      }, 'settings.manage');
      organizationId = access.organizationId;
      companyKey = link.company_id;
      companyKeys = [companyKey];
    } else {
      const { data, error } = await db.from('tally_connections').select('id').eq('id', connectionId)
        .eq('owner_user_id', user.id).is('revoked_at', null).maybeSingle();
      if (error || !data) return jsonWithCors(request, { error: 'Connection unavailable.' }, { status: 404 });
      organizationId = user.id;
      // Saved by Tally company GUID so a connector re-pair keeps the folder.
      companyKeys = purchaseDocumentCompanyKeys(undefined, connectionId, companyName, typeof body.companyGuid === 'string' ? body.companyGuid : null);
      companyKey = companyKeys[0];
    }
    if (request.method === 'PUT') {
      const folder = validatePurchaseDocumentFolder(body.folderPath);
      const { error } = await db.from('purchase_document_folders').upsert({
        organization_id: organizationId, company_key: companyKey, folder_path: folder,
        updated_by: user.id, updated_at: new Date().toISOString(),
      }, { onConflict: 'organization_id,company_key' });
      if (error) throw new Error('Could not save the folder. Ensure the purchase_document_folders migration has been applied.');
    }
    return jsonWithCors(request, { folderPath: await readPurchaseDocumentFolder(organizationId, companyKeys) });
  } catch (error) {
    return jsonWithCors(request, { error: error instanceof Error ? error.message : 'Folder settings are unavailable.' }, { status: 400 });
  }
}
export const GET = withTeamAccess(handler);
export const PUT = withTeamAccess(handler);
