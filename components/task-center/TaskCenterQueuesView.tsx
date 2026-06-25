"use client";

import { useCallback, useEffect, useState } from "react";

import type { TaskCenterGroupsResponse } from "@/lib/task-center/task-center-api-contract";
import { TASK_CENTER_GROUP_TYPE_LABELS } from "@/lib/task-center/task-center-schema-contract";
import { TASK_CENTER_PLATFORM_ACCESS_HREF } from "@/lib/task-center/task-center-org-display-contract";

import { useTaskCenter, TaskCenterLoading } from "./TaskCenterRootClient";
import { TaskCenterEmptyState } from "./TaskCenterEmptyState";
import { TaskCenterPhaseNotice } from "./TaskCenterPhaseNotice";
import { TASK_CENTER_CARD_CLASS, TASK_CENTER_PAGE_CLASS, TASK_CENTER_SUBTITLE, TASK_CENTER_TYPE_BADGE, TASK_CENTER_MUTED, TASK_CENTER_LINK, TASK_CENTER_SELECT_LG } from "./task-center-ui";

export function TaskCenterQueuesView() {
  const { fetchJson, storeId } = useTaskCenter();
  const [data, setData] = useState<TaskCenterGroupsResponse | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchJson<TaskCenterGroupsResponse>("/api/task-center/groups");
      setData(res);
      if (!selectedGroupId && res.groups[0]) setSelectedGroupId(res.groups[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load groups.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  if (loading) return <TaskCenterLoading />;
  if (error) return <p className="text-sm text-red-500">{error}</p>;
  if (!data) return null;

  const selected = data.groups.find((g) => g.id === selectedGroupId) ?? data.groups[0];
  const queueGroups = data.groups.filter((g) => g.group_type === "queue" || g.group_type === "team");

  return (
    <div className={TASK_CENTER_PAGE_CLASS}>
      <header>
        <h1 className="text-xl font-bold tracking-tight">Team Queues</h1>
        <p className={TASK_CENTER_SUBTITLE}>Tasks grouped by team or access group.</p>
      </header>

      <div className="flex flex-wrap gap-2">
        <select
          className={TASK_CENTER_SELECT_LG}
          value={selected?.id ?? ""}
          onChange={(e) => setSelectedGroupId(e.target.value)}
        >
          {data.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({TASK_CENTER_GROUP_TYPE_LABELS[g.group_type]})
            </option>
          ))}
        </select>
      </div>

      {queueGroups.length === 0 && data.groups.length === 0 ? (
        <TaskCenterEmptyState title="No groups configured" description="Configure groups in Platform Access." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(queueGroups.length ? queueGroups : data.groups).map((g) => {
            const treeNode = data.tree.flatMap(function flatten(n): typeof data.tree {
              return [n, ...n.children.flatMap(flatten)];
            }).find((n) => n.id === g.id);
            return (
              <div key={g.id} className={`${TASK_CENTER_CARD_CLASS} p-4`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={TASK_CENTER_TYPE_BADGE}>
                    {TASK_CENTER_GROUP_TYPE_LABELS[g.group_type]}
                  </span>
                </div>
                <p className="mt-2 font-semibold">{g.name}</p>
                <p className={`mt-1 text-xs ${TASK_CENTER_MUTED}`}>{g.key}</p>
                <p className="mt-3 text-sm tabular-nums">
                  <span className="font-bold">{treeNode?.open_task_count ?? 0}</span> open tasks
                </p>
                <p className={`text-xs ${TASK_CENTER_MUTED}`}>{treeNode?.member_count ?? 0} members</p>
              </div>
            );
          })}
        </div>
      )}

      <TaskCenterPhaseNotice variant="write" />
      <p className={`text-xs ${TASK_CENTER_MUTED}`}>
        Manage groups in{" "}
        <a href={TASK_CENTER_PLATFORM_ACCESS_HREF} className={TASK_CENTER_LINK}>
          Platform Access
        </a>
        .
      </p>
    </div>
  );
}
