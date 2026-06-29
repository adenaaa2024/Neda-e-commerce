/**
 * Single source of truth for app navigation, Access Management feature tree, and DB catalog sync
 * (modules, module_features, permissions) — see `lib/sidebar-sync.ts`.
 * Additional flat (non–nav) permission keys: `lib/sidebar-catalog-extras.ts` (merged on sync; see `EXTRA_CATALOG_PERMISSIONS`).
 */

import type { RbacPermissions } from "../hooks/useRbacPermissions";
import {
  EXTRA_CATALOG_PERMISSIONS,
  type CatalogExtraPermission,
} from "./sidebar-catalog-extras";

export { type CatalogExtraPermission, EXTRA_CATALOG_PERMISSIONS };

export type SidebarRbac = keyof RbacPermissions | "always";

/** Lucide icon name — resolved in `AppShell` / `lib/sidebar-icons.ts`. */
export type SidebarIconName =
  | "Package"
  | "RotateCcw"
  | "ClipboardList"
  | "Banknote"
  | "DollarSign"
  | "ShieldAlert"
  | "FileText"
  | "Settings"
  | "Building2"
  | "Users"
  | "Palette"
  | "Network"
  | "Shield"
  | "Database"
  | "FileUp"
  | "ScanLine"
  | "Inbox"
  | "LayoutDashboard"
  | "Wrench"
  | "Store"
  | "Zap"
  | "Smartphone";

export type SidebarLeaf = {
  kind: "leaf";
  id: string;
  label: string;
  path: string;
  /** Nav icon; when omitted, parent group icon is not used (caller may default). */
  icon?: SidebarIconName;
  /**
   * Stable id for this screen (used in entitlements and overrides).
   * Convention: `module.subfeature` (e.g. `platform.organizations`).
   */
  featureKey: string;
  /**
   * Permission key prefix: rows synced as `permissionBase + ".read" | ".write" | ".manage"`.
   * Usually equal to `featureKey`.
   */
  permissionBase: string;
  /** Maps to a flag from `useRbacPermissions` (or "always"). */
  rbac: SidebarRbac;
  /** Sort order within the parent group. */
  order: number;
  /**
   * When `false`, the item is not shown in the main nav (still included in access sync and RWM
   * permissions if `permissionBase` is set). Omitted = visible.
   */
  showInSidebar?: boolean;
};

export type SidebarGroup = {
  kind: "group";
  id: string;
  label: string;
  icon: SidebarIconName;
  /** `public.modules.key` and grouping in Access Management. */
  moduleKey: string;
  order: number;
  children: SidebarLeaf[];
};

export type SidebarSection = {
  id: string;
  label: string;
  groups: SidebarGroup[];
  order: number;
};

