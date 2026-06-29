/**
 * Task Center people org chart display contract (read-only Phase 1D).
 * Consumes profile_position_assignments current rows — no writes in Task Center.
 */

import type { PeopleAssignmentJoinedRow } from "@/lib/people-org-chart/people-assignment-read-helpers";

export type TaskCenterOrgPeopleCurrentRow = {
  profile_id: string;
  full_name: string | null;
  email: string | null;
  assignment_id: string;
  position_id: string;
  position_code: string;
  position_title: string;
  group_id: string | null;
  group_name: string | null;
  group_type: string | null;
  manager_profile_id: string | null;
  manager_full_name: string | null;
  manager_email: string | null;
  starts_at: string;
};

export type TaskCenterOrgPeopleTreeNode = TaskCenterOrgPeopleCurrentRow & {
  children: TaskCenterOrgPeopleTreeNode[];
};

export type TaskCenterOrgPeopleHistoryRow = {
  id: string;
  position_code: string;
  position_title: string;
  group_name: string | null;
  group_type: string | null;
  manager_full_name: string | null;
  manager_email: string | null;
  starts_at: string;
  ends_at: string | null;
  notes: string | null;
  assigned_by_full_name: string | null;
  assigned_by_email: string | null;
};

function comparePeopleNodes(a: TaskCenterOrgPeopleCurrentRow, b: TaskCenterOrgPeopleCurrentRow): number {
  const nameA = (a.full_name ?? "").trim().toLowerCase();
  const nameB = (b.full_name ?? "").trim().toLowerCase();
  if (nameA !== nameB) return nameA.localeCompare(nameB);

  const titleA = (a.position_title || a.position_code || "").trim().toLowerCase();
  const titleB = (b.position_title || b.position_code || "").trim().toLowerCase();
  if (titleA !== titleB) return titleA.localeCompare(titleB);

  return (a.position_code ?? "")
    .trim()
    .toLowerCase()
    .localeCompare((b.position_code ?? "").trim().toLowerCase());
}

/** Build manager hierarchy from current assignment rows (same org only). */
export function buildTaskCenterPeopleOrgTree(
  people: TaskCenterOrgPeopleCurrentRow[],
): TaskCenterOrgPeopleTreeNode[] {
  const currentProfileIds = new Set(people.map((p) => p.profile_id));
  const byProfileId = new Map<string, TaskCenterOrgPeopleTreeNode>();

  for (const person of people) {
    byProfileId.set(person.profile_id, { ...person, children: [] });
  }

  const roots: TaskCenterOrgPeopleTreeNode[] = [];
  for (const node of byProfileId.values()) {
    const managerId = node.manager_profile_id;
    if (managerId && currentProfileIds.has(managerId) && byProfileId.has(managerId)) {
      byProfileId.get(managerId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortNodes = (nodes: TaskCenterOrgPeopleTreeNode[]) => {
    nodes.sort(comparePeopleNodes);
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);

  return roots;
}

export const TASK_CENTER_ORG_PEOPLE_EMPTY_TITLE = "No people assignments yet";
export const TASK_CENTER_ORG_PEOPLE_EMPTY_DESCRIPTION =
  "Assign people in System Settings → People assignments.";
export const TASK_CENTER_ORG_PEOPLE_SETTINGS_HREF = "/settings/people";

export function formatTaskCenterOrgPeopleDisplayName(
  fullName: string | null,
  email: string | null,
): string {
  const name = (fullName ?? "").trim();
  if (name) return name;
  const em = (email ?? "").trim();
  return em || "Unknown person";
}

export function formatTaskCenterOrgPeopleManagerLabel(
  fullName: string | null,
  email: string | null,
): string {
  const name = (fullName ?? "").trim();
  if (name) return name;
  const em = (email ?? "").trim();
  return em || "—";
}

export function formatTaskCenterOrgPeoplePositionLabel(title: string, code: string): string {
  const t = (title ?? "").trim();
  const c = (code ?? "").trim();
  if (t && c && t.toLowerCase() !== c.toLowerCase()) return `${t} (${c})`;
  return t || c || "—";
}

export function formatTaskCenterOrgPeopleGroupLabel(
  name: string | null,
  type: string | null,
): string | null {
  const n = (name ?? "").trim();
  if (!n) return null;
  const t = (type ?? "").trim();
  if (t) return `${n} · ${t.replace(/_/g, " ")}`;
  return n;
}

export function formatTaskCenterOrgPeopleDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function toTaskCenterOrgPeopleHistoryRow(
  joined: PeopleAssignmentJoinedRow,
): TaskCenterOrgPeopleHistoryRow {
  return {
    id: joined.id,
    position_code: joined.position_code,
    position_title: joined.position_title,
    group_name: joined.group_name,
    group_type: joined.group_type,
    manager_full_name: joined.manager_full_name,
    manager_email: joined.manager_email,
    starts_at: joined.starts_at,
    ends_at: joined.ends_at,
    notes: joined.notes,
    assigned_by_full_name: joined.assigned_by_full_name,
    assigned_by_email: joined.assigned_by_email,
  };
}
