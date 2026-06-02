"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronRight, Inbox, Loader2, ShieldAlert, X } from "lucide-react";

import { ClaimImportPathBanner, ClaimEnginePageShell } from "@/components/claim-engine/ClaimEnginePageShell";
import {
  claimEngineSubTabClass,
  CLAIM_ENGINE_MAIN_CLASS,
} from "@/components/claim-engine/claim-engine-ui";
import { ClaimEvidenceViewer } from "@/components/claims/ClaimEvidenceViewer";
import { ClaimReferenceCandidatesPanel } from "@/components/claims/ClaimReferenceCandidatesPanel";
import { ProductLinkageDisplayBlock } from "@/components/product-linkage/ProductLinkageDisplayBlock";
import type { ProductLinkageDisplayContract } from "@/lib/product-linkage-display-contract";

type AllowedStoreRow = {
  store_id: string;
  name: string;
  platform: string;
  is_active: boolean;
  access_level: string;
  source: string;
  virtual: boolean;
  expires_at: string | null;
};

export type InboxQueueTab =
  | "all"
  | "ready_for_review"
  | "evidence_missing"
  | "needs_product_link"
  | "pim_blocked"
  | "legacy_source_broken"
  | "ineligible_pre_cutoff";

export type InboxListItem = {
  id: string;
  organization_id: string | null;
  store_id: string | null;
  source_table: string | null;
  source_row_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  product_id: string | null;
  resolved_product_id: string | null;
  candidate_status: string | null;
  evidence_status: string | null;
  confidence_score: unknown;
  claim_family: string | null;
  claim_reason: string | null;
  created_at: string | null;
  inbox_queue: string;
  queue_label?: string | null;
  badges: string[];
  lineage_warning_code: string | null;
  lineage_warning_message?: string | null;
  source_lineage_status?: string | null;
  automation_allowed: boolean;
  product_linkage?: ProductLinkageDisplayContract | null;
};

const QUEUE_TABS: { id: InboxQueueTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "ready_for_review", label: "Ready for Review" },
  { id: "evidence_missing", label: "Evidence Missing" },
  { id: "needs_product_link", label: "Needs Product Link" },
  { id: "pim_blocked", label: "PIM Blocked" },
  { id: "legacy_source_broken", label: "Legacy Source Broken" },
  { id: "ineligible_pre_cutoff", label: "Pre-cutoff" },
];

const SOURCE_TABLE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Any source" },
  { value: "amazon_returns", label: "Returns (amazon_returns)" },
  { value: "return_items", label: "Return items (physical scans)" },
  { value: "amazon_removals", label: "Amazon removals" },
  { value: "amazon_removal_shipments", label: "Removal shipments" },
];

const LEGACY_SOURCE_BROKEN_COPY =
  "This claim candidate points to an older Amazon removal source row that no longer exists in the current operational table. The system cannot safely auto-repair the source link. Review or regenerate from current source data instead.";

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t));
}

function whyClaimExists(row: {
  source_table?: string | null;
  claim_family?: string | null;
  claim_reason?: string | null;
}): string {
  const st = (row.source_table ?? "").toLowerCase();
  const family = row.claim_family?.trim();
  const reason = row.claim_reason?.trim();
  const hints: string[] = [];
  if (st === "amazon_returns" || st === "returns" || st === "return_items") hints.push("Return-based");
  else if (st === "amazon_removals" || st === "amazon_removal_shipments") hints.push("Removal / inventory movement");
  else if (st) hints.push(`Source: ${st.replace(/_/g, " ")}`);
  if (family) hints.push(family);
  if (reason) hints.push(reason);
  return hints.length ? hints.join(" · ") : "Claim candidate";
}

function queueLabel(q: string): string {
  const m: Record<string, string> = {
    ready_for_review: "Ready for review",
    evidence_missing: "Evidence missing",
    needs_product_link: "Needs product link",
    pim_blocked: "PIM blocked",
    legacy_source_broken: "Legacy source broken",
    ineligible_pre_cutoff: "Before claim start date",
  };
  return m[q] ?? q.replace(/_/g, " ");
}

function isLegacySourceBroken(row: {
  inbox_queue?: string | null;
  lineage_warning_code?: string | null;
  source_lineage_status?: string | null;
}): boolean {
  return (
    row.inbox_queue === "legacy_source_broken" ||
    row.lineage_warning_code === "stale_or_wrong_source_row_id" ||
    row.source_lineage_status === "legacy_source_broken"
  );
}

