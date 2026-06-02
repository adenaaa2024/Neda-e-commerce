"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, FolderPlus, Loader2 } from "lucide-react";

import { ClaimCaseBuilderPanel } from "@/components/claim-engine/ClaimCaseBuilderPanel";
import { ClaimEngineEmptyState } from "@/components/claim-engine/ClaimEngineEmptyState";
import { ClaimEnginePageShell } from "@/components/claim-engine/ClaimEnginePageShell";
import { ClaimFlowBadge } from "@/components/claim-engine/ClaimFlowBadge";
import { ClaimSourceBadge } from "@/components/claim-engine/ClaimSourceBadge";
import {
  CLAIM_ENGINE_BTN_PRIMARY,
  CLAIM_ENGINE_CARD_CLASS,
  CLAIM_ENGINE_FILTER_TAB_ACTIVE,
  CLAIM_ENGINE_FILTER_TAB_IDLE,
  CLAIM_ENGINE_INPUT_CLASS,
  CLAIM_ENGINE_SECTION_CLASS,
  CLAIM_ENGINE_STICKY_ACTION_BAR_CLASS,
  CLAIM_ENGINE_TABLE_CLASS,
  CLAIM_ENGINE_TABLE_HEAD_CLASS,
  CLAIM_ENGINE_TABLE_ROW_CLASS,
} from "@/components/claim-engine/claim-engine-ui";
import { claimEligibilityReasonLabel } from "@/lib/claim-eligibility-policy";
import { useUserRole } from "../../../components/UserRoleContext";
import { claimFlowStageHint, type ClaimFlowStage } from "../../../lib/claim-flow-status-badges";
import {
  clusterRowsByManualDimension,
  evaluateManualDraftEligibility,
  type ManualGroupingDimension,
} from "../../../lib/returns-manual-claim-grouping";
import type { ReturnsClaimQueueRow, ReturnsClaimQueueState } from "../../../lib/returns-claims-work-queue";
import { CLAIM_DEFECT_LABELS } from "../claim-condition-labels";
import {
  createManualReturnsClaimDraft,
  listAmazonReturnsImportReferences,
  type ListAmazonReturnsReferenceResult,
} from "../returns-manual-claim-grouping-actions";
import {
  listReturnsClaimsWorkQueue,
  type ListReturnsClaimsWorkQueueResult,
} from "../returns-claims-work-queue-actions";

const STATE_TABS: { id: "all" | ReturnsClaimQueueState; label: string }[] = [
  { id: "all", label: "All" },
  { id: "eligible", label: "Eligible" },
  { id: "missing_evidence", label: "Missing evidence" },
  { id: "needs_product_resolution", label: "Needs product" },
  { id: "held_until_package_closed", label: "Package hold" },
  { id: "pre_cutoff", label: "Pre-cutoff" },
];

const GROUPING_OPTIONS: { id: ManualGroupingDimension; label: string }[] = [
  { id: "issue", label: "Issue" },
  { id: "product", label: "Product" },
  { id: "order", label: "Order" },
  { id: "package", label: "Package" },
  { id: "pallet", label: "Pallet" },
];

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(t));
}

function rowToManualInput(row: ReturnsClaimQueueRow) {
  return {
    return_item_id: row.return_item_id,
    organization_id: row.organization_id,
    store_id: row.store_id,
    package_id: row.package_id,
    pallet_id: row.pallet_id ?? null,
    expected_item_id: row.expected_item_id ?? null,
    conditions: row.conditions,
    photo_evidence: row.photo_evidence,
    resolved_product_id: row.resolved_product_id,
    resolved_catalog_product_id: row.resolved_catalog_product_id,
    order_id: row.order_id,
    sku: row.sku,
    created_at: row.created_at,
  };
}

