"use client";

/**
 * AppShell — Global layout wrapper.
 *
 * ─ Desktop  : Persistent collapsible sidebar + TopHeader (theme/profile live ONLY here).
 * ─ Mobile   : TopHeader (hamburger + logo + theme + profile) + drawer for nav.
 *
 * Sidebar visibility is driven by useRbacPermissions (incl. platform vs tenant shell from
 * effective org `workspaceViewMode` — not raw `super_admin` alone).
 * Content column: TopHeader (shrink-0) + scrollable main (flex-1 min-h-0 overflow-auto).
 *
 * Shell product row: platform name + `LogoMark` from `public.platform_settings` via
 * `PlatformBrandingContext`. Tenant org label + optional tenant logo live in `TopHeader`
 * (`UserRoleContext` + `BrandingContext`).
 */

import React, {
  createContext, useContext, useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { DrawerWorkspaceBar } from "./DrawerWorkspaceBar";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronDown, PanelLeftClose, PanelLeftOpen, Wrench, X } from "lucide-react";
import { TopHeader } from "./TopHeader";
import { BrandingProvider } from "./BrandingContext";
import { PlatformBrandingProvider, usePlatformBranding } from "./PlatformBrandingContext";
import { LogoMark } from "./LogoMark";
import { PlatformAppWordmark } from "./PlatformAppWordmark";
import { PLATFORM_TAGLINE } from "../lib/platform-branding";
import { GlobalSearchProvider } from "./GlobalSearchContext";
import { UserRoleProvider } from "./UserRoleContext";
import { TechDebugPanel } from "./TechDebugPanel";
import { useRbacPermissions } from "../hooks/useRbacPermissions";
import {
  isClaimCenterRoute,
  isClaimsHubRoute,
  isClaimsSidebarActive,
  isReturnsProcessingRoute,
  normalizeAppPath,
} from "../lib/claims-hub-routes";
import { MAIN_SIDEBAR, WMS_ONLY_NAV, DASHBOARD_NAV_LEAF, TASK_CENTER_NAV_LEAF, isLeafVisibleByRbac, type SidebarGroup } from "../lib/sidebar-config";
import { getSidebarIcon } from "../lib/sidebar-icons";
import { resolveBestMatchingSidebarHref } from "../lib/sidebar-nav-active";

/** All configured sidebar leaf hrefs — used for longest-prefix active matching. */
const ALL_SIDEBAR_LEAF_HREFS: string[] = [
  DASHBOARD_NAV_LEAF.path,
  TASK_CENTER_NAV_LEAF.path,
  ...MAIN_SIDEBAR.flatMap((sec) => sec.groups.flatMap((g) => g.children.map((c) => c.path))),
];

// ─── Nav (from `lib/sidebar-config.ts`) ─────────────────────────────────────

type NavChild = { label: string; href: string; icon: React.ElementType; disabled?: boolean; badge?: string };
type NavItemDef = {
  label: string;
  icon: React.ElementType;
  href?: string;
  disabled?: boolean;
  badge?: string;
  children?: NavChild[];
};

function navChildrenForGroup(
  g: SidebarGroup,
  perms: ReturnType<typeof useRbacPermissions>,
): NavChild[] {
  return g.children
    .filter((c) => {
      if (c.showInSidebar === false) return false;
      if (!isLeafVisibleByRbac(c, perms)) return false;
      if (g.id === "admin_imports" && !perms.canSeeSystemAdmin) return false;
      return true;
    })
    .map((c) => ({
      label: c.label,
      href: c.path,
      icon: getSidebarIcon(c.icon ?? g.icon),
      badge: c.id === "wms_scan" ? "WMS" : undefined,
    }));
}

// ─── Shell context (mobile menu trigger) ──────────────────────────────────────

const MobileMenuCtx = createContext<{ openMobileMenu: () => void }>({ openMobileMenu: () => {} });
export const useAppShell = () => useContext(MobileMenuCtx);

// ─── Shared CSS classes ───────────────────────────────────────────────────────

const SIDEBAR_WIDTH_STORAGE_KEY = "sidebar_width_px";
const SIDEBAR_EXPANDED_DEFAULT_PX = 240;
const SIDEBAR_MIN_PX = Math.round(SIDEBAR_EXPANDED_DEFAULT_PX * 0.7);
const SIDEBAR_MAX_PX = Math.round(SIDEBAR_EXPANDED_DEFAULT_PX * 1.6);

