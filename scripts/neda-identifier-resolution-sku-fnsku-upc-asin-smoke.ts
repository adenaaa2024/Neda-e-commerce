/**
 * NEDA identifier resolution smoke — FNSKU / SKU / UPC / ASIN → product_id (read-only).
 * Usage: npx tsx scripts/neda-identifier-resolution-sku-fnsku-upc-asin-smoke.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { resolveProductForScannerItem } from "../lib/scanner/resolve-product-for-scanner-item";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import { buildOperatorBarcodeResolverFields } from "../lib/scanner/operator-barcode-preview-input";
import {
  buildProductLinkageDisplayContract,
  fetchProductNamesByResolvedIds,
  productLinkageOperatorPrimaryDisplayLabel,
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
  type ProductsLookupClient,
} from "../lib/scanner/product-linkage-display-contract";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const TARGET_FNSKU = "X004JWH5NB";
const RUN_ID = `20260527T${new Date().toISOString().slice(11, 19).replace(/:/g, "")}Z`;
const OUT = join(
  process.cwd(),
  ".cursor/audit-reports/neda-identifier-resolution-sku-fnsku-upc-asin",
  RUN_ID,
);

type Probe = {
  id: string;
  pass: boolean;
  detail: string;
};

function add(probes: Probe[], id: string, pass: boolean, detail: string): void {
  probes.push({ id, pass, detail });
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  mkdirSync(OUT, { recursive: true });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const ref = refFromSupabaseUrl(url);
  const probes: Probe[] = [];

  add(probes, "staging_ref", ref === STAGING_REF, ref ?? "missing");
  if (!url || !key || ref !== STAGING_REF) {
    writeArtifacts(OUT, probes, null);
    process.exit(1);
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { data: fnskuMap } = await sb
    .from("product_identifier_map")
    .select("organization_id, store_id, fnsku, product_id, seller_sku, asin, upc_code")
    .eq("fnsku", TARGET_FNSKU)
    .is("deleted_at", null)
    .limit(5);

  const fnskuRow = (fnskuMap ?? [])[0] as {
    organization_id?: string;
    store_id?: string;
    product_id?: string;
    seller_sku?: string;
    asin?: string;
    upc_code?: string;
  } | undefined;

  const orgId = String(fnskuRow?.organization_id ?? "").trim();
  const storeId = String(fnskuRow?.store_id ?? "").trim();
  const expectedPid = String(fnskuRow?.product_id ?? "").trim();

  add(
    probes,
    "target_fnsku_in_map",
    Boolean(fnskuRow && expectedPid),
    fnskuRow ? `org=${orgId} store=${storeId} product_id=${expectedPid}` : `FNSKU ${TARGET_FNSKU} not in map`,
  );

  let scannerRes = null as Awaited<ReturnType<typeof resolveProductForScannerItem>> | null;
  let insertPathRes = null as Awaited<ReturnType<typeof resolveScannerProductIdentifiers>> | null;
  let uiLabel = PRODUCT_LINKAGE_UNMAPPED_LABEL;
  let productName: string | null = null;

  if (orgId && storeId) {
    const fields = buildOperatorBarcodeResolverFields(TARGET_FNSKU);
    add(
      probes,
      "barcode_classify_fnsku",
      fields.matchKind === "fnsku" && fields.fnsku === TARGET_FNSKU,
      JSON.stringify(fields),
    );

    scannerRes = await resolveProductForScannerItem(sb, {
      organization_id: orgId,
      store_id: storeId,
      fnsku: TARGET_FNSKU,
      sku: fields.sku,
      asin: fields.asin,
      upc: fields.upc,
    });

    insertPathRes = await resolveScannerProductIdentifiers(sb, {
      organizationId: orgId,
      storeId,
      fnsku: TARGET_FNSKU,
      sku: fields.sku,
      asin: fields.asin,
      productIdentifier: fields.upc,
    });

    add(
      probes,
      "fnsku_smoke_resolveProductForScannerItem",
      scannerRes.status === "resolved" && scannerRes.resolved_product_id === expectedPid,
      JSON.stringify({
        status: scannerRes.status,
        resolved_product_id: scannerRes.resolved_product_id,
        matched_via: scannerRes.matched_via,
      }),
    );

    add(
      probes,
      "fnsku_smoke_resolveScannerProductIdentifiers",
      insertPathRes.identifier_resolution_status === "resolved" &&
        insertPathRes.resolved_product_id === expectedPid,
      JSON.stringify(insertPathRes),
    );

    const names = await fetchProductNamesByResolvedIds(sb as unknown as ProductsLookupClient, [
      scannerRes.resolved_product_id ?? "",
    ]);
    productName = scannerRes.resolved_product_id
      ? names.get(scannerRes.resolved_product_id) ?? null
      : null;
    const linkage = buildProductLinkageDisplayContract(
      {
        fnsku: TARGET_FNSKU,
        resolved_product_id: scannerRes.resolved_product_id,
        identifier_resolution_status: scannerRes.status,
        identifier_resolution_confidence: scannerRes.confidence,
      },
      names,
    );
    uiLabel = productLinkageOperatorPrimaryDisplayLabel(linkage);
    add(
      probes,
      "ui_no_unmapped_label_when_resolved",
      uiLabel !== PRODUCT_LINKAGE_UNMAPPED_LABEL && Boolean(productName?.trim()),
      `label=${uiLabel} product_name=${productName ?? "null"}`,
    );
  }

  const samples: Array<{ kind: string; probe: Record<string, string | null> }> = [];
  if (orgId && storeId) {
    const { data: skuRow } = await sb
      .from("product_identifier_map")
      .select("seller_sku, msku, product_id")
      .eq("organization_id", orgId)
      .eq("store_id", storeId)
      .not("seller_sku", "is", null)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    const sku = String((skuRow as { seller_sku?: string })?.seller_sku ?? "").trim();
    if (sku) {
      const r = await resolveProductForScannerItem(sb, {
        organization_id: orgId,
        store_id: storeId,
        sku,
      });
      samples.push({ kind: "SKU", probe: { sku, status: r.status, product_id: r.resolved_product_id } });
    }

    const { data: asinRow } = await sb
      .from("product_identifier_map")
      .select("asin, product_id")
      .eq("organization_id", orgId)
      .eq("store_id", storeId)
      .not("asin", "is", null)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    const asin = String((asinRow as { asin?: string })?.asin ?? "").trim();
    if (asin) {
      const r = await resolveProductForScannerItem(sb, {
        organization_id: orgId,
        store_id: storeId,
        asin,
      });
      samples.push({ kind: "ASIN", probe: { asin, status: r.status, product_id: r.resolved_product_id } });
    }

    const { data: upcRows } = await sb
      .from("product_identifier_map")
      .select("upc_code, product_id")
      .eq("organization_id", orgId)
      .eq("store_id", storeId)
      .not("upc_code", "is", null)
      .is("deleted_at", null)
      .limit(20);
    const upcHit = (upcRows ?? []).find((r) => String((r as { product_id?: string }).product_id ?? "").trim());
    const upc = String((upcHit as { upc_code?: string })?.upc_code ?? "").trim();
    if (upc) {
      const r = await resolveProductForScannerItem(sb, {
        organization_id: orgId,
        store_id: storeId,
        upc,
      });
      samples.push({ kind: "UPC", probe: { upc, status: r.status, product_id: r.resolved_product_id } });
    }
  }

  const pass = probes.filter((p) => p.pass).length;
  const fail = probes.filter((p) => !p.pass).length;
  const verdict = fail === 0 ? "PASS" : "FAIL";

  writeArtifacts(OUT, probes, {
    run_id: RUN_ID,
    target_fnsku: TARGET_FNSKU,
    scannerRes,
    insertPathRes,
    uiLabel,
    productName,
    samples,
    verdict,
    pass,
    fail,
  });

  console.log(`[neda-identifier-resolution] ${verdict} ${pass}/${probes.length} → ${OUT}`);
  if (fail > 0) process.exit(1);
}

function writeArtifacts(
  out: string,
  probes: Probe[],
  extra: Record<string, unknown> | null,
): void {
  const fnskuPass = probes.find((p) => p.id === "fnsku_smoke_resolveProductForScannerItem")?.pass ?? false;
  const uiPass = probes.find((p) => p.id === "ui_no_unmapped_label_when_resolved")?.pass ?? false;

  writeFileSync(
    join(out, "manifest.json"),
    JSON.stringify(
      {
        run_id: RUN_ID,
        staging_ref: STAGING_REF,
        target_fnsku: TARGET_FNSKU,
        fnsku_smoke_pass: fnskuPass,
        ui_product_link_pass: uiPass,
        probes,
        ...extra,
      },
      null,
      2,
    ),
    "utf8",
  );

  writeFileSync(
    join(out, "resolver-path-summary.md"),
    `# Resolver path summary

| Surface | Resolver | Persist |
|---------|----------|---------|
| Slip OCR / \`slip_contents\` | \`enrichSlipContentsProductLinksAfterReplace\` → \`resolveProductForScannerItem\` | \`scanner-linkage-patch\` on \`slip_contents\` |
| Add/Scan barcode preview | \`previewOperatorItemBarcodeLinkageAction\` → \`buildOperatorBarcodeResolverFields\` + \`resolveProductForScannerItem\` | read-only preview |
| Operator item save | \`insertOperatorPackageItemAction\` → \`insertReturn\` → \`resolveScannerProductIdentifiers\` → \`resolveProductForScannerItem\` | \`return_items.resolved_product_id\` + status columns on insert |
| Returns wizard | \`insertReturn\` / \`updateReturn\` | same resolver delegate |
| Post-insert enrichment | \`applyReturnItemProductEnrichmentAfterInsert\` (optional patch) | \`return_items\` linkage columns |

**Priority (deterministic):** FNSKU → SKU (map seller_sku/msku, products.sku) → UPC → ASIN. Multiple product_ids at a tier → \`ambiguous\` (no auto-link).
`,
    "utf8",
  );

  writeFileSync(
    join(out, "code-change-summary.md"),
    `# Code change summary

1. \`lib/scanner/resolve-product-for-scanner-item.ts\` — full tier order FNSKU → SKU → UPC → ASIN; map + direct \`products\` fallback; ambiguous on multi-hit.
2. \`lib/scanner-product-resolve.ts\` — \`resolveScannerProductIdentifiers\` delegates to \`resolveProductForScannerItem\` (single source of truth for \`insertReturn\`).
3. \`insertOperatorPackageItemAction\` — passes classified \`fnsku\` / \`sku\` / \`asin\` / \`product_identifier\` from \`buildOperatorBarcodeResolverFields\` (fixes ASIN/UPC dropped on save).
4. \`operator-barcode-preview-input.ts\` — UPC scans no longer duplicate into \`sku\` (avoids false SKU-tier match).
`,
    "utf8",
  );

  writeFileSync(
    join(out, "smoke-result.md"),
    `# Smoke result

| Check | Result |
|-------|--------|
| FNSKU \`${TARGET_FNSKU}\` | ${fnskuPass ? "**PASS**" : "**FAIL**"} |
| UI label (no "No product link yet") | ${uiPass ? "**PASS**" : "**FAIL**"} |
| Overall | ${extra && (extra as { verdict?: string }).verdict ? (extra as { verdict: string }).verdict : "N/A"} |

${extra ? `\n\`\`\`json\n${JSON.stringify(extra, null, 2)}\n\`\`\`` : ""}
`,
    "utf8",
  );

  writeFileSync(
    join(out, "unresolved-cases.md"),
    `# Unresolved cases

- OCR/title-only lines remain **unresolved** by design (\`ocr_ignored\` in meta).
- Missing \`store_id\` → unresolved (store-scoped map + products).
- Multiple \`product_id\` values for one identifier tier → \`ambiguous\` / "Needs review".
- Unknown barcode with no map/products row → unresolved.
`,
    "utf8",
  );

  writeFileSync(
    join(out, "merge-risk.md"),
    `# Merge risk

| Risk | Level | Notes |
|------|-------|-------|
| \`resolveScannerProductIdentifiers\` behavior change | **Medium** | Now uses sequential FNSKU→SKU→UPC→ASIN instead of in-memory tier pick (ASIN before SKU in old matcher). Aligns with Neda contract. |
| Operator save identifier columns | **Low** | ASIN/UPC now persisted on \`return_items\`; improves linkage, no schema change. |
| \`package_items\` / \`v_inventory_item_status\` | **None** | Not touched. |
`,
    "utf8",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
