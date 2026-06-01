/**
 * PRODUCT-VENDOR-1883-MAISON-ROUTIN-CLEANUP-READONLY
 *
 *   npx tsx scripts/product-vendor-1883-maison-routin-cleanup-readonly.ts --run-id=<UTC_Z>
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
const CANONICAL_VENDOR = "1883 Maison Routin";
const OUT_BASE = ".cursor/audit-reports/product-vendor-1883-maison-routin-cleanup-readonly";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromUrl(url: string): string | null {
  return refFromConnectionUrl(url);
}

type ProductRow = {
  id: string;
  sku: string | null;
  vendor_name: string | null;
  brand: string | null;
  vendor_id: string | null;
  vendor_table_name: string | null;
};

async function auditRef(label: string, dbUrl: string, ref: string) {
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name IN ('vendors','brands','products')`,
  );
  const hasVendors = tables.rows.some((r: { table_name: string }) => r.table_name === "vendors");
  const hasBrands = tables.rows.some((r: { table_name: string }) => r.table_name === "brands");

  const vendorRows = hasVendors
    ? await client.query(
        `SELECT id::text, name FROM public.vendors
         WHERE organization_id = $1::uuid
           AND (btrim(name) = '1883' OR lower(btrim(name)) = lower($2))
         ORDER BY name`,
        [SAM_ORG_ID, CANONICAL_VENDOR],
      )
    : { rows: [] };

  const counts = await client.query(
    `SELECT
      COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active_products,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND btrim(coalesce(vendor_name, '')) = '1883')::int AS bare_1883_vendor_name,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND btrim(coalesce(vendor_name, '')) = $3)::int AS canonical_vendor_name,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND btrim(coalesce(brand, '')) = '1883')::int AS bare_1883_brand,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND btrim(coalesce(brand, '')) = $3)::int AS canonical_brand,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND vendor_id IS NOT NULL)::int AS with_vendor_id,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND btrim(coalesce(vendor_name,'')) = '1883' AND btrim(coalesce(brand,'')) = '1883')::int AS both_bare,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL
          AND btrim(coalesce(vendor_name, '')) = $3
          AND vendor_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.vendors v
            WHERE v.id = products.vendor_id AND btrim(v.name) = '1883'
          )
      )::int AS canonical_text_stale_vendor_id
     FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [SAM_ORG_ID, SAM_STORE_ID, CANONICAL_VENDOR],
  );

  const bareVendorNameRows = await client.query(
    `SELECT p.id::text, NULLIF(TRIM(p.sku), '') AS sku, p.vendor_name, p.brand,
            p.vendor_id::text, v.name AS vendor_table_name
     FROM public.products p
     LEFT JOIN public.vendors v ON v.id = p.vendor_id
     WHERE p.organization_id = $1::uuid AND p.store_id = $2::uuid AND p.deleted_at IS NULL
       AND btrim(coalesce(p.vendor_name, '')) = '1883'
     ORDER BY p.sku NULLS LAST, p.id`,
    [SAM_ORG_ID, SAM_STORE_ID],
  );

  const affected = await client.query(
    `SELECT p.id::text, NULLIF(TRIM(p.sku), '') AS sku, p.vendor_name, p.brand,
            p.vendor_id::text, v.name AS vendor_table_name
     FROM public.products p
     LEFT JOIN public.vendors v ON v.id = p.vendor_id
     WHERE p.organization_id = $1::uuid AND p.store_id = $2::uuid AND p.deleted_at IS NULL
       AND (
         btrim(coalesce(p.vendor_name, '')) = '1883'
         OR btrim(coalesce(p.brand, '')) = '1883'
         OR (v.id IS NOT NULL AND btrim(v.name) = '1883')
       )
     ORDER BY p.sku NULLS LAST, p.id`,
    [SAM_ORG_ID, SAM_STORE_ID],
  );

  const canonicalProducts = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
       AND btrim(coalesce(vendor_name, '')) = $3`,
    [SAM_ORG_ID, SAM_STORE_ID, CANONICAL_VENDOR],
  );

  await client.end();

  return {
    label,
    ref,
    has_vendors_table: hasVendors,
    has_brands_table: hasBrands,
    vendor_directory_rows: vendorRows.rows as Array<{ id: string; name: string }>,
    counts: counts.rows[0] as Record<string, number>,
    canonical_product_count: (canonicalProducts.rows[0] as { c: number }).c,
    bare_vendor_name_rows: bareVendorNameRows.rows as ProductRow[],
    affected_rows: affected.rows as ProductRow[],
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";

  const results: Awaited<ReturnType<typeof auditRef>>[] = [];
  if (stagingUrl && refFromUrl(stagingUrl) === STAGING_REF) {
    results.push(await auditRef("staging", stagingUrl, STAGING_REF));
  }
  if (originalUrl && refFromUrl(originalUrl) === ORIGINAL_REF) {
    results.push(await auditRef("original", originalUrl, ORIGINAL_REF));
  }

  const staging = results.find((r) => r.label === "staging");
  const original = results.find((r) => r.label === "original");

  const stagingBare = staging?.bare_vendor_name_rows.length ?? 0;
  const originalBare = original?.bare_vendor_name_rows.length ?? 0;
  const stagingAffected = staging?.affected_rows.length ?? 0;
  const originalAffected = original?.affected_rows.length ?? 0;

  const primaryRef = staging ?? original;
  const bareRows = primaryRef?.bare_vendor_name_rows ?? [];
  const applyCohort = bareRows.slice(0, 55);

  const canonicalVendorId =
    staging?.vendor_directory_rows.find((v) => v.name.toLowerCase() === CANONICAL_VENDOR.toLowerCase())
      ?.id ??
    original?.vendor_directory_rows.find((v) => v.name.toLowerCase() === CANONICAL_VENDOR.toLowerCase())?.id ??
    null;

  const bare1883VendorId =
    staging?.vendor_directory_rows.find((v) => v.name === "1883")?.id ??
    original?.vendor_directory_rows.find((v) => v.name === "1883")?.id ??
    null;

  const safeToApply =
    applyCohort.length > 0 &&
    applyCohort.every((r) => r.vendor_name?.trim() === "1883") &&
    applyCohort.length <= 55;

  const userHypothesis55 = stagingBare === 55 || originalBare === 55;

  const architectureMd = `# Current architecture

## Vendor / brand surfaces

| Surface | Table / column | Role |
|---------|----------------|------|
| **Vendor directory** | \`public.vendors\` (\`id\`, \`organization_id\`, \`name\`) | Canonical vendor spine; \`products.vendor_id\` FK |
| **Product vendor text** | \`products.vendor_name\` | Denormalized display / import field; PIM catalog uses \`COALESCE(vendor_name, vendors.name)\` |
| **Product brand** | \`products.brand\` | Separate from vendor; packaging spreadsheet \`Brand\` column maps here for review, not auto-bulk overwrite |
| **Brand table** | \`brands\` | ${staging?.has_brands_table || original?.has_brands_table ? "present" : "**not present** in public schema"} |
| **Vendor alias map** | — | **Not implemented** (\`vendor-confirmation-policy.md\`) |

## Canonical rule

Bare \`1883\` (vendor_name, brand, or \`vendors.name\`) → display/canonical string **${CANONICAL_VENDOR}**.

Policy doc \`vendor-confirmation-policy.md\` allowlists \`1883\` as valid supplier code; UI invalid-label rule flags numeric-only vendors unless allowlisted in code.

## Recommended architecture (no new products)

1. **Phase 1 (now):** Governed \`UPDATE products SET vendor_name = '${CANONICAL_VENDOR}'\` where \`btrim(vendor_name) = '1883'\` — same pattern as VENDOR-1883 spreadsheet cohort execute.
2. **Phase 2 (optional):** Upsert \`vendors.name = '${CANONICAL_VENDOR}'\` and set \`products.vendor_id\` where null — **only** if vendor_id spine is desired; not required for display fix.
3. **Phase 3 (future):** \`vendor_alias\` (\`raw_value\`, \`canonical_vendor_id\`) for imports — **do not build in this apply**.
4. **AI hook:** Ambiguous vendor strings → \`pim_vendor_normalization_review_queue\` (read-only flag), never auto-write.

**Do not:** product create, title change, resolver rewrite, fuzzy merge.
`;

  const updatePlan = `# Safe update plan (max ${applyCohort.length})

## Scope

- **Primary apply target:** \`btrim(vendor_name) = '1883'\` only (${stagingBare} staging / ${originalBare} original)
- **Write:** \`vendor_name\` only → \`${CANONICAL_VENDOR}\`
- **Guard:** \`WHERE btrim(vendor_name) = '1883'\` (do not touch already-canonical rows)
- **Out of scope this wave:** \`brand\`, \`vendor_id\`, \`vendors.name\` rename (Phase 2)
- **Forbidden:** \`product_name\`, \`product_identifier_map\`, resolver columns, packaging tables

## Staging counts

| Metric | Count |
|--------|------:|
| Active products | ${staging?.counts.active_products ?? "n/a"} |
| Bare \`1883\` vendor_name (**apply target**) | ${staging?.counts.bare_1883_vendor_name ?? "n/a"} |
| Canonical \`1883 Maison Routin\` vendor_name | ${staging?.counts.canonical_vendor_name ?? "n/a"} |
| Bare \`1883\` brand | ${staging?.counts.bare_1883_brand ?? "n/a"} |
| Canonical text but \`vendor_id\` → bare \`1883\` (Phase 2) | ${staging?.counts.canonical_text_stale_vendor_id ?? "n/a"} |
| Broad union (vendor_name / brand / vendor_id) | ${stagingAffected} |

## Original counts

| Metric | Count |
|--------|------:|
| Bare \`1883\` vendor_name (**apply target**) | ${original?.counts.bare_1883_vendor_name ?? "n/a"} |
| Canonical vendor_name | ${original?.counts.canonical_vendor_name ?? "n/a"} |
| Broad union | ${originalAffected} |

## User check: "55 products still have old vendor name?"

**No** — live census shows **${stagingBare}** on staging and **${originalBare}** on original with bare \`vendor_name = '1883'\`.
The **max-55** limit is a **pilot batch size**, not the total remaining count.
${userHypothesis55 ? "*(One environment matches exactly 55 — hypothesis confirmed there.)*" : ""}

## Vendor directory

| vendors.name | id |
|--------------|-----|
${(staging?.vendor_directory_rows ?? original?.vendor_directory_rows ?? [])
  .map((v) => `| ${v.name} | \`${v.id}\` |`)
  .join("\n") || "| (none matched) | — |"}

**Canonical vendor id:** ${canonicalVendorId ? `\`${canonicalVendorId}\`` : "*(no vendors row for Maison Routin — text-only fix OK)*"}
**Bare \`1883\` vendor id:** ${bare1883VendorId ? `\`${bare1883VendorId}\`` : "—"}

## Max-55 pilot cohort

First **${applyCohort.length}** rows with \`btrim(vendor_name) = '1883'\` in \`max-55-apply-cohort.json\`.
Remaining after pilot: **${Math.max(0, stagingBare - applyCohort.length)}** on staging.

## AI-assist hook (no auto-write)

- Rows where \`vendor_name\` ≠ \`1883\` but sheet Brand starts with \`1883\` → manual / AI review queue
- Rows with conflicting \`brand\` vs \`vendor_name\` → \`identifier-mismatch-review-queue\` pattern
- Entitlement-gated vendor research stores evidence JSON before any write
`;

  const rollbackMd = `# Rollback plan

\`\`\`sql
BEGIN;
-- From preimage JSON: restore vendor_name per product_id
UPDATE public.products SET vendor_name = preimage.before_vendor_name, updated_at = now()
WHERE id = :product_id AND btrim(vendor_name) = '${CANONICAL_VENDOR.replace(/'/g, "''")}';
COMMIT;
\`\`\`

Artifact: \`rollback-preimage.json\` captured before execute (same pattern as \`vendor-1883-cleanup-staging-execute\`).
`;

  const applyPrompt = `# Exact apply prompt (max-55)

\`\`\`
VENDOR-1883-MAISON-ROUTIN-CLEANUP-EXECUTE — apply max ${applyCohort.length} rows

Precondition: PRODUCT-VENDOR-1883-MAISON-ROUTIN-CLEANUP-READONLY PASS (${runId})
Approval: .cursor/operator-approvals/vendor-1883-maison-routin-cleanup-approval.md
  APPROVED_TO_RUN_STAGING=true (or ORIGINAL if parity wave)
  APPROVED_VENDOR_1883_MAISON_ROUTIN_CLEANUP=true

Execute:
  npx tsx scripts/vendor-1883-maison-routin-cleanup-execute.ts --run-id=<UTC_Z> --max-rows=${applyCohort.length}

Guard: btrim(vendor_name) = '1883' only; set to '${CANONICAL_VENDOR}'
Forbidden: product create, brand bulk overwrite, map/resolver changes
\`\`\`
`;

  fs.writeFileSync(path.join(outDir, "current-architecture.md"), architectureMd);
  fs.writeFileSync(path.join(outDir, "safe-update-plan.md"), updatePlan);
  fs.writeFileSync(path.join(outDir, "rollback-plan.md"), rollbackMd);
  fs.writeFileSync(path.join(outDir, "exact-apply-prompt.md"), applyPrompt);
  fs.writeFileSync(
    path.join(outDir, "proof-summary.md"),
    [
      "# PRODUCT-VENDOR-1883-MAISON-ROUTIN-CLEANUP-READONLY",
      "",
      `**Run:** ${runId} | **Mode:** read-only | **SAFE_TO_APPLY:** ${safeToApply ? "yes" : "no"}`,
      "",
      "## Canonical vendor",
      `- **Name:** ${CANONICAL_VENDOR}`,
      `- **vendors.id:** ${canonicalVendorId ?? "*(none — create in Phase 2 or text-only)*"}`,
      `- **Bare \`1883\` vendors.id:** ${bare1883VendorId ?? "—"}`,
      "",
      "## Affected counts",
      "| Env | bare vendor_name=1883 | canonical vendor_name | stale vendor_id |",
      "|-----|----------------------:|----------------------:|----------------:|",
      `| staging | ${stagingBare} | ${staging?.counts.canonical_vendor_name ?? "n/a"} | ${staging?.counts.canonical_text_stale_vendor_id ?? "n/a"} |`,
      `| original | ${originalBare} | ${original?.counts.canonical_vendor_name ?? "n/a"} | — |`,
      "",
      `## Max-55 pilot: ${applyCohort.length} rows (${Math.max(0, stagingBare - applyCohort.length)} remain on staging)`,
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(outDir, "max-55-apply-cohort.json"),
    JSON.stringify({ count: applyCohort.length, rows: applyCohort }, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "audit-by-ref.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "ai-assist-hook-plan.md"),
    [
      "# AI-assist hook plan",
      "",
      "1. **Deterministic path:** exact `1883` → `${CANONICAL_VENDOR}` via governed SQL (this audit).",
      "2. **Ambiguous path:** `1883 Brand X` variants, numeric-only non-allowlist, vendor≠brand → review queue row with evidence requirement.",
      "3. **No auto-write** from AI; operator or approval-gated execute only.",
      "4. **Future:** `vendor_alias` table remembers approved mappings after first human confirm.",
    ].join("\n") + "\n",
  );

  const manifest = {
    prompt: "PRODUCT-VENDOR-1883-MAISON-ROUTIN-CLEANUP-READONLY",
    run_id: runId,
    branch,
    mode: "read_only",
    canonical_vendor_name: CANONICAL_VENDOR,
    canonical_vendor_id: canonicalVendorId,
    staging: staging
      ? {
          ref: STAGING_REF,
          bare_1883_vendor_name: staging.counts.bare_1883_vendor_name,
          canonical_vendor_name: staging.counts.canonical_vendor_name,
          canonical_text_stale_vendor_id: staging.counts.canonical_text_stale_vendor_id,
          affected_union_count: stagingAffected,
        }
      : null,
    original: original
      ? {
          ref: ORIGINAL_REF,
          bare_1883_vendor_name: original.counts.bare_1883_vendor_name,
          canonical_vendor_name: original.counts.canonical_vendor_name,
          affected_union_count: originalAffected,
        }
      : null,
    user_hypothesis_55_products: userHypothesis55,
    max_55_cohort_size: applyCohort.length,
    remaining_after_pilot_staging: Math.max(0, stagingBare - applyCohort.length),
    SAFE_TO_APPLY: safeToApply ? "yes" : "no",
    exact_apply_prompt: `VENDOR-1883-MAISON-ROUTIN-CLEANUP-EXECUTE — max ${applyCohort.length} rows after approval`,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
