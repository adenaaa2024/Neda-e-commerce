/**
 * Task Center org structure display contract.
 * Reuses public.groups + user_groups — no RBAC editing in Task Center.
 */

import type { TaskCenterGroupRow, TaskCenterGroupType } from "./task-center-schema-contract";

export type TaskCenterOrgTreeNode = TaskCenterGroupRow & {
  children: TaskCenterOrgTreeNode[];
  member_count: number;
  open_task_count: number;
};

export type TaskCenterGroupMemberPreview = {
  profile_id: string;
  full_name: string | null;
  email: string | null;
  role_key: string | null;
};

export type TaskCenterOrgGroupDetail = TaskCenterGroupRow & {
  members: TaskCenterGroupMemberPreview[];
  parent: Pick<TaskCenterGroupRow, "id" | "key" | "name" | "group_type"> | null;
  child_groups: Pick<TaskCenterGroupRow, "id" | "key" | "name" | "group_type">[];
  open_task_count: number;
};

/** Build tree from flat groups list (same org only) */
export function buildTaskCenterOrgTree(groups: TaskCenterGroupRow[]): TaskCenterOrgTreeNode[] {
  const byId = new Map<string, TaskCenterOrgTreeNode>();
  for (const g of groups) {
    byId.set(g.id, { ...g, children: [], member_count: 0, open_task_count: 0 });
  }
  const roots: TaskCenterOrgTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parent_group_id && byId.has(node.parent_group_id)) {
      byId.get(node.parent_group_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortNodes = (nodes: TaskCenterOrgTreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) sortNodes(n.children);
  };
  sortNodes(roots);
  return roots;
}

export const TASK_CENTER_GROUP_TYPE_SORT: TaskCenterGroupType[] = [
  "department",
  "team",
  "queue",
  "access_group",
];

export const TASK_CENTER_ORG_PHASE_NOTICE =
  "Org hierarchy is read-only in Task Center. Manage groups in Platform Access.";

export const TASK_CENTER_PLATFORM_ACCESS_HREF = "/platform/access";
