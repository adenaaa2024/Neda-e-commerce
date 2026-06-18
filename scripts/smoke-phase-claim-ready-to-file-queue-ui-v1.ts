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
  filterReadyToFileRows,
  summarizeRecoveryGap,
  type ReadyToFileRow,
} from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";

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
  drawerSrc.includes("Missing files / API") && drawerSrc.includes("Exact files / sources checked"),
  "drawer must render files-checked + missing-files/API blocks",
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
assert(drawerSrc.includes("Recovery Gap / Claim Amount Policy") && drawerSrc.includes("computeFamilyAwareRecovery"), "drawer must render the Recovery Gap / Claim Amount Policy section");
assert(drawerSrc.includes("Confirmed (strong)") && drawerSrc.includes("Open gap (current)"), "drawer recovery section must show confirmed (strong) + open gap (current)");
assert(viewSrc.includes("computeRecoveryGap") && viewSrc.includes("summarizeRecoveryGap"), "view must compute recovery gap + summary");

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
    amazon_fees_total: 6,
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

// UI surfaces the amount-basis policy + separate opportunities.
assert(drawerSrc.includes("COGS recovery") && drawerSrc.includes("Latest sale net") && drawerSrc.includes("Business total loss"), "drawer must show the three amount rows");
assert(drawerSrc.includes("Seller Central amount currently selected"), "drawer must show the selected Seller Central amount");
assert(drawerSrc.includes("Policy needs confirmation"), "drawer must render the policy-needs-confirmation badge");
assert(drawerSrc.includes("Separate claim opportunities suggested"), "drawer must render the separate-opportunities section");
assert(/<th[^>]*>Reimb\. status<\/th>/.test(viewSrc) && /<th[^>]*>Open gap<\/th>/.test(viewSrc), "view must render reimbursement table columns");
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

console.log("SMOKE OK: PHASE-CLAIM-READY-TO-FILE-QUEUE-UI-V1 static contract verified");
