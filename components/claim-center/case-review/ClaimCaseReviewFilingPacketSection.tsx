"use client";

import { useCallback, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Eye, FileText, Loader2, ShieldAlert } from "lucide-react";

import type { ClaimCaseReviewRow } from "@/lib/claims/pilot/claim-case-review-readmodel";
import type {
  ClaimFilingPacketPreviewPayload,
  ClaimFilingPacketPreviewV1,
} from "@/lib/claims/filing/claim-filing-packet-preview-v1";
import {
  FILING_PACKET_API_PATH,
  FILING_PACKET_PREVIEW_BUTTON_LABEL,
  FILING_PACKET_READINESS_BADGE_LABELS,
  FILING_PACKET_SECTION_ID,
  deriveFilingPacketReadinessBadges,
  filingPacketApiParams,
  filingPacketPreviewDisabled,
  isRemediatedDuplicateCase,
  productIdentityLabel,
  remediationStatusLabel,
  type FilingPacketReadinessBadge,
} from "@/lib/claims/filing/claim-filing-packet-ui-contract";
import { formatCaseReviewMoney } from "@/lib/claims/pilot/claim-case-review-ui-contract";

type Props = {
  row: ClaimCaseReviewRow;
  pilotCaseRunId: string;
  intakeRunId: string;
  fetchJson: <T>(path: string, extra?: Record<string, string>) => Promise<T>;
};

