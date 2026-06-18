/**
 * PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-V1 — pure generator contract.
 *
 * Converts family-aware "separate claim" suggestions (cross-family weak candidates
 * that must NOT pollute removal_shipment_missing / removal_order_discrepancy claims)
 * into per-family claim-candidate PREVIEWS. Pure + deterministic. Imports only from
 * the client-safe queue ui-contract (which itself imports nothing) so it stays safe
 * for any bundle. NO DB, NO Amazon, NO scanner, NO AI.
 */
import {
  getClaimAmountPolicy,
  type AmountBasis,
  type FamilyCandidateClassification,
} from "../filing/claim-ready-to-file-queue-ui-contract";

export const SEPARATE_FAMILY_GENERATOR_V1 = "separate-family-candidate-generator-v1";

/** Removal families are the current pilot claims — never generated here, only protected. */
export const PILOT_REMOVAL_FAMILIES = ["removal_shipment_missing", "removal_order_discrepancy", "removal_short_shipped"] as const;

/** Maps the engine source_group (and kind) to the real Amazon source table. */
export const SOURCE_TABLE_BY_GROUP: Record<string, string> = {
  reimbursement: "amazon_reimbursements",
  transaction_settlement: "amazon_settlement_transactions",
  inventory_ledger: "inventory_ledger_detail",
  customer_return: "amazon_returns",
  removal: "amazon_removal_order_detail",
  shipment_tracking: "amazon_removal_shipment_detail",
};

export type GeneratorFamilySupport = {
  family_key: string;
  display_name: string;
  basis: AmountBasis;
  /** Source group/table evidence a real candidate of this family must come from. */
  required_source_group: string;
  required_source_table: string | null;
  /** Strict evidence rule enforced before this family can be written. */
  evidence_rule: string;
  /** Whether the amount basis is operator-resolved (else needs policy confirmation). */
  policy_resolved: boolean;
};

/** Families this phase supports generating/previewing (engine classification namespace). */
export const GENERATOR_SUPPORTED_FAMILIES: readonly string[] = [
  "damaged_warehouse",
  "lost_warehouse",
  "lost_outbound",
  "damaged_outbound",
  "reimbursement_reversal",
  "refund_without_return",
  "customer_return_not_restocked",
  "customer_return_not_received",
  "fulfillment_fee_overcharge",
  "storage_fee_overcharge",
  "inbound_discrepancy",
  "disposed_without_authorization",
  "expiration_misclassification",
];

const FAMILY_REQUIRED_GROUP: Record<string, string> = {
  damaged_warehouse: "inventory_ledger",
  lost_warehouse: "inventory_ledger",
  lost_outbound: "transaction_settlement",
  damaged_outbound: "transaction_settlement",
  reimbursement_reversal: "reimbursement",
  refund_without_return: "customer_return",
  customer_return_not_restocked: "customer_return",
  customer_return_not_received: "customer_return",
  fulfillment_fee_overcharge: "transaction_settlement",
  storage_fee_overcharge: "transaction_settlement",
  inbound_discrepancy: "shipment_tracking",
  disposed_without_authorization: "inventory_ledger",
  expiration_misclassification: "inventory_ledger",
};

const FAMILY_EVIDENCE_RULE: Record<string, string> = {
  reimbursement_reversal: "Must pair with the original reimbursement (reinstate the exact reversed amount); not COGS-based.",
  refund_without_return: "Must come from returns/refunds with a return anti-match (refund without matching return).",
  customer_return_not_restocked: "Must come from customer return / return-items evidence (returned but not restocked).",
  customer_return_not_received: "Must come from order/return evidence (refunded/returned but unit never received back).",
  fulfillment_fee_overcharge: "Fee overcharge must come from transaction/settlement fee rows (charged vs expected fee).",
  storage_fee_overcharge: "Storage overcharge must come from monthly storage fee rows + cubic volume.",
  damaged_warehouse: "Must come from inventory ledger adjustment (warehouse damage) with reference id.",
  lost_warehouse: "Must come from inventory ledger adjustment (warehouse loss) with reference id.",
  lost_outbound: "Must come from outbound shipment/settlement evidence of a lost unit.",
  damaged_outbound: "Must come from outbound shipment/settlement evidence of a damaged unit.",
  inbound_discrepancy: "Must come from inbound shipment shortage (sent vs received) evidence.",
  disposed_without_authorization: "Must come from inventory ledger disposal evidence without authorization.",
  expiration_misclassification: "Basis undefined — needs operator policy before any claim amount.",
};

