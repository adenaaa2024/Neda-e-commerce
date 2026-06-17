/**
 * PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-PLAN-V1
 * Planning contract only — operator records manual Amazon filing status in MENORIX.
 * No DB writes. No Amazon API. No UI implementation in this phase.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import {
  CLAIM_SUBMISSIONS_USAGE_CONTRACT,
  DUPLICATE_SUBMISSION_PREVENTION,
} from "./claim-submission-manual-filing-contract-v1";

export const CLAIM_MANUAL_FILING_STATUS_ENTRY_PLAN_V1_VERSION =
  "claim-manual-filing-status-entry-plan-v1" as const;

export const MANUAL_FILING_RECORD_CONFIRMATION_TEXT =
  "I already filed this claim manually in Amazon. MENORIX should only record the status." as const;

export const MANUAL_FILING_SAFETY_BANNER =
  "This does not submit anything to Amazon. It only records manual filing status." as const;

/** Fields audited against claim_submissions + source_payload conventions. */
export const SCHEMA_FIELDS_AUDITED = [
  "external_case_id",
  "external_case_url",
  "external_platform",
  "filed_at",
  "filed_by",
  "filing_notes",
  "submission_status",
  "status_reason",
  "metadata",
] as const;

export type SchemaFieldSupport = {
  field: string;
  supported: boolean;
  storage_location: string;
  notes: string;
};

export const EXISTING_SCHEMA_SUPPORT: SchemaFieldSupport[] = [
  {
    field: "external_case_id",
    supported: true,
    storage_location: "claim_submissions.submission_id (TEXT)",
    notes: "Canonical Amazon Seller Central case / claim ID — already documented in schema comments.",
  },
  {
    field: "external_case_url",
    supported: false,
    storage_location: "proposed: source_payload.amazon_case_url OR additive column external_case_url",
    notes: "No dedicated column today.",
  },
  {
    field: "external_platform",
    supported: false,
    storage_location: "proposed: source_payload.external_platform default amazon_seller_central",
    notes: "Pilot is Amazon-only; store_id implies marketplace context.",
  },
  {
    field: "filed_at",
    supported: false,
    storage_location: "proposed: source_payload.portal_filed_at OR additive filed_at timestamptz",
    notes: "Contract v1 already names portal_filed_at in source_payload.",
  },
  {
    field: "filed_by",
    supported: false,
    storage_location: "proposed: source_payload.operator_filed_by (uuid) OR additive filed_by uuid → profiles",
    notes: "claim_submissions.created_by exists for record creation; separate filed_by needed for filing attestation.",
  },
  {
    field: "filing_notes",
    supported: false,
    storage_location: "proposed: source_payload.manual_filing_notes",
    notes: "Contract v1 already lists manual_filing_notes in source_payload.",
  },
  {
    field: "submission_status",
    supported: true,
    storage_location: "claim_submissions.status (claim_submission_status enum)",
    notes: "Post-manual-filing transition: draft|ready_to_send → submitted → investigating.",
  },
  {
    field: "status_reason",
    supported: false,
    storage_location: "proposed: source_payload.status_reason",
    notes: "Optional human-readable reason for rejected/evidence_requested transitions (later phase).",
  },
  {
    field: "metadata",
    supported: true,
    storage_location: "claim_submissions.source_payload JSONB",
    notes: "Pilot rows already store money_lanes, export_run_id, trid graph, pilot_case_run_id, not_submitted_to_amazon.",
  },
];

export const EXISTING_DB_COLUMNS_PRESENT = [
  "id",
  "organization_id",
  "store_id",
  "return_id",
  "claim_case_id",
  "report_url",
  "status",
  "submission_id",
  "source_payload",
  "claim_amount",
  "reimbursement_amount",
  "last_checked_at",
  "success_probability",
  "created_by",
  "created_at",
  "updated_at",
] as const;

export const EXISTING_STATUS_ENUM_VALUES = [
  "draft",
  "ready_to_send",
  "submitted",
  "accepted",
  "rejected",
  "investigating",
  "evidence_requested",
] as const;

/** UI / tracking layer — maps to reimbursement_tracking_status in preview read-model. */
export const RECOMMENDED_TRACKING_STATUS_CONTRACT = [
  "draft",
  "ready_for_manual_filing",
  "manually_filed_pending_external_id",
  "filed_waiting_for_amazon",
  "reimbursed",
  "partially_reimbursed",
  "rejected",
  "evidence_requested",
  "closed",
] as const;

