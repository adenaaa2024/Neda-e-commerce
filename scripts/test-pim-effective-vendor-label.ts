/**
 * PRODUCT-HUB-1883-CLEANUP-WARNING — effective vendor label unit checks
 *   npx tsx scripts/test-pim-effective-vendor-label.ts
 */
import {
  isPimInvalidEffectiveVendorLabel,
  isPimInvalidVendorCategoryLabel,
  resolvePimEffectiveVendorLabel,
} from "../lib/pim-invalid-label";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const CANONICAL = "1883 Maison Routin";

assert(
  resolvePimEffectiveVendorLabel(CANONICAL, "1883") === CANONICAL,
  "effective label prefers products.vendor_name over vendors.name",
);
assert(
  !isPimInvalidEffectiveVendorLabel(CANONICAL, "1883"),
  "canonical vendor_name must not flag bare vendors.name 1883",
);
assert(isPimInvalidVendorCategoryLabel("1883"), "bare vendors.name 1883 is still invalid in isolation");
assert(
  isPimInvalidEffectiveVendorLabel(null, "1883"),
  "missing vendor_name falls back to invalid vendors.name",
);
assert(
  resolvePimEffectiveVendorLabel("", "1883") === "1883",
  "empty vendor_name falls back to vendors.name",
);
assert(
  !isPimInvalidEffectiveVendorLabel("Acme Co", "1883"),
  "valid vendor_name overrides invalid vendors.name",
);

console.log(JSON.stringify({ ok: true, checks: 7 }, null, 2));