export function getGeneratorFamilySupport(family: string): GeneratorFamilySupport {
  const pol = getClaimAmountPolicy(family);
  const group = FAMILY_REQUIRED_GROUP[family] ?? "transaction_settlement";
  return {
    family_key: family,
    display_name: pol.display_name,
    basis: pol.default_claim_amount_basis,
    required_source_group: group,
    required_source_table: SOURCE_TABLE_BY_GROUP[group] ?? null,
    evidence_rule: FAMILY_EVIDENCE_RULE[family] ?? "Confirm amount basis + source evidence before filing.",
    policy_resolved: pol.policy_resolved,
  };
}

export const GENERATOR_SUPPORT_MATRIX: readonly GeneratorFamilySupport[] = GENERATOR_SUPPORTED_FAMILIES.map(
  getGeneratorFamilySupport,
);

export type GeneratorProductIdentity = {
  fnsku: string | null;
  sku: string | null;
  asin: string | null;
  resolved_product_id: string | null;
};

export type SeparateFamilyCandidatePreview = {
  preview_id: string;
  recommended_claim_family: string;
  family_display_name: string;
  source_table: string | null;
  source_row_id: string | null;
  source_group: string;
  source_kind: string;
  event_type_reason: string | null;
  event_date: string | null;
  product_identity: GeneratorProductIdentity;
  quantity: number | null;
  amount: number | null;
  matched_references: string[];
  family_classification_reason: string;
  claim_amount_basis: AmountBasis;
  expected_claim_amount: number | null;
  reimbursement_matching_status: string;
  separate_from_removal_reason: string;
  confidence: "high" | "medium" | "low";
  blockers: string[];
  writeable: boolean;
  origin_claim_submission_id: string;
  origin_claim_family: string;
};

export type GeneratorClaimInput = {
  claim_submission_id: string;
  claim_family: string;
  product_identity: GeneratorProductIdentity;
  anchors: string[];
  misclassified: FamilyCandidateClassification[];
  /** True when the originating claim's source is scanner/OCR only (rule: never generate from it). */
  scanner_only: boolean;
};

export type SeparateFamilyCandidatePreviewResult = {
  version: string;
  suggestions_input_count: number;
  candidates: SeparateFamilyCandidatePreview[];
  family_counts: Record<string, number>;
  blockers_by_family: Record<string, Record<string, number>>;
  writeable_count: number;
  unsupported_families: string[];
};

function hasProductIdentity(p: GeneratorProductIdentity): boolean {
  return Boolean(p.fnsku || p.sku || p.asin || p.resolved_product_id);
}

function reimbursementStatusFor(c: FamilyCandidateClassification): string {
  if (c.kind === "reimbursement" || c.source_group === "reimbursement") {
    return c.reason && /reversal/i.test(c.reason)
      ? "reversed_reimbursement_observed (needs original pairing)"
      : "reimbursement_row_observed (weak/date-window — not order-linked)";
  }
  return "unknown_unmatched (no order-linked reimbursement for this family)";
}

function expectedAmountFor(family: string, basis: AmountBasis, c: FamilyCandidateClassification): { amount: number | null; blocker: string | null } {
  const pol = getClaimAmountPolicy(family);
  if (!pol.policy_resolved) {
    return { amount: null, blocker: "amount_basis_needs_policy_confirmation" };
  }
  // Resolved families (reimbursement_reversal / refund / fee) derive amount from the source row.
  if (basis === "reimbursement_reinstatement") {
    return c.amount != null
      ? { amount: Math.abs(c.amount), blocker: null }
      : { amount: null, blocker: "reversed_amount_missing" };
  }
  if (basis === "refund_amount") {
    return c.amount != null ? { amount: Math.abs(c.amount), blocker: null } : { amount: null, blocker: "refund_amount_missing" };
  }
  if (basis === "fee_delta") {
    // Need expected fee from Fee Preview / Product Fees API — not available read-only yet.
    return { amount: null, blocker: "fee_expected_value_unavailable_needs_fees_api" };
  }
  return { amount: null, blocker: "amount_basis_not_implemented_preview_only" };
}

/**
 * Builds per-family separate claim-candidate previews from family-aware suggestions.
 * Deduplicates across claims by (family + source_table + source_row_id). Enforces:
 * never merge into removal, require product identity, never from scanner/OCR, fee/
 * return/reversal source-evidence rules, and policy-confirmation gating.
 */
