/**
 * PHASE-7G staging smoke — evidence packet composer (disposable fixture, full rollback).
 *   npx tsx scripts/phase7g-evidence-packet-composer-staging-smoke.ts --execute
 *
 * Verifies: single + grouped packets, index page, event sections, warnings
 * (mixed products/problems/references, expired window, missing evidence/product),
 * photos, reference graph, ORBIT summary, grouping policy block + override.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { insertIntakeBoxPackage } from "../lib/scanner/operator-box-intake";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase7g-evidence-packet-composer";
const ORG = "7397edff-7994-4731-8501-55d258d507d2";
const STORE = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";
const USER = "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.STAGING_SUPABASE_URL?.trim() || "";
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
  if (refFromSupabaseUrl(url) !== STAGING_REF) throw new Error(`expected staging ref ${STAGING_REF}`);
  if (!process.argv.includes("--execute")) {
    console.log(JSON.stringify({ blocked: "pass --execute" }));
    process.exit(1);
  }
  const admin: SupabaseClient = createClient(url, key, { auth: { persistSession: false } });
  const { composeClaimEvidencePacket } = await import(
    "../lib/claims/evidence/claim-evidence-packet-composer"
  );
  const { renderClaimEvidencePacketHtml } = await import(
    "../lib/claims/evidence/claim-evidence-packet-html"
  );

  const rid = stamp();
  const tracking = `P7G-${rid.slice(-10)}`;
  const report: Record<string, unknown> = { audit: "PHASE-7G-EVIDENCE-PACKET-SMOKE", run_id: rid };
  const cleanup = { packages: [] as string[], items: [] as string[], candidates: [] as string[], evidence: [] as string[] };

  try {
    // Fixture: box + two scanned units (different products/problems) + photo evidence.
    const opened = await insertIntakeBoxPackage(admin, {
      organizationId: ORG,
      palletId: null,
      packageNumber: `P7G-${rid.slice(-6)}`,
      shipmentTrackingNumber: tracking,
      storeId: STORE,
      created_by: USER,
    });
    if (!opened.ok) throw new Error(opened.message);
    cleanup.packages.push(opened.packageId);

    const mkItem = async (fnsku: string, conditions: string[], withPhoto = true) => {
      const { data, error } = await admin
        .from("return_items")
        .insert({
          organization_id: ORG,
          store_id: STORE,
          package_id: opened.packageId,
          fnsku,
          item_name: `Receive unit ${fnsku}`,
          scanned_quantity: 1,
          conditions,
          notes: "operator receive note",
          status: "received",
          raw_return_data: { source: "operator_scan", fnsku },
          photo_evidence: withPhoto
            ? [{ url: `https://example.invalid/photos/${fnsku}.jpg`, note: "intake photo" }]
            : [],
          created_by: USER,
        })
        .select("id")
        .single();
      if (error || !data?.id) throw new Error(error?.message ?? "item insert failed");
      cleanup.items.push(String(data.id));
      return String(data.id);
    };
    const itemA = await mkItem("X00G7AAA01", ["damaged_product"]);
    const itemB = await mkItem("X00G7BBB01", ["wrong_item"], false);

    const mkCandidate = async (args: {
      fnsku: string;
      family: string;
      reason: string;
      returnItemId: string;
      referenceType: string;
      referenceId: string;
      physicalEvent: string;
      disputeDeadline: string | null;
      daysRemaining: number | null;
      orbitSummary?: string;
    }) => {
      const { data, error } = await admin
        .from("claim_candidates")
        .insert({
          organization_id: ORG,
          store_id: STORE,
          source_kind: "scanner_physical_review",
          source_table: "return_items",
          source_row_id: args.returnItemId,
          claim_family: args.family,
          claim_reason: args.reason,
          dedupe_key: `v1:scanner_physical_review:${ORG}:${STORE}:return_items:${args.returnItemId}:${args.family}`,
          source_event_key: args.returnItemId,
          fnsku: args.fnsku,
          expected_quantity: 1,
          actual_quantity: 1,
          delta_quantity: 0,
          reference_id: args.referenceId,
          reference_type: args.referenceType,
          dispute_deadline: args.disputeDeadline,
          days_remaining: args.daysRemaining,
          recovery_value: 12.5,
          cogs_unit: 12.5,
          currency: "USD",
          event_date: new Date().toISOString(),
          candidate_status: "detected",
          evidence_status: "missing",
          package_id: opened.packageId,
          return_item_id: args.returnItemId,
          shipment_scope_key: tracking,
          metadata: {
            intake_version: "7g-smoke",
            physical_event: args.physicalEvent,
            shipment_scope_key: tracking,
            package_id: opened.packageId,
            return_item_id: args.returnItemId,
            reference_edges: [
              { reference_kind: args.referenceType, reference_value: args.referenceId },
              { reference_kind: "package_id", reference_value: opened.packageId },
            ],
            ...(args.orbitSummary ? { evidence_summary: args.orbitSummary } : {}),
          },
        })
        .select("id")
        .single();
      if (error || !data?.id) throw new Error(error?.message ?? "candidate insert failed");
      cleanup.candidates.push(String(data.id));
      return String(data.id);
    };

    const candA = await mkCandidate({
      fnsku: "X00G7AAA01",
      family: "physical_return_issue",
      reason: "operator_flagged_damaged",
      returnItemId: itemA,
      referenceType: "tracking_number",
      referenceId: tracking,
      physicalEvent: "damaged",
      disputeDeadline: "2027-10-01",
      daysRemaining: 477,
      orbitSummary: "Physical return received damaged: 1 unit of X00G7AAA01. Source scanner_returns.",
    });
    // Second candidate: different product, different problem, different reference type, EXPIRED window.
    const candB = await mkCandidate({
      fnsku: "X00G7BBB01",
      family: "wrong_item_returned",
      reason: "operator_flagged_wrong_item",
      returnItemId: itemB,
      referenceType: "order_id",
      referenceId: "111-2222333-4445556",
      physicalEvent: "wrong_item",
      disputeDeadline: "2026-01-01",
      daysRemaining: -161,
    });

    // claim_evidence file for candidate A.
    const { data: ev, error: evErr } = await admin
      .from("claim_evidence")
      .insert({
        organization_id: ORG,
        claim_candidate_id: candA,
        return_item_id: itemA,
        package_id: opened.packageId,
        evidence_kind: "photo",
        capture_source: "scanner",
        public_url: "https://example.invalid/evidence/candA.jpg",
        storage_path: `evidence/${candA}.jpg`,
        mime_type: "image/jpeg",
        operator_note: "Damage close-up",
      })
      .select("id")
      .single();
    if (evErr || !ev?.id) throw new Error(evErr?.message ?? "evidence insert failed");
    cleanup.evidence.push(String(ev.id));

    // 1) Single-candidate packet.
    const single = await composeClaimEvidencePacket(admin, { organizationId: ORG, candidateIds: [candA] });
    if (!single.ok) throw new Error(`single failed: ${single.error}`);
    report.single_candidate_packet = {
      title: single.packet.title,
      lines: single.packet.index.lines.length,
      events: single.packet.events.length,
      warnings: single.packet.warnings.map((w) => w.code),
      photos: single.packet.events[0]!.photos.length,
      reference_graph: single.packet.events[0]!.reference_graph.length,
      orbit_summary: single.packet.events[0]!.orbit_evidence_summary !== null,
      timeline_entries: single.packet.events[0]!.timeline.length,
      source_snapshot: single.packet.events[0]!.source_report.snapshot !== null,
      shipment_context: single.packet.events[0]!.shipment_context,
    };

    // 2) Grouped packet without confirmation — expect warnings + requires_confirmation.
    const groupedUnconfirmed = await composeClaimEvidencePacket(admin, {
      organizationId: ORG,
      candidateIds: [candA, candB],
    });
    if (!groupedUnconfirmed.ok) throw new Error(`grouped(unconfirmed) failed: ${groupedUnconfirmed.error}`);
    report.grouped_unconfirmed = {
      warnings: groupedUnconfirmed.packet.warnings.map((w) => w.code),
      requires_confirmation: groupedUnconfirmed.packet.grouping.requires_confirmation,
    };

    // 3) Grouped packet confirmed.
    const grouped = await composeClaimEvidencePacket(admin, {
      organizationId: ORG,
      candidateIds: [candA, candB],
      confirmMixed: true,
      title: "P7G grouped smoke packet",
    });
    if (!grouped.ok) throw new Error(`grouped failed: ${grouped.error}`);
    const html = renderClaimEvidencePacketHtml(grouped.packet);
    report.grouped_candidate_packet = {
      title: grouped.packet.title,
      lines: grouped.packet.index.lines.length,
      events: grouped.packet.events.length,
      total_units: grouped.packet.index.total_units,
      total_recovery_value: grouped.packet.index.total_recovery_value,
      warnings: grouped.packet.warnings.map((w) => w.code),
      requires_confirmation: grouped.packet.grouping.requires_confirmation,
      anchors_in_html: grouped.packet.events.every(
        (e) => html.includes(`id="${e.anchor}"`) && html.includes(`href="#${e.anchor}"`),
      ),
      html_bytes: html.length,
    };

    // 4) Grouping policy block + override path.
    const { data: orgSettingsRow } = await admin
      .from("organization_settings")
      .select("claim_policy")
      .eq("organization_id", ORG)
      .maybeSingle();
    const priorPolicy = (orgSettingsRow as { claim_policy?: Record<string, unknown> } | null)?.claim_policy ?? {};
    await admin
      .from("organization_settings")
      .update({
        claim_policy: {
          ...priorPolicy,
          allow_manual_override: true,
          candidate_intake: { manual_grouping: { allow_grouped: false } },
        },
      })
      .eq("organization_id", ORG);
    const blocked = await composeClaimEvidencePacket(admin, { organizationId: ORG, candidateIds: [candA, candB] });
    const overridden = await composeClaimEvidencePacket(admin, {
      organizationId: ORG,
      candidateIds: [candA, candB],
      confirmMixed: true,
    });
    await admin.from("organization_settings").update({ claim_policy: priorPolicy }).eq("organization_id", ORG);
    report.policy_block_check = {
      blocked: !blocked.ok,
      blocked_reason: blocked.ok ? null : blocked.blocked_reason,
      override_ok: overridden.ok,
      override_used: overridden.ok ? overridden.packet.grouping.override_used : false,
    };

    // Save HTML artifact for visual check.
    const outDir = path.join(process.cwd(), OUT_BASE, rid);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "grouped-packet.html"), html);

    const s = report.single_candidate_packet as Record<string, unknown>;
    const g = report.grouped_candidate_packet as Record<string, unknown>;
    const gw = (report.grouped_unconfirmed as { warnings: string[] }).warnings;
    report.checks = {
      single_ok: s.lines === 1 && s.events === 1 && s.photos === 2 && s.orbit_summary === true && s.source_snapshot === true,
      grouped_ok: g.lines === 2 && g.events === 2 && g.anchors_in_html === true,
      warnings_ok:
        gw.includes("mixed_products") &&
        gw.includes("mixed_problem_types") &&
        gw.includes("mixed_reference_types") &&
        gw.includes("expired_claim_window") &&
        gw.includes("missing_evidence"),
      confirmation_flow_ok:
        (report.grouped_unconfirmed as { requires_confirmation: boolean }).requires_confirmation === true &&
        g.requires_confirmation === false,
      policy_block_ok:
        (report.policy_block_check as { blocked: boolean }).blocked === true &&
        (report.policy_block_check as { override_ok: boolean }).override_ok === true,
    };
    const checks = report.checks as Record<string, boolean>;
    report.PASS = Object.values(checks).every(Boolean);
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    report.PASS = false;
  } finally {
    for (const id of cleanup.evidence) await admin.from("claim_evidence").delete().eq("id", id);
    for (const id of cleanup.candidates) await admin.from("claim_candidates").delete().eq("id", id);
    for (const id of cleanup.items) await admin.from("return_items").delete().eq("id", id);
    for (const id of cleanup.packages) await admin.from("packages").delete().eq("id", id);
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
