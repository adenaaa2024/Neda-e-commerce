/**
 * REMOVAL SHIPMENT/DETAIL → ACCEPTED/EXPECTED INTAKE FAST PLAN (read-only)
 *
 *   npx tsx scripts/removal-accepted-intake-mapping-fast-plan.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/removal-accepted-intake-mapping-fast-plan";
const PRIOR_REMOVAL_PLAN = ".cursor/audit-reports/sp-api-removal-shipment-detail-api-plan/20260528T130000Z";

const NORMALIZED_ITEM_CONTRACT = {
  schema_version: "removal_normalized_item_v1",
  grain: "one_expected_packages_row_per_detail_shipment_pair",
  quantity_field: "expected_scan_quantity",
  fields: {
    organization_id: { type: "uuid", required: true, source: "amazon_removals | amazon_removal_shipments" },
    store_id: { type: "uuid", required: true, source: "imports target store" },
    removal_order_id: {
      type: "text",
      required: true,
      source: "amazon_removals.order_id | amazon_removal_shipments.order_id",
      note: "Amazon removal order / request id",
    },
    order_type: { type: "text", required: false, source: "both tables" },
    order_date: { type: "date", required: false, source: "request/order date on both tables" },
    shipment_row_id: {
      type: "uuid",
      required: false,
      source: "amazon_removal_shipments.id",
      note: "NULL on detail_remainder rows",
    },
    detail_row_id: { type: "uuid", required: true, source: "amazon_removals.id" },
    tracking_number: { type: "text", required: false, source: "amazon_removal_shipments" },
    carrier: { type: "text", required: false, source: "amazon_removal_shipments" },
    shipment_date: { type: "date", required: false, source: "amazon_removal_shipments" },
    sku: { type: "text", required: true, source: "line sku (NOT join key alone)" },
    fnsku: { type: "text", required: false, source: "line fnsku" },
    asin: {
      type: "text",
      required: false,
      source: "amazon_removals via join OR inventory spine — not on expected_packages column",
    },
    disposition: { type: "text", required: false, source: "Sellable | Unsellable" },
    requested_quantity: { type: "integer", required: false, source: "amazon_removals" },
    shipped_quantity: { type: "integer", required: false, source: "detail shipped qty snapshot" },
    shipment_row_quantity: { type: "integer", required: false, source: "shipment line shipped qty" },
    expected_scan_quantity: {
      type: "integer",
      required: true,
      source: "rebuild: shipment_row_quantity or remainder delta",
    },
    order_status: { type: "text", required: false, source: "amazon_removals.status" },
    product_id: {
      type: "uuid",
      required: false,
      target: "expected_packages.resolved_product_id",
      note: "Required for linkage-complete; not required at INSERT time",
    },
    upload_id: { type: "uuid", required: false, source: "provenance upload" },
    source_detail_row_id: { type: "uuid", required: true, target: "expected_packages.source_detail_row_id" },
    source_shipment_row_id: {
      type: "uuid",
      required: false,
      target: "expected_packages.source_shipment_row_id",
    },
    build_source: {
      type: "enum",
      values: ["detail_shipment", "detail_remainder", "legacy"],
      required: true,
    },
    build_status: {
      type: "enum",
      values: ["matched", "awaiting_shipment_match", "shipment_overflow_conflict"],
      required: true,
    },
    intake_source_family: {
      type: "text",
      recommended: "amazon_removal",
      note: "Derive from raw_report_uploads.report_type REMOVAL_ORDER | REMOVAL_SHIPMENT",
    },
    identifier_resolution_status: { type: "text", required: false, target: "expected_packages" },
    detail_grouping_key: { type: "text", required: false, target: "expected_packages.detail_grouping_key" },
  },
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);

  const recommendedGrain =
    "One `expected_packages` row per matched (amazon_removals × amazon_removal_shipments) line pair; quantity summarized in `expected_scan_quantity` (not one DB row per unit).";

  fs.writeFileSync(
    path.join(outDir, "accepted-intake-mapping.md"),
    [
      "# Accepted / expected intake mapping (fast plan)",
      "",
      `**Run:** \`${OUT_BASE}/${runId}\``,
      "",
      "## There is no `accepted_packages` table",
      "",
      "| Layer | Table | Role |",
      "|-------|-------|------|",
      "| **Amazon expected intake** | `expected_packages` | What warehouse *should* receive per removal line/shipment split |",
      "| **Physical warehouse package** | `packages` | Operator-created carton (RMA, photos, pallet) |",
      "| **Scanned units** | `return_items` | Items scanned into a `packages` row |",
      "| **Slip OCR lines** | `slip_contents` | Manifest reconciliation fallback |",
      "",
      "**\"Accepted intake\"** in this plan = **`expected_packages`** as the canonical Amazon-side acceptance list, consumed by UI before/during physical `packages` creation.",
      "",
      "## Current `expected_packages` fields (intake target)",
      "",
      "Core identifiers: `organization_id`, `store_id`, `order_id`, `order_type`, `sku`, `fnsku`, `disposition`, `order_date`",
      "",
      "Shipment container: `tracking_number`, `carrier`, `shipment_date`",
      "",
      "Quantities: `requested_quantity`, `shipped_quantity`, `expected_scan_quantity`, `shipment_row_quantity`, `detail_shipped_quantity_total`",
      "",
      "Lineage: `upload_id`, `source_detail_row_id`, `source_shipment_row_id`, `build_source`, `build_status`, `detail_grouping_key`, `rebuild_run_at`",
      "",
      "Product linkage: `resolved_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`, `product_review_required`",
      "",
      "Warehouse scan: `actual_scanned_count` (when present)",
      "",
      "## Recommended row grain",
      "",
      recommendedGrain,
      "",
      "| build_source | Meaning |",
      "|--------------|---------|",
      "| `detail_shipment` | Detail line matched to a shipment fulfillment line |",
      "| `detail_remainder` | Detail qty not fully allocated to shipments |",
      "| `legacy` | Pre-rebuild canonical rows (do not mix SP-API path) |",
      "",
      "## Mapping from normalized removal item → `expected_packages`",
      "",
      "| Normalized field | EP column |",
      "|------------------|-----------|",
      "| detail_row_id | `source_detail_row_id` |",
      "| shipment_row_id | `source_shipment_row_id` |",
      "| removal_order_id | `order_id` |",
      "| order_type | `order_type` |",
      "| order_date | `order_date` |",
      "| sku / fnsku | `sku` / `fnsku` |",
      "| disposition | `disposition` |",
      "| tracking_number | `tracking_number` |",
      "| carrier | `carrier` |",
      "| shipment_date | `shipment_date` |",
      "| expected_scan_quantity | `expected_scan_quantity` |",
      "| product_id | `resolved_product_id` (governed backfill only) |",
      "| upload_id | `upload_id` |",
      "",
      "**source type:** use `build_source` + `upload_id` → `raw_report_uploads.report_type` (`REMOVAL_ORDER` / `REMOVAL_SHIPMENT`). Recommend tagging intake family **`amazon_removal`** in audit metadata (no new column required for v1).",
      "",
      "## UI / read-model dependencies",
      "",
      "| Consumer | How it uses intake |",
      "|----------|-------------------|",
      "| `ExpectedPackagesLinkagePanel` | `fetchExpectedPackagesNedaRead` — order/tracking filter |",
      "| `lib/scanner/operator-tracking-expectations.ts` | Groups EP by sku/fnsku/disposition for tracking gate |",
      "| `lib/scanner/shipment-entry-lookup.ts` | EP rows by tracking when no inventory view hit |",
      "| `app/returns/_components.tsx` Package drawer | `expected_packages` count + `getAmazonExpectedItems` reconciliation |",
      "| `app/returns/expected-packages-linkage-actions.ts` | ProductLinkageDisplayContract + scanned qty from `return_items` |",
      "| `v_inventory_item_status` / NEDA views | Aggregates `expected_scan_quantity` by package_code |",
      "| Scanner operator mobile | `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT` — scan vs expected qty |",
      "",
      "## Packages / pallets hierarchy (indirect)",
      "",
      "```",
      "pallets",
      "  └── packages (physical, order_id + tracking_number + package_number)",
      "        └── return_items (scanned)",
      "",
      "expected_packages (Amazon expected — NO package_id FK)",
      "  matched by tracking_number + order_id + store at read time",
      "",
      "removal_item_allocations (optional bridge)",
      "  amazon_removals ↔ shipment_box_items",
      "```",
      "",
      "Do **not** require `expected_packages.package_id` for v1 — link at UI layer via tracking/order.",
      "",
      "Prior join plan: `" + PRIOR_REMOVAL_PLAN + "`",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "removal-normalized-item-contract.json"),
    JSON.stringify(NORMALIZED_ITEM_CONTRACT, null, 2),
  );

  fs.writeFileSync(
    path.join(outDir, "dedupe-rules.md"),
    [
      "# Dedupe rules",
      "",
      "## expected_packages (derived Amazon intake)",
      "",
      "| Index | Key | When |",
      "|-------|-----|------|",
      "| `uq_expected_packages_derived_pair` | `(organization_id, source_detail_row_id, source_shipment_row_id)` | `build_source IN (detail_shipment, detail_remainder)` |",
      "| `uq_expected_packages_canonical_legacy` | 7-tuple incl. sku/fnsku/disposition | `build_source = legacy` only |",
      "",
      "**Never** dedupe derived rows on SKU alone.",
      "",
      "## Upstream (before intake rebuild)",
      "",
      "| Table | Dedupe |",
      "|-------|--------|",
      "| `amazon_removals` | `uq_amazon_removals_business_line` (org, store, order_id, sku, fnsku, qty cols, order_date, order_type) |",
      "| `amazon_removal_shipments` | `(organization_id, upload_id, amazon_staging_id)` |",
      "",
      "## Rebuild idempotency",
      "",
      "- `rebuild_expected_packages_from_removals` UPSERT on derived pair key",
      "- Deletes obsolete derived rows in scope when pair no longer exists",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "unresolved-product-queue-rules.md"),
    [
      "# Unresolved product queue rules",
      "",
      "## Rule: product_id not required at EP INSERT",
      "",
      "`rebuild_expected_packages_from_removals` does **not** set `resolved_product_id`.",
      "Linkage is read-time via `product_identifier_map` until governed backfill.",
      "",
      "## Resolution pipeline (after intake row exists)",
      "",
      "1. Read-layer: map + products direct (`resolveScannerProductIdentifiers`)",
      "2. If single winner → optional `resolved_product_id` backfill (separate approval)",
      "3. If unresolved → queues:",
      "",
      "| Queue | Cohort | Action |",
      "|-------|--------|--------|",
      "| PC03C manual | dirty / ambiguous spine | operator product pick + map insert |",
      "| PC03C amazon evidence | X-FNSKU only | SP-API inventory → catalog |",
      "| PC03D | 5 FNSKU rows | governed evidence dry-run |",
      "| E2 promotion | trusted inventory name + ids | governed `products.insert` + map |",
      "",
      "## product_id required before \"final accepted\"",
      "",
      "| Stage | product_id required? |",
      "|-------|---------------------|",
      "| `expected_packages` row exists | **No** — row is valid Amazon intake |",
      "| Scanner shows linkage display | **No** — read-layer map OK |",
      "| `return_items` scan committed | **Yes** — need resolved product or explicit review |",
      "| Claim filing | **Yes** |",
      "",
      "## Never create product from title alone",
      "",
      "See `.cursor/audit-reports/product-creation-resolution-contract/`",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "implementation-order.md"),
    [
      "# Implementation order",
      "",
      "1. **SP-API removal reports fetch** (approval: `APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH`) — download only",
      "2. **Sync** `REMOVAL_ORDER` → `amazon_removals`, `REMOVAL_SHIPMENT` → `amazon_removal_shipments`",
      "3. **`rebuild_expected_packages_from_removals(org, store)`** — populates intake rows",
      "4. **Linkage census** — `product-linkage-table-coverage-audit` on EP unresolved",
      "5. **Map-only bridge** — existing product_id only (`e1b` / PC03 patterns)",
      "6. **Evidence dry-run** — PC03D / SP-API for X-FNSKU unresolved",
      "7. **Governed product promotion** — E2-style for trusted spine only",
      "8. **`resolved_product_id` backfill** — separate approval; never bulk during rebuild",
      "9. **UI** — already consumes EP via NEDA contract; no schema change required for v1",
      "",
      "## Out of scope for fast path v1",
      "",
      "- New `accepted_packages` table",
      "- FK from `expected_packages` → `packages`",
      "- Per-unit row explosion",
      "- Auto product create during import sync",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length
      ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
      : [
          "- No `accepted_packages` table — plan uses `expected_packages`.",
          "- `expected_packages.asin` column absent on live DB — ASIN via `amazon_removals` join at read time.",
          "- `resolved_product_id` not populated by rebuild — linkage incomplete until map/promotion waves.",
          "- Physical `packages` link is soft (tracking/order), not FK.",
        ].join("\n") + "\n",
  );

  const nextPrompt =
    "REMOVAL-INTAKE-REBUILD-EXECUTE — run rebuild_expected_packages_from_removals after SP-API sync (staging, approval-gated)";

  const manifest = {
    prompt: "REMOVAL SHIPMENT/DETAIL TO ACCEPTED INTAKE FAST PLAN",
    run_id: runId,
    branch,
    status: blockers.length ? "BLOCKED" : "PASS",
    recommended_row_grain: recommendedGrain,
    required_fields: NORMALIZED_ITEM_CONTRACT.fields,
    intake_table: "expected_packages",
    accepted_packages_table: null,
    dedupe_key_derived:
      "organization_id + source_detail_row_id + source_shipment_row_id (NULL shipment allowed for remainder)",
    intake_source_family: "amazon_removal",
    exact_next_prompt: nextPrompt,
    forbidden: { db_writes: true },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: !blockers.length,
        outDir,
        recommended_row_grain: recommendedGrain,
        required_field_count: Object.keys(NORMALIZED_ITEM_CONTRACT.fields).length,
        blockers,
        next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
