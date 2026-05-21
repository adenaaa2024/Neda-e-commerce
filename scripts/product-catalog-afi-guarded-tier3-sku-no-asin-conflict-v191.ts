/**
 * PRODUCT-CATALOG-AFI-GUARDED-TIER3-SKU-NO-ASIN-CONFLICT-V191
 *
 * Read-only preflight for the guarded AFI Tier 3 SKU-only cohort.
 * This script does not execute updates. Execution requires a separate approved pass.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/product-catalog-afi-guarded-tier3-sku-no-asin-conflict-v191";
const APPROVAL_PATH =
  ".cursor/operator-approvals/product-catalog-afi-guarded-tier3-sku-no-asin-conflict-v191-approval.md";

type Candidate = {
  afi_id: string;
  organization_id: string;
  store_id: string;
  seller_sku: string;
  fulfillment_channel_sku: string;
  asin: string;
  target_product_id: string;
  target_catalog_product_id: string | null;
  map_ids: string[];
  map_asin_null_rows: number;
  map_asin_mismatch_rows: number;
};

type PreflightResult = {
  run_id: string;
  prompt: string;
  mode: string;
  coverage: {
    total_rows: number;
    resolved_product_id_rows: number;
    unresolved_rows: number;
    coverage_pct: number;
  };
  preflight: {
    candidate_count: number;
    unique_skus: number;
    unique_fnskus: number;
    unique_target_products: number;
    rows_with_target_catalog_product_id: number;
    batch_size_recommendation: number;
    status_to_write_if_approved: string;
    confidence_to_write_if_approved: number;
  };
  candidates: Candidate[];
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function writeApprovalFile(): void {
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (fs.existsSync(p)) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    [
      "# Product catalog AFI guarded Tier 3 SKU/no-ASIN-conflict V191 approval",
      "",
      "**Default:** not approved. Preflight only until Main/user flips the flag.",
      "",
      "| Field | Value |",
      "|---|---|",
      `| Staging ref | \`${STAGING_REF}\` |`,
      "| Allowed write | UPDATE `amazon_amazon_fulfilled_inventory` resolver columns only |",
      "| Product creation | forbidden |",
      "| Map inserts | forbidden |",
      "| Production | forbidden |",
      "",
      "```text",
      "APPROVED_TO_RUN_STAGING=false",
      "APPROVED_GUARDED_TIER3_SKU_NO_ASIN_CONFLICT=false",
      "```",
      "",
    ].join("\n"),
  );
}

function sql(runId: string): string {
  return `
with u as (
  select
    id,
    organization_id,
    store_id,
    nullif(trim(fulfillment_channel_sku), '') as fnsku,
    nullif(trim(seller_sku), '') as sku,
    nullif(trim(asin), '') as asin
  from public.amazon_amazon_fulfilled_inventory
  where resolved_product_id is null
    and organization_id is not null
    and store_id is not null
), m as (
  select
    id as map_id,
    organization_id,
    store_id,
    product_id,
    catalog_product_id,
    nullif(trim(fnsku), '') as fnsku,
    nullif(trim(seller_sku), '') as seller_sku,
    nullif(trim(msku), '') as msku,
    nullif(trim(asin), '') as asin
  from public.product_identifier_map
  where deleted_at is null and product_id is not null
), t1 as (
  select u.id, count(distinct m.product_id)::int as product_count
  from u join m on m.organization_id = u.organization_id and m.store_id = u.store_id
    and u.fnsku is not null and m.fnsku = u.fnsku
  group by u.id
), t2 as (
  select u.id, count(distinct m.product_id)::int as product_count
  from u join m on m.organization_id = u.organization_id and m.store_id = u.store_id
    and u.sku is not null and u.asin is not null
    and (m.seller_sku = u.sku or m.msku = u.sku) and m.asin = u.asin
  group by u.id
), t4 as (
  select u.id, count(distinct m.product_id)::int as product_count
  from u join m on m.organization_id = u.organization_id and m.store_id = u.store_id
    and u.asin is not null and m.asin = u.asin
  group by u.id
), p as (
  select organization_id, store_id, id,
    nullif(trim(fnsku), '') as fnsku,
    nullif(trim(sku), '') as sku,
    nullif(trim(asin), '') as asin
  from public.products
  where deleted_at is null
), pf as (
  select u.id, count(distinct p.id)::int as product_count
  from u join p on p.organization_id = u.organization_id and p.store_id = u.store_id
    and u.fnsku is not null and p.fnsku = u.fnsku
  group by u.id
), psa as (
  select u.id, count(distinct p.id)::int as product_count
  from u join p on p.organization_id = u.organization_id and p.store_id = u.store_id
    and u.sku is not null and u.asin is not null and p.sku = u.sku and p.asin = u.asin
  group by u.id
), pa as (
  select u.id, count(distinct p.id)::int as product_count
  from u join p on p.organization_id = u.organization_id and p.store_id = u.store_id
    and u.asin is not null and p.asin = u.asin
  group by u.id
), sku_matches as (
  select
    u.id,
    u.organization_id,
    u.store_id,
    u.sku,
    u.fnsku,
    u.asin,
    count(distinct m.product_id)::int as sku_product_count,
    min(m.product_id::text)::uuid as target_product_id,
    (array_agg(m.catalog_product_id order by m.catalog_product_id nulls last))[1] as target_catalog_product_id,
    array_agg(distinct m.map_id::text order by m.map_id::text) as map_ids,
    count(*) filter (where m.asin = u.asin)::int as matching_asin_rows,
    count(*) filter (where m.asin is null)::int as map_asin_null_rows,
    count(*) filter (where m.asin is not null and m.asin <> u.asin)::int as map_asin_mismatch_rows
  from u
  join m on m.organization_id = u.organization_id and m.store_id = u.store_id
    and u.sku is not null and (m.seller_sku = u.sku or m.msku = u.sku)
  group by u.id, u.organization_id, u.store_id, u.sku, u.fnsku, u.asin
), candidates as (
  select sm.*
  from sku_matches sm
  left join t1 on t1.id = sm.id
  left join t2 on t2.id = sm.id
  left join t4 on t4.id = sm.id
  left join pf on pf.id = sm.id
  left join psa on psa.id = sm.id
  left join pa on pa.id = sm.id
  where sm.sku_product_count = 1
    and sm.matching_asin_rows = 0
    and sm.map_asin_mismatch_rows = 0
    and sm.map_asin_null_rows > 0
    and coalesce(t1.product_count, 0) <> 1
    and coalesce(t2.product_count, 0) <> 1
    and coalesce(t4.product_count, 0) <> 1
    and not (coalesce(pf.product_count, 0) = 1 or coalesce(psa.product_count, 0) = 1 or coalesce(pa.product_count, 0) = 1)
), coverage as (
  select jsonb_build_object(
    'total_rows', count(*),
    'resolved_product_id_rows', count(*) filter (where resolved_product_id is not null),
    'unresolved_rows', count(*) filter (where resolved_product_id is null),
    'coverage_pct', round((count(*) filter (where resolved_product_id is not null))::numeric * 100 / nullif(count(*), 0), 2)
  ) as coverage_json
  from public.amazon_amazon_fulfilled_inventory
), summary as (
  select jsonb_build_object(
    'candidate_count', count(*),
    'unique_skus', count(distinct sku),
    'unique_fnskus', count(distinct fnsku),
    'unique_target_products', count(distinct target_product_id),
    'rows_with_target_catalog_product_id', count(*) filter (where target_catalog_product_id is not null),
    'batch_size_recommendation', 100,
    'status_to_write_if_approved', 'matched',
    'confidence_to_write_if_approved', 0.85
  ) as summary_json
  from candidates
), candidate_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'afi_id', id,
    'organization_id', organization_id,
    'store_id', store_id,
    'seller_sku', sku,
    'fulfillment_channel_sku', fnsku,
    'asin', asin,
    'target_product_id', target_product_id,
    'target_catalog_product_id', target_catalog_product_id,
    'map_ids', map_ids,
    'map_asin_null_rows', map_asin_null_rows,
    'map_asin_mismatch_rows', map_asin_mismatch_rows
  ) order by sku, fnsku, id), '[]'::jsonb) as candidates_json
  from candidates
)
select jsonb_build_object(
  'run_id', '${runId}',
  'prompt', 'PRODUCT-CATALOG-AFI-GUARDED-TIER3-SKU-NO-ASIN-CONFLICT-EXECUTE-V191',
  'mode', 'read_only_preflight',
  'coverage', coverage.coverage_json,
  'preflight', summary.summary_json,
  'candidates', candidate_json.candidates_json
) as result
from coverage, summary, candidate_json;
`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  writeApprovalFile();

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");
  const res = await client.query(sql(runId));
  await client.end();

  const result = res.rows[0]?.result as PreflightResult;
  if (!result) throw new Error("Preflight query returned no result");

  fs.writeFileSync(path.join(outDir, "candidates.json"), JSON.stringify(result.candidates, null, 2));
  fs.writeFileSync(path.join(outDir, "preflight-summary.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "rollback-plan.md"),
    [
      "# Rollback plan",
      "",
      "No DB writes were executed in this preflight.",
      "",
      "If a later approved execute updates AFI resolver columns, rollback should be restricted to the exact `afi_id` allowlist in `candidates.json` and restore:",
      "",
      "- `resolved_product_id = NULL`",
      "- `resolved_catalog_product_id = NULL`",
      "- `identifier_resolution_status = NULL`",
      "- `identifier_resolution_confidence = NULL`",
      "",
      "Before rollback, verify those rows were last touched by the V191 guarded Tier 3 run/audit batch.",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, "approval-needed.md"),
    [
      "# Approval needed",
      "",
      `Approval file: \`${APPROVAL_PATH}\``,
      "",
      "Execution remains disabled by default:",
      "",
      "```text",
      "APPROVED_TO_RUN_STAGING=false",
      "APPROVED_GUARDED_TIER3_SKU_NO_ASIN_CONFLICT=false",
      "```",
      "",
      "Flip both flags only after reviewing `candidates.json`.",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: result.prompt,
        run_id: runId,
        staging_ref: STAGING_REF,
        mode: result.mode,
        status: "PREFLIGHT_ONLY_NO_WRITES",
        db_writes: false,
        product_create: false,
        map_insert: false,
        afi_update: false,
        coverage: result.coverage,
        preflight: result.preflight,
        artifacts: [
          "candidates.json",
          "preflight-summary.json",
          "rollback-plan.md",
          "approval-needed.md",
          "manifest.json",
        ],
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ coverage: result.coverage, preflight: result.preflight }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
