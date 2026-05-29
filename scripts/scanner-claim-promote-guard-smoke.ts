/**
 * Scanner claim promote guard smoke — no DB writes for guard unit checks;
 * optional staging DB check for disabled promote noop.
 *
 *   npx tsx scripts/scanner-claim-promote-guard-smoke.ts --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const OUT_BASE = ".cursor/audit-reports/scanner-claim-promote-production-guard";
const FIXTURE_ORG_ID = "7397edff-7994-4731-8501-55d258d507d2";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function tableCount(client: pg.Client, table: string): Promise<number> {
  const r = await client.query(`SELECT COUNT(*)::int AS c FROM public.${table}`);
  return (r.rows[0] as { c: number }).c;
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const results: Record<string, unknown> = { run_id: rid, steps: [] as unknown[] };
  const steps = results.steps as Record<string, unknown>[];

  // --- unit: default disabled ---
  delete process.env.CLAIM_SCANNER_AUTO_PROMOTE_ENABLED;
  delete process.env.CLAIM_SCANNER_AUTO_PROMOTE_ORIGINAL_APPROVED;
  process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${STAGING_REF}.supabase.co`;
  const { evaluateScannerClaimPromoteGuard } = await import("../lib/scanner-claim-promote-guard");
  const disabled = evaluateScannerClaimPromoteGuard();
  steps.push({
    name: "default_disabled_staging_ref",
    pass: disabled.allowed === false && disabled.skipped_reason === "promote_disabled",
    result: disabled,
  });

  // --- unit: original blocked ---
  process.env.CLAIM_SCANNER_AUTO_PROMOTE_ENABLED = "1";
  process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${ORIGINAL_REF}.supabase.co`;
  const originalBlocked = evaluateScannerClaimPromoteGuard();
  steps.push({
    name: "original_ref_blocked",
    pass:
      originalBlocked.allowed === false &&
      originalBlocked.skipped_reason === "original_ref_blocked" &&
      originalBlocked.ref === ORIGINAL_REF,
    result: originalBlocked,
  });

  // --- unit: original with approval ---
  process.env.CLAIM_SCANNER_AUTO_PROMOTE_ORIGINAL_APPROVED = "1";
  const originalApproved = evaluateScannerClaimPromoteGuard();
  steps.push({
    name: "original_ref_with_approval",
    pass: originalApproved.allowed === true && originalApproved.ref === ORIGINAL_REF,
    result: originalApproved,
  });

  // --- unit: staging enabled ---
  delete process.env.CLAIM_SCANNER_AUTO_PROMOTE_ORIGINAL_APPROVED;
  process.env.CLAIM_SCANNER_AUTO_PROMOTE_ENABLED = "1";
  process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${STAGING_REF}.supabase.co`;
  const stagingAllowed = evaluateScannerClaimPromoteGuard();
  steps.push({
    name: "staging_enabled",
    pass: stagingAllowed.allowed === true && stagingAllowed.ref === STAGING_REF,
    result: stagingAllowed,
  });

  let dbNoopPass = false;
  if (execute) {
    loadEnvLocalIntoProcess();
    const dbUrl =
      process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
      process.env.DIRECT_POSTGRES_URL?.trim() ||
      "";
    const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || "";
    const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
    const ref = refFromSupabaseUrl(stagingUrl);

    if (dbUrl && serviceKey && ref === STAGING_REF) {
      delete process.env.CLAIM_SCANNER_AUTO_PROMOTE_ENABLED;
      process.env.NEXT_PUBLIC_SUPABASE_URL = stagingUrl;
      process.env.SUPABASE_URL = stagingUrl;

      const pgClient = new pg.Client({ connectionString: dbUrl });
      await pgClient.connect();
      const sb = createClient(stagingUrl, serviceKey, { auth: { persistSession: false } });
      const beforeLines = await tableCount(pgClient, "claim_lines");

      const { data: ri, error: riErr } = await sb
        .from("return_items")
        .insert({
          organization_id: FIXTURE_ORG_ID,
          marketplace: "amazon",
          item_name: `guard noop smoke ${rid}`,
          conditions: ["damaged_product"],
          status: "received",
          photo_evidence: { item_url: "https://example.com/guard-noop.jpg" },
        })
        .select("id")
        .single();

      if (!riErr && ri?.id) {
        const { promoteScannerReturnItemToClaimStructures } = await import(
          "../lib/scanner-operator-claim-promote"
        );
        const promoteRes = await promoteScannerReturnItemToClaimStructures(String(ri.id), {
          organizationId: FIXTURE_ORG_ID,
          client: sb,
        });
        const afterLines = await tableCount(pgClient, "claim_lines");
        const lineForRi = await pgClient.query(
          `SELECT COUNT(*)::int AS c FROM public.claim_lines WHERE return_item_id = $1::uuid`,
          [ri.id],
        );
        await pgClient.query(`DELETE FROM public.return_items WHERE id = $1::uuid`, [ri.id]);
        dbNoopPass =
          promoteRes.promoted === false &&
          promoteRes.skipped_reason === "promote_disabled" &&
          afterLines === beforeLines &&
          (lineForRi.rows[0] as { c: number }).c === 0;
        steps.push({
          name: "disabled_db_noop",
          pass: dbNoopPass,
          promote: promoteRes,
          claim_lines_delta: afterLines - beforeLines,
        });
      } else {
        steps.push({ name: "disabled_db_noop", pass: false, error: riErr?.message });
      }
      await pgClient.end();
    } else {
      steps.push({ name: "disabled_db_noop", pass: false, error: "staging env missing" });
    }
  } else {
    steps.push({ name: "disabled_db_noop", pass: null, skipped: "pass --execute" });
  }

  const unitPass = steps
    .filter((s) => s.name !== "disabled_db_noop")
    .every((s) => s.pass === true);
  const overall = execute ? unitPass && dbNoopPass : unitPass;

  fs.writeFileSync(path.join(outDir, "guard-smoke-results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ pass: overall, run_id: rid, outDir, results }));
  process.exit(overall ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
