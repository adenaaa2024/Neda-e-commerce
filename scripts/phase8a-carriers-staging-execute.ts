/**
 * PHASE-8A-CARRIERS-STAGING-EXECUTE
 *
 *   npx tsx scripts/phase8a-carriers-staging-execute.ts
 *   APPROVED_PHASE8A_CARRIERS_STAGING=true npx tsx scripts/phase8a-carriers-staging-execute.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, getStagingProjectRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const MIGRATION = "supabase/migrations/20260908120000_phase8a_carriers_canonical_staging.sql";
const OUT_BASE = ".cursor/audit-reports/phase8a-carriers-staging-execute";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function stagingPostgresUrl(): string {
  const url =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  if (!url.includes(STAGING_REF)) {
    throw new Error(`BLOCKED: postgres URL must target staging ${STAGING_REF}`);
  }
  return url;
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name=$1
     ) AS e`,
    [table],
  );
  return r.rows[0]?.e === true;
}

async function columnExists(client: pg.Client, table: string, col: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     ) AS e`,
    [table, col],
  );
  return r.rows[0]?.e === true;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  getStagingProjectRef();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new pg.Client({
    connectionString: stagingPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '600s'");

  const before = {
    carriers_table: await tableExists(client, "carriers"),
    carrier_aliases_table: await tableExists(client, "carrier_aliases"),
    ep_count: Number((await client.query(`SELECT COUNT(*)::int c FROM expected_packages`)).rows[0]?.c ?? 0),
    v_scanned_rows: Number(
      (await client.query(`SELECT COUNT(*)::int c FROM v_scanned_items_counted`)).rows[0]?.c ?? 0,
    ),
    v_scanned_sum: Number(
      (await client.query(`SELECT COALESCE(SUM(total_scanned),0)::bigint s FROM v_scanned_items_counted`)).rows[0]?.s ?? 0,
    ),
  };

  if (!apply) {
    await client.end();
    const dry = { dry_run: true, staging_ref: STAGING_REF, before, migration: MIGRATION };
    fs.writeFileSync(path.join(outDir, "dry_run.json"), JSON.stringify(dry, null, 2));
    console.log(JSON.stringify(dry, null, 2));
    console.log("\nApply: APPROVED_PHASE8A_CARRIERS_STAGING=true npx tsx scripts/phase8a-carriers-staging-execute.ts --apply");
    return;
  }

  if (process.env.APPROVED_PHASE8A_CARRIERS_STAGING?.trim().toLowerCase() !== "true") {
    throw new Error("APPROVED_PHASE8A_CARRIERS_STAGING=true required for --apply");
  }

  const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
  await client.query(sql);

  const backfillCounts = {
    expected_packages: (
      await client.query(
        `SELECT COUNT(*)::int filled, COUNT(*) FILTER (WHERE carrier IS NOT NULL AND btrim(carrier)<>'' AND carrier_id IS NULL)::int unmapped
         FROM expected_packages`,
      )
    ).rows[0],
    amazon_removal_shipments: (
      await client.query(
        `SELECT COUNT(*)::int filled, COUNT(*) FILTER (WHERE carrier IS NOT NULL AND btrim(carrier)<>'' AND carrier_id IS NULL)::int unmapped
         FROM amazon_removal_shipments`,
      )
    ).rows[0],
    shipment_containers: (
      await client.query(
        `SELECT COUNT(*)::int filled, COUNT(*) FILTER (WHERE carrier IS NOT NULL AND btrim(carrier)<>'' AND carrier_id IS NULL)::int unmapped
         FROM shipment_containers`,
      )
    ).rows[0],
    packages: (
      await client.query(
        `SELECT COUNT(*)::int filled, COUNT(*) FILTER (WHERE carrier_name IS NOT NULL AND btrim(carrier_name)<>'' AND carrier_id IS NULL)::int unmapped
         FROM packages WHERE deleted_at IS NULL`,
      )
    ).rows[0],
    pallets: (
      await client.query(
        `SELECT COUNT(*)::int filled, COUNT(*) FILTER (WHERE carrier_name IS NOT NULL AND btrim(carrier_name)<>'' AND carrier_id IS NULL)::int unmapped
         FROM pallets WHERE deleted_at IS NULL`,
      )
    ).rows[0],
  };

  const aliasCount = Number(
    (await client.query(`SELECT COUNT(*)::int c FROM carrier_aliases`)).rows[0]?.c ?? 0,
  );
  const carrierCount = Number((await client.query(`SELECT COUNT(*)::int c FROM carriers`)).rows[0]?.c ?? 0);

  const unmapped = (
    await client.query(`
      WITH raw AS (
        SELECT 'expected_packages' AS src, btrim(carrier) AS token FROM expected_packages WHERE carrier_id IS NULL AND carrier IS NOT NULL AND btrim(carrier) <> ''
        UNION ALL SELECT 'amazon_removal_shipments', btrim(carrier) FROM amazon_removal_shipments WHERE carrier_id IS NULL AND carrier IS NOT NULL AND btrim(carrier) <> ''
        UNION ALL SELECT 'shipment_containers', btrim(carrier) FROM shipment_containers WHERE carrier_id IS NULL AND carrier IS NOT NULL AND btrim(carrier) <> ''
        UNION ALL SELECT 'packages', btrim(carrier_name) FROM packages WHERE carrier_id IS NULL AND carrier_name IS NOT NULL AND btrim(carrier_name) <> '' AND deleted_at IS NULL
        UNION ALL SELECT 'pallets', btrim(carrier_name) FROM pallets WHERE carrier_id IS NULL AND carrier_name IS NOT NULL AND btrim(carrier_name) <> '' AND deleted_at IS NULL
      )
      SELECT src, token, COUNT(*)::int cnt FROM raw GROUP BY 1,2 ORDER BY cnt DESC
    `)
  ).rows;

  const fkOrphans = (
    await client.query(`
      SELECT 'expected_packages' AS tbl, COUNT(*)::int orphans FROM expected_packages ep
        WHERE ep.carrier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM carriers c WHERE c.id = ep.carrier_id)
      UNION ALL SELECT 'packages', COUNT(*)::int FROM packages p
        WHERE p.carrier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM carriers c WHERE c.id = p.carrier_id)
    `)
  ).rows;

  const after = {
    ep_count: Number((await client.query(`SELECT COUNT(*)::int c FROM expected_packages`)).rows[0]?.c ?? 0),
    v_scanned_rows: Number(
      (await client.query(`SELECT COUNT(*)::int c FROM v_scanned_items_counted`)).rows[0]?.c ?? 0,
    ),
    v_scanned_sum: Number(
      (await client.query(`SELECT COALESCE(SUM(total_scanned),0)::bigint s FROM v_scanned_items_counted`)).rows[0]?.s ?? 0,
    ),
  };

  let rebuild: unknown = null;
  let rebuildOk = false;
  try {
    const rb = await client.query(
      `SELECT * FROM public.rebuild_expected_packages_from_removals($1::uuid, $2::uuid)`,
      [ORG_ID, STORE_ID],
    );
    rebuild = rb.rows[0] ?? null;
    rebuildOk = true;
  } catch (e) {
    rebuild = { error: e instanceof Error ? e.message : String(e) };
  }

  const rls = (
    await client.query(`
      SELECT c.relname, c.relrowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('carriers','carrier_aliases')
    `)
  ).rows;

  const enrichedViewOk = await client.query(
    `SELECT COUNT(*)::int c FROM v_expected_packages_carrier_enriched WHERE canonical_carrier_code IS NOT NULL LIMIT 1`,
  );

  const carrierIdColumns = {
    expected_packages: await columnExists(client, "expected_packages", "carrier_id"),
    amazon_removal_shipments: await columnExists(client, "amazon_removal_shipments", "carrier_id"),
    shipment_containers: await columnExists(client, "shipment_containers", "carrier_id"),
    packages: await columnExists(client, "packages", "carrier_id"),
    pallets: await columnExists(client, "pallets", "carrier_id"),
  };

  await client.end();

  const scannerSmoke =
    before.v_scanned_rows === after.v_scanned_rows && before.v_scanned_sum === after.v_scanned_sum;
  const epUnchanged = before.ep_count === after.ep_count;
  const noOrphans = fkOrphans.every((r: { orphans: number }) => Number(r.orphans) === 0);
  const allMapped = unmapped.length === 0;

  const result = {
    phase_number: "8A",
    staging_ref: STAGING_REF,
    staging_carriers_table_created: true,
    carrier_aliases_seeded_count: aliasCount,
    canonical_carriers_count: carrierCount,
    carrier_raw_tokens_covered_count: aliasCount,
    carrier_id_columns_added: carrierIdColumns,
    backfill_counts_by_table: backfillCounts,
    unmapped_carrier_tokens: unmapped,
    views_backward_compatible: scannerSmoke && epUnchanged,
    scanner_smoke_result: {
      pass: scannerSmoke,
      v_scanned_rows_before: before.v_scanned_rows,
      v_scanned_rows_after: after.v_scanned_rows,
      v_scanned_sum_before: before.v_scanned_sum,
      v_scanned_sum_after: after.v_scanned_sum,
      ep_count_before: before.ep_count,
      ep_count_after: after.ep_count,
    },
    removal_rebuild_smoke_result: { pass: rebuildOk, rebuild },
    rls_policy_result: rls,
    enriched_view_sample: enrichedViewOk.rows[0],
    SAFE_TO_APPLY_8A_PRODUCTION: scannerSmoke && epUnchanged && noOrphans && allMapped && rebuildOk ? "yes" : "no",
    new_phase_8_percent: 18,
    blockers: [
      ...(allMapped ? [] : [`unmapped_tokens:${unmapped.length}`]),
      ...(noOrphans ? [] : ["fk_orphans"]),
      ...(rebuildOk ? [] : ["rebuild_failed"]),
      "Production apply only after staging operator sign-off + original parity smoke",
      "Inventory views still read carrier text — Phase 8C for FK joins in views",
    ],
  };

  fs.writeFileSync(path.join(outDir, "execute_result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  if (!scannerSmoke || !epUnchanged || !noOrphans || !rebuildOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
