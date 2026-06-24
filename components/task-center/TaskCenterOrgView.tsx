"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, ExternalLink, Info, Lock, Users } from "lucide-react";

import type {
  TaskCenterGroupsResponse,
  TaskCenterSummaryResponse,
} from "@/lib/task-center/task-center-api-contract";
import {
  TASK_CENTER_ORG_ASSIGNMENT_MODEL,
  TASK_CENTER_ORG_ASSIGNMENT_VISIBILITY_NOTE,
  TASK_CENTER_ORG_GROUP_TYPE_DISPLAY,
  TASK_CENTER_ORG_GROUP_TYPE_TONE,
  TASK_CENTER_ORG_READONLY_NOTICE,
  TASK_CENTER_PLATFORM_ACCESS_HREF,
  sumTaskCenterTreeMembers,
  taskCenterTreeHasHierarchy,
  type TaskCenterOrgTreeNode,
} from "@/lib/task-center/task-center-org-display-contract";

import { useTaskCenter, TaskCenterLoading } from "./TaskCenterRootClient";
import { TaskCenterPhaseNotice } from "./TaskCenterPhaseNotice";
import { TASK_CENTER_CARD_CLASS, TASK_CENTER_PAGE_CLASS, taskCenterBadgeTone } from "./task-center-ui";

function StatPill({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/5 px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide opacity-60">{label}</p>
      <p className="mt-0.5 text-lg font-bold tabular-nums">{value}</p>
    </div>
  );
}

function GroupCard({
  node,
  parentName,
  depth,
}: {
  node: TaskCenterOrgTreeNode;
  parentName: string | null;
  depth: number;
}) {
  const typeLabel = TASK_CENTER_ORG_GROUP_TYPE_DISPLAY[node.group_type] ?? node.group_type;
  const tone = TASK_CENTER_ORG_GROUP_TYPE_TONE[node.group_type] ?? "open";

  return (
    <li className="list-none">
      {/* indent on >=sm only so mobile never overflows horizontally */}
      <div className={depth > 0 ? "sm:pl-4" : ""}>
        <div className={`${TASK_CENTER_CARD_CLASS} p-3 sm:p-4`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={taskCenterBadgeTone(tone)}>{typeLabel}</span>
            <span className="min-w-0 break-words font-semibold">{node.name}</span>
          </div>

          <p className="mt-1 break-all text-xs opacity-60">{node.key}</p>

          {parentName ? (
            <p className="mt-1 text-xs opacity-70">
              Parent: <span className="font-medium">{parentName}</span>
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-80">
            <span className="inline-flex items-center gap-1">
              <Users className="h-3.5 w-3.5 opacity-70" aria-hidden />
              {node.member_count} member{node.member_count === 1 ? "" : "s"}
            </span>
            <span className="tabular-nums">
              {node.open_task_count} open task{node.open_task_count === 1 ? "" : "s"}
            </span>
          </div>

          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug opacity-60">
            <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            {TASK_CENTER_ORG_ASSIGNMENT_VISIBILITY_NOTE}
          </p>
        </div>
      </div>

      {node.children.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {node.children.map((child) => (
            <GroupCard key={child.id} node={child} parentName={node.name} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function TaskCenterOrgView() {
  const { fetchJson, storeId, stores } = useTaskCenter();
  const [data, setData] = useState<TaskCenterGroupsResponse | null>(null);
  const [summary, setSummary] = useState<TaskCenterSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [groups, summaryRes] = await Promise.all([
        fetchJson<TaskCenterGroupsResponse>("/api/task-center/groups"),
        fetchJson<TaskCenterSummaryResponse>("/api/task-center/summary").catch(() => null),
      ]);
      setData(groups);
      setSummary(summaryRes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load org structure.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  const storeName = useMemo(
    () => stores.find((s) => s.store_id === storeId)?.name ?? null,
    [stores, storeId],
  );

  const totals = useMemo(() => {
    if (!data) return { groups: 0, members: 0, openTasks: 0 };
    return {
      groups: data.groups.length,
      members: sumTaskCenterTreeMembers(data.tree),
      openTasks: summary?.counts.open ?? 0,
    };
  }, [data, summary]);

  const hasHierarchy = useMemo(
    () => (data ? taskCenterTreeHasHierarchy(data.tree) : false),
    [data],
  );

  if (loading) return <TaskCenterLoading />;
  if (error) return <p className="text-sm text-red-500">{error}</p>;
  if (!data) return null;

  return (
    <div className={TASK_CENTER_PAGE_CLASS}>
      <header>
        <h1 className="text-xl font-bold tracking-tight">Org Structure</h1>
        <p className="mt-1 text-sm opacity-70">
          Task hierarchy across teams, departments, queues, and access groups.
        </p>
      </header>

      {/* Read-only notice */}
      <div
        className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs leading-snug"
        role="note"
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0 opacity-70" aria-hidden />
        <p className="opacity-85">{TASK_CENTER_ORG_READONLY_NOTICE}</p>
      </div>

      {/* Organization root card */}
      <section className={`${TASK_CENTER_CARD_CLASS} p-4 sm:p-5`}>
        <div className="flex items-center gap-2">
          <Building2 className="h-5 w-5 shrink-0 opacity-70" aria-hidden />
          <div className="min-w-0">
            <p className="truncate text-base font-bold">Organization</p>
            <p className="truncate text-xs opacity-70">
              {storeName ? `Store: ${storeName}` : "All stores in scope"}
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatPill label="Groups" value={totals.groups} />
          <StatPill label="Members" value={totals.members} />
          <StatPill label="Open tasks" value={totals.openTasks} />
        </div>
      </section>

      {/* Hierarchy / flat list */}
      <section>
        <h2 className="mb-2 text-sm font-semibold opacity-80">
          {hasHierarchy ? "Task hierarchy" : "Top-level groups"}
        </h2>
        {data.tree.length === 0 ? (
          <p className="text-sm opacity-70">No groups in this organization yet.</p>
        ) : (
          <ul className="space-y-2">
            {data.tree.map((node) => (
              <GroupCard key={node.id} node={node} parentName={null} depth={0} />
            ))}
          </ul>
        )}
      </section>

      {/* Task assignment model explainer */}
      <section className={`${TASK_CENTER_CARD_CLASS} p-4 sm:p-5`}>
        <h2 className="text-sm font-semibold">Task assignment model</h2>
        <ul className="mt-3 space-y-2.5">
          {TASK_CENTER_ORG_ASSIGNMENT_MODEL.map((row) => (
            <li key={row.role} className="text-xs leading-snug">
              <span className="font-semibold">{row.role}</span>
              <span className="opacity-75"> — {row.detail}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-snug opacity-60">
          <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          Write actions (assigning, editing, and managing tasks) are disabled until Phase 7B.
        </p>
      </section>

      <TaskCenterPhaseNotice variant="write" />

      {/* CTA to Platform Access */}
      <a
        href={TASK_CENTER_PLATFORM_ACCESS_HREF}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition hover:shadow-md"
      >
        <ExternalLink className="h-4 w-4" aria-hidden />
        Manage groups in Platform Access
      </a>
    </div>
  );
}
