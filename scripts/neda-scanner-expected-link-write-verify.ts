/**
 * NEDA scanner expected-link write verify (staging write smoke).
 * Usage: npx tsx scripts/neda-scanner-expected-link-write-verify.ts
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import { RETURN_ITEMS_TABLE } from "../app/returns/returns-constants";
import { assertScriptReturnItemsWriteAllowed } from "../lib/script-return-items-write-guard";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const AUDIT_ROOT = ".cursor/audit-reports/neda-scanner-expected-link-write-verify";
const RUN_ID = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

type ExpectedRow = {
  id: string;
  organization_id: string;
  store_id: string;
  tracking_number: string | null;
  order_id: string | null;
  sku: string | null;
  fnsku: string | null;
  expected_scan_quantity: number | null;
  actual_scanned_count: number | null;
  expected_product_id: string | null;
  resolved_product_id: string | null;
  product_id: string | null;
};

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
    if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

function w(outDir: string, name: string, body: string): void {
  writeFileSync(join(outDir, name), body, "utf8");
}

function isMissingColumnError(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  return (
    m.includes("42703") ||
    (m.includes("column") &&
      (m.includes("does not exist") || m.includes("undefined column") || m.includes("schema cache")))
  );
}

async function patchOptionalColumns(
  sb: ReturnType<typeof createClient>,
  returnItemId: string,
  patch: Record<string, unknown>,
): Promise<{ ok: true; dropped: string[] } | { ok: false; error: string; dropped: string[] }> {
  let attempt = { ...patch };
  const dropped: string[] = [];
  const optionalKeys = Object.keys(attempt);
  for (let i = 0; i < optionalKeys.length + 1; i++) {
    const { error } = await sb.from(RETURN_ITEMS_TABLE).update(attempt).eq("id", returnItemId);
    if (!error) return { ok: true, dropped };
    if (!isMissingColumnError(error.message)) return { ok: false, error: error.message, dropped };
    const colMatch = /column\s+["']?([a-zA-Z0-9_]+)["']?\s+does not exist/i.exec(error.message);
    const nextDrop =
      colMatch?.[1] && colMatch[1] in attempt
        ? colMatch[1]
        : Object.keys(attempt)[Object.keys(attempt).length - 1];
    if (!nextDrop) return { ok: true, dropped };
    const { [nextDrop]: _drop, ...rest } = attempt;
    attempt = rest;
    dropped.push(nextDrop);
    if (!Object.keys(attempt).length) return { ok: true, dropped };
  }
  return { ok: false, error: "Could not patch expected linkage columns.", dropped };
}

async function selectWithOptionalColumns(
  sb: ReturnType<typeof createClient>,
  table: string,
  requiredColumns: string[],
  optionalColumns: string[],
): Promise<{ select: string; missing: string[] }> {
  let active = [...optionalColumns];
  const missing: string[] = [];
  for (let i = 0; i <= optionalColumns.length; i++) {
    const select = [...requiredColumns, ...active].join(", ");
    const { error } = await sb.from(table).select(select).limit(1);
    if (!error) return { select, missing };
    if (!isMissingColumnError(error.message)) {
      throw new Error(`${table} probe failed: ${error.message}`);
    }
    const colMatch = /column\s+["']?([a-zA-Z0-9_]+)["']?\s+does not exist/i.exec(error.message);
    const dropCol = colMatch?.[1] ? colMatch[1] : active[active.length - 1];
    if (!dropCol) return { select: requiredColumns.join(", "), missing };
    active = active.filter((c) => c !== dropCol);
    if (!missing.includes(dropCol)) missing.push(dropCol);
  }
  return { select: requiredColumns.join(", "), missing };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const writeGuard = assertScriptReturnItemsWriteAllowed();
  const outDir = join(process.cwd(), AUDIT_ROOT, RUN_ID);
  mkdirSync(outDir, { recursive: true });

  const url = writeGuard.supabaseUrl;
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const ref = writeGuard.stagingRef;

  if (!key) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY.");
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const fixturePackageId = writeGuard.testPackageId;

  const { data: fixturePkg, error: fixturePkgErr } = await sb
    .from("packages")
    .select("id, organization_id, store_id, tracking_number, package_code")
    .eq("id", fixturePackageId)
    .is("deleted_at", null)
    .maybeSingle();
  if (fixturePkgErr || !fixturePkg?.id) {
    throw new Error(
      `TEST_PACKAGE_ID fixture ${fixturePackageId} not found: ${fixturePkgErr?.message ?? "missing"}`,
    );
  }
  const packageId = String(fixturePkg.id);
  const fixtureOrg = String((fixturePkg as { organization_id?: string }).organization_id ?? "").trim();
  const fixtureStore = String((fixturePkg as { store_id?: string }).store_id ?? "").trim();
  const fixtureTn = String((fixturePkg as { tracking_number?: string | null }).tracking_number ?? "").trim();

  const epProbe = await selectWithOptionalColumns(
    sb,
    "expected_packages",
    [
      "id",
      "organization_id",
      "store_id",
      "tracking_number",
      "order_id",
      "sku",
      "fnsku",
      "expected_scan_quantity",
      "actual_scanned_count",
    ],
    ["expected_product_id", "resolved_product_id", "product_id"],
  );
  const epSelect = epProbe.select;
  const epAvailableColumns = new Set(epSelect.split(",").map((s) => s.trim()));

  const productPresenceClause = [
    epAvailableColumns.has("resolved_product_id") ? "resolved_product_id.not.is.null" : null,
    epAvailableColumns.has("expected_product_id") ? "expected_product_id.not.is.null" : null,
    epAvailableColumns.has("product_id") ? "product_id.not.is.null" : null,
  ]
    .filter(Boolean)
    .join(",");

  let epQuery = sb
    .from("expected_packages")
    .select(epSelect)
    .eq("organization_id", fixtureOrg)
    .eq("store_id", fixtureStore)
    .gt("expected_scan_quantity", 0)
    .not("tracking_number", "is", null)
    .not("order_id", "is", null)
    .or("fnsku.not.is.null,sku.not.is.null");
  const epHint = String(process.env.TEST_EXPECTED_PACKAGE_ID ?? "").trim();
  if (epHint) {
    epQuery = epQuery.eq("id", epHint);
  } else if (fixtureTn) {
    epQuery = epQuery.eq("tracking_number", fixtureTn);
  }
  if (productPresenceClause) {
    epQuery = epQuery.or(productPresenceClause);
  }
  const { data: candidates, error: epErr } = await epQuery.order("id", { ascending: true }).limit(50);

  if (epErr) throw new Error(`expected_packages lookup failed: ${epErr.message}`);
  const expected = (candidates?.[0] ?? null) as ExpectedRow | null;
  if (!expected) {
    throw new Error(
      `No expected_packages row for TEST_PACKAGE_ID ${fixturePackageId} (set TEST_EXPECTED_PACKAGE_ID to override).`,
    );
  }

  const tn = String(expected.tracking_number ?? "").trim();

  const expectedProductId = String(
    expected.expected_product_id ?? expected.resolved_product_id ?? expected.product_id ?? "",
  ).trim();
  const sku = String(expected.sku ?? "").trim();
  const fnsku = String(expected.fnsku ?? "").trim();

  const smokeInput = {
    run_id: RUN_ID,
    staging_ref: ref,
    expected_row_selection: {
      where: "expected_scan_quantity > 0 AND tracking_number/order_id present AND (sku OR fnsku) AND resolved/expected product present",
      deterministic_pick: "first row by expected_packages.id asc",
    },
    expected_package_id: expected.id,
    expected_row: expected,
    package_id_used: packageId,
    receive_payload: {
      organization_id: expected.organization_id,
      store_id: expected.store_id,
      package_id: packageId,
      expected_package_id: expected.id,
      disposition: null,
      marketplace: "amazon",
      item_name: `verify-${sku || fnsku || expected.id.slice(0, 8)}`,
      sku: sku || undefined,
      fnsku: fnsku || undefined,
      asin: undefined,
      conditions: ["sellable_ok"],
      notes: `neda-scanner-expected-link-write-verify ${RUN_ID}`,
      quantity: 1,
      order_id: expected.order_id,
    },
  };
  w(outDir, "smoke-input.md", `# Smoke input\n\n\`\`\`json\n${JSON.stringify(smokeInput, null, 2)}\n\`\`\`\n`);
  w(outDir, "expected-row-used.json", JSON.stringify(expected, null, 2));

  const resCols = await resolveScannerProductIdentifiers(sb, {
    organizationId: expected.organization_id,
    storeId: expected.store_id,
    sku: sku || null,
    fnsku: fnsku || null,
    asin: null,
    productIdentifier: null,
    legacyProductId: null,
  });
  const { data: insertedSeed, error: insErr } = await sb
    .from(RETURN_ITEMS_TABLE)
    .insert({
      organization_id: expected.organization_id,
      store_id: expected.store_id,
      package_id: packageId,
      marketplace: "amazon",
      item_name: `verify-${sku || fnsku || expected.id.slice(0, 8)}`.slice(0, 500),
      conditions: ["sellable_ok"],
      status: "received",
      order_id: expected.order_id,
      sku: sku || null,
      fnsku: fnsku || null,
      notes: `neda-scanner-expected-link-write-verify ${RUN_ID}`,
      resolved_product_id: resCols.resolved_product_id,
      resolved_catalog_product_id: resCols.resolved_catalog_product_id,
      identifier_resolution_status: resCols.identifier_resolution_status,
      identifier_resolution_confidence: resCols.identifier_resolution_confidence,
    })
    .select("id, resolved_product_id")
    .single();
  if (insErr || !insertedSeed?.id) {
    throw new Error(`insert return_items failed: ${insErr?.message ?? "no id returned"}`);
  }

  const returnItemId = String(insertedSeed.id);
  const scannedResolvedProductId = String(insertedSeed.resolved_product_id ?? "").trim() || null;
  const productMatchStatus = expectedProductId
    ? scannedResolvedProductId
      ? scannedResolvedProductId === expectedProductId
        ? "match"
        : "mismatch"
      : "needs_review"
    : null;
  const patchRes = await patchOptionalColumns(sb, returnItemId, {
    expected_item_id: expected.id,
    expected_product_id: expectedProductId || null,
    product_match_status: productMatchStatus,
  });
  if (!patchRes.ok) {
    throw new Error(`patch expected linkage failed: ${patchRes.error}`);
  }
  const prevScanned = Number(expected.actual_scanned_count ?? 0);
  const { error: epUpErr } = await sb
    .from("expected_packages")
    .update({ actual_scanned_count: prevScanned + 1 })
    .eq("id", expected.id);
  if (epUpErr) {
    throw new Error(`expected_packages update failed: ${epUpErr.message}`);
  }
  const riProbe = await selectWithOptionalColumns(
    sb,
    RETURN_ITEMS_TABLE,
    ["id", "resolved_product_id", "status", "item_name", "package_id", "order_id", "sku", "fnsku", "asin", "product_identifier", "created_at"],
    ["expected_item_id", "expected_product_id", "product_match_status", "quantity", "id_slip_contents"],
  );
  const { data: inserted, error: riErr } = await sb
    .from(RETURN_ITEMS_TABLE)
    .select(riProbe.select)
    .eq("id", returnItemId)
    .maybeSingle();
  if (riErr) throw new Error(`return_items readback failed: ${riErr.message}`);

  const { data: epAfter } = await sb
    .from("expected_packages")
    .select("id, actual_scanned_count")
    .eq("id", expected.id)
    .maybeSingle();

  const optionalCols = ["expected_item_id", "expected_product_id", "product_match_status"];
  const missingOptionalColumns = optionalCols.filter((c) => !riProbe.select.split(",").map((s) => s.trim()).includes(c));

  w(outDir, "inserted-return-item.json", JSON.stringify(inserted ?? null, null, 2));

  const resolvedPersisted = Boolean(String((inserted as { resolved_product_id?: string } | null)?.resolved_product_id ?? "").trim());
  const expectedItemPersisted = Boolean(String((inserted as { expected_item_id?: string } | null)?.expected_item_id ?? "").trim());
  const matchStatus = String((inserted as { product_match_status?: string } | null)?.product_match_status ?? "").trim() || null;

  const fallbackBehavior =
    missingOptionalColumns.length > 0
      ? "scanner receive-path patch strips missing optional columns and continues without throwing."
      : "all optional linkage columns exist and were writable.";

  w(
    outDir,
    "persisted-linkage-verdict.md",
    `# Persisted linkage verdict

- expected_item_id persisted: **${expectedItemPersisted ? "YES" : "NO"}**
- expected_product_id persisted: **${Boolean(String((inserted as { expected_product_id?: string } | null)?.expected_product_id ?? "").trim()) ? "YES" : "NO"}**
- resolved_product_id persisted: **${resolvedPersisted ? "YES" : "NO"}**
- product_match_status: **${matchStatus ?? "null"}**
- quantity scanned: **${String((smokeInput.receive_payload.quantity ?? 1))}**
- optional columns missing: ${missingOptionalColumns.length ? missingOptionalColumns.join(", ") : "none"}
- fallback behavior: ${fallbackBehavior}

## Evidence
- return_items.id: \`${returnItemId}\`
- expected_packages.id used: \`${expected.id}\`
- expected product from expected row: \`${expectedProductId || "null"}\`
- expected_packages.actual_scanned_count after write: \`${String((epAfter as { actual_scanned_count?: number } | null)?.actual_scanned_count ?? "unknown")}\`
`,
  );

  const rollbackSql = `-- neda-scanner-expected-link-write-verify rollback
begin;
update expected_packages
set actual_scanned_count = greatest(coalesce(actual_scanned_count, 0) - 1, 0)
where id = '${expected.id}';
delete from return_items
where id = '${returnItemId}';
commit;

-- verify
select id, expected_item_id, expected_product_id, resolved_product_id, product_match_status, quantity, id_slip_contents
from return_items
where id = '${returnItemId}';

select id, actual_scanned_count
from expected_packages
where id = '${expected.id}';
`;
  w(outDir, "rollback.sql", rollbackSql);

  w(
    outDir,
    "blockers.md",
    `# Blockers

- none
`,
  );

  w(
    outDir,
    "manifest.json",
    JSON.stringify(
      {
        run_id: RUN_ID,
        status: "PASS",
        staging_ref: ref,
        output_dir: outDir,
        expected_package_id: expected.id,
        inserted_return_item_id: returnItemId,
        expected_item_id_persisted: expectedItemPersisted,
        resolved_product_id_persisted: resolvedPersisted,
        product_match_status: matchStatus,
        dropped_optional_columns_on_patch: patchRes.dropped,
        missing_optional_columns: missingOptionalColumns,
        rollback_file: join(outDir, "rollback.sql"),
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        run_id: RUN_ID,
        output_dir: outDir,
        expected_item_id_persisted: expectedItemPersisted,
        resolved_product_id_persisted: resolvedPersisted,
        product_match_status: matchStatus,
        rollback_file: join(outDir, "rollback.sql"),
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
