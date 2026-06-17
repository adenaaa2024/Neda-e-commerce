"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import type { PerSubmissionMoneyPreviewV2 } from "@/lib/claims/submission/claim-money-lane-preview-v2-profit-loss-v1";
import {
  MONEY_LANE_FORMULA_HELPERS,
  MONEY_LANE_UI_TOOLTIPS,
  profitIfSoldFromPreview,
} from "@/lib/claims/submission/claim-money-lane-profit-loss-ui-contract";
import { formatTrackingMoney } from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";

import {
  MoneyLaneLabelBadge,
  MoneyLaneStatusBadge,
  MoneyLaneUnknownBadge,
} from "./ReimbursementTrackingMoneyBadges";

type Props = {
  money: PerSubmissionMoneyPreviewV2;
  cogsHref: string;
};

function FormulaHint({ text }: { text: string }) {
  return <p className="mt-1 text-[10px] font-mono opacity-55">{text}</p>;
}

function MoneyValue({
  value,
  label,
}: {
  value: number | null;
  label?: "actual" | "estimate" | "unknown";
}) {
  if (value == null) return <MoneyLaneUnknownBadge />;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 tabular-nums">
      {formatTrackingMoney(value)}
      {label && label !== "unknown" ? <MoneyLaneLabelBadge label={label} /> : null}
    </span>
  );
}

function ViewBlock({
  title,
  badge,
  formula,
  tooltip,
  children,
}: {
  title: string;
  badge?: ReactNode;
  formula: string;
  tooltip?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-black/[0.02] p-3 dark:bg-white/[0.02]" title={tooltip}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-semibold">{title}</h4>
        {badge}
      </div>
      {children}
      <FormulaHint text={formula} />
    </div>
  );
}

