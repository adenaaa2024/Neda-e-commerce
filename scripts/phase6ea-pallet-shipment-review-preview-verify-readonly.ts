/**
 * PHASE-6E-A-PALLET-SHIPMENT-REVIEW-PREVIEW verify (staging, read-only).
 *   npx tsx scripts/phase6ea-pallet-shipment-review-preview-verify-readonly.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

import { buildPalletShipmentReviewPreview } from "../lib/scanner/pallet-shipment-review-preview";
import type { PalletShipmentReviewBucket } from "../lib/scanner/pallet-shipment-review-types";

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

function runUnitTests(): number {
  let n = 0;
  const bump = (fn: () => void) => {
    n += 1;
    fn();
  };

  bump(() => {
    assert.equal(
      typeof buildPalletShipmentReviewPreview,
      "function",
      "buildPalletShipmentReviewPreview export",
    );
  });

  return n;
}

async function findSampleScope(
  sb: ReturnType<typeof createClient>,
): Promise<
  | { kind: "pallet"; palletId: string; organizationId: string; storeId: string }
  | { kind: "tracking"; trackingNumber: string; organizationId: string; storeId: string }
  | null
> {
  const { data: slips } = await sb.from("slip_contents").select("package_id").limit(500);
  const pkgIds = [...new Set((slips ?? []).map((s) => s.package_id).filter(Boolean))];
  if (!pkgIds.length) return null;

  const { data: pkgs } = await sb
    .from("packages")
    .select("id, organization_id, store_id, tracking_number, pallet_id")
    .in("id", pkgIds)
    .is("deleted_at", null);

  let bestPallet: {
    pallet_id: string;
    organization_id: string;
    store_id: string;
    score: number;
  } | null = null;

  let bestTracking: {
    tracking_number: string;
    organization_id: string;
    store_id: string;
    score: number;
  } | null = null;

  for (const p of pkgs ?? []) {
    const org = String(p.organization_id ?? "").trim();
    const store = String(p.store_id ?? "").trim();
    const tn = String(p.tracking_number ?? "").trim();
    const palletId = String(p.pallet_id ?? "").trim();
    if (!org || !store) continue;

    const { count: riCount } = await sb
      .from("return_items")
      .select("id", { count: "exact", head: true })
      .eq("package_id", p.id)
      .is("deleted_at", null);
    const slipCount = (slips ?? []).filter((s) => s.package_id === p.id).length;
    let epCount = 0;
    if (tn) {
      const { count } = await sb
        .from("expected_packages")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org)
        .eq("store_id", store)
        .eq("tracking_number", tn);
      epCount = count ?? 0;
    }
    const score = slipCount * 10 + (riCount ?? 0) * 3 + epCount * 2;

    if (palletId) {
      if (!bestPallet || score > bestPallet.score) {
        bestPallet = { pallet_id: palletId, organization_id: org, store_id: store, score };
      }
    }
    if (tn) {
      if (!bestTracking || score > bestTracking.score) {
        bestTracking = { tracking_number: tn, organization_id: org, store_id: store, score };
      }
    }
  }

  if (bestPallet) {
    return {
      kind: "pallet",
      palletId: bestPallet.pallet_id,
      organizationId: bestPallet.organization_id,
      storeId: bestPallet.store_id,
    };
  }
  if (bestTracking) {
    return {
      kind: "tracking",
      trackingNumber: bestTracking.tracking_number,
      organizationId: bestTracking.organization_id,
      storeId: bestTracking.store_id,
    };
  }
  return null;
}

function pickSample(lines: { bucket: PalletShipmentReviewBucket }[], bucket: PalletShipmentReviewBucket) {
  return lines.find((l) => l.bucket === bucket) ?? null;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const unit_test_count = runUnitTests();

  const url = process.env.STAGING_SUPABASE_URL?.trim() ?? process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() ?? process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing staging Supabase env");

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const sample = await findSampleScope(sb);
  if (!sample) throw new Error("No staging pallet/tracking sample found");

  const preview =
    sample.kind === "pallet"
      ? await buildPalletShipmentReviewPreview(sb, {
          organizationId: sample.organizationId,
          storeId: sample.storeId,
          palletId: sample.palletId,
        })
      : await buildPalletShipmentReviewPreview(sb, {
          organizationId: sample.organizationId,
          storeId: sample.storeId,
          trackingNumber: sample.trackingNumber,
        });

  if ("error" in preview) throw new Error(preview.error);

  let trackingPreview: Awaited<ReturnType<typeof buildPalletShipmentReviewPreview>> | null = null;
  const trackingFallback = "TBA328247199273";
  if (sample.kind === "pallet") {
    trackingPreview = await buildPalletShipmentReviewPreview(sb, {
      organizationId: sample.organizationId,
      storeId: sample.storeId,
      trackingNumber: trackingFallback,
    });
  }

  const trackingLines =
    trackingPreview && !("error" in trackingPreview) ? trackingPreview.lines : [];

  const blockers: string[] = [];
  if (!preview.read_only) blockers.push("preview.read_only must be true");
  if (preview.phase !== "6E-A") blockers.push("preview.phase must be 6E-A");
  if (preview.lines.length === 0) blockers.push("preview has zero lines");

  let build_result = "FAIL";
  try {
    const { execSync } = await import("node:child_process");
    execSync("npm run build", { cwd: process.cwd(), stdio: "pipe" });
    build_result = "PASS";
  } catch {
    build_result = "FAIL";
    blockers.push("npm run build failed");
  }

  const report = {
    phase_number: "6E-A",
    preview_action_name: "computePalletShipmentReviewPreviewAction",
    current_tables_sufficient: "yes",
    new_tables_needed: "no",
    sample_scope:
      sample.kind === "pallet"
        ? { scope_kind: "pallet", pallet_id: sample.palletId, store_id: sample.storeId }
        : {
            scope_kind: "shipment_tracking",
            tracking_number: sample.trackingNumber,
            store_id: sample.storeId,
          },
    bucket_counts: preview.bucket_counts,
    sample_under_received:
      pickSample(preview.lines, "expected_under_received") ??
      pickSample(trackingLines, "expected_under_received"),
    sample_over_received:
      pickSample(preview.lines, "expected_over_received") ??
      pickSample(trackingLines, "expected_over_received"),
    sample_off_manifest:
      pickSample(preview.lines, "scanned_off_manifest") ??
      pickSample(trackingLines, "scanned_off_manifest"),
    sample_slip_only: pickSample(preview.lines, "slip_only_evidence"),
    sample_shipment_only:
      pickSample(preview.lines, "shipment_only_expected") ??
      (trackingPreview && !("error" in trackingPreview)
        ? pickSample(trackingPreview.lines, "shipment_only_expected")
        : null),
    tracking_fallback_preview:
      trackingPreview && !("error" in trackingPreview)
        ? {
            tracking_number: trackingFallback,
            bucket_counts: trackingPreview.bucket_counts,
            line_count: trackingPreview.lines.length,
          }
        : null,
    preview_totals: preview.totals,
    package_count: preview.package_count,
    line_count: preview.lines.length,
    first_line: preview.lines[0] ?? null,
    claim_creation: "no",
    unit_test_count,
    build_result,
    SAFE_FOR_6E_UI_PREVIEW: blockers.length === 0,
    blockers,
  };

  console.log(JSON.stringify(report, null, 2));
  if (blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
