/**
 * PC05G-WAVE3-ORIGINAL-EXECUTE — Apply Wave 3 packaging parity to original/current (approval-gated).
 *
 *   npx tsx scripts/pc05g-wave3-original-parity-execute.ts --apply
 *   npx tsx scripts/pc05g-wave3-original-parity-execute.ts --apply --plan-run-id=20260527T170000Z
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const APPROVAL_PATH = ".cursor/operator-approvals/product-packaging-wave3-original-parity-pc05g-approval.md";
const PLAN_BASE = ".cursor/audit-reports/pc05g-wave3-original-parity-plan";
const OUT_BASE = ".cursor/audit-reports/pc05g-wave3-original-parity-execute";
const EXPECTED_ROWS = 50;
const EXPECTED_CURRENT_BEFORE = 441;
const EXPECTED_CURRENT_AFTER = 491;

const PACKAGING_TABLES = [
  "product_packaging_profiles",
  "product_packaging_profile_versions",
  "product_packaging_dimensions_current",
  "product_packaging_evidence",
] as const;

type InsertPlanRow = {
  candidate_id: string;
  composite_key: string;
  organization_id: string;
  store_id: string | null;
  product_id: string;
  packaging_level: string;
  fulfillment_context: string;
  profile_status: string;
  length_value: number | null;
  width_value: number | null;
  height_value: number | null;
  dimension_unit: string | null;
  weight_value: number | null;
  weight_unit: string | null;
  units_per_inner_pack: number | null;
  units_per_case: number | null;
  source_type: string;
  source_reference: string | null;
  confidence_score: number | null;
  evidence_summary: Record<string, unknown>;
  display_label?: string;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function planRunIdArg(): string | null {
  const a = process.argv.find((x) => x.startsWith("--plan-run-id="));
  return a ? a.split("=")[1]!.trim() : null;
}

function latestPlanRunId(): string | null {
  const base = path.join(process.cwd(), PLAN_BASE);
  if (!fs.existsSync(base)) return null;
  return (
    fs
      .readdirSync(base)
      .filter((d) => {
        const p = path.join(base, d, "manifest.json");
        const ip = path.join(base, d, "original-insert-plan.json");
        if (!fs.existsSync(p) || !fs.existsSync(ip)) return false;
        try {
          const m = JSON.parse(fs.readFileSync(p, "utf8")) as { ok?: boolean; insert_plan_rows?: number };
          return m.ok && (m.insert_plan_rows ?? 0) === EXPECTED_ROWS;
        } catch {
          return false;
        }
      })
      .sort()
      .reverse()[0] ?? null
  );
}

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function readApprovalFlags(): { run: boolean; parity: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runM = text.match(/APPROVED_TO_RUN_ORIGINAL\s*=\s*(\S+)/);
  const parM = text.match(/APPROVED_PRODUCT_PACKAGING_WAVE3_ORIGINAL_PARITY\s*=\s*(\S+)/);
  const runVal = runM?.[1] ?? "";
  const parVal = parM?.[1] ?? "";
  return {
    run: runVal === "true",
    parity: parVal === "true",
    raw: {
      APPROVED_TO_RUN_ORIGINAL: runVal,
      APPROVED_PRODUCT_PACKAGING_WAVE3_ORIGINAL_PARITY: parVal,
    },
  };
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

async function capturePreimage(client: pg.Client): Promise<Record<string, unknown>> {
  const counts: Record<string, number> = {};
  for (const t of PACKAGING_TABLES) {
    const r = await client.query(`SELECT count(*)::int c FROM public.${t}`);
    counts[t] = r.rows[0]?.c ?? 0;
  }
  return { table_counts: counts };
}

async function tablesExist(client: pg.Client): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const t of PACKAGING_TABLES) {
    const r = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
      [t],
    );
    out[t] = (r.rowCount ?? 0) > 0;
  }
  return out;
}

type SmokeReport = { pass: boolean; checked: number; failures: string[] };

async function runPostInsertSmoke(
  client: pg.Client,
  batchTag: string,
  insertedIds: { candidate_id: string; profile_id: string; version_id: string }[],
  executeRunId: string,
): Promise<SmokeReport> {
  const failures: string[] = [];
  const sample = insertedIds.slice(0, 5);
  for (const row of sample.length ? sample : insertedIds.slice(0, 1)) {
    const prof = await client.query(
      `SELECT display_label FROM public.product_packaging_profiles WHERE id = $1::uuid`,
      [row.profile_id],
    );
    if ((prof.rowCount ?? 0) !== 1 || String(prof.rows[0].display_label) !== batchTag) {
      failures.push(`${row.candidate_id}: profile/tag mismatch`);
    }
    const ver = await client.query(
      `SELECT profile_status, evidence_summary->>'pc05_candidate_id' AS cid,
              evidence_summary->>'pc05g_original_execute_run_id' AS exec_run
       FROM public.product_packaging_profile_versions WHERE id = $1::uuid`,
      [row.version_id],
    );
    if ((ver.rowCount ?? 0) !== 1) failures.push(`${row.candidate_id}: version missing`);
    else {
      if (ver.rows[0].profile_status !== "active") failures.push(`${row.candidate_id}: not active`);
      if (ver.rows[0].cid !== row.candidate_id) failures.push(`${row.candidate_id}: candidate_id mismatch`);
      if (ver.rows[0].exec_run !== executeRunId) failures.push(`${row.candidate_id}: missing pc05g execute run id`);
    }
    const cur = await client.query(
      `SELECT current_version_id::text FROM public.product_packaging_dimensions_current WHERE profile_id = $1::uuid`,
      [row.profile_id],
    );
    if ((cur.rowCount ?? 0) !== 1 || String(cur.rows[0].current_version_id) !== row.version_id) {
      failures.push(`${row.candidate_id}: dimensions_current mismatch`);
    }
  }
  const tagged = await client.query(
    `SELECT count(*)::int c FROM public.product_packaging_profiles WHERE display_label = $1`,
    [batchTag],
  );
  if ((tagged.rows[0]?.c ?? 0) < insertedIds.length && insertedIds.length > 0) {
    failures.push(`tagged count ${tagged.rows[0]?.c} < inserted ${insertedIds.length}`);
  }
  return { pass: failures.length === 0, checked: sample.length || insertedIds.length, failures };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const planRunId = planRunIdArg() ?? latestPlanRunId();
  if (!planRunId) {
    console.error(JSON.stringify({ ok: false, error: "No Wave 3 original parity plan found" }));
    process.exit(1);
  }
  const apply = process.argv.includes("--apply") || process.argv.includes("--execute");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const batchTag = `PC05G_WAVE3_ORIGINAL_${runId}`;
  const planPath = path.join(process.cwd(), PLAN_BASE, planRunId, "original-insert-plan.json");
  const planManifestPath = path.join(process.cwd(), PLAN_BASE, planRunId, "manifest.json");

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApprovalFlags();
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalRef = refFromConnectionUrl(originalUrl);

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (originalRef !== ORIGINAL_REF) blockers.push(`ORIGINAL must be ${ORIGINAL_REF}`);
  if (stagingUrl && originalUrl === stagingUrl) blockers.push("Must not use staging URL");
  if (!approval.run || !approval.parity) blockers.push("Approval flags not both true");
  if (!fs.existsSync(planPath)) blockers.push(`Missing plan: ${planPath}`);

  let insertPlan: InsertPlanRow[] = [];
  if (fs.existsSync(planPath)) {
    insertPlan = JSON.parse(fs.readFileSync(planPath, "utf8")) as InsertPlanRow[];
    if (insertPlan.length !== EXPECTED_ROWS) {
      blockers.push(`Expected ${EXPECTED_ROWS} insert rows, got ${insertPlan.length}`);
    }
  }
  if (fs.existsSync(planManifestPath)) {
    const pm = JSON.parse(fs.readFileSync(planManifestPath, "utf8")) as {
      counts?: { conflict?: number; unsafe?: number };
    };
    if ((pm.counts?.conflict ?? 0) > 0) blockers.push("Plan has conflicts");
    if ((pm.counts?.unsafe ?? 0) > 0) blockers.push("Plan has unsafe rows");
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof — PC05G Wave 3 original execute",
      "",
      `File: \`${APPROVAL_PATH}\``,
      "```text",
      `APPROVED_TO_RUN_ORIGINAL=${approval.raw.APPROVED_TO_RUN_ORIGINAL}`,
      `APPROVED_PRODUCT_PACKAGING_WAVE3_ORIGINAL_PARITY=${approval.raw.APPROVED_PRODUCT_PACKAGING_WAVE3_ORIGINAL_PARITY}`,
      "```",
      `Result: **${approval.run && approval.parity ? "APPROVED" : "BLOCKED"}**`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "plan-used.md"),
    [
      "# Plan used",
      "",
      `Plan: \`${planRunId}\``,
      `Rows: **${insertPlan.length}**`,
      `Batch tag: \`${batchTag}\``,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- PC05G Wave 3 original parity rollback",
      `DELETE FROM public.product_packaging_profiles WHERE display_label = '${batchTag}';`,
    ].join("\n"),
  );

  let preimage: Record<string, unknown> = {};
  let insertedProfiles = 0;
  let insertedVersions = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};
  const insertErrors: string[] = [];
  const insertedIds: { candidate_id: string; profile_id: string; version_id: string }[] = [];
  let postCounts = { profiles: 0, versions: 0, current: 0 };
  let smoke: SmokeReport = { pass: false, checked: 0, failures: ["not run"] };

  const hardBlockers = [...blockers];
  if (apply && hardBlockers.length === 0 && originalUrl) {
    const client = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    for (const t of PACKAGING_TABLES) {
      if (!(await tablesExist(client))[t]) hardBlockers.push(`Missing table: ${t}`);
    }

    preimage = await capturePreimage(client);
    fs.writeFileSync(path.join(outDir, "original-preimage.json"), JSON.stringify(preimage, null, 2));

    const beforeCurrent =
      (preimage.table_counts as Record<string, number>)?.product_packaging_dimensions_current ?? 0;
    if (beforeCurrent !== EXPECTED_CURRENT_BEFORE && beforeCurrent !== EXPECTED_CURRENT_AFTER) {
      hardBlockers.push(
        `dimensions_current before ${beforeCurrent}, expected ${EXPECTED_CURRENT_BEFORE} or idempotent ${EXPECTED_CURRENT_AFTER}`,
      );
    }

    if (hardBlockers.length === 0) {
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

        const evidence = {
          ...row.evidence_summary,
          pc05_candidate_id: row.candidate_id,
          pc05g_original_execute_run_id: runId,
          pc05g_wave3_original_batch_tag: batchTag,
          mirrored_from: STAGING_REF,
        };

        await client.query("BEGIN");
        try {
          const prof = await client.query(
            `INSERT INTO public.product_packaging_profiles (
               organization_id, store_id, product_id, packaging_level, fulfillment_context, display_label
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6) RETURNING id`,
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
               source_type, source_reference, confidence_score, profile_status, evidence_summary, effective_from
             ) VALUES ($1::uuid, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, now())
             RETURNING id`,
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
              "active",
              JSON.stringify(evidence),
            ],
          );
          const versionId = String(ver.rows[0].id);
          await client.query("COMMIT");
          existing.add(key);
          insertedProfiles++;
          insertedVersions++;
          insertedIds.push({ candidate_id: row.candidate_id, profile_id: profileId, version_id: versionId });
        } catch (e) {
          await client.query("ROLLBACK");
          skipped++;
          skipReasons.insert_error = (skipReasons.insert_error ?? 0) + 1;
          insertErrors.push(`${row.candidate_id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const pc = await client.query(
        `SELECT
           (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles,
           (SELECT count(*)::int FROM public.product_packaging_profile_versions) AS versions,
           (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS current`,
      );
      postCounts = pc.rows[0] as typeof postCounts;

      const idempotentComplete =
        skipped === insertPlan.length &&
        (skipReasons.profile_exists ?? 0) === skipped &&
        insertErrors.length === 0;

      if (insertedIds.length > 0) {
        smoke = await runPostInsertSmoke(client, batchTag, insertedIds, runId);
      } else if (idempotentComplete) {
        const tagged = await client.query(
          `SELECT p.id::text AS profile_id, v.id::text AS version_id,
                  v.evidence_summary->>'pc05_candidate_id' AS candidate_id
           FROM public.product_packaging_profiles p
           JOIN public.product_packaging_profile_versions v ON v.profile_id = p.id
           WHERE p.display_label = $1 LIMIT 5`,
          [batchTag],
        );
        const ids = tagged.rows as { candidate_id: string; profile_id: string; version_id: string }[];
        smoke = await runPostInsertSmoke(client, batchTag, ids.filter((r) => r.candidate_id), runId);
      }
      if (insertedIds.length > 0 || idempotentComplete) {
        smoke.pass = smoke.pass && postCounts.current >= EXPECTED_CURRENT_AFTER;
        if (postCounts.current < EXPECTED_CURRENT_AFTER) {
          smoke.failures.push(`dimensions_current ${postCounts.current} < ${EXPECTED_CURRENT_AFTER}`);
        }
      }
    }
    await client.end();
  } else if (originalUrl && !apply) {
    const client = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    preimage = await capturePreimage(client);
    fs.writeFileSync(path.join(outDir, "original-preimage.json"), JSON.stringify(preimage, null, 2));
    await client.end();
  }

  const idempotentComplete =
    apply &&
    insertPlan.length > 0 &&
    skipped === insertPlan.length &&
    (skipReasons.profile_exists ?? 0) === skipped &&
    insertErrors.length === 0;

  fs.writeFileSync(
    path.join(outDir, "inserted-summary.json"),
    JSON.stringify({ insertedIds, skipped, skipReasons, insertErrors }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "execute-result.md"),
    [
      "# Execute result — PC05G Wave 3 original",
      "",
      `Apply: **${apply ? "YES" : "NO"}**`,
      `Profiles inserted: **${insertedProfiles}**`,
      `Versions inserted: **${insertedVersions}**`,
      `Skipped: **${skipped}**`,
      idempotentComplete ? "Idempotent: YES" : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, "post-insert-counts.md"),
    [
      "# Post-insert counts",
      "",
      "| Table | Before | After |",
      "|-------|-------:|------:|",
      `| profiles | ${(preimage.table_counts as Record<string, number>)?.product_packaging_profiles ?? "?"} | ${postCounts.profiles} |`,
      `| dimensions_current | ${(preimage.table_counts as Record<string, number>)?.product_packaging_dimensions_current ?? "?"} | ${postCounts.current} |`,
      "",
      `Expected current after: **${EXPECTED_CURRENT_AFTER}** (441 + 50 Wave 3)`,
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, "smoke-result.md"),
    smoke.failures.length
      ? [`**Pass:** ${smoke.pass ? "YES" : "NO"}`, "", ...smoke.failures.map((f) => `- ${f}`)].join("\n")
      : `**Pass:** ${smoke.pass ? "YES" : "NO"}\n\nAll checks passed.`,
  );
  fs.writeFileSync(path.join(outDir, "blockers.md"), hardBlockers.length ? hardBlockers.map((b) => `- ${b}`).join("\n") : "None.");

  const ok =
    apply &&
    hardBlockers.length === 0 &&
    insertErrors.length === 0 &&
    smoke.pass &&
    insertedProfiles === insertedVersions &&
    (insertedProfiles > 0 || idempotentComplete) &&
    postCounts.current === EXPECTED_CURRENT_AFTER;

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PC05G-WAVE3-ORIGINAL-EXECUTE",
        run_id: runId,
        plan_run_id: planRunId,
        approval_valid: approval.run && approval.parity,
        inserted_profiles: insertedProfiles,
        inserted_versions: insertedVersions,
        skipped_existing: skipped,
        dimensions_current_before: (preimage.table_counts as Record<string, number>)?.product_packaging_dimensions_current,
        dimensions_current_after: postCounts.current,
        smoke_pass: smoke.pass,
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
        approval_valid: approval.run && approval.parity,
        plan_run_id: planRunId,
        inserted_profiles: insertedProfiles,
        inserted_versions: insertedVersions,
        skipped_existing: skipped,
        dimensions_current_before: (preimage.table_counts as Record<string, number>)?.product_packaging_dimensions_current,
        dimensions_current_after: postCounts.current,
        smoke_pass: smoke.pass,
        rollback: path.join(outDir, "rollback.sql"),
        blockers: hardBlockers,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : hardBlockers.length && !apply ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
