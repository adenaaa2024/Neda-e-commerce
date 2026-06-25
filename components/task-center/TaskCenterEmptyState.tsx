"use client";

import { Inbox } from "lucide-react";

import { TASK_CENTER_CARD_CLASS, TASK_CENTER_MUTED } from "./task-center-ui";
import { TaskCenterPhaseNotice } from "./TaskCenterPhaseNotice";

export function TaskCenterEmptyState({
  title = "No tasks yet",
  description = "No tasks yet — task write phase is not enabled.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="task-center-empty-state space-y-4 py-6">
      <div className={`${TASK_CENTER_CARD_CLASS} mx-auto max-w-lg p-6 text-center`}>
        <Inbox className={`mx-auto mb-3 h-8 w-8 ${TASK_CENTER_MUTED}`} aria-hidden />
        <h3 className="text-base font-semibold">{title}</h3>
        <p className={`mt-2 text-sm task-center-text-secondary`}>{description}</p>
      </div>
      <TaskCenterPhaseNotice compact variant="empty" />
    </div>
  );
}
