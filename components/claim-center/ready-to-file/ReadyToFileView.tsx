"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Loader2 } from "lucide-react";

import { ClaimCenterFinancialNav } from "@/components/claim-center/financial/ClaimCenterFinancialNav";
import { ClaimCenterV2PageShell } from "@/components/claim-center/ClaimCenterV2PageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import {
  CLAIM_CENTER_KPI_CARD,
  CLAIM_CENTER_KPI_GRID,
  CLAIM_CENTER_SELECT_CLASS,
  CLAIM_CENTER_TABLE_CLASS,
  CLAIM_CENTER_TABLE_HEAD_CLASS,
  CLAIM_CENTER_TABLE_ROW_CLASS,
  claimCenterBadgeTone,
} from "@/components/claim-center/claim-center-ui";
import { getClaimCenterV2Page } from "@/lib/claims/center/claim-center-v2-page-contract";
import {
  DEFAULT_READY_TO_FILE_FILTERS,
  computeAmountStatus,
  computeFamilyAwareRecovery,
  computeFilingDecision,
  computeHardenedReadyToFileGate,
  computeRemovalOriginReason,
  filterReadyToFileRows,
  summarizeRecoveryGap,
  type ReadyToFileFilterState,
  type ReadyToFileQueuePayload,
  type ReadyToFileRow,
} from "@/lib/claims/filing/claim-ready-to-file-queue-ui-contract";

import { ReadyToFileDetailDrawer } from "./ReadyToFileDetailDrawer";

const PAGE_CONTRACT = getClaimCenterV2Page("ready_to_file");

function money(v: number | null): string {
  return v == null ? "Unknown" : `$${v.toFixed(2)}`;
}

const ORIGIN_SHORT: Record<string, string> = {
  "Removal Shipment Detail": "Shipment",
  "Removal Order Detail": "Order",
  "Expected Package": "EP",
};

