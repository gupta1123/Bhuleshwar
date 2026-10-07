"use client";

import { usePathname } from "next/navigation";
import { AppShell } from "@/components/dashboard/AppShell";

const SHELL_FREE_ROUTES = /^(?:\/login|\/auth(?:\/|$)|\/account\/change-password(?:\/|$))/;

export function PersistentAppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (SHELL_FREE_ROUTES.test(pathname)) return children;

  const defaultSidebarCollapsed = /^\/cases\/[^/]+(?:\/|$)/.test(pathname);

  return <AppShell defaultSidebarCollapsed={defaultSidebarCollapsed}>{children}</AppShell>;
}
