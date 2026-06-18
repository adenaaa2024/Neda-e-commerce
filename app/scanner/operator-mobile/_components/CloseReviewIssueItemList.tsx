"use client";

import {
  formatCloseReviewIdentifierLine,
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

export function CloseReviewIssueItemList(props: CloseReviewIssueItemListProps) {
  const { lines, listKey, maxRows = 6 } = props;
  const visible = lines.slice(0, maxRows);
  const overflow = lines.length - visible.length;

  return (
    <div className="operator-shipment-close-review__item-list-wrap">
      <ul className="operator-shipment-close-review__item-list space-y-1.5">
        {visible.map((line) => {
          const identifierLine = formatCloseReviewIdentifierLine(line);
          return (
            <li
              key={`${listKey}:${line.lineKey}`}
              className="operator-shipment-close-review__item-row flex items-start justify-between gap-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="operator-shipment-close-review__item-title text-[12px] font-semibold leading-snug">
                  {line.title}
                </p>
                {identifierLine ? (
                  <p className="operator-shipment-close-review__item-ids mt-0.5 font-mono text-[10px] leading-snug">
                    {identifierLine}
                  </p>
                ) : null}
              </div>
              <span
                className="operator-shipment-close-review__qty-badge shrink-0 tabular-nums"
                aria-label={`Quantity ${line.qty}`}
              >
                {line.qty}
              </span>
            </li>
          );
        })}
      </ul>
      {overflow > 0 ? (
        <p className="operator-shipment-close-review__more mt-2 px-1 text-[11px] font-semibold">
          +{overflow} more item{overflow === 1 ? "" : "s"}
        </p>
      ) : null}
    </div>
  );
}
