/**
 * PHASE1-BLOCKER-RETURNS-UNGUARDED-PRODUCT-INSERT-FIX — static governance checks.
 * Run: npx tsx scripts/test-product-input-lookup-no-auto-create.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LOOKUP = join(process.cwd(), "app/returns/product-input-lookup-actions.ts");
const content = readFileSync(LOOKUP, "utf8");

assert.doesNotMatch(content, /\.from\s*\(\s*["']products["']\s*\)[\s\S]{0,120}?\.insert\s*\(/);
assert.doesNotMatch(
  content,
  /\.from\s*\(\s*["']product_identifier_map["']\s*\)[\s\S]{0,120}?\.insert\s*\(/,
);
assert.match(content, /product_auto_create_blocked_catalog_evidence_only/);
assert.match(content, /status: "backend_evidence"/);
assert.doesNotMatch(content, /product_input_lookup_v193_backend_enriched/);

console.log(
  JSON.stringify(
    {
      ok: true,
      prompt: "PHASE1-BLOCKER-RETURNS-UNGUARDED-PRODUCT-INSERT-FIX",
      file: "app/returns/product-input-lookup-actions.ts",
    },
    null,
    2,
  ),
);
