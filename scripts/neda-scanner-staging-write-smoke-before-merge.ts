/**
 * NEDA_SCANNER_STAGING_WRITE_SMOKE_BEFORE_MERGE
 * Usage: npx tsx scripts/neda-scanner-staging-write-smoke-before-merge.ts --execute
 *
 * Staging only. Disposable package fixture with rollback. No schema changes.
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { RETURN_ITEMS_TABLE } from "../app/returns/returns-constants";
import { insertIntakeBoxPackage } from "../lib/scanner/operator-box-intake";
import {
  readMissingReviewEntries,
  missingReviewEntryForSlip,
} from "../lib/scanner/package-missing-review-manifest";
import { readPackageReceiveState } from "../lib/scanner/package-receive-state-contract";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/neda-scanner-staging-write-smoke-before-merge";
/** Audit tag only — must not appear on return_items marker fields (insert guard). */
const AUDIT_TAG = "neda-scanner-staging-write-verify";
const FIXTURE_PACKAGE_ID = "9528d923-3d27-4aed-a773-095b5028743d";
const FIXTURE_ORG_ID = "7397edff-7994-4731-8501-55d258d507d2";
const FIXTURE_STORE_ID = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";
const FIXTURE_PACKAGE_CODE = "1231";
const SAMPLE_FNSKU = "X004N9OS4J";
const AUTH_USER_ID = "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";
const SCAN_QTY = 3;

