"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock, Database, Loader2, PlayCircle } from "lucide-react";

import type { MenorixAutomationHealth } from "@/components/menorix";
import type {
  ClaimReadinessPayload,
  OrbitFraReadinessPayload,
  ProductStoryReadinessPayload,
  SourceHealthEntry,
  TridReadinessPayload,
} from "@/lib/claims/connectors/source-connector-readmodel";
import { getClaimCenterV2Page } from "@/lib/claims/center/claim-center-v2-page-contract";

import { ClaimCenterBridgePhaseNotice } from "./ClaimCenterBridgePhaseNotice";
import { ClaimCenterSectionEmptyState } from "./ClaimCenterSectionEmptyState";
import { ClaimCenterV2PageShell } from "./ClaimCenterV2PageShell";
import { useClaimCenter } from "./ClaimCenterRootClient";
import { CLAIM_CENTER_SECTION_EMPTY } from "@/lib/claims/center/claim-center-ui-copy";

const SOURCE_LABELS: Record<string, string> = {
  scanner_returns: "Scanner returns",
  scanner_physical_review: "Scanner physical review",
  reimbursement: "Amazon reimbursements",
  settlement: "Settlements",
  transaction: "Transactions",
  inventory_ledger: "Inventory ledger",
  removal_order: "Removal orders",
  removal_shipment: "Removal shipments",
  customer_return: "Customer returns",
  orbit_fra: "ORBIT-FRA carry-forward",
  safet: "SAFE-T claims",
  delayed_not_received: "Delayed / not received",
  inbound_shipment: "Inbound shipments",
  shipment_discrepancy: "Shipment discrepancies",
};

function humanSourceLabel(key: string): string {
  return SOURCE_LABELS[key] ?? key.replace(/_/g, " ");
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "Never recorded";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Unknown" : d.toLocaleString();
}

type RunsPayload = {
  discovery_index?: {
    last_watermark_at?: string | null;
    sources?: Record<string, { enabled?: boolean; last_run_at?: string | null }>;
  } | null;
  intake_runs?: Array<{ run_id: string; candidate_count: number }>;
  automation_health?: MenorixAutomationHealth | null;
  connector_readiness?: {
    read_only?: boolean;
    no_db_writes?: boolean;
  };
  source_health_payload?: SourceHealthEntry[];
  claim_readiness_payload?: ClaimReadinessPayload;
  trid_readiness_payload?: TridReadinessPayload;
  product_story_readiness_payload?: ProductStoryReadinessPayload;
  orbit_fra_readiness_payload?: OrbitFraReadinessPayload;
  file_api_connector_readiness?: {
    manual_import_needed?: string[];
    last_upload_at?: string | null;
    raw_report_uploads_count?: number;
  };
};

type SourceCard = {
  id: string;
  name: string;
  lastRun: string;
  rowsScanned: string;
  candidatesCreated: number;
  warnings: string[];
  nextStep: string;
  enabled?: boolean;
  runId?: string;
  health?: SourceHealthEntry;
};

