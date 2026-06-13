"use client";

import { AlertTriangle, Check } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  ShipmentCloseReviewBucketKey,
  ShipmentCloseReviewLineSummary,
  ShipmentCloseReviewModel,
} from "@/lib/scanner/shipment-close-review";
import {
  deriveShipmentExpectedLineStatus,
  formatShipmentExpectedLineStatusLabel,
  summarizeShipmentExpectedContext,
  type ShipmentExpectedContext,
  type ShipmentExpectedLineStatus,
} from "@/lib/scanner/shipment-expected-context";
import { OperatorScannerFooterActions } from "@/app/scanner/operator-mobile/_components/OperatorScannerFooterActions";

type ShipmentCloseReviewModalProps = {
  formId: string;
  model: ShipmentCloseReviewModel;
  expectedContext?: ShipmentExpectedContext | null;
  busy: boolean;
  finalizeBusy: boolean;
  onCancel: () => void;
  onConfirm: (args: { criticalIssuesAcknowledged: boolean; auditNote: string | null }) => void;
};

type BucketDisplay = {
  title: string;
  subtext?: string;
};

type SummaryCard = {
  key: string;
  label: string;
  value: string;
  issueTone?: boolean;
  mono?: boolean;
};

const BUCKET_DISPLAY: Partial<Record<ShipmentCloseReviewBucketKey, BucketDisplay>> = {
  missing: {
    title: "Missing items found",
    subtext: "These units were expected but not received.",
  },
  partial: {
    title: "Partially received",
    subtext: "Some expected units were not fully received.",
  },
  over: {
    title: "Over-received items",
    subtext: "More units were scanned than expected.",
  },
  unexpected: {
    title: "Unexpected scans",
    subtext: "Items scanned that were not on the shipment manifest.",
  },
  slip_only: {
    title: "Slip-only evidence",
    subtext: "Items found on packing slip but not on shipment manifest.",
  },
  shipment_only: {
    title: "Shipment-only expected",
    subtext: "Expected on shipment but not found on packing slip.",
  },
  damaged_or_problem_items: {
    title: "Damaged or problem items",
    subtext: "Items marked with damage or other problems.",
  },
};

const CRITICAL_ISSUE_DISPLAY: Record<string, string> = {
  "Partial lines": "Partial receive",
  "Missing / final shortage": "Missing / final shortage",
  "Over lines": "Over-received",
  "Unexpected scans": "Unexpected scans",
  "Slip-only evidence": "Slip-only evidence",
  "Shipment-only expected": "Shipment-only expected",
  "Damaged / problem items": "Damaged / problem items",
};

const ISSUE_TABLE_SCROLL_ROW_THRESHOLD = 5;

function bucketDisplayTitle(key: ShipmentCloseReviewBucketKey, fallback: string): BucketDisplay {
  return BUCKET_DISPLAY[key] ?? { title: fallback };
}

function issueSummaryLabel(model: ShipmentCloseReviewModel): string {
  if (!model.has_critical_issues) return "None";
  if (model.bucket_counts.missing > 0) return "Missing";
  if (model.bucket_counts.partial > 0) return "Partial";
  if (model.bucket_counts.over > 0) return "Over";
  if (model.bucket_counts.unexpected > 0) return "Unexpected";
  if (model.bucket_counts.damaged_or_problem_items > 0) return "Problem items";
  return "Review";
}

function formatUnresolvedIssueBody(labels: string[]): string {
  if (labels.length === 0) return "Review required before closing.";
  return labels.map((label) => CRITICAL_ISSUE_DISPLAY[label] ?? label).join(" · ");
}

function oneContainerHint(model: ShipmentCloseReviewModel): string | null {
  if (model.package_count <= 1 && model.pallet_count <= 1) {
    return "This shipment contains one box on one pallet.";
  }
  if (model.package_count <= 1) return "This shipment contains one box.";
  if (model.pallet_count <= 1) return "This shipment contains one pallet.";
  return null;
}

