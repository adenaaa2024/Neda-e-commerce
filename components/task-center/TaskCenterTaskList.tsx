"use client";

import Link from "next/link";

import type { TaskCenterTaskListItem } from "@/lib/task-center/task-center-api-contract";
import { TASK_CENTER_ROUTES } from "@/lib/task-center/task-center-ui-contract";

import { TaskCenterDueBadge } from "./TaskCenterDueBadge";
import { TaskCenterPriorityBadge } from "./TaskCenterPriorityBadge";
import { TaskCenterSourceBadge } from "./TaskCenterSourceBadge";
import { TaskCenterStatusBadge } from "./TaskCenterStatusBadge";
import { TASK_CENTER_CARD_CLASS, TASK_CENTER_MUTED } from "./task-center-ui";

export function TaskCenterTaskCard({ task }: { task: TaskCenterTaskListItem }) {
  return (
    <Link
      href={TASK_CENTER_ROUTES.detail(task.id)}
      className={`${TASK_CENTER_CARD_CLASS} task-center-mobile-card block p-4 hover:shadow-md`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <TaskCenterPriorityBadge priority={task.priority} />
        <TaskCenterStatusBadge status={task.status} />
        <TaskCenterSourceBadge sourceModule={task.source_module} />
        <TaskCenterDueBadge
          isOverdue={task.is_overdue}
          isDueSoon={task.is_due_soon}
          dueAt={task.due_at}
        />
      </div>
      <p className="mt-2 font-semibold leading-snug">{task.title}</p>
      <p className={`mt-1 text-xs ${TASK_CENTER_MUTED}`}>
        {task.assigned_user_name ?? task.assigned_group_name ?? "Unassigned"}
        {task.store_label ? ` · ${task.store_label}` : ""}
      </p>
    </Link>
  );
}

export function TaskCenterTaskTable({ tasks }: { tasks: TaskCenterTaskListItem[] }) {
  return (
    <div className={`${TASK_CENTER_CARD_CLASS} task-center-table hidden overflow-x-auto md:block`}>
      <table className="w-full text-left text-sm">
        <thead className="border-b text-xs uppercase">
          <tr>
            <th className="px-4 py-3">Task</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Priority</th>
            <th className="px-4 py-3">Source</th>
            <th className="px-4 py-3">Assignee</th>
            <th className="px-4 py-3">Due</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id} className="border-b last:border-0">
              <td className="px-4 py-3">
                <Link href={TASK_CENTER_ROUTES.detail(task.id)} className="font-medium hover:underline">
                  {task.title}
                </Link>
              </td>
              <td className="px-4 py-3">
                <TaskCenterStatusBadge status={task.status} />
              </td>
              <td className="px-4 py-3">
                <TaskCenterPriorityBadge priority={task.priority} />
              </td>
              <td className="px-4 py-3">
                <TaskCenterSourceBadge sourceModule={task.source_module} />
              </td>
              <td className={`px-4 py-3 text-xs task-center-text-secondary`}>
                {task.assigned_user_name ?? task.assigned_group_name ?? "—"}
              </td>
              <td className="px-4 py-3">
                <TaskCenterDueBadge
                  isOverdue={task.is_overdue}
                  isDueSoon={task.is_due_soon}
                  dueAt={task.due_at}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TaskCenterTaskList({
  tasks,
  view,
}: {
  tasks: TaskCenterTaskListItem[];
  view: "cards" | "table";
}) {
  if (tasks.length === 0) return null;
  return (
    <div className="space-y-3">
      {view === "table" ? <TaskCenterTaskTable tasks={tasks} /> : null}
      <div className={view === "table" ? "space-y-3 md:hidden" : "space-y-3"}>
        {tasks.map((task) => (
          <TaskCenterTaskCard key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}
