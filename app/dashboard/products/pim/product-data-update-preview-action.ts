"use server";

import {
  assertUserCanAccessOrganization,
  userCanViewPimEnrichmentDebug,
} from "../pim-actions";
import { runPimCatalogEnrichmentBatch } from "@/lib/pim-catalog-enrichment-batch";
import {
  buildPreviewSummary,
  pickPreviewProductIds,
  selectPimPreviewSampleProducts,
  type ProductDataUpdatePreviewSummary,
} from "@/lib/pim-catalog-enrichment-preview-samples";
import { refFromSupabaseUrl, supabaseUrlMatchesStagingRef } from "@/lib/staging-project-ref";
import { isUuidString } from "@/lib/uuid";

const STAGING_REF = "eiqfaapyumhixxoeltgu";

export type RunProductDataUpdatePreviewResult =
  | {
      ok: true;
      summary: ProductDataUpdatePreviewSummary;
      failures: { product_id: string; reason: string }[];
      enrichment_debug?: Record<string, unknown>[];
    }
  | { ok: false; error: string };

export async function runProductDataUpdatePreviewAction(args: {
  organization_id: string;
  store_id: string;
  include_enrichment_debug?: boolean;
}): Promise<RunProductDataUpdatePreviewResult> {
  const organizationId = String(args.organization_id ?? "").trim();
  const storeId = String(args.store_id ?? "").trim();
  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return { ok: false, error: "Organization and store are required." };
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (refFromSupabaseUrl(url) !== STAGING_REF || !supabaseUrlMatchesStagingRef(url)) {
    return { ok: false, error: "Product data preview is staging-only in this phase." };
  }

  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL ?? process.env.DIRECT_POSTGRES_URL ?? "";
  if (!pgUrl) return { ok: false, error: "Preview database URL is not configured." };

  const samples = await selectPimPreviewSampleProducts({
    postgresUrl: pgUrl,
    organizationId,
    storeId,
  });
  if (samples.length < 1) {
    return { ok: false, error: "No eligible preview sample products found." };
  }

  const productIds = pickPreviewProductIds(samples);
  const allowEnrichmentDebug =
    Boolean(args.include_enrichment_debug) && (await userCanViewPimEnrichmentDebug(organizationId));

  const preview = await runPimCatalogEnrichmentBatch({
    organizationId,
    storeId,
    limit: productIds.length,
    startIndex: 0,
    prioritizeIncomplete: false,
    forceFreshPriceRows: false,
    retryOnly: true,
    retryMissingPrices: false,
    retryIds: productIds,
    allowEnrichmentDebug,
    allowSuspiciousImageOverwrite: false,
    dryRun: true,
  });

  if (!preview.ok) {
    return { ok: false, error: preview.error };
  }

  const metrics = preview.metrics as Record<string, unknown>;
  if (!metrics.dry_run) {
    return { ok: false, error: "Preview batch did not run in dry_run mode." };
  }

  const failures = preview.failures ?? [];
  const summary = buildPreviewSummary({ samples, metrics, failures });

  return {
    ok: true,
    summary,
    failures,
    enrichment_debug: allowEnrichmentDebug
      ? ((preview.enrichment_debug ?? []) as Record<string, unknown>[]).slice(0, 5)
      : undefined,
  };
}
