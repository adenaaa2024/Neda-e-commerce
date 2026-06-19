/**
 * Smoke test — PHASE-CLAIM-READY-TO-FILE-QUEUE-UI-V1
 *
 * Static contract checks only (no DB, no network): verifies the read-model is
 * read-only / AI-free, reuses the existing composers, defines the audit gates,
 * exposes a guarded Case ID recording section, and that the route/nav/page wiring
 * exists. Exits non-zero on any violation.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLAIM_AMOUNT_POLICY_MATRIX,
  CLAIM_READY_TO_FILE_QUEUE_V1,
  DEFAULT_READY_TO_FILE_FILTERS,
  READY_TO_FILE_ELIGIBLE_FAMILIES,
  buildReferenceBlockText,
  classifyCandidateFamily,
  computeFamilyAwareRecovery,
  computeFilingDecision,
  computeRecoveryGap,
  computeRemovalOriginReason,
  filterReadyToFileRows,
  summarizeRecoveryGap,
  type FamilyCandidateClassification,
  type ReadyToFileRow,
  type RemovalOriginInputs,
} from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
import {
  GENERATOR_SUPPORTED_FAMILIES,
  buildSeparateFamilyCandidatePreviews,
  type GeneratorClaimInput,
} from "../lib/claims/opportunities/separate-family-candidate-generator-contract-v1";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`SMOKE FAIL: ${msg}`);
    process.exit(1);
  }
}

const cwd = process.cwd();

// ---- Version + constants ----
assert(CLAIM_READY_TO_FILE_QUEUE_V1 === "claim-ready-to-file-queue-v1", "version constant mismatch");
assert(
  READY_TO_FILE_ELIGIBLE_FAMILIES.includes("removal_shipment_missing") &&
    READY_TO_FILE_ELIGIBLE_FAMILIES.includes("removal_order_discrepancy"),
  "eligible families must be removal_shipment_missing + removal_order_discrepancy",
);
assert(DEFAULT_READY_TO_FILE_FILTERS.status === "all", "default filter status must be 'all'");

// ---- Files exist ----
const libPath = join(cwd, "lib/claims/filing/claim-ready-to-file-queue-v1.ts");
const apiPath = join(cwd, "app/api/claims/center/ready-to-file/route.ts");
const pagePath = join(cwd, "app/claim-center/ready-to-file/page.tsx");
const viewPath = join(cwd, "components/claim-center/ready-to-file/ReadyToFileView.tsx");
const drawerPath = join(cwd, "components/claim-center/ready-to-file/ReadyToFileDetailDrawer.tsx");
for (const [p, label] of [
  [libPath, "read-model lib"],
  [apiPath, "api route"],
  [pagePath, "page"],
  [viewPath, "view"],
  [drawerPath, "detail drawer"],
] as const) {
  assert(existsSync(p), `${label} missing`);
}

// ---- Read-only: no write ops, no AI in the lib ----
const libSrc = readFileSync(libPath, "utf8");
assert(
  !/\.update\(|\.insert\(|\.delete\(|\.upsert\(/.test(libSrc),
  "read-model lib must not contain any write operation",
);
assert(
  !/openai|gpt-|anthropic|claude|chat\.completions|generateText/i.test(libSrc),
  "read-model lib must not use AI/GPT",
);
assert(libSrc.includes("composeClaimSellerCentralFilingPacketV1"), "lib must reuse seller-central packet composer");
assert(libSrc.includes("composeMoneyLanePreviewAfterCogsV1"), "lib must reuse money-lane-after-cogs composer");
assert(libSrc.includes("composeTridReferenceTraceMatrixV1"), "lib must reuse TRID trace matrix composer");

// ---- Audit gates present ----
for (const gate of [
  "family_eligible",
  "not_scanner_or_ocr_only",
  "deterministic_reference_graph",
  "has_cogs",
  "has_recovery_value",
  "has_trid_anchor",
  "has_family_specific_removal_reference",
  "has_filing_packet_evidence",
  "no_fake_scan_codes",
  "no_simulated_case_ids",
  "no_sale_price_as_amount",
  "has_external_source_reference",
]) {
  assert(libSrc.includes(`"${gate}"`), `audit gate '${gate}' must be defined`);
}
assert(
  libSrc.includes("composeClaimEventReferenceLedgerForTrace"),
  "lib must build the Event Reference Ledger",
);

// ---- Guarded Case ID recording: never submits to Amazon ----
assert(libSrc.includes("does_not_submit_to_amazon: true"), "case-id recording must declare does_not_submit_to_amazon");
assert(libSrc.includes("write_guarded: true"), "case-id recording must be write_guarded");
assert(
  libSrc.includes("PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1"),
  "case-id recording must route writes through the governed phase",
);

// ---- Drawer: Seller Central copy buttons + disabled Save ----
const drawerSrc = readFileSync(drawerPath, "utf8");
assert(drawerSrc.includes("Copy subject"), "drawer must expose Copy subject");
assert(drawerSrc.includes("Copy message"), "drawer must expose Copy message");
assert(drawerSrc.includes("Copy reference block"), "drawer must expose Copy reference block");
assert(drawerSrc.includes("Open evidence packet"), "drawer must expose Open evidence packet");
// ---- Reference correctness: renamed anchor + event/transaction table + collapsed internal anchors ----
assert(drawerSrc.includes("Primary reference anchor"), "drawer must rename 'Primary TRID anchor' to 'Primary reference anchor'");
assert(!/Primary TRID anchor/.test(drawerSrc), "drawer must NOT label the anchor 'Primary TRID anchor'");
assert(drawerSrc.includes("Event / Transaction References"), "drawer must render the Event / Transaction References section");
assert(drawerSrc.includes("Internal anchors (debug"), "drawer must keep internal DB ids in a collapsed Internal anchors section");
assert(drawerSrc.includes("References to include in Seller Central"), "drawer must label the external-only reference block");
// ---- Deep reference ledger: source groups + per-source status + coverage badge + not-found list ----
assert(drawerSrc.includes("SOURCE_STATUS_META") && drawerSrc.includes("source_groups"), "drawer must render per-source-group status");
assert(drawerSrc.includes("COVERAGE_META") && drawerSrc.includes("filing_sufficiency"), "drawer must render the Deep reference coverage badge");
assert(drawerSrc.includes("Not found / not applicable"), "drawer must render the Not found / not applicable summary");
assert(/Event-date window used/.test(drawerSrc), "drawer must report whether the event-date window was used");
assert(libSrc.includes("deep_reference_census"), "lib payload must expose the deep_reference_census");
// ---- Filing decision: drawer section + per-row badge ----
assert(drawerSrc.includes("Filing Decision") && drawerSrc.includes("computeFilingDecision"), "drawer must render the Filing Decision section");
assert(drawerSrc.includes("High-confidence references used") && drawerSrc.includes("Weak references excluded"), "drawer Filing Decision must split strong vs excluded refs");
assert(/disabled/.test(drawerSrc), "case-id Save button must be disabled (guarded)");
assert(
  /Save\/recording will be enabled by the governed manual[\s\S]*?filing status phase/.test(drawerSrc),
  "drawer case-id section must state save/recording is enabled by the governed manual filing status phase",
);

// ---- View: header + warning banner + summary cards + Open Filing Packet ----
const viewSrc = readFileSync(viewPath, "utf8");
assert(viewSrc.includes("Ready to File Claims"), "view must render the page header");
assert(
  /MENORIX does not submit to Amazon\. Use this page to manually file in Seller Central and copy the[\s\S]*?Amazon Case ID back\./.test(
    viewSrc,
  ),
  "view must render the exact no-submission warning banner",
);
assert(viewSrc.includes("Amazon Case ID missing"), "view must render the Amazon Case ID missing summary card");
assert(viewSrc.includes("Open Filing Packet"), "view must render the Open Filing Packet row action");
assert(viewSrc.includes("computeFilingDecision") && /<th[^>]*>Decision<\/th>/.test(viewSrc), "view must render a per-row filing Decision badge column");

// ---- API + nav wiring ----
const apiSrc = readFileSync(apiPath, "utf8");
assert(apiSrc.includes("getCenterReadyToFilePayload"), "api route must call getCenterReadyToFilePayload");
assert(
  readFileSync(join(cwd, "lib/claims/submission/claim-reimbursement-tracking-nav.ts"), "utf8").includes(
    "/claim-center/ready-to-file",
  ),
  "financial nav must include ready-to-file",
);
assert(
  readFileSync(join(cwd, "lib/claims/center/claim-center-v2-page-contract.ts"), "utf8").includes("ready_to_file"),
  "page contract must include ready_to_file id",
);

// ---- Filter + reference-block helpers behave ----
const sampleRow = {
  claim_submission_id: "s1",
  claim_family: "removal_order_discrepancy",
  ready_to_file: true,
  approved_cogs_unit: 5,
  trid_or_expected_package: "ep-1",
  evidence_status: "present",
  amazon_case_id_status: "not_recorded",
  recovery_value: 10,
  clean_quantity: 2,
  asin: "B000",
  fnsku: "X00",
  sku: "SKU1",
  removal_order_id: "RO-1",
  removal_shipment_id: null,
  uses_sale_price_as_amount: false,
  event_reference_ledger: {
    seller_central_reference_block: "ASIN: B000\nFNSKU: X00\nSKU: SKU1\nRemoval Order ID: RO-1\nQuantity affected: 2",
    external_reference_count: 1,
    needs_reference_review: false,
    primary_reference_anchor: { label: "Removal Order ID", value: "RO-1", kind: "removal_order_id", is_external_amazon_reference: true },
    removal_order_refs: ["RO-1"],
    removal_shipment_refs: [],
    tracking_refs: [],
    transaction_refs: [],
    report_metadata_refs: [],
    internal_anchors: [{ label: "Expected Package ID", value: "ep-1", kind: "expected_package_id", note: "internal" }],
    source_groups: [
      { group: "inventory_ledger", source_label: "Inventory ledger references", status: "found_weak_ambiguous", references: [], candidate_count: 20, candidate_samples: [{ source: "amazon_inventory_ledger", source_label: "Inventory Ledger", reference_kind: "ledger_reference_id", reference_id: "WEAKLEDGER1", event_type: null, event_date: null, quantity: null, amount: null, source_row_id: null, match_reason: ["fnsku_match"], confidence: "low", is_external_amazon_reference: true }], note: "advisory" },
    ],
  },
} as unknown as ReadyToFileRow;
const filtered = filterReadyToFileRows([sampleRow], { ...DEFAULT_READY_TO_FILE_FILTERS, status: "ready" });
assert(filtered.length === 1, "filter must keep a ready row when status=ready");
const blockedOnly = filterReadyToFileRows([sampleRow], { ...DEFAULT_READY_TO_FILE_FILTERS, status: "blocked" });
assert(blockedOnly.length === 0, "filter must drop a ready row when status=blocked");
const block = buildReferenceBlockText(sampleRow);
assert(block.includes("Removal Order ID: RO-1") && block.includes("ASIN: B000"), "reference block must list refs");

// ---- Filing decision matrix (PHASE-CLAIM-FILING-DECISION-MATRIX-V1) ----
const safeDecision = computeFilingDecision(sampleRow);
assert(safeDecision.decision === "safe_to_file", `strong ref + identity + qty + cogs must be safe_to_file (got ${safeDecision.decision})`);
assert(
  safeDecision.high_confidence_refs.some((r) => r.includes("RO-1")),
  "safe decision must surface the strong removal order reference",
);
assert(
  safeDecision.weak_refs_excluded.length > 0 && safeDecision.weak_refs_excluded.some((r) => /candidate/i.test(r)),
  "weak FNSKU/date-window candidates must be listed as excluded, not used as proof",
);
assert(
  !block.includes("WEAKLEDGER1"),
  "weak candidate ids must never appear in the Seller Central reference block",
);
// do_not_file: only internal anchors (zero external references)
const internalOnlyRow = {
  ...sampleRow,
  event_reference_ledger: { ...sampleRow.event_reference_ledger, external_reference_count: 0, removal_order_refs: [], removal_shipment_refs: [], tracking_refs: [] },
} as unknown as ReadyToFileRow;
assert(computeFilingDecision(internalOnlyRow).decision === "do_not_file", "internal-only claim must be do_not_file");
// needs_reference_review: external ref exists but no strong removal/shipment/tracking ref
const weakOnlyRow = {
  ...sampleRow,
  event_reference_ledger: { ...sampleRow.event_reference_ledger, external_reference_count: 1, removal_order_refs: [], removal_shipment_refs: [], tracking_refs: [], transaction_refs: [], report_metadata_refs: [] },
} as unknown as ReadyToFileRow;
assert(computeFilingDecision(weakOnlyRow).decision === "needs_reference_review", "no strong ref must be needs_reference_review");

// ---- Recovery gap engine (PHASE-CLAIM-RECOVERY-GAP-AND-REIMBURSEMENT-MATCHING-V1) ----
// Baseline sampleRow: only weak ledger candidates → unknown/unmatched, full open gap.
const gapBase = computeRecoveryGap(sampleRow);
assert(gapBase.reimbursement_status === "unknown_unmatched", `weak-only claim must be unknown_unmatched (got ${gapBase.reimbursement_status})`);
assert(gapBase.confirmed_reimbursed === 0, "weak-only claim must have $0 confirmed");
assert(gapBase.open_recovery_gap === 10, "weak-only claim open gap must equal expected recovery");
assert(gapBase.has_weak_candidates === true, "weak-only claim must flag weak candidates");
assert(gapBase.recovery_requested_amount === 10, "no confirmed reimbursement → requested = expected recovery");

// Order-linked settlement rows that are FEES must NEVER be counted as reimbursement.
const feeRow = {
  ...sampleRow,
  event_reference_ledger: {
    ...sampleRow.event_reference_ledger,
    source_groups: [
      { group: "transaction_settlement", source_label: "Transaction / settlement references", status: "found", candidate_count: 0, candidate_samples: [], note: "", references: [{ source: "amazon_settlements", source_label: "Settlement", reference_kind: "settlement_id", reference_id: "SET-FEE-1", event_type: "FBA Inventory Fee", event_date: "2026-05-01", quantity: null, amount: 1.23, source_row_id: null, match_reason: ["order_id_match"], confidence: "high", is_external_amazon_reference: true }] },
    ],
  },
} as unknown as ReadyToFileRow;
const gapFee = computeRecoveryGap(feeRow);
assert(gapFee.settlement_credit_matches.length === 0, "FBA Inventory Fee must not be a counted settlement credit");
assert(gapFee.strong_transaction_matches.length === 1, "fee row must be shown as a (non-counted) transaction match");
assert(gapFee.confirmed_reimbursed === 0 && gapFee.reimbursement_status === "unknown_unmatched", "fee-only claim must stay unknown_unmatched");

// PHASE-AMAZON-REPORT-SOURCE-API-COVERAGE: recovery gap now reports exact files checked + missing files/API.
assert(Array.isArray(gapBase.files_checked) && gapBase.files_checked.length > 0, "recovery gap must list files/sources checked");
assert(
  Array.isArray(gapBase.missing_files_or_api) && gapBase.missing_files_or_api.length > 0,
  "weak-only claim must list missing files/API needed to confirm reimbursement",
);
assert(
  gapBase.missing_files_or_api.some((m) => m.includes("GET_LEDGER_DETAIL_VIEW_DATA")),
  "missing files/API must name the ledger Detail View report when the ledger group is weak/ambiguous",
);
assert(
  drawerSrc.includes("Missing files / API"),
  "drawer must render the missing-files/API block",
);

// A real order-linked reimbursement credit IS counted.
const creditRow = {
  ...sampleRow,
  recovery_value: 10,
  event_reference_ledger: {
    ...sampleRow.event_reference_ledger,
    source_groups: [
      { group: "reimbursement", source_label: "Reimbursement references", status: "found", candidate_count: 0, candidate_samples: [], note: "", references: [{ source: "amazon_reimbursements", source_label: "Reimbursement", reference_kind: "reimbursement_id", reference_id: "REIMB-1", event_type: "Reimbursement", event_date: "2026-05-02", quantity: 2, amount: 10, source_row_id: null, match_reason: ["order_id_match"], confidence: "high", is_external_amazon_reference: true }] },
    ],
  },
} as unknown as ReadyToFileRow;
const gapCredit = computeRecoveryGap(creditRow);
assert(gapCredit.confirmed_reimbursed === 10, "order-linked reimbursement credit must be counted");
assert(gapCredit.reimbursement_status === "fully_reimbursed", `fully covered credit must be fully_reimbursed (got ${gapCredit.reimbursement_status})`);
assert(gapCredit.open_recovery_gap === 0, "fully reimbursed claim must have $0 open gap");
assert(gapCredit.recovery_requested_amount === 0, "confirmed reimbursement → requested = open gap");

// Aggregation + reimbursement filter.
const recSummary = summarizeRecoveryGap([sampleRow, creditRow]);
assert(recSummary.total_confirmed_reimbursed === 10, "summary must total confirmed reimbursements");
assert(recSummary.fully_reimbursed_count === 1 && recSummary.unknown_unmatched_count === 1, "summary must count statuses");
const unmatchedFiltered = filterReadyToFileRows([sampleRow, creditRow], { ...DEFAULT_READY_TO_FILE_FILTERS, reimbursement_status: "unknown_unmatched" });
assert(unmatchedFiltered.length === 1 && unmatchedFiltered[0] === sampleRow, "reimbursement_status filter must isolate unknown/unmatched");
const weakFiltered = filterReadyToFileRows([sampleRow, creditRow], { ...DEFAULT_READY_TO_FILE_FILTERS, has_weak_candidates: true });
assert(weakFiltered.length === 1 && weakFiltered[0] === sampleRow, "has_weak_candidates filter must isolate rows with weak candidates");

// UI surfaces the recovery-gap section + summary cards + columns.
assert(drawerSrc.includes("2 · Financial Breakdown") && drawerSrc.includes("computeFamilyAwareRecovery"), "drawer must render the Financial Breakdown section");
assert(drawerSrc.includes("Confirmed reimbursed (strong, same-family)") && drawerSrc.includes("Open claim amount"), "Financial Breakdown must show confirmed reimbursed (strong, same-family) + open claim amount");
assert(viewSrc.includes("computeFamilyAwareRecovery") && viewSrc.includes("summarizeRecoveryGap"), "view must compute family-aware recovery + summary");

// ---- PHASE-CLAIM-FAMILY-AWARE-RECOVERY-MATCHING-V2 ----
// Amount-basis policy matrix: physical-loss families default COGS but need confirmation;
// fee/reversal families have unambiguous, resolved bases.
assert(CLAIM_AMOUNT_POLICY_MATRIX.removal_shipment_missing.default_claim_amount_basis === "cogs_recovery", "removal_shipment_missing basis must be cogs_recovery");
assert(CLAIM_AMOUNT_POLICY_MATRIX.removal_shipment_missing.policy_resolved === false, "removal_shipment_missing must need policy confirmation");
assert(CLAIM_AMOUNT_POLICY_MATRIX.fulfillment_fee_overcharge.default_claim_amount_basis === "fee_delta", "fee overcharge basis must be fee_delta");
assert(CLAIM_AMOUNT_POLICY_MATRIX.reimbursement_reversal.policy_resolved === true && CLAIM_AMOUNT_POLICY_MATRIX.reimbursement_reversal.default_claim_amount_basis === "reimbursement_reinstatement", "reversal basis resolved as reinstatement");

// Deterministic family classifier separates removal vs warehouse-damaged vs fee.
assert(classifyCandidateFamily("Warehouse_Damaged", "reimbursement") === "damaged_warehouse", "Warehouse_Damaged must classify as damaged_warehouse");
assert(classifyCandidateFamily("Lost_Outbound", "reimbursement") === "lost_outbound", "Lost_Outbound must classify as lost_outbound");
assert(classifyCandidateFamily("FBA Inventory Fee", "transaction_settlement") === "fulfillment_fee_overcharge", "fee event must classify as fulfillment_fee_overcharge");

// Family-aware recovery: a removal claim with a Damaged_Warehouse weak reimbursement candidate
// must NOT count it, must flag it misclassified, and must suggest a separate damaged_warehouse claim.
const faRow = {
  ...sampleRow,
  claim_family: "removal_shipment_missing",
  recovery_value: 10,
  clean_quantity: 2,
  money_lane: {
    latest_sold_price: 20,
    latest_sold_price_source: "amazon_reports_repository.product_sales",
    latest_sold_price_date: "2026-03-27T19:14:27+00:00",
    latest_sale_net_deterministic: true,
    sale_match_confidence: "high",
    latest_sale_net_unknown_reason: null,
    amazon_fees_total: 6,
    amazon_fees_source: "amazon_reports_repository.selling_fees+fba_fees",
    fee_source_confidence: "high",
    net_settlement_amount: 14,
    approved_cogs_unit: 5,
    recovery_value: 10,
    observed_reimbursement: null,
    observed_reimbursement_status: "unknown",
    currency: "USD",
  },
  event_reference_ledger: {
    ...sampleRow.event_reference_ledger,
    source_groups: [
      { group: "reimbursement", source_label: "Reimbursement references", status: "found_weak_ambiguous", candidate_count: 1, candidate_samples: [], note: "", references: [{ source: "amazon_reimbursements", source_label: "Reimbursement", reference_kind: "reimbursement_id", reference_id: "REIMB-DW", event_type: "Warehouse_Damaged", event_date: "2026-05-02", quantity: 1, amount: 4, source_row_id: null, match_reason: ["fnsku_match"], confidence: "low", is_external_amazon_reference: true }] },
    ],
  },
} as unknown as ReadyToFileRow;
const fa = computeFamilyAwareRecovery(faRow);
assert(fa.current_cogs_expected_recovery === 10, "family-aware COGS recovery must equal recovery_value");
assert(fa.alternative_latest_sale_net_estimate === 28, `latest sale net est must be net_settlement × qty = 28 (got ${fa.alternative_latest_sale_net_estimate})`);
assert(fa.business_total_loss_estimate === 10, "business total loss floor must equal COGS");
assert(fa.seller_central_amount_basis === "cogs_recovery" && fa.seller_central_amount === 10, "Seller Central selected amount must be COGS basis = 10");
assert(fa.filing_status === "needs_policy_confirmation", `removal claim with unconfirmed basis must be needs_policy_confirmation (got ${fa.filing_status})`);
assert(fa.confirmed_reimbursed_strong === 0, "cross-family weak reimbursement must NOT be counted as confirmed");
assert(fa.misclassified_candidates.some((c) => c.classified_family === "damaged_warehouse"), "Damaged_Warehouse candidate must be flagged misclassified under a removal claim");
assert(fa.separate_claim_suggestions.some((s) => s.recommended_claim_family === "damaged_warehouse"), "must suggest a separate damaged_warehouse claim");

// UI surfaces the Financial Breakdown (two cards) + separate opportunities.
assert(drawerSrc.includes("A · Amazon Claim Amount") && drawerSrc.includes("B · Internal Cost / Profit-Loss"), "Financial Breakdown must split into Amazon Claim Amount + Internal Cost / Profit-Loss cards");
assert(drawerSrc.includes("Expected reimbursement (sold price − fees)") && drawerSrc.includes("Total purchase cost / COGS"), "Financial Breakdown must show expected reimbursement (sold price − fees) + internal total COGS");
assert(drawerSrc.includes("Seller Central amount basis:") && drawerSrc.includes("seller_central_amount_basis"), "drawer must render the Seller Central amount basis policy badge");
assert(drawerSrc.includes("Seller Central amount currently selected"), "drawer must show the selected Seller Central amount");
assert(drawerSrc.includes("needs_policy_confirmation"), "drawer must render the policy-needs-confirmation badge");
assert(drawerSrc.includes("Separate Claim Opportunities"), "drawer must render the separate-opportunities section");

// ---- PHASE-CLAIM-AMOUNT-BASIS-POLICY-OPERATOR-CONFIRMATION-V1 ----
// faRow with no overlay must stay needs_policy_confirmation (default unresolved).
assert(fa.policy_confirmed === false && fa.filing_status === "needs_policy_confirmation", "no overlay -> needs_policy_confirmation");

// With a confirmed operator overlay, the removal family resolves to COGS basis + safe_to_file.
const confirmedFaRow = {
  ...faRow,
  amount_basis_policy_overlay: {
    version: "claim-amount-basis-policy-v1",
    confirmed_by: "operator:maysam",
    confirmed_at: "2026-06-18T00:00:00.000Z",
    approval_key: "APPROVED_CLAIM_AMOUNT_BASIS_POLICY_V1",
    families: {
      removal_shipment_missing: {
        family_key: "removal_shipment_missing",
        basis: "cogs_recovery",
        use_as_seller_central_amount: true,
        informational_only: ["latest_sale_net", "business_total_loss"],
        confirmed_by: "operator:maysam",
        confirmed_at: "2026-06-18T00:00:00.000Z",
        approval_key: "APPROVED_CLAIM_AMOUNT_BASIS_POLICY_V1",
        note: "COGS recovery is the Seller Central claim amount.",
      },
    },
  },
} as unknown as ReadyToFileRow;
const faConfirmed = computeFamilyAwareRecovery(confirmedFaRow);
assert(faConfirmed.policy_confirmed === true, "confirmed overlay must set policy_confirmed=true");
assert(faConfirmed.policy.policy_resolved === true, "confirmed overlay must resolve the policy");
assert(faConfirmed.seller_central_amount_basis === "cogs_recovery" && faConfirmed.seller_central_amount === 10, "confirmed basis must be COGS recovery = 10");
assert(faConfirmed.filing_status === "safe_to_file", `confirmed removal claim with strong ref must be safe_to_file (got ${faConfirmed.filing_status})`);
assert(faConfirmed.confirmed_reimbursed_strong === 0, "cross-family weak credit must still not count after confirmation");
assert(faConfirmed.misclassified_candidates.some((c) => c.classified_family === "damaged_warehouse"), "separate-claim flagging must persist after confirmation");
assert(drawerSrc.includes("Policy confirmed"), "drawer must render the policy-confirmed badge");
assert(drawerSrc.includes("Internal accounting only") && drawerSrc.includes("COGS is NOT the"), "Financial Breakdown must label COGS as internal-only and not the requested amount");

// ---- PHASE-CLAIM-AMOUNT-BASIS-LATEST-SALE-NET-POLICY-FIX-V1 ----
// New latest-sale-net amount fields: expected = (latest_sold_price − amazon_fees) × qty,
// total COGS internal, business profit/loss context = expected − COGS. Settlement net is NOT the basis.
assert(fa.expected_reimbursement_latest_sale_net === 28, `expected latest-sale-net must be (20−6)×2 = 28 (got ${fa.expected_reimbursement_latest_sale_net})`);
assert(fa.total_cogs === 10, "internal total COGS must equal recovery_value (10)");
assert(fa.business_profit_loss_context === 18, `profit/loss context must be 28 − 10 = 18 (got ${fa.business_profit_loss_context})`);
// A confirmed latest_sale_net overlay must select the latest-sale-net expected amount (NOT COGS).
const latestSaleNetFaRow = {
  ...faRow,
  amount_basis_policy_overlay: {
    version: "claim-amount-basis-policy-v1",
    confirmed_by: "operator:maysam",
    confirmed_at: "2026-06-18T00:00:00.000Z",
    approval_key: "APPROVED_CLAIM_AMOUNT_BASIS_LATEST_SALE_NET_POLICY_FIX_V1",
    families: {
      removal_shipment_missing: {
        family_key: "removal_shipment_missing",
        basis: "latest_sale_net",
        use_as_seller_central_amount: true,
        informational_only: ["cogs_recovery", "business_total_loss", "settlement_net"],
        confirmed_by: "operator:maysam",
        confirmed_at: "2026-06-18T00:00:00.000Z",
        approval_key: "APPROVED_CLAIM_AMOUNT_BASIS_LATEST_SALE_NET_POLICY_FIX_V1",
        note: "Seller Central amount = latest sold price − Amazon fees.",
      },
    },
  },
} as unknown as ReadyToFileRow;
const faLatestSaleNet = computeFamilyAwareRecovery(latestSaleNetFaRow);
assert(faLatestSaleNet.seller_central_amount_basis === "latest_sale_net" && faLatestSaleNet.seller_central_amount === 28, `latest_sale_net overlay must select expected = 28 (got basis=${faLatestSaleNet.seller_central_amount_basis}, amount=${faLatestSaleNet.seller_central_amount})`);
assert(faLatestSaleNet.seller_central_amount !== faLatestSaleNet.current_cogs_expected_recovery, "Seller Central amount must NOT be the COGS amount under latest_sale_net policy");
assert(faLatestSaleNet.open_gap_under_current_policy === 28, `open claim amount must equal expected when confirmed=0 (got ${faLatestSaleNet.open_gap_under_current_policy})`);
assert(faLatestSaleNet.filing_status === "safe_to_file", `confirmed latest_sale_net removal claim must be safe_to_file (got ${faLatestSaleNet.filing_status})`);

// ---- PHASE-CLAIM-LATEST-SALE-NET-SOURCE-COVERAGE-BACKFILL-V1 ----
// Provenance + deterministic source must surface on the family-aware recovery.
assert(
  fa.latest_sold_price_source === "amazon_reports_repository.product_sales" &&
    fa.latest_sold_price_date === "2026-03-27T19:14:27+00:00" &&
    fa.sale_match_confidence === "high" &&
    fa.latest_sale_net_deterministic === true &&
    fa.amazon_fees_source === "amazon_reports_repository.selling_fees+fba_fees" &&
    fa.fee_source_confidence === "high",
  "family-aware recovery must surface deterministic sale price/fee source provenance",
);
// Missing sale price → UNKNOWN expected/open (NO COGS fallback) + an explicit reason.
const missingSaleRow = {
  ...latestSaleNetFaRow,
  money_lane: {
    ...(latestSaleNetFaRow as unknown as ReadyToFileRow).money_lane,
    latest_sold_price: null,
    latest_sold_price_source: null,
    latest_sold_price_date: null,
    latest_sale_net_deterministic: true,
    sale_match_confidence: "none",
    latest_sale_net_unknown_reason: "NO_VALID_ORDER_SALE_AT_OR_BEFORE_EVENT",
    amazon_fees_total: null,
    amazon_fees_source: null,
    fee_source_confidence: "unknown",
  },
} as unknown as ReadyToFileRow;
const faMissingSale = computeFamilyAwareRecovery(missingSaleRow);
assert(
  faMissingSale.expected_reimbursement_latest_sale_net === null &&
    faMissingSale.seller_central_amount === null &&
    faMissingSale.open_gap_under_current_policy === null,
  "missing sale price must yield UNKNOWN expected/open (no COGS fallback)",
);
assert(
  faMissingSale.latest_sale_net_unknown_reason === "NO_VALID_ORDER_SALE_AT_OR_BEFORE_EVENT",
  "missing sale price must carry an explicit unknown_reason for the UI",
);
// UI must render the sale-source column + provenance/UNKNOWN affordances.
assert(/<th[^>]*>Sale source<\/th>/.test(viewSrc), "view must render a Sale source column");
assert(viewSrc.includes("latest_sale_net_unknown_reason") && viewSrc.includes("UNKNOWN"), "view must show UNKNOWN + reason when no sale source");
assert(
  drawerSrc.includes("latest_sold_price_source") && drawerSrc.includes("latest_sale_net_unknown_reason"),
  "drawer must render latest sold price source + UNKNOWN reason",
);
assert(
  drawerSrc.includes("amazon_fees_source") && drawerSrc.includes("fee_source_confidence"),
  "drawer must render Amazon fees source + fee confidence",
);

// ---- PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-V1 ----
const mkClass = (over: Partial<FamilyCandidateClassification>): FamilyCandidateClassification => ({
  source_label: "Reimbursement",
  reference_id: "ref-1",
  reason: null,
  amount: 12.5,
  quantity: 1,
  event_date: "2026-05-01",
  kind: "reimbursement",
  source_group: "reimbursement",
  classified_family: "reimbursement_reversal",
  belongs_to_this_claim: false,
  why_not: "different family",
  should_create_separate_claim: true,
  ...over,
});
const genInput: GeneratorClaimInput = {
  claim_submission_id: "sub-1",
  claim_family: "removal_shipment_missing",
  product_identity: { fnsku: "X00FNSKU", sku: "SKU-1", asin: "B00ASIN", resolved_product_id: "prod-1" },
  anchors: ["RO-1"],
  scanner_only: false,
  misclassified: [
    mkClass({ classified_family: "reimbursement_reversal", reason: "Reversal of reimbursement", source_group: "reimbursement", reference_id: "reim-rev-1" }),
    mkClass({ classified_family: "damaged_warehouse", reason: "Warehouse_Damaged", source_group: "inventory_ledger", kind: "inventory_ledger", reference_id: "ledger-1" }),
    mkClass({ classified_family: "fulfillment_fee_overcharge", reason: "FBA fee", source_group: "transaction_settlement", kind: "transaction", reference_id: "txn-1" }),
  ],
};
const gen = buildSeparateFamilyCandidatePreviews([genInput]);
assert(gen.suggestions_input_count === 3, "generator must count all 3 suggestions");
assert(gen.candidates.length === 3, "generator must build 3 de-duplicated previews");
assert(gen.candidates.every((c) => !c.recommended_claim_family.startsWith("removal_")), "no generated candidate may be a removal family");
assert(gen.candidates.every((c) => Boolean(c.product_identity.fnsku)), "every candidate must carry product identity");
const rev = gen.candidates.find((c) => c.recommended_claim_family === "reimbursement_reversal");
assert(rev != null && rev.source_table === "amazon_reimbursements" && rev.claim_amount_basis === "reimbursement_reinstatement", "reversal candidate maps to amazon_reimbursements + reinstatement basis");
assert(rev!.expected_claim_amount === 12.5 && rev!.writeable === true, "resolved reversal candidate is writeable with reinstated amount");
const dmg = gen.candidates.find((c) => c.recommended_claim_family === "damaged_warehouse");
assert(dmg != null && dmg.claim_amount_basis === "cogs_recovery" && dmg.blockers.includes("amount_basis_needs_policy_confirmation"), "unresolved damaged_warehouse candidate is blocked on policy confirmation");
const fee = gen.candidates.find((c) => c.recommended_claim_family === "fulfillment_fee_overcharge");
assert(fee != null && fee.blockers.includes("fee_expected_value_unavailable_needs_fees_api"), "fee overcharge candidate needs Fees API expected value");
// Scanner-only claims must never generate candidates without a scanner blocker.
const scannerGen = buildSeparateFamilyCandidatePreviews([{ ...genInput, scanner_only: true }]);
assert(scannerGen.candidates.every((c) => c.blockers.includes("scanner_or_ocr_only_excluded")), "scanner/OCR-only origin must block every generated candidate");
assert(GENERATOR_SUPPORTED_FAMILIES.includes("reimbursement_reversal") && GENERATOR_SUPPORTED_FAMILIES.includes("storage_fee_overcharge"), "generator must support reversal + storage families");

// New files exist + UI wired.
for (const [p, label] of [
  [join(cwd, "lib/claims/opportunities/separate-family-candidate-generator-contract-v1.ts"), "generator contract"],
  [join(cwd, "lib/claims/opportunities/separate-family-candidate-generators-v1.ts"), "generator composer"],
  [join(cwd, "lib/claims/opportunities/separate-family-candidate-generators-write-v1.ts"), "generator write module"],
  [join(cwd, "app/api/claims/center/separate-family-opportunities/route.ts"), "opportunities api route"],
  [join(cwd, "components/claim-center/opportunities/SeparateFamilyOpportunitiesPanel.tsx"), "opportunities panel"],
] as const) {
  assert(existsSync(p), `${label} missing`);
}
assert(
  readFileSync(join(cwd, "components/claim-center/ClaimCenterOpportunitiesView.tsx"), "utf8").includes("SeparateFamilyOpportunitiesPanel"),
  "opportunities view must render the separate-family panel",
);
assert(
  readFileSync(join(cwd, "components/claim-center/data-coverage/ClaimDataCoverageView.tsx"), "utf8").includes("SeparateFamilyOpportunitiesPanel"),
  "data-coverage view must render the generator support panel",
);
assert(/<th[^>]*>Reimb\. status<\/th>/.test(viewSrc) && /<th[^>]*>Open claim amount<\/th>/.test(viewSrc), "view must render reimbursement table columns");
assert(/<th[^>]*>Expected reimbursement<\/th>/.test(viewSrc) && /<th[^>]*>Internal COGS<\/th>/.test(viewSrc) && /<th[^>]*>Profit\/loss context<\/th>/.test(viewSrc), "view must render expected reimbursement / internal COGS / profit-loss columns");
assert(viewSrc.includes("Open recovery gap") && viewSrc.includes("Confirmed reimbursed"), "view must render recovery summary cards");

// ---- STATIC CLIENT/SERVER BOUNDARY GUARD ----
// Client components (and the client-safe contract) must NEVER import any module
// that drags server-only code (node:fs, playwright, reference/queue composers)
// into the browser bundle. This is the regression guard for the Turbopack
// "node:fs in client bundle" build error.
const FORBIDDEN_CLIENT_IMPORTS = [
  "claim-ready-to-file-queue-v1",
  "trid-reference-trace-matrix-v1",
  "claim-event-reference-ledger-v1",
  "claim-live-reference-api-completion-v1",
  "claim-live-reference-api-completion-audit-v1",
  "claim-7h-source-api-file-reference-discovery-v1",
  "node:fs",
  "playwright",
];

/** Extract only the module specifiers from `import ... from "x"` / `import("x")`. */
function importedSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const fromRe = /\bfrom\s+["']([^"']+)["']/g;
  const dynRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src)) !== null) specs.push(m[1]);
  while ((m = dynRe.exec(src)) !== null) specs.push(m[1]);
  return specs;
}

