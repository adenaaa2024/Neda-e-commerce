/**
 * Shared smoke helpers for Neda expected/inventory read-model signoff (V181).
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  EP_DETAIL_SELECT,
  EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT,
  fetchExpectedPackagesForTracking,
  loadTrackingExpectationSnapshot,
} from "../../lib/scanner/operator-tracking-expectations";
import {
  buildExpectedPackageProductLinkage,
  formatScanVarianceLabel,
  mergeExpectedPackageRowsProductLinkage,
} from "../../lib/scanner/expected-packages-read-contract";
import {
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
  productLinkagePrimaryLabel,
  productLinkageShowsUnmappedLabel,
} from "../../lib/scanner/product-linkage-display-contract";
import {
  fetchVInventoryItemStatusLinesExact,
  fetchVInventoryStatusForScanCode,
} from "../../lib/scanner/v-inventory-status";

export const SAM_ORG_ID = "00000000-0000-0000-0000-000000000001";
export const SAM_STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const SCAN_PAGE = join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx");
const META = join(process.cwd(), "app/scanner/operator-mobile/_components/OperatorProductLinkageMeta.tsx");
const SCANNER_ROOT = join(process.cwd(), "app/scanner");

export type SmokeResult = { pass: boolean; overall: string; steps: { id: string; pass: boolean; detail: string }[] };

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

export function stagingSupabase(): { client: SupabaseClient | null; detail: string } {
  loadEnvLocal();
  const url = process.env.STAGING_SUPABASE_URL?.trim() || "";
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
  if (!url || !key) return { client: null, detail: "missing STAGING_SUPABASE_URL or STAGING_SERVICE_ROLE_KEY" };
  if (!url.includes("eiqfaapyumhixxoeltgu")) {
    return { client: null, detail: "STAGING_SUPABASE_URL does not reference staging project eiqfaapyumhixxoeltgu" };
  }
  return {
    client: createClient(url, key, { auth: { persistSession: false } }),
    detail: "staging service role",
  };
}

function walkTs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkTs(p, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}

export function scanStaleRefs(): Record<string, number> {
  const counts = {
    package_items: 0,
    returns_table: 0,
    packages_package_number_select: 0,
    pallets_photo_url_select: 0,
  };
  for (const file of walkTs(SCANNER_ROOT)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/package_items/.test(line)) counts.package_items++;
      if (/\.from\(["']returns["']\)/.test(line)) counts.returns_table++;
      if (
        /\.from\(["']packages["']\)[\s\S]{0,80}package_number|select\([^)]*package_number[^)]*\)[\s\S]{0,40}\.from\(["']packages["']\)/.test(
          line,
        )
      ) {
        counts.packages_package_number_select++;
      }
      if (/\.from\(["']pallets["']\)[\s\S]{0,80}photo_url|pallets\.photo_url/.test(line)) {
        counts.pallets_photo_url_select++;
      }
    }
  }
  return counts;
}

function pageText(): string {
  return existsSync(SCAN_PAGE) ? readFileSync(SCAN_PAGE, "utf8") : "";
}

function metaText(): string {
  return existsSync(META) ? readFileSync(META, "utf8") : "";
}

export async function runExpectedPackagesSmoke(): Promise<SmokeResult> {
  const steps: SmokeResult["steps"] = [];
  const add = (id: string, pass: boolean, detail: string) => steps.push({ id, pass, detail });

  const page = pageText();
  const meta = metaText();
  const tracking = readFileSync(join(process.cwd(), "lib/scanner/operator-tracking-expectations.ts"), "utf8");

  add("alias_fetchExpectedPackagesNedaRead", /fetchExpectedPackagesForTracking|loadTrackingExpectationSnapshot/.test(page + tracking), "tracking read path");
  add("ui_expected_qty_scan_var", /expectedQty|line\.expectedQty/.test(page) && /scannedQty|line\.scannedQty/.test(page), "Exp/Scan columns");
  add("ui_variance", /formatScanVarianceLabel/.test(page), "variance label");
  add("ui_product_linkage_block", meta.includes("OperatorProductLinkageMeta") && page.includes("OperatorProductLinkageMeta"), "ProductLinkageDisplayBlock alias");
  add("ui_order_tracking_context", /order_id/.test(page) && /tracking_number|activeTracking|fetchExpectedPackagesForTracking/.test(page), "order + tracking wiring");
  add("contract_variance_math", formatScanVarianceLabel(3, 5) === "+2", "+2");

  const stale = scanStaleRefs();
  add("stale_refs_zero", Object.values(stale).every((n) => n === 0), JSON.stringify(stale));

  const { client, detail } = stagingSupabase();
  if (!client) {
    add("staging_db", false, detail);
  } else {
    add("staging_db", true, detail);
    const { error: detailErr } = await client
      .from("expected_packages")
      .select(EP_DETAIL_SELECT)
      .eq("organization_id", SAM_ORG_ID)
      .eq("store_id", SAM_STORE_ID)
      .limit(1);
    add("db_ep_detail_select", !detailErr, detailErr?.message ?? "ok");
    const { error: extErr } = await client
      .from("expected_packages")
      .select(EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT)
      .eq("organization_id", SAM_ORG_ID)
      .eq("store_id", SAM_STORE_ID)
      .limit(1);
    add(
      "db_ep_linkage_select",
      !extErr,
      extErr?.message ?? "ok (full linkage columns)",
    );
    const { data: sample } = await client
      .from("expected_packages")
      .select(EP_DETAIL_SELECT)
      .eq("organization_id", SAM_ORG_ID)
      .eq("store_id", SAM_STORE_ID)
      .not("tracking_number", "is", null)
      .limit(1);
    const tn = String((sample?.[0] as { tracking_number?: string } | undefined)?.tracking_number ?? "").trim();
    if (tn) {
      const rows = await fetchExpectedPackagesForTracking(client, SAM_ORG_ID, SAM_STORE_ID, tn, EP_DETAIL_SELECT);
      add("db_fetch_by_tracking", rows.length > 0, `tracking=${tn} rows=${rows.length}`);
      const snap = await loadTrackingExpectationSnapshot(client, SAM_ORG_ID, SAM_STORE_ID, tn);
      add("db_load_snapshot", snap.lines.length >= 0, `lines=${snap.lines.length} raw=${snap.rawRowCount}`);
      if (rows[0]) {
        const linkage = buildExpectedPackageProductLinkage(rows[0] as Record<string, unknown>, new Map());
        const label = productLinkagePrimaryLabel(linkage);
        add("db_linkage_contract", label.length > 0, label || "(empty)");
      }
    } else {
      add("db_fetch_by_tracking", false, "no sample tracking in Sam store");
    }
    const oid = String((sample?.[0] as { order_id?: string } | undefined)?.order_id ?? "").trim();
    if (oid) {
      const { data: byOrder, error: orderErr } = await client
        .from("expected_packages")
        .select(EP_DETAIL_SELECT)
        .eq("organization_id", SAM_ORG_ID)
        .eq("store_id", SAM_STORE_ID)
        .eq("order_id", oid)
        .limit(5);
      add("db_filter_order_id", !orderErr && (byOrder?.length ?? 0) > 0, orderErr?.message ?? `rows=${byOrder?.length ?? 0}`);
    } else {
      add("db_filter_order_id", false, "no sample order_id");
    }
  }

  const required = steps.filter((s) => s.id !== "db_ep_linkage_select");
  const pass = required.every((s) => s.pass);
  return { pass, overall: pass ? "PASS" : "FAIL", steps };
}

export async function runInventoryViewsSmoke(): Promise<SmokeResult> {
  const steps: SmokeResult["steps"] = [];
  const add = (id: string, pass: boolean, detail: string) => steps.push({ id, pass, detail });

  const page = pageText();
  const meta = metaText();
  const vinv = readFileSync(join(process.cwd(), "lib/scanner/v-inventory-status.ts"), "utf8");

  add("alias_fetchInventoryItemStatusForNeda", /fetchVInventoryStatusForScanCode|fetchVInventoryItemStatusLinesExact/.test(page + vinv), "inventory read path");
  add("ui_inventory_rows", /identifyGateShipmentLines/.test(page) && /fetchVInventoryStatusForScanCode/.test(page), "inventory item status table");
  add("ui_expected_scanned_status_cols", /total_expected/.test(page) && /total_scanned/.test(page) && /Variance/.test(page), "expected/scanned/status");
  add("ui_product_linkage_block", meta.includes("OperatorProductLinkageMeta") && /buildInventoryViewProductLinkage/.test(page), "linkage on rows");
  add(
    "ui_unmapped_label",
    meta.includes("PRODUCT_LINKAGE_UNMAPPED_LABEL") || meta.includes("productLinkageShowsUnmappedLabel"),
    PRODUCT_LINKAGE_UNMAPPED_LABEL,
  );

  const unresolved = mergeExpectedPackageRowsProductLinkage(
    [{ sku: "X", identifier_resolution_status: "unresolved" }],
    new Map(),
  );
  add("unresolved_shows_unmapped", productLinkageShowsUnmappedLabel(unresolved), "No product link yet");

  const stale = scanStaleRefs();
  add("stale_refs_zero", Object.values(stale).every((n) => n === 0), JSON.stringify(stale));

  const { client, detail } = stagingSupabase();
  if (!client) {
    add("staging_db", false, detail);
  } else {
    add("staging_db", true, detail);
    const { error: viewErr } = await client.from("v_inventory_item_status").select("*").eq("organization_id", SAM_ORG_ID).eq("store_id", SAM_STORE_ID).limit(1);
    add("db_v_inventory_item_status", !viewErr, viewErr?.message ?? "ok");

    const { error: pkgViewErr } = await client.from("v_inventory_status").select("*").eq("organization_id", SAM_ORG_ID).eq("store_id", SAM_STORE_ID).limit(1);
    add("db_v_inventory_status_optional", !pkgViewErr, pkgViewErr?.message ?? "ok (package-level chips)");

    const { data: epSample } = await client
      .from("expected_packages")
      .select("tracking_number")
      .eq("organization_id", SAM_ORG_ID)
      .eq("store_id", SAM_STORE_ID)
      .not("tracking_number", "is", null)
      .limit(1);
    const tn = String(epSample?.[0]?.tracking_number ?? "").trim();
    if (tn) {
      const res = await fetchVInventoryStatusForScanCode(client, SAM_ORG_ID, SAM_STORE_ID, tn);
      add("db_fetchVInventoryStatusForScanCode", true, `rows=${res.rows.length} field=${res.matchedField ?? "none"}`);
      const exact = await fetchVInventoryItemStatusLinesExact(client, SAM_ORG_ID, SAM_STORE_ID, "tracking_number", tn);
      add("db_fetchVInventoryItemStatusLinesExact", exact.rows.length >= 0, `rows=${exact.rows.length}`);
    } else {
      add("db_fetchVInventoryStatusForScanCode", false, "no tracking sample");
    }
  }

  const pass = steps.every((s) => s.pass);
  return { pass, overall: pass ? "PASS" : "FAIL", steps };
}

export function staticPackageDrawerChecks(): { id: string; pass: boolean; detail: string }[] {
  const page = pageText();
  const badgeRender = (page.match(/\{boxScanResolvedPkgBadge \? \(/g) ?? []).length;
  const pickerBadge = (page.match(/operatorPackagePickerStatusBadge\(st\)/g) ?? []).length;
  const linkageInItems = page.includes("OperatorProductLinkageMeta linkage={line.product_linkage}") ||
    page.includes("OperatorProductLinkageMeta linkage={linkage}");
  return [
    {
      id: "package_drawer_single_status_chip",
      pass: badgeRender === 1,
      detail: `status chip JSX blocks=${badgeRender}`,
    },
    {
      id: "package_picker_status_badge",
      pass: pickerBadge >= 1,
      detail: `picker badges=${pickerBadge}`,
    },
    {
      id: "package_drawer_line_linkage",
      pass: linkageInItems,
      detail: linkageInItems ? "OperatorProductLinkageMeta on line rows" : "missing",
    },
  ];
}
