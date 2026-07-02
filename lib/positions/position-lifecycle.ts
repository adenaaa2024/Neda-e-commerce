import "server-only";

import { supabaseServer } from "../supabase-server";
import { normalizeAccessEntityKey } from "../../app/platform/access/access-validation";

export const POSITION_ARCHIVE_CHILD_BLOCK_MSG =
  "This position has child positions. Move or archive child positions first.";

export const POSITION_HARD_DELETE_BLOCKED_MSG =
  "This position has assignment history or child positions and cannot be permanently deleted. Archive it instead.";

export const POSITION_RESTORE_PARENT_BLOCKED_MSG =
  "This position cannot be restored because its parent position is archived or inactive. Restore or change the parent first.";

export async function countActiveChildPositions(
  positionId: string,
  organizationId: string,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const { count, error } = await supabaseServer
    .from("positions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("parent_position_id", positionId)
    .is("deleted_at", null);
  if (error) return { ok: false, error: error.message };
  return { ok: true, count: count ?? 0 };
}

export async function countAllChildPositions(
  positionId: string,
  organizationId: string,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const { count, error } = await supabaseServer
    .from("positions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("parent_position_id", positionId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, count: count ?? 0 };
}

export async function countPositionAssignmentReferences(
  positionId: string,
  organizationId: string,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const { count, error } = await supabaseServer
    .from("profile_position_assignments")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("position_id", positionId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, count: count ?? 0 };
}

export async function assertPositionArchiveAllowed(
  positionId: string,
  organizationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const childCheck = await countActiveChildPositions(positionId, organizationId);
  if (!childCheck.ok) return { ok: false, error: childCheck.error };
  if (childCheck.count > 0) {
    return { ok: false, error: POSITION_ARCHIVE_CHILD_BLOCK_MSG };
  }
  return { ok: true };
}

export async function assertPositionHardDeleteAllowed(
  positionId: string,
  organizationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const childCheck = await countAllChildPositions(positionId, organizationId);
  if (!childCheck.ok) return { ok: false, error: childCheck.error };
  if (childCheck.count > 0) {
    return { ok: false, error: POSITION_HARD_DELETE_BLOCKED_MSG };
  }

  const assignmentCheck = await countPositionAssignmentReferences(positionId, organizationId);
  if (!assignmentCheck.ok) return { ok: false, error: assignmentCheck.error };
  if (assignmentCheck.count > 0) {
    return { ok: false, error: POSITION_HARD_DELETE_BLOCKED_MSG };
  }

  return { ok: true };
}

export async function assertPositionRestoreParentValid(
  parentPositionId: string | null,
  organizationId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!parentPositionId) return { ok: true };

  const { data: parentRow, error: parentErr } = await supabaseServer
    .from("positions")
    .select("id, organization_id, deleted_at, is_active")
    .eq("id", parentPositionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (parentErr) return { ok: false, error: parentErr.message };
  if (!parentRow?.id) {
    return { ok: false, error: POSITION_RESTORE_PARENT_BLOCKED_MSG };
  }
  const parent = parentRow as { deleted_at?: string | null; is_active?: boolean };
  if (parent.deleted_at != null || !parent.is_active) {
    return { ok: false, error: POSITION_RESTORE_PARENT_BLOCKED_MSG };
  }
  return { ok: true };
}

export function normalizePositionConfirmationCode(confirmationCode: string): string {
  return normalizeAccessEntityKey(confirmationCode);
}
