"use server";

import { supabaseServer } from "../../../lib/supabase-server";
import { getSessionUserIdFromCookies } from "../../../lib/supabase-server-auth";
import { resolveEffectiveCompanyOrganizationId } from "../../../lib/resolve-effective-company-organization";
import {
  canEditTenantOrganizationBrandingByRoleKey,
  normalizeRoleKeyForBranding,
} from "../../../lib/tenant-branding-permissions";
import { isUuidString } from "../../../lib/uuid";
import {
  collectPositionCreateErrors,
  collectPositionUpdateErrors,
  normalizeAccessEntityKey,
  parsePositionLevel,
} from "../../platform/access/access-validation";

export type PositionsSettingsPageAccess = {
  accessDenied: "not_authenticated" | "forbidden" | null;
  organizationId: string | null;
  actorProfileId: string | null;
};

export type PositionSettingsRow = {
  id: string;
  organization_id: string;
  code: string;
  title: string;
  description: string | null;
  level: number | null;
  parent_position_id: string | null;
  parent_position_title: string | null;
  sort_order: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type CreatePositionSettingsInput = {
  code: string;
  title: string;
  description?: string | null;
  level?: string | number | null;
  parent_position_id?: string | null;
  sort_order?: string | number | null;
  is_active: boolean;
  /** Effective org hint for workspace-picker roles only. */
  organization_id?: string | null;
};

export type UpdatePositionSettingsInput = {
  code: string;
  title: string;
  description?: string | null;
  level?: string | number | null;
  parent_position_id?: string | null;
  sort_order?: string | number | null;
  is_active: boolean;
  /** Effective org hint for workspace-picker roles only. */
  organization_id?: string | null;
};

type PositionHierarchyNode = {
  id: string;
  parent_position_id: string | null;
};

function parseOptionalSortOrder(sortOrderRaw: string | number | null | undefined): number | null {
  if (sortOrderRaw == null || String(sortOrderRaw).trim() === "") return null;
  const n =
    typeof sortOrderRaw === "number"
      ? sortOrderRaw
      : Number.parseInt(String(sortOrderRaw).trim(), 10);
  return Number.isInteger(n) ? n : null;
}

function parseOptionalParentPositionId(
  parentRaw: string | null | undefined,
): string | null {
  if (parentRaw == null) return null;
  const trimmed = String(parentRaw).trim();
  if (!trimmed || trimmed === "__top_level__") return null;
  return isUuidString(trimmed) ? trimmed : null;
}

function collectPositionDescendantIds(
  positionId: string,
  nodes: PositionHierarchyNode[],
): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parent_position_id) continue;
    const siblings = childrenByParent.get(node.parent_position_id) ?? [];
    siblings.push(node.id);
    childrenByParent.set(node.parent_position_id, siblings);
  }

  const descendants = new Set<string>();
  const queue = [...(childrenByParent.get(positionId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || descendants.has(current)) continue;
    descendants.add(current);
    queue.push(...(childrenByParent.get(current) ?? []));
  }
  return descendants;
}

function mapPositionHierarchyTriggerError(errorMessage: string): string {
  const msg = errorMessage.trim();
  if (/cannot be its own parent/i.test(msg)) {
    return "A position cannot report to itself.";
  }
  if (/would create a cycle/i.test(msg)) {
    return "That parent would create a circular reporting line.";
  }
  if (/is archived/i.test(msg)) {
    return "Cannot assign an archived position as parent.";
  }
  if (/is not active/i.test(msg)) {
    return "Cannot assign an inactive position as parent.";
  }
  if (/does not belong to organization/i.test(msg) || /does not exist/i.test(msg)) {
    return "Parent position is not valid for this organization.";
  }
  return msg;
}

type ResolvedPositionsSettingsContext =
  | {
      ok: true;
      actorProfileId: string;
      organizationId: string;
    }
  | {
      ok: false;
      denied: "not_authenticated" | "forbidden";
    };