export const MAIN_SIDEBAR: SidebarSection[] = [
  {
    id: "core",
    label: "",
    order: 0,
    groups: [
      {
        kind: "group",
        id: "warehouse",
        label: "Warehouse Operations",
        icon: "Package",
        moduleKey: "operations",
        order: 10,
        children: [
          {
            kind: "leaf",
            id: "returns",
            label: "Returns Processing",
            path: "/returns",
            featureKey: "operations.returns",
            permissionBase: "operations.returns",
            icon: "RotateCcw",
            rbac: "canSeeReturns",
            order: 1,
          },
          {
            kind: "leaf",
            id: "inventory",
            label: "Inventory Ledger",
            path: "/inventory",
            featureKey: "operations.inventory",
            permissionBase: "operations.inventory",
            icon: "ClipboardList",
            rbac: "always",
            order: 2,
            showInSidebar: false,
          },
          {
            kind: "leaf",
            id: "operator_mobile_scan",
            label: "Operator Mobile Scan",
            path: "/scanner/operator-mobile",
            featureKey: "operations.operator_mobile_scan",
            permissionBase: "operations.operator_mobile_scan",
            icon: "ScanLine",
            rbac: "canSeeWmsTools",
            order: 3,
          },
          {
            kind: "leaf",
            id: "pim_products",
            label: "Product Information Management",
            path: "/dashboard/products",
            featureKey: "etl.products",
            permissionBase: "etl.products",
            icon: "Package",
            rbac: "always",
            order: 4,
          },
        ],
      },
      {
        kind: "group",
        id: "finance",
        label: "Finance & Claims",
        icon: "DollarSign",
        moduleKey: "finance",
        order: 20,
        children: [
          {
            kind: "leaf",
            id: "settlements",
            label: "Settlements",
            path: "/settlements",
            featureKey: "finance.settlements",
            permissionBase: "finance.settlements",
            icon: "Banknote",
            rbac: "always",
            order: 1,
            showInSidebar: false,
          },
          {
            kind: "leaf",
            id: "claims",
            label: "Claims",
            path: "/claim-engine/inbox",
            featureKey: "claims.engine",
            permissionBase: "claims.engine",
            icon: "ShieldAlert",
            rbac: "canSeeClaimEngine",
            order: 2,
          },
          {
            kind: "leaf",
            id: "claim_center",
            label: "Claim Center",
            path: "/claim-center",
            featureKey: "claims.engine",
            permissionBase: "claims.engine",
            icon: "Inbox",
            rbac: "canSeeClaimEngine",
            order: 2.005,
          },
          {
            kind: "leaf",
            id: "claim_inbox",
            label: "Intake",
            path: "/claim-engine/inbox",
            featureKey: "claims.engine",
            permissionBase: "claims.engine",
            icon: "Inbox",
            rbac: "canSeeClaimEngine",
            order: 2.01,
            showInSidebar: false,
          },
          {
            kind: "leaf",
            id: "returns_claims_queue",
            label: "Draft pool (scans)",
            path: "/returns/claims",
            featureKey: "claims.engine",
            permissionBase: "claims.engine",
            icon: "RotateCcw",
            rbac: "canSeeClaimEngine",
            order: 2.52,
            showInSidebar: false,
          },
          {
            kind: "leaf",
            id: "claim_review_ops",
            label: "Review",
            path: "/claim-engine/review-ops",
            featureKey: "claims.engine",
            permissionBase: "claims.engine",
            icon: "ClipboardList",
            rbac: "canSeeClaimEngine",
            order: 2.55,
            showInSidebar: false,
          },
          {
            kind: "leaf",
            id: "claim_drafts_review",
            label: "Drafts review",
            path: "/claim-engine/drafts",
            featureKey: "claims.engine",
            permissionBase: "claims.engine",
            icon: "FileText",
            rbac: "canSeeClaimEngine",
            order: 2.56,
            showInSidebar: false,
          },
          {
            kind: "leaf",
            id: "claim_cases",
            label: "Cases",
            path: "/claim-engine/cases",
            featureKey: "claims.engine",
            permissionBase: "claims.engine",
            icon: "ClipboardList",
            rbac: "canSeeClaimEngine",
            order: 2.57,
            showInSidebar: false,
          },
          {
            kind: "leaf",
            id: "claim_engine_submission",
            label: "Submission queue",
            path: "/claim-engine",
            featureKey: "claims.engine",
            permissionBase: "claims.engine",
            icon: "ShieldAlert",
            rbac: "canSeeClaimEngine",
            order: 2.58,
            showInSidebar: false,
          },
          {
            kind: "leaf",
            id: "report_history",
            label: "Reports",
            path: "/claim-engine/report-history",
            featureKey: "claims.report_history",
            permissionBase: "claims.report_history",
            icon: "FileText",
            rbac: "canSeeReportHistory",
            order: 2.59,
            showInSidebar: false,
          },
          {
            kind: "leaf",
            id: "claims_settings",
            label: "Claims settings",
            path: "/settings?tab=claim_engine",
            featureKey: "claims.engine",
            permissionBase: "claims.engine",
            icon: "Settings",
            rbac: "canSeeClaimEngine",
            order: 2.6,
            showInSidebar: false,
          },
        ],
      },
      {
        kind: "group",
        id: "etl_imports",
        label: "Data Management",
        icon: "Database",
        moduleKey: "etl",
        order: 25,
        children: [
          {
            kind: "leaf",
            id: "imports",
            label: "Imports",
            path: "/dashboard/file-import",
            featureKey: "etl.imports",
            permissionBase: "etl.imports",
            icon: "FileUp",
            rbac: "canSeeImports",
            order: 1,
          },
        ],
      },
      {
        kind: "group",
        id: "system",
        label: "System Settings",
        icon: "Settings",
        moduleKey: "settings",
        order: 30,
        children: [
          {
            kind: "leaf",
            id: "stores",
            label: "Stores & Adapters",
            path: "/settings",
            featureKey: "settings.stores",
            permissionBase: "settings.stores",
            icon: "Store",
            rbac: "canSeeSettings",
            order: 1,
          },
          {
            kind: "leaf",
            id: "tenant_users",
            label: "Users",
            path: "/users",
            featureKey: "settings.users",
            permissionBase: "settings.users",
            icon: "Users",
            rbac: "canSeeUsers",
            order: 2,
          },
          {
            kind: "leaf",
            id: "people_assignments",
            label: "People assignments",
            path: "/settings/people",
            featureKey: "settings.people_assignments",
            permissionBase: "settings.people_assignments",
            icon: "Network",
            rbac: "canSeeUsers",
            order: 3,
          },
        ],
      },
      {
        kind: "group",
        id: "platform",
        label: "Platform Settings",
        icon: "Wrench",
        moduleKey: "platform",
        order: 40,
        children: [
          {
            kind: "leaf",
            id: "platform_branding",
            label: "Product branding",
            path: "/platform/settings",
            featureKey: "platform.branding",
            permissionBase: "platform.branding",
            icon: "Palette",
            rbac: "canSeePlatformAdmin",
            order: 1,
          },
          {
            kind: "leaf",
            id: "platform_automation",
            label: "Automation",
            path: "/platform/settings/automation",
            featureKey: "platform.branding",
            permissionBase: "platform.branding",
            icon: "Zap",
            rbac: "canSeePlatformAdmin",
            order: 2,
          },
          {
            kind: "leaf",
            id: "platform_pwa",
            label: "PWA / Installable app",
            path: "/platform/settings/pwa",
            featureKey: "platform.branding",
            permissionBase: "platform.branding",
            icon: "Smartphone",
            rbac: "canSeePlatformAdmin",
            order: 3,
          },
          {
            kind: "leaf",
            id: "platform_organizations",
            label: "Organizations",
            path: "/platform/organizations",
            featureKey: "platform.organizations",
            permissionBase: "platform.organizations",
            icon: "Building2",
            rbac: "canSeePlatformAdmin",
            order: 4,
          },
          {
            kind: "leaf",
            id: "platform_users",
            label: "Platform users",
            path: "/platform/users",
            featureKey: "platform.users",
            permissionBase: "platform.users",
            icon: "Users",
            rbac: "canSeePlatformUserDirectory",
            order: 5,
          },
          {
            kind: "leaf",
            id: "platform_access",
            label: "Access Management",
            path: "/platform/access",
            featureKey: "platform.access",
            permissionBase: "platform.access",
            icon: "Shield",
            rbac: "canSeePlatformAccess",
            order: 6,
          },
        ],
      },
    ],
  },
];

