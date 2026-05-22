/**
 * V206 — amazon_removal_shipments orphan resolved_product_id cleanup (staging).
 *
 *   npx tsx scripts/removal-shipments-source-rpid-cleanup-v206-staging.ts --run-id=20260522T220000Z
 *   npx tsx scripts/removal-shipments-source-rpid-cleanup-v206-staging.ts --run-id=20260522T220000Z --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/v206-removal-shipments-source-rpid-cleanup";
const APPROVAL_REL = ".cursor/operator-approvals/removal-shipments-source-rpid-cleanup-v206-approval.md";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function approvalOk(): boolean {
  const p = path.join(process.cwd(), APPROVAL_REL);
  if (!fs.existsSync(p)) return false;
  return /APPROVED_TO_RUN_STAGING[\s\S]*?\|\s*`?true`?\s*\|/i.test(fs.readFileSync(p, "utf8"));
}

type PreimageRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  fnsku: string | null;
  sku: string | null;
  old_resolved_product_id: string;
  action: "remap_fnsku_map" | "remap_sku_map" | "null_orphan_rpid";
  new_resolved_product_id: string | null;
};

async function countShipmentOrphanRpid(client: pg.Client): Promise<number> {
  const res = await client.query(`
    SELECT COUNT(*)::bigint AS c FROM public.amazon_removal_shipments s
    WHERE s.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = s.resolved_product_id)
  `);
  return Number(res.rows[0]?.c ?? 0);
}

async function countValidShipmentRpid(client: pg.Client): Promise<number> {
  const res = await client.query(`
    SELECT COUNT(*)::bigint AS c FROM public.amazon_removal_shipments s
    WHERE s.resolved_product_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = s.resolved_product_id AND p.deleted_at IS NULL)
  `);
  return Number(res.rows[0]?.c ?? 0);
}

async function buildPlan(client: pg.Client): Promise<PreimageRow[]> {
  const res = await client.query(`
    WITH orphan AS (
      SELECT
        s.id,
        s.organization_id,
        s.store_id,
        nullif(btrim(s.fnsku), '') AS fnsku,
        nullif(btrim(s.sku), '') AS sku,
        s.resolved_product_id
      FROM public.amazon_removal_shipments s
      WHERE s.resolved_product_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = s.resolved_product_id)
    ),
    fnsku_pick AS (
      SELECT o.id, (array_agg(DISTINCT m.product_id))[1] AS new_pid
      FROM orphan o
      JOIN public.product_identifier_map m
        ON m.organization_id = o.organization_id AND m.store_id = o.store_id
       AND m.product_id IS NOT NULL AND btrim(m.fnsku) = o.fnsku
      JOIN public.products p ON p.id = m.product_id AND p.deleted_at IS NULL
      WHERE o.fnsku IS NOT NULL
      GROUP BY o.id
      HAVING count(DISTINCT m.product_id) = 1
    ),
    sku_pick AS (
      SELECT o.id, (array_agg(DISTINCT m.product_id))[1] AS new_pid
      FROM orphan o
      JOIN public.product_identifier_map m
        ON m.organization_id = o.organization_id AND m.store_id = o.store_id
       AND m.product_id IS NOT NULL AND btrim(m.seller_sku) = o.sku
      JOIN public.products p ON p.id = m.product_id AND p.deleted_at IS NULL
      WHERE o.sku IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fnsku_pick f WHERE f.id = o.id)
      GROUP BY o.id
      HAVING count(DISTINCT m.product_id) = 1
    )
    SELECT
      o.id::text,
      o.organization_id::text,
      o.store_id::text,
      o.fnsku,
      o.sku,
      o.resolved_product_id::text AS old_resolved_product_id,
      CASE
        WHEN f.new_pid IS NOT NULL THEN 'remap_fnsku_map'
        WHEN sk.new_pid IS NOT NULL THEN 'remap_sku_map'
        ELSE 'null_orphan_rpid'
      END AS action,
      COALESCE(f.new_pid, sk.new_pid)::text AS new_resolved_product_id
    FROM orphan o
    LEFT JOIN fnsku_pick f ON f.id = o.id
    LEFT JOIN sku_pick sk ON sk.id = o.id
    ORDER BY o.id
  `);
  return res.rows as PreimageRow[];
}

function writeRollbackSql(outDir: string, plan: PreimageRow[]): void {
  const lines = ["-- V206 rollback: amazon_removal_shipments.resolved_product_id", "BEGIN;"];
  for (const r of plan) {
    lines.push(
      `UPDATE public.amazon_removal_shipments SET resolved_product_id = '${r.old_resolved_product_id}'::uuid WHERE id = '${r.id}'::uuid;`,
    );
  }
  lines.push("COMMIT;");
  fs.writeFileSync(path.join(outDir, "rollback.sql"), lines.join("\n"), "utf8");
}

async function applyPlan(
  client: pg.Client,
  plan: PreimageRow[],
): Promise<{ remapped_fnsku: number; remapped_sku: number; nulled: number }> {
  const fnskuIds = plan.filter((r) => r.action === "remap_fnsku_map" && r.new_resolved_product_id);
  const skuIds = plan.filter((r) => r.action === "remap_sku_map" && r.new_resolved_product_id);
  const nullIds = plan.filter((r) => r.action === "null_orphan_rpid").map((r) => r.id);

  let remappedFnsku = 0;
  let remappedSku = 0;
  let nulled = 0;

  await client.query("BEGIN");
  try {
    if (fnskuIds.length > 0) {
      const CHUNK = 400;
      for (let i = 0; i < fnskuIds.length; i += CHUNK) {
        const slice = fnskuIds.slice(i, i + CHUNK);
        const res = await client.query(
          `UPDATE public.amazon_removal_shipments s
           SET resolved_product_id = v.pid
           FROM unnest($1::uuid[], $2::uuid[]) AS v(id, pid)
           INNER JOIN public.products p ON p.id = v.pid AND p.deleted_at IS NULL
           WHERE s.id = v.id
             AND s.resolved_product_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM public.products px WHERE px.id = s.resolved_product_id)
           RETURNING s.id`,
          [slice.map((r) => r.id), slice.map((r) => r.new_resolved_product_id!)],
        );
        remappedFnsku += res.rowCount ?? 0;
      }
    }

    if (skuIds.length > 0) {
      const CHUNK = 400;
      for (let i = 0; i < skuIds.length; i += CHUNK) {
        const slice = skuIds.slice(i, i + CHUNK);
        const res = await client.query(
          `UPDATE public.amazon_removal_shipments s
           SET resolved_product_id = v.pid
           FROM unnest($1::uuid[], $2::uuid[]) AS v(id, pid)
           INNER JOIN public.products p ON p.id = v.pid AND p.deleted_at IS NULL
           WHERE s.id = v.id
             AND s.resolved_product_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM public.products px WHERE px.id = s.resolved_product_id)
           RETURNING s.id`,
          [slice.map((r) => r.id), slice.map((r) => r.new_resolved_product_id!)],
        );
        remappedSku += res.rowCount ?? 0;
      }
    }

    if (nullIds.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < nullIds.length; i += CHUNK) {
        const slice = nullIds.slice(i, i + CHUNK);
        const res = await client.query(
          `UPDATE public.amazon_removal_shipments s
           SET resolved_product_id = NULL
           WHERE s.id = ANY($1::uuid[])
             AND s.resolved_product_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = s.resolved_product_id)
           RETURNING s.id`,
          [slice],
        );
        nulled += res.rowCount ?? 0;
      }
    }

    await client.query("COMMIT");
    return { remapped_fnsku: remappedFnsku, remapped_sku: remappedSku, nulled };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

async function claimUnblockEstimate(client: pg.Client) {
  const res = await client.query(`
    SELECT COUNT(*)::bigint AS c
    FROM public.claim_candidates c
    JOIN public.amazon_removal_shipments s
      ON s.id = c.source_row_id AND s.organization_id = c.organization_id
    WHERE c.source_table = 'amazon_removal_shipments'
      AND c.resolved_product_id IS NULL
      AND s.resolved_product_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = s.resolved_product_id AND p.deleted_at IS NULL)
  `);
  return Number(res.rows[0]?.c ?? 0);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const execute = hasFlag("--execute");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging guard failed (expected ${STAGING_REF})`);
  }
  if (execute && !approvalOk()) throw new Error(`Execute blocked: ${APPROVAL_REL}`);

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const preOrphan = await countShipmentOrphanRpid(client);
  const preValid = await countValidShipmentRpid(client);
  const plan = await buildPlan(client);

  const actionCounts = plan.reduce(
    (acc, r) => {
      acc[r.action] = (acc[r.action] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  fs.writeFileSync(path.join(outDir, "pk-allowlist.json"), JSON.stringify(plan.map((r) => r.id), null, 2));
  fs.writeFileSync(path.join(outDir, "rollback-preimage-rows.json"), JSON.stringify(plan, null, 2));
  writeRollbackSql(outDir, plan);

  let applied = { remapped_fnsku: 0, remapped_sku: 0, nulled: 0 };
  if (execute) applied = await applyPlan(client, plan);

  const postOrphan = execute ? await countShipmentOrphanRpid(client) : preOrphan;
  const postValid = execute ? await countValidShipmentRpid(client) : preValid;
  const claimSourceLift = execute ? await claimUnblockEstimate(client) : null;

  await client.end();

  const dryRun = {
    pre_orphan_rpid: preOrphan,
    post_orphan_rpid: postOrphan,
    pre_valid_rpid: preValid,
    post_valid_rpid: postValid,
    plan_rows: plan.length,
    action_counts: actionCounts,
    execute,
    applied,
    claim_candidates_unresolved_could_copy_valid_source_rpid: claimSourceLift,
  };

  fs.writeFileSync(path.join(outDir, "dry-run-summary.json"), JSON.stringify(dryRun, null, 2));

  const pass = execute && postOrphan === 0;
  const manifest = {
    prompt: "V206-REMOVAL-SHIPMENTS-SOURCE-RPID-CLEANUP",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: execute ? "dry_run_and_execute" : "dry_run",
    applied,
    orphan_rpid: { before: preOrphan, after: postOrphan },
    valid_rpid: { before: preValid, after: postValid },
    status: !execute ? "DRY_RUN_OK" : pass ? "PASS" : "FAIL",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "execute-summary.md"),
    [
      "# V206 — amazon_removal_shipments source RPID cleanup",
      "",
      `- run_id: \`${runId}\``,
      `- mode: ${execute ? "**execute**" : "dry-run"}`,
      "",
      "## Plan",
      `- Orphan RPID rows: **${preOrphan}**`,
      `- Remap via FNSKU map (unambiguous): **${actionCounts.remap_fnsku_map ?? 0}**`,
      `- Remap via SKU map (unambiguous): **${actionCounts.remap_sku_map ?? 0}**`,
      `- NULL (no map): **${actionCounts.null_orphan_rpid ?? 0}**`,
      "",
      execute
        ? [
            "## Applied",
            `- FNSKU remap: **${applied.remapped_fnsku}**`,
            `- SKU remap: **${applied.remapped_sku}**`,
            `- NULL: **${applied.nulled}**`,
            `- Valid source RPID after: **${postValid}**`,
            `- Orphan after: **${postOrphan}**`,
            `- Unresolved claim_candidates with valid source RPID ready: **${claimSourceLift ?? "n/a"}**`,
          ].join("\n")
        : "Run with `--execute` after approval.",
      "",
      `Status: **${manifest.status}**`,
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(manifest, null, 2));
  if (execute && !pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
