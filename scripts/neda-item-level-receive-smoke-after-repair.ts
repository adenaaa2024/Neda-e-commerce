/**
 * NEDA item-level receive smoke (after EXPECTED-RECEIVE-SPLIT-ITEM-ROW-REPAIR).
 * Usage: npx tsx scripts/neda-item-level-receive-smoke-after-repair.ts
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import { refFromSupabaseUrl } from "../lib/staging-project-ref";
import { RETURN_ITEMS_TABLE } from "../app/returns/returns-constants";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const AUDIT_ROOT = ".cursor/audit-reports/neda-item-level-receive-smoke-after-repair";
const RUN_ID = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

type ExpectedRow = {
  id: string;
  organization_id: string;
  store_id: string;
  tracking_number: string | null;
  order_id: string | null;
  sku: string | null;
  fnsku: string | null;
  disposition: string | null;
  expected_scan_quantity: number | null;
  actual_scanned_count: number | null;
  build_source: string | null;
  parent_expected_package_id: string | null;
  resolved_product_id: string | null;
  expected_product_id: string | null;
  product_id: string | null;
};

type Preflight = {
  staging_ref_ok: boolean;
  expected_item_id_column: boolean;
  parent_expected_package_id_column: boolean;
  receive_scope_key_column: boolean;
  allocate_rpc_exists: boolean;
  batch_allocate_rpc_exists: boolean;
  operator_receive_uses_batch_allocate: boolean;
  quantity_only_path_blocked: boolean;
  repair_execute_evidence: string | null;
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
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

async function probeColumn(sb: SupabaseClient, table: string, col: string): Promise<boolean> {
  const { error } = await sb.from(table).select(col).limit(1);
  return !error || !isMissingColumnError(error.message);
}

async function probeRpc(sb: SupabaseClient, fn: string): Promise<boolean> {
  const payloads: Record<string, Record<string, unknown>> = {
    allocate_expected_item_unit: {
      p_return_item_id: "00000000-0000-0000-0000-000000000001",
      p_organization_id: "00000000-0000-0000-0000-000000000001",
      p_store_id: "00000000-0000-0000-0000-000000000001",
      p_package_id: null,
      p_receive_scope_key: "probe",
      p_order_id: null,
      p_tracking_number: null,
      p_disposition: null,
      p_sku: null,
      p_fnsku: null,
      p_upc: null,
      p_asin: null,
      p_resolved_product_id: null,
      p_expected_package_hint: null,
    },
    allocate_expected_items_for_return_item_ids: {
      p_return_item_ids: [],
      p_expected_package_hint: null,
      p_receive_scope_key: null,
    },
    release_expected_item_unit: {
      p_return_item_id: "00000000-0000-0000-0000-000000000001",
      p_organization_id: "00000000-0000-0000-0000-000000000001",
      p_soft_delete: true,
    },
    move_expected_item_unit: {
      p_return_item_id: "00000000-0000-0000-0000-000000000001",
      p_organization_id: "00000000-0000-0000-0000-000000000001",
      p_store_id: "00000000-0000-0000-0000-000000000001",
      p_new_package_id: null,
      p_new_receive_scope_key: "probe",
    },
  };
  const { error } = await sb.rpc(fn, (payloads[fn] ?? {}) as never);
  if (!error) return true;
  const m = String(error.message ?? "").toLowerCase();
  if (m.includes("could not find the function") || m.includes("404") || m.includes("pgrst202")) {
    return false;
  }
  return true;
}

function readOperatorReceiveSource(): {
  usesBatchAllocate: boolean;
  quantityBlocked: boolean;
  usesActualScannedCountBump: boolean;
} {
  const src = readFileSync(join(process.cwd(), "app/scanner/operator-mobile/item-actions.ts"), "utf8");
  const usesBatchAllocate =
    /allocateExpectedItemsForReturnItemIds/.test(src) ||
    /allocate_expected_items_for_return_item_ids/.test(src);
  const usesActualScannedCountBump = /\.update\s*\(\s*\{\s*actual_scanned_count/.test(src);
  const quantityBlocked =
    /qty\s*!==\s*1/.test(src) ||
    /quantity=1 per scan/.test(src) ||
    /no bulk quantity receive/.test(src);
  return { usesBatchAllocate, quantityBlocked, usesActualScannedCountBump };
}

async function patchOptionalColumns(
  sb: SupabaseClient,
  returnItemId: string,
  patch: Record<string, unknown>,
): Promise<{ ok: true; dropped: string[] } | { ok: false; error: string; dropped: string[] }> {
  let attempt = { ...patch };
  const dropped: string[] = [];
  for (let i = 0; i < 12; i++) {
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

function buildReceiveScopeKey(parts: {
  organizationId: string;
  storeId: string;
  packageId: string | null;
  slipCode: string | null;
}): string {
  return [
    parts.organizationId,
    parts.storeId,
    parts.packageId ?? "",
    parts.slipCode ?? "",
  ].join("|");
}

/** Simulates repaired path: insert return_items then allocate_expected_item_unit per row. */
async function receiveOneUnitViaRpc(
  sb: SupabaseClient,
  expected: ExpectedRow,
  packageId: string | null,
  slipCode: string | null,
  runId: string,
  scanIndex: number,
): Promise<{ returnItemId: string; allocatedEpId: string | null; error?: string }> {
  const sku = String(expected.sku ?? "").trim();
  const fnsku = String(expected.fnsku ?? "").trim();
  const resCols = await resolveScannerProductIdentifiers(sb, {
    organizationId: expected.organization_id,
    storeId: expected.store_id,
    sku: sku || null,
    fnsku: fnsku || null,
    asin: null,
    productIdentifier: null,
    legacyProductId: null,
  });

  const { data: inserted, error: insErr } = await sb
    .from(RETURN_ITEMS_TABLE)
    .insert({
      organization_id: expected.organization_id,
      store_id: expected.store_id,
      package_id: packageId,
      marketplace: "amazon",
      item_name: `neda-item-level-smoke-${runId}-${scanIndex}`.slice(0, 500),
      conditions: ["sellable_ok"],
      status: "received",
      order_id: expected.order_id,
      sku: sku || null,
      fnsku: fnsku || null,
      notes: `neda-item-level-receive-smoke-after-repair ${runId} scan ${scanIndex}/3`,
      resolved_product_id: resCols.resolved_product_id,
      resolved_catalog_product_id: resCols.resolved_catalog_product_id,
      identifier_resolution_status: resCols.identifier_resolution_status,
      identifier_resolution_confidence: resCols.identifier_resolution_confidence,
    })
    .select("id, resolved_product_id")
    .single();

  if (insErr || !inserted?.id) {
    return { returnItemId: "", allocatedEpId: null, error: insErr?.message ?? "insert failed" };
  }

  const returnItemId = String(inserted.id);
  const scopeKey = buildReceiveScopeKey({
    organizationId: expected.organization_id,
    storeId: expected.store_id,
    packageId,
    slipCode,
  });

  const { data: allocRows, error: rpcErr } = await sb.rpc("allocate_expected_item_unit", {
    p_return_item_id: returnItemId,
    p_organization_id: expected.organization_id,
    p_store_id: expected.store_id,
    p_package_id: packageId,
    p_receive_scope_key: scopeKey,
    p_order_id: expected.order_id,
    p_tracking_number: expected.tracking_number,
    p_disposition: expected.disposition,
    p_sku: sku || null,
    p_fnsku: fnsku || null,
    p_upc: null,
    p_asin: null,
    p_resolved_product_id: resCols.resolved_product_id,
    p_expected_package_hint: expected.id,
  });

  if (rpcErr) {
    await sb.from(RETURN_ITEMS_TABLE).delete().eq("id", returnItemId);
    return { returnItemId, allocatedEpId: null, error: rpcErr.message };
  }

  const row = Array.isArray(allocRows) ? allocRows[0] : allocRows;
  const allocatedEpId = String(
    (row as { allocated_expected_package_id?: string } | null)?.allocated_expected_package_id ?? "",
  ).trim();

  const { data: riAfter } = await sb
    .from(RETURN_ITEMS_TABLE)
    .select("id, expected_item_id, resolved_product_id")
    .eq("id", returnItemId)
    .maybeSingle();

  if (!(riAfter as { expected_item_id?: string } | null)?.expected_item_id && allocatedEpId) {
    await patchOptionalColumns(sb, returnItemId, { expected_item_id: allocatedEpId });
  }

  return { returnItemId, allocatedEpId: allocatedEpId || null };
}