const clientSafeFiles: Array<[string, string]> = [
  [pagePath, "page.tsx (server component, but renders the client tree)"],
  [viewPath, "ReadyToFileView.tsx (client component)"],
  [drawerPath, "ReadyToFileDetailDrawer.tsx (client component)"],
  [join(cwd, "lib/claims/filing/claim-ready-to-file-queue-ui-contract.ts"), "ui-contract module"],
];

for (const [filePath, label] of clientSafeFiles) {
  const specs = importedSpecifiers(readFileSync(filePath, "utf8"));
  for (const spec of specs) {
    for (const forbidden of FORBIDDEN_CLIENT_IMPORTS) {
      assert(
        !spec.includes(forbidden),
        `${label} must not import server-only module '${forbidden}' (found import "${spec}")`,
      );
    }
  }
}

// ---- Contract module must be FULLY self-contained (no relative/server imports at all) ----
const contractSrc = readFileSync(
  join(cwd, "lib/claims/filing/claim-ready-to-file-queue-ui-contract.ts"),
  "utf8",
);
for (const spec of importedSpecifiers(contractSrc)) {
  assert(
    false,
    `ui-contract module must import nothing (client-safe); found import "${spec}"`,
  );
}

// ---- View imports the contract, never the server composer ----
const viewSpecs = importedSpecifiers(viewSrc);
assert(
  viewSpecs.some((s) => s.includes("claim-ready-to-file-queue-ui-contract")),
  "view must import types/helpers from the client-safe ui-contract module",
);