export function ReturnsClaimsWorkQueueClient() {
  const { actorUserId, organizationId, role } = useUserRole();
  const [activeTab, setActiveTab] = useState<"all" | ReturnsClaimQueueState>("all");
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const hasLoadedOnceRef = useRef(false);
  const [result, setResult] = useState<ListReturnsClaimsWorkQueueResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupingDimension, setGroupingDimension] = useState<ManualGroupingDimension>("issue");
  const [creating, setCreating] = useState(false);
  const [caseBuilderOpen, setCaseBuilderOpen] = useState(false);
  const [draftMessage, setDraftMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [references, setReferences] = useState<ListAmazonReturnsReferenceResult | null>(null);

  const tenantQuery = useMemo(
    () => ({
      actorProfileId: actorUserId,
      filterOrganizationId: role === "super_admin" ? organizationId : undefined,
    }),
    [actorUserId, organizationId, role],
  );

  const load = useCallback(async () => {
    if (!hasLoadedOnceRef.current) setInitialLoading(true);
    else setRefreshing(true);
    const res = await listReturnsClaimsWorkQueue(tenantQuery);
    setResult(res);
    setInitialLoading(false);
    setRefreshing(false);
    hasLoadedOnceRef.current = true;
  }, [tenantQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = result?.rows ?? [];
  const filtered =
    activeTab === "all" ? rows : rows.filter((r) => r.queue_state === activeTab);

  const canSelectRow = useCallback(
    (row: ReturnsClaimQueueRow) => {
      if (!result?.returns_domain_enabled || !result.claim_policy) return false;
      return evaluateManualDraftEligibility(row, result.claim_policy, {
        workflow: result.effective_claim_settings?.workflow,
      }).allowed;
    },
    [result?.returns_domain_enabled, result?.claim_policy, result?.effective_claim_settings],
  );

  const selectedRows = useMemo(
    () => rows.filter((r) => selectedIds.has(r.return_item_id)),
    [rows, selectedIds],
  );

  const tabCounts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const t of STATE_TABS) {
      if (t.id !== "all") c[t.id] = rows.filter((r) => r.queue_state === t.id).length;
    }
    return c;
  }, [rows]);

  const suggestedGroups = useMemo(() => {
    if (!selectedRows.length) return [];
    return [...clusterRowsByManualDimension(selectedRows.map(rowToManualInput), groupingDimension).entries()].map(
      ([key, items]) => ({ key, count: items.length, ids: items.map((i) => i.return_item_id) }),
    );
  }, [selectedRows, groupingDimension]);

  const loadReferences = useCallback(async () => {
    const orderIds = selectedRows.map((r) => r.order_id).filter(Boolean) as string[];
    const skus = selectedRows.map((r) => r.sku).filter(Boolean) as string[];
    if (!orderIds.length && !skus.length) {
      setReferences(null);
      return;
    }
    const res = await listAmazonReturnsImportReferences({
      order_ids: orderIds,
      skus,
      tenant: tenantQuery,
    });
    setReferences(res);
  }, [selectedRows, tenantQuery]);

  useEffect(() => {
    void loadReferences();
  }, [loadReferences]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllEligible = () => {
    setSelectedIds(new Set(rows.filter(canSelectRow).map((r) => r.return_item_id)));
  };

  const clearSelection = () => setSelectedIds(new Set());

  const createDraft = async (ids: string[], dimension: ManualGroupingDimension = groupingDimension) => {
    setCreating(true);
    setDraftMessage(null);
    const res = await createManualReturnsClaimDraft(ids, {
      grouping_dimension: dimension,
      actorProfileId: actorUserId,
      tenant: tenantQuery,
    });
    setCreating(false);
    if (res.ok) {
      setDraftMessage({
        ok: true,
        text: `Draft case ${res.claim_case_id?.slice(0, 8)}… — ${res.attached_line_count} return_item line(s)${res.created_case ? " (new)" : " (existing)"}.`,
      });
      setCaseBuilderOpen(false);
      void load();
      clearSelection();
    } else {
      setDraftMessage({ ok: false, text: res.error ?? "Failed to create draft." });
    }
    return res;
  };

  const splitAndCreate = async (dimension: ManualGroupingDimension) => {
    const groups = [...clusterRowsByManualDimension(selectedRows.map(rowToManualInput), dimension).values()];
    setCreating(true);
    let okCount = 0;
    for (const group of groups) {
      const ids = group.map((i) => i.return_item_id);
      const res = await createManualReturnsClaimDraft(ids, {
        grouping_dimension: dimension,
        actorProfileId: actorUserId,
        tenant: tenantQuery,
      });
      if (res.ok) okCount += 1;
      else {
        setDraftMessage({ ok: false, text: res.error ?? "Split create failed." });
        setCreating(false);
        return;
      }
    }
    setCreating(false);
    setCaseBuilderOpen(false);
    setDraftMessage({ ok: true, text: `Created ${okCount} case(s) from split by ${dimension}.` });
    void load();
    clearSelection();
  };

  const openCaseBuilder = () => {
    if (!selectedIds.size) return;
    setCaseBuilderOpen(true);
  };

  const removeFromSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  return (
    <ClaimEnginePageShell
      title="Draft pool"
      description="Physical-scan return items eligible for claims. Select items and use the case builder to group them into claim cases."
    >
      <div id="case-builder" className="scroll-mt-24" />
      <ClaimCaseBuilderPanel
        open={caseBuilderOpen}
        rows={selectedRows}
        policy={result?.claim_policy}
        effectiveSettings={result?.effective_claim_settings}
        creating={creating}
        onClose={() => setCaseBuilderOpen(false)}
        onConfirmMixed={() => void createDraft([...selectedIds])}
        onSplitAndCreate={(d) => void splitAndCreate(d)}
        onRemoveRow={removeFromSelection}
      />

      {result && !result.returns_domain_enabled ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/20 dark:text-amber-100">
          <strong>Returns module is disabled</strong> in claim policy. Enable Returns under Settings → Claim Engine →
          module scope before creating draft cases.
        </div>
      ) : null}

      {result?.policy_summary ? (
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>
            Scan go-live:{" "}
            <strong className="text-foreground">{result.policy_summary.scan_go_live_date ?? "not set"}</strong>
          </span>
          <span>
            Claim start:{" "}
            <strong className="text-foreground">{result.policy_summary.claim_start_date ?? "not set"}</strong>
          </span>
          <span>
            Window:{" "}
            <strong className="text-foreground">{result.policy_summary.claim_eligibility_window_days ?? 90}d</strong>
          </span>
          <span>
            Grouping:{" "}
            <strong className="text-foreground">{result.claim_policy?.claim_grouping_policy ?? "single_item"}</strong>
          </span>
          <span>
            Queue rows: <strong className="text-foreground">{result.stats.queue_rows}</strong>
          </span>
          <span>
            Eligible: <strong className="text-foreground">{result.stats.eligible_count}</strong>
          </span>
        </div>
      ) : null}

      <div className={CLAIM_ENGINE_SECTION_CLASS}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Manual grouping</span>
          <select
            value={groupingDimension}
            onChange={(e) => setGroupingDimension(e.target.value as ManualGroupingDimension)}
            className={CLAIM_ENGINE_INPUT_CLASS}
          >
            {GROUPING_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                Group by {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={selectAllEligible}
            className="rounded-lg bg-muted px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted/80"
          >
            Select eligible
          </button>
          <button
            type="button"
            onClick={clearSelection}
            disabled={!selectedIds.size}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            Clear ({selectedIds.size})
          </button>
          <button
            type="button"
            disabled={!selectedIds.size || creating || !result?.returns_domain_enabled}
            onClick={openCaseBuilder}
            className={`${CLAIM_ENGINE_BTN_PRIMARY} inline-flex items-center gap-1.5 px-4 py-2 text-sm`}
          >
            <FolderPlus className="h-4 w-4" />
            Build claim case
          </button>
        </div>
        {suggestedGroups.length > 1 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Selection spans {suggestedGroups.length} {groupingDimension} groups:{" "}
            {suggestedGroups.map((g) => `${g.key} (${g.count})`).join(", ")}
          </p>
        ) : null}
        {draftMessage ? (
          <p
            className={[
              "mt-2 text-sm",
              draftMessage.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300",
            ].join(" ")}
          >
            {draftMessage.text}
          </p>
        ) : null}
      </div>

      {references && references.lines.length > 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/80 px-4 py-3 dark:border-slate-600 dark:bg-slate-900/40">
          <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">Read-only import context (amazon_returns)</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{references.note}</p>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {references.lines.map((line) => (
              <li key={line.claim_line_id}>
                Order {line.order_id ?? "—"} · SKU {line.sku ?? "—"} · {line.status} · line{" "}
                {line.claim_line_id.slice(0, 8)}…
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {STATE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={activeTab === tab.id ? CLAIM_ENGINE_FILTER_TAB_ACTIVE : CLAIM_ENGINE_FILTER_TAB_IDLE}
          >
            {tab.label}
            <span className="ml-1 opacity-80">({tabCounts[tab.id] ?? 0})</span>
          </button>
        ))}
      </div>

      {initialLoading && rows.length === 0 ? (
        <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading queue…
        </div>
      ) : result?.error ? (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {result.error}
        </div>
      ) : rows.length === 0 ? (
        <ClaimEngineEmptyState
          title="Draft pool is empty"
          description="Physical return scans with a claimable scanner issue appear here. Check claim go-live date, product link, and evidence in Settings."
          action={{ href: "/scanner/operator-mobile/scan", label: "Open scanner" }}
          secondaryAction={{ href: "/settings", label: "Claim settings" }}
        />
      ) : filtered.length === 0 ? (
        <ClaimEngineEmptyState
          title="No scans in this filter"
          description='Select the "All" tab above to see held, pre-cutoff, or missing-evidence rows.'
        />
      ) : (
        <>
          {refreshing ? (
            <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" />
              Refreshing queue…
            </div>
          ) : null}
          <div className={`hidden md:block ${CLAIM_ENGINE_CARD_CLASS}`}>
            <table className={CLAIM_ENGINE_TABLE_CLASS}>
              <thead className={CLAIM_ENGINE_TABLE_HEAD_CLASS}>
                <tr>
                  <th className="w-10 px-3 py-3" />
                  <th className="px-4 py-3 font-semibold">Source</th>
                  <th className="px-4 py-3 font-semibold">Flow</th>
                  <th className="px-4 py-3 font-semibold">Queue</th>
                  <th className="px-4 py-3 font-semibold">Item</th>
                  <th className="px-4 py-3 font-semibold">Issue</th>
                  <th className="px-4 py-3 font-semibold">Product</th>
                  <th className="px-4 py-3 font-semibold">Scanned</th>
                  <th className="px-4 py-3 font-semibold">Claim line</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <QueueRow
                    key={row.return_item_id}
                    row={row}
                    selected={selectedIds.has(row.return_item_id)}
                    canSelect={canSelectRow(row)}
                    onToggle={() => toggleSelect(row.return_item_id)}
                    policyReason={
                      result?.claim_policy
                        ? evaluateManualDraftEligibility(row, result.claim_policy, {
                            workflow: result.effective_claim_settings?.workflow,
                          }).reason
                        : undefined
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-3 md:hidden">
            {filtered.map((row) => (
              <QueueCard
                key={row.return_item_id}
                row={row}
                selected={selectedIds.has(row.return_item_id)}
                canSelect={canSelectRow(row)}
                onToggle={() => toggleSelect(row.return_item_id)}
              />
            ))}
          </div>
        </>
      )}

      {selectedIds.size > 0 ? (
        <div className={`${CLAIM_ENGINE_STICKY_ACTION_BAR_CLASS} md:hidden`}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">{selectedIds.size} selected</span>
            <button
              type="button"
              disabled={creating || !result?.returns_domain_enabled}
              onClick={openCaseBuilder}
              className={`${CLAIM_ENGINE_BTN_PRIMARY} inline-flex items-center gap-1.5`}
            >
              <FolderPlus className="h-4 w-4" />
              Build case
            </button>
          </div>
        </div>
      ) : null}
    </ClaimEnginePageShell>
  );
}