function buildSourceCards(data: RunsPayload | null, automation: MenorixAutomationHealth | null): SourceCard[] {
  const cards: SourceCard[] = [];
  const sources = data?.discovery_index?.sources ?? {};
  const intakeTotal = (data?.intake_runs ?? []).reduce((s, r) => s + r.candidate_count, 0);

  for (const [key, cfg] of Object.entries(sources)) {
    const warnings: string[] = [];
    if (!cfg?.enabled) warnings.push("Source is disabled in workspace settings.");
    if (!cfg?.last_run_at) warnings.push("No successful run recorded yet.");

    cards.push({
      id: `discovery-${key}`,
      name: humanSourceLabel(key),
      lastRun: formatWhen(cfg?.last_run_at),
      rowsScanned: cfg?.last_run_at ? "Scheduled scan" : "—",
      candidatesCreated: 0,
      warnings,
      nextStep: cfg?.enabled
        ? cfg?.last_run_at
          ? "Check workflow queues for opportunities from this source."
          : "Wait for the next scheduled run or trigger pool generation in Platform Automation."
        : "Enable this source in workspace claim settings, then run pool generation.",
      enabled: cfg?.enabled,
    });
  }

  for (const run of data?.intake_runs ?? []) {
    cards.push({
      id: `intake-${run.run_id}`,
      name: "Intake run",
      lastRun: "From recent pool generation",
      rowsScanned: "Store scan",
      candidatesCreated: run.candidate_count,
      warnings: run.candidate_count === 0 ? ["Run completed with zero opportunities created."] : [],
      nextStep:
        run.candidate_count > 0
          ? "Open Home or the full pool to review new opportunities."
          : "Verify store scope and source enablement, then re-run generation.",
      runId: run.run_id,
    });
  }

  if (cards.length === 0 && automation?.enabled_sources?.length) {
    for (const key of automation.enabled_sources) {
      cards.push({
        id: `auto-${key}`,
        name: humanSourceLabel(key),
        lastRun: formatWhen(automation.last_run_at),
        rowsScanned: automation.last_run_at ? "Discovery index" : "—",
        candidatesCreated: intakeTotal,
        warnings: automation.warnings ?? [],
        nextStep: "Generators are enabled — wait for the next scan or run pool generation manually.",
        enabled: true,
      });
    }
  }

  // Enrich with connector health rows (domain tables)
  for (const health of data?.source_health_payload ?? []) {
    if (!health.domain_table || health.source_key === "reports_repository") continue;
    const existing = cards.find((c) => c.id === `health-${health.source_key}`);
    if (existing) {
      existing.health = health;
      existing.rowsScanned = health.row_count > 0 ? `${health.row_count.toLocaleString()} rows` : "—";
      if (health.blocker_reason) existing.warnings.push(health.blocker_reason);
      continue;
    }
    cards.push({
      id: `health-${health.source_key}`,
      name: health.label,
      lastRun: formatWhen(health.last_import_at ?? health.last_row_at),
      rowsScanned: health.row_count > 0 ? `${health.row_count.toLocaleString()} rows` : "—",
      candidatesCreated: 0,
      warnings: health.blocker_reason ? [health.blocker_reason] : [],
      nextStep:
        health.imported === "yes"
          ? `Data ${health.freshness_status}; generator ${health.source_type}.`
          : "Import or enable API sync for this source.",
      health,
    });
  }

  return cards;
}

