/**
 * FIX-SCANNER-FNSKU-SLIP-ALLOCATION-REGRESSION
 *   npx tsx scripts/scanner-fnsku-slip-allocation-regression.ts --read-original
 *   npx tsx scripts/scanner-fnsku-slip-allocation-regression.ts --read-staging
 *   npx tsx scripts/scanner-fnsku-slip-allocation-regression.ts --read-staging --smoke-write
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { itemScanSaveShouldTreatAsOffSlip } from "../lib/scanner/item-scan-off-slip";
import {
  resolveItemBarcodeAgainstSlipRows,
  coalesceSlipRowFnsku,
  coalesceSlipRowUpc,
  type SlipBarcodeMatchRow,
} from "../lib/scanner/operator-slip-item-resolve";

function slipLinesToBarcodeMatchRowsForTest(lines: Record<string, unknown>[]): SlipBarcodeMatchRow[] {
  return lines.map((row, idx) => ({
    id: String(row.id ?? "").trim() || null,
    upc: coalesceSlipRowUpc({
      upc: typeof row.upc === "string" ? row.upc : null,
      parsed_upc: typeof row.parsed_upc === "string" ? row.parsed_upc : null,
    }),
    fnsku: coalesceSlipRowFnsku({
      fnsku: typeof row.fnsku === "string" ? row.fnsku : null,
      parsed_fnsku: typeof row.parsed_fnsku === "string" ? row.parsed_fnsku : null,
    }),
    description: typeof row.description === "string" ? row.description : null,
    quantity: Math.max(0, Math.floor(Number(row.quantity ?? 0))),
    sort_index: idx,
  }));
}

const TARGET_CODE = "25";
const TARGET_FNSKU = "X004JWH5NB";

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
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function parseArgs(): { readOriginal: boolean; readStaging: boolean; smokeWrite: boolean } {
  const argv = process.argv.slice(2);
  return {
    readOriginal: argv.includes("--read-original"),
    readStaging: argv.includes("--read-staging"),
    smokeWrite: argv.includes("--smoke-write"),
  };
}

function sbFor(mode: "original" | "staging"): SupabaseClient {
  const url =
    mode === "original"
      ? process.env.ORIGINAL_SUPABASE_URL?.trim()
      : process.env.STAGING_SUPABASE_URL?.trim() ?? process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key =
    mode === "original"
      ? process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim()
      : process.env.STAGING_SERVICE_ROLE_KEY?.trim() ?? process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error(`Missing ${mode} Supabase env`);
  return createClient(url, key, { auth: { persistSession: false } });
}

async function auditDb(sb: SupabaseClient) {
  const pkgs = await sb
    .from("packages")
    .select("id, package_code, tracking_number, id_slip_contents, pallet_id, store_id, organization_id")
    .or(`package_code.eq.${TARGET_CODE},tracking_number.eq.${TARGET_CODE}`)
    .is("deleted_at", null);

  const pkgIds = (pkgs.data ?? []).map((p) => p.id);
  if (!pkgIds.length) {
    return {
      original_package_found: false,
      packages: [],
      original_slip_rows_for_fnsku: [],
      original_expected_rows_for_fnsku: [],
      existing_return_items_for_fnsku: [],
    };
  }

  const slips = await sb.from("slip_contents").select("*").in("package_id", pkgIds);
  const fnskuUpper = TARGET_FNSKU.toUpperCase();
  const slipRows = (slips.data ?? []).filter((s) => {
    const f = String(s.fnsku ?? "").trim().toUpperCase();
    const pf = String(s.parsed_fnsku ?? "").trim().toUpperCase();
    return f === fnskuUpper || pf === fnskuUpper;
  });

  const org = String(pkgs.data![0]!.organization_id ?? "");
  const store = String(pkgs.data![0]!.store_id ?? "");
  const tn = String(pkgs.data![0]!.tracking_number ?? TARGET_CODE);

  const epFnsku = await sb
    .from("expected_packages")
    .select("id, fnsku, sku, asin, expected_scan_quantity, tracking_number, build_source")
    .eq("organization_id", org)
    .eq("store_id", store)
    .ilike("fnsku", TARGET_FNSKU);

  const epTracking = await sb
    .from("expected_packages")
    .select("id, fnsku, sku, expected_scan_quantity, tracking_number, build_source")
    .eq("organization_id", org)
    .eq("store_id", store)
    .eq("tracking_number", tn);

  const ris = await sb
    .from("return_items")
    .select("id, package_id, fnsku, sku, scanned_quantity, notes, deleted_at")
    .in("package_id", pkgIds)
    .ilike("fnsku", `%${TARGET_FNSKU}%`)
    .is("deleted_at", null);

  return {
    original_package_found: true,
    packages: pkgs.data ?? [],
    original_slip_rows_for_fnsku: slipRows,
    original_expected_rows_for_fnsku: epFnsku.data ?? [],
    ep_on_tracking: epTracking.data ?? [],
    existing_return_items_for_fnsku: ris.data ?? [],
  };
}

function runUnitTests(): number {
  let n = 0;
  const bump = (fn: () => void) => {
    n += 1;
    fn();
  };

  bump(() => {
    const rows: SlipBarcodeMatchRow[] = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        fnsku: "X004JWH5NB",
        upc: null,
        description: "Test",
        quantity: 2,
        sort_index: 0,
      },
    ];
    const outcome = resolveItemBarcodeAgainstSlipRows("x004jwh5nb", rows);
    assert.equal(outcome.kind, "single");
    assert.equal(outcome.kind === "single" ? outcome.tier : "", "fnsku");
  });

  bump(() => {
    assert.equal(
      itemScanSaveShouldTreatAsOffSlip({
        matchKindPreset: null,
        slipContentId: "00000000-0000-4000-8000-000000000001",
        slipExpectedQty: 2,
        scannedForSlipQty: 0,
        hasAllocatableExpectedPackageHint: false,
      }),
      false,
      "slip match must win without EP hint",
    );
  });

  bump(() => {
    assert.equal(
      itemScanSaveShouldTreatAsOffSlip({
        matchKindPreset: null,
        slipContentId: "00000000-0000-4000-8000-000000000001",
        slipExpectedQty: 1,
        scannedForSlipQty: 2,
        hasAllocatableExpectedPackageHint: false,
      }),
      false,
      "over-scanned slip row stays on slip (OVER in UI)",
    );
  });

  bump(() => {
    assert.equal(
      itemScanSaveShouldTreatAsOffSlip({
        matchKindPreset: null,
        slipContentId: null,
        slipExpectedQty: 0,
        scannedForSlipQty: 0,
        hasAllocatableExpectedPackageHint: false,
      }),
      true,
      "no slip match → off-manifest",
    );
  });

  return n;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const args = parseArgs();
  const mode = args.readOriginal ? "original" : "staging";
  if (!args.readOriginal && !args.readStaging) {
    throw new Error("Pass --read-original or --read-staging");
  }

  const sb = sbFor(mode);
  const audit = await auditDb(sb);
  const unit_test_count = runUnitTests();

  const slipRows = (audit.original_slip_rows_for_fnsku ?? []) as Record<string, unknown>[];
  const matchRows = slipLinesToBarcodeMatchRowsForTest(slipRows);
  const matchOutcome = resolveItemBarcodeAgainstSlipRows(TARGET_FNSKU, matchRows);
  const matchedSlipRow = matchOutcome.kind === "single";
  const slipId =
    matchOutcome.kind === "single" ? String(matchOutcome.slip.id ?? "").trim() : null;
  const slipExpectedQty =
    matchOutcome.kind === "single" ? Math.max(0, Math.floor(Number(matchOutcome.slip.quantity ?? 0))) : 0;

  const saveAsOffSlip = itemScanSaveShouldTreatAsOffSlip({
    matchKindPreset: "fnsku",
    slipContentId: slipId,
    slipExpectedQty,
    scannedForSlipQty: 0,
    hasAllocatableExpectedPackageHint: false,
  });

  const overOffSlip = itemScanSaveShouldTreatAsOffSlip({
    matchKindPreset: "fnsku",
    slipContentId: slipId,
    slipExpectedQty: 1,
    scannedForSlipQty: 2,
    hasAllocatableExpectedPackageHint: false,
  });

  let build_result = process.argv.includes("--skip-build") ? "SKIPPED" : "FAIL";
  const blockers: string[] = [];
  if (!process.argv.includes("--skip-build")) {
    try {
      const { execSync } = await import("node:child_process");
      execSync("npm run build", { cwd: process.cwd(), stdio: "pipe", timeout: 180_000 });
      build_result = "PASS";
    } catch {
      blockers.push("npm run build failed");
    }
  }

  if (!matchedSlipRow && audit.original_package_found) {
    blockers.push(`FNSKU ${TARGET_FNSKU} not found on slip rows for code ${TARGET_CODE}`);
  }
  if (saveAsOffSlip) blockers.push("itemScanSaveShouldTreatAsOffSlip still true for matched slip");
  if (overOffSlip) blockers.push("over-scanned slip still treated as off-slip");

  const report = {
    mode,
    original_package_found: audit.original_package_found,
    packages: audit.packages,
    original_slip_rows_for_fnsku: audit.original_slip_rows_for_fnsku,
    original_expected_rows_for_fnsku: audit.original_expected_rows_for_fnsku,
    ep_on_tracking: audit.ep_on_tracking,
    existing_return_items_for_fnsku: audit.existing_return_items_for_fnsku,
    root_cause:
      "itemScanSaveShouldTreatAsOffSlip returned true when hasAllocatableExpectedPackageHint=false even with valid slipContentId; save path cleared slipContentId and set matchKind=unexpected",
    matched_slip_row: matchedSlipRow,
    fnsku_exact_slip_match_wins: matchedSlipRow && !saveAsOffSlip,
    scan_allocates_to_slip_row: matchedSlipRow && !saveAsOffSlip,
    not_unexpected_result: !saveAsOffSlip,
    over_result: !overOffSlip,
    delete_back_to_pending_result: "not_run_in_readonly",
    unit_test_count,
    build_result,
    SAFE_FOR_NEDA_PULL: blockers.length === 0,
    blockers,
  };

  console.log(JSON.stringify(report, null, 2));
  if (blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
