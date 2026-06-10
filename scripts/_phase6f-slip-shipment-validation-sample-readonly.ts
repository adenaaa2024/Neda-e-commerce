/**
 * PHASE-6F readonly sample — slip vs shipment expected validation census.
 * Usage: npx tsx scripts/_phase6f-slip-shipment-validation-sample-readonly.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

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

function norm(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

type GrainRow = {
  resolved_product_id: string | null;
  fnsku: string | null;
  asin: string | null;
  sku: string | null;
  upc: string | null;
  title: string | null;
};

function grainKey(r: GrainRow): string | null {
  if (r.resolved_product_id) return `pid:${r.resolved_product_id}`;
  if (r.fnsku) return `fnsku:${norm(r.fnsku)}`;
  if (r.asin && r.sku) return `asin+sku:${norm(r.asin)}:${norm(r.sku)}`;
  if (r.asin) return `asin:${norm(r.asin)}`;
  if (r.sku) return `sku:${norm(r.sku)}`;
  if (r.upc) return `upc:${norm(r.upc)}`;
  if (r.title) return `title:${norm(r.title).slice(0, 40)}`;
  return null;
}

function slipToGrain(raw: Record<string, unknown>): GrainRow {
  return {
    resolved_product_id: String(raw.resolved_product_id ?? "").trim() || null,
    fnsku: String(raw.fnsku ?? raw.parsed_fnsku ?? "").trim() || null,
    asin: String(raw.parsed_asin ?? "").trim() || null,
    sku: String(raw.parsed_sku ?? "").trim() || null,
    upc: String(raw.upc ?? raw.parsed_upc ?? "").trim() || null,
    title: String(raw.description ?? raw.ocr_product_name ?? "").trim() || null,
  };
}

function epToGrain(raw: Record<string, unknown>): GrainRow {
  return {
    resolved_product_id: String(raw.resolved_product_id ?? raw.expected_product_id ?? raw.product_id ?? "").trim() || null,
    fnsku: String(raw.fnsku ?? "").trim() || null,
    asin: String(raw.asin ?? "").trim() || null,
    sku: String(raw.sku ?? "").trim() || null,
    upc: null,
    title: String((raw.products as { product_name?: string } | null)?.product_name ?? "").trim() || null,
  };
}

function riToGrain(raw: Record<string, unknown>): GrainRow {
  return {
    resolved_product_id: String(raw.resolved_product_id ?? "").trim() || null,
    fnsku: String(raw.fnsku ?? "").trim() || null,
    asin: null,
    sku: String(raw.sku ?? "").trim() || null,
    upc: String(raw.product_identifier ?? "").trim() || null,
    title: String(raw.item_name ?? "").trim() || null,
  };
}

function offSlip(notes: unknown): boolean {
  return /not on packing slip/i.test(String(notes ?? ""));
}

async function main() {
  loadEnvLocal();
  const url = process.env.STAGING_SUPABASE_URL?.trim() ?? process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() ?? process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing staging Supabase env");

  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { data: slipAll, error: slipErr } = await sb
    .from("slip_contents")
    .select(
      "id, package_id, quantity, fnsku, upc, parsed_asin, parsed_sku, parsed_upc, parsed_fnsku, description, resolved_product_id, identifier_resolution_status, identifier_resolution_confidence",
    );
  if (slipErr) throw slipErr;
  const slips = slipAll ?? [];
  const pkgIds = [...new Set(slips.map((s) => s.package_id).filter(Boolean))];

  const { data: pkgs } = await sb
    .from("packages")
    .select("id, tracking_number, id_slip_contents, organization_id, store_id, package_code, manifest_data")
    .in("id", pkgIds.length ? pkgIds : ["00000000-0000-4000-8000-000000000000"])
    .is("deleted_at", null);

  const candidates = (pkgs ?? []).filter((p) => String(p.tracking_number ?? "").trim());

  let best: {
    package: Record<string, unknown>;
    slipLines: Record<string, unknown>[];
    epLines: Record<string, unknown>[];
    riLines: Record<string, unknown>[];
  } | null = null;

  for (const p of candidates) {
    const tn = String(p.tracking_number).trim();
    const { data: eps } = await sb
      .from("expected_packages")
      .select(
        "id, fnsku, sku, asin, expected_scan_quantity, id_slip_contents, build_source, resolved_product_id, disposition, source_detail_row_id",
      )
      .eq("organization_id", p.organization_id)
      .eq("store_id", p.store_id)
      .eq("tracking_number", tn);
    const slipLines = slips.filter((s) => s.package_id === p.id);
    const { data: ris } = await sb
      .from("return_items")
      .select("id, fnsku, sku, product_identifier, scanned_quantity, notes, resolved_product_id")
      .eq("package_id", p.id)
      .is("deleted_at", null);
    const epLines = eps ?? [];
    const riLines = ris ?? [];
    const score = slipLines.length * 10 + epLines.length * 5 + riLines.length;
    if (!best || score > best.slipLines.length * 10 + best.epLines.length * 5 + best.riLines.length) {
      best = { package: p as Record<string, unknown>, slipLines: slipLines as Record<string, unknown>[], epLines: epLines as Record<string, unknown>[], riLines: riLines as Record<string, unknown>[] };
    }
  }

  if (!best) {
    console.log(JSON.stringify({ error: "no package with slip+tracking", slip_count: slips.length }, null, 2));
    return;
  }

  const { package: pkg, slipLines, epLines, riLines } = best;

  const slipByKey = new Map<string, { slip_id: string; qty: number; grain: GrainRow; confidence: string }>();
  for (const s of slipLines) {
    const g = slipToGrain(s);
    const k = grainKey(g);
    if (!k) continue;
    slipByKey.set(k, {
      slip_id: String(s.id),
      qty: Math.max(0, Math.floor(Number(s.quantity ?? 0))),
      grain: g,
      confidence: g.resolved_product_id ? "product_id" : g.fnsku ? "fnsku" : g.upc ? "upc" : "title_low",
    });
  }

  const epByKey = new Map<string, { ep_ids: string[]; qty: number; grain: GrainRow; build_source: string | null }>();
  for (const e of epLines) {
    const g = epToGrain(e);
    const k = grainKey(g);
    if (!k) continue;
    const prev = epByKey.get(k);
    const qty = Math.max(0, Math.floor(Number(e.expected_scan_quantity ?? 0)));
    if (prev) {
      prev.qty += qty;
      prev.ep_ids.push(String(e.id));
    } else {
      epByKey.set(k, {
        ep_ids: [String(e.id)],
        qty,
        grain: g,
        build_source: String(e.build_source ?? "").trim() || null,
      });
    }
  }

  const scannedByKey = new Map<string, { qty: number; off_slip_qty: number }>();
  for (const r of riLines) {
    const g = riToGrain(r);
    const k = grainKey(g) ?? `scan:${String(r.id)}`;
    const q = Math.max(1, Math.floor(Number(r.scanned_quantity ?? 1)));
    const prev = scannedByKey.get(k) ?? { qty: 0, off_slip_qty: 0 };
    prev.qty += q;
    if (offSlip(r.notes)) prev.off_slip_qty += q;
    scannedByKey.set(k, prev);
  }

  const allKeys = new Set([...slipByKey.keys(), ...epByKey.keys(), ...scannedByKey.keys()]);
  const lines: Record<string, unknown>[] = [];

  for (const k of allKeys) {
    const slip = slipByKey.get(k);
    const ep = epByKey.get(k);
    const scan = scannedByKey.get(k);
    let bucket: string;
    if (slip && ep) bucket = "shipment_and_slip_expected";
    else if (slip && !ep) bucket = "slip_only";
    else if (!slip && ep) bucket = "shipment_only";
    else bucket = "unresolved_product_link";

    const slipQty = slip?.qty ?? 0;
    const epQty = ep?.qty ?? 0;
    const scannedQty = scan?.qty ?? 0;
    const offSlipQty = scan?.off_slip_qty ?? 0;

    if (offSlipQty > 0) bucket = bucket === "shipment_and_slip_expected" ? bucket : "scanned_off_slip";
    if (scannedQty > Math.max(slipQty, epQty) && scannedQty > 0) {
      bucket = "scanned_over_expected";
    }
    if (!slip && !ep && scan) bucket = offSlipQty > 0 ? "scanned_off_slip" : "unresolved_product_link";

    lines.push({
      grain_key: k,
      bucket,
      slip_qty: slipQty,
      shipment_expected_qty: epQty,
      scanned_qty: scannedQty,
      off_slip_scanned_qty: offSlipQty,
      sources: {
        slip: slip ? "packing_slip_ocr" : null,
        shipment: ep ? "amazon_expected" : null,
        scan: scan ? "operator_scan" : null,
        product_link_confidence: slip?.confidence ?? (ep?.grain.resolved_product_id ? "product_id" : "identifier"),
      },
      slip_content_id: slip?.slip_id ?? null,
      expected_package_ids: ep?.ep_ids ?? [],
      build_source: ep?.build_source ?? null,
    });
  }

  const summary = {
    shipment_and_slip_expected: lines.filter((l) => l.bucket === "shipment_and_slip_expected").length,
    slip_only: lines.filter((l) => l.bucket === "slip_only").length,
    shipment_only: lines.filter((l) => l.bucket === "shipment_only").length,
    scanned_off_slip: lines.filter((l) => l.bucket === "scanned_off_slip").length,
    scanned_over_expected: lines.filter((l) => l.bucket === "scanned_over_expected").length,
    unresolved_product_link: lines.filter((l) => l.bucket === "unresolved_product_link").length,
  };

  console.log(
    JSON.stringify(
      {
        phase_number: "6F",
        sample_package_id: pkg.id,
        tracking_number: pkg.tracking_number,
        id_slip_contents: pkg.id_slip_contents,
        slip_line_count: slipLines.length,
        ep_line_count: epLines.length,
        return_item_count: riLines.length,
        bucket_summary: summary,
        validation_lines: lines,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
