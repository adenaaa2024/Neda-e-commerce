/**
 * NEXT-PLATFORM-ENTITLEMENTS-03 — Pure resolver smoke (no env, DB, or network).
 *
 *   npx tsx scripts/entitlement-resolver-smoke.ts
 */

import assert from "node:assert/strict";

import {
  assertEntitlement,
  getFeatureMeters,
  recordUsageEventNoop,
  resolveEntitlement,
  resolveUsageLimit,
} from "../lib/entitlements/resolve-entitlement";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "11111111-1111-1111-1111-111111111111";

function main(): void {
  const scopeStore = { organizationId: ORG, storeId: STORE };
  const scopeNoStore = { organizationId: ORG };

  const allowRead = resolveEntitlement("claims.inbox.read", scopeStore);
  assert.equal(allowRead.ok, true);
  assert.equal(allowRead.status, "allow");
  assert.equal(allowRead.moduleKey, "claims_inbox");

  const unknown = resolveEntitlement("not.a.real.feature", scopeStore);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, "not_cataloged");
  assert.deepEqual(unknown.reasonCodes, ["FEATURE_NOT_CATALOGED"]);

  const noStore = resolveEntitlement("claims.inbox.read", scopeNoStore);
  assert.equal(noStore.ok, false);
  assert.deepEqual(noStore.reasonCodes, ["STORE_REQUIRED"]);

  const denied = resolveEntitlement("claims.inbox.read", scopeStore, {
    staticDenyList: ["claims.inbox.read"],
  });
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.reasonCodes, ["STATICALLY_DISABLED"]);

  const meters = getFeatureMeters("claims.ai.draft");
  assert.deepEqual(meters, ["ai.token", "ai.credit"]);

  const assertSame = assertEntitlement("warehouse.locations", scopeStore);
  assert.equal(assertSame.ok, true);

  const usage = resolveUsageLimit({ organizationId: ORG, storeId: STORE }, "ai.token");
  assert.equal(usage.ok, true);
  assert.deepEqual(usage.reasonCodes, ["USAGE_NOT_ENFORCED_STATIC"]);

  const noop = recordUsageEventNoop({
    organizationId: ORG,
    storeId: STORE,
    meterKey: "ai.token",
    quantity: 1,
    idempotencyKey: "smoke-test",
  });
  assert.equal(noop.status, "skipped_static_noop");

  console.log("entitlement-resolver-smoke: OK");
}

main();
