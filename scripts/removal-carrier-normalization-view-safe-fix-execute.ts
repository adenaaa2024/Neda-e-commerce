/**
 * REMOVAL CARRIER NORMALIZATION + VIEW SAFE FIX — staging execute
 *
 *   npx tsx scripts/removal-carrier-normalization-view-safe-fix-execute.ts
 *   npx tsx scripts/removal-carrier-normalization-view-safe-fix-execute.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";
import { normalizeRemovalCarrierOperational } from "../lib/pipeline/removal-carrier-normalize";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const APPROVAL_PATH =
  ".cursor/operator-approvals/removal-carrier-normalization-fix-approval.md";
const MIGRATION_PATH =
  "supabase/migrations/20260828120000_removal_carrier_normalization_views.sql";
const OUT_BASE = ".cursor/audit-reports/removal-carrier-normalization-view-safe-fix";

type ProbeRow = Record<string, number>;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runVal = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const fixVal = /APPROVED_REMOVAL_CARRIER_NORMALIZATION_FIX\s*=\s*true/i.test(text);
  return {
    valid: runVal && fixVal,
    raw: {
      APPROVED_TO_RUN_STAGING: runVal ? "true" : "false",
      APPROVED_REMOVAL_CARRIER_NORMALIZATION_FIX: fixVal ? "true" : "false",
    },
  };
}

async function countProbes(client: pg.Client): Promise<ProbeRow> {
  const r = await client.query(
    `
    SELECT
      (SELECT COUNT(*)::int FROM public.amazon_removal_shipments
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND carrier IS NOT NULL AND position(',' IN carrier) > 0) AS arms_carrier_comma,
      (SELECT COUNT(*)::int FROM public.expected_packages
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND carrier IS NOT NULL AND position(',' IN carrier) > 0) AS ep_carrier_comma,
      (SELECT COUNT(*)::int FROM public.amazon_removals
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND carrier IS NOT NULL AND position(',' IN carrier) > 0) AS ar_carrier_comma,
      (SELECT COUNT(*)::int FROM public.packages p
       WHERE p.organization_id = $1::uuid
         AND p.carrier_name IS NOT NULL AND position(',' IN p.carrier_name) > 0) AS pkg_carrier_comma,
      (SELECT COUNT(*)::int FROM public.amazon_removal_shipments s,
         LATERAL public.normalize_removal_carrier_operational(s.carrier) n
       WHERE s.organization_id = $1::uuid AND s.store_id = $2::uuid
         AND s.carrier IS NOT NULL AND n.status = 'multi_conflict') AS arms_carrier_conflict,
      (SELECT COUNT(*)::int FROM public.expected_packages ep,
         LATERAL public.normalize_removal_carrier_operational(ep.carrier) n
       WHERE ep.organization_id = $1::uuid AND ep.store_id = $2::uuid
         AND ep.carrier IS NOT NULL AND n.status = 'multi_conflict') AS ep_carrier_conflict,
      (SELECT COUNT(*)::int FROM public.v_inventory_item_status v
       WHERE v.organization_id = $1::uuid AND v.store_id = $2::uuid
         AND v.carrier IS NOT NULL AND position(',' IN v.carrier) > 0) AS view_carrier_comma
    `,
    [ORG_ID, STORE_ID],
  );
  return r.rows[0] as ProbeRow;
}

async function sampleProof(client: pg.Client): Promise<unknown[]> {
  const r = await client.query(
    `
    SELECT s.id::text, s.carrier AS before_carrier, n.operational AS after_operational, n.status
    FROM public.amazon_removal_shipments s
    CROSS JOIN LATERAL public.normalize_removal_carrier_operational(s.carrier) n
    WHERE s.organization_id = $1::uuid AND s.store_id = $2::uuid
      AND s.carrier IS NOT NULL
      AND n.status = 'deduped_repeated'
    ORDER BY length(s.carrier) DESC
    LIMIT 5
    `,
    [ORG_ID, STORE_ID],
  );
  return r.rows;
}

async function ensureCarrierSql(client: pg.Client): Promise<void> {
  const exists = await client.query(
    `SELECT 1 FROM pg_proc WHERE proname = 'normalize_removal_carrier_operational' LIMIT 1`,
  );
  if (exists.rowCount) return;
  const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION_PATH), "utf8");
  const fn = sql.match(
    /CREATE OR REPLACE FUNCTION public\.normalize_removal_carrier_operational[\s\S]*?\$carr\$;[\s\S]*?END;\s*\$carr\$;/,
  );
  if (!fn) throw new Error("Could not extract normalize_removal_carrier_operational");
  await client.query(fn[0]);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (!approval.valid) blockers.push("Approval flags not both true");

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
      blockers.push(`DB URL must target staging ${STAGING_REF}`);
    }
    if (dbUrl.includes(ORIGINAL_REF)) blockers.push("DB URL targets original — forbidden");
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      "| Flag | Value |",
      "|------|-------|",
      `| APPROVED_TO_RUN_STAGING | ${approval.raw.APPROVED_TO_RUN_STAGING} |`,
      `| APPROVED_REMOVAL_CARRIER_NORMALIZATION_FIX | ${approval.raw.APPROVED_REMOVAL_CARRIER_NORMALIZATION_FIX} |`,
      `| valid | **${approval.valid}** |`,
      "",
      "Staging Sam cohort. No Amazon API. No allocation rebuild.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "code-change-summary.md"),
    [
      "# Code change summary",
      "",
      "| File | Change |",
      "|------|--------|",
      "| `lib/pipeline/removal-carrier-normalize.ts` | Operational carrier normalize (case-insensitive dedupe) |",
      "| `lib/import-sync-mappers.ts` | Shipment + removal ingest carrier |",
      "| `lib/pipeline/removal-shipment-archive-key.ts` | Business key on normalized carrier |",
      "| `supabase/migrations/20260828120000_*` | SQL normalizer + view safe fix |",
      "| `scripts/verify-removal-carrier-normalize.ts` | Unit verify |",
    ].join("\n") + "\n",
  );

  if (!apply || blockers.length) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      blockers.length
        ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
        : "- Dry-run only; pass `--apply` for staging migration + cleanup.\n",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, ok: !blockers.length, apply: false, blockers }, null, 2) + "\n",
    );
    console.log(JSON.stringify({ ok: !blockers.length, outDir, apply: false, blockers }, null, 2));
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const migrationSql = fs.readFileSync(path.join(process.cwd(), MIGRATION_PATH), "utf8");
  await client.query(migrationSql);

  fs.writeFileSync(
    path.join(outDir, "migration-summary.md"),
    [
      "# Migration applied",
      "",
      `- File: \`${MIGRATION_PATH}\``,
      "- `normalize_removal_carrier_operational(text)`",
      "- `v_scanned_items_counted` / `v_inventory_item_status` use operational normalizers",
    ].join("\n") + "\n",
  );

  const before = await countProbes(client);
  const samplesBefore = await sampleProof(client);

  await client.query("BEGIN");
  try {
    const arms = await client.query(
      `
      WITH targets AS (
        SELECT s.id, n.operational
        FROM public.amazon_removal_shipments s
        CROSS JOIN LATERAL public.normalize_removal_carrier_operational(s.carrier) n
        WHERE s.organization_id = $1::uuid AND s.store_id = $2::uuid
          AND s.carrier IS NOT NULL
          AND n.status = 'deduped_repeated'
          AND n.operational IS NOT NULL
          AND s.carrier IS DISTINCT FROM n.operational
      )
      UPDATE public.amazon_removal_shipments ars
      SET carrier = t.operational
      FROM targets t
      WHERE ars.id = t.id
      RETURNING ars.id
      `,
      [ORG_ID, STORE_ID],
    );

    const ep = await client.query(
      `
      WITH targets AS (
        SELECT ep.id, n.operational
        FROM public.expected_packages ep
        CROSS JOIN LATERAL public.normalize_removal_carrier_operational(ep.carrier) n
        WHERE ep.organization_id = $1::uuid AND ep.store_id = $2::uuid
          AND ep.carrier IS NOT NULL
          AND n.status = 'deduped_repeated'
          AND n.operational IS NOT NULL
          AND ep.carrier IS DISTINCT FROM n.operational
      )
      UPDATE public.expected_packages e
      SET carrier = t.operational, updated_at = now()
      FROM targets t
      WHERE e.id = t.id
      RETURNING e.id
      `,
      [ORG_ID, STORE_ID],
    );

    const ar = await client.query(
      `
      WITH targets AS (
        SELECT r.id, n.operational
        FROM public.amazon_removals r
        CROSS JOIN LATERAL public.normalize_removal_carrier_operational(r.carrier) n
        WHERE r.organization_id = $1::uuid AND r.store_id = $2::uuid
          AND r.carrier IS NOT NULL
          AND n.status IN ('single', 'deduped_repeated')
          AND n.operational IS NOT NULL
          AND r.carrier IS DISTINCT FROM n.operational
      )
      UPDATE public.amazon_removals r
      SET carrier = t.operational
      FROM targets t
      WHERE r.id = t.id
      RETURNING r.id
      `,
      [ORG_ID, STORE_ID],
    );

    const pkg = await client.query(
      `
      WITH targets AS (
        SELECT p.id, n.operational
        FROM public.packages p
        CROSS JOIN LATERAL public.normalize_removal_carrier_operational(p.carrier_name) n
        WHERE p.organization_id = $1::uuid
          AND p.carrier_name IS NOT NULL
          AND position(',' IN p.carrier_name) > 0
          AND n.status = 'deduped_repeated'
          AND n.operational IS NOT NULL
          AND p.carrier_name IS DISTINCT FROM n.operational
      )
      UPDATE public.packages p
      SET carrier_name = t.operational, updated_at = now()
      FROM targets t
      WHERE p.id = t.id
      RETURNING p.id
      `,
      [ORG_ID],
    );

    await client.query("COMMIT");

    const after = await countProbes(client);
    const samplesAfter = await sampleProof(client);

    fs.writeFileSync(
      path.join(outDir, "cleanup-result.md"),
      [
        "# Cleanup result",
        "",
        "| Metric | Before | After |",
        "|--------|-------:|------:|",
        `| arms carrier comma | ${before.arms_carrier_comma} | ${after.arms_carrier_comma} |`,
        `| expected_packages carrier comma | ${before.ep_carrier_comma} | ${after.ep_carrier_comma} |`,
        `| amazon_removals carrier comma | ${before.ar_carrier_comma} | ${after.ar_carrier_comma} |`,
        `| packages carrier_name comma | ${before.pkg_carrier_comma} | ${after.pkg_carrier_comma} |`,
        `| v_inventory_item_status carrier comma | ${before.view_carrier_comma} | ${after.view_carrier_comma} |`,
        "",
        `- amazon_removal_shipments updated: **${arms.rowCount ?? 0}**`,
        `- expected_packages updated: **${ep.rowCount ?? 0}**`,
        `- amazon_removals updated: **${ar.rowCount ?? 0}**`,
        `- packages updated: **${pkg.rowCount ?? 0}**`,
        `- arms multi_conflict (unchanged op): **${after.arms_carrier_conflict}**`,
        `- ep multi_conflict: **${after.ep_carrier_conflict}**`,
        "- raw_row / raw_data: **not modified**",
      ].join("\n") + "\n",
    );

    fs.writeFileSync(
      path.join(outDir, "sample-proof.md"),
      [
        "# Sample proof",
        "",
        "## TS helper (UPS repeated)",
        "",
        "```json",
        JSON.stringify(normalizeRemovalCarrierOperational("UPS, UPS, UPS"), null, 2),
        "```",
        "",
        "## Staging dedupe candidates (before)",
        "",
        "```json",
        JSON.stringify(samplesBefore, null, 2),
        "```",
        "",
        "## After cleanup (remaining dedupe-shaped rows in DB)",
        "",
        "```json",
        JSON.stringify(samplesAfter, null, 2),
        "```",
      ].join("\n") + "\n",
    );

    fs.writeFileSync(
      path.join(outDir, "view-smoke.md"),
      [
        "# View smoke",
        "",
        "Carrier output from `v_inventory_item_status` should not contain comma lists for normalized rows.",
        "",
        "```json",
        JSON.stringify({ view_carrier_comma_before: before.view_carrier_comma, view_carrier_comma_after: after.view_carrier_comma }, null, 2),
        "```",
      ].join("\n") + "\n",
    );

    fs.writeFileSync(
      path.join(outDir, "rollback.sql"),
      [
        "-- Rollback views: re-apply supabase/migrations/20260824120000_inventory_views_neda_snapshot_v180.sql (prior split_part definitions)",
        "-- Rollback carrier columns: restore from preimage if captured; operational cleanup is one-way without preimage export.",
      ].join("\n") + "\n",
    );

    const execBlockers: string[] = [];
    if (after.arms_carrier_comma > 0) {
      execBlockers.push(`arms_carrier_comma_after=${after.arms_carrier_comma}`);
    }
    if (after.view_carrier_comma > 0) {
      execBlockers.push(`view_carrier_comma_after=${after.view_carrier_comma}`);
    }

    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      execBlockers.length ? execBlockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None\n",
    );

    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          run_id: runId,
          ok: execBlockers.length === 0,
          before,
          after,
          conflicts: {
            arms: after.arms_carrier_conflict,
            ep: after.ep_carrier_conflict,
          },
          updates: {
            arms: arms.rowCount ?? 0,
            ep: ep.rowCount ?? 0,
            ar: ar.rowCount ?? 0,
            pkg: pkg.rowCount ?? 0,
          },
          blockers: execBlockers,
        },
        null,
        2,
      ) + "\n",
    );

    console.log(
      JSON.stringify(
        {
          ok: execBlockers.length === 0,
          outDir,
          dirty_before: before.arms_carrier_comma + before.ep_carrier_comma,
          dirty_after: after.arms_carrier_comma + after.ep_carrier_comma,
          conflicts: after.arms_carrier_conflict + after.ep_carrier_conflict,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