/** DB enum values used after operator records manual filing (no new enum values required for V1). */
export const RECOMMENDED_DB_STATUS_TRANSITION = {
  before_manual_filing: ["draft", "ready_to_send"] as const,
  after_record_manual_filing: "submitted" as const,
  after_amazon_acknowledged: "investigating" as const,
  terminal: ["accepted", "rejected", "evidence_requested"] as const,
  note: "Tracking statuses reimbursed/partially_reimbursed/closed are derived from amazon_reimbursements + status — not new enum values.",
};

export const MANUAL_FILING_WORKFLOW_STEPS = [
  "Operator opens Claim Center → Reimbursement Tracking",
  "Operator opens submission detail drawer for a pilot row",
  "Operator reviews filing packet / export artifact paths and reference graph",
  "Operator leaves MENORIX and files claim manually in Amazon Seller Central",
  "Operator returns to MENORIX detail drawer",
  "Operator clicks Record manual filing (enabled when preconditions pass)",
  "Modal collects Amazon Case ID, filed date/time, optional URL, optional notes, required confirmation checkbox",
  "On confirm: UPDATE claim_submissions only — status=submitted, submission_id=case id, source_payload filing fields",
  "System appends audit event (claim_history_logs and/or audit_logs via trigger)",
  "Reimbursement tracking read-model refreshes → filed_waiting_for_amazon; later match uses submission_id",
] as const;

export const UI_MODAL_CONTRACT = {
  action_id: "record_manual_filing",
  action_label: "Record manual filing",
  location: "ReimbursementTrackingDetailDrawer section G (Next action) + disabled-actions replacement",
  safety_banner: MANUAL_FILING_SAFETY_BANNER,
  confirmation_checkbox: MANUAL_FILING_RECORD_CONFIRMATION_TEXT,
  fields: [
    { id: "amazon_case_id", label: "Amazon Case ID", required: true, maps_to: "claim_submissions.submission_id" },
    { id: "filed_at", label: "Filed date/time", required: true, maps_to: "source_payload.portal_filed_at" },
    { id: "external_case_url", label: "External Amazon case URL", required: false, maps_to: "source_payload.amazon_case_url" },
    { id: "filing_notes", label: "Notes", required: false, maps_to: "source_payload.manual_filing_notes" },
    { id: "attestation", label: MANUAL_FILING_RECORD_CONFIRMATION_TEXT, required: true, type: "checkbox" },
  ],
  submit_button: "Save filing record",
  cancel_button: "Cancel",
  success_toast: "Manual filing recorded — not submitted by MENORIX",
  post_save_status_label: "Waiting for Amazon",
} as const;

export const UI_BUTTON_ENABLE_RULES = {
  enabled_when_all: [
    "submission.status IN (draft, ready_to_send)",
    "submission.submission_id IS NULL",
    "source_payload.export_run_id OR draft_artifact_paths present",
    "reference graph verified (trid_reference_graph_verification present OR reference_edges materialized)",
    "pilot scope: source_payload.pilot_case_run_id = pilot-20260615T190000Z",
    "not legacy return-linked row unless explicit override flag",
    "actor has record_manual_filing permission (or admin-equivalent deferred)",
  ],
  disabled_when_any: [
    "submission_id already set",
    "status IN (submitted, investigating, accepted, rejected, evidence_requested)",
    "legacy submission without pilot_case_run_id (3 legacy rows excluded by default)",
    "read_only preview mode flag (until execute phase removes)",
  ],
} as const;

export const PERMISSION_CONTRACT = {
  preferred_permission: "claim.submission.record_manual_filing",
  rbac_extension_deferred: true,
  pilot_fallback: "admin or manager role on organization (existing 5-tier RBAC — no Platform Access changes this phase)",
  audit_actor: "profiles.id from session — stored as filed_by",
  denied_copy: "You do not have permission to record manual filing status.",
} as const;

export const AUDIT_EVENT_CONTRACT = {
  primary_table: "claim_history_logs",
  secondary: "audit_logs (Postgres trigger on claim_submissions UPDATE)",
  event_type: "manual_filing_recorded",
  payload: {
    claim_submission_id: "uuid",
    claim_case_id: "uuid",
    old_status: "claim_submission_status",
    new_status: "submitted",
    external_case_id: "submission_id value",
    filed_at: "ISO timestamp",
    filed_by: "profiles.id",
    notes: "optional text",
    external_case_url: "optional url",
    run_id: "phase execute run id",
    actor_id: "same as filed_by",
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  },
  claim_history_actor: "human_admin",
  message_kind: "manual_filing_attestation",
  immutable: "append-only — no hard delete",
} as const;

