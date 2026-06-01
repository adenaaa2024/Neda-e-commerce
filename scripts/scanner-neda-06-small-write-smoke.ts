/**
 * SCANNER-NEDA-06 — one small `return_items` write smoke (operator-mobile path parity).
 * Usage: npx tsx scripts/scanner-neda-06-small-write-smoke.ts
 *
 * Requires: .cursor/operator-approvals/scanner-neda-06-small-write-smoke-approval.md
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional: SCANNER_NEDA_06_RUN_ID, SCANNER_NEDA_06_FIXTURE_PACKAGE_ID, SCANNER_NEDA_06_DELETE_AFTER=true
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { RETURN_ITEMS_TABLE } from "../app/returns/returns-constants";
import {
  resolveItemBarcodeAgainstSlipRows,
  type SlipBarcodeMatchRow,
} from "../lib/scanner/operator-slip-item-resolve";
import {
  assertScriptReturnItemsWriteAllowed,
  DEFAULT_SCANNER_SMOKE_FIXTURE_PACKAGE_ID,
} from "../lib/script-return-items-write-guard";

const APPROVAL_PATH = join(
  process.cwd(),
  ".cursor/operator-approvals/scanner-neda-06-small-write-smoke-approval.md",
);
const APPROVAL_TOKEN = "APPROVED_TO_RUN_SCANNER_NEDA_06_SMALL_WRITE_SMOKE=true";

const RETURN_ITEMS_ITEM_SCAN_SELECT =
  "id, fnsku, sku, product_identifier, conditions, expiration_date, batch_number, photo_evidence, created_at, resolved_product_id, resolved_catalog_product_id, item_name, package_id, organization_id";

const DEFAULT_FIXTURE_PACKAGE_ID = DEFAULT_SCANNER_SMOKE_FIXTURE_PACKAGE_ID;

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

function scannedBarcodeFromRow(row: {
  fnsku?: string | null;
  sku?: string | null;
  product_identifier?: string | null;
}): string {
  const f = String(row.fnsku ?? "").trim();
  if (f) return f;
  const s = String(row.sku ?? "").trim();
  if (s) return s;
  return String(row.product_identifier ?? "").trim();
}

function slipContentIdForBarcode(barcode: string, slipRows: SlipBarcodeMatchRow[]): string | null {
  const outcome = resolveItemBarcodeAgainstSlipRows(barcode, slipRows);
  if (outcome.kind !== "single") return null;
  const sid = String(outcome.slip.id ?? "").trim();
  return sid.length > 0 ? sid : null;
}

function readApproval(): { ok: boolean; detail: string } {
  if (!existsSync(APPROVAL_PATH)) {
    return { ok: false, detail: `missing ${APPROVAL_PATH}` };
  }
  const text = readFileSync(APPROVAL_PATH, "utf8");
  if (!text.includes(APPROVAL_TOKEN)) {
    return { ok: false, detail: `approval token not found in ${APPROVAL_PATH}` };
  }
  return { ok: true, detail: "operator approval present" };
}

async function probePackageItemsAbsent(supabase: SupabaseClient): Promise<{ ok: boolean; detail: string }> {
  const { error } = await supabase.from("package_items").select("id").limit(1);
  if (error?.code === "PGRST205" || /Could not find the table/i.test(error?.message ?? "")) {
    return { ok: true, detail: "package_items absent or blocked (expected)" };
  }
  if (error) {
    return { ok: true, detail: `package_items probe error (non-fatal): ${error.message}` };
  }
  return { ok: false, detail: "package_items table responded — do not use for operator-mobile" };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const writeGuard = assertScriptReturnItemsWriteAllowed({
    testPackageIdEnv: "SCANNER_NEDA_06_FIXTURE_PACKAGE_ID",
    defaultTestPackageId: DEFAULT_FIXTURE_PACKAGE_ID,
  });
  const runId = process.env.SCANNER_NEDA_06_RUN_ID ?? "run-20260518-001";
  const outDir = join(
    process.cwd(),
    ".cursor/audit-reports/scanner-neda-06-small-write-smoke",
    runId,
  );
  const deleteAfter = process.env.SCANNER_NEDA_06_DELETE_AFTER === "true";

  const url = writeGuard.supabaseUrl;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  const report: Record<string, unknown> = {
    audit: "scanner-neda-06-small-write-smoke",
    run_id: runId,
    date: "2026-05-18",
    probe_method: "one return_items insert + hydrate verify (service role)",
    project_ref: extractProjectRef(url),
    approval: readApproval(),
    steps: [] as { step: string; ok: boolean; detail: string }[],
  };

  const steps = report.steps as { step: string; ok: boolean; detail: string }[];

  function step(name: string, ok: boolean, detail: string): void {
    steps.push({ step: name, ok, detail });
  }

  if (!report.approval || !(report.approval as { ok: boolean }).ok) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  if (!url || !key) {
    step("env", false, "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const pkgProbe = await probePackageItemsAbsent(supabase);
  step("package_items_absent", pkgProbe.ok, pkgProbe.detail);
  if (!pkgProbe.ok) {
    report.blocked = true;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const fixturePkgId = writeGuard.testPackageId;

  const { data: pkgRow, error: pkgErr } = await supabase
    .from("packages")
    .select("id, organization_id, store_id, tracking_number, package_code, actual_item_count")
    .eq("id", fixturePkgId)
    .is("deleted_at", null)
    .maybeSingle();

  if (pkgErr || !pkgRow) {
    step("fixture_package", false, pkgErr?.message ?? `package ${fixturePkgId} not found`);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const orgId = String(pkgRow.organization_id ?? "");
  const storeId = String(pkgRow.store_id ?? "");
  report.fixture = {
    package_id: pkgRow.id,
    organization_id: orgId,
    store_id: storeId,
    tracking_number: pkgRow.tracking_number,
    package_code: pkgRow.package_code,
    actual_item_count_before: pkgRow.actual_item_count,
  };
  step("fixture_package", true, `package ${fixturePkgId}`);

  const { data: slipRows, error: slipErr } = await supabase
    .from("slip_contents")
    .select("id, upc, fnsku, description, quantity, sort_index")
    .eq("package_id", fixturePkgId)
    .order("sort_index", { ascending: true });

  if (slipErr) {
    step("slip_rows", false, slipErr.message);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const slips: SlipBarcodeMatchRow[] = (slipRows ?? []).map((r) => ({
    id: String(r.id ?? ""),
    upc: r.upc as string | null,
    fnsku: r.fnsku as string | null,
    description: r.description as string | null,
    quantity: Number(r.quantity ?? 1),
    sort_index: Number(r.sort_index ?? 0),
  }));

  const matchable = slips.filter((s) => String(s.fnsku ?? "").trim() || String(s.upc ?? "").trim());
  if (matchable.length === 0) {
    step("slip_matchable_barcode", false, "no slip row with fnsku/upc");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const slip = matchable[0]!;
  const tier = String(slip.fnsku ?? "").trim() ? "fnsku" : "upc";
  const barcode = tier === "fnsku" ? String(slip.fnsku).trim() : String(slip.upc).trim();
  const resolveCheck = resolveItemBarcodeAgainstSlipRows(barcode, slips);
  step(
    "slip_barcode_resolve",
    resolveCheck.kind === "single",
    `${resolveCheck.kind} tier=${tier} barcode=${barcode}`,
  );

  const { count: productsBefore } = await supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);

  const { data: retBefore } = await supabase
    .from(RETURN_ITEMS_TABLE)
    .select("id")
    .eq("package_id", fixturePkgId)
    .is("deleted_at", null);

  const beforeCount = retBefore?.length ?? 0;
  report.return_items_before = beforeCount;

  const itemName = String(slip.description ?? "Scanned unit").trim().slice(0, 500) || "Scanned unit";
  const insertRow: Record<string, unknown> = {
    organization_id: orgId,
    store_id: storeId,
    package_id: fixturePkgId,
    marketplace: "amazon",
    item_name: itemName,
    conditions: ["sellable_ok"],
    status: "received",
    fnsku: tier === "fnsku" ? barcode.slice(0, 500) : null,
    sku: tier === "upc" ? barcode.slice(0, 500) : null,
    resolved_product_id: null,
    resolved_catalog_product_id: null,
  };

  const { data: inserted, error: insErr } = await supabase
    .from(RETURN_ITEMS_TABLE)
    .insert(insertRow)
    .select(RETURN_ITEMS_ITEM_SCAN_SELECT)
    .single();

  if (insErr || !inserted?.id) {
    step("return_items_insert", false, insErr?.message ?? "insert returned no id");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const returnId = String(inserted.id);
  report.inserted_return_item_id = returnId;
  step("return_items_insert", true, returnId);

  const { data: retAfter, error: retAfterErr } = await supabase
    .from(RETURN_ITEMS_TABLE)
    .select(RETURN_ITEMS_ITEM_SCAN_SELECT)
    .eq("package_id", fixturePkgId)
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  const hydrated = (retAfter ?? []).find((r) => String(r.id) === returnId);
  const hydrateOk = !retAfterErr && Boolean(hydrated);
  step(
    "reload_hydrate",
    hydrateOk,
    hydrateOk ? `found ${returnId} among ${retAfter?.length ?? 0} rows` : retAfterErr?.message ?? "row missing",
  );

  const scanned = scannedBarcodeFromRow(hydrated ?? inserted);
  const slipId = slipContentIdForBarcode(scanned, slips);
  const slipMatchOk = slipId === String(slip.id);
  step(
    "slip_line_match_by_barcode",
    slipMatchOk,
    `scanned=${scanned} slip_content_id=${slipId} expected=${slip.id}`,
  );

  const { count: productsAfter } = await supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);

  const noProductCreated =
    (productsAfter ?? 0) === (productsBefore ?? 0) &&
    !inserted.resolved_product_id &&
    !inserted.resolved_catalog_product_id;
  step(
    "no_product_from_ocr_title",
    noProductCreated,
    `products ${productsBefore}→${productsAfter} resolved_product_id=${inserted.resolved_product_id ?? "null"}`,
  );

  const { data: pkgAfter } = await supabase
    .from("packages")
    .select("actual_item_count")
    .eq("id", fixturePkgId)
    .maybeSingle();

  report.actual_item_count_after = pkgAfter?.actual_item_count ?? null;
  report.return_items_after = retAfter?.length ?? 0;

  report.rollback = {
    soft_delete: `update return_items set deleted_at = now() where id = '${returnId}';`,
    hard_delete: `delete from return_items where id = '${returnId}';`,
    verify: `select id, package_id, fnsku, sku, deleted_at from return_items where id = '${returnId}';`,
    package_count_check: `select actual_item_count from packages where id = '${fixturePkgId}';`,
    note: "Prefer soft_delete if RLS/audit expects tombstones; re-check packages.actual_item_count after delete.",
  };

  let deleted = false;
  if (deleteAfter) {
    const { error: delErr } = await supabase.from(RETURN_ITEMS_TABLE).delete().eq("id", returnId);
    deleted = !delErr;
    step("rollback_delete_after_probe", deleted, delErr?.message ?? "deleted");
    report.rollback_applied = deleted;
  } else {
    step("rollback_delete_after_probe", true, "skipped (set SCANNER_NEDA_06_DELETE_AFTER=true to auto-delete)");
  }

  report.no_package_items = pkgProbe.ok;
  report.pass =
    steps.every((s) => s.ok) &&
    Boolean(report.inserted_return_item_id) &&
    Boolean(report.no_package_items);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  const pass = Boolean(report.pass);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
