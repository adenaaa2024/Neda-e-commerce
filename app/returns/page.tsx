"use client";

/**
 * Returns Processing — Items / Packages / Pallets (route: `/returns`).
 * Data loads via server actions in `./actions` (application layer), not inline in UI.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Boxes, Package2, ScanLine, Store } from "lucide-react";
import { DatabaseTag } from "../../components/DatabaseTag";
import { useGlobalSearch } from "../../components/GlobalSearchContext";
import { useUserRole } from "../../components/UserRoleContext";
import { listReturns, listPackages, listPallets, getOrgSettings, countReturns } from "./actions";
import { listStoresForOrganization } from "../settings/adapters/actions";
import type { OrgSettings, PackageRecord, PalletRecord, ReturnRecord } from "./returns-action-types";
import { getFefoSettings } from "../settings/workspace-settings-actions";
import {
  DEFAULT_FEFO,
  type InventoryModuleConfig,
} from "../settings/workspace-settings-types";
import { resolveOrganizationId } from "../../lib/organization";
import { normalizeRoleKeyForBranding } from "../../lib/tenant-branding-permissions";
import { isUuidString } from "../../lib/uuid";
import {
  listWorkspaceOrganizationsForAdmin,
  getOrganizationNames,
  type WorkspaceOrganizationOption,
} from "../session/tenant-actions";
import { listPlatformMarketplaceIcons } from "../(admin)/lib/platform-actions";
import {
  DEFAULT_ORG_SETTINGS,
  type DrawerContent, type WizardInheritedContext,
  type ToastKind,
  ToastStack, RightDrawer,
  ItemDrawerContent, PackageDrawerContent, PalletDrawerContent,
  ItemsDataTable, PackagesDataTable, PalletsDataTable,
  SingleItemWizardModal, CreatePackageModal, CreatePalletModal,
  useToast,
} from "./_components";

// ─── Root Page ─────────────────────────────────────────────────────────────────

type ActiveTab = "items" | "packages" | "pallets";

type ReturnsScopeDebugPhase =
  | "initial_load"
  | "company_filter_change"
  | "tab_change"
  | "before_items_query"
  | "before_packages_query"
  | "before_pallets_query";

function logReturnsScopeDebug(
  phase: ReturnsScopeDebugPhase,
  payload: Record<string, unknown>,
): void {
  if (process.env.NODE_ENV === "production") return;
  console.log("[returns-scope-debug]", { phase, ...payload });
}

/** Report list scope — super_admin on parent workspace defaults to all companies when no explicit pick. */
function resolveReturnsListFilterOrganizationId(opts: {
  canViewAllCompanies: boolean;
  viewAllCompanies: boolean;
  reportCompanyFilterOrganizationId: string;
  workspaceOrganizationId: string | null;
  homeOrganizationId: string | null;
}): string | undefined {
  const {
    canViewAllCompanies,
    viewAllCompanies,
    reportCompanyFilterOrganizationId,
    workspaceOrganizationId,
    homeOrganizationId,
  } = opts;
  if (canViewAllCompanies) {
    if (viewAllCompanies) return undefined;
    const picked = reportCompanyFilterOrganizationId.trim();
    if (picked && isUuidString(picked)) return picked;
    return undefined;
  }
  const workspace = (workspaceOrganizationId ?? "").trim();
  if (workspace && isUuidString(workspace)) return workspace;
  const home = (homeOrganizationId ?? "").trim();
  return home && isUuidString(home) ? home : undefined;
}

function returnsQueryScopeMode(
  canViewAllCompanies: boolean,
  filterOrganizationId: string | undefined,
): "all_companies" | "single_company" | "workspace_scoped" {
  if (canViewAllCompanies) {
    return filterOrganizationId ? "single_company" : "all_companies";
  }
  return "workspace_scoped";
}

