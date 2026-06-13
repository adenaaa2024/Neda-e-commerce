/**
 * PHASE-AMAZON-FEE-ADJUSTED-REIMBURSEMENT-ESTIMATE-MODEL-V1
 * Read-only contract smoke + staging sample dry-runs — no DB writes, no Amazon API calls.
 *
 *   npx tsx scripts/phase-amazon-fee-adjusted-reimbursement-estimate-model-v1-readonly.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  CATEGORY_FEE_SNAPSHOT_FALLBACK_RULES,
  CONFIDENCE_RULES_FEE_ADJUSTED,
  FEE_ADJUSTED_REIMBURSEMENT_FORMULA,
  FEE_COMPONENT_PRIORITY_RULES,
  FEE_PREVIEW_FALLBACK_CONTRACT,
  INTERNAL_COST_LANE_CONTRACT,
  MISSING_FEE_FIELDS,
  MISSING_PRODUCT_FIELDS,
  NEXT_EXACT_PROMPT_FEE_ADJUSTED,
  OBSERVED_REIMBURSEMENT_LANE_CONTRACT,
  PRICE_SOURCE_PRIORITY_RULES,
  PRODUCT_FEES_API_CONTRACT,
  SAFE_TO_IMPLEMENT_FEE_ESTIMATE_READMODEL,
  SETTLEMENT_ACTUAL_FEE_FALLBACK,
  computeFeeAdjustedMoneyOutput,
  type FeeAdjustedEstimateInput,
  type FeeAdjustedMoneyOutput,
} from "../lib/fees/amazon-fee-adjusted-reimbursement-estimate-model-v1";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-fee-adjusted-reimbursement-estimate-model-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const SAMPLE_FNSKUS = {
  x004: "X004LKS4VD",
  spine: "B0000B11UX",
} as const;

const SPINE_PRODUCT_ID = "8beddd08-4133-48fb-abc1-279e61af8caf";

type SampleRow = {
  sample_key: string;
  fnsku: string | null;
  product_id: string | null;
  linkage_resolved: boolean;
  staging_row_counts: Record<string, number>;
  dry_run_input: FeeAdjustedEstimateInput;
  dry_run_output: FeeAdjustedMoneyOutput;
  missing_product_fields: string[];
  missing_fee_fields: string[];
};

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function q1<T extends Record<string, unknown>>(
  client: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  try {
    const r = await client.query(sql, params);
    return (r.rows[0] as T) ?? null;
  } catch {
    return null;
  }
}

async function resolveProductId(
  client: pg.Client,
  fnsku: string,
): Promise<string | null> {
  const row = await q1<{ product_id: string }>(
    client,
    `SELECT product_id::text FROM product_identifier_map
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND upper(fnsku)=upper($3)
     LIMIT 1`,
    [ORG, STORE, fnsku],
  );
  return row?.product_id ?? null;
}

async function buildSample(
  client: pg.Client,
  sample_key: string,
  fnsku: string | null,
  product_id: string | null,
): Promise<SampleRow> {
  const linkage_resolved = product_id != null;
  const staging_row_counts: Record<string, number> = {};
  const missing_product_fields: string[] = [];
  const missing_fee_fields: string[] = [];

  if (!linkage_resolved) missing_product_fields.push("product_id_via_identifier_map");
  if (!fnsku) missing_product_fields.push("fnsku");

  const countFor = async (table: string, where: string, params: unknown[]) => {
    const r = await q1<{ c: number }>(
      client,
      `SELECT COUNT(*)::int AS c FROM ${table} WHERE ${where}`,
      params,
    );
    staging_row_counts[table] = r?.c ?? 0;
  };

  if (fnsku) {
    await countFor(
      "amazon_reimbursements",
      "organization_id=$1::uuid AND store_id=$2::uuid AND upper(fnsku)=upper($3)",
      [ORG, STORE, fnsku],
    );
    await countFor(
      "amazon_fee_preview",
      "organization_id=$1::uuid AND store_id=$2::uuid AND upper(fnsku)=upper($3)",
      [ORG, STORE, fnsku],
    );
    await countFor(
      "amazon_monthly_storage_fees",
      "organization_id=$1::uuid AND store_id=$2::uuid AND upper(fnsku)=upper($3)",
      [ORG, STORE, fnsku],
    );
    await countFor(
      "amazon_manage_fba_inventory",
      "organization_id=$1::uuid AND store_id=$2::uuid AND upper(fnsku)=upper($3)",
      [ORG, STORE, fnsku],
    );
  }

  if (product_id) {
    const priceRow = await q1<{ amount: string; observed_at: string }>(
      client,
      `SELECT amount::text, observed_at::text FROM product_prices
       WHERE organization_id=$1::uuid AND store_id=$2::uuid AND product_id=$3::uuid
       ORDER BY observed_at DESC NULLS LAST LIMIT 1`,
      [ORG, STORE, product_id],
    );
    if (!priceRow) missing_product_fields.push("product_prices");

    const pc04 = await q1<{ c: number }>(
      client,
      `SELECT COUNT(*)::int AS c FROM product_packaging_dimensions_current WHERE product_id=$1::uuid`,
      [product_id],
    );
    if ((pc04?.c ?? 0) === 0) missing_product_fields.push("pc04_dimensions");

    const feePreview = fnsku
      ? await q1<{ price: string; estimated_fee: string; raw_data: unknown }>(
          client,
          `SELECT price::text, estimated_fee::text, raw_data FROM amazon_fee_preview
           WHERE organization_id=$1::uuid AND store_id=$2::uuid AND upper(fnsku)=upper($3)
           ORDER BY created_at DESC LIMIT 1`,
          [ORG, STORE, fnsku],
        )
      : null;

    if (!feePreview) missing_fee_fields.push("amazon_fee_preview_row");

    const reimb = fnsku
      ? await q1<{ total: string }>(
          client,
          `SELECT COALESCE(SUM(amount_total),0)::text AS total FROM amazon_reimbursements
           WHERE organization_id=$1::uuid AND store_id=$2::uuid AND upper(fnsku)=upper($3)
             AND amount_total IS NOT NULL`,
          [ORG, STORE, fnsku],
        )
      : null;

    const salePrice = feePreview?.price
      ? Number(feePreview.price)
      : priceRow?.amount
        ? Number(priceRow.amount)
        : null;

    const saleSource = feePreview?.price
      ? ("open_listings_price" as const)
      : priceRow?.amount
        ? ("product_prices_listing" as const)
        : ("unavailable" as const);

    const referralFromPreview = feePreview?.raw_data
      ? Number(
          (feePreview.raw_data as Record<string, string>)["estimated-referral-fee-per-unit"] ??
            (feePreview.raw_data as Record<string, string>)["estimated-referral-fee-per-unit".toUpperCase()] ??
            NaN,
        )
      : NaN;
    const fbaFromPreview = feePreview?.raw_data
      ? Number(
          (feePreview.raw_data as Record<string, string>)["expected-domestic-fulfilment-fee-per-unit"] ?? NaN,
        )
      : NaN;

    const dry_run_input: FeeAdjustedEstimateInput = {
      product_linkage_resolved: linkage_resolved,
      disputed_row_excluded: false,
      clean_qty: 1,
      unit_cost_basis: null,
      latest_valid_sale_price: Number.isFinite(salePrice) ? salePrice : null,
      latest_valid_sale_price_source: saleSource,
      fee_components: {
        referral_fee:
          Number.isFinite(referralFromPreview) && referralFromPreview > 0
            ? { amount: referralFromPreview, source: "fee_preview_report" }
            : undefined,
        fba_fulfillment_fee:
          Number.isFinite(fbaFromPreview) && fbaFromPreview > 0
            ? { amount: fbaFromPreview, source: "fee_preview_report" }
            : feePreview?.estimated_fee && Number(feePreview.estimated_fee) > 0
              ? { amount: Number(feePreview.estimated_fee), source: "fee_preview_report" }
              : undefined,
      },
      observed_reimbursement: reimb?.total ? Number(reimb.total) : null,
    };

    if (!dry_run_input.fee_components.referral_fee && !dry_run_input.fee_components.fba_fulfillment_fee) {
      missing_fee_fields.push("fee_component_values");
    }
    missing_fee_fields.push("product_fees_api_not_wired", "product_cost_snapshots_not_migrated");

    return {
      sample_key,
      fnsku,
      product_id,
      linkage_resolved,
      staging_row_counts,
      dry_run_input,
      dry_run_output: computeFeeAdjustedMoneyOutput(dry_run_input),
      missing_product_fields,
      missing_fee_fields,
    };
  }

  const dry_run_input: FeeAdjustedEstimateInput = {
    product_linkage_resolved: false,
    disputed_row_excluded: true,
    clean_qty: null,
    unit_cost_basis: null,
    latest_valid_sale_price: null,
    latest_valid_sale_price_source: "unavailable",
    fee_components: {},
    observed_reimbursement: null,
  };

  missing_fee_fields.push("all_fee_sources_unavailable");

  return {
    sample_key,
    fnsku,
    product_id,
    linkage_resolved,
    staging_row_counts,
    dry_run_input,
    dry_run_output: computeFeeAdjustedMoneyOutput(dry_run_input),
    missing_product_fields,
    missing_fee_fields,
  };
}

async function pickDynamicSamples(client: pg.Client): Promise<{ reimbFnsku: string | null; feeFnsku: string | null; storageFnsku: string | null }> {
  const reimb = await q1<{ fnsku: string }>(
    client,
    `SELECT fnsku FROM amazon_reimbursements
     WHERE organization_id=$1::uuid AND store_id=$2::uuid AND fnsku IS NOT NULL AND amount_total IS NOT NULL
     ORDER BY approval_date DESC NULLS LAST LIMIT 1`,
    [ORG, STORE],
  );
  const fee = await q1<{ fnsku: string }>(
    client,
    `SELECT fnsku FROM amazon_fee_preview
     WHERE organization_id=$1::uuid AND store_id=$2::uuid AND fnsku IS NOT NULL AND estimated_fee IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [ORG, STORE],
  );
  const storage = await q1<{ fnsku: string }>(
    client,
    `SELECT fnsku FROM amazon_monthly_storage_fees
     WHERE organization_id=$1::uuid AND store_id=$2::uuid AND fnsku IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [ORG, STORE],
  );
  return {
    reimbFnsku: reimb?.fnsku ?? null,
    feeFnsku: fee?.fnsku ?? null,
    storageFnsku: storage?.fnsku ?? null,
  };
}

async function main(): Promise<void> {
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const samples: SampleRow[] = [];
  let staging_census: Record<string, unknown> = {};

  if (pgUrl.includes(STAGING_REF)) {
    const client = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    staging_census = {
      amazon_fee_preview: await q1(client, `SELECT COUNT(*)::int AS rows FROM amazon_fee_preview WHERE organization_id=$1::uuid`, [ORG]),
      amazon_monthly_storage_fees: await q1(client, `SELECT COUNT(*)::int AS rows FROM amazon_monthly_storage_fees WHERE organization_id=$1::uuid`, [ORG]),
      amazon_reimbursements: await q1(client, `SELECT COUNT(*)::int AS rows FROM amazon_reimbursements WHERE organization_id=$1::uuid`, [ORG]),
      product_prices: await q1(client, `SELECT COUNT(*)::int AS rows FROM product_prices WHERE organization_id=$1::uuid`, [ORG]),
      product_cost_snapshots: await q1(client, `SELECT to_regclass('public.product_cost_snapshots') IS NOT NULL AS exists`),
    };

    const x004ProductId = await resolveProductId(client, SAMPLE_FNSKUS.x004);
    samples.push(await buildSample(client, "X004LKS4VD", SAMPLE_FNSKUS.x004, x004ProductId));

    const spineProductId = await resolveProductId(client, SAMPLE_FNSKUS.spine);
    samples.push(
      await buildSample(client, "B0000B11UX", SAMPLE_FNSKUS.spine, spineProductId ?? SPINE_PRODUCT_ID),
    );

    const dynamic = await pickDynamicSamples(client);
    if (dynamic.reimbFnsku) {
      const pid = await resolveProductId(client, dynamic.reimbFnsku);
      samples.push(await buildSample(client, "one_with_reimbursements", dynamic.reimbFnsku, pid));
    }
    if (dynamic.feeFnsku && dynamic.feeFnsku !== dynamic.reimbFnsku) {
      const pid = await resolveProductId(client, dynamic.feeFnsku);
      samples.push(await buildSample(client, "one_with_fee_preview", dynamic.feeFnsku, pid));
    }
    if (dynamic.storageFnsku) {
      const pid = await resolveProductId(client, dynamic.storageFnsku);
      samples.push(await buildSample(client, "one_with_storage_fee", dynamic.storageFnsku, pid));
    }

    await client.end();
  } else {
    samples.push({
      sample_key: "offline_contract_only",
      fnsku: null,
      product_id: null,
      linkage_resolved: false,
      staging_row_counts: {},
      dry_run_input: {
        product_linkage_resolved: false,
        disputed_row_excluded: false,
        clean_qty: null,
        unit_cost_basis: null,
        latest_valid_sale_price: null,
        latest_valid_sale_price_source: "unavailable",
        fee_components: {},
        observed_reimbursement: null,
      },
      dry_run_output: computeFeeAdjustedMoneyOutput({
        product_linkage_resolved: false,
        disputed_row_excluded: false,
        clean_qty: null,
        unit_cost_basis: null,
        latest_valid_sale_price: null,
        latest_valid_sale_price_source: "unavailable",
        fee_components: {},
        observed_reimbursement: null,
      }),
      missing_product_fields: ["staging_connection_unavailable"],
      missing_fee_fields: ["staging_connection_unavailable"],
    });
  }

  const illustrative_high_confidence = computeFeeAdjustedMoneyOutput({
    product_linkage_resolved: true,
    disputed_row_excluded: false,
    clean_qty: 2,
    unit_cost_basis: 4.5,
    latest_valid_sale_price: 19.99,
    latest_valid_sale_price_source: "transaction_sale_price",
    fee_components: {
      referral_fee: { amount: 3.0, source: "product_fees_api" },
      fba_fulfillment_fee: { amount: 4.12, source: "product_fees_api" },
    },
    observed_reimbursement: 11.5,
  });

  const results = {
    prompt: "PHASE-AMAZON-FEE-ADJUSTED-REIMBURSEMENT-ESTIMATE-MODEL-V1",
    run_id: rid,
    mode: "read_only_calculation_contract",
    fee_adjusted_reimbursement_formula: FEE_ADJUSTED_REIMBURSEMENT_FORMULA,
    fee_component_priority_rules: FEE_COMPONENT_PRIORITY_RULES,
    price_source_priority_rules: PRICE_SOURCE_PRIORITY_RULES,
    product_fees_api_contract: PRODUCT_FEES_API_CONTRACT,
    fee_preview_fallback_contract: FEE_PREVIEW_FALLBACK_CONTRACT,
    settlement_actual_fee_fallback: SETTLEMENT_ACTUAL_FEE_FALLBACK,
    category_fee_snapshot_fallback_rules: CATEGORY_FEE_SNAPSHOT_FALLBACK_RULES,
    internal_cost_lane_contract: INTERNAL_COST_LANE_CONTRACT,
    observed_reimbursement_lane_contract: OBSERVED_REIMBURSEMENT_LANE_CONTRACT,
    missing_product_fields: MISSING_PRODUCT_FIELDS,
    missing_fee_fields: MISSING_FEE_FIELDS,
    confidence_rules: CONFIDENCE_RULES_FEE_ADJUSTED,
    staging_census,
    sample_calculations: samples,
    illustrative_high_confidence_sample: illustrative_high_confidence,
    two_lane_separation: {
      lane_a_amazon_payout: "latest_valid_sale_price - estimated_total_amazon_fees = estimated_amazon_payout",
      lane_b_internal_cost: "clean_qty × unit_cost_basis = internal_cost_loss (NULL when COGS unknown)",
      lane_c_observed: "observed_reimbursement separate; gap = estimated_amazon_payout - observed",
      never: "sale price is NOT COGS; estimated payout is NOT guaranteed reimbursement",
    },
    SAFE_TO_IMPLEMENT_FEE_ESTIMATE_READMODEL,
    NEXT_EXACT_PROMPT: NEXT_EXACT_PROMPT_FEE_ADJUSTED,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PHASE-AMAZON-FEE-ADJUSTED-REIMBURSEMENT-ESTIMATE-MODEL-V1

**Run:** ${rid}
**SAFE_TO_IMPLEMENT_FEE_ESTIMATE_READMODEL:** ${SAFE_TO_IMPLEMENT_FEE_ESTIMATE_READMODEL}

## Two money lanes (Maysam)

| Lane | Field | Formula |
|------|-------|---------|
| Amazon payout estimate | \`estimated_amazon_payout\` | sale price − Amazon fees (estimate) |
| Internal cost/loss | \`internal_cost_loss\` | clean_qty × unit_cost (NULL if unknown) |
| Observed | \`observed_reimbursement\` | linked reimbursements/settlements |
| Gap | \`estimated_reimbursement_gap\` | estimated_amazon_payout − observed |

## Sample count
${samples.length} staging dry-runs + 1 illustrative high-confidence example

## NEXT_EXACT_PROMPT
${NEXT_EXACT_PROMPT_FEE_ADJUSTED}
`,
  );

  console.log(`PASS fee-adjusted estimate model — ${samples.length} samples, run ${rid}`);
  console.log(JSON.stringify({ SAFE_TO_IMPLEMENT_FEE_ESTIMATE_READMODEL, sample_keys: samples.map((s) => s.sample_key) }));
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
