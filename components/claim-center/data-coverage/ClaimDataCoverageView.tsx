"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Database, Loader2 } from "lucide-react";

import { ClaimCenterFinancialNav } from "@/components/claim-center/financial/ClaimCenterFinancialNav";
import { ClaimCenterV2PageShell } from "@/components/claim-center/ClaimCenterV2PageShell";
import { SeparateFamilyOpportunitiesPanel } from "@/components/claim-center/opportunities/SeparateFamilyOpportunitiesPanel";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import {
  CLAIM_CENTER_KPI_CARD,
  CLAIM_CENTER_KPI_GRID,
  CLAIM_CENTER_TABLE_CLASS,
  CLAIM_CENTER_TABLE_HEAD_CLASS,
  CLAIM_CENTER_TABLE_ROW_CLASS,
  claimCenterBadgeTone,
} from "@/components/claim-center/claim-center-ui";
import { getClaimCenterV2Page } from "@/lib/claims/center/claim-center-v2-page-contract";
import {
  familySupportMeta,
  sourceConnectionMeta,
  type ClaimSourceCoveragePayload,
  type SourceCoverageRow,
} from "@/lib/claims/center/claim-source-coverage-ui-contract";
import {
  dataSourceBadgeMeta,
  type DataSourceHubRow,
  type DataSourcesHubPayload,
} from "@/lib/data-sources/data-sources-hub-contract";

const PAGE_CONTRACT = getClaimCenterV2Page("data_coverage");

type CoveragePayloadWithHub = ClaimSourceCoveragePayload & {
  data_sources_hub?: DataSourcesHubPayload | null;
};

const HUB_TONE_CLASS: Record<string, string> = {
  success: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
  info: "bg-sky-500/15 text-sky-800 dark:text-sky-200",
  warning: "bg-amber-500/15 text-amber-900 dark:text-amber-100",
  danger: "bg-rose-500/15 text-rose-800 dark:text-rose-200",
  neutral: "bg-black/10 text-black/60 dark:bg-white/10 dark:text-white/60",
};

function yn(v: boolean): string {
  return v ? "Yes" : "No";
}

