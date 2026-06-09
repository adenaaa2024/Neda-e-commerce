/**
 * PHASE-4F — static check that cron routes bypass session middleware.
 *   npx tsx scripts/test-cron-middleware-bypass.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mw = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");
assert.match(mw, /pathname\.startsWith\("\/api\/cron\/"\)/);
assert.match(mw, /NextResponse\.next\(\)/);

const route = readFileSync(
  join(process.cwd(), "app/api/cron/removal-nightly-sync/route.ts"),
  "utf8",
);
assert.match(route, /CRON_SECRET/);
assert.match(route, /Unauthorized.*401|status: 401/);

console.log(
  JSON.stringify({
    ok: true,
    prompt: "PHASE-4F-CRON-MIDDLEWARE-BYPASS",
    middleware_bypass: "pathname.startsWith('/api/cron/')",
    route_auth: "CRON_SECRET Bearer",
  }),
);
