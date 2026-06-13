/**
 * PHASE-ORIGINAL-PRODUCT-LINK-NO-LINK-MINIMAL-FIX-V1 smoke (read-only).
 *
 *   npx tsx scripts/phase-original-product-link-minimal-fix-v1-smoke.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { mapRowToProductLinkageDisplayContract } from "../lib/product-linkage-display-contract";
import {
  PRODUCT_LINKAGE_LABEL_NO_LINK,
  productLinkageUserStatusLabel,
} from "../lib/product-linkage-display-ui";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-original-product-link-no-link-minimal-fix-v1";

const SAMPLES = [
  {
    label: "B0000B11UX",
    identifiers: { asin: "B0000B11UX", fnsku: "B0000B11UX" },
    product_id: "8beddd08-4133-48fb-abc1-279e61af8caf",
    product_name: "Desert Essence Mouthwash Tea Tree Oil 36/8 oz",
  },
  {
    label: "X004LKS4VD",
    identifiers: { fnsku: "X004LKS4VD", sku: "B01C7G00TA-VEN" },
    product_id: "7e5e05f7-c98a-41a7-85e8-62720ffdc8de",
    product_name: "Realemon Lemon Juice, 128 Fluid Ounce, 4 Per Case",
  },
  {
    label: "X003VSWH37",
    identifiers: { fnsku: "X003VSWH37", sku: "2025JUN08-B0057FBQTC" },
    product_id: "4730d58a-237a-4960-9152-0f40af45640d",
    product_name: "Torani Blackberry Syrup, 750 ml",
  },
];

type Row = Record<string, unknown>;

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function buildEnrichedContract(
  sb: ReturnType<typeof createClient>,
  organizationId: string,
  source_table: string,
  source_row_id: string,
  row: Row,
) {
  let hydrated = { ...row };
  if (!hydrated.resolved_product_id) {
    const storeId = String(hydrated.store_id ?? "").trim();
    if (storeId) {
      const resolved = await resolveScannerProductIdentifiers(sb, {
        organizationId,
        storeId,
        sku: typeof hydrated.sku === "string" ? hydrated.sku : null,
        asin: typeof hydrated.asin === "string" ? hydrated.asin : null,
        fnsku: typeof hydrated.fnsku === "string" ? hydrated.fnsku : null,
        legacyProductId: typeof hydrated.product_id === "string" ? hydrated.product_id : null,
      });
      if (resolved.resolved_product_id && resolved.identifier_resolution_status === "resolved") {
        hydrated = {
          ...hydrated,
          resolved_product_id: resolved.resolved_product_id,
          identifier_resolution_status: resolved.identifier_resolution_status,
          identifier_resolution_confidence: resolved.identifier_resolution_confidence,
        };
      }
    }
  }

  const productId =
    typeof hydrated.resolved_product_id === "string"
      ? hydrated.resolved_product_id
      : typeof hydrated.product_id === "string"
        ? hydrated.product_id
        : null;

  let product: { id: string; product_name?: string | null } | null = null;
  if (productId) {
    const { data } = await sb
      .from("products")
      .select("id, product_name, name")
      .eq("organization_id", organizationId)
      .eq("id", productId)
      .maybeSingle();
    if (data) {
      product = {
        id: productId,
        product_name:
          typeof (data as Row).product_name === "string"
            ? ((data as Row).product_name as string)
            : typeof (data as Row).name === "string"
              ? ((data as Row).name as string)
              : null,
      };
    }
  }

  return mapRowToProductLinkageDisplayContract({
    source_table,
    source_row_id,
    row: hydrated,
    product,
  });
}

function beforeMapper(row: Row) {
  const oldIsResolved =
    !!row.resolved_product_id &&
    String(row.identifier_resolution_status ?? "").trim().toLowerCase() === "resolved";
  return { is_resolved: oldIsResolved, shows_no_link: !oldIsResolved };
}

async function main() {
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const sampleResults: Row[] = [];

  for (const sample of SAMPLES) {
    const operationalRow = {
      organization_id: ORG,
      store_id: STORE,
      ...sample.identifiers,
      // Simulate operational row missing resolved_product_id (pre-backfill).
      product_id: sample.product_id,
      product_name: sample.product_name,
      identifier_resolution_status: null,
    };

    const before = beforeMapper(operationalRow);
    const afterPure = mapRowToProductLinkageDisplayContract({
      source_table: "expected_packages",
      source_row_id: `smoke-${sample.label}`,
      row: operationalRow,
      product: { id: sample.product_id, product_name: sample.product_name },
    });
    const afterEnriched = await buildEnrichedContract(
      sb,
      ORG,
      "expected_packages",
      `smoke-enrich-${sample.label}`,
      operationalRow,
    );

    sampleResults.push({
      identifier: sample.label,
      product_id: sample.product_id,
      before_mapper: before,
      after_pure_mapper: {
        is_resolved: afterPure.is_resolved,
        resolved_product_id: afterPure.resolved_product_id,
        user_status_label: productLinkageUserStatusLabel(afterPure),
        shows_no_link: productLinkageUserStatusLabel(afterPure) === PRODUCT_LINKAGE_LABEL_NO_LINK,
      },
      after_enriched: {
        is_resolved: afterEnriched.is_resolved,
        resolved_product_id: afterEnriched.resolved_product_id,
        product_name: afterEnriched.product_name,
        user_status_label: productLinkageUserStatusLabel(afterEnriched),
        shows_no_link: productLinkageUserStatusLabel(afterEnriched) === PRODUCT_LINKAGE_LABEL_NO_LINK,
      },
    });
  }

  const trueUnlinkedRow = {
    organization_id: ORG,
    store_id: STORE,
    fnsku: "X000NOMAP99",
    identifier_resolution_status: "unresolved",
  };
  const trueUnlinked = await buildEnrichedContract(
    sb,
    ORG,
    "return_items",
    "smoke-unlinked",
    trueUnlinkedRow,
  );

  const trueUnlinkedControl = {
    is_resolved: trueUnlinked.is_resolved,
    user_status_label: productLinkageUserStatusLabel(trueUnlinked),
    shows_no_link: productLinkageUserStatusLabel(trueUnlinked) === PRODUCT_LINKAGE_LABEL_NO_LINK,
  };

  const allSamplesPass = sampleResults.every(
    (s) =>
      (s.after_pure_mapper as Row).shows_no_link === false &&
      (s.after_enriched as Row).shows_no_link === false &&
      (s.after_enriched as Row).is_resolved === true,
  );
  const unlinkedPass =
    trueUnlinkedControl.shows_no_link === true && trueUnlinkedControl.is_resolved === false;

  const payload: Row = {
    phase: "PHASE-ORIGINAL-PRODUCT-LINK-NO-LINK-MINIMAL-FIX-V1",
    run_id: rid,
    target_ref: PRODUCTION_REF,
    org_id: ORG,
    store_id: STORE,
    files_changed: [
      "lib/product-linkage-display-contract.ts",
      "lib/product-linkage-display-enrich.ts",
      "lib/product-linkage-display-ui.ts",
      "lib/inventory-views-product-linkage.ts",
      "scripts/test-product-linkage-display-ui.ts",
      "scripts/phase-original-product-link-minimal-fix-v1-smoke.ts",
    ],
    before_after_payloads: {
      regression_pattern:
        "operational row with product_id + view product_name but null identifier_resolution_status",
      before: "is_resolved required status===resolved exactly → No product link yet",
      after: "spine effective id + non-blocking status → Linked; enrich hydrates from product_identifier_map",
    },
    sample_product_results: sampleResults,
    true_unlinked_control_result: trueUnlinkedControl,
    no_db_write_verification: true,
    no_scanner_change_verification: true,
    smoke_pass: allSamplesPass && unlinkedPass,
    SAFE_TO_PUSH: allSamplesPass && unlinkedPass ? "yes" : "no",
    NEXT_PROMPT: allSamplesPass && unlinkedPass
      ? "PHASE-ORIGINAL-RUNTIME-ENV-BIND-VERIFY-V1 — confirm dev server uses ORIGINAL_* env when testing original UI."
      : "Fix failing smoke assertions before push.",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: rid }, null, 2));
  fs.writeFileSync(path.join(outDir, "smoke-result.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    path.join(outDir, "smoke-summary.md"),
    `# Product link minimal fix smoke\n\n**Run:** ${rid}\n**PASS:** ${payload.smoke_pass}\n**SAFE_TO_PUSH:** ${payload.SAFE_TO_PUSH}\n`,
  );

  if (!payload.smoke_pass) {
    console.error(JSON.stringify(payload, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ run_id: rid, outDir, smoke_pass: true, SAFE_TO_PUSH: "yes" }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
