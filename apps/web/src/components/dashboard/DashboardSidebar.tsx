"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  LayoutDashboard,
  FolderOpen,
  FileStack,
  FileText,
  Trash2,
  LogOut,
  ChevronsUpDown,
  Settings,
  ChevronLeft,
  PlugZap,
} from "lucide-react";

import styles from "./DashboardSidebar.module.css";
import { useTallyIndicator } from '@/components/tally/TallyStatusProvider';
import { useAccess } from '@/components/access/AccessProvider';
import { canAccess } from '@autodealer/shared/lib/access';
import { pagePermissions } from '@autodealer/shared/lib/access-routes';

/* ── Sectioned nav ───────────────────────────── */
type SidebarItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  exact?: boolean;
};

type SidebarSection = {
  id: string;
  title: string;
  items: SidebarItem[];
};

const SIDEBAR_SECTIONS: SidebarSection[] = [
  {
    id: "main",
    title: "Main",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
    ],
  },
  {
    id: "cases",
    title: "Cases",
    items: [
      { href: "/workspace", label: "Add Case", icon: FileStack },
      { href: "/cases", label: "All Cases", icon: FolderOpen },
    ],
  },
  {
    id: "system",
    title: "System",
    items: [
      { href: "/tally-prime?view=connection", label: "Tally Connector", icon: PlugZap },
      { href: "/recycle-bin", label: "Recycle Bin", icon: Trash2 },
    ],
  },
];

function isActivePath(pathname: string, href: string, exact = false) {
  const hrefPath = href.split("?")[0];
  if (hrefPath === "/" || exact) return pathname === hrefPath;
  return pathname === hrefPath || pathname.startsWith(`${hrefPath}/`);
}

interface UserInfo {
  name: string;
  email: string;
}

export interface DashboardSidebarProps {
  user?: UserInfo;
  defaultCollapsed?: boolean;
}

