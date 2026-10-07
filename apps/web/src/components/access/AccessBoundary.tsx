'use client';
import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { canAccess } from '@autodealer/shared/lib/access';
import { pagePermissions } from '@autodealer/shared/lib/access-routes';
import { useAccess } from './AccessProvider';

export function AccessBoundary({ children }: { children: ReactNode }) {
  const { snapshot, loading, error, refresh, enforcementRequired } = useAccess();
  const pathname = usePathname();
  // Sharing is deliberately gated in SQL until legacy resource enforcement is complete.
  if (snapshot?.member.must_change_password) return <p role="status" className="p-8">Please change your temporary password to continue.</p>;
  const enforcing = enforcementRequired;
  if (!enforcing) return children;
  if (loading) return <p role="status" className="p-8">Checking access…</p>;
  if (!snapshot) return <section className="p-8"><p role="alert">{error || 'Select an organization to continue.'}</p><button onClick={() => void refresh()}>Check again</button></section>;
  const required = pagePermissions(pathname);
  if (required.length && !required.some(permission => canAccess(snapshot, permission))) return <section className="p-8"><h1 className="text-xl font-semibold">You don’t have access to this area</h1><p className="mt-2">Ask your administrator to review your role and module access.</p></section>;
  // Changing scope remounts page state, preventing an old response from repopulating it.
  return <div key={`${snapshot.member.user_id}:${snapshot.organizationId}:${snapshot.revision}`} className="contents">{children}</div>;
}