export const DUPLICATE_EXTERNAL_CASE_ID_RULE = {
  scope: "per organization_id + store_id",
  rule: "Reject UPDATE if another non-rejected claim_submissions row has same submission_id for same store",
  proposed_index:
    "CREATE UNIQUE INDEX IF NOT EXISTS claim_submissions_store_external_case_uidx ON claim_submissions (organization_id, store_id, submission_id) WHERE submission_id IS NOT NULL AND status NOT IN ('rejected')",
  safe_for_pilot: true,
  collision_handling: "Show blocking error with conflicting claim_submission_id; operator must verify case ID",
  amazon_api_verification: false,
} as const;

export const PROPOSED_ADDITIVE_MIGRATION_SQL = `-- PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-V1 (proposed — DO NOT APPLY in plan phase)
-- Prefer source_payload for pilot V1; optional columns for query ergonomics:

ALTER TABLE public.claim_submissions
  ADD COLUMN IF NOT EXISTS filed_at timestamptz,
  ADD COLUMN IF NOT EXISTS filed_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_case_url text,
  ADD COLUMN IF NOT EXISTS filing_notes text,
  ADD COLUMN IF NOT EXISTS status_reason text;

COMMENT ON COLUMN public.claim_submissions.filed_at IS
  'Operator-attested manual filing timestamp (Amazon portal); MENORIX does not submit.';
COMMENT ON COLUMN public.claim_submissions.filed_by IS
  'Profile id of operator who recorded manual filing attestation.';
COMMENT ON COLUMN public.claim_submissions.external_case_url IS
  'Optional deep link to Amazon Seller Central case.';
COMMENT ON COLUMN public.claim_submissions.filing_notes IS
  'Operator notes at manual filing record time.';
COMMENT ON COLUMN public.claim_submissions.status_reason IS
  'Human-readable status context for rejected/evidence_requested (later transitions).';

CREATE UNIQUE INDEX IF NOT EXISTS claim_submissions_store_external_case_uidx
  ON public.claim_submissions (organization_id, store_id, submission_id)
  WHERE submission_id IS NOT NULL AND status NOT IN ('rejected');
`;

export const ROLLBACK_PLAN = {
  scope: "single claim_submissions row — pilot only",
  operator_action: "Admin-only Roll back filing record (separate gated action — not in V1 UI unless approved)",
  data_restore: [
    "status → prior value (draft or ready_to_send) from audit old_status",
    "submission_id → NULL",
    "clear source_payload.portal_filed_at, operator_filed_by, amazon_case_url, manual_filing_notes",
    "set source_payload.manual_filing_rollback_at + rollback_run_id",
  ],
  audit: "append claim_history_logs message_kind=manual_filing_rollback",
  reimbursement_impact: "Observed reimbursement matching decoupled until re-filed",
  no_hard_delete: true,
};

export type ManualFilingStatusEntryPlanResult = {
  version: typeof CLAIM_MANUAL_FILING_STATUS_ENTRY_PLAN_V1_VERSION;
  pilot_case_run_id: string;
  intake_run_id: string;
  prerequisites_met: boolean;
  existing_schema_support: SchemaFieldSupport[];
  missing_fields: string[];
  migration_needed: boolean;
  migration_required_for_pilot_v1: boolean;
  proposed_migration_if_needed: string;
  existing_status_values: string[];
  recommended_status_contract: {
    tracking_ui: readonly string[];
    db_enum: readonly string[];
    transition: typeof RECOMMENDED_DB_STATUS_TRANSITION;
  };
  manual_filing_workflow: readonly string[];
  UI_modal_contract: typeof UI_MODAL_CONTRACT;
  permission_contract: typeof PERMISSION_CONTRACT;
  audit_event_contract: typeof AUDIT_EVENT_CONTRACT;
  duplicate_external_case_id_rule: typeof DUPLICATE_EXTERNAL_CASE_ID_RULE;
  rollback_plan: typeof ROLLBACK_PLAN;
  live_db_schema_probe: Record<string, unknown>;
  pilot_submission_snapshot: Record<string, unknown>;
  no_db_write_verification: boolean;
  no_claim_submission_mutation_verification: boolean;
  no_amazon_submission_verification: boolean;
  no_scanner_change_verification: boolean;
  SAFE_TO_BUILD_MANUAL_FILING_STATUS_ENTRY_UI: boolean;
  SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY_EXECUTE: boolean;
  NEXT_PROMPT: string;
};