// ---- Separate-family panel + generator contract stay client-safe ----
const panelSrc = readFileSync(join(cwd, "components/claim-center/opportunities/SeparateFamilyOpportunitiesPanel.tsx"), "utf8");
for (const spec of importedSpecifiers(panelSrc)) {
  for (const forbidden of FORBIDDEN_CLIENT_IMPORTS) {
    assert(!spec.includes(forbidden), `separate-family panel must not import server-only '${forbidden}' (found "${spec}")`);
  }
}
const genContractSrc = readFileSync(join(cwd, "lib/claims/opportunities/separate-family-candidate-generator-contract-v1.ts"), "utf8");
for (const spec of importedSpecifiers(genContractSrc)) {
  for (const forbidden of FORBIDDEN_CLIENT_IMPORTS) {
    assert(!spec.includes(forbidden), `generator contract must not import server-only '${forbidden}' (found "${spec}")`);
  }
}

// ---- PHASE-CLAIM-FAMILY-SEPARATION-UI-CLEANUP-V1 ----
// Drawer separates the four sections cleanly (A current evidence, B gap, C excluded, D opportunities).
assert(drawerSrc.includes("1 · Current Claim Evidence"), "drawer must render section 1 Current Claim Evidence");
assert(drawerSrc.includes("2 · Financial Breakdown"), "drawer must render section 2 Financial Breakdown");
assert(drawerSrc.includes("3 · Excluded Cross-Family Candidates"), "drawer must render section 3 Excluded Cross-Family Candidates");
assert(drawerSrc.includes("4 · Separate Claim Opportunities"), "drawer must render section 4 Separate Claim Opportunities");
// Excluded section uses misclassified_candidates (cross-family) and is collapsed by default (<details> without `open`).
assert(drawerSrc.includes("misclassified_candidates"), "drawer must source the excluded section from misclassified_candidates");
assert(
  /ExcludedCrossFamilySection[\s\S]*?<details>[\s\S]*?<summary/.test(drawerSrc) &&
    !/ExcludedCrossFamilySection[\s\S]*?<details open/.test(drawerSrc),
  "excluded cross-family section must be a <details> collapsed by default (no open attribute)",
);
// Excluded section columns: event type, suggested family, source table, amount, date, why excluded, separate?
for (const col of ["Event type", "Suggested family", "Source table", "Why excluded"]) {
  assert(drawerSrc.includes(col), `excluded cross-family table must show '${col}'`);
}
// Current evidence section must show same-family anchors only.
for (const f of ["Removal order ID", "Removal shipment ID", "Tracking / shipment ref", "Recovery value"]) {
  assert(drawerSrc.includes(f), `current claim evidence must show '${f}'`);
}
// Seller Central copy block must use the external-only reference block (buildReferenceBlockText), never cross-family classifications.
assert(
  drawerSrc.includes("buildReferenceBlockText") && drawerSrc.includes("References to include in Seller Central"),
  "Seller Central copy must use the external-only reference block (no cross-family refs)",
);
assert(
  !/seller_central_message_body[\s\S]{0,40}misclassified/.test(drawerSrc),
  "Seller Central copy must not interpolate misclassified cross-family candidates",
);

