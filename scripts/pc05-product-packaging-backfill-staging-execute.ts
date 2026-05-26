/**
 * PC05-EXECUTE — Product packaging backfill staging apply (approval-gated).
 *
 * Inserts accepted dry-run candidates into packaging tables only.
 *
 *   npx tsx scripts/pc05-product-packaging-backfill-staging-execute.ts
 *   npx tsx scripts/pc05-product-packaging-backfill-staging-execute.ts --apply
 *   npx tsx scripts/pc05-product-packaging-backfill-staging-execute.ts --apply --dry-run-id=20260523T220000Z
 */
import { createReadStream } from "node:fs";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const DRY_RUN_DEFAULT = "20260523T220000Z";
const APPROVAL_PATH_DEFAULT = ".cursor/operator-approvals/product-packaging-backfill-pc05-execute-approval.md";
const DRY_RUN_BASE = ".cursor/audit-reports/pc05-product-packaging-governed-backfill-dry-run";
const OUT_BASE = ".cursor/audit-reports/pc05-product-packaging-backfill-staging-execute";

type CsvRow = Record<string, string>;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function dryRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--dry-run-id="));
  return a ? a.split("=")[1]!.trim() : DRY_RUN_DEFAULT;
}

function approvalPathArg(): string {
  const a = process.argv.find((x) => x.startsWith("--approval-path="));
  return a ? a.split("=")[1]!.trim() : APPROVAL_PATH_DEFAULT;
}

function outBaseArg(): string {
  const a = process.argv.find((x) => x.startsWith("--out-base="));
  return a ? a.split("=")[1]!.trim() : OUT_BASE;
}

function batchTagArg(runId: string): string {
  const a = process.argv.find((x) => x.startsWith("--batch-tag="));
  return a ? a.split("=")[1]!.trim() : `PC05_BACKFILL_${runId}`;
}

function forceNeedsReview(): boolean {
  return process.argv.includes("--force-needs-review");
}

