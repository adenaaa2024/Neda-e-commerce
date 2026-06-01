"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FolderPlus,
  ImageOff,
  Link2,
  Loader2,
  Package,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";

import { useUserRole } from "../../../components/UserRoleContext";
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

const STATE_BADGE: Record<ReturnsClaimQueueState, string> = {
  eligible: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200",
  pre_cutoff: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  missing_evidence: "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  needs_product_resolution: "bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200",
  held_until_package_closed: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200",
  domain_disabled: "bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200",
};

function StateIcon({ state }: { state: ReturnsClaimQueueState }) {
  switch (state) {
    case "eligible":
      return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
    case "missing_evidence":
      return <ImageOff className="h-4 w-4 text-amber-600" />;
    case "needs_product_resolution":
      return <Link2 className="h-4 w-4 text-violet-600" />;
    case "held_until_package_closed":
      return <Package className="h-4 w-4 text-sky-600" />;
    case "pre_cutoff":
      return <Clock className="h-4 w-4 text-slate-500" />;
    default:
      return <ShieldAlert className="h-4 w-4 text-rose-600" />;
  }
}

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
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<ListReturnsClaimsWorkQueueResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupingDimension, setGroupingDimension] = useState<ManualGroupingDimension>("issue");
  const [creating, setCreating] = useState(false);
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
    setLoading(true);
    const res = await listReturnsClaimsWorkQueue(tenantQuery);
    setResult(res);
    setLoading(false);
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
      return evaluateManualDraftEligibility(row, result.claim_policy).allowed;
    },
    [result?.returns_domain_enabled, result?.claim_policy],
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

  const createDraft = async () => {
    setCreating(true);
    setDraftMessage(null);
    const res = await createManualReturnsClaimDraft([...selectedIds], {
      grouping_dimension: groupingDimension,
      actorProfileId: actorUserId,
      tenant: tenantQuery,
    });
    setCreating(false);
    if (res.ok) {
      setDraftMessage({
        ok: true,
        text: `Draft case ${res.claim_case_id?.slice(0, 8)}… — ${res.attached_line_count} return_item line(s)${res.created_case ? " (new)" : " (existing)"}.`,
      });
      void load();
      clearSelection();
    } else {
      setDraftMessage({ ok: false, text: res.error ?? "Failed to create draft." });
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-100 dark:bg-rose-950/50">
            <RotateCcw className="h-5 w-5 text-rose-600 dark:text-rose-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Returns Claims Queue</h1>
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
              Phase 1 returns-first: live physical scans only. Select items → create a manual draft claim case.
              Historical <code className="rounded bg-muted px-1 font-mono text-[10px]">import_source</code> /{" "}
              <code className="rounded bg-muted px-1 font-mono text-[10px]">expected_group</code> lines are read-only
              context — never grouped here. No auto-promote or marketplace submit.
            </p>
          </div>
        </div>
        <Link
          href="/returns"
          className="text-sm font-medium text-violet-600 hover:text-violet-500 dark:text-violet-400"
        >
          ← Returns processing
        </Link>
      </div>

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
            Queue rows: <strong className="text-foreground">{result.stats.queue_rows}</strong>
          </span>
          <span>
            Eligible: <strong className="text-foreground">{result.stats.eligible_count}</strong>
          </span>
        </div>
      ) : null}

      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Manual grouping</span>
          <select
            value={groupingDimension}
            onChange={(e) => setGroupingDimension(e.target.value as ManualGroupingDimension)}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
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
            onClick={() => void createDraft()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
            Create draft case
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
            className={[
              "rounded-lg px-3 py-1.5 text-xs font-semibold transition",
              activeTab === tab.id
                ? "bg-violet-600 text-white"
                : "bg-muted text-muted-foreground hover:bg-muted/80",
            ].join(" ")}
          >
            {tab.label}
            <span className="ml-1 opacity-80">({tabCounts[tab.id] ?? 0})</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading queue…
        </div>
      ) : result?.error ? (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {result.error}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          No return-item scanner claims match this filter. Historical backfill lines never appear here.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-3" />
                <th className="px-4 py-3 font-semibold">State</th>
                <th className="px-4 py-3 font-semibold">Item</th>
                <th className="px-4 py-3 font-semibold">Issue</th>
                <th className="px-4 py-3 font-semibold">Product</th>
                <th className="px-4 py-3 font-semibold">Scanned</th>
                <th className="px-4 py-3 font-semibold">Claim line</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((row) => (
                <QueueRow
                  key={row.return_item_id}
                  row={row}
                  selected={selectedIds.has(row.return_item_id)}
                  canSelect={canSelectRow(row)}
                  onToggle={() => toggleSelect(row.return_item_id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function QueueRow({
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
  const issueLabel =
    (row.scanner_issue_label && CLAIM_DEFECT_LABELS[row.scanner_issue_label]) ||
    row.scanner_issue_type ||
    "—";
  const productOk = !!(row.resolved_product_id || row.resolved_catalog_product_id);

  return (
    <tr className={selected ? "bg-violet-50/50 dark:bg-violet-950/20" : "hover:bg-muted/20"}>
      <td className="px-3 py-3">
        <input
          type="checkbox"
          checked={selected}
          disabled={!canSelect}
          onChange={onToggle}
          title={canSelect ? "Include in manual draft case" : "Not eligible for manual draft"}
          className="h-4 w-4 rounded border-border"
        />
      </td>
      <td className="px-4 py-3">
        <span
          className={[
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
            STATE_BADGE[row.queue_state as ReturnsClaimQueueState],
          ].join(" ")}
        >
          <StateIcon state={row.queue_state} />
          {row.state_label}
        </span>
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