function SourceTableBadge({ table }: { table: string | null }) {
  if (!table) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex rounded-md border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200">
      {table}
    </span>
  );
}

function DisabledAction({ label }: { label: string }) {
  return (
    <button
      type="button"
      disabled
      title="Read-only v1."
      className="cursor-not-allowed rounded-lg border border-slate-200 bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-500"
    >
      {label}
    </button>
  );
}

export function ClaimInboxClient({
  organizationId,
  defaultStoreId,
  initialCandidateId = null,
  initialDraftId = null,
}: {
  organizationId: string;
  defaultStoreId: string | null;
  initialCandidateId?: string | null;
  initialDraftId?: string | null;
}) {
  const [allowedStores, setAllowedStores] = useState<AllowedStoreRow[]>([]);
  const [hasVirtualCoverage, setHasVirtualCoverage] = useState(false);
  const [storesReady, setStoresReady] = useState(false);
  const [storesLoading, setStoresLoading] = useState(true);
  const [storesError, setStoresError] = useState<string | null>(null);

  const storeById = useMemo(() => {
    const m = new Map<string, AllowedStoreRow>();
    for (const s of allowedStores) m.set(s.store_id, s);
    return m;
  }, [allowedStores]);

  const allowAllAllowedOption = allowedStores.length > 1 || hasVirtualCoverage;

  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);
  const [queueTab, setQueueTab] = useState<InboxQueueTab>("all");
  const [page, setPage] = useState(1);
  const [scanCursor, setScanCursor] = useState<string | null>(null);
  const [pageSize] = useState(25);
  const [items, setItems] = useState<InboxListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filterSourceTable, setFilterSourceTable] = useState("");
  const [filterEvidenceStatus, setFilterEvidenceStatus] = useState("");
  const [filterClaimFamily, setFilterClaimFamily] = useState("");
  const [filterClaimReason, setFilterClaimReason] = useState("");

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailJson, setDetailJson] = useState<Record<string, unknown> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);

  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceJson, setEvidenceJson] = useState<Record<string, unknown> | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceErr, setEvidenceErr] = useState<string | null>(null);

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
          if (!cancelled) {
            setStoresError(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
            setAllowedStores([]);
            setHasVirtualCoverage(false);
            setStoresReady(true);
          }
          return;
        }
        const raw = body.stores;
        const list: AllowedStoreRow[] = Array.isArray(raw)
          ? (raw as unknown as Record<string, unknown>[]).map((r) => ({
              store_id: String(r.store_id ?? ""),
              name: String(r.name ?? ""),
              platform: String(r.platform ?? ""),
              is_active: r.is_active !== false,
              access_level: String(r.access_level ?? "view"),
              source: String(r.source ?? ""),
              virtual: r.virtual === true,
              expires_at: typeof r.expires_at === "string" ? r.expires_at : null,
            }))
          : [];
        const virtual = body.has_virtual_coverage === true;
        if (cancelled) return;
        setAllowedStores(list);
        setHasVirtualCoverage(virtual);
        setStoresReady(true);

        const allowAll = list.length > 1 || virtual;
        if (list.length === 0) {
          setSelectedStoreId(null);
        } else if (!allowAll) {
          setSelectedStoreId(list[0]?.store_id ?? null);
        } else if (defaultStoreId && list.some((s) => s.store_id === defaultStoreId)) {
          setSelectedStoreId(defaultStoreId);
        } else {
          setSelectedStoreId(null);
        }
      } catch (e) {
        if (!cancelled) {
          setStoresError(e instanceof Error ? e.message : "Failed to load store access");
          setAllowedStores([]);
          setHasVirtualCoverage(false);
          setStoresReady(true);
        }
      } finally {
        if (!cancelled) setStoresLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, defaultStoreId]);

  const fetchList = useCallback(async () => {
    if (!storesReady) {
      return;
    }
    if (allowedStores.length === 0 && !hasVirtualCoverage) {
      setLoading(false);
      setItems([]);
      setNextCursor(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      organization_id: organizationId,
      pageSize: String(pageSize),
    });
    if (selectedStoreId) params.set("store_id", selectedStoreId);
    if (queueTab !== "all") params.set("queue", queueTab);
    if (filterSourceTable) params.set("source_table", filterSourceTable);
    if (filterEvidenceStatus) params.set("evidence_status", filterEvidenceStatus);
    if (filterClaimFamily.trim()) params.set("claim_family", filterClaimFamily.trim());
    if (filterClaimReason.trim()) params.set("claim_reason", filterClaimReason.trim());
    if (queueTab !== "all") {
      if (scanCursor) params.set("cursor", scanCursor);
    } else {
      params.set("page", String(page));
    }

    try {
      const res = await fetch(`/api/claims/inbox?${params.toString()}`, { credentials: "include" });
      const body = (await res.json()) as unknown as Record<string, unknown>;
      if (!res.ok) {
        setItems([]);
        setNextCursor(null);
        setError(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
        return;
      }
      const rawItems = body.items;
      setItems(Array.isArray(rawItems) ? (rawItems as InboxListItem[]) : []);
      setNextCursor(typeof body.next_cursor === "string" ? body.next_cursor : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      setItems([]);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  }, [
    organizationId,
    pageSize,
    selectedStoreId,
    queueTab,
    page,
    scanCursor,
    filterSourceTable,
    filterEvidenceStatus,
    filterClaimFamily,
    filterClaimReason,
    storesReady,
    allowedStores.length,
    hasVirtualCoverage,
  ]);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  const resetPagination = () => {
    setPage(1);
    setScanCursor(null);
  };

  const openDetail = (id: string) => {
    setDetailId(id);
    setDetailJson(null);
    setDetailErr(null);
    setEvidenceOpen(false);
    setEvidenceJson(null);
    setEvidenceErr(null);
    setDetailLoading(true);
    void fetch(`/api/claims/inbox/${encodeURIComponent(id)}?organization_id=${encodeURIComponent(organizationId)}`, {
      credentials: "include",
    })
      .then(async (res) => {
        const j = (await res.json()) as unknown as Record<string, unknown>;
        if (!res.ok) {
          setDetailErr(typeof j.error === "string" ? j.error : `HTTP ${res.status}`);
          return;
        }
        setDetailJson(j);
      })
      .catch((e) => setDetailErr(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setDetailLoading(false));
  };

  useEffect(() => {
    if (!initialCandidateId) return;
    openDetail(initialCandidateId);
    // Deep-link only on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadEvidence = useCallback(() => {
    if (!detailId) return;
    setEvidenceLoading(true);
    setEvidenceErr(null);
    void fetch(
      `/api/claims/inbox/${encodeURIComponent(detailId)}/evidence-graph?organization_id=${encodeURIComponent(organizationId)}&include_persisted_edges=true`,
      { credentials: "include" },
    )
      .then(async (res) => {
        const j = (await res.json()) as unknown as Record<string, unknown>;
        if (!res.ok) {
          setEvidenceErr(typeof j.error === "string" ? j.error : `HTTP ${res.status}`);
          return;
        }
        setEvidenceJson(j);
      })
      .catch((e) => setEvidenceErr(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setEvidenceLoading(false));
  }, [detailId, organizationId]);

  const projection = detailJson?.projection as unknown as Record<string, unknown> | undefined;
  const legacyAlert = isLegacySourceBroken({
    inbox_queue: typeof projection?.inbox_queue === "string" ? projection.inbox_queue : null,
    lineage_warning_code: typeof projection?.lineage_warning_code === "string" ? projection.lineage_warning_code : null,
  });
  const candidate = (detailJson?.candidate as unknown as Record<string, unknown> | undefined) ?? null;

  const noStoreAccess = storesReady && !storesError && allowedStores.length === 0 && !hasVirtualCoverage;

  return (
    <>
      <main className={CLAIM_ENGINE_MAIN_CLASS}>
        <ClaimEnginePageShell
          showHub={false}
          title="Import / Amazon candidate inbox"
          description="Review claim_candidates from imports, removals, and legacy generators. Read-only in v1 — not the warehouse physical-scan path."
          aside={[
            { href: "/returns/claims", label: "Physical-scan draft pool" },
            { href: "/claim-engine", label: "Submission queue" },
          ]}
        >
          <ClaimImportPathBanner />
          {initialDraftId ? (
            <p className="text-xs text-muted-foreground">
              <Link
                href={`/claim-engine/evidence?draft_id=${encodeURIComponent(initialDraftId)}`}
                className="font-medium text-emerald-700 underline dark:text-emerald-300"
              >
                Open persisted evidence for draft {initialDraftId.slice(0, 8)}…
              </Link>
            </p>
          ) : null}
          {storesLoading || !storesReady ? (
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-6 text-center text-sm text-muted-foreground dark:border-slate-800 dark:bg-slate-950">
              Loading store access…
            </div>
          ) : storesError ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
              Could not load store access: {storesError}
            </div>
          ) : noStoreAccess ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200">
              No store access assigned. Ask an admin to grant store access.
            </div>
          ) : (
            <>
              {allowAllAllowedOption && selectedStoreId === null && allowedStores.length > 0 ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
                  All allowed stores — results are not filtered to a single marketplace location. (Administrators may see
                  every store in the organization in this view.)
                </div>
              ) : null}

              {queueTab === "legacy_source_broken" ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
                  <div className="flex gap-2">
                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <p className="font-semibold">Legacy source broken queue</p>
                      <p className="mt-1">
                        These rows have stale Amazon removal lineage. Automation and source repair are disabled; use this
                        queue to isolate historical candidates before reviewing or regenerating from current source rows.
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
                  Store
                  <select
                    value={selectedStoreId ?? ""}
                    disabled={storesLoading || !!storesError || (allowedStores.length === 0 && !hasVirtualCoverage)}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSelectedStoreId(v === "" ? null : v);
                      resetPagination();
                    }}
                    className="min-w-[12rem] rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900"
                  >
                    {allowAllAllowedOption ? <option value="">All allowed stores</option> : null}
                    {allowedStores.map((s) => (
                      <option key={s.store_id} value={s.store_id}>
                        {s.name}
                        {s.platform ? ` (${s.platform})` : ""}
                        {!s.is_active ? " — inactive" : ""}
                      </option>
                    ))}
                  </select>
                </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              Source table
              <select
                value={filterSourceTable}
                onChange={(e) => {
                  setFilterSourceTable(e.target.value);
                  resetPagination();
                }}
                className="min-w-[10rem] rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
              >
                {SOURCE_TABLE_OPTIONS.map((opt) => (
                  <option key={opt.value || "any"} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              Evidence status
              <input
                value={filterEvidenceStatus}
                onChange={(e) => setFilterEvidenceStatus(e.target.value)}
                onBlur={() => resetPagination()}
                placeholder="e.g. missing"
                className="w-36 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              Claim family (exact)
              <input
                value={filterClaimFamily}
                onChange={(e) => setFilterClaimFamily(e.target.value)}
                onBlur={() => resetPagination()}
                className="w-40 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              Claim reason (exact)
              <input
                value={filterClaimReason}
                onChange={(e) => setFilterClaimReason(e.target.value)}
                onBlur={() => resetPagination()}
                className="min-w-[8rem] flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900 sm:max-w-xs"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-950/80">
            {QUEUE_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setQueueTab(t.id);
                  resetPagination();
                }}
                className={claimEngineSubTabClass(queueTab === t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {error ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100">
              {error}
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
            <table className="min-w-[960px] w-full border-collapse text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/80">
                <tr className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Why / type</th>
                  <th className="px-3 py-2">Queue</th>
                  <th className="px-3 py-2">Store</th>
                  <th className="px-3 py-2">Identifiers</th>
                  <th className="px-3 py-2">Evidence</th>
                  <th className="px-3 py-2">Confidence</th>
                  <th className="px-3 py-2">Created</th>
                  <th className="px-3 py-2">Flags</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-12 text-center text-slate-500">
                      <Loader2 className="mx-auto h-6 w-6 animate-spin text-sky-500" />
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                      <p>No candidates in this view.</p>
                      {filterSourceTable === "returns" ? (
                        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                          The legacy label &quot;returns&quot; does not match stored{" "}
                          <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">source_table</code> values — use{" "}
                          <strong>Returns (amazon_returns)</strong> instead.
                        </p>
                      ) : filterSourceTable ? (
                        <p className="mt-2 text-xs">
                          No rows with source_table = <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">{filterSourceTable}</code>.
                        </p>
                      ) : null}
                    </td>
                  </tr>
                ) : (
                  items.map((row) => {
                    const st = row.store_id ? storeById.get(row.store_id) : null;
                    const legacyRow = isLegacySourceBroken(row);
                    return (
                      <tr
                        key={row.id}
                        className="cursor-pointer border-b border-slate-100 hover:bg-slate-50 dark:border-slate-800/80 dark:hover:bg-slate-900/60"
                        onClick={() => openDetail(row.id)}
                      >
                        <td className="px-3 py-2 align-top">
                          <SourceTableBadge table={row.source_table} />
                        </td>
                        <td className="max-w-[220px] px-3 py-2 align-top text-[11px] text-slate-700 dark:text-slate-200">
                          <div className="line-clamp-2">{whyClaimExists(row)}</div>
                          {row.claim_family || row.claim_reason ? (
                            <div className="mt-1 text-[10px] text-muted-foreground">
                              {[row.claim_family, row.claim_reason].filter(Boolean).join(" · ")}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 align-top text-[11px]">
                          <div>{row.queue_label ?? queueLabel(row.inbox_queue)}</div>
                          {legacyRow ? (
                            <div className="mt-1 max-w-[12rem] text-[10px] leading-snug text-amber-700 dark:text-amber-200">
                              Stale source link · no auto-repair
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 align-top text-[11px]">
                          {st ? st.name : row.store_id ? `${row.store_id.slice(0, 8)}…` : "—"}
                        </td>
                        <td className="px-3 py-2 align-top text-[10px] text-slate-700 dark:text-slate-200">
                          {row.product_linkage ? (
                            <ProductLinkageDisplayBlock
                              linkage={row.product_linkage}
                              organizationId={organizationId}
                              compact
                              showPimLink={false}
                            />
                          ) : (
                            <>
                              <div>SKU {row.sku ?? "—"}</div>
                              <div>FNSKU {row.fnsku ?? "—"}</div>
                              <div>ASIN {row.asin ?? "—"}</div>
                              <div className="text-muted-foreground">
                                Resolved {row.resolved_product_id ?? "—"}
                              </div>
                            </>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top text-[11px]">{row.evidence_status ?? "—"}</td>
                        <td className="px-3 py-2 align-top text-[11px]">
                          {row.confidence_score != null ? String(row.confidence_score) : "—"}
                        </td>
                        <td className="px-3 py-2 align-top text-[11px] text-muted-foreground">{formatWhen(row.created_at)}</td>
                        <td className="px-3 py-2 align-top">
                          <div className="flex flex-wrap items-center gap-1">
                            {row.badges?.includes("conflict") ? (
                              <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[10px] text-amber-800 dark:text-amber-100">
                                Conflict
                              </span>
                            ) : null}
                            {legacyRow ? (
                              <span
                                className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[10px] text-amber-800 dark:text-amber-100"
                                title={row.lineage_warning_message ?? LEGACY_SOURCE_BROKEN_COPY}
                              >
                                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                                Legacy broken
                              </span>
                            ) : null}
                            {!row.automation_allowed ? (
                              <span className="text-[10px] text-muted-foreground" title="Automation not allowed for this row">
                                No auto
                              </span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">{queueTab === "all" ? `Page ${page}` : "Scan mode (forward only)"}</p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={loading || (queueTab === "all" ? page <= 1 : true)}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs disabled:opacity-40 dark:border-slate-700"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={loading || !nextCursor}
                onClick={() => {
                  if (queueTab === "all") setPage((p) => p + 1);
                  else setScanCursor(nextCursor);
                }}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs disabled:opacity-40 dark:border-slate-700"
              >
                Next
              </button>
            </div>
          </div>
          {queueTab !== "all" ? (
            <p className="text-[10px] text-muted-foreground">
              Filtered queues use server scan cursors (forward pagination only in v1).
            </p>
          ) : null}
            </>
          )}
        </ClaimEnginePageShell>
      </main>

      {detailId ? (
        <div className="fixed inset-0 z-[600] flex justify-end">
          <button type="button" className="absolute inset-0 bg-black/50" aria-label="Close" onClick={() => setDetailId(null)} />
          <aside className="relative z-10 flex h-full w-full max-w-md animate-in slide-in-from-right flex-col border-l border-slate-200 bg-white shadow-2xl duration-200 dark:border-slate-800 dark:bg-slate-950 sm:max-w-2xl">
            <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">Candidate detail</p>
                <p className="truncate font-mono text-[10px] text-muted-foreground">{detailId}</p>
              </div>
              <button
                type="button"
                onClick={() => setDetailId(null)}
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {detailLoading ? (
                <Loader2 className="mx-auto h-6 w-6 animate-spin text-sky-500" />
              ) : detailErr ? (
                <p className="text-sm text-rose-600">{detailErr}</p>
              ) : detailJson ? (
                <div className="space-y-4 text-sm">
                  {legacyAlert ? (
                    <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-50">
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <p className="font-semibold">Legacy source broken</p>
                        <p className="mt-1">{LEGACY_SOURCE_BROKEN_COPY}</p>
                        <p className="mt-1">Automation, claim submission, and source repair are disabled for this row.</p>
                      </div>
                    </div>
                  ) : null}

                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Summary</h3>
                    <dl className="mt-2 space-y-1 text-xs">
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Why this claim exists</dt>
                        <dd className="max-w-[70%] text-right text-slate-800 dark:text-slate-100">
                          {candidate ? whyClaimExists(candidate) : "—"}
                        </dd>
                      </div>
                      {candidate?.source_table != null ? (
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Source table</dt>
                          <dd>
                            <SourceTableBadge table={String(candidate.source_table)} />
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </section>

                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Product identity</h3>
                    {detailJson.product_linkage &&
                    typeof detailJson.product_linkage === "object" ? (
                      <div className="mt-2">
                        <ProductLinkageDisplayBlock
                          linkage={detailJson.product_linkage as ProductLinkageDisplayContract}
                          organizationId={organizationId}
                        />
                      </div>
                    ) : null}
                    <ul className="mt-2 space-y-2 text-xs">
                      {(Array.isArray(detailJson.product_badges) ? detailJson.product_badges : []).map((p, i) => {
                        const row = p as unknown as Record<string, unknown>;
                        return (
                          <li
                            key={i}
                            className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900/60"
                          >
                            <span className="font-medium">{String(row.title ?? row.seller_sku ?? row.id ?? "Product")}</span>
                            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                              {[row.asin, row.fnsku, row.seller_sku].filter(Boolean).join(" · ") || String(row.id ?? "")}
                            </div>
                          </li>
                        );
                      })}
                      {Array.isArray(detailJson.product_badges) && detailJson.product_badges.length === 0 ? (
                        <li className="text-muted-foreground">No product rows loaded.</li>
                      ) : null}
                    </ul>
                  </section>

                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Resolver status</h3>
                    <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-2 text-[10px] dark:border-slate-700 dark:bg-slate-900">
                      {JSON.stringify(detailJson.projection ?? {}, null, 2)}
                    </pre>
                  </section>

                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Lineage</h3>
                    <pre className="mt-2 max-h-32 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-2 text-[10px] dark:border-slate-700 dark:bg-slate-900">
                      {JSON.stringify(detailJson.lineage_warning ?? null, null, 2)}
                    </pre>
                  </section>

                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Related submissions</h3>
                    <pre className="mt-2 max-h-32 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-2 text-[10px] dark:border-slate-700 dark:bg-slate-900">
                      {JSON.stringify(detailJson.related_submissions ?? {}, null, 2)}
                    </pre>
                  </section>

                  <section className="flex flex-wrap gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
                    <DisabledAction label="Submit Claim" />
                    <DisabledAction label="Mark Reviewed" />
                    <DisabledAction label="Link Product" />
                    <DisabledAction label="Repair Source" />
                  </section>

                  <button
                    type="button"
                    onClick={() => {
                      const next = !evidenceOpen;
                      setEvidenceOpen(next);
                      if (next && !evidenceJson && !evidenceLoading) void loadEvidence();
                    }}
                    className="flex w-full items-center gap-1 text-left text-xs font-semibold text-sky-600 dark:text-sky-400"
                  >
                    <ChevronRight className={`h-4 w-4 shrink-0 transition ${evidenceOpen ? "rotate-90" : ""}`} />
                    Evidence graph (persisted + live preview)
                  </button>
                  {evidenceOpen ? (
                    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-700 dark:bg-slate-900/60">
                      <ClaimReferenceCandidatesPanel
                        organizationId={organizationId}
                        claimCandidateId={detailId}
                        draftId={
                          typeof evidenceJson?.draft_id === "string"
                            ? evidenceJson.draft_id
                            : undefined
                        }
                      />
                      {evidenceLoading ? (
                        <Loader2 className="h-5 w-5 animate-spin text-sky-500" />
                      ) : evidenceErr ? (
                        <p className="text-rose-600">{evidenceErr}</p>
                      ) : evidenceJson ? (
                        <ClaimEvidenceViewer payload={evidenceJson} organizationId={organizationId} />
                      ) : (
                        <p className="text-muted-foreground">No evidence loaded.</p>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
