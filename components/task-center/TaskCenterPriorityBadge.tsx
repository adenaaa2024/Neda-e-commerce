"use client";

import type { TaskCenterPriority } from "@/lib/task-center/task-center-schema-contract";
import { taskCenterBadgeTone } from "./task-center-ui";

const LABEL: Record<TaskCenterPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export function TaskCenterPriorityBadge({ priority }: { priority: TaskCenterPriority }) {
  const tone = priority === "urgent" || priority === "high" ? "urgent" : "open";
  return <span className={taskCenterBadgeTone(tone)}>{LABEL[priority]}</span>;
}
