"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Database, Loader2, RefreshCw } from "lucide-react";

import { responsiveFormInput, responsivePageInner, responsivePageOuter } from "@/lib/responsive-page-shell";
import {
  readAutomationScopeStorage,
  writeAutomationScopeStorage,
} from "@/lib/platform-automation-api-report-type";
import {
  listPlatformAutomationOrganizationsAction,
  listPlatformAutomationStoresAction,
  type OrganizationOption,
} from "../automation-settings-actions";
import {
  dataSourceBadgeMeta,
  type DataSourceHubRow,
  type DataSourcesHubPayload,
} from "@/lib/data-sources/data-sources-hub-contract";

type StoreOption = { id: string; name: string; platform: string };

const TONE_CLASS: Record<string, string> = {
  success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200",
  info: "bg-sky-500/15 text-sky-700 dark:text-sky-200",
  warning: "bg-amber-500/15 text-amber-800 dark:text-amber-100",
  danger: "bg-rose-500/15 text-rose-700 dark:text-rose-200",
  neutral: "bg-foreground/10 text-muted-foreground",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function SourceRow({ row }: { row: DataSourceHubRow }) {
  const meta = dataSourceBadgeMeta(row.badge);
  return (
    <tr className="border-t border-border/60 align-top">
      <td className="px-3 py-2">
        <p className="font-medium text-foreground">{row.display_name}</p>
        <p className="font-mono text-[10px] text-muted-foreground">{row.report_type_or_api_endpoint}</p>
      </td>
      <td className="px-3 py-2 text-xs capitalize text-muted-foreground">{row.source_domain}</td>
      <td className="px-3 py-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${TONE_CLASS[meta.tone] ?? TONE_CLASS.neutral}`}>
          {meta.label}
        </span>
      </td>
      <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">
        {row.row_count != null ? row.row_count.toLocaleString() : "—"}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(row.latest_event_date)}</td>
      <td className="px-3 py-2 text-xs text-muted-foreground">{row.schedule}</td>
      <td className="px-3 py-2 text-xs text-muted-foreground">{row.worker_flag ?? "—"}</td>
    </tr>
  );
}

