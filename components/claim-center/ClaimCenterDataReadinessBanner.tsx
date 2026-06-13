"use client";

import Link from "next/link";
import { AlertCircle } from "lucide-react";

import type { MenorixAutomationHealth } from "@/components/menorix";
import type { ClaimCenterQueryMeta } from "@/lib/claims/center/claim-center-v1-types";

const SOURCE_LABELS: Record<string, string> = {
  scanner_returns: "Scanner returns",
  scanner_physical_review: "Scanner physical review",
  reimbursement: "Amazon reimbursements",
  settlement: "Settlements",
  transaction: "Transactions",
  inventory_ledger: "Inventory ledger",
  removal_order: "Removal orders",
  removal_shipment: "Removal shipments",
  customer_return: "Customer returns",
  orbit_fra: "ORBIT-FRA carry-forward",
  safet: "SAFE-T claims",
  delayed_not_received: "Delayed / not received",
  inbound_shipment: "Inbound shipments",
  shipment_discrepancy: "Shipment discrepancies",
};

function humanSource(key: string): string {
  return SOURCE_LABELS[key] ?? key.replace(/_/g, " ");
}

type Props = {
  meta?: ClaimCenterQueryMeta | null;
  totalActive?: number | null;
  automationHealth?: MenorixAutomationHealth | null;
};

export function ClaimCenterDataReadinessBanner({ meta, totalActive, automationHealth }: Props) {
  const dbTotal = meta?.db_total_count ?? totalActive ?? null;
  const activeCount = dbTotal ?? totalActive ?? 0;

  if (activeCount > 0) {
    return null;
  }

  const enabledSources = automationHealth?.enabled_sources ?? [];
  const trustedCount = enabledSources.length;
  const sourcesChecked =
    enabledSources.length > 0
      ? enabledSources.map(humanSource).join(", ")
      : "No enabled generators reported yet — check Sources and workspace claim settings.";

  const lastRun = automationHealth?.last_run_at
    ? new Date(automationHealth.last_run_at).toLocaleString()
    : null;

  return (
    <div
      className="mt-4 rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 dark:text-amber-100"
      role="status"
      data-claim-center="data-readiness-banner"
    >
      <div className="flex gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="space-y-2">
          <p className="font-semibold">No active claim opportunities generated for this workspace yet.</p>
          <p className="text-xs leading-relaxed opacity-90">
            KPIs and queues reflect a genuinely empty pool — not demo or sample data. Older seed rows stay hidden by
            design.
          </p>
          <dl className="grid gap-1 text-xs opacity-90 sm:grid-cols-2">
            <div>
              <dt className="font-medium">Sources checked</dt>
              <dd className="opacity-85">{sourcesChecked}</dd>
            </div>
            {trustedCount > 0 ? (
              <div>
                <dt className="font-medium">Trusted sources enabled</dt>
                <dd className="opacity-85">{trustedCount}</dd>
              </div>
            ) : null}
            {lastRun ? (
              <div className="sm:col-span-2">
                <dt className="font-medium">Last discovery activity</dt>
                <dd className="opacity-85">{lastRun}</dd>
              </div>
            ) : null}
          </dl>
          {automationHealth?.warnings?.length ? (
            <ul className="list-inside list-disc text-xs opacity-85">
              {automationHealth.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
          <Link
            href="/claim-center/sources"
            className="inline-flex min-h-[40px] items-center text-xs font-semibold underline opacity-95"
          >
            Open Sources to see generator health →
          </Link>
        </div>
      </div>
    </div>
  );
}