// Ready-to-File table exposes the required family-separation columns + per-row badges.
for (const col of [
  "Current family",
  "Filing status",
  "Policy status",
  "Decision",
  "Expected reimbursement",
  "Confirmed reimbursed",
  "Open claim amount",
  "Internal COGS",
  "Profit/loss context",
  "Sep. opps",
]) {
  assert(viewSrc.includes(col), `ready-to-file table must add the '${col}' column`);
}
for (const badge of ["current claim only", "cross-family excluded", "not Amazon-submitted", "needs_policy_confirmation"]) {
  assert(viewSrc.includes(badge), `ready-to-file row must render the '${badge}' badge`);
}
assert(
  viewSrc.includes("open_gap_under_current_policy") && viewSrc.includes("confirmed_reimbursed_strong"),
  "table open-gap/reimbursed columns must use family-aware values (exclude cross-family weak candidates)",
);
assert(!viewSrc.includes("computeRecoveryGap"), "table must no longer use raw computeRecoveryGap for the gap columns");

// ---- PHASE-CLAIM-REMOVAL-ORIGIN-REASON-UI-SURFACE-V1 ----
// Pure origin/missing-basis classifier mirrors the audit: valid_missing when no
// receipt + age over threshold; waiting when under threshold; discrepancy when
// partially received; not_missing when fully received; not_applicable when null.
const mkOrigin = (over: Partial<RemovalOriginInputs>): RemovalOriginInputs => ({
  from_removal_shipment_detail: true,
  from_removal_order_detail: true,
  from_expected_packages: true,
  tracking: "TRK-1",
  removal_order_id: "RO-1",
  removal_shipment_id: "RS-1",
  expected_package_id: "ep-1",
  event_date: "2026-04-01T00:00:00Z",
  event_age_days: 40,
  threshold_days: 14,
  threshold_source: "workspace_settings.module_configs.claim_intake.delayed_not_received_days",
  expected_qty: 2,
  received_qty: 0,
  build_status: "matched",
  package_received: false,
  scanned_units: 0,
  ...over,
});

