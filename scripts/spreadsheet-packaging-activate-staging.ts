/**
 * SPREADSHEET PACKAGING ACTIVATE STAGING — Activate review-eligible versions (approval-gated).
 *
 *   npx tsx scripts/spreadsheet-packaging-activate-staging.ts
 *   npx tsx scripts/spreadsheet-packaging-activate-staging.ts --apply
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const EXECUTE_RUN = "20260528T030000Z";
const REVIEW_RUN = "20260528T040000Z";
const EXPECTED_ELIGIBLE = 80;
const EXPECTED_CURRENT_BEFORE = 491;
const EXPECTED_CURRENT_AFTER = 571;
const BATCH_TAG = "SPREADSHEET_DIMENSIONS_20260528T010000Z";
const APPROVAL_PATH = ".cursor/operator-approvals/spreadsheet-packaging-activate-staging-approval.md";
const EXECUTE_DIR = `.cursor/audit-reports/spreadsheet-packaging-import-staging-execute/${EXECUTE_RUN}`;
const REVIEW_DIR = `.cursor/audit-reports/spreadsheet-packaging-review-census-staging/${REVIEW_RUN}`;
const OUT_BASE = ".cursor/audit-reports/spreadsheet-packaging-activate-staging";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApprovalFlags(): { run: boolean; activate: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runM = text.match(/APPROVED_TO_RUN_STAGING\s*=\s*(\S+)/);
  const actM = text.match(/APPROVED_SPREADSHEET_PACKAGING_ACTIVATE\s*=\s*(\S+)/);
  const runVal = runM?.[1] ?? "";
  const actVal = actM?.[1] ?? "";
  return {
    run: runVal === "true",
    activate: actVal === "true",
    raw: {
      APPROVED_TO_RUN_STAGING: runVal,
      APPROVED_SPREADSHEET_PACKAGING_ACTIVATE: actVal,
    },
  };
}

async function tableCounts(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(
    `SELECT
       (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles,
       (SELECT count(*)::int FROM public.product_packaging_profile_versions WHERE profile_status = 'needs_review') AS needs_review,
       (SELECT count(*)::int FROM public.product_packaging_profile_versions WHERE profile_status = 'active') AS active_versions,
       (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS dimensions_current`,
  );
  return r.rows[0] as Record<string, number>;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApprovalFlags();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = refFromSupabaseUrl(dbUrl) || getStagingProjectRef({ loadEnv: false });

  const eligiblePath = path.join(process.cwd(), REVIEW_DIR, "activate-eligible-ids.txt");
  const holdoutPath = path.join(process.cwd(), REVIEW_DIR, "holdout-ids.txt");
  const insertSummaryPath = path.join(process.cwd(), EXECUTE_DIR, "insert-summary.json");
  const executeManifestPath = path.join(process.cwd(), EXECUTE_DIR, "manifest.json");
  const reviewManifestPath = path.join(process.cwd(), REVIEW_DIR, "manifest.json");

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (ref !== STAGING_REF) blockers.push(`Target must be staging ${STAGING_REF}`);
  if (originalUrl && dbUrl === originalUrl) blockers.push("Must not use ORIGINAL URL");
  if (!approval.run || !approval.activate) blockers.push("Approval flags not both true");
  if (!fs.existsSync(eligiblePath)) blockers.push(`Missing ${eligiblePath}`);
  if (!fs.existsSync(insertSummaryPath)) blockers.push(`Missing ${insertSummaryPath}`);

  if (fs.existsSync(executeManifestPath)) {
    try {
      const em = JSON.parse(fs.readFileSync(executeManifestPath, "utf8")) as {
        ok?: boolean;
        inserted_versions?: number;
        inserted_profiles?: number;
      };
      if (!em.ok || (em.inserted_profiles ?? 0) !== EXPECTED_ELIGIBLE) {
        blockers.push("Spreadsheet execute manifest not PASS 80");
      }
    } catch {
      blockers.push("Invalid execute manifest");
    }
  } else {
    blockers.push(`Missing execute manifest: ${EXECUTE_RUN}`);
  }

  if (fs.existsSync(reviewManifestPath)) {
    try {
      const rm = JSON.parse(fs.readFileSync(reviewManifestPath, "utf8")) as {
        activate_eligible?: number;
        holdout?: number;
        blockers?: string[];
      };
      if ((rm.activate_eligible ?? 0) !== EXPECTED_ELIGIBLE) {
        blockers.push("Review manifest not PASS 80 eligible");
      }
      if ((rm.holdout ?? 0) > 0) blockers.push("Review has holdouts — resolve before activate");
      if ((rm.blockers?.length ?? 0) > 0) blockers.push("Review manifest has blockers");
    } catch {
      blockers.push("Invalid review manifest");
    }
  } else {
    blockers.push(`Missing review manifest: ${REVIEW_RUN}`);
  }

  const eligibleVersionIds = fs
    .readFileSync(eligiblePath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (eligibleVersionIds.length !== EXPECTED_ELIGIBLE) {
    blockers.push(`Expected ${EXPECTED_ELIGIBLE} eligible version ids, got ${eligibleVersionIds.length}`);
  }

  const holdoutLines = fs.existsSync(holdoutPath)
    ? fs
        .readFileSync(holdoutPath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
    : [];
  const holdoutVersionIds = holdoutLines.map((l) => l.split("\t")[0]!.trim()).filter(Boolean);

  const insertSummary = JSON.parse(fs.readFileSync(insertSummaryPath, "utf8")) as {
    insertedIds: { candidate_id: string; profile_id: string; version_id: string }[];
  };
  const allVersionIds = new Set(insertSummary.insertedIds.map((r) => r.version_id));
  for (const vid of eligibleVersionIds) {
    if (!allVersionIds.has(vid)) blockers.push(`Eligible version not in spreadsheet execute: ${vid}`);
  }

  fs.writeFileSync(path.join(outDir, "eligible-ids-used.txt"), eligibleVersionIds.join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "holdout-ids-kept.txt"), holdoutLines.join("\n") + (holdoutLines.length ? "\n" : ""));

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof — Spreadsheet packaging activate",
      "",
      `Approval: \`${APPROVAL_PATH}\``,
      `Execute run: \`${EXECUTE_RUN}\``,
      `Review run: \`${REVIEW_RUN}\``,
      `Batch tag: \`${BATCH_TAG}\``,
      "",
      "```text",
      `APPROVED_TO_RUN_STAGING=${approval.raw.APPROVED_TO_RUN_STAGING}`,
      `APPROVED_SPREADSHEET_PACKAGING_ACTIVATE=${approval.raw.APPROVED_SPREADSHEET_PACKAGING_ACTIVATE}`,
      "```",
      "",
      `Result: **${approval.run && approval.activate ? "APPROVED" : "BLOCKED"}**`,
      `Eligible versions: **${eligibleVersionIds.length}**`,
      `Holdout versions: **${holdoutVersionIds.length}**`,
    ].join("\n"),
  );

  let activated = 0;
  let snapshotPass = 0;
  const activationChecks: Record<string, unknown>[] = [];
  let preImage: Record<string, unknown> = {};
  let postImage: Record<string, unknown> = {};
  const preTargets: { version_id: string; profile_id: string; prior_status: string }[] = [];

  if (blockers.length === 0 && dbUrl) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const countsBefore = await tableCounts(client);
    preImage = { table_counts: countsBefore, eligible_version_ids: eligibleVersionIds };

    if (countsBefore.dimensions_current !== EXPECTED_CURRENT_BEFORE) {
      blockers.push(
        `dimensions_current before ${countsBefore.dimensions_current}, expected ${EXPECTED_CURRENT_BEFORE}`,
      );
    }

    for (const versionId of eligibleVersionIds) {
      const row = await client.query(
        `SELECT v.id::text AS version_id, v.profile_id::text AS profile_id, v.profile_status,
                p.display_label
         FROM public.product_packaging_profile_versions v
         INNER JOIN public.product_packaging_profiles p ON p.id = v.profile_id
         WHERE v.id = $1::uuid`,
        [versionId],
      );
      if ((row.rowCount ?? 0) === 0) {
        blockers.push(`Version not found: ${versionId}`);
        continue;
      }
      const r = row.rows[0] as {
        version_id: string;
        profile_id: string;
        profile_status: string;
        display_label: string;
      };
      if (r.display_label !== BATCH_TAG) {
        blockers.push(`Version ${versionId} not in batch ${BATCH_TAG}`);
        continue;
      }
      if (r.profile_status !== "needs_review") {
        blockers.push(`Version ${versionId} status ${r.profile_status}, expected needs_review`);
        continue;
      }
      preTargets.push({
        version_id: r.version_id,
        profile_id: r.profile_id,
        prior_status: r.profile_status,
      });
    }

    if (apply && preTargets.length === eligibleVersionIds.length && blockers.length === 0) {
      await client.query("BEGIN");
      try {
        for (const t of preTargets) {
          await client.query(
            `UPDATE public.product_packaging_profile_versions
             SET profile_status = 'active', effective_from = COALESCE(effective_from, now())
             WHERE id = $1::uuid AND profile_status = 'needs_review'`,
            [t.version_id],
          );

          const cur = await client.query(
            `SELECT current_version_id::text, profile_status
             FROM public.product_packaging_dimensions_current WHERE profile_id = $1::uuid`,
            [t.profile_id],
          );
          const snap = cur.rows[0] as { current_version_id: string; profile_status: string } | undefined;
          const ok =
            !!snap &&
            String(snap.current_version_id) === t.version_id &&
            snap.profile_status === "active";
          if (ok) {
            activated++;
            snapshotPass++;
          }
          activationChecks.push({
            version_id: t.version_id,
            profile_id: t.profile_id,
            snapshot_ok: ok,
          });
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }

    const countsAfter = await tableCounts(client);
    postImage = { table_counts: countsAfter, activation_checks_sample: activationChecks.slice(0, 5) };

    if (holdoutVersionIds.length > 0) {
      const hold = await client.query(
        `SELECT id::text, profile_status FROM public.product_packaging_profile_versions WHERE id = ANY($1::uuid[])`,
        [holdoutVersionIds],
      );
      for (const row of hold.rows as { id: string; profile_status: string }[]) {
        if (row.profile_status !== "needs_review") {
          blockers.push(`Holdout ${row.id} changed to ${row.profile_status}`);
        }
      }
    }

    await client.end();
  }

  fs.writeFileSync(
    path.join(outDir, "rollback-preimage.json"),
    JSON.stringify(
      {
        run_id: runId,
        batch_tag: BATCH_TAG,
        pre_targets: preTargets,
        table_counts_before: preImage.table_counts,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "activation-result.md"),
    [
      "# Activation result — Spreadsheet packaging",
      "",
      `Run: \`${runId}\``,
      `Apply: **${apply ? "YES" : "NO"}**`,
      "",
      "| Metric | Value |",
      "|--------|------:|",
      `| Targets (eligible) | ${preTargets.length} |`,
      `| Activated + snapshot OK | ${snapshotPass} |`,
      `| Holdout kept | ${holdoutVersionIds.length} |`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "post-activation-counts.md"),
    [
      "# Post-activation counts",
      "",
      "| Metric | Before | After |",
      "|--------|-------:|------:|",
      `| dimensions_current | ${(preImage.table_counts as Record<string, number>)?.dimensions_current ?? "?"} | ${(postImage.table_counts as Record<string, number>)?.dimensions_current ?? "?"} |`,
      `| active versions | ${(preImage.table_counts as Record<string, number>)?.active_versions ?? "?"} | ${(postImage.table_counts as Record<string, number>)?.active_versions ?? "?"} |`,
      `| needs_review versions | ${(preImage.table_counts as Record<string, number>)?.needs_review ?? "?"} | ${(postImage.table_counts as Record<string, number>)?.needs_review ?? "?"} |`,
      "",
      `Expected dimensions_current: **${EXPECTED_CURRENT_BEFORE} → ${EXPECTED_CURRENT_AFTER}** (+${EXPECTED_ELIGIBLE})`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- Spreadsheet packaging activate rollback — revert to needs_review",
      `-- Activate run: ${runId}`,
      `-- Batch: ${BATCH_TAG}`,
      "",
      "BEGIN;",
      ...preTargets.map(
        (t) =>
          `UPDATE public.product_packaging_profile_versions SET profile_status = 'needs_review' WHERE id = '${t.version_id}'::uuid;`,
      ),
      "COMMIT;",
      "",
      "-- May need manual cleanup of dimensions_current if trigger does not remove rows on revert.",
    ].join("\n"),
  );

  fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "None.");

  const ok =
    apply &&
    blockers.length === 0 &&
    activated === EXPECTED_ELIGIBLE &&
    snapshotPass === EXPECTED_ELIGIBLE &&
    (postImage.table_counts as Record<string, number>)?.dimensions_current === EXPECTED_CURRENT_AFTER;

  const nextPrompt = ok
    ? "SPREADSHEET-PACKAGING-ACTIVATE-STAGING-VERIFY — post-activate read-only census"
    : "SPREADSHEET-PACKAGING-ACTIVATE-STAGING — fix blockers and re-run --apply";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "SPREADSHEET PACKAGING ACTIVATE STAGING",
        run_id: runId,
        execute_run_id: EXECUTE_RUN,
        review_run_id: REVIEW_RUN,
        batch_tag: BATCH_TAG,
        branch,
        staging_ref: STAGING_REF,
        approval_valid: approval.run && approval.activate,
        activated_count: activated,
        holdout_count: holdoutVersionIds.length,
        dimensions_current_before: (preImage.table_counts as Record<string, number>)?.dimensions_current,
        dimensions_current_after: (postImage.table_counts as Record<string, number>)?.dimensions_current,
        rollback_path: path.join(outDir, "rollback.sql"),
        next_prompt: nextPrompt,
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
        output_directory: outDir,
        approval_valid: approval.run && approval.activate,
        activated,
        holdout: holdoutVersionIds.length,
        dimensions_current_before: (preImage.table_counts as Record<string, number>)?.dimensions_current,
        dimensions_current_after: (postImage.table_counts as Record<string, number>)?.dimensions_current,
        rollback: path.join(outDir, "rollback.sql"),
        next_prompt: nextPrompt,
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
