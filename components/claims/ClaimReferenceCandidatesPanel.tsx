"use client";

import { Check, Copy, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type {
  CanonicalReferenceCandidate,
  ReferenceCandidatesResponse,
} from "@/lib/canonical-reference-candidate-types";

type Props = {
  organizationId: string;
  /** Required for draft API route when claimCandidateId is unset. */
  draftId?: string;
  /** Inbox candidate route when set; otherwise draft route. */
  claimCandidateId?: string | null;
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "deterministic_single":
      return "Single match";
    case "ambiguous_multiple":
      return "Ambiguous";
    case "missing_frr":
      return "Missing FRR";
    case "no_order_id":
      return "No order ID";
    case "missing_operational_row":
      return "Missing operational row";
    default:
      return outcome;
  }
}

function outcomeClass(outcome: string): string {
  switch (outcome) {
    case "deterministic_single":
      return "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-100";
    case "ambiguous_multiple":
      return "border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-100";
    case "missing_frr":
    case "missing_operational_row":
    case "no_order_id":
      return "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/60";
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function formatAmount(amount: number | null, currency: string | null): string {
  if (amount == null) return "—";
  const cur = currency ? ` ${currency}` : "";
  return `${amount}${cur}`;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }, [value]);

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="inline-flex items-center gap-1 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
      title="Copy reference value"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CandidateRow({ c }: { c: CanonicalReferenceCandidate }) {
  return (
    <li
      className={`rounded-lg border px-2.5 py-2 ${
        c.operator_selected
          ? "border-sky-400 bg-sky-50/80 dark:border-sky-700 dark:bg-sky-950/30"
          : "border-slate-200 dark:border-slate-700"
      }`}
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] font-medium text-sky-800 break-all dark:text-sky-200">
              {c.reference_value}
            </span>
            <CopyButton value={c.reference_value} />
            {c.operator_selected ? (
              <span className="rounded bg-sky-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
                Operator selected
              </span>
            ) : null}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px] text-slate-600 dark:text-slate-400">
            <dt className="font-medium">Type</dt>
            <dd>{c.reference_type}</dd>
            <dt className="font-medium">Source</dt>
            <dd className="font-mono break-all">
              {c.source_table} · {c.source_row_id.slice(0, 8)}…
            </dd>
            <dt className="font-medium">Report</dt>
            <dd>{c.report_kind ?? c.lineage.report_kind ?? "—"}</dd>
            <dt className="font-medium">Date</dt>
            <dd>{formatDate(c.event_date)}</dd>
            <dt className="font-medium">Amount</dt>
            <dd>{formatAmount(c.amount, c.currency)}</dd>
            <dt className="font-medium">Confidence</dt>
            <dd>{pct(c.confidence)}</dd>
            <dt className="font-medium">Join</dt>
            <dd>{c.claim_case_join_reason}</dd>
            {c.sku ? (
              <>
                <dt className="font-medium">SKU</dt>
                <dd className="font-mono">{c.sku}</dd>
              </>
            ) : null}
            {c.order_id ? (
              <>
                <dt className="font-medium">Order</dt>
                <dd className="font-mono">{c.order_id}</dd>
              </>
            ) : null}
          </dl>
        </div>
      </div>
      <details className="mt-2 text-[10px] text-slate-500">
        <summary className="cursor-pointer font-medium">Lineage</summary>
        <ul className="mt-1 space-y-0.5 font-mono">
          {c.lineage.source_upload_id ? <li>upload: {c.lineage.source_upload_id}</li> : null}
          {c.lineage.source_run_id ? <li>finances run: {c.lineage.source_run_id}</li> : null}
          {c.lineage.source_citations.map((cit, i) => (
            <li key={i}>
              {cit.kind} → {cit.table}
              {cit.row_id ? ` (${cit.row_id.slice(0, 8)}…)` : ""}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

export function ClaimReferenceCandidatesPanel({
  organizationId,
  draftId,
  claimCandidateId,
}: Props) {
  const [data, setData] = useState<ReferenceCandidatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!claimCandidateId && !draftId) {
      setError("draftId or claimCandidateId required.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const base = claimCandidateId
        ? `/api/claims/inbox/${encodeURIComponent(claimCandidateId)}/reference-candidates`
        : `/api/claims/drafts/${encodeURIComponent(draftId!)}/reference-candidates`;
      const res = await fetch(
        `${base}?organization_id=${encodeURIComponent(organizationId)}`,
        { credentials: "include" },
      );
      const j = (await res.json()) as ReferenceCandidatesResponse & { error?: string };
      if (!res.ok) {
        setData(null);
        setError(typeof j.error === "string" ? j.error : `HTTP ${res.status}`);
        return;
      }
      setData(j);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Failed to load reference candidates");
    } finally {
      setLoading(false);
    }
  }, [organizationId, draftId, claimCandidateId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <section className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-4 text-sm text-slate-600 dark:border-slate-700">
        <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
        Loading reference candidates…
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        {error}
      </section>
    );
  }

  if (!data) return null;

  return (
    <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/40">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          TRID / reference candidates
        </h3>
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${outcomeClass(data.outcome)}`}
        >
          {outcomeLabel(data.outcome)}
        </span>
        <span className="text-[10px] text-slate-500">
          {data.candidate_count_returned}
          {data.truncated ? ` / ${data.candidate_count}` : ""} candidates · read-only
        </span>
      </header>

      {data.warnings.length > 0 ? (
        <ul className="space-y-1">
          {data.warnings.map((w) => (
            <li
              key={w.code}
              className={`rounded border px-2 py-1 text-[10px] ${
                w.severity === "error"
                  ? "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/50"
                  : w.severity === "warn"
                    ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40"
                    : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/60"
              }`}
            >
              {w.message}
            </li>
          ))}
        </ul>
      ) : null}

      {data.operational ? (
        <p className="text-[10px] text-slate-500">
          Operational: {data.operational.source_table} · order{" "}
          <span className="font-mono">{data.operational.order_id ?? "—"}</span>
          {data.operational.sku ? ` · SKU ${data.operational.sku}` : ""}
        </p>
      ) : null}

      {data.candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">No reference candidates resolved.</p>
      ) : (
        <ul className="space-y-2">
          {data.candidates.map((c) => (
            <CandidateRow key={c.candidate_key} c={c} />
          ))}
        </ul>
      )}
    </section>
  );
}
