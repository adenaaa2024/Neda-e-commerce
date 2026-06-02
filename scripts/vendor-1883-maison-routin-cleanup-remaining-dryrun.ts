/**
 * VENDOR-1883-MAISON-ROUTIN-CLEANUP-REMAINING-DRYRUN
 *
 *   npx tsx scripts/vendor-1883-maison-routin-cleanup-remaining-dryrun.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const SAM_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SAM_STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const CANONICAL = "1883 Maison Routin";
const OUT_BASE = ".cursor/audit-reports/vendor-1883-maison-routin-cleanup-remaining-dryrun";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

type SampleRow = {
  id: string;
  sku: string | null;
  vendor_name: string | null;
  brand: string | null;
  category: string | null;
  vendor_id: string | null;
  vendors_name: string | null;
};

async function auditEnv(label: string, dbUrl: string) {
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const hasCategory = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='products' AND column_name='category'`,
  );

  const counts = await client.query(
    `SELECT
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND btrim(coalesce(vendor_name,'')) = '1883')::int AS products_bare_vendor_name,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND btrim(coalesce(brand,'')) = '1883')::int AS products_bare_brand,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND btrim(coalesce(vendor_name,'')) = $3)::int AS products_canonical_vendor_name,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL AND vendor_name IS NOT NULL
          AND btrim(vendor_name) <> '1883'
          AND btrim(vendor_name) ILIKE '1883%'
      )::int AS products_vendor_contains_1883_not_exact,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL AND brand IS NOT NULL
          AND btrim(brand) <> '1883'
          AND btrim(brand) ILIKE '1883%'
      )::int AS products_brand_contains_1883_not_exact
     FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [SAM_ORG_ID, SAM_STORE_ID, CANONICAL],
  );

  const hasCategoryCol = hasCategory.rows.length > 0;
  let categoriesBare = 0;
  const hasCategoriesTable = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='categories'`,
  );
  if (hasCategoriesTable.rows.length) {
    const catR = await client.query(
      `SELECT COUNT(*)::int AS c FROM public.categories
       WHERE organization_id = $1::uuid AND btrim(coalesce(name, '')) = '1883'`,
      [SAM_ORG_ID],
    );
    categoriesBare = (catR.rows[0] as { c: number }).c;
  }

  let categoryBare = 0;
  if (hasCategoryCol) {
    const catR = await client.query(
      `SELECT COUNT(*)::int AS c FROM public.products
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
         AND btrim(coalesce(category, '')) = '1883'`,
      [SAM_ORG_ID, SAM_STORE_ID],
    );
    categoryBare = (catR.rows[0] as { c: number }).c;
  }

  const vendorsBare = await client.query(
    `SELECT id::text, name FROM public.vendors
     WHERE organization_id = $1::uuid AND btrim(name) = '1883'`,
    [SAM_ORG_ID],
  );

  const vendorsCanonical = await client.query(
    `SELECT id::text, name FROM public.vendors
     WHERE organization_id = $1::uuid AND lower(btrim(name)) = lower($2)`,
    [SAM_ORG_ID, CANONICAL],
  );

  const sample = await client.query(
    `SELECT p.id::text, NULLIF(TRIM(p.sku), '') AS sku, p.vendor_name, p.brand,
            ${hasCategoryCol ? "p.category," : "NULL::text AS category,"}
            p.vendor_id::text, v.name AS vendors_name
     FROM public.products p
     LEFT JOIN public.vendors v ON v.id = p.vendor_id
     WHERE p.organization_id = $1::uuid AND p.store_id = $2::uuid AND p.deleted_at IS NULL
       AND btrim(coalesce(p.vendor_name, '')) = '1883'
     ORDER BY p.sku NULLS LAST, p.id
     LIMIT 15`,
    [SAM_ORG_ID, SAM_STORE_ID],
  );

  await client.end();

  const c = counts.rows[0] as Record<string, number>;
  return {
    label,
    counts: {
      products_bare_vendor_name: c.products_bare_vendor_name,
      products_bare_brand: c.products_bare_brand,
      products_canonical_vendor_name: c.products_canonical_vendor_name,
      products_category_bare_1883: categoryBare,
      categories_table_bare_1883: categoriesBare,
      vendors_bare_1883: vendorsBare.rows.length,
      vendors_canonical: vendorsCanonical.rows.length,
      products_vendor_contains_1883_not_exact: c.products_vendor_contains_1883_not_exact,
      products_brand_contains_1883_not_exact: c.products_brand_contains_1883_not_exact,
    },
    vendors_bare_rows: vendorsBare.rows as Array<{ id: string; name: string }>,
    vendors_canonical_rows: vendorsCanonical.rows as Array<{ id: string; name: string }>,
    sample_rows: sample.rows as SampleRow[],
    apply_scope: "products.vendor_name only where btrim(vendor_name) = '1883'",
    out_of_scope: [
      "brand (unless exact bare '1883' — manual review)",
      "category (unless exact bare '1883' — not in vendor_name apply)",
      "vendors.name rename (Phase 2)",
      "vendor_name containing '1883' plus other text",
    ],
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();

  loadEnvLocalIntoProcess();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";

  const results: Awaited<ReturnType<typeof auditEnv>>[] = [];
  if (stagingUrl && refFromConnectionUrl(stagingUrl) === STAGING_REF) {
    results.push(await auditEnv("staging", stagingUrl));
  }
  if (originalUrl && refFromConnectionUrl(originalUrl) === ORIGINAL_REF) {
    results.push(await auditEnv("original", originalUrl));
  }

  const staging = results.find((r) => r.label === "staging");
  const original = results.find((r) => r.label === "original");
  const stagingBare = staging?.counts.products_bare_vendor_name ?? 0;
  const originalBare = original?.counts.products_bare_vendor_name ?? 0;

  const safeToApply =
    stagingBare > 0 && (staging?.counts.products_vendor_contains_1883_not_exact ?? 0) === 0;

  const applyPrompt =
    stagingBare > 0
      ? `# Exact apply prompt

\`\`\`
VENDOR-1883-MAISON-ROUTIN-CLEANUP-EXECUTE — remaining ${stagingBare} rows (staging)

Precondition: VENDOR-1883-MAISON-ROUTIN-CLEANUP-REMAINING-DRYRUN PASS (${runId})
Approval: .cursor/operator-approvals/vendor-1883-maison-routin-cleanup-approval.md
  APPROVED_TO_RUN_STAGING=true
  APPROVED_VENDOR_1883_MAISON_ROUTIN_CLEANUP=true
  TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu

Execute:
  npx tsx scripts/vendor-1883-maison-routin-cleanup-execute.ts --run-id=<UTC_Z> --apply --remaining --max-rows=${stagingBare}

Guard: btrim(vendor_name) = '1883' only → '${CANONICAL}'
Forbidden: product create, brand bulk overwrite, names containing other text, map/resolver changes
\`\`\`
`
      : originalBare > 0
        ? `# Exact apply prompt (original parity — separate approval required)

\`\`\`
VENDOR-1883-CLEANUP-ORIGINAL-PARITY-EXECUTE — ${originalBare} rows on original

Staging bare vendor_name = 0. Original still has ${originalBare} bare '1883' rows.
Use original parity plan/approval — do NOT run staging execute script on original.
\`\`\`
`
        : `# No apply needed

All bare vendor_name = '1883' rows cleaned on staging and original (SAM store scope).`;

  fs.writeFileSync(path.join(outDir, "exact-apply-prompt.md"), applyPrompt);
  fs.writeFileSync(path.join(outDir, "audit-by-env.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "sample-rows-staging.json"),
    JSON.stringify(staging?.sample_rows ?? [], null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "sample-rows-original.json"),
    JSON.stringify(original?.sample_rows ?? [], null, 2),
  );

  const manifest = {
    prompt: "VENDOR-1883-MAISON-ROUTIN-CLEANUP-REMAINING-DRYRUN",
    run_id: runId,
    branch,
    mode: "dry_run",
    canonical_vendor: CANONICAL,
    staging: staging?.counts ?? null,
    original: original?.counts ?? null,
    sample_row_count: staging?.sample_rows.length ?? 0,
    SAFE_TO_APPLY: safeToApply ? "yes" : stagingBare === 0 && originalBare === 0 ? "n/a_clean" : stagingBare === 0 ? "no_staging_use_original_parity" : "no",
    exact_apply_prompt: applyPrompt.trim(),
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
  console.log("\n--- SAMPLE ROWS (staging, up to 15) ---");
  console.log(JSON.stringify(staging?.sample_rows ?? [], null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