function FreshnessBadge({ status }: { status: string }) {
  const cls =
    status === "fresh"
      ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200"
      : status === "stale"
        ? "bg-amber-500/15 text-amber-900 dark:text-amber-100"
        : "bg-black/10 opacity-70";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${cls}`}>{status}</span>
  );
}

function SourceHumanCard({ card }: { card: SourceCard }) {
  return (
    <article className="claim-center-card rounded-xl p-4 transition-all hover:shadow-md" data-source-card>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium">{card.name}</h3>
          {card.runId ? (
            <p className="mt-0.5 truncate font-mono text-[10px] opacity-45" title={card.runId}>
              Run {card.runId.slice(0, 8)}…
            </p>
          ) : card.health ? (
            <p className="mt-0.5 text-[10px] opacity-50">{card.health.source_type.replace(/_/g, " ")}</p>
          ) : null}
        </div>
        {card.health ? (
          <FreshnessBadge status={card.health.freshness_status} />
        ) : card.enabled != null ? (
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
              card.enabled ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200" : "bg-black/10 opacity-60"
            }`}
          >
            {card.enabled ? "On" : "Off"}
          </span>
        ) : (
          <PlayCircle className="h-4 w-4 shrink-0 opacity-40" aria-hidden />
        )}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <div>
          <dt className="font-medium opacity-55">Last activity</dt>
          <dd className="opacity-85">{card.lastRun}</dd>
        </div>
        <div>
          <dt className="font-medium opacity-55">Rows / scan</dt>
          <dd className="opacity-85">{card.rowsScanned}</dd>
        </div>
        <div className="col-span-2">
          <dt className="font-medium opacity-55">Opportunities created</dt>
          <dd className="text-sm font-semibold">{card.candidatesCreated}</dd>
        </div>
      </dl>

      {card.warnings.length > 0 ? (
        <ul className="mt-3 space-y-1 text-xs text-amber-900 dark:text-amber-100">
          {card.warnings.map((w) => (
            <li key={w} className="flex gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
              {w}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-3 rounded-lg bg-black/[0.03] px-3 py-2 text-xs dark:bg-white/[0.04]">
        <span className="font-medium">Next step:</span> {card.nextStep}
      </p>
    </article>
  );
}

function ReadinessSummaryPanel({ data }: { data: RunsPayload | null }) {
  const claim = data?.claim_readiness_payload;
  const trid = data?.trid_readiness_payload;
  const story = data?.product_story_readiness_payload;
  const orbit = data?.orbit_fra_readiness_payload;
  const fileApi = data?.file_api_connector_readiness;

  if (!claim && !trid) return null;

  return (
    <section className="claim-center-card space-y-4 rounded-xl p-4">
      <div className="flex items-center gap-2">
        <Database className="h-4 w-4 opacity-50" aria-hidden />
        <h2 className="text-sm font-semibold">Connector readiness (read-only)</h2>
        {data?.connector_readiness?.read_only ? (
          <span className="text-[10px] uppercase opacity-45">no DB writes</span>
        ) : null}
      </div>

      <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="font-medium opacity-55">Active opportunities</dt>
          <dd className="text-sm font-semibold">{claim?.active_candidate_count ?? 0}</dd>
        </div>
        <div>
          <dt className="font-medium opacity-55">TRID edges</dt>
          <dd className="text-sm font-semibold">
            {trid?.claim_reference_edge_count ?? 0}
            <span className="ml-1 text-[10px] font-normal opacity-60">({trid?.trid_capable ?? "—"})</span>
          </dd>
        </div>
        <div>
          <dt className="font-medium opacity-55">Product linkage</dt>
          <dd className="text-sm font-semibold">
            {story?.linkage_pct_on_active_candidates ?? 0}%
            <span className="ml-1 text-[10px] font-normal opacity-60">on active pool</span>
          </dd>
        </div>
        <div>
          <dt className="font-medium opacity-55">ORBIT generator</dt>
          <dd className="text-sm font-semibold">{orbit?.live_db_generator === "yes" ? "Live" : "—"}</dd>
        </div>
      </dl>

      {trid?.missing_edge_reason ? (
        <p className="text-xs text-amber-900 dark:text-amber-100">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden />
          TRID: {trid.missing_edge_reason} · FRR rows {trid.frr_row_count}
        </p>
      ) : null}

      {story?.gaps?.length ? (
        <p className="text-xs opacity-70">Product Story gaps: {story.gaps.join("; ")}</p>
      ) : null}

      {orbit?.cogs_source_note ? (
        <p className="text-xs opacity-70">ORBIT COGS: {orbit.cogs_source_note}</p>
      ) : null}

      {fileApi?.manual_import_needed?.length ? (
        <p className="text-xs opacity-70">
          Manual file import still needed: {fileApi.manual_import_needed.join(", ")}
        </p>
      ) : null}
    </section>
  );
}

export function ClaimCenterSourcesView() {
  const contract = getClaimCenterV2Page("sources");
  const { fetchJson, storeId } = useClaimCenter();
  const [data, setData] = useState<RunsPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const payload = await fetchJson<RunsPayload>("/api/claims/center/sources");
    setData(payload);
    setLoading(false);
  }, [fetchJson]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  const automation = data?.automation_health ?? null;
  const cards = useMemo(() => buildSourceCards(data, automation), [data, automation]);
  const hasContent =
    cards.length > 0 ||
    automation?.last_run_at ||
    (data?.source_health_payload?.length ?? 0) > 0;

  return (
    <ClaimCenterV2PageShell contract={contract}>
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading sources…
        </div>
      ) : !hasContent ? (
        <ClaimCenterSectionEmptyState config={CLAIM_CENTER_SECTION_EMPTY.runs} />
      ) : (
        <div className="space-y-6">
          <ReadinessSummaryPanel data={data} />

          <section className="claim-center-card rounded-xl p-4 transition-shadow hover:shadow-sm">
            <div className="flex items-start gap-3">
              <Clock className="mt-0.5 h-5 w-5 opacity-50" aria-hidden />
              <div>
                <h2 className="text-sm font-semibold">Overall generator health</h2>
                <p className="mt-1 text-sm opacity-80">
                  {formatWhen(data?.discovery_index?.last_watermark_at ?? automation?.last_run_at)}
                </p>
                {automation?.label ? (
                  <p className="mt-1 text-xs opacity-65">
                    Status: {automation.label}
                    {automation.enabled_sources?.length
                      ? ` · ${automation.enabled_sources.length} trusted source${automation.enabled_sources.length === 1 ? "" : "s"}`
                      : ""}
                  </p>
                ) : null}
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Source activity &amp; data health</h2>
            {cards.length === 0 ? (
              <p className="text-sm opacity-60">No per-source cards yet — enable generators and run pool generation.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {cards.map((card) => (
                  <SourceHumanCard key={card.id} card={card} />
                ))}
              </div>
            )}
          </section>

          <p className="text-xs opacity-55">
            Configure generators in Platform Automation or workspace claim settings — not inside Claim Center.
          </p>
        </div>
      )}

      <div className="mt-4">
        <ClaimCenterBridgePhaseNotice compact />
      </div>
    </ClaimCenterV2PageShell>
  );
}
