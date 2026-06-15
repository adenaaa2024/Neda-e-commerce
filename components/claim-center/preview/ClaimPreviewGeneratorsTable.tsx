"use client";

import type { PreviewGeneratorItem } from "@/lib/claims/center/claim-first-safe-families-preview-generators-v1";
import {
  CLAIM_CENTER_TABLE_CLASS,
  CLAIM_CENTER_TABLE_HEAD_CLASS,
  CLAIM_CENTER_TABLE_ROW_CLASS,
  claimCenterBadgeTone,
} from "@/components/claim-center/claim-center-ui";
import {
  PREVIEW_GENERATOR_BADGE_LABELS,
  actionLabel,
  formatPreviewMoney,
  previewGeneratorBadges,
} from "@/lib/claims/preview/claim-preview-generators-ui-contract";

type Props = {
  rows: PreviewGeneratorItem[];
  selectedIds: Set<string>;
  onToggleSelect: (previewId: string) => void;
  emptyLabel?: string;
};

function badgeTone(id: string): string {
  if (id === "needs_review" || id === "date_gated") return claimCenterBadgeTone("warning");
  if (id === "disputed_excluded") return claimCenterBadgeTone("danger");
  return claimCenterBadgeTone("neutral");
}

function productLabel(item: PreviewGeneratorItem): string {
  const parts = [item.asin, item.fnsku, item.sku].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  if (item.product_id) return item.product_id.slice(0, 8) + "…";
  return "—";
}

export function ClaimPreviewGeneratorsTable({
  rows,
  selectedIds,
  onToggleSelect,
  emptyLabel = "No previews match these filters.",
}: Props) {
  return (
    <div className="claim-center-table-card overflow-x-auto rounded-xl border">
      <table className={CLAIM_CENTER_TABLE_CLASS}>
        <thead className={`${CLAIM_CENTER_TABLE_HEAD_CLASS} text-[10px] uppercase opacity-70`}>
          <tr>
            <th className="px-3 py-2 w-8" />
            <th className="px-3 py-2">Preview ID</th>
            <th className="px-3 py-2">Family</th>
            <th className="px-3 py-2">Action</th>
            <th className="px-3 py-2">Product</th>
            <th className="px-3 py-2">Source</th>
            <th className="px-3 py-2">Event key</th>
            <th className="px-3 py-2 text-right">Qty</th>
            <th className="px-3 py-2 text-right">Observed</th>
            <th className="px-3 py-2 text-right">Est. payout</th>
            <th className="px-3 py-2 text-right">Cost</th>
            <th className="px-3 py-2">Event date</th>
            <th className="px-3 py-2">Date gate</th>
            <th className="px-3 py-2">Confidence</th>
            <th className="px-3 py-2">Flags / badges</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={15} className="px-4 py-10 text-center text-sm opacity-60">
                {emptyLabel}
              </td>
            </tr>
          ) : (
            rows.map((item) => {
              const badges = previewGeneratorBadges(item);
              const checked = selectedIds.has(item.preview_id);
              return (
                <tr key={item.preview_id} className={CLAIM_CENTER_TABLE_ROW_CLASS}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleSelect(item.preview_id)}
                      aria-label={`Select ${item.preview_id}`}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-[10px]">{item.preview_id}</td>
                  <td className="px-3 py-2 text-xs">{item.family_key.replace(/_/g, " ")}</td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      className={claimCenterBadgeTone(
                        item.recommended_action === "claim_ready"
                          ? "success"
                          : item.recommended_action === "needs_review"
                            ? "warning"
                            : "neutral",
                      )}
                    >
                      {actionLabel(item.recommended_action)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">{productLabel(item)}</td>
                  <td className="px-3 py-2 text-xs">{item.source_kind}</td>
                  <td className="px-3 py-2 text-xs font-mono">{item.source_event_key ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-xs">
                    {item.quantity_claimed ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {formatPreviewMoney(item.observed_reimbursement)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {formatPreviewMoney(item.estimated_amazon_payout)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {formatPreviewMoney(item.internal_cost_loss)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {item.source_event_date ?? item.event_date ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {item.date_gate_passed ? (
                      <span className={claimCenterBadgeTone("success")}>Pass</span>
                    ) : (
                      <span className={claimCenterBadgeTone("warning")}>Fail</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{item.confidence}</td>
                  <td className="px-3 py-2">
                    <div className="flex max-w-[200px] flex-wrap gap-1">
                      {badges.map((b) => (
                        <span key={b} className={badgeTone(b)}>
                          {PREVIEW_GENERATOR_BADGE_LABELS[b]}
                        </span>
                      ))}
                      {item.review_flags
                        .filter(
                          (f) =>
                            ![
                              "disputed_source_row",
                              "fee_payout_unavailable",
                              "cogs_unavailable",
                            ].includes(f),
                        )
                        .map((f) => (
                          <span key={f} className={claimCenterBadgeTone("info")}>
                            {f.replace(/_/g, " ")}
                          </span>
                        ))}
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
