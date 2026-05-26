/**
 * PC02 — SP-API ENV + PRODUCT ENRICHMENT EVIDENCE DRY-RUN PLAN
 *
 * Read-only: no Amazon HTTP, no DB writes, no secrets in output.
 *
 *   npx tsx scripts/pc02-sp-api-env-evidence-dry-run-plan.ts --run-id=<UTC_Z>
 */

import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { amazonSpCredentialsLookComplete } from "../lib/amazon-marketplace-credentials";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/pc02-sp-api-env-evidence-dry-run-plan";
const PC02_APPROVAL = ".cursor/operator-approvals/sp-api-product-evidence-dry-run-pc02-approval.md";
const V194_API_APPROVAL =
  ".cursor/operator-approvals/expected-packages-amazon-api-enrichment-v194-approval.md";

const ENV_FLAGS = [
  "AMAZON_SP_API_ENABLED",
  "PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED",
  "NEXT_PUBLIC_SUPABASE_URL",
  "STAGING_PROJECT_REF",
  "PRODUCTION_SUPABASE_URL",
  "PRODUCTION_PROJECT_REF",
] as const;

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function envPresent(name: string): boolean {
  return (process.env[name]?.trim() ?? "") !== "";
}

function readApproval(file: string, flags: string[]): { approved: boolean; detail: string } {
  const p = path.join(process.cwd(), file);
  if (!fs.existsSync(p)) return { approved: false, detail: "file_missing" };
  const text = fs.readFileSync(p, "utf8");
  const ok = flags.every((f) => new RegExp(`${f}\\s*=\\s*true`, "i").test(text));
  return { approved: ok, detail: ok ? "all_flags_true" : "not_approved" };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, id);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const stagingOk = supabaseUrlMatchesStagingRef(stagingUrl, STAGING_REF);
  const spApiEnabled = envFlag("AMAZON_SP_API_ENABLED");
  const autoCreateEnabledConfig = envFlag("PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED");
  const pc02Approval = readApproval(PC02_APPROVAL, [
    "APPROVED_TO_RUN_STAGING",
    "APPROVED_SP_API_EVIDENCE_DRY_RUN",
  ]);
  const v194Approval = readApproval(V194_API_APPROVAL, [
    "APPROVED_TO_RUN_STAGING",
    "APPROVED_EXPECTED_PACKAGES_AMAZON_API_ENRICHMENT_V194",
  ]);

  const envSnapshot: Record<string, string | boolean> = {};
  for (const name of ENV_FLAGS) {
    if (name.includes("KEY") || name.includes("SECRET") || name.includes("TOKEN")) {
      envSnapshot[name] = envPresent(name);
    } else if (name === "NEXT_PUBLIC_SUPABASE_URL") {
      envSnapshot[name] = refFromSupabaseUrl(process.env[name] ?? "") ?? "(unset)";
    } else {
      const v = process.env[name]?.trim() ?? "";
      envSnapshot[name] = v === "" ? "(blank)" : v;
    }
  }
  envSnapshot.AMAZON_SP_API_ENABLED_bool = spApiEnabled;
  envSnapshot.PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED_bool = autoCreateEnabledConfig;

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (!dbUrl || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error("Staging ref guard failed");
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SET statement_timeout = '120s'`);

  const coverage = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id, NULLIF(TRIM(e.sku), '') AS sku,
        NULLIF(TRIM(e.fnsku), '') AS fnsku, e.resolved_product_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ep JOIN public.product_identifier_map m
        ON m.organization_id=ep.organization_id AND m.store_id=ep.store_id AND m.deleted_at IS NULL
        AND ep.fnsku IS NOT NULL AND m.fnsku=ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ep JOIN public.product_identifier_map m
        ON m.organization_id=ep.organization_id AND m.store_id=ep.store_id AND m.deleted_at IS NULL
        AND ep.sku IS NOT NULL AND (m.seller_sku=ep.sku OR m.msku=ep.sku)
      GROUP BY ep.id
    ),
    classified AS (
      SELECT ep.id,
        CASE
          WHEN ep.resolved_product_id IS NOT NULL THEN 'resolved'
          WHEN COALESCE(mf.c,0)=1 OR COALESCE(ms.c,0)=1 THEN 'read_layer'
          WHEN COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS bucket
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id=ep.id
      LEFT JOIN map_sku ms ON ms.id=ep.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket IN ('resolved','read_layer'))::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved,
      COUNT(*) FILTER (WHERE bucket='ambiguous')::int AS ambiguous
    FROM classified
  `);

  const apiCohort = await client.query(
    `
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku),'') AS sku, NULLIF(TRIM(e.fnsku),'') AS fnsku,
        e.resolved_product_id,
        NULLIF(TRIM(COALESCE(ar.raw_data->>'asin', ar.raw_data->>'ASIN')), '') AS detail_asin
      FROM public.expected_packages e
      LEFT JOIN public.amazon_removals ar ON ar.id = e.source_detail_row_id AND ar.organization_id = e.organization_id
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id)::int AS c FROM ep
      LEFT JOIN public.product_identifier_map m ON m.organization_id=ep.organization_id AND m.store_id=ep.store_id
        AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku=ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id)::int AS c FROM ep
      LEFT JOIN public.product_identifier_map m ON m.organization_id=ep.organization_id AND m.store_id=ep.store_id
        AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku=ep.sku OR m.msku=ep.sku)
      GROUP BY ep.id
    ),
    unresolved AS (
      SELECT ep.* FROM ep
      LEFT JOIN map_fnsku mf ON mf.id=ep.id LEFT JOIN map_sku ms ON ms.id=ep.id
      WHERE ep.resolved_product_id IS NULL
        AND COALESCE(mf.c,0)<=1 AND COALESCE(ms.c,0)<=1
        AND NOT (COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1)
        AND ep.store_id IS NOT NULL
    )
    SELECT u.id::text AS expected_package_id, u.organization_id::text, u.store_id::text,
      u.sku, u.fnsku, u.detail_asin AS asin
    FROM unresolved u
    WHERE u.detail_asin IS NOT NULL AND u.detail_asin ~ '^B[0-9A-Z]{9}$'
    ORDER BY u.id
    LIMIT 12
  `,
  );

  const afiUnresolved = await client.query(`
    SELECT COUNT(*)::int AS n FROM public.amazon_amazon_fulfilled_inventory
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
      AND resolved_product_id IS NULL
  `, [ORG, STORE]);

  const mpRows = await client.query(
    `SELECT id::text, provider, credentials IS NOT NULL AS has_credentials_json
     FROM public.marketplaces WHERE organization_id = $1::uuid AND provider = 'amazon_sp_api'`,
    [ORG],
  );
  const orgKey = await client.query(
    `SELECT (api_key IS NOT NULL AND length(trim(api_key)) > 2) AS has_org_api_key
     FROM public.organization_api_keys WHERE organization_id = $1::uuid AND name = 'amazon_sp_api' LIMIT 1`,
    [ORG],
  );

  let credentialsCompleteForSamStore = false;
  const credChecks: { source: string; complete: boolean }[] = [];
  for (const row of mpRows.rows as { id: string; provider: string; has_credentials_json: boolean }[]) {
    const full = await client.query(`SELECT credentials FROM public.marketplaces WHERE id = $1::uuid`, [row.id]);
    const cred = (full.rows[0] as { credentials?: unknown })?.credentials;
    const complete = amazonSpCredentialsLookComplete(cred);
    credChecks.push({ source: `marketplaces:${row.id}`, complete });
    if (complete) credentialsCompleteForSamStore = true;
  }
  if (orgKey.rows[0]?.has_org_api_key) {
    const keyRow = await client.query(
      `SELECT api_key FROM public.organization_api_keys WHERE organization_id = $1::uuid AND name = 'amazon_sp_api' LIMIT 1`,
      [ORG],
    );
    let complete = false;
    try {
      const parsed = JSON.parse(String((keyRow.rows[0] as { api_key?: string })?.api_key ?? "{}"));
      complete = amazonSpCredentialsLookComplete(parsed);
    } catch {
      complete = false;
    }
    credChecks.push({ source: "organization_api_keys:amazon_sp_api", complete });
    if (complete) credentialsCompleteForSamStore = true;
  }

  await client.end();

  const cohort = apiCohort.rows as Record<string, unknown>[];
  const distinctAsins = [...new Set(cohort.map((r) => String(r.asin ?? "").toUpperCase()))];

  const gatesReady =
    stagingOk &&
    spApiEnabled &&
    autoCreateEnabledConfig &&
    credentialsCompleteForSamStore &&
    pc02Approval.approved;

  const blockers: string[] = [];
  if (!stagingOk) blockers.push("NEXT_PUBLIC_SUPABASE_URL must point to staging ref");
  if (!spApiEnabled) blockers.push("AMAZON_SP_API_ENABLED is not true");
  if (!autoCreateEnabledConfig) blockers.push("PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED is not true");
  if (!credentialsCompleteForSamStore) blockers.push("Amazon LWA credentials incomplete for Sam org (marketplaces or organization_api_keys)");
  if (!pc02Approval.approved) blockers.push(`PC02 approval: ${pc02Approval.detail}`);
  if (!v194Approval.approved) blockers.push(`V194 expected-packages API approval: ${v194Approval.detail} (required for V202 execute path)`);

  const payload = {
    run_id: id,
    prompt: "PC02-SP-API-ENV-EVIDENCE-DRY-RUN-PLAN",
    api_gates_ready: gatesReady,
    env_flags: { spApiEnabled, autoCreateEnabledConfig, stagingOk },
    credentials_complete_sam_org: credentialsCompleteForSamStore,
    pc02_approval: pc02Approval,
    v194_approval: v194Approval,
    expected_packages_coverage: coverage.rows[0],
    cohort: { source: "expected_packages_unresolved_with_asin", row_count: cohort.length, distinct_asins: distinctAsins.length },
    afi_unresolved_sam_store: afiUnresolved.rows[0]?.n ?? null,
    amazon_api_called: false,
  };

  fs.writeFileSync(path.join(outDir, "cohort-candidates.json"), JSON.stringify({ rows: cohort, distinct_asins: distinctAsins }, null, 2));
  fs.writeFileSync(path.join(outDir, "env-snapshot.json"), JSON.stringify(envSnapshot, null, 2));
  fs.writeFileSync(path.join(outDir, "credential-presence.json"), JSON.stringify(credChecks, null, 2));
  fs.writeFileSync(path.join(outDir, "matrix.json"), JSON.stringify(payload, null, 2));

  console.log(JSON.stringify({ outDir, ...payload }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