function HubStatusChip({ row }: { row: DataSourceHubRow }) {
  const meta = dataSourceBadgeMeta(row.badge);
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
      <span className="min-w-0 truncate text-[12px] font-medium" title={row.display_name}>
        {row.display_name}
      </span>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
          HUB_TONE_CLASS[meta.tone] ?? HUB_TONE_CLASS.neutral
        }`}
      >
        {meta.label}
      </span>
    </div>
  );
}

function CoverageCard({ row }: { row: SourceCoverageRow }) {
  const meta = sourceConnectionMeta(row.connection_status);
  return (
    <div className="claim-center-kpi rounded-xl p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-bold leading-tight">{row.label}</p>
        <span className={claimCenterBadgeTone(meta.tone)}>{meta.label}</span>
      </div>
      <p className="mt-0.5 font-mono text-[10px] opacity-55">{row.table ?? "— (no dedicated table)"}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums">
        {row.row_count == null ? "—" : row.row_count.toLocaleString()}
        <span className="ml-1 text-[11px] font-medium opacity-55">rows</span>
      </p>
      <dl className="mt-2 space-y-0.5 text-[11px] opacity-75">
        <div className="flex justify-between gap-2">
          <dt className="opacity-60">Latest</dt>
          <dd className="tabular-nums">{row.latest_date ? row.latest_date.slice(0, 10) : "—"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="opacity-60">API · Importer · SP-API · UI</dt>
          <dd className="tabular-nums">
            {yn(row.api_endpoint_exists)} · {yn(row.importer_exists)} · {yn(row.live_sp_api_exists)} ·{" "}
            {yn(row.ui_uses_it)}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-[10px] leading-snug opacity-60">{row.notes}</p>
    </div>
  );
}

export function ClaimDataCoverageView() {
  const { fetchJson, storeId } = useClaimCenter();
  const [payload, setPayload] = useState<CoveragePayloadWithHub | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<CoveragePayloadWithHub>("/api/claims/center/source-coverage");
      setPayload(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load source coverage.");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [fetchJson]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  const totals = payload?.totals;
  const families = useMemo(() => payload?.claim_family_map ?? [], [payload]);

  return (
    <ClaimCenterV2PageShell contract={PAGE_CONTRACT}>
      <ClaimCenterFinancialNav />

      <header className="space-y-2">
        <h1 className="flex items-center gap-2 text-xl font-bold sm:text-2xl">
          <Database className="h-5 w-5 opacity-70" /> Claim Data Coverage
        </h1>
        <p className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-sm font-medium text-sky-950 dark:text-sky-100">
          Read-only map of which Amazon files/tables/APIs power each claim type, what is loaded, and what
          must still be live-synced. No DB writes, no Amazon calls.
        </p>
      </header>

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading source coverage…
        </div>
      ) : error ? (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          {error}
        </p>
      ) : payload && totals ? (
        <div className="space-y-8">
          {/* ---- Coverage totals ---- */}
          <section className={CLAIM_CENTER_KPI_GRID}>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Sources</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{totals.sources_total}</p>
            </div>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Live · loaded</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
                {totals.sources_live_loaded}
              </p>
            </div>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Connected · empty</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-300">
                {totals.sources_loaded_empty}
              </p>
            </div>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Missing · planned</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-red-700 dark:text-red-300">
                {totals.sources_missing_or_planned}
              </p>
            </div>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Families mapped</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{totals.families_total}</p>
            </div>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Complete</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
                {totals.families_complete}
              </p>
            </div>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Partial / preview</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-300">
                {totals.families_partial + totals.families_preview_or_missing}
              </p>
            </div>
          </section>

          {/* ---- Missing source warnings ---- */}
          {payload.missing_files_or_tables.length > 0 ? (
            <section className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
              <p className="text-sm font-bold text-amber-950 dark:text-amber-100">Missing / empty sources</p>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[12px] text-amber-950/90 dark:text-amber-100/90">
                {payload.missing_files_or_tables.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* ---- Live source status (single Data Sources Hub) ---- */}
          {payload.data_sources_hub && payload.data_sources_hub.sources.length > 0 ? (
            <section className="space-y-3" data-data-sources-hub>
              <h2 className="text-sm font-bold uppercase tracking-wide opacity-70">
                Live source status · Data Sources Hub
              </h2>
              <p className="text-[11px] opacity-55">
                Same status the Platform Settings control plane and Claim Center / Sources read from — one source of
                truth.
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {payload.data_sources_hub.sources.map((row) => (
                  <HubStatusChip key={row.source_key} row={row} />
                ))}
              </div>
            </section>
          ) : null}

          {/* ---- Source coverage cards ---- */}
          <section className="space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-wide opacity-70">Source coverage</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {payload.source_coverage_matrix.map((row) => (
                <CoverageCard key={row.key} row={row} />
              ))}
            </div>
          </section>

          {/* ---- Claim family map ---- */}
          <section className="space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-wide opacity-70">Claim family → source / API map</h2>
            <div className="overflow-x-auto rounded-xl border">
              <table className={CLAIM_CENTER_TABLE_CLASS}>
                <thead className={CLAIM_CENTER_TABLE_HEAD_CLASS}>
                  <tr className="text-[11px] uppercase opacity-60">
                    <th className="px-3 py-2">Family</th>
                    <th className="px-3 py-2">Support</th>
                    <th className="px-3 py-2">Source tables</th>
                    <th className="px-3 py-2">Match keys</th>
                    <th className="px-3 py-2">Recovery / reimbursement logic</th>
                    <th className="px-3 py-2">UI · API</th>
                    <th className="px-3 py-2">Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {families.map((f) => {
                    const meta = familySupportMeta(f.support_status);
                    return (
                      <tr key={f.family_key} className={CLAIM_CENTER_TABLE_ROW_CLASS}>
                        <td className="px-3 py-2 align-top">
                          <p className="font-semibold leading-tight">{f.display_name}</p>
                          <p className="font-mono text-[10px] opacity-55">{f.family_key}</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {f.is_pilot_family ? (
                              <span className={claimCenterBadgeTone("info")}>pilot</span>
                            ) : null}
                            {f.observed_in_claim_candidates ? (
                              <span className={claimCenterBadgeTone("neutral")}>in pool</span>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <span className={claimCenterBadgeTone(meta.tone)}>{meta.label}</span>
                        </td>
                        <td className="px-3 py-2 align-top text-[11px] opacity-80">
                          {f.source_tables_required.join(", ") || "—"}
                        </td>
                        <td className="px-3 py-2 align-top text-[11px] opacity-80">
                          <p>P: {f.product_matching_keys.join(", ")}</p>
                          <p>E: {f.event_matching_keys.join(", ")}</p>
                        </td>
                        <td className="px-3 py-2 align-top text-[11px] opacity-80">
                          <p className="opacity-70">{f.cogs_recovery_formula}</p>
                          <p className="mt-0.5">{f.reimbursement_matching_logic}</p>
                        </td>
                        <td className="px-3 py-2 align-top text-[11px] opacity-70">
                          <p>{f.ui_page}</p>
                          <p className="font-mono opacity-60">{f.api_endpoint}</p>
                        </td>
                        <td className="px-3 py-2 align-top text-[11px] font-semibold">{f.priority}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* ---- Live sync plan ---- */}
          <section className="space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-wide opacity-70">Live Amazon report sync plan</h2>
            <div className="overflow-x-auto rounded-xl border">
              <table className={CLAIM_CENTER_TABLE_CLASS}>
                <thead className={CLAIM_CENTER_TABLE_HEAD_CLASS}>
                  <tr className="text-[11px] uppercase opacity-60">
                    <th className="px-3 py-2">Report / API</th>
                    <th className="px-3 py-2">Table</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Cadence</th>
                    <th className="px-3 py-2">Backfill</th>
                    <th className="px-3 py-2">Safe now</th>
                    <th className="px-3 py-2">Approval</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.live_sync_plan.map((s) => (
                    <tr key={s.report_api_name} className={CLAIM_CENTER_TABLE_ROW_CLASS}>
                      <td className="px-3 py-2 align-top font-mono text-[11px]">{s.report_api_name}</td>
                      <td className="px-3 py-2 align-top font-mono text-[11px] opacity-70">{s.source_table ?? "—"}</td>
                      <td className="px-3 py-2 align-top text-[11px] opacity-80">{s.current_status}</td>
                      <td className="px-3 py-2 align-top text-[11px] opacity-80">{s.sync_cadence}</td>
                      <td className="px-3 py-2 align-top text-[11px] opacity-80">{s.backfill_requirement}</td>
                      <td className="px-3 py-2 align-top">
                        <span className={claimCenterBadgeTone(s.safe_to_build_now ? "success" : "warning")}>
                          {yn(s.safe_to_build_now)}
                        </span>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <span className={claimCenterBadgeTone(s.approval_required ? "warning" : "neutral")}>
                          {yn(s.approval_required)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ---- Separate-family generator support ---- */}
          <SeparateFamilyOpportunitiesPanel variant="support" />

          {/* ---- Highest priority next builds ---- */}
          <section className="rounded-xl border bg-black/[0.02] px-4 py-3 dark:bg-white/[0.02]">
            <p className="text-sm font-bold">Highest-priority next builds</p>
            <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-[12px] opacity-85">
              {payload.highest_priority_next_builds.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ol>
          </section>
        </div>
      ) : (
        <p className="py-12 text-sm opacity-70">No coverage data available.</p>
      )}
    </ClaimCenterV2PageShell>
  );
}
