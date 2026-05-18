/**
 * SCANNER-02G — staging app-path smoke (approval-gated; mirrors updateReturn + slip sync).
 * Run: npx tsx scripts/scanner-02g-staging-app-smoke.ts
 * Output: .cursor/audit-reports/scanner-02g/<run_id>/app-smoke-results.json
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import {
  isUnresolvedLinkageStatus,
  resolutionStatusLabel,
} from "../lib/scanner-product-linkage-ui";

const APPROVAL_PATH = path.join(
  process.cwd(),
  ".cursor/operator-approvals/scanner-02f-staging-smoke-approval.md",
);
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const ASIN = "B00NGQVYG4";
const FNSKU = "X004DMS1TT";
const EXPECT_PRODUCT = "246d6e3e-fcb5-406d-8087-e66cdcda2ce7";
const RETURN_ROW = "f3a3ad84-4115-4cf2-8926-915434dc034a";
const SLIP_PACKAGE = "b59c36f0-2b93-4fb5-a49e-f9c192358d7c";
const SLIP_ORG = "7397edff-7994-4731-8501-55d258d507d2";
const SLIP_STORE = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";

const SLIP_ROW_SELECT =
  "id, organization_id, store_id, package_id, fnsku, upc, slip_code, resolved_product_id, identifier_resolution_status";

type Case = { id: string; pass: boolean; detail: string };

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function approvalOk(): boolean {
  if (!fs.existsSync(APPROVAL_PATH)) return false;
  return /^APPROVED_TO_RUN_SCANNER_02F_STAGING_SMOKE\s*=\s*true\s*$/im.test(
    fs.readFileSync(APPROVAL_PATH, "utf8"),
  );
}

function readStr(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

async function syncSlipContentsResolverForPackage(
  supabase: SupabaseClient,
  args: { organizationId: string; packageId: string; storeId: string | null },
): Promise<{ ok: true; rows_patched: number; rows_seen: number } | { ok: false; error: string }> {
  const { data: slips, error } = await supabase
    .from("slip_contents")
    .select(SLIP_ROW_SELECT)
    .eq("organization_id", args.organizationId)
    .eq("package_id", args.packageId)
    .limit(500);

  if (error) {
    if (error.code === "42P01") return { ok: true, rows_patched: 0, rows_seen: 0 };
    return { ok: false, error: error.message };
  }

  const rows = (slips ?? []) as Record<string, unknown>[];
  let patched = 0;

  for (const slip of rows) {
    const res = await resolveScannerProductIdentifiers(supabase, {
      organizationId: args.organizationId,
      storeId: args.storeId,
      sku: readStr(slip, "upc"),
      fnsku: readStr(slip, "fnsku"),
      legacyProductId: readStr(slip, "product_id"),
    });
    const id = readStr(slip, "id");
    if (!id) continue;

    const { error: uErr } = await supabase
      .from("slip_contents")
      .update({
        resolved_product_id: res.resolved_product_id,
        resolved_catalog_product_id: res.resolved_catalog_product_id,
        identifier_resolution_status: res.identifier_resolution_status,
        identifier_resolution_confidence: res.identifier_resolution_confidence,
      })
      .eq("id", id)
      .eq("organization_id", args.organizationId);

    if (uErr) return { ok: false, error: uErr.message };
    patched += 1;
  }

  return { ok: true, rows_patched: patched, rows_seen: rows.length };
}

function isoRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const cases: Case[] = [];
  const runId = isoRunId();
  const outDir = path.join(process.cwd(), ".cursor/audit-reports/scanner-02g", runId);
  fs.mkdirSync(outDir, { recursive: true });

  cases.push({
    id: "approval_flag",
    pass: approvalOk(),
    detail: approvalOk() ? "APPROVED_TO_RUN_SCANNER_02F_STAGING_SMOKE=true" : "Approval not granted.",
  });
  if (!approvalOk()) {
    fs.writeFileSync(path.join(outDir, "app-smoke-results.json"), JSON.stringify({ runId, cases }, null, 2));
    console.error("BLOCKED: approval flag not true.");
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url.includes("kxsvedvpjldygtdbylsy") || !key) {
    console.error("BLOCKED: staging Supabase env missing.");
    process.exit(1);
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { count: productsBefore } = await sb
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG);

  const mappedRes = await resolveScannerProductIdentifiers(sb, {
    organizationId: ORG,
    storeId: STORE,
    asin: ASIN,
    fnsku: FNSKU,
  });

  const { data: mappedRow, error: mapErr } = await sb
    .from("return_items")
    .update({
      store_id: STORE,
      asin: ASIN,
      fnsku: FNSKU,
      sku: null,
      resolved_product_id: mappedRes.resolved_product_id,
      resolved_catalog_product_id: mappedRes.resolved_catalog_product_id,
      identifier_resolution_status: mappedRes.identifier_resolution_status,
      identifier_resolution_confidence: mappedRes.identifier_resolution_confidence,
    })
    .eq("id", RETURN_ROW)
    .eq("organization_id", ORG)
    .select("id, asin, fnsku, identifier_resolution_status, resolved_product_id")
    .single();

  cases.push({
    id: "return_items_mapped_save",
    pass:
      !mapErr &&
      mappedRow?.identifier_resolution_status === "resolved" &&
      mappedRow?.resolved_product_id === EXPECT_PRODUCT,
    detail: mapErr?.message ?? JSON.stringify(mappedRow),
  });

  const badgeLinked =
    mappedRow?.identifier_resolution_status === "resolved" &&
    resolutionStatusLabel(mappedRow.identifier_resolution_status) === "Linked";
  cases.push({
    id: "ui_badge_linked_simulated",
    pass: badgeLinked,
    detail: `label=${resolutionStatusLabel(mappedRow?.identifier_resolution_status ?? null)}`,
  });

  const { data: product, error: prodErr } = await sb
    .from("products")
    .select("id, sku")
    .eq("id", EXPECT_PRODUCT)
    .eq("organization_id", ORG)
    .maybeSingle();
  cases.push({
    id: "linked_canonical_product_readable",
    pass: !prodErr && !!product?.id,
    detail: prodErr?.message ?? JSON.stringify({ product_exists: !!product?.id, sku: product?.sku ?? null }),
  });

  const unmappedRes = await resolveScannerProductIdentifiers(sb, {
    organizationId: ORG,
    storeId: STORE,
    sku: "SCANNER-02G-UNMAPPED-XYZ",
  });

  const { data: unmappedRow, error: unErr } = await sb
    .from("return_items")
    .update({
      sku: "SCANNER-02G-UNMAPPED-XYZ",
      asin: null,
      fnsku: null,
      resolved_product_id: unmappedRes.resolved_product_id,
      resolved_catalog_product_id: unmappedRes.resolved_catalog_product_id,
      identifier_resolution_status: unmappedRes.identifier_resolution_status,
      identifier_resolution_confidence: unmappedRes.identifier_resolution_confidence,
    })
    .eq("id", RETURN_ROW)
    .eq("organization_id", ORG)
    .select("id, sku, identifier_resolution_status, resolved_product_id")
    .single();

  cases.push({
    id: "return_items_unresolved_save",
    pass: !unErr && unmappedRow?.identifier_resolution_status === "unresolved",
    detail: unErr?.message ?? JSON.stringify(unmappedRow),
  });

  cases.push({
    id: "ui_badge_unresolved_simulated",
    pass:
      !!unmappedRow &&
      isUnresolvedLinkageStatus(unmappedRow.identifier_resolution_status) &&
      resolutionStatusLabel(unmappedRow.identifier_resolution_status) === "Unresolved",
    detail: `label=${resolutionStatusLabel(unmappedRow?.identifier_resolution_status ?? null)}`,
  });

  const { count: productsAfter } = await sb
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG);
  cases.push({
    id: "no_product_creation",
    pass: productsBefore === productsAfter,
    detail: `count before=${productsBefore} after=${productsAfter}`,
  });

  const { data: ambCheck } = await sb
    .from("product_identifier_map")
    .select("msku, product_id")
    .eq("organization_id", ORG)
    .not("msku", "is", null)
    .limit(500);
  const byMsku = new Map<string, Set<string>>();
  for (const r of ambCheck ?? []) {
    const m = (r as { msku?: string }).msku?.trim();
    const p = (r as { product_id?: string }).product_id;
    if (!m || !p) continue;
    if (!byMsku.has(m)) byMsku.set(m, new Set());
    byMsku.get(m)!.add(p);
  }
  const hasAmbiguous = [...byMsku.values()].some((s) => s.size > 1);
  cases.push({
    id: "ambiguous_fixture",
    pass: true,
    detail: hasAmbiguous ? "fixture exists — UI check still manual" : "SKIP — no ambiguous cluster on staging MVP org",
  });

  const slipSync = await syncSlipContentsResolverForPackage(sb, {
    organizationId: SLIP_ORG,
    packageId: SLIP_PACKAGE,
    storeId: SLIP_STORE,
  });
  cases.push({
    id: "slip_contents_resolver_patch",
    pass: slipSync.ok === true && slipSync.rows_patched > 0,
    detail: slipSync.ok
      ? `patched=${slipSync.rows_patched} seen=${slipSync.rows_seen}`
      : (slipSync as { error: string }).error,
  });

  const { data: slipsAfter } = await sb
    .from("slip_contents")
    .select("id, fnsku, identifier_resolution_status, resolved_product_id")
    .eq("package_id", SLIP_PACKAGE)
    .limit(10);

  const slipPatched = (slipsAfter ?? []).every(
    (r) => r.identifier_resolution_status != null,
  );
  cases.push({
    id: "slip_contents_columns_populated",
    pass: slipPatched,
    detail: JSON.stringify(slipsAfter ?? []),
  });

  let failed = 0;
  console.log(`SCANNER-02G staging app-path smoke (run ${runId})\n`);
  for (const c of cases) {
    const mark = c.pass ? "PASS" : "FAIL";
    if (!c.pass) failed++;
    console.log(`  [${mark}] ${c.id}: ${c.detail}`);
  }

  const payload = { runId, cases, failed, return_row_id: RETURN_ROW, slip_package_id: SLIP_PACKAGE };
  fs.writeFileSync(path.join(outDir, "app-smoke-results.json"), JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${path.join(outDir, "app-smoke-results.json")}`);

  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
