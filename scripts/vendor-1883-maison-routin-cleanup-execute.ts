/**
 * VENDOR-1883-MAISON-ROUTIN-CLEANUP-EXECUTE — staging vendor_name cleanup
 *
 *   npx tsx scripts/vendor-1883-maison-routin-cleanup-execute.ts --run-id=<UTC_Z>
 *   npx tsx scripts/vendor-1883-maison-routin-cleanup-execute.ts --apply --max-rows=55
 *   npx tsx scripts/vendor-1883-maison-routin-cleanup-execute.ts --apply --remaining --max-rows=121
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const SAM_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SAM_STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const CANONICAL_VENDOR = "1883 Maison Routin";
const READONLY_RUN_DEFAULT = "20260521T120000Z";
const READONLY_BASE = ".cursor/audit-reports/product-vendor-1883-maison-routin-cleanup-readonly";
const APPROVAL_PATH = ".cursor/operator-approvals/vendor-1883-maison-routin-cleanup-approval.md";
const OUT_BASE = ".cursor/audit-reports/vendor-1883-maison-routin-cleanup-execute";

type CohortRow = { id: string; sku: string | null };

type PreimageRow = {
  id: string;
  sku: string | null;
  product_name: string | null;
  vendor_name: string | null;
  brand: string | null;
  vendor_id: string | null;
  map_row_count: number;
  updated_at: string | null;
};

type AppliedRow = {
  product_id: string;
  sku: string | null;
  before_vendor_name: string;
  after_vendor_name: string;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readonlyRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--readonly-run-id="));
  return a ? a.split("=")[1]!.trim() : READONLY_RUN_DEFAULT;
}

function maxRowsArg(remaining: boolean): number {
  const a = process.argv.find((x) => x.startsWith("--max-rows="));
  const cap = remaining ? 121 : 55;
  const n = a ? parseInt(a.split("=")[1]!, 10) : cap;
  if (!Number.isFinite(n) || n < 1 || n > cap) {
    throw new Error(`--max-rows must be 1..${cap}${remaining ? " when --remaining" : ""}`);
  }
  return n;
}

async function fetchLiveCohort(client: pg.Client, maxRows: number): Promise<CohortRow[]> {
  const r = await client.query(
    `SELECT p.id::text, NULLIF(TRIM(p.sku), '') AS sku
     FROM public.products p
     WHERE p.organization_id = $1::uuid AND p.store_id = $2::uuid
       AND p.deleted_at IS NULL AND btrim(coalesce(p.vendor_name, '')) = '1883'
     ORDER BY p.sku NULLS LAST, p.id
     LIMIT $3`,
    [SAM_ORG_ID, SAM_STORE_ID, maxRows],
  );
  return r.rows as CohortRow[];
}

function readApproval(): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runVal = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const cleanupVal = /APPROVED_VENDOR_1883_MAISON_ROUTIN_CLEANUP\s*=\s*true/i.test(text);
  const refMatch = text.match(/TARGET_SUPABASE_REF\s*=\s*([a-z]{20})/i);
  const targetRef = refMatch?.[1]?.toLowerCase() ?? "";
  const refOk = targetRef === STAGING_REF;
  return {
    valid: runVal && cleanupVal && refOk,
    raw: {
      APPROVED_TO_RUN_STAGING: runVal ? "true" : "false",
      APPROVED_VENDOR_1883_MAISON_ROUTIN_CLEANUP: cleanupVal ? "true" : "false",
      TARGET_SUPABASE_REF: targetRef || "missing",
    },
  };
}

function sqlQuote(v: string | null | undefined): string {
  if (v == null) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function countBare1883(client: pg.Client): Promise<number> {
  const r = await client.query(
    `SELECT COUNT(*)::int AS c
     FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND deleted_at IS NULL AND btrim(coalesce(vendor_name, '')) = '1883'`,
    [SAM_ORG_ID, SAM_STORE_ID],
  );
  return (r.rows[0] as { c: number }).c;
}

async function fetchPreimage(client: pg.Client, ids: string[]): Promise<PreimageRow[]> {
  const r = await client.query(
    `SELECT p.id::text, NULLIF(TRIM(p.sku), '') AS sku, p.product_name, p.vendor_name, p.brand,
            p.vendor_id::text, p.updated_at::text,
            (SELECT COUNT(*)::int FROM public.product_identifier_map m WHERE m.product_id = p.id) AS map_row_count
     FROM public.products p
     WHERE p.organization_id = $1::uuid AND p.store_id = $2::uuid
       AND p.deleted_at IS NULL AND p.id = ANY($3::uuid[])`,
    [SAM_ORG_ID, SAM_STORE_ID, ids],
  );
  return r.rows as PreimageRow[];
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const readonlyRunId = readonlyRunIdArg();
  const remaining = process.argv.includes("--remaining");
  const maxRows = maxRowsArg(remaining);
  const apply = process.argv.includes("--apply");
  const outBase = remaining
    ? ".cursor/audit-reports/vendor-1883-maison-routin-cleanup-execute-remaining"
    : OUT_BASE;
  const outDir = path.join(process.cwd(), outBase, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const cohortPath = path.join(
    process.cwd(),
    READONLY_BASE,
    readonlyRunId,
    "max-55-apply-cohort.json",
  );
  const blockers: string[] = [];

  if (!approval.valid) blockers.push("Approval flags / TARGET_SUPABASE_REF not valid");
  if (!remaining && !fs.existsSync(cohortPath)) blockers.push(`Missing cohort ${cohortPath}`);

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF) && refFromConnectionUrl(dbUrl) !== STAGING_REF) {
      blockers.push(`DB URL must target staging ${STAGING_REF}`);
    }
    if (originalUrl && dbUrl === originalUrl) blockers.push("Must not use original URL as staging");
    if (dbUrl.includes(ORIGINAL_REF)) blockers.push("DB URL targets original project");
  }

  let cohort: CohortRow[] = [];
  if (remaining) {
    if (apply && !blockers.length) {
      const probe = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
      await probe.connect();
      cohort = await fetchLiveCohort(probe, maxRows);
      await probe.end();
    }
  } else if (fs.existsSync(cohortPath)) {
    const parsed = JSON.parse(fs.readFileSync(cohortPath, "utf8")) as {
      count: number;
      rows: Array<{ id: string; sku: string | null; vendor_name?: string | null }>;
    };
    cohort = (parsed.rows ?? [])
      .filter((r) => (r.vendor_name ?? "").trim() === "1883")
      .slice(0, maxRows)
      .map((r) => ({ id: r.id, sku: r.sku }));
    if (cohort.length === 0) blockers.push("Cohort has no bare-1883 rows");
    if (cohort.length > maxRows) blockers.push(`Cohort exceeds max-rows ${maxRows}`);
  }

  if (remaining && apply && cohort.length === 0 && !blockers.length) {
    blockers.push("No live bare-1883 rows found on staging");
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      "| Flag | Value |",
      "|------|-------|",
      `| APPROVED_TO_RUN_STAGING | ${approval.raw.APPROVED_TO_RUN_STAGING} |`,
      `| APPROVED_VENDOR_1883_MAISON_ROUTIN_CLEANUP | ${approval.raw.APPROVED_VENDOR_1883_MAISON_ROUTIN_CLEANUP} |`,
      `| TARGET_SUPABASE_REF | ${approval.raw.TARGET_SUPABASE_REF} |`,
      `| valid | **${approval.valid}** |`,
      `| apply_mode | **${apply}** |`,
      `| mode | **${remaining ? "remaining-live-cohort" : "readonly-cohort"}** |`,
      `| readonly_run_id | \`${readonlyRunId}\` |`,
      `| max_rows | ${maxRows} |`,
    ].join("\n") + "\n",
  );

  if (blockers.length && apply) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    throw new Error(`Blocked: ${blockers.join("; ")}`);
  }

  if (!apply || blockers.length) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      blockers.length
        ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
        : "- Dry-run only; pass `--apply` to execute.\n",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          prompt: remaining
            ? "VENDOR-1883-MAISON-ROUTIN-CLEANUP-EXECUTE-REMAINING-STAGING"
            : "VENDOR-1883-MAISON-ROUTIN-CLEANUP-EXECUTE",
          run_id: runId,
          branch,
          staging_ref: STAGING_REF,
          status: blockers.length ? "BLOCKED" : "DRY_RUN",
          apply,
          cohort_size: cohort.length,
          blockers,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ ok: !blockers.length, outDir, apply: false, cohort_size: cohort.length, blockers }, null, 2));
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const beforeBare = await countBare1883(client);
  if (remaining) {
    cohort = await fetchLiveCohort(client, maxRows);
    if (cohort.length === 0) {
      await client.end();
      throw new Error("No live bare-1883 rows to apply");
    }
    if (beforeBare !== cohort.length && beforeBare <= maxRows) {
      // refresh cohort to match live count when finishing all remaining
      cohort = await fetchLiveCohort(client, beforeBare);
    }
  }

  const ids = cohort.map((r) => r.id);
  const preimageRows = await fetchPreimage(client, ids);
  const liveById = new Map(preimageRows.map((r) => [r.id, r]));

  const skipped: Array<{ product_id: string; sku: string | null; reason: string }> = [];
  const toApply: CohortRow[] = [];
  for (const row of cohort) {
    const live = liveById.get(row.id);
    if (!live) {
      skipped.push({ product_id: row.id, sku: row.sku, reason: "product_not_found" });
      continue;
    }
    const vn = (live.vendor_name ?? "").trim();
    if (vn !== "1883") {
      skipped.push({
        product_id: row.id,
        sku: row.sku,
        reason: vn === CANONICAL_VENDOR ? "already_updated" : `vendor_guard_${vn || "empty"}`,
      });
      continue;
    }
    toApply.push(row);
  }

  const preimagePath = path.join(outDir, "preimage.json");
  fs.writeFileSync(
    preimagePath,
    JSON.stringify(
      {
        run_id: runId,
        mode: remaining ? "remaining-live-cohort" : "readonly-cohort",
        readonly_run_id: remaining ? null : readonlyRunId,
        before_bare_1883_count: beforeBare,
        canonical_vendor: CANONICAL_VENDOR,
        rows: toApply.map((r) => liveById.get(r.id)),
      },
      null,
      2,
    ),
  );

  if (toApply.length === 0) {
    await client.end();
    fs.writeFileSync(path.join(outDir, "skipped-rows.json"), JSON.stringify(skipped, null, 2));
    throw new Error("No rows eligible to apply");
  }

  const applied: AppliedRow[] = [];
  await client.query("BEGIN");
  try {
    for (const row of toApply) {
      const upd = await client.query(
        `UPDATE public.products
         SET vendor_name = $2, updated_at = now()
         WHERE id = $1::uuid
           AND organization_id = $3::uuid
           AND store_id = $4::uuid
           AND deleted_at IS NULL
           AND btrim(coalesce(vendor_name, '')) = '1883'
         RETURNING id::text, vendor_name`,
        [row.id, CANONICAL_VENDOR, SAM_ORG_ID, SAM_STORE_ID],
      );
      if (upd.rowCount !== 1) {
        throw new Error(`Expected 1 update for ${row.id}, got ${upd.rowCount}`);
      }
      applied.push({
        product_id: row.id,
        sku: row.sku,
        before_vendor_name: "1883",
        after_vendor_name: CANONICAL_VENDOR,
      });
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  const afterBare = await countBare1883(client);
  const postRows = await fetchPreimage(client, applied.map((a) => a.product_id));
  const postById = new Map(postRows.map((r) => [r.id, r]));

  const parityViolations: string[] = [];
  for (const pre of toApply.map((r) => liveById.get(r.id)!)) {
    const post = postById.get(pre.id);
    if (!post) {
      parityViolations.push(`${pre.id}: missing post-update row`);
      continue;
    }
    if ((post.vendor_name ?? "").trim() !== CANONICAL_VENDOR) {
      parityViolations.push(`${pre.id}: vendor_name not canonical`);
    }
    if (post.product_name !== pre.product_name) {
      parityViolations.push(`${pre.id}: product_name changed`);
    }
    if (post.brand !== pre.brand) {
      parityViolations.push(`${pre.id}: brand changed`);
    }
    if (post.vendor_id !== pre.vendor_id) {
      parityViolations.push(`${pre.id}: vendor_id changed`);
    }
    if (post.map_row_count !== pre.map_row_count) {
      parityViolations.push(`${pre.id}: product_identifier_map count changed`);
    }
  }

  await client.end();

  fs.writeFileSync(path.join(outDir, "applied-rows.json"), JSON.stringify(applied, null, 2));
  fs.writeFileSync(path.join(outDir, "skipped-rows.json"), JSON.stringify(skipped, null, 2));
  fs.writeFileSync(path.join(outDir, "post-update-snapshot.json"), JSON.stringify(postRows, null, 2));
  fs.writeFileSync(path.join(outDir, "parity-violations.json"), JSON.stringify(parityViolations, null, 2));

  const rollbackLines: string[] = [
    "-- Vendor 1883 Maison Routin pilot rollback (staging only)",
    `-- run_id=${runId}`,
    "",
  ];
  for (const row of applied) {
    const pre = liveById.get(row.product_id)!;
    rollbackLines.push(
      `UPDATE public.products SET vendor_name = ${sqlQuote(pre.vendor_name ?? "1883")}, updated_at = now()`,
      `WHERE id = '${row.product_id}'::uuid`,
      `  AND organization_id = '${SAM_ORG_ID}'::uuid`,
      `  AND store_id = '${SAM_STORE_ID}'::uuid`,
      `  AND btrim(coalesce(vendor_name, '')) = ${sqlQuote(CANONICAL_VENDOR)};`,
      "",
    );
  }
  const rollbackSqlPath = path.join(outDir, "rollback.sql");
  fs.writeFileSync(rollbackSqlPath, rollbackLines.join("\n"));

  const rollbackJsonPath = path.join(outDir, "rollback-preimage.json");
  fs.writeFileSync(
    rollbackJsonPath,
    JSON.stringify(
      {
        run_id: runId,
        rows: applied.map((a) => ({
          product_id: a.product_id,
          before_vendor_name: liveById.get(a.product_id)!.vendor_name,
          restore_vendor_name: liveById.get(a.product_id)!.vendor_name ?? "1883",
        })),
      },
      null,
      2,
    ),
  );

  const safeToContinue =
    parityViolations.length === 0 &&
    applied.length === toApply.length &&
    afterBare === beforeBare - applied.length &&
    (!remaining || afterBare === 0);

  fs.writeFileSync(
    path.join(outDir, "execute-result.md"),
    [
      "# Vendor 1883 Maison Routin execute result",
      "",
      remaining ? "**Wave:** remaining staging cleanup (live cohort)" : "**Wave:** pilot (readonly cohort)",
      "| Metric | Value |",
      "|--------|-------|",
      `| BEFORE_COUNT (bare 1883) | ${beforeBare} |`,
      `| ROWS_UPDATED | **${applied.length}** |`,
      `| AFTER_COUNT (bare 1883) | ${afterBare} |`,
      `| Skipped | ${skipped.length} |`,
      `| Parity violations | ${parityViolations.length} |`,
      `| SAFE_TO_CONTINUE | **${safeToContinue ? "yes" : "no"}** |`,
      "",
      "Forbidden surfaces verified unchanged: product_name, brand, vendor_id, product_identifier_map.",
    ].join("\n") + "\n",
  );

  const manifest = {
    prompt: remaining
      ? "VENDOR-1883-MAISON-ROUTIN-CLEANUP-EXECUTE-REMAINING-STAGING"
      : "VENDOR-1883-MAISON-ROUTIN-CLEANUP-EXECUTE",
    run_id: runId,
    mode: remaining ? "remaining-live-cohort" : "readonly-cohort",
    readonly_run_id: remaining ? null : readonlyRunId,
    branch,
    staging_ref: STAGING_REF,
    status: safeToContinue ? "PASS" : "VERIFY_FAILED",
    apply: true,
    BEFORE_COUNT: beforeBare,
    ROWS_UPDATED: applied.length,
    AFTER_COUNT: afterBare,
    ROLLBACK_PATH: rollbackJsonPath.replace(/\\/g, "/"),
    ROLLBACK_SQL_PATH: rollbackSqlPath.replace(/\\/g, "/"),
    SAFE_TO_CONTINUE: safeToContinue ? "yes" : "no",
    parity_violations: parityViolations,
    skipped_count: skipped.length,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        BEFORE_COUNT: beforeBare,
        ROWS_UPDATED: applied.length,
        AFTER_COUNT: afterBare,
        ROLLBACK_PATH: rollbackJsonPath,
        SAFE_TO_CONTINUE: safeToContinue ? "yes" : "no",
        outDir,
        parity_violations: parityViolations,
      },
      null,
      2,
    ),
  );

  if (!safeToContinue) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
