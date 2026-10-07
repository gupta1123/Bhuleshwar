"use client";

import { createContext, useContext } from "react";
import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";
import styles from "./AppShell.module.css";
import { AccessBoundary } from '@/components/access/AccessBoundary';

type AppShellProps = {
  children: React.ReactNode;
  defaultSidebarCollapsed?: boolean;
};

const AppShellContext = createContext(false);

export function AppShell({ children, defaultSidebarCollapsed = false }: AppShellProps) {
  const alreadyInsideShell = useContext(AppShellContext);

  // Existing screens still contain AppShell while the root layout owns the
  // persistent instance. Treat those wrappers as compatibility boundaries.
  if (alreadyInsideShell) return <>{children}</>;

  return (
    <AppShellContext.Provider value>
      <div className={styles.shell}>
        <DashboardSidebar defaultCollapsed={defaultSidebarCollapsed} />

        <main className={styles.main}><AccessBoundary>{children}</AccessBoundary></main>
      </div>
    </AppShellContext.Provider>
  );
}
