"use server";

import { supabaseServer } from "@/lib/supabase-server";
import { isReturnsBarcodeProductCacheInsertEnabled } from "@/lib/returns-barcode-product-cache-flags";

export type CacheBarcodeProductResult =
  | { ok: true; cached: true }
  | { ok: true; cached: false; reason: "disabled" | "skipped" | "duplicate" | "error" };

/**
 * Optional local `products` row after Amazon mock adapter hit (returns wizard display cache).
 * Does NOT set resolved_product_id — canonical linkage remains on save via product_identifier_map.
 */
export async function cacheBarcodeProductFromAmazonLookup(input: {
  barcode: string;
  name: string;
  price?: number | null;
  image_url?: string | null;
}): Promise<CacheBarcodeProductResult> {
  if (!isReturnsBarcodeProductCacheInsertEnabled()) {
    return { ok: true, cached: false, reason: "disabled" };
  }

  const barcode = input.barcode.trim();
  const name = input.name.trim();
  if (!barcode || !name) {
    return { ok: true, cached: false, reason: "skipped" };
  }

  try {
    const { error } = await supabaseServer.from("products").insert({
      barcode,
      name,
      price: input.price ?? null,
      image_url: input.image_url ?? null,
      source: "Amazon",
    });
    if (error) {
      const msg = error.message.toLowerCase();
      if (msg.includes("duplicate") || msg.includes("unique")) {
        return { ok: true, cached: false, reason: "duplicate" };
      }
      return { ok: true, cached: false, reason: "error" };
    }
    return { ok: true, cached: true };
  } catch {
    return { ok: true, cached: false, reason: "error" };
  }
}
