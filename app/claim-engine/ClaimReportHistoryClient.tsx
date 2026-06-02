"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { ClaimEngineEmptyState } from "@/components/claim-engine/ClaimEngineEmptyState";
import { ClaimEnginePageShell } from "@/components/claim-engine/ClaimEnginePageShell";
import {
  CLAIM_ENGINE_BTN_PRIMARY,
  CLAIM_ENGINE_CARD_CLASS,
  CLAIM_ENGINE_MAIN_CLASS,
  CLAIM_ENGINE_SECTION_CLASS,
  CLAIM_ENGINE_TABLE_CLASS,
  CLAIM_ENGINE_TABLE_HEAD_CLASS,
  CLAIM_ENGINE_TABLE_ROW_CLASS,
} from "@/components/claim-engine/claim-engine-ui";
import {
  listClaimReportHistory,
  type ClaimReportHistoryRow,
  type ClaimReportHistoryStatusLabel,
} from "./claim-report-history-actions";
import { refreshClaimReportSignedUrl } from "./claim-submission-actions";

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function toYyyyMmDd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startUtcIsoFromYyyyMmDd(s: string): string {
  const t = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return new Date(0).toISOString();
  return `${t}T00:00:00.000Z`;
}

function endUtcIsoFromYyyyMmDd(s: string): string {
  const t = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return new Date().toISOString();
  return `${t}T23:59:59.999Z`;
}

const STATUS_BADGE: Record<ClaimReportHistoryStatusLabel, string> = {
  Generated: "border-slate-200 bg-slate-100 text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
  Submitted: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  Denied: "border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200",
  "Generating...": "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200",
  Failed: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400",
};

function isHttpUrl(path: string): boolean {
  return /^https?:\/\//i.test(path.trim());
}

