"use client";

import { useCallback, useEffect, useState } from "react";

import type { TaskCenterGroupsResponse } from "@/lib/task-center/task-center-api-contract";
import { TASK_CENTER_GROUP_TYPE_LABELS } from "@/lib/task-center/task-center-schema-contract";
import { TASK_CENTER_ORG_PHASE_NOTICE, TASK_CENTER_PLATFORM_ACCESS_HREF } from "@/lib/task-center/task-center-org-display-contract";

import { useTaskCenter, TaskCenterLoading } from "./TaskCenterRootClient";
import { TaskCenterPhaseNotice } from "./TaskCenterPhaseNotice";
import { TASK_CENTER_CARD_CLASS, TASK_CENTER_PAGE_CLASS } from "./task-center-ui";
import type { TaskCenterOrgTreeNode } from "@/lib/task-center/task-center-org-display-contract";

function OrgTreeNode({ node, depth = 0 }: { node: TaskCenterOrgTreeNode; depth?: number }) {
  return (
    <li className="task-center-tree-node ml-0 list-none pl-3" style={{ marginLeft: depth * 12 }}>
      <div className={`${TASK_CENTER_CARD_CLASS} mb-2 p-3`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-slate-500/10 px-2 py-0.5 text-[11px] font-semibold">
            {TASK_CENTER_GROUP_TYPE_LABELS[node.group_type]}
          </span>
          <span className="font-semibold">{node.name}</span>
        </div>
        <p className="mt-1 text-xs opacity-60">{node.key}</p>
        <p className="mt-2 text-xs opacity-70">
          {node.member_count} users · {node.open_task_count} open tasks
        </p>
      </div>
      {node.children.length > 0 ? (
        <ul className="space-y-1">
          {node.children.map((child) => (
            <OrgTreeNode key={child.id} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function TaskCenterOrgView() {
  const { fetchJson, storeId } = useTaskCenter();
  const [data, setData] = useState<TaskCenterGroupsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchJson<TaskCenterGroupsResponse>("/api/task-center/groups"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load org structure.");
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

  return (
    <div className={TASK_CENTER_PAGE_CLASS}>
      <header>
        <h1 className="text-xl font-bold tracking-tight">Org Structure</h1>
        <p className="mt-1 text-sm opacity-70">{TASK_CENTER_ORG_PHASE_NOTICE}</p>
      </header>

      {data.tree.length === 0 ? (
        <p className="text-sm opacity-70">No groups in this organization yet.</p>
      ) : (
        <ul className="space-y-2">
          {data.tree.map((node) => (
            <OrgTreeNode key={node.id} node={node} />
          ))}
        </ul>
      )}

      <TaskCenterPhaseNotice variant="write" />
      <a href={TASK_CENTER_PLATFORM_ACCESS_HREF} className="inline-block text-sm font-semibold underline">
        Open Platform Access
      </a>
    </div>
  );
}
