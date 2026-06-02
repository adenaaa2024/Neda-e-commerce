"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { ClaimEngineEmptyState } from "@/components/claim-engine/ClaimEngineEmptyState";
import { ClaimFlowBadge } from "@/components/claim-engine/ClaimFlowBadge";
import {
  CLAIM_ENGINE_CARD_CLASS,
  CLAIM_ENGINE_FILTER_TAB_ACTIVE,
  CLAIM_ENGINE_FILTER_TAB_IDLE,
  CLAIM_ENGINE_TABLE_CLASS,
  CLAIM_ENGINE_TABLE_HEAD_CLASS,
  CLAIM_ENGINE_TABLE_ROW_CLASS,
} from "@/components/claim-engine/claim-engine-ui";
import type { ClaimFlowStage } from "@/lib/claim-flow-status-badges";
import type { ReturnsClaimQueueRow } from "@/lib/returns-claims-work-queue";
import { listReturnsClaimsWorkQueue } from "@/app/returns/returns-claims-work-queue-actions";

type ReviewReadOnlyTab = "all" | "needs_product" | "needs_evidence" | "on_hold" | "ready_for_case";

const TABS: { id: ReviewReadOnlyTab; label: string; match: (r: ReturnsClaimQueueRow) => boolean }[] = [
  { id: "all", label: "All", match: () => true },
  {
    id: "needs_product",
    label: "Needs product",
    match: (r) =>
      r.queue_state === "needs_product_resolution" ||
      r.eligibility_display_code === "needs_product",
  },
  {
    id: "needs_evidence",
    label: "Needs evidence",
    match: (r) =>
      r.queue_state === "missing_evidence" ||
      r.eligibility_display_code === "needs_evidence" ||
      r.eligibility_display_code === "needs_note",
  },
  {
    id: "on_hold",
    label: "On hold",
    match: (r) =>
      r.queue_state === "held_until_package_closed" ||
      r.eligibility_display_code === "on_hold" ||
      r.eligibility_display_code === "manual_review",
  },
  {
    id: "ready_for_case",
    label: "Ready for case",
    match: (r) =>
      r.queue_state === "eligible" ||
      r.flow_stage === "ready_for_case" ||
      r.eligibility_display_code === "ready_for_case",
  },
];

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(t));
}

export function ClaimReviewReadOnlyQueue({
  actorProfileId,
  filterOrganizationId,
}: {
  actorProfileId: string | null;
  filterOrganizationId?: string | null;
}) {
  const [tab, setTab] = useState<ReviewReadOnlyTab>("all");
  const [rows, setRows] = useState<ReturnsClaimQueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [returnsEnabled, setReturnsEnabled] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listReturnsClaimsWorkQueue({
      actorProfileId: actorProfileId ?? undefined,
      filterOrganizationId: filterOrganizationId ?? undefined,
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error ?? "Failed to load queue.");
      setRows([]);
      return;
    }
    setError(null);
    setReturnsEnabled(res.returns_domain_enabled);
    setRows(res.rows);
  }, [actorProfileId, filterOrganizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const def = TABS.find((t) => t.id === tab);
    return rows.filter((r) => (def ? def.match(r) : true));
  }, [rows, tab]);

  const tabCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of TABS) c[t.id] = rows.filter(t.match).length;
    return c;
  }, [rows]);

  if (!returnsEnabled) {
    return (
      <ClaimEngineEmptyState
        title="Returns claims disabled"
        description="Enable the Returns module in Settings → Claim policy before reviewing physical-scan holds."
        action={{ href: "/settings", label: "Open claim settings" }}
        secondaryAction={{ href: "/claim-engine/inbox", label: "Import intake" }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Read-only view from the physical-scan draft pool. Full import/TRID review (assignments, bootstrap, bulk actions)
        requires workflow flags — see banner above.
      </p>

      <div className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={tab === t.id ? CLAIM_ENGINE_FILTER_TAB_ACTIVE : CLAIM_ENGINE_FILTER_TAB_IDLE}
          >
            {t.label}
            <span className="ml-1 opacity-80">({tabCounts[t.id] ?? 0})</span>
          </button>
        ))}
      </div>

      {loading ? (
        <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading review queue…
        </p>
      ) : error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200">
          {error}
        </div>
      ) : rows.length === 0 ? (
        <ClaimEngineEmptyState
          title="Nothing to review in the draft pool"
          description="Physical scans with claimable issues appear here after scanner save. Import/TRID drafts use the full Review tab when ENABLE_CLAIM_DRAFTS_REVIEW and ENABLE_CLAIM_REVIEW_WORKFLOW are on."
          action={{ href: "/returns/claims", label: "Open draft pool" }}
          secondaryAction={{ href: "/claim-engine/inbox", label: "Open intake" }}
        />
      ) : filtered.length === 0 ? (
        <ClaimEngineEmptyState
          title="No rows in this slice"
          description="Try another tab or resolve holds in the scanner / returns UI."
          action={{ href: "/returns/claims", label: "Draft pool (all rows)" }}
        />
      ) : (
        <div className={CLAIM_ENGINE_CARD_CLASS}>
          <div className="hidden overflow-x-auto md:block">
            <table className={CLAIM_ENGINE_TABLE_CLASS}>
              <thead className={CLAIM_ENGINE_TABLE_HEAD_CLASS}>
                <tr>
                  <th className="px-4 py-3">Flow</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3">Issue</th>
                  <th className="px-4 py-3">Why</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const stage = (row.flow_stage as ClaimFlowStage | null) ?? null;
                  return (
                    <tr key={row.return_item_id} className={CLAIM_ENGINE_TABLE_ROW_CLASS}>
                      <td className="px-4 py-3">
                        {stage ? <ClaimFlowBadge stage={stage} /> : <span className="text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {row.eligibility_display_label ?? row.state_label}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {row.item_name?.trim() || row.sku || row.return_item_id.slice(0, 8)}
                        <span className="block text-xs text-muted-foreground">{formatWhen(row.created_at)}</span>
                      </td>
                      <td className="px-4 py-3 text-xs">{row.scanner_issue_type ?? "—"}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground" title={row.eligibility_display_hint ?? undefined}>
                        {row.eligibility_display_hint?.slice(0, 80) ?? "—"}
                        {(row.eligibility_display_hint?.length ?? 0) > 80 ? "…" : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="space-y-3 p-4 md:hidden">
            {filtered.map((row) => (
              <div
                key={row.return_item_id}
                className="rounded-xl border border-slate-100 p-3 dark:border-slate-800"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {row.flow_stage ? (
                    <ClaimFlowBadge stage={row.flow_stage as ClaimFlowStage} />
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {row.eligibility_display_label ?? row.state_label}
                  </span>
                </div>
                <p className="mt-2 text-sm font-medium">
                  {row.item_name?.trim() || row.sku || row.return_item_id.slice(0, 8)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{row.eligibility_display_hint}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-center text-xs text-muted-foreground">
        <Link href="/returns/claims" className="font-semibold text-sky-600 hover:underline dark:text-sky-400">
          Open draft pool
        </Link>
        {" "}to select rows and build claim cases.
      </p>
    </div>
  );
}
