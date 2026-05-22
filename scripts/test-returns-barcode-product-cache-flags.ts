/**
 * V165 — unit checks for returns barcode product cache flag (no DB).
 */
import {
  barcodeProductCacheDisabledReason,
  isReturnsBarcodeProductCacheInsertEnabled,
} from "../lib/returns-barcode-product-cache-flags";

function eq(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const prev = process.env.ENABLE_RETURNS_BARCODE_PRODUCT_CACHE_INSERT;

delete process.env.ENABLE_RETURNS_BARCODE_PRODUCT_CACHE_INSERT;
eq(!isReturnsBarcodeProductCacheInsertEnabled(), "default off when unset");
eq(barcodeProductCacheDisabledReason() === "cache_insert_disabled", "disabled reason when off");

process.env.ENABLE_RETURNS_BARCODE_PRODUCT_CACHE_INSERT = "true";
eq(isReturnsBarcodeProductCacheInsertEnabled(), "true enables");
eq(barcodeProductCacheDisabledReason() === null, "no reason when on");

process.env.ENABLE_RETURNS_BARCODE_PRODUCT_CACHE_INSERT = "1";
eq(isReturnsBarcodeProductCacheInsertEnabled(), "1 enables");

if (prev !== undefined) process.env.ENABLE_RETURNS_BARCODE_PRODUCT_CACHE_INSERT = prev;
else delete process.env.ENABLE_RETURNS_BARCODE_PRODUCT_CACHE_INSERT;

console.log("test-returns-barcode-product-cache-flags: all checks passed");
