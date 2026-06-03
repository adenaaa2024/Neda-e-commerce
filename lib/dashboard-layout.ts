export type ExecWidgetId = "today" | "open" | "exceptions" | "claims";
export type InsightWidgetId = "trend" | "scan" | "funnel" | "conditions";
export type BodyWidgetId = "queue" | "rail";

export const DEFAULT_EXEC_ORDER: ExecWidgetId[] = ["today", "open", "exceptions", "claims"];
export const DEFAULT_INSIGHT_ORDER: InsightWidgetId[] = ["trend", "scan", "funnel", "conditions"];
export const DEFAULT_BODY_ORDER: BodyWidgetId[] = ["queue", "rail"];

const KEYS = {
  exec: "cc_layout_exec_v1",
  insight: "cc_layout_insight_v1",
  body: "cc_layout_body_v1",
} as const;

function validOrder<T extends string>(raw: unknown, fallback: T[], allowed: readonly T[]): T[] {
  if (!Array.isArray(raw)) return fallback;
  const valid = raw.filter((id): id is T => typeof id === "string" && allowed.includes(id as T));
  return valid.length === fallback.length ? valid : fallback;
}

function loadOrder<T extends string>(key: string, fallback: T[], allowed: readonly T[]): T[] {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return validOrder(JSON.parse(raw) as unknown, fallback, allowed);
  } catch {
    return fallback;
  }
}

export function loadExecOrder(): ExecWidgetId[] {
  return loadOrder(KEYS.exec, DEFAULT_EXEC_ORDER, DEFAULT_EXEC_ORDER);
}

export function loadInsightOrder(): InsightWidgetId[] {
  return loadOrder(KEYS.insight, DEFAULT_INSIGHT_ORDER, DEFAULT_INSIGHT_ORDER);
}

export function loadBodyOrder(): BodyWidgetId[] {
  return loadOrder(KEYS.body, DEFAULT_BODY_ORDER, DEFAULT_BODY_ORDER);
}

export function saveExecOrder(order: ExecWidgetId[]): void {
  try { localStorage.setItem(KEYS.exec, JSON.stringify(order)); } catch { /* ignore */ }
}

export function saveInsightOrder(order: InsightWidgetId[]): void {
  try { localStorage.setItem(KEYS.insight, JSON.stringify(order)); } catch { /* ignore */ }
}

export function saveBodyOrder(order: BodyWidgetId[]): void {
  try { localStorage.setItem(KEYS.body, JSON.stringify(order)); } catch { /* ignore */ }
}

export function swapIds<T extends string>(order: T[], sourceId: T, targetId: T): T[] {
  const from = order.indexOf(sourceId);
  const to = order.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