/** Home / Command Center — top of main nav (not synced to access catalog). */
export const DASHBOARD_NAV_LEAF: SidebarLeaf = {
  kind: "leaf",
  id: "dashboard",
  label: "Dashboard",
  path: "/dashboard",
  icon: "LayoutDashboard",
  featureKey: "dashboard.command_center",
  permissionBase: "operations.dashboard",
  rbac: "always",
  order: 0,
};

/** Task Center — standalone module (not under Finance & Claims). */
export const TASK_CENTER_NAV_LEAF: SidebarLeaf = {
  kind: "leaf",
  id: "task_center",
  label: "Task Center",
  path: "/task-center",
  icon: "ClipboardList",
  featureKey: "operations.task_center",
  permissionBase: "operations.task_center",
  rbac: "always",
  order: 1,
};

export const WMS_ONLY_NAV: { section: "wms"; label: string; order: number; leaves: SidebarLeaf[] } = {
  section: "wms",
  label: "WMS",
  order: 0,
  leaves: [
    {
      kind: "leaf",
      id: "wms_scan",
      label: "Operator Mobile Scan",
      path: "/scanner/operator-mobile",
      featureKey: "wms.scanner",
      permissionBase: "wms.scanner",
      icon: "ScanLine",
      rbac: "always",
      order: 1,
    },
  ],
};

