/**
 * Packing slip vision — JSON shape from GPT-4o (shared by API route + tests).
 */

export type SlipVisionLine = {
  sku: string | null;
  asin: string | null;
  barcode: string | null;
  description: string | null;
  expected_qty: number;
};

export type SlipVisionExtract = {
  vret_id: string | null;
  shipment_id: string | null;
  carrier: string | null;
  amazon_order_id: string | null;
  items: SlipVisionLine[];
};

export function stripVisionJsonFence(text: string): string {
  const t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(t);
  if (fence) return fence[1].trim();
  const inline = /^```([\s\S]*?)```$/m.exec(t);
  if (inline) return inline[1].trim();
  return t;
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

/** Parse model output into a normalized slip extract. */
export function parseSlipVisionExtractFromContent(content: string): SlipVisionExtract {
  const raw = stripVisionJsonFence(content);
  const obj = JSON.parse(raw) as Record<string, unknown>;

  const vret_id = normStr(obj.vret_id ?? obj.VRET_ID ?? obj.vretId);
  const shipment_id = normStr(obj.shipment_id ?? obj.Shipment_ID ?? obj.shipmentId);
  const carrier = normStr(obj.carrier ?? obj.Carrier ?? obj.carrier_name ?? obj.carrierName);
  const amazon_order_id = normStr(
    obj.amazon_order_id ??
      obj.amazonOrderId ??
      obj.amazon_order ??
      obj.order_id ??
      obj.orderId ??
      obj.OrderID,
  );

  const itemsRaw = obj.items ?? obj.line_items ?? obj.lines;
  const itemsIn = Array.isArray(itemsRaw) ? itemsRaw : [];
  const items: SlipVisionLine[] = [];

  for (const row of itemsIn) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    items.push({
      sku: normStr(r.sku ?? r.SKU),
      asin: normStr(r.asin ?? r.ASIN),
      barcode: normStr(r.barcode ?? r.Barcode ?? r.upc ?? r.UPC ?? r.fnsku ?? r.FNSKU),
      description: normStr(r.description ?? r.title ?? r.product_name),
      expected_qty: normQty(r.expected_qty ?? r.qty ?? r.quantity ?? r.expectedQty),
    });
  }

  return { vret_id, shipment_id, carrier, amazon_order_id, items };
}