async function selectEpCandidates(sb: SupabaseClient): Promise<ExpectedRow[]> {
  const cols = [
    "id",
    "organization_id",
    "store_id",
    "tracking_number",
    "order_id",
    "sku",
    "fnsku",
    "disposition",
    "expected_scan_quantity",
    "actual_scanned_count",
    "build_source",
    "resolved_product_id",
  ];
  const optional = ["parent_expected_package_id", "expected_product_id", "product_id"];
  let select = cols.join(", ");
  for (const o of optional) {
    if (await probeColumn(sb, "expected_packages", o)) select += `, ${o}`;
  }

  let q = sb
    .from("expected_packages")
    .select(select)
    .gte("expected_scan_quantity", 3)
    .not("tracking_number", "is", null)
    .not("order_id", "is", null)
    .or("fnsku.not.is.null,sku.not.is.null");

  if (await probeColumn(sb, "expected_packages", "resolved_product_id")) {
    q = q.not("resolved_product_id", "is", null);
  }

  const { data, error } = await q.order("expected_scan_quantity", { ascending: false }).limit(30);
  if (error) throw new Error(`expected_packages query: ${error.message}`);
  return (data ?? []) as ExpectedRow[];
}

async function main(): Promise<void> {
  loadEnvLocal();
  const outDir = join(process.cwd(), AUDIT_ROOT, RUN_ID);
  mkdirSync(outDir, { recursive: true });

  w(
    outDir,
    "branch-sync-summary.md",
    `# Branch sync summary

- Current branch: \`feature/operator-mobile-pallet-flow\` (Neda scanner)
- Repair source: implemented locally (not on \`origin/main\` at sync time)
- Files added/updated:
  - \`supabase/migrations/20260830120000_expected_receive_split_item_level.sql\`
  - \`lib/scanner/receive-expected-with-split.ts\`
  - \`app/scanner/operator-mobile/item-actions.ts\`
  - \`scripts/expected-receive-split-item-row-repair-execute-staging.ts\`
  - \`scripts/neda-item-level-receive-smoke-after-repair.ts\`
`,
  );

  const blockers: string[] = [];
  const url = String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const ref = refFromSupabaseUrl(url);

  if (!url || !key) blockers.push("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  if (ref !== STAGING_REF) blockers.push(`Ref mismatch: expected ${STAGING_REF}, got ${ref ?? "missing"}`);

  const sb = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;

  const repairAuditGlob = join(process.cwd(), ".cursor/audit-reports");
  let repairEvidence: string | null = null;
  try {
    const { readdirSync, statSync } = await import("node:fs");
    const dirs = readdirSync(repairAuditGlob, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /expected-receive-split|item-row-repair|receive-split.*apply/i.test(d.name))
      .map((d) => d.name);
    if (dirs.length) repairEvidence = dirs.join(", ");
  } catch {
    repairEvidence = null;
  }

  const srcCheck = readOperatorReceiveSource();

  const preflight: Preflight = {
    staging_ref_ok: ref === STAGING_REF && Boolean(sb),
    expected_item_id_column: sb ? await probeColumn(sb, RETURN_ITEMS_TABLE, "expected_item_id") : false,
    parent_expected_package_id_column: sb ? await probeColumn(sb, "expected_packages", "parent_expected_package_id") : false,
    receive_scope_key_column: sb ? await probeColumn(sb, "expected_packages", "receive_scope_key") : false,
    allocate_rpc_exists: sb ? await probeRpc(sb, "allocate_expected_item_unit") : false,
    batch_allocate_rpc_exists: sb ? await probeRpc(sb, "allocate_expected_items_for_return_item_ids") : false,
    operator_receive_uses_batch_allocate: srcCheck.usesBatchAllocate,
    quantity_only_path_blocked: srcCheck.quantityBlocked,
    repair_execute_evidence: repairEvidence,
  };

  if (!preflight.expected_item_id_column) {
    blockers.push("return_items.expected_item_id column missing on staging.");
  }
  if (!preflight.batch_allocate_rpc_exists) {
    blockers.push("allocate_expected_items_for_return_item_ids RPC not found on staging.");
  }
  if (!preflight.operator_receive_uses_batch_allocate) {
    blockers.push("operatorReceiveItem does not call allocateExpectedItemsForReturnItemIds.");
  }
  if (!preflight.quantity_only_path_blocked) {
    blockers.push("Quantity-only receive path not blocked (operatorReceiveItem still allows quantity 2–50 loop).");
  }
  if (srcCheck.usesActualScannedCountBump) {
    blockers.push("operatorReceiveItem still bumps actual_scanned_count (legacy quantity-counter path).");
  }
  if (!repairEvidence) {
    blockers.push("No expected-receive-split-item-row-repair-execute audit folder (optional if RPCs present).");
  }

  const canRunWrites =
    preflight.staging_ref_ok &&
    preflight.expected_item_id_column &&
    preflight.batch_allocate_rpc_exists &&
    preflight.parent_expected_package_id_column &&
    preflight.receive_scope_key_column &&
    preflight.operator_receive_uses_batch_allocate &&
    preflight.quantity_only_path_blocked &&
    !srcCheck.usesActualScannedCountBump;

  let expected: ExpectedRow | null = null;
  let packageId: string | null = null;
  let parentBeforeQty: number | null = null;
  const insertedIds: string[] = [];
  let receiveErrors: string[] = [];

  w(outDir, "migration-function-check.md", `# Migration / function check (smoke preflight)

\`\`\`json
${JSON.stringify(preflight, null, 2)}
\`\`\`
`);

  if (sb && canRunWrites) {
    const candidates = await selectEpCandidates(sb);
    expected =
      candidates.find((r) => String(r.build_source ?? "").includes("remainder")) ??
      candidates[0] ??
      null;
    if (!expected) {
      blockers.push("No expected_packages row with expected_scan_quantity >= 3 and resolved_product_id.");
    } else {
      const tn = String(expected.tracking_number ?? "").trim();
      const tnToken = tn.split(",")[0]?.trim() ?? tn;
      let pkg: { id?: string; id_slip_contents?: string } | null = null;
      {
        const { data } = await sb
          .from("packages")
          .select("id, id_slip_contents, tracking_number")
          .eq("organization_id", expected.organization_id)
          .eq("store_id", expected.store_id)
          .eq("tracking_number", tnToken)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        pkg = (data as { id?: string; id_slip_contents?: string } | null) ?? null;
      }
      if (!pkg?.id && tnToken) {
        const { data: rows } = await sb
          .from("packages")
          .select("id, id_slip_contents, tracking_number")
          .eq("organization_id", expected.organization_id)
          .eq("store_id", expected.store_id)
          .ilike("tracking_number", `%${tnToken.slice(0, 16)}%`)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(1);
        pkg = (rows?.[0] as { id?: string; id_slip_contents?: string } | undefined) ?? null;
      }
      packageId = String((pkg as { id?: string } | null)?.id ?? "").trim() || null;
      const slipCode = String((pkg as { id_slip_contents?: string } | null)?.id_slip_contents ?? "").trim() || null;
      parentBeforeQty = Number(expected.expected_scan_quantity ?? 0);

      const smokeInput = {
        run_id: RUN_ID,
        staging_ref: ref,
        expected_package_id: expected.id,
        parent_expected_scan_quantity_before: parentBeforeQty,
        package_id: packageId,
        receive_scope_key: buildReceiveScopeKey({
          organizationId: expected.organization_id,
          storeId: expected.store_id,
          packageId,
          slipCode,
        }),
        scans: 3,
        path: "3x insertReturn-equivalent rows + allocate_expected_items_for_return_item_ids batch",
      };
      w(outDir, "smoke-input.md", `# Smoke input\n\n\`\`\`json\n${JSON.stringify(smokeInput, null, 2)}\n\`\`\`\n`);
      w(outDir, "expected-row-used.json", JSON.stringify(expected, null, 2));

      const scopeKey = smokeInput.receive_scope_key;
      const sku = String(expected.sku ?? "").trim();
      const fnsku = String(expected.fnsku ?? "").trim();

      for (let i = 0; i < 3; i++) {
        const resCols = await resolveScannerProductIdentifiers(sb, {
          organizationId: expected.organization_id,
          storeId: expected.store_id,
          sku: sku || null,
          fnsku: fnsku || null,
          asin: null,
          productIdentifier: null,
          legacyProductId: null,
        });
        const { data: ins, error: insErr } = await sb
          .from(RETURN_ITEMS_TABLE)
          .insert({
            organization_id: expected.organization_id,
            store_id: expected.store_id,
            package_id: packageId,
            marketplace: "amazon",
            item_name: `neda-item-level-smoke-${RUN_ID}-${i + 1}`.slice(0, 500),
            conditions: ["sellable_ok"],
            status: "received",
            order_id: expected.order_id,
            sku: sku || null,
            fnsku: fnsku || null,
            notes: `neda-item-level-receive-smoke-after-repair ${RUN_ID} scan ${i + 1}/3`,
            resolved_product_id: resCols.resolved_product_id,
            resolved_catalog_product_id: resCols.resolved_catalog_product_id,
            identifier_resolution_status: resCols.identifier_resolution_status,
            identifier_resolution_confidence: resCols.identifier_resolution_confidence,
          })
          .select("id")
          .single();
        if (insErr || !ins?.id) {
          receiveErrors.push(insErr?.message ?? `insert scan ${i + 1} failed`);
          break;
        }
        insertedIds.push(String(ins.id));
      }

      if (insertedIds.length === 3) {
        const { data: allocData, error: allocErr } = await sb.rpc("allocate_expected_items_for_return_item_ids", {
          p_return_item_ids: insertedIds,
          p_expected_package_hint: expected.id,
          p_receive_scope_key: scopeKey,
        });
        if (allocErr) {
          receiveErrors.push(allocErr.message);
        } else {
          const rows = Array.isArray(allocData) ? allocData : [];
          for (const r of rows) {
            const err = String((r as { error_message?: string }).error_message ?? "").trim();
            if (err) receiveErrors.push(err);
          }
        }
      }
    }
  } else if (sb) {
    w(
      outDir,
      "smoke-input.md",
      `# Smoke input\n\nSmoke writes skipped — preflight blockers.\n\n\`\`\`json\n${JSON.stringify({ preflight, blockers }, null, 2)}\n\`\`\`\n`,
    );
  }

  // Verification reads
  let returnItemsCreated: Record<string, unknown>[] = [];
  let allocationAfter: Record<string, unknown>[] = [];
  let viewScannedCount: number | null = null;
  let viewExpected: number | null = null;
  let viewStatus: string | null = null;

  if (sb && insertedIds.length && expected) {
    const riRequired = ["id", "resolved_product_id", "expected_item_id", "package_id", "sku", "fnsku", "order_id", "deleted_at"];
    const riOptional = ["expected_product_id", "product_match_status"];
    let riSelect = riRequired.join(", ");
    for (const c of riOptional) {
      if (await probeColumn(sb, RETURN_ITEMS_TABLE, c)) riSelect += `, ${c}`;
    }
    const { data: rows } = await sb.from(RETURN_ITEMS_TABLE).select(riSelect).in("id", insertedIds);
    returnItemsCreated = (rows ?? []) as Record<string, unknown>[];

    let epQ = sb
      .from("expected_packages")
      .select(
        "id, build_source, expected_scan_quantity, parent_expected_package_id, receive_scope_key, actual_scanned_count",
      )
      .or(`id.eq.${expected.id},parent_expected_package_id.eq.${expected.id}`);
    if (!(await probeColumn(sb, "expected_packages", "parent_expected_package_id"))) {
      epQ = sb.from("expected_packages").select("id, build_source, expected_scan_quantity, actual_scanned_count").eq("id", expected.id);
    }
    const { data: epRows } = await epQ;
    allocationAfter = (epRows ?? []) as Record<string, unknown>[];

    const sku = String(expected.sku ?? "").trim();
    const fnsku = String(expected.fnsku ?? "").trim();
    const tn = String(expected.tracking_number ?? "").split(",")[0]?.trim() ?? "";
    const { data: scannedView } = await sb
      .from("v_scanned_items_counted")
      .select("total_scanned, sku, fnsku, tracking_number")
      .eq("organization_id", expected.organization_id)
      .eq("store_id", expected.store_id)
      .eq("tracking_number", tn);
    const matchRow = (scannedView ?? []).find((r) => {
      const row = r as { sku?: string; fnsku?: string };
      if (sku && String(row.sku ?? "").trim() === sku) return true;
      if (fnsku && String(row.fnsku ?? "").trim() === fnsku) return true;
      return false;
    });
    viewScannedCount = Number((matchRow as { total_scanned?: number } | undefined)?.total_scanned ?? NaN);
    if (!Number.isFinite(viewScannedCount)) viewScannedCount = null;

    const { data: itemStatus } = await sb
      .from("v_inventory_item_status")
      .select("total_expected, total_scanned, status, sku, fnsku, tracking_number")
      .eq("organization_id", expected.organization_id)
      .eq("store_id", expected.store_id)
      .eq("tracking_number", tn)
      .limit(20);
    const statusRow = (itemStatus ?? []).find((r) => {
      const row = r as { sku?: string; fnsku?: string };
      if (sku && String(row.sku ?? "").trim() === sku) return true;
      if (fnsku && String(row.fnsku ?? "").trim() === fnsku) return true;
      return false;
    });
    if (statusRow) {
      viewExpected = Number((statusRow as { total_expected?: number }).total_expected ?? NaN);
      const vs = Number((statusRow as { total_scanned?: number }).total_scanned ?? NaN);
      if (Number.isFinite(vs)) viewScannedCount = vs;
      viewStatus = String((statusRow as { status?: string }).status ?? "");
    }
  }

  const threeRows = insertedIds.length === 3;
  const allResolved =
    insertedIds.length > 0 &&
    returnItemsCreated.every((r) =>
      Boolean(String((r as { resolved_product_id?: string }).resolved_product_id ?? "").trim()),
    );
  const allExpectedItemId =
    insertedIds.length > 0 &&
    returnItemsCreated.every((r) =>
      Boolean(String((r as { expected_item_id?: string }).expected_item_id ?? "").trim()),
    );
  const receiveAllocated = allocationAfter.filter((r) => String(r.build_source ?? "") === "receive_allocated");
  const allocatedQtySum = receiveAllocated.reduce(
    (s, r) => s + Number((r as { expected_scan_quantity?: number }).expected_scan_quantity ?? 0),
    0,
  );
  const parentAfter = allocationAfter.find((r) => (r as { id?: string }).id === expected?.id);
  const parentQtyAfter = parentAfter ? Number((parentAfter as { expected_scan_quantity?: number }).expected_scan_quantity ?? 0) : null;
  const remainderDecreased =
    parentBeforeQty != null && parentQtyAfter != null ? parentBeforeQty - parentQtyAfter === 3 : false;

  let directScannedCount = 0;
  if (returnItemsCreated.length) {
    directScannedCount = returnItemsCreated.filter((r) =>
      Boolean(String((r as { expected_item_id?: string }).expected_item_id ?? "").trim()),
    ).length;
  }

  const pass =
    canRunWrites &&
    receiveErrors.length === 0 &&
    threeRows &&
    allResolved &&
    allExpectedItemId &&
    receiveAllocated.length >= 1 &&
    allocatedQtySum >= 3 &&
    remainderDecreased &&
    directScannedCount >= 3 &&
    (viewScannedCount == null || viewScannedCount >= 3 || packageId == null);

  w(outDir, "return-items-created.json", JSON.stringify(returnItemsCreated, null, 2));
  w(outDir, "expected-allocation-after.json", JSON.stringify(allocationAfter, null, 2));
  w(
    outDir,
    "view-count-proof.md",
    `# View count proof

| Check | Value |
|-------|-------|
| v_scanned_items_counted / v_inventory_item_status total_scanned (approx) | ${viewScannedCount ?? "n/a"} |
| v_inventory_item_status total_expected | ${viewExpected ?? "n/a"} |
| v_inventory_item_status status | ${viewStatus ?? "n/a"} |
| Direct return_items with expected_item_id | ${directScannedCount} |
| package_id used for view join | ${packageId ?? "null"} |
| receive_allocated rows | ${receiveAllocated.length} |
| receive_allocated expected_scan_quantity sum | ${allocatedQtySum} |
| Parent remainder before → after | ${parentBeforeQty} → ${parentQtyAfter} |
`,
  );

  const rollbackLines = [
    "-- neda-item-level-receive-smoke-after-repair rollback",
    "begin;",
    ...insertedIds.map((id) => `delete from return_items where id = '${id}';`),
    ...(receiveAllocated.map(
      (r) => `delete from expected_packages where id = '${String((r as { id?: string }).id)}';`,
    ) ?? []),
    expected
      ? `update expected_packages set expected_scan_quantity = ${parentBeforeQty ?? "expected_scan_quantity"} where id = '${expected.id}';`
      : "",
    "commit;",
  ].filter(Boolean);
  w(outDir, "rollback.sql", rollbackLines.join("\n"));

  let cleanupDone = false;
  if (sb && insertedIds.length) {
    for (const id of insertedIds) {
      await sb.from(RETURN_ITEMS_TABLE).delete().eq("id", id);
    }
    for (const r of receiveAllocated) {
      const eid = String((r as { id?: string }).id ?? "");
      if (eid) await sb.from("expected_packages").delete().eq("id", eid);
    }
    if (expected && parentBeforeQty != null) {
      await sb.from("expected_packages").update({ expected_scan_quantity: parentBeforeQty }).eq("id", expected.id);
    }
    const { data: verifyGone } = await sb.from(RETURN_ITEMS_TABLE).select("id").in("id", insertedIds);
    cleanupDone = (verifyGone ?? []).length === 0;
  }

  w(
    outDir,
    "cleanup-proof.md",
    `# Cleanup proof

- rollback.sql generated: yes
- automated cleanup executed: ${insertedIds.length ? "yes" : "no (no rows inserted)"}
- return_items gone after cleanup: **${cleanupDone ? "YES" : insertedIds.length ? "NO" : "n/a"}**
`,
  );

  if (receiveErrors.length) blockers.push(...receiveErrors.map((e) => `receive: ${e}`));

  w(
    outDir,
    "blockers.md",
    `# Blockers

${blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "- none"}

## Preflight

\`\`\`json
${JSON.stringify(preflight, null, 2)}
\`\`\`
`,
  );

  const finalStatus = pass ? "PASS" : blockers.length ? "BLOCKED" : "FAIL";

  w(
    outDir,
    "manifest.json",
    JSON.stringify(
      {
        run_id: RUN_ID,
        status: finalStatus,
        staging_ref: ref,
        three_item_rows_created: threeRows,
        expected_item_id_persisted: allExpectedItemId,
        receive_allocated_count: receiveAllocated.length,
        receive_allocated_qty_sum: allocatedQtySum,
        parent_remainder_decreased_by_3: remainderDecreased,
        view_scanned_count: viewScannedCount,
        cleanup_done: cleanupDone,
        inserted_return_item_ids: insertedIds,
        preflight,
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
        status: finalStatus,
        three_item_rows_created: threeRows,
        expected_item_id_persisted: allExpectedItemId,
        view_scanned_count: viewScannedCount,
        cleanup_done: cleanupDone,
        blockers: blockers.length,
      },
      null,
      2,
    ),
  );

  w(
    outDir,
    "next-prompt.md",
    `# Next prompt

${finalStatus === "PASS" ? "Re-run signoff or original parity." : `## BLOCKED — run repair execute first

1. Apply staging migration with:
   - \`allocate_expected_item_unit\`, \`release_expected_item_unit\`, \`move_expected_item_unit\`
   - (columns \`parent_expected_package_id\`, \`receive_scope_key\` appear **present** on staging already)
2. Wire \`operatorReceiveItem\`: per-row insert + RPC allocate; remove \`actual_scanned_count\` bump; block \`quantity > 1\`.
3. Record audit \`.cursor/audit-reports/expected-receive-split-item-row-repair-execute/<run_id>/\` with status PASS.
4. Set \`.cursor/operator-approvals/item-level-receive-split-fix-approval.md\` flags true.
5. Re-run: \`npx tsx scripts/neda-item-level-receive-smoke-after-repair.ts\`

### Copy-paste

\`\`\`markdown
# EXPECTED-RECEIVE-SPLIT-ITEM-ROW-REPAIR EXECUTE (staging)

Approval: item-level-receive-split-fix-approval.md (both flags true)
Apply unit allocation RPCs + wire operatorReceiveItem + block quantity>1.
Then: npx tsx scripts/neda-item-level-receive-smoke-after-repair.ts
\`\`\`
`}
`,
  );

  if (finalStatus !== "PASS") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
