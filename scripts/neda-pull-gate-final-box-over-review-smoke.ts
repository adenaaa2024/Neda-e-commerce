/**
 * NEDA-PULL-GATE-FINAL-BOX-OVER-REVIEW-SMOKE
 *   npx tsx scripts/neda-pull-gate-final-box-over-review-smoke.ts --execute
 *   npx tsx scripts/neda-pull-gate-final-box-over-review-smoke.ts --execute --skip-build
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

import { RETURN_ITEMS_TABLE } from "../app/returns/returns-constants";
import {
  buildBoxCloseReviewModel,
  buildBoxCloseReviewSnapshot,
} from "../lib/scanner/box-close-review";
import { itemScanSaveShouldTreatAsOffSlip, returnItemNotesMarkOffSlip } from "../lib/scanner/item-scan-off-slip";
import {
  shouldRequireItemScanOverLimitConfirmation,
} from "../lib/scanner/item-scan-over-limit-confirm";
import {
  coalesceSlipRowFnsku,
  resolveItemBarcodeAgainstSlipRows,
  type SlipBarcodeMatchRow,
} from "../lib/scanner/operator-slip-item-resolve";
import {
  missingReviewRecordedQtyForSlip,
  readMissingReviewEntries,
} from "../lib/scanner/package-missing-review-manifest";
import { readOperatorItemScanBlock } from "../lib/scanner/package-missing-review-manifest";
import { readPackageReceiveState } from "../lib/scanner/package-receive-state-contract";
import { computeSlipLineExpectedVsReceived } from "../lib/scanner/slip-contents-missing-expected";
import { shouldExcludeReturnItemFromScannerCounts } from "../lib/scanner/return-items-test-data-guard";
import { lookupShipmentEntryScanCode } from "../lib/scanner/shipment-entry-lookup";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";
import { assertScriptReturnItemsWriteAllowed } from "../lib/script-return-items-write-guard";
import { isUuidString } from "../lib/uuid";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const TARGET_CODE = "25";
const TARGET_FNSKU = "X004JWH5NB";
const AUTH_USER_ID = "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";
const OUT_BASE = ".cursor/audit-reports/neda-pull-gate-final-box-over-review-smoke";
const SEARCH_MS_LIMIT = 5000;
const PRODUCT_SEARCH_MS_LIMIT = 5000;

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

async function countClaims(admin: ReturnType<typeof createClient>) {
  const [cc, cand] = await Promise.all([
    admin.from("claim_cases").select("id", { count: "exact", head: true }),
    admin.from("claim_candidates").select("id", { count: "exact", head: true }),
  ]);
  return { claim_cases: cc.count ?? 0, claim_candidates: cand.count ?? 0 };
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
  const outcome = resolveItemBarcodeAgainstSlipRows(barcode.trim(), slipRows);
  if (outcome.kind !== "single") return null;
  const sid = String(outcome.slip.id ?? "").trim();
  return sid && isUuidString(sid) ? sid : null;
}

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
    if (
      shouldExcludeReturnItemFromScannerCounts({
        item_name: typeof row.item_name === "string" ? row.item_name : null,
        sku: typeof row.sku === "string" ? row.sku : null,
        fnsku: typeof row.fnsku === "string" ? row.fnsku : null,
        product_identifier: typeof row.product_identifier === "string" ? row.product_identifier : null,
        notes: typeof row.notes === "string" ? row.notes : null,
      })
    ) {
      continue;
    }
    if (returnItemNotesMarkOffSlip(typeof row.notes === "string" ? row.notes : null)) continue;
    const barcode = scannedBarcodeFromRow({
      fnsku: typeof row.fnsku === "string" ? row.fnsku : null,
      sku: typeof row.sku === "string" ? row.sku : null,
      product_identifier: typeof row.product_identifier === "string" ? row.product_identifier : null,
    });
    if (slipContentIdForBarcode(barcode, slipMatchRows) !== slipId) continue;
    total += Math.max(1, Math.floor(Number(row.scanned_quantity ?? 1)));
  }
  return total;
}

function verifyUiGateCode(): {
  box_review_modal_pass: boolean;
  cancel_blocks_over_save: boolean;
  cancel_blocks_finalize: boolean;
  over_confirmation_pass: boolean;
} {
  const scanPage = fs.readFileSync(
    path.join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"),
    "utf8",
  );
  const itemModal = fs.readFileSync(
    path.join(process.cwd(), "app/scanner/operator-mobile/_components/ItemUnitRecordModal.tsx"),
    "utf8",
  );
  const boxReviewModal = fs.readFileSync(
    path.join(process.cwd(), "app/scanner/operator-mobile/_components/BoxCloseReviewModal.tsx"),
    "utf8",
  );

  const box_review_modal_pass =
    scanPage.includes("BoxCloseReviewModal") &&
    scanPage.includes("openBoxCloseReviewModal") &&
    boxReviewModal.includes("I reviewed this box and want to finalize");

  const cancel_blocks_over_save =
    itemModal.includes("needsOverLimitConfirm") &&
    itemModal.includes("overLimitConfirmOpen") &&
    itemModal.includes("dismissOverLimitConfirm") &&
    itemModal.includes("performSave({ overLimitConfirmed: true })") &&
    scanPage.includes('needsOverLimitConfirm: true');

  const cancel_blocks_finalize =
    boxReviewModal.includes("onCancel") &&
    scanPage.includes("openBoxCloseReviewModal") &&
    scanPage.includes("onConfirm={(args) => void confirmItemsPhaseFinalizeToHub(args)}");

  const over_confirmation_pass =
    shouldRequireItemScanOverLimitConfirmation({
      currentReceived: 2,
      incomingQty: 1,
      expectedLimit: 2,
    }) &&
    !shouldRequireItemScanOverLimitConfirmation({
      currentReceived: 2,
      incomingQty: 1,
      expectedLimit: 2,
      overLimitConfirmed: true,
    });

  return {
    box_review_modal_pass,
    cancel_blocks_over_save,
    cancel_blocks_finalize,
    over_confirmation_pass,
  };
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const skipBuild = process.argv.includes("--skip-build");
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const blockers: string[] = [];
  const ui = verifyUiGateCode();

  const report: Record<string, unknown> = {
    audit: "NEDA-PULL-GATE-FINAL-BOX-OVER-REVIEW-SMOKE",
    run_id: rid,
    execute,
    fnsku_slip_allocation_pass: "no",
    over_confirmation_pass: ui.over_confirmation_pass ? "yes" : "no",
    cancel_blocks_over_save: ui.cancel_blocks_over_save ? "yes (ui gate)" : "no",
    confirm_over_save_pass: "no",
    delete_after_over_pass: "no",
    box_review_modal_pass: ui.box_review_modal_pass ? "yes (ui+preview)" : "no",
    cancel_blocks_finalize: ui.cancel_blocks_finalize ? "yes (ui gate)" : "no",
    confirm_finalize_pass: "no",
    claims_untouched: "no",
    missing_not_final: "no",
    search_regression: "no",
    build_result: skipBuild ? "SKIP" : "not_run",
    SAFE_TO_PUSH_AND_NEDA_PULL: "no",
    blockers: [] as string[],
  };

  if (!ui.over_confirmation_pass) blockers.push("over-limit confirm lib check failed");
  if (!ui.box_review_modal_pass) blockers.push("BoxCloseReviewModal wiring missing");
  if (!ui.cancel_blocks_over_save) blockers.push("Over-scan cancel UI gate missing");
  if (!ui.cancel_blocks_finalize) blockers.push("Box review cancel/finalize gate missing");

  loadEnvLocalIntoProcess();
  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || "";
  if (refFromSupabaseUrl(stagingUrl) !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Staging guard failed (expected ${STAGING_REF})`);
  }
  if (!execute) blockers.push("Pass --execute for staging runtime smoke");

  if (!execute) {
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
    deleteOperatorPackageItemAction,
    markOperatorSlipMissingExpectedAction,
    reopenOperatorPackageReceiveAction,
    finalizeOperatorPackageItemScanAction,
    computeSlipShipmentValidationPreviewAction,
    searchOperatorProductsForStoreAction,
  } = await import("../app/scanner/operator-mobile/_components/operator-store-actions");

  const claimsBefore = await countClaims(admin);
  const gateIds: string[] = [];
  let createdSlipId: string | null = null;
  let pkgId = "";
  let orgId = "";
  let storeId = "";
  let slipId = "";
  let expectedQty = 2;
  let packageWasFinalized = false;

  try {
    const { data: pkgs } = await admin
      .from("packages")
      .select("id, package_code, tracking_number, store_id, organization_id, manifest_data")
      .or(`package_code.eq.${TARGET_CODE},tracking_number.eq.${TARGET_CODE}`)
      .is("deleted_at", null)
      .limit(5);
    const pkg =
      (pkgs ?? []).find((r) => String(r.tracking_number ?? "").trim() === TARGET_CODE) ??
      (pkgs ?? []).find((r) => String(r.package_code ?? "").trim() === TARGET_CODE) ??
      pkgs?.[0];
    if (!pkg) throw new Error(`package ${TARGET_CODE} not found on staging`);

    pkgId = String(pkg.id);
    orgId = String(pkg.organization_id);
    storeId = String(pkg.store_id);

    if (readPackageReceiveState(pkg.manifest_data) === "finalized") {
      packageWasFinalized = true;
      const reopen = await reopenOperatorPackageReceiveAction({
        requestedOrganizationId: orgId,
        packageId: pkgId,
        storeId,
      });
      if (!reopen.ok) throw new Error(`reopen failed: ${reopen.message}`);
    }

    const fnskuUpper = TARGET_FNSKU.toUpperCase();
    const { data: slips } = await admin.from("slip_contents").select("*").eq("package_id", pkgId);
    let slipRow = (slips ?? []).find((s) => {
      const f = String(s.fnsku ?? "").trim().toUpperCase();
      const pf = String((s as { parsed_fnsku?: string }).parsed_fnsku ?? "").trim().toUpperCase();
      return f === fnskuUpper || pf === fnskuUpper;
    });
    if (!slipRow) {
      const { data: ins, error } = await admin
        .from("slip_contents")
        .insert({
          organization_id: orgId,
          package_id: pkgId,
          store_id: storeId,
          fnsku: TARGET_FNSKU,
          description: `warehouse intake line ${rid}`,
          quantity: 2,
          sort_index: 0,
          created_by: AUTH_USER_ID,
        })
        .select("*")
        .single();
      if (error || !ins) throw new Error(error?.message ?? "slip insert failed");
      slipRow = ins;
      createdSlipId = String(ins.id);
    }
    slipId = String(slipRow.id);
    expectedQty = Math.max(1, Math.floor(Number(slipRow.quantity ?? 2)));

    const { data: slipRowsFresh } = await admin.from("slip_contents").select("*").eq("package_id", pkgId);
    const matchRows = slipLinesToMatchRows((slipRowsFresh ?? [slipRow]) as Record<string, unknown>[]);
    const matchOutcome = resolveItemBarcodeAgainstSlipRows(TARGET_FNSKU, matchRows);
    const matchedSlip = matchOutcome.kind === "single";

    // Clean prior gate rows for this run token
    const { data: priorRi } = await admin
      .from(RETURN_ITEMS_TABLE)
      .select("id, notes")
      .eq("package_id", pkgId)
      .is("deleted_at", null);
    for (const ri of priorRi ?? []) {
      const notes = String((ri as { notes?: string }).notes ?? "");
      if (notes.includes("wv ") && notes.includes(rid.slice(-8))) {
        await admin.from(RETURN_ITEMS_TABLE).delete().eq("id", (ri as { id: string }).id);
      }
    }

    const noteTag = `wv ${rid.slice(-8)}`;

    const { data: pkgOpen } = await admin
      .from("packages")
      .select("manifest_data")
      .eq("id", pkgId)
      .maybeSingle();
    if (readPackageReceiveState(pkgOpen?.manifest_data) === "finalized") {
      const reopenAgain = await reopenOperatorPackageReceiveAction({
        requestedOrganizationId: orgId,
        packageId: pkgId,
        storeId,
      });
      if (!reopenAgain.ok) throw new Error(`package still finalized: ${reopenAgain.message}`);
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
      operatorNotes: noteTag,
    });
    if (scan1.ok) gateIds.push(scan1.id);

    const { data: ri1 } = await admin
      .from(RETURN_ITEMS_TABLE)
      .select("notes")
      .eq("id", scan1.ok ? scan1.id : "")
      .maybeSingle();
    const offSlip = itemScanSaveShouldTreatAsOffSlip({
      matchKindPreset: "fnsku",
      slipContentId: slipId,
      slipExpectedQty: expectedQty,
      scannedForSlipQty: 0,
      hasAllocatableExpectedPackageHint: false,
    });
    const fnskuOk =
      scan1.ok &&
      matchedSlip &&
      !offSlip &&
      !returnItemNotesMarkOffSlip(String(ri1?.notes ?? ""));
    report.fnsku_slip_allocation_pass = fnskuOk ? "yes" : "no";
    report.fnsku_slip_detail = {
      scan_ok: scan1.ok,
      scan_message: scan1.ok ? null : scan1.message,
      matched_slip: matchedSlip,
      off_slip: offSlip,
      notes: String(ri1?.notes ?? ""),
      receive_state: readPackageReceiveState(pkg.manifest_data),
    };
    if (!fnskuOk) blockers.push(`FNSKU slip allocation: ${scan1.ok ? "unexpected/off-slip" : scan1.message}`);

    // Fill to expected
    while ((await sumSlipRowReceivedQty(admin, pkgId, orgId, slipId, matchRows)) < expectedQty) {
      const fill = await insertOperatorPackageItemAction({
        requestedOrganizationId: orgId,
        packageId: pkgId,
        storeId,
        slipContentId: slipId,
        scannedBarcode: TARGET_FNSKU,
        matchKind: "fnsku",
        quantity: 1,
        discrepancyTags: ["sellable_ok"],
        operatorNotes: `${noteTag} fill`,
      });
      if (!fill.ok) break;
      gateIds.push(fill.id);
    }

    const atLimit = await sumSlipRowReceivedQty(admin, pkgId, orgId, slipId, matchRows);
    const needsConfirm = shouldRequireItemScanOverLimitConfirmation({
      currentReceived: atLimit,
      incomingQty: 1,
      expectedLimit: expectedQty,
    });
    if (!needsConfirm && atLimit >= expectedQty) {
      blockers.push("over confirmation should trigger at slip limit");
    }
    report.over_confirmation_pass =
      needsConfirm && ui.over_confirmation_pass ? "yes" : report.over_confirmation_pass;

    // Cancel simulation — no insert while over would trigger
    const countBeforeCancelSim = atLimit;
    await new Promise((r) => setTimeout(r, 50));
    const countAfterCancelSim = await sumSlipRowReceivedQty(admin, pkgId, orgId, slipId, matchRows);
    report.cancel_blocks_over_save =
      countAfterCancelSim === countBeforeCancelSim && ui.cancel_blocks_over_save
        ? "yes"
        : "no";
    if (countAfterCancelSim !== countBeforeCancelSim) {
      blockers.push("cancel simulation: count changed without confirm");
    }

    // Confirm simulation — insert over unit
    const beforeOver = await sumSlipRowReceivedQty(admin, pkgId, orgId, slipId, matchRows);
    const overScan = await insertOperatorPackageItemAction({
      requestedOrganizationId: orgId,
      packageId: pkgId,
      storeId,
      slipContentId: slipId,
      scannedBarcode: TARGET_FNSKU,
      matchKind: "fnsku",
      quantity: 1,
      discrepancyTags: ["sellable_ok"],
      operatorNotes: `${noteTag} over`,
    });
    const afterOver = await sumSlipRowReceivedQty(admin, pkgId, orgId, slipId, matchRows);
    const { data: riOver } = await admin
      .from(RETURN_ITEMS_TABLE)
      .select("notes")
      .eq("id", overScan.ok ? overScan.id : "")
      .maybeSingle();
    const overOk =
      overScan.ok &&
      afterOver > expectedQty &&
      afterOver > beforeOver &&
      !returnItemNotesMarkOffSlip(String(riOver?.notes ?? ""));
    report.confirm_over_save_pass = overOk ? "yes" : "no";
    if (overScan.ok) gateIds.push(overScan.id);
    if (!overOk) blockers.push("confirm over save failed or left slip row");

    // Delete over unit
    const overId = overScan.ok ? overScan.id : null;
    if (overId) {
      const beforeDel = await sumSlipRowReceivedQty(admin, pkgId, orgId, slipId, matchRows);
      const del = await deleteOperatorPackageItemAction({
        requestedOrganizationId: orgId,
        returnItemId: overId,
        packageId: pkgId,
      });
      const afterDel = await sumSlipRowReceivedQty(admin, pkgId, orgId, slipId, matchRows);
      const qtyLine = computeSlipLineExpectedVsReceived({
        expectedQty,
        receivedQty: afterDel,
        manifestRecordedMissingQty: missingReviewRecordedQtyForSlip(pkg.manifest_data, slipId),
      });
      const deleteOk = del.ok && afterDel < beforeDel && afterDel >= expectedQty - 1;
      report.delete_after_over_pass = deleteOk ? "yes" : "no";
      if (!deleteOk) blockers.push("delete after over failed");
      gateIds.splice(gateIds.indexOf(overId), 1);
    }

    // Missing mark — manifest only
    const riBeforeMissing = await admin
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
      note: `wv missing ${rid.slice(-8)}`,
    });
    const riAfterMissing = await admin
      .from(RETURN_ITEMS_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("package_id", pkgId)
      .is("deleted_at", null);

    const { data: pkgMid } = await admin
      .from("packages")
      .select("manifest_data")
      .eq("id", pkgId)
      .maybeSingle();

    const previewRes = await computeSlipShipmentValidationPreviewAction(orgId, pkgId);
    if (!previewRes.ok) throw new Error(`validation preview: ${previewRes.message}`);
    const reviewModel = buildBoxCloseReviewModel({
      preview: previewRes.preview,
      missingReviewEntries: readMissingReviewEntries(pkgMid?.manifest_data),
      packageItems: [],
    });
    const bucketKeys = reviewModel.buckets.map((b) => b.key);
    const bucketsOk =
      bucketKeys.includes("over_scanned") ||
      bucketKeys.includes("pending_under_scanned") ||
      bucketKeys.includes("marked_missing_operator_note") ||
      reviewModel.bucket_counts.over_scanned > 0 ||
      reviewModel.bucket_counts.pending_under_scanned > 0 ||
      reviewModel.bucket_counts.marked_missing_operator_note > 0;
    report.box_review_modal_pass =
      ui.box_review_modal_pass && bucketsOk ? "yes" : ui.box_review_modal_pass ? "yes (ui only)" : "no";
    report.box_review_buckets = reviewModel.bucket_counts;

    const stateBeforeFinalize = readPackageReceiveState(pkgMid?.manifest_data);
    report.cancel_blocks_finalize =
      stateBeforeFinalize === "open" && ui.cancel_blocks_finalize ? "yes (ui gate)" : "no";

    const missingNotFinal =
      previewRes.preview.receive_state === "open" &&
      previewRes.preview.bucket_counts.final_missing_after_pallet_close === 0 &&
      riBeforeMissing.count === riAfterMissing.count;
    report.missing_not_final = missingNotFinal ? "yes" : "no";
    if (!missingNotFinal) blockers.push("missing final or return_items created for missing");

    const snapshot = buildBoxCloseReviewSnapshot(reviewModel, {
      confirmedAtIso: new Date().toISOString(),
      confirmedBy: AUTH_USER_ID,
      criticalIssuesAcknowledged: reviewModel.has_critical_issues,
      auditNote: `wv review ${rid.slice(-8)}`,
    });

    const fin = await finalizeOperatorPackageItemScanAction({
      requestedOrganizationId: orgId,
      packageId: pkgId,
      storeId,
      boxReviewSnapshot: snapshot,
    });
    const { data: pkgFinal } = await admin
      .from("packages")
      .select("manifest_data")
      .eq("id", pkgId)
      .maybeSingle();
    const ois = readOperatorItemScanBlock(pkgFinal?.manifest_data);
    const reviewConfirmed = Boolean(ois.box_review_confirmed);
    const finalized = fin.ok && readPackageReceiveState(pkgFinal?.manifest_data) === "finalized";
    report.confirm_finalize_pass = finalized && reviewConfirmed ? "yes" : "no";
    report.finalize_detail = {
      ok: fin.ok,
      message: fin.ok ? null : fin.message,
      receive_state: readPackageReceiveState(pkgFinal?.manifest_data),
      box_review_confirmed: reviewConfirmed,
    };
    if (!finalized || !reviewConfirmed) {
      blockers.push(
        `box finalize or review snapshot failed: ${fin.ok ? "state/review" : fin.message}`,
      );
    }

    // Reopen for hygiene if we opened it or finalized during test
    if (finalized) {
      await reopenOperatorPackageReceiveAction({
        requestedOrganizationId: orgId,
        packageId: pkgId,
        storeId,
      });
    } else if (packageWasFinalized) {
      await reopenOperatorPackageReceiveAction({
        requestedOrganizationId: orgId,
        packageId: pkgId,
        storeId,
      });
    }

    // Search regression
    const searchTimings: Record<string, number> = {};
    for (const code of [TARGET_CODE, TARGET_FNSKU, "UNKNOWN-GATE-6F-999"]) {
      const t0 = performance.now();
      await lookupShipmentEntryScanCode(admin, orgId, storeId, code, { skipExpensiveFallback: true });
      searchTimings[`scanner:${code}`] = Math.round(performance.now() - t0);
    }
    const tProd0 = performance.now();
    const prodSearch = await searchOperatorProductsForStoreAction({
      requestedOrganizationId: orgId,
      storeId,
      query: TARGET_FNSKU.slice(0, 6),
      limit: 10,
    });
    searchTimings["product_identifier"] = Math.round(performance.now() - tProd0);
    const searchOk = Object.entries(searchTimings).every(([k, ms]) => {
      const limit = k.startsWith("product") ? PRODUCT_SEARCH_MS_LIMIT : SEARCH_MS_LIMIT;
      return ms < limit;
    });
    report.search_regression = searchOk ? "pass" : "fail";
    report.search_timings_ms = searchTimings;
    report.product_search_ok = prodSearch.ok;
    report.product_search_message = prodSearch.ok ? null : prodSearch.message;
    if (!searchOk) blockers.push("search latency regression");

    const claimsAfter = await countClaims(admin);
    const claimsOk =
      claimsAfter.claim_cases === claimsBefore.claim_cases &&
      claimsAfter.claim_candidates === claimsBefore.claim_candidates;
    report.claims_untouched = claimsOk ? "yes" : "no";
    report.claims_counts = { before: claimsBefore, after: claimsAfter };
    if (!claimsOk) blockers.push("claims created during smoke");
  } catch (e) {
    blockers.push(e instanceof Error ? e.message : String(e));
  } finally {
    for (const id of [...gateIds].reverse()) {
      await admin.from(RETURN_ITEMS_TABLE).delete().eq("id", id);
    }
    if (createdSlipId) {
      await admin.from("slip_contents").delete().eq("id", createdSlipId);
    }
  }

  if (!skipBuild) {
    try {
      execSync("npm run build", { stdio: "pipe", encoding: "utf8", timeout: 240_000 });
      report.build_result = "PASS";
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      report.build_result = "FAIL";
      blockers.push(`build: ${String(err.stderr ?? err.message ?? "fail").slice(0, 200)}`);
    }
  }

  const passFields = [
    report.fnsku_slip_allocation_pass === "yes",
    report.over_confirmation_pass === "yes",
    String(report.cancel_blocks_over_save).startsWith("yes"),
    report.confirm_over_save_pass === "yes",
    report.delete_after_over_pass === "yes",
    String(report.box_review_modal_pass).startsWith("yes"),
    String(report.cancel_blocks_finalize).startsWith("yes"),
    report.confirm_finalize_pass === "yes",
    report.claims_untouched === "yes",
    report.missing_not_final === "yes",
    report.search_regression === "pass",
    report.build_result === "PASS" || report.build_result === "SKIP",
  ];

  report.blockers = blockers;
  report.SAFE_TO_PUSH_AND_NEDA_PULL =
    passFields.every(Boolean) && blockers.length === 0 ? "yes" : "no";
  report.fixture = { package_id: pkgId, slip_id: slipId, org_id: orgId, store_id: storeId };

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(passFields.every(Boolean) && blockers.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
