/**
 * NEXT-CLAIM-CANONICAL-07 — Dry-run or execute bootstrap of claim_review_work_items from claim_candidate_drafts.
 *
 *   npx tsx scripts/claim-review-workitem-bootstrap.ts --org-id=<uuid> [--store-id=<uuid>] [--execute]
 *
 * Default: dry-run (no writes). With --execute: inserts missing rows + `created` events.
 * Writes optional report dir: .cursor/audit-reports/next-claim-canonical-07/<run_id>/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { bootstrapClaimReviewWorkItemsFromDrafts } from "../lib/claim-review-workflow-bootstrap";
import { mkRunDir, mkRunId } from "../lib/audits/product-seed-output";

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false } });
}

function argVal(flag: string): string | null {
  const prefix = `${flag}=`;
  for (const a of process.argv.slice(2)) {
    if (a === flag) return "";
    if (a.startsWith(prefix)) return a.slice(prefix.length).trim();
  }
  return null;
}

async function verifyNoDuplicateDrafts(sb: SupabaseClient, organizationId: string): Promise<string[]> {
  const { data, error } = await sb.from("claim_review_work_items").select("draft_id").eq("organization_id", organizationId);
  if (error) throw new Error(error.message);
  const counts = new Map<string, number>();
  for (const r of data ?? []) {
    const id = (r as { draft_id?: string }).draft_id;
    if (typeof id !== "string") continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, n]) => n > 1)
    .map(([id]) => id);
}

async function main(): Promise<void> {
  loadEnvLocal();
  const orgId = argVal("--org-id");
  if (!orgId) {
    console.error("Usage: npx tsx scripts/claim-review-workitem-bootstrap.ts --org-id=<uuid> [--store-id=<uuid>] [--execute] [--write-artifacts]");
    process.exit(1);
  }
  const storeId = argVal("--store-id");
  const execute = process.argv.includes("--execute");
  const writeArtifacts = process.argv.includes("--write-artifacts");

  const sb = createServiceClient();
  const result = await bootstrapClaimReviewWorkItemsFromDrafts({
    supabase: sb,
    organizationId: orgId,
    storeId: storeId && storeId.length > 0 ? storeId : null,
    dryRun: !execute,
    actorUserId: null,
  });

  console.log(JSON.stringify({ dry_run: !execute, ...result }, null, 2));

  if (execute && result.inserted_count > 0) {
    const dups = await verifyNoDuplicateDrafts(sb, orgId);
    if (dups.length > 0) {
      console.error("Duplicate draft_id rows detected:", dups);
      process.exit(2);
    }
  }

  if (writeArtifacts) {
    const runId = mkRunId();
    const dir = mkRunDir(path.join(".cursor", "audit-reports", "next-claim-canonical-07"), runId);
    const j = JSON.stringify({ run_id: runId, ...result, dry_run: !execute }, null, 2);
    fs.writeFileSync(path.join(dir, "cli-output.json"), j, "utf8");
    console.error(`Wrote ${path.join(dir, "cli-output.json")}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
