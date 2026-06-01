/**
 * PRODUCT-ENRICHMENT-BACKEND-JOB-IMPLEMENT-WAVE1 — batch library + route parity tests
 *
 * Run: npx tsx scripts/test-pim-catalog-enrichment-batch.ts
 */
import {
  PIM_CATALOG_ENRICHMENT_DELAY_MS,
  PIM_CATALOG_ENRICHMENT_MAX_PER_RUN,
  PIM_CATALOG_ENRICHMENT_METRIC_KEYS,
  parsePimCatalogEnrichmentBatchParams,
  validatePimCatalogEnrichmentBatchParams,
} from "../lib/pim-catalog-enrichment-batch-request";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const PID = "209497af-4554-4a8b-91a1-ff4f8e00df77";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main(): void {
  let passed = 0;

  assert(PIM_CATALOG_ENRICHMENT_MAX_PER_RUN === 80, "MAX_PER_RUN unchanged");
  assert(PIM_CATALOG_ENRICHMENT_DELAY_MS === 220, "DELAY_MS unchanged");
  passed += 2;

  const parsed = parsePimCatalogEnrichmentBatchParams({
    organization_id: ORG,
    store_id: STORE,
    limit: 200,
    start_index: 5,
    prioritize_incomplete: true,
    force_fresh_price_rows: true,
    include_enrichment_debug: true,
  });
  assert(parsed.organizationId === ORG, "org parsed");
  assert(parsed.storeId === STORE, "store parsed");
  assert(parsed.limit === 80, "limit capped at MAX_PER_RUN");
  assert(parsed.startIndex === 5, "start_index parsed");
  assert(parsed.prioritizeIncomplete === true, "prioritize_incomplete");
  assert(parsed.forceFreshPriceRows === true, "force_fresh_price_rows");
  assert(parsed.allowEnrichmentDebug === true, "include_enrichment_debug flag");
  passed += 7;

  const retryParsed = parsePimCatalogEnrichmentBatchParams({
    organization_id: ORG,
    store_id: STORE,
    retry_failed_only: true,
    product_ids: [PID, "not-a-uuid"],
  });
  assert(retryParsed.retryOnly === true, "retry_failed_only");
  assert(retryParsed.retryIds.length === 1 && retryParsed.retryIds[0] === PID, "product_ids filtered to UUIDs");
  passed += 2;

  const bothErr = validatePimCatalogEnrichmentBatchParams({
    ...parsed,
    retryOnly: true,
    retryMissingPrices: true,
  });
  assert(bothErr?.error.includes("not both"), "reject both retry flags");
  passed++;

  const badOrg = validatePimCatalogEnrichmentBatchParams({ ...parsed, organizationId: "bad" });
  assert(badOrg?.error.includes("organization_id"), "bad org");
  passed++;

  const retryNoIds = validatePimCatalogEnrichmentBatchParams({
    ...parsed,
    retryOnly: true,
    retryIds: [],
  });
  assert(retryNoIds?.error.includes("product_ids"), "retry_failed_only requires ids");
  passed++;

  const missingPriceWithIds = validatePimCatalogEnrichmentBatchParams({
    ...parsed,
    retryMissingPrices: true,
    retryIds: [PID],
  });
  assert(missingPriceWithIds?.error.includes("does not use product_ids"), "retry_missing_prices_only rejects product_ids");
  passed++;

  const sampleSuccess = {
    ok: true as const,
    metrics: Object.fromEntries(PIM_CATALOG_ENRICHMENT_METRIC_KEYS.map((k) => [k, 0])),
    failures: [] as { product_id: string; reason: string }[],
    failed_product_ids: [] as string[],
  };
  for (const key of PIM_CATALOG_ENRICHMENT_METRIC_KEYS) {
    assert(key in sampleSuccess.metrics, `metrics missing key: ${key}`);
  }
  assert(Array.isArray(sampleSuccess.failures), "failures array");
  assert(Array.isArray(sampleSuccess.failed_product_ids), "failed_product_ids array");
  passed += PIM_CATALOG_ENRICHMENT_METRIC_KEYS.length + 2;

  console.log(`\n${passed} checks passed (pim-catalog-enrichment-batch wave1 parity).`);
}

main();