function readApprovalFlags(approvalPath: string): { run: boolean; execute: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), approvalPath), "utf8");
  const runM = text.match(/APPROVED_TO_RUN_STAGING\s*=\s*(\S+)/);
  const execM =
    text.match(/APPROVED_PRODUCT_PACKAGING_BACKFILL_PC05D_SCALE_EXECUTE\s*=\s*(\S+)/) ??
    text.match(/APPROVED_PRODUCT_PACKAGING_BACKFILL_SCALE_EXECUTE\s*=\s*(\S+)/) ??
    text.match(/APPROVED_PRODUCT_PACKAGING_BACKFILL_EXECUTE\s*=\s*(\S+)/);
  const runVal = runM?.[1] ?? "";
  const execVal = execM?.[1] ?? "";
  return {
    run: runVal === "true",
    execute: execVal === "true",
    raw: {
      APPROVED_TO_RUN_STAGING: runVal,
      APPROVED_PRODUCT_PACKAGING_BACKFILL_EXECUTE: execVal,
    },
  };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function loadAcceptedCandidates(
  dryRunDir: string,
  acceptedPath: string,
): Promise<{ headers: string[]; rows: CsvRow[] }> {
  const accepted = new Set(
    fs
      .readFileSync(acceptedPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
  if (accepted.size === 0) throw new Error("accepted-candidate-ids.txt is empty");

  const csvPath = path.join(dryRunDir, "candidate-rows.csv");
  const rl = readline.createInterface({ input: createReadStream(csvPath, "utf8"), crlfDelay: Infinity });
  let headers: string[] = [];
  const rows: CsvRow[] = [];
  let first = true;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (first) {
      headers = cols;
      first = false;
      continue;
    }
    const row: CsvRow = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    if (accepted.has(row.candidate_id ?? "")) rows.push(row);
  }
  return { headers, rows };
}

function numOrNull(v: string): number | null {
  const s = v.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v: string): number | null {
  const n = numOrNull(v);
  return n == null ? null : Math.round(n);
}

function profileKey(
  org: string,
  store: string | null,
  product: string,
  level: string,
  context: string,
): string {
  return `${org}|${store ?? ""}|${product}|${level}|${context}`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const dryRunId = dryRunIdArg();
  const apply = process.argv.includes("--apply") || process.argv.includes("--execute");
  const outBase = outBaseArg();
  const outDir = path.join(process.cwd(), outBase, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approvalPath = approvalPathArg();
  const approval = readApprovalFlags(approvalPath);
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = refFromSupabaseUrl(dbUrl) || getStagingProjectRef({ loadEnv: false });

  const dryRunDir = path.join(process.cwd(), DRY_RUN_BASE, dryRunId);
  const acceptedPath = path.join(dryRunDir, "accepted-candidate-ids.txt");

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (ref !== STAGING_REF) blockers.push(`Target must be staging ${STAGING_REF}`);
  if (originalUrl && dbUrl === originalUrl) blockers.push("Must not use ORIGINAL URL");
  if (!approval.run || !approval.execute) blockers.push("Approval flags not both true");
  if (!fs.existsSync(path.join(process.cwd(), approvalPath))) blockers.push("Missing approval file");
  if (!fs.existsSync(acceptedPath)) blockers.push(`Missing ${acceptedPath}`);
  if (!fs.existsSync(path.join(dryRunDir, "candidate-rows.csv"))) blockers.push("Missing candidate-rows.csv");

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof — PC05-EXECUTE packaging backfill",
      "",
      `Approval: \`${approvalPath}\``,
      `Dry-run: \`${dryRunId}\``,
      `Accepted list: \`accepted-candidate-ids.txt\``,
      "",
      "```text",
      `APPROVED_TO_RUN_STAGING=${approval.raw.APPROVED_TO_RUN_STAGING}`,
      `APPROVED_PRODUCT_PACKAGING_BACKFILL_EXECUTE=${approval.raw.APPROVED_PRODUCT_PACKAGING_BACKFILL_EXECUTE}`,
      "```",
      "",
      `Result: **${approval.run && approval.execute ? "APPROVED" : "BLOCKED"}**`,
    ].join("\n"),
  );

  let acceptedRows: CsvRow[] = [];
  if (blockers.length === 0) {
    try {
      acceptedRows = (await loadAcceptedCandidates(dryRunDir, acceptedPath)).rows;
      if (acceptedRows.length === 0) blockers.push("No candidate rows matched accepted-candidate-ids.txt");
    } catch (e) {
      blockers.push(e instanceof Error ? e.message : String(e));
    }
  }

  fs.copyFileSync(acceptedPath, path.join(outDir, "accepted-candidate-ids.txt"));

  const batchTag = batchTagArg(runId);
  const needsReviewOnly = forceNeedsReview();
  const insertPlan = acceptedRows.map((r) => ({
    candidate_id: r.candidate_id,
    organization_id: r.organization_id,
    store_id: r.store_id || null,
    product_id: r.product_id,
    packaging_level: r.packaging_level,
    fulfillment_context: r.fulfillment_context,
    source_type: r.source_type === "amazon_report" ? "amazon_report" : r.source_type === "import" ? "import" : "manual",
    source_reference: `${r.source_table}:${r.source_row_id}`,
    profile_status: needsReviewOnly
      ? "needs_review"
      : r.profile_status_proposed === "draft"
        ? "draft"
        : "needs_review",
    confidence_score: numOrNull(r.confidence_score),
    length_value: numOrNull(r.length_value),
    width_value: numOrNull(r.width_value),
    height_value: numOrNull(r.height_value),
    dimension_unit: r.dimension_unit?.trim() || null,
    weight_value: numOrNull(r.weight_value),
    weight_unit: r.weight_unit?.trim() || null,
    units_per_case: intOrNull(r.units_per_case),
    units_per_inner_pack: intOrNull(r.units_per_inner_pack),
    cubic_volume: numOrNull(r.cubic_volume),
    cubic_volume_unit: r.cubic_volume_unit?.trim() || null,
    blockers: r.blockers,
    recommended_action: r.recommended_action,
  }));

  fs.writeFileSync(path.join(outDir, "insert-plan.json"), JSON.stringify(insertPlan, null, 2));

  let insertedProfiles = 0;
  let insertedVersions = 0;
  let insertErrors: string[] = [];
  let skipped = 0;
  const skipReasons: Record<string, number> = {};
  const insertedIds: { candidate_id: string; profile_id: string; version_id: string }[] = [];

  if (apply && blockers.length === 0) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const existing = new Set<string>();
    const ex = await client.query(
      `SELECT organization_id::text, store_id::text, product_id::text, packaging_level, fulfillment_context
       FROM public.product_packaging_profiles`,
    );
    for (const r of ex.rows as Record<string, string | null>[]) {
      existing.add(
        profileKey(
          String(r.organization_id),
          r.store_id ? String(r.store_id) : null,
          String(r.product_id),
          String(r.packaging_level),
          String(r.fulfillment_context),
        ),
      );
    }

    for (const row of insertPlan) {
      if (row.recommended_action === "blocked") {
        skipped++;
        skipReasons.blocked = (skipReasons.blocked ?? 0) + 1;
        continue;
      }
      const key = profileKey(
        row.organization_id,
        row.store_id,
        row.product_id,
        row.packaging_level,
        row.fulfillment_context,
      );
      if (existing.has(key)) {
        skipped++;
        skipReasons.profile_exists = (skipReasons.profile_exists ?? 0) + 1;
        continue;
      }

      let evidence: Record<string, unknown> = {};
      const src = acceptedRows.find((x) => x.candidate_id === row.candidate_id);
      if (src?.evidence_summary) {
        try {
          evidence = JSON.parse(src.evidence_summary) as Record<string, unknown>;
        } catch {
          evidence = { raw: src.evidence_summary };
        }
      }
      if (row.cubic_volume != null) {
        evidence.cubic_volume = row.cubic_volume;
        evidence.cubic_volume_unit = row.cubic_volume_unit;
      }
      evidence.pc05_execute_run_id = runId;
      evidence.pc05_candidate_id = row.candidate_id;
      evidence.pc05_blockers = row.blockers;

      await client.query("BEGIN");
      try {
        const prof = await client.query(
          `INSERT INTO public.product_packaging_profiles (
             organization_id, store_id, product_id, packaging_level, fulfillment_context, display_label
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)
           RETURNING id`,
          [
            row.organization_id,
            row.store_id,
            row.product_id,
            row.packaging_level,
            row.fulfillment_context,
            batchTag,
          ],
        );
        const profileId = String(prof.rows[0].id);

        const ver = await client.query(
          `INSERT INTO public.product_packaging_profile_versions (
             profile_id, version_number, length_value, width_value, height_value, dimension_unit,
             weight_value, weight_unit, units_per_inner_pack, units_per_case,
             source_type, source_reference, confidence_score, profile_status, evidence_summary
           ) VALUES (
             $1::uuid, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb
           ) RETURNING id`,
          [
            profileId,
            row.length_value,
            row.width_value,
            row.height_value,
            row.dimension_unit,
            row.weight_value,
            row.weight_unit,
            row.units_per_inner_pack,
            row.units_per_case,
            row.source_type,
            row.source_reference,
            row.confidence_score,
            row.profile_status,
            JSON.stringify(evidence),
          ],
        );
        const versionId = String(ver.rows[0].id);
        await client.query("COMMIT");

        existing.add(key);
        insertedProfiles++;
        insertedVersions++;
        insertedIds.push({ candidate_id: row.candidate_id!, profile_id: profileId, version_id: versionId });
      } catch (e) {
        await client.query("ROLLBACK");
        skipped++;
        skipReasons.insert_error = (skipReasons.insert_error ?? 0) + 1;
        insertErrors.push(`${row.candidate_id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const curCount = await client.query(`SELECT count(*)::int c FROM public.product_packaging_dimensions_current`);
    fs.writeFileSync(
      path.join(outDir, "post-insert-counts.md"),
      [
        "# Post-insert counts",
        "",
        `- profiles inserted this run: **${insertedProfiles}**`,
        `- versions inserted this run: **${insertedVersions}**`,
        `- dimensions_current rows: **${curCount.rows[0]?.c ?? "?"}** (expect 0 — status not active)`,
        `- skipped: **${skipped}**`,
      ].join("\n"),
    );

    await client.end();
  }

  fs.writeFileSync(path.join(outDir, "insert-summary.json"), JSON.stringify({ insertedIds, skipped, skipReasons }, null, 2));

  const idempotentComplete =
    apply &&
    acceptedRows.length > 0 &&
    skipped === acceptedRows.length &&
    (skipReasons.profile_exists ?? 0) === skipped &&
    insertErrors.length === 0;
  const ok =
    apply &&
    blockers.length === 0 &&
    insertErrors.length === 0 &&
    insertedProfiles === insertedVersions &&
    (insertedProfiles > 0 || idempotentComplete);

  fs.writeFileSync(
    path.join(outDir, "execute-result.md"),
    [
      "# Execute result — PC05-EXECUTE",
      "",
      `Run: \`${runId}\``,
      `Dry-run source: \`${dryRunId}\``,
      `Apply: **${apply ? "YES" : "NO"}**`,
      "",
      `Accepted candidates: ${acceptedRows.length}`,
      `Profiles inserted: **${insertedProfiles}**`,
      `Versions inserted: **${insertedVersions}**`,
      `Skipped: **${skipped}**`,
      idempotentComplete ? `Idempotent: **YES** (all accepted profiles already on staging)` : "",
      "",
      "Skip reasons:",
      "",
      "```json",
      JSON.stringify(skipReasons, null, 2),
      "```",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- PC05-EXECUTE rollback — delete profiles tagged with display_label for this run",
      `-- Run id: ${runId}`,
      `-- Tag: ${batchTag}`,
      "",
      "BEGIN;",
      `DELETE FROM public.product_packaging_profiles WHERE display_label = '${batchTag}';`,
      "COMMIT;",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      ...(blockers.length ? blockers.map((b) => `- ${b}`) : ["None."]),
      ...(insertErrors.length ? ["", "## Insert errors", ...insertErrors.map((e) => `- ${e}`)] : []),
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PC05-EXECUTE — PRODUCT PACKAGING BACKFILL STAGING APPLY",
        run_id: runId,
        dry_run_id: dryRunId,
        branch,
        staging_ref: STAGING_REF,
        approval_valid: approval.run && approval.execute,
        applied: apply && (insertedProfiles > 0 || idempotentComplete),
        idempotent_complete: idempotentComplete,
        accepted_count: acceptedRows.length,
        inserted_profiles: insertedProfiles,
        inserted_versions: insertedVersions,
        skipped,
        batch_tag: batchTag,
        ok,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok,
        outDir,
        accepted: acceptedRows.length,
        inserted_profiles: insertedProfiles,
        inserted_versions: insertedVersions,
        skipped,
        idempotent_complete: idempotentComplete,
        blockers,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : blockers.length && !apply ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
