/**
 * V203 — claim_candidates orphan FK remediation (staging).
 *
 *   npx tsx scripts/claim-orphan-fk-remediation-v203-staging.ts --run-id=20260522T190000Z
 *   npx tsx scripts/claim-orphan-fk-remediation-v203-staging.ts --run-id=20260522T190000Z --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/v203-claim-orphan-fk-remediation";
const APPROVAL_REL = ".cursor/operator-approvals/claim-orphan-fk-remediation-v203-approval.md";

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
  const text = fs.readFileSync(p, "utf8");
  return /APPROVED_TO_RUN_STAGING[\s\S]*?\|\s*`?true`?\s*\|/i.test(text);
}

type PreimageRow = {
  id: string;
  organization_id: string;
  source_table: string;
  source_row_id: string;
  old_resolved_product_id: string;
  action: "remap_from_source" | "null_orphan_rpid";
  new_resolved_product_id: string | null;
};

async function countOrphanFk(client: pg.Client): Promise<number> {
  const res = await client.query(`
    SELECT COUNT(*)::bigint AS c
    FROM public.claim_candidates t
    WHERE t.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = t.resolved_product_id)
  `);
  return Number(res.rows[0]?.c ?? 0);
}

async function tableCounts(client: pg.Client) {
  const res = await client.query(`
    SELECT
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS resolved,
      COUNT(*) FILTER (
        WHERE resolved_product_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = resolved_product_id AND p.deleted_at IS NULL)
      )::bigint AS strict_valid
    FROM public.claim_candidates
  `);
  const total = Number(res.rows[0]?.total ?? 0);
  const resolved = Number(res.rows[0]?.resolved ?? 0);
  const strictValid = Number(res.rows[0]?.strict_valid ?? 0);
  return {
    total,
    resolved,
    unresolved: total - resolved,
    strict_valid: strictValid,
    loose_pct: total ? Math.round((resolved / total) * 1000) / 10 : 0,
    strict_pct: total ? Math.round((strictValid / total) * 1000) / 10 : 0,
  };
}

async function buildPlan(client: pg.Client): Promise<PreimageRow[]> {
  const res = await client.query(`
    SELECT
      c.id::text AS id,
      c.organization_id::text AS organization_id,
      c.source_table,
      c.source_row_id::text AS source_row_id,
      c.resolved_product_id::text AS old_resolved_product_id,
      CASE
        WHEN c.source_table = 'amazon_removal_shipments' THEN (
          SELECT s.resolved_product_id::text
          FROM public.amazon_removal_shipments s
          INNER JOIN public.products p ON p.id = s.resolved_product_id AND p.deleted_at IS NULL
          WHERE s.id = c.source_row_id AND s.organization_id = c.organization_id
            AND s.resolved_product_id IS NOT NULL
            AND s.resolved_product_id IS DISTINCT FROM c.resolved_product_id
          LIMIT 1
        )
        WHEN c.source_table = 'amazon_returns' THEN (
          SELECT r.resolved_product_id::text
          FROM public.amazon_returns r
          INNER JOIN public.products p ON p.id = r.resolved_product_id AND p.deleted_at IS NULL
          WHERE r.id = c.source_row_id AND r.organization_id = c.organization_id
            AND r.resolved_product_id IS NOT NULL
            AND r.resolved_product_id IS DISTINCT FROM c.resolved_product_id
          LIMIT 1
        )
        ELSE NULL
      END AS remap_target
    FROM public.claim_candidates c
    WHERE c.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = c.resolved_product_id)
  `);

  return (res.rows as Array<Record<string, string | null>>).map((r) => {
    const remap = r.remap_target?.trim() || null;
    return {
      id: String(r.id),
      organization_id: String(r.organization_id),
      source_table: String(r.source_table),
      source_row_id: String(r.source_row_id),
      old_resolved_product_id: String(r.old_resolved_product_id),
      action: remap ? "remap_from_source" : "null_orphan_rpid",
      new_resolved_product_id: remap,
    };
  });
}

function writeRollbackSql(outDir: string, plan: PreimageRow[]): void {
  const lines = [
    "-- V203 rollback: restore claim_candidates.resolved_product_id from preimage",
    "BEGIN;",
  ];
  for (const r of plan) {
    const val =
      r.old_resolved_product_id === null || r.old_resolved_product_id === ""
        ? "NULL"
        : `'${r.old_resolved_product_id}'::uuid`;
    lines.push(
      `UPDATE public.claim_candidates SET resolved_product_id = ${val}, updated_at = now() WHERE id = '${r.id}'::uuid;`,
    );
  }
  lines.push("COMMIT;");
  fs.writeFileSync(path.join(outDir, "rollback.sql"), lines.join("\n"), "utf8");
}

async function applyPlan(client: pg.Client, plan: PreimageRow[]): Promise<{ remapped: number; nulled: number }> {
  const remapRows = plan.filter((r) => r.action === "remap_from_source" && r.new_resolved_product_id);
  const nullIds = plan.filter((r) => r.action === "null_orphan_rpid").map((r) => r.id);

  let remapped = 0;
  await client.query("BEGIN");
  try {
    const CHUNK = 250;
    for (let i = 0; i < remapRows.length; i += CHUNK) {
      const slice = remapRows.slice(i, i + CHUNK);
      const ids = slice.map((r) => r.id);
      const pids = slice.map((r) => r.new_resolved_product_id!);
      const res = await client.query(
        `UPDATE public.claim_candidates t
         SET resolved_product_id = v.product_id, updated_at = now()
         FROM unnest($1::uuid[], $2::uuid[]) AS v(id, product_id)
         INNER JOIN public.products p ON p.id = v.product_id AND p.deleted_at IS NULL
         WHERE t.id = v.id
           AND t.resolved_product_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.products px WHERE px.id = t.resolved_product_id)
         RETURNING t.id::text`,
        [ids, pids],
      );
      remapped += res.rowCount ?? 0;
    }

    let nulled = 0;
    for (let i = 0; i < nullIds.length; i += CHUNK) {
      const slice = nullIds.slice(i, i + CHUNK);
      const res = await client.query(
        `UPDATE public.claim_candidates t
         SET resolved_product_id = NULL, updated_at = now()
         WHERE t.id = ANY($1::uuid[])
           AND t.resolved_product_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = t.resolved_product_id)
         RETURNING t.id::text`,
        [slice],
      );
      nulled += res.rowCount ?? 0;
    }

    await client.query("COMMIT");
    return { remapped, nulled };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
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
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF}, got ${ref ?? "unset"})`);
  }

  if (execute && !approvalOk()) {
    throw new Error(`Execute blocked: missing or false ${APPROVAL_REL}`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const preCounts = await tableCounts(client);
  const preOrphan = await countOrphanFk(client);
  const plan = await buildPlan(client);

  const actionCounts = plan.reduce(
    (acc, r) => {
      acc[r.action] = (acc[r.action] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  fs.writeFileSync(
    path.join(outDir, "rollback-preimage-rows.json"),
    JSON.stringify(
      plan.map((r) => ({
        id: r.id,
        old_resolved_product_id: r.old_resolved_product_id,
        action: r.action,
        new_resolved_product_id: r.new_resolved_product_id,
      })),
      null,
      2,
    ),
  );
  writeRollbackSql(outDir, plan);

  let applied = { remapped: 0, nulled: 0 };
  if (execute) {
    applied = await applyPlan(client, plan);
  }

  const postOrphan = execute ? await countOrphanFk(client) : preOrphan;
  const postCounts = execute ? await tableCounts(client) : null;
  await client.end();

  const dryRun = {
    orphan_fk_before: preOrphan,
    plan_rows: plan.length,
    action_counts: actionCounts,
    execute,
    applied,
    orphan_fk_after: postOrphan,
  };

  fs.writeFileSync(path.join(outDir, "dry-run-summary.json"), JSON.stringify(dryRun, null, 2));
  fs.writeFileSync(path.join(outDir, "pre-counts.json"), JSON.stringify(preCounts, null, 2));
  if (postCounts) fs.writeFileSync(path.join(outDir, "post-counts.json"), JSON.stringify(postCounts, null, 2));

  const status =
    execute && postOrphan === 0 ? "PASS" : execute && postOrphan > 0 ? "FAIL" : "DRY_RUN_OK";

  const manifest = {
    prompt: "V203-CLAIM-ORPHAN-FK-REMEDIATION",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: execute ? "dry_run_and_execute" : "dry_run",
    approval_file: APPROVAL_REL,
    pre_counts: preCounts,
    post_counts: postCounts,
    orphan_fk: { before: preOrphan, after: postOrphan },
    applied,
    status,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "execute-summary.md"),
    [
      "# V203 — claim_candidates orphan FK remediation",
      "",
      `- run_id: \`${runId}\``,
      `- staging: \`${STAGING_REF}\``,
      `- mode: ${execute ? "**execute**" : "dry-run"}`,
      "",
      "## Plan",
      `- Orphan FK rows: **${preOrphan}**`,
      `- Remap from valid source RPID: **${actionCounts.remap_from_source ?? 0}**`,
      `- NULL orphan RPID: **${actionCounts.null_orphan_rpid ?? 0}**`,
      "",
      execute
        ? [
            "## Applied",
            `- Remapped: **${applied.remapped}**`,
            `- Nulled: **${applied.nulled}**`,
            `- Orphan FK after: **${postOrphan}**`,
            `- Loose resolved: ${preCounts.resolved} → ${postCounts?.resolved ?? "n/a"} / ${preCounts.total}`,
            `- Strict valid: ${preCounts.strict_valid} → ${postCounts?.strict_valid ?? "n/a"}`,
          ].join("\n")
        : "## Next",
        "Run with `--execute` after operator approval.",
      "",
      `Status: **${status}**`,
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(manifest, null, 2));
  if (execute && postOrphan > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
