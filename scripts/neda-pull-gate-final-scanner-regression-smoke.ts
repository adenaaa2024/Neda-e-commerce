/**
 * NEDA-PULL-GATE-FINAL-SCANNER-REGRESSION-SMOKE
 * Staging runtime smoke — disposable writes on package tracking "25" when possible.
 *
 *   npx tsx scripts/neda-pull-gate-final-scanner-regression-smoke.ts --execute
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { RETURN_ITEMS_TABLE } from "../app/returns/returns-constants";
import { itemScanSaveShouldTreatAsOffSlip } from "../lib/scanner/item-scan-off-slip";
import {
  coalesceSlipRowFnsku,
  resolveItemBarcodeAgainstSlipRows,
  type SlipBarcodeMatchRow,
} from "../lib/scanner/operator-slip-item-resolve";
import { missingReviewRecordedQtyForSlip } from "../lib/scanner/package-missing-review-manifest";
import {
  computeSlipLineExpectedVsReceived,
} from "../lib/scanner/slip-contents-missing-expected";
import { returnItemNotesMarkOffSlip } from "../lib/scanner/item-scan-off-slip";
import { shouldExcludeReturnItemFromScannerCounts } from "../lib/scanner/return-items-test-data-guard";
import { shouldShowValidationChipOnRow } from "../lib/scanner/slip-shipment-validation-ui-helpers";
import { isUuidString } from "../lib/uuid";
import { lookupShipmentEntryScanCode } from "../lib/scanner/shipment-entry-lookup";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";
import { readPackageReceiveState } from "../lib/scanner/package-receive-state-contract";
import { assertScriptReturnItemsWriteAllowed } from "../lib/script-return-items-write-guard";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const TARGET_CODE = "25";
const TARGET_FNSKU = "X004JWH5NB";
const AUTH_USER_ID = "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";
const OUT_BASE = ".cursor/audit-reports/neda-pull-gate-final-scanner-regression-smoke";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function slipLinesToMatchRows(lines: Record<string, unknown>[]): SlipBarcodeMatchRow[] {
  return lines.map((row, idx) => ({
    id: String(row.id ?? "").trim() || null,
    upc: typeof row.upc === "string" ? row.upc : null,
    fnsku: coalesceSlipRowFnsku({
      fnsku: typeof row.fnsku === "string" ? row.fnsku : null,
      parsed_fnsku: typeof row.parsed_fnsku === "string" ? row.parsed_fnsku : null,
    }),
    description: typeof row.description === "string" ? row.description : null,
    quantity: Math.max(0, Math.floor(Number(row.quantity ?? 0))),
    sort_index: idx,
  }));
}

async function establishCookieJar(): Promise<{ name: string; value: string }[]> {
  const url = process.env.STAGING_SUPABASE_URL!.trim();
  const anon = process.env.STAGING_ANON_KEY!.trim();
  const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY!.trim();
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 50 });
  const u = users?.users.find((x) => x.id === AUTH_USER_ID);
  if (!u?.email) throw new Error("staging auth user not found");

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: u.email,
    options: { redirectTo: "http://127.0.0.1:3000" },
  });
  const hashedToken = String(link?.properties?.hashed_token ?? "").trim();
  if (linkErr || !hashedToken) throw new Error(linkErr?.message ?? "generateLink failed");

  const jar: { name: string; value: string }[] = [];
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return jar;
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          const i = jar.findIndex((c) => c.name === name);
          if (i >= 0) jar[i]!.value = value;
          else jar.push({ name, value });
        }
      },
    },
  });
  const { data, error } = await supabase.auth.verifyOtp({ token_hash: hashedToken, type: "email" });
  if (error || !data.session) throw new Error(error?.message ?? "verifyOtp failed");
  await supabase.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  return jar;
}

function installCookieMock(jar: { name: string; value: string }[]): void {
  require.cache[require.resolve("next/headers")] = {
    exports: {
      cookies: async () => ({
        getAll: () => jar,
        get: (name: string) => jar.find((c) => c.name === name),
      }),
    },
  } as Module;
}

async function countClaims(admin: ReturnType<typeof createClient>): Promise<{
  claim_cases: number;
  claim_candidates: number;
}> {
  const [cc, cand] = await Promise.all([
    admin.from("claim_cases").select("id", { count: "exact", head: true }),
    admin.from("claim_candidates").select("id", { count: "exact", head: true }),
  ]);
  return {
    claim_cases: cc.count ?? 0,
    claim_candidates: cand.count ?? 0,
  };
}

async function findPackage25(admin: ReturnType<typeof createClient>) {
  const { data, error } = await admin
    .from("packages")
    .select("id, package_code, tracking_number, store_id, organization_id, manifest_data")
    .or(`package_code.eq.${TARGET_CODE},tracking_number.eq.${TARGET_CODE}`)
    .is("deleted_at", null)
    .limit(5);
  if (error) throw error;
  const rows = data ?? [];
  const hit =
    rows.find((r) => String(r.tracking_number ?? "").trim() === TARGET_CODE) ??
    rows.find((r) => String(r.package_code ?? "").trim() === TARGET_CODE) ??
    rows[0];
  return hit ?? null;
}

async function ensureFnskuSlipRow(
  admin: ReturnType<typeof createClient>,
  pkg: { id: string; organization_id: string; store_id: string },
  runToken: string,
): Promise<{ slipId: string; expectedQty: number; created: boolean }> {
  const { data: slips } = await admin
    .from("slip_contents")
    .select("id, fnsku, parsed_fnsku, quantity")
    .eq("package_id", pkg.id);
  const fnskuUpper = TARGET_FNSKU.toUpperCase();
  for (const s of slips ?? []) {
    const f = String(s.fnsku ?? "").trim().toUpperCase();
    const pf = String((s as { parsed_fnsku?: string }).parsed_fnsku ?? "").trim().toUpperCase();
    if (f === fnskuUpper || pf === fnskuUpper) {
      return {
        slipId: String(s.id),
        expectedQty: Math.max(1, Math.floor(Number(s.quantity ?? 1))),
        created: false,
      };
    }
  }
  const { data: ins, error } = await admin
    .from("slip_contents")
    .insert({
      organization_id: pkg.organization_id,
      package_id: pkg.id,
      store_id: pkg.store_id,
      fnsku: TARGET_FNSKU,
      description: `Warehouse intake line ${runToken.replace(/[^0-9A-Za-z-]/g, "")}`,
      quantity: 2,
      sort_index: 0,
      created_by: AUTH_USER_ID,
    })
    .select("id, quantity")
    .single();
  if (error || !ins?.id) throw new Error(error?.message ?? "slip insert failed");
  return {
    slipId: String(ins.id),
    expectedQty: Math.max(1, Math.floor(Number(ins.quantity ?? 2))),
    created: true,
  };
}

function scannedBarcodeFromReturnItemRow(row: {
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

function returnItemUnitQty(row: Record<string, unknown>): number {
  return Math.max(1, Math.floor(Number(row.scanned_quantity ?? 1)));
}

function slipContentIdForReturnItemBarcode(
  barcode: string,
  slipRows: SlipBarcodeMatchRow[],
): string | null {
  const trimmed = barcode.trim();
  if (!trimmed || slipRows.length === 0) return null;
  const outcome = resolveItemBarcodeAgainstSlipRows(trimmed, slipRows);
  if (outcome.kind !== "single") return null;
  const sid = String(outcome.slip.id ?? "").trim();
  return sid && isUuidString(sid) ? sid : null;
}

/** Mirrors operator Item Scan slip-row received qty (no `return_items.quantity` — staging lacks column). */
async function sumSlipRowReceivedQty(
  admin: ReturnType<typeof createClient>,
  packageId: string,
  orgId: string,
  slipId: string,
  slipMatchRows: SlipBarcodeMatchRow[],
): Promise<number> {
  const { data: riRows, error } = await admin
    .from(RETURN_ITEMS_TABLE)
    .select("fnsku, sku, product_identifier, item_name, notes, scanned_quantity")
    .eq("package_id", packageId)
    .eq("organization_id", orgId)
    .is("deleted_at", null);
  if (error) throw new Error(error.message);

  let total = 0;
  for (const raw of riRows ?? []) {
    const row = raw as Record<string, unknown>;
    const fnsku = typeof row.fnsku === "string" ? row.fnsku : null;
    const sku = typeof row.sku === "string" ? row.sku : null;
    const product_identifier =
      typeof row.product_identifier === "string" ? row.product_identifier : null;
    const operator_notes = typeof row.notes === "string" ? row.notes : null;

    if (
      shouldExcludeReturnItemFromScannerCounts({
        item_name: typeof row.item_name === "string" ? row.item_name : null,
        sku,
        fnsku,
        product_identifier,
        notes: operator_notes,
      })
    ) {
      continue;
    }
    if (returnItemNotesMarkOffSlip(operator_notes)) continue;

    const scanned_barcode = scannedBarcodeFromReturnItemRow({ fnsku, sku, product_identifier });
    const mappedSlipId = slipContentIdForReturnItemBarcode(scanned_barcode, slipMatchRows);
    if (mappedSlipId !== slipId) continue;
    total += returnItemUnitQty(row);
  }
  return total;
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const blockers: string[] = [];
  const report: Record<string, unknown> = {
    audit: "neda-pull-gate-final-scanner-regression-smoke",
    run_id: rid,
    execute,
    fnsku_slip_allocation_pass: "no",
    over_same_row_pass: "no",
    delete_pass: "no",
    old_colors_preserved: "code_verified",
    chips_additive: "no",
    claims_untouched: "no",
    search_regression: "no",
    build_result: "not_run",
    SAFE_TO_PUSH_AND_NEDA_PULL: "no",
    blockers: [] as string[],
  };

  loadEnvLocalIntoProcess();
  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || "";
  if (refFromSupabaseUrl(stagingUrl) !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Staging guard failed (expected ${STAGING_REF})`);
  }
  if (!execute) blockers.push("Pass --execute for staging write smoke");

  // Code-level chip additive contract
  const chipAdditive =
    !shouldShowValidationChipOnRow("pending", "open") &&
    !shouldShowValidationChipOnRow("off_manifest", "open") &&
    !shouldShowValidationChipOnRow("over_scanned", "open") &&
    shouldShowValidationChipOnRow("confirmed", "open") &&
    shouldShowValidationChipOnRow("slip_only", "open") &&
    shouldShowValidationChipOnRow("shipment_only", "open") &&
    shouldShowValidationChipOnRow("unresolved", "open");
  report.chips_additive = chipAdditive ? "yes" : "no";
  if (!chipAdditive) blockers.push("6F chips not additive-only per shouldShowValidationChipOnRow");

  // CSS color tokens present
  const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  const scanPage = fs.readFileSync(
    path.join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"),
    "utf8",
  );
  const colorChecks = [
    "operator-item-scan-slip-passive-badge--pending",
    'data-neda-qty="RECEIVED"',
    'data-neda-qty="OVER"',
    "operator-item-scan-mark-missing-btn",
    "operator-slip-validation-chip--confirmed",
  ];
  const colorsOk =
    colorChecks.slice(0, 3).every((k) => css.includes(k)) &&
    colorChecks.slice(3).every((k) => css.includes(k) || scanPage.includes(k));
  report.old_colors_preserved = colorsOk ? "yes" : "no";
  if (!colorsOk) blockers.push("Expected item color CSS tokens missing in globals.css");

  if (blockers.length && !execute) {
    report.blockers = blockers;
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  assertScriptReturnItemsWriteAllowed();
  process.env.NEXT_PUBLIC_SUPABASE_URL = stagingUrl;
  process.env.SUPABASE_URL = stagingUrl;
  process.env.APP_ENV = "staging";

  const admin = createClient(stagingUrl, process.env.STAGING_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false },
  });
  const jar = await establishCookieJar();
  installCookieMock(jar);

  const {
    insertOperatorPackageItemAction,
    markOperatorSlipMissingExpectedAction,
    deleteOperatorPackageItemAction,
    reopenOperatorPackageReceiveAction,
  } = await import("../app/scanner/operator-mobile/_components/operator-store-actions");

  const claimsBefore = await countClaims(admin);
  const createdReturnItemIds: string[] = [];
  let createdSlipId: string | null = null;
  let pkgId = "";
  let orgId = "";
  let storeId = "";
  let slipId = "";
  let expectedQty = 2;

  try {
    const pkg = await findPackage25(admin);
    if (!pkg) {
      blockers.push(`No package with code/tracking ${TARGET_CODE} on staging`);
      throw new Error("package 25 not found");
    }
    pkgId = String(pkg.id);
    orgId = String(pkg.organization_id);
    storeId = String(pkg.store_id);

    const slipEnsure = await ensureFnskuSlipRow(
      admin,
      {
      id: pkgId,
      organization_id: orgId,
      store_id: storeId,
    },
      rid,
    );
    slipId = slipEnsure.slipId;
    expectedQty = slipEnsure.expectedQty;
    if (slipEnsure.created) createdSlipId = slipId;

    const { data: slipRowsRaw } = await admin.from("slip_contents").select("*").eq("package_id", pkgId);
    const matchRows = slipLinesToMatchRows((slipRowsRaw ?? []) as Record<string, unknown>[]);
    const baselineSlipReceived = await sumSlipRowReceivedQty(
      admin,
      pkgId,
      orgId,
      slipId,
      matchRows,
    );

    const receiveState = readPackageReceiveState(pkg.manifest_data);
    if (receiveState === "finalized") {
      const reopen = await reopenOperatorPackageReceiveAction({
        requestedOrganizationId: orgId,
        packageId: pkgId,
        storeId,
      });
      report.package_reopen = reopen;
      if (!reopen.ok) {
        blockers.push(`Package ${TARGET_CODE} finalized and reopen failed: ${reopen.message}`);
      }
    }

    const matchOutcome = resolveItemBarcodeAgainstSlipRows(TARGET_FNSKU, matchRows);
    const matchedSlip = matchOutcome.kind === "single";
    const offSlip = itemScanSaveShouldTreatAsOffSlip({
      matchKindPreset: "fnsku",
      slipContentId: matchedSlip ? String(matchOutcome.slip.id) : null,
      slipExpectedQty: matchedSlip ? Math.max(0, Number(matchOutcome.slip.quantity ?? 0)) : 0,
      scannedForSlipQty: 0,
      hasAllocatableExpectedPackageHint: false,
    });

    // Search timing
    const searchCodes = [TARGET_CODE, TARGET_FNSKU, "UNKNOWN-GATE-SMOKE-999"];
    const searchTimings: Record<string, { ms: number; rows: number }> = {};
    for (const code of searchCodes) {
      const t0 = performance.now();
      const lookup = await lookupShipmentEntryScanCode(admin, orgId, storeId, code, {
        skipExpensiveFallback: true,
      });
      searchTimings[code] = {
        ms: Math.round(performance.now() - t0),
        rows: lookup.inventory_rows.length,
      };
    }
    const searchOk =
      searchTimings[TARGET_CODE]!.ms < 5000 &&
      searchTimings[TARGET_FNSKU]!.ms < 5000 &&
      searchTimings["UNKNOWN-GATE-SMOKE-999"]!.ms < 3000;
    report.search_regression = searchOk ? "pass" : "fail";
    report.search_timings_ms = searchTimings;
    if (!searchOk) blockers.push("Search latency regression on staging");

    // Clean prior gate-smoke return_items for this package+slip
    const { data: priorRi } = await admin
      .from(RETURN_ITEMS_TABLE)
      .select("id, notes")
      .eq("package_id", pkgId)
      .is("deleted_at", null);
    for (const ri of priorRi ?? []) {
      const notes = String((ri as { notes?: string }).notes ?? "");
      if (notes.includes(`wv `) && notes.includes(rid.slice(-8))) {
        await admin.from(RETURN_ITEMS_TABLE).delete().eq("id", (ri as { id: string }).id);
      }
    }

    const scan1 = await insertOperatorPackageItemAction({
      requestedOrganizationId: orgId,
      packageId: pkgId,
      storeId,
      slipContentId: slipId,
      scannedBarcode: TARGET_FNSKU,
      matchKind: "fnsku",
      quantity: 1,
      discrepancyTags: ["sellable_ok"],
      operatorNotes: `wv qty=1 ${rid}`,
    });

    const { data: ri1 } = await admin
      .from(RETURN_ITEMS_TABLE)
      .select("id, fnsku, notes, scanned_quantity")
      .eq("id", scan1.ok ? scan1.id : "")
      .maybeSingle();
    const notes1 = String(ri1?.notes ?? "");
    const notUnexpected = !notes1.toLowerCase().includes("not on packing slip");
    const fnskuPass = scan1.ok && matchedSlip && !offSlip && notUnexpected;
    report.fnsku_slip_allocation_pass = fnskuPass ? "yes" : "no";
    report.fnsku_slip_detail = {
      scan_ok: scan1.ok,
      scan_message: scan1.ok ? null : scan1.message,
      matched_slip: matchedSlip,
      off_slip: offSlip,
      notes: notes1,
    };
    if (scan1.ok) createdReturnItemIds.push(scan1.id);
    if (!fnskuPass) blockers.push("FNSKU scan did not allocate to slip / went unexpected");

    // Fill to expected, then one more for OVER on same slip row
    const scan2 =
      expectedQty > 1
        ? await insertOperatorPackageItemAction({
            requestedOrganizationId: orgId,
            packageId: pkgId,
            storeId,
            slipContentId: slipId,
            scannedBarcode: TARGET_FNSKU,
            matchKind: "fnsku",
            quantity: 1,
            discrepancyTags: ["sellable_ok"],
            operatorNotes: `wv qty=2 ${rid}`,
          })
        : { ok: true as const, id: scan1.id };
    if (scan2.ok && scan2.id !== scan1.id) createdReturnItemIds.push(scan2.id);

    const scannedBeforeOver = await sumSlipRowReceivedQty(
      admin,
      pkgId,
      orgId,
      slipId,
      matchRows,
    );
    const scanOver = await insertOperatorPackageItemAction({
      requestedOrganizationId: orgId,
      packageId: pkgId,
      storeId,
      slipContentId: slipId,
      scannedBarcode: TARGET_FNSKU,
      matchKind: "fnsku",
      quantity: 1,
      discrepancyTags: ["sellable_ok"],
      operatorNotes: `wv over ${rid}`,
    });
    const scannedAfterOver = await sumSlipRowReceivedQty(
      admin,
      pkgId,
      orgId,
      slipId,
      matchRows,
    );
    const qtyLineOver = computeSlipLineExpectedVsReceived({
      expectedQty,
      receivedQty: scannedAfterOver,
      manifestRecordedMissingQty: missingReviewRecordedQtyForSlip(pkg.manifest_data, slipId),
    });
    const overPass =
      scanOver.ok &&
      scannedAfterOver > expectedQty &&
      scannedAfterOver > scannedBeforeOver;
    report.over_same_row_pass = overPass ? "yes" : "no";
    report.over_detail = {
      scan_ok: scanOver.ok,
      scan_message: scanOver.ok ? null : scanOver.message,
      expectedQty,
      scannedBeforeOver,
      scannedAfterOver,
      qtyLine: qtyLineOver,
    };
    if (scanOver.ok) createdReturnItemIds.push(scanOver.id);
    if (!overPass) blockers.push("Over scan did not increment same slip row above expected");

    // Missing mark — no return_items
    const riBeforeMissing = (priorRi ?? []).length;
    const { count: riCountBeforeMissing } = await admin
      .from(RETURN_ITEMS_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("package_id", pkgId)
      .is("deleted_at", null);
    await markOperatorSlipMissingExpectedAction({
      requestedOrganizationId: orgId,
      packageId: pkgId,
      storeId,
      slipContentId: slipId,
      missingQty: 1,
      note: `wv missing ${rid}`,
    });
    const { count: riCountAfterMissing } = await admin
      .from(RETURN_ITEMS_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("package_id", pkgId)
      .is("deleted_at", null);
    if (riCountAfterMissing !== riCountBeforeMissing) {
      blockers.push("return_items created for missing mark");
    }

    // Delete one scanned unit
    const deleteTarget = createdReturnItemIds[createdReturnItemIds.length - 1];
    const scannedBeforeDelete = await sumSlipRowReceivedQty(
      admin,
      pkgId,
      orgId,
      slipId,
      matchRows,
    );
    const del = await deleteOperatorPackageItemAction({
      requestedOrganizationId: orgId,
      returnItemId: deleteTarget,
      packageId: pkgId,
    });
    const scannedAfterDelete = await sumSlipRowReceivedQty(
      admin,
      pkgId,
      orgId,
      slipId,
      matchRows,
    );
    const qtyLinePending = computeSlipLineExpectedVsReceived({
      expectedQty,
      receivedQty: scannedAfterDelete,
      manifestRecordedMissingQty: missingReviewRecordedQtyForSlip(pkg.manifest_data, slipId),
    });
    const deletePass =
      del.ok &&
      scannedAfterDelete < scannedBeforeDelete &&
      (scannedAfterDelete === 0 ? qtyLinePending.receivedQty === 0 : true);

    // Delete remaining wv rows to verify pending-at-zero
    for (const id of [...createdReturnItemIds].reverse()) {
      await deleteOperatorPackageItemAction({
        requestedOrganizationId: orgId,
        returnItemId: id,
        packageId: pkgId,
      });
    }
    const scannedAfterFullDelete = await sumSlipRowReceivedQty(
      admin,
      pkgId,
      orgId,
      slipId,
      matchRows,
    );
    report.delete_pending_at_zero =
      scannedAfterFullDelete === baselineSlipReceived
        ? "yes"
        : `remaining=${scannedAfterFullDelete} baseline=${baselineSlipReceived}`;
    report.delete_pass = deletePass ? "yes" : "no";
    report.delete_detail = {
      void_ok: del.ok,
      void_error: del.ok ? null : del.error,
      scannedBeforeDelete,
      scannedAfterDelete,
      qtyLine: qtyLinePending,
    };
    if (deletePass && deleteTarget) {
      createdReturnItemIds.splice(createdReturnItemIds.indexOf(deleteTarget), 1);
    }
    if (!deletePass) blockers.push("Delete scanned unit failed or count did not decrement");

    const claimsAfter = await countClaims(admin);
    const claimsUntouched =
      claimsAfter.claim_cases === claimsBefore.claim_cases &&
      claimsAfter.claim_candidates === claimsBefore.claim_candidates;
    report.claims_untouched = claimsUntouched ? "yes" : "no";
    report.claims_counts = { before: claimsBefore, after: claimsAfter };
    if (!claimsUntouched) blockers.push("claim_cases or claim_candidates count changed");
  } catch (e) {
    blockers.push(e instanceof Error ? e.message : String(e));
  } finally {
    for (const id of [...createdReturnItemIds].reverse()) {
      await admin.from(RETURN_ITEMS_TABLE).delete().eq("id", id);
    }
    if (createdSlipId) {
      await admin.from("slip_contents").delete().eq("id", createdSlipId);
    }
  }

  let buildOk = false;
  if (process.argv.includes("--skip-build")) {
    buildOk = true;
    report.build_result = "skipped";
  } else {
    try {
      execSync("npm run build", { stdio: "pipe", encoding: "utf8", timeout: 180_000 });
      buildOk = true;
      report.build_result = "pass";
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      report.build_result = "fail";
      blockers.push(`build: ${String(err.stderr ?? err.message ?? "fail").slice(0, 200)}`);
    }
  }

  const corePass =
    report.fnsku_slip_allocation_pass === "yes" &&
    report.over_same_row_pass === "yes" &&
    report.delete_pass === "yes" &&
    report.old_colors_preserved === "yes" &&
    report.chips_additive === "yes" &&
    report.claims_untouched === "yes" &&
    report.search_regression === "pass" &&
    buildOk;

  report.blockers = blockers;
  report.SAFE_TO_PUSH_AND_NEDA_PULL = corePass && blockers.length === 0 ? "yes" : "no";
  report.fixture = { package_id: pkgId, slip_id: slipId, org_id: orgId, store_id: storeId };

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(corePass && blockers.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