function IssueItemsTable(props: {
  lines: ShipmentCloseReviewLineSummary[];
  bucketKey: string;
  maxRows?: number;
}) {
  const { lines, bucketKey, maxRows = 6 } = props;
  const visible = lines.slice(0, maxRows);
  const overflow = lines.length - visible.length;

  return (
    <div className="operator-shipment-close-review__table-wrap">
      <table className="operator-shipment-close-review__table w-full border-collapse">
        <thead>
          <tr>
            <th className="operator-shipment-close-review__table-head text-left">Identifier</th>
            <th className="operator-shipment-close-review__table-head operator-shipment-close-review__table-head--qty">
              Qty
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((line) => (
            <tr key={`${bucketKey}:${line.lineKey}`} className="operator-shipment-close-review__table-row">
              <td className="operator-shipment-close-review__table-cell">
                <span className="operator-shipment-close-review__identifier font-mono">{line.label}</span>
              </td>
              <td className="operator-shipment-close-review__table-cell operator-shipment-close-review__table-cell--qty">
                <span className="operator-shipment-close-review__qty-badge tabular-nums">{line.qty}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {overflow > 0 ? (
        <p className="operator-shipment-close-review__more mt-2 px-2 text-[11px] font-semibold">
          +{overflow} more item{overflow === 1 ? "" : "s"}
        </p>
      ) : null}
    </div>
  );
}

const EXPECTED_STATUS_TONE: Record<ShipmentExpectedLineStatus, string> = {
  pending: "text-slate-300",
  partial: "text-amber-200",
  received: "text-emerald-200",
  over: "text-orange-200",
  missing: "text-rose-200",
};

export function ShipmentCloseReviewModal(props: ShipmentCloseReviewModalProps) {
  const { formId, model, expectedContext, busy, finalizeBusy, onCancel, onConfirm } = props;

  const [reviewChecked, setReviewChecked] = useState(false);
  const [auditNote, setAuditNote] = useState("");

  const confirmDisabled = !reviewChecked;
  const showAckHint = confirmDisabled && !busy && !finalizeBusy;
  const containerHint = oneContainerHint(model);
  const missingUnits = model.totals.final_shortage_qty || model.totals.missing_qty;

  const ackLabel = model.has_critical_issues
    ? "I reviewed the shipment and understand the unresolved issues."
    : "I reviewed this shipment and want to close it.";

  const closeButtonLabel = model.has_critical_issues ? "Close Shipment with Issues" : "Close Shipment";

  const primaryBtnClass = model.has_critical_issues
    ? "operator-shipment-flow-modal__btn-warning"
    : "operator-shipment-flow-modal__btn-primary";

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      {
        key: "tracking",
        label: "Tracking",
        value: model.tracking_number ?? "—",
        mono: true,
      },
      {
        key: "boxes",
        label: "Boxes",
        value: String(model.package_count),
      },
      {
        key: "missing-units",
        label: "Missing units",
        value: String(missingUnits),
      },
      {
        key: "issues",
        label: "Issues",
        value: issueSummaryLabel(model),
        issueTone: model.has_critical_issues,
      },
    ],
    [model, missingUnits],
  );

  const unresolvedIssueBody = useMemo(
    () => formatUnresolvedIssueBody(model.critical_issue_labels),
    [model.critical_issue_labels],
  );

  const totalIssueRows = useMemo(
    () => model.buckets.reduce((sum, bucket) => sum + bucket.lines.length, 0),
    [model.buckets],
  );

  const issuesListScrollable = totalIssueRows > ISSUE_TABLE_SCROLL_ROW_THRESHOLD;

  const expectedSummary = useMemo(
    () => (expectedContext ? summarizeShipmentExpectedContext(expectedContext) : null),
    [expectedContext],
  );

  return (
    <div
      className={`operator-shipment-flow-modal fixed inset-0 z-[144] flex items-center justify-center p-4${
        model.has_critical_issues ? " operator-shipment-flow-modal--warning" : ""
      }`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${formId}-shipment-review-title`}
    >
      <div className="operator-shipment-flow-modal__panel operator-shipment-close-review__shell flex max-h-[calc(100dvh-32px)] w-full max-w-md flex-col overflow-hidden rounded-[24px] border p-4">
        <header className="operator-shipment-close-review__header shrink-0 text-center">
          <p
            id={`${formId}-shipment-review-title`}
            className="operator-shipment-flow-modal__title text-[17px] font-black leading-snug"
          >
            Shipment Review
          </p>
          <p className="operator-shipment-flow-modal__body mt-1 text-[13px] font-semibold leading-snug">
            Review the shipment before closing warehouse receive.
          </p>
          <p className="operator-shipment-close-review__disclaimer mt-1 text-[11px] font-medium leading-snug">
            Closing this shipment does not create claims. Issues are saved as review evidence.
          </p>
          {containerHint ? (
            <p className="operator-shipment-flow-modal__note mt-1 text-[11px] font-semibold leading-snug">
              {containerHint}
            </p>
          ) : null}
        </header>

        <div className="operator-shipment-close-review__body min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <section
            className="operator-shipment-close-review__summary mt-3"
            aria-label="Shipment summary"
          >
            {summaryCards.map((card) => (
              <article key={card.key} className="operator-shipment-close-review__chip">
                <p className="operator-shipment-close-review__chip-label">{card.label}</p>
                <p
                  className={[
                    "operator-shipment-close-review__chip-value",
                    card.mono ? "font-mono" : "",
                    card.issueTone ? "operator-shipment-close-review__chip-value--issue" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {card.value}
                </p>
              </article>
            ))}
          </section>

          {expectedContext && expectedSummary ? (
            <section
              className="operator-shipment-close-review__expected-compare mt-3 rounded-xl border border-sky-500/20 bg-sky-950/15 px-3 py-2.5"
              aria-label="Expected shipment comparison"
            >
              <p className="operator-shipment-close-review__section-title text-[12px] font-bold leading-snug">
                Expected vs scanned
              </p>
              {(expectedContext.carrier || expectedContext.tracking_number) && (
                <p className="mt-1 text-[11px] font-semibold leading-snug text-slate-200">
                  {expectedContext.carrier ? (
                    <>
                      <span className="text-slate-400">Carrier</span> {expectedContext.carrier}
                      {expectedContext.tracking_number ? " · " : null}
                    </>
                  ) : null}
                  {expectedContext.tracking_number ? (
                    <>
                      <span className="text-slate-400">Tracking</span>{" "}
                      <span className="font-mono">{expectedContext.tracking_number}</span>
                    </>
                  ) : null}
                </p>
              )}
              <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] font-semibold">
                <div className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
                  <p className="text-slate-400">Expected units</p>
                  <p className="tabular-nums text-white">{expectedContext.expected_total_units}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
                  <p className="text-slate-400">Scanned units</p>
                  <p className="tabular-nums text-white">{expectedSummary.scannedUnits}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
                  <p className="text-slate-400">Missing units</p>
                  <p className="tabular-nums text-rose-200">{expectedSummary.missingUnits}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
                  <p className="text-slate-400">Over units</p>
                  <p className="tabular-nums text-orange-200">{expectedSummary.overUnits}</p>
                </div>
              </div>
              {model.totals.unexpected_qty > 0 ? (
                <p className="mt-2 text-[11px] font-semibold text-violet-200">
                  Unexpected / off-manifest: {model.totals.unexpected_qty} unit
                  {model.totals.unexpected_qty !== 1 ? "s" : ""}
                </p>
              ) : null}
              <ul className="mt-2.5 max-h-40 space-y-1.5 overflow-y-auto overscroll-contain">
                {expectedContext.lines.map((line) => {
                  const status = deriveShipmentExpectedLineStatus(line, true);
                  const ids = [line.fnsku, line.sku, line.asin].filter(Boolean).join(" · ");
                  return (
                    <li
                      key={line.lineKey}
                      className="flex items-start justify-between gap-2 rounded-lg border border-white/8 bg-black/15 px-2 py-1.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-semibold text-white">{line.title}</p>
                        {ids ? (
                          <p className="truncate font-mono text-[10px] text-slate-400">{ids}</p>
                        ) : null}
                        <p className="text-[10px] font-semibold tabular-nums text-slate-300">
                          Exp {line.expectedQty} · Scan {line.scannedQty}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 text-[9px] font-bold uppercase tracking-wide ${EXPECTED_STATUS_TONE[status]}`}
                      >
                        {formatShipmentExpectedLineStatusLabel(status)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          <div
            className={`operator-shipment-close-review__issues mt-3 rounded-xl${
              issuesListScrollable ? " operator-shipment-close-review__issues--scrollable" : ""
            }`}
          >
            {model.buckets.length === 0 ? (
              <p className="operator-shipment-close-review__empty px-3 py-3 text-center text-[12px] font-semibold leading-snug">
                No issues found — ready to close.
              </p>
            ) : (
              <ul
                className={`space-y-3 p-2.5${
                  issuesListScrollable ? " operator-shipment-close-review__issues-list--scrollable" : ""
                }`}
              >
                {model.buckets.map((bucket) => {
                  const display = bucketDisplayTitle(bucket.key, bucket.title);
                  return (
                    <li key={bucket.key}>
                      <div className="operator-shipment-close-review__section-header">
                        <p className="operator-shipment-close-review__section-title">{display.title}</p>
                        {display.subtext ? (
                          <p className="operator-shipment-close-review__section-subtext">{display.subtext}</p>
                        ) : null}
                      </div>
                      {bucket.lines.length > 0 ? (
                        <IssueItemsTable lines={bucket.lines} bucketKey={bucket.key} />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {model.has_critical_issues ? (
            <section
              className="operator-shipment-close-review__unresolved operator-shipment-close-review__unresolved-card mt-3 rounded-xl px-3.5 py-2.5"
              aria-label="Unresolved issues"
            >
              <p className="operator-shipment-close-review__unresolved-title text-[12px] font-bold leading-snug">
                Unresolved issues
              </p>
              <p className="operator-shipment-close-review__unresolved-body mt-0.5 text-[12px] font-semibold leading-snug">
                {unresolvedIssueBody}
              </p>
            </section>
          ) : null}
        </div>

        <footer className="operator-shipment-close-review__footer shrink-0 border-t pt-3">
          <label className="operator-shipment-close-review__ack flex cursor-pointer items-start gap-2.5 text-[12px] font-semibold leading-snug">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0"
              checked={reviewChecked}
              onChange={(e) => setReviewChecked(e.target.checked)}
            />
            <span>{ackLabel}</span>
          </label>

          <div className="operator-shipment-close-review__audit mt-2.5">
            <label
              htmlFor={`${formId}-shipment-audit-note`}
              className="operator-shipment-close-review__audit-label text-[11px] font-semibold"
            >
              Optional note
            </label>
            <textarea
              id={`${formId}-shipment-audit-note`}
              className="operator-shipment-close-review__audit-input mt-1 w-full rounded-lg border px-2.5 py-1.5 text-[12px] font-medium"
              rows={1}
              placeholder="Add a note for the shipment close snapshot..."
              value={auditNote}
              onChange={(e) => setAuditNote(e.target.value)}
            />
          </div>

          {showAckHint ? (
            <p className="operator-shipment-close-review__ack-hint mt-2 text-center text-[11px] font-semibold leading-snug">
              {model.has_critical_issues
                ? "Review and acknowledge issues to continue."
                : "Check the review box to continue."}
            </p>
          ) : null}

          <OperatorScannerFooterActions
            className="operator-shipment-close-review__footer-actions mt-2.5"
            primary={
              <button
                type="button"
                disabled={busy || finalizeBusy || confirmDisabled}
                className={`operator-shipment-close-review__confirm-btn ${primaryBtnClass} flex h-11 w-full items-center justify-center gap-2 rounded-xl border text-[13px] font-bold transition active:scale-[0.98] disabled:cursor-not-allowed`}
                onClick={() =>
                  onConfirm({
                    criticalIssuesAcknowledged: model.has_critical_issues ? reviewChecked : true,
                    auditNote: auditNote.trim() || null,
                  })
                }
              >
                {model.has_critical_issues ? (
                  <>
                    <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={2.35} aria-hidden />
                    {finalizeBusy ? "Closing…" : closeButtonLabel}
                  </>
                ) : (
                  <>
                    <Check className="h-4 w-4 shrink-0" strokeWidth={2.75} aria-hidden />
                    {finalizeBusy ? "Closing…" : closeButtonLabel}
                  </>
                )}
              </button>
            }
            secondary={
              <button
                type="button"
                className="operator-shipment-flow-modal__btn-secondary h-11 w-full rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                onClick={onCancel}
              >
                Cancel
              </button>
            }
          />
        </footer>
      </div>
    </div>
  );
}
