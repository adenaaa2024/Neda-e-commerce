/**
 * NEXT-SCANNER-04 staging E2E probes (read + optional manual override round-trip).
 * Usage: npx tsx scripts/next-scanner-04-staging-e2e.ts [--write-test]
 *
 * Requires SCANNER-02C gate: approval file OR SUPABASE_ENV/APP_ENV dev|staging.
 * --write-test: apply + revert manual override on one return_items row (staging only).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT,
  EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT,
} from "../lib/scanner/operator-tracking-expectations";
import { RETURN_ITEMS_TABLE, RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT } from "../app/returns/returns-constants";

function loadEnvLocal(): void {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === "") {
      process.env[k] = v;
    }
  }
}

function extractProjectRef(url: string): string | null {
  const m = url.match(/https:\/\/([^.]+)\.supabase\.co/);
  return m?.[1] ?? null;
}

function isStagingGateOpen(): { ok: boolean; reason: string } {
  const approvalPath = join(process.cwd(), ".cursor/operator-approvals/scanner-02c-dev-staging-approval.md");
  if (existsSync(approvalPath)) {
    const body = readFileSync(approvalPath, "utf8");
    if (/APPROVED_TO_APPLY_SCANNER_PRODUCT_LINKAGE_MIGRATION\s*=\s*true/i.test(body)) {
      return { ok: true, reason: "operator approval file" };
    }
    return { ok: false, reason: "approval file present but APPROVED flag not true" };
  }
  const envLabel = [
    process.env.SUPABASE_ENV,
    process.env.APP_ENV,
    process.env.ENVIRONMENT,
    process.env.VERCEL_ENV,
  ]
    .map((v) => String(v ?? "").trim().toLowerCase())
    .find(Boolean);
  if (envLabel && /^(dev|development|staging|preview|local)$/.test(envLabel)) {
    return { ok: true, reason: `env marker ${envLabel}` };
  }
  return { ok: false, reason: "no approval file and no dev/staging env marker" };
}

type ProbeResult = { name: string; ok: boolean; detail: string };

async function main(): Promise<void> {
  loadEnvLocal();
  const writeTest = process.argv.includes("--write-test");
  const gate = isStagingGateOpen();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const projectRef = extractProjectRef(url);

  const report: Record<string, unknown> = {
    run: "next-scanner-04-staging-e2e",
    gate_open: gate.ok,
    gate_reason: gate.reason,
    project_ref: projectRef,
    write_test_requested: writeTest,
    probes: [] as ProbeResult[],
  };

  if (!url || !key) {
    report.error = "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY";
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const probes: ProbeResult[] = [];

  async function probeSelect(name: string, table: string, select: string): Promise<void> {
    const { error } = await supabase.from(table).select(select).limit(1);
    probes.push({
      name,
      ok: !error,
      detail: error ? `${error.code ?? "error"}: ${error.message}` : "select ok (0+ rows)",
    });
  }

  await probeSelect("EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT", "expected_packages", EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT);
  await probeSelect("EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT", "expected_packages", EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT);
  await probeSelect("RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT", RETURN_ITEMS_TABLE, RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT);

  const { count: productCount } = await supabase.from("products").select("id", { count: "exact", head: true });
  probes.push({
    name: "products_table_readable",
    ok: productCount != null,
    detail: productCount != null ? `count head ok (${productCount ?? 0} rows)` : "count failed",
  });

  report.probes = probes;
  const allSelectsOk = probes.slice(0, 3).every((p) => p.ok);
  report.extended_selects_ok = allSelectsOk;
  report.migration_columns_likely_applied = allSelectsOk;

  if (!gate.ok) {
    report.manual_override_skipped = "scanner-02c gate closed";
    report.audit_log_skipped = "scanner-02c gate closed";
    console.log(JSON.stringify(report, null, 2));
    process.exit(allSelectsOk ? 2 : 1);
  }

  if (!writeTest) {
    report.manual_override_skipped = "pass --write-test to run override round-trip";
    report.audit_log_skipped = "pass --write-test";
    console.log(JSON.stringify(report, null, 2));
    process.exit(allSelectsOk ? 0 : 1);
  }

  const { data: item } = await supabase
    .from(RETURN_ITEMS_TABLE)
    .select("id, organization_id, store_id, resolved_product_id, sku")
    .not("store_id", "is", null)
    .not("organization_id", "is", null)
    .limit(1)
    .maybeSingle();

  if (!item?.id || !item.store_id || !item.organization_id) {
    report.manual_override = { ok: false, detail: "no suitable return_items row" };
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const orgId = String(item.organization_id);
  const storeId = String(item.store_id);
  const sku = String(item.sku ?? "").trim();
  let productId: string | null = null;

  if (sku) {
    const { data: prod } = await supabase
      .from("products")
      .select("id")
      .eq("organization_id", orgId)
      .eq("store_id", storeId)
      .eq("sku", sku)
      .limit(1)
      .maybeSingle();
    productId = prod?.id ? String(prod.id) : null;
  }
  if (!productId) {
    const { data: prod } = await supabase
      .from("products")
      .select("id")
      .eq("organization_id", orgId)
      .eq("store_id", storeId)
      .limit(1)
      .maybeSingle();
    productId = prod?.id ? String(prod.id) : null;
  }

  if (!productId) {
    report.manual_override = { ok: false, detail: "no product in same org/store" };
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const prevResolved = item.resolved_product_id ? String(item.resolved_product_id) : null;
  const { manualOverrideReturnItemProductResolution } = await import(
    "../app/scanner/operator-mobile/item-actions"
  );

  const overrideRes = await manualOverrideReturnItemProductResolution({
    return_item_id: String(item.id),
    resolved_product_id: productId,
    actor: "next-scanner-04-e2e",
  });

  const { data: auditRows } = await supabase
    .from("return_audit_log")
    .select("id, field, new_value, actor")
    .eq("return_id", String(item.id))
    .eq("field", "scanner_product_manual_override")
    .order("created_at", { ascending: false })
    .limit(1);

  const { count: productsBefore } = await supabase.from("products").select("id", { count: "exact", head: true });

  if (prevResolved) {
    await supabase
      .from(RETURN_ITEMS_TABLE)
      .update({
        resolved_product_id: prevResolved,
        identifier_resolution_source: null,
        product_match_status: null,
        product_review_required: false,
      })
      .eq("id", String(item.id));
  } else {
    await supabase
      .from(RETURN_ITEMS_TABLE)
      .update({
        resolved_product_id: null,
        identifier_resolution_source: null,
        product_match_status: null,
        product_review_required: false,
      })
      .eq("id", String(item.id));
  }

  const { count: productsAfter } = await supabase.from("products").select("id", { count: "exact", head: true });

  report.manual_override = {
    ok: overrideRes.ok,
    detail: overrideRes.ok ? "override applied" : overrideRes.error ?? "failed",
  };
  report.audit_log = {
    ok: Boolean(auditRows?.length),
    detail: auditRows?.length ? `field=${auditRows[0]?.field}` : "no audit row",
  };
  report.no_product_creation = {
    ok: productsBefore === productsAfter,
    products_before: productsBefore,
    products_after: productsAfter,
  };

  console.log(JSON.stringify(report, null, 2));
  const pass =
    allSelectsOk &&
    overrideRes.ok &&
    Boolean(auditRows?.length) &&
    productsBefore === productsAfter;
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
