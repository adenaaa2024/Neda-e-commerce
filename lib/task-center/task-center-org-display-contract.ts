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

/** Page-level read-only banner copy for the Org Structure preview. */
export const TASK_CENTER_ORG_READONLY_NOTICE =
  "Read-only organization structure preview. Manage teams, groups, and members in Platform Access.";

/** Org-view display labels (title-cased per spec, distinct from the schema labels). */
export const TASK_CENTER_ORG_GROUP_TYPE_DISPLAY: Record<TaskCenterGroupType, string> = {
  team: "Team",
  access_group: "Access Group",
  department: "Department",
  queue: "Queue",
};

/** Badge tone per group type (maps to existing task-center-badge--* classes). */
export const TASK_CENTER_ORG_GROUP_TYPE_TONE: Record<TaskCenterGroupType, string> = {
  team: "product",
  department: "scanner",
  queue: "automation",
  access_group: "open",
};

/** Static explainer for who can see/work which tasks (write actions deferred to Phase 7B). */
export const TASK_CENTER_ORG_ASSIGNMENT_MODEL: { role: string; detail: string }[] = [
  {
    role: "Admin / Super Admin",
    detail: "Can view and manage tasks organization-wide across every group and store.",
  },
  {
    role: "Manager / Employee",
    detail: "Can work within the groups they are permitted to access.",
  },
  {
    role: "Operator",
    detail: "Sees only tasks assigned to themselves or their own team / group.",
  },
];

/** Per-card note describing how assigned tasks become visible. */
export const TASK_CENTER_ORG_ASSIGNMENT_VISIBILITY_NOTE =
  "Tasks assigned to this group are visible to its members.";

/** Sum member counts across the whole tree (preview total — counts memberships). */
export function sumTaskCenterTreeMembers(nodes: TaskCenterOrgTreeNode[]): number {
  return nodes.reduce(
    (acc, node) => acc + (node.member_count ?? 0) + sumTaskCenterTreeMembers(node.children),
    0,
  );
}

/** True when at least one group declares a resolvable parent (real hierarchy exists). */
export function taskCenterTreeHasHierarchy(nodes: TaskCenterOrgTreeNode[]): boolean {
  return nodes.some((node) => node.children.length > 0);
}

export const TASK_CENTER_PLATFORM_ACCESS_HREF = "/platform/access";