function policySettingHint(reason: string | undefined): string | null {
  if (!reason || reason === "allowed") return null;
  const known = [
    "allowed",
    "scan_not_live",
    "import_pre_cutoff",
    "outside_window",
    "hold_package_open",
    "hold_pallet_open",
    "hold_order_incomplete",
    "manual_review_required",
    "missing_scanner_evidence",
    "promote_disabled",
    "module_scope_disabled",
  ] as const;
  if ((known as readonly string[]).includes(reason)) {
    return claimEligibilityReasonLabel(reason as (typeof known)[number]);
  }
  return reason.replace(/_/g, " ");
}

function QueueRow({
  row,
  selected,
  canSelect,
  onToggle,
  policyReason,
}: {
  row: ReturnsClaimQueueRow;
  selected: boolean;
  canSelect: boolean;
  onToggle: () => void;
  policyReason?: string;
}) {
  const issueLabel =
    (row.scanner_issue_label && CLAIM_DEFECT_LABELS[row.scanner_issue_label]) ||
    row.scanner_issue_type ||
    "—";
  const productOk = !!(row.resolved_product_id || row.resolved_catalog_product_id);
  const flowStage = (row.flow_stage as ClaimFlowStage | null) ?? null;
  const flowLabel = row.flow_stage_label ?? row.state_label;
  const flowHint =
    row.eligibility_display_hint?.trim() ||
    (flowStage ? claimFlowStageHint(flowStage) : "");

  const settingHint = policySettingHint(policyReason) ?? row.eligibility_display_label ?? null;

  return (
    <tr className={`${CLAIM_ENGINE_TABLE_ROW_CLASS} ${selected ? "bg-slate-50 dark:bg-slate-900/60" : "hover:bg-muted/20"}`}>
      <td className="px-3 py-3">
        <input
          type="checkbox"
          checked={selected}
          disabled={!canSelect}
          onChange={onToggle}
          title={canSelect ? "Include in manual draft case" : settingHint ?? flowHint ?? "Not eligible for manual draft"}
          className="h-4 w-4 rounded border-border"
        />
      </td>
      <td className="px-4 py-3">
        <ClaimSourceBadge source_table="return_items" />
      </td>
      <td className="px-4 py-3">
        {flowStage ? <ClaimFlowBadge stage={flowStage} /> : <span className="text-xs text-muted-foreground">{flowLabel}</span>}
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground" title={settingHint ?? undefined}>
        {row.state_label}
      </td>
      <td className="px-4 py-3">
        <div className="font-medium text-foreground">
          {row.item_name?.trim() || row.lpn || row.return_item_id.slice(0, 8)}
        </div>
        <div className="text-xs text-muted-foreground">
          {row.sku || row.fnsku || row.asin || "—"}
          {row.order_id ? ` · ${row.order_id}` : ""}
        </div>
      </td>
      <td className="px-4 py-3 text-xs">{issueLabel}</td>
      <td className="px-4 py-3 text-xs">
        {productOk ? (
          <span className="text-emerald-700 dark:text-emerald-300">Linked</span>
        ) : (
          <span className="text-violet-700 dark:text-violet-300">Unresolved</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground">{formatWhen(row.created_at)}</td>
      <td className="px-4 py-3 text-xs text-muted-foreground">
        {row.claim_line ? (
          <span title={row.claim_line.id}>
            {row.claim_line.status}
            {row.claim_line.scanner_issue_type ? ` · ${row.claim_line.scanner_issue_type}` : ""}
          </span>
        ) : (
          <span className="italic">No line yet</span>
        )}
      </td>
    </tr>
  );
}

function QueueCard({
  row,
  selected,
  canSelect,
  onToggle,
}: {
  row: ReturnsClaimQueueRow;
  selected: boolean;
  canSelect: boolean;
  onToggle: () => void;
}) {
  const flowStage = (row.flow_stage as ClaimFlowStage | null) ?? null;
  const issueLabel =
    (row.scanner_issue_label && CLAIM_DEFECT_LABELS[row.scanner_issue_label]) ||
    row.scanner_issue_type ||
    "—";

  return (
    <div
      className={`rounded-xl border p-4 shadow-sm ${selected ? "border-slate-400 bg-slate-50 dark:border-slate-600 dark:bg-slate-900/60" : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950/70"}`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          disabled={!canSelect}
          onChange={onToggle}
          className="mt-1 h-4 w-4 rounded border-border"
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <ClaimSourceBadge source_table="return_items" />
            {flowStage ? <ClaimFlowBadge stage={flowStage} /> : null}
            <span className="text-xs text-muted-foreground">{row.state_label}</span>
          </div>
          <p className="font-medium text-foreground">
            {row.item_name?.trim() || row.lpn || row.return_item_id.slice(0, 8)}
          </p>
          <p className="text-xs text-muted-foreground">
            {row.sku || row.fnsku || "—"}
            {row.order_id ? ` · ${row.order_id}` : ""}
          </p>
          <p className="text-xs">{issueLabel}</p>
        </div>
      </div>
    </div>
  );
}
