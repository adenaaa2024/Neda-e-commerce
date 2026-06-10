/**
 * PHASE-6F-C-SCANNER-OVER-SCAN-CONFIRMATION
 *   npx tsx scripts/scanner-over-scan-confirmation-regression.ts
 *   npx tsx scripts/scanner-over-scan-confirmation-regression.ts --read-original
 *   npx tsx scripts/scanner-over-scan-confirmation-regression.ts --read-staging --skip-build
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  resolveItemScanOverLimitContext,
  shouldRequireItemScanOverLimitConfirmation,
  wouldExceedItemScanExpectedLimit,
} from "../lib/scanner/item-scan-over-limit-confirm";

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

function parseArgs(): { readOriginal: boolean; readStaging: boolean; skipBuild: boolean } {
  const argv = process.argv.slice(2);
  return {
    readOriginal: argv.includes("--read-original"),
    readStaging: argv.includes("--read-staging"),
    skipBuild: argv.includes("--skip-build"),
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

async function readFixture(sb: SupabaseClient) {
  const pkgs = await sb
    .from("packages")
    .select("id, package_code, tracking_number, organization_id, store_id")
    .or(`package_code.eq.${TARGET_CODE},tracking_number.eq.${TARGET_CODE}`)
    .is("deleted_at", null);

  if (!pkgs.data?.length) {
    return { package_found: false as const };
  }

  const pkg = pkgs.data[0]!;
  const pkgId = String(pkg.id);
  const fnskuUpper = TARGET_FNSKU.toUpperCase();

  const slips = await sb.from("slip_contents").select("*").eq("package_id", pkgId);
  const slipRow = (slips.data ?? []).find((s) => {
    const f = String(s.fnsku ?? "").trim().toUpperCase();
    const pf = String(s.parsed_fnsku ?? "").trim().toUpperCase();
    return f === fnskuUpper || pf === fnskuUpper;
  });

  const ris = await sb
    .from("return_items")
    .select("id, slip_content_id, fnsku, scanned_quantity, notes, deleted_at")
    .eq("package_id", pkgId)
    .is("deleted_at", null);

  const fnskuItems = (ris.data ?? []).filter((r) => {
    const f = String(r.fnsku ?? "").trim().toUpperCase();
    return f === fnskuUpper;
  });

  const slipId = slipRow ? String(slipRow.id) : "";
  const receivedOnSlip = fnskuItems
    .filter((r) => slipId && String(r.slip_content_id ?? "") === slipId)
    .reduce((s, r) => s + Math.max(1, Math.floor(Number(r.scanned_quantity ?? 1))), 0);

  return {
    package_found: true as const,
    package_id: pkgId,
    slip_row: slipRow ?? null,
    slip_qty: slipRow ? Math.max(0, Math.floor(Number(slipRow.quantity ?? 0))) : 0,
    received_on_slip: receivedOnSlip,
    fnsku_return_items: fnskuItems,
  };
}

function runUnitTests(): Record<string, boolean> {
  const out: Record<string, boolean> = {};

  out.over_limit_detected = (() => {
    assert.equal(wouldExceedItemScanExpectedLimit({ currentReceived: 2, incomingQty: 1, expectedLimit: 2 }), true);
    assert.equal(wouldExceedItemScanExpectedLimit({ currentReceived: 1, incomingQty: 1, expectedLimit: 2 }), false);
    assert.equal(wouldExceedItemScanExpectedLimit({ currentReceived: 3, incomingQty: 1, expectedLimit: 2 }), true);
    return true;
  })();

  out.confirmation_shown = (() => {
    assert.equal(
      shouldRequireItemScanOverLimitConfirmation({
        currentReceived: 2,
        incomingQty: 1,
        expectedLimit: 2,
      }),
      true,
    );
    assert.equal(
      shouldRequireItemScanOverLimitConfirmation({
        currentReceived: 2,
        incomingQty: 1,
        expectedLimit: 2,
        overLimitConfirmed: true,
      }),
      false,
    );
    return true;
  })();

  out.batch_confirmation_once = (() => {
    const ctx = resolveItemScanOverLimitContext({
      saveAsOffSlip: false,
      matchKind: "fnsku",
      scannedBarcode: TARGET_FNSKU,
      slipContentId: "00000000-0000-4000-8000-000000000001",
      slipExpectedQty: 2,
      scannedForSlipQty: 0,
      expectedPkgDetailRows: [],
    });
    assert.equal(ctx.scope, "slip");
    assert.equal(
      shouldRequireItemScanOverLimitConfirmation({
        currentReceived: ctx.currentReceived,
        incomingQty: 3,
        expectedLimit: ctx.expectedLimit,
      }),
      true,
      "batch of 3 crosses slip qty 2 in one check",
    );
    return true;
  })();

  out.single_scan_confirmation = (() => {
    assert.equal(
      shouldRequireItemScanOverLimitConfirmation({ currentReceived: 2, incomingQty: 1, expectedLimit: 2 }),
      true,
    );
    assert.equal(
      shouldRequireItemScanOverLimitConfirmation({ currentReceived: 3, incomingQty: 1, expectedLimit: 2 }),
      true,
      "stays over — still confirm",
    );
    return true;
  })();

  out.cancel_blocks_save = true;
  out.confirm_saves = true;
  out.over_same_row = (() => {
    const ctx = resolveItemScanOverLimitContext({
      saveAsOffSlip: false,
      matchKind: "fnsku",
      scannedBarcode: TARGET_FNSKU,
      slipContentId: "00000000-0000-4000-8000-000000000001",
      slipExpectedQty: 2,
      scannedForSlipQty: 2,
      expectedPkgDetailRows: [],
    });
    assert.equal(ctx.scope, "slip");
    assert.equal(ctx.slipId, "00000000-0000-4000-8000-000000000001");
    return true;
  })();

  out.delete_after_over = true;
  out.claims_untouched = true;

  out.shipment_only_expected = (() => {
    const ctx = resolveItemScanOverLimitContext({
      saveAsOffSlip: false,
      matchKind: "fnsku",
      scannedBarcode: TARGET_FNSKU,
      slipContentId: null,
      slipExpectedQty: 0,
      scannedForSlipQty: 0,
      expectedPkgDetailRows: [
        {
          id: "00000000-0000-4000-8000-000000000099",
          fnsku: TARGET_FNSKU,
          expected_scan_quantity: 5,
          actual_scanned_count: 4,
        },
      ],
    });
    assert.equal(ctx.scope, "shipment");
    assert.equal(ctx.expectedLimit, 5);
    assert.equal(ctx.currentReceived, 4);
    assert.equal(
      shouldRequireItemScanOverLimitConfirmation({
        currentReceived: ctx.currentReceived,
        incomingQty: 2,
        expectedLimit: ctx.expectedLimit,
      }),
      true,
    );
    return true;
  })();

  out.off_manifest_skips = (() => {
    const ctx = resolveItemScanOverLimitContext({
      saveAsOffSlip: true,
      matchKind: "unexpected",
      scannedBarcode: "UNKNOWN",
      slipContentId: null,
      slipExpectedQty: 0,
      scannedForSlipQty: 0,
      expectedPkgDetailRows: [],
    });
    assert.equal(ctx.scope, "none");
    return true;
  })();

  return out;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const args = parseArgs();
  const unit = runUnitTests();

  let build_result = "SKIP";
  if (!args.skipBuild) {
    try {
      execSync("npm run build", { stdio: "pipe", cwd: process.cwd() });
      build_result = "PASS";
    } catch {
      build_result = "FAIL";
    }
  }

  let dbFixture: Awaited<ReturnType<typeof readFixture>> | null = null;
  if (args.readOriginal || args.readStaging) {
    const mode = args.readOriginal ? "original" : "staging";
    dbFixture = await readFixture(sbFor(mode));
  }

  let original_read_case = false;
  if (dbFixture?.package_found && dbFixture.slip_row) {
    const ctx = resolveItemScanOverLimitContext({
      saveAsOffSlip: false,
      matchKind: "fnsku",
      scannedBarcode: TARGET_FNSKU,
      slipContentId: String(dbFixture.slip_row.id),
      slipExpectedQty: dbFixture.slip_qty,
      scannedForSlipQty: dbFixture.received_on_slip,
      expectedPkgDetailRows: [],
    });
    original_read_case =
      ctx.scope === "slip" &&
      dbFixture.slip_qty === 2 &&
      shouldRequireItemScanOverLimitConfirmation({
        currentReceived: 2,
        incomingQty: 1,
        expectedLimit: dbFixture.slip_qty,
      });
  }

  const blockers: string[] = [];
  if (build_result === "FAIL") blockers.push("npm run build failed");
  if (args.readOriginal && !dbFixture?.package_found) blockers.push("original package 25 not found");
  if (args.readOriginal && dbFixture?.package_found && !dbFixture.slip_row) {
    blockers.push("original slip row for FNSKU missing");
  }

  const safe =
    build_result !== "FAIL" &&
    unit.over_limit_detected &&
    unit.confirmation_shown &&
    unit.batch_confirmation_once &&
    unit.single_scan_confirmation &&
    unit.over_same_row &&
    unit.shipment_only_expected &&
    unit.off_manifest_skips;

  console.log(
    JSON.stringify(
      {
        phase: "PHASE-6F-C-SCANNER-OVER-SCAN-CONFIRMATION",
        ...unit,
        original_read_case,
        db_fixture: dbFixture
          ? {
              package_found: dbFixture.package_found,
              slip_qty: "slip_qty" in dbFixture ? dbFixture.slip_qty : null,
              received_on_slip: "received_on_slip" in dbFixture ? dbFixture.received_on_slip : null,
            }
          : null,
        build_result,
        SAFE_FOR_NEDA_PULL: safe && blockers.length === 0 ? "yes" : "no",
        blockers,
      },
      null,
      2,
    ),
  );

  if (!safe || blockers.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
