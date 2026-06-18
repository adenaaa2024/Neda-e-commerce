/**
 * Smoke: PHASE-CLAIM-SELLER-CENTRAL-FILING-PACKET-V1
 * Static contract checks only (no DB, no writes, no Amazon, no AI).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLAIM_SELLER_CENTRAL_FILING_PACKET_V1,
  SELLER_CENTRAL_HUMAN_REVIEW_REQUIRED,
  SELLER_CENTRAL_SUBJECT_TEMPLATES,
  SELLER_CENTRAL_DRAFT_LABEL,
} from "../lib/claims/filing/claim-seller-central-filing-packet-v1";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
}

const cwd = process.cwd();

assert(
  CLAIM_SELLER_CENTRAL_FILING_PACKET_V1 === "claim-seller-central-filing-packet-v1",
  "version constant mismatch",
);
assert(SELLER_CENTRAL_HUMAN_REVIEW_REQUIRED === true, "human review must be required");
assert(
  SELLER_CENTRAL_SUBJECT_TEMPLATES.removal_shipment_missing.includes("{fnsku}") &&
    SELLER_CENTRAL_SUBJECT_TEMPLATES.removal_order_discrepancy.includes("{qty}"),
  "subject templates must reference fnsku + qty placeholders",
);
assert(
  /NOT CONTACT AMAZON/i.test(SELLER_CENTRAL_DRAFT_LABEL),
  "draft label must declare no Amazon contact",
);

const libPath = join(cwd, "lib/claims/filing/claim-seller-central-filing-packet-v1.ts");
const scriptPath = join(cwd, "scripts/phase-claim-seller-central-filing-packet-v1.ts");
assert(existsSync(libPath), "composer lib missing");
assert(existsSync(scriptPath), "phase script missing");

const libSrc = readFileSync(libPath, "utf8");
assert(
  !/\.update\(|\.insert\(|\.delete\(|\.upsert\(/i.test(libSrc),
  "composer lib must not contain any write operation",
);
assert(
  !/openai|gpt-|anthropic|claude|chat\.completions|generateText/i.test(libSrc),
  "composer lib must not use AI/GPT",
);
assert(libSrc.includes("composeMoneyLanePreviewAfterCogsV1"), "lib must reuse money lane after COGS composer");
assert(libSrc.includes("composeTridReferenceTraceMatrixV1"), "lib must reuse TRID trace matrix composer");
assert(libSrc.includes("composeReimbursementTrackingPreviewV1"), "lib must reuse reimbursement tracking composer");
assert(libSrc.includes("composeClaimFilingPacketPreviewV1"), "lib must reuse filing packet preview composer");
assert(
  libSrc.includes("clean_quantity") && libSrc.includes("approved_cogs_unit"),
  "recovery formula must reference clean_quantity x approved_cogs_unit",
);
assert(
  libSrc.includes("missing_recovery_value") && libSrc.includes("missing_primary_trid"),
  "lib must mark packets not ready on missing recovery value / TRID",
);
assert(
  /amazon_case_id:\s*null/.test(libSrc),
  "record-back amazon_case_id must default to null (no simulated case IDs)",
);

const scriptSrc = readFileSync(scriptPath, "utf8");
assert(scriptSrc.includes("read-only-filing-packet-generation"), "script must declare read-only mode");
assert(scriptSrc.includes("PRODUCTION_REF"), "script must guard production ref");
assert(
  !/INSERT\s+INTO|\.update\(|\.insert\(|\.delete\(|\.upsert\(/i.test(scriptSrc),
  "phase script must not contain any write operation",
);
assert(scriptSrc.includes("no_claim_submission_mutation_verification"), "must emit submission mutation guard");
assert(scriptSrc.includes("no_claim_reference_edge_mutation_verification"), "must emit reference edge mutation guard");
assert(scriptSrc.includes("SAFE_SELLER_CENTRAL_FILING_PACKETS_READY"), "must emit packets-ready safe flag");
assert(scriptSrc.includes("SAFE_TO_MANUALLY_FILE_IN_SELLER_CENTRAL"), "must emit file-in-seller-central safe flag");
assert(scriptSrc.includes("recovery_formula_consistent_qty_x_cogs"), "must verify recovery formula consistency");

console.log(
  JSON.stringify(
    { smoke: "PHASE-CLAIM-SELLER-CENTRAL-FILING-PACKET-V1", result: "pass", checks: 19 },
    null,
    2,
  ),
);
