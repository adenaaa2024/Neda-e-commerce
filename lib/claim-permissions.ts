/**
 * Claim permission catalog (NEXT-CLAIM-33).
 * Server-safe constants + metadata — no I/O.
 *
 * Align with docs/claims/STORE_ACCESS_AND_PERMISSIONS_V1.md over time.
 */

export type ClaimRiskClass = "low" | "medium" | "high" | "critical";

export type StoreAccessFloor = "view" | "act" | "submit";

/** Lexicographic order not used — rank via CLAIM_ACCESS_RANK. */
export type ClaimPermissionKey =
  | "claims.inbox.view"
  | "claims.case.view"
  | "claims.task.view"
  | "claims.event.view"
  | "claims.case.open"
  | "claims.case.assign"
  | "claims.case.reopen"
  | "claims.case.close"
  | "claims.task.claim"
  | "claims.task.complete"
  | "claims.task.reassign"
  | "claims.evidence.upload"
  | "claims.evidence.delete"
  | "claims.product.link"
  | "claims.pim.override_block"
  | "claims.marketplace.open_case"
  | "claims.marketplace.submit"
  | "claims.marketplace.follow_up"
  | "claims.ai.view_suggestions"
  | "claims.ai.apply_suggestion"
  | "claims.workflow.admin"
  | "claims.settings.manage"
  | "platform.claims.impersonate_read"
  | "platform.claims.audit";

export type ClaimPermissionMeta = {
  key: ClaimPermissionKey;
  description: string;
  risk: ClaimRiskClass;
  /** When true, assertClaimPermission denies if storeId is missing. */
  requiredStore: boolean;
  /** Minimum assignment access_level (hierarchy: submit >= act >= view). */
  minimumStoreAccess: StoreAccessFloor;
  /**
   * When true, tenant_admin/admin in the org does NOT receive implicit store access;
   * an explicit user_store_assignments row is required (marketplace-dangerous paths).
   */
  requireExplicitAssignmentForTenantAdmin?: boolean;
};

export const CLAIM_ACCESS_RANK: Record<StoreAccessFloor, number> = {
  view: 0,
  act: 1,
  submit: 2,
};

