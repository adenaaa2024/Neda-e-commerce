/**
 * NEXT-CLAIM-FILING-AGENT-06 — Outbound filing adapter payload types (claim-filing-outbound-v1).
 * No I/O; safe to import from validators and tests.
 */

import type { TridFilingPayloadExtension } from "./claim-trid-candidates-types";

export const CLAIM_FILING_OUTBOUND_SCHEMA_VERSION = "claim-filing-outbound-v1" as const;

export type ClaimFilingOutboundEnvironment = "sandbox" | "production";

/** Mirrors `claim_filing_requests.automation_mode` CHECK; outbound rejects `full_auto_reserved`. */
export type ClaimFilingOutboundAutomationMode =
  | "disabled"
  | "manual_only"
  | "prepare_only"
  | "submit_with_confirmation"
  | "full_auto_reserved";

export type ClaimFilingOutboundLeaseContext = {
  readonly lease_holder: string;
  readonly lease_expires_at: string;
  readonly lease_attempt?: number | null;
  readonly worker_pool?: string | null;
  readonly pickup_contract_source?: string | null;
};

export type ClaimFilingOutboundIdempotency = {
  readonly filing_request_idempotency_key: string;
  readonly outbound_delivery_id: string;
  readonly callback_correlation_id: string;
  readonly payload_hash: string;
  readonly retry_attempt?: number | null;
};

export type ClaimFilingOutboundClaimContext = {
  readonly claim_review_work_item_id: string | null;
  readonly claim_candidate_draft_id: string | null;
  readonly claim_submission_id: string | null;
  readonly claim_family_key?: string | null;
  readonly source_table: string;
  readonly source_row_id: string;
  readonly order_id?: string | null;
  readonly sku?: string | null;
};

export type ClaimFilingOutboundFilingInstructions = {
  readonly allowed_actions: readonly string[];
  readonly marketplace_submission_allowed: boolean;
  readonly requires_operator_confirmation_before_submit: boolean;
  readonly no_live_submission_reason?: string | null;
};

export type ClaimFilingOutboundPdfRef = {
  readonly kind: string;
  readonly artifact_ref: string;
  readonly content_sha256?: string | null;
  readonly generated_at?: string | null;
  readonly expires_at?: string | null;
};

export type ClaimFilingOutboundArtifactRef = {
  readonly kind: string;
  readonly artifact_ref: string;
  readonly source?: string | null;
  readonly content_sha256?: string | null;
  readonly mime_type?: string | null;
};

export type ClaimFilingOutboundEvidencePackage = {
  readonly pdf_refs: readonly ClaimFilingOutboundPdfRef[];
  readonly artifact_refs: readonly ClaimFilingOutboundArtifactRef[];
  readonly manifest: {
    readonly evidence_hash: string;
    readonly generated_at: string;
    readonly redaction_profile: string;
    readonly source_citations?: readonly unknown[];
  };
};

export type ClaimFilingOutboundPayloadV1 = {
  readonly schema_version: typeof CLAIM_FILING_OUTBOUND_SCHEMA_VERSION;
  readonly filing_request_id: string;
  readonly organization_id: string;
  readonly store_id: string;
  readonly environment: ClaimFilingOutboundEnvironment;
  readonly automation_mode: ClaimFilingOutboundAutomationMode;
  readonly lease_context: ClaimFilingOutboundLeaseContext | null;
  readonly idempotency: ClaimFilingOutboundIdempotency;
  readonly claim_context: ClaimFilingOutboundClaimContext;
  readonly filing_instructions: ClaimFilingOutboundFilingInstructions;
  readonly evidence_package: ClaimFilingOutboundEvidencePackage;
  readonly payload: {
    readonly trid?: TridFilingPayloadExtension | null;
  };
};
