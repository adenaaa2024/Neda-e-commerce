/**
 * PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-V1 — server composer (read-only).
 *
 * Loads the 10 pilot Ready-to-File claims, runs the family-aware engine, and converts
 * every cross-family "separate claim" suggestion into a per-family claim-candidate
 * preview via the pure generator contract. Removal pilot claims are never modified;
 * cross-family candidates never reduce removal open gaps. Compose-only — NO writes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../filing/claim-ready-to-file-queue-v1";
import { computeFamilyAwareRecovery } from "../filing/claim-ready-to-file-queue-ui-contract";
import {
  buildSeparateFamilyCandidatePreviews,
  GENERATOR_SUPPORT_MATRIX,
  type GeneratorClaimInput,
  type GeneratorFamilySupport,
  type SeparateFamilyCandidatePreviewResult,
} from "./separate-family-candidate-generator-contract-v1";
import { readSeparateFamilyGeneratorApproval, type SeparateFamilyGeneratorApproval } from "./separate-family-candidate-generators-write-v1";

export type SeparateFamilyOpportunitiesPayload = SeparateFamilyCandidatePreviewResult & {
  route: string;
  read_only: true;
  does_not_write: true;
  mode: "preview" | "execute";
  approval_status: SeparateFamilyGeneratorApproval;
  generator_support_matrix: readonly GeneratorFamilySupport[];
  removal_pilot_open_gap_total: number | null;
  removal_pilot_claim_count: number;
};

export async function composeSeparateFamilyCandidateGeneratorsV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  opts: { pilot_case_run_id?: string; intake_run_id?: string } = {},
): Promise<SeparateFamilyOpportunitiesPayload> {
  const queue = await composeClaimReadyToFileQueueV1(client, organizationId, storeId, opts);
  const rows = [...queue.ready_rows, ...queue.blocked_rows];

  const inputs: GeneratorClaimInput[] = [];
  let removalOpenGap = 0;
  let removalCount = 0;
  for (const r of rows) {
    const fa = computeFamilyAwareRecovery(r);
    removalCount += 1;
    removalOpenGap += fa.open_gap_under_current_policy ?? 0;
    const ledger = r.event_reference_ledger;
    const anchors = [
      ...(ledger.removal_order_refs ?? []),
      ...(ledger.removal_shipment_refs ?? []),
      r.product_identity.fnsku ?? "",
    ].filter(Boolean);
    inputs.push({
      claim_submission_id: r.claim_submission_id,
      claim_family: r.claim_family ?? "other",
      product_identity: {
        fnsku: r.product_identity.fnsku,
        sku: r.product_identity.sku,
        asin: r.product_identity.asin,
        resolved_product_id: r.product_identity.resolved_product_id,
      },
      anchors,
      misclassified: fa.misclassified_candidates,
      scanner_only: r.scanner_only,
    });
  }

  const result = buildSeparateFamilyCandidatePreviews(inputs);
  const approval = readSeparateFamilyGeneratorApproval();

  return {
    ...result,
    route: "/api/claims/center/separate-family-opportunities",
    read_only: true,
    does_not_write: true,
    mode: "preview",
    approval_status: approval,
    generator_support_matrix: GENERATOR_SUPPORT_MATRIX,
    removal_pilot_open_gap_total: Math.round(removalOpenGap * 100) / 100,
    removal_pilot_claim_count: removalCount,
  };
}
