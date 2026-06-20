/**
 * smoke-product-trid-story-linkage-audit-and-layer-v1 — static safety checks
 *   npx tsx scripts/smoke-product-trid-story-linkage-audit-and-layer-v1.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const contract = readFileSync(
  "lib/products/contracts/product-trid-story-linkage-audit-v1.ts",
  "utf8",
);
const script = readFileSync(
  "scripts/phase-product-trid-story-linkage-audit-and-layer-v1.ts",
  "utf8",
);

// Contract content
assert.match(contract, /TRID_REFERENCE_MODEL/);
assert.match(contract, /SOURCE_IDENTITY_SPECS/);
assert.match(contract, /INCOMING_API_MAPPING_RULE/);
assert.match(contract, /SELLER_CENTRAL_PROOF_IDENTIFIERS/);
assert.match(contract, /INTERNAL_ONLY_IDENTIFIERS/);
assert.match(contract, /amazon_returns/);
// customer_returns is documented as non-existent
assert.match(contract, /NON_EXISTENT_SOURCE_TABLES/);
// never use internal UUID as proof
assert.match(contract, /use internal UUID as external proof/);
assert.match(contract, /auto-create products from title\/OCR/);

// Read-only proof: phase script must not mutate
assert.match(script, /default_transaction_read_only = ON/);
assert.doesNotMatch(script, /\.insert\(/);
assert.doesNotMatch(script, /\.update\(/);
assert.doesNotMatch(script, /\.delete\(/);
assert.doesNotMatch(script, /\.upsert\(/);
// No claim submission / Amazon / scanner mutation
assert.doesNotMatch(script, /claim_submissions[^\n]*update/i);
assert.match(script, /no_claim_submission_mutation_verification: true/);
assert.match(script, /no_amazon_submission_verification: true/);

console.log(JSON.stringify({ ok: true, smoke: "pass" }, null, 2));
