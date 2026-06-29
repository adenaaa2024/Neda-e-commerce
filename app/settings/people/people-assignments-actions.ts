"use server";

import { supabaseServer } from "../../../lib/supabase-server";
import { getSessionUserIdFromCookies } from "../../../lib/supabase-server-auth";
import { resolveEffectiveCompanyOrganizationId } from "../../../lib/resolve-effective-company-organization";
import {
  canEditTenantOrganizationBrandingByRoleKey,
  normalizeRoleKeyForBranding,
} from "../../../lib/tenant-branding-permissions";
import type {
  AssignableGroupForPeopleRow,
  AssignablePositionRow,
  AssignProfilePositionInput,
  ManagerCandidateRow,
  PeopleAssignmentAccessDenied,
  PeopleAssignmentsPageAccess,
  PersonForAssignmentRow,
  ProfilePositionAssignmentDisplay,
  ProfilePositionAssignmentState,
} from "../../../lib/people-org-chart/people-assignment-types";
import { isUuidString } from "../../../lib/uuid";

const PROFILE_LIST_SELECT =
  "id, full_name, role, photo_url, roles!profiles_role_id_fkey(key, name)";

const ASSIGNMENT_SELECT =
  "id, position_id, group_id, manager_profile_id, starts_at, ends_at, notes, assigned_by";

const ASSIGNABLE_GROUP_TYPES = ["team", "department", "queue", "access_group"] as const;
const MAX_ASSIGNMENT_NOTES_LENGTH = 2000;

type ResolvedPeopleAssignmentsContext =
  | {
      ok: true;
      actorProfileId: string;
      organizationId: string;
      roleKey: string;
    }
  | {
      ok: false;
      denied: PeopleAssignmentAccessDenied;
    };

function splitJoined<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return (raw[0] as T | undefined) ?? null;
  return raw as T;
}

async function getAuthenticatedPeopleAssignmentsActor() {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId) return null;

  const { data: profile } = await supabaseServer
    .from("profiles")
    .select("id, organization_id, role, role_id")
    .eq("id", sessionUserId)
    .maybeSingle();

  if (!profile) return null;

  let roleKey = "";
  const roleId = typeof profile.role_id === "string" ? profile.role_id.trim() : "";
  if (roleId) {
    const { data: roleRow } = await supabaseServer
      .from("roles")
      .select("key")
      .eq("id", roleId)
      .maybeSingle();
    roleKey = typeof roleRow?.key === "string" ? roleRow.key.trim() : "";
  }
  if (!roleKey) {
    roleKey = typeof profile.role === "string" ? profile.role.trim() : "";
  }
  roleKey = normalizeRoleKeyForBranding(roleKey);

  return {
    id: String(profile.id),
    organizationId:
      typeof profile.organization_id === "string" && profile.organization_id.trim()
        ? profile.organization_id.trim()
        : null,
    roleKey: roleKey.length > 0 ? roleKey : null,
  };
}

function canManagePeopleAssignments(roleKey: string | null): boolean {
  return canEditTenantOrganizationBrandingByRoleKey(roleKey);
}

async function resolvePeopleAssignmentsContext(
  organizationIdHint?: string | null,
): Promise<ResolvedPeopleAssignmentsContext> {
  const actor = await getAuthenticatedPeopleAssignmentsActor();
  if (!actor || !actor.roleKey) {
    return { ok: false, denied: "not_authenticated" };
  }
  if (!canManagePeopleAssignments(actor.roleKey)) {
    return { ok: false, denied: "forbidden" };
  }
  const organizationId = resolveEffectiveCompanyOrganizationId(actor, organizationIdHint);
  if (!organizationId) {
    return { ok: false, denied: "forbidden" };
  }
  return {
    ok: true,
    actorProfileId: actor.id,
    organizationId,
    roleKey: actor.roleKey,
  };
}