export const CLAIM_PERMISSION_CATALOG: Record<ClaimPermissionKey, ClaimPermissionMeta> = {
  "claims.inbox.view": {
    key: "claims.inbox.view",
    description: "View claim inbox / queue for a tenant (optional store filter).",
    risk: "low",
    requiredStore: false,
    minimumStoreAccess: "view",
  },
  "claims.case.view": {
    key: "claims.case.view",
    description: "View case summary and read-only case data.",
    risk: "low",
    requiredStore: false,
    minimumStoreAccess: "view",
  },
  "claims.task.view": {
    key: "claims.task.view",
    description: "View workflow tasks.",
    risk: "low",
    requiredStore: false,
    minimumStoreAccess: "view",
  },
  "claims.event.view": {
    key: "claims.event.view",
    description: "View claim timeline / events.",
    risk: "low",
    requiredStore: false,
    minimumStoreAccess: "view",
  },
  "claims.case.open": {
    key: "claims.case.open",
    description: "Open a new case for a claim family.",
    risk: "medium",
    requiredStore: false,
    minimumStoreAccess: "act",
  },
  "claims.case.assign": {
    key: "claims.case.assign",
    description: "Assign case ownership or reviewers.",
    risk: "medium",
    requiredStore: false,
    minimumStoreAccess: "act",
  },
  "claims.case.reopen": {
    key: "claims.case.reopen",
    description: "Reopen a closed case (may be restricted when reimbursed).",
    risk: "high",
    requiredStore: false,
    minimumStoreAccess: "act",
  },
  "claims.case.close": {
    key: "claims.case.close",
    description: "Close or resolve a case.",
    risk: "medium",
    requiredStore: false,
    minimumStoreAccess: "act",
  },
  "claims.task.claim": {
    key: "claims.task.claim",
    description: "Claim a task from the queue.",
    risk: "low",
    requiredStore: false,
    minimumStoreAccess: "act",
  },
  "claims.task.complete": {
    key: "claims.task.complete",
    description: "Mark a task complete.",
    risk: "medium",
    requiredStore: false,
    minimumStoreAccess: "act",
  },
  "claims.task.reassign": {
    key: "claims.task.reassign",
    description: "Reassign a task to another operator.",
    risk: "medium",
    requiredStore: false,
    minimumStoreAccess: "act",
  },
  "claims.evidence.upload": {
    key: "claims.evidence.upload",
    description: "Upload evidence artifacts for a claim context.",
    risk: "medium",
    requiredStore: true,
    minimumStoreAccess: "act",
  },
  "claims.evidence.delete": {
    key: "claims.evidence.delete",
    description: "Delete evidence (dangerous; audit-heavy).",
    risk: "critical",
    requiredStore: true,
    minimumStoreAccess: "submit",
    requireExplicitAssignmentForTenantAdmin: true,
  },
  "claims.product.link": {
    key: "claims.product.link",
    description: "Link catalog/product identity to claim context.",
    risk: "medium",
    requiredStore: true,
    minimumStoreAccess: "act",
  },
  "claims.pim.override_block": {
    key: "claims.pim.override_block",
    description: "Override PIM merge / identifier blocks for claim resolution.",
    risk: "critical",
    requiredStore: true,
    minimumStoreAccess: "submit",
    requireExplicitAssignmentForTenantAdmin: true,
  },
  "claims.marketplace.open_case": {
    key: "claims.marketplace.open_case",
    description: "Open a marketplace support case (channel-specific).",
    risk: "high",
    requiredStore: true,
    minimumStoreAccess: "act",
    requireExplicitAssignmentForTenantAdmin: true,
  },
  "claims.marketplace.submit": {
    key: "claims.marketplace.submit",
    description: "Submit reimbursement / dispute to marketplace (irreversible).",
    risk: "critical",
    requiredStore: true,
    minimumStoreAccess: "submit",
    requireExplicitAssignmentForTenantAdmin: true,
  },
  "claims.marketplace.follow_up": {
    key: "claims.marketplace.follow_up",
    description: "Send follow-up messages on an existing marketplace case.",
    risk: "high",
    requiredStore: true,
    minimumStoreAccess: "act",
    requireExplicitAssignmentForTenantAdmin: true,
  },
  "claims.ai.view_suggestions": {
    key: "claims.ai.view_suggestions",
    description: "View AI-generated suggestions (read-only).",
    risk: "low",
    requiredStore: false,
    minimumStoreAccess: "view",
  },
  "claims.ai.apply_suggestion": {
    key: "claims.ai.apply_suggestion",
    description: "Apply an AI suggestion after human confirmation.",
    risk: "high",
    requiredStore: false,
    minimumStoreAccess: "act",
  },
  "claims.workflow.admin": {
    key: "claims.workflow.admin",
    description: "Administrative workflow controls (bypass / repair).",
    risk: "critical",
    requiredStore: false,
    minimumStoreAccess: "submit",
    requireExplicitAssignmentForTenantAdmin: true,
  },
  "claims.settings.manage": {
    key: "claims.settings.manage",
    description: "Manage claim module settings for the tenant.",
    risk: "high",
    requiredStore: false,
    minimumStoreAccess: "act",
  },
  "platform.claims.impersonate_read": {
    key: "platform.claims.impersonate_read",
    description: "Platform staff read-only cross-tenant claim inspection.",
    risk: "medium",
    requiredStore: false,
    minimumStoreAccess: "view",
  },
  "platform.claims.audit": {
    key: "platform.claims.audit",
    description: "Platform audit exports / read-only forensic views.",
    risk: "medium",
    requiredStore: false,
    minimumStoreAccess: "view",
  },
};

export function isClaimPermissionKey(s: string): s is ClaimPermissionKey {
  return Object.prototype.hasOwnProperty.call(CLAIM_PERMISSION_CATALOG, s);
}
