/**
 * API & Intake Settings inventory — setting → source → job → claim intake effect.
 * Read-only catalog; no secrets.
 */

import type { ClaimIntakeSourceKind } from "./claim-intake-sources";
import { CLAIM_INTAKE_IDEMPOTENCY_STRATEGY } from "./claim-intake-candidate-generators";

export type ApiSettingStorage =
  | "env"
  | "platform_settings.automation_settings"
  | "organization_settings"
  | "stores.marketplaces.credentials"
  | "organization_api_keys"
  | "feature_flag"
  | "none";

export type ApiIntakeSettingEntry = {
  setting_key: string;
  label: string;
  intake_source: ClaimIntakeSourceKind | "product_catalog";
  storage: ApiSettingStorage;
  env_keys?: string[];
  db_path?: string;
  job_or_script: string;
  manual_run: string;
  claim_intake_effect: string;
  schedule_scope?: string;
};

export const API_INTAKE_SETTINGS_INVENTORY: ApiIntakeSettingEntry[] = [
  {
    setting_key: "amazon_sp_api_credentials",
    label: "Amazon SP-API (LWA + refresh token)",
    intake_source: "amazon_return",
    storage: "stores.marketplaces.credentials",
    db_path: "stores.marketplaces(provider=amazon_sp_api).credentials",
    job_or_script: "lib/amazon/reports-api-credentials.ts",
    manual_run: "/platform/settings/automation",
    claim_intake_effect: "Required for Reports API fetch → import sync → domain rows → intake generators.",
  },
  {
    setting_key: "ENABLE_AMAZON_REPORTS_API_WORKER",
    label: "Reports API worker master flag",
    intake_source: "amazon_return",
    storage: "env",
    env_keys: ["ENABLE_AMAZON_REPORTS_API_WORKER"],
    job_or_script: "lib/amazon/reports-api-worker-flags.ts",
    manual_run: "Server env only",
    claim_intake_effect: "Gates all SP-API report pulls (returns, removal, reimbursement, settlement).",
  },
  {
    setting_key: "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER",
    label: "Removal order report API",
    intake_source: "removal",
    storage: "env",
    env_keys: ["ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER"],
    job_or_script: "scripts/sp-api-removal-reports-fetch-execute.ts",
    manual_run: "/platform/settings/automation → Removal order",
    claim_intake_effect: "amazon_removals rows → claim intake via generator (source_table=amazon_removals).",
  },
  {
    setting_key: "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT",
    label: "Removal shipment report API",
    intake_source: "removal",
    storage: "env",
    env_keys: ["ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT"],
    job_or_script: "scripts/sp-api-removal-reports-fetch-execute.ts",
    manual_run: "/platform/settings/automation → Removal shipment",
    claim_intake_effect: "amazon_removal_shipments → claim intake via generator.",
  },
  {
    setting_key: "automation_settings.removal_api_sync",
    label: "Removal API schedule (recent + historical)",
    intake_source: "removal",
    storage: "platform_settings.automation_settings",
    db_path: "platform_settings.automation_settings.scopes[org:store].removal_api_sync",
    job_or_script: "scripts/removal-automation-orchestrator.ts",
    manual_run: "/platform/settings/automation",
    claim_intake_effect: "Scheduled fetch only when enabled; does not auto-run on claim UI load.",
    schedule_scope: "per org/store",
  },
  {
    setting_key: "automation_settings.reimbursements_api",
    label: "Reimbursements API schedule",
    intake_source: "reimbursement",
    storage: "platform_settings.automation_settings",
    db_path: "platform_settings.automation_settings.scopes[org:store].reimbursements_api",
    env_keys: ["ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS"],
    job_or_script: "app/api/settings/imports/sync + Reports API upload",
    manual_run: "/platform/settings/automation → Reimbursements",
    claim_intake_effect: "amazon_reimbursements import → claim_candidate_drafts via intake generator.",
    schedule_scope: "per org/store",
  },
  {
    setting_key: "automation_settings.settlement_api",
    label: "Settlement API schedule",
    intake_source: "settlement",
    storage: "platform_settings.automation_settings",
    db_path: "platform_settings.automation_settings.scopes[org:store].settlement_api",
    env_keys: ["ENABLE_AMAZON_REPORTS_API_SETTLEMENT"],
    job_or_script: "app/api/settings/imports/sync (SETTLEMENT kind)",
    manual_run: "/platform/settings/automation → Settlement",
    claim_intake_effect: "amazon_settlements (claimable rows only) → claim_candidate_drafts.",
    schedule_scope: "per org/store",
  },
  {
    setting_key: "automation_settings.finances_archive_api",
    label: "Finances archive API",
    intake_source: "reimbursement",
    storage: "platform_settings.automation_settings",
    db_path: "platform_settings.automation_settings.scopes[org:store].finances_archive_api",
    env_keys: ["ENABLE_AMAZON_FINANCES_API_WORKER", "ENABLE_AMAZON_FINANCES_API_INGEST"],
    job_or_script: "amazon_finances_source_runs worker",
    manual_run: "/platform/settings/automation → Finances archive",
    claim_intake_effect: "TRID reference edges for drafts; not direct claim_candidates inbox.",
    schedule_scope: "per org/store",
  },
  {
    setting_key: "file_import_returns",
    label: "Returns file import (UniversalImporter)",
    intake_source: "amazon_return",
    storage: "none",
    job_or_script: "app/api/settings/imports/sync (RETURNS kind)",
    manual_run: "/settings/imports",
    claim_intake_effect: "amazon_returns rows → existing claim_candidates path + intake generator.",
  },
  {
    setting_key: "physical_return_scan",
    label: "Physical return scan",
    intake_source: "physical_return",
    storage: "organization_settings",
    db_path: "organization_settings.claim_policy",
    job_or_script: "app/scanner/operator-mobile + lib/returns-manual-claim-grouping.ts",
    manual_run: "/scanner/operator-mobile/scan",
    claim_intake_effect: "return_items → Draft pool (returns-first); not claim_candidates inbox.",
  },
  {
    setting_key: "openai_box_slip",
    label: "OpenAI (box slip / vision parse)",
    intake_source: "physical_return",
    storage: "organization_settings",
    db_path: "organization_settings.credentials.openai_api_key",
    env_keys: ["OPENAI_API_KEY"],
    job_or_script: "app/api/scanner/extract-box-slip/route.ts",
    manual_run: "Scanner slip capture (explicit operator action)",
    claim_intake_effect: "Evidence enrichment for physical returns; not marketplace submit.",
  },
  {
    setting_key: "claim_intake_generator",
    label: "Claim intake candidate generator",
    intake_source: "amazon_return",
    storage: "feature_flag",
    env_keys: ["CLAIM_INTAKE_GENERATOR_CONFIRM_APPLY"],
    job_or_script: "lib/claim-intake-candidate-generators.ts",
    manual_run: "POST /api/claims/intake/generate-candidates (explicit, dry_run default)",
    claim_intake_effect: "Upserts claim_candidate_drafts with idempotency; no auto-run on page load.",
  },
];

