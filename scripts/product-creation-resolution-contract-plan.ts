/**
 * PRODUCT CREATION + RESOLUTION CONTRACT FOR AMAZON API IMPORTS (read-only)
 *
 *   npx tsx scripts/product-creation-resolution-contract-plan.ts --run-id=<UTC_Z>
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
const OUT_BASE = ".cursor/audit-reports/product-creation-resolution-contract";

const PRODUCT_CREATION_SCRIPTS = [
  "scripts/expected-packages-e2-product-promotion-execute-v194.ts",
  "scripts/product-catalog-wave-a-afi-link-existing-v190a2b.ts",
  "scripts/product-identifier-map-bridge-from-products-v190b.ts",
  "scripts/expected-packages-e1-map-bridge-execute-v192.ts",
  "scripts/expected-packages-e1b-map-bridge-execute-v198.ts",
  "scripts/pc03-exec-expected-packages-dirty-source-fix-execute.ts",
  "scripts/pc03b-expected-packages-source-disagreement-map-execute.ts",
  "app/returns/product-input-lookup-actions.ts (tryBackendCatalogEvidence — gated)",
];

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function columnList(client: pg.Client, table: string): Promise<string[]> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  return (r.rows as Array<{ column_name: string }>).map((x) => x.column_name);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);

  let productsCols: string[] = [];
  let mapCols: string[] = [];
  let counts = { products: 0, active_map: 0, merged_products: 0 };

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (dbUrl && supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    productsCols = await columnList(client, "products");
    mapCols = await columnList(client, "product_identifier_map");
    const c = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM public.products WHERE deleted_at IS NULL) AS products,
        (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map,
        (SELECT COUNT(*)::int FROM public.products WHERE merge_status = 'merged') AS merged_products
    `);
    counts = c.rows[0] as typeof counts;
    await client.end();
  } else {
    blockers.push("Staging DB unavailable — schema snapshot from migrations only");
    productsCols = [
      "id",
      "organization_id",
      "store_id",
      "sku",
      "asin",
      "fnsku",
      "upc_code",
      "barcode",
      "product_name",
      "deleted_at",
      "merge_status",
      "merged_into_id",
    ];
    mapCols = [
      "id",
      "organization_id",
      "store_id",
      "product_id",
      "catalog_product_id",
      "seller_sku",
      "msku",
      "asin",
      "fnsku",
      "upc_code",
      "external_listing_id",
      "match_source",
      "confidence_score",
      "deleted_at",
      "linked_from_report_family",
      "linked_from_target_table",
    ];
  }

  const minimumEvidence = {
    required_hard_identifier:
      "At least one of: valid ASIN (B0…), X-FNSKU, or non-junk seller_sku (not UNKNOW/UNKNOWN)",
    asin: "Required when SP-API catalog is the sole evidence source",
    fnsku_or_sku: "At least one required for FBA operational rows",
    product_name: "Required on product row but MUST NOT be sole trigger for create",
    marketplace: "store_id + marketplace_id via stores/marketplaces",
    source_api_or_report:
      "match_source + linked_from_report_family / upload_id / source_row_id lineage",
    confidence: "identifier_resolution_confidence or map confidence_score documented",
    amazon_evidence:
      "SP-API catalog HTTP 200 with summaries OR trusted amazon_* row (AFI/FBA inventory) with same identifier tuple",
    forbidden: ["title_only", "image_only", "gpt_inferred_asin", "duplicate_asin_ambiguous_spine"],
  };

  const creationByCase = [
    { case: "Single winner via product_identifier_map", product_create: "no", map_insert: "only_if_missing_and_approved" },
    { case: "Single winner via products direct match (sku/fnsku/asin)", product_create: "no", map_insert: "optional_bridge" },
    { case: "SP-API catalog 200 + ASIN + (FNSKU or seller_sku) agree", product_create: "yes_governed", map_insert: "yes_after_create" },
    { case: "Trusted report row (AFI/FBA) name + identifiers, no product", product_create: "yes_e2_style", map_insert: "yes" },
    { case: "Catalog title/image only", product_create: "no", map_insert: "no" },
    { case: "Ambiguous map (>1 product_id)", product_create: "no", map_insert: "no" },
    { case: "Ambiguous products direct (>1 id)", product_create: "no", map_insert: "no" },
    { case: "PIM Product Master import", product_create: "separate_pim_governed", map_insert: "pim_upsert" },
    { case: "Removal import row before resolver", product_create: "no", map_insert: "no" },
  ];

  fs.writeFileSync(
    path.join(outDir, "product-resolution-contract.md"),
    [
      "# Product resolution contract — Amazon API imports",
      "",
      `**Run:** \`${OUT_BASE}/${runId}\` | **Branch:** \`${branch}\``,
      "",
      "## Core rule",
      "",
      "Every imported Amazon operational line must resolve to exactly one `product_id` before intake rows are considered linkage-complete.",
      "",
      "## Resolution order (canonical)",
      "",
      "Apply in order; stop at first **deterministic single winner**:",
      "",
      "| Step | Source | Implementation |",
      "|------|--------|----------------|",
      "| 1 | **ASIN** | `product_identifier_map` tier 2, `products.asin`, catalog evidence |",
      "| 2 | **FNSKU** | Map tier 1, `products.fnsku`, inventory spine |",
      "| 3 | **Seller SKU / MSKU** | Map tier 3, `products.sku`, removal/report sku |",
      "| 4 | **UPC / GTIN** | Map tier 4, `products.upc_code` / `barcode` — digits-only, GTIN-14 normalize |",
      "| 5 | **`product_identifier_map`** | `resolveProductIdentifierMapMatch` / `pickBestProductIdentifierMatch` |",
      "| 6 | **`products` direct** | `resolveProductsDirectMatch` in `lib/scanner-product-resolve.ts` |",
      "",
      "> Code note: `lib/product-identifier-match.ts` ranks map tiers as FNSKU→ASIN→SKU→UPC; the table above is the **business priority** for Amazon API imports. When both apply, prefer **identifier agreement across map + products + evidence** over tier alone.",
      "",
      "## If product exists",
      "",
      "- Use existing `product_id` (reject `merge_status=merged` losers; follow `merged_into_id` chain depth ≤ 1)",
      "- Insert **missing** map rows only when deterministic, no identifier collision, and execute approval grants map insert",
      "- Do **not** update `products` identifiers from report drift without governed source-fix prompt",
      "",
      "## If product does not exist",
      "",
      "1. Obtain **real Amazon evidence** (see `product-creation-minimum-evidence.md`)",
      "2. Run **approval-gated promotion** on staging (`expected-packages-e2-product-promotion` pattern)",
      "3. `INSERT products` + `INSERT product_identifier_map` in one transaction with preimage",
      "4. Backfill `resolved_product_id` on operational rows via separate governed prompt (never title-only)",
      "",
      "## Staging schema snapshot",
      "",
      `- **products** rows (active): **${counts.products}** | merged: **${counts.merged_products}**`,
      `- **product_identifier_map** (active): **${counts.active_map}**`,
      "",
      "### Key `products` columns",
      "",
      productsCols.filter((c) =>
        /^(id|organization|store|sku|asin|fnsku|upc|barcode|product_name|merge|deleted)/.test(c),
      ).map((c) => `- \`${c}\``).join("\n"),
      "",
      "### Key `product_identifier_map` columns",
      "",
      mapCols.filter((c) =>
        /^(id|organization|store|product|seller|msku|asin|fnsku|upc|external|match|confidence|deleted|linked)/.test(c),
      ).map((c) => `- \`${c}\``).join("\n"),
      "",
      "## Non-negotiable guards",
      "",
      "- `PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED=false` until explicit promotion approval",
      "- `AMAZON_SP_API_ENABLED=false` for evidence pass-1 (`.ai-memory/SP_API_STATE.md`)",
      "- No browser-side `products.insert`",
      "- `npm run check:product-resolution-contract-v192` must pass before linkage execute waves",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "product-creation-minimum-evidence.md"),
    [
      "# Product creation — minimum evidence",
      "",
      "## Minimum bundle (ALL required for `products.insert`)",
      "",
      "| Field | Requirement |",
      "|-------|-------------|",
      "| **Hard identifier** | ≥1 of: ASIN (`^B[0-9A-Z]{9}$`), X-FNSKU (`^X…`), seller_sku (not UNKNOW/UNKNOWN/placeholder) |",
      "| **ASIN** | Required when catalog SP-API is primary evidence; must match catalog response |",
      "| **FNSKU or SKU** | Required for FBA/removal operational cohorts |",
      "| **product_name** | From Amazon evidence field (`itemName`, `product_name`, trusted inventory) — **not** operator free text |",
      "| **marketplace** | `store_id` + marketplace id (e.g. `ATVPDKIKX0DER`) on evidence record |",
      "| **source** | `match_source` + `linked_from_report_family` / `linked_from_target_table` OR external_listing_id prefix |",
      "| **lineage** | `upload_id`, `source_row_id`, `run_id`, evidence artifact path |",
      "| **confidence** | `confidence_score` ≥ 0.85 for promotion; map tier confidence preserved |",
      "",
      "## Acceptable evidence sources",
      "",
      "| Source | Accept for create? |",
      "|--------|-------------------|",
      "| SP-API Catalog Items GET 200 + identifier match | **Yes** (with promotion approval) |",
      "| `amazon_fba_inventory` / `amazon_manage_fba_inventory` / AFI row with identifiers + name | **Yes** (E2 trusted spine) |",
      "| Removal Order/Shipment report row alone | **No** — resolve first; create only after cross-check |",
      "| Spreadsheet / operator sheet | **No** for products — packaging-only path |",
      "| GPT / OpenAI classification | **No** |",
      "",
      "## Forbidden create triggers",
      "",
      ...minimumEvidence.forbidden.map((f) => `- ${f}`),
      "",
      "## JSON machine summary",
      "",
      "```json",
      JSON.stringify(minimumEvidence, null, 2),
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "product-promotion-flow.md"),
    [
      "# Product promotion flow (approval-gated)",
      "",
      "```mermaid",
      "flowchart TD",
      "  A[Import line identifiers] --> B{Resolver}",
      "  B -->|single product_id| C[Use existing]",
      "  B -->|unresolved| D{Evidence gather}",
      "  D -->|SP-API catalog| E[Evidence dry-run PC02/PC03D]",
      "  D -->|Report spine| F[Trusted source query]",
      "  E --> G{Meets minimum evidence?}",
      "  F --> G",
      "  G -->|no| H[Manual queue / quarantine]",
      "  G -->|yes| I{Approvals true?}",
      "  I -->|no| J[Plan only — STOP]",
      "  I -->|yes| K[E2-style promotion execute]",
      "  K --> L[INSERT products]",
      "  L --> M[INSERT product_identifier_map]",
      "  M --> N[Map-only / resolver backfill on EP/returns]",
      "```",
      "",
      "## Approval chain (staging)",
      "",
      "| Stage | Approval file | Flags |",
      "|-------|---------------|-------|",
      "| SP-API evidence | `sp-api-product-evidence-dry-run-pc02-approval.md` | `APPROVED_SP_API_EVIDENCE_DRY_RUN` |",
      "| Amazon API enrichment | `expected-packages-amazon-api-enrichment-v194-approval.md` | `APPROVED_EXPECTED_PACKAGES_AMAZON_API_ENRICHMENT_V194` |",
      "| Product promotion | `expected-packages-e2-product-promotion-v194-approval.md` | `APPROVED_EXPECTED_PACKAGES_E2_PRODUCT_PROMOTION_V194` |",
      "| Map-only bridge | `expected-packages-e1b-map-bridge-*` / PC03 approvals | map insert only |",
      "| Removal import | `removal-shipment-normalized-import-staging-approval.md` | no create in import phase |",
      "",
      "## Execute scripts (reference)",
      "",
      ...PRODUCT_CREATION_SCRIPTS.map((s) => `- \`${s}\``),
      "",
      "## Ordering for Removal Shipment/Detail API track",
      "",
      "1. Fetch reports (no product writes)",
      "2. Sync `amazon_removals` + `amazon_removal_shipments`",
      "3. Rebuild `expected_packages`",
      "4. Resolver census → map-only for resolvable",
      "5. Evidence dry-run for unresolved with X-FNSKU",
      "6. Governed promotion (if evidence passes)",
      "7. `resolved_product_id` backfill (separate approval)",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "identifier-map-rules.md"),
    [
      "# Identifier map rules",
      "",
      "## Insert eligibility",
      "",
      "- `organization_id` + `store_id` required",
      "- `product_id` must reference live `products` row (`deleted_at IS NULL`, not merged loser)",
      "- At least one of: `seller_sku`, `fnsku`, `asin`, `upc_code`",
      "- `external_listing_id` unique per (org, store) when used",
      "",
      "## Uniqueness (DB)",
      "",
      "| Index | Scope |",
      "|-------|-------|",
      "| `uq_imap_org_store_sku` | One active `seller_sku` per store |",
      "| `uq_product_identifier_map_product_identity` | Product Identity uploads via `external_listing_id` |",
      "| ASIN / FNSKU | **Not globally unique** — multiple seller SKUs per ASIN allowed |",
      "",
      "## match_source conventions",
      "",
      "| match_source | Use |",
      "|--------------|-----|",
      "| `expected_packages_e2_product_promotion_v194` | E2 promotion |",
      "| `expected_packages_pc03exec_dirty_source_map` | PC03 map-only |",
      "| `product_bridge_v190b` | Bridge from existing products |",
      "| `amazon_api_import_v1:<report>:<upload_id>` | **Proposed** for removal SP-API track |",
      "",
      "## Map-only vs create",
      "",
      "- **Map-only execute:** insert map row pointing at **existing** `product_id` — never creates product",
      "- **Promotion execute:** creates product **then** map in same transaction",
      "- Never insert map that points to a different `product_id` than an existing active identifier owner (E2 conflict check)",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "duplicate-prevention-rules.md"),
    [
      "# Duplicate prevention + rollback",
      "",
      "## Prevention",
      "",
      "| Layer | Rule |",
      "|-------|------|",
      "| Pre-insert | Conflict query: no existing `products` with same org/store + (fnsku \\| sku \\| asin) |",
      "| Map | `ON CONFLICT DO NOTHING` or skip if `external_listing_id` / `seller_sku` exists |",
      "| ASIN | Multiple products per ASIN allowed; do not auto-merge without merge winner prompt |",
      "| Promotion batch | Group by identifier tuple; one product per group (E2) |",
      "| Merged losers | Exclude `merge_status=merged` from resolver winners |",
      "",
      "## Rollback",
      "",
      "Every execute must emit:",
      "",
      "- `preimage.json` — products + map rows before write",
      "- `rollback.sql` — `DELETE FROM product_identifier_map WHERE external_listing_id IN (…)` then `DELETE FROM products WHERE id IN (…)`",
      "- Promotion runs must rollback **map first**, then product (FK)",
      "",
      "## Removal import safety",
      "",
      "- Removal sync must not call `products.insert`",
      "- `expected_packages` rebuild must not fabricate `resolved_product_id`",
      "- Product promotion is a **separate** governed prompt after evidence PASS",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length
      ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
      : "- Contract plan complete; no DB writes.\n- Live product create blocked until promotion + SP-API approvals.\n",
  );

  const nextPrompt =
    "AMAZON-API-PRODUCT-RESOLVER-WIRE — implement shared resolver + promotion gate for removal import (after SP-API removal fetch + evidence approvals)";

  const manifest = {
    prompt: "PRODUCT CREATION + RESOLUTION CONTRACT FOR AMAZON API IMPORTS",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: blockers.length ? "BLOCKED" : "PASS",
    minimum_required_evidence: minimumEvidence,
    product_creation_by_case: creationByCase,
    product_creation_scripts_audited: PRODUCT_CREATION_SCRIPTS,
    staging_counts: counts,
    exact_next_prompt: nextPrompt,
    forbidden: { db_writes: true, product_create_default: false },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: !blockers.length,
        outDir,
        minimum_required_evidence: minimumEvidence.required_hard_identifier,
        creation_by_case: creationByCase,
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
