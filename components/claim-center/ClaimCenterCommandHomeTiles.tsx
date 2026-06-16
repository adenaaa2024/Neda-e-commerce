"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  BadgeCheck,
  ClipboardCheck,
  DollarSign,
  FileSearch,
  GitBranch,
  HelpCircle,
  Link2,
  Wallet,
} from "lucide-react";

import {
  CLAIM_CENTER_MONEY_TOOLTIPS,
  formatKnownUsd,
} from "@/lib/claims/center/claim-center-money-contract";
import type { ClaimCenterDashboardKpis } from "@/lib/claims/center/claim-center-v1-types";

type Props = {
  kpis: ClaimCenterDashboardKpis;
  referenceConflictCount?: number;
};

function Tooltip({ text }: { text: string }) {
  return (
    <span className="group/tip relative inline-flex">
      <HelpCircle className="h-3.5 w-3.5 opacity-40" aria-hidden />
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 hidden w-48 -translate-x-1/2 rounded-lg border bg-inherit px-2 py-1.5 text-[10px] leading-snug opacity-95 shadow-lg group-hover/tip:block group-focus-within/tip:block"
      >
        {text}
      </span>
    </span>
  );
}

function TileShell({
  href,
  icon: Icon,
  title,
  tone,
  children,
}: {
  href: string;
  icon: typeof DollarSign;
  title: string;
  tone: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`claim-center-home-tile claim-center-card flex min-h-[140px] flex-col rounded-xl border p-4 transition-all duration-150 hover:-translate-y-px hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500/50 ${tone}`}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/[0.04] dark:bg-white/[0.06]">
          <Icon className="h-4 w-4 opacity-75" aria-hidden />
        </span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="mt-3 flex-1 text-sm">{children}</div>
    </Link>
  );
}

