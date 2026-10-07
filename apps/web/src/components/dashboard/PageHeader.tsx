"use client";

import React from "react";

export interface PageHeaderProps {
  /** Main title of the page (e.g. "Cases", "Dashboard") */
  title: React.ReactNode;
  /** Short descriptive subtitle next to or below the title */
  subtitle?: React.ReactNode;
  /** Optional status or badge (e.g. "Admin view") */
  badge?: React.ReactNode;
  /** Primary / secondary action buttons (e.g. filter toggle, add button) */
  actions?: React.ReactNode;
  /** Optional secondary controls (e.g. filter inputs, search, tab bar) */
  children?: React.ReactNode;
  /** Whether the header sticks to the top during scrolling (default: true) */
  sticky?: boolean;
  /** Custom extra container classes */
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  badge,
  actions,
  children,
  sticky = true,
  className = "",
}: PageHeaderProps) {
  return (
    <header
      className={`w-full transition-all ${
        sticky
          ? "sticky top-0 z-20 bg-[#f7f4ef]/95 backdrop-blur-md border-b border-[#e0d8cc] shadow-[0_1px_3px_rgba(45,36,28,0.03)]"
          : "border-b border-[#e0d8cc]"
      } ${className}`}
    >
      <div className="flex flex-col py-2.5">
        {/* ── Top Compact Row: Title + Subtitle on Left, Badge + Actions on Right ── */}
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <h1 className="text-lg font-bold tracking-tight text-[#111827] sm:text-xl">
              {title}
            </h1>
            {subtitle && (
              <>
                <span className="hidden text-[#c4b9ad] sm:inline-block">·</span>
                <span className="hidden text-xs font-normal text-[#8a7f72] sm:inline-block">
                  {subtitle}
                </span>
              </>
            )}
          </div>

          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            {badge}
            {actions}
          </div>
        </div>

        {/* ── Sub-row: Filter bar or secondary controls (with clean divider) ── */}
        {children && (
          <div className="mt-2.5 pt-2.5 border-t border-[#ece6dc]/80 w-full">
            {children}
          </div>
        )}
      </div>
    </header>
  );
}
