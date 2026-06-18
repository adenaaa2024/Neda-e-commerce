/**
 * PHASE-CLAIM-READY-TO-FILE-RUNTIME-DATA-FIX-V1 — read-only diagnostic.
 *
 * Proves WHY the live /claim-center/ready-to-file UI is empty: it compares the
 * Ready-to-File composer output against BOTH the staging project (the value the
 * running dev app is bound to via NEXT_PUBLIC_*) and the original/live project
 * (where the pilot data was emitted). No DB writes.
 *
 *   npx tsx scripts/diag-claim-ready-to-file-runtime-data-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function refOf(url: string): string {
  const m = /https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url);
  return m?.[1] ?? "unknown";
}

async function probe(label: string, url?: string, key?: string): Promise<void> {
  if (!url || !key) {
    console.log(`\n[${label}] SKIP — missing url/key`);
    return;
  }
  const client: SupabaseClient = createClient(url, key, { auth: { persistSession: false } });
  const ref = refOf(url);
  try {
    const { count: subCount } = await client
      .from("claim_submissions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG);

    const payload = await composeClaimReadyToFileQueueV1(client, ORG, STORE, {
      pilot_case_run_id: PILOT_CASE_RUN_ID,
      intake_run_id: PILOT_INTAKE_RUN_ID,
    });

    console.log(
      `\n[${label}] ref=${ref}` +
        `\n  claim_submissions(org) = ${subCount ?? "?"}` +
        `\n  ready_rows             = ${payload.ready_rows.length}` +
        `\n  blocked_rows           = ${payload.blocked_rows.length}` +
        `\n  total_recovery_value   = ${payload.summary_cards.total_recovery_value}` +
        `\n  family_counts          = ${JSON.stringify(payload.summary_cards.family_counts)}`,
    );
  } catch (e) {
    console.log(`\n[${label}] ref=${ref} ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const e = process.env;

  console.log("=== Ready-to-File runtime data diagnostic (read-only) ===");
  console.log(`pilot_case_run_id = ${PILOT_CASE_RUN_ID}`);
  console.log(`intake_run_id     = ${PILOT_INTAKE_RUN_ID}`);
  console.log(`NEXT_PUBLIC_SUPABASE_URL (running app binds here) = ${e.NEXT_PUBLIC_SUPABASE_URL}`);

  await probe(
    "RUNNING APP (NEXT_PUBLIC_*)",
    e.NEXT_PUBLIC_SUPABASE_URL,
    e.SUPABASE_SERVICE_ROLE_KEY,
  );
  await probe("STAGING (STAGING_*)", e.STAGING_SUPABASE_URL, e.STAGING_SERVICE_ROLE_KEY);
  await probe("ORIGINAL/LIVE (ORIGINAL_*)", e.ORIGINAL_SUPABASE_URL, e.ORIGINAL_SERVICE_ROLE_KEY);
}

void main();
