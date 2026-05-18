/**
 * NEXT-CLAIM-FILING-AGENT-06 — Fixture payloads for outbound validator tests (no secrets).
 */

import { CLAIM_FILING_OUTBOUND_SCHEMA_VERSION } from "./claim-filing-outbound-types";

const BASE_IDS = {
  filing_request_id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
  store_id: "33333333-3333-4333-8333-333333333333",
  outbound_delivery_id: "44444444-4444-4444-8444-444444444444",
  callback_correlation_id: "55555555-5555-4555-8555-555555555555",
  work_item_id: "66666666-6666-4666-8666-666666666666",
  draft_id: "77777777-7777-4777-8777-777777777777",
};

const filingInstructions = {
  allowed_actions: ["prepare_evidence_package", "return_callback"],
  marketplace_submission_allowed: false,
  requires_operator_confirmation_before_submit: true,
  no_live_submission_reason: "Agent 06 stub: no live submission path.",
} as const;

const evidenceManifest = {
  evidence_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  generated_at: "2026-05-15T12:00:00.000Z",
  redaction_profile: "claim-filing-v1",
} as const;

function idempotency(frk: string) {
  return {
    filing_request_idempotency_key: frk,
    outbound_delivery_id: BASE_IDS.outbound_delivery_id,
    callback_correlation_id: BASE_IDS.callback_correlation_id,
    payload_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  };
}

function claimContext(overrides?: Partial<{ work: string | null; draft: string | null; sub: string | null }>) {
  return {
    claim_review_work_item_id: overrides?.work ?? BASE_IDS.work_item_id,
    claim_candidate_draft_id: overrides?.draft ?? BASE_IDS.draft_id,
    claim_submission_id: overrides?.sub ?? null,
    claim_family_key: "removal_fee",
    source_table: "amazon_removals",
    source_row_id: "op-row-1",
    order_id: "111-1234567-1234567",
    sku: "SKU-1",
  };
}

const evidencePackage = {
  pdf_refs: [
    {
      kind: "claim_report_pdf",
      artifact_ref: "storage:pdf-handle-1",
      content_sha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      generated_at: "2026-05-15T12:00:00.000Z",
      expires_at: null,
    },
  ],
  artifact_refs: [] as const,
  manifest: evidenceManifest,
} as const;

/** Single TRID candidate; selection none — valid prepare path. */
export const OUTBOUND_FIXTURE_DETERMINISTIC_TRID = {
  schema_version: CLAIM_FILING_OUTBOUND_SCHEMA_VERSION,
  filing_request_id: BASE_IDS.filing_request_id,
  organization_id: BASE_IDS.organization_id,
  store_id: BASE_IDS.store_id,
  environment: "sandbox" as const,
  automation_mode: "prepare_only" as const,
  lease_context: null,
  idempotency: idempotency("idem-deterministic-1"),
  claim_context: claimContext(),
  filing_instructions: filingInstructions,
  evidence_package: evidencePackage,
  payload: {
    trid: {
      trid_candidates: [
        {
          trid_key: "internal|line|1",
          source_table: "financial_reference_resolver",
          source_row_id: "frr-1",
          settlement_id: "s-1",
          order_id: "111-1234567-1234567",
          sku: "SKU-1",
          confidence_score: 0.9,
          reference_group_key: null,
          transaction_type: null,
        },
      ],
      trid_operator_selected: null,
      trid_selection_status: "none" as const,
      trid_selected_by: null,
      trid_selected_at: null,
      trid_source_run_id: "fixture-deterministic",
      reference_graph_generation: 1,
    },
  },
};

/** Two candidates; pending_operator — valid (no auto-select). */
export const OUTBOUND_FIXTURE_AMBIGUOUS_TRID = {
  ...OUTBOUND_FIXTURE_DETERMINISTIC_TRID,
  idempotency: idempotency("idem-ambiguous-1"),
  payload: {
    trid: {
      trid_candidates: [
        {
          trid_key: "internal|a",
          source_table: "financial_reference_resolver",
          source_row_id: "frr-a",
          settlement_id: "s-a",
          order_id: "111-1234567-1234567",
          sku: "SKU-1",
          confidence_score: 0.7,
          reference_group_key: "g1",
          transaction_type: null,
        },
        {
          trid_key: "internal|b",
          source_table: "financial_reference_resolver",
          source_row_id: "frr-b",
          settlement_id: "s-b",
          order_id: "111-1234567-1234567",
          sku: "SKU-1",
          confidence_score: 0.65,
          reference_group_key: "g1",
          transaction_type: null,
        },
      ],
      trid_operator_selected: null,
      trid_selection_status: "pending_operator" as const,
      trid_selected_by: null,
      trid_selected_at: null,
      trid_source_run_id: "fixture-ambiguous",
      reference_graph_generation: 1,
    },
  },
};

/** Missing FRR path: empty candidates, skipped. */
export const OUTBOUND_FIXTURE_MISSING_TRID_SKIPPED = {
  ...OUTBOUND_FIXTURE_DETERMINISTIC_TRID,
  idempotency: idempotency("idem-missing-skipped-1"),
  payload: {
    trid: {
      trid_candidates: [],
      trid_operator_selected: null,
      trid_selection_status: "skipped_no_reference" as const,
      trid_selected_by: null,
      trid_selected_at: null,
      trid_source_run_id: "fixture-missing",
      reference_graph_generation: null,
    },
  },
};

/** operator_selected but wrong candidate — invalid. */
export const OUTBOUND_FIXTURE_INVALID_OPERATOR_SELECTED = {
  ...OUTBOUND_FIXTURE_DETERMINISTIC_TRID,
  idempotency: idempotency("idem-invalid-sel-1"),
  payload: {
    trid: {
      trid_candidates: [
        {
          trid_key: "internal|line|1",
          source_table: "financial_reference_resolver",
          source_row_id: "frr-1",
          settlement_id: "s-1",
          order_id: "111-1234567-1234567",
          sku: "SKU-1",
          confidence_score: 0.9,
          reference_group_key: null,
          transaction_type: null,
        },
      ],
      trid_operator_selected: {
        trid_key: "not-in-list",
        source_table: "financial_reference_resolver",
        source_row_id: "x",
        settlement_id: null,
        order_id: null,
        sku: null,
        confidence_score: null,
        reference_group_key: null,
        transaction_type: null,
      },
      trid_selection_status: "operator_selected" as const,
      trid_selected_by: "88888888-8888-4888-8888-888888888888",
      trid_selected_at: "2026-05-15T12:00:00.000Z",
      trid_source_run_id: "fixture-invalid",
      reference_graph_generation: 1,
    },
  },
};

/** Wrong schema version. */
export const OUTBOUND_FIXTURE_INVALID_SCHEMA = {
  ...OUTBOUND_FIXTURE_DETERMINISTIC_TRID,
  schema_version: "wrong-schema",
};

/** marketplace_submission_allowed true — invalid. */
export const OUTBOUND_FIXTURE_INVALID_SUBMISSION_FLAG = {
  ...OUTBOUND_FIXTURE_DETERMINISTIC_TRID,
  filing_instructions: {
    ...filingInstructions,
    marketplace_submission_allowed: true,
  },
};
