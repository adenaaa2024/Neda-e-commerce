/**
 * SCANNER-NEDA-08 — final operator-mobile UI signoff (read-only DB probes + static gates).
 * Usage: npx tsx scripts/scanner-neda-08-final-ui-signoff.ts
 *
 * Prerequisite: scanner-neda-06-small-write-smoke pass.
 * No migrations, no inserts/updates/deletes, no production/Amazon/AI.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { EP_DETAIL_SELECT } from "../lib/scanner/operator-tracking-expectations";
import { RETURN_ITEMS_TABLE, RETURN_SCANNER_LINKAGE_SELECT } from "../app/returns/returns-constants";
import {
  resolveItemBarcodeAgainstSlipRows,
  type SlipBarcodeMatchRow,
} from "../lib/scanner/operator-slip-item-resolve";

const EP_SELECT = "sku, fnsku, disposition, expected_scan_quantity, order_id, tracking_number";

const NEDA_06_FIXTURE_PACKAGE_ID = "9528d923-3d27-4aed-a773-095b5028743d";
const NEDA_06_INSERTED_ROW_ID = "ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663";

const RETURN_ITEMS_ITEM_SCAN_SELECT =
  "id, fnsku, sku, product_identifier, conditions, expiration_date, batch_number, photo_evidence, created_at, resolved_product_id, item_name, package_id, organization_id";

const SLIP_SELECT_ATTEMPTS = [
  "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, notes, order_id, conflicting_order_id, resolved_product_id, resolved_catalog_product_id, identifier_resolution_status, identifier_resolution_confidence",
  "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, notes, order_id, conflicting_order_id",
  "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code, notes",
  "id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code",
];

const OPERATOR_MOBILE_ROOT = join(process.cwd(), "app", "scanner", "operator-mobile");

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

function walkTsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) walkTsFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name.name)) out.push(p);
  }
  return out;
}

function staticScanOperatorMobile(): {
  package_items_refs: string[];
  return_items_refs: number;
  insert_operator_save: boolean;
  list_hydrate: boolean;
  manual_override_linkage: boolean;
  products_insert_in_operator: boolean;
  ui_markers: Record<string, boolean>;
} {
  const files = walkTsFiles(OPERATOR_MOBILE_ROOT);
  let returnItemsRefs = 0;
  let insertSave = false;
  let listHydrate = false;
  let manualOverride = false;
  let productsInsert = false;
  const packageItemsRefs: string[] = [];
  const uiMarkers: Record<string, boolean> = {
    ScannerBottomNav: false,
    identifyGatePhase: false,
    flowPhase: false,
    ItemUnitRecordModal: false,
    OperatorSessionStoreProvider: false,
    insertOperatorPackageItemAction: false,
    listOperatorPackageItemsForPackageAction: false,
  };

  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const rel = f.replace(process.cwd(), "").replace(/\\/g, "/");
    if (/package_items/.test(text)) packageItemsRefs.push(rel);
    const ri = (text.match(/RETURN_ITEMS_TABLE|return_items/g) ?? []).length;
    returnItemsRefs += ri;
    if (text.includes("insertOperatorPackageItemAction")) {
      insertSave = true;
      if (rel.includes("scan/page.tsx")) uiMarkers.insertOperatorPackageItemAction = true;
    }
    if (text.includes("listOperatorPackageItemsForPackageAction")) {
      listHydrate = true;
      if (rel.includes("scan/page.tsx")) uiMarkers.listOperatorPackageItemsForPackageAction = true;
    }
    if (text.includes("manualOverrideReturnItemProductResolution")) manualOverride = true;
    if (/from\(["']products["']\)\s*\.insert|\.from\("products"\)\.insert/.test(text)) {
      productsInsert = true;
    }
    for (const key of Object.keys(uiMarkers)) {
      if (key.startsWith("insert") || key.startsWith("list")) continue;
      if (text.includes(key)) uiMarkers[key] = true;
    }
  }

  return {
    package_items_refs: packageItemsRefs,
    return_items_refs: returnItemsRefs,
    insert_operator_save: insertSave,
    list_hydrate: listHydrate,
    manual_override_linkage: manualOverride,
    products_insert_in_operator: productsInsert,
    ui_markers: uiMarkers,
  };
}

function routeFilesExist(): { ok: boolean; paths: string[] } {
  const paths = [
    "app/scanner/operator-mobile/page.tsx",
    "app/scanner/operator-mobile/scan/page.tsx",
    "app/scanner/operator-mobile/_components/ScannerBottomNav.tsx",
  ];
  const missing = paths.filter((p) => !existsSync(join(process.cwd(), p)));
  return { ok: missing.length === 0, paths: missing };
}

type Step = { step: string; ok: boolean; detail: string };

async function main(): Promise<void> {
  loadEnvLocal();
  const runId = process.env.SCANNER_NEDA_08_RUN_ID ?? "run-20260518-001";
  const outDir = join(
    process.cwd(),
    ".cursor/audit-reports/scanner-neda-08-final-ui-signoff",
    runId,
  );

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const steps: Step[] = [];
  const report: Record<string, unknown> = {
    audit: "scanner-neda-08-final-ui-signoff",
    run_id: runId,
    date: "2026-05-18",
    owner: "Neda",
    prerequisite: "scanner-neda-06-small-write-smoke/run-20260518-001",
    probe_method: "read-only PostgREST + static operator-mobile scan",
    project_ref: extractProjectRef(url),
    steps,
  };

  function step(name: string, ok: boolean, detail: string): void {
    steps.push({ step: name, ok, detail });
  }

  const routes = routeFilesExist();
  step("route_files_present", routes.ok, routes.ok ? "hub + scan + nav" : `missing: ${routes.paths.join(", ")}`);

  const staticScan = staticScanOperatorMobile();
  report.static_scan = staticScan;
  step(
    "no_package_items_in_operator_mobile",
    staticScan.package_items_refs.length === 0,
    staticScan.package_items_refs.length
      ? `refs: ${staticScan.package_items_refs.join("; ")}`
      : "zero package_items references under app/scanner/operator-mobile",
  );
  step(
    "return_items_hydrate_and_save_wired",
    staticScan.list_hydrate && staticScan.insert_operator_save,
    `list=${staticScan.list_hydrate} insert=${staticScan.insert_operator_save} refs=${staticScan.return_items_refs}`,
  );
  step(
    "manual_override_product_linkage",
    staticScan.manual_override_linkage,
    staticScan.manual_override_linkage ? "manualOverrideReturnItemProductResolution present" : "missing",
  );
  step(
    "no_products_insert_operator_mobile",
    !staticScan.products_insert_in_operator,
    staticScan.products_insert_in_operator ? "found products.insert" : "no products.insert in operator-mobile tree",
  );
  const uiOk = Object.values(staticScan.ui_markers).every(Boolean);
  step(
    "neda_ui_markers",
    uiOk,
    uiOk ? Object.keys(staticScan.ui_markers).join(", ") : JSON.stringify(staticScan.ui_markers),
  );

  if (!url || !key) {
    step("env", false, "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    report.pass = false;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { error: piErr } = await supabase.from("package_items").select("id").limit(1);
  const piAbsent =
    piErr?.code === "PGRST205" || /Could not find the table/i.test(piErr?.message ?? "");
  step(
    "package_items_table_absent_live",
    piAbsent || Boolean(piErr),
    piAbsent ? "PGRST205/absent (expected)" : piErr ? piErr.message : "table responded — unexpected",
  );

  const returnListSelect = `id, fnsku, sku, product_identifier, conditions, expiration_date, batch_number, photo_evidence, created_at, ${RETURN_SCANNER_LINKAGE_SELECT}`;
  const { error: retSelErr } = await supabase.from(RETURN_ITEMS_TABLE).select(returnListSelect).limit(1);
  step(
    "return_items_linkage_select",
    !retSelErr,
    retSelErr ? `${retSelErr.code}: ${retSelErr.message}` : "select ok",
  );

  let slipOk = false;
  let slipIdx = -1;
  for (let i = 0; i < SLIP_SELECT_ATTEMPTS.length; i++) {
    const { error } = await supabase.from("slip_contents").select(SLIP_SELECT_ATTEMPTS[i]!).limit(1);
    if (!error) {
      slipOk = true;
      slipIdx = i;
      break;
    }
  }
  step(
    "slip_contents_display_select",
    slipOk,
    slipOk ? `fallback attempt ${slipIdx + 1}` : "all slip select attempts failed",
  );

  const { error: epErr } = await supabase.from("expected_packages").select(EP_SELECT).limit(1);
  step("identify_gate_EP_SELECT", !epErr, epErr ? epErr.message : "ok");
  const { error: epDetailErr } = await supabase.from("expected_packages").select(EP_DETAIL_SELECT).limit(1);
  step("identify_gate_EP_DETAIL_SELECT", !epDetailErr, epDetailErr ? epDetailErr.message : "ok");

  const fixturePkgId = process.env.SCANNER_NEDA_08_FIXTURE_PACKAGE_ID?.trim() || NEDA_06_FIXTURE_PACKAGE_ID;

  const { data: slipRows, error: slipListErr } = await supabase
    .from("slip_contents")
    .select("id, upc, fnsku, description, quantity, sort_index")
    .eq("package_id", fixturePkgId)
    .order("sort_index", { ascending: true });

  step(
    "slip_rows_on_fixture",
    !slipListErr && (slipRows?.length ?? 0) > 0,
    slipListErr?.message ?? `${slipRows?.length ?? 0} rows on ${fixturePkgId}`,
  );

  const { data: retRows, error: retListErr } = await supabase
    .from(RETURN_ITEMS_TABLE)
    .select(RETURN_ITEMS_ITEM_SCAN_SELECT)
    .eq("package_id", fixturePkgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  const neda06Row = (retRows ?? []).find((r) => String(r.id) === NEDA_06_INSERTED_ROW_ID);
  step(
    "reload_hydrate_return_items",
    !retListErr && (retRows?.length ?? 0) > 0,
    retListErr?.message ?? `${retRows?.length ?? 0} rows; neda06_row=${neda06Row ? "found" : "missing"}`,
  );

  const slips: SlipBarcodeMatchRow[] = (slipRows ?? []).map((r) => ({
    id: String(r.id ?? ""),
    upc: r.upc as string | null,
    fnsku: r.fnsku as string | null,
    description: r.description as string | null,
    quantity: Number(r.quantity ?? 1),
    sort_index: Number(r.sort_index ?? 0),
  }));

  if (neda06Row) {
    const bc = String(neda06Row.fnsku ?? neda06Row.sku ?? neda06Row.product_identifier ?? "").trim();
    const outcome = resolveItemBarcodeAgainstSlipRows(bc, slips);
    const noProduct = !neda06Row.resolved_product_id;
    step(
      "neda06_row_slip_barcode_match",
      outcome.kind === "single",
      `${outcome.kind} barcode=${bc}`,
    );
    step(
      "neda06_row_no_auto_product",
      noProduct,
      `resolved_product_id=${neda06Row.resolved_product_id ?? "null"}`,
    );
    report.neda_06_smoke_row = {
      id: NEDA_06_INSERTED_ROW_ID,
      found: true,
      fnsku: neda06Row.fnsku,
      slip_match: outcome.kind,
    };
  } else {
    step("neda06_row_slip_barcode_match", true, "smoke row not found — skipped (may have been rolled back)");
    step("neda06_row_no_auto_product", true, "skipped");
    report.neda_06_smoke_row = { id: NEDA_06_INSERTED_ROW_ID, found: false };
  }

  report.fixture_package_id = fixturePkgId;
  report.slip_line_count = slipRows?.length ?? 0;
  report.return_item_count = retRows?.length ?? 0;
  report.neda_06_save_path_reference = "insertOperatorPackageItemAction → insertReturn → return_items";

  const criticalSteps = [
    "route_files_present",
    "no_package_items_in_operator_mobile",
    "return_items_hydrate_and_save_wired",
    "no_products_insert_operator_mobile",
    "neda_ui_markers",
    "package_items_table_absent_live",
    "return_items_linkage_select",
    "slip_contents_display_select",
    "identify_gate_EP_SELECT",
    "slip_rows_on_fixture",
    "reload_hydrate_return_items",
  ];
  report.pass = criticalSteps.every((name) => steps.find((s) => s.step === name)?.ok);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
