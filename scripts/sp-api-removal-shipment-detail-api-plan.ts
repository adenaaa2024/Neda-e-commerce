/**
 * SP-API REMOVAL SHIPMENT + REMOVAL DETAIL API PLAN (read-only)
 *
 * Plans Amazon removal ingestion via SP-API Reports → existing sync → expected_packages.
 * No Amazon HTTP. No DB writes.
 *
 *   npx tsx scripts/sp-api-removal-shipment-detail-api-plan.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/sp-api-removal-shipment-detail-api-plan";
const APPROVAL_FETCH = ".cursor/operator-approvals/sp-api-removal-shipment-fetch-approval.md";
const APPROVAL_IMPORT = ".cursor/operator-approvals/removal-shipment-normalized-import-staging-approval.md";

const SP_API_REPORT_ORDER = "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA";
const SP_API_REPORT_SHIPMENT = "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA";

const EXISTING_TABLES = [
  "raw_report_uploads",
  "raw_report_import_audit",
  "amazon_staging",
  "amazon_removals",
  "amazon_removal_shipments",
  "expected_packages",
  "products",
  "product_identifier_map",
  "removal_item_allocations",
  "shipment_box_items",
  "import_pipeline_locks",
] as const;

const PROPOSED_OPTIONAL_TABLES = [
  "raw_removal_shipments",
  "raw_removal_shipment_details",
  "normalized_removal_shipments",
  "normalized_removal_shipment_items",
] as const;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function writeApproval(
  relPath: string,
  title: string,
  scopeFlag: string,
  body: string,
): void {
  fs.writeFileSync(
    path.join(process.cwd(), relPath),
    `# ${title}

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| Production / original | forbidden |
| Product create from title only | forbidden |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
${scopeFlag}=false
\`\`\`

${body}

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
${scopeFlag}=false
Approved by:
UTC date:
\`\`\`
`,
  );
}

async function tableExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [name],
  );
  return (r.rowCount ?? 0) > 0;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const existingFound: string[] = [];
  const missingProposed: string[] = [];
  let removalsCount = 0;
  let shipmentsCount = 0;
  let expectedDerivedCount = 0;

  if (dbUrl && supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("SET statement_timeout = '60s'");
    for (const t of EXISTING_TABLES) {
      if (await tableExists(client, t)) existingFound.push(t);
    }
    for (const t of PROPOSED_OPTIONAL_TABLES) {
      if (!(await tableExists(client, t))) missingProposed.push(t);
    }
    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM public.amazon_removals) AS removals,
        (SELECT COUNT(*)::int FROM public.amazon_removal_shipments) AS shipments,
        (SELECT COUNT(*)::int FROM public.expected_packages
          WHERE build_source IN ('detail_shipment', 'detail_remainder')) AS ep_derived
    `);
    removalsCount = Number(counts.rows[0]?.removals ?? 0);
    shipmentsCount = Number(counts.rows[0]?.shipments ?? 0);
    expectedDerivedCount = Number(counts.rows[0]?.ep_derived ?? 0);
    await client.end();
  } else {
    blockers.push("STAGING_DIRECT_POSTGRES_URL unset or wrong ref — schema counts skipped");
    existingFound.push(...EXISTING_TABLES);
    missingProposed.push(...PROPOSED_OPTIONAL_TABLES);
  }

  writeApproval(
    APPROVAL_FETCH,
    "SP-API removal shipment fetch",
    "APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH",
    `## Scope\n\n- Reports API fetch for:\n  - \`${SP_API_REPORT_ORDER}\`\n  - \`${SP_API_REPORT_SHIPMENT}\`\n- Download → synthetic \`raw_report_uploads\` (no direct domain write in fetch phase)`,
  );
  writeApproval(
    APPROVAL_IMPORT,
    "Removal shipment normalized import (staging)",
    "APPROVED_REMOVAL_SHIPMENT_NORMALIZED_IMPORT",
    `## Scope\n\n- Run existing REMOVAL_ORDER / REMOVAL_SHIPMENT sync + \`rebuild_expected_packages_from_removals\`\n- Map-only / governed product promotion only (no title-only create)`,
  );

  const joinKeyRecommendation = [
    "**Primary join (detail demand × shipment supply):**",
    "`organization_id` + `store_id` + `order_id` + `order_type` + `order_date` + `sku` + `fnsku` + `disposition` (NULL-safe `IS NOT DISTINCT FROM`).",
    "",
    "**Shipment header grain (operational, not join key):**",
    "After line join, group by `tracking_number` + `carrier` + `shipment_date` for warehouse shipment containers.",
    "",
    "**Forbidden:** SKU-only or FNSKU-only join without `order_id` + `order_type` + `order_date` + `disposition`.",
  ].join("\n");

  fs.writeFileSync(
    path.join(outDir, "removal-api-source-plan.md"),
    [
      "# Removal API / report source plan",
      "",
      `**Run:** \`${OUT_BASE}/${runId}\``,
      "",
      "## Terminology map (business ↔ Amazon ↔ repo)",
      "",
      "| Your business term | Amazon SP-API report | Sync kind | Table | Grain |",
      "|-------------------|---------------------|-----------|-------|-------|",
      "| **Removal Shipment Detail** (item/line) | `GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA` | `REMOVAL_ORDER` | `amazon_removals` | Demand line: sku, fnsku, disposition, requested/shipped qty |",
      "| **Removal Shipment** (header/container) | `GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA` | `REMOVAL_SHIPMENT` | `amazon_removal_shipments` | Fulfillment line + **tracking_number**, carrier, shipment_date |",
      "",
      "> Amazon names both reports \"…DETAIL_DATA\"; in this project **order detail = item truth**, **shipment detail = container/tracking truth**. Do not swap them.",
      "",
      "**Header grain (derived, not a separate raw table):**",
      "`GROUP BY organization_id, store_id, order_id, order_type, tracking_number, carrier, shipment_date` on `amazon_removal_shipments`.",
      "",
      "**Item grain:** `amazon_removals` row, joined to shipment lines on the 7-tuple below (not SKU-only).",
      "",
      "## Current ingestion (live today)",
      "",
      "1. Operator CSV upload → `raw_report_uploads` + `amazon_staging`",
      "2. Phase 3 sync:",
      "   - `REMOVAL_ORDER` → `amazon_removals` (`lib/import-sync-mappers.ts` `mapRowToAmazonRemoval`)",
      "   - `REMOVAL_SHIPMENT` → `amazon_removal_shipments` (`mapRowToAmazonRemovalShipment`)",
      "3. Phase 4 generic (shipment uploads): `rebuild_shipment_tree_from_removal_shipments`, enrichment patch to `amazon_removals`",
      "4. Derived intake: `rebuild_expected_packages_from_removals()` → `expected_packages` (`build_source` detail_shipment | detail_remainder)",
      "",
      "**Anchors:** `lib/pipeline/amazon-report-registry.ts`, `app/api/settings/imports/sync/route.ts`, `supabase/migrations/20260631_expected_packages_derived_rebuild.sql`",
      "",
      "## SP-API track (planned — not wired)",
      "",
      "| Step | Action |",
      "|------|--------|",
      "| 1 | `POST /reports/2021-06-30/reports` with `reportType` = order or shipment report above |",
      "| 2 | Poll `getReport` until `DONE` |",
      "| 3 | `getReportDocument` → download tab-delimited file |",
      "| 4 | Synthetic upload via `lib/amazon/reports-api-synthetic-upload.ts` pattern (same as reimbursements worker) |",
      "| 5 | Reuse **existing** Phase 3/4 sync — no parallel mapper |",
      "",
      "Crosswalk: `lib/amazon/amazon-report-type-crosswalk.ts`",
      "",
      "## What is NOT in repo today",
      "",
      "- No removal-specific Reports API worker (reimbursements/settlement only)",
      "- No live SP-API removal pull in production path (`PROJECT_CONTEXT.md` / `FORBIDDEN_ACTIONS.md`)",
      "- No `accepted_packages` table — operational intake is `expected_packages` only",
      "",
      "## Staging row counts (snapshot)",
      "",
      `- \`amazon_removals\`: **${removalsCount}**`,
      `- \`amazon_removal_shipments\`: **${shipmentsCount}**`,
      `- \`expected_packages\` derived (detail_shipment + detail_remainder): **${expectedDerivedCount}**`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "removal-shipment-detail-join-contract.md"),
    [
      "# Removal shipment ↔ detail join contract",
      "",
      "## Canonical join (implemented)",
      "",
      "Function: `rebuild_expected_packages_from_removals`",
      "",
      "```sql",
      "detail amazon_removals d",
      "JOIN shipment amazon_removal_shipments s",
      "  ON s.organization_id = d.organization_id",
      " AND s.store_id    IS NOT DISTINCT FROM d.store_id",
      " AND s.order_id    IS NOT DISTINCT FROM d.order_id",
      " AND s.order_type  IS NOT DISTINCT FROM d.order_type",
      " AND s.order_date  IS NOT DISTINCT FROM d.order_date",
      " AND s.sku         IS NOT DISTINCT FROM d.sku",
      " AND s.fnsku       IS NOT DISTINCT FROM d.fnsku",
      " AND s.disposition IS NOT DISTINCT FROM d.disposition",
      "```",
      "",
      "## Join key recommendation",
      "",
      joinKeyRecommendation,
      "",
      "## Quantity reconciliation",
      "",
      "- **Matched pair:** `expected_scan_quantity` = shipment `shipped_quantity`",
      "- **Remainder:** sum(shipment qty) < detail `shipped_quantity` → `build_source = detail_remainder`",
      "- **Overflow:** sum(shipment qty) > detail → `build_status = shipment_overflow_conflict`",
      "",
      "## Enrichment (non-join)",
      "",
      "`buildRemovalFillFromShipment` patches `amazon_removals` tracking/carrier/shipment_date from shipment rows — fill-only, never identity.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "removal-normalized-schema-plan.md"),
    [
      "# Removal normalized schema plan",
      "",
      "## Existing tables (use first)",
      "",
      ...existingFound.map((t) => `- \`${t}\` ✓`),
      "",
      "## Proposed names — status",
      "",
      "| Proposed | Recommendation |",
      "|----------|----------------|",
      "| `raw_removal_shipments` | **Defer** — use `amazon_removal_shipments.raw_row` + `amazon_staging` lineage |",
      "| `raw_removal_shipment_details` | **Defer** — use `amazon_removals.raw_data` + staging |",
      "| `normalized_removal_shipments` | **Optional view** over `amazon_removal_shipments` with header grain |",
      "| `normalized_removal_shipment_items` | **Optional view** over `amazon_removals` OR joined pair |",
      "",
      "Missing on staging today:",
      "",
      ...missingProposed.map((t) => `- \`${t}\` — not present`),
      "",
      "## Recommended layering (SP-API track)",
      "",
      "```",
      "SP-API Reports download",
      "  → raw_report_uploads (source_run metadata)",
      "  → amazon_staging (physical lines)",
      "  → amazon_removals | amazon_removal_shipments (typed domain)",
      "  → [optional] v_normalized_removal_* views",
      "  → expected_packages (derived intake)",
      "```",
      "",
      "Add physical `normalized_*` tables only if view performance or API-json audit requires append-only JSON separate from `raw_row`.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "product-resolution-contract.md"),
    [
      "# Product resolution contract",
      "",
      "Canonical contract: `.cursor/audit-reports/product-creation-resolution-contract/` (full evidence + promotion gates).",
      "",
      "## Resolver order for removal import (summary)",
      "",
      "1. ASIN → 2. FNSKU → 3. seller SKU → 4. UPC (trustworthy) → 5. `product_identifier_map` → 6. `products` direct",
      "",
      "Per intake row after `expected_packages` rebuild:",
      "",
      "1. `resolved_product_id` if set",
      "2. Map tiers (`lib/product-identifier-match.ts`: FNSKU → ASIN → SKU → UPC)",
      "3. Inventory spine for **evidence only** (not auto-create)",
      "4. SP-API catalog evidence dry-run — never title-only create",
      "",
      "## If product exists",
      "",
      "- Set `resolved_product_id` on intake row after map bridge or governed backfill",
      "- Insert `product_identifier_map` only when identifiers are trusted (import source, not title)",
      "",
      "## If product missing",
      "",
      "| Evidence quality | Action |",
      "|------------------|--------|",
      "| Real Amazon identifiers + catalog 200 | Plan **E2-style promotion** (`expected-packages-e2-product-promotion`) with separate approval |",
      "| Title/image only | **BLOCK** — never create from title alone |",
      "| Ambiguous multi-product spine | **manual_product_match** queue (PC03C pattern) |",
      "",
      "## Product creation risk",
      "",
      "**Risk level: HIGH** if execute path allows:",
      "- `products.insert` from catalog `itemName` without FNSKU/SKU/ASIN agreement",
      "- SKU-only collision across distinct FNSKUs",
      "",
      "**Mitigations (required in execute prompt):**",
      "",
      "- Promotion requires `APPROVED_*` + trusted identifier tuple",
      "- Map insert uses `match_source` lineage (`removal_spapi_v1` / upload id)",
      "- No `products.insert` in fetch or normalized import phases",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "expected-accepted-intake-mapping.md"),
    [
      "# Expected / accepted intake mapping",
      "",
      "## accepted_packages",
      "",
      "**No `accepted_packages` table in schema.** Operational intake = **`expected_packages`**.",
      "",
      "## Mapping: normalized pair → expected_packages",
      "",
      "| Source | Target column |",
      "|--------|---------------|",
      "| `amazon_removals.id` | `source_detail_row_id` |",
      "| `amazon_removal_shipments.id` | `source_shipment_row_id` (NULL on remainder) |",
      "| shipment `tracking_number` | `tracking_number` |",
      "| shipment `carrier` | `carrier` |",
      "| shipment `shipment_date` | `shipment_date` |",
      "| line `sku` / `fnsku` | `sku` / `fnsku` |",
      "| line `order_id` / `order_type` / `disposition` | same |",
      "| — | `build_source` = `detail_shipment` \\| `detail_remainder` |",
      "| — | `build_status` = `matched` \\| `awaiting_shipment_match` \\| `shipment_overflow_conflict` |",
      "| — | `expected_scan_quantity`, `shipment_row_quantity` |",
      "",
      "## Status semantics",
      "",
      "| build_source | Meaning |",
      "|--------------|---------|",
      "| `legacy` | Pre-rebuild canonical 7-tuple rows |",
      "| `detail_shipment` | Detail line matched to a shipment line |",
      "| `detail_remainder` | Detail qty not fully covered by shipments |",
      "",
      "## Future accepted layer",
      "",
      "Warehouse **actual** scans remain separate (`removal_scan_events` in full pipeline plan) — do not overwrite expected rows in place.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "duplicate-prevention-rules.md"),
    [
      "# Duplicate prevention rules",
      "",
      "## Physical / upload layer",
      "",
      "| Table | Dedupe key |",
      "|-------|------------|",
      "| `amazon_staging` | upload + staging line (`REMOVAL_ORDER`: staging_line; `REMOVAL_SHIPMENT`: upload + staging id) |",
      "| `amazon_removal_shipments` | `(organization_id, upload_id, amazon_staging_id)` |",
      "| `amazon_removals` | `(organization_id, upload_id, source_staging_id)` + business line `uq_amazon_removals_business_line` |",
      "",
      "## Cross-upload shipment",
      "",
      "- `runRemovalShipmentSync` skips rows whose business shipment key already exists from another upload",
      "",
      "## Derived expected_packages",
      "",
      "| Index | Scope |",
      "|-------|-------|",
      "| `uq_expected_packages_derived_pair` | `(organization_id, source_detail_row_id, source_shipment_row_id)` WHERE build_source IN (detail_shipment, detail_remainder) |",
      "| `uq_expected_packages_canonical_legacy` | 7-tuple WHERE build_source = legacy |",
      "",
      "## SP-API fetch phase",
      "",
      "- Content-address uploads (`content_sha256`) with optional `removal_shipment_replace_same_file_sha`",
      "- Re-fetch must not double-insert staging lines (reuse existing sync idempotency)",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "approval-files.md"),
    [
      "# Approval files",
      "",
      "| File | Flag | Purpose |",
      "|------|------|---------|",
      `| \`${APPROVAL_FETCH}\` | \`APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH\` | Reports API create/download only |`,
      `| \`${APPROVAL_IMPORT}\` | \`APPROVED_REMOVAL_SHIPMENT_NORMALIZED_IMPORT\` | Staging sync + rebuild expected_packages |`,
      "",
      "Both require `APPROVED_TO_RUN_STAGING=true`.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length
      ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
      : [
          "- Read-only plan complete.",
          "- No removal Reports API worker implemented yet.",
          "- SP-API removal fetch remains operator-gated.",
        ].join("\n") + "\n",
  );

  const nextPrompt =
    "SP-API-REMOVAL-REPORTS-FETCH-WORKER-PLAN — implement GET_FBA_FULFILLMENT_REMOVAL_* Reports worker + synthetic upload (after APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH=true)";

  const manifest = {
    prompt: "SP-API REMOVAL SHIPMENT + REMOVAL DETAIL API PLAN",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: blockers.length ? "BLOCKED" : "PASS",
    existing_tables_found: existingFound,
    missing_tables_needed: missingProposed,
    join_key_recommendation:
      "organization_id + store_id + order_id + order_type + order_date + sku + fnsku + disposition (NULL-safe); never SKU-only",
    product_creation_risk: "HIGH if title-only promotion allowed; mitigated by map-only + governed E2 promotion",
    sp_api_report_types: {
      removal_order_detail: SP_API_REPORT_ORDER,
      removal_shipment_detail: SP_API_REPORT_SHIPMENT,
    },
    approval_files: [APPROVAL_FETCH, APPROVAL_IMPORT],
    exact_next_prompt: nextPrompt,
    forbidden: { amazon_api_called: false, db_writes: false },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: !blockers.length,
        outDir,
        existing_tables_found: existingFound.length,
        missing_tables_needed: missingProposed.length,
        join_key_recommendation: manifest.join_key_recommendation,
        product_creation_risk: manifest.product_creation_risk,
        next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
