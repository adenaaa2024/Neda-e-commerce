/**
 * PHASE-6F-B-SLIP-SHIPMENT-VALIDATION-PREVIEW-BACKEND verify (staging, read-only).
 *   npx tsx scripts/phase6f-validation-preview-verify-readonly.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  productGrainConfidence,
  productGrainKey,
  productGrainsMatch,
  slipRowToProductGrain,
} from "../lib/scanner/product-grain-match";
import { buildSlipShipmentValidationPreview } from "../lib/scanner/slip-shipment-validation";
import type { SlipShipmentValidationBucket } from "../lib/scanner/slip-shipment-validation-types";

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
    const g = slipRowToProductGrain({
      resolved_product_id: "00000000-0000-4000-8000-000000000099",
      fnsku: "X003ZN3TJT",
      description: "Chocolate",
    });
    assert.equal(productGrainKey(g), "pid:00000000-0000-4000-8000-000000000099");
    assert.equal(productGrainConfidence(g), "resolved_product_id");
  });

  bump(() => {
    const g = slipRowToProductGrain({ fnsku: "X003ZN3TJT", description: "Chocolate" });
    assert.equal(productGrainKey(g), "fnsku:x003zn3tjt");
    assert.equal(productGrainConfidence(g), "fnsku");
  });

  bump(() => {
    const g = slipRowToProductGrain({ parsed_asin: "B012345678", parsed_sku: "SKU-1" });
    assert.equal(productGrainKey(g), "asin+sku:b012345678:sku-1");
    assert.equal(productGrainConfidence(g), "asin_sku");
  });

  bump(() => {
    const a = slipRowToProductGrain({ fnsku: "X003ZN3TJT" });
    const b = slipRowToProductGrain({ fnsku: "x003zn3tjt" });
    assert.ok(productGrainsMatch(a, b));
  });

  bump(() => {
    const g = slipRowToProductGrain({ description: "Red Vines" });
    assert.equal(productGrainConfidence(g), "title_low");
    assert.ok(productGrainKey(g)?.startsWith("title:"));
  });

  return n;
}

async function findSamplePackage(
  sb: ReturnType<typeof createClient>,
): Promise<{ packageId: string; organizationId: string } | null> {
  const { data: slips } = await sb.from("slip_contents").select("package_id").limit(500);
  const pkgIds = [...new Set((slips ?? []).map((s) => s.package_id).filter(Boolean))];
  if (!pkgIds.length) return null;

  const { data: pkgs } = await sb
    .from("packages")
    .select("id, organization_id, store_id, tracking_number")
    .in("id", pkgIds)
    .is("deleted_at", null);

  let best: { id: string; organization_id: string; score: number } | null = null;
  for (const p of pkgs ?? []) {
    const tn = String(p.tracking_number ?? "").trim();
    if (!tn) continue;
    const { count } = await sb
      .from("expected_packages")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", p.organization_id)
      .eq("store_id", p.store_id)
      .eq("tracking_number", tn);
    const { count: riCount } = await sb
      .from("return_items")
      .select("id", { count: "exact", head: true })
      .eq("package_id", p.id)
      .is("deleted_at", null);
    const slipCount = (slips ?? []).filter((s) => s.package_id === p.id).length;
    const score = slipCount * 10 + (count ?? 0) * 5 + (riCount ?? 0);
    if (!best || score > best.score) {
      best = { id: p.id, organization_id: p.organization_id, score };
    }
  }
  if (!best) return null;
  return { packageId: best.id, organizationId: best.organization_id };
}

function pickSample(
  lines: { bucket: SlipShipmentValidationBucket }[],
  bucket: SlipShipmentValidationBucket,
) {
  return lines.find((l) => l.bucket === bucket) ?? null;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const unit_test_count = runUnitTests();

  const url = process.env.STAGING_SUPABASE_URL?.trim() ?? process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() ?? process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing staging Supabase env");

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const sample = await findSamplePackage(sb);
  if (!sample) throw new Error("No staging package with slip+tracking found");

  const preview = await buildSlipShipmentValidationPreview(sb, sample.organizationId, sample.packageId);
  if ("error" in preview) throw new Error(preview.error);

  const blockers: string[] = [];
  if (!preview.read_only) blockers.push("preview.read_only must be true");
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
    preview_payload_sample: {
      package_id: preview.package_id,
      tracking_number: preview.tracking_number,
      receive_state: preview.receive_state,
      totals: preview.totals,
      line_count: preview.lines.length,
      first_line: preview.lines[0] ?? null,
    },
    bucket_counts: preview.bucket_counts,
    sample_confirmed: pickSample(preview.lines, "shipment_and_slip_expected"),
    sample_slip_only: pickSample(preview.lines, "slip_only"),
    sample_shipment_only: pickSample(preview.lines, "shipment_only"),
    sample_off_manifest: pickSample(preview.lines, "scanned_off_manifest"),
    sample_over_scanned: pickSample(preview.lines, "over_scanned"),
    sample_pending_under: pickSample(preview.lines, "pending_under_scanned"),
    unit_test_count,
    build_result,
    SAFE_FOR_NEDA_UI_WIREUP: blockers.length === 0,
    blockers,
  };

  console.log(JSON.stringify(report, null, 2));
  if (blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
