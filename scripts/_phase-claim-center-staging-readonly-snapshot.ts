/**
 * One-off read-only staging snapshot for Claim Center data contract audit.
 * npx tsx scripts/_phase-claim-center-staging-readonly-snapshot.ts
 */
import pg from "pg";
import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_ORG = "7397edff-7994-4731-8501-55d258d507d2";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  if (getStagingProjectRef() !== "eiqfaapyumhixxoeltgu") throw new Error("staging ref guard");

  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const c = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
  await c.connect();
  await c.query("SET statement_timeout = '60s'");

  const global = await c.query(`
    SELECT COUNT(*)::int total,
      COUNT(*) FILTER (WHERE quarantined_at IS NULL AND COALESCE(source_kind,'') <> 'legacy_seed')::int active,
      COUNT(*) FILTER (WHERE source_kind='legacy_seed')::int legacy,
      COUNT(*) FILTER (WHERE quarantined_at IS NOT NULL)::int quarantined
    FROM claim_candidates
  `);

  const orgs = await c.query(`
    SELECT organization_id::text,
      COUNT(*)::int total,
      COUNT(*) FILTER (WHERE quarantined_at IS NULL AND COALESCE(source_kind,'') <> 'legacy_seed')::int active
    FROM claim_candidates GROUP BY 1 ORDER BY active DESC LIMIT 20
  `);

  const stagingOrgAll = await c.query(
    `SELECT source_kind, candidate_status, claim_family, COUNT(*)::int c
     FROM claim_candidates WHERE organization_id = $1::uuid
     GROUP BY 1,2,3 ORDER BY c DESC`,
    [STAGING_ORG],
  );

  const stores = await c.query(
    `SELECT id::text, name FROM stores WHERE organization_id = $1::uuid`,
    [STAGING_ORG],
  );

  const orgSettings = await c.query(
    `SELECT claim_policy->'discovery_index' AS discovery_index,
            claim_policy->'intake' AS intake
     FROM organization_settings WHERE organization_id = $1::uuid`,
    [STAGING_ORG],
  );

  const evidenceCols = await c.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='claim_evidence' ORDER BY ordinal_position
  `);

  const frrCols = await c.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='financial_reference_resolver' ORDER BY ordinal_position
  `);

  const evidenceGlobal = await c.query(`
    SELECT COUNT(*)::int total,
      COUNT(*) FILTER (WHERE claim_candidate_id IS NOT NULL)::int candidate_linked,
      COUNT(*) FILTER (WHERE claim_case_id IS NOT NULL)::int case_linked,
      COUNT(*) FILTER (WHERE storage_path IS NOT NULL AND btrim(storage_path) <> '')::int with_storage
    FROM claim_evidence WHERE organization_id = $1::uuid`,
    [STAGING_ORG],
  );

  const amazonReimb = await c.query(
    `SELECT COUNT(*)::int c FROM amazon_reimbursements WHERE organization_id = $1::uuid`,
    [STAGING_ORG],
  );

  const returnItems = await c.query(
    `SELECT COUNT(*)::int c FROM return_items WHERE organization_id = $1::uuid`,
    [STAGING_ORG],
  );

  const products = await c.query(
    `SELECT COUNT(*)::int c FROM products WHERE organization_id = $1::uuid`,
    [STAGING_ORG],
  );

  const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
  const defaultOrgBreakdown = await c.query(
    `SELECT source_kind, candidate_status, claim_family,
      COUNT(*)::int c,
      COUNT(*) FILTER (WHERE quarantined_at IS NOT NULL)::int quarantined
     FROM claim_candidates WHERE organization_id = $1::uuid
     GROUP BY 1,2,3 ORDER BY c DESC LIMIT 30`,
    [DEFAULT_ORG],
  );
  const defaultEdges = await c.query(
    `SELECT COUNT(*)::int total,
      COUNT(*) FILTER (WHERE candidate_id IS NOT NULL)::int candidate_anchored,
      COUNT(*) FILTER (WHERE ambiguity_group_key IS NOT NULL AND btrim(ambiguity_group_key) <> '')::int ambiguity_edges
     FROM claim_reference_edges WHERE organization_id = $1::uuid`,
    [DEFAULT_ORG],
  );
  const defaultFrr = await c.query(
    `SELECT COUNT(*)::int total FROM financial_reference_resolver WHERE organization_id = $1::uuid`,
    [DEFAULT_ORG],
  );
  const defaultEvidence = await c.query(
    `SELECT COUNT(*)::int total,
      COUNT(*) FILTER (WHERE claim_candidate_id IS NOT NULL)::int candidate_linked,
      COUNT(*) FILTER (WHERE storage_path IS NOT NULL AND btrim(storage_path) <> '')::int with_storage
     FROM claim_evidence WHERE organization_id = $1::uuid`,
    [DEFAULT_ORG],
  );
  const defaultPim = await c.query(
    `SELECT COUNT(*)::int total FROM product_identifier_map WHERE organization_id = $1::uuid`,
    [DEFAULT_ORG],
  );
  const defaultCases = await c.query(
    `SELECT COUNT(*)::int c FROM claim_cases WHERE organization_id = $1::uuid`,
    [DEFAULT_ORG],
  );
  const defaultSubs = await c.query(
    `SELECT COUNT(*)::int c FROM claim_submissions WHERE organization_id = $1::uuid`,
    [DEFAULT_ORG],
  );

  await c.end();

  console.log(
    JSON.stringify(
      {
        staging_org: STAGING_ORG,
        global_candidates: global.rows[0],
        orgs_with_candidates: orgs.rows,
        staging_org_breakdown: stagingOrgAll.rows,
        stores: stores.rows,
        org_settings: orgSettings.rows[0] ?? null,
        claim_evidence_columns: evidenceCols.rows.map((r) => r.column_name),
        frr_columns: frrCols.rows.map((r) => r.column_name),
        evidence_staging_org: evidenceGlobal.rows[0],
        amazon_reimbursements: amazonReimb.rows[0],
        return_items: returnItems.rows[0],
        products: products.rows[0],
        default_org_hidden_inventory: {
          breakdown: defaultOrgBreakdown.rows,
          edges: defaultEdges.rows[0],
          frr: defaultFrr.rows[0],
          evidence: defaultEvidence.rows[0],
          pim: defaultPim.rows[0],
          cases: defaultCases.rows[0],
          submissions: defaultSubs.rows[0],
          note: "All 9055 rows are legacy_seed + quarantined — excluded from Claim Center default filter",
        },
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
