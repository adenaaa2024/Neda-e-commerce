"use client";

import type { ClaimPolicyV1 } from "@/lib/claim-policy-types";
import type { ClaimWorkflowSettings } from "@/lib/claim-effective-settings-shared";

export type ClaimSettingsOverviewRow = {
  id: string;
  label: string;
  effective: string;
  source: "platform" | "organization" | "store" | "environment" | "default";
  editability: "customer-editable" | "admin-only" | "locked" | "read-only";
  featureRequired?: string;
  warning?: string | null;
};

function row(
  id: string,
  label: string,
  effective: string,
  source: ClaimSettingsOverviewRow["source"],
  editability: ClaimSettingsOverviewRow["editability"],
  extra?: Partial<ClaimSettingsOverviewRow>,
): ClaimSettingsOverviewRow {
  return { id, label, effective, source, editability, ...extra };
}

export function buildClaimSettingsOverviewRows(input: {
  policy?: ClaimPolicyV1 | null;
  workflow?: ClaimWorkflowSettings | null;
  claimRecoveryEnabled?: boolean;
  autoCreateDrafts?: boolean;
  moduleAccessReason?: string | null;
}): ClaimSettingsOverviewRow[] {
  const p = input.policy;
  const w = input.workflow;

  return [
    row(
      "module_enablement",
      "Module enablement",
      input.claimRecoveryEnabled ? "Claim Recovery enabled" : "Disabled or domain-only",
      "platform",
      "admin-only",
      { featureRequired: "claim_recovery", warning: input.moduleAccessReason },
    ),
    row(
      "sources",
      "Sources",
      Object.entries(p?.enabled_claim_domains ?? {})
        .filter(([, v]) => v)
        .map(([k]) => k.replace(/_/g, " "))
        .join(", ") || "None enabled",
      "organization",
      "customer-editable",
    ),
    row(
      "trigger_modes",
      "Trigger modes",
      input.autoCreateDrafts ? "Auto drafts on scan enabled" : "Manual draft creation",
      "organization",
      "customer-editable",
    ),
    row(
      "filing_deadlines",
      "Filing deadlines",
      p?.claim_eligibility_window_days != null ? `${p.claim_eligibility_window_days} day window` : "Default policy window",
      "organization",
      "customer-editable",
    ),
    row(
      "evidence_requirements",
      "Evidence requirements",
      w?.require_evidence === false ? "Optional" : "Required for promotion",
      "organization",
      "customer-editable",
    ),
    row(
      "product_linkage_requirements",
      "Product linkage requirements",
      w?.require_product_link === false ? "Optional" : "Resolved product required",
      "organization",
      "customer-editable",
    ),
    row(
      "trid_reference_requirements",
      "TRID / reference requirements",
      (p?.claim_hold_policy ?? []).includes("manual_review_required")
        ? "Manual review hold on references"
        : "Standard reference checks",
      "organization",
      "customer-editable",
    ),
    row(
      "submission_rules",
      "Submission rules",
      w?.create_case_when === "manual_only" ? "Manual case creation only" : `Cases when: ${w?.create_case_when ?? "package closed"}`,
      "organization",
      "customer-editable",
    ),
    row(
      "ai_assistant_rules",
      "AI assistant rules",
      "Assistive only — no auto filing",
      "platform",
      "locked",
      { featureRequired: "ai_assistant" },
    ),
    row(
      "amazon_agent_rules",
      "Amazon agent rules",
      "Agent filing gated — manual approval default",
      "platform",
      "admin-only",
      { featureRequired: "ai_agents" },
    ),
    row(
      "orbit_fra_import",
      "ORBIT-FRA import",
      p?.enabled_claim_domains?.financial ? "Financial domain enabled" : "Financial / ORBIT lane off",
      "organization",
      "admin-only",
    ),
    row(
      "automation_schedules",
      "Automation schedules",
      "Platform Automation Center + claim pool generation",
      "platform",
      "admin-only",
    ),
    row(
      "approval_thresholds",
      "Approval thresholds",
      (p?.claim_hold_policy ?? []).length ? p!.claim_hold_policy.join(", ") : "Default holds",
      "organization",
      "customer-editable",
    ),
    row(
      "store_overrides",
      "Store overrides",
      "Per-store automation + intake overrides supported",
      "store",
      "customer-editable",
    ),
    row(
      "role_permissions",
      "Role permissions",
      "Claims settings manage + operator review roles",
      "organization",
      "admin-only",
    ),
  ];
}

export function ClaimSettingsOverviewPanel({
  rows,
}: {
  rows: ClaimSettingsOverviewRow[];
}) {
  return (
    <section className="claim-center-card space-y-4 rounded-xl p-4">
      <div>
        <h3 className="text-sm font-semibold">Settings overview</h3>
        <p className="text-xs opacity-70">
          Read-only effective policy snapshot. Edits happen in workspace or platform settings — not here in V1.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="claim-center-table w-full min-w-[640px] text-sm">
          <thead className="text-xs uppercase opacity-60">
            <tr>
              <th className="px-3 py-2 text-left">Setting</th>
              <th className="px-3 py-2 text-left">Effective value</th>
              <th className="px-3 py-2 text-left">Source</th>
              <th className="px-3 py-2 text-left">Access</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-2.5 align-top">
                  <p className="font-medium">{r.label}</p>
                  {r.featureRequired ? (
                    <p className="text-[10px] opacity-50">Requires: {r.featureRequired}</p>
                  ) : null}
                  {r.warning ? <p className="text-[10px] text-amber-600 dark:text-amber-400">{r.warning}</p> : null}
                </td>
                <td className="px-3 py-2.5 align-top">{r.effective}</td>
                <td className="px-3 py-2.5 align-top capitalize">{r.source}</td>
                <td className="px-3 py-2.5 align-top capitalize">{r.editability.replace(/-/g, " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
