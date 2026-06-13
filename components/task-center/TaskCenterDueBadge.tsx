"use client";

import { taskCenterBadgeTone } from "./task-center-ui";

export function TaskCenterDueBadge({
  isOverdue,
  isDueSoon,
  dueAt,
}: {
  isOverdue: boolean;
  isDueSoon: boolean;
  dueAt: string | null;
}) {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (isOverdue) {
    return <span className={taskCenterBadgeTone("blocked")}>Overdue · {label}</span>;
  }
  if (isDueSoon) {
    return <span className={taskCenterBadgeTone("urgent")}>Due soon · {label}</span>;
  }
  return <span className={taskCenterBadgeTone("open")}>Due {label}</span>;
}
