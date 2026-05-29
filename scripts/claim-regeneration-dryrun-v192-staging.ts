/**
 * CLAIM-REGENERATION-DRYRUN-V192 — v2 generator dry-run vs existing drafts (read-only).
 *
 *   npx tsx scripts/claim-regeneration-dryrun-v192-staging.ts --run-id=<id>
 *   npx tsx scripts/claim-regeneration-dryrun-v192-staging.ts --run-id=<id> --v191-run=<id>
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/claim-regeneration-dryrun-v192";
const GENERATOR_VERSION = "0.2.0-v192-dryrun";
const PAGE = 800;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function v191RunArg(): string {
  const a = process.argv.find((x) => x.startsWith("--v191-run="));
  return a ? a.split("=")[1]!.trim() : "20260525T190000Z";
}

function nv(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function idempotencyKey(org: string, sourceTable: string, sourceRowId: string, claimReason: string): string {
  return crypto.createHash("sha256").update(`${org}|${sourceTable}|${sourceRowId}|${claimReason}`).digest("hex");
}

async function fetchPaged(sb: SupabaseClient, table: string, max: number | null): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select("*").order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
    if (max != null && out.length >= max) return out.slice(0, max);
  }
  return max != null ? out.slice(0, max) : out;
}

function buildCandidate(
  row: Record<string, unknown>,
  sourceTable: string,
  claimFamily: string,
  claimReason: string,
): Record<string, unknown> | null {
  const org = nv(row.organization_id);
  const id = nv(row.id);
  if (!org || !id) return null;
  const sku = nv(row.sku) ?? nv(row.merchant_sku) ?? nv(row.seller_sku);
  const asin = nv(row.asin);
  const fnsku = nv(row.fnsku);
  const evidence = sku || fnsku || asin ? "partial" : "missing";
  return {
    organization_id: org,
    store_id: nv(row.store_id),
    source_table: sourceTable,
    source_row_id: id,
    claim_family: claimFamily,
    claim_reason: claimReason,
    evidence_status: evidence,
    idempotency_key: idempotencyKey(org, sourceTable, id, claimReason),
    generator_version: GENERATOR_VERSION,
    generated_by: "dry_run",
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const v191Run = v191RunArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging guard failed (ref=${ref})`);
  }

  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const sb = createClient(publicUrl, key, { auth: { persistSession: false } });
  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const v191ManifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/claim-cleanup-wave-b-source-orphan-rpid-v191",
    v191Run,
    "manifest.json",
  );
  const v191Manifest = fs.existsSync(v191ManifestPath)
    ? (JSON.parse(fs.readFileSync(v191ManifestPath, "utf8")) as Record<string, unknown>)
    : null;

  const existingKeys = await pgClient.query(`SELECT idempotency_key FROM public.claim_candidate_drafts`);
  const existingSet = new Set(existingKeys.rows.map((r: { idempotency_key: string }) => r.idempotency_key));

  const [returns, removals, shipments] = await Promise.all([
    fetchPaged(sb, "amazon_returns", null),
    fetchPaged(sb, "amazon_removals", null),
    fetchPaged(sb, "amazon_removal_shipments", null),
  ]);

  const generated: Record<string, unknown>[] = [];
  for (const r of returns) {
    const c = buildCandidate(r, "amazon_returns", "AMAZON_RETURNS", "DISPOSITION_LINE_REVIEW");
    if (c) generated.push(c);
  }
  for (const r of removals) {
    const c = buildCandidate(r, "amazon_removals", "AMAZON_REMOVALS", "DISPOSITION_LINE_REVIEW");
    if (c) generated.push(c);
  }
  for (const r of shipments) {
    const c = buildCandidate(r, "amazon_removal_shipments", "AMAZON_REMOVAL_SHIPMENTS", "SHIPMENT_QUANTITY_MISMATCH");
    if (c) generated.push(c);
  }

  let wouldInsert = 0;
  let wouldSkipDuplicate = 0;
  let wouldSkipMissingEvidence = 0;
  const bySource: Record<string, number> = {};

  for (const c of generated) {
    const st = String(c.source_table);
    bySource[st] = (bySource[st] ?? 0) + 1;
    if (existingSet.has(String(c.idempotency_key))) {
      wouldSkipDuplicate++;
      continue;
    }
    if (c.evidence_status === "missing") {
      wouldSkipMissingEvidence++;
      continue;
    }
    wouldInsert++;
  }

  const postV191Lift =
    v191Manifest && typeof v191Manifest.repair_outcomes === "object"
      ? (v191Manifest.repair_outcomes as Record<string, number>).alternate_key_repair_proposal ?? 0
      : 0;

  await pgClient.end();

  const manifest = {
    prompt: "CLAIM-REGENERATION-DRYRUN-V192",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "dry_run_only",
    v191_run: v191Run,
    v191_manifest_found: v191Manifest != null,
    generator_version: GENERATOR_VERSION,
    source_rows: { amazon_returns: returns.length, amazon_removals: removals.length, amazon_removal_shipments: shipments.length },
    v2_candidates_generated: generated.length,
    by_source_table: bySource,
    existing_draft_idempotency_keys: existingSet.size,
    would_insert_new_drafts: wouldInsert,
    would_skip_duplicate_idempotency: wouldSkipDuplicate,
    would_skip_missing_evidence: wouldSkipMissingEvidence,
    v191_source_repair_lift_estimate: postV191Lift,
    applied: 0,
    status: "PASS",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "regeneration-summary.json"),
    JSON.stringify(
      {
        would_insert: wouldInsert,
        would_skip_duplicate: wouldSkipDuplicate,
        would_skip_missing_evidence: wouldSkipMissingEvidence,
        sample_new_keys: generated
          .filter((c) => !existingSet.has(String(c.idempotency_key)) && c.evidence_status !== "missing")
          .slice(0, 25),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# CLAIM-REGENERATION-DRYRUN-V192",
      "",
      `- run_id: \`${runId}\``,
      `- v191 prerequisite run: \`${v191Run}\``,
      `- mode: **dry-run only**`,
      "",
      "## Generator output",
      `- v2 candidates from source rows: **${generated.length}**`,
      `- would insert (new idempotency keys, partial+ evidence): **${wouldInsert}**`,
      `- would skip (duplicate idempotency): **${wouldSkipDuplicate}**`,
      `- would skip (missing evidence): **${wouldSkipMissingEvidence}**`,
      "",
      "## V191 lift (estimate)",
      `- source-row repair proposals from V191: **${postV191Lift}** (not applied in dry-run)`,
      "",
      "No draft INSERT. No claim submission.",
    ].join("\n"),
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