async function getAuthenticatedPositionsSettingsActor() {
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

function canManagePositionsSettings(roleKey: string | null): boolean {
  return canEditTenantOrganizationBrandingByRoleKey(roleKey);
}

async function resolvePositionsSettingsContext(
  organizationIdHint?: string | null,
): Promise<ResolvedPositionsSettingsContext> {
  const actor = await getAuthenticatedPositionsSettingsActor();
  if (!actor || !actor.roleKey) {
    return { ok: false, denied: "not_authenticated" };
  }
  if (!canManagePositionsSettings(actor.roleKey)) {
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
  };
}

async function loadPositionHierarchyNodes(
  organizationId: string,
): Promise<{ ok: true; nodes: PositionHierarchyNode[] } | { ok: false; error: string }> {
  const { data, error } = await supabaseServer
    .from("positions")
    .select("id, parent_position_id")
    .eq("organization_id", organizationId)
    .is("deleted_at", null);
  if (error) return { ok: false, error: error.message };
  const nodes: PositionHierarchyNode[] = (data ?? [])
    .map((raw) => {
      const r = raw as unknown as Record<string, unknown>;
      const id = String(r.id ?? "").trim();
      if (!id) return null;
      const parentRaw = r.parent_position_id;
      const parent_position_id =
        parentRaw != null && String(parentRaw).trim() ? String(parentRaw).trim() : null;
      return { id, parent_position_id };
    })
    .filter((x): x is PositionHierarchyNode => x != null);
  return { ok: true, nodes };
}

async function validateParentPositionSelection(input: {
  organizationId: string;
  positionId?: string | null;
  parentPositionId: string | null;
}): Promise<{ ok: true } | { ok: false; error: string; fieldErrors?: Record<string, string> }> {
  if (!input.parentPositionId) return { ok: true };
  if (input.positionId && input.parentPositionId === input.positionId) {
    return {
      ok: false,
      error: "A position cannot report to itself.",
      fieldErrors: { parent_position_id: "Cannot select this position as its own parent." },
    };
  }

  const { data: parentRow, error: parentErr } = await supabaseServer
    .from("positions")
    .select("id, organization_id, deleted_at, is_active")
    .eq("id", input.parentPositionId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (parentErr) return { ok: false, error: parentErr.message };
  if (!parentRow?.id) {
    return {
      ok: false,
      error: "Parent position not found in this organization.",
      fieldErrors: { parent_position_id: "Invalid parent position." },
    };
  }
  const parent = parentRow as { deleted_at?: string | null; is_active?: boolean };
  if (parent.deleted_at != null) {
    return {
      ok: false,
      error: "Cannot assign an archived position as parent.",
      fieldErrors: { parent_position_id: "Archived positions cannot be parents." },
    };
  }
  if (!parent.is_active) {
    return {
      ok: false,
      error: "Cannot assign an inactive position as parent.",
      fieldErrors: { parent_position_id: "Inactive positions cannot be parents." },
    };
  }

  if (input.positionId) {
    const hierarchy = await loadPositionHierarchyNodes(input.organizationId);
    if (!hierarchy.ok) return { ok: false, error: hierarchy.error };
    const descendants = collectPositionDescendantIds(input.positionId, hierarchy.nodes);
    if (descendants.has(input.parentPositionId)) {
      return {
        ok: false,
        error: "That parent would create a circular reporting line.",
        fieldErrors: { parent_position_id: "Cannot assign a descendant as parent." },
      };
    }
  }

  return { ok: true };
}

async function assertPositionInOrganization(
  positionId: string,
  organizationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabaseServer
    .from("positions")
    .select("id, deleted_at")
    .eq("id", positionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data?.id) return { ok: false, error: "Position not found in this organization." };
  const deletedAt = (data as { deleted_at?: string | null }).deleted_at;
  if (deletedAt != null) {
    return { ok: false, error: "Cannot update an archived position." };
  }
  return { ok: true };
}

export async function getPositionsSettingsPageAccessAction(
  organizationIdHint?: string | null,
): Promise<PositionsSettingsPageAccess> {
  const ctx = await resolvePositionsSettingsContext(organizationIdHint);
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

export async function listPositionsForOrgSettingsAction(
  organizationIdHint?: string | null,
): Promise<{ ok: true; rows: PositionSettingsRow[] } | { ok: false; error: string }> {
  const ctx = await resolvePositionsSettingsContext(organizationIdHint);
  if (!ctx.ok) {
    return {
      ok: false,
      error: ctx.denied === "not_authenticated" ? "Not authenticated." : "Forbidden.",
    };
  }

  try {
    const { data, error } = await supabaseServer
      .from("positions")
      .select(
        "id, organization_id, code, title, description, level, parent_position_id, sort_order, is_active, created_at, updated_at",
      )
      .eq("organization_id", ctx.organizationId)
      .is("deleted_at", null)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("title", { ascending: true })
      .order("code", { ascending: true });
    if (error) return { ok: false, error: error.message };

    const titleById = new Map<string, string>();
    for (const raw of data ?? []) {
      const r = raw as unknown as Record<string, unknown>;
      const id = String(r.id ?? "").trim();
      if (id) titleById.set(id, String(r.title ?? "").trim());
    }

    const rows: PositionSettingsRow[] = (data ?? [])
      .map((raw) => {
        const r = raw as unknown as Record<string, unknown>;
        const id = String(r.id ?? "").trim();
        if (!id) return null;
        const levelRaw = r.level;
        const level =
          levelRaw != null && Number.isInteger(Number(levelRaw)) ? Number(levelRaw) : null;
        const sortOrderRaw = r.sort_order;
        const sort_order =
          sortOrderRaw != null && Number.isInteger(Number(sortOrderRaw))
            ? Number(sortOrderRaw)
            : null;
        const parentRaw = r.parent_position_id;
        const parent_position_id =
          parentRaw != null && String(parentRaw).trim() ? String(parentRaw).trim() : null;
        return {
          id,
          organization_id: String(r.organization_id ?? "").trim(),
          code: String(r.code ?? "").trim(),
          title: String(r.title ?? "").trim(),
          description: r.description != null ? String(r.description) : null,
          level,
          parent_position_id,
          parent_position_title: parent_position_id
            ? (titleById.get(parent_position_id) ?? null)
            : null,
          sort_order,
          is_active: Boolean(r.is_active),
          created_at: r.created_at != null ? String(r.created_at) : "",
          updated_at: r.updated_at != null ? String(r.updated_at) : "",
        };
      })
      .filter((x): x is PositionSettingsRow => x != null);

    return { ok: true, rows };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to load positions.",
    };
  }
}

export async function createPositionSettingsAction(
  input: CreatePositionSettingsInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string; fieldErrors?: Record<string, string> }> {
  const ctx = await resolvePositionsSettingsContext(input.organization_id);
  if (!ctx.ok) {
    return {
      ok: false,
      error: ctx.denied === "not_authenticated" ? "Not authenticated." : "Forbidden.",
    };
  }

  const fe = collectPositionCreateErrors({
    organization_id: ctx.organizationId,
    code: input.code,
    title: input.title,
    description: input.description,
    level: input.level,
  });
  if (fe) return { ok: false, error: "Validation failed.", fieldErrors: fe };

  const code = normalizeAccessEntityKey(input.code);
  const title = input.title.trim();
  const description =
    input.description != null && String(input.description).trim()
      ? String(input.description).trim().slice(0, 300)
      : null;
  const level = parsePositionLevel(input.level);
  const parent_position_id = parseOptionalParentPositionId(input.parent_position_id);
  const sort_order = parseOptionalSortOrder(input.sort_order);
  if (input.parent_position_id != null && String(input.parent_position_id).trim() && !parent_position_id) {
    return {
      ok: false,
      error: "Invalid parent position.",
      fieldErrors: { parent_position_id: "Invalid parent position." },
    };
  }

  const parentValidation = await validateParentPositionSelection({
    organizationId: ctx.organizationId,
    parentPositionId: parent_position_id,
  });
  if (!parentValidation.ok) {
    return {
      ok: false,
      error: parentValidation.error,
      fieldErrors: parentValidation.fieldErrors,
    };
  }

  try {
    const { data: orgRow, error: orgErr } = await supabaseServer
      .from("organizations")
      .select("id")
      .eq("id", ctx.organizationId)
      .maybeSingle();
    if (orgErr) return { ok: false, error: orgErr.message };
    if (!orgRow) return { ok: false, error: "Organization not found." };

    const { data, error } = await supabaseServer
      .from("positions")
      .insert({
        organization_id: ctx.organizationId,
        code,
        title,
        description,
        level,
        parent_position_id,
        sort_order,
        is_active: Boolean(input.is_active),
        created_by: ctx.actorProfileId,
        updated_by: ctx.actorProfileId,
      })
      .select("id")
      .maybeSingle();
    if (error) {
      if (error.code === "23505") {
        return {
          ok: false,
          error: "A position with this code already exists in this organization.",
          fieldErrors: { code: "Duplicate code for this org." },
        };
      }
      return { ok: false, error: mapPositionHierarchyTriggerError(error.message) };
    }
    const newId =
      data && typeof (data as { id?: unknown }).id === "string"
        ? String((data as { id: string }).id)
        : "";
    if (!newId) return { ok: false, error: "Create failed." };
    return { ok: true, id: newId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Create failed." };
  }
}

export async function updatePositionSettingsAction(
  id: string,
  input: UpdatePositionSettingsInput,
): Promise<{ ok: true } | { ok: false; error: string; fieldErrors?: Record<string, string> }> {
  const ctx = await resolvePositionsSettingsContext(input.organization_id);
  if (!ctx.ok) {
    return {
      ok: false,
      error: ctx.denied === "not_authenticated" ? "Not authenticated." : "Forbidden.",
    };
  }
  if (!isUuidString(id)) return { ok: false, error: "Invalid position id." };

  const fe = collectPositionUpdateErrors(input);
  if (fe) return { ok: false, error: "Validation failed.", fieldErrors: fe };

  const inOrg = await assertPositionInOrganization(id, ctx.organizationId);
  if (!inOrg.ok) return { ok: false, error: inOrg.error };

  const code = normalizeAccessEntityKey(input.code);
  const title = input.title.trim();
  const description =
    input.description != null && String(input.description).trim()
      ? String(input.description).trim().slice(0, 300)
      : null;
  const level = parsePositionLevel(input.level);
  const parent_position_id = parseOptionalParentPositionId(input.parent_position_id);
  const sort_order = parseOptionalSortOrder(input.sort_order);
  if (input.parent_position_id != null && String(input.parent_position_id).trim() && !parent_position_id) {
    return {
      ok: false,
      error: "Invalid parent position.",
      fieldErrors: { parent_position_id: "Invalid parent position." },
    };
  }

  const parentValidation = await validateParentPositionSelection({
    organizationId: ctx.organizationId,
    positionId: id,
    parentPositionId: parent_position_id,
  });
  if (!parentValidation.ok) {
    return {
      ok: false,
      error: parentValidation.error,
      fieldErrors: parentValidation.fieldErrors,
    };
  }

  try {
    const { error } = await supabaseServer
      .from("positions")
      .update({
        code,
        title,
        description,
        level,
        parent_position_id,
        sort_order,
        is_active: Boolean(input.is_active),
        updated_by: ctx.actorProfileId,
      })
      .eq("id", id)
      .eq("organization_id", ctx.organizationId)
      .is("deleted_at", null);
    if (error) {
      if (error.code === "23505") {
        return {
          ok: false,
          error: "A position with this code already exists in this organization.",
          fieldErrors: { code: "Duplicate code for this org." },
        };
      }
      return { ok: false, error: mapPositionHierarchyTriggerError(error.message) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Update failed." };
  }
}

export async function archivePositionSettingsAction(
  id: string,
  organizationIdHint?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await resolvePositionsSettingsContext(organizationIdHint);
  if (!ctx.ok) {
    return {
      ok: false,
      error: ctx.denied === "not_authenticated" ? "Not authenticated." : "Forbidden.",
    };
  }
  if (!isUuidString(id)) return { ok: false, error: "Invalid position id." };

  try {
    const { data: row, error: fetchErr } = await supabaseServer
      .from("positions")
      .select("id, deleted_at")
      .eq("id", id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    if (fetchErr) return { ok: false, error: fetchErr.message };
    if (!row) return { ok: false, error: "Position not found in this organization." };
    const r = row as { deleted_at?: string | null };
    if (r.deleted_at != null) {
      return { ok: false, error: "Position is already archived." };
    }
    const now = new Date().toISOString();
    const { error } = await supabaseServer
      .from("positions")
      .update({
        deleted_at: now,
        is_active: false,
        updated_by: ctx.actorProfileId,
      })
      .eq("id", id)
      .eq("organization_id", ctx.organizationId)
      .is("deleted_at", null);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Archive failed." };
  }
}