export function DataSourcesHubControlPlaneClient() {
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [orgId, setOrgId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [accessDenied, setAccessDenied] = useState<string | null>(null);
  const [payload, setPayload] = useState<DataSourcesHubPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const orgRes = await listPlatformAutomationOrganizationsAction();
      if (cancelled) return;
      if (orgRes.accessDenied) {
        setAccessDenied(orgRes.accessDenied);
        setLoading(false);
        return;
      }
      setOrganizations(orgRes.organizations);
      const stored = readAutomationScopeStorage();
      const initialOrg =
        stored.orgId && orgRes.organizations.some((o) => o.id === stored.orgId)
          ? stored.orgId
          : orgRes.organizations[0]?.id ?? "";
      setOrgId(initialOrg);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!orgId) {
      setStores([]);
      setStoreId("");
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await listPlatformAutomationStoresAction(orgId);
      if (cancelled) return;
      const list = res.accessDenied ? [] : res.stores;
      setStores(list);
      const stored = readAutomationScopeStorage();
      const pick =
        stored.orgId === orgId && stored.storeId && list.some((s) => s.id === stored.storeId)
          ? stored.storeId
          : list.find((s) => (s.platform ?? "").toLowerCase().includes("amazon"))?.id ?? list[0]?.id ?? "";
      setStoreId(pick);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organization_id: orgId, view: "control_plane" });
      if (storeId) params.set("store_id", storeId);
      const res = await fetch(`/api/platform/data-sources/status?${params.toString()}`, { cache: "no-store" });
      const json = (await res.json()) as DataSourcesHubPayload & { ok?: boolean; error?: string };
      if (!res.ok || json.ok === false) throw new Error(json.error ?? "Failed to load data sources hub.");
      setPayload(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data sources hub.");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [orgId, storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onOrgChange = (next: string) => {
    setOrgId(next);
    writeAutomationScopeStorage(next, "");
  };
  const onStoreChange = (next: string) => {
    setStoreId(next);
    writeAutomationScopeStorage(orgId, next);
  };

  const totals = payload?.totals;
  const selectedOrgName = useMemo(
    () => organizations.find((o) => o.id === orgId)?.name ?? null,
    [organizations, orgId],
  );

  // Aggregate SP-API credential presence across control-plane sources (never the secret itself).
  const credentialPresent = useMemo(() => {
    if (!payload) return false;
    const controlPlane = payload.sources.filter((s) => s.is_control_plane_source);
    return controlPlane.length > 0 && controlPlane.every((s) => s.credential_status !== "missing");
  }, [payload]);

  if (accessDenied) {
    return (
      <div className={responsivePageOuter}>
        <div className={responsivePageInner}>
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">{accessDenied}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={responsivePageOuter}>
      <div className={`${responsivePageInner} space-y-6`}>
        <header className="space-y-2">
          <h1 className="flex items-center gap-2 text-xl font-bold sm:text-2xl">
            <Database className="h-5 w-5 opacity-70" /> Data Sources (control plane)
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            The single source of truth for every API / import / sync status. Claim Center, Data Coverage,
            Ready-to-File and Product Story all read from this same hub. Read-only — configure schedules and run
            jobs in{" "}
            <Link href="/platform/settings/automation" className="underline underline-offset-2">
              Automation API Center
            </Link>
            .
          </p>
        </header>

        <section className="rounded-2xl border-2 border-violet-500/25 bg-card p-4 shadow-sm sm:p-5" aria-label="Data sources scope">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="font-medium text-foreground">Company / organization</span>
                <select
                  value={orgId}
                  onChange={(e) => onOrgChange(e.target.value)}
                  className={`${responsiveFormInput} mt-1.5`}
                  aria-label="Data sources company"
                >
                  {organizations.length === 0 ? <option value="">No companies available</option> : null}
                  {organizations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="font-medium text-foreground">Store / account</span>
                <select
                  value={storeId}
                  disabled={!orgId || !stores.length}
                  onChange={(e) => onStoreChange(e.target.value)}
                  className={`${responsiveFormInput} mt-1.5`}
                  aria-label="Data sources store"
                >
                  {!stores.length ? (
                    <option value="">{orgId ? "All stores for this company" : "Select a company first"}</option>
                  ) : (
                    <option value="">All stores</option>
                  )}
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.platform})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted/40"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
            </button>
          </div>
          <p className="mt-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Current scope: <strong className="text-foreground">{selectedOrgName ?? "—"}</strong>
            {storeId ? <> · {stores.find((s) => s.id === storeId)?.name ?? storeId}</> : " · all stores"}
          </p>
        </section>

        {loading ? (
          <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading data sources hub…
          </div>
        ) : error ? (
          <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-200">
            {error}
          </p>
        ) : payload && totals ? (
          <div className="space-y-6">
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
              {(
                [
                  ["Total", totals.total_sources, "neutral"],
                  ["Live", totals.live, "success"],
                  ["Healthy", totals.healthy, "success"],
                  ["Local only", totals.local_only, "info"],
                  ["Stale", totals.stale, "warning"],
                  ["Needs sync", totals.needs_initial_sync, "warning"],
                  ["Needs env", totals.needs_env, "warning"],
                  ["Disabled", totals.disabled, "neutral"],
                ] as Array<[string, number, string]>
              ).map(([label, value, tone]) => (
                <div key={label} className="rounded-xl border border-border/60 bg-card p-3">
                  <p className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</p>
                  <p className={`mt-1 text-xl font-bold tabular-nums ${tone === "success" ? "text-emerald-600 dark:text-emerald-300" : tone === "warning" ? "text-amber-600 dark:text-amber-300" : ""}`}>
                    {value}
                  </p>
                </div>
              ))}
            </section>

            <section
              className={`rounded-xl border px-4 py-3 ${
                payload.safe_to_run_initial_live_source_sync
                  ? "border-emerald-500/30 bg-emerald-500/10"
                  : "border-amber-500/30 bg-amber-500/10"
              }`}
              aria-label="Initial live-sync readiness"
            >
              <p className="text-sm font-bold text-foreground">
                Initial live-sync readiness:{" "}
                <span
                  className={
                    payload.safe_to_run_initial_live_source_sync
                      ? "text-emerald-700 dark:text-emerald-300"
                      : "text-amber-800 dark:text-amber-200"
                  }
                >
                  {payload.safe_to_run_initial_live_source_sync ? "READY (env complete)" : "BLOCKED"}
                </span>
              </p>
              <ul className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                <li>
                  Worker master flag:{" "}
                  <strong className={payload.worker_master_enabled ? "text-emerald-600 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300"}>
                    {payload.worker_master_enabled ? "enabled" : "DISABLED — ENABLE_AMAZON_REPORTS_API_WORKER"}
                  </strong>
                </li>
                <li>
                  CRON_SECRET:{" "}
                  <strong className={payload.cron_secret_present ? "text-emerald-600 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300"}>
                    {payload.cron_secret_present ? "present" : "ABSENT"}
                  </strong>
                </li>
                <li>
                  SP-API credentials:{" "}
                  <strong className={credentialPresent ? "text-emerald-600 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300"}>
                    {credentialPresent ? "present" : "missing / incomplete"}
                  </strong>
                </li>
                <li>
                  Operator approval (required separately):{" "}
                  <strong className="text-amber-700 dark:text-amber-300">
                    APPROVED_AMAZON_INITIAL_LIVE_SOURCE_SYNC_V1=yes
                  </strong>{" "}
                  in <code className="font-mono">.cursor/operator-approvals/amazon-initial-live-source-sync-v1-approval.md</code>
                </li>
              </ul>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Even when env is READY, the initial sync stays gated until the operator approval token is set to
                <code className="mx-1 font-mono">yes</code>. Env readiness here does not call Amazon.
              </p>
            </section>

            {payload.missing_env_keys.length > 0 ? (
              <section className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                <p className="text-sm font-bold text-amber-900 dark:text-amber-100">
                  Environment blockers before live sync is safe
                </p>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-amber-900/90 dark:text-amber-100/90">
                  {payload.missing_env_keys.map((k) => (
                    <li key={k} className="font-mono">
                      {k}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="overflow-x-auto rounded-xl border border-border/60">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/40 text-[11px] uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Source</th>
                    <th className="px-3 py-2">Domain</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Rows</th>
                    <th className="px-3 py-2">Latest</th>
                    <th className="px-3 py-2">Schedule</th>
                    <th className="px-3 py-2">Worker flag</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.sources.map((row) => (
                    <SourceRow key={row.source_key} row={row} />
                  ))}
                </tbody>
              </table>
            </section>

            <details className="rounded-xl border border-border/60 bg-card p-3">
              <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">
                Developer details (raw hub payload)
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted/30 p-3 text-[10px]">
                {JSON.stringify(payload, null, 2)}
              </pre>
            </details>
          </div>
        ) : (
          <p className="py-12 text-sm text-muted-foreground">No data sources available.</p>
        )}
      </div>
    </div>
  );
}
