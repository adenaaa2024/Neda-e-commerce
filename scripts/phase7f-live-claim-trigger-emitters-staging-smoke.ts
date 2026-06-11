/**
 * PHASE-7F staging smoke — live claim trigger emitters (disposable fixture, full rollback).
 *   npx tsx scripts/phase7f-live-claim-trigger-emitters-staging-smoke.ts --execute
 *
 * Verifies: per_problem_scan / box_close / shipment_review_close emitters, policy gating,
 * dedupe convergence, single-box + multi-box shipment scopes, pool-only writes.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { insertIntakeBoxPackage } from "../lib/scanner/operator-box-intake";
import { ITEM_SCAN_OFF_SLIP_NOTE_MARKER } from "../lib/scanner/item-scan-off-slip";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase7f-live-claim-trigger-emitters";
const ORG = "7397edff-7994-4731-8501-55d258d507d2";
const STORE = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";
const USER = "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}

async function counts(admin: SupabaseClient) {
  const cc = await admin.from("claim_candidates").select("id", { count: "exact", head: true });
  const cases = await admin.from("claim_cases").select("id", { count: "exact", head: true });
  const lines = await admin.from("claim_lines").select("id", { count: "exact", head: true });
  return { candidates: cc.count ?? -1, cases: cases.count ?? -1, lines: lines.count ?? -1 };
}

async function insertScan(
  admin: SupabaseClient,
  args: {
    packageId: string;
    fnsku: string;
    qty: number;
    conditions: string[];
    offSlip?: boolean;
  },
): Promise<string> {
  const { data, error } = await admin
    .from("return_items")
    .insert({
      organization_id: ORG,
      store_id: STORE,
      package_id: args.packageId,
      fnsku: args.fnsku,
      item_name: `Receive unit ${args.fnsku}`,
      scanned_quantity: args.qty,
      conditions: args.conditions,
      notes: args.offSlip ? `operator extra unit · ${ITEM_SCAN_OFF_SLIP_NOTE_MARKER}` : "operator receive note",
      status: "received",
      raw_return_data: { source: "operator_scan", fnsku: args.fnsku },
      created_by: USER,
    })
    .select("id")
    .single();
  if (error || !data?.id) throw new Error(error?.message ?? "scan insert failed");
  return String(data.id);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.STAGING_SUPABASE_URL?.trim() || "";
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
  if (refFromSupabaseUrl(url) !== STAGING_REF) throw new Error(`expected staging ref ${STAGING_REF}`);
  if (!process.argv.includes("--execute")) {
    console.log(JSON.stringify({ blocked: "pass --execute to run staging smoke" }));
    process.exit(1);
  }

  const admin = createClient(url, key, { auth: { persistSession: false } });
  const {
    emitPerProblemScanCandidate,
    emitBoxCloseCandidates,
    emitShipmentReviewCloseCandidates,
  } = await import("../lib/claims/intake/claim-live-trigger-emitters");

  const rid = stamp();
  const tracking = `P7F-${rid.slice(-10)}`;
  const before = await counts(admin);
  const report: Record<string, unknown> = { audit: "PHASE-7F-LIVE-EMITTERS-SMOKE", run_id: rid, before };

  const cleanup: { packages: string[]; slips: string[]; eps: string[]; items: string[] } = {
    packages: [],
    slips: [],
    eps: [],
    items: [],
  };

  try {
    // 0) Policy: per_problem_scan (most permissive trigger) on fixture org.
    const { data: orgSettings } = await admin
      .from("organization_settings")
      .select("claim_policy")
      .eq("organization_id", ORG)
      .maybeSingle();
    const priorPolicy = (orgSettings as { claim_policy?: Record<string, unknown> } | null)?.claim_policy ?? {};
    await admin
      .from("organization_settings")
      .update({
        claim_policy: {
          ...priorPolicy,
          candidate_intake: { claim_candidate_trigger: "per_problem_scan" },
        },
      })
      .eq("organization_id", ORG);

    // 1) Fixture: box A (tracking) with slip+EP lines; box B same tracking (multi-box scope).
    const mkBox = async (codeSuffix: string) => {
      const opened = await insertIntakeBoxPackage(admin, {
        organizationId: ORG,
        palletId: null,
        packageNumber: `P7F-${codeSuffix}-${rid.slice(-6)}`,
        shipmentTrackingNumber: tracking,
        storeId: STORE,
        created_by: USER,
      });
      if (!opened.ok) throw new Error(opened.message);
      cleanup.packages.push(opened.packageId);
      return opened.packageId;
    };
    const boxA = await mkBox("A");
    const boxB = await mkBox("B");

    const mkSlip = async (packageId: string, fnsku: string, qty: number) => {
      const { data, error } = await admin
        .from("slip_contents")
        .insert({
          organization_id: ORG,
          package_id: packageId,
          store_id: STORE,
          fnsku,
          description: `P7F ${fnsku}`,
          quantity: qty,
          sort_index: 0,
          created_by: USER,
        })
        .select("id")
        .single();
      if (error || !data?.id) throw new Error(error?.message ?? "slip insert failed");
      cleanup.slips.push(String(data.id));
      return String(data.id);
    };
    const mkEp = async (fnsku: string, qty: number) => {
      const { data, error } = await admin
        .from("expected_packages")
        .insert({
          organization_id: ORG,
          store_id: STORE,
          order_id: `P7F-${rid.slice(-6)}-${fnsku}`,
          sku: "",
          fnsku,
          tracking_number: tracking,
          expected_scan_quantity: qty,
          build_source: "legacy",
          build_status: "matched",
          order_type: "P7F_FIXTURE",
          disposition: "Sellable",
        })
        .select("id")
        .single();
      if (error || !data?.id) throw new Error(error?.message ?? "ep insert failed");
      cleanup.eps.push(String(data.id));
    };

    await mkSlip(boxA, "X007DMG01", 1);
    await mkEp("X007DMG01", 1);
    await mkSlip(boxA, "X007MISS1", 3);
    await mkEp("X007MISS1", 3);
    await mkSlip(boxA, "X007OVER1", 1);
    await mkEp("X007OVER1", 1);
    await mkSlip(boxB, "X007BDMG1", 1);
    await mkEp("X007BDMG1", 1);

    // Scans: damaged unit, partial (missing), over (2 of 1), off-slip unexpected; box B damaged.
    const damagedItem = await insertScan(admin, { packageId: boxA, fnsku: "X007DMG01", qty: 1, conditions: ["damaged_product"] });
    const missItem = await insertScan(admin, { packageId: boxA, fnsku: "X007MISS1", qty: 1, conditions: ["sellable_ok"] });
    const overItem = await insertScan(admin, { packageId: boxA, fnsku: "X007OVER1", qty: 2, conditions: ["sellable_ok"] });
    const offSlipItem = await insertScan(admin, { packageId: boxA, fnsku: "X007UNEXP", qty: 1, conditions: ["sellable_ok"], offSlip: true });
    const boxBItem = await insertScan(admin, { packageId: boxB, fnsku: "X007BDMG1", qty: 1, conditions: ["wrong_item"] });
    cleanup.items.push(damagedItem, missItem, overItem, offSlipItem, boxBItem);

    // 2) per_problem_scan emitter + dedupe re-run.
    const scan1 = await emitPerProblemScanCandidate(admin, { organizationId: ORG, returnItemId: damagedItem });
    const scan1Again = await emitPerProblemScanCandidate(admin, { organizationId: ORG, returnItemId: damagedItem });
    report.per_problem_scan = { first: scan1, rerun_dedupe: scan1Again };

    // 3) box_close emitter on box A (unit events + over + missing; off-slip unexpected).
    const boxClose = await emitBoxCloseCandidates(admin, { organizationId: ORG, packageId: boxA });
    report.box_close = boxClose;

    // 4) shipment_review_close — multi-box (A+B) aggregate, then verify single-box path on B-only tracking.
    const shipClose = await emitShipmentReviewCloseCandidates(admin, {
      organizationId: ORG,
      storeId: STORE,
      trackingNumber: tracking,
    });
    report.shipment_review_close_multi_box = shipClose;

    // Single-box scope: box C with its own tracking.
    const trackingC = `${tracking}-C`;
    const openedC = await insertIntakeBoxPackage(admin, {
      organizationId: ORG,
      palletId: null,
      packageNumber: `P7F-C-${rid.slice(-6)}`,
      shipmentTrackingNumber: trackingC,
      storeId: STORE,
      created_by: USER,
    });
    if (!openedC.ok) throw new Error(openedC.message);
    cleanup.packages.push(openedC.packageId);
    await mkSlip(openedC.packageId, "X007CDMG1", 1);
    const cItem = await insertScan(admin, { packageId: openedC.packageId, fnsku: "X007CDMG1", qty: 1, conditions: ["expired"] });
    cleanup.items.push(cItem);
    const shipCloseSingle = await emitShipmentReviewCloseCandidates(admin, {
      organizationId: ORG,
      storeId: STORE,
      trackingNumber: trackingC,
    });
    report.shipment_review_close_single_box = shipCloseSingle;

    // 5) Policy-disallow check: manual_only must block live emitters.
    await admin
      .from("organization_settings")
      .update({
        claim_policy: { ...priorPolicy, candidate_intake: { claim_candidate_trigger: "manual_only" } },
      })
      .eq("organization_id", ORG);
    const blocked = await emitBoxCloseCandidates(admin, { organizationId: ORG, packageId: boxA });
    report.policy_disallow_check = blocked;

    // 6) Inspect written candidates.
    const { data: written } = await admin
      .from("claim_candidates")
      .select(
        "id, source_kind, source_table, source_row_id, claim_family, dedupe_key, shipment_scope_key, package_id, pallet_id, return_item_id, expected_package_id, candidate_status, metadata",
      )
      .eq("organization_id", ORG)
      .eq("source_kind", "scanner_physical_review")
      .like("dedupe_key", `v1:scanner_physical_review:${ORG}%`)
      .order("created_at", { ascending: true });
    const rows = (written ?? []) as Array<Record<string, unknown>>;
    report.written_candidates = rows.map((r) => ({
      family: r.claim_family,
      table: r.source_table,
      status: r.candidate_status,
      shipment_scope_key: r.shipment_scope_key,
      package_id: r.package_id != null,
      return_item_id: r.return_item_id != null,
      physical_event: (r.metadata as Record<string, unknown> | null)?.physical_event,
      live_trigger: (r.metadata as Record<string, unknown> | null)?.live_trigger,
    }));
    report.written_count = rows.length;
    report.scope_key_set_on_all = rows.every((r) => r.shipment_scope_key != null || r.claim_family === "physical_return_issue");

    const after = await counts(admin);
    report.after = after;
    report.claim_cases_written = after.cases !== before.cases ? "YES — VIOLATION" : "no";
    report.claim_lines_written = after.lines !== before.lines ? "YES — VIOLATION" : "no";

    // 7) Rollback: candidates + fixture + policy restore.
    for (const r of rows) await admin.from("claim_candidates").delete().eq("id", String(r.id));
    for (const id of cleanup.items) await admin.from("return_items").delete().eq("id", id);
    for (const id of cleanup.slips) await admin.from("slip_contents").delete().eq("id", id);
    for (const id of cleanup.eps) await admin.from("expected_packages").delete().eq("id", id);
    for (const id of cleanup.packages) {
      await admin.from("return_items").delete().eq("package_id", id);
      await admin.from("packages").delete().eq("id", id);
    }
    await admin
      .from("organization_settings")
      .update({ claim_policy: priorPolicy })
      .eq("organization_id", ORG);

    const restored = await counts(admin);
    report.rolled_back = restored.candidates === before.candidates;
    report.final_counts = restored;

    const scan1Ok = (report.per_problem_scan as { first: { emitted: number } }).first.emitted === 1;
    const dedupeOk =
      (report.per_problem_scan as { rerun_dedupe: { emitted: number; updated: number } }).rerun_dedupe.emitted === 0 &&
      (report.per_problem_scan as { rerun_dedupe: { updated: number } }).rerun_dedupe.updated >= 1;
    const boxOk = (boxClose.emitted + boxClose.updated) >= 3;
    const multiOk = shipClose.boxes_in_scope === 2;
    const singleOk = shipCloseSingle.boxes_in_scope === 1 && (shipCloseSingle.emitted + shipCloseSingle.updated) >= 1;
    const blockedOk = blocked.skip_reason === "trigger_manual_only_disallows_box_close";
    const poolOnly = report.claim_cases_written === "no" && report.claim_lines_written === "no";

    report.checks = { scan1Ok, dedupeOk, boxOk, multiOk, singleOk, blockedOk, poolOnly, rolled_back: report.rolled_back };
    report.PASS = scan1Ok && dedupeOk && boxOk && multiOk && singleOk && blockedOk && poolOnly && report.rolled_back === true;
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    report.PASS = false;
  }

  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.PASS === true ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
