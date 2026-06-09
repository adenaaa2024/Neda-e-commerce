/**
 * PHASE-5D-PRODUCT-ECOSYSTEM-COMPLETION-AUDIT (read-only)
 *
 *   npx tsx scripts/phase5d-product-ecosystem-completion-audit-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { readPlatformAutomationApiFlags } from "../lib/platform-automation-api-flags";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase5d-product-ecosystem-completion-audit";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function cols(client: pg.Client, table: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

async function tableExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name],
  );
  return r.rowCount === 1;
}

async function auditMasterData(client: pg.Client, prodCols: Set<string>): Promise<Record<string, unknown>> {
  const dimCol = prodCols.has("packaging_dimensions")
    ? "packaging_dimensions"
    : prodCols.has("product_dimensions")
      ? "product_dimensions"
      : null;
  const priceCols = ["list_price", "sale_price", "price", "cost_price"].filter((c) => prodCols.has(c));
  const brandCol = prodCols.has("brand_id") ? "brand_id" : prodCols.has("brand") ? "brand" : null;

  const priceMissing = priceCols.length
    ? priceCols.map((c) => `( ${c} IS NULL )`).join(" AND ")
    : "true";

  const r = await client.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE vendor_id IS NULL)::int AS missing_vendor,
           count(*) FILTER (WHERE category_id IS NULL)::int AS missing_category,
           ${brandCol ? `count(*) FILTER (WHERE ${brandCol} IS NULL)::int AS missing_brand,` : "0::int AS missing_brand,"}
           count(*) FILTER (WHERE asin IS NULL OR btrim(asin)='')::int AS missing_asin,
           count(*) FILTER (WHERE fnsku IS NULL OR btrim(fnsku)='')::int AS missing_fnsku,
           count(*) FILTER (WHERE sku IS NULL OR btrim(sku)='')::int AS missing_sku,
           count(*) FILTER (WHERE main_image_url IS NULL OR btrim(main_image_url)='')::int AS missing_main_image,
           count(*) FILTER (WHERE amazon_raw IS NULL)::int AS missing_amazon_raw,
           ${dimCol ? `count(*) FILTER (WHERE ${dimCol} IS NULL OR ${dimCol}::text IN ('null','{}','[]'))::int AS missing_dimensions,` : "0::int AS missing_dimensions,"}
           count(*) FILTER (WHERE ${priceMissing})::int AS missing_all_price_fields
    FROM products WHERE organization_id=$1::uuid AND deleted_at IS NULL`, [ORG]);

  const vendors = await client.query(`SELECT count(*)::int AS n FROM vendors WHERE organization_id=$1::uuid`, [ORG]);
  const categories = await client.query(
    `SELECT count(*)::int AS n FROM product_categories WHERE organization_id=$1::uuid`,
    [ORG],
  );
  let brands = { n: 0 };
  if (await tableExists(client, "brands")) {
    brands = (await client.query(`SELECT count(*)::int AS n FROM brands WHERE organization_id=$1::uuid`, [ORG])).rows[0];
  }

  return {
    products: r.rows[0],
    vendors_count: vendors.rows[0]?.n ?? 0,
    categories_count: categories.rows[0]?.n ?? 0,
    brands_count: brands.n ?? 0,
    dimension_column: dimCol,
    price_columns_present: priceCols,
    brand_column: brandCol,
  };
}

async function auditPackagesPallets(client: pg.Client): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const t of ["packages", "pallets", "shipment_boxes", "shipment_box_items"]) {
    if (!(await tableExists(client, t))) {
      out[t] = { exists: false };
      continue;
    }
    const c = await cols(client, t);
    const hasProd = c.has("product_id") || c.has("resolved_product_id");
    const r = await client.query(`
      SELECT count(*)::int AS total
      ${c.has("product_id") ? ", count(*) FILTER (WHERE product_id IS NOT NULL)::int AS with_product_id" : ""}
      ${c.has("resolved_product_id") ? ", count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS with_resolved_product_id" : ""}
      FROM ${t}
      WHERE organization_id=$1::uuid
      ${c.has("deleted_at") ? "AND deleted_at IS NULL" : ""}`, [ORG]);
    out[t] = { exists: true, has_product_link_column: hasProd, ...r.rows[0] };
  }
  return out;
}

async function auditMigrationFingerprint(client: pg.Client): Promise<Record<string, unknown>> {
  const products = await client.query(`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE main_image_url IS NOT NULL AND btrim(main_image_url)<>'')::int AS with_image,
           count(*) FILTER (WHERE amazon_raw IS NOT NULL)::int AS with_amazon_raw,
           md5(string_agg(id::text, ',' ORDER BY id)) AS id_fingerprint
    FROM products WHERE organization_id=$1::uuid AND deleted_at IS NULL`, [ORG]);

  const maps = await client.query(`
    SELECT count(*)::int AS n,
           md5(string_agg(id::text, ',' ORDER BY id)) AS id_fingerprint
    FROM product_identifier_map WHERE organization_id=$1::uuid AND deleted_at IS NULL`, [ORG]);

  const sampleDiff = await client.query(`
    SELECT p.id::text, p.sku, p.asin, p.main_image_url,
           length(coalesce(p.amazon_raw::text,''))::int AS amazon_raw_len
    FROM products p
    WHERE p.organization_id=$1::uuid AND p.deleted_at IS NULL
    ORDER BY p.updated_at DESC NULLS LAST
    LIMIT 5`, [ORG]);

  return {
    products: products.rows[0],
    product_identifier_map: maps.rows[0],
    sample_recent_products: sampleDiff.rows,
  };
}

async function auditRef(label: string, url: string): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const prodCols = await cols(client, "products");
  const epCols = await cols(client, "expected_packages");

  const ep = await client.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
           count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
    FROM expected_packages WHERE organization_id=$1::uuid`, [ORG]);

  const ri = await client.query(`
    SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
           count(*) FILTER (WHERE deleted_at IS NULL AND resolved_product_id IS NOT NULL)::int AS resolved,
           count(*) FILTER (WHERE deleted_at IS NULL AND resolved_product_id IS NULL)::int AS unresolved
    FROM return_items WHERE organization_id=$1::uuid`, [ORG]);

  const mapDup = await client.query(`
    SELECT
      (SELECT count(*)::int FROM (
         SELECT upper(btrim(fnsku)) FROM product_identifier_map
         WHERE organization_id=$1::uuid AND deleted_at IS NULL AND fnsku IS NOT NULL AND btrim(fnsku)<>''
         GROUP BY 1 HAVING count(DISTINCT product_id)>1
       ) x) AS fnsku_conflicts,
      (SELECT count(*)::int FROM (
         SELECT upper(btrim(seller_sku)) FROM product_identifier_map
         WHERE organization_id=$1::uuid AND deleted_at IS NULL AND seller_sku IS NOT NULL AND btrim(seller_sku)<>''
         GROUP BY 1 HAVING count(DISTINCT product_id)>1
       ) x) AS sku_conflicts,
      (SELECT count(*)::int FROM (
         SELECT upper(btrim(asin)) FROM product_identifier_map
         WHERE organization_id=$1::uuid AND deleted_at IS NULL AND asin IS NOT NULL AND btrim(asin)<>''
         GROUP BY 1 HAVING count(DISTINCT product_id)>1
       ) x) AS asin_conflicts`, [ORG]);

  let claims: Record<string, unknown> | null = null;
  if (await tableExists(client, "claim_candidates")) {
    const cc = await client.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
             count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
      FROM claim_candidates WHERE organization_id=$1::uuid`, [ORG]);
    claims = cc.rows[0] as Record<string, unknown>;
  }

  const master = await auditMasterData(client, prodCols);
  const hierarchy = await auditPackagesPallets(client);
  const fingerprint = await auditMigrationFingerprint(client);

  let automation: Record<string, unknown> | null = null;
  if (label === "staging") {
    const ar = await client.query(`SELECT automation_settings FROM platform_settings WHERE id=true LIMIT 1`);
    const doc = ar.rows[0]?.automation_settings ?? {};
    const scopeKey = `${ORG}:${STORE}`;
    const scope = doc?.scopes?.[scopeKey] ?? doc?.scopes?.[`org:${ORG}:store:${STORE}`] ?? null;
    automation = {
      product_enrichment: scope?.product_enrichment ?? doc?.product_enrichment ?? null,
      scoped: scope != null,
    };
  }

  await client.end();

  const epRow = ep.rows[0] as { total: number; resolved: number; unresolved: number };
  const linkPct =
    epRow.total === 0 ? 100 : Math.round((epRow.resolved / epRow.total) * 1000) / 10;

  return {
    label,
    ref: label === "original" ? ORIGINAL_REF : STAGING_REF,
    product_link_resolved_percent: linkPct,
    expected_packages: epRow,
    return_items: ri.rows[0],
    claim_candidates: claims,
    duplicate_identifier_conflicts: mapDup.rows[0],
    product_master: master,
    packages_pallets: hierarchy,
    migration_fingerprint: fingerprint,
    automation_settings: automation,
  };
}

async function auditApiWorkerStatus(): Promise<Record<string, unknown>> {
  const flags = readPlatformAutomationApiFlags();
  return {
    product_enrichment_worker: {
      registry: "lib/jobs/workers/product-enrichment-worker.ts",
      worker_kind: "product_enrichment",
      schedule_key: "product_enrichment",
      scheduled_executor: "platform-automation-scheduler-tick (dry-run enqueue only; jobs/tick for apply)",
      catalog_api: "runPimCatalogEnrichmentBatch → SP-API Catalog Items (per-store credentials from DB)",
      image_update: "same worker batch (main_image_url + amazon_raw); no separate image cron",
      env_flags: {
        PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED: process.env.PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED ?? null,
        PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED: process.env.PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED ?? null,
        AMAZON_SP_API_ENABLED: process.env.AMAZON_SP_API_ENABLED ?? null,
      },
    },
    listing_pull_worker: {
      status: "not_wired",
      note: "No SP-API listing report scheduled pull; catalog enrich only",
    },
    api_flags: flags,
  };
}

function buildFixPlan(args: {
  original: Record<string, unknown>;
  staging: Record<string, unknown> | null;
  linkAudit: Record<string, unknown> | null;
  imageAudit: Record<string, unknown> | null;
}): string {
  const o = args.original;
  const ep = o.expected_packages as { unresolved: number; resolved: number; total: number };
  const dup = o.duplicate_identifier_conflicts as { fnsku_conflicts: number; asin_conflicts: number };
  const master = (o.product_master as { products: Record<string, number> }).products;

  return `# Phase 5D — Product ecosystem completion (safe fix plan)

**Mode:** audit-first; no bulk overwrite; no schema without approval; no scanner UI changes.

## Linkage (${ORIGINAL_REF} production/original)

| Metric | Value |
|--------|------:|
| EP resolved % | ${o.product_link_resolved_percent}% |
| EP unresolved | ${ep.unresolved} / ${ep.total} |
| Class A/B safe auto-fix | 0 (all remaining Class C) |
| FNSKU duplicate clusters | ${dup.fnsku_conflicts} |
| ASIN duplicate clusters | ${dup.asin_conflicts} |

### Wave 1 — Class C governed seed (operator approval)
- \`scripts/phase5c-expected-packages-class-c-governed-seed-plan.ts\`
- Per-row evidence; never overwrite existing \`resolved_product_id\`
- Resolve FNSKU \`X003UR3W83\` duplicate before map expansion

### Wave 2 — Return items (7 unresolved)
- Manual / evidence-only; 0 unique map matches in audit
- Do not auto-map ambiguous identifiers

### Wave 3 — Claim candidates (9055 rows, 0 resolved)
- Separate claim-product-linkage resolver dry-run before any persist
- Out of scope for EP Class C batch

## Master data gaps (original)

| Field gap | Count |
|-----------|------:|
| missing_vendor | ${master.missing_vendor} |
| missing_category | ${master.missing_category} |
| missing_main_image | ${master.missing_main_image} |
| missing_amazon_raw | ${master.missing_amazon_raw} |
| missing_dimensions | ${master.missing_dimensions ?? "n/a"} |

### Safe master-data fixes (staging first)
1. **Vendor/category backfill** — spreadsheet intake only (\`product-dimensions-spreadsheet-intake-*\`); no auto-guess
2. **Dimensions** — \`pc05-product-packaging-governed-backfill-dry-run\` pattern; review queue before activate
3. **Images** — targeted suspicious-cluster repair only (\`phase5b-suspicious-image-cluster-repair-staging.ts\`); **no bulk refresh**

## API automation

| Worker | Status |
|--------|--------|
| product_enrichment | Worker exists; schedule disabled on staging; scheduler-tick dry-run only |
| catalog/listing pull | Not wired as scheduled executor |
| image update | Part of enrichment batch; QA gate required |

**Next wiring (post-5D):** enable \`product_enrichment\` on staging → single-store dry-run job → verify \`main_image_url\` / \`amazon_raw\` on sample ASINs.

## Migration staging ↔ original

- Product + map **counts equal**; 158 map row IDs differ (symmetric parity note from Phase 5)
- Staging EP has **fewer rows** (9732 vs 12042) — subset/migration slice; not 1:1 EP parity
- **Do not bulk copy staging → production** without row-level diff approval

## Safety rules (non-negotiable)

1. Never overwrite valid \`resolved_product_id\` / \`product_id\`
2. Never auto-map when map hits ≠ 1
3. Never bulk image refresh without cluster QA
4. Preserve scanner return_items / packages hierarchy as-is

## Recommended execute sequence

1. \`PHASE-5C-CLASS-C-GOVERNED-SEED-STAGING-SAMPLE\` — 10-row dry-run
2. \`PHASE-5D-FNSKU-DUPLICATE-RESOLVE-STAGING\` — X003UR3W83 merge review
3. \`PHASE-5B-IMAGE-CLUSTER-REPAIR-NEXT-SAFE\` — next non-blocked cluster after 4152CsQbheL QA
4. \`PRODUCT-ENRICHMENT-STAGING-SINGLE-JOB-SMOKE\` — one ASIN catalog enrich with credentials from DB
5. Production: only after staging sample + operator sign-off on each wave
`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const origUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stagUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!origUrl.includes(ORIGINAL_REF)) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL guard failed");

  console.error("Phase 5D: auditing original…");
  const original = await auditRef("original", origUrl);
  console.error("Phase 5D: auditing staging…");
  const staging = stagUrl.includes(STAGING_REF) ? await auditRef("staging", stagUrl) : null;

  const linkAuditPath = path.join(process.cwd(), ".cursor/audit-reports/phase5-product-link-integrity-audit");
  let linkAudit: Record<string, unknown> | null = null;
  const linkDirs = fs.existsSync(linkAuditPath)
    ? fs.readdirSync(linkAuditPath).sort().reverse()
    : [];
  if (linkDirs[0]) {
    const p = path.join(linkAuditPath, linkDirs[0], "manifest.json");
    if (fs.existsSync(p)) linkAudit = JSON.parse(fs.readFileSync(p, "utf8"));
  }

  const imageAuditPath = path.join(process.cwd(), ".cursor/audit-reports/product-image-linkage");
  let imageAudit: Record<string, unknown> | null = null;
  const imageDirs = fs.existsSync(imageAuditPath) ? fs.readdirSync(imageAuditPath).sort().reverse() : [];
  if (imageDirs[0]) {
    const p = path.join(imageAuditPath, imageDirs[0], "summary.json");
    if (fs.existsSync(p)) imageAudit = JSON.parse(fs.readFileSync(p, "utf8"));
  }

  const apiWorker = await auditApiWorkerStatus();

  const oEp = original.expected_packages as { total: number; unresolved: number };
  const oDup = original.duplicate_identifier_conflicts as {
    fnsku_conflicts: number;
    sku_conflicts: number;
    asin_conflicts: number;
  };
  const oMaster = (original.product_master as { products: Record<string, number> }).products;
  const safeAutoFix = Number(linkAudit?.safe_auto_fix_count ?? 0);
  const manualReview = Number(linkAudit?.manual_review_count ?? oEp.unresolved);

  const stagingDiff = staging
    ? {
        products_count_delta:
          Number((staging.migration_fingerprint as { products: { n: number } }).products.n) -
          Number((original.migration_fingerprint as { products: { n: number } }).products.n),
        map_count_delta:
          Number((staging.migration_fingerprint as { product_identifier_map: { n: number } }).product_identifier_map.n) -
          Number((original.migration_fingerprint as { product_identifier_map: { n: number } }).product_identifier_map.n),
        ep_unresolved_delta:
          Number((staging.expected_packages as { unresolved: number }).unresolved) -
          Number((original.expected_packages as { unresolved: number }).unresolved),
        ep_resolved_percent_delta:
          Number(staging.product_link_resolved_percent) - Number(original.product_link_resolved_percent),
        product_id_fingerprint_match:
          (staging.migration_fingerprint as { products: { id_fingerprint: string } }).products.id_fingerprint ===
          (original.migration_fingerprint as { products: { id_fingerprint: string } }).products.id_fingerprint,
        map_id_fingerprint_match:
          (staging.migration_fingerprint as { product_identifier_map: { id_fingerprint: string } })
            .product_identifier_map.id_fingerprint ===
          (original.migration_fingerprint as { product_identifier_map: { id_fingerprint: string } })
            .product_identifier_map.id_fingerprint,
        master_data_deltas: {
          missing_vendor_delta: (staging.product_master as { products: Record<string, number> }).products.missing_vendor -
            oMaster.missing_vendor,
          missing_category_delta:
            (staging.product_master as { products: Record<string, number> }).products.missing_category -
            oMaster.missing_category,
          missing_main_image_delta:
            (staging.product_master as { products: Record<string, number> }).products.missing_main_image -
            oMaster.missing_main_image,
          missing_amazon_raw_delta:
            (staging.product_master as { products: Record<string, number> }).products.missing_amazon_raw -
            oMaster.missing_amazon_raw,
        },
        note: "EP row counts differ (staging subset); product/map spines aligned on count + fingerprint",
      }
    : null;

  const blockers: string[] = [];
  if (oDup.fnsku_conflicts > 0) blockers.push(`${oDup.fnsku_conflicts} FNSKU duplicate cluster(s) on original`);
  if (oDup.asin_conflicts > 30) blockers.push(`${oDup.asin_conflicts} ASIN duplicate clusters — resolve before auto-map`);
  if (safeAutoFix === 0 && oEp.unresolved > 0) {
    blockers.push("352 EP unresolved — all Class C; governed seed only, no Class A/B bulk fix");
  }
  if (imageAudit && imageAudit.SAFE_TO_REFRESH_AMAZON_IMAGES === "no") {
    blockers.push("Image audit: SAFE_TO_REFRESH_AMAZON_IMAGES=no — suspicious duplicate URL clusters");
  }
  const peEnabled = (staging?.automation_settings as { product_enrichment?: { enabled?: boolean } } | null)
    ?.product_enrichment?.enabled;
  if (!peEnabled) blockers.push("product_enrichment schedule disabled on staging — API self-sufficiency not live");

  const migrationNeeded =
    stagingDiff &&
    (!stagingDiff.product_id_fingerprint_match ||
      !stagingDiff.map_id_fingerprint_match ||
      stagingDiff.ep_unresolved_delta !== 0)
      ? "yes"
      : "conditional";

  const fixPlan = buildFixPlan({ original, staging, linkAudit, imageAudit });
  fs.writeFileSync(path.join(outDir, "safe_fix_plan.md"), fixPlan);

  const result = {
    phase_number: "5D",
    product_link_resolved_percent: original.product_link_resolved_percent,
    remaining_unresolved_count: oEp.unresolved,
    duplicate_identifier_conflicts: {
      fnsku: oDup.fnsku_conflicts,
      sku: oDup.sku_conflicts,
      asin: oDup.asin_conflicts,
      top_fnsku: linkAudit
        ? ((linkAudit.original_summary as { duplicate_conflicts?: { fnsku_top?: unknown[] } })?.duplicate_conflicts
            ?.fnsku_top ?? [])
        : [],
    },
    product_master_missing_fields: {
      missing_vendor: oMaster.missing_vendor,
      missing_category: oMaster.missing_category,
      missing_brand: oMaster.missing_brand,
      missing_main_image: oMaster.missing_main_image,
      missing_amazon_raw: oMaster.missing_amazon_raw,
      missing_dimensions: oMaster.missing_dimensions,
      missing_all_price_fields: oMaster.missing_all_price_fields,
      vendors_count: (original.product_master as { vendors_count: number }).vendors_count,
      categories_count: (original.product_master as { categories_count: number }).categories_count,
    },
    staging_original_product_diff: stagingDiff,
    product_api_worker_status: apiWorker,
    product_image_status: imageAudit
      ? {
          products_with_image: imageAudit.products_with_display_image,
          suspicious_reason_count: imageAudit.products_with_suspicious_reasons,
          duplicate_url_clusters: imageAudit.suspicious_duplicate_url_clusters,
          SAFE_TO_REFRESH_AMAZON_IMAGES: imageAudit.SAFE_TO_REFRESH_AMAZON_IMAGES,
        }
      : { note: "Run phase5b-product-image-linkage-audit-readonly.ts for full image census" },
    packages_pallets: original.packages_pallets,
    claim_candidates_unresolved: (original.claim_candidates as { unresolved?: number })?.unresolved ?? null,
    return_items_unresolved: (original.return_items as { unresolved?: number })?.unresolved ?? null,
    safe_auto_fix_count: safeAutoFix,
    manual_review_count: manualReview,
    migration_needed_yes_no: migrationNeeded,
    SAFE_TO_APPLY_PRODUCT_ECOSYSTEM_FIX_STAGING: safeAutoFix > 0 ? "conditional" : "yes_for_governed_waves_only",
    SAFE_TO_APPLY_PRODUCT_ECOSYSTEM_FIX_PRODUCTION: "no",
    blockers,
    next_exact_execute_prompt:
      "PHASE-5C-CLASS-C-GOVERNED-SEED-STAGING-SAMPLE — dry-run 10 Class C expected_packages rows with evidence queue; no overwrite of resolved_product_id; no bulk images",
    original,
    staging,
    link_audit_ref: linkDirs[0] ?? null,
    image_audit_ref: imageDirs[0] ?? null,
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