export default function ReturnsPage() {
  // ── Data State ──────────────────────────────────────────────────────────────
  const [returns,      setReturns]      = useState<ReturnRecord[]>([]);
  const [packages,     setPackages]     = useState<PackageRecord[]>([]);
  const [pallets,      setPallets]      = useState<PalletRecord[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing,     setRefreshing]     = useState(false);
  const hasLoadedOnceRef = useRef(false);
  const [fetchErrors,  setFetchErrors]  = useState<string[]>([]);
  const [orgSettings,  setOrgSettings]  = useState<OrgSettings>(DEFAULT_ORG_SETTINGS);
  const [fefoSettings, setFefoSettings] = useState<InventoryModuleConfig>(DEFAULT_FEFO);
  /** Exact DB total (non-deleted return_items) — compares to `listReturns()` row cap. */
  const [returnsTotalCount, setReturnsTotalCount] = useState<number | null>(null);
  /** In-session File objects keyed by returnId — enables live photo gallery in the drawer. */
  const [sessionPhotos, setSessionPhotos] = useState<Map<string, Record<string, File[]>>>(new Map());

  // ── UI State ────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ActiveTab>("items");
  const {
    role,
    actorName: actor,
    actorUserId,
    actorCanonicalRoleKey,
    organizationId: userOrgId,
    homeOrganizationId,
    workspaceOrganizations,
    workspaceViewMode,
    workspaceViewModeReady,
    profileLoading,
  } = useUserRole();
  /** Report-only: All companies mode (super_admin parent workspace). Does not change header workspace. */
  const [viewAllCompanies, setViewAllCompanies] = useState(true);
  /** Report-only company filter — scopes list queries; never updates global workspace. */
  const [reportCompanyFilterOrganizationId, setReportCompanyFilterOrganizationId] = useState("");
  const [companyOptions, setCompanyOptions] = useState<WorkspaceOrganizationOption[]>([]);
  const companyOptionsForUi =
    workspaceOrganizations.length > 0 ? workspaceOrganizations : companyOptions;

  const isSuperAdmin =
    normalizeRoleKeyForBranding(actorCanonicalRoleKey) === "super_admin";
  /** Parent/root workspace = `organizations.type` internal → platform shell (`workspaceViewMode`). */
  const isViewingParentOrganization =
    workspaceViewModeReady && workspaceViewMode === "platform";
  const canViewAllCompanies = isSuperAdmin && isViewingParentOrganization;
  const showCompanyFilter =
    isSuperAdmin && isViewingParentOrganization && companyOptionsForUi.length > 0;
  /** Store filter is always available on Items / Packages / Pallets for allowed users. */
  const showStoreFilter = true;
  /** Real org names fetched directly from organizations + organization_settings tables.
   *  Populated for every org_id found in the loaded data rows. */
  const [extraOrgLabels, setExtraOrgLabels] = useState<Record<string, string>>({});
  const [platformIconBySlug, setPlatformIconBySlug] = useState<Record<string, string>>({});

  /** Store filter — applies to Items and Packages (pallets don't have store_id in list select). */
  const [storeFilter, setStoreFilter] = useState<string>("");
  const [storeOptions, setStoreOptions] = useState<{ id: string; name: string; platform: string }[]>([]);

  /** Super Admin parent workspace: wait for org type before resolving All-companies scope. */
  const reportFilterReady = useMemo(
    () => !profileLoading && (!isSuperAdmin || workspaceViewModeReady),
    [profileLoading, isSuperAdmin, workspaceViewModeReady],
  );

  const listFilterOrganizationId = useMemo(
    () =>
      resolveReturnsListFilterOrganizationId({
        canViewAllCompanies,
        viewAllCompanies,
        reportCompanyFilterOrganizationId,
        workspaceOrganizationId: userOrgId,
        homeOrganizationId,
      }),
    [
      canViewAllCompanies,
      viewAllCompanies,
      reportCompanyFilterOrganizationId,
      userOrgId,
      homeOrganizationId,
    ],
  );

  const queryScopeMode = useMemo(
    () => returnsQueryScopeMode(canViewAllCompanies, listFilterOrganizationId),
    [canViewAllCompanies, listFilterOrganizationId],
  );

  const tenantQuery = useMemo(
    () => ({ actorProfileId: actorUserId, filterOrganizationId: listFilterOrganizationId }),
    [actorUserId, listFilterOrganizationId],
  );

  /** Org used for store dropdown + org settings while lists are company-scoped. */
  const effectiveListOrganizationId = useMemo((): string => {
    if (listFilterOrganizationId) return listFilterOrganizationId;
    return userOrgId ?? homeOrganizationId ?? resolveOrganizationId();
  }, [listFilterOrganizationId, userOrgId, homeOrganizationId]);

  const showCompanyColumn = canViewAllCompanies && viewAllCompanies;

  const organizationLabelById = useMemo(() => {
    // Layer 1: real DB names from organizations.name (lowest priority base)
    const m: Record<string, string> = { ...extraOrgLabels };
    // Layer 2: admin-set display names from companyOptions, but ONLY when the
    // RPC returned a real name — not when it fell back to the raw UUID string.
    for (const o of companyOptionsForUi) {
      if (o.display_name && o.display_name !== o.organization_id) {
        m[o.organization_id] = o.display_name;
      }
    }
    return m;
  }, [companyOptionsForUi, extraOrgLabels]);

  const effectiveWriteOrgId = userOrgId ?? homeOrganizationId ?? resolveOrganizationId();

  // ── Drawer Stack ─────────────────────────────────────────────────────────────
  // Stack allows drilling down: Pallet → Package → Item and going back.
  const [drawerStack, setDrawerStack] = useState<DrawerContent[]>([]);
  const activeDrawer = drawerStack[drawerStack.length - 1] ?? null;
  const canGoBack    = drawerStack.length > 1;

  function openDrawer(c: DrawerContent) { setDrawerStack([c]); }
  function openItemDetail(r: ReturnRecord) {
    openDrawer({ type: "item", record: r });
  }
  function openItemEdit(r: ReturnRecord) {
    openDrawer({ type: "item", record: r, startInEditMode: true });
  }
  function pushDrawer(c: DrawerContent) { setDrawerStack((p) => [...p, c]); }
  function popDrawer()                  { setDrawerStack((p) => p.slice(0, -1)); }
  function closeDrawer()                { setDrawerStack([]); }

  // ── Modal State ──────────────────────────────────────────────────────────────
  const [wizardOpen,         setWizardOpen]         = useState(false);
  const [wizardInherited,    setWizardInherited]    = useState<WizardInheritedContext | undefined>(undefined);
  const [createPackageOpen,  setCreatePackageOpen]  = useState(false);
  const [createPalletOpen,   setCreatePalletOpen]   = useState(false);

  const { toasts, show: showToast } = useToast();
  const { query: globalSearchQuery } = useGlobalSearch();

  useEffect(() => {
    if (!showCompanyFilter) return;
    let cancelled = false;
    void listWorkspaceOrganizationsForAdmin().then((res) => {
      if (!cancelled && res.ok) setCompanyOptions(res.rows);
    });
    return () => { cancelled = true; };
  }, [showCompanyFilter]);

  /** Child-org / tenant workspace: clear All-companies report mode once workspace type is known. */
  useEffect(() => {
    if (!workspaceViewModeReady) return;
    if (!canViewAllCompanies && (viewAllCompanies || reportCompanyFilterOrganizationId)) {
      setViewAllCompanies(false);
      setReportCompanyFilterOrganizationId("");
    }
  }, [
    workspaceViewModeReady,
    canViewAllCompanies,
    viewAllCompanies,
    reportCompanyFilterOrganizationId,
  ]);

  /** Parent workspace super_admin: restore All-companies when no explicit company pick. */
  useEffect(() => {
    if (!workspaceViewModeReady || !canViewAllCompanies) return;
    if (!reportCompanyFilterOrganizationId.trim() && !viewAllCompanies) {
      setViewAllCompanies(true);
    }
  }, [
    workspaceViewModeReady,
    canViewAllCompanies,
    reportCompanyFilterOrganizationId,
    viewAllCompanies,
  ]);

  const scopeDebugPayload = useMemo(
    () => ({
      role,
      isParentWorkspace: isViewingParentOrganization,
      workspaceOrganizationId: userOrgId,
      reportCompanyFilterOrganizationId,
      viewAllCompanies,
      effectiveListOrganizationId: listFilterOrganizationId,
      activeTab,
      queryScopeMode,
    }),
    [
      role,
      isViewingParentOrganization,
      userOrgId,
      reportCompanyFilterOrganizationId,
      viewAllCompanies,
      listFilterOrganizationId,
      activeTab,
      queryScopeMode,
    ],
  );

  const scopeDebugPayloadRef = useRef(scopeDebugPayload);
  scopeDebugPayloadRef.current = scopeDebugPayload;

  const initialLoadLoggedRef = useRef(false);
  useEffect(() => {
    if (!reportFilterReady || initialLoadLoggedRef.current) return;
    initialLoadLoggedRef.current = true;
    logReturnsScopeDebug("initial_load", scopeDebugPayloadRef.current);
  }, [reportFilterReady]);

  const prevTabRef = useRef(activeTab);
  useEffect(() => {
    if (prevTabRef.current === activeTab) return;
    prevTabRef.current = activeTab;
    logReturnsScopeDebug("tab_change", scopeDebugPayloadRef.current);
  }, [activeTab]);

  // After data loads, resolve the real DB name for every org_id present in the
  // rows. This catches the case where list_workspace_organizations_for_admin()
  // returned a raw UUID as display_name (happens when company_display_name is
  // NULL in organization_settings but organizations.name has the real value).
  useEffect(() => {
    if (!showCompanyColumn) return;
    const orgIds = new Set<string>();
    for (const r of returns)  if (r.organization_id) orgIds.add(r.organization_id);
    for (const p of packages) if (p.organization_id) orgIds.add(p.organization_id);
    for (const p of pallets)  if (p.organization_id) orgIds.add(p.organization_id);
    if (orgIds.size === 0) return;
    let cancelled = false;
    void getOrganizationNames([...orgIds]).then((res) => {
      if (cancelled || !res.ok) return;
      setExtraOrgLabels((prev) => {
        const next = { ...prev };
        for (const row of res.rows) {
          // Only store when getOrganizationNames found a real name (not UUID fallback)
          if (row.display_name && row.display_name !== row.organization_id) {
            next[row.organization_id] = row.display_name;
          }
        }
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [showCompanyColumn, returns, packages, pallets]);

  useEffect(() => {
    let cancelled = false;
    void listPlatformMarketplaceIcons().then((res) => {
      if (!cancelled && res.ok) setPlatformIconBySlug(res.bySlug);
    });
    return () => { cancelled = true; };
  }, []);

  // Load stores for the store filter — scoped to one company, or merged across tenants in All-companies mode.
  useEffect(() => {
    let cancelled = false;
    async function loadStoreOptions() {
      if (canViewAllCompanies && viewAllCompanies && companyOptionsForUi.length > 0) {
        const results = await Promise.all(
          companyOptionsForUi.map((o) => listStoresForOrganization(o.organization_id)),
        );
        if (cancelled) return;
        const byId = new Map<string, { id: string; name: string; platform: string }>();
        for (const res of results) {
          if (!res.ok || !res.data) continue;
          for (const s of res.data) {
            if (s.is_active === false) continue;
            byId.set(s.id, { id: s.id, name: s.name, platform: s.platform });
          }
        }
        setStoreOptions(
          [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)),
        );
        return;
      }
      const res = await listStoresForOrganization(effectiveListOrganizationId);
      if (cancelled || !res.ok || !res.data) return;
      setStoreOptions(
        res.data
          .filter((s) => s.is_active !== false)
          .map((s) => ({ id: s.id, name: s.name, platform: s.platform })),
      );
    }
    void loadStoreOptions();
    return () => { cancelled = true; };
  }, [
    canViewAllCompanies,
    viewAllCompanies,
    effectiveListOrganizationId,
    companyOptionsForUi,
  ]);

  useEffect(() => {
    setStoreFilter("");
  }, [listFilterOrganizationId, viewAllCompanies, reportCompanyFilterOrganizationId]);

  // ── Data Loading ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!reportFilterReady) return;
    let cancelled = false;
    async function load() {
      if (!hasLoadedOnceRef.current) setInitialLoading(true);
      else setRefreshing(true);
      setFetchErrors([]);
      try {
        const settingsOrg = effectiveListOrganizationId;
        const debug = scopeDebugPayloadRef.current;
        logReturnsScopeDebug("before_items_query", debug);
        logReturnsScopeDebug("before_packages_query", debug);
        logReturnsScopeDebug("before_pallets_query", debug);
        const [r, p, pl, settings, fefo, retCount] = await Promise.all([
          listReturns(tenantQuery),
          listPackages(tenantQuery),
          listPallets(tenantQuery),
          getOrgSettings(settingsOrg),
          getFefoSettings(),
          countReturns(tenantQuery),
        ]);
        if (cancelled) return;
        const errs: string[] = [];
        if (r.ok)  setReturns(r.data   ?? []);
        else       errs.push(`Items: ${r.error ?? "unknown error"}`);
        if (retCount.ok) setReturnsTotalCount(retCount.count);
        else { setReturnsTotalCount(null); console.error("[ReturnsPage] countReturns failed:", retCount.error); }
        if (p.ok)  setPackages(p.data  ?? []);
        else       errs.push(`Boxes: ${p.error ?? "unknown error"}`);
        if (pl.ok) setPallets(pl.data  ?? []);
        else       errs.push(`Pallets: ${pl.error ?? "unknown error"}`);
        if (errs.length) setFetchErrors(errs);
        setOrgSettings(settings);
        setFefoSettings(fefo);
      } catch (e) {
        if (!cancelled) {
          setFetchErrors([`Failed to load: ${e instanceof Error ? e.message : String(e)}`]);
        }
      } finally {
        if (!cancelled) {
          setInitialLoading(false);
          setRefreshing(false);
          hasLoadedOnceRef.current = true;
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [reportFilterReady, tenantQuery, effectiveListOrganizationId]);

  // ── Derived helpers ──────────────────────────────────────────────────────────
  const openPackages = useMemo(() => packages.filter((p) => p.status === "open"), [packages]);
  const openPallets  = useMemo(() => pallets.filter((p)  => p.status === "open"), [pallets]);

  /**
   * Store-filtered views.
   * Returns and packages both carry a `store_id` FK; pallets do not (they span stores).
   * When `storeFilter` is empty, all rows are shown.
   */
  const filteredReturns  = useMemo(() =>
    storeFilter ? returns.filter((r)  => r.store_id  === storeFilter) : returns,
    [returns, storeFilter],
  );
  const filteredPackages = useMemo(() =>
    storeFilter ? packages.filter((p) => p.store_id === storeFilter) : packages,
    [packages, storeFilter],
  );

  const filteredPallets = useMemo(() => {
    if (!storeFilter) return pallets;
    return pallets.filter((p) => {
      if (p.store_id === storeFilter) return true;
      if (packages.some((pkg) => pkg.pallet_id === p.id && pkg.store_id === storeFilter)) return true;
      return returns.some((r) => r.pallet_id === p.id && r.store_id === storeFilter);
    });
  }, [pallets, packages, returns, storeFilter]);

  /** Tab counts and Items table use this array only — loaded via `listReturns()` (no mock / no fixed length). */
  const visibleReturns = filteredReturns;
  const visiblePallets = filteredPallets;

  // ── Mutations ────────────────────────────────────────────────────────────────
  function addReturn(r: ReturnRecord, photos?: Record<string, File[]>) {
    setReturns((p) => [r, ...p]);
    if (photos && Object.keys(photos).length > 0) {
      setSessionPhotos((m) => new Map(m).set(r.id, photos));
    }
    setPackages((prev) => prev.map((pkg) => pkg.id === r.package_id ? { ...pkg, actual_item_count: pkg.actual_item_count + 1 } : pkg));
  }
  function updateReturn_(r: ReturnRecord) { setReturns((p) => p.map((x) => x.id === r.id ? r : x)); }
  function removeReturn(id: string) {
    const removed = returns.find((r) => r.id === id);
    setReturns((p) => p.filter((x) => x.id !== id));
    if (removed?.package_id) setPackages((prev) => prev.map((pkg) => pkg.id === removed.package_id ? { ...pkg, actual_item_count: Math.max(0, pkg.actual_item_count - 1) } : pkg));
  }
  function bulkRemoveReturns(ids: string[]) { const set = new Set(ids); setReturns((p) => p.filter((r) => !set.has(r.id))); }
  function bulkUpdateReturns(updated: ReturnRecord[]) { const map = new Map(updated.map((r) => [r.id, r])); setReturns((p) => p.map((r) => map.get(r.id) ?? r)); }

  function addPackage(p: PackageRecord)  { setPackages((prev) => [p, ...prev]); }
  function updatePackage_(p: PackageRecord) {
    setPackages((prev) => prev.map((x) => x.id === p.id ? p : x));
    setReturns((prev) => prev.map((r) => (r.package_id === p.id ? { ...r, pallet_id: p.pallet_id } : r)));
  }
  function removePackage(id: string)     { setPackages((p) => p.filter((x) => x.id !== id)); }
  function bulkRemovePackages(ids: string[]) { const s = new Set(ids); setPackages((p) => p.filter((x) => !s.has(x.id))); }
  /** After bulk assign packages → pallet: merge package rows and sync items' denormalized pallet_id */
  function bulkUpdatePackages(updated: PackageRecord[]) {
    const map = new Map(updated.map((p) => [p.id, p]));
    setPackages((prev) => prev.map((p) => map.get(p.id) ?? p));
    const touched = new Set(updated.map((p) => p.id));
    setReturns((prev) => prev.map((r) => {
      if (!r.package_id || !touched.has(r.package_id)) return r;
      const pkg = map.get(r.package_id);
      if (!pkg) return r;
      return { ...r, pallet_id: pkg.pallet_id };
    }));
  }

  function addPallet(p: PalletRecord)    { setPallets((prev) => [p, ...prev]); }
  function updatePallet_(p: PalletRecord) { setPallets((prev) => prev.map((x) => x.id === p.id ? p : x)); }
  function removePallet(id: string)      { setPallets((p) => p.filter((x) => x.id !== id)); }
  function bulkRemovePallets(ids: string[]) { const s = new Set(ids); setPallets((p) => p.filter((x) => !s.has(x.id))); }

  /** Assign/move existing return item to a package — sync items list + denormalized counts from live `return_items` rows. */
  function syncReturnAfterPackageAssignment(updated: ReturnRecord, prevPackageId: string | null) {
    setReturns((prev) => {
      const merged = prev.map((x) => (x.id === updated.id ? updated : x));
      const affected = new Set<string>();
      if (prevPackageId) affected.add(prevPackageId);
      if (updated.package_id) affected.add(updated.package_id);
      queueMicrotask(() => {
        setPackages((pkgs) =>
          pkgs.map((pkg) => {
            if (!affected.has(pkg.id)) return pkg;
            const n = merged.filter((r) => r.package_id === pkg.id).length;
            return { ...pkg, actual_item_count: n };
          }),
        );
        setDrawerStack((stack) =>
          stack.map((d) => {
            if (d.type !== "package") return d;
            if (!affected.has(d.record.id)) return d;
            const n = merged.filter((r) => r.package_id === d.record.id).length;
            return { ...d, record: { ...d.record, actual_item_count: n } };
          }),
        );
      });
      return merged;
    });
  }

  // ── Open wizard with optional inherited context ───────────────────────────────
  function openWizard(ctx?: WizardInheritedContext) {
    setWizardInherited(ctx);
    setWizardOpen(true);
  }

  // ── Derived drawer title ─────────────────────────────────────────────────────
  function drawerTitle() {
    if (!activeDrawer) return "";
    if (activeDrawer.type === "item")    return activeDrawer.record.item_name;
    if (activeDrawer.type === "package") return activeDrawer.record.package_code;
    if (activeDrawer.type === "pallet")  return activeDrawer.record.pallet_number;
    return "";
  }
  function drawerSubtitle() {
    if (!activeDrawer) return "";
    if (activeDrawer.type === "item")
      return activeDrawer.startInEditMode ? "Return Item · Edit" : "Return Item";
    if (activeDrawer.type === "package") return "Box";
    if (activeDrawer.type === "pallet")  return "Pallet";
    return "";
  }

  // ── Tab config ───────────────────────────────────────────────────────────────
  const tabs: { id: ActiveTab; label: string; icon: React.ElementType; count: number; countTitle?: string; accent: string }[] = [
    {
      id: "items",
      label: "Items",
      icon: ScanLine,
      count: filteredReturns.length,
      countTitle: (() => {
        if (storeFilter) return `${filteredReturns.length} of ${returns.length} items match the selected store`;
        if (returnsTotalCount != null && returnsTotalCount > returns.length) {
          return `${returns.length} loaded in this session (${returnsTotalCount} total in database)`;
        }
        if (returns.length > 25) {
          return `${returns.length} items — table shows 25 per page`;
        }
        return undefined;
      })(),
      accent: "text-[#8A681F] border-[#8A681F] dark:text-[#D6B76E] dark:border-[#D6B76E]",
    },
    { id: "packages", label: "Boxes", icon: Package2,  count: filteredPackages.length, accent: "text-[#B08A3C] border-[#B08A3C] dark:text-[#F1D58A] dark:border-[#F1D58A]" },
    { id: "pallets",  label: "Pallets",  icon: Boxes,     count: filteredPallets.length,  accent: "text-[#8A681F] border-[#8A681F] dark:text-[#D6B76E] dark:border-[#D6B76E]" },
  ];

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col bg-[#F3EFE6] text-[#171A1E] dark:bg-[#0B0E12] dark:text-[#F7F3EA]">
      {/* Top Bar */}
      {/* Page title row — global TopHeader (theme/profile) is rendered by AppShell above */}
      {/* z below app TopHeader (z-50) so global chrome popovers aren’t covered */}
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-[rgba(138,104,31,0.18)] bg-[#F8F6F1]/95 px-4 py-3 backdrop-blur-sm dark:border-[rgba(214,183,110,0.18)] dark:bg-[#151A20]/95">
        <div className="min-w-0 flex-1">
          <h1 className="font-bold text-[#171A1E] dark:text-[#F7F3EA]">Returns & Logistics</h1>
          <p className="text-xs text-[#737C86] dark:text-[#7E8894]">FBA Reimbursement ERP · tenant-scoped data</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {showCompanyFilter ? (
            <label className="flex items-center gap-2 text-xs font-medium text-[#4C5661] dark:text-[#B8C1CB]">
              <span className="whitespace-nowrap">Company</span>
              <select
                value={viewAllCompanies ? "" : reportCompanyFilterOrganizationId}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") {
                    setViewAllCompanies(true);
                    setReportCompanyFilterOrganizationId("");
                    logReturnsScopeDebug("company_filter_change", {
                      role,
                      isParentWorkspace: isViewingParentOrganization,
                      workspaceOrganizationId: userOrgId,
                      reportCompanyFilterOrganizationId: "",
                      viewAllCompanies: true,
                      effectiveListOrganizationId: undefined,
                      activeTab,
                      queryScopeMode: "all_companies",
                    });
                    return;
                  }
                  setViewAllCompanies(false);
                  setReportCompanyFilterOrganizationId(v);
                  logReturnsScopeDebug("company_filter_change", {
                    role,
                    isParentWorkspace: isViewingParentOrganization,
                    workspaceOrganizationId: userOrgId,
                    reportCompanyFilterOrganizationId: v,
                    viewAllCompanies: false,
                    effectiveListOrganizationId: v,
                    activeTab,
                    queryScopeMode: "single_company",
                  });
                }}
                className="h-9 min-w-[150px] rounded-lg border border-[rgba(138,104,31,0.18)] bg-[#FFFFFF] px-2 text-xs font-semibold text-[#171A1E] dark:border-[rgba(214,183,110,0.18)] dark:bg-[#1D242C] dark:text-[#F7F3EA]"
                aria-label="Filter report by company"
              >
                <option value="">All companies</option>
                {companyOptionsForUi.map((o) => (
                  <option key={o.organization_id} value={o.organization_id}>{o.display_name}</option>
                ))}
              </select>
            </label>
          ) : null}

          {showStoreFilter && activeTab === "items" ? (
            <label className="flex items-center gap-2 text-xs font-medium text-[#4C5661] dark:text-[#B8C1CB]">
              <Store className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="whitespace-nowrap">Store</span>
              <select
                value={storeFilter}
                onChange={(e) => setStoreFilter(e.target.value)}
                className="h-9 min-w-[150px] rounded-lg border border-[rgba(138,104,31,0.18)] bg-[#FFFFFF] px-2 text-xs font-semibold text-[#171A1E] dark:border-[rgba(214,183,110,0.18)] dark:bg-[#1D242C] dark:text-[#F7F3EA]"
                aria-label="Filter by store"
              >
                <option value="">All stores</option>
                {storeOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} {s.platform ? `(${s.platform})` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </header>

      {/* Tab Bar */}
      <div className="sticky top-[57px] z-10 border-b border-[rgba(138,104,31,0.18)] bg-[#F8F6F1] dark:border-[rgba(214,183,110,0.18)] dark:bg-[#151A20]">
        <nav className="flex gap-0 overflow-x-auto px-4" role="tablist">
          {tabs.map((t) => {
            const Icon = t.icon; const active = activeTab === t.id;
            return (
              <button key={t.id} role="tab" aria-selected={active} onClick={() => setActiveTab(t.id)}
                className={`flex items-center gap-2 border-b-2 px-5 py-4 text-sm font-semibold transition whitespace-nowrap ${
                  active
                    ? `${t.accent} bg-[#EFE6D2]/40 dark:bg-[#2A2418]/50`
                    : "border-transparent text-[#4C5661] hover:text-[#171A1E] dark:text-[#B8C1CB] dark:hover:text-[#F7F3EA]"
                }`}>
                <Icon className="h-4 w-4" />
                {t.label}
                <span
                  title={t.countTitle}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${active ? "bg-[#EFE6D2] text-[#8A681F] dark:bg-[#2A2418] dark:text-[#F1D58A]" : "bg-[#EEE8DC] text-[#4C5661] dark:bg-[#232C35] dark:text-[#B8C1CB]"}`}
                >{t.count}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Fetch error banner — shown when any list query fails */}
      {fetchErrors.length > 0 && (
        <div className="border-b border-[rgba(138,104,31,0.24)] bg-[#F3E5DE] px-4 py-3 dark:border-[rgba(214,183,110,0.24)] dark:bg-[#302025]">
          <p className="mb-1 text-sm font-semibold text-[#6C3E34] dark:text-[#D7B2A8]">Data failed to load — check your browser console and server logs for details.</p>
          <ul className="list-inside list-disc space-y-0.5">
            {fetchErrors.map((e, i) => (
              <li key={i} className="text-xs text-[#6C3E34] dark:text-[#D7B2A8]">{e}</li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-[#737C86] dark:text-[#7E8894]">
            Common cause: a database migration has not been applied yet. Run the pending SQL migration files in Supabase → SQL Editor.
          </p>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 p-4 sm:p-6">
        {initialLoading && returns.length === 0 && packages.length === 0 && pallets.length === 0 ? (
          <div className="flex items-center justify-center py-24">
            <div className="flex flex-col items-center gap-3"><div className="h-10 w-10 animate-spin rounded-full border-4 border-[#D9CBB1] border-t-[#8A681F] dark:border-[#2E3740] dark:border-t-[#D6B76E]" /><p className="text-sm text-[#737C86] dark:text-[#7E8894]">Loading…</p></div>
          </div>
        ) : (
          <>
            {refreshing ? (
              <div className="mb-3 flex items-center gap-2 text-sm text-[#4C5661] dark:text-[#B8C1CB]" aria-live="polite">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#D9CBB1] border-t-[#8A681F] dark:border-[#2E3740] dark:border-t-[#D6B76E]" />
                Refreshing…
              </div>
            ) : null}
            {activeTab === "items" && (
              <div className="relative min-h-0">
                <DatabaseTag table="items" />
                <ItemsDataTable
                  items={visibleReturns}
                  packages={packages}
                  pallets={pallets}
                  role={role}
                  actor={actor}
                  actorProfileId={actorUserId}
                  showCompanyColumn={showCompanyColumn}
                  organizationLabelById={organizationLabelById}
                  platformIconBySlug={platformIconBySlug}
                  fefoSettings={fefoSettings}
                  externalSearch={globalSearchQuery}
                  onToast={showToast}
                  returnsTotalInDb={returnsTotalCount}
                  onRowClick={openItemDetail}
                  onRowEdit={openItemEdit}
                  onBulkDeleted={bulkRemoveReturns}
                  onBulkMoved={bulkUpdateReturns}
                />
              </div>
            )}

            {activeTab === "packages" && (
              <div className="relative min-h-0">
                <DatabaseTag table="packages" />
                <PackagesDataTable
                  packages={filteredPackages}
                  returns={visibleReturns}
                  pallets={pallets}
                  role={role}
                  actor={actor}
                  actorProfileId={actorUserId}
                  showCompanyColumn={showCompanyColumn}
                  organizationLabelById={organizationLabelById}
                  externalSearch={globalSearchQuery}
                  storeFilter={storeFilter}
                  storeOptions={storeOptions}
                  onStoreFilterChange={setStoreFilter}
                  onToast={showToast}
                  onRowClick={(p) => openDrawer({ type: "package", record: p })}
                  onRowEdit={(p)  => openDrawer({ type: "package", record: p })}
                  onBulkDeleted={bulkRemovePackages}
                  onBulkPackagesUpdated={bulkUpdatePackages}
                />
              </div>
            )}

            {activeTab === "pallets" && (
              <div className="relative min-h-0">
                <DatabaseTag table="pallets" />
                <PalletsDataTable
                  pallets={visiblePallets}
                  packages={filteredPackages}
                  returns={visibleReturns}
                  role={role}
                  actor={actor}
                  actorProfileId={actorUserId}
                  showCompanyColumn={showCompanyColumn}
                  organizationLabelById={organizationLabelById}
                  externalSearch={globalSearchQuery}
                  storeFilter={storeFilter}
                  storeOptions={storeOptions}
                  onStoreFilterChange={setStoreFilter}
                  onToast={showToast}
                  onRowClick={(p) => openDrawer({ type: "pallet", record: p })}
                  onRowEdit={(p)  => openDrawer({ type: "pallet", record: p })}
                  onBulkDeleted={bulkRemovePallets}
                />
              </div>
            )}
          </>
        )}
      </main>

      {/* ── Right Drawer (portal-based — sidebar is ALWAYS visible) ── */}
      <RightDrawer
        open={!!activeDrawer}
        onClose={closeDrawer}
        onBack={canGoBack ? popDrawer : undefined}
        title={drawerTitle()}
        subtitle={drawerSubtitle()}
      >
        {activeDrawer?.type === "item" && (
          <ItemDrawerContent
            record={activeDrawer.record}
            startInEditMode={activeDrawer.startInEditMode ?? false}
            role={role}
            actor={actor}
            actorProfileId={actorUserId}
            packages={packages}
            pallets={pallets}
            sessionPhotos={sessionPhotos.get(activeDrawer.record.id)}
            onToast={showToast}
            onUpdated={(r) => { updateReturn_(r); openItemDetail(r); }}
            onDeleted={(id) => { removeReturn(id); closeDrawer(); showToast("Return deleted.", "warning"); }}
          />
        )}

        {activeDrawer?.type === "package" && (
          <PackageDrawerContent
            pkg={activeDrawer.record}
            role={role}
            actor={actor}
            actorProfileId={actorUserId}
            openPallets={openPallets}
            allReturns={visibleReturns}
            onClose={closeDrawer}
            onPackageUpdated={(p) => { updatePackage_(p); setDrawerStack((prev) => prev.map((d) => d.type === "package" && d.record.id === p.id ? { type: "package", record: p } : d)); }}
            onItemAdded={(r) => { addReturn(r); showToast(`✓ Item logged — ${r.asin ?? r.fnsku ?? r.sku ?? r.item_name}`); }}
            onReturnAssigned={syncReturnAfterPackageAssignment}
            onReturnRemoved={removeReturn}
            onPackageDeleted={(id) => { removePackage(id); closeDrawer(); showToast("Box deleted.", "warning"); }}
            onOpenItem={(r) => pushDrawer({ type: "item", record: r })}
            onOpenPallet={(plt) => pushDrawer({ type: "pallet", record: plt })}
            showToast={showToast as (msg: string, kind?: ToastKind) => void}
          />
        )}

        {activeDrawer?.type === "pallet" && (
          <PalletDrawerContent
            pallet={activeDrawer.record}
            role={role}
            actor={actor}
            actorProfileId={actorUserId}
            organizationId={activeDrawer.record.organization_id}
            packages={packages}
            allReturns={visibleReturns}
            onClose={closeDrawer}
            onPalletUpdated={updatePallet_}
            onPalletDeleted={(id) => { removePallet(id); closeDrawer(); showToast("Pallet deleted.", "warning"); }}
            onOpenPackage={(p) => pushDrawer({ type: "package", record: p })}
            showToast={showToast as (msg: string, kind?: ToastKind) => void}
          />
        )}
      </RightDrawer>

      {/* ── Modals ── */}
      {wizardOpen && (
        <SingleItemWizardModal
          onClose={() => { setWizardOpen(false); setWizardInherited(undefined); }}
          onSuccess={(r, photos) => { addReturn(r, photos); }}
          actor={actor}
          organizationId={effectiveWriteOrgId}
          actorProfileId={actorUserId}
          openPackages={openPackages}
          openPallets={openPallets}
          existingReturns={visibleReturns}
          onCreatePackage={() => { setWizardOpen(false); setCreatePackageOpen(true); }}
          onCreatePallet={() => { setWizardOpen(false); setCreatePalletOpen(true); }}
          inheritedContext={wizardInherited}
          aiLabelEnabled={orgSettings.is_ai_label_ocr_enabled}
          onSoftPackageWarning={() => showToast("Warning: This item is not on the box's expected list.", "warning")}
          onToast={showToast}
          onNavigateToPackage={(id) => {
            const p = packages.find((x) => x.id === id);
            if (p) {
              setWizardOpen(false);
              setWizardInherited(undefined);
              setActiveTab("packages");
              openDrawer({ type: "package", record: p });
            }
          }}
          onNavigateToPallet={(palletId) => {
            const pl = pallets.find((x) => x.id === palletId);
            if (pl) {
              setWizardOpen(false);
              setWizardInherited(undefined);
              setActiveTab("pallets");
              openDrawer({ type: "pallet", record: pl });
            }
          }}
        />
      )}

      {createPackageOpen && (
        <CreatePackageModal
          onClose={() => setCreatePackageOpen(false)}
          onCreated={(p) => { addPackage(p); setCreatePackageOpen(false); showToast(`Box ${p.package_code} created.`); }}
          actor={actor}
          organizationId={effectiveWriteOrgId}
          actorProfileId={actorUserId}
          openPallets={openPallets}
          aiPackingSlipEnabled={orgSettings.is_ai_packing_slip_ocr_enabled}
        />
      )}

      {createPalletOpen && (
        <CreatePalletModal
          onClose={() => setCreatePalletOpen(false)}
          onCreated={(p) => { addPallet(p); setCreatePalletOpen(false); showToast(`Pallet ${p.pallet_number} created.`); }}
          actor={actor}
          organizationId={effectiveWriteOrgId}
          actorProfileId={actorUserId}
          aiManifestEnabled={orgSettings.is_ai_packing_slip_ocr_enabled}
        />
      )}

      <ToastStack toasts={toasts} />
    </div>
  );
}