export function buildSeparateFamilyCandidatePreviews(
  inputs: GeneratorClaimInput[],
): SeparateFamilyCandidatePreviewResult {
  const byId = new Map<string, SeparateFamilyCandidatePreview>();
  const unsupported = new Set<string>();
  let suggestionsInput = 0;

  for (const input of inputs) {
    for (const c of input.misclassified) {
      if (!c.should_create_separate_claim) continue;
      suggestionsInput += 1;
      const family = c.classified_family;
      if (!GENERATOR_SUPPORTED_FAMILIES.includes(family)) {
        unsupported.add(family);
      }
      const support = getGeneratorFamilySupport(family);
      const basis = support.basis;
      const sourceTable = SOURCE_TABLE_BY_GROUP[c.source_group] ?? null;
      const previewId = `${family}::${c.source_group}::${c.reference_id}`;

      const blockers: string[] = [];
      // Strict rules.
      if (!hasProductIdentity(input.product_identity)) blockers.push("missing_product_identity");
      if (input.scanner_only) blockers.push("scanner_or_ocr_only_excluded");
      if (!GENERATOR_SUPPORTED_FAMILIES.includes(family)) blockers.push("family_not_supported_by_generator");
      // Source-evidence rules per family.
      if (c.source_group !== support.required_source_group) {
        blockers.push(`source_group_mismatch_expected_${support.required_source_group}`);
      }
      if (family === "reimbursement_reversal" && !(c.reason && /reversal/i.test(c.reason))) {
        blockers.push("needs_original_reimbursement_pairing");
      }

      const expected = expectedAmountFor(family, basis, c);
      if (expected.blocker) blockers.push(expected.blocker);

      const confidence: SeparateFamilyCandidatePreview["confidence"] =
        c.reference_id && c.reason && /reversal|refund|damaged|lost|fee|storage|return|dispos|expir/i.test(c.reason)
          ? "medium"
          : c.reference_id
            ? "low"
            : "low";

      const candidate: SeparateFamilyCandidatePreview = {
        preview_id: previewId,
        recommended_claim_family: family,
        family_display_name: support.display_name,
        source_table: sourceTable,
        source_row_id: c.reference_id || null,
        source_group: c.source_group,
        source_kind: c.kind,
        event_type_reason: c.reason,
        event_date: c.event_date,
        product_identity: input.product_identity,
        quantity: c.quantity,
        amount: c.amount,
        matched_references: [c.reference_id, ...input.anchors].filter(Boolean),
        family_classification_reason: c.why_not ?? `Classified as '${family}' from ${c.source_label}.`,
        claim_amount_basis: basis,
        expected_claim_amount: expected.amount,
        reimbursement_matching_status: reimbursementStatusFor(c),
        separate_from_removal_reason: `Belongs to '${family}' (group ${c.source_group}), a different family than the removal claim '${input.claim_family}' it was surfaced under — must be its own claim and must not reduce the removal open gap.`,
        confidence,
        blockers,
        writeable: blockers.length === 0 && support.policy_resolved,
        origin_claim_submission_id: input.claim_submission_id,
        origin_claim_family: input.claim_family,
      };

      // Dedup: keep the most complete (fewest blockers / has amount) per source row.
      const prior = byId.get(previewId);
      if (!prior || (prior.expected_claim_amount == null && candidate.expected_claim_amount != null) || candidate.blockers.length < prior.blockers.length) {
        byId.set(previewId, candidate);
      }
    }
  }

  const candidates = [...byId.values()].sort((a, b) =>
    a.recommended_claim_family === b.recommended_claim_family
      ? (a.source_row_id ?? "").localeCompare(b.source_row_id ?? "")
      : a.recommended_claim_family.localeCompare(b.recommended_claim_family),
  );

  const family_counts: Record<string, number> = {};
  const blockers_by_family: Record<string, Record<string, number>> = {};
  let writeable_count = 0;
  for (const c of candidates) {
    family_counts[c.recommended_claim_family] = (family_counts[c.recommended_claim_family] ?? 0) + 1;
    if (c.writeable) writeable_count += 1;
    const fb = (blockers_by_family[c.recommended_claim_family] ??= {});
    for (const b of c.blockers) fb[b] = (fb[b] ?? 0) + 1;
  }

  return {
    version: SEPARATE_FAMILY_GENERATOR_V1,
    suggestions_input_count: suggestionsInput,
    candidates,
    family_counts,
    blockers_by_family,
    writeable_count,
    unsupported_families: [...unsupported],
  };
}
