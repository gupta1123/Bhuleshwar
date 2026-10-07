import { requirePermission } from './server';

export async function settingsOrganization(request: Request) {
  if (process.env.TEAM_ACCESS_ENFORCEMENT !== 'true') return 'default';
  const context = await requirePermission(request, 'settings.manage');
  return context.organizationId;
}
