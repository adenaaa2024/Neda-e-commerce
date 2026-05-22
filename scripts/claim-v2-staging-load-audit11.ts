/**
 * CLAIM-INBOX-AUDIT-11 — Load v2 dry-run NDJSON into public.claim_candidate_drafts.
 *
 *   npx tsx scripts/claim-v2-staging-load-audit11.ts
 *   npx tsx scripts/claim-v2-staging-load-audit11.ts --limit=500
 *   npx tsx scripts/claim-v2-staging-load-audit11.ts --ndjson=path/to/v2-candidates.ndjson
 *
 * Inserts ONLY claim_candidate_drafts. ON CONFLICT (idempotency_key) DO NOTHING.
 * Does NOT touch claim_candidates.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkRunDir, mkRunId } from "../lib/audits/product-seed-output";

const DEFAULT_NDJSON = path.join(
  ".cursor",
  "audit-reports",
  "claim-inbox-audit-07",
  "20260513T222709Z",
  "v2-candidates.ndjson",
);

const BATCH = 150;
const GENERATED_BY_STAGING = "v2_generator";

type V2Row = Record<string, unknown>;

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
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

function nv(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function numConfidence(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

function mapLifecycle(c: V2Row): string {
  const ev = nv(c.evidence_status)?.toLowerCase() ?? "";
  const hasProduct = !!(nv(c.product_id) || nv(c.resolved_product_id));
  if (ev === "missing") return "needs_evidence";
  if (!hasProduct) return "needs_product_link";
  if (ev === "complete") return "ready_for_review";
  return "draft";
}

function validateRow(c: V2Row, lineNo: number): string | null {
  const idem = nv(c.idempotency_key);
  if (!idem || idem.length < 32) return `line ${lineNo}: missing idempotency_key`;
  if (!nv(c.organization_id)) return `line ${lineNo}: missing organization_id`;
  if (!nv(c.source_table)) return `line ${lineNo}: missing source_table`;
  if (!nv(c.source_row_id)) return `line ${lineNo}: missing source_row_id`;
  if (!nv(c.claim_family)) return `line ${lineNo}: missing claim_family`;
  if (!nv(c.claim_reason)) return `line ${lineNo}: missing claim_reason`;
  const ev = nv(c.evidence_status);
  if (!ev || !["missing", "partial", "complete", "unknown"].includes(ev)) return `line ${lineNo}: bad evidence_status`;
  return null;
}

function toInsertRow(c: V2Row): Record<string, unknown> {
  const blockers = Array.isArray(c.blocker_reasons) ? c.blocker_reasons : [];
  const lifecycle = mapLifecycle(c);
  return {
    organization_id: nv(c.organization_id),
    store_id: nv(c.store_id),
    source_table: nv(c.source_table),
    source_row_id: nv(c.source_row_id),
    claim_family: nv(c.claim_family),
    claim_reason: nv(c.claim_reason),
    evidence_status: nv(c.evidence_status),
    confidence_score: numConfidence(c.confidence_score),
    sku: nv(c.sku),
    asin: nv(c.asin),
    fnsku: nv(c.fnsku),
    product_id: nv(c.product_id),
    resolved_product_id: nv(c.resolved_product_id),
    generator_version: nv(c.generator_version) ?? "0.0.0",
    source_run_id: nv(c.source_run_id),
    upload_id: nv(c.upload_id),
    idempotency_key: nv(c.idempotency_key),
    generated_by: GENERATED_BY_STAGING,
    blocker_reasons: blockers,
    recommended_action: nv(c.recommended_action),
    candidate_payload: { ...c, _staging_load: "CLAIM-INBOX-AUDIT-11", _lifecycle_rule: lifecycle },
    lifecycle_status: lifecycle,
  };
}

function parseArgs(argv: string[]): { ndjsonPath: string; limit: number | null } {
  let ndjsonPath = path.join(process.cwd(), DEFAULT_NDJSON);
  let limit: number | null = null;
  for (const a of argv) {
    if (a.startsWith("--ndjson=")) ndjsonPath = path.resolve(process.cwd(), a.slice("--ndjson=".length).trim());
    if (a.startsWith("--limit=")) {
      const n = parseInt(a.slice("--limit=".length), 10);
      limit = Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  return { ndjsonPath, limit };
}

async function countDrafts(sb: SupabaseClient): Promise<number> {
  const { count, error } = await sb.from("claim_candidate_drafts").select("id", { count: "exact", head: true });
  if (error) throw new Error(`count claim_candidate_drafts: ${error.message}`);
  return count ?? 0;
}

async function countBy(sb: SupabaseClient, col: string, val: string): Promise<number> {
  const { count, error } = await sb
    .from("claim_candidate_drafts")
    .select("id", { count: "exact", head: true })
    .eq(col, val);
  if (error) throw new Error(`count ${col}=${val}: ${error.message}`);
  return count ?? 0;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const sb = createServiceClient();
  const { ndjsonPath, limit } = parseArgs(process.argv.slice(2));
  const runId = mkRunId();
  const outDir = mkRunDir(path.join(".cursor", "audit-reports", "claim-inbox-audit-11"), runId);
  const logPath = path.join(outDir, "logs", "claim-inbox-audit-11.ndjson");
  const trace = (o: Record<string, unknown>) => fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n", "utf8");

  if (!fs.existsSync(ndjsonPath)) throw new Error(`NDJSON not found: ${ndjsonPath}`);

  trace({ event: "start", runId, ndjsonPath, limit });

  const preDrafts = await countDrafts(sb);
  trace({ event: "pre_count_drafts", count: preDrafts });

  let preLegacyCount: number | null = null;
  const { count: preLegacy, error: legErr } = await sb.from("claim_candidates").select("id", { count: "exact", head: true });
  if (legErr) trace({ event: "pre_count_legacy_error", message: legErr.message });
  else {
    preLegacyCount = preLegacy ?? 0;
    trace({ event: "pre_count_legacy_readonly", count: preLegacyCount });
  }

  const idemSet = new Set<string>();
  let lineNo = 0;
  let attempted = 0;
  let validationErrors = 0;
  const histSource = new Map<string, number>();
  const histLife = new Map<string, number>();
  const histEv = new Map<string, number>();

  const rl = readline.createInterface({ input: fs.createReadStream(ndjsonPath, "utf8"), crlfDelay: Infinity });
  let batch: Record<string, unknown>[] = [];

  const flush = async (rows: Record<string, unknown>[], stripUpload: boolean) => {
    if (rows.length === 0) return;
    const payload = stripUpload ? rows.map((r) => ({ ...r, upload_id: null })) : rows;
    const { error } = await sb.from("claim_candidate_drafts").upsert(payload, {
      onConflict: "idempotency_key",
      ignoreDuplicates: true,
    });
    if (error) throw new Error(`upsert batch (stripUpload=${stripUpload}): ${error.message}`);
  };

  let stripUpload = false;

  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    lineNo++;
    let c: V2Row;
    try {
      c = JSON.parse(t) as V2Row;
    } catch {
      validationErrors++;
      continue;
    }
    const err = validateRow(c, lineNo);
    if (err) {
      trace({ event: "validation_error", err });
      validationErrors++;
      continue;
    }
    const idem = nv(c.idempotency_key)!;
    if (idemSet.has(idem)) {
      trace({ event: "duplicate_idempotency_in_file", idempotency_key: idem });
      continue;
    }
    idemSet.add(idem);

    const row = toInsertRow(c);
    const st = nv(c.source_table) ?? "?";
    const life = nv(row.lifecycle_status as string) ?? "?";
    const ev = nv(c.evidence_status) ?? "?";
    histSource.set(st, (histSource.get(st) ?? 0) + 1);
    histLife.set(life, (histLife.get(life) ?? 0) + 1);
    histEv.set(ev, (histEv.get(ev) ?? 0) + 1);

    batch.push(row);
    attempted++;

    if (limit != null && attempted >= limit) break;

    if (batch.length >= BATCH) {
      try {
        await flush(batch, stripUpload);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!stripUpload && /upload_id|foreign key|23503/i.test(msg)) {
          stripUpload = true;
          trace({ event: "retry_batches_without_upload_id" });
          await flush(batch, true);
        } else throw e;
      }
      trace({ event: "batch_flushed", size: batch.length, stripUpload });
      batch = [];
    }
  }

  if (batch.length > 0) {
    try {
      await flush(batch, stripUpload);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!stripUpload && /upload_id|foreign key|23503/i.test(msg)) {
        stripUpload = true;
        trace({ event: "retry_final_batch_without_upload_id" });
        await flush(batch, true);
      } else throw e;
    }
    trace({ event: "final_batch_flushed", size: batch.length, stripUpload });
  }

  const postDrafts = await countDrafts(sb);
  const inserted = postDrafts - preDrafts;
  const skipped = attempted - inserted;

  const postLegacyRes = await sb.from("claim_candidates").select("id", { count: "exact", head: true });
  let postLegacyCount: number | null = null;
  if (!postLegacyRes.error) postLegacyCount = postLegacyRes.count ?? 0;
  trace({ event: "post_count_drafts", count: postDrafts, inserted, attempted, skipped, validationErrors });

  const dist: Record<string, Record<string, number>> = {};
  for (const tbl of ["amazon_returns", "amazon_removals", "amazon_removal_shipments"]) {
    dist[tbl] = { count: await countBy(sb, "source_table", tbl) };
  }
  const lifeDist: Record<string, number> = {};
  for (const s of ["draft", "needs_evidence", "needs_product_link", "ready_for_review", "blocked"]) {
    lifeDist[s] = await countBy(sb, "lifecycle_status", s);
  }
  const evDist: Record<string, number> = {};
  for (const s of ["missing", "partial", "complete", "unknown"]) {
    evDist[s] = await countBy(sb, "evidence_status", s);
  }

  const manifest = {
    auditPrompt: "CLAIM-INBOX-AUDIT-11",
    runId,
    ndjsonPath,
    pre_draft_count: preDrafts,
    post_draft_count: postDrafts,
    rows_attempted_valid: attempted,
    rows_inserted_delta: inserted,
    conflicts_or_skipped_estimate: skipped,
    validation_errors: validationErrors,
    strip_upload_id: stripUpload,
    source_distribution_db: dist,
    lifecycle_distribution_db: lifeDist,
    evidence_distribution_db: evDist,
    legacy_claim_candidates_count_before: preLegacyCount,
    legacy_claim_candidates_count_after: postLegacyCount,
    constraints: { claim_candidates_writes: false },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const md = (name: string, body: string) => fs.writeFileSync(path.join(outDir, name), body, "utf8");

  md(
    "staging-insert-summary.md",
    `<!-- markdownlint-disable MD013 MD060 -->

# Staging insert summary — CLAIM-INBOX-AUDIT-11

**Run ID:** \`${runId}\`

| Metric | Value |
|--------|------:|
| Pre-insert \`claim_candidate_drafts\` count | ${preDrafts} |
| Post-insert count | ${postDrafts} |
| Rows attempted (validated) | ${attempted} |
| Inserted delta (post − pre) | ${inserted} |
| Skipped / no-op estimate (attempted − delta) | ${skipped} |
| Validation / JSON errors | ${validationErrors} |
| \`upload_id\` stripped on FK retry | ${stripUpload ? "yes" : "no"} |

**Legacy \`claim_candidates\` count (read-only):** ${preLegacyCount ?? "n/a"} → ${postLegacyCount ?? "n/a"} (must be unchanged).
`,
  );

  md(
    "pre-insert-checks.md",
    `# Pre-insert checks

<!-- markdownlint-disable MD013 MD060 -->

- **claim_candidate_drafts pre-count:** ${preDrafts} (expected 0 unless prior load)
- **claim_candidates pre-count (witness):** ${preLegacyCount ?? "unavailable"}
- **Source file:** \`${ndjsonPath}\`
- **Unique idempotency keys in file:** ${idemSet.size}
- **Lifecycle mapping:** \`missing\` evidence → \`needs_evidence\`; no product id → \`needs_product_link\`; else \`complete\` → \`ready_for_review\` else \`draft\`
`,
  );

  md(
    "post-insert-verification.md",
    `# Post-insert verification

<!-- markdownlint-disable MD013 MD060 -->

DB post-checks (service role):

| source_table | count |
| --- | ---: |
${Object.entries(dist)
      .map(([k, v]) => `| \`${k}\` | ${v.count} |`)
      .join("\n")}

| lifecycle_status | count |
| --- | ---: |
${Object.entries(lifeDist)
      .map(([k, v]) => `| \`${k}\` | ${v} |`)
      .join("\n")}

| evidence_status | count |
| --- | ---: |
${Object.entries(evDist)
      .map(([k, v]) => `| \`${k}\` | ${v} |`)
      .join("\n")}

Duplicate idempotency keys in DB are prevented by UNIQUE constraint; file contained **${idemSet.size}** unique keys among valid lines.

**RLS smoke (service role):** this run used the service role client, which bypasses RLS for inserts and counts. Authenticated reads remain org-scoped via \`get_my_organization_id()\`.
`,
  );

  md(
    "source-distribution.md",
    `# Source table distribution (attempted rows)\n\n${[...histSource.entries()].map(([k, v]) => `- **${k}:** ${v}`).join("\n")}\n`,
  );
  md(
    "lifecycle-status-distribution.md",
    `# Lifecycle distribution (attempted rows)\n\n${[...histLife.entries()].map(([k, v]) => `- **${k}:** ${v}`).join("\n")}\n`,
  );
  md(
    "idempotency-conflicts.md",
    `# Idempotency conflicts

<!-- markdownlint-disable MD013 MD060 -->

- **In-file duplicate keys:** logged to NDJSON if any (search \`duplicate_idempotency_in_file\`).
- **DB ON CONFLICT DO NOTHING:** skipped rows ≈ \`${skipped}\` (equals attempted − inserted when pre-count was ${preDrafts}).
`,
  );
  md(
    "no-legacy-write-confirmation.md",
    `# No legacy writes — CLAIM-INBOX-AUDIT-11

- **No** INSERT/UPDATE/DELETE on \`claim_candidates\`.
- **No** truncate.
- **Only** \`claim_candidate_drafts\` upserts (idempotent).
`,
  );
  md(
    "next-step-recommendation.md",
    `# Next step — CLAIM-INBOX-AUDIT-11

<!-- markdownlint-disable MD013 MD012 -->

1. Feature-flag **read path** (API) so operators can list
   \`claim_candidate_drafts\` by \`organization_id\` and \`lifecycle_status\`.
2. Internal **staging review** UI or CSV export for \`needs_evidence\` and
   \`needs_product_link\` queues.
3. **CLAIM-INBOX-AUDIT-12** (or product prompt): promotion job
   \`INSERT INTO claim_candidates\` from approved drafts only; separate signoff.
`,
  );

  trace({ event: "complete", outDir, inserted, postDrafts });
  console.log(`CLAIM-INBOX-AUDIT-11 complete → ${outDir}`);
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
