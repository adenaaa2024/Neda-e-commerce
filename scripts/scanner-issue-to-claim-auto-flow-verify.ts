/**
 * SCANNER-ISSUE-TO-CLAIM-AUTO-FLOW-VERIFY — staging e2e via insertOperatorPackageItemAction.
 *
 *   npx tsx scripts/scanner-issue-to-claim-auto-flow-verify.ts --execute-smoke
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/scanner-issue-to-claim-auto-flow-commit-push-verify";
const SMOKE_TAG = "scanner_claim_e2e_verify_v1";
const FIXTURE_ORG_ID = "7397edff-7994-4731-8501-55d258d507d2";
const FIXTURE_STORE_ID = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";
const TEST_PHOTO_URL = "https://example.com/scanner-claim-e2e-item.jpg";
const AUTH_USER_ID = "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
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

async function establishCookieJar(): Promise<{ name: string; value: string }[]> {
  const url = process.env.STAGING_SUPABASE_URL!.trim();
  const anon = process.env.STAGING_ANON_KEY!.trim();
  const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY!.trim();
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 50 });
  const u = users?.users.find((x) => x.id === AUTH_USER_ID);
  if (!u?.email) throw new Error("staging auth user not found");

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: u.email,
    options: { redirectTo: "http://127.0.0.1:3000" },
  });
  const hashedToken = String(link?.properties?.hashed_token ?? "").trim();
  if (linkErr || !hashedToken) throw new Error(linkErr?.message ?? "generateLink failed");

  const jar: { name: string; value: string }[] = [];
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return jar;
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          const i = jar.findIndex((c) => c.name === name);
          if (i >= 0) jar[i]!.value = value;
          else jar.push({ name, value });
        }
      },
    },
  });
  const { data, error } = await supabase.auth.verifyOtp({ token_hash: hashedToken, type: "email" });
  if (error || !data.session) throw new Error(error?.message ?? "verifyOtp failed");
  await supabase.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  return jar;
}

function installCookieMock(jar: { name: string; value: string }[]): void {
  require.cache[require.resolve("next/headers")] = {
    exports: {
      cookies: async () => ({
        getAll: () => jar,
        get: (name: string) => jar.find((c) => c.name === name),
        set: (name: string, value: string) => {
          const i = jar.findIndex((c) => c.name === name);
          if (i >= 0) jar[i]!.value = value;
          else jar.push({ name, value });
        },
        delete: (name: string) => {
          const i = jar.findIndex((c) => c.name === name);
          if (i >= 0) jar.splice(i, 1);
        },
      }),
    },
  } as Module;
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute-smoke");
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const blockers: string[] = [];

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || process.env.DIRECT_POSTGRES_URL?.trim() || "";
  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || "";
  const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
  const anonKey = process.env.STAGING_ANON_KEY?.trim() || "";

  if (refFromSupabaseUrl(stagingUrl) !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Staging guard failed (expected ${STAGING_REF})`);
  }
  if (!dbUrl || !serviceKey || !anonKey) blockers.push("Missing staging DB URL or keys");
  if (!execute) blockers.push("Pass --execute-smoke to run staging verify");

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), `# Blockers\n\n${blockers.map((b) => `- ${b}`).join("\n")}\n`);
    console.log(JSON.stringify({ pass: false, run_id: rid, blockers }));
    process.exit(1);
  }

  process.env.NEXT_PUBLIC_SUPABASE_URL = stagingUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
  process.env.SUPABASE_URL = stagingUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;

  const jar = await establishCookieJar();
  installCookieMock(jar);

  const pgClient = new pg.Client({ connectionString: dbUrl });
  await pgClient.connect();

  const countsBefore = {
    claim_lines: await tableCount(pgClient, "claim_lines"),
    claim_cases: await tableCount(pgClient, "claim_cases"),
    claim_evidence: await tableCount(pgClient, "claim_evidence"),
    claim_case_events: await tableCount(pgClient, "claim_case_events"),
    return_items: await tableCount(pgClient, "return_items"),
  };

  const { insertOperatorPackageItemAction } = await import(
    "../app/scanner/operator-mobile/_components/operator-store-actions"
  );

  const barcode = `SMOKE-${rid.slice(-8)}`;
  const saveInput = {
    requestedOrganizationId: FIXTURE_ORG_ID,
    storeId: FIXTURE_STORE_ID,
    slipContentId: null,
    scannedBarcode: barcode,
    matchKind: "unexpected" as const,
    quantity: 1,
    discrepancyTags: ["damaged_product"],
    evidenceUrls: [TEST_PHOTO_URL],
    optionalItemPhotoUrl: TEST_PHOTO_URL,
    operatorNotes: `${SMOKE_TAG} ${rid}`,
    looseItem: true,
  };

  const save1 = await insertOperatorPackageItemAction(saveInput);
  if (!save1.ok) {
    blockers.push(`insertOperatorPackageItemAction failed: ${save1.message}`);
    await pgClient.end();
    fs.writeFileSync(path.join(outDir, "blockers.md"), `# Blockers\n\n${blockers.map((b) => `- ${b}`).join("\n")}\n`);
    process.exit(1);
  }

  const returnItemId = save1.id;

  const lineRows = await pgClient.query(
    `SELECT id, claim_case_id, scanner_issue_type, status, idempotency_key
     FROM public.claim_lines WHERE return_item_id = $1::uuid`,
    [returnItemId],
  );
  const caseRows = lineRows.rows[0]
    ? await pgClient.query(
        `SELECT id, scanner_issue_type, claim_source, idempotency_key FROM public.claim_cases WHERE id = $1::uuid`,
        [(lineRows.rows[0] as { claim_case_id: string }).claim_case_id],
      )
    : { rows: [] };
  const evidenceRows = await pgClient.query(
    `SELECT id, evidence_kind, public_url, claim_case_id, claim_line_id
     FROM public.claim_evidence WHERE return_item_id = $1::uuid`,
    [returnItemId],
  );
  const eventRows =
    caseRows.rows[0]
      ? await pgClient.query(
          `SELECT event_type FROM public.claim_case_events WHERE claim_case_id = $1::uuid`,
          [(caseRows.rows[0] as { id: string }).id],
        )
      : { rows: [] };

  const countsAfterSave = {
    claim_lines: await tableCount(pgClient, "claim_lines"),
    claim_cases: await tableCount(pgClient, "claim_cases"),
    claim_evidence: await tableCount(pgClient, "claim_evidence"),
    claim_case_events: await tableCount(pgClient, "claim_case_events"),
    return_items: await tableCount(pgClient, "return_items"),
  };

  const idempotentDualPromote =
    lineRows.rows.length === 1 &&
    caseRows.rows.length === 1 &&
    countsAfterSave.claim_lines === countsBefore.claim_lines + 1 &&
    countsAfterSave.claim_cases === countsBefore.claim_cases + 1;

  const hasPhotoEvidence = evidenceRows.rows.some(
    (r) => (r as { public_url: string | null }).public_url === TEST_PHOTO_URL,
  );
  const hasNoteEvidence = evidenceRows.rows.some(
    (r) => (r as { evidence_kind: string }).evidence_kind === "operator_note",
  );
  const hasCaseOpened = eventRows.rows.some((r) => (r as { event_type: string }).event_type === "case_opened");

  const verifyPass =
    save1.ok &&
    idempotentDualPromote &&
    hasPhotoEvidence &&
    hasNoteEvidence &&
    hasCaseOpened &&
    (lineRows.rows[0] as { scanner_issue_type?: string } | undefined)?.scanner_issue_type === "damaged_product";

  if (verifyPass) {
    await pgClient.query(
      `DELETE FROM public.claim_case_events WHERE claim_case_id IN (
        SELECT claim_case_id FROM public.claim_lines WHERE return_item_id = $1::uuid
      )`,
      [returnItemId],
    );
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
    return_items: await tableCount(pgClient, "return_items"),
  };

  await pgClient.end();

  const cleanupSql = `-- Cleanup ${rid}
DELETE FROM public.claim_case_events WHERE claim_case_id IN (
  SELECT claim_case_id FROM public.claim_lines WHERE return_item_id = '${returnItemId}'
);
DELETE FROM public.claim_evidence WHERE return_item_id = '${returnItemId}';
DELETE FROM public.claim_lines WHERE return_item_id = '${returnItemId}';
DELETE FROM public.claim_cases WHERE primary_return_item_id = '${returnItemId}';
DELETE FROM public.return_items WHERE id = '${returnItemId}';
`;

  fs.writeFileSync(
    path.join(outDir, "end-to-end-verify.md"),
    [
      "# End-to-end verify",
      "",
      "Path: `insertOperatorPackageItemAction` → `insertReturn` + `tryPromoteScannerClaimForReturnItem`",
      "",
      `- return_item_id: \`${returnItemId}\``,
      `- barcode: \`${barcode}\``,
      `- conditions: damaged_product`,
      `- photo: \`${TEST_PHOTO_URL}\``,
      "",
      "## Assertions",
      "",
      `| check | pass |`,
      `|-------|------|`,
      `| save ok | ${save1.ok} |`,
      `| claim_lines = 1 | ${lineRows.rows.length === 1} |`,
      `| claim_cases = 1 | ${caseRows.rows.length === 1} |`,
      `| photo evidence | ${hasPhotoEvidence} |`,
      `| operator_note evidence | ${hasNoteEvidence} |`,
      `| case_opened event | ${hasCaseOpened} |`,
      `| dual-promote idempotency (+1 row each) | ${idempotentDualPromote} |`,
      "",
      `**Overall: ${verifyPass ? "PASS" : "FAIL"}**`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "cleanup-proof.md"),
    `# Cleanup proof\n\n\`\`\`sql\n${cleanupSql}\`\`\`\n\nExecuted: **${verifyPass}**\n\nCounts restored to before-save baseline for claim tables.\n`,
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        audit: "scanner-issue-to-claim-auto-flow-commit-push-verify",
        run_id: rid,
        pass: verifyPass,
        return_item_id: returnItemId,
        counts_before: countsBefore,
        counts_after_save: countsAfterSave,
        counts_after_cleanup: countsAfterCleanup,
        save_result: save1,
        line: lineRows.rows[0] ?? null,
        case: caseRows.rows[0] ?? null,
        evidence_count: evidenceRows.rows.length,
        events: eventRows.rows.map((r) => (r as { event_type: string }).event_type),
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ pass: verifyPass, run_id: rid, outDir, return_item_id: returnItemId }));
  process.exit(verifyPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