async function emailByUserIdMap(userIds?: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const { data, error } = await supabaseServer.auth.admin.listUsers({ perPage: 1000 });
    if (error || !data?.users) return map;
    const filter =
      userIds && userIds.length > 0 ? new Set(userIds.map((x) => x.trim())) : null;
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

async function assertProfileInOrganization(
  profileId: string,
  organizationId: string,
): Promise<boolean> {
  const { data, error } = await supabaseServer
    .from("profiles")
    .select("id")
    .eq("id", profileId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return !error && !!data?.id;
}

async function assertPositionInOrganization(
  positionId: string,
  organizationId: string,
): Promise<boolean> {
  const { data, error } = await supabaseServer
    .from("positions")
    .select("id")
    .eq("id", positionId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .eq("is_active", true)
    .maybeSingle();
  return !error && !!data?.id;
}

async function assertGroupInOrganization(
  groupId: string,
  organizationId: string,
): Promise<boolean> {
  const { data, error } = await supabaseServer
    .from("groups")
    .select("id, group_type")
    .eq("id", groupId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error || !data?.id) return false;
  const groupType = String((data as { group_type?: unknown }).group_type ?? "").trim();
  return ASSIGNABLE_GROUP_TYPES.includes(
    groupType as (typeof ASSIGNABLE_GROUP_TYPES)[number],
  );
}

type AssignmentJoinMaps = {
  positions: Map<string, { code: string; title: string }>;
  groups: Map<string, { name: string; group_type: string }>;
  profiles: Map<string, { full_name: string; email: string | null }>;
};

async function buildAssignmentJoinMaps(
  rows: Record<string, unknown>[],
): Promise<AssignmentJoinMaps> {
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
      const r = raw as unknown as Record<string, unknown>;
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
      const r = raw as unknown as Record<string, unknown>;
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
      const r = raw as unknown as Record<string, unknown>;
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

function mapAssignmentRow(
  row: Record<string, unknown>,
  joins: AssignmentJoinMaps,
): ProfilePositionAssignmentDisplay {
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

export async function getPeopleAssignmentsPageAccessAction(
  organizationIdHint?: string | null,
): Promise<PeopleAssignmentsPageAccess> {
  const ctx = await resolvePeopleAssignmentsContext(organizationIdHint);
  if (!ctx.ok) {
    return {
      accessDenied: ctx.denied,
      organizationId: null,
      actorProfileId: null,
    };
  }
  return {
    accessDenied: null,
    organizationId: ctx.organizationId,
    actorProfileId: ctx.actorProfileId,
  };
}

export async function listPeopleForAssignmentsAction(
  organizationIdHint?: string | null,
): Promise<{ ok: true; rows: PersonForAssignmentRow[] } | { ok: false; error: string }> {
  const ctx = await resolvePeopleAssignmentsContext(organizationIdHint);
  if (!ctx.ok) {
    return {
      ok: false,
      error: ctx.denied === "not_authenticated" ? "Not authenticated." : "Forbidden.",
    };
  }

  try {
    const { data, error } = await supabaseServer
      .from("profiles")
      .select(PROFILE_LIST_SELECT)
      .eq("organization_id", ctx.organizationId)
      .order("full_name", { ascending: true });
    if (error) return { ok: false, error: error.message };

    const rawRows = (data ?? []) as unknown as Record<string, unknown>[];
    const emails = await emailByUserIdMap(rawRows.map((r) => String(r.id ?? "")));
    const rows: PersonForAssignmentRow[] = rawRows
      .map((raw) => {
        const id = String(raw.id ?? "").trim();
        if (!id) return null;
        const joined = splitJoined<{ key?: string; name?: string }>(raw.roles);
        const legacyRole = typeof raw.role === "string" ? raw.role.trim() : "";
        const roleKey = joined?.key?.trim() || legacyRole || null;
        const roleName = joined?.name?.trim() || null;
        return {
          id,
          full_name: String(raw.full_name ?? "").trim() || "Unnamed user",
          email: emails.get(id) ?? null,
          role_key: roleKey,
          role_name: roleName,
          photo_url:
            typeof raw.photo_url === "string" && raw.photo_url.trim()
              ? raw.photo_url.trim()
              : null,
        };
      })
      .filter((x): x is PersonForAssignmentRow => x != null);

    return { ok: true, rows };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to load people.",
    };
  }
}

export async function listAssignablePositionsForOrgAction(
  organizationIdHint?: string | null,
): Promise<{ ok: true; rows: AssignablePositionRow[] } | { ok: false; error: string }> {
  const ctx = await resolvePeopleAssignmentsContext(organizationIdHint);
  if (!ctx.ok) {
    return {
      ok: false,
      error: ctx.denied === "not_authenticated" ? "Not authenticated." : "Forbidden.",
    };
  }

  try {
    const { data, error } = await supabaseServer
      .from("positions")
      .select("id, code, title")
      .eq("organization_id", ctx.organizationId)
      .is("deleted_at", null)
      .eq("is_active", true)
      .order("title", { ascending: true })
      .order("code", { ascending: true });
    if (error) return { ok: false, error: error.message };

    const rows: AssignablePositionRow[] = (data ?? [])
      .map((raw) => {
        const r = raw as unknown as Record<string, unknown>;
        const id = String(r.id ?? "").trim();
        if (!id) return null;
        return {
          id,
          code: String(r.code ?? "").trim(),
          title: String(r.title ?? "").trim() || String(r.code ?? "").trim(),
        };
      })
      .filter((x): x is AssignablePositionRow => x != null);

    return { ok: true, rows };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to load positions.",
    };
  }
}

export async function listAssignableGroupsForPeopleAction(
  organizationIdHint?: string | null,
): Promise<
  { ok: true; rows: AssignableGroupForPeopleRow[] } | { ok: false; error: string }
> {
  const ctx = await resolvePeopleAssignmentsContext(organizationIdHint);
  if (!ctx.ok) {
    return {
      ok: false,
      error: ctx.denied === "not_authenticated" ? "Not authenticated." : "Forbidden.",
    };
  }

  try {
    const { data, error } = await supabaseServer
      .from("groups")
      .select("id, key, name, group_type")
      .eq("organization_id", ctx.organizationId)
      .in("group_type", [...ASSIGNABLE_GROUP_TYPES])
      .order("name", { ascending: true });
    if (error) return { ok: false, error: error.message };

    const rows: AssignableGroupForPeopleRow[] = (data ?? [])
      .map((raw) => {
        const r = raw as unknown as Record<string, unknown>;
        const id = String(r.id ?? "").trim();
        if (!id) return null;
        return {
          id,
          key: String(r.key ?? "").trim(),
          name: String(r.name ?? "").trim() || String(r.key ?? "").trim(),
          group_type: String(r.group_type ?? "").trim(),
        };
      })
      .filter((x): x is AssignableGroupForPeopleRow => x != null);

    return { ok: true, rows };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to load groups.",
    };
  }
}

export async function listManagerCandidatesForOrgAction(
  profileId?: string | null,
  organizationIdHint?: string | null,
): Promise<{ ok: true; rows: ManagerCandidateRow[] } | { ok: false; error: string }> {
  const ctx = await resolvePeopleAssignmentsContext(organizationIdHint);
  if (!ctx.ok) {
    return {
      ok: false,
      error: ctx.denied === "not_authenticated" ? "Not authenticated." : "Forbidden.",
    };
  }

  const excludeId = profileId?.trim() ?? "";

  try {
    const { data, error } = await supabaseServer
      .from("profiles")
      .select("id, full_name")
      .eq("organization_id", ctx.organizationId)
      .order("full_name", { ascending: true });
    if (error) return { ok: false, error: error.message };

    const rawRows = (data ?? []) as unknown as Record<string, unknown>[];
    const filtered = rawRows.filter((r) => {
      const id = String(r.id ?? "").trim();
      return id && id !== excludeId;
    });
    const emails = await emailByUserIdMap(filtered.map((r) => String(r.id ?? "")));

    const rows: ManagerCandidateRow[] = filtered
      .map((raw) => {
        const id = String(raw.id ?? "").trim();
        if (!id) return null;
        return {
          id,
          full_name: String(raw.full_name ?? "").trim() || "Unnamed user",
          email: emails.get(id) ?? null,
        };
      })
      .filter((x): x is ManagerCandidateRow => x != null);

    return { ok: true, rows };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to load manager candidates.",
    };
  }
}

export async function getProfilePositionAssignmentStateAction(
  profileId: string,
  organizationIdHint?: string | null,
): Promise<
  { ok: true; state: ProfilePositionAssignmentState } | { ok: false; error: string }
> {
  const ctx = await resolvePeopleAssignmentsContext(organizationIdHint);
  if (!ctx.ok) {
    return {
      ok: false,
      error: ctx.denied === "not_authenticated" ? "Not authenticated." : "Forbidden.",
    };
  }

  const pid = profileId.trim();
  if (!isUuidString(pid)) return { ok: false, error: "Invalid profile." };
  if (!(await assertProfileInOrganization(pid, ctx.organizationId))) {
    return { ok: false, error: "Profile not found in this organization." };
  }

  try {
    const { data, error } = await supabaseServer
      .from("profile_position_assignments")
      .select(ASSIGNMENT_SELECT)
      .eq("organization_id", ctx.organizationId)
      .eq("profile_id", pid)
      .order("starts_at", { ascending: false });
    if (error) return { ok: false, error: error.message };

    const rawRows = (data ?? []) as unknown as Record<string, unknown>[];
    const joins = await buildAssignmentJoinMaps(rawRows);
    const mapped = rawRows.map((row) => mapAssignmentRow(row, joins));
    const current = mapped.find((row) => row.ends_at == null) ?? null;
    const history = mapped;

    return { ok: true, state: { current, history } };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to load assignment state.",
    };
  }
}