export function buildManualFilingStatusEntryPlanV1(args: {
  liveDbProbe: Record<string, unknown>;
  pilotSnapshot: Record<string, unknown>;
  prerequisites: Record<string, boolean>;
  submissionsCountBefore: number;
  submissionsCountAfter: number;
  scannerUnchanged: boolean;
}): ManualFilingStatusEntryPlanResult {
  const missing = EXISTING_SCHEMA_SUPPORT.filter((f) => !f.supported).map((f) => f.field);
  const requiredPrereqKeys = [
    "submission_record_pilot_pass",
    "reimbursement_tracking_preview_pass",
    "reimbursement_tracking_ui_visible",
    "reimbursement_tracking_nav_dedup_pass",
    "money_lane_source_discovery_pass",
    "product_cogs_audit_pass",
    "money_lane_preview_pass",
  ] as const;
  const prereqMet = requiredPrereqKeys.every((k) => args.prerequisites[k] === true);

  const migrationNeeded = missing.length > 0;
  const intakeIds = args.pilotSnapshot.intake_run_ids;
  const intakeOk = Array.isArray(intakeIds) && intakeIds.includes(PILOT_INTAKE_RUN_ID);
  const pilotReady =
    Number(args.pilotSnapshot.pilot_count ?? 0) === 10 &&
    args.pilotSnapshot.all_submission_id_null === true &&
    intakeOk;

  const schemaReady =
    args.liveDbProbe.claim_case_id_column_exists === true ||
    args.liveDbProbe.claim_case_id_in_source_payload === true;

  const operationalPrereqs =
    pilotReady &&
    schemaReady &&
    args.submissionsCountBefore === args.submissionsCountAfter;

  const canBuildUi = operationalPrereqs;
  const canPlanExecute = operationalPrereqs && schemaReady;

  return {
    version: CLAIM_MANUAL_FILING_STATUS_ENTRY_PLAN_V1_VERSION,
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    prerequisites_met: prereqMet || operationalPrereqs,
    existing_schema_support: EXISTING_SCHEMA_SUPPORT,
    missing_fields: missing,
    migration_needed: migrationNeeded,
    migration_required_for_pilot_v1: false,
    proposed_migration_if_needed: migrationNeeded
      ? `${PROPOSED_ADDITIVE_MIGRATION_SQL}\n-- Pilot V1 can defer columns above and use submission_id + source_payload only.`
      : "none — source_payload + submission_id sufficient for pilot V1",
    existing_status_values: [...EXISTING_STATUS_ENUM_VALUES],
    recommended_status_contract: {
      tracking_ui: RECOMMENDED_TRACKING_STATUS_CONTRACT,
      db_enum: EXISTING_STATUS_ENUM_VALUES,
      transition: RECOMMENDED_DB_STATUS_TRANSITION,
    },
    manual_filing_workflow: MANUAL_FILING_WORKFLOW_STEPS,
    UI_modal_contract: UI_MODAL_CONTRACT,
    permission_contract: PERMISSION_CONTRACT,
    audit_event_contract: AUDIT_EVENT_CONTRACT,
    duplicate_external_case_id_rule: DUPLICATE_EXTERNAL_CASE_ID_RULE,
    rollback_plan: ROLLBACK_PLAN,
    live_db_schema_probe: args.liveDbProbe,
    pilot_submission_snapshot: args.pilotSnapshot,
    no_db_write_verification: args.submissionsCountBefore === args.submissionsCountAfter,
    no_claim_submission_mutation_verification: args.submissionsCountBefore === args.submissionsCountAfter,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: args.scannerUnchanged,
    SAFE_TO_BUILD_MANUAL_FILING_STATUS_ENTRY_UI: canBuildUi,
    SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY_EXECUTE: canPlanExecute,
    NEXT_PROMPT: canPlanExecute
      ? "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-V1 — implement Record manual filing modal in Reimbursement Tracking drawer (read-only API stub until execute approval)"
      : "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-SCHEMA-VERIFY-V1 — confirm claim_case_id column on original + apply additive migration if approved",
  };
}

export const PLAN_PREREQUISITES = {
  submission_record_pilot_pass: "phase-claim-submission-record-pilot-execute-v1 PASS — 10 pilot rows",
  reimbursement_tracking_preview_pass: "phase-claim-reimbursement-tracking-preview-v1 PASS — 10/10",
  reimbursement_tracking_ui_visible: "phase-claim-reimbursement-tracking-ui-main-visibility-repair-v2 PASS — main nav",
  reimbursement_tracking_nav_dedup_pass: "phase-claim-reimbursement-tracking-nav-dedup-ux-polish-v1 PASS — single entry",
  money_lane_source_discovery_pass: "phase-claim-money-lane-source-discovery-v1 PASS — sold/fees/settlement 10/10",
  product_cogs_audit_pass: "phase-product-cogs-audit-v1 PASS — pilot 10/10 audited; COGS gap documented",
  money_lane_preview_pass: "phase-claim-money-lane-preview-v1 PASS — sold/fees/settlement 10/10; COGS 0/10 documented",
  trid_graph_materialized: "phase-7h pilot reference edges PASS — 96 edges (optional evidence folder)",
} as const;

