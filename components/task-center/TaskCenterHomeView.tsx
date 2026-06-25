"use client";

import { useCallback, useEffect, useState } from "react";

import type { TaskCenterSummaryResponse } from "@/lib/task-center/task-center-api-contract";
import { TASK_CENTER_ROUTES } from "@/lib/task-center/task-center-ui-contract";

import { useTaskCenter, TaskCenterLoading } from "./TaskCenterRootClient";
import { TaskCenterEmptyState } from "./TaskCenterEmptyState";
import { TaskCenterKpiTile, TaskCenterSourceSummaryTiles, TASK_CENTER_KPI_GRID } from "./TaskCenterKpiTile";
import { TaskCenterPhaseNotice } from "./TaskCenterPhaseNotice";
import { TaskCenterTaskList } from "./TaskCenterTaskList";
import type { TaskCenterTaskListItem } from "@/lib/task-center/task-center-api-contract";
import { TASK_CENTER_PAGE_CLASS } from "./task-center-ui";

export function TaskCenterHomeView() {
  const { fetchJson, userId, storeId } = useTaskCenter();
  const [summary, setSummary] = useState<TaskCenterSummaryResponse | null>(null);
  const [myTasks, setMyTasks] = useState<TaskCenterTaskListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sum, tasks] = await Promise.all([
        fetchJson<TaskCenterSummaryResponse>("/api/task-center/summary"),
        userId
          ? fetchJson<{ items: TaskCenterTaskListItem[] }>("/api/task-center/tasks", {
              assigned_user_id: userId,
              limit: "5",
            })
          : Promise.resolve({ items: [] }),
      ]);
      setSummary(sum);
      setMyTasks(tasks.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Task Center.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson, userId]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  if (loading) return <TaskCenterLoading />;
  if (error) return <p className="text-sm text-red-500">{error}</p>;
  if (!summary) return null;

  const c = summary.counts;
  const sourceRows = [
    { label: "Scanner", open_count: c.by_source_module.scanner ?? 0, href: `${TASK_CENTER_ROUTES.sources}?module=scanner` },
    { label: "Claims", open_count: c.by_source_module.claims ?? 0, href: `${TASK_CENTER_ROUTES.sources}?module=claims` },
    { label: "Product", open_count: c.by_source_module.product ?? 0, href: `${TASK_CENTER_ROUTES.sources}?module=product` },
    { label: "Automation", open_count: c.by_source_module.automation ?? 0, href: `${TASK_CENTER_ROUTES.sources}?module=automation` },
  ];

  return (
    <div className={TASK_CENTER_PAGE_CLASS}>
      <header>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Home</h1>
        <p className="mt-1 text-sm opacity-70">
          Overview of your task workload across personal, team, source, and claim queues.
        </p>
      </header>

      <div className={TASK_CENTER_KPI_GRID}>
        <TaskCenterKpiTile label="My open" count={c.assigned_to_me} href={TASK_CENTER_ROUTES.my} />
        <TaskCenterKpiTile label="Team queue" count={c.assigned_to_my_groups} href={TASK_CENTER_ROUTES.queues} />
        <TaskCenterKpiTile label="Overdue" count={c.overdue} href={`${TASK_CENTER_ROUTES.my}?overdue=1`} tone="danger" />
        <TaskCenterKpiTile label="Blocked" count={c.blocked} href={`${TASK_CENTER_ROUTES.my}?blocked=1`} tone="warn" />
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wide opacity-60">Source modules</h2>
        <TaskCenterSourceSummaryTiles rows={sourceRows} />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold uppercase tracking-wide opacity-60">My open tasks</h2>
          <a href={TASK_CENTER_ROUTES.my} className="text-xs font-semibold text-teal-700 dark:text-teal-300">
            View all
          </a>
        </div>
        {myTasks.length === 0 ? (
          <TaskCenterEmptyState />
        ) : (
          <TaskCenterTaskList tasks={myTasks} view="cards" />
        )}
      </section>

      <TaskCenterPhaseNotice variant="write" />
    </div>
  );
}