type StepResult = { ok: boolean; detail: string };

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `run-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
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
        set: (name: string, value: string) => {
          const i = jar.findIndex((c) => c.name === name);
          if (i >= 0) jar[i]!.value = value;
          else jar.push({ name, value });
        },
        delete: (name: string) => {
          const i = jar.findIndex((c) => c.name === name);
          if (i >= 0) jar.splice(i, 1);
        },
      }),
    },
  } as Module;
}

async function countActiveReturnItems(
  admin: ReturnType<typeof createClient>,
  packageId: string,
): Promise<number> {
  const { data } = await admin
    .from(RETURN_ITEMS_TABLE)
    .select("id")
    .eq("package_id", packageId)
    .is("deleted_at", null);
  return data?.length ?? 0;
}

async function rollbackFixture(
  admin: ReturnType<typeof createClient>,
  packageId: string,
  slipId: string | null,
  createdReturnItemIds: string[],
): Promise<void> {
  for (const id of createdReturnItemIds) {
    await admin.from(RETURN_ITEMS_TABLE).delete().eq("id", id);
  }
  await admin.from(RETURN_ITEMS_TABLE).delete().eq("package_id", packageId);
  if (slipId) await admin.from("slip_contents").delete().eq("id", slipId);
  await admin.from("slip_contents").delete().eq("package_id", packageId);
  await admin.from("packages").delete().eq("id", packageId);
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const blockers: string[] = [];
  const report: Record<string, unknown> = {
    audit: "neda-scanner-staging-write-smoke-before-merge",
    run_id: rid,
    write_smoke_ran: "no",
    quantity_result: { ok: false, detail: "not run" },
    missing_review_result: { ok: false, detail: "not run" },
    finalize_result: { ok: false, detail: "not run" },
    reopen_result: { ok: false, detail: "not run" },
    edit_result: { ok: false, detail: "not run" },
    empty_box_guard_result: { ok: false, detail: "not run" },
    return_items_not_created_for_missing: "no",
    build_result: { ok: false, detail: "not run" },
    SAFE_TO_MERGE_NEDA_SCANNER: "no",
    blockers: [] as string[],
  };

  loadEnvLocalIntoProcess();
  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || "";
  const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
  const anonKey = process.env.STAGING_ANON_KEY?.trim() || "";

  if (refFromSupabaseUrl(stagingUrl) !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Staging guard failed (expected ${STAGING_REF})`);
  }
  if (!stagingUrl || !serviceKey || !anonKey) blockers.push("Missing staging Supabase URL or keys");
  if (!execute) blockers.push("Pass --execute to run staging write smoke");

  if (blockers.length) {
    report.blockers = blockers;
    fs.writeFileSync(path.join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  process.env.NEXT_PUBLIC_SUPABASE_URL = stagingUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
  process.env.SUPABASE_URL = stagingUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
  process.env.APP_ENV = "staging";

  const admin = createClient(stagingUrl, serviceKey, { auth: { persistSession: false } });
  const jar = await establishCookieJar();
  installCookieMock(jar);

  const {
    insertOperatorPackageItemAction,
    markOperatorSlipMissingExpectedAction,
    finalizeOperatorPackageItemScanAction,
    reopenOperatorPackageReceiveAction,
    patchPackageMissingReviewAction,
    correctOperatorPackageItemQuantityAction,
    saveOperatorEmptyBoxAction,
  } = await import("../app/scanner/operator-mobile/_components/operator-store-actions");

  const packageCode = `NSWS-${rid.slice(-12)}`;
  let packageId = "";
  let slipId = "";
  let scanFnsku = SAMPLE_FNSKU;
  const createdReturnItemIds: string[] = [];

  try {
    report.write_smoke_ran = "yes";

    const opened = await insertIntakeBoxPackage(admin, {
      organizationId: FIXTURE_ORG_ID,
      palletId: null,
      packageNumber: packageCode,
      shipmentTrackingNumber: `NSWS-PALLET-${rid}`,
      storeId: FIXTURE_STORE_ID,
      created_by: AUTH_USER_ID,
    });
    if (!opened.ok) {
      blockers.push(`fixture open failed: ${opened.message}`);
      throw new Error(opened.message);
    }
    packageId = opened.packageId;

    const digits = rid.replace(/\D/g, "").slice(-7).padStart(7, "0");
    scanFnsku = `X009${digits}`;
    const { data: slipRow, error: slipErr } = await admin
      .from("slip_contents")
      .insert({
        organization_id: FIXTURE_ORG_ID,
        package_id: packageId,
        store_id: FIXTURE_STORE_ID,
        fnsku: scanFnsku,
        description: `Warehouse intake line ${rid}`,
        quantity: SCAN_QTY + 1,
        sort_index: 0,
        created_by: AUTH_USER_ID,
      })
      .select("id")
      .single();
    if (slipErr || !slipRow?.id) {
      blockers.push(`slip insert failed: ${slipErr?.message ?? "no id"}`);
      throw new Error(slipErr?.message ?? "slip insert failed");
    }
    slipId = String(slipRow.id);

    const beforeScanCount = await countActiveReturnItems(admin, packageId);
    const scan = await insertOperatorPackageItemAction({
      requestedOrganizationId: FIXTURE_ORG_ID,
      packageId,
      storeId: FIXTURE_STORE_ID,
      slipContentId: slipId,
      scannedBarcode: scanFnsku,
      matchKind: "fnsku",
      quantity: SCAN_QTY,
      discrepancyTags: ["sellable_ok"],
      operatorNotes: `write-verify qty=${SCAN_QTY} ${rid}`,
    });
    const afterScanCount = await countActiveReturnItems(admin, packageId);
    const quantityResult: StepResult = {
      ok: scan.ok && afterScanCount === beforeScanCount + 1,
      detail: scan.ok
        ? `return_item=${scan.id} scanned_quantity=${SCAN_QTY} rows ${beforeScanCount}→${afterScanCount}`
        : `scan failed: ${scan.ok ? "" : scan.message}`,
    };
    report.quantity_result = quantityResult;
    if (!quantityResult.ok) blockers.push(`quantity: ${quantityResult.detail}`);
    if (scan.ok) createdReturnItemIds.push(scan.id);

    const beforeMissingCount = await countActiveReturnItems(admin, packageId);
    const markMissing = await markOperatorSlipMissingExpectedAction({
      requestedOrganizationId: FIXTURE_ORG_ID,
      packageId,
      storeId: FIXTURE_STORE_ID,
      slipContentId: slipId,
      missingQty: 1,
      note: `write-verify missing ${rid}`,
    });
    const afterMissingCount = await countActiveReturnItems(admin, packageId);
    const noReturnItemsForMissing = afterMissingCount === beforeMissingCount;

    const { data: pkgAfterMissing } = await admin
      .from("packages")
      .select("manifest_data")
      .eq("id", packageId)
      .maybeSingle();
    const missingEntries = readMissingReviewEntries(pkgAfterMissing?.manifest_data);
    const slipEntry = missingReviewEntryForSlip(pkgAfterMissing?.manifest_data, slipId);

    const missingReviewResult: StepResult = {
      ok:
        markMissing.ok &&
        noReturnItemsForMissing &&
        missingEntries.length >= 1 &&
        Boolean(slipEntry) &&
        slipEntry!.operator_marked_missing_qty === 1,
      detail: markMissing.ok
        ? `manifest entries=${missingEntries.length} slip_marked=${slipEntry?.operator_marked_missing_qty ?? 0} return_items unchanged=${noReturnItemsForMissing}`
        : `mark missing failed: ${markMissing.message}`,
    };
    report.missing_review_result = missingReviewResult;
    report.return_items_not_created_for_missing = noReturnItemsForMissing ? "yes" : "no";
    if (!missingReviewResult.ok) blockers.push(`missing_review: ${missingReviewResult.detail}`);

    const finalize = await finalizeOperatorPackageItemScanAction({
      requestedOrganizationId: FIXTURE_ORG_ID,
      packageId,
      storeId: FIXTURE_STORE_ID,
    });
    const { data: pkgAfterFinalize } = await admin
      .from("packages")
      .select("manifest_data")
      .eq("id", packageId)
      .maybeSingle();
    const receiveStateAfterFinalize = readPackageReceiveState(pkgAfterFinalize?.manifest_data);
    const finalizeResult: StepResult = {
      ok: finalize.ok && receiveStateAfterFinalize === "finalized",
      detail: finalize.ok
        ? `finalized receive_state=${receiveStateAfterFinalize} scanned_qty=${finalize.scanned_qty}`
        : `finalize failed: ${finalize.message}`,
    };
    report.finalize_result = finalizeResult;
    if (!finalizeResult.ok) blockers.push(`finalize: ${finalizeResult.detail}`);

    const reopen = await reopenOperatorPackageReceiveAction({
      requestedOrganizationId: FIXTURE_ORG_ID,
      packageId,
      storeId: FIXTURE_STORE_ID,
    });
    const { data: pkgAfterReopen } = await admin
      .from("packages")
      .select("manifest_data")
      .eq("id", packageId)
      .maybeSingle();
    const receiveStateAfterReopen = readPackageReceiveState(pkgAfterReopen?.manifest_data);
    const reopenResult: StepResult = {
      ok: reopen.ok && receiveStateAfterReopen === "open",
      detail: reopen.ok
        ? `reopened receive_state=${receiveStateAfterReopen}`
        : `reopen failed: ${reopen.message}`,
    };
    report.reopen_result = reopenResult;
    if (!reopenResult.ok) blockers.push(`reopen: ${reopenResult.detail}`);

    const editMissing = await patchPackageMissingReviewAction({
      requestedOrganizationId: FIXTURE_ORG_ID,
      packageId,
      storeId: FIXTURE_STORE_ID,
      slipContentId: slipId,
      operatorMarkedMissingQty: 0,
    });
    const { data: pkgAfterUndoMissing } = await admin
      .from("packages")
      .select("manifest_data")
      .eq("id", packageId)
      .maybeSingle();
    const missingAfterUndo = missingReviewEntryForSlip(pkgAfterUndoMissing?.manifest_data, slipId);

    let qtyEditOk = false;
    let qtyEditDetail = "no return item";
    if (scan.ok) {
      const qtyEdit = await correctOperatorPackageItemQuantityAction({
        requestedOrganizationId: FIXTURE_ORG_ID,
        returnItemId: scan.id,
        storeId: FIXTURE_STORE_ID,
        scannedQuantity: 2,
      });
      const { data: riAfterEdit } = await admin
        .from(RETURN_ITEMS_TABLE)
        .select("scanned_quantity")
        .eq("id", scan.id)
        .maybeSingle();
      const editedQty = Math.max(0, Math.floor(Number(riAfterEdit?.scanned_quantity ?? 0)));
      qtyEditOk = qtyEdit.ok && editedQty === 2;
      qtyEditDetail = qtyEdit.ok
        ? `scanned_quantity ${SCAN_QTY}→${editedQty}`
        : `qty edit failed: ${qtyEdit.message}`;
    }

    const editResult: StepResult = {
      ok: editMissing.ok && !missingAfterUndo && qtyEditOk,
      detail: `unmark_missing=${editMissing.ok} entry_cleared=${!missingAfterUndo} ${qtyEditDetail}`,
    };
    report.edit_result = editResult;
    if (!editResult.ok) blockers.push(`edit: ${editResult.detail}`);

    const emptyBox = await saveOperatorEmptyBoxAction({
      requestedOrganizationId: FIXTURE_ORG_ID,
      packageId,
      storeId: FIXTURE_STORE_ID,
    });
    const emptyBoxGuardResult: StepResult = {
      ok: !emptyBox.ok && /physical items have already been scanned/i.test(emptyBox.message),
      detail: emptyBox.ok
        ? "empty_box incorrectly accepted with scanned items"
        : `rejected as expected: ${emptyBox.message}`,
    };
    report.empty_box_guard_result = emptyBoxGuardResult;
    if (!emptyBoxGuardResult.ok) blockers.push(`empty_box_guard: ${emptyBoxGuardResult.detail}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!blockers.includes(msg)) blockers.push(msg);
  } finally {
    if (packageId) {
      await rollbackFixture(admin, packageId, slipId || null, createdReturnItemIds);
      report.rollback = { package_id: packageId, slip_id: slipId, return_item_ids: createdReturnItemIds };
    }
  }

  let buildOk = false;
  let buildDetail = "skipped";
  try {
    execSync("npm run build", { stdio: "pipe", encoding: "utf8", cwd: process.cwd() });
    buildOk = true;
    buildDetail = "next build passed";
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    buildDetail = String(err.stderr ?? err.message ?? "build failed").slice(0, 2000);
    blockers.push(`build: ${buildDetail.slice(0, 200)}`);
  }
  report.build_result = { ok: buildOk, detail: buildDetail };

  const corePass =
    (report.quantity_result as StepResult).ok &&
    (report.missing_review_result as StepResult).ok &&
    report.return_items_not_created_for_missing === "yes" &&
    (report.finalize_result as StepResult).ok &&
    (report.reopen_result as StepResult).ok &&
    (report.edit_result as StepResult).ok &&
    (report.empty_box_guard_result as StepResult).ok &&
    buildOk;

  report.blockers = blockers;
  report.SAFE_TO_MERGE_NEDA_SCANNER = corePass && blockers.length === 0 ? "yes" : "no";
  report.fixture = {
    package_id: packageId || FIXTURE_PACKAGE_ID,
    package_code: packageCode,
    fnsku: scanFnsku,
    slip_id: slipId,
    fallback_fixture_package_id: FIXTURE_PACKAGE_ID,
  };

  fs.writeFileSync(path.join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(corePass && blockers.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
