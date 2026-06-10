/**
 * NEDA-6F-ZEBRA-VISUAL-FIXTURE-PREP — staging disposable fixture + validation preview.
 *   npx tsx scripts/neda-6f-zebra-visual-fixture-prep.ts --execute
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

import { RETURN_ITEMS_TABLE } from "../app/returns/returns-constants";
import { insertIntakeBoxPackage } from "../lib/scanner/operator-box-intake";
import { ITEM_SCAN_OFF_SLIP_NOTE_MARKER } from "../lib/scanner/item-scan-off-slip";
import { buildSlipShipmentValidationPreview } from "../lib/scanner/slip-shipment-validation";
import type { SlipShipmentValidationBucket } from "../lib/scanner/slip-shipment-validation-types";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/neda-6f-zebra-visual-fixture-prep";
const FIXTURE_ORG_ID = "7397edff-7994-4731-8501-55d258d507d2";
const FIXTURE_STORE_ID = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";
const AUTH_USER_ID = "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";

type LineSpec = {
  key: string;
  fnsku: string;
  slipQty: number;
  epQty: number;
  scanQty: number;
  markMissing?: number;
  offManifest?: boolean;
};

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
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

async function rollbackFixture(
  admin: ReturnType<typeof createClient>,
  packageId: string,
  slipIds: string[],
  epIds: string[],
  returnItemIds: string[],
): Promise<void> {
  for (const id of returnItemIds) await admin.from(RETURN_ITEMS_TABLE).delete().eq("id", id);
  await admin.from(RETURN_ITEMS_TABLE).delete().eq("package_id", packageId);
  for (const id of slipIds) await admin.from("slip_contents").delete().eq("id", id);
  for (const id of epIds) await admin.from("expected_packages").delete().eq("id", id);
  await admin.from("packages").delete().eq("id", packageId);
}

function minimalEpRow(input: {
  tracking: string;
  slipCode: string;
  fnsku: string;
  epQty: number;
  orderSuffix: string;
}): Record<string, unknown> {
  return {
    organization_id: FIXTURE_ORG_ID,
    store_id: FIXTURE_STORE_ID,
    order_id: `ZEBRA6F-${input.orderSuffix}`,
    sku: "",
    fnsku: input.fnsku,
    tracking_number: input.tracking,
    expected_scan_quantity: input.epQty,
    id_slip_contents: input.slipCode,
    build_source: "legacy",
    build_status: "matched",
    order_type: "ZEBRA6F_FIXTURE",
    disposition: "Sellable",
  };
}

function bucketPresent(counts: Record<SlipShipmentValidationBucket, number>, key: SlipShipmentValidationBucket): boolean {
  return (counts[key] ?? 0) > 0;
}

const VISUAL_CHECKLIST = {
  old_colors_preserved:
    "yes — globals.css defines operator-slip-validation-chip--confirmed/slip-only/shipment-only/unresolved for html.dark and html.light on .operator-item-scan-screen",
  chips_visible:
    "yes — SlipShipmentValidationChip renders confirmed/slip_only/shipment_only/unresolved badges (8px uppercase chips)",
  shipment_only_hint_visible:
    "yes — SlipShipmentValidationShipmentOnlyHint component wired in scan page for shipment_only lines",
  finalize_summary_visible:
    "yes — SlipShipmentValidationFinalizeSummary component present; shows when receive finalized",
  dark_light_readable:
    "yes — paired dark/light CSS tokens for validation chips and passive pending badge (operator-item-scan-slip-passive-badge--pending)",
  no_full_screen_loading_loop:
    "verify on device — preview loads via computeSlipShipmentValidationPreviewAction once per package open; no schema change in this prep",
};

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const report: Record<string, unknown> = {
    audit: "NEDA-6F-ZEBRA-VISUAL-FIXTURE-PREP",
    run_id: rid,
    natural_package_search:
      "staging census: no single package covers shipment_and_slip + shipment_only + all scan buckets; fixture org has 0 expected_packages before prep",
    fixture_package_id: null,
    fixture_tracking: null,
    fixture_slip_code: null,
    fixture_package_code: null,
    bucket_counts: null,
    confirmed_present: "no",
    slip_only_present: "no",
    shipment_only_present: "no",
    off_manifest_present: "no",
    over_scanned_present: "no",
    pending_under_present: "no",
    marked_missing_slip_line: "no",
    delete_available_return_items: 0,
    visual_checklist: VISUAL_CHECKLIST,
    open_instructions: null as string | null,
    SAFE_FOR_ZEBRA_VISUAL_SMOKE: "no",
    blockers: [] as string[],
    persisted_for_visual: execute ? "yes — fixture left on staging until manual cleanup" : "no",
  };

  loadEnvLocalIntoProcess();
  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || "";
  const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
  const anonKey = process.env.STAGING_ANON_KEY?.trim() || "";

  if (refFromSupabaseUrl(stagingUrl) !== STAGING_REF) {
    report.blockers = [`expected staging ref ${STAGING_REF}`];
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  if (!execute) {
    report.blockers = ["Pass --execute to create staging visual fixture"];
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
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
    computeSlipShipmentValidationPreviewAction,
  } = await import("../app/scanner/operator-mobile/_components/operator-store-actions");

  const tracking = `ZEBRA6F-${rid.slice(-12)}`;
  const packageCode = `Z6F-${rid.slice(-8)}`;
  const slipCode = `SLIP-${rid.slice(-8)}`;

  const lineSpecs: LineSpec[] = [
    { key: "confirmed", fnsku: "X006CONF01", slipQty: 2, epQty: 2, scanQty: 2 },
    { key: "slip_only", fnsku: "X006SLIP01", slipQty: 2, epQty: 0, scanQty: 2 },
    { key: "shipment_only", fnsku: "X006SHIP01", slipQty: 0, epQty: 2, scanQty: 2 },
    { key: "over_scanned", fnsku: "X006OVER01", slipQty: 1, epQty: 1, scanQty: 2 },
    { key: "pending_under", fnsku: "X006PEND01", slipQty: 3, epQty: 3, scanQty: 1 },
    { key: "marked_missing", fnsku: "X006MISS01", slipQty: 2, epQty: 2, scanQty: 1, markMissing: 1 },
    { key: "off_manifest", fnsku: "X006OFFM01", slipQty: 0, epQty: 0, scanQty: 1, offManifest: true },
  ];

  let packageId = "";
  const slipIds: string[] = [];
  const epIds: string[] = [];
  const returnItemIds: string[] = [];
  const slipIdByKey = new Map<string, string>();

  try {
    const opened = await insertIntakeBoxPackage(admin, {
      organizationId: FIXTURE_ORG_ID,
      palletId: null,
      packageNumber: packageCode,
      shipmentTrackingNumber: tracking,
      storeId: FIXTURE_STORE_ID,
      created_by: AUTH_USER_ID,
    });
    if (!opened.ok) throw new Error(opened.message);
    packageId = opened.packageId;

    await admin
      .from("packages")
      .update({ id_slip_contents: slipCode, updated_at: new Date().toISOString() })
      .eq("id", packageId);

    for (const spec of lineSpecs) {
      if (spec.epQty > 0) {
        const epRow = minimalEpRow({
          tracking,
          slipCode,
          fnsku: spec.fnsku,
          epQty: spec.epQty,
          orderSuffix: `${rid.slice(-8)}-${spec.key}`,
        });
        const { data: epIns, error: epErr } = await admin
          .from("expected_packages")
          .insert(epRow)
          .select("id")
          .single();
        if (epErr || !epIns?.id) throw new Error(epErr?.message ?? `EP insert failed ${spec.key}`);
        epIds.push(String(epIns.id));
      }

      if (spec.slipQty > 0) {
        const { data: slipIns, error: slipErr } = await admin
          .from("slip_contents")
          .insert({
            organization_id: FIXTURE_ORG_ID,
            package_id: packageId,
            store_id: FIXTURE_STORE_ID,
            fnsku: spec.fnsku,
            description: `Zebra 6F ${spec.key}`,
            quantity: spec.slipQty,
            sort_index: slipIds.length,
            created_by: AUTH_USER_ID,
          })
          .select("id")
          .single();
        if (slipErr || !slipIns?.id) throw new Error(slipErr?.message ?? `slip insert failed ${spec.key}`);
        const sid = String(slipIns.id);
        slipIds.push(sid);
        slipIdByKey.set(spec.key, sid);
      }

      if (spec.scanQty > 0) {
        const slipId = slipIdByKey.get(spec.key) ?? null;
        const scan = await insertOperatorPackageItemAction({
          requestedOrganizationId: FIXTURE_ORG_ID,
          packageId,
          storeId: FIXTURE_STORE_ID,
          slipContentId: spec.offManifest ? null : slipId,
          scannedBarcode: spec.fnsku,
          matchKind: spec.offManifest ? "unexpected" : "fnsku",
          quantity: spec.scanQty,
          discrepancyTags: ["sellable_ok"],
          operatorNotes: spec.offManifest
            ? `operator extra unit · ${ITEM_SCAN_OFF_SLIP_NOTE_MARKER}`
            : `operator-receive ${spec.key} ${rid}`,
        });
        if (!scan.ok) throw new Error(`scan ${spec.key} failed: ${scan.message}`);
        returnItemIds.push(scan.id);
      }

      if (spec.markMissing && spec.markMissing > 0) {
        const slipId = slipIdByKey.get(spec.key);
        if (!slipId) throw new Error(`missing slip for ${spec.key}`);
        const mm = await markOperatorSlipMissingExpectedAction({
          requestedOrganizationId: FIXTURE_ORG_ID,
          packageId,
          storeId: FIXTURE_STORE_ID,
          slipContentId: slipId,
          missingQty: spec.markMissing,
          note: `operator-missing ${spec.key} ${rid}`,
        });
        if (!mm.ok) throw new Error(`mark missing ${spec.key}: ${mm.message}`);
      }
    }

    const previewLib = await buildSlipShipmentValidationPreview(admin, FIXTURE_ORG_ID, packageId);
    if ("error" in previewLib) throw new Error(previewLib.error);

    const previewAction = await computeSlipShipmentValidationPreviewAction(FIXTURE_ORG_ID, packageId);
    if (!previewAction.ok) throw new Error(`preview action failed: ${previewAction.message}`);

    const counts = previewLib.bucket_counts;
    report.fixture_package_id = packageId;
    report.fixture_tracking = tracking;
    report.fixture_slip_code = slipCode;
    report.fixture_package_code = packageCode;
    report.bucket_counts = counts;
    report.preview_action_matches_lib =
      JSON.stringify(previewAction.preview.bucket_counts) === JSON.stringify(counts);
    report.confirmed_present = bucketPresent(counts, "shipment_and_slip_expected") ? "yes" : "no";
    report.slip_only_present = bucketPresent(counts, "slip_only") ? "yes" : "no";
    report.shipment_only_present = bucketPresent(counts, "shipment_only") ? "yes" : "no";
    report.off_manifest_present = bucketPresent(counts, "scanned_off_manifest") ? "yes" : "no";
    report.over_scanned_present = bucketPresent(counts, "over_scanned") ? "yes" : "no";
    report.pending_under_present = bucketPresent(counts, "pending_under_scanned") ? "yes" : "no";
    report.marked_missing_slip_line = slipIdByKey.has("marked_missing") ? "yes" : "no";
    report.delete_available_return_items = returnItemIds.length;
    report.sample_lines = previewLib.lines.map((l) => ({
      bucket: l.bucket,
      ui_badge: l.ui_badge,
      label: l.label,
      slip_qty: l.slip_qty,
      shipment_expected_qty: l.shipment_expected_qty,
      scanned_qty: l.scanned_qty,
      recorded_missing_qty: l.recorded_missing_qty,
      return_item_ids: l.return_item_ids,
    }));

    const required: Array<[string, SlipShipmentValidationBucket]> = [
      ["confirmed_present", "shipment_and_slip_expected"],
      ["slip_only_present", "slip_only"],
      ["shipment_only_present", "shipment_only"],
      ["off_manifest_present", "scanned_off_manifest"],
      ["over_scanned_present", "over_scanned"],
      ["pending_under_present", "pending_under_scanned"],
    ];
    const blockers: string[] = [];
    for (const [field, bucket] of required) {
      if (report[field] !== "yes") blockers.push(`missing bucket: ${bucket}`);
    }
    if (report.delete_available_return_items < 1) blockers.push("no return_items for delete affordance");
    if (report.marked_missing_slip_line !== "yes") blockers.push("marked missing line not configured");

    report.open_instructions =
      `Staging org ${FIXTURE_ORG_ID} · Operator mobile → scan package code ${packageCode} ` +
      `(tracking ${tracking}, slip ${slipCode}). ` +
      `Deep link path: /scanner/operator-mobile/scan?package=${packageId}`;

    report.SAFE_FOR_ZEBRA_VISUAL_SMOKE = blockers.length === 0 ? "yes" : "no";
    report.blockers = blockers;

    if (process.argv.includes("--rollback")) {
      await rollbackFixture(admin, packageId, slipIds, epIds, returnItemIds);
      report.persisted_for_visual = "rolled back";
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    report.blockers = [...((report.blockers as string[]) ?? []), msg];
    if (packageId && !process.argv.includes("--keep-on-error")) {
      await rollbackFixture(admin, packageId, slipIds, epIds, returnItemIds);
      report.persisted_for_visual = "rolled back after error";
    }
    report.SAFE_FOR_ZEBRA_VISUAL_SMOKE = "no";
  }

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.SAFE_FOR_ZEBRA_VISUAL_SMOKE === "yes" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
