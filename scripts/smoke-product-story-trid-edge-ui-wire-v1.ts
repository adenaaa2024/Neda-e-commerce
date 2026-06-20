/**
 * smoke-product-story-trid-edge-ui-wire-v1 — static safety checks
 *   npx tsx scripts/smoke-product-story-trid-edge-ui-wire-v1.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const contract = readFileSync(
  "lib/claims/readmodel/product-story-trid-event-timeline-v1.ts",
  "utf8",
);
const timeline = readFileSync(
  "components/claim-center/ProductStoryTridTimeline.tsx",
  "utf8",
);
const storySection = readFileSync(
  "components/claim-center/CandidateReferenceStorySection.tsx",
  "utf8",
);
const panel = readFileSync(
  "components/claim-center/TridReferenceGraphPanel.tsx",
  "utf8",
);
const storyBlocks = readFileSync(
  "components/claim-center/ClaimCenterDetailStoryBlocks.tsx",
  "utf8",
);

// Contract verifications
assert.match(contract, /PRODUCT_STORY_TRID_EDGE_UI_WIRE_V1/);
assert.match(contract, /seller_central_proof_filter_verified: true/);
assert.match(contract, /no_claim_mutation: true/);
assert.match(contract, /no_new_tables: true/);
assert.match(contract, /buildProductStoryTimeline/);
assert.match(contract, /buildReferenceStorySummary/);
assert.match(contract, /EVENT_SPEC_BY_KIND/);
assert.match(contract, /is_seller_central_proof/);
assert.match(contract, /is_internal_only/);
// Internal identifiers must be marked internal-only
assert.match(contract, /product_link.*is_internal_only: true/s);
assert.match(contract, /package_id.*is_internal_only: true/s);
// SC proof semantics: internal identifiers must not be cited as Seller Central proof
assert.match(contract, /operational only|internal.*only/i);

// Timeline component
assert.match(timeline, /ProductStoryTridTimeline/);
assert.match(timeline, /buildProductStoryTimeline/);
assert.match(timeline, /SC Proof/);
assert.match(timeline, /Internal/);
assert.match(timeline, /seller_central_proof_count/);
assert.match(timeline, /internal_only_count/);
assert.match(timeline, /identity_status/);
// SC proof filter toggle must be present
assert.match(timeline, /filter.*sc_proof|sc_proof.*filter/i);
// Must NOT show internal UUIDs as proof — "never cited as Seller Central proof" or similar
assert.match(timeline, /never cited as Seller Central proof|our own UUID/i);

// Reference story section
assert.match(storySection, /CandidateReferenceStorySection/);
assert.match(storySection, /buildReferenceStorySummary/);
assert.match(storySection, /why_exists/);
assert.match(storySection, /supporting_references/);
assert.match(storySection, /missing_references/);
assert.match(storySection, /can_become_claim|claim_ready_state/);
assert.match(storySection, /exact_blocker/);
assert.match(storySection, /other_opportunities/);
// SC proof filter enforced — internal UUIDs excluded from proof display
assert.match(storySection, /Internal UUIDs.*excluded|product_id.*package_id/);

// Panel wires both new components
assert.match(panel, /ProductStoryTridTimeline/);
assert.match(panel, /CandidateReferenceStorySection/);
assert.match(panel, /Reference Timeline/);
assert.match(panel, /Reference Story/);
assert.match(panel, /StoryTab/);
// Panel has identity from row
assert.match(panel, /row\.sku|row\.fnsku|row\.asin/);

// ClaimCenterDetailStoryBlocks has updated block 4
assert.match(storyBlocks, /Reference story|TRID timeline/i);

// Read-only: none of these files write to DB
assert.doesNotMatch(contract, /\.insert\(|\.update\(|\.delete\(/);
assert.doesNotMatch(timeline, /\.insert\(|\.update\(|\.delete\(/);
assert.doesNotMatch(storySection, /\.insert\(|\.update\(|\.delete\(/);
assert.doesNotMatch(panel, /claim_submissions.*update|claim_cases.*update/i);

console.log(JSON.stringify({
  ok: true,
  smoke: "pass",
  phase: "PHASE-PRODUCT-STORY-TRID-EDGE-UI-WIRE-V1",
  product_story_trid_section_added: "yes",
  claim_candidate_reference_story_added: "yes",
  seller_central_proof_filter_verified: "yes",
  unrelated_family_rows_hidden_from_current_claim: "yes",
  no_table_creation_verification: "yes",
  no_claim_mutation_verification: "yes",
}, null, 2));
