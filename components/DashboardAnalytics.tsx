"use client";

import React, { useMemo } from "react";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { Boxes, Clock, RotateCcw, User } from "lucide-react";
import type { ReturnsAnalyticsPayload } from "../app/returns/returns-action-types";

/** MENORIX gold / bronze / neutral — semantic red/green only at end of rotation. */
const PIE_COLORS = [
  "#b08a3c",
  "#8a681f",
  "#c9a96e",
  "#a67c52",
  "#737b86",
  "#5c6370",
  "#d6b76e",
  "#9a7b4f",
  "#d14343",
  "#2d8f5f",
  "#ece7dc",
  "#323c48",
];

const CHART_PRIMARY = "#b08a3c";
const CHART_PRIMARY_DARK = "#d6b76e";

function fmtConditionLabel(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtProcessingHours(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return "—";
  if (h < 24) return `${h.toFixed(1)} h avg`;
  return `${(h / 24).toFixed(1)} d avg`;
}

export function DashboardAnalytics({ data }: { data: ReturnsAnalyticsPayload | null }) {
  const pieData = useMemo(() => {
    if (!data?.conditionSlices?.length) return [];
    return data.conditionSlices.map((s) => ({
      ...s,
      name: fmtConditionLabel(s.name),
    }));
  }, [data]);

  const barData = data?.carrierBars ?? [];

  if (!data) {
    return (
      <section className="admin-panel-card px-4 py-8 text-center text-sm text-muted-foreground">
        Returns analytics will appear when return data is available.
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-foreground">Returns analytics</h2>
        <p className="text-xs text-muted-foreground">Volume, processing time, reasons, and carriers.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="admin-panel-card p-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <RotateCcw className="h-4 w-4 text-primary" />
            Total returns
          </div>
          <p className="mt-2 text-3xl font-semibold tabular-nums text-foreground">{data.totalReturns}</p>
        </div>
        <div className="admin-panel-card p-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Clock className="h-4 w-4 text-primary" />
            Processing time
          </div>
          <p className="mt-2 text-3xl font-semibold tabular-nums text-foreground">{fmtProcessingHours(data.avgProcessingHours)}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">Created → last update</p>
        </div>
        <div className="admin-panel-card p-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Boxes className="h-4 w-4 text-primary" />
            Total pallets
          </div>
          <p className="mt-2 text-3xl font-semibold tabular-nums text-foreground">{data.totalPallets}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="admin-panel-card min-h-[280px] p-4">
          <p className="mb-2 text-xs font-semibold text-foreground">Returns by condition</p>
          {pieData.length === 0 ? (
            <p className="py-12 text-center text-xs text-muted-foreground">No condition data yet.</p>
          ) : (
            <div className="h-[260px] w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={48}
                    outerRadius={88}
                    paddingAngle={2}
                  >
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ borderRadius: "12px", border: "1px solid hsl(var(--border))", fontSize: "12px" }}
                  />
                  <Legend wrapperStyle={{ fontSize: "11px" }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="admin-panel-card min-h-[280px] p-4">
          <p className="mb-2 text-xs font-semibold text-foreground">Returns by carrier</p>
          {barData.length === 0 ? (
            <p className="py-12 text-center text-xs text-muted-foreground">Link items to packages with carriers to see this chart.</p>
          ) : (
            <div className="h-[260px] w-full min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={56} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={32} />
                  <Tooltip
                    contentStyle={{ borderRadius: "12px", border: "1px solid hsl(var(--border))", fontSize: "12px" }}
                  />
                  <Bar dataKey="count" fill={CHART_PRIMARY} radius={[6, 6, 0, 0]} name="Returns" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {/* Operator Performance Widget */}
      {(data.operatorStats?.length ?? 0) > 0 && (
        <div className="admin-panel-card p-4">
          <div className="mb-4 flex items-center gap-2">
            <User className="h-4 w-4 text-primary" />
            <p className="text-xs font-semibold text-foreground">Operator Performance</p>
            <span className="ml-auto text-[10px] text-muted-foreground">Items processed per operator</span>
          </div>
          <div className="h-[200px] w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.operatorStats} layout="vertical" margin={{ top: 0, right: 24, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border" />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="operator" tick={{ fontSize: 10 }} width={90} />
                <Tooltip contentStyle={{ borderRadius: "12px", border: "1px solid hsl(var(--border))", fontSize: "12px" }} />
                <Bar dataKey="count" fill={CHART_PRIMARY_DARK} radius={[0, 6, 6, 0]} name="Items" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </section>
  );
}
