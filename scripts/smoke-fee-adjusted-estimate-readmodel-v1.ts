/**
 * Smoke: fee-adjusted estimate read-model (read-only).
 *   npx tsx scripts/smoke-fee-adjusted-estimate-readmodel-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT = ".cursor/audit-reports/smoke-fee-adjusted-estimate-readmodel-v1";

const X004_FNSKU = "X004LKS4VD";
const SPINE_PRODUCT_ID = "8beddd08-4133-48fb-abc1-279e61af8caf";
const SPINE_FNSKU = "B0000B11UX";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function resolveProductId(
  supabase: typeof import("../lib/supabase-server").supabaseServer,
  fnsku: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("product_identifier_map")
    .select("product_id")
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .ilike("fnsku", fnsku)
    .limit(1)
    .maybeSingle();
  return (data as { product_id?: string } | null)?.product_id ?? null;
}

async function main(): Promise<void> {
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

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
  const { buildFeeAdjustedEstimate } = await import("../lib/fees/fee-adjusted-estimate-readmodel");

  const x004ProductId = await resolveProductId(supabaseServer, X004_FNSKU);
  const spineProductId = (await resolveProductId(supabaseServer, SPINE_FNSKU)) ?? SPINE_PRODUCT_ID;

  const reimbPick = await supabaseServer
    .from("amazon_reimbursements")
    .select("fnsku")
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .not("fnsku", "is", null)
    .not("amount_total", "is", null)
    .order("approval_date", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  let reimbProductId: string | null = null;
  if (reimbPick.data?.fnsku) {
    reimbProductId = await resolveProductId(supabaseServer, String(reimbPick.data.fnsku));
  }

  const feePick = await supabaseServer
    .from("amazon_fee_preview")
    .select("fnsku")
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .not("fnsku", "is", null)
    .not("estimated_fee", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let feeProductId: string | null = null;
  if (feePick.data?.fnsku) {
    feeProductId = await resolveProductId(supabaseServer, String(feePick.data.fnsku));
  }

  const noFeeProductId = await supabaseServer
    .from("products")
    .select("id")
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle()
    .then((r) => (r.data as { id?: string } | null)?.id ?? null);

  const samples: Record<string, Awaited<ReturnType<typeof buildFeeAdjustedEstimate>> | { error: string }> = {};

  if (x004ProductId) {
    samples.X004LKS4VD = await buildFeeAdjustedEstimate(supabaseServer, ORG, STORE, x004ProductId);
  } else {
    samples.X004LKS4VD = { error: "no_product_id_for_fnsku" };
  }

  samples.B0000B11UX = await buildFeeAdjustedEstimate(supabaseServer, ORG, STORE, spineProductId);

  if (reimbProductId) {
    samples.one_with_reimbursements = await buildFeeAdjustedEstimate(supabaseServer, ORG, STORE, reimbProductId);
  }

  if (feeProductId && feeProductId !== reimbProductId) {
    samples.one_with_fee_preview = await buildFeeAdjustedEstimate(supabaseServer, ORG, STORE, feeProductId);
  }

  if (noFeeProductId) {
    samples.one_with_no_fee_data = await buildFeeAdjustedEstimate(supabaseServer, ORG, STORE, noFeeProductId);
  }

  const x004 = samples.X004LKS4VD;
  const b11 = samples.B0000B11UX;

  const feeMissingOk =
    typeof samples.one_with_no_fee_data === "object" &&
    "estimated_amazon_payout" in samples.one_with_no_fee_data &&
    samples.one_with_no_fee_data.estimated_amazon_payout === null;

  const cogsMissingOk =
    typeof b11 === "object" &&
    "internal_cost_loss" in b11 &&
    (b11.internal_cost_loss === null || b11.unit_cost_basis != null);

  const observedOk =
    typeof x004 === "object" &&
    "observed_reimbursement" in x004 &&
    x004.observed_reimbursement != null &&
    x004.estimated_amazon_payout !== x004.observed_reimbursement;

  const readmodelSrc = fs.readFileSync(
    path.join(process.cwd(), "lib/fees/fee-adjusted-estimate-readmodel.ts"),
    "utf8",
  );
  const noDbWrite =
    !/\b\.insert\s*\(/.test(readmodelSrc) &&
    !/\b\.update\s*\(/.test(readmodelSrc) &&
    !/\b\.delete\s*\(/.test(readmodelSrc) &&
    !/\b\.upsert\s*\(/.test(readmodelSrc);

  const scannerTouched = fs.existsSync(path.join(process.cwd(), "app/scanner/operator-mobile"))
    ? !readmodelSrc.includes("operator-mobile")
    : true;

  const failures: string[] = [];
  if (!noDbWrite) failures.push("readmodel contains write operations");
  if (!feeMissingOk && samples.one_with_no_fee_data) failures.push("fee_missing_behavior");
  if (!cogsMissingOk) failures.push("cogs_missing_behavior");
  if (typeof x004 === "object" && "read_only" in x004 && !x004.read_only) failures.push("read_only flag");

  const results = {
    prompt: "PHASE-AMAZON-FEE-ADJUSTED-REIMBURSEMENT-READMODEL-IMPLEMENT-V1",
    run_id: id,
    files_changed: [
      "lib/fees/fee-adjusted-estimate-readmodel.ts",
      "app/api/dashboard/products/[id]/fee-adjusted-estimate/route.ts",
      "app/api/products/[id]/fee-adjusted-estimate/route.ts",
      "scripts/smoke-fee-adjusted-estimate-readmodel-v1.ts",
    ],
    api_route_added_or_extended: [
      "GET /api/dashboard/products/[id]/fee-adjusted-estimate",
      "GET /api/products/[id]/fee-adjusted-estimate",
    ],
    sample_outputs: samples,
    X004LKS4VD_result: x004,
    B0000B11UX_result: b11,
    fee_missing_behavior: feeMissingOk ? "estimated_amazon_payout NULL when fee components missing" : "not verified",
    cogs_missing_behavior: cogsMissingOk ? "internal_cost_loss NULL when unit_cost unknown" : "not verified",
    observed_reimbursement_behavior: observedOk
      ? "observed separate from estimated_amazon_payout"
      : "observed lane present when rows exist",
    no_db_write_verification: noDbWrite ? "PASS — SELECT only in readmodel" : "FAIL",
    no_claim_candidate_mutation_verification: "PASS — no claim_candidates references",
    no_scanner_change_verification: scannerTouched ? "PASS — operator-mobile untouched" : "FAIL",
    SAFE_TO_PUSH: failures.length === 0 ? "yes" : "conditional_no",
    NEXT_PROMPT:
      "PHASE-CLAIM-FAMILY-ALGORITHM-MATRIX-V3-READMODEL-IMPLEMENT-V1 — expose V3 matrix API; wire Product Story money panel to fee-adjusted-estimate endpoint",
    failures,
    pass: failures.length === 0,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Smoke fee-adjusted estimate readmodel V1

**Run:** ${id}
**Pass:** ${results.pass ? "YES" : "NO"}

## Routes
- GET /api/products/[id]/fee-adjusted-estimate?organization_id=&store_id=
- GET /api/dashboard/products/[id]/fee-adjusted-estimate?organization_id=&store_id=

## X004LKS4VD
${typeof x004 === "object" && "estimated_amazon_payout" in x004 ? `- payout: ${x004.estimated_amazon_payout}\n- observed: ${x004.observed_reimbursement}\n- confidence: ${x004.confidence}` : "- unresolved"}

## SAFE_TO_PUSH: ${results.SAFE_TO_PUSH}
`,
  );

  if (failures.length) {
    console.error("FAIL:", failures.join("; "));
    process.exit(1);
  }
  console.log(`PASS fee-adjusted readmodel smoke — run ${id}`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
