"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

type AllowedStoreRow = {
  store_id: string;
  name: string;
  platform: string;
};

type ReviewTab =
  | "mine"
  | "unassigned"
  | "overdue"
  | "follow_up_due"
  | "quarantine"
  | "escalation"
  | "needs_product_link"
  | "needs_evidence";

const TABS: { id: ReviewTab; label: string; slice: string }[] = [
  { id: "mine", label: "Assigned to me", slice: "" },
  { id: "unassigned", label: "Unassigned", slice: "unassigned" },
  { id: "overdue", label: "Overdue", slice: "overdue" },
  { id: "follow_up_due", label: "Follow-up due", slice: "follow_up_due" },
  { id: "quarantine", label: "Quarantine", slice: "quarantine" },
  { id: "escalation", label: "Escalation", slice: "escalation" },
  { id: "needs_product_link", label: "Needs product link (draft)", slice: "draft_needs_product_link" },
  { id: "needs_evidence", label: "Needs evidence (draft)", slice: "draft_needs_evidence" },
];

type WorkRow = Record<string, unknown> & { id?: string; draft_id?: string };
type PatchStatus =
  | { status: "idle"; action: null; message: null }
  | { status: "running" | "success" | "error"; action: string; message: string | null };

const SAVED_VIEW_STORAGE_KEY = "claim_review_ops_saved_view_v1";

function activeElementAcceptsText(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || (el as HTMLElement).isContentEditable === true;
}

