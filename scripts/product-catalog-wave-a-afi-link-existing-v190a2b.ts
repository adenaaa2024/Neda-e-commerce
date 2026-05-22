/**
 * PRODUCT-CATALOG-WAVE-A-AFI-LINK-EXISTING-EXECUTE-V190A2B
 *
 *   npx tsx scripts/product-catalog-wave-a-afi-link-existing-v190a2b.ts --run-id=<id>
 *   npx tsx scripts/product-catalog-wave-a-afi-link-existing-v190a2b.ts --run-id=<id> --execute [--limit=500] [--all]
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
const TABLE = "amazon_amazon_fulfilled_inventory";
const OUT_BASE = ".cursor/audit-reports/product-catalog-wave-a-afi-link-existing-v190a2b";
const APPROVAL_PATH = ".cursor/operator-approvals/product-catalog-wave-a-afi-link-existing-v190a2-approval.md";
const LINK_CANDIDATES_SQL = `
  WITH u AS (
    SELECT
      t.id,
      t.organization_id,
      t.store_id,
      NULLIF(TRIM(t.fulfillment_channel_sku), '') AS fnsku,
      NULLIF(TRIM(t.seller_sku), '') AS sku,
      NULLIF(TRIM(t.asin), '') AS asin
    FROM public.amazon_amazon_fulfilled_inventory t
    WHERE t.resolved_product_id IS NULL
      AND t.store_id IS NOT NULL
      AND t.organization_id IS NOT NULL
  ),
  fnsku_hit AS (
    SELECT u.id AS afi_id, MIN(p.id::text)::uuid AS product_id
    FROM u
    JOIN public.products p
      ON p.organization_id = u.organization_id AND p.store_id = u.store_id
     AND u.fnsku IS NOT NULL AND NULLIF(TRIM(p.fnsku), '') = u.fnsku
    GROUP BY u.id
    HAVING COUNT(DISTINCT p.id) = 1
  ),
  sku_asin_hit AS (
    SELECT u.id AS afi_id, MIN(p.id::text)::uuid AS product_id
    FROM u
    JOIN public.products p
      ON p.organization_id = u.organization_id AND p.store_id = u.store_id
     AND u.sku IS NOT NULL AND u.asin IS NOT NULL
     AND NULLIF(TRIM(p.sku), '') = u.sku AND NULLIF(TRIM(p.asin), '') = u.asin
    GROUP BY u.id
    HAVING COUNT(DISTINCT p.id) = 1
  ),
  asin_hit AS (
    SELECT u.id AS afi_id, MIN(p.id::text)::uuid AS product_id
    FROM u
    JOIN public.products p
      ON p.organization_id = u.organization_id AND p.store_id = u.store_id
     AND u.asin IS NOT NULL AND NULLIF(TRIM(p.asin), '') = u.asin
    GROUP BY u.id
    HAVING COUNT(DISTINCT p.id) = 1
  ),
  picks AS (
    SELECT
      u.id AS afi_id,
      u.organization_id,
      u.store_id,
      COALESCE(f.product_id, s.product_id, a.product_id) AS product_id,
      CASE
        WHEN f.product_id IS NOT NULL THEN 'fnsku'
        WHEN s.product_id IS NOT NULL THEN 'sku_asin'
        WHEN a.product_id IS NOT NULL THEN 'asin'
      END AS win_tier
    FROM u
    LEFT JOIN fnsku_hit f ON f.afi_id = u.id
    LEFT JOIN sku_asin_hit s ON s.afi_id = u.id AND f.product_id IS NULL
    LEFT JOIN asin_hit a ON a.afi_id = u.id AND f.product_id IS NULL AND s.product_id IS NULL
    WHERE COALESCE(f.product_id, s.product_id, a.product_id) IS NOT NULL
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
  return 500;
}

function readApproval(): boolean {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_LINK_EXISTING_PRODUCT_ONLY\s*=\s*true/i.test(text)
  );
}

async function probeAfi(client: pg.Client) {
  const r = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
    FROM public.amazon_amazon_fulfilled_inventory
  `);
  return r.rows[0] as { total: number; resolved: number; unresolved: number };
}

async function materializeCandidates(client: pg.Client): Promise<number> {
  await client.query(`DROP TABLE IF EXISTS _v190a2b_link_candidates`);
  await client.query(`
    CREATE TEMP TABLE _v190a2b_link_candidates (
      afi_id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      store_id uuid NOT NULL,
      product_id uuid NOT NULL,
      win_tier text NOT NULL
    ) ON COMMIT PRESERVE ROWS
  `);
  const ins = await client.query(`
    ${LINK_CANDIDATES_SQL}
    INSERT INTO _v190a2b_link_candidates (afi_id, organization_id, store_id, product_id, win_tier)
    SELECT afi_id, organization_id, store_id, product_id, win_tier FROM picks
  `);
  return ins.rowCount ?? 0;
}

async function remainingCandidates(client: pg.Client): Promise<number> {
  const r = await client.query(`SELECT COUNT(*)::int AS n FROM _v190a2b_link_candidates`);
  return Number(r.rows[0]?.n ?? 0);
}

async function linkBatch(
  client: pg.Client,
  batchLimit: number,
): Promise<{ linked: number; rows: { afi_id: string; product_id: string; win_tier: string }[] }> {
  const r = await client.query(
    `
    WITH batch AS (
      SELECT afi_id, product_id, win_tier
      FROM _v190a2b_link_candidates
      ORDER BY afi_id
      LIMIT $1
    ),
    map_pick AS (
      SELECT DISTINCT ON (m.product_id)
        m.product_id,
        m.catalog_product_id
      FROM public.product_identifier_map m
      WHERE m.product_id IN (SELECT product_id FROM batch)
      ORDER BY m.product_id, m.is_primary DESC NULLS LAST, m.last_seen_at DESC NULLS LAST
    ),
    upd AS (
      UPDATE public.amazon_amazon_fulfilled_inventory t
      SET
        resolved_product_id = b.product_id,
        resolved_catalog_product_id = mp.catalog_product_id,
        identifier_resolution_status = 'resolved',
        identifier_resolution_confidence = 1,
        updated_at = now()
      FROM batch b
      LEFT JOIN map_pick mp ON mp.product_id = b.product_id
      WHERE t.id = b.afi_id
        AND t.resolved_product_id IS NULL
      RETURNING t.id::text AS afi_id, b.product_id::text AS product_id, b.win_tier
    ),
    del AS (
      DELETE FROM _v190a2b_link_candidates c
      USING upd u
      WHERE c.afi_id = u.afi_id::uuid
      RETURNING u.afi_id, u.product_id, u.win_tier
    )
    SELECT afi_id, product_id, win_tier FROM del
  `,
    [batchLimit],
  );
  const rows = r.rows as { afi_id: string; product_id: string; win_tier: string }[];
  return { linked: rows.length, rows };
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
  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SET statement_timeout = '600s'`);

  const before = await probeAfi(client);
  const candidateCount = await materializeCandidates(client);
  const remaining = await remainingCandidates(client);

  const tierBreakdown = await client.query(`
    SELECT win_tier, COUNT(*)::int AS n FROM _v190a2b_link_candidates GROUP BY win_tier ORDER BY n DESC
  `);

  if (!execute) {
    const manifest = {
      prompt: "PRODUCT-CATALOG-WAVE-A-AFI-LINK-EXISTING-EXECUTE-V190A2B",
      run_id: runId,
      mode: "dry_run",
      link_candidates: candidateCount,
      tier_breakdown: tierBreakdown.rows,
      afi_before: before,
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    await client.end();
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  if (!readApproval()) {
    throw new Error(`Set approval flags in ${APPROVAL_PATH}`);
  }

  const linkedAll: { afi_id: string; product_id: string; win_tier: string }[] = [];
  const batchLog: { batch: number; linked: number; remaining: number }[] = [];
  let batchNum = 0;

  await client.query("BEGIN");
  try {
    do {
      batchNum += 1;
      const { linked, rows } = await linkBatch(client, batchLimit);
      linkedAll.push(...rows);
      const rem = await remainingCandidates(client);
      batchLog.push({ batch: batchNum, linked, remaining: rem });
      if (linked === 0) break;
      if (!runAll) break;
    } while (batchLog[batchLog.length - 1]!.remaining > 0);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  const after = await probeAfi(client);
  await client.end();

  const manifest = {
    prompt: "PRODUCT-CATALOG-WAVE-A-AFI-LINK-EXISTING-EXECUTE-V190A2B",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: runAll ? "execute_all_batches" : "execute_single_batch",
    batch_limit: batchLimit,
    link_candidates_materialized: candidateCount,
    afi_rows_linked: linkedAll.length,
    map_rows_inserted: 0,
    map_insert_policy: "skipped_v190a2b_use_existing_map_only",
    batches: batchLog,
    tier_breakdown: tierBreakdown.rows,
    afi_before: before,
    afi_after: after,
    status: "PASS",
  };

  fs.writeFileSync(path.join(outDir, "batch-log.json"), JSON.stringify(batchLog, null, 2));
  fs.writeFileSync(
    path.join(outDir, "linked-rows.json"),
    JSON.stringify(linkedAll.slice(0, 5000), null, 2),
  );
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# V190A2B link existing product",
      "",
      `- Candidates: **${candidateCount}**`,
      `- AFI rows linked: **${linkedAll.length}**`,
      "- Map bridge: not inserted (link uses existing `product_identifier_map` when present)",
      `- Unresolved: ${before.unresolved} → **${after.unresolved}**`,
      `- Resolved: ${before.resolved} → **${after.resolved}**`,
      "",
      "No new `products` created.",
    ].join("\n"),
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