export function inventoryForIntakeSource(kind: ClaimIntakeSourceKind): ApiIntakeSettingEntry[] {
  return API_INTAKE_SETTINGS_INVENTORY.filter((e) => e.intake_source === kind);
}

export function sourceToClaimIntakeMap(): Array<{
  claim_source: ClaimIntakeSourceKind;
  import_domain_table: string;
  intake_target: string;
  generator: string;
  idempotency: string;
}> {
  const idem = CLAIM_INTAKE_IDEMPOTENCY_STRATEGY.key;
  return [
    {
      claim_source: "physical_return",
      import_domain_table: "return_items",
      intake_target: "Draft pool (returns-first claim_cases)",
      generator: "lib/returns-manual-claim-grouping.ts",
      idempotency: "manual draft idempotency_key on claim_cases",
    },
    {
      claim_source: "amazon_return",
      import_domain_table: "amazon_returns",
      intake_target: "claim_candidates + claim_candidate_drafts",
      generator: "lib/claim-intake-candidate-generators.ts",
      idempotency: idem,
    },
    {
      claim_source: "removal",
      import_domain_table: "amazon_removals / amazon_removal_shipments",
      intake_target: "claim_candidates + claim_candidate_drafts",
      generator: "lib/claim-intake-candidate-generators.ts",
      idempotency: idem,
    },
    {
      claim_source: "reimbursement",
      import_domain_table: "amazon_reimbursements",
      intake_target: "claim_candidate_drafts",
      generator: "lib/claim-intake-candidate-generators.ts",
      idempotency: idem,
    },
    {
      claim_source: "settlement",
      import_domain_table: "amazon_settlements (claimable filter)",
      intake_target: "claim_candidate_drafts",
      generator: "lib/claim-intake-candidate-generators.ts",
      idempotency: idem,
    },
    {
      claim_source: "manual",
      import_domain_table: "—",
      intake_target: "returns manual draft",
      generator: "app/returns/actions.ts",
      idempotency: "cl:case:manual:…",
    },
  ];
}

export function missingSettingsFromInventory(flags: {
  reports_worker: boolean;
  removal_order: boolean;
  removal_shipment: boolean;
  reimbursements: boolean;
  settlement: boolean;
  finances_ingest: boolean;
  sp_api_credentials_configured: boolean;
}): string[] {
  const missing: string[] = [];
  if (!flags.sp_api_credentials_configured) missing.push("amazon_sp_api_credentials");
  if (!flags.reports_worker) missing.push("ENABLE_AMAZON_REPORTS_API_WORKER");
  if (!flags.removal_order) missing.push("ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER");
  if (!flags.removal_shipment) missing.push("ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT");
  if (!flags.reimbursements) missing.push("ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS");
  if (!flags.settlement) missing.push("ENABLE_AMAZON_REPORTS_API_SETTLEMENT");
  if (!flags.finances_ingest) missing.push("ENABLE_AMAZON_FINANCES_API_INGEST");
  return missing;
}