function isUuidish(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function readWorkItemIdFromLocation(): string {
  if (typeof window === "undefined") return "";
  return new URL(window.location.href).searchParams.get("work_item_id")?.trim() ?? "";
}

export function ClaimReviewOperationsClient({
  organizationId,
  defaultStoreId,
}: {
  organizationId: string;
  defaultStoreId: string | null;
}) {
  const searchParams = useSearchParams();
  const urlWorkItemId = (searchParams.get("work_item_id") ?? "").trim();
  const [allowedStores, setAllowedStores] = useState<AllowedStoreRow[]>([]);
  const [storesLoading, setStoresLoading] = useState(true);
  const [storesError, setStoresError] = useState<string | null>(null);
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(defaultStoreId);

  const [tab, setTab] = useState<ReviewTab>("mine");
  const [items, setItems] = useState<WorkRow[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);

  const [verification, setVerification] = useState<Record<string, unknown> | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);

  const [bootstrapPlan, setBootstrapPlan] = useState<Record<string, unknown> | null>(null);
  const [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [bootstrapMsg, setBootstrapMsg] = useState<string | null>(null);
  const [confirmBootstrap, setConfirmBootstrap] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<"bulk_assign" | "bulk_set_priority" | "bulk_quarantine" | "bulk_schedule_follow_up">(
    "bulk_assign",
  );
  const [assigneeId, setAssigneeId] = useState("");
  const [bulkPriority, setBulkPriority] = useState("p2");
  const [bulkQuarantineReason, setBulkQuarantineReason] = useState("");
  const [bulkFollowUpHrs, setBulkFollowUpHrs] = useState(48);
  const [bulkPreview, setBulkPreview] = useState<Record<string, unknown> | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [selectedRowIndex, setSelectedRowIndex] = useState(0);
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);

  const [drawerWorkId, setDrawerWorkId] = useState<string | null>(null);
  const [drawerStoreId, setDrawerStoreId] = useState<string | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [drawerData, setDrawerData] = useState<{
    work_item: Record<string, unknown>;
    draft: Record<string, unknown> | null;
    events: Record<string, unknown>[];
    entitlements: Record<string, unknown>;
  } | null>(null);
  const [patchStatus, setPatchStatus] = useState<PatchStatus>({ status: "idle", action: null, message: null });
  const [drawerAssigneeId, setDrawerAssigneeId] = useState("");
  const [drawerPriority, setDrawerPriority] = useState("p2");
  const [drawerQuarantineReason, setDrawerQuarantineReason] = useState("");
  const [drawerFollowUpHrs, setDrawerFollowUpHrs] = useState(48);
  const [drawerAiJson, setDrawerAiJson] = useState("{}");
  const [handoffNoteText, setHandoffNoteText] = useState("");
  const [handoffToUserId, setHandoffToUserId] = useState("");
  const [copyLinkMsg, setCopyLinkMsg] = useState<string | null>(null);
  const [confirmCloseReview, setConfirmCloseReview] = useState(false);

  const drawerAsideRef = useRef<HTMLElement | null>(null);
  const storesLoadingRef = useRef(storesLoading);
  storesLoadingRef.current = storesLoading;
  const drawerWorkIdRef = useRef(drawerWorkId);
  drawerWorkIdRef.current = drawerWorkId;

  useEffect(() => {
    let cancelled = false;
    setStoresLoading(true);
    setStoresError(null);
    void (async () => {
      try {
        const params = new URLSearchParams({ organization_id: organizationId });
        const res = await fetch(`/api/claims/my-stores?${params.toString()}`, { credentials: "include" });
        const body = (await res.json()) as unknown as Record<string, unknown>;
        if (!res.ok) {
          if (!cancelled) setStoresError(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
          return;
        }
        const raw = body.stores;
        const list: AllowedStoreRow[] = Array.isArray(raw)
          ? (raw as unknown as Record<string, unknown>[]).map((r) => ({
              store_id: String(r.store_id ?? ""),
              name: String(r.name ?? ""),
              platform: String(r.platform ?? ""),
            }))
          : [];
        if (!cancelled) {
          setAllowedStores(list);
          setSelectedStoreId((prev) => {
            if (prev && list.some((s) => s.store_id === prev)) return prev;
            if (defaultStoreId && list.some((s) => s.store_id === defaultStoreId)) return defaultStoreId;
            return list[0]?.store_id ?? null;
          });
        }
      } catch (e) {
        if (!cancelled) setStoresError(e instanceof Error ? e.message : "Failed to load stores");
      } finally {
        if (!cancelled) setStoresLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, defaultStoreId]);

  const storeId = selectedStoreId;

  const loadSummary = useCallback(async () => {
    if (!storeId) return;
    const p = new URLSearchParams({
      organization_id: organizationId,
      store_id: storeId,
      summary: "true",
    });
    const res = await fetch(`/api/claims/review-work-items?${p.toString()}`, { credentials: "include" });
    const body = (await res.json()) as unknown as Record<string, unknown>;
    if (res.ok) setSummary((body.summary as unknown as Record<string, unknown>) ?? null);
  }, [organizationId, storeId]);

  const loadVerification = useCallback(async () => {
    if (!storeId) return;
    setVerifyLoading(true);
    try {
      const p = new URLSearchParams({ organization_id: organizationId, store_id: storeId });
      const res = await fetch(`/api/claims/review-work-items/verification?${p.toString()}`, { credentials: "include" });
      const body = (await res.json()) as unknown as Record<string, unknown>;
      if (!res.ok) {
        setVerification(null);
        return;
      }
      setVerification(body.snapshot as unknown as Record<string, unknown>);
    } finally {
      setVerifyLoading(false);
    }
  }, [organizationId, storeId]);

  const loadItems = useCallback(async () => {
    if (!storeId) return;
    setListLoading(true);
    setListError(null);
    try {
      const p = new URLSearchParams({
        organization_id: organizationId,
        store_id: storeId,
        limit: "50",
      });
      const t = TABS.find((x) => x.id === tab);
      if (tab === "mine") p.set("mine", "true");
      else if (t?.slice) p.set("dashboard_slice", t.slice);

      const res = await fetch(`/api/claims/review-work-items?${p.toString()}`, { credentials: "include" });
      const body = (await res.json()) as unknown as Record<string, unknown>;
      if (!res.ok) {
        setItems([]);
        setListError(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
        return;
      }
      const nextItems = (Array.isArray(body.items) ? body.items : []) as WorkRow[];
      setItems(nextItems);
      setSelectedRowIndex((prev) => Math.min(Math.max(prev, 0), Math.max(0, nextItems.length - 1)));
    } catch (e) {
      setListError(e instanceof Error ? e.message : "List failed");
      setItems([]);
    } finally {
      setListLoading(false);
    }
  }, [organizationId, storeId, tab]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    if (storeId) void loadVerification();
  }, [storeId, loadVerification]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const view = url.searchParams.get("view")?.trim();
    const saved = window.localStorage.getItem(SAVED_VIEW_STORAGE_KEY)?.trim();
    const candidate = view || saved || "";
    if (TABS.some((t) => t.id === candidate)) setTab(candidate as ReviewTab);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SAVED_VIEW_STORAGE_KEY, tab);
    const url = new URL(window.location.href);
    url.searchParams.set("view", tab);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [tab]);

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const runBootstrap = async (dryRun: boolean) => {
    if (!storeId) return;
    setBootstrapLoading(true);
    setBootstrapMsg(null);
    try {
      const res = await fetch("/api/claims/review-work-items/bootstrap", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization_id: organizationId,
          store_id: storeId,
          dry_run: dryRun,
          confirm_execute: dryRun ? false : confirmBootstrap,
        }),
      });
      const body = (await res.json()) as unknown as Record<string, unknown>;
      if (!res.ok) {
        setBootstrapMsg(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
        return;
      }
      setBootstrapPlan((body.plan as unknown as Record<string, unknown>) ?? null);
      const plan = body.plan as { missing_draft_count?: number } | undefined;
      const missingCount = typeof plan?.missing_draft_count === "number" ? plan.missing_draft_count : null;
      setBootstrapMsg(
        dryRun
          ? `Dry-run: ${String(missingCount ?? "?")} work items would be created.`
          : `Created ${String(body.inserted_count ?? 0)} work items; ${String(body.events_inserted ?? 0)} audit events.`,
      );
      void loadVerification();
      void loadSummary();
      void loadItems();
    } finally {
      setBootstrapLoading(false);
    }
  };

  const runBulk = async (execute: boolean) => {
    if (!storeId) return;
    setBulkLoading(true);
    setBulkPreview(null);
    try {
      const res = await fetch("/api/claims/review-work-items/bulk", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization_id: organizationId,
          store_id: storeId,
          bulk_action: bulkAction,
          work_item_ids: [...selectedIds],
          execute,
          confirm_execute: execute ? confirmBulk : false,
          assignee_user_id: bulkAction === "bulk_assign" ? assigneeId.trim() : undefined,
          priority: bulkAction === "bulk_set_priority" ? bulkPriority : undefined,
          quarantine_reason: bulkAction === "bulk_quarantine" ? bulkQuarantineReason : undefined,
          follow_up_interval_hours: bulkAction === "bulk_schedule_follow_up" ? bulkFollowUpHrs : undefined,
        }),
      });
      const body = (await res.json()) as unknown as Record<string, unknown>;
      if (!res.ok) {
        setBulkPreview({ error: body.error });
        return;
      }
      setBulkPreview(body);
      if (execute) {
        setConfirmBulk(false);
        void loadItems();
        void loadSummary();
        void loadVerification();
      }
    } finally {
      setBulkLoading(false);
    }
  };

  const syncWorkItemIdInUrl = useCallback((workItemId: string | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (workItemId) url.searchParams.set("work_item_id", workItemId);
    else url.searchParams.delete("work_item_id");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const buildWorkItemDeepLink = useCallback((workItemId: string): string => {
    if (typeof window === "undefined") return `/claim-engine/review-ops?work_item_id=${encodeURIComponent(workItemId)}`;
    const url = new URL(window.location.href);
    url.pathname = "/claim-engine/review-ops";
    url.searchParams.set("work_item_id", workItemId);
    url.searchParams.set("view", tab);
    return `${url.pathname}${url.search}${url.hash}`;
  }, [tab]);

  const closeDrawer = useCallback((opts?: { syncUrl?: boolean }) => {
    setDrawerWorkId(null);
    setDrawerStoreId(null);
    setDrawerData(null);
    setDrawerError(null);
    setPatchStatus({ status: "idle", action: null, message: null });
    setCopyLinkMsg(null);
    setConfirmCloseReview(false);
    if (opts?.syncUrl !== false) syncWorkItemIdInUrl(null);
  }, [syncWorkItemIdInUrl]);

  const copyDrawerDeepLink = useCallback(async () => {
    if (!drawerWorkId) return;
    const rel = buildWorkItemDeepLink(drawerWorkId);
    const full = typeof window === "undefined" ? rel : `${window.location.origin}${rel}`;
    try {
      await navigator.clipboard.writeText(full);
      setCopyLinkMsg("Copied link.");
    } catch {
      setCopyLinkMsg(full);
    }
  }, [buildWorkItemDeepLink, drawerWorkId]);

  const loadDrawer = useCallback(
    async (
      workItemId: string,
      options?: { deriveStoreFromDetail?: boolean; preservePatchStatus?: boolean; forceStoreId?: string | null },
    ) => {
      if (!storeId && options?.deriveStoreFromDetail !== true) return;
      setDrawerLoading(true);
      setDrawerError(null);
      if (options?.preservePatchStatus !== true) {
        setPatchStatus((prev) => (prev.status === "running" ? prev : { status: "idle", action: null, message: null }));
      }
      try {
        const p = new URLSearchParams({ organization_id: organizationId });
        const scopedStoreId = String(options?.forceStoreId ?? "").trim();
        if (scopedStoreId) p.set("store_id", scopedStoreId);
        else if (storeId && options?.deriveStoreFromDetail !== true) p.set("store_id", storeId);
        const res = await fetch(`/api/claims/review-work-items/${workItemId}?${p.toString()}`, {
          credentials: "include",
        });
        const body = (await res.json()) as unknown as Record<string, unknown>;
        if (!res.ok) {
          setDrawerData(null);
          setDrawerError(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
          return;
        }
        const wi = body.work_item as unknown as Record<string, unknown> | undefined;
        const pr = typeof wi?.priority === "string" ? wi.priority : "p2";
        const detailStoreId = typeof wi?.store_id === "string" ? wi.store_id : "";
        setDrawerStoreId(detailStoreId || null);
        if (detailStoreId && detailStoreId !== storeId && allowedStores.some((s) => s.store_id === detailStoreId)) {
          setSelectedStoreId(detailStoreId);
        }
        setDrawerPriority(pr);
        const assignedTo = typeof wi?.assigned_to === "string" ? wi.assigned_to : "";
        const qReason = typeof wi?.quarantine_reason === "string" ? wi.quarantine_reason : "";
        setDrawerAssigneeId(assignedTo);
        setDrawerQuarantineReason(qReason);
        startTransition(() => {
          setDrawerData({
            work_item: wi ?? {},
            draft: (body.draft as unknown as Record<string, unknown> | null) ?? null,
            events: Array.isArray(body.events) ? (body.events as unknown as Record<string, unknown>[]) : [],
            entitlements: (body.entitlements as unknown as Record<string, unknown>) ?? {},
          });
        });
      } catch (e) {
        setDrawerData(null);
        setDrawerError(e instanceof Error ? e.message : "Failed to load detail");
      } finally {
        setDrawerLoading(false);
      }
    },
    [allowedStores, organizationId, storeId],
  );

  const openDrawer = useCallback(
    (workItemId: string, options?: { deriveStoreFromDetail?: boolean }) => {
      setDrawerWorkId(workItemId);
      syncWorkItemIdInUrl(workItemId);
      void loadDrawer(workItemId, options);
    },
    [loadDrawer, syncWorkItemIdInUrl],
  );

  const patchWorkItem = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      if (!drawerWorkId) return false;
      const actionStoreId = drawerStoreId ?? storeId;
      if (!actionStoreId) {
        setPatchStatus({ status: "error", action, message: "Cannot patch: work item store is not loaded yet." });
        return false;
      }
      setPatchStatus({ status: "running", action, message: null });
      try {
        const res = await fetch(`/api/claims/review-work-items/${drawerWorkId}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organization_id: organizationId,
            store_id: actionStoreId,
            action,
            ...extra,
          }),
        });
        const body = (await res.json()) as unknown as Record<string, unknown>;
        if (!res.ok) {
          setPatchStatus({
            status: "error",
            action,
            message: typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
          });
          return false;
        }
        setPatchStatus({ status: "success", action, message: `${actionLabel(action)} saved.` });
        const wi = body.work_item as unknown as Record<string, unknown> | undefined;
        if (wi && typeof wi.priority === "string") setDrawerPriority(wi.priority);
        void loadDrawer(drawerWorkId, { preservePatchStatus: true, forceStoreId: actionStoreId });
        void loadItems();
        void loadSummary();
        void loadVerification();
        return true;
      } catch (e) {
        setPatchStatus({ status: "error", action, message: e instanceof Error ? e.message : "Patch failed" });
        return false;
      }
    },
    [drawerStoreId, storeId, drawerWorkId, organizationId, loadDrawer, loadItems, loadSummary, loadVerification],
  );

  /** Open drawer from `?work_item_id=` (Next searchParams + same-tab navigation). */
  useEffect(() => {
    if (storesLoading) return;
    const wid = urlWorkItemId;
    if (!wid) return;
    if (!isUuidish(wid)) {
      setListError("Invalid work_item_id in URL.");
      return;
    }
    if (wid !== drawerWorkId) {
      setDrawerWorkId(wid);
      void loadDrawer(wid, { deriveStoreFromDetail: true });
    }
  }, [storesLoading, urlWorkItemId, drawerWorkId, loadDrawer]);

  /** Browser back/forward: keep drawer in sync with the address bar without rewriting history. */
  useEffect(() => {
    const onPop = () => {
      if (storesLoadingRef.current) return;
      const wid = readWorkItemIdFromLocation();
      if (!wid || !isUuidish(wid)) {
        if (drawerWorkIdRef.current) closeDrawer({ syncUrl: false });
        return;
      }
      if (wid !== drawerWorkIdRef.current) {
        setDrawerWorkId(wid);
        void loadDrawer(wid, { deriveStoreFromDetail: true });
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [closeDrawer, loadDrawer]);

  useEffect(() => {
    if (!drawerWorkId) return;
    const t = window.setTimeout(() => drawerAsideRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [drawerWorkId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        if (!activeElementAcceptsText()) {
          e.preventDefault();
          setShowKeyboardHelp((v) => !v);
        }
        return;
      }
      if (e.key === "Escape") {
        if (showKeyboardHelp) {
          e.preventDefault();
          setShowKeyboardHelp(false);
          return;
        }
        if (drawerWorkId) {
          e.preventDefault();
          closeDrawer();
        }
        return;
      }
      if (activeElementAcceptsText()) return;

      if (drawerWorkId) {
        const curIdx = items.findIndex((r) => String(r.id ?? "") === drawerWorkId);
        if (e.key === "r" || e.key === "R") {
          e.preventDefault();
          if (!drawerLoading) void loadDrawer(drawerWorkId, { forceStoreId: drawerStoreId ?? storeId });
          return;
        }
        if ((e.key === "[" || e.key === "{") && curIdx > 0) {
          e.preventDefault();
          const prevId = String(items[curIdx - 1]?.id ?? "");
          if (prevId) openDrawer(prevId);
          setSelectedRowIndex(curIdx - 1);
          return;
        }
        if ((e.key === "]" || e.key === "}") && curIdx >= 0 && curIdx < items.length - 1) {
          e.preventDefault();
          const nextId = String(items[curIdx + 1]?.id ?? "");
          if (nextId) openDrawer(nextId);
          setSelectedRowIndex(curIdx + 1);
          return;
        }
        return;
      }

      if (items.length === 0) return;
      if (e.key === "ArrowDown" || e.key.toLowerCase() === "j") {
        e.preventDefault();
        setSelectedRowIndex((prev) => Math.min(items.length - 1, prev + 1));
        return;
      }
      if (e.key === "ArrowUp" || e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSelectedRowIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        const id = String(items[selectedRowIndex]?.id ?? "");
        if (id) {
          e.preventDefault();
          openDrawer(id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    closeDrawer,
    drawerLoading,
    drawerStoreId,
    drawerWorkId,
    items,
    loadDrawer,
    openDrawer,
    selectedRowIndex,
    showKeyboardHelp,
    storeId,
  ]);

  const tabLabel = useMemo(() => TABS.find((t) => t.id === tab)?.label ?? tab, [tab]);

  return (
    <>
      <div className="mx-auto max-w-[1400px] space-y-6 p-4 text-slate-900 dark:text-slate-100">
      <header className="space-y-1 border-b border-slate-200 pb-4 dark:border-slate-700">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">Claim review operations</h1>
          <Link href="/claim-engine/drafts" className="text-sm text-blue-600 underline dark:text-blue-400">
            Drafts staging
          </Link>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Human-gated bootstrap, bulk actions, and row-level review drawer. No marketplace submission; no promotion to
          legacy claim_candidates.
        </p>
      </header>

      <section className="space-y-2 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Store</h2>
        {storesLoading ? (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading stores…
          </p>
        ) : storesError ? (
          <p className="text-sm text-red-600">{storesError}</p>
        ) : (
          <select
            className="max-w-md rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900"
            value={storeId ?? ""}
            onChange={(e) => setSelectedStoreId(e.target.value || null)}
          >
            {allowedStores.map((s) => (
              <option key={s.store_id} value={s.store_id}>
                {s.name} ({s.platform})
              </option>
            ))}
          </select>
        )}
      </section>

      {storeId && (
        <>
          <section className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Verification</h2>
              <button
                type="button"
                className="rounded border border-slate-300 px-3 py-1 text-xs font-medium dark:border-slate-600"
                onClick={() => void loadVerification()}
                disabled={verifyLoading}
              >
                {verifyLoading ? "Refreshing…" : "Refresh snapshot"}
              </button>
            </div>
            {verification ? (
              <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
                <Stat label="Eligible drafts (bootstrap)" v={num(verification, ["bootstrap_plan", "eligible_draft_count"])} />
                <Stat label="Drafts with work item" v={num(verification, ["bootstrap_plan", "existing_work_item_draft_count"])} />
                <Stat label="Missing work items" v={num(verification, ["bootstrap_plan", "missing_draft_count"])} />
                <Stat label="Work items (store)" v={num(verification, ["work_items_total"])} />
                <Stat label="Duplicate draft_id rows" v={(verification.duplicate_draft_ids as unknown[] | undefined)?.length ?? 0} />
                <Stat label="Events (org-wide count)" v={num(verification, ["events_total_org"])} />
              </div>
            ) : (
              <p className="text-xs text-slate-500">Click refresh to load counts and duplicate check.</p>
            )}
          </section>

          <section className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Bootstrap work items from drafts</h2>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white dark:bg-slate-200 dark:text-slate-900"
                disabled={bootstrapLoading}
                onClick={() => void runBootstrap(true)}
              >
                Dry-run
              </button>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={confirmBootstrap} onChange={(e) => setConfirmBootstrap(e.target.checked)} />
                I confirm creating missing work items for this store
              </label>
              <button
                type="button"
                className="rounded border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
                disabled={bootstrapLoading || !confirmBootstrap}
                onClick={() => void runBootstrap(false)}
              >
                Execute bootstrap
              </button>
            </div>
            {bootstrapMsg && <p className="text-xs text-slate-600 dark:text-slate-400">{bootstrapMsg}</p>}
            {bootstrapPlan && (
              <pre className="max-h-48 overflow-auto rounded bg-slate-50 p-2 text-[10px] dark:bg-slate-900">
                {JSON.stringify(bootstrapPlan, null, 2)}
              </pre>
            )}
          </section>

          <section className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Dashboard</h2>
              <button
                type="button"
                className="text-xs underline"
                onClick={() => {
                  void loadSummary();
                  void loadItems();
                }}
              >
                Refresh list + summary
              </button>
            </div>
            {summary && (
              <div className="flex flex-wrap gap-3 text-xs text-slate-600 dark:text-slate-400">
                <span>Mine open: {num(summary, ["mine_open"])}</span>
                <span>Unassigned: {num(summary, ["unassigned_open"])}</span>
                <span>Overdue: {num(summary, ["overdue_open"])}</span>
                <span>Follow-up due: {num(summary, ["follow_up_due_open"])}</span>
                <span>Quarantine: {num(summary, ["quarantine_open"])}</span>
                <span>Escalation: {num(summary, ["escalation_open"])}</span>
              </div>
            )}
            <div className="flex flex-wrap gap-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`rounded px-2 py-1 text-xs ${tab === t.id ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900" : "border border-slate-200 dark:border-slate-600"}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-500">
              Viewing: {tabLabel}. Keyboard: J/K or arrows move row focus; Enter or Space opens; [ / ] previous/next in
              drawer; R refreshes drawer; ? shortcuts; Escape closes drawer or help.
            </p>
            {listLoading ? (
              <p className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </p>
            ) : listError ? (
              <p className="text-sm text-red-600">{listError}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-600">
                      <th className="p-1">Sel</th>
                      <th className="p-1">Work item</th>
                      <th className="p-1">Draft</th>
                      <th className="p-1">State</th>
                      <th className="p-1">Queue</th>
                      <th className="p-1">Priority</th>
                      <th className="p-1 w-24">Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row, idx) => {
                      const id = String(row.id ?? "");
                      const did = String(row.draft_id ?? "");
                      const isActive = idx === selectedRowIndex;
                      return (
                        <tr
                          key={id || did}
                          className={`border-b border-slate-100 dark:border-slate-800 ${isActive ? "bg-blue-50 dark:bg-blue-950/40" : ""}`}
                          aria-selected={isActive}
                          onClick={() => setSelectedRowIndex(idx)}
                        >
                          <td className="p-1">
                            {id ? (
                              <input
                                type="checkbox"
                                checked={selectedIds.has(id)}
                                onChange={() => toggleId(id)}
                                onClick={(e) => e.stopPropagation()}
                              />
                            ) : null}
                          </td>
                          <td className="font-mono p-1 text-[10px]">{id.slice(0, 8)}…</td>
                          <td className="font-mono p-1 text-[10px]">{did.slice(0, 8)}…</td>
                          <td className="p-1">{String(row.workflow_state ?? "")}</td>
                          <td className="p-1">{String(row.review_queue ?? "")}</td>
                          <td className="p-1">{String(row.priority ?? "")}</td>
                          <td className="p-1">
                            {id ? (
                              <button
                                type="button"
                                className="rounded border border-slate-300 px-2 py-0.5 text-[10px] font-medium dark:border-slate-600"
                                onClick={() => openDrawer(id)}
                              >
                                Open
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Guarded bulk actions</h2>
            <p className="text-xs text-slate-500">Select rows above (max 40). Preview first, then execute with confirmation.</p>
            <div className="flex flex-wrap gap-2 text-xs">
              <select
                className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
                value={bulkAction}
                onChange={(e) => setBulkAction(e.target.value as typeof bulkAction)}
              >
                <option value="bulk_assign">Bulk assign</option>
                <option value="bulk_set_priority">Bulk set priority</option>
                <option value="bulk_quarantine">Bulk quarantine</option>
                <option value="bulk_schedule_follow_up">Bulk schedule follow-up</option>
              </select>
              {bulkAction === "bulk_assign" && (
                <input
                  className="min-w-[200px] rounded border px-2 py-1 font-mono text-[11px]"
                  placeholder="Assignee profile UUID"
                  value={assigneeId}
                  onChange={(e) => setAssigneeId(e.target.value)}
                />
              )}
              {bulkAction === "bulk_set_priority" && (
                <select
                  className="rounded border px-2 py-1"
                  value={bulkPriority}
                  onChange={(e) => setBulkPriority(e.target.value)}
                >
                  {["p0", "p1", "p2", "p3"].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              )}
              {bulkAction === "bulk_quarantine" && (
                <input
                  className="min-w-[240px] flex-1 rounded border px-2 py-1"
                  placeholder="Quarantine reason (required)"
                  value={bulkQuarantineReason}
                  onChange={(e) => setBulkQuarantineReason(e.target.value)}
                />
              )}
              {bulkAction === "bulk_schedule_follow_up" && (
                <label className="flex items-center gap-1">
                  Interval (h)
                  <input
                    type="number"
                    className="w-20 rounded border px-1 py-0.5"
                    min={1}
                    value={bulkFollowUpHrs}
                    onChange={(e) => setBulkFollowUpHrs(Number(e.target.value) || 48)}
                  />
                </label>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded border border-slate-300 px-3 py-1 text-xs dark:border-slate-600"
                disabled={bulkLoading || selectedIds.size === 0}
                onClick={() => void runBulk(false)}
              >
                Preview bulk
              </button>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={confirmBulk} onChange={(e) => setConfirmBulk(e.target.checked)} />
                Confirm execute
              </label>
              <button
                type="button"
                className="rounded bg-amber-700 px-3 py-1 text-xs font-medium text-white"
                disabled={bulkLoading || selectedIds.size === 0 || !confirmBulk}
                onClick={() => void runBulk(true)}
              >
                Execute bulk
              </button>
            </div>
            {bulkPreview && (
              <pre className="max-h-56 overflow-auto rounded bg-slate-50 p-2 text-[10px] dark:bg-slate-900">
                {JSON.stringify(bulkPreview, null, 2)}
              </pre>
            )}
          </section>
        </>
      )}
      </div>

      {drawerWorkId && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" role="presentation">
          <button
            type="button"
            className="h-full flex-1 cursor-default border-0 bg-transparent"
            aria-label="Close drawer"
            onClick={() => closeDrawer()}
          />
          <aside
            ref={drawerAsideRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="claim-review-drawer-title"
            className="flex h-full w-full max-w-lg flex-col border-l border-slate-200 bg-white shadow-xl outline-none dark:border-slate-700 dark:bg-slate-950"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-700">
              <h2 id="claim-review-drawer-title" className="text-sm font-semibold">
                Work item review
              </h2>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => void copyDrawerDeepLink()}
                  disabled={!drawerWorkId}
                >
                  Copy link
                </button>
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => void loadDrawer(drawerWorkId, { forceStoreId: drawerStoreId ?? storeId })}
                  disabled={drawerLoading}
                >
                  {drawerLoading ? (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" /> Refresh
                    </span>
                  ) : (
                    "Refresh"
                  )}
                </button>
                <button type="button" className="text-xs font-medium text-slate-600 dark:text-slate-400" onClick={() => closeDrawer()}>
                  Close
                </button>
              </div>
            </div>
            <div className="relative min-h-0 flex-1 overflow-y-auto p-3 text-xs text-slate-800 dark:text-slate-100">
              {drawerLoading && !drawerData && (
                <p className="flex items-center gap-2 text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading detail…
                </p>
              )}
              {drawerLoading && drawerData && (
                <div
                  className="pointer-events-none absolute inset-0 z-10 flex items-start justify-end bg-white/50 p-2 dark:bg-slate-950/50"
                  aria-live="polite"
                  aria-busy="true"
                >
                  <span className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-600 shadow-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300">
                    <Loader2 className="h-3 w-3 animate-spin" /> Updating…
                  </span>
                </div>
              )}
              {drawerError && <p className="text-red-600">{drawerError}</p>}
              {copyLinkMsg && <p className="mb-2 break-all text-slate-500">{copyLinkMsg}</p>}
              {patchStatus.status !== "idle" && patchStatus.message && (
                <p
                  className={`mb-2 ${patchStatus.status === "error" ? "text-red-600" : "text-slate-600 dark:text-slate-400"}`}
                  role="status"
                  aria-live="polite"
                >
                  {patchStatus.message}
                </p>
              )}
              {drawerData && (
                <ReviewDrawerBody
                  drawerData={drawerData}
                  patchStatus={patchStatus}
                  patchWorkItem={patchWorkItem}
                  drawerAssigneeId={drawerAssigneeId}
                  setDrawerAssigneeId={setDrawerAssigneeId}
                  drawerPriority={drawerPriority}
                  setDrawerPriority={setDrawerPriority}
                  drawerQuarantineReason={drawerQuarantineReason}
                  setDrawerQuarantineReason={setDrawerQuarantineReason}
                  drawerFollowUpHrs={drawerFollowUpHrs}
                  setDrawerFollowUpHrs={setDrawerFollowUpHrs}
                  drawerAiJson={drawerAiJson}
                  setDrawerAiJson={setDrawerAiJson}
                  handoffNoteText={handoffNoteText}
                  setHandoffNoteText={setHandoffNoteText}
                  handoffToUserId={handoffToUserId}
                  setHandoffToUserId={setHandoffToUserId}
                  confirmCloseReview={confirmCloseReview}
                  setConfirmCloseReview={setConfirmCloseReview}
                />
              )}
            </div>
          </aside>
        </div>
      )}
      {showKeyboardHelp && (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-black/30 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowKeyboardHelp(false);
          }}
        >
          <div className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 text-xs shadow-xl dark:border-slate-600 dark:bg-slate-900">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
              <button
                type="button"
                className="text-slate-500 underline"
                onClick={() => setShowKeyboardHelp(false)}
              >
                Close
              </button>
            </div>
            <ul className="space-y-2 text-slate-700 dark:text-slate-300">
              <li>
                <kbd className="rounded border px-1 font-mono">J</kbd> / <kbd className="rounded border px-1 font-mono">↓</kbd>{" "}
                next row
              </li>
              <li>
                <kbd className="rounded border px-1 font-mono">K</kbd> / <kbd className="rounded border px-1 font-mono">↑</kbd>{" "}
                previous row
              </li>
              <li>
                <kbd className="rounded border px-1 font-mono">Enter</kbd> or <kbd className="rounded border px-1 font-mono">Space</kbd>{" "}
                open focused row
              </li>
              <li>
                <kbd className="rounded border px-1 font-mono">[</kbd> / <kbd className="rounded border px-1 font-mono">]</kbd>{" "}
                previous / next work item while drawer is open (current tab list)
              </li>
              <li>
                <kbd className="rounded border px-1 font-mono">R</kbd> refresh drawer (not in text fields)
              </li>
              <li>
                <kbd className="rounded border px-1 font-mono">?</kbd> toggle this panel
              </li>
              <li>
                <kbd className="rounded border px-1 font-mono">Esc</kbd> close help or close drawer
              </li>
            </ul>
            <p className="mt-3 text-[10px] text-slate-500">
              Deep link: append <span className="font-mono">?work_item_id=&lt;uuid&gt;</span> (optional{" "}
              <span className="font-mono">view=</span> tab). Copy link in the drawer copies the full URL.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

function TimelineActorRow({ ev }: { ev: Record<string, unknown> }) {
  const aid = typeof ev.actor_user_id === "string" ? ev.actor_user_id.trim() : "";
  const actor = ev.actor;
  let primary: string;
  let secondary: string;
  let initials: string;

  if (!aid) {
    primary = "System";
    secondary = "No signed-in actor on this event";
    initials = "SYS";
  } else if (actor && typeof actor === "object" && !Array.isArray(actor)) {
    const a = actor as unknown as Record<string, unknown>;
    const name = typeof a.full_name === "string" && a.full_name.trim() ? a.full_name.trim() : "";
    const role = typeof a.role === "string" && a.role.trim() ? a.role.trim() : "";
    primary = name || "Organization member";
    const bits = [role, `id ${aid.slice(0, 8)}…`].filter(Boolean);
    secondary = bits.join(" · ");
    const parts = name.split(/\s+/).filter(Boolean);
    initials =
      parts.length >= 2
        ? `${parts[0]!.charAt(0)}${parts[parts.length - 1]!.charAt(0)}`.toUpperCase()
        : (name.slice(0, 2) || aid.slice(0, 2)).toUpperCase();
  } else {
    primary = "Unknown or removed profile";
    secondary = `actor_user_id ${aid} (no matching profiles row in this org)`;
    initials = aid.slice(0, 2).toUpperCase();
  }

  return (
    <div className="mt-1 flex gap-2">
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[9px] font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-200"
        aria-hidden
      >
        {initials}
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="font-medium text-slate-800 dark:text-slate-100">{primary}</div>
        <div className="break-all text-[9px] text-slate-500">{secondary}</div>
      </div>
    </div>
  );
}

const EventTimelineList = memo(function EventTimelineList({ events }: { events: Record<string, unknown>[] }) {
  return (
    <ul className="max-h-56 space-y-2 overflow-y-auto border border-slate-50 p-2 dark:border-slate-800">
      {events.length === 0 ? (
        <li className="text-[10px] text-slate-500">No events yet.</li>
      ) : (
        events.map((ev, idx) => (
          <li
            key={String(ev.id ?? `ev-${idx}`)}
            className="border-b border-slate-50 pb-2 text-[10px] last:border-0 dark:border-slate-800"
          >
            <div className="flex flex-wrap items-center justify-between gap-1">
              <div className="font-medium">{eventLabel(ev)}</div>
              <div className="shrink-0 text-slate-500">{formatTimestamp(ev.created_at)}</div>
            </div>
            <TimelineActorRow ev={ev} />
            <div className="mt-1 rounded bg-slate-50 p-1 text-[9px] text-slate-600 dark:bg-slate-900 dark:text-slate-400">
              {payloadSummary(ev.payload)}
            </div>
          </li>
        ))
      )}
    </ul>
  );
});

const ReviewDrawerBody = memo(function ReviewDrawerBody({
  drawerData,
  patchStatus,
  patchWorkItem,
  drawerAssigneeId,
  setDrawerAssigneeId,
  drawerPriority,
  setDrawerPriority,
  drawerQuarantineReason,
  setDrawerQuarantineReason,
  drawerFollowUpHrs,
  setDrawerFollowUpHrs,
  drawerAiJson,
  setDrawerAiJson,
  handoffNoteText,
  setHandoffNoteText,
  handoffToUserId,
  setHandoffToUserId,
  confirmCloseReview,
  setConfirmCloseReview,
}: {
  drawerData: {
    work_item: Record<string, unknown>;
    draft: Record<string, unknown> | null;
    events: Record<string, unknown>[];
    entitlements: Record<string, unknown>;
  };
  patchStatus: PatchStatus;
  patchWorkItem: (action: string, extra?: Record<string, unknown>) => Promise<boolean>;
  drawerAssigneeId: string;
  setDrawerAssigneeId: (v: string) => void;
  drawerPriority: string;
  setDrawerPriority: (v: string) => void;
  drawerQuarantineReason: string;
  setDrawerQuarantineReason: (v: string) => void;
  drawerFollowUpHrs: number;
  setDrawerFollowUpHrs: (v: number) => void;
  drawerAiJson: string;
  setDrawerAiJson: (v: string) => void;
  handoffNoteText: string;
  setHandoffNoteText: (v: string) => void;
  handoffToUserId: string;
  setHandoffToUserId: (v: string) => void;
  confirmCloseReview: boolean;
  setConfirmCloseReview: (v: boolean) => void;
}) {
  const wi = drawerData.work_item;
  const draft = drawerData.draft;
  const events = drawerData.events;
  const ent = drawerData.entitlements;
  const taskOk = ent.workflow_task_create === true;
  const repeatOk = ent.repeat_followup === true;
  const slaOk = ent.sla_escalation === true;
  const aiOk = ent.ai_draft === true;

  const btn = "rounded border border-slate-300 px-2 py-1 text-[11px] font-medium dark:border-slate-600 disabled:opacity-40";
  const patchBusy = patchStatus.status === "running";
  const activeAction = patchStatus.status === "running" ? patchStatus.action : null;

  function spin(action: string, busy: string, idle: string) {
    if (activeAction === action) {
      return (
        <span className="inline-flex items-center gap-1">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
          {busy}
        </span>
      );
    }
    return idle;
  }

  return (
    <div className="space-y-4">
      <section className="space-y-1 rounded border border-slate-100 p-2 dark:border-slate-800">
        <h3 className="text-[11px] font-semibold uppercase text-slate-500">Work item</h3>
        <dl className="grid grid-cols-2 gap-x-2 gap-y-1 font-mono text-[10px]">
          <dt className="text-slate-500">id</dt>
          <dd className="break-all">{String(wi.id ?? "")}</dd>
          <dt className="text-slate-500">state</dt>
          <dd>{String(wi.workflow_state ?? "")}</dd>
          <dt className="text-slate-500">queue</dt>
          <dd>{String(wi.review_queue ?? "")}</dd>
          <dt className="text-slate-500">priority</dt>
          <dd>{String(wi.priority ?? "")}</dd>
          <dt className="text-slate-500">assigned_to</dt>
          <dd className="break-all">{String(wi.assigned_to ?? "—")}</dd>
          <dt className="text-slate-500">sla_due_at</dt>
          <dd className="break-all">{String(wi.sla_due_at ?? "—")}</dd>
          <dt className="text-slate-500">next_follow_up_at</dt>
          <dd className="break-all">{String(wi.next_follow_up_at ?? "—")}</dd>
          <dt className="text-slate-500">escalation_level</dt>
          <dd>{String(wi.escalation_level ?? "")}</dd>
          <dt className="text-slate-500">quarantine_reason</dt>
          <dd className="col-span-2 break-words text-[10px]">{String(wi.quarantine_reason ?? "—")}</dd>
        </dl>
      </section>

      {draft && (
        <section className="space-y-1 rounded border border-slate-100 p-2 dark:border-slate-800">
          <h3 className="text-[11px] font-semibold uppercase text-slate-500">Linked draft &amp; projection hints</h3>
          <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-[10px]">
            <dt className="text-slate-500">lifecycle</dt>
            <dd>{String(draft.lifecycle_status ?? "")}</dd>
            <dt className="text-slate-500">evidence</dt>
            <dd>{String(draft.evidence_status ?? "")}</dd>
            <dt className="text-slate-500">claim_family</dt>
            <dd>{String(draft.claim_family ?? "")}</dd>
            <dt className="text-slate-500">sku / asin</dt>
            <dd className="break-all">
              {String(draft.sku ?? "—")} / {String(draft.asin ?? "—")}
            </dd>
            <dt className="text-slate-500">product_id</dt>
            <dd className="break-all">{String(draft.product_id ?? "—")}</dd>
            <dt className="text-slate-500">resolved_product_id</dt>
            <dd className="break-all">{String(draft.resolved_product_id ?? "—")}</dd>
            <dt className="text-slate-500">blockers</dt>
            <dd className="col-span-2 break-words">{fmtJson(draft.blocker_reasons)}</dd>
            <dt className="text-slate-500">recommended_action</dt>
            <dd className="col-span-2 break-words">{String(draft.recommended_action ?? "—")}</dd>
          </dl>
        </section>
      )}

      <section
        className="space-y-2 rounded border border-slate-100 p-2 dark:border-slate-800"
        aria-busy={patchBusy}
        aria-live="polite"
      >
        <h3 className="text-[11px] font-semibold uppercase text-slate-500">Actions (PATCH)</h3>
        {!taskOk && <p className="text-[10px] text-amber-800 dark:text-amber-200">workflow_task_create is off — actions disabled.</p>}
        <div className="flex flex-wrap gap-1">
          <input
            className="min-w-0 flex-1 rounded border px-1 py-0.5 font-mono text-[10px]"
            placeholder="Assignee profile UUID"
            value={drawerAssigneeId}
            onChange={(e) => setDrawerAssigneeId(e.target.value)}
            disabled={!taskOk || patchBusy}
          />
          <button
            type="button"
            className={btn}
            disabled={!taskOk || patchBusy}
            onClick={() => void patchWorkItem("assign", { assignee_user_id: drawerAssigneeId.trim() })}
          >
            {spin("assign", "Assigning…", "Assign")}
          </button>
          <button type="button" className={btn} disabled={!taskOk || patchBusy} onClick={() => void patchWorkItem("unassign")}>
            {spin("unassign", "Unassigning…", "Unassign")}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <label className="text-[10px] text-slate-500">Priority</label>
          <select
            className="rounded border px-1 py-0.5 text-[10px]"
            value={drawerPriority}
            onChange={(e) => setDrawerPriority(e.target.value)}
            disabled={!taskOk || patchBusy}
          >
            {["p0", "p1", "p2", "p3"].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={btn}
            disabled={!taskOk || patchBusy}
            onClick={() => void patchWorkItem("set_priority", { priority: drawerPriority })}
          >
            {spin("set_priority", "Saving…", "Set priority")}
          </button>
          <button type="button" className={btn} disabled={!taskOk || patchBusy} onClick={() => void patchWorkItem("mark_in_review")}>
            {spin("mark_in_review", "Saving…", "Mark in review")}
          </button>
          <button type="button" className={btn} disabled={!taskOk || patchBusy} onClick={() => void patchWorkItem("reset_sla")}>
            {spin("reset_sla", "Resetting…", "Reset SLA")}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <label className="text-[10px] text-slate-500">Follow-up (h)</label>
          <input
            type="number"
            min={1}
            className="w-16 rounded border px-1 py-0.5 text-[10px]"
            value={drawerFollowUpHrs}
            onChange={(e) => setDrawerFollowUpHrs(Number(e.target.value) || 48)}
            disabled={!taskOk || !repeatOk || patchBusy}
          />
          <button
            type="button"
            className={btn}
            disabled={!taskOk || !repeatOk || patchBusy}
            onClick={() => void patchWorkItem("schedule_follow_up", { follow_up_interval_hours: drawerFollowUpHrs })}
          >
            {spin("schedule_follow_up", "Scheduling…", "Schedule follow-up")}
          </button>
          <button
            type="button"
            className={btn}
            disabled={!taskOk || !repeatOk || patchBusy}
            onClick={() => void patchWorkItem("bump_follow_up", { follow_up_interval_hours: drawerFollowUpHrs })}
          >
            {spin("bump_follow_up", "Saving…", "Bump follow-up")}
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          <button type="button" className={btn} disabled={!taskOk || !slaOk || patchBusy} onClick={() => void patchWorkItem("escalate")}>
            {spin("escalate", "Escalating…", "Escalate")}
          </button>
        </div>
        <div className="flex flex-col gap-1">
          <input
            className="rounded border px-1 py-0.5 text-[10px]"
            placeholder="Quarantine reason (required)"
            value={drawerQuarantineReason}
            onChange={(e) => setDrawerQuarantineReason(e.target.value)}
            disabled={!taskOk || patchBusy}
          />
          <button
            type="button"
            className={btn}
            disabled={!taskOk || patchBusy}
            onClick={() => void patchWorkItem("quarantine", { quarantine_reason: drawerQuarantineReason.trim() })}
          >
            {spin("quarantine", "Quarantining…", "Quarantine")}
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          <button type="button" className={btn} disabled={!taskOk || patchBusy} onClick={() => void patchWorkItem("human_override")}>
            {spin("human_override", "Saving…", "Human override")}
          </button>
        </div>
        <div className="space-y-1 border-t border-slate-100 pt-2 dark:border-slate-800">
          <p className="text-[10px] text-slate-500">Operator handoff note (audited; does not change status)</p>
          <textarea
            className="h-20 w-full rounded border bg-slate-50 p-1 text-[10px] dark:bg-slate-900"
            placeholder="Add handoff context, blocker details, or next steps..."
            value={handoffNoteText}
            onChange={(e) => setHandoffNoteText(e.target.value)}
            disabled={!taskOk || patchBusy}
          />
          <input
            className="w-full rounded border px-1 py-0.5 font-mono text-[10px]"
            placeholder="Optional handoff_to profile UUID"
            value={handoffToUserId}
            onChange={(e) => setHandoffToUserId(e.target.value)}
            disabled={!taskOk || patchBusy}
          />
          <button
            type="button"
            className={btn}
            disabled={!taskOk || patchBusy || handoffNoteText.trim().length === 0}
            onClick={() => {
              void patchWorkItem("operator_note", {
                note_text: handoffNoteText.trim(),
                handoff_to_user_id: handoffToUserId.trim() || undefined,
              }).then((ok) => {
                if (ok) {
                  setHandoffNoteText("");
                  setHandoffToUserId("");
                }
              });
            }}
          >
            {spin("operator_note", "Saving note…", "Add note / handoff")}
          </button>
        </div>
        <div className="space-y-1 border-t border-slate-100 pt-2 dark:border-slate-800">
          <p className="text-[10px] text-slate-500">AI suggestion placeholder (requires ai_draft entitlement)</p>
          <textarea
            className="h-16 w-full rounded border bg-slate-50 p-1 font-mono text-[10px] dark:bg-slate-900"
            value={drawerAiJson}
            onChange={(e) => setDrawerAiJson(e.target.value)}
            disabled={!taskOk || !aiOk || patchBusy}
          />
          <button
            type="button"
            className={btn}
            disabled={!taskOk || !aiOk || patchBusy}
            onClick={() => {
              try {
                const parsed = JSON.parse(drawerAiJson || "{}") as unknown as Record<string, unknown>;
                void patchWorkItem("record_ai_placeholder", { ai_classification: parsed });
              } catch {
                /* invalid JSON — ignore */
              }
            }}
          >
            {spin("record_ai_placeholder", "Recording…", "Record AI placeholder")}
          </button>
        </div>
        <div className="space-y-1 border-t border-slate-100 pt-2 dark:border-slate-800">
          <label className="flex items-center gap-2 text-[10px]">
            <input type="checkbox" checked={confirmCloseReview} onChange={(e) => setConfirmCloseReview(e.target.checked)} />
            I confirm closing this review (does not submit to marketplace)
          </label>
          <button
            type="button"
            className={`${btn} border-red-300 text-red-900 dark:border-red-800 dark:text-red-100`}
            disabled={!taskOk || patchBusy || !confirmCloseReview}
            onClick={() => void patchWorkItem("close_review", { confirm_close_review: true })}
          >
            {spin("close_review", "Closing…", "Close review")}
          </button>
        </div>
      </section>

      <section className="space-y-1 rounded border border-slate-100 p-2 dark:border-slate-800">
        <h3 className="text-[11px] font-semibold uppercase text-slate-500">Event timeline</h3>
        <EventTimelineList events={events} />
      </section>
    </div>
  );
});

function fmtJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return String(v);
  }
}

function actionLabel(action: string): string {
  return action
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function eventLabel(ev: Record<string, unknown>): string {
  const payload = ev.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const action = (payload as unknown as Record<string, unknown>).action;
    if (action === "operator_note") return "Operator note / handoff";
  }
  const eventType = String(ev.event_type ?? "");
  if (!eventType) return "Event";
  return actionLabel(eventType);
}

function formatTimestamp(v: unknown): string {
  if (typeof v !== "string" || !v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString();
}

function payloadSummary(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "No payload.";
  const p = payload as unknown as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["action", "from", "to", "priority", "assignee_user_id", "quarantine_reason", "escalation_level", "follow_up_interval_hours", "next_follow_up_at", "note"]) {
    const v = p[key];
    if (v !== null && v !== undefined && String(v).trim() !== "") parts.push(`${key}: ${String(v)}`);
  }
  if (Array.isArray(p.keys) && p.keys.length > 0) parts.push(`keys: ${p.keys.join(", ")}`);
  return parts.length > 0 ? parts.join(" | ") : JSON.stringify(payload);
}

function num(obj: Record<string, unknown>, path: string[]): number {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object" && k in (cur as object)) cur = (cur as unknown as Record<string, unknown>)[k];
    else return 0;
  }
  return typeof cur === "number" ? cur : 0;
}

function Stat({ label, v }: { label: string; v: number }) {
  return (
    <div className="rounded border border-slate-100 p-2 dark:border-slate-800">
      <div className="text-[10px] uppercase text-slate-500">{label}</div>
      <div className="text-lg font-semibold">{v.toLocaleString()}</div>
    </div>
  );
}