export function DashboardSidebar({ user, defaultCollapsed = false }: DashboardSidebarProps) {
  const pathname = usePathname();
  const {snapshot}=useAccess();
  const visible=(href:string)=>!snapshot?.sharingEnabled||pagePermissions(href).length===0||pagePermissions(href).some(p=>canAccess(snapshot,p));
  const sections=SIDEBAR_SECTIONS.map(section=>({...section,items:section.items.filter(item=>visible(item.href))})).filter(section=>section.items.length>0);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  useEffect(() => setCollapsed(defaultCollapsed), [defaultCollapsed]);
  const { status: tallyStatus, companyName: tallyCompanyName } = useTallyIndicator();
  const userRowRef = useRef<HTMLDivElement>(null);

  const displayUser: UserInfo = user ?? (snapshot ? {name:snapshot.member.display_name,email:snapshot.member.email} : {
    name: "Admin",
    email: "admin@bhuleshwar.local",
  });

  const initials = displayUser.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ""}`}>
      {/* ── BRAND ── */}
      <div className={`${styles.brandRow} ${collapsed ? styles.collapsed : ""}`}>
        <div className={styles.brandLeft}>
          <div className={styles.brandLogoMark}>B</div>
          <span className={styles.brandTitle}>Bhuleshwar</span>
        </div>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={styles.collapseBtn}
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <ChevronLeft className={`h-4 w-4 transition-transform ${collapsed ? "rotate-180" : ""}`} />
        </button>
      </div>

      {/* ── DESKTOP SECTIONED NAVIGATION ── */}
      <nav className={`${styles.navSection} ${styles.desktopNav}`}>
        {sections.map((section) => (
          <div key={section.id} className={styles.sectionGroup}>
            {!collapsed && <h3 className={styles.sectionHeader}>{section.title}</h3>}
            <ul className={styles.navList} role="list">
              {section.items.map((item) => {
                const active = isActivePath(pathname, item.href, item.exact);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
                      aria-label={collapsed ? item.label : undefined}
                      title={collapsed ? item.label : undefined}
                    >
                      <div className={styles.navItemLeft}>
                        {active && <div className={styles.activeBar} />}
                        <Icon className={styles.navIcon} />
                        <span className={styles.navTitle}>{item.label}</span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* ── MOBILE FLAT NAVIGATION ── */}
      <nav className={`${styles.navSection} ${styles.mobileNav}`}>
        <ul className={styles.navList} role="list">
          {sections.flatMap((s) => s.items).map((item) => {
            const active = isActivePath(pathname, item.href, item.exact);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
                >
                  <div className={styles.navItemLeft}>
                    {active && <div className={styles.activeBar} />}
                    <Icon className={styles.navIcon} />
                    <span className={styles.navTitle}>{item.label}</span>
                  </div>
                </Link>
              </li>
            );
          })}
          <li className={styles.mobileLogoutItem}>
            <form action="/auth/signout" method="post">
              <button type="submit" className={`${styles.navItem} ${styles.mobileLogoutButton}`}>
                <div className={styles.navItemLeft}>
                  <LogOut className={styles.navIcon} />
                  <span className={styles.navTitle}>Logout</span>
                </div>
              </button>
            </form>
          </li>
        </ul>
      </nav>

      <div className={styles.spacer} />

      <div className={styles.tallyStatusWrapper}>
        <Link
          href="/tally-prime?view=connection"
          className={`${styles.tallyStatusChip} ${styles[`tallyStatus_${tallyStatus}`]}`}
          aria-label={
            tallyStatus === "connected"
              ? `Tally connected${tallyCompanyName ? ` to ${tallyCompanyName}` : ""}`
              : tallyStatus === "checking"
                ? "Checking Tally connection"
                : tallyStatus === "attention"
                  ? "Tally connection needs attention"
                  : tallyStatus === "unavailable"
                    ? "Tally status unavailable"
                    : "Tally disconnected"
          }
          title={
            tallyStatus === "connected" && tallyCompanyName
              ? `Connected to ${tallyCompanyName}`
              : "Open Tally Connector"
          }
        >
          <span className={styles.tallyStatusDot} aria-hidden="true" />
          <span className={styles.tallyStatusCopy}>
            <span className={styles.tallyStatusText}>
            {tallyStatus === "connected"
              ? "Tally connected"
              : tallyStatus === "checking"
                ? "Checking Tally…"
                : tallyStatus === "attention"
                  ? "Tally not ready"
                  : tallyStatus === "unavailable"
                    ? "Status unavailable"
                    : "Tally disconnected"}
            </span>
            {tallyCompanyName && tallyStatus === "connected" ? (
              <span className={styles.tallyStatusCompany}>{tallyCompanyName}</span>
            ) : null}
          </span>
          <PlugZap className={styles.tallyStatusIcon} aria-hidden="true" />
        </Link>
      </div>

      {/* ── USER ROW (opens popover) ── */}
      <div className={styles.userRowWrapper} ref={userRowRef}>
        {/* Logout Popover */}
        {popoverOpen && (
          <>
            {/* Backdrop to close */}
            <div
              className={styles.popoverBackdrop}
              onClick={() => setPopoverOpen(false)}
            />
            <div className={styles.popover}>
              <div className={styles.popoverHeader}>
                <div className={styles.popoverUserAvatar}>{initials}</div>
                <div className={styles.popoverUserInfo}>
                  <div className={styles.popoverUserName}>{displayUser.name}</div>
                  <div className={styles.popoverUserEmail}>{displayUser.email}</div>
                </div>
              </div>
              
              <div className={styles.popoverMenu}>
                <Link href="/settings" className={styles.popoverMenuItem} onClick={() => setPopoverOpen(false)}>
                  <Settings size={14} className={styles.popoverMenuIcon} />
                  <span>Settings</span>
                </Link>
              </div>

              <div className={styles.popoverFooter}>
                <form action="/auth/signout" method="post" className="w-full">
                  <button type="submit" className={styles.popoverLogoutBtn}>
                    <LogOut size={14} />
                    <span>Sign out</span>
                  </button>
                </form>
              </div>
            </div>
          </>
        )}

        <div
          className={styles.userRow}
          onClick={() => setPopoverOpen((o) => !o)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && setPopoverOpen((o) => !o)}
          aria-expanded={popoverOpen}
          aria-haspopup="true"
        >
          <div className={styles.userLeft}>
            <div className={styles.userAvatar}>{initials}</div>
            <div className={styles.userInfo}>
              <span className={styles.userName}>{displayUser.name}</span>
              <span className={styles.userEmail}>{displayUser.email}</span>
            </div>
          </div>
          <ChevronsUpDown size={14} className={styles.userChevron} />
        </div>
      </div>
    </aside>
  );
}
