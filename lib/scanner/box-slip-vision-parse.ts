/**
 * BOX packing slip — JSON shape from GPT-4o (extract-box-slip API + UI + `slip_contents`).
 * Paper column "ASIN" maps to `fnsku` (Amazon FNSKU, often starts with X).
 */

import { stripVisionJsonFence } from "@/lib/scanner/slip-extract-parse";

export type BoxSlipVisionLine = {
  upc: string | null;
  fnsku: string | null;
  description: string | null;
  expected_qty: number;
  condition: string | null;
  printed_asin?: string | null;
  /** Marked missing vs physical inventory (UI + manifest JSON). */
  missing?: boolean;
};

export type BoxSlipVisionExtract = {
  /** Printed slip / document id on paper (typically starts with S) → `packages.id_slip_contents`. */
  id_slip_contents: string | null;
  rma_number: string | null;
  /** Marketplace / removal order id if visible on the slip (not the RMA string). */
  order_id: string | null;
  items: BoxSlipVisionLine[];
};

/** API + client: structured slip could not be read (no slip id, no line-item table, or no scannable identifiers). */
export const INVALID_SLIP_FORMAT = "INVALID_SLIP_FORMAT" as const;

function lineHasProductBarcode(row: BoxSlipVisionLine): boolean {
  const upc = String(row.upc ?? "").trim();
  if (upc.replace(/\D/g, "").length >= 8) return true;
  const fn = String(row.fnsku ?? "").trim();
  if (fn.length >= 4 && /^[A-Z0-9][A-Z0-9._/-]*$/i.test(fn)) return true;
  const pa = String(row.printed_asin ?? "").trim();
  if (/^B0[0-9A-Z]{8}$/i.test(pa)) return true;
  return false;
}

/** True when slip id, a readable line-item table, and at least one line-level barcode (UPC/FNSKU/ASIN) are present. */
export function isStructuredBoxSlipExtractValid(slip: BoxSlipVisionExtract): boolean {
  const slipId = String(slip.id_slip_contents ?? "").trim();
  if (slipId.length < 2) return false;
  const items = Array.isArray(slip.items) ? slip.items : [];
  if (items.length === 0) return false;
  const hasTableRow = items.some((row) => {
    const qty = Math.max(0, Math.floor(Number(row.expected_qty ?? 0)));
    const desc = String(row.description ?? "").trim();
    const ident = Boolean(row.upc?.trim()) || Boolean(row.fnsku?.trim()) || desc.length >= 2;
    return qty > 0 && ident;
  });
  if (!hasTableRow) return false;
  const slipDocBarcode = slipId.length >= 6 && /^[A-Z0-9][A-Z0-9._-]+$/i.test(slipId);
  const anyLineBarcode = items.some((row) => lineHasProductBarcode(row));
  if (!slipDocBarcode && !anyLineBarcode) return false;
  return true;
}

function normStr(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function normQty(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** Prefer a 12-digit UPC from OCR (first contiguous 12 digits if needed). */
function normUpc(v: unknown): string | null {
  const s = String(v ?? "").trim();
  const digits = s.replace(/\D/g, "");
  if (digits.length === 12) return digits;
  const m = s.match(/\d{12}/);
  return m ? m[0] : null;
}

/** Parse model output for BOX slip vision. */
export function parseBoxSlipVisionExtractFromContent(content: string): BoxSlipVisionExtract {
  const raw = stripVisionJsonFence(content);
  let obj = JSON.parse(raw) as Record<string, unknown>;
  const nested = obj.slip;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    obj = nested as Record<string, unknown>;
  }

  /** Prefer explicit slip / barcode-under-barcode fields before generic ids (AI often labels these more reliably). */
  const slipRaw =
    obj.slip_barcode ??
    obj.slipBarcode ??
    obj.barcode_below_barcode ??
    obj.barcode_under_barcode ??
    obj.packing_slip_barcode ??
    obj.packingSlipBarcode ??
    obj.slip_barcode_human ??
    obj.slip_code ??
    obj.slip_id ??
    obj.slipId ??
    obj.SlipID ??
    obj.id_slip_contents ??
    obj.document_id ??
    obj.documentId ??
    obj.packing_slip_id ??
    obj.packingSlipId;
  let id_slip_contents = normStr(slipRaw);
  if (id_slip_contents && id_slip_contents.length > 160) {
    id_slip_contents = id_slip_contents.slice(0, 160);
  }

  const rma_number = normStr(
    obj.rma_number ??
      obj.rma ??
      obj.rma_no ??
      obj.RMA ??
      obj.ra_number ??
      obj.RA ??
      obj.return_number ??
      obj.returnNumber ??
      obj.return_id,
  );

  const order_id = normStr(
    obj.order_id ??
      obj.amazon_order_id ??
      obj.amazonOrderId ??
      obj.AmazonOrderId ??
      obj.marketplace_order_id ??
      obj.marketplaceOrderId ??
      obj.removal_order_id ??
      obj.removalOrderId ??
      obj.OrderID ??
      obj.merchant_order_id,
  );

  // If the model put the same string in both fields, keep RMA but prefer a distinct slip-only alias when present.
  const slipOnlyAlias = normStr(
    obj.slip_code_only ??
      obj.slip_document_id ??
      obj.packing_list_id ??
      obj.slip_number,
  );
  if (
    slipOnlyAlias &&
    rma_number &&
    id_slip_contents === rma_number &&
    slipOnlyAlias !== rma_number
  ) {
    id_slip_contents = slipOnlyAlias.length > 160 ? slipOnlyAlias.slice(0, 160) : slipOnlyAlias;
  }

  const itemsRaw = obj.items ?? obj.line_items ?? obj.lines;
  const itemsIn = Array.isArray(itemsRaw) ? itemsRaw : [];
  const items: BoxSlipVisionLine[] = [];

  for (const row of itemsIn) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const upc = normUpc(r.upc ?? r.UPC ?? r.upc_code ?? r.gtin ?? r.GTIN);
    const fnskuExplicit = normStr(r.fnsku ?? r.FNSKU);
    const skuOrPart = normStr(
      r.sku ??
        r.SKU ??
        r.part_number ??
        r.partNumber ??
        r.vendor_sku ??
        r.VendorSKU ??
        r.seller_sku ??
        r.SellerSKU ??
        r.merchant_sku ??
        r.item_sku,
    );
    const asinLike = normStr(r.asin ?? r.ASIN ?? r.asin_on_paper);
    const idFromPaper = fnskuExplicit ?? skuOrPart ?? asinLike;
    const explicitPrinted = normStr(r.printed_asin ?? r.printedAsin);
    const inferredAsin =
      asinLike && /^B0[0-9A-Z]{8}$/i.test(asinLike)
        ? asinLike
        : idFromPaper && /^B0[0-9A-Z]{8}$/i.test(idFromPaper)
          ? idFromPaper
          : null;
    const qty = normQty(
      r.qty ??
        r.quantity ??
        r.qty_ordered ??
        r.qtyOrdered ??
        r.amount ??
        r.count ??
        r.expected_qty ??
        r.expectedQty ??
        r.expected_quantity,
    );
    items.push({
      upc,
      fnsku: idFromPaper,
      printed_asin: explicitPrinted ?? inferredAsin,
      description: normStr(r.description ?? r.title ?? r.product_name ?? r.product ?? r.item_description),
      expected_qty: qty,
      condition: normStr(r.condition ?? r.Condition ?? r.item_condition ?? r.state),
    });
  }

  return { id_slip_contents, rma_number, order_id, items };
}
