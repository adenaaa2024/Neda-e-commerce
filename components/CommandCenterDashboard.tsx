"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Boxes,
  Camera,
  ChevronRight,
  ClipboardCheck,
  Layers,
  Link2,
  RotateCcw,
  ScanLine,
  Send,
  Server,
  Upload,
  Maximize2,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CommandCenterPayload } from "@/app/returns/returns-action-types";
import { DashboardDragSlot } from "@/components/DashboardDragSlot";
import { parseCountUpTarget, useCountUp } from "@/hooks/useCountUp";
import {
  type BodyWidgetId,
  type ExecWidgetId,
  type InsightWidgetId,
  bodySpanClass,
  cycleBodyQueueSpan,
  cycleGridSpan,
  DEFAULT_DASHBOARD_LAYOUT,
  execSpanClass,
  insightSpanClass,
  loadDashboardLayout,
  resetDashboardLayout,
  saveDashboardLayout,
  swapIds,
} from "@/lib/dashboard-layout";

const CHART_GOLD = "#b08a3c";
const CHART_GOLD_DARK = "#d6b76e";
const PIE_COLORS = ["#b08a3c", "#8a681f", "#c9a96e", "#737b86", "#5c6370"];

const CONDITIONS_PREVIEW = 4;

const CHART_ANIM = { isAnimationActive: true, animationDuration: 2200, animationEasing: "ease-out" as const };
const COUNT_UP_MS = 1800;

function MetricValue({ value, className }: { value: string; className?: string }) {
  const plain = value.replace(/,/g, "").trim();
  const isCurrency = plain.startsWith("$");
  const numeric = isCurrency ? parseCountUpTarget(plain.slice(1)) : parseCountUpTarget(plain);
  const animated = useCountUp(numeric ?? 0, { enabled: numeric !== null, duration: COUNT_UP_MS });

  if (numeric === null) {
    return <span className={className}>{value}</span>;
  }

  const display = isCurrency
    ? formatUsd(animated)
    : animated.toLocaleString();

  return <span className={[className, "cc-exec-metric__value--counting"].filter(Boolean).join(" ")}>{display}</span>;
}

function formatUsd(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Number.isFinite(n) ? n : 0);
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t));
}

function formatTrendDate(iso: string): string {
  const t = Date.parse(`${iso}T12:00:00Z`);
  if (!Number.isFinite(t)) return iso;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(t));
}