export function ReimbursementTrackingMoneyTab({ money, cogsHref }: Props) {
  const profitIfSold = profitIfSoldFromPreview(money);
  const cogsMissing = money.cost_recovery_view.approved_cogs_unit.value == null;
  const feeLabel = money.amazon_fee_view.breakdown.fee_label;
  const feeIsEstimate = money.amazon_fee_view.breakdown.is_estimate;

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-xs opacity-90">
        {MONEY_LANE_UI_TOOLTIPS.null_preservation} Sale price is never used as COGS.
      </p>

      <ViewBlock
        title="A. Sale view"
        badge={<MoneyLaneStatusBadge kind="informational" />}
        formula={MONEY_LANE_FORMULA_HELPERS.sale_gross}
        tooltip={MONEY_LANE_UI_TOOLTIPS.sale_price}
      >
        <dl className="grid gap-2 sm:grid-cols-2 text-sm">
          <div>
            <dt className="text-[10px] uppercase opacity-55">Latest sold price (per unit)</dt>
            <dd className="mt-0.5">
              <MoneyValue value={money.sale_view.latest_sold_price.value} label="actual" />
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase opacity-55">Gross sale value</dt>
            <dd className="mt-0.5">
              <MoneyValue value={money.sale_view.gross_sale_value.value} label="actual" />
            </dd>
          </div>
        </dl>
      </ViewBlock>

      <ViewBlock
        title="B. Amazon fee view"
        badge={
          feeIsEstimate ? (
            <MoneyLaneLabelBadge label="estimate" />
          ) : feeLabel === "actual" ? (
            <MoneyLaneLabelBadge label="actual" />
          ) : (
            <MoneyLaneUnknownBadge />
          )
        }
        formula={MONEY_LANE_FORMULA_HELPERS.amazon_fees}
        tooltip={MONEY_LANE_UI_TOOLTIPS.amazon_fees}
      >
        <p className="text-[11px] opacity-70">
          {feeIsEstimate
            ? "Estimated from category-rate model — not mixed with report actuals."
            : feeLabel === "actual"
              ? "Actual from report — settlement/transaction row."
              : "Fees not found in matched report."}
        </p>
        <dl className="mt-2 grid gap-2 sm:grid-cols-2 text-sm">
          <div>
            <dt className="text-[10px] uppercase opacity-55">Fees per unit</dt>
            <dd className="mt-0.5">
              <MoneyValue value={money.amazon_fee_view.amazon_fees_per_unit.value} label={feeLabel} />
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase opacity-55">Estimated Amazon fees (qty)</dt>
            <dd className="mt-0.5">
              <MoneyValue value={money.amazon_fee_view.estimated_amazon_fees.value} label={feeLabel} />
            </dd>
          </div>
        </dl>
      </ViewBlock>

      <ViewBlock
        title="C. Settlement view"
        badge={<MoneyLaneLabelBadge label="actual" />}
        formula={MONEY_LANE_FORMULA_HELPERS.net_settlement}
      >
        <MoneyValue value={money.settlement_view.net_settlement_amount.value} label="actual" />
      </ViewBlock>

      <ViewBlock
        title="D. COGS / recovery view"
        badge={cogsMissing ? <MoneyLaneStatusBadge kind="needs_cogs" /> : <MoneyLaneLabelBadge label="actual" />}
        formula={MONEY_LANE_FORMULA_HELPERS.recovery}
        tooltip={MONEY_LANE_UI_TOOLTIPS.cogs}
      >
        <dl className="grid gap-2 sm:grid-cols-2 text-sm">
          <div>
            <dt className="text-[10px] uppercase opacity-55">Approved COGS unit</dt>
            <dd className="mt-0.5">
              <MoneyValue value={money.cost_recovery_view.approved_cogs_unit.value} />
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase opacity-55">Recovery value</dt>
            <dd className="mt-0.5">
              <MoneyValue value={money.cost_recovery_view.recovery_value.value} />
            </dd>
          </div>
        </dl>
        {cogsMissing ? (
          <div className="mt-3 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs">
            <p className="flex items-center gap-1.5 font-semibold text-amber-950 dark:text-amber-100">
              <AlertTriangle className="h-3.5 w-3.5" /> COGS missing — recovery value Unknown
            </p>
            <p className="mt-1 opacity-90">No final loss claim until approved unit cost is entered.</p>
            <Link
              href={cogsHref}
              className="mt-2 inline-flex rounded-md border border-amber-600/40 bg-white/60 px-3 py-1.5 text-[11px] font-semibold hover:bg-white/80 dark:bg-black/20"
            >
              Add COGS
            </Link>
          </div>
        ) : null}
      </ViewBlock>

      <ViewBlock
        title="E. Reimbursement view"
        badge={
          money.reimbursement_view.observed_reimbursement.value == null ? (
            <MoneyLaneStatusBadge kind="no_reimb_match" />
          ) : (
            <MoneyLaneLabelBadge label="actual" />
          )
        }
        formula={MONEY_LANE_FORMULA_HELPERS.observed_reimb}
        tooltip={MONEY_LANE_UI_TOOLTIPS.reimbursement}
      >
        <MoneyValue value={money.reimbursement_view.observed_reimbursement.value} />
      </ViewBlock>

      <ViewBlock title="F. Open gap" formula={MONEY_LANE_FORMULA_HELPERS.open_gap}>
        <MoneyValue value={money.open_gap_view.open_recovery_gap.value} />
      </ViewBlock>

      <ViewBlock
        title="G. Profit / loss view"
        badge={
          money.profit_loss_view.analysis_status === "informational_only" ? (
            <MoneyLaneStatusBadge kind="informational" />
          ) : money.profit_loss_view.analysis_status === "complete" ? (
            <MoneyLaneLabelBadge label="actual" />
          ) : (
            <MoneyLaneUnknownBadge />
          )
        }
        formula={`${MONEY_LANE_FORMULA_HELPERS.profit_if_sold} · ${MONEY_LANE_FORMULA_HELPERS.actual_recovery_vs_cost} · ${MONEY_LANE_FORMULA_HELPERS.lost_profit}`}
      >
        <p className="mb-2 text-[11px] opacity-80">{money.profit_loss_view.analysis_note}</p>
        <dl className="grid gap-2 sm:grid-cols-2 text-sm">
          <div>
            <dt className="text-[10px] uppercase opacity-55">Profit if sold</dt>
            <dd className="mt-0.5">
              <MoneyValue value={profitIfSold ?? money.profit_loss_view.estimated_profit_if_sold.value} />
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase opacity-55">Actual recovery vs cost</dt>
            <dd className="mt-0.5">
              <MoneyValue value={money.profit_loss_view.actual_recovery_vs_cost.value} />
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-[10px] uppercase opacity-55">Lost profit estimate</dt>
            <dd className="mt-0.5">
              <MoneyValue value={money.profit_loss_view.lost_profit_estimate.value} />
            </dd>
          </div>
        </dl>
        {money.profit_loss_view.informational_sale_estimate ? (
          <p className="mt-2 text-xs opacity-75">
            Informational net sale estimate:{" "}
            {money.profit_loss_view.informational_sale_estimate.display === "Unknown"
              ? "Unknown"
              : formatTrackingMoney(money.profit_loss_view.informational_sale_estimate.value)}
          </p>
        ) : null}
      </ViewBlock>

      <ViewBlock title="H. Formula explanations" formula="Read-only reference — values above use these rules">
        <ul className="space-y-2 text-xs opacity-85">
          <li>
            <span className="font-semibold">Gross sale value:</span> {MONEY_LANE_FORMULA_HELPERS.sale_gross}
          </li>
          <li>
            <span className="font-semibold">Amazon fees:</span> {MONEY_LANE_FORMULA_HELPERS.amazon_fees}
          </li>
          <li>
            <span className="font-semibold">Net settlement:</span> {MONEY_LANE_FORMULA_HELPERS.net_settlement}
          </li>
          <li>
            <span className="font-semibold">Recovery value:</span> {MONEY_LANE_FORMULA_HELPERS.recovery}
          </li>
          <li>
            <span className="font-semibold">Observed reimbursement:</span> {MONEY_LANE_FORMULA_HELPERS.observed_reimb}
          </li>
          <li>
            <span className="font-semibold">Open gap:</span> {MONEY_LANE_FORMULA_HELPERS.open_gap}
          </li>
          <li>
            <span className="font-semibold">Profit if sold:</span> {MONEY_LANE_FORMULA_HELPERS.profit_if_sold}
          </li>
          <li>
            <span className="font-semibold">Actual recovery vs cost:</span>{" "}
            {MONEY_LANE_FORMULA_HELPERS.actual_recovery_vs_cost}
          </li>
          <li>
            <span className="font-semibold">Lost profit estimate:</span> {MONEY_LANE_FORMULA_HELPERS.lost_profit}
          </li>
        </ul>
      </ViewBlock>
    </div>
  );
}
