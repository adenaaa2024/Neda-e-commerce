"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type { TaskCenterTaskDetailResponse } from "@/lib/task-center/task-center-api-contract";

import { useTaskCenter, TaskCenterLoading } from "./TaskCenterRootClient";
import { TaskCenterDueBadge } from "./TaskCenterDueBadge";
import { TaskCenterEmptyState } from "./TaskCenterEmptyState";
import { TaskCenterPhaseNotice } from "./TaskCenterPhaseNotice";
import { TaskCenterPriorityBadge } from "./TaskCenterPriorityBadge";
import { TaskCenterSourceBadge } from "./TaskCenterSourceBadge";
import { TaskCenterStatusBadge } from "./TaskCenterStatusBadge";
import { TaskCenterWriteGateFooter } from "./TaskCenterWriteGateFooter";
import { TASK_CENTER_CARD_CLASS, TASK_CENTER_PAGE_CLASS } from "./task-center-ui";
import { TASK_CENTER_ROUTES } from "@/lib/task-center/task-center-ui-contract";

export function TaskCenterDetailView({ taskId }: { taskId: string }) {
  const { fetchJson, storeId } = useTaskCenter();
  const [detail, setDetail] = useState<TaskCenterTaskDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await fetchJson<TaskCenterTaskDetailResponse>(`/api/task-center/tasks/${taskId}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load task.");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [fetchJson, taskId]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  if (loading) return <TaskCenterLoading />;
  if (error) {
    return (
      <div className={TASK_CENTER_PAGE_CLASS}>
        <p className="text-sm text-red-500">{error}</p>
        <Link href={TASK_CENTER_ROUTES.home} className="text-sm font-semibold underline">
          Back to home
        </Link>
      </div>
    );
  }
  if (!detail) return <TaskCenterEmptyState title="Task not found" />;

  const { task } = detail;
  const snapshot = task.source_snapshot ?? {};

  return (
    <div className={`${TASK_CENTER_PAGE_CLASS} pb-24 lg:pb-8`}>
      <Link href={TASK_CENTER_ROUTES.home} className="text-xs font-semibold opacity-60 hover:opacity-100">
        ← Task Center
      </Link>

      <header className="mt-3 space-y-3">
        <h1 className="text-xl font-bold leading-snug sm:text-2xl">{task.title}</h1>
        <div className="flex flex-wrap gap-2">
          <TaskCenterStatusBadge status={task.status} />
          <TaskCenterPriorityBadge priority={task.priority} />
          <TaskCenterSourceBadge sourceModule={task.source_module} />
          <TaskCenterDueBadge isOverdue={task.is_overdue} isDueSoon={task.is_due_soon} dueAt={task.due_at} />
        </div>
      </header>

      <section className={`${TASK_CENTER_CARD_CLASS} grid gap-3 p-4 sm:grid-cols-2`}>
        <div>
          <p className="text-xs font-bold uppercase opacity-50">Assignee</p>
          <p className="mt-1 text-sm">{task.assigned_user_name ?? task.assigned_group_name ?? "Unassigned"}</p>
        </div>
        <div>
          <p className="text-xs font-bold uppercase opacity-50">Store</p>
          <p className="mt-1 text-sm">{task.store_label ?? "Org-level"}</p>
        </div>
        <div className="sm:col-span-2">
          <p className="text-xs font-bold uppercase opacity-50">Description</p>
          <p className="mt-1 text-sm opacity-80">{task.description ?? "—"}</p>
        </div>
      </section>

      <section className={`${TASK_CENTER_CARD_CLASS} p-4`}>
        <h2 className="text-sm font-bold uppercase opacity-60">Source snapshot</h2>
        {Object.keys(snapshot).length === 0 ? (
          <p className="mt-2 text-sm opacity-60">No snapshot stored yet.</p>
        ) : (
          <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-black/5 p-3 text-xs dark:bg-white/5">
            {JSON.stringify(snapshot, null, 2)}
          </pre>
        )}
        {detail.source_link?.href ? (
          <a href={detail.source_link.href} className="mt-3 inline-block text-sm font-semibold text-teal-700 dark:text-teal-300">
            {detail.source_link.label}
          </a>
        ) : null}
      </section>

      <section className={`${TASK_CENTER_CARD_CLASS} p-4`}>
        <h2 className="text-sm font-bold uppercase opacity-60">Comments</h2>
        {detail.comments.length === 0 ? (
          <p className="mt-2 text-sm opacity-60">No comments · Phase 7B required to add.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {detail.comments.map((c) => (
              <li key={c.id} className="rounded-lg border px-3 py-2 text-sm">
                {c.body}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={`${TASK_CENTER_CARD_CLASS} p-4`}>
        <h2 className="text-sm font-bold uppercase opacity-60">Watchers</h2>
        <p className="mt-2 text-sm opacity-60">
          {detail.watchers.length === 0
            ? "No watchers · Phase 7B required to follow."
            : `${detail.watchers.length} watcher(s)`}
        </p>
      </section>

      <section className={`${TASK_CENTER_CARD_CLASS} p-4`}>
        <h2 className="text-sm font-bold uppercase opacity-60">Activity</h2>
        {detail.activity.length === 0 ? (
          <p className="mt-2 text-sm opacity-60">No activity logged yet.</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {detail.activity.map((a) => (
              <li key={a.id} className="opacity-80">
                {a.event_type} · {new Date(a.created_at).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={`${TASK_CENTER_CARD_CLASS} p-4`}>
        <h2 className="text-sm font-bold uppercase opacity-60">Status timeline</h2>
        <ul className="mt-2 space-y-2">
          {detail.status_timeline.map((s, i) => (
            <li key={`${s.at}-${i}`} className="flex items-center gap-2 text-sm">
              <TaskCenterStatusBadge status={s.status} />
              <span className="opacity-60">{new Date(s.at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </section>

      <TaskCenterWriteGateFooter />
      <TaskCenterPhaseNotice variant="write" />
    </div>
  );
}