function fmtConditionLabel(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function SparseState({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="cc-sparse">
      <p className="cc-sparse__title">{message}</p>
      {detail ? <p className="cc-sparse__detail">{detail}</p> : null}
    </div>
  );
}

type ExecMetric = { label: string; value: string; emphasis?: boolean; warn?: boolean };

type ExecGroupProps = {
  title: string;
  icon: React.ReactNode;
  href?: string | null;
  metrics: ExecMetric[];
  footnote?: string;
  alertPill?: string | null;
};

function ExecGroup({ title, icon, href, metrics, footnote, alertPill }: ExecGroupProps) {
  const card = (
    <div className="cc-exec-card">
      <div className="cc-exec-card__head">
        <span className="cc-exec-card__icon" aria-hidden>
          {icon}
        </span>
        <span className="cc-exec-card__title">{title}</span>
        {alertPill ? <span className="cc-exec-alert-pill">{alertPill}</span> : null}
        {href ? <ChevronRight className="cc-exec-card__chevron h-4 w-4 shrink-0 opacity-50" aria-hidden /> : null}
      </div>
      <dl className="cc-exec-metrics">
        {metrics.map((m) => (
          <div key={m.label} className="cc-exec-metric">
            <dt className="cc-exec-metric__label">{m.label}</dt>
            <dd
              className={`cc-exec-metric__value ${
                m.warn ? "cc-exec-metric__value--warn" : m.emphasis ? "cc-exec-metric__value--emph" : ""
              }`}
            >
              <MetricValue value={m.value} />
            </dd>
          </div>
        ))}
      </dl>
      {footnote ? <p className="cc-exec-footnote">{footnote}</p> : <p className="cc-exec-footnote cc-exec-footnote--placeholder" aria-hidden>&nbsp;</p>}
    </div>
  );
  if (href) {
    return (
      <Link href={href} className="cc-exec-link block h-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {card}
      </Link>
    );
  }
  return <div className="cc-exec-wrap h-full">{card}</div>;
}

function ConditionsInsightCard({
  slices,
  maxCondition,
}: {
  slices: { name: string; value: number }[];
  maxCondition: number;
}) {
  const visible = slices.slice(0, CONDITIONS_PREVIEW);
  const moreCount = slices.length - visible.length;

  return (
    <div className="cc-panel cc-insight-card cc-conditions-insight">
      <header className="cc-insight-card__head">
        <Layers className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden />
        <h3 className="cc-chart-title">Conditions</h3>
      </header>
      <p className="cc-chart-sub">Recent item tags</p>
      {slices.length === 0 ? (
        <SparseState message="No tags yet" detail="Condition labels appear on scanned items." />
      ) : (
        <ul className="cc-conditions-insight__list" aria-label="Condition breakdown">
          {visible.map((c, i) => (
            <li key={c.name} className="cc-conditions-insight__item">
              <div className="cc-conditions-insight__row">
                <span className="cc-conditions-insight__label truncate">{fmtConditionLabel(c.name)}</span>
                <span className="cc-conditions-insight__value tabular-nums">
                  <MetricValue value={String(c.value)} />
                </span>
              </div>
              <div className="command-center-progress-track cc-conditions-insight__track">
                <div
                  className="cc-conditions-insight__fill cc-progress-animate h-full rounded-sm"
                  style={{
                    width: `${Math.round((c.value / maxCondition) * 100)}%`,
                    backgroundColor: PIE_COLORS[i % PIE_COLORS.length],
                  }}
                />
              </div>
            </li>
          ))}
          {moreCount > 0 ? (
            <li className="cc-conditions-insight__more tabular-nums">+{moreCount} more</li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

const ACTION_CHIP: Record<string, string> = {
  missing_evidence: "cc-chip cc-chip--warn",
  product_link: "cc-chip cc-chip--gold",
  stale_package: "cc-chip cc-chip--muted",
  open_pallet: "cc-chip cc-chip--muted",
  claim_ready: "cc-chip cc-chip--claim",
  package_hold: "cc-chip cc-chip--warn",
};

function ActionTypeLabel({ type }: { type: string }) {
  const map: Record<string, string> = {
    missing_evidence: "Evidence",
    product_link: "Link",
    stale_package: "Stale pkg",
    open_pallet: "Pallet",
    claim_ready: "Claim",
    package_hold: "Hold",
  };
  return <>{map[type] ?? type}</>;
}

export function CommandCenterDashboard({
  data,
  fetchError,
}: {
  data: CommandCenterPayload | null;
  fetchError: string | null;
}) {
  if (!data) {
    return (
      <div className="cc-panel px-6 py-12 text-center">
        <p className="text-sm font-medium text-foreground">Command center unavailable</p>
        <p className="mt-2 text-xs text-muted-foreground">
          {fetchError ?? "Could not load operational metrics."}
        </p>
      </div>
    );
  }

  return <CommandCenterDashboardLoaded data={data} fetchError={fetchError} />;
}

function CommandCenterDashboardLoaded({
  data,
  fetchError,
}: {
  data: CommandCenterPayload;
  fetchError: string | null;
}) {
  const { snapshot: snap } = data;
  const scanPct =
    data.expectedItems > 0
      ? Math.min(100, Math.round((data.scannedItems / data.expectedItems) * 100))
      : null;
  const linkTotal = data.needsProductLink + data.productLinkResolved;
  const linkResolvedPct = linkTotal > 0 ? Math.round((data.productLinkResolved / linkTotal) * 100) : 0;

  const trendHasActivity = data.returnsTrend.some((p) => p.count > 0);
  const trendChart = data.returnsTrend.map((p) => ({ ...p, label: formatTrendDate(p.date) }));

  const funnelChart = [
    { stage: "Scan", count: data.claimFunnel.scanned },
    { stage: "Elig", count: data.claimFunnel.eligible },
    { stage: "Draft", count: data.claimFunnel.draft },
    { stage: "Ready", count: data.claimFunnel.ready },
    { stage: "Sent", count: data.claimFunnel.submitted },
  ];
  const funnelHasData = funnelChart.some((f) => f.count > 0);
  const maxCondition = Math.max(1, ...data.conditionSlices.map((c) => c.value));
  const exceptionsCount = data.missingEvidence + data.needsProductLink;

  const queueTotal = data.actionQueue.length;
  const queueCountDisplay = useCountUp(queueTotal);

  const [layout, setLayout] = useState(DEFAULT_DASHBOARD_LAYOUT);

  useEffect(() => {
    setLayout(loadDashboardLayout());
  }, []);

  const persistLayout = useCallback((updater: (prev: typeof DEFAULT_DASHBOARD_LAYOUT) => typeof DEFAULT_DASHBOARD_LAYOUT) => {
    setLayout((prev) => {
      const next = updater(prev);
      saveDashboardLayout(next);
      return next;
    });
  }, []);

  const onExecSwap = useCallback(
    (sourceId: string, targetId: string) => {
      persistLayout((prev) => ({
        ...prev,
        execOrder: swapIds(prev.execOrder, sourceId as ExecWidgetId, targetId as ExecWidgetId),
      }));
    },
    [persistLayout],
  );

  const onInsightSwap = useCallback(
    (sourceId: string, targetId: string) => {
      persistLayout((prev) => ({
        ...prev,
        insightOrder: swapIds(prev.insightOrder, sourceId as InsightWidgetId, targetId as InsightWidgetId),
      }));
    },
    [persistLayout],
  );

  const onBodySwap = useCallback(
    (sourceId: string, targetId: string) => {
      persistLayout((prev) => ({
        ...prev,
        bodyOrder: swapIds(prev.bodyOrder, sourceId as BodyWidgetId, targetId as BodyWidgetId),
      }));
    },
    [persistLayout],
  );

  const onResetLayout = useCallback(() => {
    const next = resetDashboardLayout();
    setLayout(next);
    saveDashboardLayout(next);
  }, []);

  const cycleExecSpan = useCallback(
    (id: ExecWidgetId) => {
      persistLayout((prev) => ({
        ...prev,
        execSpans: { ...prev.execSpans, [id]: cycleGridSpan(prev.execSpans[id]) },
      }));
    },
    [persistLayout],
  );

  const cycleInsightSpan = useCallback(
    (id: InsightWidgetId) => {
      persistLayout((prev) => ({
        ...prev,
        insightSpans: { ...prev.insightSpans, [id]: cycleGridSpan(prev.insightSpans[id]) },
      }));
    },
    [persistLayout],
  );

  const cycleBodyQueueSize = useCallback(() => {
    persistLayout((prev) => ({
      ...prev,
      bodyQueueSpan: cycleBodyQueueSpan(prev.bodyQueueSpan),
    }));
  }, [persistLayout]);

  const execWidgets: Record<ExecWidgetId, React.ReactNode> = {
    today: (
      <ExecGroup
        title="Today"
        href="/returns"
        icon={<RotateCcw className="h-4 w-4" strokeWidth={2.25} />}
        metrics={[
          { label: "Returns", value: String(snap.returnsToday), emphasis: true },
          { label: "Scanned", value: data.scannedItems.toLocaleString(), emphasis: true },
        ]}
        footnote="UTC day · physical items in scope"
      />
    ),
    open: (
      <ExecGroup
        title="Open work"
        href="/returns"
        icon={<Boxes className="h-4 w-4" strokeWidth={2.25} />}
        metrics={[
          { label: "Pallets", value: String(data.openPallets), emphasis: true },
          { label: "Packages", value: String(data.openPackages), emphasis: true },
        ]}
        footnote={`${snap.palletCount} pallets · ${snap.packageCount} packages total`}
      />
    ),
    exceptions: (
      <ExecGroup
        title="Exceptions"
        href={exceptionsCount > 0 ? "/claim-engine/inbox" : undefined}
        icon={<Camera className="h-4 w-4" strokeWidth={2.25} />}
        alertPill={exceptionsCount > 0 ? `${exceptionsCount} open` : null}
        metrics={[
          { label: "Evidence", value: String(data.missingEvidence), warn: data.missingEvidence > 0 },
          { label: "Link gap", value: String(data.needsProductLink), warn: data.needsProductLink > 0 },
        ]}
        footnote={
          data.expectedItems > 0
            ? `${data.expectedItems.toLocaleString()} expected units`
            : "Evidence and linkage gaps"
        }
      />
    ),
    claims: (
      <ExecGroup
        title="Claims"
        href={snap.claimsReadyToSend > 0 ? "/claim-engine" : undefined}
        icon={<Send className="h-4 w-4" strokeWidth={2.25} />}
        metrics={[
          { label: "Ready", value: String(snap.claimsReadyToSend), emphasis: true },
          { label: "Est. value", value: formatUsd(snap.returnsEstimatedValueUsd) },
        ]}
        footnote={`${data.claimsDraft} draft in queue`}
      />
    ),
  };

  const insightWidgets: Record<InsightWidgetId, React.ReactNode> = {
    trend: (
      <div className="cc-panel cc-insight-card h-full">
        <h3 className="cc-chart-title">Returns trend</h3>
        <p className="cc-chart-sub">30 days UTC</p>
        {!trendHasActivity ? (
          <SparseState message="Quiet period" detail="No return items in the last 30 days." />
        ) : (
          <div className="cc-chart-box cc-chart-box--insight" role="img" aria-label="Returns trend">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendChart} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 4" className="stroke-border" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 8 }} interval="preserveStartEnd" />
                <YAxis allowDecimals={false} tick={{ fontSize: 8 }} width={24} />
                <Tooltip contentStyle={{ borderRadius: 6, fontSize: 11 }} />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke={CHART_GOLD}
                  strokeWidth={1.75}
                  dot={false}
                  activeDot={{ r: 3 }}
                  {...CHART_ANIM}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    ),
    scan: (
      <div className="cc-panel cc-insight-card h-full">
        <h3 className="cc-chart-title">Scanned vs expected</h3>
        <p className="cc-chart-sub">Package declarations</p>
        {data.expectedItems <= 0 && data.scannedItems <= 0 ? (
          <SparseState message="No volume yet" detail="Expected counts come from open packages." />
        ) : (
          <div className="cc-scan-compact cc-scan-compact--insight">
            <div className="flex justify-between text-[11px] tabular-nums">
              <span>{data.scannedItems.toLocaleString()} scanned</span>
              <span>{data.expectedItems.toLocaleString()} expected</span>
            </div>
            <div
              className="command-center-progress-track cc-progress-sm"
              role="progressbar"
              aria-valuenow={scanPct ?? 0}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="command-center-progress-fill cc-progress-animate h-full rounded-sm"
                style={{ width: `${scanPct ?? (data.scannedItems > 0 ? 100 : 0)}%` }}
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              {scanPct !== null ? `${scanPct}% matched` : "No expected counts on packages"}
            </p>
          </div>
        )}
      </div>
    ),
    funnel: (
      <div className="cc-panel cc-insight-card h-full">
        <h3 className="cc-chart-title">Claim funnel</h3>
        <p className="cc-chart-sub">Pipeline stages</p>
        {!funnelHasData ? (
          <SparseState message="Pipeline idle" detail="Claims appear as items move through filing." />
        ) : (
          <div className="cc-chart-box cc-chart-box--insight" role="img" aria-label="Claim funnel">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={funnelChart} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="2 4" className="stroke-border" vertical={false} />
                <XAxis dataKey="stage" tick={{ fontSize: 8 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 8 }} width={22} />
                <Tooltip contentStyle={{ borderRadius: 6, fontSize: 11 }} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]} {...CHART_ANIM}>
                  {funnelChart.map((_, i) => (
                    <Cell key={i} fill={i % 2 === 0 ? CHART_GOLD : CHART_GOLD_DARK} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    ),
    conditions: <ConditionsInsightCard slices={data.conditionSlices} maxCondition={maxCondition} />,
  };

  const bodyWidgets: Record<BodyWidgetId, React.ReactNode> = {
    queue: (
      <section aria-label="Action queue" className="cc-panel cc-queue-panel cc-body-main h-full">
        <header className="cc-panel__header cc-queue-header">
          <div className="flex min-w-0 items-center gap-2">
            <span className="cc-queue-header__badge" aria-hidden>
              <AlertTriangle className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <h2 className="cc-panel__title">Action queue</h2>
              <p className="cc-panel__subtitle">Top priority work</p>
            </div>
          </div>
          <span className="cc-queue-count tabular-nums">
            {queueTotal === 0 ? "Clear" : `${queueCountDisplay} open`}
          </span>
        </header>

        <div className="cc-queue-body cc-scroll-subtle">
          {queueTotal === 0 ? (
            <div className="cc-queue-empty">
              <p className="text-sm font-medium text-foreground">No urgent actions right now.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Evidence gaps, stale packages, and claim-ready items appear here when they need attention.
              </p>
            </div>
          ) : (
            <ul className="cc-queue-list">
              {data.actionQueue.map((item) => (
                <li key={item.id} className="cc-queue-row">
                  <div className="cc-queue-row__main min-w-0">
                    <div className="cc-queue-row__top">
                      <span className={ACTION_CHIP[item.type] ?? "cc-chip"}>
                        <ActionTypeLabel type={item.type} />
                      </span>
                      {item.reference ? (
                        <span className="cc-queue-ref font-mono">{item.reference}</span>
                      ) : null}
                    </div>
                    <p className="cc-queue-label truncate">{item.label}</p>
                    <p className="cc-queue-meta">
                      {formatWhen(item.createdAt)}
                      <span className="cc-queue-meta__dot" aria-hidden>
                        ·
                      </span>
                      <span className="capitalize">{item.status.replace(/_/g, " ")}</span>
                    </p>
                  </div>
                  {item.href ? (
                    <Link href={item.href} className="cc-btn-review">
                      Review
                      <ArrowRight className="h-3 w-3" />
                    </Link>
                  ) : (
                    <span className="cc-btn-review cc-btn-review--disabled">Review</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="cc-queue-footer">
          {queueTotal > 0 ? (
            <Link href="/claim-engine/inbox" className="cc-queue-view-all">
              View all {queueTotal} actions
              <ArrowRight className="h-3 w-3" />
            </Link>
          ) : null}
          <div className="cc-queue-footer__actions">
            <Link href="/returns" className="admin-btn-primary text-xs">
              Returns
            </Link>
            <Link href="/claim-engine" className="admin-btn-secondary text-xs">
              Claims
            </Link>
          </div>
        </footer>
      </section>
    ),
    rail: (
      <aside className="cc-rail cc-rail--compact cc-body-rail h-full" aria-label="Status rail">
        <div className="cc-panel cc-rail-card cc-rail-card--compact">
          <header className="cc-panel__header cc-panel__header--compact">
            <Server className="h-3.5 w-3.5 text-primary" aria-hidden />
            <h3 className="cc-panel__title">Health &amp; sync</h3>
          </header>
          <div className="cc-rail-card__body">
            <dl className="cc-health-list cc-health-list--compact">
              <div className="cc-health-row">
                <Upload className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                <div>
                  <dt>Import</dt>
                  <dd>
                    {data.health.lastImportAt
                      ? `${formatWhen(data.health.lastImportAt)}${data.health.lastImportLabel ? ` · ${data.health.lastImportLabel}` : ""}`
                      : "No recent run"}
                  </dd>
                </div>
              </div>
              <div className="cc-health-row">
                <Activity className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                <div>
                  <dt>Product job</dt>
                  <dd>
                    {data.health.productJobStatus
                      ? `${data.health.productJobStatus}${data.health.productJobAt ? ` · ${formatWhen(data.health.productJobAt)}` : ""}`
                      : "Not configured"}
                  </dd>
                </div>
              </div>
              <div className="cc-health-row">
                <ClipboardCheck className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                <div>
                  <dt>Audit</dt>
                  <dd>
                    {data.health.lastAuditAt
                      ? `${data.health.lastAuditAction ?? "Event"} · ${formatWhen(data.health.lastAuditAt)}`
                      : "None recent"}
                  </dd>
                </div>
              </div>
              <div className="cc-health-row">
                <ScanLine className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                <div>
                  <dt>Volume</dt>
                  <dd>{data.health.scannerActivityHint}</dd>
                </div>
              </div>
            </dl>
            {data.health.importErrorsHint ? (
              <p className="cc-health-warn">{data.health.importErrorsHint}</p>
            ) : null}
          </div>
        </div>

        <div className="cc-panel cc-rail-card cc-rail-card--compact">
          <header className="cc-panel__header cc-panel__header--compact">
            <Link2 className="h-3.5 w-3.5 text-primary" aria-hidden />
            <h3 className="cc-panel__title">Product linkage</h3>
          </header>
          <div className="cc-rail-card__body cc-rail-card__body--center">
            {linkTotal <= 0 ? (
              <p className="cc-rail-empty">No linkage in scope yet.</p>
            ) : (
              <div className="cc-linkage-compact cc-linkage-compact--sm">
                <div
                  className="cc-linkage-ring cc-linkage-ring--sm"
                  style={{
                    background: `conic-gradient(${CHART_GOLD} ${linkResolvedPct * 3.6}deg, var(--muted) 0deg)`,
                  }}
                  aria-hidden
                >
                  <span className="cc-linkage-ring__inner">{linkResolvedPct}%</span>
                </div>
                <ul className="cc-linkage-stats">
                  <li>
                    <span className="tabular-nums font-semibold text-foreground"><MetricValue value={String(data.productLinkResolved)} /></span>
                    <span className="text-muted-foreground"> resolved</span>
                  </li>
                  <li>
                    <span className="tabular-nums font-semibold text-foreground"><MetricValue value={String(data.needsProductLink)} /></span>
                    <span className="text-muted-foreground"> need link</span>
                  </li>
                </ul>
              </div>
            )}
            {data.needsProductLink > 0 ? (
              <Link href="/claim-engine/inbox" className="cc-rail-link">
                Open inbox <ArrowRight className="h-3 w-3" />
              </Link>
            ) : null}
          </div>
        </div>

        <div className="cc-panel cc-rail-card cc-rail-card--compact">
          <header className="cc-panel__header cc-panel__header--compact">
            <Send className="h-3.5 w-3.5 text-primary" aria-hidden />
            <h3 className="cc-panel__title">Claims ready</h3>
          </header>
          <div className="cc-rail-card__body cc-rail-card__body--center">
            <p className="cc-claims-ready-value cc-claims-ready-value--sm tabular-nums">
              <MetricValue value={String(snap.claimsReadyToSend)} />
            </p>
            <p className="cc-claims-ready-label">ready_to_send</p>
            <ul className="cc-claims-mini cc-claims-mini--compact">
                  <li>
                    <span>Draft</span>
                    <span className="tabular-nums font-medium"><MetricValue value={String(data.claimsDraft)} /></span>
                  </li>
                  <li>
                    <span>Submitted</span>
                    <span className="tabular-nums font-medium"><MetricValue value={String(data.claimFunnel.submitted)} /></span>
                  </li>
                  <li>
                    <span>Eligible</span>
                    <span className="tabular-nums font-medium"><MetricValue value={String(data.claimFunnel.eligible)} /></span>
                  </li>
            </ul>
            {snap.claimsReadyToSend > 0 ? (
              <Link href="/claim-engine" className="cc-rail-link">
                Open claim engine <ArrowRight className="h-3 w-3" />
              </Link>
            ) : null}
          </div>
        </div>
      </aside>
    ),
  };

  return (
    <div className="command-center">
      {fetchError && (
        <div className="cc-alert rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span className="font-semibold">Partial data:</span> {fetchError}
        </div>
      )}

      <div className="cc-layout-toolbar">
        <p className="cc-layout-toolbar__hint">
          Drag widgets to swap · use <Maximize2 className="inline h-3 w-3" aria-hidden /> to resize
        </p>
        <button type="button" className="admin-btn-quiet cc-layout-reset text-xs" onClick={onResetLayout}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Reset layout
        </button>
      </div>

      <section aria-label="Executive summary" className="cc-executive-strip">
        {layout.execOrder.map((id) => (
          <DashboardDragSlot
            key={id}
            id={id}
            className={["h-full", execSpanClass(layout.execSpans[id])].join(" ")}
            onSwap={onExecSwap}
            onCycleSize={() => cycleExecSpan(id)}
            sizeMode={layout.execSpans[id] === 2 ? "wide" : "compact"}
          >
            {execWidgets[id]}
          </DashboardDragSlot>
        ))}
      </section>

      <section aria-label="Operational insights" className="cc-insight-row">
        {layout.insightOrder.map((id) => (
          <DashboardDragSlot
            key={id}
            id={id}
            className={["h-full min-w-0", insightSpanClass(layout.insightSpans[id])].join(" ")}
            onSwap={onInsightSwap}
            onCycleSize={() => cycleInsightSpan(id)}
            sizeMode={layout.insightSpans[id] === 2 ? "wide" : "compact"}
          >
            {insightWidgets[id]}
          </DashboardDragSlot>
        ))}
      </section>

      <div className="cc-body-grid">
        {layout.bodyOrder.map((id) => (
          <DashboardDragSlot
            key={id}
            id={id}
            className={[
              id === "queue" ? "cc-body-main min-w-0" : "cc-body-rail min-w-0",
              bodySpanClass(id, layout.bodyQueueSpan),
            ].join(" ")}
            onSwap={onBodySwap}
            onCycleSize={id === "queue" ? cycleBodyQueueSize : undefined}
            sizeMode={layout.bodyQueueSpan >= 8 ? "wide" : "compact"}
          >
            {bodyWidgets[id]}
          </DashboardDragSlot>
        ))}
      </div>
    </div>
  );
}