function validateAssignInput(input: AssignProfilePositionInput): string | null {
  const profileId = input.profile_id.trim();
  const positionId = input.position_id.trim();
  const startsAt = input.starts_at.trim();

  if (!isUuidString(profileId)) return "Person is required.";
  if (!isUuidString(positionId)) return "Position is required.";
  if (!startsAt) return "Start date is required.";
  if (Number.isNaN(Date.parse(startsAt))) return "Start date is invalid.";

  const managerId = input.manager_profile_id?.trim() ?? "";
  if (managerId && managerId === profileId) {
    return "Manager cannot be the same person.";
  }

  const notes = input.notes?.trim() ?? "";
  if (notes.length > MAX_ASSIGNMENT_NOTES_LENGTH) {
    return `Notes must be at most ${MAX_ASSIGNMENT_NOTES_LENGTH} characters.`;
  }

  return null;
}

export async function assignProfilePositionFromSettingsAction(
  input: AssignProfilePositionInput,
): Promise<
  | { ok: true; state: ProfilePositionAssignmentState }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }
> {
  const ctx = await resolvePeopleAssignmentsContext(input.organization_id);
  if (!ctx.ok) {
    return {
      ok: false,
      error: ctx.denied === "not_authenticated" ? "Not authenticated." : "Forbidden.",
    };
  }

  const validationError = validateAssignInput(input);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  const profileId = input.profile_id.trim();
  const positionId = input.position_id.trim();
  const groupId = input.group_id?.trim() || null;
  const managerId = input.manager_profile_id?.trim() || null;
  const startsAt = new Date(input.starts_at.trim()).toISOString();
  const notes = input.notes?.trim() || null;

  if (!(await assertProfileInOrganization(profileId, ctx.organizationId))) {
    return { ok: false, error: "Profile not found in this organization." };
  }
  if (!(await assertPositionInOrganization(positionId, ctx.organizationId))) {
    return { ok: false, error: "Position not found or inactive for this organization." };
  }
  if (groupId && !(await assertGroupInOrganization(groupId, ctx.organizationId))) {
    return { ok: false, error: "Group not found or not assignable for this organization." };
  }
  if (managerId && !(await assertProfileInOrganization(managerId, ctx.organizationId))) {
    return { ok: false, error: "Manager not found in this organization." };
  }

  const currentState = await getProfilePositionAssignmentStateAction(
    profileId,
    ctx.organizationId,
  );
  if (currentState.ok && currentState.state.current?.starts_at) {
    const currentStart = Date.parse(currentState.state.current.starts_at);
    const nextStart = Date.parse(startsAt);
    if (!Number.isNaN(currentStart) && !Number.isNaN(nextStart) && nextStart < currentStart) {
      return {
        ok: false,
        error: "Start date cannot be before the current assignment start date.",
        fieldErrors: { starts_at: "Must be on or after the current assignment start." },
      };
    }
  }

  try {
    const { error } = await supabaseServer.rpc("assign_profile_position", {
      p_organization_id: ctx.organizationId,
      p_profile_id: profileId,
      p_position_id: positionId,
      p_group_id: groupId,
      p_manager_profile_id: managerId,
      p_starts_at: startsAt,
      p_assigned_by: ctx.actorProfileId,
      p_notes: notes,
    });
    if (error) {
      return { ok: false, error: error.message };
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Assignment failed.",
    };
  }

  const refreshed = await getProfilePositionAssignmentStateAction(profileId, ctx.organizationId);
  if (!refreshed.ok) {
    return { ok: false, error: refreshed.error };
  }
  return { ok: true, state: refreshed.state };
}
