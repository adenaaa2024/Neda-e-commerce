"use client";

import { TASK_CENTER_DEFERRED_WRITE_ACTIONS } from "@/lib/task-center/task-center-api-contract";
import { TaskCenterPhaseNotice } from "./TaskCenterPhaseNotice";
import { TASK_CENTER_DISABLED_BTN } from "./task-center-ui";

const ACTION_LABELS: Record<(typeof TASK_CENTER_DEFERRED_WRITE_ACTIONS)[number], string> = {
  create_task: "Create task",
  assign_task: "Assign",
  assign_group: "Assign group",
  update_status: "Update status",
  update_priority: "Change priority",
  set_due_date: "Set due date",
  add_comment: "Comment",
  add_watcher: "Watch",
  remove_watcher: "Unwatch",
  complete_task: "Complete",
  cancel_task: "Cancel",
  archive_task: "Archive",
};

export function TaskCenterWriteGateFooter({ compact = false }: { compact?: boolean }) {
  return (
    <div className="space-y-3 border-t border-black/5 pt-4 dark:border-white/10">
      <TaskCenterPhaseNotice compact={compact} variant="write" />
      <div className={`flex flex-wrap gap-2 ${compact ? "" : "pb-2"}`}>
        {(["assign_task", "add_comment", "complete_task"] as const).map((id) => (
          <button key={id} type="button" disabled className={TASK_CENTER_DISABLED_BTN}>
            {ACTION_LABELS[id]} · Phase 7B required
          </button>
        ))}
      </div>
    </div>
  );
}