const CLS = {
  linkActive: "admin-nav-link--active",
  linkGroupOpen: "admin-nav-link--group-open",
  linkChildActive: "admin-nav-link--child-active",
  linkIdle:   "admin-nav-link--idle",
  linkDis:    "pointer-events-none text-muted-foreground/50",
  linkBase:   "admin-nav-link group relative flex min-h-[42px] w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] font-medium",
  section:    "admin-nav-section",
};

// ─── AppShell root ────────────────────────────────────────────────────────────

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <UserRoleProvider>
      <PlatformBrandingProvider>
        <BrandingProvider>
          <AppShellInner>{children}</AppShellInner>
        </BrandingProvider>
      </PlatformBrandingProvider>
    </UserRoleProvider>
  );
}

// ─── Inner shell (has access to context) ─────────────────────────────────────

function AppShellInner({ children }: { children: React.ReactNode }) {
  const { platformAppName, loading: platformNameLoading } = usePlatformBranding();
  const [collapsed,     setCollapsed]     = useState(false);
  const [mobileOpen,    setMobileOpen]    = useState(false);
  const [techDebugOpen, setTechDebugOpen] = useState(false);
  const [mounted,       setMounted]       = useState(false);
  const [expanded,      setExpanded]      = useState<Record<string, boolean>>({});
  const [sidebarWidthPx, setSidebarWidthPx] = useState<number | null>(null);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const settingsTabParam = searchParams.get("tab");
  const isPublicRoute = pathname === "/login" || pathname === "/";
  /** Standalone mobile scanner UI — no ERP sidebar, top search, or workspace chrome. */
  const isOperatorMobileScanner = pathname.startsWith("/scanner/operator-mobile");

  const normalizedPath = normalizeAppPath(pathname);
  const bestSidebarLeafMatch = useMemo(
    () => resolveBestMatchingSidebarHref(pathname, ALL_SIDEBAR_LEAF_HREFS),
    [pathname],
  );

  const expandedSidebarWidth = sidebarWidthPx ?? SIDEBAR_EXPANDED_DEFAULT_PX;

  useEffect(() => {
    setMounted(true);
    if (localStorage.getItem("sidebar_collapsed") === "true") setCollapsed(true);
    try {
      const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
      const n = raw != null ? Number.parseInt(raw, 10) : Number.NaN;
      if (Number.isFinite(n) && n >= SIDEBAR_MIN_PX && n <= SIDEBAR_MAX_PX) {
        setSidebarWidthPx(n);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!sidebarResizing) return;
    const onMove = (e: MouseEvent) => {
      const d = sidebarDragRef.current;
      if (!d) return;
      const next = Math.min(
        SIDEBAR_MAX_PX,
        Math.max(SIDEBAR_MIN_PX, d.startW + (e.clientX - d.startX)),
      );
      setSidebarWidthPx(next);
    };
    const onUp = () => {
      setSidebarWidthPx((w) => {
        const finalW = w ?? SIDEBAR_EXPANDED_DEFAULT_PX;
        try {
          localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(finalW));
        } catch {
          /* ignore */
        }
        return w;
      });
      sidebarDragRef.current = null;
      setSidebarResizing(false);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [sidebarResizing]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      localStorage.setItem("sidebar_collapsed", String(!c));
      return !c;
    });
  }, []);

  function toggleAccordion(key: string) {
    setExpanded((p) => ({ ...p, [key]: !p[key] }));
  }

  function isActive(href?: string) {
    if (!href || href === "#") return false;
    const path = normalizedPath;
    if (href === "/dashboard") return path === "/dashboard";
    if (href === "/settings") return path === "/settings";
    if (href === "/platform/settings") return path === "/platform/settings";
    if (href === "/claim-engine/inbox") {
      return isClaimsSidebarActive(path, settingsTabParam);
    }
    if (href === "/returns") {
      return isReturnsProcessingRoute(path);
    }
    return bestSidebarLeafMatch === href;
  }

  // Auto-expand accordion groups when a child route becomes active
  useEffect(() => {
    const auto: Record<string, boolean> = {};
    for (const sec of MAIN_SIDEBAR) {
      for (const g of sec.groups) {
        const key = `nav-${sec.id}-${g.id}`;
        if (g.children.some((c) => isActive(c.path))) {
          auto[key] = true;
        }
      }
    }
    if (
      isClaimsHubRoute(pathname) ||
      isClaimsSidebarActive(pathname, settingsTabParam) ||
      isClaimCenterRoute(pathname)
    ) {
      auto["nav-core-finance"] = true;
    }
    if (
      pathname.startsWith("/platform/settings")
      || pathname.startsWith("/platform/organizations")
      || pathname.startsWith("/platform/users")
      || pathname.startsWith("/platform/access")
    ) {
      auto["nav-core-platform"] = true;
    }
    if (Object.keys(auto).length) setExpanded((p) => ({ ...p, ...auto }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const closeMenu = () => setMobileOpen(false);

  function openTechDebug() {
    closeMenu();
    setTechDebugOpen(true);
  }

  // ── NavLink ────────────────────────────────────────────────────────────────
  function NavLink({ item, child = false, alwaysFull = false }: {
    item:        NavItemDef | NavChild;
    child?:      boolean;
    alwaysFull?: boolean;
  }) {
    const href     = (item as NavItemDef).href ?? "";
    const disabled = !!(item as NavItemDef).disabled;
    const badge    = (item as NavItemDef).badge;
    const active   = isActive(href);
    const Icon     = (item as NavItemDef).icon ?? (item as NavChild).icon;
    const showText = alwaysFull || !collapsed;

    return (
      <Link
        href={disabled ? "#" : href}
        onClick={closeMenu}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : undefined}
        className={[
          CLS.linkBase,
          child && showText ? "admin-nav-link--child" : "",
          collapsed && !showText ? "justify-center" : "",
          active && !disabled
            ? [CLS.linkActive, child ? CLS.linkChildActive : ""].filter(Boolean).join(" ")
            : disabled
              ? CLS.linkDis
              : CLS.linkIdle,
        ].join(" ")}
      >
        {Icon && (
          <Icon className={[
            child ? "h-4 w-4 shrink-0" : "h-5 w-5 shrink-0",
            active && !disabled ? "text-primary" : "",
            disabled             ? "opacity-50"                     : "",
          ].join(" ")} />
        )}

        {showText && (
          <>
            <span className="flex-1 truncate">{item.label}</span>
            {badge && (
              <span className="shrink-0 rounded-full border border-border bg-muted px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
                {badge}
              </span>
            )}
            {active && <span className="ml-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
          </>
        )}

        {!showText && (
          <span
            role="tooltip"
            className="invisible absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap rounded-xl border border-border bg-popover px-3 py-1.5 text-xs font-semibold text-popover-foreground shadow-lg group-hover:visible"
          >
            {item.label}
          </span>
        )}
      </Link>
    );
  }

  // ── AccordionItem ─────────────────────────────────────────────────────────
  function AccordionItem({
    item,
    groupKey,
    alwaysFull = false,
    trailingExpandedContent,
  }: {
    item:        NavItemDef;
    /** Stable id for expand state, e.g. `nav-core-warehouse` */
    groupKey:   string;
    alwaysFull?: boolean;
    /** Rendered inside the expanded panel after link children (e.g. Tech Debug). */
    trailingExpandedContent?: React.ReactNode;
  }) {
    const key         = groupKey;
    const open        = expanded[key] ?? false;
    const childActive = item.children?.some((c) => isActive(c.href));
    const Icon        = item.icon;
    const showText    = alwaysFull || !collapsed;

    return (
      <div>
        <button
          type="button"
          onClick={() => showText && toggleAccordion(key)}
          aria-expanded={showText ? open : undefined}
          className={[
            CLS.linkBase,
            collapsed && !showText ? "justify-center" : "",
            childActive ? CLS.linkGroupOpen : CLS.linkIdle,
          ].join(" ")}
        >
          <Icon className={[
            "h-5 w-5 shrink-0",
            childActive ? "text-primary" : "",
          ].join(" ")} />

          {showText && (
            <>
              <span className="flex-1 truncate text-left">{item.label}</span>
              <ChevronDown
                className={[
                  "h-4 w-4 shrink-0 opacity-90 transition-transform duration-300 ease-out motion-reduce:transition-none",
                  open ? "rotate-0" : "-rotate-90",
                ].join(" ")}
              />
            </>
          )}

          {!showText && (
            <span
              role="tooltip"
              className="invisible absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap rounded-xl border border-border bg-popover px-3 py-1.5 text-xs font-semibold text-popover-foreground shadow-lg group-hover:visible"
            >
              {item.label}
            </span>
          )}
        </button>

        {/* Smooth height reveal via CSS grid rows trick */}
        {showText && (
          <div
            className={[
              "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
              open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            ].join(" ")}
          >
            <div className="overflow-hidden">
              <div className="mt-0.5 space-y-0.5 pb-1">
                {item.children?.map((c) => (
                  <NavLink key={c.href} item={c} child alwaysFull={alwaysFull} />
                ))}
                {trailingExpandedContent}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── SidebarBody ───────────────────────────────────────────────────────────
  function SidebarBody({
    alwaysFull = false,
    collapsed: sidebarCollapsed,
  }: {
    alwaysFull?: boolean;
    collapsed:   boolean;
  }) {
    const perms = useRbacPermissions();
    const showSection = alwaysFull || !sidebarCollapsed;

    if (perms.isWmsOnly) {
      const wmsVisible = WMS_ONLY_NAV.leaves.filter((c) => isLeafVisibleByRbac(c, perms));
      return (
        <div className="mb-4">
          <div className="mb-2">
            <NavLink
              item={{
                label: DASHBOARD_NAV_LEAF.label,
                href: DASHBOARD_NAV_LEAF.path,
                icon: getSidebarIcon(DASHBOARD_NAV_LEAF.icon ?? "LayoutDashboard"),
              }}
              alwaysFull={alwaysFull}
            />
          </div>
          {isLeafVisibleByRbac(TASK_CENTER_NAV_LEAF, perms) ? (
            <div className="mb-2">
              <NavLink
                item={{
                  label: TASK_CENTER_NAV_LEAF.label,
                  href: TASK_CENTER_NAV_LEAF.path,
                  icon: getSidebarIcon(TASK_CENTER_NAV_LEAF.icon ?? "ClipboardList"),
                }}
                alwaysFull={alwaysFull}
              />
            </div>
          ) : null}
          {showSection
            ? <p className={CLS.section}>{WMS_ONLY_NAV.label}</p>
            : <div className="mb-2 mx-3 h-px bg-border" />
          }
          <div className="space-y-0.5">
            {wmsVisible.map((leaf) => (
              <NavLink
                key={leaf.id}
                item={{
                  label: leaf.label,
                  href: leaf.path,
                  icon: getSidebarIcon(leaf.icon ?? "ScanLine"),
                  badge: "WMS",
                }}
                alwaysFull={alwaysFull}
              />
            ))}
          </div>
        </div>
      );
    }

    const core = MAIN_SIDEBAR[0]!;
    const admin = MAIN_SIDEBAR[1];
    const adminVisible =
      admin?.groups
        .map((g) => navChildrenForGroup(g, perms))
        .some((ch) => ch.length > 0) ?? false;

    return (
      <>
        <div className="mb-2">
          <NavLink
            item={{
              label: DASHBOARD_NAV_LEAF.label,
              href: DASHBOARD_NAV_LEAF.path,
              icon: getSidebarIcon(DASHBOARD_NAV_LEAF.icon ?? "LayoutDashboard"),
            }}
            alwaysFull={alwaysFull}
          />
        </div>
        {isLeafVisibleByRbac(TASK_CENTER_NAV_LEAF, perms) ? (
          <div className="mb-2">
            <NavLink
              item={{
                label: TASK_CENTER_NAV_LEAF.label,
                href: TASK_CENTER_NAV_LEAF.path,
                icon: getSidebarIcon(TASK_CENTER_NAV_LEAF.icon ?? "ClipboardList"),
              }}
              alwaysFull={alwaysFull}
            />
          </div>
        ) : null}
        <div className="space-y-1">
          {core.groups.map((g) => {
            const ch = navChildrenForGroup(g, perms);
            if (g.id === "platform") {
              const showTech = perms.canSeeTechDebug;
              if (ch.length === 0 && !showTech) return null;
              return (
                <AccordionItem
                  key={g.id}
                  groupKey={`nav-${core.id}-${g.id}`}
                  item={{ label: g.label, icon: getSidebarIcon(g.icon), children: ch }}
                  alwaysFull={alwaysFull}
                  trailingExpandedContent={
                    showTech ? (
                      <TechDebugNavButton
                        child
                        collapsed={sidebarCollapsed}
                        alwaysFull={alwaysFull}
                        onClick={openTechDebug}
                      />
                    ) : null
                  }
                />
              );
            }
            if (ch.length === 0) return null;
            return (
              <AccordionItem
                key={g.id}
                groupKey={`nav-${core.id}-${g.id}`}
                item={{ label: g.label, icon: getSidebarIcon(g.icon), children: ch }}
                alwaysFull={alwaysFull}
              />
            );
          })}
        </div>

        {admin && adminVisible ? (
          <div className="mt-4">
            {showSection
              ? <p className={CLS.section}>{admin.label}</p>
              : <div className="mb-2 mx-3 h-px bg-border" />
            }
            <div className="space-y-0.5">
              {admin.groups.map((g) => {
                const ch = navChildrenForGroup(g, perms);
                if (ch.length === 0) return null;
                if (g.id === "admin_imports" && ch.length === 1) {
                  return <NavLink key={g.id} item={ch[0]!} alwaysFull={alwaysFull} />;
                }
                return (
                  <AccordionItem
                    key={g.id}
                    groupKey={`nav-${admin.id}-${g.id}`}
                    item={{ label: g.label, icon: getSidebarIcon(g.icon), children: ch }}
                    alwaysFull={alwaysFull}
                  />
                );
              })}
            </div>
          </div>
        ) : null}
      </>
    );
  }

  // ── Mobile drawer ─────────────────────────────────────────────────────────
  const mobileDrawer = (
    <>
      <div
        className="fixed inset-0 z-[200] bg-foreground/20 backdrop-blur-sm"
        onClick={closeMenu}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="fixed left-0 top-0 z-[210] flex h-full w-[280px] max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar shadow-2xl animate-drawer-slide-in-left admin-sidebar"
      >
        <div className="admin-sidebar-brand flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border px-4">
          <Link
            href="/dashboard"
            onClick={closeMenu}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg outline-none ring-sidebar-ring transition hover:bg-sidebar-accent/25 focus-visible:ring-2"
            title="Home / Dashboard"
          >
            <LogoMark />
            <div className="min-w-0">
              <PlatformAppWordmark
                name={platformAppName}
                loading={platformNameLoading}
                size="sidebar"
                className="max-w-full"
                fallbackClassName="block truncate text-sm font-bold tracking-tight text-sidebar-foreground"
              />
              <p className="truncate text-[10px] font-medium text-muted-foreground">{PLATFORM_TAGLINE}</p>
            </div>
          </Link>
          <button
            type="button"
            onClick={closeMenu}
            aria-label="Close menu"
            className="admin-chrome-control flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <DrawerWorkspaceBar onClose={closeMenu} />

        <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 py-4">
          <SidebarBody alwaysFull collapsed={false} />
        </nav>
      </div>
    </>
  );

  // Public routes (landing + login) render without the main app shell chrome.
  if (isPublicRoute) {
    return (
      <GlobalSearchProvider>
        <MobileMenuCtx.Provider value={{ openMobileMenu: () => setMobileOpen(true) }}>
          <div className="menorix-admin-shell min-h-screen bg-background">{children}</div>
        </MobileMenuCtx.Provider>
      </GlobalSearchProvider>
    );
  }

  // Operator mobile scanner: outer canvas matches route layout gutter (no ERP chrome).
  if (isOperatorMobileScanner) {
    return (
      <GlobalSearchProvider>
        <MobileMenuCtx.Provider value={{ openMobileMenu: () => {} }}>
          <div className="m-0 flex min-h-dvh w-full max-w-none flex-col bg-[#030712] p-0">{children}</div>
        </MobileMenuCtx.Provider>
      </GlobalSearchProvider>
    );
  }

  // ── Full layout ───────────────────────────────────────────────────────────
  return (
    <GlobalSearchProvider>
      <MobileMenuCtx.Provider value={{ openMobileMenu: () => setMobileOpen(true) }}>
        <div className="menorix-admin-shell flex min-h-screen bg-background">

          {/* Desktop sidebar */}
          <aside
            className={[
              "admin-sidebar sticky top-0 hidden h-screen shrink-0 flex-col overflow-hidden",
              "border-r border-sidebar-border",
              "md:flex",
              collapsed ? "w-16" : "relative",
              !collapsed && !sidebarResizing ? "transition-[width] duration-200 ease-out" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={!collapsed ? { width: expandedSidebarWidth } : undefined}
          >
            <Link
              href="/dashboard"
              className={[
                "admin-sidebar-brand mx-hover-sidebar-brand flex h-14 shrink-0 items-center border-b border-sidebar-border px-4 min-w-0 overflow-hidden outline-none ring-sidebar-ring focus-visible:ring-2",
                collapsed ? "justify-center" : "gap-2.5",
              ].join(" ")}
              title="Home / Dashboard"
            >
              <LogoMark />
              {!collapsed && (
                <div className="min-w-0">
                  <PlatformAppWordmark
                    name={platformAppName}
                    loading={platformNameLoading}
                    size="sidebar"
                    className="max-w-full"
                    fallbackClassName="block truncate text-sm font-bold tracking-tight text-sidebar-foreground"
                  />
                  <p className="truncate text-[10px] font-medium text-muted-foreground">{PLATFORM_TAGLINE}</p>
                </div>
              )}
            </Link>

            <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 py-4">
              <SidebarBody collapsed={collapsed} />
            </nav>

            <div className="shrink-0 border-t border-sidebar-border px-3 py-2.5">
              <button
                type="button"
                onClick={toggleCollapsed}
                title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                className={[
                  "admin-sidebar-collapse-btn mx-hover-sidebar-control",
                  collapsed ? "mx-auto" : "ml-auto",
                ].join(" ")}
              >
                {collapsed
                  ? <PanelLeftOpen className="h-6 w-6 shrink-0" />
                  : <PanelLeftClose className="h-6 w-6 shrink-0" />}
              </button>
            </div>

            {!collapsed ? (
              <button
                type="button"
                aria-label="Resize sidebar"
                title="Drag to resize sidebar"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  sidebarDragRef.current = {
                    startX: e.clientX,
                    startW: expandedSidebarWidth,
                  };
                  setSidebarResizing(true);
                }}
                className="admin-sidebar-resize-handle mx-hover-sidebar-resize absolute right-0 top-0 z-30 h-full w-2 max-w-[12px] cursor-col-resize border-0 bg-transparent p-0"
              >
                <span className="pointer-events-none absolute right-1 top-1/2 h-10 w-px -translate-y-1/2 rounded-full bg-border/80" />
              </button>
            ) : null}
          </aside>

          {/* Main column */}
          <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col">
            <TopHeader onMenuClick={() => setMobileOpen(true)} />
            <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-auto">
              <div className="admin-page-content w-full flex-1">{children}</div>
            </div>
          </div>

          {mobileOpen && mounted && createPortal(mobileDrawer, document.body)}

          <TechDebugPanel open={techDebugOpen} onClose={() => setTechDebugOpen(false)} />
        </div>
      </MobileMenuCtx.Provider>
    </GlobalSearchProvider>
  );
}

// ─── TechDebugNavButton — opens TechDebugPanel (super_admin) ─────────────────

function TechDebugNavButton({
  collapsed,
  alwaysFull,
  onClick,
  child = false,
}: {
  collapsed:  boolean;
  alwaysFull: boolean;
  onClick:    () => void;
  /** Indent like accordion sub-links (Platform Settings). */
  child?:     boolean;
}) {
  const showText = alwaysFull || !collapsed;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open Tech Debug panel"
      className={[
        CLS.linkBase, CLS.linkIdle,
        child && showText ? "admin-nav-link--child" : "",
        collapsed && !showText ? "justify-center" : "",
      ].join(" ")}
    >
      <Wrench className={[child ? "h-4 w-4" : "h-5 w-5", "shrink-0"].join(" ")} />

      {showText && (
        <>
          <span className="flex-1 truncate text-left">Tech Debug</span>
          <span className="shrink-0 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-primary">
            SA
          </span>
        </>
      )}

      {!showText && (
        <span
          role="tooltip"
          className="invisible absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap rounded-xl border border-border bg-popover px-3 py-1.5 text-xs font-semibold text-popover-foreground shadow-lg group-hover:visible"
        >
          Tech Debug
        </span>
      )}
    </button>
  );
}
