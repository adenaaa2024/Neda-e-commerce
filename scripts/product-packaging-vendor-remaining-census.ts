/**
 * PRODUCT PACKAGING + VENDOR REMAINING CENSUS (read-only)
 *
 *   npx tsx scripts/product-packaging-vendor-remaining-census.ts --run-id=<UTC_Z>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/product-packaging-vendor-remaining-census";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const STAGING_SPREADSHEET_BATCH = "SPREADSHEET_DIMENSIONS_20260528T010000Z";
const ORIGINAL_SPREADSHEET_BATCH = "SPREADSHEET_DIMENSIONS_ORIGINAL_20260528T070000Z";
const EXPECTED_SPREADSHEET_ROWS = 80;
const EXPECTED_DIMENSIONS_CURRENT = 571;
const VENDOR_PLAN = ".cursor/audit-reports/vendor-1883-cleanup-plan-review/20260528T120000Z";
const VENDOR_EXECUTE_BASE = ".cursor/audit-reports/vendor-1883-cleanup-staging-execute";
const SPREADSHEET_PARITY_RUN = ".cursor/audit-reports/spreadsheet-packaging-full-parity-verify/20260528T130000Z";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

type EnvSnapshot = {
  ref: string;
  profiles_total: number;
  versions_total: number;
  dimensions_current_total: number;
  spreadsheet_active_profiles: number;
  spreadsheet_needs_review_profiles: number;
  spreadsheet_import_source_active: number;
  products_total: number;
  catalog_products_total: number;
  map_total: number;
  vendor_bare_1883: number;
  vendor_cleaned_1883_brand_prefix: number;
  vendor_plan_still_bare: number;
  vendor_plan_cleaned: number;
  expected_packages_total: number;
  expected_packages_resolved: number;
  expected_packages_unresolved: number;
  expected_packages_ambiguous: number;
  return_items_total: number;
  return_items_unresolved: number;
  return_items_ambiguous: number;
};

async function connect(url: string, expectedRef: string): Promise<pg.Client> {
  const ref = refFromConnectionUrl(url);
  if (ref !== expectedRef) throw new Error(`Ref guard failed: expected ${expectedRef}, got ${ref}`);
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");
  return client;
}

async function snapshotEnv(
  client: pg.Client,
  ref: string,
  spreadsheetBatch: string | null,
  vendorPlanRows: Array<{ product_id: string; proposed_vendor_name: string }> | null,
): Promise<EnvSnapshot> {
  const q1 = await client.query(`
    SELECT
      (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles_total,
      (SELECT count(*)::int FROM public.product_packaging_profile_versions) AS versions_total,
      (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS dimensions_current_total
  `);

  const spreadsheetActive = spreadsheetBatch
    ? await client.query(
        `SELECT count(DISTINCT p.id)::int AS c
         FROM public.product_packaging_profiles p
         JOIN public.product_packaging_profile_versions v ON v.profile_id = p.id
         JOIN public.product_packaging_dimensions_current c ON c.profile_id = p.id AND c.current_version_id = v.id
         WHERE p.display_label = $1 AND v.profile_status = 'active'`,
        [spreadsheetBatch],
      )
    : { rows: [{ c: 0 }] };

  const spreadsheetNeedsReview = spreadsheetBatch
    ? await client.query(
        `SELECT count(DISTINCT p.id)::int AS c
         FROM public.product_packaging_profiles p
         JOIN public.product_packaging_profile_versions v ON v.profile_id = p.id
         WHERE p.display_label = $1 AND v.profile_status = 'needs_review'`,
        [spreadsheetBatch],
      )
    : { rows: [{ c: 0 }] };

  const importActive = await client.query(
    `SELECT count(DISTINCT p.id)::int AS c
     FROM public.product_packaging_profiles p
     JOIN public.product_packaging_profile_versions v ON v.profile_id = p.id
     JOIN public.product_packaging_dimensions_current c ON c.profile_id = p.id AND c.current_version_id = v.id
     WHERE v.source_type = 'import' AND v.profile_status = 'active'`,
  );

  const products = await client.query(
    `SELECT count(*)::int AS c FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
    [SAM_ORG, SAM_STORE],
  );

  const catalog = await client.query(
    `SELECT count(*)::int AS c FROM public.catalog_products WHERE organization_id = $1::uuid`,
    [SAM_ORG],
  ).catch(() => ({ rows: [{ c: -1 }] }));

  const map = await client.query(
    `SELECT count(*)::int AS c FROM public.product_identifier_map
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
    [SAM_ORG, SAM_STORE],
  );

  const vendorBare = await client.query(
    `SELECT count(*)::int AS c FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND deleted_at IS NULL AND TRIM(vendor_name) = '1883'`,
    [SAM_ORG, SAM_STORE],
  );

  const vendorCleaned = await client.query(
    `SELECT count(*)::int AS c FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND deleted_at IS NULL AND vendor_name ~* '^1883\\s' AND TRIM(vendor_name) <> '1883'`,
    [SAM_ORG, SAM_STORE],
  );

  let vendorPlanStillBare = 0;
  let vendorPlanCleaned = 0;
  if (vendorPlanRows?.length) {
    const ids = vendorPlanRows.map((r) => r.product_id);
    const planQ = await client.query(
      `SELECT id::text, NULLIF(TRIM(vendor_name), '') AS vendor_name
       FROM public.products
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND deleted_at IS NULL AND id = ANY($3::uuid[])`,
      [SAM_ORG, SAM_STORE, ids],
    );
    const proposedById = new Map(vendorPlanRows.map((r) => [r.product_id, r.proposed_vendor_name]));
    for (const row of planQ.rows as Array<{ id: string; vendor_name: string | null }>) {
      const proposed = proposedById.get(row.id);
      if (row.vendor_name === "1883") vendorPlanStillBare += 1;
      else if (proposed && row.vendor_name === proposed) vendorPlanCleaned += 1;
    }
  }

  const ep = await client.query(
    `SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
      count(*) FILTER (
        WHERE resolved_product_id IS NULL
          AND COALESCE(identifier_resolution_status, 'unresolved') NOT IN ('ambiguous', 'mismatch')
      )::int AS unresolved,
      count(*) FILTER (WHERE identifier_resolution_status = 'ambiguous')::int AS ambiguous
     FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [SAM_ORG, SAM_STORE],
  );

  const riHasResolved = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'return_items' AND column_name = 'resolved_product_id'`,
  );
  let returnItems = { total: 0, unresolved: 0, ambiguous: 0 };
  if ((riHasResolved.rowCount ?? 0) > 0) {
    const ri = await client.query(
      `SELECT
        count(*)::int AS total,
        count(*) FILTER (
          WHERE resolved_product_id IS NULL
            AND COALESCE(identifier_resolution_status, 'unresolved') NOT IN ('ambiguous', 'mismatch')
        )::int AS unresolved,
        count(*) FILTER (WHERE identifier_resolution_status = 'ambiguous')::int AS ambiguous
       FROM public.return_items
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
      [SAM_ORG, SAM_STORE],
    );
    returnItems = ri.rows[0] as typeof returnItems;
  }

  const base = q1.rows[0] as Record<string, number>;
  const epRow = ep.rows[0] as Record<string, number>;

  return {
    ref,
    profiles_total: base.profiles_total ?? 0,
    versions_total: base.versions_total ?? 0,
    dimensions_current_total: base.dimensions_current_total ?? 0,
    spreadsheet_active_profiles: (spreadsheetActive.rows[0] as { c: number }).c ?? 0,
    spreadsheet_needs_review_profiles: (spreadsheetNeedsReview.rows[0] as { c: number }).c ?? 0,
    spreadsheet_import_source_active: (importActive.rows[0] as { c: number }).c ?? 0,
    products_total: (products.rows[0] as { c: number }).c ?? 0,
    catalog_products_total: (catalog.rows[0] as { c: number }).c ?? 0,
    map_total: (map.rows[0] as { c: number }).c ?? 0,
    vendor_bare_1883: (vendorBare.rows[0] as { c: number }).c ?? 0,
    vendor_cleaned_1883_brand_prefix: (vendorCleaned.rows[0] as { c: number }).c ?? 0,
    vendor_plan_still_bare: vendorPlanStillBare,
    vendor_plan_cleaned: vendorPlanCleaned,
    expected_packages_total: epRow.total ?? 0,
    expected_packages_resolved: epRow.resolved ?? 0,
    expected_packages_unresolved: epRow.unresolved ?? 0,
    expected_packages_ambiguous: epRow.ambiguous ?? 0,
    return_items_total: returnItems.total ?? 0,
    return_items_unresolved: returnItems.unresolved ?? 0,
    return_items_ambiguous: returnItems.ambiguous ?? 0,
  };
}

function loadVendorPlanRows(): Array<{ product_id: string; proposed_vendor_name: string }> | null {
  const p = path.join(process.cwd(), VENDOR_PLAN, "deterministic-update-plan.json");
  if (!fs.existsSync(p)) return null;
  const file = JSON.parse(fs.readFileSync(p, "utf8")) as {
    rows?: Array<{ product_id: string; proposed_vendor_name: string }>;
  };
  return file.rows ?? null;
}

function latestExecuteRun(base: string): string | null {
  const dir = path.join(process.cwd(), base);
  if (!fs.existsSync(dir)) return null;
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, "manifest.json")))
    .sort()
    .reverse()[0] ?? null;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`branch=${branch}`);
  if (!stagingUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL missing");
  if (!originalUrl) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL missing");
  if (stagingUrl === originalUrl) blockers.push("staging/original URLs must differ");
  if (getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) blockers.push("staging ref guard");

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    throw new Error(blockers.join("; "));
  }

  const vendorPlanRows = loadVendorPlanRows();
  const vendorPlanCount = vendorPlanRows?.length ?? 454;

  const stagingClient = await connect(stagingUrl, STAGING_REF);
  const originalClient = await connect(originalUrl, ORIGINAL_REF);
  const staging = await snapshotEnv(stagingClient, STAGING_REF, STAGING_SPREADSHEET_BATCH, vendorPlanRows);
  const original = await snapshotEnv(originalClient, ORIGINAL_REF, ORIGINAL_SPREADSHEET_BATCH, null);
  await stagingClient.end();
  await originalClient.end();

  const spreadsheetRemainingStaging = Math.max(0, EXPECTED_SPREADSHEET_ROWS - staging.spreadsheet_active_profiles);
  const spreadsheetRemainingOriginal = Math.max(0, EXPECTED_SPREADSHEET_ROWS - original.spreadsheet_active_profiles);
  const packagingRemaining = spreadsheetRemainingStaging + spreadsheetRemainingOriginal;

  const vendorExecuteRun = latestExecuteRun(VENDOR_EXECUTE_BASE);
  const vendorExecuteManifest = vendorExecuteRun
    ? JSON.parse(
        fs.readFileSync(path.join(process.cwd(), VENDOR_EXECUTE_BASE, vendorExecuteRun, "manifest.json"), "utf8"),
      )
    : null;

  const vendorRemainingStaging = staging.vendor_plan_still_bare || staging.vendor_bare_1883;
  const vendorRemainingOriginal = original.vendor_bare_1883;

  const pimDelta = Math.abs(staging.products_total - original.products_total);
  const linkageRemaining =
    staging.expected_packages_unresolved +
    original.expected_packages_unresolved +
    staging.return_items_unresolved +
    original.return_items_unresolved;

  const exactNextPrompt =
    vendorRemainingStaging > 0
      ? "VENDOR-1883-CLEANUP-STAGING-EXECUTE — 454 deterministic vendor_name updates still pending on staging"
      : vendorRemainingOriginal > 0
        ? "VENDOR-1883-CLEANUP-ORIGINAL-PARITY-EXECUTE — staging cleaned; original bare 1883 rows remain"
        : linkageRemaining > 0
          ? "PRODUCT-LINKAGE-RESOLVER-WAVE — expected_packages + return_items unresolved after sheet import enrichment"
          : "SPREADSHEET GOVERNED IMPORT CLOSEOUT — packaging/vendor/PIM parity complete; update memory only";

  const summary = [
    "# Product packaging + vendor remaining census",
    "",
    `**Run:** \`${OUT_BASE}/${runId}/\` | **Branch:** \`${branch}\``,
    "",
    "## Packaging (spreadsheet cohort)",
    "",
    "| Env | profiles | dimensions_current | spreadsheet active (80 target) | remaining |",
    "|-----|----------|-------------------:|---------------------------------:|----------:|",
    `| Staging | ${staging.profiles_total} | ${staging.dimensions_current_total} | **${staging.spreadsheet_active_profiles}** | ${spreadsheetRemainingStaging} |`,
    `| Original | ${original.profiles_total} | ${original.dimensions_current_total} | **${original.spreadsheet_active_profiles}** | ${spreadsheetRemainingOriginal} |`,
    "",
    `- Expected dimensions_current baseline: **${EXPECTED_DIMENSIONS_CURRENT}** (staging ${staging.dimensions_current_total === EXPECTED_DIMENSIONS_CURRENT ? "match" : "drift"}, original ${original.dimensions_current_total === EXPECTED_DIMENSIONS_CURRENT ? "match" : "drift"})`,
    `- Spreadsheet import-source active profiles: staging **${staging.spreadsheet_import_source_active}**, original **${original.spreadsheet_import_source_active}**`,
    `- **Packaging remaining (spreadsheet cohort): ${packagingRemaining}**`,
    "",
    "## Vendor 1883",
    "",
    "| Env | bare \`1883\` | cleaned (\`1883 …\` prefix) | plan still bare / plan cleaned |",
    "|-----|-------------:|---------------------------:|-------------------------------:|",
    `| Staging | **${staging.vendor_bare_1883}** | ${staging.vendor_cleaned_1883_brand_prefix} | ${staging.vendor_plan_still_bare} / ${staging.vendor_plan_cleaned} of ${vendorPlanCount} |`,
    `| Original | **${original.vendor_bare_1883}** | ${original.vendor_cleaned_1883_brand_prefix} | n/a |`,
    "",
    `- Vendor execute audit: ${vendorExecuteRun ? `\`${vendorExecuteRun}\` applied=${vendorExecuteManifest?.applied ?? "?"}` : "**none found**"}`,
    `- **Vendor remaining: staging ${vendorRemainingStaging}, original ${vendorRemainingOriginal}**`,
    "",
    "## PIM / product linkage",
    "",
    "| Metric | Staging | Original |",
    "|--------|--------:|---------:|",
    `| \`products\` (Sam store) | ${staging.products_total} | ${original.products_total} |`,
    `| \`catalog_products\` | ${staging.catalog_products_total} | ${original.catalog_products_total} |`,
    `| \`product_identifier_map\` | ${staging.map_total} | ${original.map_total} |`,
    `| EP unresolved | **${staging.expected_packages_unresolved}** | **${original.expected_packages_unresolved}** |`,
    `| EP ambiguous | ${staging.expected_packages_ambiguous} | ${original.expected_packages_ambiguous} |`,
    `| return_items unresolved | **${staging.return_items_unresolved}** | **${original.return_items_unresolved}** |`,
    `| return_items ambiguous | ${staging.return_items_ambiguous} | ${original.return_items_ambiguous} |`,
    "",
    `- PIM count delta (products): **${pimDelta}**`,
    `- **Linkage remaining (EP + RI unresolved): ${linkageRemaining}**`,
    "",
    `**Next prompt:** ${exactNextPrompt}`,
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "census-summary.md"), summary + "\n");
  fs.writeFileSync(path.join(outDir, "staging-snapshot.json"), JSON.stringify(staging, null, 2));
  fs.writeFileSync(path.join(outDir, "original-snapshot.json"), JSON.stringify(original, null, 2));
  fs.writeFileSync(
    path.join(outDir, "remaining-counts.json"),
    JSON.stringify(
      {
        packaging_remaining_count: packagingRemaining,
        spreadsheet_remaining_staging: spreadsheetRemainingStaging,
        spreadsheet_remaining_original: spreadsheetRemainingOriginal,
        vendor_remaining_staging: vendorRemainingStaging,
        vendor_remaining_original: vendorRemainingOriginal,
        vendor_execute_run_id: vendorExecuteRun,
        pim_products_delta: pimDelta,
        linkage_remaining_count: linkageRemaining,
        linkage_breakdown: {
          staging_ep_unresolved: staging.expected_packages_unresolved,
          original_ep_unresolved: original.expected_packages_unresolved,
          staging_ri_unresolved: staging.return_items_unresolved,
          original_ri_unresolved: original.return_items_unresolved,
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(outDir, "blockers.md"), "# Blockers\n\nNone.\n");
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PRODUCT PACKAGING + VENDOR REMAINING CENSUS",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        original_ref: ORIGINAL_REF,
        packaging_remaining_count: packagingRemaining,
        vendor_remaining_count: vendorRemainingStaging + vendorRemainingOriginal,
        vendor_remaining_staging: vendorRemainingStaging,
        vendor_remaining_original: vendorRemainingOriginal,
        pim_linkage_remaining_count: linkageRemaining,
        staging_products: staging.products_total,
        original_products: original.products_total,
        staging_dimensions_current: staging.dimensions_current_total,
        original_dimensions_current: original.dimensions_current_total,
        spreadsheet_parity_ref: SPREADSHEET_PARITY_RUN,
        vendor_plan_ref: VENDOR_PLAN,
        vendor_execute_run_id: vendorExecuteRun,
        exact_next_prompt: exactNextPrompt,
        mode: "read_only",
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify(JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8")), null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
