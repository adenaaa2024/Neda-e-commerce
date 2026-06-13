import { CLAIMS_SETTINGS_HREF } from "@/lib/claims-hub-routes";
import type { ClaimPolicyV1 } from "@/lib/claim-policy-types";
import type { ClaimWorkflowSettings } from "@/lib/claim-effective-settings-shared";

import type { ClaimSettingsOverviewRow } from "@/components/claim-center/ClaimSettingsOverviewPanel";
import { buildClaimSettingsOverviewRows } from "@/components/claim-center/ClaimSettingsOverviewPanel";

export const POLICY_SNAPSHOT_INTRO =
  "This page only shows the effective rules used by Claim Center. Editing happens in the owning settings area — not here.";

export type PolicyOwnershipGroupId =
  | "operational"
  | "automation"
  | "entitlement"
  | "access"
  | "platform_gates";

export type PolicyOwnershipGroup = {
  id: PolicyOwnershipGroupId;
  title: string;
  description: string;
  ownerLabel: string;
  ownerHref: string | null;
  ownerFallback: string | null;
  rowIds: string[];
};

export const POLICY_OWNERSHIP_GROUPS: PolicyOwnershipGroup[] = [
  {
    id: "operational",
    title: "Claim operational policy",
    description: "Evidence, filing windows, workflow, and claim rules for this organization.",
    ownerLabel: "Workspace claim settings",
    ownerHref: CLAIMS_SETTINGS_HREF,
    ownerFallback: null,
    rowIds: [
      "sources",
      "trigger_modes",
      "filing_deadlines",
      "evidence_requirements",
      "product_linkage_requirements",
      "trid_reference_requirements",
      "submission_rules",
      "approval_thresholds",
      "orbit_fra_import",
    ],
  },
  {
    id: "automation",
    title: "Automation & source runs",
    description: "Intake schedules, pool generation, and per-store automation overrides.",
    ownerLabel: "Platform automation",
    ownerHref: "/platform/settings/automation",
    ownerFallback: null,
    rowIds: ["automation_schedules", "candidate_intake_policy", "store_overrides"],
  },
  {
    id: "entitlement",
    title: "Claim module availability",
    description: "Whether Claim Recovery and claim domains are enabled for this company.",
    ownerLabel: "Platform access & entitlements",
    ownerHref: "/platform/access",
    ownerFallback: "Managed by platform admin",
    rowIds: ["module_enablement"],
  },
  {
    id: "access",
    title: "User & role access",
    description: "Who can review claims, manage settings, and operate Claim Engine workflows.",
    ownerLabel: "Platform users & access",
    ownerHref: "/platform/users",
    ownerFallback: "Managed in access settings",
    rowIds: ["role_permissions"],
  },
];

const PLATFORM_LOCKED_ROW_IDS = new Set(["ai_assistant_rules", "amazon_agent_rules", "operator_pwa_gates"]);

export function buildPolicySnapshotGroups(input: {
  policy?: ClaimPolicyV1 | null;
  workflow?: ClaimWorkflowSettings | null;
  claimRecoveryEnabled?: boolean;
  autoCreateDrafts?: boolean;
  moduleAccessReason?: string | null;
}): Array<PolicyOwnershipGroup & { rows: ClaimSettingsOverviewRow[] }> {
  const allRows = buildClaimSettingsOverviewRows(input);
  const byId = new Map(allRows.map((r) => [r.id, r]));

  const groups = POLICY_OWNERSHIP_GROUPS.map((g) => ({
    ...g,
    rows: g.rowIds.map((id) => byId.get(id)).filter((r): r is ClaimSettingsOverviewRow => !!r),
  }));

  const platformRows = allRows.filter((r) => PLATFORM_LOCKED_ROW_IDS.has(r.id));
  if (platformRows.length) {
    groups.push({
      id: "platform_gates",
      title: "Platform gates (read-only)",
      description: "AI assist, agent filing, and operator PWA policies — platform-controlled.",
      ownerLabel: "Platform settings",
      ownerHref: "/platform/settings/pwa",
      ownerFallback: "Managed by platform admin",
      rowIds: [...PLATFORM_LOCKED_ROW_IDS],
      rows: platformRows,
    });
  }

  return groups;
}
