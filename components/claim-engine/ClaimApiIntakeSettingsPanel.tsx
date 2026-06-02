"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

import type { IntakeSourceConnectionStatus } from "@/lib/claim-api-intake-settings-status";
import { ClaimSourceBadge } from "@/components/claim-engine/ClaimSourceBadge";
import type { ClaimIntakeSourceKind } from "@/lib/claim-intake-sources";

function fmtTs(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function statusLabel(s: IntakeSourceConnectionStatus): string {
  if (s.disabled_by_setting) return "Disabled";
  if (s.connected) return "Connected";
  return "Not connected";
}

function statusClass(s: IntakeSourceConnectionStatus): string {
  if (s.disabled_by_setting) return "text-amber-700 dark:text-amber-300";
  if (s.connected) return "text-emerald-700 dark:text-emerald-300";
  return "text-slate-500 dark:text-slate-400";
}

const KIND_BY_LABEL: Record<string, ClaimIntakeSourceKind> = {
  "Physical return scan": "physical_return",
  "Amazon return reports": "amazon_return",
  "Removal orders & shipments": "removal",
  Reimbursements: "reimbursement",
  Settlements: "settlement",
  "Manual entry": "manual",
  "Inventory / QC": "inventory",
};

export function ClaimApiIntakeSettingsPanel(props: {
  organizationId: string | null;
  storeId: string | null;
  defaultCollapsed?: boolean;
}) {
  const { organizationId, storeId, defaultCollapsed = true } = props;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sources, setSources] = useState<IntakeSourceConnectionStatus[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
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
      setLoaded(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [organizationId, storeId]);

  useEffect(() => {
    if (!collapsed && organizationId && storeId && !loaded && !loading) {
      void load();
    }
  }, [collapsed, organizationId, storeId, loaded, loading, load]);

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
      const j = (await res.json()) as { ok?: boolean; error?: string; batches?: { built: number }[] };
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      const total = (j.batches ?? []).reduce((s, b) => s + b.built, 0);
      setGenMsg(`Dry-run: ${total} would build (no writes).`);
    } catch (e) {
      setGenMsg(e instanceof Error ? e.message : "Dry-run failed");
    } finally {
      setGenBusy(false);
    }
  };

  if (!organizationId || !storeId) {
    return (
      <p className="text-[11px] text-muted-foreground">Select a store to view API connection status.</p>
    );
  }

  const apiSources = sources.filter((s) => s.kind !== "physical_return" && s.kind !== "manual");

  return (
    <div className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-slate-800 dark:text-slate-100"
      >
        <span className="flex items-center gap-1.5">
          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          API & intake connections
        </span>
        <span className="text-[10px] font-normal text-muted-foreground">Read-only · expand to load</span>
      </button>

      {!collapsed ? (
        <div className="border-t border-slate-100 px-3 pb-3 dark:border-slate-800">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="rounded border border-slate-200 px-2 py-0.5 text-[10px] font-medium hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900"
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
            <button
              type="button"
              onClick={() => void runGeneratorDryRun()}
              disabled={genBusy}
              className="rounded border border-violet-300 bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-900 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-100"
            >
              {genBusy ? "Dry-run…" : "Dry-run generator"}
            </button>
            <Link
              href="/platform/settings/automation"
              className="text-[10px] font-medium text-violet-700 underline dark:text-violet-300"
            >
              Automation
            </Link>
          </div>

          {err ? <p className="mb-2 text-[11px] text-rose-600">{err}</p> : null}
          {genMsg ? <p className="mb-2 text-[11px] text-violet-800 dark:text-violet-200">{genMsg}</p> : null}

          {loading && !sources.length ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-[11px]">
                <thead>
                  <tr className="border-b border-slate-100 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground dark:border-slate-800">
                    <th className="py-1 pr-2 text-left">Source</th>
                    <th className="py-1 pr-2 text-left">Status</th>
                    <th className="py-1 pr-2 text-left">Last sync</th>
                    <th className="py-1 pr-2 text-left">Next sync</th>
                    <th className="py-1 pr-2 text-left">Last error</th>
                    <th className="py-1 text-left">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {apiSources.map((s) => {
                    const kind = KIND_BY_LABEL[s.label] ?? s.kind;
                    return (
                      <tr key={s.kind} className="border-b border-slate-50 last:border-0 dark:border-slate-900">
                        <td className="py-1.5 pr-2 align-top">
                          <ClaimSourceBadge kind={kind} />
                        </td>
                        <td className={`py-1.5 pr-2 align-top font-medium ${statusClass(s)}`}>{statusLabel(s)}</td>
                        <td className="py-1.5 pr-2 align-top text-muted-foreground">
                          {fmtTs(s.last_sync_at)}
                          {s.last_sync_status !== "never" ? (
                            <span className="ml-1 text-[10px]">({s.last_sync_status})</span>
                          ) : null}
                        </td>
                        <td className="py-1.5 pr-2 align-top text-muted-foreground">{fmtTs(s.next_sync_at)}</td>
                        <td className="max-w-[140px] truncate py-1.5 pr-2 align-top text-rose-600 dark:text-rose-400" title={s.last_error ?? undefined}>
                          {s.last_error ? s.last_error : "—"}
                        </td>
                        <td className="py-1.5 align-top">
                          {s.manual_run_available && s.manual_run_href ? (
                            <Link href={s.manual_run_href} className="font-medium text-violet-700 underline dark:text-violet-300">
                              Run
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="mt-2 flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground"
          >
            {advancedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Advanced
          </button>
          {advancedOpen ? (
            <div className="mt-1 space-y-1 text-[10px] text-muted-foreground">
              {missing.length ? <p>Missing flags: {missing.join(", ")}</p> : <p>All checked server flags present.</p>}
              {sources
                .filter((s) => s.disabled_reason)
                .map((s) => (
                  <p key={s.kind}>
                    {s.label}: {s.disabled_reason}
                  </p>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
