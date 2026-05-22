"use client";

import { Download, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { FilingPacketValidationResult } from "@/lib/claim-filing-packet-validation";

type Props = {
  organizationId: string;
  draftId: string;
};

function statusClass(status: string): string {
  switch (status) {
    case "pass":
      return "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100";
    case "warn":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100";
    default:
      return "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-100";
  }
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ClaimFilingPacketValidationPanel({ organizationId, draftId }: Props) {
  const [validation, setValidation] = useState<FilingPacketValidationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/claims/drafts/${encodeURIComponent(draftId)}/filing-packet-validation?organization_id=${encodeURIComponent(organizationId)}`,
        { credentials: "include" },
      );
      const j = (await res.json()) as { validation?: FilingPacketValidationResult; error?: string };
      if (!res.ok) {
        setValidation(null);
        setError(typeof j.error === "string" ? j.error : `HTTP ${res.status}`);
        return;
      }
      setValidation(j.validation ?? null);
    } catch (e) {
      setValidation(null);
      setError(e instanceof Error ? e.message : "Validation failed");
    } finally {
      setLoading(false);
    }
  }, [draftId, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <section className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs dark:border-slate-700">
        <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
        Validating filing packet…
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-100">
        Packet validation: {error}
      </section>
    );
  }

  if (!validation) return null;

  const blockers = validation.blocker_inventory.filter((b) => b.severity === "blocker");
  const warns = validation.blocker_inventory.filter((b) => b.severity === "warn");

  return (
    <section className="space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/40 px-3 py-3 dark:border-indigo-900 dark:bg-indigo-950/30">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-indigo-950 dark:text-indigo-100">
          Filing packet validation
        </h3>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${validation.overall_valid ? "bg-emerald-600 text-white" : "bg-rose-600 text-white"}`}
        >
          {validation.overall_valid ? "Integrity OK" : "Integrity blocked"}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${validation.ready_for_future_submission_layer ? "bg-sky-600 text-white" : "bg-slate-500 text-white"}`}
        >
          Future layer: {validation.ready_for_future_submission_layer ? "Ready" : "Not ready"}
        </span>
      </div>
      <p className="text-[10px] text-slate-600 dark:text-slate-400">
        Pre-submission integrity checks only — does not file claims or call Amazon.
      </p>

      <div>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-indigo-800 dark:text-indigo-200">
          Filing-readiness matrix
        </h4>
        <div className="overflow-x-auto rounded border border-indigo-200/80 dark:border-indigo-900/60">
          <table className="w-full text-left text-[10px]">
            <thead className="bg-indigo-100/80 dark:bg-indigo-950/50">
              <tr>
                <th className="px-2 py-1 font-medium">Category</th>
                <th className="px-2 py-1 font-medium">Check</th>
                <th className="px-2 py-1 font-medium">Status</th>
                <th className="px-2 py-1 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {validation.matrix.map((row) => (
                <tr key={row.id} className="border-t border-indigo-100 dark:border-indigo-900/40">
                  <td className="px-2 py-1 capitalize text-slate-500">{row.category.replace(/_/g, " ")}</td>
                  <td className="px-2 py-1 font-medium">{row.label}</td>
                  <td className="px-2 py-1">
                    <span className={`rounded px-1.5 py-0.5 font-semibold uppercase ${statusClass(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-slate-700 dark:text-slate-300">{row.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-indigo-800 dark:text-indigo-200">
          Blocker inventory
        </h4>
        {blockers.length === 0 && warns.length === 0 ? (
          <p className="text-[10px] text-emerald-700 dark:text-emerald-300">No blockers or warnings.</p>
        ) : (
          <ul className="space-y-1 text-[10px]">
            {blockers.map((b) => (
              <li
                key={b.code}
                className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100"
              >
                <span className="font-semibold">{b.code}</span> — {b.message}
              </li>
            ))}
            {warns.map((b) => (
              <li
                key={b.code}
                className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
              >
                <span className="font-semibold">{b.code}</span> — {b.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() =>
            downloadJson(`claim-filing-packet-validation-${draftId.slice(0, 8)}.json`, validation)
          }
          className="inline-flex items-center gap-1 rounded border border-indigo-400 bg-white px-2 py-1 text-[10px] font-medium text-indigo-900 hover:bg-indigo-50 dark:border-indigo-700 dark:bg-slate-900 dark:text-indigo-100"
        >
          <Download className="h-3 w-3" />
          Download validation report
        </button>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-slate-300 px-2 py-1 text-[10px] text-slate-700 dark:border-slate-600 dark:text-slate-300"
        >
          Re-validate
        </button>
      </div>
    </section>
  );
}
