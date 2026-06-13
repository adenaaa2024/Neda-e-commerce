"use client";

import {
  TASK_CENTER_SOURCE_MODULE_LABELS,
  type TaskCenterSourceModule,
} from "@/lib/task-center/task-center-schema-contract";
import { taskCenterBadgeTone } from "./task-center-ui";

const TONE: Partial<Record<TaskCenterSourceModule, string>> = {
  scanner: "scanner",
  claims: "claims",
  product: "product",
  automation: "automation",
};

export function TaskCenterSourceBadge({
  sourceModule,
}: {
  sourceModule: TaskCenterSourceModule | null;
}) {
  if (!sourceModule) {
    return <span className={taskCenterBadgeTone("open")}>General</span>;
  }
  const tone = TONE[sourceModule] ?? "open";
  return (
    <span className={taskCenterBadgeTone(tone)}>
      {TASK_CENTER_SOURCE_MODULE_LABELS[sourceModule]}
    </span>
  );
}
