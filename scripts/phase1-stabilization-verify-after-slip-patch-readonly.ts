/**
 * PHASE1-STABILIZATION-VERIFY-AFTER-SLIP-PATCH — read-only staging + local checks.
 *   npx tsx scripts/phase1-stabilization-verify-after-slip-patch-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";
import { applyExcludeBulkOrphanReturnItemsFilter } from "../lib/return-item-physical-scan";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase1-stabilization-verify-after-slip-patch";
const BASELINE = path.join(
  process.cwd(),
  ".cursor/audit-reports/inventory-views-bulk-orphan-ri-exclusion-migration/20260521T220000Z/before-after-view-counts.json",
);

const BULK_ORPHAN_PREDICATE = `
  ri.deleted_at IS NULL
  AND ri.expected_item_id IS NOT NULL
  AND ri.package_id IS NULL
  AND ri.pallet_id IS NULL
`;

function makeRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function fetchPage(url: string): Promise<{ ok: boolean; status: number; slipError: boolean; body: string }> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    const body = await res.text();
    const slipError = /slip_content_id/i.test(body) && /does not exist|42703/i.test(body);
    return { ok: res.ok, status: res.status, slipError, body: body.slice(0, 2000) };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      slipError: false,
      body: e instanceof Error ? e.message : String(e),
    };
  }
}

async function main(): Promise<void> {
  const runId = makeRunId();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const checks: { id: string; pass: boolean; detail: string }[] = [];
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
    "";

  let baseline: Record<string, unknown> = {};
  if (fs.existsSync(BASELINE)) {
    baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as Record<string, unknown>;
  }

  if (!dbUrl) {
    checks.push({ id: "staging_db", pass: false, detail: "STAGING_DIRECT_POSTGRES_URL unset" });
  } else {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      const ref = refFromSupabaseUrl(dbUrl);
      checks.push({
        id: "staging_ref",
        pass: ref === STAGING_REF,
        detail: `ref=${ref ?? "null"} expected ${STAGING_REF}`,
      });

      const col = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='return_items' AND column_name='slip_content_id'`,
      );
      checks.push({
        id: "no_slip_content_id_column",
        pass: (col.rowCount ?? 0) === 0,
        detail: `return_items.slip_content_id exists=${(col.rowCount ?? 0) > 0}`,
      });

      const m = await client.query(`
        SELECT
          (SELECT count(*)::int FROM public.return_items WHERE deleted_at IS NULL) AS active_ri,
          (SELECT count(*)::int FROM public.return_items ri WHERE ${BULK_ORPHAN_PREDICATE}) AS bulk_orphan_active,
          (SELECT coalesce(sum(total_scanned),0)::numeric FROM public.v_scanned_items_counted) AS v_scanned_sum,
          (SELECT count(*)::int FROM public.expected_packages) AS ep_count,
          (SELECT count(*)::int FROM public.products) AS products_count,
          (SELECT count(*)::int FROM public.product_identifier_map) AS pim_count
      `);
      const row = m.rows[0] as Record<string, unknown>;
      const afterBaseline = baseline.after as Record<string, unknown> | undefined;

      checks.push({
        id: "active_ri_33",
        pass: Number(row.active_ri) === 33,
        detail: `active_ri=${row.active_ri}`,
      });
      checks.push({
        id: "bulk_orphan_0",
        pass: Number(row.bulk_orphan_active) === 0,
        detail: `bulk_orphan_active=${row.bulk_orphan_active}`,
      });
      checks.push({
        id: "v_scanned_sum_3",
        pass: Number(row.v_scanned_sum) === 3,
        detail: `v_scanned_sum=${row.v_scanned_sum}`,
      });

      if (afterBaseline) {
        checks.push({
          id: "ep_count_unchanged",
          pass: String(row.ep_count) === String(afterBaseline.ep_count),
          detail: `ep_count=${row.ep_count} baseline=${afterBaseline.ep_count}`,
        });
      } else {
        checks.push({
          id: "ep_count_unchanged",
          pass: Number(row.ep_count) === 9459,
          detail: `ep_count=${row.ep_count} (no baseline file; expect 9459)`,
        });
      }

      checks.push({
        id: "products_readable",
        pass: Number(row.products_count) > 0,
        detail: `products=${row.products_count}`,
      });
      checks.push({
        id: "pim_readable",
        pass: Number(row.pim_count) >= 0,
        detail: `product_identifier_map=${row.pim_count}`,
      });
    } finally {
      await client.end();
    }
  }

  if (supabaseUrl && supabaseKey) {
    const sb = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
    let q = sb.from("return_items").select("id", { count: "exact", head: true }).is("deleted_at", null);
    q = applyExcludeBulkOrphanReturnItemsFilter(q);
    const { count, error } = await q;
    const slipErr = error?.message?.includes("slip_content_id") ?? false;
    checks.push({
      id: "postgrest_count_no_slip_error",
      pass: !error && !slipErr,
      detail: error ? error.message : `count=${count ?? 0}`,
    });
    checks.push({
      id: "postgrest_list_sample",
      pass: false,
      detail: "pending",
    });
    let lq = sb.from("return_items").select("id,package_id,pallet_id,expected_item_id").is("deleted_at", null).limit(1);
    lq = applyExcludeBulkOrphanReturnItemsFilter(lq);
    const listRes = await lq;
    const listSlipErr = listRes.error?.message?.includes("slip_content_id") ?? false;
    checks[checks.length - 1] = {
      id: "postgrest_list_sample",
      pass: !listRes.error && !listSlipErr,
      detail: listRes.error ? listRes.error.message : `rows=${listRes.data?.length ?? 0}`,
    };
  } else {
    checks.push({
      id: "postgrest_count_no_slip_error",
      pass: false,
      detail: "Supabase URL/key unset — skipped PostgREST probe",
    });
  }

  const ports = [3000, 3001];
  let pageProbe = "dev server not reachable";
  let returnsPass = false;
  let scannerPass = false;
  for (const port of ports) {
    const base = `http://localhost:${port}`;
    const home = await fetchPage(base);
    if (home.status === 0) continue;
    const returns = await fetchPage(`${base}/returns`);
    const scanner = await fetchPage(`${base}/scanner`);
    returnsPass = returns.status > 0 && returns.status < 500 && !returns.slipError;
    scannerPass = scanner.status > 0 && scanner.status < 500 && !scanner.slipError;
    pageProbe = `port ${port}: returns status=${returns.status} scanner=${scanner.status} slipErr=${returns.slipError || scanner.slipError}`;
    if (returnsPass && scannerPass) break;
  }
  checks.push({ id: "returns_page_loads", pass: returnsPass, detail: pageProbe });
  checks.push({ id: "scanner_page_loads", pass: scannerPass, detail: pageProbe });

  let buildPass = false;
  let buildDetail = "";
  try {
    execSync("npm run build", { encoding: "utf8", stdio: "pipe", cwd: process.cwd(), timeout: 300000 });
    buildPass = true;
    buildDetail = "npm run build exit 0";
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    buildDetail = String(err.stderr ?? err.stdout ?? err.message ?? e).slice(0, 500);
  }
  checks.push({ id: "build_pass", pass: buildPass, detail: buildDetail });

  const failed = checks.filter((c) => !c.pass);
  const safe = failed.length === 0;

  const md = [
    "# PHASE1-STABILIZATION-VERIFY-AFTER-SLIP-PATCH",
    "",
    `Run: \`${runId}\``,
    "",
    "## SAFE_TO_RESUME",
    "",
    safe ? "**yes**" : "**no**",
    "",
    "## Checks",
    "",
    "| # | Check | Pass | Detail |",
    "|---|-------|------|--------|",
    ...checks.map((c, i) => `| ${i + 1} | ${c.id} | ${c.pass ? "YES" : "NO"} | ${c.detail.replace(/\|/g, "\\|")} |`),
    "",
    "## NEXT_ORDERED_PROMPTS",
    "",
    "1. `CLAIM-RETURN-LINE-BACKFILL-DRYRUN` — read-only census with fixed SQL (no slip_content_id)",
    "2. `BULK-ORPHAN-RETURN-ITEMS-STAGING-REMEDIATION-EXECUTE` — only if bulk_orphan_active > 0 again",
    "3. `SCANNER-ACTIVE-SCAN-COUNTS-BULK-ORPHAN-GUARD` — already patched; optional re-audit",
    "4. `PRODUCT-ENRICHMENT-BACKEND-JOB-PHASE1` — catalog enrich when stabilization signed off",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "PHASE1_STABILIZATION_VERIFY.md"), md + "\n");
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ run_id: runId, safe_to_resume: safe, checks, failed: failed.map((f) => f.id) }, null, 2),
  );

  console.log(JSON.stringify({ safe_to_resume: safe, outDir, failed: failed.map((f) => f.id) }, null, 2));
  if (!safe) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
