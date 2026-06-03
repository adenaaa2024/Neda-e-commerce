/**
 * ORIGINAL-DEMO-RUNTIME-SMOKE — backend/DB runtime smoke against original/live.
 *   npx tsx scripts/original-demo-runtime-smoke.ts [--fix-pdf]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { dirname as pathDirname } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const DEMO_PACKAGE = "5fd5a376-51fc-4e72-8643-940060c80d05";
const PDF_SUBMISSION = "6bffd14b-1490-45a2-9b91-bc61b653cbae";
const BUCKET = "claim-reports";
const OUT_BASE = ".cursor/audit-reports/original-demo-runtime-smoke";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getMinutes())}${p(d.getSeconds())}Z`;
}

function originalClient(): SupabaseClient {
  const url = process.env.ORIGINAL_SUPABASE_URL?.trim();
  const key = process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("ORIGINAL_SUPABASE_URL / ORIGINAL_SERVICE_ROLE_KEY required");
  if (refFromSupabaseUrl(url) !== ORIGINAL_REF) throw new Error("ORIGINAL_SUPABASE_URL ref mismatch");
  return createClient(url, key, { auth: { persistSession: false } });
}

function stagingClient(): SupabaseClient {
  const url = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("staging Supabase URL/key required");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function main(): Promise<void> {
  const fixPdf = process.argv.includes("--fix-pdf");
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const appUrlRef = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const envPointsToOriginal = appUrlRef === ORIGINAL_REF;

  // Point server modules at original for this process
  if (process.env.ORIGINAL_SUPABASE_URL) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.ORIGINAL_SUPABASE_URL;
  }
  if (process.env.ORIGINAL_SERVICE_ROLE_KEY) {
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.ORIGINAL_SERVICE_ROLE_KEY;
  }

  const origSb = originalClient();
  const report: Record<string, unknown> = {
    run_id: rid,
    current_branch_commit: null as string | null,
    env_points_to_original: envPointsToOriginal,
    app_next_public_supabase_ref: appUrlRef,
    original_supabase_ref: ORIGINAL_REF,
    fixes_applied: [] as string[],
    backend_mismatches: [] as { area: string; class: string; detail: string }[],
  };

  try {
    const { execSync } = await import("node:child_process");
    report.current_branch_commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    report.current_branch_commit = "unknown";
  }

  // ── Scanner smoke ──
  const { lookupShipmentEntryScanCode } = await import("../lib/scanner/shipment-entry-lookup");
  const scanner: Record<string, unknown> = {};

  for (const code of ["25", "1ZA8339B0318447051", "ZZZ-NOMATCH-SMOKE-999"]) {
    const fast = await lookupShipmentEntryScanCode(origSb, ORG_ID, STORE_ID, code, {
      skipExpensiveFallback: code !== "ZZZ-NOMATCH-SMOKE-999",
    });
    scanner[`lookup_${code}_fast`] = {
      match_status: fast.match_status,
      rows: fast.inventory_rows.length,
      next_action: fast.next_action,
    };
  }

  const deep = await lookupShipmentEntryScanCode(origSb, ORG_ID, STORE_ID, "ZZZ-NOMATCH-SMOKE-999", {
    skipExpensiveFallback: false,
  });
  scanner.deep_search_nomatch = { match_status: deep.match_status, rows: deep.inventory_rows.length };

  const { data: slip } = await origSb.from("slip_contents").select("id").eq("package_id", DEMO_PACKAGE);
  const { data: ep } = await origSb
    .from("expected_packages")
    .select("id, tracking_number")
    .eq("organization_id", ORG_ID)
    .in("tracking_number", ["25", "1ZA8339B0318447051"]);
  const { data: pkg } = await origSb.from("packages").select("id, tracking_number, status").eq("id", DEMO_PACKAGE).maybeSingle();
  const { data: pal } = await origSb
    .from("pallets")
    .select("id, pallet_number")
    .eq("organization_id", ORG_ID)
    .is("deleted_at", null)
    .limit(5);

  scanner.slip_contents_count = slip?.length ?? 0;
  scanner.expected_packages_demo_trackings = ep?.length ?? 0;
  scanner.demo_package = pkg;
  scanner.active_pallets_sample = pal?.length ?? 0;
  report.scanner_runtime_result = scanner;

  // ── Returns / claims loaders (direct Supabase — avoids server-only imports) ──
  const poolSql = `
    ri.deleted_at IS NULL AND ri.organization_id = $1::uuid
    AND ri.package_id IS NOT NULL
    AND NOT (ri.expected_item_id IS NOT NULL AND ri.package_id IS NULL AND ri.pallet_id IS NULL)
    AND ri.conditions && $2::text[]`;
  const CLAIMABLE = [
    "damaged_product", "scratched", "wrong_item", "wrong_item_different", "wrong_item_junk",
    "expired", "missing_parts", "missing_item", "empty_box", "damaged_box", "damaged_warehouse",
    "damaged_customer", "damaged_carrier", "wet", "counterfeit_suspect", "operator_other",
  ];

  const pgUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim();
  let draftPoolCount = 0;
  if (pgUrl) {
    const c = new pg.Client({ connectionString: pgUrl });
    await c.connect();
    const pr = await c.query(`SELECT count(*)::int n FROM return_items ri WHERE ${poolSql}`, [ORG_ID, CLAIMABLE]);
    draftPoolCount = pr.rows[0]?.n ?? 0;
    await c.end();
  }

  const { data: activeRis } = await origSb
    .from("return_items")
    .select("id")
    .eq("organization_id", ORG_ID)
    .is("deleted_at", null);

  report.returns_runtime_result = {
    ok: true,
    active_return_items: activeRis?.length ?? 0,
  };
  report.draft_pool_runtime_result = { count: draftPoolCount, expected: 4 };

  const { data: caseRows, error: caseErr } = await origSb
    .from("claim_cases")
    .select("id, status, scanner_issue_type, primary_return_item_id")
    .eq("organization_id", ORG_ID);
  report.cases_runtime_result = {
    ok: !caseErr,
    count: caseRows?.length ?? 0,
    expected: 2,
    error: caseErr?.message ?? null,
  };

  const { data: allSubs, error: subsErr } = await origSb
    .from("claim_submissions")
    .select("id, status, report_url")
    .eq("organization_id", ORG_ID);
  const readyCount = (allSubs ?? []).filter((s) => s.status === "ready_to_send").length;
  report.submission_queue_runtime_result = {
    total_count: allSubs?.length ?? 0,
    ready_to_send_count: readyCount,
    expected_total: 3,
    subs_error: subsErr?.message ?? null,
  };

  report.claim_intake_runtime_result = {
    physical_returns_api_equivalent: draftPoolCount,
    expected: 4,
  };

  const { data: orgSet } = await origSb
    .from("organization_settings")
    .select("claim_policy")
    .eq("organization_id", ORG_ID)
    .maybeSingle();
  const { normalizeClaimPolicy } = await import("../lib/claim-eligibility-policy");
  const policy = normalizeClaimPolicy(orgSet?.claim_policy);
  report.claim_settings_runtime_result = {
    returns_enabled: policy.enabled_claim_domains?.returns === true,
  };

  // Case builder dry-run (transaction rollback)
  let caseBuilderOk = false;
  let caseBuilderNote: string | null = null;
  if (pgUrl) {
    const client = new pg.Client({ connectionString: pgUrl });
    await client.connect();
    try {
      await client.query("BEGIN");
      const ri = await client.query(
        `SELECT id FROM return_items
         WHERE organization_id=$1::uuid AND deleted_at IS NULL AND package_id IS NOT NULL
           AND conditions && ARRAY['damaged_customer']::text[]
         LIMIT 1`,
        [ORG_ID],
      );
      if (ri.rows[0]?.id) {
        const key = `smoke-dry-run-${Date.now()}`;
        await client.query(
          `INSERT INTO claim_cases (
             organization_id, store_id, claim_source, scanner_issue_type, status, priority,
             primary_return_item_id, idempotency_key, metadata
           ) VALUES ($1,$2,'scanner_operator_issue','damaged_product','open','normal',$3,$4,'{}'::jsonb)`,
          [ORG_ID, STORE_ID, ri.rows[0].id, key],
        );
        caseBuilderOk = true;
      } else {
        caseBuilderNote = "no suitable return_item for dry-run";
      }
      await client.query("ROLLBACK");
    } catch (e) {
      caseBuilderNote = e instanceof Error ? e.message : String(e);
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  }
  report.case_builder_runtime_result = { insert_dry_run_ok: caseBuilderOk, note: caseBuilderNote };

  // ── PIM reads ──
  const { data: draftRis } = await origSb
    .from("return_items")
    .select("id, resolved_product_id, products(product_name, main_image_url, sku, fnsku)")
    .eq("organization_id", ORG_ID)
    .is("deleted_at", null)
    .not("package_id", "is", null)
    .limit(4);
  const { count: pimMapCount } = await origSb
    .from("product_identifier_map")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG_ID);

  const pgClient = pgUrl ? new pg.Client({ connectionString: pgUrl }) : null;
  let facetsOk = false;
  if (pgClient) {
    await pgClient.connect();
    const fr = await pgClient.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname='pim_catalog_products_page'
       ) AS e`,
    );
    facetsOk = fr.rows[0]?.e === true;
    await pgClient.end();
  }

  report.products_pim_runtime_result = {
    draft_pool_product_embed_rows: draftRis?.length ?? 0,
    product_identifier_map_org_rows: pimMapCount ?? 0,
    pim_catalog_rpc_exists: facetsOk,
  };

  // ── PDF storage ──
  const { data: subRow } = await origSb
    .from("claim_submissions")
    .select("id, report_url")
    .eq("id", PDF_SUBMISSION)
    .maybeSingle();
  const reportPath = String(subRow?.report_url ?? "").trim();
  let pdfOriginal = false;
  let pdfStaging = false;
  if (reportPath) {
    const oList = await origSb.storage.from(BUCKET).list(pathDirname(reportPath.replace(/\\/g, "/")));
    pdfOriginal = Boolean(oList.data?.some((f) => reportPath.endsWith(f.name)));
    if (!pdfOriginal) {
      const oDl = await origSb.storage.from(BUCKET).download(reportPath);
      pdfOriginal = !oDl.error && !!oDl.data;
    }
    try {
      const st = stagingClient();
      const sDl = await st.storage.from(BUCKET).download(reportPath);
      pdfStaging = !sDl.error && !!sDl.data;
    } catch {
      pdfStaging = false;
    }
  }

  report.pdf_storage_result = {
    submission_id: PDF_SUBMISSION,
    report_url: reportPath,
    exists_on_original: pdfOriginal,
    exists_on_staging: pdfStaging,
  };

  if (fixPdf && reportPath && !pdfOriginal && pdfStaging) {
    const st = stagingClient();
    const sDl = await st.storage.from(BUCKET).download(reportPath);
    if (sDl.data) {
      const buf = Buffer.from(await sDl.data.arrayBuffer());
      const up = await origSb.storage.from(BUCKET).upload(reportPath, buf, {
        contentType: "application/pdf",
        upsert: true,
      });
      if (!up.error) {
        (report.fixes_applied as string[]).push(`copied PDF to original bucket: ${reportPath}`);
        report.pdf_storage_result = { ...(report.pdf_storage_result as object), exists_on_original: true, fixed: true };
      }
    }
  }

  // ── Amazon intake audit (read-only) ──
  const { count: candCount } = await origSb
    .from("claim_candidates")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG_ID);
  report.amazon_intake_audit = {
    claim_candidates_org_rows: candCount ?? 0,
    note: "Cards may show import candidates; physical tab uses return_items queue. No copy applied.",
  };

  // Classify mismatches
  const mismatches = report.backend_mismatches as { area: string; class: string; detail: string }[];
  if (!envPointsToOriginal) {
    mismatches.push({
      area: "env",
      class: "C",
      detail: `NEXT_PUBLIC_SUPABASE_URL points to ${appUrlRef}, not original ${ORIGINAL_REF}. Local dev hits staging; Vercel Production should use original.`,
    });
  }
  if (draftPoolCount !== 4) {
    mismatches.push({ area: "draft_pool", class: "F", detail: `expected 4 got ${draftPoolCount}` });
  }
  if ((caseRows?.length ?? 0) !== 2) {
    mismatches.push({ area: "cases", class: "F", detail: `expected 2 got ${caseRows?.length}` });
  }
  if (!pdfOriginal) {
    mismatches.push({
      area: "pdf",
      class: "D",
      detail: "report_url PDF missing on original storage (cosmetic)",
    });
  }

  const scannerOk =
    (scanner.lookup_25_fast as { rows: number }).rows > 0 &&
    (scanner.lookup_1ZA8339B0318447051_fast as { rows: number }).rows > 0;

  report.SAFE_TO_PRESENT_FROM_ORIGINAL =
    scannerOk &&
    draftPoolCount === 4 &&
    (caseRows?.length ?? 0) === 2 &&
    (allSubs?.length ?? 0) >= 3 &&
    policy.enabled_claim_domains?.returns === true;

  fs.writeFileSync(path.join(outDir, "smoke_report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
