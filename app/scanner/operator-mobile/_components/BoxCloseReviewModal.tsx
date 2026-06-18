"use client";

import { AlertTriangle, Check } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  BoxCloseReviewBucket,
  BoxCloseReviewBucketKey,
  BoxCloseReviewModel,
} from "@/lib/scanner/box-close-review";
import { OperatorScannerFooterActions } from "@/app/scanner/operator-mobile/_components/OperatorScannerFooterActions";
import { CloseReviewIssueItemList } from "@/app/scanner/operator-mobile/_components/CloseReviewIssueItemList";

type BoxCloseReviewModalProps = {
  formId: string;
  model: BoxCloseReviewModel;
  liveScanned: number;
  liveExpected: number;
  aggregateStatusLabel: string;
  busy: boolean;
  finalizeBusy: boolean;
  hasItemDraft: boolean;
  isEmptyBox?: boolean;
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
};

const BUCKET_DISPLAY: Partial<Record<BoxCloseReviewBucketKey, BucketDisplay>> = {
  pending_under_scanned: {
    title: "Pending items",
    subtext: "Expected units not scanned.",
  },
  marked_missing_operator_note: {
    title: "Marked missing by operator",
    subtext: "These were marked missing during review.",
  },
  over_scanned: {
    title: "Over-scanned items",
    subtext: "More units were scanned than expected.",
  },
  scanned_off_manifest: {
    title: "Off-manifest scans",
    subtext: "Items scanned that were not on the box manifest.",
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
  "Pending under-scanned lines": "Pending items",
  "Over scanned lines": "Over-scanned items",
  "Off manifest scans": "Off-manifest scans",
  "Slip-only evidence": "Slip-only evidence",
  "Shipment-only expected": "Shipment-only expected",
  "Unresolved missing quantity": "Quantity mismatch",
};

const ISSUE_LIST_SCROLL_ROW_THRESHOLD = 5;

function bucketDisplayTitle(key: BoxCloseReviewBucketKey, fallback: string): BucketDisplay {
  return BUCKET_DISPLAY[key] ?? { title: fallback };
}

function bucketQtySum(bucket: BoxCloseReviewBucket | undefined): number {
  if (!bucket) return 0;
  return bucket.lines.reduce((sum, line) => sum + line.qty, 0);
}

function formatUnresolvedIssueBody(labels: string[]): string {
  if (labels.length === 0) return "Review required before closing.";
  return labels.map((label) => CRITICAL_ISSUE_DISPLAY[label] ?? label).join(" · ");
}

export function BoxCloseReviewModal(props: BoxCloseReviewModalProps) {
  const {
    formId,
    model,
    liveScanned,
    liveExpected,
    busy,
    finalizeBusy,
    hasItemDraft,
    isEmptyBox = false,
    onCancel,
    onConfirm,
  } = props;

  const [reviewChecked, setReviewChecked] = useState(false);
  const [auditNote, setAuditNote] = useState("");

  const confirmDisabled = !reviewChecked;
  const showAckHint = confirmDisabled && !busy && !finalizeBusy;

  const pendingBucket = model.buckets.find((bucket) => bucket.key === "pending_under_scanned");
  const markedMissingBucket = model.buckets.find(
    (bucket) => bucket.key === "marked_missing_operator_note",
  );
  const pendingQty = bucketQtySum(pendingBucket);
  const markedMissingQty = bucketQtySum(markedMissingBucket);

  const issueBuckets = useMemo(
    () => model.buckets.filter((bucket) => bucket.key !== "received_complete"),
    [model.buckets],
  );

  const ackLabel = model.has_critical_issues
    ? "I reviewed this box and understand the unresolved issues."
    : "I reviewed this box and want to close it.";

  const closeButtonLabel =
    isEmptyBox && !model.has_critical_issues
      ? "Close Empty Box"
      : model.has_critical_issues
        ? "Close Box with Issues"
        : "Close Box";

  const primaryBtnClass = model.has_critical_issues
    ? "operator-shipment-flow-modal__btn-warning"
    : "operator-shipment-flow-modal__btn-primary";

  const summaryCards = useMemo<SummaryCard[]>(
    () => [
      { key: "expected", label: "Expected", value: String(liveExpected) },
      { key: "scanned", label: "Scanned", value: String(liveScanned) },
      {
        key: "pending",
        label: "Pending",
        value: String(pendingQty),
        issueTone: pendingQty > 0,
      },
      {
        key: "marked-missing",
        label: "Marked missing",
        value: String(markedMissingQty),
        issueTone: markedMissingQty > 0,
      },
    ],
    [liveExpected, liveScanned, pendingQty, markedMissingQty],
  );

  const unresolvedIssueBody = useMemo(
    () => formatUnresolvedIssueBody(model.critical_issue_labels),
    [model.critical_issue_labels],
  );

  const totalIssueRows = useMemo(
    () => issueBuckets.reduce((sum, bucket) => sum + bucket.lines.length, 0),
    [issueBuckets],
  );

  const issuesListScrollable = totalIssueRows > ISSUE_LIST_SCROLL_ROW_THRESHOLD;

  return (
    <div
      className={`operator-shipment-flow-modal fixed inset-0 z-[143] flex items-center justify-center p-4${
        model.has_critical_issues ? " operator-shipment-flow-modal--warning" : ""
      }`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${formId}-box-review-title`}
    >
      <div className="operator-shipment-flow-modal__panel operator-shipment-close-review__shell flex max-h-[calc(100dvh-32px)] w-full max-w-md flex-col overflow-hidden rounded-[24px] border p-4">
        <header className="operator-shipment-close-review__header shrink-0 text-center">
          <p
            id={`${formId}-box-review-title`}
            className="operator-shipment-flow-modal__title text-[17px] font-black leading-snug"
          >
            Box Review
          </p>
          <p className="operator-shipment-flow-modal__body mt-1 text-[13px] font-semibold leading-snug">
            Review this box before closing.
          </p>
          <p className="operator-shipment-close-review__disclaimer mt-1 text-[11px] font-medium leading-snug">
            Closing this box does not create claims. Issues are saved as review evidence.
          </p>
        </header>

        <div className="operator-shipment-close-review__body min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {isEmptyBox ? (
            <section
              className="operator-box-close-review__empty-summary mt-3 rounded-xl px-3.5 py-2.5 text-center"
              aria-label="Empty box summary"
            >
              <p className="operator-box-close-review__empty-title text-[13px] font-bold leading-snug">
                Empty box
              </p>
              <p className="operator-box-close-review__empty-body mt-0.5 text-[12px] font-semibold leading-snug">
                This box was marked as containing no items.
              </p>
            </section>
          ) : null}

          <section
            className="operator-shipment-close-review__summary mt-3"
            aria-label="Box summary"
          >
            {summaryCards.map((card) => (
              <article key={card.key} className="operator-shipment-close-review__chip">
                <p className="operator-shipment-close-review__chip-label">{card.label}</p>
                <p
                  className={[
                    "operator-shipment-close-review__chip-value tabular-nums",
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

          <div
            className={`operator-shipment-close-review__issues mt-3 rounded-xl${
              issuesListScrollable ? " operator-shipment-close-review__issues--scrollable" : ""
            }`}
          >
            {issueBuckets.length === 0 ? (
              <p className="operator-shipment-close-review__empty px-3 py-3 text-center text-[12px] font-semibold leading-snug">
                No issues found — ready to close.
              </p>
            ) : (
              <ul
                className={`space-y-3 p-2.5${
                  issuesListScrollable ? " operator-shipment-close-review__issues-list--scrollable" : ""
                }`}
              >
                {issueBuckets.map((bucket) => {
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
                        <CloseReviewIssueItemList
                          lines={bucket.lines}
                          listKey={bucket.key}
                        />
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

          {hasItemDraft ? (
            <p className="operator-shipment-flow-modal__note mt-3 text-center text-[11px] font-semibold leading-snug">
              You still have an item draft open — it will be cleared when you close this box.
            </p>
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
              htmlFor={`${formId}-box-audit-note`}
              className="operator-shipment-close-review__audit-label text-[11px] font-semibold"
            >
              Optional note
            </label>
            <textarea
              id={`${formId}-box-audit-note`}
              className="operator-shipment-close-review__audit-input mt-1 w-full rounded-lg border px-2.5 py-1.5 text-[12px] font-medium"
              rows={1}
              placeholder="Add a note for this box close snapshot..."
              value={auditNote}
              onChange={(e) => setAuditNote(e.target.value)}
            />
          </div>

          {showAckHint ? (
            <p className="operator-shipment-close-review__ack-hint mt-2 text-center text-[11px] font-semibold leading-snug">
              Review and acknowledge issues to continue.
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