/** Tech debug: permission-only gate (no primary route in sidebar). */
export const TECH_DEBUG_LEAF: SidebarLeaf = {
  kind: "leaf",
  id: "tech_debug",
  label: "Tech debug",
  path: "/",
  featureKey: "tech_debug.access",
  permissionBase: "tech_debug.access",
  rbac: "canSeeTechDebug",
  order: 99,
};

export function isLeafVisibleByRbac(leaf: SidebarLeaf, p: RbacPermissions): boolean {
  if (leaf.rbac === "always") return true;
  return Boolean(p[leaf.rbac as keyof RbacPermissions]);
}

export function flattenSidebarLeaves(): SidebarLeaf[] {
  const out: SidebarLeaf[] = [];
  for (const sec of MAIN_SIDEBAR) {
    for (const g of sec.groups) {
      out.push(...g.children);
    }
  }
  out.push(TASK_CENTER_NAV_LEAF);
  out.push(...WMS_ONLY_NAV.leaves);
  out.push(TECH_DEBUG_LEAF);
  return out;
}

/** Display + sort for `public.modules` rows; keys match the first segment of each leaf’s `permissionBase`. */
export const MODULE_CATALOG: Record<string, { name: string; sort_order: number }> = {
  operations: { name: "Operations", sort_order: 10 },
  /** Task Center permissions use operations.task_center.* — productivity module, not finance/claims. */
  task_center: { name: "Task Center", sort_order: 15 },
  finance: { name: "Finance", sort_order: 20 },
  claims: { name: "Claims", sort_order: 30 },
  settings: { name: "Settings", sort_order: 40 },
  platform: { name: "Platform", sort_order: 50 },
  etl:          { name: "ETL / Imports", sort_order: 35 },
  tenant_admin: { name: "Tenant admin", sort_order: 60 },
  wms: { name: "WMS", sort_order: 5 },
  tech_debug: { name: "Tech debug", sort_order: 90 },
};

export function getModuleRowsForSync(): { moduleKey: string; name: string; sort_order: number }[] {
  const keys = new Set<string>();
  for (const leaf of flattenSidebarLeaves()) {
    keys.add(parsePermissionBase(leaf.permissionBase).module);
  }
  for (const row of EXTRA_CATALOG_PERMISSIONS) {
    const m = String(row.module ?? "").trim() || "general";
    keys.add(m);
  }
  return [...keys]
    .map((k) => {
      const cat = MODULE_CATALOG[k];
      return {
        moduleKey: k,
        name: cat?.name ?? k,
        sort_order: cat?.sort_order ?? 500,
      };
    })
    .sort((a, b) => a.sort_order - b.sort_order || a.moduleKey.localeCompare(b.moduleKey));
}

/**
 * @returns module first segment, feature = rest (e.g. `platform` / `users` from `platform.users`).
 */
export function parsePermissionBase(permissionBase: string): { module: string; featureKey: string } {
  const parts = permissionBase.split(".").filter(Boolean);
  if (parts.length < 2) {
    return { module: parts[0] ?? "general", featureKey: "general" };
  }
  const [mod, ...rest] = parts;
  return { module: mod!, featureKey: rest.join(".") || "general" };
}