const originRowBase = { ...sampleRow, claim_family: "removal_shipment_missing" } as unknown as ReadyToFileRow;

// Non-removal / unresolved → not applicable.
const naReason = computeRemovalOriginReason({ ...originRowBase, removal_origin_inputs: null } as ReadyToFileRow);
assert(naReason.applicable === false && naReason.validity === "not_applicable", "null origin inputs → not_applicable");

// Valid missing (the 10 pilot claims): age 40 > 14, received 0, no receipt.
const validMissing = computeRemovalOriginReason({
  ...originRowBase,
  removal_origin_inputs: mkOrigin({}),
} as ReadyToFileRow);
assert(validMissing.validity === "valid_missing", `age>threshold + received 0 → valid_missing (got ${validMissing.validity})`);
assert(validMissing.threshold_days === 14, "valid missing must carry threshold 14");
assert(validMissing.event_age_days === 40 && validMissing.received_qty === 0, "valid missing must carry age 40 + received 0");
assert(validMissing.missing_qty === 2, "valid missing missing_qty = expected − received = 2");
assert(validMissing.compact_reason === "Missing: no scan/receipt after 14 days", `compact reason wording (got "${validMissing.compact_reason}")`);
assert(
  validMissing.final_reason ===
    "Valid missing claim: no physical receipt/scanner evidence after configured threshold.",
  "valid missing final reason wording",
);
for (const b of ["valid_missing", "over_threshold", "scanner_absent", "full_missing", "no_manual_review_needed"]) {
  assert(validMissing.badges.includes(b), `valid missing must carry badge '${b}'`);
}
assert(validMissing.from_scanner_receipt_absence && validMissing.from_deadline_threshold, "valid missing origin flags set");
assert(
  validMissing.origin_sources.includes("Removal Shipment Detail") &&
    validMissing.origin_sources.includes("Removal Order Detail") &&
    validMissing.origin_sources.includes("Expected Package"),
  "valid missing must list all three origin sources",
);

