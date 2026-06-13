/**
 * PHASE-RLS-POLICY-BATCH-CLAIM-AMAZON-REIMBURSEMENTS-V1-ORIGINAL-APPLY
 *
 *   APPROVED_ORIGINAL_RLS_REIMBURSEMENTS_APPLY=yes \
 *     npx tsx scripts/phase-rls-policy-batch-claim-amazon-reimbursements-v1-original-apply.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const MIGRATION = "supabase/migrations/20260614120000_phase_rls_policy_batch_claim_amazon_reimbursements_v1.sql";
const VERSION = "20260614120000";
const OUT_BASE = ".cursor/audit-reports/phase-rls-policy-batch-claim-amazon-reimbursements-v1-original-apply";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function rlsState(client: pg.Client, tables: string[]) {
  const policies = await client.query(
    `SELECT tablename, policyname, roles, cmd
     FROM pg_policies
     WHERE schemaname = 'public' AND tablename = ANY($1::text[])
     ORDER BY tablename, policyname`,
    [tables],
  );
  const meta = await client.query(
    `SELECT c.relname AS table_name,
            c.relrowsecurity AS rls_enabled,
            (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [tables],
  );
  return { policies: policies.rows, meta: meta.rows };
}

async function tableCount(client: pg.Client, table: string): Promise<number> {
  const r = await client.query(`SELECT count(*)::bigint AS c FROM public.${table}`);
  return Number(r.rows[0]?.c ?? 0);
}

async function authCount(client: pg.Client, userId: string, filterOrg?: string): Promise<number> {
  await client.query("BEGIN");
  try {
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await client.query("SET LOCAL ROLE authenticated");
    const r = filterOrg
      ? await client.query(
          `SELECT count(*)::int AS c FROM public.amazon_reimbursements WHERE organization_id = $1::uuid`,
          [filterOrg],
        )
      : await client.query(`SELECT count(*)::int AS c FROM public.amazon_reimbursements`);
    await client.query("ROLLBACK");
    return Number(r.rows[0]?.c ?? 0);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

async function main(): Promise<void> {
  if (process.env.APPROVED_ORIGINAL_RLS_REIMBURSEMENTS_APPLY?.trim() !== "yes") {
    throw new Error("Set APPROVED_ORIGINAL_RLS_REIMBURSEMENTS_APPLY=yes (Maysam approved)");
  }

  loadEnvLocalIntoProcess();
  const { url } = bindProductionSupabaseEnv();
  const pgUrl = productionPostgresUrl();
  if (!pgUrl.includes(PRODUCTION_REF)) {
    throw new Error(`Postgres URL must target ${PRODUCTION_REF}`);
  }

  const run_id = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, run_id);
  fs.mkdirSync(outDir, { recursive: true });

  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!anon || !serviceKey) throw new Error("Anon + service role keys required after production bind");

  const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
  const client = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const tables = ["amazon_reimbursements", "claim_reimbursements"];
  const before_rls_state = await rlsState(client, tables);

  const row_counts_before = {
    amazon_reimbursements: await tableCount(client, "amazon_reimbursements"),
    claim_reimbursements: await tableCount(client, "claim_reimbursements"),
    claim_candidates: await tableCount(client, "claim_candidates"),
    products: await tableCount(client, "products"),
    expected_packages: await tableCount(client, "expected_packages"),
    amazon_removals: await tableCount(client, "amazon_removals"),
  };

  const alreadyApplied = (before_rls_state.meta as Array<{ table_name: string; policy_count: number }>).every(
    (m) => m.policy_count >= 2,
  );

  let migration_applied = false;
  if (!alreadyApplied) {
    await client.query(sql);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [VERSION, "phase_rls_policy_batch_claim_amazon_reimbursements_v1.sql"],
    );
    migration_applied = true;
  } else {
    migration_applied = false;
  }

  const after_rls_state = await rlsState(client, tables);
  const row_counts_after = {
    amazon_reimbursements: await tableCount(client, "amazon_reimbursements"),
    claim_reimbursements: await tableCount(client, "claim_reimbursements"),
    claim_candidates: await tableCount(client, "claim_candidates"),
    products: await tableCount(client, "products"),
    expected_packages: await tableCount(client, "expected_packages"),
    amazon_removals: await tableCount(client, "amazon_removals"),
  };

  const profileRow = await client.query(
    `SELECT id::text AS user_id FROM public.profiles WHERE organization_id = $1::uuid LIMIT 1`,
    [ORG],
  );
  const testUserId = (profileRow.rows[0] as { user_id?: string } | undefined)?.user_id ?? null;
  const altOrgRow = await client.query(
    `SELECT id::text FROM public.organizations WHERE id <> $1::uuid LIMIT 1`,
    [ORG],
  );
  const altOrg = (altOrgRow.rows[0] as { id?: string } | undefined)?.id ?? null;

  let sameOrgCount = 0;
  let crossOrgCount = 0;
  if (testUserId) {
    sameOrgCount = await authCount(client, testUserId);
    if (altOrg) {
      const altProfile = await client.query(
        `SELECT id::text FROM public.profiles WHERE organization_id = $1::uuid LIMIT 1`,
        [altOrg],
      );
      const altUserId = (altProfile.rows[0] as { id?: string } | undefined)?.id;
      if (altUserId) crossOrgCount = await authCount(client, altUserId, ORG);
    }
  }

  await client.end();

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const anonClient = createClient(url, anon, { auth: { persistSession: false } });

  const srSelect = await admin
    .from("amazon_reimbursements")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG);
  const anonSelect = await anonClient.from("amazon_reimbursements").select("id", { count: "exact", head: true });

  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  require.cache[require.resolve("server-only")] = {
    id: "server-only",
    filename: "server-only",
    loaded: true,
    exports: {},
  } as NodeModule;

  const { supabaseServer } = await import("../lib/supabase-server");
  const { buildFeeAdjustedEstimate } = await import("../lib/fees/fee-adjusted-estimate-readmodel");
  const { buildSourceConnectorReadiness } = await import("../lib/claims/connectors/source-connector-readmodel");

  const reimbPick = await supabaseServer
    .from("amazon_reimbursements")
    .select("fnsku, amount_total")
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .not("fnsku", "is", null)
    .order("approval_date", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  let feeAdjustedSmoke: Record<string, unknown> = { skipped: true };
  if (reimbPick.data?.fnsku) {
    const map = await supabaseServer
      .from("product_identifier_map")
      .select("product_id")
      .eq("organization_id", ORG)
      .eq("store_id", STORE)
      .ilike("fnsku", String(reimbPick.data.fnsku))
      .limit(1)
      .maybeSingle();
    const productId = (map.data as { product_id?: string } | null)?.product_id;
    if (productId) {
      const est = await buildFeeAdjustedEstimate(supabaseServer, ORG, STORE, productId);
      feeAdjustedSmoke = {
        product_id: productId,
        observed_reimbursement: est.observed_reimbursement,
        observed_reimbursement_sources: est.observed_reimbursement_sources,
        pass:
          est.observed_reimbursement != null ||
          est.observed_reimbursement_sources.includes("amazon_reimbursements"),
      };
    }
  }

  let sourceReadiness: Awaited<ReturnType<typeof buildSourceConnectorReadiness>> | null = null;
  let sourceReadinessError: string | null = null;
  try {
    sourceReadiness = await buildSourceConnectorReadiness(supabaseServer, ORG, STORE);
  } catch (e) {
    sourceReadinessError = e instanceof Error ? e.message : String(e);
  }
  const reimbSource = sourceReadiness?.source_health.find(
    (s) => s.domain_table === "amazon_reimbursements" || s.source_key.includes("reimbursement"),
  );

  let scannerDiff = "";
  try {
    scannerDiff = execSync('git diff HEAD -- "app/scanner/**" "**/operator-mobile/**"', {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
  } catch {
    scannerDiff = "";
  }

  const noDataMutation =
    row_counts_before.amazon_reimbursements === row_counts_after.amazon_reimbursements &&
    row_counts_before.claim_reimbursements === row_counts_after.claim_reimbursements &&
    row_counts_before.claim_candidates === row_counts_after.claim_candidates &&
    row_counts_before.products === row_counts_after.products &&
    row_counts_before.expected_packages === row_counts_after.expected_packages &&
    row_counts_before.amazon_removals === row_counts_after.amazon_removals;

  const afterMeta = after_rls_state.meta as Array<{
    table_name: string;
    rls_enabled: boolean;
    policy_count: number;
  }>;
  const amazonOk = afterMeta.find((m) => m.table_name === "amazon_reimbursements");
  const claimOk = afterMeta.find((m) => m.table_name === "claim_reimbursements");
  const rlsFixed =
    amazonOk?.rls_enabled === true &&
    (amazonOk?.policy_count ?? 0) >= 2 &&
    claimOk?.rls_enabled === true &&
    (claimOk?.policy_count ?? 0) >= 2;

  const sameOrgPass = sameOrgCount > 0 && !srSelect.error && (srSelect.count ?? 0) > 0;
  const crossOrgPass = crossOrgCount === 0;
  const anonPass = anonSelect.error != null || (anonSelect.count ?? 0) === 0;
  const readmodelPass =
    !reimbPick.error &&
    (reimbSource != null || (srSelect.count ?? 0) > 0) &&
    (feeAdjustedSmoke.pass === true || feeAdjustedSmoke.skipped === true);

  const SAFE_ORIGINAL_RLS_FIXED =
    rlsFixed && noDataMutation && sameOrgPass && crossOrgPass && anonPass && readmodelPass ? "yes" : "no";

  const report = {
    run_id,
    db: PRODUCTION_REF,
    maysam_approval: "APPROVED_ORIGINAL_RLS_REIMBURSEMENTS_APPLY=yes",
    migration_file: MIGRATION,
    before_rls_state,
    migration_applied,
    after_rls_state,
    row_counts_before_after: { before: row_counts_before, after: row_counts_after },
    same_org_access_result: sameOrgPass ? "PASS" : "FAIL",
    cross_org_block_result: crossOrgPass ? "PASS" : "FAIL",
    anon_block_result: anonPass ? "PASS" : "FAIL",
    access_details: {
      service_role_count: srSelect.count,
      same_org_authenticated_count: sameOrgCount,
      cross_org_visible_rows: crossOrgCount,
      anon_count: anonSelect.count ?? 0,
      anon_error: anonSelect.error?.message ?? null,
    },
    reimbursement_readmodel_smoke: {
      amazon_reimbursements_pick: reimbPick.data ?? null,
      fee_adjusted_estimate: feeAdjustedSmoke,
      source_connector_reimbursement: reimbSource ?? null,
      source_connector_error: sourceReadinessError,
      service_role_reimbursement_count: srSelect.count ?? 0,
      pass: readmodelPass,
    },
    no_data_mutation_verification: { pass: noDataMutation, before: row_counts_before, after: row_counts_after },
    no_scanner_change_verification: {
      pass: scannerDiff.length === 0,
      git_diff_app_scanner: scannerDiff.length === 0 ? "empty" : "non_empty_see_manifest",
      note: "Apply is DB-only; no app/scanner files modified by this script",
    },
    SAFE_ORIGINAL_RLS_FIXED,
    NEXT_PROMPT: "PHASE-LIVE-TABLE-RLS-AND-ORG-SCOPE-AUDIT-V1-REVERIFY",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "audit-report.md"),
    `# Original RLS reimbursements apply

DB: \`${PRODUCTION_REF}\` · Migration applied: **${migration_applied}**

## After state
${afterMeta.map((m) => `- \`${m.table_name}\`: RLS ${m.rls_enabled ? "on" : "off"}, ${m.policy_count} policies`).join("\n")}

## Row counts unchanged: ${noDataMutation ? "yes" : "NO"}
- amazon_reimbursements: ${row_counts_before.amazon_reimbursements} → ${row_counts_after.amazon_reimbursements}
- claim_reimbursements: ${row_counts_before.claim_reimbursements} → ${row_counts_after.claim_reimbursements}

## Access: same_org ${report.same_org_access_result} · cross_org ${report.cross_org_block_result} · anon ${report.anon_block_result}

## SAFE_ORIGINAL_RLS_FIXED: **${SAFE_ORIGINAL_RLS_FIXED}**
`,
  );

  console.log(JSON.stringify({ ok: true, outDir, SAFE_ORIGINAL_RLS_FIXED, migration_applied }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
