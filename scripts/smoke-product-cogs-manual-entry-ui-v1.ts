/**
 * smoke-product-cogs-manual-entry-ui-v1 — static safety checks
 *   npx tsx scripts/smoke-product-cogs-manual-entry-ui-v1.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lib = readFileSync("lib/claims/submission/product-cogs-manual-entry-ui-v1.ts", "utf8");
const api = readFileSync("app/api/claims/center/reimbursement-tracking/cogs/route.ts", "utf8");
const view = readFileSync(
  "components/claim-center/reimbursement-tracking/ProductCogsManualEntryView.tsx",
  "utf8",
);
const drawer = readFileSync(
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx",
  "utf8",
);

assert.match(lib, /dryRunOnly: true/);
assert.match(lib, /noDbWrite: true/);
assert.match(lib, /matches_sale_price/);
assert.match(lib, /ambiguous_match/);
assert.match(lib, /PILOT_FNSKUS_V1/);
assert.doesNotMatch(lib, /\.insert\(/);
assert.doesNotMatch(lib, /\.update\(/);
assert.doesNotMatch(api, /\.insert\(/);
assert.doesNotMatch(api, /\.update\(/);
assert.match(view, /dry-run/i);
assert.match(view, /safetyBanner/);
assert.match(lib, /This only previews approved COGS/);
assert.match(drawer, /Add COGS/);
assert.match(
  readFileSync("components/claim-center/reimbursement-tracking/ReimbursementTrackingView.tsx", "utf8"),
  /COGS missing/,
);

console.log(JSON.stringify({ ok: true, smoke: "pass" }, null, 2));
