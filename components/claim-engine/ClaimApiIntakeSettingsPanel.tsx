"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type { IntakeSourceConnectionStatus } from "@/lib/claim-api-intake-settings-status";

const STATUS_DOT: Record<string, string> = {
  connected: "bg-emerald-500",
  disabled: "bg-amber-400",
  offline: "bg-slate-300 dark:bg-slate-600",
};

function fmtTs(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function ClaimApiIntakeSettingsPanel(props: {
  organizationId: string | null;
  storeId: string | null;
}) {
  const { organizationId, storeId } = props;
  const [sources, setSources] = useState<IntakeSourceConnectionStatus[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [genMsg, setGenMsg] = useState<string | null>(null);
  const [genBusy, setGenBusy] = useState(false);

  const load = useCallback(async () => {
    if (!organizationId || !storeId) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/claims/intake/settings-status?organization_id=${encodeURIComponent(organizationId)}&store_id=${encodeURIComponent(storeId)}`,
      );
      const j = (await res.json()) as {
        ok?: boolean;
        error?: string;
        sources?: IntakeSourceConnectionStatus[];
        missing_settings?: string[];
      };
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setSources(j.sources ?? []);
      setMissing(j.missing_settings ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load intake settings");
    } finally {
      setLoading(false);
    }
  }, [organizationId, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runGeneratorDryRun = async () => {
    if (!organizationId || !storeId) return;
    setGenBusy(true);
    setGenMsg(null);
    try {
      const res = await fetch("/api/claims/intake/generate-candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization_id: organizationId,
          store_id: storeId,
          dry_run: true,
          limit_per_table: 50,
        }),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string; batches?: { built: number; source_table: string }[] };
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      const total = (j.batches ?? []).reduce((s, b) => s + b.built, 0);
      setGenMsg(`Dry-run: ${total} candidate(s) would be built (no writes).`);
    } catch (e) {
      setGenMsg(e instanceof Error ? e.message : "Generator dry-run failed");
    } finally {
      setGenBusy(false);
    }
  };

  if (!organizationId || !storeId) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-3 py-3 text-xs text-muted-foreground dark:border-slate-800 dark:bg-slate-950">
        Select a store to view API & intake connection status.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-4 dark:border-slate-800 dark:bg-slate-950">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">API & intake settings</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Read-only status. No sync runs on page load. Manual runs via Automation or explicit generator dry-run.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void runGeneratorDryRun()}
            disabled={genBusy}
            className="rounded-md border border-violet-300 bg-violet-50 px-2 py-1 text-xs font-medium text-violet-900 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-100"
          >
            {genBusy ? "Dry-run…" : "Dry-run intake generator"}
          </button>
          <Link
            href="/platform/settings/automation"
            className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
          >
            Automation settings
          </Link>
        </div>
      </div>

      {err ? <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{err}</p> : null}
      {genMsg ? <p className="mt-2 text-xs text-violet-800 dark:text-violet-200">{genMsg}</p> : null}
      {missing.length ? (
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
          Missing server flags / credentials: {missing.join(", ")}
        </p>
      ) : null}

      <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
        {sources.map((s) => {
          const dot = s.disabled_by_setting ? STATUS_DOT.disabled : s.connected ? STATUS_DOT.connected : STATUS_DOT.offline;
          return (
            <li key={s.kind} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-block h-2 w-2 rounded-full ${dot}`} aria-hidden />
                <span className="text-sm font-medium text-foreground">{s.label}</span>
                <span className="text-[10px] uppercase text-muted-foreground">{s.generator_status}</span>
              </div>
              <div className="mt-1 grid gap-0.5 text-[11px] text-muted-foreground sm:grid-cols-2">
                <span>Last sync: {fmtTs(s.last_sync_at)} ({s.last_sync_status})</span>
                <span>Next sync: {fmtTs(s.next_sync_at)}</span>
                {s.last_error ? <span className="text-rose-600 dark:text-rose-400 sm:col-span-2">Error: {s.last_error}</span> : null}
                {s.disabled_reason ? (
                  <span className="text-amber-700 dark:text-amber-300 sm:col-span-2">Disabled: {s.disabled_reason}</span>
                ) : null}
              </div>
              {s.manual_run_available && s.manual_run_href ? (
                <Link href={s.manual_run_href} className="mt-1 inline-block text-[11px] font-medium text-violet-700 underline dark:text-violet-300">
                  Manual run →
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