// Waiting threshold: too new (age 5 ≤ 14), received 0 → NOT ready to file.
const waiting = computeRemovalOriginReason({
  ...originRowBase,
  removal_origin_inputs: mkOrigin({ event_age_days: 5 }),
} as ReadyToFileRow);
assert(waiting.validity === "waiting_threshold", `age≤threshold + received 0 → waiting_threshold (got ${waiting.validity})`);
assert(waiting.badges.includes("waiting_threshold"), "waiting must carry waiting_threshold badge");

// Discrepancy: partial receipt (1 of 2).
const discrepancy = computeRemovalOriginReason({
  ...originRowBase,
  removal_origin_inputs: mkOrigin({ received_qty: 1, package_received: true, scanned_units: 1 }),
} as ReadyToFileRow);
assert(discrepancy.validity === "valid_discrepancy", `partial receipt → valid_discrepancy (got ${discrepancy.validity})`);
assert(discrepancy.compact_reason === "Discrepancy: expected 2, received 1", `discrepancy wording (got "${discrepancy.compact_reason}")`);
assert(discrepancy.missing_qty === 1, "discrepancy missing_qty = 1");

// Fully received → not missing (reclassify).
const fullyReceived = computeRemovalOriginReason({
  ...originRowBase,
  removal_origin_inputs: mkOrigin({ received_qty: 2, package_received: true, scanned_units: 2 }),
} as ReadyToFileRow);
assert(fullyReceived.validity === "not_missing", `full receipt → not_missing (got ${fullyReceived.validity})`);
assert(fullyReceived.badges.includes("has_receipt"), "fully received must carry has_receipt badge");

