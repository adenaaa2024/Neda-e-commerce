/**
 * PRODUCT-CATALOG-WAVE-B1-MAP-BRIDGE-FROM-PRODUCTS-V190B
 *
 *   npx tsx scripts/product-identifier-map-bridge-from-products-v190b.ts --run-id=<id>
 *   npx tsx scripts/product-identifier-map-bridge-from-products-v190b.ts --run-id=<id> --execute [--limit=500] [--all]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/product-identifier-map-bridge-from-products-v190";
const APPROVAL_PATH = ".cursor/operator-approvals/product-identifier-map-bridge-from-products-v190-approval.md";
const PLAN_RUN = "20260524T190000Z";
const MATCH_SOURCE = "product_bridge_v190b";
const EXTERNAL_PREFIX = "product_bridge_v190b:";
const DEFAULT_BATCH = 500;

const ELIGIBLE_CTE = `
  WITH no_map AS (
    SELECT p.id, p.organization_id, p.store_id,
      NULLIF(TRIM(p.sku), '') AS sku,
      NULLIF(TRIM(p.asin), '') AS asin,
      NULLIF(TRIM(p.fnsku), '') AS fnsku,
      NULLIF(TRIM(p.upc_code), '') AS upc_code
    FROM public.products p
    WHERE NOT EXISTS (
      SELECT 1 FROM public.product_identifier_map m WHERE m.product_id = p.id
    )
  ),
  classified AS (
    SELECT no_map.*,
      CASE
        WHEN store_id IS NULL THEN 'excluded_no_store_id'
        WHEN sku IS NULL AND asin IS NULL AND fnsku IS NULL THEN 'excluded_no_exact_identifier'
        WHEN upc_code IS NOT NULL AND sku IS NULL AND asin IS NULL AND fnsku IS NULL THEN 'excluded_upc_only_not_in_wave'
        WHEN EXISTS (
          SELECT 1 FROM public.product_identifier_map m
          WHERE m.organization_id = no_map.organization_id AND m.store_id = no_map.store_id
            AND m.product_id IS NOT NULL AND m.product_id <> no_map.id
            AND (no_map.sku IS NOT NULL AND (NULLIF(TRIM(m.seller_sku), '') = no_map.sku OR NULLIF(TRIM(m.msku), '') = no_map.sku))
        ) THEN 'blocked_sku_owned_by_other_product'
        WHEN EXISTS (
          SELECT 1 FROM public.product_identifier_map m
          WHERE m.organization_id = no_map.organization_id AND m.store_id = no_map.store_id
            AND m.product_id IS NOT NULL AND m.product_id <> no_map.id
            AND no_map.fnsku IS NOT NULL AND NULLIF(TRIM(m.fnsku), '') = no_map.fnsku
        ) THEN 'blocked_fnsku_owned_by_other_product'
        WHEN EXISTS (
          SELECT 1 FROM public.product_identifier_map m
          WHERE m.organization_id = no_map.organization_id AND m.store_id = no_map.store_id
            AND m.product_id IS NOT NULL AND m.product_id <> no_map.id
            AND no_map.asin IS NOT NULL AND NULLIF(TRIM(m.asin), '') = no_map.asin
        ) THEN 'blocked_asin_owned_by_other_product'
        ELSE 'insert_candidate'
      END AS classification
    FROM no_map
  )
`;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function limitArg(): number {
  const a = process.argv.find((x) => x.startsWith("--limit="));
  if (a) return Math.max(1, parseInt(a.split("=")[1]!, 10));
  return DEFAULT_BATCH;
}

function readApproval(): { staging: boolean; insert: boolean } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  return {
    staging: /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text),
    insert: /APPROVED_TO_INSERT_MAP_ROWS\s*=\s*true/i.test(text),
  };
}

async function dryRunCounts(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    ${ELIGIBLE_CTE}
    SELECT classification, COUNT(*)::int AS n
    FROM classified
    GROUP BY classification
    ORDER BY n DESC
  `);
  const out: Record<string, number> = {};
  for (const row of r.rows as { classification: string; n: number }[]) {
    out[row.classification] = row.n;
  }
  return out;
}

async function spineSnapshot(client: pg.Client): Promise<Record<string, number>> {
  const products = await client.query(`SELECT COUNT(*)::int AS n FROM public.products`);
  const mapTotal = await client.query(`SELECT COUNT(*)::int AS n FROM public.product_identifier_map`);
  const noMap = await client.query(`
    SELECT COUNT(*)::int AS n FROM public.products p
    WHERE NOT EXISTS (SELECT 1 FROM public.product_identifier_map m WHERE m.product_id = p.id)
  `);
  const bridgeRows = await client.query(`
    SELECT COUNT(*)::int AS n FROM public.product_identifier_map
    WHERE match_source = $1
  `, [MATCH_SOURCE]);
  return {
    products: products.rows[0]?.n,
    product_identifier_map: mapTotal.rows[0]?.n,
    products_without_map: noMap.rows[0]?.n,
    map_rows_product_bridge_v190b: bridgeRows.rows[0]?.n,
  };
}

async function materializeCandidates(client: pg.Client): Promise<number> {
  await client.query(`DROP TABLE IF EXISTS _v190b_candidates`);
  await client.query(`
    CREATE TEMP TABLE _v190b_candidates (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      store_id uuid NOT NULL,
      sku text,
      asin text,
      fnsku text
    ) ON COMMIT PRESERVE ROWS
  `);
  const ins = await client.query(`
    ${ELIGIBLE_CTE}
    INSERT INTO _v190b_candidates (id, organization_id, store_id, sku, asin, fnsku)
    SELECT id, organization_id, store_id, sku, asin, fnsku
    FROM classified
    WHERE classification = 'insert_candidate'
  `);
  return ins.rowCount ?? 0;
}

async function remainingCandidates(client: pg.Client): Promise<number> {
  const r = await client.query(`SELECT COUNT(*)::int AS n FROM _v190b_candidates`);
  return Number(r.rows[0]?.n ?? 0);
}

async function insertBatch(
  client: pg.Client,
  batchLimit: number,
): Promise<{ inserted: number; rows: { map_id: string; product_id: string }[] }> {
  const q = `
    WITH picked AS (
      SELECT id FROM _v190b_candidates ORDER BY id LIMIT $1
    ),
    ins AS (
      INSERT INTO public.product_identifier_map (
        organization_id,
        store_id,
        product_id,
        seller_sku,
        asin,
        fnsku,
        match_source,
        source_report_type,
        external_listing_id,
        is_primary,
        first_seen_at,
        last_seen_at,
        created_at,
        updated_at
      )
      SELECT
        c.organization_id,
        c.store_id,
        c.id,
        c.sku,
        c.asin,
        c.fnsku,
        $2,
        $2,
        $3 || c.id::text,
        true,
        now(),
        now(),
        now(),
        now()
      FROM _v190b_candidates c
      INNER JOIN picked p ON p.id = c.id
      RETURNING product_identifier_map.id, product_identifier_map.product_id
    ),
    done AS (
      DELETE FROM _v190b_candidates t
      USING ins
      WHERE t.id = ins.product_id
      RETURNING ins.id::text AS map_id, ins.product_id::text AS product_id
    )
    SELECT map_id, product_id FROM done
  `;
  const r = await client.query(q, [batchLimit, MATCH_SOURCE, EXTERNAL_PREFIX]);
  const rows = r.rows as { map_id: string; product_id: string }[];
  return { inserted: rows.length, rows };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const execute = process.argv.includes("--execute");
  const runAll = process.argv.includes("--all");
  const batchLimit = limitArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = refFromSupabaseUrl(process.env.STAGING_SUPABASE_URL?.trim() || "") || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  if (execute) {
    await client.query(`SET statement_timeout = '600s'`);
  }

  const countsBefore = await dryRunCounts(client);
  const spineBefore = await spineSnapshot(client);

  if (!execute) {
    const noMapTotal = Object.values(countsBefore).reduce((a, b) => a + b, 0);
    const manifest = {
      prompt: "PRODUCT-CATALOG-WAVE-B1-MAP-BRIDGE-FROM-PRODUCTS-V190B",
      run_id: runId,
      staging_ref: STAGING_REF,
      mode: "dry_run_only",
      plan_run_id: PLAN_RUN,
      products_without_map_total: noMapTotal,
      classification_counts: countsBefore,
      insert_candidates: countsBefore.insert_candidate ?? 0,
    };
    fs.writeFileSync(path.join(outDir, "classification-counts.json"), JSON.stringify(countsBefore, null, 2));
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    await client.end();
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const approval = readApproval();
  if (!approval.staging || !approval.insert) {
    throw new Error(
      `Set APPROVED_TO_RUN_STAGING=true and APPROVED_TO_INSERT_MAP_ROWS=true in ${APPROVAL_PATH}`,
    );
  }

  const insertedAll: { map_id: string; product_id: string }[] = [];
  const batchLog: { batch: number; inserted: number; remaining?: number }[] = [];
  let batchNum = 0;

  await client.query("BEGIN");
  try {
    const materialized = await materializeCandidates(client);
    fs.writeFileSync(
      path.join(outDir, "materialized-candidates.json"),
      JSON.stringify({ count: materialized, at: new Date().toISOString() }, null, 2),
    );

    do {
      batchNum += 1;
      const { inserted, rows } = await insertBatch(client, batchLimit);
      insertedAll.push(...rows);
      const remaining = await remainingCandidates(client);
      batchLog.push({ batch: batchNum, inserted, remaining });
      if (inserted === 0) break;
      if (!runAll) break;
    } while (batchLog[batchLog.length - 1]!.remaining! > 0);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  const countsAfter = await dryRunCounts(client);
  const spineAfter = await spineSnapshot(client);

  const manifest = {
    prompt: "PRODUCT-CATALOG-WAVE-B1-MAP-BRIDGE-EXECUTE-V190B",
    run_id: runId,
    plan_run_id: PLAN_RUN,
    staging_ref: STAGING_REF,
    mode: runAll ? "execute_all_batches" : "execute_single_batch",
    batch_limit: batchLimit,
    batches: batchLog,
    map_rows_inserted: insertedAll.length,
    classification_counts_before: countsBefore,
    classification_counts_after: countsAfter,
    spine_before: spineBefore,
    spine_after: spineAfter,
    match_source: MATCH_SOURCE,
    status: insertedAll.length > 0 ? "PASS" : "PARTIAL",
  };

  fs.writeFileSync(path.join(outDir, "batch-log.json"), JSON.stringify(batchLog, null, 2));
  fs.writeFileSync(
    path.join(outDir, "inserted-rows.json"),
    JSON.stringify(insertedAll.slice(0, 5000), null, 2),
  );
  if (insertedAll.length > 5000) {
    fs.writeFileSync(
      path.join(outDir, "inserted-row-count-note.txt"),
      `Full insert count ${insertedAll.length}; JSON truncated to 5000 rows.`,
    );
  }
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# V190B map bridge execute",
      "",
      `- run_id: \`${runId}\``,
      `- plan dry-run: \`${PLAN_RUN}\``,
      `- map rows inserted: **${insertedAll.length}**`,
      `- batches: ${batchLog.length}`,
      `- products without map: ${spineBefore.products_without_map} → ${spineAfter.products_without_map}`,
      `- map rows (product_bridge_v190b): ${spineBefore.map_rows_product_bridge_v190b} → ${spineAfter.map_rows_product_bridge_v190b}`,
      `- insert candidates remaining: ${countsAfter.insert_candidate ?? 0}`,
      "",
      "No `products` rows created. No `return_items` resolver run.",
    ].join("\n"),
    "utf8",
  );

  await client.end();
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
