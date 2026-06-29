/**
 * Read-only join helpers for profile_position_assignments display.
 * Shared by Task Center org-people API; settings write actions keep their own copy.
 */

import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

export const PROFILE_POSITION_ASSIGNMENT_READ_SELECT =
  "id, profile_id, position_id, group_id, manager_profile_id, starts_at, ends_at, notes, assigned_by";

export type PeopleAssignmentJoinMaps = {
  positions: Map<string, { code: string; title: string }>;
  groups: Map<string, { name: string; group_type: string }>;
  profiles: Map<string, { full_name: string; email: string | null }>;
};

export type PeopleAssignmentJoinedRow = {
  id: string;
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
  ends_at: string | null;
  notes: string | null;
  assigned_by: string | null;
  assigned_by_full_name: string | null;
  assigned_by_email: string | null;
};

export async function emailByUserIdMap(userIds?: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const { data, error } = await supabaseServer.auth.admin.listUsers({ perPage: 1000 });
    if (error || !data?.users) return map;
    const filter = userIds && userIds.length > 0 ? new Set(userIds.map((x) => x.trim())) : null;
    for (const u of data.users) {
      if (filter && !filter.has(u.id)) continue;
      const e = u.email?.trim();
      if (e) map.set(u.id, e);
    }
  } catch {
    /* non-fatal */
  }
  return map;
}

export async function buildPeopleAssignmentJoinMaps(
  rows: Record<string, unknown>[],
): Promise<PeopleAssignmentJoinMaps> {
  const positionIds = new Set<string>();
  const groupIds = new Set<string>();
  const profileIds = new Set<string>();

  for (const row of rows) {
    const positionId = String(row.position_id ?? "").trim();
    const groupId = row.group_id != null ? String(row.group_id).trim() : "";
    const managerId =
      row.manager_profile_id != null ? String(row.manager_profile_id).trim() : "";
    const assignedBy = row.assigned_by != null ? String(row.assigned_by).trim() : "";
    if (positionId && isUuidString(positionId)) positionIds.add(positionId);
    if (groupId && isUuidString(groupId)) groupIds.add(groupId);
    if (managerId && isUuidString(managerId)) profileIds.add(managerId);
    if (assignedBy && isUuidString(assignedBy)) profileIds.add(assignedBy);
  }

  const positions = new Map<string, { code: string; title: string }>();
  if (positionIds.size > 0) {
    const { data } = await supabaseServer
      .from("positions")
      .select("id, code, title")
      .in("id", [...positionIds]);
    for (const raw of data ?? []) {
      const r = raw as Record<string, unknown>;
      const id = String(r.id ?? "").trim();
      if (!id) continue;
      positions.set(id, {
        code: String(r.code ?? "").trim(),
        title: String(r.title ?? "").trim(),
      });
    }
  }

  const groups = new Map<string, { name: string; group_type: string }>();
  if (groupIds.size > 0) {
    const { data } = await supabaseServer
      .from("groups")
      .select("id, name, group_type")
      .in("id", [...groupIds]);
    for (const raw of data ?? []) {
      const r = raw as Record<string, unknown>;
      const id = String(r.id ?? "").trim();
      if (!id) continue;
      groups.set(id, {
        name: String(r.name ?? "").trim(),
        group_type: String(r.group_type ?? "").trim(),
      });
    }
  }

  const profiles = new Map<string, { full_name: string; email: string | null }>();
  if (profileIds.size > 0) {
    const ids = [...profileIds];
    const [{ data: profileRows }, emails] = await Promise.all([
      supabaseServer.from("profiles").select("id, full_name").in("id", ids),
      emailByUserIdMap(ids),
    ]);
    for (const raw of profileRows ?? []) {
      const r = raw as Record<string, unknown>;
      const id = String(r.id ?? "").trim();
      if (!id) continue;
      profiles.set(id, {
        full_name: String(r.full_name ?? "").trim(),
        email: emails.get(id) ?? null,
      });
    }
  }

  return { positions, groups, profiles };
}

export function mapPeopleAssignmentJoinedRow(
  row: Record<string, unknown>,
  joins: PeopleAssignmentJoinMaps,
): PeopleAssignmentJoinedRow {
  const positionId = String(row.position_id ?? "").trim();
  const groupId = row.group_id != null ? String(row.group_id).trim() : null;
  const managerId =
    row.manager_profile_id != null ? String(row.manager_profile_id).trim() : null;
  const assignedBy = row.assigned_by != null ? String(row.assigned_by).trim() : null;
  const position = positionId ? joins.positions.get(positionId) : undefined;
  const group = groupId ? joins.groups.get(groupId) : undefined;
  const manager = managerId ? joins.profiles.get(managerId) : undefined;
  const assigner = assignedBy ? joins.profiles.get(assignedBy) : undefined;

  return {
    id: String(row.id ?? ""),
    position_id: positionId,
    position_code: position?.code ?? "",
    position_title: position?.title ?? "",
    group_id: groupId,
    group_name: group?.name ?? null,
    group_type: group?.group_type ?? null,
    manager_profile_id: managerId,
    manager_full_name: manager?.full_name ?? null,
    manager_email: manager?.email ?? null,
    starts_at: row.starts_at != null ? String(row.starts_at) : "",
    ends_at: row.ends_at != null ? String(row.ends_at) : null,
    notes: row.notes != null ? String(row.notes) : null,
    assigned_by: assignedBy,
    assigned_by_full_name: assigner?.full_name ?? null,
    assigned_by_email: assigner?.email ?? null,
  };
}