// View must render the origin/basis columns.
for (const col of [
  "Origin",
  "Missing basis",
  "Age days",
  "Threshold days",
  "Expected qty",
  "Received/scanned qty",
  "Missing qty",
  "Validity",
]) {
  assert(viewSrc.includes(col), `ready-to-file table must add the '${col}' origin column`);
}
assert(viewSrc.includes("computeRemovalOriginReason"), "view must compute the removal origin reason per row");

// Drawer must render the "Why this claim exists" section + threshold source + scanner status + final reason.
assert(drawerSrc.includes("Why this claim exists"), "drawer must render the 'Why this claim exists' section");
assert(drawerSrc.includes("computeRemovalOriginReason"), "drawer must compute the removal origin reason");
assert(drawerSrc.includes("Configured threshold") && drawerSrc.includes("threshold_source"), "drawer must show configured threshold + source");
assert(drawerSrc.includes("Scanner status"), "drawer must render scanner status lines");
assert(drawerSrc.includes("Final reason"), "drawer must render the final reason");
assert(drawerSrc.includes("Waiting threshold"), "drawer must surface a Waiting threshold badge for waiting claims");

// Server composer must resolve the origin inputs read-only from the threshold + source tables.
assert(libSrc.includes("loadRemovalOriginInputsForRows"), "lib must attach removal origin inputs to rows");
assert(libSrc.includes("loadClaimIntakeSettings"), "lib must load the missing threshold from claim intake settings");
const originLibPath = join(cwd, "lib/claims/filing/claim-removal-origin-basis-v1.ts");
assert(existsSync(originLibPath), "removal-origin-basis loader must exist");
const originLibSrc = readFileSync(originLibPath, "utf8");
assert(
  !/\.update\(|\.insert\(|\.delete\(|\.upsert\(/.test(originLibSrc),
  "removal-origin-basis loader must be read-only (no write ops)",
);
assert(
  !/openai|gpt-|anthropic|claude|chat\.completions|generateText/i.test(originLibSrc),
  "removal-origin-basis loader must not use AI/GPT",
);

console.log("SMOKE OK: PHASE-CLAIM-READY-TO-FILE-QUEUE-UI-V1 static contract verified");
