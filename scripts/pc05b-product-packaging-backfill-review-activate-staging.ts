/**
 * PC05B — Review + activate packaging backfill versions on staging (approval-gated).
 *
 *   npx tsx scripts/pc05b-product-packaging-backfill-review-activate-staging.ts
 *   npx tsx scripts/pc05b-product-packaging-backfill-review-activate-staging.ts --apply
 *   npx tsx scripts/pc05b-product-packaging-backfill-review-activate-staging.ts --apply --execute-run-id=20260523T215222Z
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
const EXECUTE_DEFAULT = "20260523T215222Z";
const APPROVAL_PATH_DEFAULT = ".cursor/operator-approvals/product-packaging-backfill-pc05b-activate-approval.md";
const EXECUTE_BASE = ".cursor/audit-reports/pc05-product-packaging-backfill-staging-execute";
const OUT_BASE = ".cursor/audit-reports/pc05b-product-packaging-backfill-review-activate-staging";

type VersionTarget = {
  version_id: string;
  profile_id: string;
  candidate_id: string | null;
  prior_status: string;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function executeRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--execute-run-id="));
  return a ? a.split("=")[1]!.trim() : EXECUTE_DEFAULT;
}

function approvalPathArg(): string {
  const a = process.argv.find((x) => x.startsWith("--approval-path="));
  return a ? a.split("=")[1]!.trim() : APPROVAL_PATH_DEFAULT;
}

function readApprovalFlags(approvalPath: string): { run: boolean; activate: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), approvalPath), "utf8");
  const runM = text.match(/APPROVED_TO_RUN_STAGING\s*=\s*(\S+)/);
  const actM =
    text.match(/APPROVED_PRODUCT_PACKAGING_BACKFILL_SCALE_ACTIVATE\s*=\s*(\S+)/) ??
    text.match(/APPROVED_PRODUCT_PACKAGING_BACKFILL_ACTIVATE\s*=\s*(\S+)/);
  const runVal = runM?.[1] ?? "";
  const actVal = actM?.[1] ?? "";
  return {
    run: runVal === "true",
    activate: actVal === "true",
    raw: {
      APPROVED_TO_RUN_STAGING: runVal,
      APPROVED_PRODUCT_PACKAGING_BACKFILL_ACTIVATE: actVal,
    },
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const executeRunId = executeRunIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approvalPath = approvalPathArg();
  const approval = readApprovalFlags(approvalPath);
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = refFromSupabaseUrl(dbUrl) || getStagingProjectRef({ loadEnv: false });

  const executeDir = path.join(process.cwd(), EXECUTE_BASE, executeRunId);
  const acceptedPath = path.join(executeDir, "accepted-version-ids.txt");
  const insertSummaryPath = path.join(executeDir, "insert-summary.json");
  const executeManifestPath = path.join(executeDir, "manifest.json");

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (ref !== STAGING_REF) blockers.push(`Target must be staging ${STAGING_REF}`);
  if (originalUrl && dbUrl === originalUrl) blockers.push("Must not use ORIGINAL URL");
  if (!approval.run || !approval.activate) blockers.push("Approval flags not both true");
  if (!fs.existsSync(acceptedPath)) blockers.push(`Missing ${acceptedPath}`);
  if (!fs.existsSync(insertSummaryPath)) blockers.push(`Missing ${insertSummaryPath}`);

  const executeManifest = fs.existsSync(executeManifestPath)
    ? (JSON.parse(fs.readFileSync(executeManifestPath, "utf8")) as { ok?: boolean; batch_tag?: string })
    : null;
  if (!executeManifest?.ok) blockers.push(`PC05-EXECUTE pilot not ok: ${executeRunId}`);

  const acceptedVersionIds = fs
    .readFileSync(acceptedPath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (acceptedVersionIds.length === 0) blockers.push("accepted-version-ids.txt is empty");

  const insertSummary = JSON.parse(fs.readFileSync(insertSummaryPath, "utf8")) as {
    insertedIds: { candidate_id: string; profile_id: string; version_id: string }[];
  };
  const candidateByVersion = new Map(
    insertSummary.insertedIds.map((r) => [r.version_id, r.candidate_id] as const),
  );

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof — PC05B activate",
      "",
      `Approval: \`${approvalPath}\``,
      `Pilot execute: \`${executeRunId}\``,
      `Batch tag: \`${executeManifest?.batch_tag ?? "?"}\``,
      "",
      "```text",
      `APPROVED_TO_RUN_STAGING=${approval.raw.APPROVED_TO_RUN_STAGING}`,
      `APPROVED_PRODUCT_PACKAGING_BACKFILL_ACTIVATE=${approval.raw.APPROVED_PRODUCT_PACKAGING_BACKFILL_ACTIVATE}`,
      "```",
      "",
      `Accepted version count: **${acceptedVersionIds.length}**`,
    ].join("\n"),
  );

  fs.copyFileSync(acceptedPath, path.join(outDir, "accepted-version-ids.txt"));

  let activated = 0;
  let snapshotPass = 0;
  const checks: {
    version_id: string;
    profile_id: string;
    candidate_id: string | null;
    activated: boolean;
    current_snapshot: boolean;
    current_version_match: boolean;
    detail: string;
  }[] = [];
  let preActivate: VersionTarget[] = [];

  if (blockers.length === 0) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    preActivate = [];
    for (const versionId of acceptedVersionIds) {
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
      const r = row.rows[0] as { version_id: string; profile_id: string; profile_status: string; display_label: string };
      if (executeManifest?.batch_tag && r.display_label !== executeManifest.batch_tag) {
        blockers.push(`Version ${versionId} profile display_label mismatch (not pilot batch)`);
        continue;
      }
      if (!["needs_review", "draft"].includes(String(r.profile_status))) {
        blockers.push(`Version ${versionId} status is ${r.profile_status}, expected needs_review or draft`);
        continue;
      }
      preActivate.push({
        version_id: r.version_id,
        profile_id: r.profile_id,
        candidate_id: candidateByVersion.get(r.version_id) ?? null,
        prior_status: String(r.profile_status),
      });
    }

    fs.writeFileSync(path.join(outDir, "pre-activate-targets.json"), JSON.stringify(preActivate, null, 2));

    if (apply && preActivate.length > 0 && blockers.length === 0) {
      for (const t of preActivate) {
        await client.query(
          `UPDATE public.product_packaging_profile_versions
           SET profile_status = 'active', effective_from = COALESCE(effective_from, now())
           WHERE id = $1::uuid AND profile_status IN ('needs_review', 'draft')`,
          [t.version_id],
        );

        const cur = await client.query(
          `SELECT profile_id::text, current_version_id::text, profile_status,
                  length_value, width_value, height_value, dimension_unit
           FROM public.product_packaging_dimensions_current
           WHERE profile_id = $1::uuid`,
          [t.profile_id],
        );
        const snap = cur.rows[0] as Record<string, unknown> | undefined;
        const hasSnap = !!snap;
        const versionMatch = hasSnap && String(snap.current_version_id) === t.version_id;
        const okRow = hasSnap && versionMatch && String(snap.profile_status) === "active";

        if (okRow) {
          activated++;
          snapshotPass++;
        }

        checks.push({
          version_id: t.version_id,
          profile_id: t.profile_id,
          candidate_id: t.candidate_id,
          activated: true,
          current_snapshot: hasSnap,
          current_version_match: versionMatch,
          detail: hasSnap
            ? versionMatch
              ? `active snapshot; dims L=${snap.length_value ?? "null"} W=${snap.width_value ?? "null"} H=${snap.height_value ?? "null"}`
              : "snapshot current_version_id mismatch"
            : "no product_packaging_dimensions_current row after activate",
        });
      }
    } else if (!apply) {
      for (const t of preActivate) {
        checks.push({
          version_id: t.version_id,
          profile_id: t.profile_id,
          candidate_id: t.candidate_id,
          activated: false,
          current_snapshot: false,
          current_version_match: false,
          detail: "dry-run only (--apply not set)",
        });
      }
    }

    const postCounts = await client.query(
      `SELECT
         (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles,
         (SELECT count(*)::int FROM public.product_packaging_profile_versions WHERE profile_status = 'active') AS active_versions,
         (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS current_rows`,
    );
    fs.writeFileSync(
      path.join(outDir, "post-activate-counts.md"),
      [
        "# Post-activate counts",
        "",
        `- Pilot targets: **${preActivate.length}**`,
        `- Activated + snapshot verified: **${snapshotPass}**`,
        "",
        "| Metric | Count |",
        "|--------|------:|",
        `| product_packaging_profiles | ${postCounts.rows[0]?.profiles ?? "?"} |`,
        `| active versions (all) | ${postCounts.rows[0]?.active_versions ?? "?"} |`,
        `| dimensions_current rows | ${postCounts.rows[0]?.current_rows ?? "?"} |`,
      ].join("\n"),
    );

    await client.end();
  }

  fs.writeFileSync(path.join(outDir, "activate-checks.json"), JSON.stringify(checks, null, 2));

  fs.writeFileSync(
    path.join(outDir, "snapshot-proof.md"),
    [
      "# Snapshot proof — product_packaging_dimensions_current",
      "",
      "| version_id | candidate | snapshot | version match | detail |",
      "|------------|-----------|----------|---------------|--------|",
      ...checks.map(
        (c) =>
          `| \`${c.version_id.slice(0, 8)}…\` | ${c.candidate_id ?? "—"} | ${c.current_snapshot ? "YES" : "NO"} | ${c.current_version_match ? "YES" : "NO"} | ${c.detail} |`,
      ),
      "",
      `**Overall:** ${snapshotPass}/${preActivate.length} snapshots verified`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- PC05B rollback — revert pilot versions to needs_review (removes current snapshot via trigger logic)",
      `-- Pilot execute run: ${executeRunId}`,
      "",
      "BEGIN;",
      ...preActivate.map(
        (t) =>
          `UPDATE public.product_packaging_profile_versions SET profile_status = '${t.prior_status}' WHERE id = '${t.version_id}'::uuid;`,
      ),
      "COMMIT;",
      "",
      "-- Note: dimensions_current rows for deactivated versions may remain until superseded;",
      "-- operator may DELETE FROM product_packaging_dimensions_current WHERE profile_id IN (...)",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "None.",
  );

  const ok =
    apply &&
    blockers.length === 0 &&
    preActivate.length > 0 &&
    activated === preActivate.length &&
    snapshotPass === preActivate.length;

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PC05B — PRODUCT PACKAGING BACKFILL REVIEW + ACTIVATE",
        run_id: runId,
        execute_run_id: executeRunId,
        branch,
        staging_ref: STAGING_REF,
        approval_valid: approval.run && approval.activate,
        applied: apply && activated > 0,
        targets: preActivate.length,
        activated,
        snapshot_verified: snapshotPass,
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
        targets: preActivate.length,
        activated,
        snapshot_verified: snapshotPass,
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
