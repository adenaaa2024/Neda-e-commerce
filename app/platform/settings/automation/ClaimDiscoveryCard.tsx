"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";

import {
  CLAIM_DISCOVERY_SOURCE_KINDS,
  DEFAULT_CLAIM_DISCOVERY_SCHEDULE,
  type ClaimDiscoverySchedule,
} from "@/lib/platform-automation-settings-types";
import { formatAutomationTimestamp } from "@/lib/platform-automation-ui-format";
import { responsiveFormInput } from "@/lib/responsive-page-shell";
import { discoverySourceLabel } from "@/lib/claims/discovery/claim-discovery-source-catalog";
import type { ClaimDiscoveryRunOutcome } from "@/lib/claims/discovery/claim-discovery-types";
import {
  getClaimDiscoveryStatusAction,
  runClaimDiscoveryNowAction,
  saveClaimDiscoveryScheduleAction,
  type ClaimDiscoveryStatus,
} from "./claim-discovery-actions";
import { EnabledToggle, ManualWindowHelp, StatusPill } from "./automation-api-center-shared";

export function ClaimDiscoveryCard({ orgId, storeId }: { orgId: string; storeId: string }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<ClaimDiscoveryStatus | null>(null);
  const [draft, setDraft] = useState<ClaimDiscoverySchedule>({ ...DEFAULT_CLAIM_DISCOVERY_SCHEDULE });
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<"dry_run" | "apply" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOutcome, setLastOutcome] = useState<ClaimDiscoveryRunOutcome | null>(null);

  const load = useCallback(async () => {
    if (!orgId || !storeId) return;
    setLoading(true);
    setError(null);
    const res = await getClaimDiscoveryStatusAction({ organizationId: orgId, storeId });
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

  const update = (patch: Partial<ClaimDiscoverySchedule>) =>
    setDraft((d) => ({ ...d, ...patch }));

  async function onSave() {
    setSaving(true);
    setMessage(null);
    setError(null);
    const res = await saveClaimDiscoveryScheduleAction({
      organizationId: orgId,
      storeId,
      schedule: { ...draft, enabled_source_kinds: selectedSources },
    });
    if (res.ok) {
      setDraft(res.schedule);
      setMessage("Claim discovery settings saved.");
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
    const res = await runClaimDiscoveryNowAction({
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
        `${apply ? "Apply" : "Dry-run"} — indexed ${c.sources_ran} source(s), generated ${c.generated}, updated ${c.updated}, eligibility queue ${c.queue_eligible}/${c.queue_total}.`,
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
    <section className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-700 dark:text-violet-300">
          <Search className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-foreground">Claim Discovery Engine</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Incremental per-source discovery into claim_candidates. Uses watermarks — no full-table
            scans after the initial lookback.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-2 rounded-lg border border-border/70 bg-muted/10 p-3 text-xs text-muted-foreground sm:grid-cols-3">
        <span>
          Last run: {lastRun.primary}
          {lastRun.secondary ? ` · ${lastRun.secondary}` : ""}
        </span>
        <span>Next run: {draft.enabled ? nextRun.primary : "Off — not scheduled"}</span>
        <span className="flex items-center gap-2">
          Status <StatusPill status={runtime?.last_run_status ?? "never"} />
        </span>
      </div>

      {loading ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading discovery settings…
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <EnabledToggle
            checked={draft.enabled}
            onChange={(v) => update({ enabled: v })}
            title="Daily schedule enabled"
            description="Runs incremental discovery per enabled source at configured local times."
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
              <span className="font-medium text-foreground">Local run times</span>
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
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-foreground">Initial lookback (days)</span>
              <input
                type="number"
                min={1}
                max={90}
                value={draft.initial_lookback_days}
                onChange={(e) => update({ initial_lookback_days: Number(e.target.value) })}
                className={`${responsiveFormInput} mt-1.5`}
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-foreground">Incremental overlap (days)</span>
              <input
                type="number"
                min={0}
                max={14}
                value={draft.incremental_overlap_days}
                onChange={(e) => update({ incremental_overlap_days: Number(e.target.value) })}
                className={`${responsiveFormInput} mt-1.5`}
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
              <span className="font-medium text-foreground">Scheduled mode</span>
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

          <fieldset className="rounded-lg border border-border/70 p-3">
            <legend className="px-1 text-sm font-medium text-foreground">Discovery sources</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {CLAIM_DISCOVERY_SOURCE_KINDS.map((kind) => (
                <label key={kind} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedSources.includes(kind)}
                    onChange={() => toggleSource(kind)}
                  />
                  {discoverySourceLabel(kind)}
                </label>
              ))}
            </div>
          </fieldset>

          {status?.discovery_index?.sources ? (
            <div className="rounded-lg border border-border/60 bg-muted/5 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Per-source watermarks</p>
              <ul className="mt-2 space-y-1">
                {CLAIM_DISCOVERY_SOURCE_KINDS.filter((k) => status.discovery_index.sources[k]).map(
                  (k) => {
                    const row = status.discovery_index.sources[k]!;
                    return (
                      <li key={k}>
                        {discoverySourceLabel(k)}: through {row.last_through_date ?? "—"} (
                        {row.rows_indexed} rows indexed)
                      </li>
                    );
                  },
                )}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void onSave()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save schedule"}
            </button>
            <button
              type="button"
              disabled={!!running}
              onClick={() => void onRun(false)}
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {running === "dry_run" ? "Running…" : "Dry-run discovery"}
            </button>
            <button
              type="button"
              disabled={!!running}
              onClick={() => void onRun(true)}
              className="rounded-lg border border-emerald-600 px-4 py-2 text-sm font-semibold text-emerald-800 dark:text-emerald-200 disabled:opacity-50"
            >
              {running === "apply" ? "Applying…" : "Apply discovery"}
            </button>
          </div>

          {message ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p> : null}
          {error ? <p className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}

          {lastOutcome ? (
            <pre className="max-h-48 overflow-auto rounded-lg bg-muted/20 p-3 text-[11px]">
              {JSON.stringify(
                {
                  indexed_sources: lastOutcome.indexed_sources,
                  counts: lastOutcome.counts,
                  candidate_queue_sample: lastOutcome.candidate_queue.slice(0, 5),
                },
                null,
                2,
              )}
            </pre>
          ) : null}
        </div>
      )}
    </section>
  );
}
