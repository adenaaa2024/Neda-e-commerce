import { sha256CanonicalJson } from "./finances-api-idempotency";

export type FlattenedFinancialEvent = {
  event_type: string;
  amazon_event_id: string | null;
  posted_at: string | null;
  amount: number | null;
  currency: string | null;
  order_id: string | null;
  seller_order_id: string | null;
  sku: string | null;
  shipment_id: string | null;
  removal_order_id: string | null;
  reimbursement_id: string | null;
  adjustment_id: string | null;
  reference_ids: Record<string, unknown>;
  raw_fragment: Record<string, unknown>;
  payload_digest: string;
};

function readStr(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function readNullableStr(obj: Record<string, unknown>, ...keys: string[]): string | null {
  const s = readStr(obj, ...keys);
  return s || null;
}

function parsePostedAt(fragment: Record<string, unknown>): string | null {
  const s = readNullableStr(fragment, "PostedDate", "postedDate");
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function parsePrimaryAmount(fragment: Record<string, unknown>): { amount: number | null; currency: string | null } {
  const candidates = [
    fragment.Amount,
    fragment.amount,
    fragment.ChargeAmount,
    fragment.chargeAmount,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const o = c as unknown as Record<string, unknown>;
    const amountRaw = o.CurrencyAmount ?? o.currencyAmount ?? o.Amount ?? o.amount;
    const currency = readNullableStr(o as unknown as Record<string, unknown>, "CurrencyCode", "currencyCode");
    if (typeof amountRaw === "number" && !Number.isNaN(amountRaw)) {
      return { amount: amountRaw, currency };
    }
    if (typeof amountRaw === "string" && amountRaw.trim()) {
      const n = Number(amountRaw);
      if (!Number.isNaN(n)) return { amount: n, currency };
    }
  }
  return { amount: null, currency: null };
}

function collectReferenceIds(
  fragment: Record<string, unknown>,
  usedKeys: Set<string>,
): Record<string, unknown> {
  const refs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fragment)) {
    if (usedKeys.has(k)) continue;
    if (v == null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      refs[k] = v;
    }
  }
  return refs;
}

function normalizeListKey(key: string): string {
  if (key.endsWith("List")) return key.slice(0, -4);
  return key;
}

function extractAmazonEventId(fragment: Record<string, unknown>, eventType: string): string | null {
  const generic = readNullableStr(
    fragment,
    "AmazonOrderId",
    "amazonOrderId",
    "OrderId",
    "orderId",
    "ShipmentId",
    "shipmentId",
    "ReimbursementId",
    "reimbursementId",
    "AdjustmentId",
    "adjustmentId",
    "RemovalOrderId",
    "removalOrderId",
    "TransactionId",
    "transactionId",
  );
  if (generic) return `${eventType}:${generic}`;

  const digest = sha256CanonicalJson(fragment).slice(0, 32);
  return `${eventType}:${digest}`;
}

/** Flatten v0 FinancialEvents object (ShipmentEventList, etc.). */
export function flattenFinancialEventsV0(
  financialEvents: Record<string, unknown>,
): FlattenedFinancialEvent[] {
  const out: FlattenedFinancialEvent[] = [];

  for (const [key, value] of Object.entries(financialEvents)) {
    if (!key.endsWith("List") || !Array.isArray(value)) continue;
    const event_type = normalizeListKey(key);

    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const fragment = item as unknown as Record<string, unknown>;
      const { amount, currency } = parsePrimaryAmount(fragment);
      const used = new Set([
        "PostedDate",
        "postedDate",
        "AmazonOrderId",
        "amazonOrderId",
        "SellerOrderId",
        "sellerOrderId",
        "OrderId",
        "orderId",
        "SKU",
        "sku",
        "ShipmentId",
        "shipmentId",
        "RemovalOrderId",
        "removalOrderId",
        "ReimbursementId",
        "reimbursementId",
        "AdjustmentId",
        "adjustmentId",
        "Amount",
        "amount",
        "ChargeAmount",
        "chargeAmount",
      ]);

      out.push({
        event_type,
        amazon_event_id: extractAmazonEventId(fragment, event_type),
        posted_at: parsePostedAt(fragment),
        amount,
        currency,
        order_id: readNullableStr(fragment, "AmazonOrderId", "amazonOrderId", "OrderId", "orderId"),
        seller_order_id: readNullableStr(fragment, "SellerOrderId", "sellerOrderId"),
        sku: readNullableStr(fragment, "SKU", "sku"),
        shipment_id: readNullableStr(fragment, "ShipmentId", "shipmentId"),
        removal_order_id: readNullableStr(fragment, "RemovalOrderId", "removalOrderId"),
        reimbursement_id: readNullableStr(fragment, "ReimbursementId", "reimbursementId"),
        adjustment_id: readNullableStr(fragment, "AdjustmentId", "adjustmentId"),
        reference_ids: collectReferenceIds(fragment, used),
        raw_fragment: fragment,
        payload_digest: sha256CanonicalJson(fragment),
      });
    }
  }

  return out;
}

/** Extract FinancialEvents from listFinancialEventsByGroup page raw_body. */
export function extractFinancialEventsFromEventsPage(
  rawBody: Record<string, unknown>,
): Record<string, unknown> {
  const payload = (rawBody.payload ?? rawBody) as unknown as Record<string, unknown>;
  const events = payload.FinancialEvents ?? payload.financialEvents;
  if (events && typeof events === "object" && !Array.isArray(events)) {
    return events as unknown as Record<string, unknown>;
  }
  return {};
}
