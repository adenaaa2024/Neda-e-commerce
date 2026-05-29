/**
 * VENDOR-1883-CLEANUP-STAGING-EXECUTE — products.vendor_name cleanup (staging only)
 *
 *   npx tsx scripts/vendor-1883-cleanup-staging-execute.ts --run-id=<UTC_Z>
 *   npx tsx scripts/vendor-1883-cleanup-staging-execute.ts --apply --plan-run-id=20260528T120000Z
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

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const SAM_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SAM_STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const PLAN_DEFAULT = "20260528T120000Z";
const PLAN_BASE = ".cursor/audit-reports/vendor-1883-cleanup-plan-review";
const APPROVAL_PATH = ".cursor/operator-approvals/vendor-1883-cleanup-staging-approval.md";
const OUT_BASE = ".cursor/audit-reports/vendor-1883-cleanup-staging-execute";

type PlanRow = {
  product_id: string;
  seller_sku: string;
  sheet_row: number;
  sheet_brand: string;
  proposed_vendor_name: string;
  before_vendor_name: string;
  after_vendor_name: string;
};

type SkipRow = {
  product_id: string;
  seller_sku: string;
  reason: string;
};

type AppliedRow = {
  product_id: string;
  seller_sku: string;
  before_vendor_name: string;
  after_vendor_name: string;
  sheet_brand: string;
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

function planRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--plan-run-id="));
  return a ? a.split("=")[1]!.trim() : PLAN_DEFAULT;
}

function readApproval(): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runVal = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const cleanupVal = /APPROVED_VENDOR_1883_CLEANUP\s*=\s*true/i.test(text);
  return {
    valid: runVal && cleanupVal,
    raw: {
      APPROVED_TO_RUN_STAGING: runVal ? "true" : "false",
      APPROVED_VENDOR_1883_CLEANUP: cleanupVal ? "true" : "false",
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

async function main(): Promise<void> {
  const runId = runIdArg();
  const planRunId = planRunIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const planPath = path.join(process.cwd(), PLAN_BASE, planRunId, "deterministic-update-plan.json");
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}, got ${branch}`);
  if (!approval.valid) blockers.push("Approval flags not both true");
  if (!fs.existsSync(planPath)) blockers.push(`Missing plan ${planPath}`);

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
      blockers.push(`DB URL must target staging ${STAGING_REF}`);
    }
    if (originalUrl && dbUrl === originalUrl) blockers.push("Must not use original URL as staging");
    if (dbUrl.includes(ORIGINAL_REF)) blockers.push("DB URL targets original project");
  }
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (supaUrl && refFromSupabaseUrl(supaUrl) !== STAGING_REF) {
    blockers.push(`NEXT_PUBLIC_SUPABASE_URL must be staging ${STAGING_REF}`);
  }

  let planRows: PlanRow[] = [];
  if (fs.existsSync(planPath)) {
    const parsed = JSON.parse(fs.readFileSync(planPath, "utf8")) as {
      count: number;
      rows: PlanRow[];
    };
    planRows = parsed.rows ?? [];
    if (planRows.length !== 454) {
      blockers.push(`Expected 454 plan rows, got ${planRows.length}`);
    }
    const badBrand = planRows.filter(
      (r) => r.proposed_vendor_name !== r.sheet_brand || r.after_vendor_name !== r.sheet_brand,
    );
    if (badBrand.length) blockers.push(`${badBrand.length} rows with proposed != sheet_brand`);
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      `| Flag | Value |`,
      `|------|-------|`,
      `| APPROVED_TO_RUN_STAGING | ${approval.raw.APPROVED_TO_RUN_STAGING} |`,
      `| APPROVED_VENDOR_1883_CLEANUP | ${approval.raw.APPROVED_VENDOR_1883_CLEANUP} |`,
      `| approval_file | \`${APPROVAL_PATH}\` |`,
      `| valid | **${approval.valid}** |`,
      `| apply_mode | **${apply}** |`,
      `| plan_run_id | \`${planRunId}\` |`,
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
          prompt: "VENDOR-1883-CLEANUP-STAGING-EXECUTE",
          run_id: runId,
          plan_run_id: planRunId,
          branch,
          staging_ref: STAGING_REF,
          status: blockers.length ? "BLOCKED" : "DRY_RUN",
          apply,
          plan_row_count: planRows.length,
          blockers,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify(
        {
          ok: !blockers.length,
          outDir,
          apply: false,
          plan_row_count: planRows.length,
          blockers,
        },
        null,
        2,
      ),
    );
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const beforeBare = await countBare1883(client);
  const ids = planRows.map((r) => r.product_id);

  const preimageRes = await client.query(
    `SELECT id::text, sku, asin, vendor_name, updated_at::text
     FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND deleted_at IS NULL AND id = ANY($3::uuid[])`,
    [SAM_ORG_ID, SAM_STORE_ID, ids],
  );
  const liveById = new Map(
    (preimageRes.rows as Array<Record<string, unknown>>).map((r) => [String(r.id), r]),
  );

  const skipped: SkipRow[] = [];
  const toApply: PlanRow[] = [];
  for (const row of planRows) {
    const live = liveById.get(row.product_id);
    if (!live) {
      skipped.push({ product_id: row.product_id, seller_sku: row.seller_sku, reason: "product_not_found" });
      continue;
    }
    const vn = String(live.vendor_name ?? "").trim();
    if (vn !== "1883") {
      skipped.push({
        product_id: row.product_id,
        seller_sku: row.seller_sku,
        reason: vn === row.proposed_vendor_name ? "already_updated" : `vendor_guard_${vn || "empty"}`,
      });
      continue;
    }
    if (row.proposed_vendor_name !== row.sheet_brand) {
      skipped.push({
        product_id: row.product_id,
        seller_sku: row.seller_sku,
        reason: "proposed_not_sheet_brand",
      });
      continue;
    }
    toApply.push(row);
  }

  fs.writeFileSync(
    path.join(outDir, "preimage.json"),
    JSON.stringify(
      {
        run_id: runId,
        plan_run_id: planRunId,
        before_bare_1883_count: beforeBare,
        rows: toApply.map((r) => liveById.get(r.product_id)),
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
        [row.product_id, row.sheet_brand, SAM_ORG_ID, SAM_STORE_ID],
      );
      if (upd.rowCount !== 1) {
        throw new Error(`Expected 1 update for ${row.product_id}, got ${upd.rowCount}`);
      }
      applied.push({
        product_id: row.product_id,
        seller_sku: row.seller_sku,
        before_vendor_name: "1883",
        after_vendor_name: row.sheet_brand,
        sheet_brand: row.sheet_brand,
      });
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  const afterBare = await countBare1883(client);
  await client.end();

  fs.writeFileSync(path.join(outDir, "applied-rows.json"), JSON.stringify(applied, null, 2));
  fs.writeFileSync(path.join(outDir, "skipped-rows.json"), JSON.stringify(skipped, null, 2));

  const rollbackLines: string[] = [
    "-- Vendor 1883 cleanup rollback (staging only)",
    `-- run_id=${runId}`,
    `-- plan_run_id=${planRunId}`,
    "",
  ];
  for (const row of applied) {
    const pre = liveById.get(row.product_id)!;
    rollbackLines.push(
      `UPDATE public.products SET vendor_name = ${sqlQuote(String(pre.vendor_name ?? "1883"))}, updated_at = now()`,
      `WHERE id = '${row.product_id}'::uuid`,
      `  AND organization_id = '${SAM_ORG_ID}'::uuid`,
      `  AND store_id = '${SAM_STORE_ID}'::uuid`,
      `  AND btrim(coalesce(vendor_name, '')) = ${sqlQuote(row.after_vendor_name)};`,
      "",
    );
  }
  const rollbackPath = path.join(outDir, "rollback.sql");
  fs.writeFileSync(rollbackPath, rollbackLines.join("\n"));

  const nextPrompt = "VENDOR-1883-CLEANUP-STAGING-VERIFY — confirm bare 1883 count = 0 on staging";

  fs.writeFileSync(
    path.join(outDir, "execute-result.md"),
    [
      "# Vendor 1883 cleanup execute result",
      "",
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Plan rows | ${planRows.length} |`,
      `| Updated | **${applied.length}** |`,
      `| Skipped | **${skipped.length}** |`,
      `| Before bare \`1883\` | ${beforeBare} |`,
      `| After bare \`1883\` | ${afterBare} |`,
      `| Proposed vendor | 1883 Maison Routin (sheet Brand) |`,
      "",
      "Forbidden tables untouched: `product_identifier_map`, packaging tables.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "VENDOR-1883-CLEANUP-STAGING-EXECUTE",
        run_id: runId,
        plan_run_id: planRunId,
        branch,
        staging_ref: STAGING_REF,
        status: "PASS",
        apply: true,
        updated_count: applied.length,
        skipped_count: skipped.length,
        before_bare_1883_count: beforeBare,
        after_bare_1883_count: afterBare,
        rollback_path: rollbackPath.replace(/\\/g, "/"),
        exact_next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir,
        updated_count: applied.length,
        skipped_count: skipped.length,
        before_bare_1883_count: beforeBare,
        after_bare_1883_count: afterBare,
        rollback_path: rollbackPath,
        next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