export function ClaimReportHistoryClient({
  organizationId,
  initialRows,
  initialError,
}: {
  organizationId: string;
  initialRows: ClaimReportHistoryRow[];
  initialError: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<ClaimReportHistoryRow[]>(initialRows);
  const [loadError, setLoadError] = useState<string | null>(initialError);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const now = useMemo(() => new Date(), []);
  const defaultTo = useMemo(() => toYyyyMmDd(now), [now]);
  const defaultFrom = useMemo(() => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 90);
    return toYyyyMmDd(d);
  }, [now]);

  const urlFrom = searchParams.get("from");
  const urlTo = searchParams.get("to");
  const urlType = searchParams.get("type");

  const [dateFrom, setDateFrom] = useState(urlFrom && /^\d{4}-\d{2}-\d{2}$/.test(urlFrom) ? urlFrom : defaultFrom);
  const [dateTo, setDateTo] = useState(urlTo && /^\d{4}-\d{2}-\d{2}$/.test(urlTo) ? urlTo : defaultTo);
  const [claimType, setClaimType] = useState(urlType ?? "all");

  const persistQuery = useCallback(
    (next: { from: string; to: string; type: string }) => {
      const p = new URLSearchParams();
      p.set("from", next.from);
      p.set("to", next.to);
      if (next.type && next.type !== "all") p.set("type", next.type);
      router.replace(`/claim-engine/report-history?${p.toString()}`, { scroll: false });
    },
    [router],
  );

  const refetch = useCallback(async () => {
    setPolling(true);
    const res = await listClaimReportHistory({
      organizationId,
      dateFrom: startUtcIsoFromYyyyMmDd(dateFrom),
      dateTo: endUtcIsoFromYyyyMmDd(dateTo),
    });
    setPolling(false);
    if (res.ok) {
      setRows(res.data);
      setLoadError(null);
    } else {
      setLoadError(res.error ?? "Refresh failed.");
    }
  }, [organizationId, dateFrom, dateTo]);

  useEffect(() => {
    void refetch();
    // Initial load + URL defaults — interval below keeps rows in sync when report_url is filled in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refetch();
    }, 12_000);
    return () => window.clearInterval(id);
  }, [refetch]);

  const claimTypeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.claim_type?.trim()) set.add(r.claim_type.trim());
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const filteredRows = useMemo(() => {
    if (!claimType || claimType === "all") return rows;
    return rows.filter((r) => (r.claim_type ?? "").trim() === claimType);
  }, [rows, claimType]);

  async function handleDownload(row: ClaimReportHistoryRow) {
    const path = row.report_url?.trim();
    if (!path) return;
    setBusyId(row.id);
    try {
      if (isHttpUrl(path)) {
        window.open(path, "_blank", "noopener,noreferrer");
        return;
      }
      const r = await refreshClaimReportSignedUrl(path);
      const url = r.ok ? r.url : null;
      if (!url) {
        window.alert(r.error ?? "Could not create a download link.");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setBusyId(null);
    }
  }

  function applyDateFilters() {
    persistQuery({ from: dateFrom, to: dateTo, type: claimType });
    void refetch();
  }

  return (
    <main className={CLAIM_ENGINE_MAIN_CLASS}>
      <ClaimEnginePageShell
        title="Reports"
        description="PDF export history on claim_submissions. Refreshes every 12s while this page is open."
        aside={[{ href: "/claim-engine", label: "Submission queue" }]}
      >
        {loadError ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200">
            {loadError}
          </div>
        ) : null}

        <section className={CLAIM_ENGINE_SECTION_CLASS}>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-[11px] font-medium text-slate-600 dark:text-slate-400">
                From
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-medium text-slate-600 dark:text-slate-400">
                To
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
              </label>
              <label className="flex min-w-[10rem] flex-col gap-1 text-[11px] font-medium text-slate-600 dark:text-slate-400">
                Claim type
                <select
                  value={claimType}
                  onChange={(e) => {
                    const v = e.target.value;
                    setClaimType(v);
                    persistQuery({ from: dateFrom, to: dateTo, type: v });
                  }}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                >
                  <option value="all">All types</option>
                  {claimTypeOptions.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => applyDateFilters()} className={CLAIM_ENGINE_BTN_PRIMARY}>
                Apply range
              </button>
              {polling ? (
                <span className="flex items-center gap-1 text-[11px] text-slate-500">
                  <Loader2 className="h-3 w-3 animate-spin" /> Syncing…
                </span>
              ) : null}
            </div>
        </section>

        <section className={CLAIM_ENGINE_CARD_CLASS}>
          <div className="overflow-x-auto md:hidden">
            <div className="space-y-3 p-4">
              {filteredRows.length === 0 ? (
                rows.length === 0 ? (
                  <ClaimEngineEmptyState
                    title="No PDF reports yet"
                    description="Reports appear after promoting a case to the submission queue with PDF generation enabled, or from the submission queue build action."
                    action={{ href: "/claim-engine/cases", label: "Promote from cases" }}
                    secondaryAction={{ href: "/claim-engine", label: "Submission queue" }}
                  />
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No reports for this claim type in the selected range.
                  </p>
                )
              ) : (
                filteredRows.map((row) => (
                  <div
                    key={row.id}
                    className="rounded-xl border border-slate-100 p-3 dark:border-slate-800"
                  >
                    <p className="font-medium text-slate-900 dark:text-slate-100">{row.report_name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {row.claim_type ?? "—"} · {formatDateTime(row.created_at)}
                    </p>
                    <span
                      className={`mt-2 inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[row.status_label]}`}
                    >
                      {row.status_label}
                    </span>
                    <button
                      type="button"
                      disabled={!row.report_url?.trim() || busyId === row.id}
                      onClick={() => void handleDownload(row)}
                      className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-slate-700 dark:text-slate-200"
                    >
                      {busyId === row.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
                      Download
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className={`${CLAIM_ENGINE_TABLE_CLASS} min-w-[720px]`}>
              <thead className={CLAIM_ENGINE_TABLE_HEAD_CLASS}>
                <tr>
                    <th className="px-4 py-3 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                      Report name
                    </th>
                    <th className="px-4 py-3 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                      Type
                    </th>
                    <th className="px-4 py-3 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                      Generated by
                    </th>
                    <th className="px-4 py-3 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                      Date
                    </th>
                    <th className="px-4 py-3 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                      Status
                    </th>
                    <th className="px-4 py-3 text-right text-[11px] font-medium uppercase tracking-wide text-slate-500">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-0">
                        {rows.length === 0 ? (
                          <ClaimEngineEmptyState
                            title="No PDF reports yet"
                            description="Promote cases to generate PDFs on submissions, or build from the submission queue."
                            action={{ href: "/claim-engine/cases", label: "Cases" }}
                            secondaryAction={{ href: "/claim-engine", label: "Submission queue" }}
                          />
                        ) : (
                          <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                            No reports for this claim type in the selected range.
                          </p>
                        )}
                      </td>
                    </tr>
                  ) : (
                    filteredRows.map((row) => {
                      const canDownload = Boolean(row.report_url?.trim());
                      return (
                        <tr key={row.id} className={CLAIM_ENGINE_TABLE_ROW_CLASS}>
                          <td className="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">
                            {row.report_name}
                          </td>
                          <td className="px-4 py-3 text-slate-700 dark:text-slate-300">{row.claim_type ?? "—"}</td>
                          <td className="px-4 py-3 text-slate-700 dark:text-slate-300">
                            {row.generated_by ?? "—"}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-slate-600 dark:text-slate-400">
                            {formatDateTime(row.created_at)}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[row.status_label]}`}
                            >
                              {row.status_label}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              type="button"
                              disabled={!canDownload || busyId === row.id}
                              onClick={() => void handleDownload(row)}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                              title={canDownload ? "Download / open PDF" : "PDF not ready yet"}
                            >
                              {busyId === row.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <FileDown className="h-3.5 w-3.5" />
                              )}
                              Download
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
          </div>
        </section>
      </ClaimEnginePageShell>
    </main>
  );
}