function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-55">{label}</dt>
      <dd className={`mt-0.5 text-sm font-medium ${mono ? "font-mono text-xs break-all" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function badgeStyles(badge: FilingPacketReadinessBadge): string {
  switch (badge) {
    case "ready_for_pdf_preview":
    case "ready_for_manual_filing":
      return "bg-emerald-500/15 text-emerald-900 dark:text-emerald-100 border-emerald-500/30";
    case "needs_review":
      return "bg-amber-500/15 text-amber-900 dark:text-amber-100 border-amber-500/30";
    case "blocked":
      return "bg-red-500/15 text-red-900 dark:text-red-100 border-red-500/30";
  }
}

function BadgeIcon({ badge }: { badge: FilingPacketReadinessBadge }) {
  if (badge === "ready_for_pdf_preview" || badge === "ready_for_manual_filing") {
    return <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />;
  }
  if (badge === "needs_review") return <AlertTriangle className="h-3.5 w-3.5" aria-hidden />;
  return <ShieldAlert className="h-3.5 w-3.5" aria-hidden />;
}

function FilingPacketContent({
  preview,
  rowRemediated,
}: {
  preview: ClaimFilingPacketPreviewV1;
  rowRemediated: boolean;
}) {
  const badges = deriveFilingPacketReadinessBadges(preview, rowRemediated);
  const money = preview.money_lanes;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {badges.map((badge) => (
          <span
            key={badge}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${badgeStyles(badge)}`}
          >
            <BadgeIcon badge={badge} />
            {FILING_PACKET_READINESS_BADGE_LABELS[badge]}
          </span>
        ))}
      </div>

      <dl className="grid gap-3 sm:grid-cols-2">
        <Field label="Case ID" value={preview.claim_case_id} mono />
        <Field label="Idempotency key" value={preview.case_idempotency_key ?? "—"} mono />
        <Field label="Pilot case run" value={preview.pilot_case_run_id ?? "—"} mono />
        <Field label="Intake run" value={preview.intake_run_id ?? "—"} mono />
        <Field label="Claim family" value={preview.claim_family ?? "—"} />
        <Field label="Claim source" value={preview.claim_source ?? "—"} />
        <Field label="Claim subtype" value={preview.claim_subtype ?? "—"} />
        <Field label="Family V3" value={preview.family_key_v3 ?? "—"} />
        <Field label="Case status" value={preview.case_status ?? "—"} />
        <Field
          label="Source event key"
          value={preview.source_event_key ?? "—"}
          mono
        />
        <Field label="Source event date" value={preview.source_event_date ?? "—"} />
        <Field label="Clean quantity" value={preview.clean_quantity ?? "—"} />
      </dl>

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">
          Candidate IDs ({preview.line_summary.candidate_ids.length})
        </h4>
        {preview.line_summary.candidate_ids.length === 0 ? (
          <p className="text-xs opacity-60">No candidates.</p>
        ) : (
          <ul className="space-y-1">
            {preview.line_summary.candidate_ids.map((id) => (
              <li key={id} className="font-mono text-xs break-all">
                {id}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">
          Claim lines ({preview.line_summary.claim_line_ids.length})
        </h4>
        {preview.line_summary.claim_line_ids.length === 0 ? (
          <p className="text-xs opacity-60">No claim lines.</p>
        ) : (
          <ul className="space-y-2">
            {preview.line_summary.claim_line_ids.map((id) => (
              <li key={id} className="rounded-lg border px-3 py-2 text-xs">
                <p className="font-mono break-all">{id}</p>
                <p className="mt-1 opacity-70">
                  Status {preview.line_summary.line_status ?? "—"} · Qty{" "}
                  {preview.line_summary.quantity_expected ?? "—"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">Product identity</h4>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Field label="Identifiers" value={productIdentityLabel(preview.product_identity)} />
          <Field
            label="Resolved product"
            value={preview.product_identity.resolved_product_id ?? "—"}
            mono
          />
        </dl>
      </div>

      <div>
        <dt className="text-[10px] font-semibold uppercase tracking-wide opacity-55">Evidence summary</dt>
        <dd className="mt-1 rounded-lg bg-black/5 p-3 text-xs dark:bg-white/5">
          {preview.evidence_summary ?? preview.internal_filing_summary ?? "—"}
        </dd>
      </div>

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">
          Source edges ({preview.source_edges.length})
        </h4>
        {preview.source_edges.length === 0 ? (
          <p className="text-xs opacity-60">No source edges in snapshot.</p>
        ) : (
          <pre className="max-h-32 overflow-auto rounded-lg bg-black/5 p-3 text-[10px] dark:bg-white/5">
            {JSON.stringify(preview.source_edges, null, 2)}
          </pre>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">
          Reference edges ({preview.reference_edges.length})
        </h4>
        {preview.reference_edges.length === 0 ? (
          <p className="text-xs opacity-60">No reference edges.</p>
        ) : (
          <ul className="space-y-2">
            {preview.reference_edges.map((e) => (
              <li key={e.id} className="rounded-lg bg-black/5 px-3 py-2 text-xs dark:bg-white/5">
                <span className="font-semibold">{e.edge_type ?? "edge"}</span>
                <span className="mx-1 opacity-40">·</span>
                <span className="opacity-70">
                  {e.reference_kind}:{e.reference_value}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">Operator attestation</h4>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Attested"
            value={preview.operator_attestation.attested ? "Yes" : "No"}
          />
          <Field label="Attested by" value={preview.operator_attestation.attested_by ?? "—"} />
          <Field label="Attested at" value={preview.operator_attestation.attested_at ?? "—"} />
        </dl>
      </div>

      <div>
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">Money lanes</h4>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Estimated Amazon payout"
            value={formatCaseReviewMoney(money.estimated_amazon_payout, String(money.currency ?? "USD"))}
          />
          <Field
            label="Observed reimbursement"
            value={formatCaseReviewMoney(money.observed_reimbursement, String(money.currency ?? "USD"))}
          />
          <Field
            label="Internal cost loss"
            value={formatCaseReviewMoney(money.internal_cost_loss, String(money.currency ?? "USD"))}
          />
          <Field
            label="Recovery value"
            value={formatCaseReviewMoney(money.recovery_value, String(money.currency ?? "USD"))}
          />
          <Field
            label="Sale price (display only)"
            value={formatCaseReviewMoney(money.sale_price_display_only, String(money.currency ?? "USD"))}
          />
        </dl>
      </div>

      {preview.warnings.length > 0 ? (
        <div>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">Warnings</h4>
          <div className="flex flex-wrap gap-2">
            {preview.warnings.map((w) => (
              <span
                key={w}
                className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-200"
              >
                {w}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {preview.blockers.length > 0 ? (
        <div>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide opacity-55">Blockers</h4>
          <div className="flex flex-wrap gap-2">
            {preview.blockers.map((b) => (
              <span
                key={b}
                className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-800 dark:text-red-200"
              >
                {b}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <p className="text-[10px] opacity-55">
        PDF export deferred · does not submit · read-only preview
      </p>
    </div>
  );
}

export function ClaimCaseReviewFilingPacketSection({
  row,
  pilotCaseRunId,
  intakeRunId,
  fetchJson,
}: Props) {
  const [preview, setPreview] = useState<ClaimFilingPacketPreviewV1 | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const remediated = isRemediatedDuplicateCase(row);
  const previewDisabled = filingPacketPreviewDisabled(row);

  const loadPreview = useCallback(async () => {
    if (previewDisabled) return;
    setLoading(true);
    setError(null);
    try {
      const params = filingPacketApiParams({
        caseId: row.id,
        pilotCaseRunId,
        intakeRunId,
        status: row.status ?? "open",
      });
      const data = await fetchJson<ClaimFilingPacketPreviewPayload>(FILING_PACKET_API_PATH, params);
      const item = data.previews[0] ?? null;
      if (!item) {
        setPreview(null);
        setError("No filing packet preview composed for this case.");
      } else {
        setPreview(item);
      }
      setLoaded(true);
    } catch (e) {
      setPreview(null);
      setLoaded(true);
      setError(e instanceof Error ? e.message : "Failed to load filing packet preview.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson, intakeRunId, pilotCaseRunId, previewDisabled, row.id, row.status]);

  return (
    <section id={FILING_PACKET_SECTION_ID} className="rounded-xl border border-dashed p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 opacity-60" aria-hidden />
          <h3 className="text-xs font-semibold uppercase opacity-60">Filing packet</h3>
        </div>
        <button
          type="button"
          onClick={() => void loadPreview()}
          disabled={previewDisabled || loading}
          aria-disabled={previewDisabled || loading}
          title={
            previewDisabled
              ? "Filing packet preview disabled for remediated or closed cases"
              : "Load read-only filing packet preview"
          }
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-semibold hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-45 dark:hover:bg-white/5"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Eye className="h-3.5 w-3.5" aria-hidden />
          )}
          {FILING_PACKET_PREVIEW_BUTTON_LABEL}
        </button>
      </div>

      {remediated ? (
        <div className="mb-3 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
          <p className="font-semibold">Remediation status</p>
          <p className="mt-1">{remediationStatusLabel(row)}</p>
          <p className="mt-1 opacity-80">Filing packet preview is disabled for remediated duplicate cases.</p>
        </div>
      ) : (
        <p className="mb-3 text-xs opacity-70">
          Tap {FILING_PACKET_PREVIEW_BUTTON_LABEL} to inspect filing-ready fields before any PDF export or
          submission.
        </p>
      )}

      {loading ? (
        <p className="flex items-center gap-2 text-xs opacity-70">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading filing packet…
        </p>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
          <p className="font-semibold text-red-800 dark:text-red-200">Could not load filing packet</p>
          <p className="mt-1 opacity-90">{error}</p>
        </div>
      ) : null}

      {preview && !error ? (
        <FilingPacketContent preview={preview} rowRemediated={remediated} />
      ) : loaded && !loading && !error && !previewDisabled ? (
        <p className="text-xs opacity-60">No filing packet preview loaded yet.</p>
      ) : null}
    </section>
  );
}