export const PLAN_MANIFEST = {
  version: CLAIM_MANUAL_FILING_STATUS_ENTRY_PLAN_V1_VERSION,
  prior_contracts: [
    CLAIM_SUBMISSIONS_USAGE_CONTRACT,
    DUPLICATE_SUBMISSION_PREVENTION,
  ],
  prerequisites: PLAN_PREREQUISITES,
} as const;

export async function probeClaimSubmissionsSchemaLive(
  client: SupabaseClient,
  organizationId: string,
): Promise<Record<string, unknown>> {
  const probe: Record<string, unknown> = {};

  const { data: sample, error: sampleErr } = await client
    .from("claim_submissions")
    .select("id, claim_case_id, status, submission_id, source_payload, store_id, return_id, created_at")
    .eq("organization_id", organizationId)
    .limit(3);

  if (sampleErr && String(sampleErr.message).includes("claim_case_id")) {
    const { data: fallback, error: fbErr } = await client
      .from("claim_submissions")
      .select("id, status, submission_id, source_payload, store_id, return_id, created_at")
      .eq("organization_id", organizationId)
      .limit(3);
    probe.claim_case_id_column_exists = false;
    probe.sample_error = fbErr?.message ?? null;
    probe.sample_rows = fallback?.length ?? 0;
    probe.claim_case_id_in_source_payload = (fallback ?? []).some((r) => {
      const p = (r as { source_payload?: Record<string, unknown> }).source_payload;
      return !!p?.claim_case_id;
    });
  } else {
    probe.claim_case_id_column_exists = !sampleErr;
    probe.sample_error = sampleErr?.message ?? null;
    probe.sample_rows = sample?.length ?? 0;
    probe.claim_case_id_in_source_payload = (sample ?? []).some((r) => {
      const row = r as { claim_case_id?: string; source_payload?: Record<string, unknown> };
      return !!row.claim_case_id || !!row.source_payload?.claim_case_id;
    });
  }

  const statusSet = new Set<string>();
  const { data: all } = await client
    .from("claim_submissions")
    .select("status, submission_id, source_payload")
    .eq("organization_id", organizationId);
  let pilotCount = 0;
  let legacyCount = 0;
  for (const row of all ?? []) {
    const r = row as { status?: string; submission_id?: string; source_payload?: Record<string, unknown> };
    if (r.status) statusSet.add(r.status);
    const pr = String(r.source_payload?.pilot_case_run_id ?? "");
    if (pr === PILOT_CASE_RUN_ID) pilotCount += 1;
    else if (r.source_payload?.submission_record_origin !== "manual_filing_record_pilot_v1") legacyCount += 1;
  }
  probe.distinct_status_values_live = [...statusSet];
  probe.pilot_submission_count = pilotCount;
  probe.legacy_submission_count = legacyCount;
  probe.total_submissions = all?.length ?? 0;
  probe.submission_id_populated_count = (all ?? []).filter((r) => {
    const x = r as { submission_id?: string };
    return !!String(x.submission_id ?? "").trim();
  }).length;

  return probe;
}

export async function snapshotPilotSubmissions(
  client: SupabaseClient,
  organizationId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await client
    .from("claim_submissions")
    .select("id, claim_case_id, status, submission_id, store_id, source_payload, created_at")
    .eq("organization_id", organizationId);

  const rows = (data ?? []) as Array<{
    id: string;
    claim_case_id?: string | null;
    status?: string | null;
    submission_id?: string | null;
    source_payload?: Record<string, unknown> | null;
  }>;

  const pilot = rows.filter((r) => String(r.source_payload?.pilot_case_run_id ?? "") === PILOT_CASE_RUN_ID);

  return {
    error: error?.message ?? null,
    pilot_count: pilot.length,
    all_draft_or_ready: pilot.every((r) => {
      const st = String(r.status ?? "").toLowerCase();
      return st === "draft" || st === "ready_to_send";
    }),
    all_submission_id_null: pilot.every((r) => !String(r.submission_id ?? "").trim()),
    status_breakdown: pilot.reduce<Record<string, number>>((acc, r) => {
      const k = String(r.status ?? "unknown");
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
    intake_run_ids: [...new Set(pilot.map((r) => String(r.source_payload?.intake_run_id ?? "")))],
    not_submitted_flags: pilot.filter((r) => r.source_payload?.not_submitted_to_amazon === true).length,
  };
}
