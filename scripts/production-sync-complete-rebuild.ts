/**
 * Complete expected_packages rebuild after production sync (original only).
 */
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { productionPostgresUrl, bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  queryEpAllocationMismatchBreakdown,
  rebuildValidFromBreakdown,
} from "../lib/removal/ep-allocation-mismatch-breakdown";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();
  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '1800s'");

  const before = await client.query(
    `SELECT count(*)::bigint c FROM expected_packages WHERE organization_id=$1::uuid
       AND build_source IN ('detail_shipment','detail_remainder')`,
    [ORG_ID],
  );
  const breakdownBefore = await queryEpAllocationMismatchBreakdown(client, ORG_ID, STORE_ID);

  const rebuildRes = await client.query(
    `SELECT * FROM public.rebuild_expected_packages_from_removals($1::uuid, $2::uuid)`,
    [ORG_ID, STORE_ID],
  );
  const rebuild = rebuildRes.rows[0] as Record<string, unknown>;
  const breakdownAfter = await queryEpAllocationMismatchBreakdown(client, ORG_ID, STORE_ID);

  const after = await client.query(
    `SELECT count(*)::bigint c FROM expected_packages WHERE organization_id=$1::uuid
       AND build_source IN ('detail_shipment','detail_remainder')`,
    [ORG_ID],
  );

  await client.end();

  console.log(
    JSON.stringify(
      {
        target_ref: PRODUCTION_REF,
        ep_derived_before: Number(before.rows[0]?.c),
        ep_derived_after: Number(after.rows[0]?.c),
        rebuild,
        rebuild_valid: rebuildValidFromBreakdown(breakdownAfter),
        breakdown_before: breakdownBefore,
        breakdown_after: breakdownAfter,
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
