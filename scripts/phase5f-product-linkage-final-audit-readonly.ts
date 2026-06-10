/**
 * PHASE-5F-PRODUCT-LINKAGE-FINAL-AUDIT (read-only)
 *   npx tsx scripts/phase5f-product-linkage-final-audit-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { evaluateSuspiciousMainImage } from "../lib/pim-image-suspicious-policy";
import { resolvePimDisplayImageUrl } from "../lib/pim-display-image";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase5f-product-linkage-final-audit";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function tableExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
    [name],
  );
  return (r.rowCount ?? 0) > 0;
}

async function cols(client: pg.Client, table: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

async function auditImageIssues(client: pg.Client): Promise<Record<string, unknown>> {
  const r = await client.query<{
    id: string;
    product_name: string | null;
    asin: string | null;
    main_image_url: string | null;
    amazon_raw: unknown;
  }>(
    `SELECT id::text, product_name, asin, main_image_url, amazon_raw
     FROM products WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
    [ORG],
  );

  let missingImage = 0;
  let suspicious = 0;
  let knownBadCluster = 0;
  const urlToProducts = new Map<string, string[]>();

  for (const row of r.rows) {
    const display = resolvePimDisplayImageUrl(row.main_image_url, row.amazon_raw);
    if (!display) {
      missingImage += 1;
      continue;
    }
    const eval_ = evaluateSuspiciousMainImage(row);
    if (eval_.suspicious) {
      suspicious += 1;
      if (eval_.reasons.includes("known_bad_url_cluster")) knownBadCluster += 1;
    }
    const list = urlToProducts.get(display) ?? [];
    list.push(row.id);
    urlToProducts.set(display, list);
  }

  let duplicateSuspiciousClusters = 0;
  for (const [, ids] of urlToProducts) {
    if (ids.length >= 3) duplicateSuspiciousClusters += 1;
  }

  return {
    total_products: r.rows.length,
    missing_display_image: missingImage,
    suspicious_main_image: suspicious,
    known_bad_url_cluster_products: knownBadCluster,
    duplicate_url_clusters_3plus: duplicateSuspiciousClusters,
    image_issues_count: missingImage + suspicious,
  };
}

async function auditEnrichmentLastRun(client: pg.Client, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ref: label };

  if (await tableExists(client, "background_jobs")) {
    const bgCols = await cols(client, "background_jobs");
    const timeCol = bgCols.has("updated_at")
      ? "updated_at"
      : bgCols.has("created_at")
        ? "created_at"
        : "id";
    const selectCols = [
      "id::text",
      bgCols.has("status") ? "status" : "NULL::text AS status",
      bgCols.has("created_at") ? "created_at::text" : "NULL::text AS created_at",
      bgCols.has("updated_at") ? "updated_at::text" : "NULL::text AS updated_at",
      bgCols.has("completed_at") ? "completed_at::text" : "NULL::text AS completed_at",
      bgCols.has("last_error_detail") ? "last_error_detail" : "NULL::text AS last_error_detail",
      bgCols.has("payload") ? "payload->>'store_id' AS store_id" : "NULL::text AS store_id",
    ].join(", ");
    const jobs = await client.query(
      `SELECT ${selectCols}
       FROM background_jobs
       WHERE job_type='product_enrichment' AND organization_id=$1::uuid
       ORDER BY ${timeCol} DESC NULLS LAST LIMIT 5`,
      [ORG],
    );
    out.background_jobs_last5 = jobs.rows;
    out.last_run_at = jobs.rows[0]?.updated_at ?? jobs.rows[0]?.completed_at ?? jobs.rows[0]?.created_at ?? null;
    out.last_status = jobs.rows[0]?.status ?? null;
  } else {
    out.background_jobs_table = false;
  }

  if (await tableExists(client, "jobs")) {
    const legacy = await client.query(
      `SELECT id::text, status, created_at::text, completed_at::text, last_error
       FROM jobs WHERE job_type='product_enrichment' AND organization_id=$1::uuid
       ORDER BY coalesce(completed_at, created_at) DESC NULLS LAST LIMIT 3`,
      [ORG],
    );
    out.jobs_table_last3 = legacy.rows;
    if (!out.last_run_at && legacy.rows[0]) {
      out.last_run_at = legacy.rows[0].completed_at ?? legacy.rows[0].created_at;
      out.last_status = legacy.rows[0].status;
    }
  }

  try {
    const ps = await client.query(`SELECT automation_settings FROM platform_settings WHERE id=true LIMIT 1`);
    const doc = (ps.rows[0]?.automation_settings ?? {}) as Record<string, unknown>;
    const scopeKey = `${ORG}:${STORE}`;
    const scopes = doc.scopes as Record<string, unknown> | undefined;
    const scope = scopes?.[scopeKey] ?? scopes?.[`org:${ORG}:store:${STORE}`] ?? null;
    const pe = (scope as { product_enrichment?: unknown } | null)?.product_enrichment ?? doc.product_enrichment;
    out.product_enrichment_schedule = pe;
  } catch {
    out.product_enrichment_schedule = null;
  }

  const enrichedRecently = await client.query(
    `SELECT count(*)::int AS n,
            max(updated_at)::text AS max_updated_at
     FROM products
     WHERE organization_id=$1::uuid AND deleted_at IS NULL
       AND amazon_raw IS NOT NULL
       AND updated_at >= now() - interval '30 days'`,
    [ORG],
  );
  out.products_with_amazon_raw_updated_30d = enrichedRecently.rows[0];

  return out;
}

async function auditRef(label: string, url: string): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const ep = await client.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
            count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
     FROM expected_packages WHERE organization_id=$1::uuid`,
    [ORG],
  );

  const ri = await client.query(
    `SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
            count(*) FILTER (WHERE deleted_at IS NULL AND resolved_product_id IS NOT NULL)::int AS resolved,
            count(*) FILTER (WHERE deleted_at IS NULL AND resolved_product_id IS NULL)::int AS unresolved
     FROM return_items WHERE organization_id=$1::uuid`,
    [ORG],
  );

  let claims = { total: 0, resolved: 0, unresolved: 0 };
  if (await tableExists(client, "claim_candidates")) {
    const cc = await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
              count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
       FROM claim_candidates WHERE organization_id=$1::uuid`,
      [ORG],
    );
    claims = cc.rows[0] as typeof claims;
  }

  const mapDup = await client.query(
    `SELECT
      (SELECT count(*)::int FROM (
         SELECT upper(btrim(fnsku)) FROM product_identifier_map
         WHERE organization_id=$1::uuid AND deleted_at IS NULL AND fnsku IS NOT NULL AND btrim(fnsku)<>''
         GROUP BY 1 HAVING count(DISTINCT product_id)>1
       ) x) AS fnsku_conflicts,
      (SELECT count(*)::int FROM (
         SELECT upper(btrim(seller_sku)), coalesce(store_id::text,'') FROM product_identifier_map
         WHERE organization_id=$1::uuid AND deleted_at IS NULL AND seller_sku IS NOT NULL AND btrim(seller_sku)<>''
         GROUP BY 1,2 HAVING count(DISTINCT product_id)>1
       ) x) AS sku_conflicts,
      (SELECT count(*)::int FROM (
         SELECT upper(btrim(asin)) FROM product_identifier_map
         WHERE organization_id=$1::uuid AND deleted_at IS NULL AND asin IS NOT NULL AND btrim(asin)<>''
         GROUP BY 1 HAVING count(DISTINCT product_id)>1
       ) x) AS asin_conflicts,
      (SELECT count(*)::int FROM (
         SELECT upper(btrim(upc_code)) FROM product_identifier_map
         WHERE organization_id=$1::uuid AND deleted_at IS NULL AND upc_code IS NOT NULL AND btrim(upc_code)<>''
         GROUP BY 1 HAVING count(DISTINCT product_id)>1
       ) x) AS upc_conflicts`,
    [ORG],
  );

  const mapCov = await client.query(
    `SELECT
      count(*) FILTER (WHERE deleted_at IS NULL)::int AS active_rows,
      count(*) FILTER (WHERE deleted_at IS NULL AND NULLIF(btrim(fnsku),'') IS NOT NULL)::int AS with_fnsku,
      count(*) FILTER (WHERE deleted_at IS NULL AND NULLIF(btrim(seller_sku),'') IS NOT NULL)::int AS with_sku,
      count(*) FILTER (WHERE deleted_at IS NULL AND NULLIF(btrim(asin),'') IS NOT NULL)::int AS with_asin,
      count(*) FILTER (WHERE deleted_at IS NULL AND NULLIF(btrim(upc_code),'') IS NOT NULL)::int AS with_upc
     FROM product_identifier_map WHERE organization_id=$1::uuid`,
    [ORG],
  );

  const prodCols = await cols(client, "products");
  const upcCol = prodCols.has("upc_code") ? "upc_code" : prodCols.has("barcode") ? "barcode" : null;
  const prodCov = await client.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE NULLIF(btrim(fnsku),'') IS NOT NULL)::int AS with_fnsku,
            count(*) FILTER (WHERE NULLIF(btrim(sku),'') IS NOT NULL)::int AS with_sku,
            count(*) FILTER (WHERE NULLIF(btrim(asin),'') IS NOT NULL)::int AS with_asin,
            ${upcCol ? `count(*) FILTER (WHERE NULLIF(btrim(${upcCol}),'') IS NOT NULL)::int AS with_upc` : "0::int AS with_upc"}
     FROM products WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
    [ORG],
  );

  const fingerprint = await client.query(
    `SELECT count(*)::int AS n,
            md5(string_agg(id::text, ',' ORDER BY id)) AS id_fingerprint
     FROM products WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
    [ORG],
  );
  const mapFp = await client.query(
    `SELECT count(*)::int AS n,
            md5(string_agg(id::text, ',' ORDER BY id)) AS id_fingerprint
     FROM product_identifier_map WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
    [ORG],
  );

  const images = await auditImageIssues(client);
  const apiStatus = await auditEnrichmentLastRun(client, label);

  await client.end();

  const epRow = ep.rows[0] as { total: number; resolved: number; unresolved: number };
  const riRow = ri.rows[0] as { active: number; resolved: number; unresolved: number };
  const prodRow = prodCov.rows[0] as { total: number; with_fnsku: number; with_sku: number; with_asin: number; with_upc: number };

  const epPct = epRow.total === 0 ? 100 : Math.round((epRow.resolved / epRow.total) * 1000) / 10;
  const riPct = riRow.active === 0 ? 100 : Math.round((riRow.resolved / riRow.active) * 1000) / 10;
  const idCoverage =
    prodRow.total === 0
      ? 100
      : Math.round(
          ((prodRow.with_fnsku + prodRow.with_sku + prodRow.with_asin + prodRow.with_upc) /
            (prodRow.total * 4)) *
            1000,
        ) / 10;
  const imagePct =
    prodRow.total === 0
      ? 100
      : Math.round(
          (((images.total_products as number) - (images.missing_display_image as number)) /
            (images.total_products as number)) *
            1000,
        ) / 10;
  const ecosystemPct = Math.round(((epPct + riPct + idCoverage + imagePct) / 4) * 10) / 10;

  return {
    ref: label === "original" ? ORIGINAL_REF : STAGING_REF,
    label,
    expected_packages: epRow,
    return_items: riRow,
    claim_candidates: claims,
    identifier_conflicts: mapDup.rows[0],
    identifier_coverage: {
      product_identifier_map: mapCov.rows[0],
      products: prodRow,
    },
    images,
    product_api_status: apiStatus,
    migration_fingerprint: {
      products: fingerprint.rows[0],
      product_identifier_map: mapFp.rows[0],
    },
    product_ecosystem_percent: ecosystemPct,
    product_ecosystem_breakdown: { ep_link_pct: epPct, return_link_pct: riPct, identifier_coverage_pct: idCoverage, image_pct: imagePct },
  };
}

function buildNextFixPrompt(args: {
  original: Record<string, unknown>;
  staging: Record<string, unknown>;
  stagingDiff: Record<string, unknown>;
}): string {
  const oEp = args.original.expected_packages as { unresolved: number };
  const sEp = args.staging.expected_packages as { unresolved: number };
  const dup = args.original.identifier_conflicts as {
    fnsku_conflicts: number;
    asin_conflicts: number;
  };
  const img = args.original.images as { image_issues_count: number; known_bad_url_cluster_products: number };

  const lines: string[] = [];
  if (oEp.unresolved > 0) {
    lines.push(
      `PHASE-5C-CLASS-C-GOVERNED-SEED-STAGING-APPLY-SAMPLE — ${oEp.unresolved} EP unresolved on original (${sEp.unresolved} staging); governed seed with evidence queue`,
    );
  }
  if (dup.fnsku_conflicts > 0) {
    lines.push(
      `PHASE-5D-FNSKU-DUPLICATE-RESOLVE — ${dup.fnsku_conflicts} FNSKU map conflict cluster(s) before Class B map bridge`,
    );
  }
  if (img.known_bad_url_cluster_products > 0) {
    lines.push(
      `PHASE-5B-IMAGE-CLUSTER-REPAIR-NEXT-SAFE — ${img.known_bad_url_cluster_products} products on known-bad URL needles; staging-only until operator sign-off`,
    );
  }
  const ri = args.original.return_items as { unresolved: number };
  if (ri.unresolved > 0) {
    lines.push(`RETURN-ITEMS-LINKAGE-MANUAL-REVIEW — ${ri.unresolved} active return_items without resolved_product_id`);
  }
  const cc = args.original.claim_candidates as { unresolved: number };
  if (cc.unresolved > 0) {
    lines.push(`CLAIM-CANDIDATES-PRODUCT-LINKAGE-DRY-RUN — ${cc.unresolved} claim_candidates unresolved (separate resolver)`);
  }
  const pe = (args.staging.product_api_status as { product_enrichment_schedule?: { enabled?: boolean } })
    ?.product_enrichment_schedule;
  if (!pe?.enabled) {
    lines.push("PRODUCT-ENRICHMENT-STAGING-SINGLE-JOB-SMOKE — enable schedule + one catalog enrich job with DB credentials");
  }
  if (!lines.length) lines.push("PRODUCT-LINKAGE-SIGNOFF — no blockers; proceed to production parity verification");
  return lines.join("\n");
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const origUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stagUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!origUrl.includes(ORIGINAL_REF)) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL guard failed");
  if (!stagUrl.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL guard failed");

  console.error("Phase 5F: auditing original…");
  const original = await auditRef("original", origUrl);
  console.error("Phase 5F: auditing staging…");
  const staging = await auditRef("staging", stagUrl);

  const oFp = original.migration_fingerprint as {
    products: { n: number; id_fingerprint: string };
    product_identifier_map: { n: number; id_fingerprint: string };
  };
  const sFp = staging.migration_fingerprint as typeof oFp;

  const stagingOriginalDiff = {
    products_count_delta: sFp.products.n - oFp.products.n,
    map_count_delta: sFp.product_identifier_map.n - oFp.product_identifier_map.n,
    product_id_fingerprint_match: sFp.products.id_fingerprint === oFp.products.id_fingerprint,
    map_id_fingerprint_match: sFp.product_identifier_map.id_fingerprint === oFp.product_identifier_map.id_fingerprint,
    expected_packages_unresolved_delta:
      (staging.expected_packages as { unresolved: number }).unresolved -
      (original.expected_packages as { unresolved: number }).unresolved,
    return_items_unresolved_delta:
      (staging.return_items as { unresolved: number }).unresolved -
      (original.return_items as { unresolved: number }).unresolved,
    claim_candidates_unresolved_delta:
      (staging.claim_candidates as { unresolved: number }).unresolved -
      (original.claim_candidates as { unresolved: number }).unresolved,
    product_ecosystem_percent_delta:
      (staging.product_ecosystem_percent as number) - (original.product_ecosystem_percent as number),
    note: "EP row totals differ (staging migration subset); product+map spines aligned on count+fingerprint when match=true",
  };

  const nextFixPrompt = buildNextFixPrompt({ original, staging, stagingDiff: stagingOriginalDiff });

  const result = {
    audit_id: "PHASE-5F-PRODUCT-LINKAGE-FINAL-AUDIT",
    run_id: rid,
    mode: "read-only",
    staging_ref: STAGING_REF,
    original_ref: ORIGINAL_REF,
    expected_packages_unresolved: {
      staging: (staging.expected_packages as { unresolved: number }).unresolved,
      original: (original.expected_packages as { unresolved: number }).unresolved,
      staging_total: (staging.expected_packages as { total: number }).total,
      original_total: (original.expected_packages as { total: number }).total,
    },
    return_items_unresolved: {
      staging: (staging.return_items as { unresolved: number }).unresolved,
      original: (original.return_items as { unresolved: number }).unresolved,
    },
    claim_candidates_unresolved: {
      staging: (staging.claim_candidates as { unresolved: number }).unresolved,
      original: (original.claim_candidates as { unresolved: number }).unresolved,
    },
    identifier_conflicts: {
      staging: staging.identifier_conflicts,
      original: original.identifier_conflicts,
    },
    identifier_coverage: {
      staging: staging.identifier_coverage,
      original: original.identifier_coverage,
    },
    image_issues_count: {
      staging: (staging.images as { image_issues_count: number }).image_issues_count,
      original: (original.images as { image_issues_count: number }).image_issues_count,
      staging_detail: staging.images,
      original_detail: original.images,
    },
    product_api_status: {
      staging: staging.product_api_status,
      original: original.product_api_status,
    },
    staging_original_diff: stagingOriginalDiff,
    product_ecosystem_percent: {
      staging: staging.product_ecosystem_percent,
      original: original.product_ecosystem_percent,
      breakdown_staging: staging.product_ecosystem_breakdown,
      breakdown_original: original.product_ecosystem_breakdown,
    },
    next_fix_prompt: nextFixPrompt,
    original,
    staging,
  };

  const md = `# PHASE-5F Product linkage final audit

Run: \`${rid}\` · Mode: read-only  
Staging: \`${STAGING_REF}\` · Original: \`${ORIGINAL_REF}\`

## Summary

| Metric | Staging | Original |
|--------|---------|----------|
| EP unresolved | ${result.expected_packages_unresolved.staging} / ${result.expected_packages_unresolved.staging_total} | ${result.expected_packages_unresolved.original} / ${result.expected_packages_unresolved.original_total} |
| return_items unresolved | ${result.return_items_unresolved.staging} | ${result.return_items_unresolved.original} |
| claim_candidates unresolved | ${result.claim_candidates_unresolved.staging} | ${result.claim_candidates_unresolved.original} |
| product ecosystem % | ${result.product_ecosystem_percent.staging} | ${result.product_ecosystem_percent.original} |
| image issues | ${result.image_issues_count.staging} | ${result.image_issues_count.original} |

## identifier_conflicts (original)

${JSON.stringify(result.identifier_conflicts.original, null, 2)}

## staging_original_diff

${JSON.stringify(stagingOriginalDiff, null, 2)}

## next_fix_prompt

\`\`\`text
${nextFixPrompt}
\`\`\`
`;

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "audit-report.md"), md);
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ audit_id: result.audit_id, run_id: rid, mode: "read-only" }, null, 2),
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
