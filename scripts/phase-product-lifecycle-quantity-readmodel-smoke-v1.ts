/**
 * Smoke: product lifecycle quantity read-model (read-only).
 *   npx tsx scripts/phase-product-lifecycle-quantity-readmodel-smoke-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT = ".cursor/audit-reports/phase-product-lifecycle-quantity-readmodel-smoke-v1";

const SAMPLES = {
  x004: { fnsku: "X004LKS4VD", note: "resolve via identifier map" },
  spine: { product_id: "8beddd08-4133-48fb-abc1-279e61af8caf", fnsku: "B0000B11UX" },
};

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  require.cache[require.resolve("server-only")] = {
    id: "server-only",
    filename: "server-only",
    loaded: true,
    exports: {},
  } as NodeModule;

  const { supabaseServer } = await import("../lib/supabase-server");
  const { buildProductLifecycleQuantities } = await import("../lib/product-lifecycle-quantity-readmodel");

  const x004Map = await supabaseServer
    .from("product_identifier_map")
    .select("product_id")
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .ilike("fnsku", SAMPLES.x004.fnsku)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();

  const x004ProductId = (x004Map.data as { product_id?: string } | null)?.product_id ?? null;

  const reimbPick = await supabaseServer
    .from("amazon_reimbursements")
    .select("fnsku")
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .not("fnsku", "is", null)
    .limit(1)
    .maybeSingle();

  let reimbProductId: string | null = null;
  if (reimbPick.data?.fnsku) {
    const m = await supabaseServer
      .from("product_identifier_map")
      .select("product_id")
      .eq("organization_id", ORG)
      .eq("store_id", STORE)
      .ilike("fnsku", String(reimbPick.data.fnsku))
      .limit(1)
      .maybeSingle();
    reimbProductId = (m.data as { product_id?: string } | null)?.product_id ?? null;
  }

  const returnPick = await supabaseServer
    .from("amazon_returns")
    .select("fnsku")
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .not("fnsku", "is", null)
    .limit(1)
    .maybeSingle();

  let returnProductId: string | null = null;
  if (returnPick.data?.fnsku) {
    const m = await supabaseServer
      .from("product_identifier_map")
      .select("product_id")
      .eq("organization_id", ORG)
      .eq("store_id", STORE)
      .ilike("fnsku", String(returnPick.data.fnsku))
      .limit(1)
      .maybeSingle();
    returnProductId = (m.data as { product_id?: string } | null)?.product_id ?? null;
  }

  const removalPick = await supabaseServer
    .from("amazon_removals")
    .select("fnsku")
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .not("fnsku", "is", null)
    .limit(1)
    .maybeSingle();

  let removalProductId: string | null = null;
  if (removalPick.data?.fnsku) {
    const m = await supabaseServer
      .from("product_identifier_map")
      .select("product_id")
      .eq("organization_id", ORG)
      .eq("store_id", STORE)
      .ilike("fnsku", String(removalPick.data.fnsku))
      .limit(1)
      .maybeSingle();
    removalProductId = (m.data as { product_id?: string } | null)?.product_id ?? null;
  }

  const traces: Record<string, unknown> = {};

  if (x004ProductId) {
    traces.X004LKS4VD_lifecycle_trace = await buildProductLifecycleQuantities(
      supabaseServer,
      ORG,
      STORE,
      x004ProductId,
    );
  } else {
    traces.X004LKS4VD_lifecycle_trace = { error: "no_product_id_for_fnsku" };
  }

  traces.spine_B0000B11UX = await buildProductLifecycleQuantities(
    supabaseServer,
    ORG,
    STORE,
    SAMPLES.spine.product_id,
  );

  if (reimbProductId) {
    traces.reimbursement_product = await buildProductLifecycleQuantities(
      supabaseServer,
      ORG,
      STORE,
      reimbProductId,
    );
  }
  if (returnProductId) {
    traces.customer_return_product = await buildProductLifecycleQuantities(
      supabaseServer,
      ORG,
      STORE,
      returnProductId,
    );
  }
  if (removalProductId) {
    traces.removal_product = await buildProductLifecycleQuantities(
      supabaseServer,
      ORG,
      STORE,
      removalProductId,
    );
  }

  const x004 = traces.X004LKS4VD_lifecycle_trace as {
    states?: Array<{
      state_key: string;
      quantity: number | null;
      quantity_display?: string;
      disputed_quantity: number | null;
      confidence?: string;
      blocker_reason?: string | null;
    }>;
    disputed_bucket?: { quantity: number };
  };

  const removedShipped = x004?.states?.find((s) => s.state_key === "removed_shipped");
  const unreimbursed = x004?.states?.find((s) => s.state_key === "unreimbursed_gap");
  const stranded = x004?.states?.find((s) => s.state_key === "stranded");

  const checks = {
    state_count: x004?.states?.length ?? 0,
    removed_shipped_qty: removedShipped?.quantity ?? null,
    removed_shipped_disputed: removedShipped?.disputed_quantity ?? null,
    unreimbursed_display: unreimbursed?.quantity_display ?? null,
    stranded_unavailable: stranded?.confidence === "unavailable",
    safet_empty_behavior:
      unreimbursed?.confidence === "unavailable" ||
      (unreimbursed?.blocker_reason?.includes("safet") ?? false),
    read_only: (traces.spine_B0000B11UX as { read_only?: boolean }).read_only === true,
  };

  const pass =
    checks.state_count === 18 &&
    checks.read_only === true &&
    checks.stranded_unavailable === true;

  const rid = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const result = {
    smoke: pass ? "PASS" : "FAIL",
    checks,
    sample_product_ids: {
      x004: x004ProductId,
      spine: SAMPLES.spine.product_id,
      reimbursement: reimbProductId,
      customer_return: returnProductId,
      removal: removalProductId,
    },
    disputed_rows_excluded: x004?.disputed_bucket ?? null,
    traces,
  };

  fs.writeFileSync(path.join(outDir, "smoke.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ smoke: result.smoke, checks, artifact: outDir }, null, 2));
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