export function ReadyToFileView() {
  const { fetchJson, storeId } = useClaimCenter();
  const [payload, setPayload] = useState<ReadyToFileQueuePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ReadyToFileFilterState>(DEFAULT_READY_TO_FILE_FILTERS);
  const [selected, setSelected] = useState<ReadyToFileRow | null>(null);
  const [activeTab, setActiveTab] = useState<"ready" | "needs_data">("ready");

  const load = useCallback(async () => {
    if (!storeId) {
      setPayload(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<ReadyToFileQueuePayload>("/api/claims/center/ready-to-file");
      setPayload(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load ready-to-file queue.");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [fetchJson, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const allRows = useMemo(
    () => (payload ? [...payload.ready_rows, ...payload.blocked_rows] : []),
    [payload],
  );
  const tabSourceRows = useMemo(
    () => (activeTab === "ready" ? (payload?.ready_rows ?? []) : (payload?.blocked_rows ?? [])),
    [payload, activeTab],
  );
  const filteredRows = useMemo(() => filterReadyToFileRows(tabSourceRows, filters), [tabSourceRows, filters]);
  const recovery = useMemo(() => summarizeRecoveryGap(allRows), [allRows]);

  const families = useMemo(
    () => Object.keys(payload?.summary_cards.family_counts ?? {}),
    [payload],
  );

  const cards = payload?.summary_cards;

  return (
    <ClaimCenterV2PageShell contract={PAGE_CONTRACT}>
      <ClaimCenterFinancialNav />

      <header className="space-y-2">
        <h1 className="flex items-center gap-2 text-xl font-bold sm:text-2xl">
          <FileText className="h-5 w-5 opacity-70" /> Ready to File Claims
        </h1>
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-950 dark:text-amber-100">
          MENORIX does not submit to Amazon. Use this page to manually file in Seller Central and copy the
          Amazon Case ID back.
        </p>
      </header>

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading ready-to-file queue…
        </div>
      ) : error ? (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          {error}
        </p>
      ) : payload && cards ? (
        <div className="space-y-6">
          {/* ---- Part A: intake settings audit strip ---- */}
          {payload.settings_audit ? (
            <section className="rounded-xl border border-sky-500/30 bg-sky-500/[0.05] px-4 py-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide opacity-70">
                  Intake settings that created these claims
                </h2>
                {payload.settings_audit.has_org_override ? (
                  <span className={claimCenterBadgeTone("info")}>company override active</span>
                ) : (
                  <span className={claimCenterBadgeTone("neutral")}>platform default</span>
                )}
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-[10px] font-semibold uppercase opacity-55">Missing threshold</dt>
                  <dd className="mt-0.5 font-semibold">
                    {payload.settings_audit.delayed_not_received_days} days
                  </dd>
                  <dd className="text-[10px] opacity-50">{payload.settings_audit.delayed_not_received_days_source}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-semibold uppercase opacity-55">
                    Scan / receipt reliable from
                  </dt>
                  {payload.settings_audit.scan_availability_start_found ? (
                    <dd className="mt-0.5 font-semibold">
                      {payload.settings_audit.scan_availability_start_value}
                    </dd>
                  ) : (
                    <dd className="mt-0.5 font-semibold text-amber-700 dark:text-amber-300">
                      missing setting
                    </dd>
                  )}
                  <dd className="text-[10px] opacity-50">{payload.settings_audit.scan_availability_start_source}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-semibold uppercase opacity-55">Claim start date</dt>
                  <dd className="mt-0.5 font-semibold">
                    {payload.settings_audit.claim_start_date ?? (
                      <span className="text-amber-700 dark:text-amber-300">missing setting</span>
                    )}
                  </dd>
                  <dd className="text-[10px] opacity-50">
                    eligibility window {payload.settings_audit.claim_eligibility_window_days}d
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] font-semibold uppercase opacity-55">
                    Expected-package match window
                  </dt>
                  <dd className="mt-0.5 font-semibold">
                    {payload.settings_audit.expected_package_matching_window_days != null
                      ? `${payload.settings_audit.expected_package_matching_window_days} days`
                      : "—"}
                  </dd>
                  <dd className="text-[10px] opacity-50">
                    expiry warning {payload.settings_audit.expiration_warning_days}d
                  </dd>
                </div>
              </dl>
              {payload.settings_audit.missing_settings.length > 0 ? (
                <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-950 dark:text-amber-100">
                  <p className="font-semibold">Missing settings (not invented — recommend adding):</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {payload.settings_audit.missing_settings.map((m) => (
                      <li key={m.key}>
                        <span className="font-mono">{m.key}</span> — {m.meaning} → recommended key:{" "}
                        <span className="font-mono">{m.recommended_setting_key}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}

          {/* ---- Summary cards ---- */}
          <section className={CLAIM_CENTER_KPI_GRID}>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Ready to file</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
                {cards.ready_to_file_count}
              </p>
            </div>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Total recovery value</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{money(cards.total_recovery_value)}</p>
            </div>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Families</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{cards.families_count}</p>
              <p className="mt-1 text-[10px] opacity-65">
                {Object.entries(cards.family_counts)
                  .map(([k, v]) => `${v} ${k.replace("removal_", "")}`)
                  .join(" · ")}
              </p>
            </div>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Blocked</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-300">
                {cards.missing_blockers_count}
              </p>
            </div>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Amazon Case ID missing</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{cards.not_submitted_to_amazon_count}</p>
            </div>
          </section>

          {/* ---- Recovery gap summary cards ---- */}
          <section className={CLAIM_CENTER_KPI_GRID}>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Expected recovery</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{money(recovery.total_expected_recovery)}</p>
            </div>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Confirmed reimbursed</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
                {money(recovery.total_confirmed_reimbursed)}
              </p>
            </div>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Open recovery gap</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-300">
                {money(recovery.total_open_recovery_gap)}
              </p>
            </div>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Unreimbursed claims</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{recovery.unreimbursed_claims_count}</p>
            </div>
            <div className={CLAIM_CENTER_KPI_CARD}>
              <p className="text-[11px] font-semibold uppercase opacity-60">Needs reimbursement review</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{recovery.needs_reimbursement_review_count}</p>
            </div>
          </section>

          {allRows.length === 0 ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-950 dark:text-amber-100">
              <p className="font-semibold">No ready-to-file claims found for the current data scope.</p>
              <p className="mt-1 opacity-90">
                This is a scope/connection issue, not an audit result — the queue was not silently emptied. The
                verified pilot data (10 ready claims · $100.72 · 6 removal_shipment_missing + 4
                removal_order_discrepancy) lives under organization{" "}
                <span className="font-mono">00000000-…-0001</span> / store{" "}
                <span className="font-mono">509ee1f6-…</span> on the original project (
                <span className="font-mono">kxsvedvpjldygtdbylsy</span>). Confirm the store selector above and that
                the app is bound to the correct Supabase project, then reload.
              </p>
            </div>
          ) : payload.scanner_only_claims_detected > 0 ||
            payload.simulated_case_ids_used > 0 ||
            payload.fake_scan_codes_detected > 0 ||
            payload.sale_price_used_as_amount_detected > 0 ? (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-800 dark:text-red-200">
              Audit flags — scanner-only: {payload.scanner_only_claims_detected} · fake scan codes:{" "}
              {payload.fake_scan_codes_detected} · simulated case IDs: {payload.simulated_case_ids_used} · sale
              price as amount: {payload.sale_price_used_as_amount_detected}
            </p>
          ) : (
            <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-950 dark:text-emerald-100">
              Correctness audit clean — no scanner-only, fake scan codes, simulated case IDs, or sale-price
              amounts.
            </p>
          )}

          {/* ---- Tab bar: Ready to File / Needs Data ---- */}
          {allRows.length > 0 ? (
            <div className="flex items-center gap-1 rounded-xl border bg-black/[0.02] p-1 dark:bg-white/[0.02]">
              <button
                type="button"
                onClick={() => setActiveTab("ready")}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                  activeTab === "ready"
                    ? "bg-white shadow dark:bg-white/10"
                    : "opacity-60 hover:opacity-90"
                }`}
              >
                Ready to File
                <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-bold ${
                  activeTab === "ready"
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-black/10 dark:bg-white/10"
                }`}>
                  {payload?.ready_rows.length ?? 0}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("needs_data")}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                  activeTab === "needs_data"
                    ? "bg-white shadow dark:bg-white/10"
                    : "opacity-60 hover:opacity-90"
                }`}
              >
                Needs Data
                <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-bold ${
                  activeTab === "needs_data"
                    ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                    : "bg-black/10 dark:bg-white/10"
                }`}>
                  {payload?.blocked_rows.length ?? 0}
                </span>
              </button>
            </div>
          ) : null}

          {/* ---- Needs Data explanation banner ---- */}
          {activeTab === "needs_data" && (payload?.blocked_rows.length ?? 0) > 0 ? (
            <section className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs">
              <p className="font-semibold text-amber-900 dark:text-amber-100">
                These claims do not meet all 9 filing gate requirements and are held from Ready to File.
              </p>
              <p className="mt-1 text-amber-800 dark:text-amber-200">
                Each row shows its specific blockers below. Common hold reasons for this pilot:
                {" "}<strong>physical_receiving_not_started</strong> (no packages/scan row — removal packages were never checked in physically),
                {" "}<strong>live_reimbursement_check_missing</strong> (status unknown_unmatched — need GET_FBA_REIMBURSEMENTS_DATA sync),
                {" "}<strong>missing_sale_price_source</strong> (7/10 claims — no Order sale loaded for those SKUs).
              </p>
              <p className="mt-1 text-amber-800/70 dark:text-amber-200/70">
                Non-fileable candidates appear here. Damaged/Lost/Disposed/Reversal/CustomerReturn candidates are in drawer section "Other possible claim opportunities" — not part of the removal claim.
              </p>
            </section>
          ) : null}

          {/* ---- Filters ---- */}
          <section className="flex flex-wrap items-end gap-3 rounded-xl border bg-black/[0.02] p-3 dark:bg-white/[0.02]">
            <label className="text-xs">
              <span className="mb-0.5 block opacity-60">Family</span>
              <select
                className={CLAIM_CENTER_SELECT_CLASS}
                value={filters.family}
                onChange={(e) => setFilters({ ...filters, family: e.target.value })}
              >
                <option value="all">All families</option>
                {families.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              <span className="mb-0.5 block opacity-60">Status</span>
              <select
                className={CLAIM_CENTER_SELECT_CLASS}
                value={filters.status}
                onChange={(e) =>
                  setFilters({ ...filters, status: e.target.value as ReadyToFileFilterState["status"] })
                }
              >
                <option value="all">All</option>
                <option value="ready">Ready</option>
                <option value="blocked">Blocked</option>
              </select>
            </label>
            <label className="text-xs">
              <span className="mb-0.5 block opacity-60">Reimbursement</span>
              <select
                className={CLAIM_CENTER_SELECT_CLASS}
                value={filters.reimbursement_status}
                onChange={(e) =>
                  setFilters({
                    ...filters,
                    reimbursement_status: e.target.value as ReadyToFileFilterState["reimbursement_status"],
                  })
                }
              >
                <option value="all">All</option>
                <option value="not_reimbursed">Not reimbursed</option>
                <option value="partially_reimbursed">Partially reimbursed</option>
                <option value="fully_reimbursed">Fully reimbursed</option>
                <option value="unknown_unmatched">Unknown / unmatched</option>
              </select>
            </label>
            {(
              [
                ["has_weak_candidates", "Has weak candidates"],
                ["has_trid", "Has TRID"],
                ["has_cogs", "Has COGS"],
                ["has_evidence", "Has evidence packet"],
                ["has_amazon_case_id", "Has Amazon Case ID"],
              ] as Array<[keyof ReadyToFileFilterState, string]>
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={Boolean(filters[key])}
                  onChange={(e) => setFilters({ ...filters, [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
            <button
              type="button"
              onClick={() => setFilters(DEFAULT_READY_TO_FILE_FILTERS)}
              className="ml-auto rounded-md border px-3 py-1.5 text-xs opacity-80 hover:opacity-100"
            >
              Reset
            </button>
          </section>

          {/* ---- Table ---- */}
          <div className="overflow-x-auto rounded-xl border">
            <table className={CLAIM_CENTER_TABLE_CLASS}>
              <thead className={CLAIM_CENTER_TABLE_HEAD_CLASS}>
                <tr className="text-[11px] uppercase opacity-60">
                  <th className="px-3 py-2">Submission</th>
                  <th className="px-3 py-2">Case</th>
                  <th className="px-3 py-2">Origin</th>
                  <th className="px-3 py-2">Why created</th>
                  <th className="px-3 py-2 text-right">Age days</th>
                  <th className="px-3 py-2 text-right">Threshold days</th>
                  <th className="px-3 py-2 text-right">Expected qty</th>
                  <th className="px-3 py-2 text-right">Received/scanned qty</th>
                  <th className="px-3 py-2">Scan status</th>
                  <th className="px-3 py-2 text-right">Missing qty</th>
                  <th className="px-3 py-2">Validity</th>
                  <th className="px-3 py-2">Current family</th>
                  <th className="px-3 py-2">Filing status</th>
                  <th className="px-3 py-2">Gate blockers</th>
                  <th className="px-3 py-2">Policy status</th>
                  <th className="px-3 py-2">Decision</th>
                  <th className="px-3 py-2">Flags</th>
                  <th className="px-3 py-2 text-right">Expected reimbursement</th>
                  <th className="px-3 py-2">Amount status</th>
                  <th className="px-3 py-2">Price source status</th>
                  <th className="px-3 py-2">Sale source</th>
                  <th className="px-3 py-2 text-right">Confirmed reimbursed</th>
                  <th className="px-3 py-2 text-right">Open claim amount</th>
                  <th className="px-3 py-2 text-right">Internal COGS</th>
                  <th className="px-3 py-2 text-right">Profit/loss context</th>
                  <th className="px-3 py-2 text-right">Sep. opps</th>
                  <th className="px-3 py-2">Reimb. status</th>
                  <th className="px-3 py-2">Match conf.</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">COGS/u</th>
                  <th className="px-3 py-2">FNSKU</th>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">ASIN</th>
                  <th className="px-3 py-2">TRID / EP</th>
                  <th className="px-3 py-2">Removal order</th>
                  <th className="px-3 py-2">Removal shipment</th>
                  <th className="px-3 py-2">Evidence</th>
                  <th className="px-3 py-2">Packet</th>
                  <th className="px-3 py-2">Case ID</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r) => {
                  const o = computeRemovalOriginReason(r);
                  return (
                  <tr
                    key={r.claim_submission_id}
                    className={CLAIM_CENTER_TABLE_ROW_CLASS}
                    onClick={() => setSelected(r)}
                  >
                    <td className="px-3 py-2 font-mono text-[11px]">{r.claim_submission_id.slice(0, 8)}…</td>
                    <td className="px-3 py-2 font-mono text-[11px]">
                      {r.claim_case_id ? `${r.claim_case_id.slice(0, 8)}…` : "—"}
                    </td>
                    <td className="px-3 py-2 text-[11px]">
                      {o.applicable && o.origin_sources.length > 0
                        ? o.origin_sources.map((s) => ORIGIN_SHORT[s] ?? s).join(" + ")
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-[11px]">{o.applicable ? o.compact_reason : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{o.event_age_days ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{o.applicable ? o.threshold_days : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{o.expected_qty ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{o.received_qty ?? "—"}</td>
                    <td className="px-3 py-2 text-[11px]">
                      {o.applicable ? (
                        <span
                          className={claimCenterBadgeTone(
                            o.scan_status_compact.startsWith("No scan") ? "neutral" : "info",
                          )}
                        >
                          {o.scan_status_compact}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{o.missing_qty ?? "—"}</td>
                    <td className="px-3 py-2 text-xs">
                      {o.applicable ? (
                        <span className={claimCenterBadgeTone(o.validity_tone)}>{o.validity_label}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    {(() => {
                      const fa = computeFamilyAwareRecovery(r);
                      const d = computeFilingDecision(r);
                      const amt = computeAmountStatus(r);
                      const sepCount = fa.separate_claim_suggestions.length;
                      const excludedCount = fa.misclassified_candidates.length;
                      const gap = fa.gap;
                      const gate = r.hardened_gate ?? computeHardenedReadyToFileGate(r);
                      return (
                        <>
                          <td className="px-3 py-2 text-xs">{r.claim_family ?? "—"}</td>
                          <td className="px-3 py-2 text-xs">
                            <span className={claimCenterBadgeTone(fa.filing_status_tone)}>{fa.filing_status_label}</span>
                          </td>
                          <td className="max-w-[200px] px-3 py-2">
                            {gate.is_ready ? (
                              <span className={claimCenterBadgeTone("success")}>All gates pass</span>
                            ) : (
                              <div className="flex flex-col gap-0.5">
                                {gate.blockers.map((b) => (
                                  <span key={b} className={`${claimCenterBadgeTone("warning")} block whitespace-nowrap text-[10px]`}>{b}</span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {fa.policy_confirmed ? (
                              <span className={claimCenterBadgeTone("success")}>Policy confirmed</span>
                            ) : (
                              <span className={claimCenterBadgeTone("warning")}>needs_policy_confirmation</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            <span className={claimCenterBadgeTone(d.tone)}>{d.label}</span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-col gap-1 text-[10px]">
                              <span className={claimCenterBadgeTone("info")}>current claim only</span>
                              {excludedCount > 0 ? (
                                <span className={claimCenterBadgeTone("warning")}>{excludedCount} cross-family excluded</span>
                              ) : null}
                              {r.amazon_case_id_status !== "recorded" ? (
                                <span className={claimCenterBadgeTone("neutral")}>not Amazon-submitted</span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold text-emerald-700 dark:text-emerald-300">
                            {fa.seller_central_amount == null ? (
                              <span className="text-amber-700 dark:text-amber-300">UNKNOWN</span>
                            ) : (
                              money(fa.seller_central_amount)
                            )}
                          </td>
                          <td className="px-3 py-2 text-[11px]">
                            <span className={claimCenterBadgeTone(amt.amount_tone)}>
                              {amt.amount_status_label}
                            </span>
                            {amt.needs_sale_price_source_import ? (
                              <span className="mt-0.5 block text-[10px] leading-tight text-amber-700 dark:text-amber-300">
                                needs sale price source import
                              </span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 text-[11px]">
                            <span
                              className={claimCenterBadgeTone(amt.price_source_loaded ? "success" : "warning")}
                              title={amt.unknown_reason ?? undefined}
                            >
                              price {amt.price_source_loaded ? "loaded" : "missing"}
                            </span>
                            <span
                              className={`mt-0.5 block ${claimCenterBadgeTone(amt.fee_source_loaded ? "success" : "neutral")}`}
                            >
                              fees {amt.fee_source_loaded ? "loaded" : "missing"}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            {fa.latest_sold_price == null ? (
                              <span
                                className={claimCenterBadgeTone("warning")}
                                title={fa.latest_sale_net_unknown_reason ?? "no loaded sale source"}
                              >
                                UNKNOWN
                              </span>
                            ) : (
                              <span
                                className="text-[10px] leading-tight opacity-60"
                                title={`fees: ${fa.amazon_fees_source ?? "—"} · ${fa.fee_source_confidence}`}
                              >
                                {(fa.latest_sold_price_source ?? "—").replace("amazon_", "").replace(".product_sales", "")}
                                {fa.latest_sold_price_date ? ` · ${fa.latest_sold_price_date.slice(0, 10)}` : ""}
                                {` · ${fa.sale_match_confidence}`}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {fa.confirmed_reimbursed_strong > 0 ? money(fa.confirmed_reimbursed_strong) : "—"}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-amber-700 dark:text-amber-300">
                            {money(fa.open_gap_under_current_policy)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums opacity-65" title="Internal cost — not the Seller Central claim amount">
                            {money(fa.total_cogs)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums opacity-65" title="Internal profit/loss context">
                            {money(fa.business_profit_loss_context)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {sepCount > 0 ? (
                              <span className={claimCenterBadgeTone("info")}>{sepCount}</span>
                            ) : (
                              <span className="opacity-50">0</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            <span className={claimCenterBadgeTone(gap.status_tone)}>{gap.status_label}</span>
                          </td>
                          <td className="px-3 py-2 text-xs capitalize opacity-70">{gap.match_confidence}</td>
                        </>
                      );
                    })()}
                    <td className="px-3 py-2 text-right tabular-nums">{r.clean_quantity ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.approved_cogs_unit)}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{r.fnsku ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{r.sku ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{r.asin ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">
                      {r.trid_or_expected_package ? `${r.trid_or_expected_package.slice(0, 8)}…` : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{r.removal_order_id ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">
                      {r.removal_shipment_id ? `${r.removal_shipment_id.slice(0, 8)}…` : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={claimCenterBadgeTone(r.evidence_status === "present" ? "success" : "warning")}>
                        {r.evidence_status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={claimCenterBadgeTone(r.filing_packet_status === "ready" ? "success" : "warning")}>
                        {r.filing_packet_status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={claimCenterBadgeTone(r.amazon_case_id_status === "recorded" ? "info" : "neutral")}>
                        {r.amazon_case_id_status === "recorded" ? "recorded" : "pending"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(r);
                        }}
                        className="whitespace-nowrap rounded-md border px-2.5 py-1 text-[11px] font-semibold opacity-80 hover:opacity-100"
                      >
                        Open Filing Packet
                      </button>
                    </td>
                  </tr>
                  );
                })}
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={40} className="px-3 py-10 text-center text-sm opacity-60">
                      {activeTab === "ready"
                        ? "No claims are currently Ready to File — see the Needs Data tab for blockers."
                        : "No claims match the current filters."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm opacity-70">
          Select a store to load the ready-to-file queue.
        </p>
      )}

      <ReadyToFileDetailDrawer
        row={selected}
        settingsAudit={payload?.settings_audit ?? null}
        caseIdRecording={
          payload?.case_id_recording ?? {
            enabled_by_default: false,
            unlock_label: "I filed this manually in Seller Central",
            fields: [],
            does_not_submit_to_amazon: true,
            write_phase_required: "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1",
            write_guarded: true,
          }
        }
        onClose={() => setSelected(null)}
      />
    </ClaimCenterV2PageShell>
  );
}
