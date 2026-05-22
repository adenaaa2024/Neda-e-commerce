import "server-only";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { getSessionUserIdFromCookies } from "./supabase-server-auth";

export type {
  AssertClaimPermissionContext,
  AssertClaimPermissionDenied,
  AssertClaimPermissionOk,
  AssertClaimPermissionResult,
  ClaimPermissionDenialCode,
  UserStoreAssignmentRow,
} from "./claim-permission-evaluate";

export type { ClaimPermissionKey, StoreAccessFloor } from "./claim-permissions";
export { CLAIM_PERMISSION_CATALOG, isClaimPermissionKey } from "./claim-permissions";

export {
  evaluateClaimPermissionForActor,
  getUserStoreAccessForOrganization,
  loadUserOrgAccessFlags,
  userMayAccessOrganization,
} from "./claim-permission-evaluate";

import {
  evaluateClaimPermissionForActor,
  type AssertClaimPermissionContext,
  type AssertClaimPermissionResult,
} from "./claim-permission-evaluate";

/**
 * Session-bound claim permission check for server routes/actions.
 */
export async function assertClaimPermission(
  action: string,
  ctx: AssertClaimPermissionContext,
): Promise<AssertClaimPermissionResult> {
  const uid = await getSessionUserIdFromCookies();
  if (!uid) {
    return { ok: false, code: "ORG_DENIED", message: "Not signed in.", httpStatus: 401 };
  }

  const org = await assertUserCanAccessOrganization(ctx.organizationId);
  if (!org.ok) {
    return {
      ok: false,
      code: "ORG_DENIED",
      message: org.error,
      httpStatus: org.error === "Not signed in." ? 401 : 403,
    };
  }
  if (org.userId !== uid) {
    return { ok: false, code: "INTERNAL_ERROR", message: "Session user mismatch.", httpStatus: 500 };
  }

  return evaluateClaimPermissionForActor(action, uid, ctx);
}
