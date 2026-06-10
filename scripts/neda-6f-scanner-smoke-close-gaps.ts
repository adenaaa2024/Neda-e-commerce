/**
 * NEDA-6F-SCANNER-SMOKE-CLOSE-GAPS — staging runtime smoke (rollback fixture).
 *   npx tsx scripts/neda-6f-scanner-smoke-close-gaps.ts --execute
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
  missingReviewEntryForSlip,
  readMissingReviewEntries,
} from "../lib/scanner/package-missing-review-manifest";
import { readPackageReceiveState } from "../lib/scanner/package-receive-state-contract";
import {
  computeSlipLineExpectedVsReceived,
  formatSlipLineQtySummary,
} from "../lib/scanner/slip-contents-missing-expected";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/neda-6f-scanner-smoke-close-gaps";
const FIXTURE_ORG_ID = "7397edff-7994-4731-8501-55d258d507d2";
const FIXTURE_STORE_ID = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";
const AUTH_USER_ID = "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";
const EXPECTED_QTY = 3;

type ClaimCounts = { claim_cases: number; claim_candidates: number };

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

async function countClaims(
  admin: ReturnType<typeof createClient>,
  orgId: string,
): Promise<ClaimCounts> {
  const [cases, candidates] = await Promise.all([
    admin
      .from("claim_cases")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId),
    admin
      .from("claim_candidates")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId),
  ]);
  return {
    claim_cases: cases.count ?? 0,
    claim_candidates: candidates.count ?? 0,
  };
}

async function countActiveReturnItems(
  admin: ReturnType<typeof createClient>,
  packageId: string,
): Promise<number> {
  const { count } = await admin
    .from(RETURN_ITEMS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("package_id", packageId)
    .is("deleted_at", null);
  return count ?? 0;
}

async function sumReceivedForSlip(
  admin: ReturnType<typeof createClient>,
  packageId: string,
  orgId: string,
  fnsku: string,
): Promise<number> {
  const { data } = await admin
    .from(RETURN_ITEMS_TABLE)
    .select("scanned_quantity, quantity, fnsku, deleted_at")
    .eq("package_id", packageId)
    .eq("organization_id", orgId)
    .is("deleted_at", null);
  let sum = 0;
  const target = fnsku.trim().toLowerCase();
  for (const row of data ?? []) {
    const r = row as { fnsku?: string | null; scanned_quantity?: number | null; quantity?: number | null };
    if (String(r.fnsku ?? "").trim().toLowerCase() !== target) continue;
    const q = Math.max(
      1,
      Math.floor(Number(r.scanned_quantity ?? r.quantity ?? 1)),
    );
    sum += q;
  }
  return sum;
}

function slipStatusLabel(
  line: ReturnType<typeof computeSlipLineExpectedVsReceived>,
  hasMissingReviewEntry: boolean,
): string {
  if (line.expected > 0 && line.received >= line.expected) return "Received";
  if (hasMissingReviewEntry && line.recordedMissing > 0) return "Marked missing";
  if (line.expected > 0) return "Pending";
  return "—";
}

async function loadSlipLineState(
  admin: ReturnType<typeof createClient>,
  packageId: string,
  orgId: string,
  slipId: string,
  fnsku: string,
): Promise<{
  slipExists: boolean;
  received: number;
  line: ReturnType<typeof computeSlipLineExpectedVsReceived>;
  summary: string;
  statusLabel: string;
  hasMissingReview: boolean;
}> {
  const { data: slip } = await admin
    .from("slip_contents")
    .select("id, quantity")
    .eq("id", slipId)
    .maybeSingle();
  const { data: pkg } = await admin
    .from("packages")
    .select("manifest_data")
    .eq("id", packageId)
    .maybeSingle();

  const expected = Math.max(0, Math.floor(Number((slip as { quantity?: number } | null)?.quantity ?? 0)));
  const received = await sumReceivedForSlip(admin, packageId, orgId, fnsku);
  const manifestRecorded = missingReviewEntryForSlip(pkg?.manifest_data, slipId)?.operator_marked_missing_qty;
  const line = computeSlipLineExpectedVsReceived({
    expectedQty: expected,
    receivedQty: received,
    manifestRecordedMissingQty: manifestRecorded,
  });
  const hasMissingReview = Boolean(missingReviewEntryForSlip(pkg?.manifest_data, slipId));
  return {
    slipExists: Boolean(slip?.id),
    received,
    line,
    summary: formatSlipLineQtySummary(line),
    statusLabel: slipStatusLabel(line, hasMissingReview),
    hasMissingReview,
  };
}

async function rollbackFixture(
  admin: ReturnType<typeof createClient>,
  packageId: string,
  slipId: string | null,
  returnItemIds: string[],
): Promise<void> {
  for (const id of returnItemIds) {
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
    audit: "NEDA-6F-SCANNER-SMOKE-CLOSE-GAPS",
    run_id: rid,
    trash_delete_tested: "no",
    trash_delete_result: "not_run",
    expected_row_preserved: "no",
    received_count_decremented_to_zero: "no",
    pending_after_delete: "no",
    claim_cases_before_after: {} as Record<string, ClaimCounts>,
    claim_candidates_before_after: {} as Record<string, ClaimCounts>,
    claims_untouched: "no",
    missing_manifest_only: "no",
    return_items_not_created_for_missing: "no",
    build_result: "not_run",
    SAFE_TO_PUSH_FOR_NEDA_PULL: "no",
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
    deleteOperatorPackageItemAction,
    markOperatorSlipMissingExpectedAction,
    patchPackageMissingReviewAction,
    finalizeOperatorPackageItemScanAction,
  } = await import("../app/scanner/operator-mobile/_components/operator-store-actions");

  const packageCode = `N6F-${rid.slice(-10)}`;
  let packageId = "";
  let slipId = "";
  let scanFnsku = "";
  const createdReturnItemIds: string[] = [];
  const claimSnapshots: Record<string, ClaimCounts> = {};

  const recordClaims = async (label: string) => {
    claimSnapshots[label] = await countClaims(admin, FIXTURE_ORG_ID);
  };

  try {
    await recordClaims("baseline");

    const opened = await insertIntakeBoxPackage(admin, {
      organizationId: FIXTURE_ORG_ID,
      palletId: null,
      packageNumber: packageCode,
      shipmentTrackingNumber: `N6F-TRACK-${rid}`,
      storeId: FIXTURE_STORE_ID,
      created_by: AUTH_USER_ID,
    });
    if (!opened.ok) throw new Error(`fixture open failed: ${opened.message}`);
    packageId = opened.packageId;

    const digits = rid.replace(/\D/g, "").slice(-7).padStart(7, "0");
    scanFnsku = `X006${digits}`;
    const { data: slipRow, error: slipErr } = await admin
      .from("slip_contents")
      .insert({
        organization_id: FIXTURE_ORG_ID,
        package_id: packageId,
        store_id: FIXTURE_STORE_ID,
        fnsku: scanFnsku,
        description: `warehouse intake line ${rid}`,
        quantity: EXPECTED_QTY,
        sort_index: 0,
        created_by: AUTH_USER_ID,
      })
      .select("id")
      .single();
    if (slipErr || !slipRow?.id) throw new Error(slipErr?.message ?? "slip insert failed");
    slipId = String(slipRow.id);

    const scan = await insertOperatorPackageItemAction({
      requestedOrganizationId: FIXTURE_ORG_ID,
      packageId,
      storeId: FIXTURE_STORE_ID,
      slipContentId: slipId,
      scannedBarcode: scanFnsku,
      matchKind: "fnsku",
      quantity: 1,
      discrepancyTags: ["sellable_ok"],
      operatorNotes: `operator-receive qty=1 ${rid}`,
    });
    if (!scan.ok) throw new Error(`scan failed: ${scan.message}`);
    createdReturnItemIds.push(scan.id);
    await recordClaims("after_scan");

    const { data: riAfterScan } = await admin
      .from(RETURN_ITEMS_TABLE)
      .select("scanned_quantity, quantity, deleted_at")
      .eq("id", scan.id)
      .maybeSingle();
    const scanUnitQty = Math.max(
      1,
      Math.floor(
        Number(
          (riAfterScan as { scanned_quantity?: number | null; quantity?: number | null } | null)
            ?.scanned_quantity ??
            (riAfterScan as { quantity?: number | null } | null)?.quantity ??
            1,
        ),
      ),
    );
    const activeAfterScan = await countActiveReturnItems(admin, packageId);
    if (scanUnitQty !== 1 || activeAfterScan !== 1) {
      blockers.push(`after_scan qty=${scanUnitQty} active_ri=${activeAfterScan} expected 1`);
    }

    report.trash_delete_tested = "yes";
    const del = await deleteOperatorPackageItemAction({
      requestedOrganizationId: FIXTURE_ORG_ID,
      returnItemId: scan.id,
      packageId,
    });

    const { data: riAfterDelete } = await admin
      .from(RETURN_ITEMS_TABLE)
      .select("deleted_at")
      .eq("id", scan.id)
      .maybeSingle();
    const activeAfterDelete = await countActiveReturnItems(admin, packageId);
    const afterDeleteState = await loadSlipLineState(admin, packageId, FIXTURE_ORG_ID, slipId, scanFnsku);

    const trashOk =
      del.ok &&
      Boolean((riAfterDelete as { deleted_at?: string | null } | null)?.deleted_at) &&
      activeAfterDelete === 0 &&
      afterDeleteState.slipExists &&
      afterDeleteState.received === 0 &&
      afterDeleteState.statusLabel === "Pending" &&
      afterDeleteState.line.recordedMissing === 0 &&
      afterDeleteState.summary.includes("Pending") &&
      !afterDeleteState.summary.includes("Missing");

    report.trash_delete_result = trashOk
      ? `pass voided=${Boolean(riAfterDelete?.deleted_at)} active_ri=${activeAfterDelete} status=${afterDeleteState.statusLabel} summary=${afterDeleteState.summary}`
      : `fail: ${del.ok ? "" : del.error} active_ri=${activeAfterDelete} received=${afterDeleteState.received} status=${afterDeleteState.statusLabel} summary=${afterDeleteState.summary}`;
    report.expected_row_preserved = afterDeleteState.slipExists ? "yes" : "no";
    report.received_count_decremented_to_zero = afterDeleteState.received === 0 ? "yes" : "no";
    report.pending_after_delete =
      afterDeleteState.statusLabel === "Pending" && afterDeleteState.line.recordedMissing === 0 ? "yes" : "no";
    if (!trashOk) blockers.push(`trash_delete: ${report.trash_delete_result}`);

    await recordClaims("after_delete");

    const beforeMissingRi = await countActiveReturnItems(admin, packageId);
    const markMissing = await markOperatorSlipMissingExpectedAction({
      requestedOrganizationId: FIXTURE_ORG_ID,
      packageId,
      storeId: FIXTURE_STORE_ID,
      slipContentId: slipId,
      missingQty: 1,
      note: `operator-missing qty=1 ${rid}`,
    });
    const afterMissingRi = await countActiveReturnItems(admin, packageId);
    const afterMissingState = await loadSlipLineState(admin, packageId, FIXTURE_ORG_ID, slipId, scanFnsku);
    const { data: pkgAfterMissing } = await admin
      .from("packages")
      .select("manifest_data")
      .eq("id", packageId)
      .maybeSingle();
    const manifestOnly =
      markMissing.ok &&
      afterMissingRi === beforeMissingRi &&
      readMissingReviewEntries(pkgAfterMissing?.manifest_data).length >= 1 &&
      Boolean(missingReviewEntryForSlip(pkgAfterMissing?.manifest_data, slipId));

    report.missing_manifest_only = manifestOnly ? "yes" : "no";
    report.return_items_not_created_for_missing = afterMissingRi === beforeMissingRi ? "yes" : "no";
    if (!manifestOnly) blockers.push(`missing_manifest: ri ${beforeMissingRi}→${afterMissingRi} mark=${markMissing.ok}`);

    await recordClaims("after_mark_missing");

    const unmark = await patchPackageMissingReviewAction({
      requestedOrganizationId: FIXTURE_ORG_ID,
      packageId,
      storeId: FIXTURE_STORE_ID,
      slipContentId: slipId,
      operatorMarkedMissingQty: 0,
    });
    const { data: pkgAfterUnmark } = await admin
      .from("packages")
      .select("manifest_data")
      .eq("id", packageId)
      .maybeSingle();
    const unmarkOk = unmark.ok && !missingReviewEntryForSlip(pkgAfterUnmark?.manifest_data, slipId);
    if (!unmarkOk) blockers.push(`unmark_missing failed: ${unmark.ok ? "entry still present" : "action failed"}`);

    await recordClaims("after_unmark_missing");

    const rescan = await insertOperatorPackageItemAction({
      requestedOrganizationId: FIXTURE_ORG_ID,
      packageId,
      storeId: FIXTURE_STORE_ID,
      slipContentId: slipId,
      scannedBarcode: scanFnsku,
      matchKind: "fnsku",
      quantity: 1,
      discrepancyTags: ["sellable_ok"],
      operatorNotes: `operator-receive rescan ${rid}`,
    });
    if (!rescan.ok) throw new Error(`rescan failed: ${rescan.message}`);
    createdReturnItemIds.push(rescan.id);
    await recordClaims("after_rescan");

    const finalize = await finalizeOperatorPackageItemScanAction({
      requestedOrganizationId: FIXTURE_ORG_ID,
      packageId,
      storeId: FIXTURE_STORE_ID,
    });
    const { data: pkgFinal } = await admin
      .from("packages")
      .select("manifest_data")
      .eq("id", packageId)
      .maybeSingle();
    const finalized = finalize.ok && readPackageReceiveState(pkgFinal?.manifest_data) === "finalized";
    if (!finalized) blockers.push(`finalize: ${finalize.ok ? "state not finalized" : finalize.message}`);
    await recordClaims("after_finalize");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!blockers.includes(msg)) blockers.push(msg);
  } finally {
    if (packageId) {
      await rollbackFixture(admin, packageId, slipId || null, createdReturnItemIds);
      report.rollback = { package_id: packageId, slip_id: slipId, return_item_ids: createdReturnItemIds };
    }
  }

  const baseline = claimSnapshots.baseline;
  const untouched =
    baseline &&
    Object.entries(claimSnapshots).every(([, c]) => {
      return c.claim_cases === baseline.claim_cases && c.claim_candidates === baseline.claim_candidates;
    });
  report.claims_untouched = untouched ? "yes" : "no";
  if (!untouched) blockers.push("claim counts changed during smoke");

  report.claim_cases_before_after = Object.fromEntries(
    Object.entries(claimSnapshots).map(([k, v]) => [k, v.claim_cases]),
  );
  report.claim_candidates_before_after = Object.fromEntries(
    Object.entries(claimSnapshots).map(([k, v]) => [k, v.claim_candidates]),
  );

  let buildOk = false;
  try {
    execSync("npm run build", { stdio: "pipe", encoding: "utf8", cwd: process.cwd() });
    buildOk = true;
    report.build_result = "PASS";
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    report.build_result = `FAIL: ${String(err.stderr ?? err.message ?? "build failed").slice(0, 500)}`;
    blockers.push("build failed");
  }

  const corePass =
    report.trash_delete_tested === "yes" &&
    report.expected_row_preserved === "yes" &&
    report.received_count_decremented_to_zero === "yes" &&
    report.pending_after_delete === "yes" &&
    report.claims_untouched === "yes" &&
    report.missing_manifest_only === "yes" &&
    report.return_items_not_created_for_missing === "yes" &&
    buildOk &&
    blockers.length === 0;

  report.blockers = blockers;
  report.SAFE_TO_PUSH_FOR_NEDA_PULL = corePass ? "yes" : "no";
  report.fixture = { package_code: packageCode, fnsku: scanFnsku, slip_id: slipId, expected_qty: EXPECTED_QTY };

  fs.writeFileSync(path.join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(corePass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
