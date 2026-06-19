"use client";

import {
  type CloseReviewIdentifierFields,
} from "@/lib/scanner/close-review-line-display";

export type CloseReviewIssueItemRow = {
  lineKey: string;
  title: string;
  qty: number;
} & CloseReviewIdentifierFields;

type CloseReviewIssueItemListProps = {
  lines: CloseReviewIssueItemRow[];
  listKey: string;
  maxRows?: number;
};

function cell(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

function extraIdentifierMeta(ids: CloseReviewIdentifierFields): string | null {
  const parts = [
    cell(ids.asin) ? `ASIN: ${cell(ids.asin)}` : null,
    cell(ids.sku) ? `SKU: ${cell(ids.sku)}` : null,
  ].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function CloseReviewIssueItemList(props: CloseReviewIssueItemListProps) {
  const { lines, listKey, maxRows = 6 } = props;
  const visible = lines.slice(0, maxRows);
  const overflow = lines.length - visible.length;

  return (
    <div className="operator-shipment-close-review__item-list-wrap">
      <ul className="operator-shipment-close-review__item-list">
        {visible.map((line) => {
          const fnsku = cell(line.fnsku);
          const extraMeta = extraIdentifierMeta(line);
          return (
            <li
              key={`${listKey}:${line.lineKey}`}
              className="operator-shipment-close-review__item-row"
            >
              <div className="operator-shipment-close-review__item-body min-w-0 flex-1">
                <p className="operator-shipment-close-review__item-title">{line.title}</p>
                {fnsku ? (
                  <p className="operator-shipment-close-review__item-fnsku mt-0.5 font-mono leading-snug">
                    FNSKU: {fnsku}
                  </p>
                ) : null}
                {extraMeta ? (
                  <p className="operator-shipment-close-review__item-meta mt-0.5 font-mono leading-snug">
                    {extraMeta}
                  </p>
                ) : null}
              </div>
              <span
                className="operator-shipment-close-review__qty-badge shrink-0 tabular-nums"
                aria-label={`Quantity ${line.qty}`}
              >
                Qty {line.qty}
              </span>
            </li>
          );
        })}
      </ul>
      {overflow > 0 ? (
        <p className="operator-shipment-close-review__more mt-2 px-0.5 text-[11px] font-semibold">
          +{overflow} more item{overflow === 1 ? "" : "s"}
        </p>
      ) : null}
    </div>
  );
}
