/**
 * NEDA-PULL-GATE-OVER-DISPLAY-FINAL-SMOKE
 *   npx tsx scripts/neda-pull-gate-over-display-final-smoke.ts --execute
 *   npx tsx scripts/neda-pull-gate-over-display-final-smoke.ts --execute --skip-build
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

import { RETURN_ITEMS_TABLE } from "../app/returns/returns-constants";
import { buildBoxCloseReviewModel } from "../lib/scanner/box-close-review";
import { returnItemNotesMarkOffSlip } from "../lib/scanner/item-scan-off-slip";
import { shouldRequireItemScanOverLimitConfirmation } from "../lib/scanner/item-scan-over-limit-confirm";
import { nedaQuantityRowPresentation } from "../lib/scanner/neda-quantity-color-matrix";
import {
  coalesceSlipRowFnsku,
  resolveItemBarcodeAgainstSlipRows,
  type SlipBarcodeMatchRow,
} from "../lib/scanner/operator-slip-item-resolve";
import { readPackageReceiveState } from "../lib/scanner/package-receive-state-contract";
import {
  computeSlipLineExpectedVsReceived,
  slipLineStatusBadgeState,
} from "../lib/scanner/slip-contents-missing-expected";
import { shouldExcludeReturnItemFromScannerCounts } from "../lib/scanner/return-items-test-data-guard";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";
import { assertScriptReturnItemsWriteAllowed } from "../lib/script-return-items-write-guard";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const TARGET_CODE = "25";
const TARGET_FNSKU = "X004JWH5NB";
const AUTH_USER_ID = "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";
const OUT_BASE = ".cursor/audit-reports/neda-pull-gate-over-display-final-smoke";

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

function displayState(expected: number, received: number) {
  const qtyLine = computeSlipLineExpectedVsReceived({ expectedQty: expected, receivedQty: received });
  const badge = slipLineStatusBadgeState(qtyLine, false);
  const surface = nedaQuantityRowPresentation(expected, received, false);
  return { qtyLine, badge, surface };
}

function assertOverDisplay(expected: number, received: number): boolean {
  const { badge, surface } = displayState(expected, received);
  return (
    received > expected &&
    badge.label === "Over" &&
    badge.tone === "over" &&
    badge.label !== "Received" &&
    surface.label === "OVER"
  );
}

function assertNotReceivedWhenOver(expected: number, received: number): boolean {
  if (received <= expected) return true;
  const { badge } = displayState(expected, received);
  return badge.label !== "Received" && badge.tone !== "received";
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

    const barcode =
      String(row.fnsku ?? "").trim() ||
      String(row.sku ?? "").trim() ||
      String(row.product_identifier ?? "").trim();
    const outcome = resolveItemBarcodeAgainstSlipRows(barcode, slipMatchRows);
    if (outcome.kind !== "single") continue;
    const sid = String(outcome.slip.id ?? "").trim();
    if (sid !== slipId) continue;
    total += Math.max(1, Math.floor(Number(row.scanned_quantity ?? 1)));
  }
  return total;
}

function verifyUiOverStyling(): {
  over_styling_pass: boolean;
  box_review_finalize_gate_pass: boolean;
  over_modal_in_item_unit_pass: boolean;
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
  const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  return {
    over_styling_pass:
      scanPage.includes("slipLineStatusBadgeState") &&
      scanPage.includes('data-neda-qty="OVER"') &&
      css.includes('.operator-item-scan-slip-status[data-neda-qty="OVER"]'),
    box_review_finalize_gate_pass:
      scanPage.includes("BoxCloseReviewModal") &&
      scanPage.includes("openBoxCloseReviewModal") &&
      boxReviewModal.includes("I reviewed this box and want to finalize") &&
      boxReviewModal.includes("onCancel") &&
      !boxReviewModal.includes("finalizeOperatorPackageItemScanAction"),
    over_modal_in_item_unit_pass:
      itemModal.includes("overLimitConfirmOpen") &&
      itemModal.includes("dismissOverLimitConfirm") &&
      itemModal.includes("performSave({ overLimitConfirmed: true })") &&
      !scanPage.includes("overLimitPendingSavePayloadRef"),
  };
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const skipBuild = process.argv.includes("--skip-build");
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const blockers: string[] = [];
  const report: Record<string, unknown> = {
    audit: "NEDA-PULL-GATE-OVER-DISPLAY-FINAL-SMOKE",
    run_id: rid,
    execute,
    allocation_pass: "no",
    over_warning_pass: "no",
    over_display_pass: "no",
    not_received_when_over: "no",
    delete_recalc_pass: "no",
    box_review_over_pass: "no",
    claims_untouched: "no",
    build_result: skipBuild ? "SKIP" : "not_run",
    SAFE_TO_PUSH_AND_NEDA_PULL: "no",
    blockers: [] as string[],
  };

  // Code-level over warning + styling gates
  const overWarningLib =
    shouldRequireItemScanOverLimitConfirmation({
      currentReceived: 1,
      incomingQty: 1,
      expectedLimit: 1,
    }) &&
    !shouldRequireItemScanOverLimitConfirmation({
      currentReceived: 1,
      incomingQty: 1,
      expectedLimit: 1,
      overLimitConfirmed: true,
    });
  const uiGates = verifyUiOverStyling();
  report.over_warning_pass = overWarningLib ? "yes (lib+ui gate)" : "no";
  if (!overWarningLib) blockers.push("over-limit confirm lib failed");
  if (!uiGates.over_styling_pass) blockers.push("OVER UI styling missing");
  if (!uiGates.over_modal_in_item_unit_pass) blockers.push("over warning modal not owned by ItemUnitRecordModal");
  if (!uiGates.box_review_finalize_gate_pass) blockers.push("box review finalize gate missing");

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
    reopenOperatorPackageReceiveAction,
    computeSlipShipmentValidationPreviewAction,
  } = await import("../app/scanner/operator-mobile/_components/operator-store-actions");

  const claimsBefore = await countClaims(admin);
  const gateIds: string[] = [];
  let createdSlipId: string | null = null;
  let pkgId = "";
  let orgId = "";
  let storeId = "";
  let slipId = "";
  let expectedQty = 2;
  const deleteRecalcSteps: Array<{ received: number; badge: string; surface: string }> = [];

  try {
    const { data: pkgs } = await admin
      .from("packages")
      .select("id, tracking_number, package_code, organization_id, store_id, manifest_data")
      .or(`package_code.eq.${TARGET_CODE},tracking_number.eq.${TARGET_CODE}`)
      .is("deleted_at", null)
      .limit(5);
    const pkg =
      (pkgs ?? []).find((r) => String(r.tracking_number ?? "").trim() === TARGET_CODE) ??
      pkgs?.[0];
    if (!pkg) throw new Error(`package ${TARGET_CODE} not found`);

    pkgId = String(pkg.id);
    orgId = String(pkg.organization_id);
    storeId = String(pkg.store_id);

    if (readPackageReceiveState(pkg.manifest_data) === "finalized") {
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
    const noteTag = `wv ${rid.slice(-8)}`;

    // Clean prior wv rows for this run
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
    const allocOk =
      scan1.ok &&
      !returnItemNotesMarkOffSlip(String(ri1?.notes ?? "")) &&
      resolveItemBarcodeAgainstSlipRows(TARGET_FNSKU, matchRows).kind === "single";
    report.allocation_pass = allocOk ? "yes" : "no";
    if (!allocOk) blockers.push("FNSKU did not allocate to slip row");

    // Fill to expected then one over (simulates confirm save)
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
    const needsWarn = shouldRequireItemScanOverLimitConfirmation({
      currentReceived: atLimit,
      incomingQty: 1,
      expectedLimit: expectedQty,
    });
    if (!needsWarn) blockers.push("over warning should trigger at slip limit");

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
    if (overScan.ok) gateIds.push(overScan.id);

    const receivedOver = await sumSlipRowReceivedQty(admin, pkgId, orgId, slipId, matchRows);
    const overDisplayOk = receivedOver > expectedQty && assertOverDisplay(expectedQty, receivedOver);
    const notReceivedOk = assertNotReceivedWhenOver(expectedQty, receivedOver);
    report.over_display_pass = overDisplayOk && uiGates.over_styling_pass ? "yes" : "no";
    report.not_received_when_over = notReceivedOk ? "yes" : "no";
    report.over_warning_pass =
      needsWarn && overWarningLib ? "yes (lib+ui gate)" : report.over_warning_pass;
    report.display_at_over = displayState(expectedQty, receivedOver);

    if (!overDisplayOk) blockers.push("display at over: badge/surface not OVER");
    if (!notReceivedOk) blockers.push("received pill shown when over");
    if (!needsWarn) blockers.push("over warning should trigger at slip limit");

    // Box review over bucket while still over (before delete recalc)
    const previewRes = await computeSlipShipmentValidationPreviewAction(orgId, pkgId);
    if (!previewRes.ok) throw new Error(previewRes.message);
    const reviewModel = buildBoxCloseReviewModel({
      preview: previewRes.preview,
      missingReviewEntries: [],
      packageItems: [],
    });
    const overBucketOk =
      reviewModel.bucket_counts.over_scanned > 0 ||
      reviewModel.buckets.some((b) => b.key === "over_scanned" && b.count > 0);
    report.box_review_over_pass =
      overBucketOk && uiGates.box_review_finalize_gate_pass ? "yes" : "no";
    report.box_review_buckets = reviewModel.bucket_counts;
    if (!overBucketOk) blockers.push("box review missing over bucket");
    if (!uiGates.box_review_finalize_gate_pass) blockers.push("box review finalize gate missing");

    // Delete recalc: step down until pending
    let deleteIds = [...gateIds];
    while (deleteIds.length > 0) {
      const received = await sumSlipRowReceivedQty(admin, pkgId, orgId, slipId, matchRows);
      const st = displayState(expectedQty, received);
      deleteRecalcSteps.push({
        received,
        badge: st.badge.label,
        surface: st.surface.label,
      });

      const delId = deleteIds.pop()!;
      const del = await deleteOperatorPackageItemAction({
        requestedOrganizationId: orgId,
        returnItemId: delId,
        packageId: pkgId,
      });
      if (!del.ok) {
        blockers.push(`delete failed: ${del.error}`);
        break;
      }
      gateIds.splice(gateIds.indexOf(delId), 1);
    }
    const finalReceived = await sumSlipRowReceivedQty(admin, pkgId, orgId, slipId, matchRows);
    deleteRecalcSteps.push({
      received: finalReceived,
      badge: displayState(expectedQty, finalReceived).badge.label,
      surface: displayState(expectedQty, finalReceived).surface.label,
    });

    const deleteRecalcOk =
      deleteRecalcSteps.some(
        (s) => s.received > expectedQty && s.badge === "Over" && s.surface === "OVER",
      ) &&
      deleteRecalcSteps.some(
        (s) => s.received === expectedQty && s.badge === "Received" && s.surface === "RECEIVED",
      ) &&
      deleteRecalcSteps.some(
        (s) =>
          s.received < expectedQty &&
          s.received > 0 &&
          (s.badge === "In progress" || s.surface === "IN PROGRESS"),
      ) &&
      (finalReceived === 0
        ? deleteRecalcSteps.some(
            (s) => s.received === 0 && s.badge === "Pending" && s.surface === "Awaiting",
          )
        : deleteRecalcSteps.some(
            (s) =>
              s.received < expectedQty &&
              s.received > 0 &&
              s.badge !== "Over" &&
              s.badge !== "Received",
          ));
    report.delete_recalc_pass = deleteRecalcOk ? "yes" : "no";
    report.delete_recalc_steps = deleteRecalcSteps;
    if (!deleteRecalcOk) blockers.push("delete recalc status steps incomplete");

    const claimsAfter = await countClaims(admin);
    const claimsOk =
      claimsAfter.claim_cases === claimsBefore.claim_cases &&
      claimsAfter.claim_candidates === claimsBefore.claim_candidates;
    report.claims_untouched = claimsOk ? "yes" : "no";
    report.claims_counts = { before: claimsBefore, after: claimsAfter };
    if (!claimsOk) blockers.push("claims changed during smoke");
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

  const pass =
    report.allocation_pass === "yes" &&
    String(report.over_warning_pass).startsWith("yes") &&
    report.over_display_pass === "yes" &&
    report.not_received_when_over === "yes" &&
    report.delete_recalc_pass === "yes" &&
    report.box_review_over_pass === "yes" &&
    report.claims_untouched === "yes" &&
    (report.build_result === "PASS" || report.build_result === "SKIP");

  report.blockers = blockers;
  report.SAFE_TO_PUSH_AND_NEDA_PULL = pass && blockers.length === 0 ? "yes" : "no";
  report.fixture = { package_id: pkgId, slip_id: slipId, expected_qty: expectedQty, fnsku: TARGET_FNSKU };

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(pass && blockers.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
