"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  Boxes,
  Camera,
  ClipboardCheck,
  Link2,
  Package2,
  RotateCcw,
  Send,
  TrendingUp,
} from "lucide-react";
import type { CommandCenterSnapshot, ReturnsAnalyticsPayload } from "../app/returns/returns-action-types";
import { DashboardAnalytics } from "./DashboardAnalytics";

const PIE_COLORS = ["#b08a3c", "#8a681f", "#4d5560", "#10b981", "#0ea5e9", "#8b5cf6"];

function formatUsd(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Number.isFinite(n) ? n : 0);
}

function fmtShortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtWhen(iso: string | null): string {
  if (!iso?.trim()) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

type KpiCardProps = {
  label: string;
  value: string | number;
  hint: string;
  icon: React.ElementType;
  href?: string | null;
  disabled?: boolean;
};

function KpiCard({ label, value, hint, icon: Icon, href, disabled }: KpiCardProps) {
  const inner = (
    <div
      className={[
        "admin-stat-card h-full px-4 py-4 transition",
        href && !disabled ? "hover:border-primary/40 hover:shadow-md cursor-pointer" : "",
        disabled ? "opacity-60" : "",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="admin-stat-card__label">{label}</p>
          <p className="admin-stat-card__value mt-1 text-2xl tabular-nums sm:text-3xl">{value}</p>
          <p className="admin-stat-card__hint mt-2">{hint}</p>
        </div>
        <span className="admin-stat-card__icon">
          <Icon className="h-5 w-5" strokeWidth={2.25} />
        </span>
      </div>
    </div>
  );
  if (href && !disabled) {
    return (
      <Link href={href} className="block h-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {inner}
      </Link>
    );
  }
  return inner;
}

const ACTION_KIND_LABEL: Record<string, string> = {
  missing_evidence: "Missing evidence",
  package_hold: "Package hold",
  product_link: "Product link",
  stale_package: "Stale package",
  claim_review: "Claim review",
};

export function CommandCenterDashboard({
  command,
  analytics,
}: {
  command: CommandCenterSnapshot | null;
  analytics: ReturnsAnalyticsPayload | null;
}) {
  const [trendRange, setTrendRange] = useState<"7d" | "30d">("7d");

  const trendData = useMemo(() => {
    if (!command) return [];
    const src = trendRange === "7d" ? command.returnsTrend7d : command.returnsTrend30d;
    return src.map((p) => ({ ...p, label: fmtShortDate(p.date) }));
  }, [command, trendRange]);

  const linkagePie = useMemo(() => {
    if (!command) return [];
    const { resolved, unresolved } = command.productLinkage;
    if (resolved + unresolved <= 0) return [];
    return [
      { name: "Resolved", value: resolved },
      { name: "Unresolved", value: unresolved },
    ];
  }, [command]);

  const conditionPie = useMemo(() => {
    if (!analytics?.conditionSlices?.length) return [];
    return analytics.conditionSlices.map((s) => ({
      name: s.name.replace(/_/g, " "),
      value: s.value,
    }));
  }, [analytics]);

  if (!command) {
    return (
      <section className="admin-panel-card p-6 text-center text-sm text-muted-foreground">
        Command center metrics will appear when workspace data is available.
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Returns today"
          value={command.returnsToday}
          hint="New return items since midnight UTC."
          icon={RotateCcw}
          href="/returns"
        />
        <KpiCard
          label="Open packages"
          value={command.openPackageCount}
          hint="Packages with status open."
          icon={Package2}
          href="/returns"
        />
        <KpiCard
          label="Open pallets"
          value={command.openPalletCount}
          hint="Pallets with status open."
          icon={Boxes}
          href="/returns"
        />
        <KpiCard
          label="Expected items"
          value={command.expectedItemsTotal}
          hint="Sum of expected_scan_quantity (capped sample)."
          icon={TrendingUp}
          disabled={command.expectedItemsTotal === 0}
        />
        <KpiCard
          label="Scanned items"
          value={command.scannedItemsTotal}
          hint="Return items in catalog (non-deleted)."
          icon={Camera}
          href="/returns"
        />
        <KpiCard
          label="Ready claims value"
          value={formatUsd(command.readyClaimsValueUsd)}
          hint="Sum of estimated_value on ready_for_claim items."
          icon={Send}
          href="/claim-engine/inbox"
        />
        <KpiCard
          label="Missing evidence"
          value={command.missingEvidenceCount}
          hint="Items in pending_evidence status."
          icon={AlertTriangle}
          href="/returns"
        />
        <KpiCard
          label="Needs product link"
          value={command.needsProductLinkCount}
          hint="Unresolved identifier_resolution_status."
          icon={Link2}
          href="/returns"
        />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="admin-panel-card p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-foreground">Returns trend</p>
              <p className="text-xs text-muted-foreground">Daily return item volume (UTC).</p>
            </div>
            <div className="flex rounded-lg border border-border p-0.5 text-xs">
              <button
                type="button"
                className={[
                  "rounded-md px-2.5 py-1 font-medium",
                  trendRange === "7d" ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                ].join(" ")}
                onClick={() => setTrendRange("7d")}
              >
                7d
              </button>
              <button
                type="button"
                className={[
                  "rounded-md px-2.5 py-1 font-medium",
                  trendRange === "30d" ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                ].join(" ")}
                onClick={() => setTrendRange("30d")}
              >
                30d
              </button>
            </div>
          </div>
          {trendData.every((d) => d.count === 0) ? (
            <p className="py-16 text-center text-xs text-muted-foreground">No returns in this window.</p>
          ) : (
            <div className="h-[220px] w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={28} />
                  <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                  <Line type="monotone" dataKey="count" stroke="#b08a3c" strokeWidth={2} dot={false} name="Returns" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="admin-panel-card p-4 sm:p-5">
          <p className="text-sm font-semibold text-foreground">Claim funnel</p>
          <p className="text-xs text-muted-foreground">Scanned → eligible → draft → ready → submitted.</p>
          <div className="mt-3 h-[220px] w-full min-w-0">
            {command.claimFunnel.every((s) => s.count === 0) ? (
              <p className="flex h-full items-center justify-center text-xs text-muted-foreground">No claim pipeline data yet.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={command.claimFunnel} margin={{ top: 8, right: 8, left: 0, bottom: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="stage" tick={{ fontSize: 10 }} angle={-12} textAnchor="end" height={48} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={28} />
                  <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                  <Bar dataKey="count" fill="#8a681f" radius={[6, 6, 0, 0]} name="Items" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="admin-panel-card p-4 sm:p-5">
          <p className="text-sm font-semibold text-foreground">Product linkage</p>
          <p className="text-xs text-muted-foreground">Resolved vs unresolved return items.</p>
          {linkagePie.length === 0 ? (
            <p className="py-16 text-center text-xs text-muted-foreground">No linkage data yet.</p>
          ) : (
            <div className="h-[220px] w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={linkagePie} dataKey="value" nameKey="name" innerRadius={48} outerRadius={80} paddingAngle={2}>
                    {linkagePie.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="admin-panel-card p-4 sm:p-5">
          <p className="text-sm font-semibold text-foreground">Item condition breakdown</p>
          <p className="text-xs text-muted-foreground">From recent return items sample.</p>
          {conditionPie.length === 0 ? (
            <p className="py-16 text-center text-xs text-muted-foreground">No condition tags recorded yet.</p>
          ) : (
            <div className="h-[220px] w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={conditionPie} dataKey="value" nameKey="name" innerRadius={48} outerRadius={80} paddingAngle={2}>
                    {conditionPie.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section className="admin-panel-card p-4 sm:p-5 xl:col-span-2">
          <div className="mb-3 flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-primary" />
            <p className="text-sm font-semibold text-foreground">Action queue</p>
          </div>
          {command.actionQueue.length === 0 ? (
            <p className="text-xs text-muted-foreground">No items need attention right now.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Type</th>
                    <th className="py-2 pr-3 font-medium">Item</th>
                    <th className="py-2 pr-3 font-medium">Detail</th>
                    <th className="py-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {command.actionQueue.map((row) => (
                    <tr key={row.id} className="border-b border-border/50">
                      <td className="py-2 pr-3 text-foreground">{ACTION_KIND_LABEL[row.kind] ?? row.kind}</td>
                      <td className="py-2 pr-3">
                        {row.href ? (
                          <Link href={row.href} className="font-medium text-primary underline-offset-2 hover:underline">
                            {row.title}
                          </Link>
                        ) : (
                          <span className="text-foreground">{row.title}</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{row.detail}</td>
                      <td className="py-2 tabular-nums text-muted-foreground">{fmtWhen(row.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="admin-panel-card p-4 sm:p-5">
          <p className="text-sm font-semibold text-foreground">Health</p>
          <p className="mt-1 text-xs text-muted-foreground">Sync, catalog, and import signals.</p>
          <dl className="mt-4 space-y-3 text-xs">
            <div>
              <dt className="font-medium text-muted-foreground">Last sync</dt>
              <dd className="mt-0.5 text-foreground">{fmtWhen(command.health.lastSyncAt)}</dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground">Last product update</dt>
              <dd className="mt-0.5 text-foreground">{fmtWhen(command.health.lastProductUpdateAt)}</dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground">API automation</dt>
              <dd className="mt-0.5 text-foreground">{command.health.apiAutomationStatus}</dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground">Import errors (tracked)</dt>
              <dd className="mt-0.5 tabular-nums text-foreground">{command.health.importErrorsCount}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="admin-panel-card p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-foreground">Operational summary</p>
            <p className="text-xs text-muted-foreground">Existing dashboard analytics (carriers, operators, processing time).</p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-border bg-muted/40 px-2.5 py-1">
              Claims ready: <strong className="text-foreground">{command.claimsReadyToSend}</strong>
            </span>
            <span className="rounded-full border border-border bg-muted/40 px-2.5 py-1">
              Returns est.: <strong className="text-foreground">{formatUsd(command.returnsEstimatedValueUsd)}</strong>
            </span>
          </div>
        </div>
        <DashboardAnalytics data={analytics} />
      </section>

      <section className="admin-panel-card p-5 sm:p-6">
        <p className="text-sm font-semibold tracking-tight text-foreground">Next steps</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Process inbound returns in Returns Processing. File and track marketplace claims in Claims.
        </p>
        <div className="mt-4 flex flex-wrap gap-2.5">
          <Link href="/returns" className="admin-btn-primary">
            Returns Processing
          </Link>
          <Link href="/claim-engine/inbox" className="admin-btn-secondary">
            Claims
          </Link>
          <Link href="/dashboard/products" className="admin-btn-quiet">
            Product Information
          </Link>
          <Link href="/settings" className="admin-btn-quiet">
            Connected Stores
          </Link>
        </div>
      </section>
    </div>
  );
}
