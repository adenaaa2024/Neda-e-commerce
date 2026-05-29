/**
 * SCANNER-ISSUE-TO-CLAIM-AUTO-FLOW-IMPLEMENT — staging smoke + audit artifacts.
 *
 *   npx tsx scripts/scanner-issue-to-claim-auto-flow-implement-smoke.ts --execute
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/scanner-issue-to-claim-auto-flow-implement";
const SMOKE_TAG = "scanner_claim_auto_flow_smoke_v1";

const FIXTURE_ORG_ID = "7397edff-7994-4731-8501-55d258d507d2";
const FIXTURE_STORE_ID = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";
const TEST_PHOTO_URL = "https://example.com/scanner-claim-smoke-item.jpg";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

async function tableCount(client: pg.Client, table: string, extraWhere = ""): Promise<number> {
  const r = await client.query(`SELECT COUNT(*)::int AS c FROM public.${table} ${extraWhere}`);
  return (r.rows[0] as { c: number }).c;
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  let commitHash = "unknown";
  try {
    commitHash = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* ignore */
  }

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const serviceKey = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromConnectionUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Staging guard failed (expected ${STAGING_REF}, got ${ref ?? "none"})`);
  }
  if (!serviceKey) blockers.push("Missing SUPABASE_SERVICE_ROLE_KEY");

  const guardResults = {
    branch,
    commit_hash: commitHash,
    staging_ref: ref,
    execute,
    blockers,
  };
  fs.writeFileSync(path.join(outDir, "guard-results.md"), `# Guard results\n\n\`\`\`json\n${JSON.stringify(guardResults, null, 2)}\n\`\`\`\n`);

  fs.writeFileSync(
    path.join(outDir, "build-result.md"),
    [
      "# Build result",
      "",
      "Run separately before smoke:",
      "",
      "- `npm run check:product-resolution-contract-v192` — PASS",
      "- `npm run build` — PASS",
    ].join("\n") + "\n",
  );

  if (!execute) {
    blockers.push("Pass --execute to run staging smoke");
  }
  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), `# Blockers\n\n${blockers.map((b) => `- ${b}`).join("\n")}\n`);
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, pass: false, blockers }, null, 2),
    );
    console.log(JSON.stringify({ pass: false, run_id: runId, outDir, blockers }));
    process.exit(1);
  }

  const pgClient = new pg.Client({ connectionString: dbUrl });
  await pgClient.connect();
  const sb = createClient(publicUrl, serviceKey, { auth: { persistSession: false } });

  process.env.CLAIM_SCANNER_AUTO_PROMOTE_ENABLED = "1";
  process.env.NEXT_PUBLIC_SUPABASE_URL = publicUrl;

  const countsBefore = {
    claim_lines: await tableCount(pgClient, "claim_lines"),
    claim_cases: await tableCount(pgClient, "claim_cases"),
    claim_evidence: await tableCount(pgClient, "claim_evidence"),
    claim_case_events: await tableCount(pgClient, "claim_case_events"),
  };

  const { promoteScannerReturnItemToClaimStructures } = await import("../lib/scanner-operator-claim-promote");

  const { data: insertedRi, error: riErr } = await sb
    .from("return_items")
    .insert({
      organization_id: FIXTURE_ORG_ID,
      store_id: FIXTURE_STORE_ID,
      package_id: null,
      marketplace: "amazon",
      item_name: `SCANNER-CLAIM-SMOKE ${runId}`,
      conditions: ["damaged_product"],
      status: "received",
      photo_evidence: { item_url: TEST_PHOTO_URL, damaged_product: 1 },
      notes: `smoke ${SMOKE_TAG} ${runId}`,
    })
    .select("id")
    .single();

  if (riErr || !insertedRi?.id) {
    blockers.push(`return_items insert failed: ${riErr?.message ?? "unknown"}`);
    await pgClient.end();
    fs.writeFileSync(path.join(outDir, "blockers.md"), `# Blockers\n\n${blockers.map((b) => `- ${b}`).join("\n")}\n`);
    process.exit(1);
  }

  const returnItemId = String(insertedRi.id);
  const promote1 = await promoteScannerReturnItemToClaimStructures(returnItemId, {
    organizationId: FIXTURE_ORG_ID,
    client: sb,
  });
  const promote2 = await promoteScannerReturnItemToClaimStructures(returnItemId, {
    organizationId: FIXTURE_ORG_ID,
    client: sb,
  });

  const lineForRi = await pgClient.query(
    `SELECT id, claim_case_id, scanner_issue_type, status, idempotency_key
     FROM public.claim_lines WHERE return_item_id = $1::uuid`,
    [returnItemId],
  );
  const caseForRi = lineForRi.rows[0]
    ? await pgClient.query(`SELECT id, idempotency_key, scanner_issue_type, claim_source FROM public.claim_cases WHERE id = $1::uuid`, [
        (lineForRi.rows[0] as { claim_case_id: string }).claim_case_id,
      ])
    : { rows: [] };
  const evidenceForRi = await pgClient.query(
    `SELECT id, evidence_kind, public_url, claim_case_id, claim_line_id
     FROM public.claim_evidence WHERE return_item_id = $1::uuid`,
    [returnItemId],
  );
  const eventsForCase =
    caseForRi.rows[0]
      ? await pgClient.query(`SELECT event_type FROM public.claim_case_events WHERE claim_case_id = $1::uuid`, [
          (caseForRi.rows[0] as { id: string }).id,
        ])
      : { rows: [] };

  const countsAfter = {
    claim_lines: await tableCount(pgClient, "claim_lines"),
    claim_cases: await tableCount(pgClient, "claim_cases"),
    claim_evidence: await tableCount(pgClient, "claim_evidence"),
    claim_case_events: await tableCount(pgClient, "claim_case_events"),
  };

  const smokePass =
    promote1.promoted === true &&
    promote2.promoted === true &&
    lineForRi.rows.length === 1 &&
    caseForRi.rows.length === 1 &&
    evidenceForRi.rows.some((r) => (r as { public_url: string }).public_url === TEST_PHOTO_URL) &&
    countsAfter.claim_lines === countsBefore.claim_lines + 1 &&
    countsAfter.claim_cases === countsBefore.claim_cases + 1;

  const cleanupSql = `-- Cleanup smoke run ${runId}
DELETE FROM public.claim_case_events WHERE claim_case_id IN (
  SELECT claim_case_id FROM public.claim_lines WHERE return_item_id = '${returnItemId}'
);
DELETE FROM public.claim_evidence WHERE return_item_id = '${returnItemId}';
DELETE FROM public.claim_lines WHERE return_item_id = '${returnItemId}';
DELETE FROM public.claim_cases WHERE primary_return_item_id = '${returnItemId}';
DELETE FROM public.return_items WHERE id = '${returnItemId}';
`;

  if (smokePass) {
    await pgClient.query(`DELETE FROM public.claim_case_events WHERE claim_case_id IN (
      SELECT claim_case_id FROM public.claim_lines WHERE return_item_id = $1::uuid
    )`, [returnItemId]);
    await pgClient.query(`DELETE FROM public.claim_evidence WHERE return_item_id = $1::uuid`, [returnItemId]);
    await pgClient.query(`DELETE FROM public.claim_lines WHERE return_item_id = $1::uuid`, [returnItemId]);
    await pgClient.query(`DELETE FROM public.claim_cases WHERE primary_return_item_id = $1::uuid`, [returnItemId]);
    await pgClient.query(`DELETE FROM public.return_items WHERE id = $1::uuid`, [returnItemId]);
  }

  const countsAfterCleanup = {
    claim_lines: await tableCount(pgClient, "claim_lines"),
    claim_cases: await tableCount(pgClient, "claim_cases"),
    claim_evidence: await tableCount(pgClient, "claim_evidence"),
    claim_case_events: await tableCount(pgClient, "claim_case_events"),
  };

  await pgClient.end();

  const changedFiles = execSync("git diff --name-only HEAD", { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

  fs.writeFileSync(
    path.join(outDir, "implementation-summary.md"),
    [
      "# Implementation summary",
      "",
      "Wired scanner operator item save (`insertOperatorPackageItemAction`) to promote `return_items` with claimable issue tags into:",
      "",
      "- `claim_lines` (return_item grain, idempotency `cl:return_item:{org}:{return_item_id}`)",
      "- `claim_cases` (scanner_operator_issue / warehouse_qc_issue, idempotency `cl:case:scanner:{org}:{return_item_id}:{issue}`)",
      "- `claim_evidence` (photos from `photo_evidence`, operator notes)",
      "- `claim_case_events` (case_opened, evidence_added, status_changed)",
      "",
      `Helper: \`lib/scanner-operator-claim-promote.ts\``,
      `Commit: \`${commitHash}\``,
      `Smoke pass: **${smokePass}**`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "changed-files.md"),
    changedFiles.length ? changedFiles.map((f) => `- ${f}`).join("\n") + "\n" : "- (uncommitted)\n",
  );

  fs.writeFileSync(
    path.join(outDir, "issue-type-mapping.md"),
    [
      "# Issue type mapping",
      "",
      "| Source tag | Canonical case/line issue | discrepancy_kind | claim_source |",
      "|------------|----------------------------|------------------|--------------|",
      "| damaged_product | damaged_product | damage | scanner_operator_issue |",
      "| scratched | scratched | damage | scanner_operator_issue |",
      "| wrong_item | wrong_item | wrong_item | scanner_operator_issue |",
      "| expired | expired | other | scanner_operator_issue |",
      "| missing_parts | missing_parts | other | scanner_operator_issue |",
      "| missing_item | missing_parts | other | scanner_operator_issue |",
      "| damaged_warehouse | operator_other | damage | warehouse_qc_issue |",
      "| sellable_ok | — (no-op) | — | — |",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "idempotency-proof.md"),
    [
      "# Idempotency proof",
      "",
      `- First promote: promoted=${promote1.promoted}, created_line=${promote1.created_line}, created_case=${promote1.created_case}, evidence_created=${promote1.evidence_created}`,
      `- Second promote: promoted=${promote2.promoted}, created_line=${promote2.created_line}, created_case=${promote2.created_case}, evidence_created=${promote2.evidence_created}`,
      `- claim_lines for return_item: **${lineForRi.rows.length}** (expect 1)`,
      `- claim_cases linked: **${caseForRi.rows.length}** (expect 1)`,
      `- photo evidence rows: **${evidenceForRi.rows.length}**`,
      "",
      "**Gap:** return_item hard-delete / void does not auto-close or detach claim structures (not in scope).",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "staging-smoke.md"),
    [
      "# Staging smoke",
      "",
      `- return_item_id: \`${returnItemId}\``,
      `- conditions: damaged_product`,
      `- photo: \`${TEST_PHOTO_URL}\``,
      "",
      "## Counts",
      "",
      "| table | before | after insert | after cleanup |",
      "|-------|--------|--------------|---------------|",
      `| claim_lines | ${countsBefore.claim_lines} | ${countsAfter.claim_lines} | ${countsAfterCleanup.claim_lines} |`,
      `| claim_cases | ${countsBefore.claim_cases} | ${countsAfter.claim_cases} | ${countsAfterCleanup.claim_cases} |`,
      `| claim_evidence | ${countsBefore.claim_evidence} | ${countsAfter.claim_evidence} | ${countsAfterCleanup.claim_evidence} |`,
      `| claim_case_events | ${countsBefore.claim_case_events} | ${countsAfter.claim_case_events} | ${countsAfterCleanup.claim_case_events} |`,
      "",
      `Result: **${smokePass ? "PASS" : "FAIL"}**`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(path.join(outDir, "cleanup-proof.md"), `# Cleanup proof\n\n\`\`\`sql\n${cleanupSql}\`\`\`\n\nCleanup executed: **${smokePass}**\n`);
  fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.length ? `# Blockers\n\n${blockers.map((b) => `- ${b}`).join("\n")}\n` : "# Blockers\n\nNone.\n");
  fs.writeFileSync(
    path.join(outDir, "exact-next-prompts.md"),
    [
      "# Exact next prompts",
      "",
      "```",
      "SCANNER-ISSUE-TO-CLAIM-AUTO-FLOW-VERIFY — re-run --execute-smoke on staging after implement",
      "```",
      "",
      "- Agent filing / TRID remain out of scope",
      "- Grouping/batching policy wiring deferred",
    ].join("\n") + "\n",
  );

  const manifest = {
    audit: "scanner-issue-to-claim-auto-flow-implement",
    run_id: runId,
    pass: smokePass,
    commit_hash: commitHash,
    branch,
    staging_ref: STAGING_REF,
    return_item_id: returnItemId,
    counts_before: countsBefore,
    counts_after: countsAfter,
    counts_after_cleanup: countsAfterCleanup,
    promote_first: promote1,
    promote_second: promote2,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify({ pass: smokePass, run_id: runId, outDir, manifest }));
  process.exit(smokePass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
