"use client";

/**
 * Phase 7D — Claim Pool Generation automation card.
 * Self-contained: loads/saves its own schedule and triggers manual runs through
 * claim-pool-generation-actions. Candidates only — never claim_cases/claim_lines.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";

import { ClaimCandidateIntakePolicyPanel } from "@/components/claim-engine/ClaimCandidateIntakePolicyPanel";

import {
  CLAIM_POOL_SOURCE_KINDS,
  DEFAULT_CLAIM_POOL_GENERATION_SCHEDULE,
  type ClaimPoolGenerationSchedule,
} from "@/lib/platform-automation-settings-types";
import { formatAutomationTimestamp } from "@/lib/platform-automation-ui-format";
import { responsiveFormInput } from "@/lib/responsive-page-shell";
import type { ClaimPoolRunOutcome } from "@/lib/claims/intake/claim-pool-automation-run";
import {
  getClaimPoolGenerationStatusAction,
  runClaimPoolGenerationNowAction,
  saveClaimPoolGenerationScheduleAction,
  type ClaimPoolGenerationStatus,
} from "./claim-pool-generation-actions";
import { EnabledToggle, ManualWindowHelp, RollingWindowHelp, StatusPill } from "./automation-api-center-shared";

const SOURCE_LABELS: Record<string, string> = {
  scanner_physical_review: "Scanner physical review",
  amazon_removal_api: "Amazon removal API",
  reimbursement: "Reimbursements",
  settlement: "Settlements",
  transaction: "Transactions",
  inventory_ledger: "Inventory ledger",
  safet: "SAFE-T claims",
  delayed_not_received: "Delayed / not received",
  shipment_discrepancy: "Shipment discrepancy",
  inbound_shipment: "Inbound shipments",
  manual_import: "Manual import",
  orbit_fra: "ORBIT-FRA (18 categories)",
};

export function ClaimPoolGenerationCard({
  orgId,
  storeId,
}: {
  orgId: string;
  storeId: string;
}) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<ClaimPoolGenerationStatus | null>(null);
  const [draft, setDraft] = useState<ClaimPoolGenerationSchedule>({
    ...DEFAULT_CLAIM_POOL_GENERATION_SCHEDULE,
  });
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<"dry_run" | "apply" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOutcome, setLastOutcome] = useState<ClaimPoolRunOutcome | null>(null);

  const load = useCallback(async () => {
    if (!orgId || !storeId) return;
    setLoading(true);
    setError(null);
    const res = await getClaimPoolGenerationStatusAction({ organizationId: orgId, storeId });
    if (res.ok) {
      setStatus(res.status);
      setDraft(res.status.schedule);
      setSelectedSources(res.status.schedule.enabled_source_kinds);
    } else {
      setError(res.error);
    }
    setLoading(false);
  }, [orgId, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (patch: Partial<ClaimPoolGenerationSchedule>) =>
    setDraft((d) => ({ ...d, ...patch }));

  async function onSave() {
    setSaving(true);
    setMessage(null);
    setError(null);
    const res = await saveClaimPoolGenerationScheduleAction({
      organizationId: orgId,
      storeId,
      schedule: draft,
    });
    if (res.ok) {
      setDraft(res.schedule);
      setMessage("Claim pool generation settings saved.");
      void load();
    } else {
      setError(res.error);
    }
    setSaving(false);
  }

  async function onRun(apply: boolean) {
    setRunning(apply ? "apply" : "dry_run");
    setMessage(null);
    setError(null);
    setLastOutcome(null);
    const res = await runClaimPoolGenerationNowAction({
      organizationId: orgId,
      storeId,
      sources: selectedSources.length ? selectedSources : null,
      windowFrom: draft.manual_window_start,
      windowTo: draft.manual_window_end,
      apply,
    });
    if (res.ok) {
      setLastOutcome(res.outcome);
      const c = res.outcome.counts;
      setMessage(
        `${apply ? "Apply" : "Dry-run"} finished — generated ${c.generated}, updated ${c.updated}, superseded ${c.superseded}, legacy corroborated ${c.quarantined_corroborated} (drafts in memory: ${c.drafts_in_memory}).`,
      );
      void load();
    } else {
      setError(res.error);
    }
    setRunning(null);
  }

  const runtime = status?.cron_runtime ?? null;
  const lastRun = formatAutomationTimestamp(runtime?.last_run_at ?? null);
  const nextRun = formatAutomationTimestamp(status?.next_run_at ?? null);

  const toggleSource = (kind: string) =>
    setSelectedSources((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    );

  return (
    <>
      <ClaimCandidateIntakePolicyPanel
        organizationId={orgId}
        storeId={storeId}
        editableScopes={["platform", "company", "store"]}
        className="mb-6"
      />
      <section className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
          <ShieldCheck className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-foreground">Claim Pool Generation</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Rebuilds claim candidates from trusted sources into the unified pool
            (claim_candidates only — no cases or lines are created).
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-2 rounded-lg border border-border/70 bg-muted/10 p-3 text-xs text-muted-foreground sm:grid-cols-3">
        <span>
          Last run: {lastRun.primary}
          {lastRun.secondary ? ` · ${lastRun.secondary}` : ""}
        </span>
        <span>
          Next run: {draft.enabled ? nextRun.primary : "Off — not scheduled"}
        </span>
        <span className="flex items-center gap-2">
          Status <StatusPill status={runtime?.last_run_status ?? "never"} />
        </span>
        {runtime?.last_error ? (
          <span className="text-red-700 dark:text-red-300 sm:col-span-3">
            Last error: {runtime.last_error}
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading claim pool settings…
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <EnabledToggle
            checked={draft.enabled}
            onChange={(v) => update({ enabled: v })}
            title="Schedule enabled"
            description="When off, no scheduled claim pool generation runs."
          />

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block text-sm">
              <span className="font-medium text-foreground">Runs per day</span>
              <input
                type="number"
                min={1}
                max={24}
                value={draft.runs_per_day}
                onChange={(e) => update({ runs_per_day: Number(e.target.value) })}
                className={`${responsiveFormInput} mt-1.5`}
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-foreground">Local run times (HH:MM)</span>
              <input
                type="text"
                value={draft.run_times_local.join(", ")}
                onChange={(e) =>
                  update({
                    run_times_local: e.target.value
                      .split(/[,;\s]+/)
                      .map((t) => t.trim())
                      .filter(Boolean),
                  })
                }
                className={`${responsiveFormInput} mt-1.5`}
                placeholder="02:30"
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-foreground">Timezone (IANA)</span>
              <input
                type="text"
                value={draft.timezone}
                onChange={(e) => update({ timezone: e.target.value })}
                className={`${responsiveFormInput} mt-1.5`}
                placeholder="America/Los_Angeles"
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-foreground">Max runtime (seconds)</span>
              <input
                type="number"
                min={60}
                max={3600}
                value={draft.max_runtime_seconds}
                onChange={(e) => update({ max_runtime_seconds: Number(e.target.value) })}
                className={`${responsiveFormInput} mt-1.5`}
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block text-sm">
              <span className="font-medium text-foreground">Rolling window (days)</span>
              <input
                type="number"
                min={1}
                max={365}
                value={draft.rolling_days}
                onChange={(e) => update({ rolling_days: Number(e.target.value) })}
                className={`${responsiveFormInput} mt-1.5`}
              />
              <RollingWindowHelp />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-foreground">Manual window start</span>
              <input
                type="date"
                value={draft.manual_window_start ?? ""}
                onChange={(e) => update({ manual_window_start: e.target.value || null })}
                className={`${responsiveFormInput} mt-1.5`}
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-foreground">Manual window end</span>
              <input
                type="date"
                value={draft.manual_window_end ?? ""}
                onChange={(e) => update({ manual_window_end: e.target.value || null })}
                className={`${responsiveFormInput} mt-1.5`}
              />
              <ManualWindowHelp />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-foreground">Scheduled run mode</span>
              <select
                value={draft.scheduled_mode}
                onChange={(e) =>
                  update({ scheduled_mode: e.target.value === "apply" ? "apply" : "dry_run" })
                }
                className={`${responsiveFormInput} mt-1.5`}
              >
                <option value="dry_run">Dry-run (counts only)</option>
                <option value="apply">Apply (write candidates)</option>
              </select>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Scheduled apply additionally requires the server env gate.
              </p>
            </label>
          </div>

          <div className="rounded-lg border border-border/60 bg-background/50 p-3">
            <span className="block text-sm font-semibold text-foreground">Enabled sources</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Scheduled and manual runs only use checked sources. 👑 marks sources gated off by the
              current plan (not purchased).
            </span>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {CLAIM_POOL_SOURCE_KINDS.map((kind) => {
                const purchased = draft.purchased_source_kinds[kind] !== false;
                const enabled = draft.enabled_source_kinds.includes(kind);
                return (
                  <label
                    key={kind}
                    className={`flex items-center gap-2 text-sm ${purchased ? "" : "opacity-60"}`}
                  >
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={!purchased}
                      onChange={() =>
                        update({
                          enabled_source_kinds: enabled
                            ? draft.enabled_source_kinds.filter((k) => k !== kind)
                            : [...draft.enabled_source_kinds, kind],
                        })
                      }
                      className="rounded border-border"
                    />
                    <span>
                      {SOURCE_LABELS[kind] ?? kind}
                      {!purchased ? " 👑" : ""}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="rounded-lg border border-border/60 bg-background/50 p-3">
            <span className="block text-sm font-semibold text-foreground">Manual run</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Runs selected sources for the manual window (or rolling window when empty). Dry-run
              never writes; Apply upserts claim_candidates by dedupe key.
            </span>
            <div className="mt-3 flex flex-wrap gap-2">
              {CLAIM_POOL_SOURCE_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => toggleSource(kind)}
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    selectedSources.includes(kind)
                      ? "border-cyan-500/60 bg-cyan-500/10 text-cyan-900 dark:text-cyan-100"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  {SOURCE_LABELS[kind] ?? kind}
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={running !== null}
                onClick={() => void onRun(false)}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/40 disabled:opacity-50"
              >
                {running === "dry_run" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Run dry-run now
              </button>
              <button
                type="button"
                disabled={running !== null}
                onClick={() => void onRun(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
              >
                {running === "apply" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Run apply now
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void onSave()}
                className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-900 hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-100"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Save schedule
              </button>
            </div>
          </div>

          {error ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          {message ? (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-100">
              {message}
            </div>
          ) : null}

          {lastOutcome ? (
            <div className="rounded-lg border border-border/70 bg-muted/10 p-3 text-xs">
              <span className="font-semibold text-foreground">
                Run {lastOutcome.run_id.slice(0, 8)} · {lastOutcome.mode} · {lastOutcome.window.from} →{" "}
                {lastOutcome.window.to}
              </span>
              <table className="mt-2 w-full text-left">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Source</th>
                    <th className="py-1 pr-2 font-medium">Matched</th>
                    <th className="py-1 pr-2 font-medium">Drafts</th>
                    <th className="py-1 pr-2 font-medium">Generated</th>
                    <th className="py-1 pr-2 font-medium">Updated</th>
                    <th className="py-1 pr-2 font-medium">Superseded</th>
                    <th className="py-1 pr-2 font-medium">Corroborated</th>
                  </tr>
                </thead>
                <tbody>
                  {lastOutcome.per_source
                    .filter((r) => r.ran || r.error)
                    .map((r) => (
                      <tr key={r.source_kind} className="border-t border-border/40">
                        <td className="py-1 pr-2">{SOURCE_LABELS[r.source_kind] ?? r.source_kind}</td>
                        <td className="py-1 pr-2">{r.matched}</td>
                        <td className="py-1 pr-2">{r.drafts}</td>
                        <td className="py-1 pr-2">{r.inserted}</td>
                        <td className="py-1 pr-2">{r.updated}</td>
                        <td className="py-1 pr-2">{r.superseded}</td>
                        <td className="py-1 pr-2">{r.corroborated}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {lastOutcome.blocked_sources.length ? (
                <p className="mt-2 text-muted-foreground">
                  Blocked: {lastOutcome.blocked_sources.map((b) => `${b.source_kind} (${b.reason})`).join(", ")}
                </p>
              ) : null}
            </div>
          ) : null}

          {status?.recent_runs.length ? (
            <div className="rounded-lg border border-border/70 bg-muted/10 p-3 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">Recent runs (audit log)</span>
              <ul className="mt-2 space-y-1">
                {status.recent_runs.map((r, i) => {
                  const counts =
                    r.result && typeof r.result.counts === "object" && r.result.counts !== null
                      ? (r.result.counts as Record<string, unknown>)
                      : null;
                  return (
                    <li key={i}>
                      {r.created_at?.slice(0, 16).replace("T", " ") ?? "—"} · {r.action} ·{" "}
                      {String(r.result?.mode ?? "")} · {r.actor_email ?? "scheduler"}
                      {counts
                        ? ` · generated ${String(counts.generated ?? 0)}, updated ${String(counts.updated ?? 0)}`
                        : ""}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </section>
    </>
  );
}