export function ClaimCenterCommandHomeTiles({ kpis, referenceConflictCount = 0 }: Props) {
  const m = kpis.money;
  const potentialDisplay =
    m.potential_recovery_known_usd > 0
      ? formatKnownUsd(m.potential_recovery_known_usd)
      : m.potential_recovery_unknown_count > 0
        ? "Cost unknown"
        : "—";

  return (
    <section aria-label="Command tiles" className="claim-center-home-tiles" data-claim-center="command-home-tiles">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide opacity-60">Command tiles</h2>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <TileShell href="/claim-center/opportunities" icon={DollarSign} title="Money" tone="claim-center-home-tile--money">
          <div className="space-y-2">
            <p className="text-2xl font-bold tabular-nums">{kpis.queue_counts?.find_money_count ?? kpis.total_active}</p>
            <p className="text-xs opacity-65">recoverable in Find Money (grouped)</p>
            <div className="flex items-center justify-between gap-2 border-t border-black/5 pt-2 dark:border-white/10">
              <span className="text-xs opacity-60">Potential recovery</span>
              <Tooltip text={CLAIM_CENTER_MONEY_TOOLTIPS.potential_recovery} />
            </div>
            <p className="text-lg font-bold tabular-nums">{potentialDisplay}</p>
            {m.potential_recovery_unknown_count > 0 ? (
              <p className="text-[11px] text-amber-800 dark:text-amber-200">
                {m.potential_recovery_unknown_count} unknown amount{m.potential_recovery_unknown_count === 1 ? "" : "s"}
              </p>
            ) : null}
            {m.zero_unpriced_count > 0 ? (
              <p className="text-[11px] opacity-70">{m.zero_unpriced_count} at $0 (unpriced)</p>
            ) : null}
            {(kpis.queue_counts?.blocked_money_count ?? 0) > 0 ? (
              <p className="text-[11px] text-amber-800 dark:text-amber-200">
                {kpis.queue_counts!.blocked_money_count} blocked — still in Find Money
              </p>
            ) : null}
            <div className="border-t border-black/5 pt-2 dark:border-white/10">
              <p className="text-xs opacity-60">Open exposure (known)</p>
              <p className="font-semibold tabular-nums">
                {m.open_exposure_known_usd > 0 ? formatKnownUsd(m.open_exposure_known_usd) : "—"}
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs font-semibold opacity-80">Open opportunities →</p>
        </TileShell>

        <TileShell
          href="/claim-center/candidates?filter=needs_review"
          icon={ClipboardCheck}
          title="Review"
          tone="claim-center-home-tile--review"
        >
          <p className="text-2xl font-bold tabular-nums">{kpis.queue_counts?.review_count ?? kpis.review_blocker_count}</p>
          <p className="mt-1 text-xs opacity-65">human decision blockers</p>
          <ul className="mt-2 space-y-0.5 text-[11px] opacity-70">
            <li>{kpis.blocked_product_link_count} product (see Product Match)</li>
            <li>{referenceConflictCount} reference conflicts</li>
            <li>Proof gaps listed under Proof, not Review</li>
          </ul>
          <p className="mt-3 text-xs font-semibold opacity-80">Open review queue →</p>
        </TileShell>

        <TileShell href="/claim-center/evidence" icon={FileSearch} title="Proof" tone="claim-center-home-tile--proof">
          <p className="text-2xl font-bold tabular-nums">{kpis.queue_counts?.proof_count ?? kpis.evidence_missing_count}</p>
          <p className="mt-1 text-xs opacity-65">proof missing only</p>
          <p className="mt-2 text-[11px] opacity-70">
            {kpis.evidence_previewable_count} previewable in scope
          </p>
          <p className="mt-3 text-xs font-semibold opacity-80">Check proof gaps →</p>
        </TileShell>

        <TileShell
          href="/claim-center/product-linkage"
          icon={Link2}
          title="Product & references"
          tone="claim-center-home-tile--blockers"
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xl font-bold tabular-nums">{kpis.blocked_product_link_count}</p>
              <p className="text-[10px] opacity-60">not matched</p>
            </div>
            <div>
              <p className="text-xl font-bold tabular-nums">{referenceConflictCount}</p>
              <p className="text-[10px] opacity-60">ref conflicts</p>
            </div>
          </div>
          <p className="mt-2 text-[11px] opacity-65">Routes to Product Match or References queues.</p>
          <p className="mt-3 text-xs font-semibold opacity-80">Fix blockers →</p>
        </TileShell>

        <TileShell href="/claim-center/recovery" icon={BadgeCheck} title="Recovery" tone="claim-center-home-tile--recovery">
          {m.financial_links_present ? (
            <>
              <p className="text-2xl font-bold tabular-nums">{m.observed_reimbursed_count}</p>
              <p className="mt-1 text-xs opacity-65">observed reimbursement</p>
              {m.observed_filed_count > 0 ? (
                <p className="mt-1 text-[11px] opacity-70">{m.observed_filed_count} observed filed</p>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">Not linked yet</p>
              <p className="mt-1 text-[11px] leading-relaxed opacity-65">
                No FRR or reimbursement imports linked to opportunities in this store scope.
              </p>
            </>
          )}
          <p className="mt-3 text-xs font-semibold opacity-80">View recovery signals →</p>
        </TileShell>

        <TileShell
          href="/claim-center/reimbursement-tracking"
          icon={Wallet}
          title="Reimbursement Tracking"
          tone="claim-center-home-tile--recovery"
        >
          <p className="text-sm font-semibold">Pilot submission financial tracking</p>
          <p className="mt-2 text-[11px] leading-relaxed opacity-70">
            Read-only preview — filing status, reimbursement matches, open gaps, and follow-up needs.
          </p>
          <p className="mt-1 text-[11px] opacity-60">Not submitted to Amazon</p>
          <p className="mt-3 text-xs font-semibold opacity-80">Open reimbursement tracking →</p>
        </TileShell>

        <div className="claim-center-card flex flex-col rounded-xl border p-4 opacity-90 md:col-span-2 xl:col-span-1">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 opacity-60" aria-hidden />
            <h3 className="text-sm font-semibold">What to do next</h3>
          </div>
          <ol className="mt-3 list-decimal space-y-1.5 pl-4 text-xs leading-relaxed opacity-75">
            {kpis.money.potential_recovery_unknown_count > 0 ? (
              <li>Review opportunities with unknown amounts — link products and COGS.</li>
            ) : null}
            {kpis.review_blocker_count > 0 ? (
              <li>Clear review blockers before expecting filing readiness.</li>
            ) : null}
            {kpis.evidence_missing_count > 0 ? <li>Close proof gaps on high-priority rows.</li> : null}
            {kpis.total_active === 0 ? (
              <li>Check Sources — confirm generators ran for your store.</li>
            ) : (
              <li>Use the attention list below for deadline-driven priorities.</li>
            )}
          </ol>
        </div>
      </div>
    </section>
  );
}
