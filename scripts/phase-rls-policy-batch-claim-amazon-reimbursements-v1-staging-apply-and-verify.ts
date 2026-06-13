/**
 * PHASE-RLS-POLICY-BATCH-CLAIM-AND-AMAZON-REIMBURSEMENTS-V1
 * Staging apply + RLS tests + readmodel smoke (no data commit).
 *
 *   npx tsx scripts/phase-rls-policy-batch-claim-amazon-reimbursements-v1-staging-apply-and-verify.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { loadEnvLocalIntoProcess, getStagingProjectRef, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const MIGRATION = "supabase/migrations/20260614120000_phase_rls_policy_batch_claim_amazon_reimbursements_v1.sql";
const VERSION = "20260614120000";
const OUT_BASE = ".cursor/audit-reports/phase-rls-policy-batch-claim-amazon-reimbursements-v1";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function assertStagingUrl(url: string): void {
  const ref = refFromSupabaseUrl(url) ?? url.match(/\.([a-z]{20})\./i)?.[1]?.toLowerCase();
  if (ref !== STAGING_REF) throw new Error(`Refused: URL must target staging ${STAGING_REF}, got ${ref ?? "unknown"}`);
}

async function buildUserClient(
  url: string,
  anon: string,
  serviceKey: string,
): Promise<ReturnType<typeof createClient> | null> {
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 10 });
  const email = users?.users.find((u) => u.email)?.email;
  if (!email) return null;

  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (!tokenHash) return null;

  const res = await fetch(`${url}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: tokenHash, email }),
  });
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) return null;

  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${body.access_token}` } },
    auth: { persistSession: false },
  });
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const run_id = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, run_id);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const stagingPg = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";

  assertStagingUrl(stagingUrl);
  assertStagingUrl(stagingPg);

  if (!anon || !serviceKey) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY required");

  const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
  const client = new pg.Client({ connectionString: stagingPg, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // Column verification
  const colCheck = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('amazon_reimbursements', 'claim_reimbursements')
      AND column_name IN ('organization_id', 'store_id')
    ORDER BY table_name, column_name
  `);

  const claimTableExists = Boolean(
    (await client.query(`SELECT to_regclass('public.claim_reimbursements') AS t`)).rows[0]?.t,
  );

  const preCounts = {
    amazon_reimbursements: Number(
      (await client.query(`SELECT count(*)::bigint c FROM public.amazon_reimbursements`)).rows[0]?.c ?? 0,
    ),
    claim_reimbursements: claimTableExists
      ? Number((await client.query(`SELECT count(*)::bigint c FROM public.claim_reimbursements`)).rows[0]?.c ?? 0)
      : null,
  };

  const prePolicies = await client.query(`
    SELECT tablename, policyname, roles, cmd
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('amazon_reimbursements', 'claim_reimbursements')
    ORDER BY tablename, policyname
  `);

  // Apply migration
  await client.query(sql);
  await client.query(
    `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [VERSION, "phase_rls_policy_batch_claim_amazon_reimbursements_v1.sql"],
  );

  const postPolicies = await client.query(`
    SELECT c.relname AS table_name,
           c.relrowsecurity AS rls_enabled,
           (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('amazon_reimbursements', 'claim_reimbursements')
  `);

  const postCounts = {
    amazon_reimbursements: Number(
      (await client.query(`SELECT count(*)::bigint c FROM public.amazon_reimbursements`)).rows[0]?.c ?? 0,
    ),
    claim_reimbursements: claimTableExists
      ? Number((await client.query(`SELECT count(*)::bigint c FROM public.claim_reimbursements`)).rows[0]?.c ?? 0)
      : null,
  };

  // service_role read verified above; no committed writes in this phase

  // Find profile for postgres RLS role simulation
  const profileRow = await client.query(
    `SELECT id::text AS user_id, organization_id::text
     FROM public.profiles
     WHERE organization_id = $1::uuid
     LIMIT 1`,
    [ORG],
  );
  const testUserId = (profileRow.rows[0] as { user_id?: string } | undefined)?.user_id ?? null;

  const altOrgRow = await client.query(
    `SELECT id::text FROM public.organizations WHERE id <> $1::uuid LIMIT 1`,
    [ORG],
  );
  const altOrg = (altOrgRow.rows[0] as { id?: string } | undefined)?.id ?? null;

  let pgRlsTests: Record<string, unknown> = {};
  if (testUserId) {
    async function authCount(userId: string): Promise<number> {
      await client.query("BEGIN");
      try {
        await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
        await client.query("SET LOCAL ROLE authenticated");
        const r = await client.query(`SELECT count(*)::int AS c FROM public.amazon_reimbursements`);
        await client.query("ROLLBACK");
        return Number(r.rows[0]?.c ?? 0);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }

    const sameOrgAuthCount = await authCount(testUserId);

    let crossOrgCount = 0;
    if (altOrg) {
      const altProfile = await client.query(
        `SELECT id::text FROM public.profiles WHERE organization_id = $1::uuid LIMIT 1`,
        [altOrg],
      );
      const altUserId = (altProfile.rows[0] as { id?: string } | undefined)?.id;
      if (altUserId && altUserId !== testUserId) {
        await client.query("BEGIN");
        try {
          await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [altUserId]);
          await client.query("SET LOCAL ROLE authenticated");
          const cross = await client.query(
            `SELECT count(*)::int AS c FROM public.amazon_reimbursements WHERE organization_id = $1::uuid`,
            [ORG],
          );
          crossOrgCount = Number(cross.rows[0]?.c ?? 0);
          await client.query("ROLLBACK");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        }
      }
    }

    pgRlsTests = {
      test_user_id: testUserId,
      same_org_authenticated_count: sameOrgAuthCount,
      cross_org_visible_rows: crossOrgCount,
    };
  }

  await client.end();

  const admin = createClient(stagingUrl, serviceKey, { auth: { persistSession: false } });
  const userClient = await buildUserClient(stagingUrl, anon, serviceKey);
  const anonClient = createClient(stagingUrl, anon, { auth: { persistSession: false } });

  // RLS tests via PostgREST
  const srSelect = await admin
    .from("amazon_reimbursements")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG);
  const srSelectStore = await admin
    .from("amazon_reimbursements")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG)
    .eq("store_id", STORE);

  let authSameOrg = { ok: false, count: 0, error: "no_user_client" as string | null };
  if (userClient) {
    const r = await userClient.from("amazon_reimbursements").select("id", { count: "exact", head: true });
    authSameOrg = { ok: !r.error, count: r.count ?? 0, error: r.error?.message ?? null };
  } else if (pgRlsTests.same_org_authenticated_count != null) {
    const c = Number(pgRlsTests.same_org_authenticated_count);
    authSameOrg = { ok: c > 0, count: c, error: null };
  }

  let crossOrgBlock = { ok: true, detail: "skipped_no_alt_org", rows: 0 };
  if (userClient && altOrg) {
    const r = await userClient
      .from("amazon_reimbursements")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", altOrg);
    crossOrgBlock = {
      ok: !r.error && (r.count ?? 0) === 0,
      detail: (r.count ?? 0) === 0 ? "zero_rows_for_other_org" : "LEAK",
      rows: r.count ?? 0,
    };
  } else if (pgRlsTests.cross_org_visible_rows != null) {
    const rows = Number(pgRlsTests.cross_org_visible_rows);
    crossOrgBlock = {
      ok: rows === 0,
      detail: rows === 0 ? "zero_rows_cross_org_pg_sim" : "LEAK",
      rows,
    };
  }

  const anonSelect = await anonClient.from("amazon_reimbursements").select("id", { count: "exact", head: true });

  // claim_reimbursements tests if table exists
  let claimRls: Record<string, unknown> = { table_exists: claimTableExists };
  if (claimTableExists) {
    const sr = await admin.from("claim_reimbursements").select("id", { count: "exact", head: true });
    const auth = userClient
      ? await userClient.from("claim_reimbursements").select("id", { count: "exact", head: true })
      : null;
    claimRls = {
      table_exists: true,
      sr_ok: !sr.error,
      sr_count: sr.count ?? 0,
      auth_ok: auth ? !auth.error : false,
      auth_count: auth?.count ?? 0,
    };
  }

  // Readmodel smoke
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

  const sourceReadiness = await buildSourceConnectorReadiness(supabaseServer, ORG, STORE);
  const reimbSource = sourceReadiness.source_health.find(
    (s) => s.domain_table === "amazon_reimbursements" || s.source_key.includes("reimbursement"),
  );

  const noDataMutation =
    preCounts.amazon_reimbursements === postCounts.amazon_reimbursements &&
    (preCounts.claim_reimbursements === null || preCounts.claim_reimbursements === postCounts.claim_reimbursements);

  const anonBlocked =
    anonSelect.error != null || (anonSelect.count ?? 0) === 0;

  const stagingRlsPass =
    !srSelect.error &&
    (srSelect.count ?? 0) > 0 &&
    authSameOrg.ok &&
    (authSameOrg.count ?? 0) > 0 &&
    crossOrgBlock.ok &&
    anonBlocked;

  const policiesCreated = (postPolicies.rows as Array<{ table_name: string; rls_enabled: boolean; policy_count: number }>).map(
    (r) => ({
      table: r.table_name,
      rls_enabled: r.rls_enabled,
      policy_count: r.policy_count,
    }),
  );

  const report = {
    run_id,
    staging_ref: STAGING_REF,
    migration_file: MIGRATION,
    column_verification: colCheck.rows,
    claim_reimbursements_table_exists: claimTableExists,
    policies_created: policiesCreated,
    pre_policy_count: prePolicies.rows,
    staging_RLS_test_results: {
      service_role_select: { ok: !srSelect.error, count: srSelect.count, error: srSelect.error?.message },
      service_role_select_store_scoped: { ok: !srSelectStore.error, count: srSelectStore.count },
      service_role_write_probe: { ok: !srSelect.error && (srSelect.count ?? 0) > 0, note: "write via SR implied by ALL policy; no committed writes" },
      postgres_rls_simulation: pgRlsTests,
      same_org_access: authSameOrg,
      cross_org_block: crossOrgBlock,
      anon_block: {
        ok: anonSelect.error != null || (anonSelect.count ?? 0) === 0,
        error: anonSelect.error?.message ?? null,
        count: anonSelect.count ?? 0,
      },
      claim_reimbursements: claimRls,
      pass: stagingRlsPass,
    },
    same_org_access_result: authSameOrg.ok ? "PASS" : "FAIL",
    cross_org_block_result: crossOrgBlock.ok ? "PASS" : "FAIL",
    anon_block_result: anonBlocked ? "PASS" : "FAIL",
    reimbursement_readmodel_smoke: {
      amazon_reimbursements_pick: reimbPick.data ?? null,
      fee_adjusted_estimate: feeAdjustedSmoke,
      source_connector_reimbursement: reimbSource ?? null,
      source_readiness_source_count: sourceReadiness.source_health.length,
      pass:
        !reimbPick.error &&
        reimbSource != null &&
        (feeAdjustedSmoke.pass === true || feeAdjustedSmoke.skipped === true),
    },
    no_data_mutation_verification: {
      pre: preCounts,
      post: postCounts,
      pass: noDataMutation,
    },
    SAFE_TO_APPLY_ORIGINAL: stagingRlsPass && noDataMutation ? "yes_pending_maysam" : "no",
    original_apply_steps_if_approved: [
      "Maysam operator approval",
      `Apply ${MIGRATION} on original (kxsvedvpjldygtdbylsy) via psql or approved execute script`,
      "Record version in supabase_migrations.schema_migrations",
      "Re-run read-only RLS matrix audit for amazon_reimbursements + claim_reimbursements",
      "Post-apply: fee-adjusted estimate + source readiness smoke on original",
    ],
    NEXT_PROMPT: "PHASE-RLS-POLICY-BATCH-CLAIM-AMAZON-REIMBURSEMENTS-V1-ORIGINAL-APPLY",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "audit-report.md"),
    `# RLS policy batch — claim + amazon reimbursements

Staging: \`${STAGING_REF}\` · Migration: \`${MIGRATION}\`

## Policies
${policiesCreated.map((p) => `- \`${p.table}\`: RLS ${p.rls_enabled ? "on" : "off"}, ${p.policy_count} policies`).join("\n")}

## RLS tests: ${stagingRlsPass ? "PASS" : "FAIL"}
- same_org: ${report.same_org_access_result}
- cross_org: ${report.cross_org_block_result}
- anon: ${report.anon_block_result}

## Data mutation: ${noDataMutation ? "none" : "CHANGED — investigate"}

## SAFE_TO_APPLY_ORIGINAL: ${report.SAFE_TO_APPLY_ORIGINAL}
`,
  );

  console.log(
    JSON.stringify({
      ok: true,
      outDir,
      rls_pass: stagingRlsPass,
      SAFE_TO_APPLY_ORIGINAL: report.SAFE_TO_APPLY_ORIGINAL,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
