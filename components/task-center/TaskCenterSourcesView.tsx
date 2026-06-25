"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import type { TaskCenterSourceSummaryResponse, TaskCenterTaskListItem } from "@/lib/task-center/task-center-api-contract";
import { TASK_CENTER_SOURCE_MODULE_LABELS, type TaskCenterSourceModule } from "@/lib/task-center/task-center-schema-contract";
import { TASK_CENTER_SCANNER_UI_SOURCE_KINDS, TASK_CENTER_SCANNER_PHASE_NOTICE } from "@/lib/task-center/task-center-scanner-source-display-contract";
import { TASK_CENTER_ROUTES } from "@/lib/task-center/task-center-ui-contract";

import { useTaskCenter, TaskCenterLoading } from "./TaskCenterRootClient";
import { TaskCenterEmptyState } from "./TaskCenterEmptyState";
import { TaskCenterPhaseNotice } from "./TaskCenterPhaseNotice";
import { TaskCenterTaskList } from "./TaskCenterTaskList";
import { TASK_CENTER_CARD_CLASS, TASK_CENTER_PAGE_CLASS } from "./task-center-ui";

const SOURCE_LINKS: { module: TaskCenterSourceModule; slug: string }[] = [
  { module: "scanner", slug: "scanner" },
  { module: "claims", slug: "claims" },
  { module: "product", slug: "product" },
  { module: "automation", slug: "automation" },
  { module: "warehouse", slug: "warehouse" },
  { module: "platform", slug: "admin" },
];

export function TaskCenterSourcesView() {
  const { fetchJson, storeId } = useTaskCenter();
  const searchParams = useSearchParams();
  const moduleParam = searchParams.get("module") as TaskCenterSourceModule | null;
  const [summary, setSummary] = useState<TaskCenterSourceSummaryResponse | null>(null);
  const [tasks, setTasks] = useState<TaskCenterTaskListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sum = await fetchJson<TaskCenterSourceSummaryResponse>("/api/task-center/source-summary");
      setSummary(sum);
      if (moduleParam) {
        const list = await fetchJson<{ items: TaskCenterTaskListItem[] }>("/api/task-center/tasks", {
          source_module: moduleParam,
          limit: "50",
        });
        setTasks(list.items ?? []);
      } else {
        setTasks([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sources.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson, moduleParam]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  if (loading) return <TaskCenterLoading />;
  if (error) return <p className="text-sm text-red-500">{error}</p>;

  return (
    <div className={TASK_CENTER_PAGE_CLASS}>
      <header>
        <h1 className="text-xl font-bold tracking-tight">Source Modules</h1>
        <p className="mt-1 text-sm opacity-70">Tasks grouped by the module or workflow that created them.</p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SOURCE_LINKS.map(({ module, slug }) => {
          const row = summary?.rows.find((r) => r.source_module === module);
          const active = moduleParam === module;
          return (
            <Link
              key={module}
              href={`${TASK_CENTER_ROUTES.sources}?module=${module}`}
              className={`${TASK_CENTER_CARD_CLASS} p-4 hover:shadow-md ${active ? "ring-2 ring-teal-500/40" : ""}`}
            >
              <p className="text-xs font-bold uppercase opacity-60">{slug}</p>
              <p className="mt-1 font-semibold">{TASK_CENTER_SOURCE_MODULE_LABELS[module]}</p>
              <p className="mt-2 text-2xl font-bold tabular-nums">{row?.open_count ?? 0}</p>
              <p className="text-xs opacity-60">open tasks</p>
            </Link>
          );
        })}
      </div>

      {moduleParam === "scanner" ? (
        <section className={`${TASK_CENTER_CARD_CLASS} space-y-3 p-4`}>
          <h2 className="text-sm font-bold uppercase opacity-60">Scanner source types (future)</h2>
          <p className="text-sm opacity-75">{TASK_CENTER_SCANNER_PHASE_NOTICE}</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {TASK_CENTER_SCANNER_UI_SOURCE_KINDS.map((k) => (
              <li key={k.id} className="rounded-lg border border-dashed px-3 py-2 text-sm opacity-80">
                {k.title}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {moduleParam ? (
        <section className="space-y-3">
          <h2 className="text-sm font-bold uppercase opacity-60">
            {TASK_CENTER_SOURCE_MODULE_LABELS[moduleParam]} tasks
          </h2>
          {tasks.length === 0 ? <TaskCenterEmptyState /> : <TaskCenterTaskList tasks={tasks} view="cards" />}
        </section>
      ) : null}

      <TaskCenterPhaseNotice variant="scanner" />
    </div>
  );
}
