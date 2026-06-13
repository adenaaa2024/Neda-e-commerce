"use client";

import type { TaskCenterStatus } from "@/lib/task-center/task-center-schema-contract";
import { taskCenterBadgeTone } from "./task-center-ui";

const STATUS_TONE: Record<TaskCenterStatus, string> = {
  open: "open",
  in_progress: "open",
  blocked: "blocked",
  waiting: "open",
  completed: "open",
  canceled: "blocked",
  archived: "open",
};

const STATUS_LABEL: Record<TaskCenterStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  waiting: "Waiting",
  completed: "Completed",
  canceled: "Canceled",
  archived: "Archived",
};

export function TaskCenterStatusBadge({ status }: { status: TaskCenterStatus }) {
  return (
    <span className={taskCenterBadgeTone(STATUS_TONE[status])}>{STATUS_LABEL[status]}</span>
  );
}
