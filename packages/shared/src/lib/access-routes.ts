// Explicit UI capabilities. Authorization still belongs to the API and database.
export function pagePermissions(path: string): string[] {
  const pathname = path.split('?')[0];
  if (pathname === '/settings/team') return ['team.manage', 'roles.manage'];
  if (/^\/settings(?:\/|$)/.test(pathname)) return ['settings.manage'];
  if (/^\/tally-prime(?:\/|$)/.test(pathname)) return ['connections.manage'];
  if (/^\/workspace(?:\/|$)/.test(pathname)) return ['purchases.prepare'];
  if (/^\/cases(?:\/|$)/.test(pathname)) return ['purchases.view'];
  if (/^\/recycle-bin(?:\/|$)/.test(pathname)) return ['purchases.recycle'];
  if (/^\/bank-statements(?:\/|$)/.test(pathname)) return ['bank.view'];
  if (/^\/collections\/follow-ups(?:\/|$)/.test(pathname)) return ['followups.view'];
  if (/^\/collections(?:\/|$)/.test(pathname)) return ['discounts.view'];
  return [];
}
