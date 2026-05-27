/**
 * REMOVAL PRODUCT RESOLVER WIRE PLAN (read-only)
 *
 * Plans wiring shared product resolver into removal → expected_packages intake.
 * No DB writes. No product creation.
 *
 *   npx tsx scripts/removal-product-resolver-wire-plan.ts --run-id=<UTC_Z>
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
const OUT_BASE = ".cursor/audit-reports/removal-product-resolver-wire-plan";

const RESOLVER_ENTRYPOINTS = [
  "lib/product-identifier-match.ts — pickBestProductIdentifierMatch, fetchProductIdentifierMapCandidates",
  "lib/amazon-operational-product-resolve.ts — resolveProductIdentifierMapMatch",
  "lib/scanner-product-resolve.ts — resolveScannerProductIdentifiers (map → products direct)",
  "lib/scanner/resolve-product-for-scanner-item.ts — scanner/slip alternate path",
  "app/returns/product-input-lookup-actions.ts — manual add lookup (gated catalog evidence)",
] as const;

const FILES_TO_CHANGE = [
  "lib/removal/resolve-expected-package-product.ts (new — hint hydration + queue bucket)",
  "lib/scanner-product-resolve.ts (optional — export queue bucket helper only if shared)",
  "scripts/removal-expected-packages-resolver-backfill-execute.ts (new — dry-run default)",
  ".cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md (new)",
  "supabase/migrations/20260632_expected_packages_detail_driven_rebuild.sql — **no change** (qty/join only)",
] as const;

const FILES_REFERENCE_ONLY = [
  "scripts/return-items-resolver-backfill-v181-staging.ts",
  "scripts/pc03-expected-packages-source-disagreement-reconcile.ts",
  "scripts/pc03c-expected-packages-quarantined-manual-queue.ts",
  "scripts/expected-packages-e2-product-promotion-execute-v194.ts",
  "scripts/pc03d-expected-packages-amazon-evidence-dry-run-execute.ts",
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

async function columnExists(client: pg.Client, table: string, col: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, col],
  );
  return (r.rowCount ?? 0) > 0;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  let branch = "unknown";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* ignore */
  }

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) {
    blockers.push(`Branch is \`${branch}\`; expected \`${REQUIRED_BRANCH}\`.`);
  }

  let epCounts = {
    derived_total: 0,
    resolved: 0,
    unresolved: 0,
    ambiguous: 0,
    with_fnsku: 0,
    with_sku: 0,
  };
  let schema = {
    ep_resolved_product_id: false,
    ep_asin: false,
    removals_asin: false,
  };

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (dbUrl && supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    schema = {
      ep_resolved_product_id: await columnExists(client, "expected_packages", "resolved_product_id"),
      ep_asin: await columnExists(client, "expected_packages", "asin"),
      removals_asin: await columnExists(client, "amazon_removals", "asin"),
    };
    const c = await client.query(`
      SELECT
        COUNT(*)::int AS derived_total,
        COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
        COUNT(*) FILTER (WHERE identifier_resolution_status = 'ambiguous')::int AS ambiguous,
        COUNT(*) FILTER (
          WHERE resolved_product_id IS NULL
            AND (identifier_resolution_status IS NULL OR identifier_resolution_status = 'unresolved')
        )::int AS unresolved,
        COUNT(*) FILTER (WHERE nullif(btrim(fnsku), '') IS NOT NULL)::int AS with_fnsku,
        COUNT(*) FILTER (WHERE nullif(btrim(sku), '') IS NOT NULL)::int AS with_sku
      FROM public.expected_packages
      WHERE build_source IN ('detail_shipment', 'detail_remainder')`);
    epCounts = c.rows[0] as typeof epCounts;
    await client.end();
  } else {
    blockers.push("Staging DB unavailable — counts omitted; schema from migrations only.");
    schema.ep_resolved_product_id = true;
  }

  const planBlockers = [
    "`rebuild_expected_packages_from_removals` does not populate resolver columns (by design).",
    "No removal-specific resolver backfill script in repo.",
    "ASIN/UPC often absent on `expected_packages` rows — must hydrate from `amazon_removals.raw_data` or map-only.",
    "Product promotion (E2) and Amazon evidence (PC03D) remain separate approval-gated executes.",
  ];

  fs.writeFileSync(
    path.join(outDir, "resolver-wire-design.md"),
    [
      "# Resolver wire design",
      "",
      "## Canonical resolver (reuse — do not fork)",
      "",
      "Use **`resolveScannerProductIdentifiers`** (`lib/scanner-product-resolve.ts`) as the single write-model resolver for `expected_packages`.",
      "",
      "It already implements the shared contract:",
      "",
      "1. **`resolveProductIdentifierMapMatch`** (`lib/amazon-operational-product-resolve.ts` → `lib/product-identifier-match.ts`)",
      "   - Tier order in map: **FNSKU → ASIN → seller SKU/MSKU → UPC**",
      "2. **`resolveProductsDirectMatch`** on `products` when map is unresolved",
      "   - Direct order: FNSKU → SKU+ASIN → ASIN → SKU → UPC/barcode",
      "",
      "> Contract prose often lists ASIN before FNSKU for catalog evidence priority; **operational tier order in code is FNSKU-first** (V196). Do not add a removal-only ranking fork.",
      "",
      "## New thin wrapper (planned)",
      "",
      "`lib/removal/resolve-expected-package-product.ts`:",
      "",
      "```typescript",
      "resolveExpectedPackageProduct(supabase, {",
      "  organizationId, storeId, sku, fnsku, asin?, upc?,",
      "  legacyProductId?: null,",
      "}) → { bucket, columns: ScannerResolutionColumns }",
      "```",
      "",
      "- Hydrate `asin` / `upc` from `amazon_removals` via `source_detail_row_id` when EP columns are null.",
      "- Map `identifier_resolution_status` → output queue bucket (below).",
      "- **Never** call `products.insert` / `product_identifier_map.insert`.",
      "",
      "## Separation from rebuild SQL",
      "",
      "| Layer | Responsibility |",
      "|-------|----------------|",
      "| `rebuild_expected_packages_from_removals` | Detail×shipment grain, quantities, tracking fill-null |",
      "| Post-rebuild TS resolver pass | `resolved_product_id` + resolver status columns only |",
      "| Governed promotion | `products.insert` only via E2 + approval + Amazon evidence |",
      "",
      "## Scanner / manual add (reference only)",
      "",
      "- Manual add: `POST /api/dashboard/products` — **creates** products (forbidden on removal path).",
      "- Scanner: `resolveProductForScannerItem` — parallel legacy path; removal intake should use scanner-product-resolve for parity with PC03 / V181 backfill.",
      "",
      "## Entrypoints",
      "",
      ...RESOLVER_ENTRYPOINTS.map((e) => `- ${e}`),
      "",
      "## Staging snapshot (derived expected_packages)",
      "",
      `- Rows: **${epCounts.derived_total}** | resolved_product_id set: **${epCounts.resolved}** | ambiguous: **${epCounts.ambiguous}** | unresolved/null: **${epCounts.unresolved}**`,
      `- With FNSKU: **${epCounts.with_fnsku}** | with SKU: **${epCounts.with_sku}**`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "rebuild-integration-plan.md"),
    [
      "# Rebuild integration plan",
      "",
      "## Current `rebuild_expected_packages_from_removals`",
      "",
      "- Migration: `supabase/migrations/20260632_expected_packages_detail_driven_rebuild.sql`",
      "- **Does not** read or write `resolved_product_id`, `identifier_resolution_status`, or catalog columns.",
      "- UPSERT touch list is removal logistics only (order, sku, fnsku, quantities, tracking, build_source/status).",
      "",
      "## Minimal change strategy",
      "",
      "**Do not embed resolver logic in PL/pgSQL.** Reasons:",
      "",
      "1. Resolver requires `product_identifier_map` priority ranking already implemented in TypeScript.",
      "2. Keeps rebuild idempotent and safe to rerun after each import without clobbering resolver outcomes.",
      "3. Matches `return-items-resolver-backfill-v181-staging.ts` pattern.",
      "",
      "## Post-rebuild hook (recommended)",
      "",
      "```text",
      "rebuild_expected_packages_from_removals(org, store)",
      "  → removal-expected-packages-resolver-backfill (dry-run | execute)",
      "       FOR each EP WHERE build_source IN (detail_shipment, detail_remainder)",
      "         hints ← EP.sku/fnsku + optional join amazon_removals.raw_data",
      "         res ← resolveScannerProductIdentifiers(...)",
      "         UPDATE expected_packages SET resolver columns (fill-null or status-only rules)",
      "```",
      "",
      "## Update rules (execute)",
      "",
      "| Condition | Action |",
      "|-----------|--------|",
      "| `resolved` + new `resolved_product_id` | SET `resolved_product_id`, `resolved_catalog_product_id`, status, confidence |",
      "| `resolved` + existing `resolved_product_id` same | skip |",
      "| `resolved` + existing different | SET status `mismatch`, clear ids (operator review) |",
      "| `ambiguous` | SET status `ambiguous`, clear `resolved_product_id` |",
      "| `unresolved` | SET status `unresolved`, leave `resolved_product_id` null |",
      "",
      "**Never** update `expected_scan_quantity`, `build_source`, or shipment join keys in resolver pass.",
      "",
      "## Optional ASIN hydration",
      "",
      `- \`expected_packages.asin\` column exists: **${schema.ep_asin}**`,
      `- \`amazon_removals.asin\` column exists: **${schema.removals_asin}**`,
      "",
      "If no column, parse `amazon_removals.raw_data` JSON keys (`asin`, `ASIN`) in TS only for resolver hints — do not persist ASIN on EP in v1 unless column added later.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "no-create-guard.md"),
    [
      "# No-create guard",
      "",
      "## Product creation blocked: **YES**",
      "",
      "Removal fetch, rebuild, and resolver backfill **must not** create products.",
      "",
      "## Hard forbids (enforce in code review + execute script)",
      "",
      "| Forbidden | Where it must not appear |",
      "|-----------|-------------------------|",
      "| `products.insert` / `upsert` | resolver backfill, rebuild SQL, SP-API fetch worker |",
      "| `product_identifier_map.insert` | resolver backfill (map bridge = separate E1/E1b approval) |",
      "| Title-only product create | any removal path |",
      "| Browser / mock Amazon catalog | removal resolver |",
      "",
      "## Allowed writes (resolver execute only, with approval)",
      "",
      "- `UPDATE expected_packages` resolver quad: `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`",
      "- Audit artifacts under `.cursor/audit-reports/removal-expected-packages-resolver-backfill-execute/<run_id>/`",
      "",
      "## Static guard (planned execute script)",
      "",
      "```typescript",
      "const FORBIDDEN_TABLES = ['products', 'product_identifier_map', 'catalog_products'] as const;",
      "// assert no .from('products').insert in module",
      "// --execute requires approval file + staging ref match",
      "```",
      "",
      "## CI / grep gate (optional follow-up)",
      "",
      "- Fail if `scripts/removal-*` contains `.from(\"products\").insert`",
      "- Fail if `rebuild_expected_packages_from_removals` migration adds product FK writes",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "product-promotion-queue-contract.md"),
    [
      "# Product promotion queue contract",
      "",
      "## Output queues (resolver read-model)",
      "",
      "Each derived `expected_packages` row classifies into exactly one bucket after `resolveExpectedPackageProduct`:",
      "",
      "| Bucket | `identifier_resolution_status` | `resolved_product_id` | Next action |",
      "|--------|-------------------------------|----------------------|-------------|",
      "| **resolved** | `resolved` | set (deterministic) | None — scanner/Neda hydration |",
      "| **ambiguous** | `ambiguous` | null | PC03C `manual_product_match` queue |",
      "| **missing_product_needs_evidence** | `unresolved` | null | PC03D Amazon evidence dry-run / queue (`requires_amazon_evidence`) |",
      "| **product_promotion_candidate** | `unresolved` | null | E2 promotion plan only if evidence row proves ASIN/FNSKU/SKU tuple |",
      "",
      "### Bucket rules",
      "",
      "**resolved**",
      "- Map or direct `products` match with single winner (`resolveScannerProductIdentifiers`).",
      "",
      "**ambiguous**",
      "- Multiple `product_id` at best tier, or direct `products` query returned >1 id.",
      "",
      "**missing_product_needs_evidence**",
      "- No map/direct match AND at least one of: FNSKU, SKU, ASIN hint present.",
      "- Emit queue row: `{ expected_package_id, sku, fnsku, order_id, build_source, recommended_action: 'requires_amazon_evidence' }`.",
      "- Execute: `pc03d-expected-packages-amazon-evidence-dry-run-execute.ts` (approval-gated).",
      "",
      "**product_promotion_candidate**",
      "- Only after Amazon evidence artifact returns catalog 200 with trusted identifier agreement.",
      "- **Not** allocated by resolver backfill — append to promotion preview JSON for `expected-packages-e2-product-promotion-execute-v194.ts`.",
      "- Requires separate `APPROVED_*` promotion approval; never auto-run from rebuild.",
      "",
      "## Artifact outputs (execute script)",
      "",
      "- `resolver-summary.json` — counts per bucket",
      "- `queue-resolved.jsonl`",
      "- `queue-ambiguous.jsonl` → feed PC03C manual queue format",
      "- `queue-missing-product-needs-evidence.jsonl`",
      "- `queue-product-promotion-candidate.jsonl` (preview only, no insert)",
      "",
      "## Reference queues",
      "",
      ...FILES_REFERENCE_ONLY.map((f) => `- \`${f}\``),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "test-plan.md"),
    [
      "# Test plan",
      "",
      "## Unit (no DB)",
      "",
      "1. Mock `resolveScannerProductIdentifiers` in wrapper tests:",
      "   - FNSKU hit → bucket `resolved`",
      "   - two product_ids at tier 1 → `ambiguous`",
      "   - no hits + fnsku present → `missing_product_needs_evidence`",
      "2. Assert wrapper never imports product promotion execute modules.",
      "",
      "## Integration (mock Supabase)",
      "",
      "- Pattern: `tests/fixtures/sp-api-reports/reimbursements` style fixtures for map rows + products rows.",
      "- Verify UPDATE payload only touches resolver columns.",
      "",
      "## Staging dry-run",
      "",
      "```bash",
      "npx tsx scripts/removal-expected-packages-resolver-backfill-execute.ts --run-id=<UTC_Z>",
      "```",
      "",
      "- Requires staging ref + approval file false → dry-run only.",
      "- Compare counts: resolved + ambiguous + unresolved = scoped rows.",
      "- Sample 20 rows: manual spot-check against `product_identifier_map`.",
      "",
      "## Regression guards",
      "",
      "- Re-run `rebuild_expected_packages_from_removals` → resolver columns unchanged for matched ids (rebuild must not wipe resolver fields — if wipe observed, add COALESCE preserve in rebuild DO UPDATE follow-up).",
      "- SP-API fetch worker: assert `runPipeline: false` still leaves resolver null.",
      "",
      "## Acceptance",
      "",
      "- Zero `products` rows created in audit window.",
      "- All `resolved` rows have FK-existing `products.id`.",
      "- Ambiguous/evidence queues exported for operator review.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [...blockers.map((b) => `- ${b}`), ...planBlockers.map((b) => `- ${b}`)].join("\n") + "\n",
  );

  const nextPrompt =
    "REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-EXECUTE — implement lib/removal/resolve-expected-package-product.ts + dry-run backfill on staging derived expected_packages (no product create)";

  const manifest = {
    prompt: "REMOVAL PRODUCT RESOLVER WIRE PLAN",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: blockers.length ? "BLOCKED" : "PASS",
    product_creation_blocked: true,
    resolver_entrypoint: "lib/scanner-product-resolve.ts::resolveScannerProductIdentifiers",
    rebuild_sql_changes: false,
    schema_snapshot: schema,
    ep_counts: epCounts,
    files_to_change: FILES_TO_CHANGE,
    reference_scripts: FILES_REFERENCE_ONLY,
    exact_next_prompt: nextPrompt,
    forbidden: { db_writes: false, product_create: false },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        product_creation_blocked: true,
        files_to_change: FILES_TO_CHANGE.length,
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
