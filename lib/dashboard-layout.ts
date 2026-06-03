export type ExecWidgetId = "today" | "open" | "exceptions" | "claims";
export type InsightWidgetId = "trend" | "scan" | "funnel" | "conditions";
export type BodyWidgetId = "queue" | "rail";

export type GridSpan = 1 | 2;
export type BodySpan = 4 | 6 | 8 | 12;

export const DEFAULT_EXEC_ORDER: ExecWidgetId[] = ["today", "open", "exceptions", "claims"];
export const DEFAULT_INSIGHT_ORDER: InsightWidgetId[] = ["trend", "scan", "funnel", "conditions"];
export const DEFAULT_BODY_ORDER: BodyWidgetId[] = ["queue", "rail"];

export const DEFAULT_EXEC_SPANS: Record<ExecWidgetId, GridSpan> = {
  today: 1,
  open: 1,
  exceptions: 1,
  claims: 1,
};

export const DEFAULT_INSIGHT_SPANS: Record<InsightWidgetId, GridSpan> = {
  trend: 2,
  scan: 1,
  funnel: 2,
  conditions: 1,
};

export const DEFAULT_BODY_QUEUE_SPAN: BodySpan = 8;

const STORAGE_V2 = "cc_dashboard_layout_v2";

export type DashboardLayoutState = {
  execOrder: ExecWidgetId[];
  insightOrder: InsightWidgetId[];
  bodyOrder: BodyWidgetId[];
  execSpans: Record<ExecWidgetId, GridSpan>;
  insightSpans: Record<InsightWidgetId, GridSpan>;
  bodyQueueSpan: BodySpan;
};

export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayoutState = {
  execOrder: [...DEFAULT_EXEC_ORDER],
  insightOrder: [...DEFAULT_INSIGHT_ORDER],
  bodyOrder: [...DEFAULT_BODY_ORDER],
  execSpans: { ...DEFAULT_EXEC_SPANS },
  insightSpans: { ...DEFAULT_INSIGHT_SPANS },
  bodyQueueSpan: DEFAULT_BODY_QUEUE_SPAN,
};

function isExecId(v: string): v is ExecWidgetId {
  return DEFAULT_EXEC_ORDER.includes(v as ExecWidgetId);
}

function isInsightId(v: string): v is InsightWidgetId {
  return DEFAULT_INSIGHT_ORDER.includes(v as InsightWidgetId);
}

function isBodyId(v: string): v is BodyWidgetId {
  return DEFAULT_BODY_ORDER.includes(v as BodyWidgetId);
}

function validOrder<T extends string>(raw: unknown, fallback: T[], guard: (v: string) => v is T): T[] {
  if (!Array.isArray(raw)) return fallback;
  const valid = raw.filter((id): id is T => typeof id === "string" && guard(id));
  return valid.length === fallback.length ? valid : fallback;
}

function loadLegacyOrders(): Partial<DashboardLayoutState> | null {
  if (typeof window === "undefined") return null;
  try {
    const exec = localStorage.getItem("cc_layout_exec_v1");
    const insight = localStorage.getItem("cc_layout_insight_v1");
    const body = localStorage.getItem("cc_layout_body_v1");
    if (!exec && !insight && !body) return null;
    return {
      execOrder: exec ? validOrder(JSON.parse(exec), DEFAULT_EXEC_ORDER, isExecId) : undefined,
      insightOrder: insight ? validOrder(JSON.parse(insight), DEFAULT_INSIGHT_ORDER, isInsightId) : undefined,
      bodyOrder: body ? validOrder(JSON.parse(body), DEFAULT_BODY_ORDER, isBodyId) : undefined,
    };
  } catch {
    return null;
  }
}

export function loadDashboardLayout(): DashboardLayoutState {
  if (typeof window === "undefined") return { ...DEFAULT_DASHBOARD_LAYOUT };

  try {
    const raw = localStorage.getItem(STORAGE_V2);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DashboardLayoutState>;
      return {
        execOrder: validOrder(parsed.execOrder, DEFAULT_EXEC_ORDER, isExecId),
        insightOrder: validOrder(parsed.insightOrder, DEFAULT_INSIGHT_ORDER, isInsightId),
        bodyOrder: validOrder(parsed.bodyOrder, DEFAULT_BODY_ORDER, isBodyId),
        execSpans: { ...DEFAULT_EXEC_SPANS, ...parsed.execSpans },
        insightSpans: { ...DEFAULT_INSIGHT_SPANS, ...parsed.insightSpans },
        bodyQueueSpan: parsed.bodyQueueSpan === 4 || parsed.bodyQueueSpan === 6 || parsed.bodyQueueSpan === 8 || parsed.bodyQueueSpan === 12
          ? parsed.bodyQueueSpan
          : DEFAULT_BODY_QUEUE_SPAN,
      };
    }
  } catch {
    /* fall through */
  }

  const legacy = loadLegacyOrders();
  return {
    ...DEFAULT_DASHBOARD_LAYOUT,
    ...legacy,
  };
}

export function saveDashboardLayout(state: DashboardLayoutState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_V2, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

export function resetDashboardLayout(): DashboardLayoutState {
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(STORAGE_V2);
      localStorage.removeItem("cc_layout_exec_v1");
      localStorage.removeItem("cc_layout_insight_v1");
      localStorage.removeItem("cc_layout_body_v1");
    } catch {
      /* ignore */
    }
  }
  return { ...DEFAULT_DASHBOARD_LAYOUT };
}

export function swapIds<T extends string>(order: T[], sourceId: T, targetId: T): T[] {
  const from = order.indexOf(sourceId);
  const to = order.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function cycleGridSpan(current: GridSpan): GridSpan {
  return current === 1 ? 2 : 1;
}

const BODY_SPAN_CYCLE: BodySpan[] = [8, 12, 6, 4];

export function cycleBodyQueueSpan(current: BodySpan): BodySpan {
  const idx = BODY_SPAN_CYCLE.indexOf(current);
  return BODY_SPAN_CYCLE[(idx + 1) % BODY_SPAN_CYCLE.length] ?? 8;
}

export function pairedBodyRailSpan(queueSpan: BodySpan): BodySpan {
  if (queueSpan === 12) return 12;
  return (12 - queueSpan) as BodySpan;
}

export function execSpanClass(span: GridSpan): string {
  return span === 2 ? "cc-drag-slot--exec-span-2" : "cc-drag-slot--exec-span-1";
}

export function insightSpanClass(span: GridSpan): string {
  return span === 2 ? "cc-drag-slot--insight-span-2" : "cc-drag-slot--insight-span-1";
}

export function bodySpanClass(id: BodyWidgetId, queueSpan: BodySpan): string {
  if (id === "queue") return `cc-drag-slot--body-span-${queueSpan}`;
  return `cc-drag-slot--body-span-${pairedBodyRailSpan(queueSpan)}`;
}
