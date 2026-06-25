"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import type { TaskCenterTaskListItem } from "@/lib/task-center/task-center-api-contract";
import {
  TASK_CENTER_PRIORITIES,
  TASK_CENTER_ACTIVE_STATUSES,
  TASK_CENTER_SOURCE_MODULES,
} from "@/lib/task-center/task-center-schema-contract";

import { useTaskCenter, TaskCenterLoading } from "./TaskCenterRootClient";
import { TaskCenterEmptyState } from "./TaskCenterEmptyState";
import { TaskCenterTaskList } from "./TaskCenterTaskList";
import { TASK_CENTER_PAGE_CLASS, TASK_CENTER_SUBTITLE, TASK_CENTER_TOGGLE, TASK_CENTER_TOGGLE_ACTIVE, TASK_CENTER_SELECT } from "./task-center-ui";

export function TaskCenterMyTasksView() {
  const { fetchJson, userId, storeId } = useTaskCenter();
  const searchParams = useSearchParams();
  const [view, setView] = useState<"cards" | "table">("cards");
  const [tasks, setTasks] = useState<TaskCenterTaskListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [priorityFilter, setPriorityFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("");

  const queryExtra = useMemo(() => {
    const extra: Record<string, string> = { limit: "100" };
    if (userId) extra.assigned_user_id = userId;
    if (searchParams.get("overdue") === "1") extra.overdue = "1";
    if (searchParams.get("blocked") === "1") extra.blocked = "1";
    if (statusFilter !== "active") extra.status = statusFilter;
    if (priorityFilter) extra.priority = priorityFilter;
    if (sourceFilter) extra.source_module = sourceFilter;
    return extra;
  }, [userId, searchParams, statusFilter, priorityFilter, sourceFilter]);

  const load = useCallback(async () => {
    if (!userId) {
      setTasks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<{ items: TaskCenterTaskListItem[] }>("/api/task-center/tasks", queryExtra);
      setTasks(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tasks.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson, userId, queryExtra]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  return (
    <div className={TASK_CENTER_PAGE_CLASS}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">My Tasks</h1>
          <p className={TASK_CENTER_SUBTITLE}>Tasks assigned directly to you.</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className={view === "cards" ? TASK_CENTER_TOGGLE_ACTIVE : TASK_CENTER_TOGGLE}
            onClick={() => setView("cards")}
          >
            Cards
          </button>
          <button
            type="button"
            className={view === "table" ? TASK_CENTER_TOGGLE_ACTIVE : TASK_CENTER_TOGGLE}
            onClick={() => setView("table")}
          >
            Table
          </button>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        <select
          className={TASK_CENTER_SELECT}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="active">Active statuses</option>
          {TASK_CENTER_ACTIVE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          className={TASK_CENTER_SELECT}
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
        >
          <option value="">All priorities</option>
          {TASK_CENTER_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          className={TASK_CENTER_SELECT}
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
        >
          <option value="">All sources</option>
          {TASK_CENTER_SOURCE_MODULES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {loading ? <TaskCenterLoading /> : null}
      {error ? <p className="text-sm text-red-500">{error}</p> : null}
      {!loading && !error && tasks.length === 0 ? <TaskCenterEmptyState /> : null}
      {!loading && tasks.length > 0 ? <TaskCenterTaskList tasks={tasks} view={view} /> : null}
    </div>
  );
}
