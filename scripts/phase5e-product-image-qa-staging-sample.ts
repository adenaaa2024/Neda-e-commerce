/**
 * PHASE-5E-PRODUCT-IMAGE-QA-STAGING-SAMPLE
 * Max 1 main_image_url write on staging — no bulk, no original, no OpenAI.
 *
 *   npx tsx scripts/phase5e-product-image-qa-staging-sample.ts
 *   npx tsx scripts/phase5e-product-image-qa-staging-sample.ts --execute
 *   npx tsx scripts/phase5e-product-image-qa-staging-sample.ts --execute --product-id=<uuid>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { canonicalAmazonImageKey } from "../lib/amazon-catalog-image-extract";
import {
  collectAmazonRawImageCandidates,
  evaluateSuspiciousMainImage,
  isKnownBadImageUrl,
  KNOWN_BAD_IMAGE_SUBSTRINGS,
} from "../lib/pim-image-suspicious-policy";
import {
  assertStagingSupabaseUrl,
  loadEnvLocalIntoProcess,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase5e-product-image-qa-staging-sample";
const BLOCKED_NEEDLES = [...KNOWN_BAD_IMAGE_SUBSTRINGS];
const FANOUT_BLOCK_MIN_ASINS = 10;

type ProductRow = {
  id: string;
  asin: string | null;
  product_name: string | null;
  main_image_url: string | null;
  amazon_raw: unknown;
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

function argValue(prefix: string): string | null {
  const a = process.argv.find((x) => x.startsWith(`${prefix}=`));
  return a ? a.split("=").slice(1).join("=").trim() : null;
}

function wireStagingSupabaseEnv(): void {
  const stagingUrl =
    process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const stagingKey =
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() ||
    process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "";
  if (stagingUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = stagingUrl;
  if (stagingKey) process.env.SUPABASE_SERVICE_ROLE_KEY = stagingKey;
  assertStagingSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", "NEXT_PUBLIC_SUPABASE_URL");
}

function urlBlocked(url: string | null | undefined): boolean {
  if (!url?.trim()) return false;
  return BLOCKED_NEEDLES.some((n) => url.includes(n));
}

async function clusterAsinCount(client: pg.Client, imageUrl: string): Promise<number> {
  const r = await client.query(
    `SELECT count(DISTINCT upper(btrim(asin)))::int AS c
     FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
       AND main_image_url = $3 AND asin IS NOT NULL AND btrim(asin) <> ''`,
    [ORG, STORE, imageUrl],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function loadCandidateProducts(client: pg.Client, limit = 500): Promise<ProductRow[]> {
  const r = await client.query(
    `SELECT id::text, asin, product_name, main_image_url, amazon_raw
     FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
       AND asin IS NOT NULL AND btrim(asin) <> ''
       AND main_image_url NOT ILIKE '%31BH1QY2CvL%'
       AND main_image_url NOT ILIKE '%4152CsQbheL%'
       AND main_image_url NOT ILIKE '%41gCLv9NY9L%'
       AND (
         main_image_url IS NULL OR btrim(main_image_url) = ''
         OR main_image_url ILIKE '%media-amazon.com%'
         OR main_image_url ILIKE '%images-amazon.com%'
       )
     ORDER BY
       CASE
         WHEN main_image_url IS NOT NULL AND btrim(main_image_url) <> ''
           AND NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements_text(
               COALESCE(amazon_raw->'pim_image_candidates', '[]'::jsonb)
             ) AS c(val)
             WHERE c.val = main_image_url
           )
         THEN 0
         WHEN main_image_url IS NULL OR btrim(main_image_url) = '' THEN 1
         ELSE 2
       END,
       updated_at DESC NULLS LAST
     LIMIT $3`,
    [ORG, STORE, limit],
  );
  return r.rows as ProductRow[];
}

async function loadProductById(client: pg.Client, productId: string): Promise<ProductRow | null> {
  const r = await client.query(
    `SELECT id::text, asin, product_name, main_image_url, amazon_raw
     FROM public.products
     WHERE id = $1::uuid AND organization_id = $2::uuid AND store_id = $3::uuid AND deleted_at IS NULL`,
    [productId, ORG, STORE],
  );
  return (r.rows[0] as ProductRow | undefined) ?? null;
}

type RepairOutcome = Awaited<
  ReturnType<typeof import("../lib/pim-suspicious-image-repair").repairSuspiciousProductImage>
>;

async function pickRepairableCandidate(
  client: pg.Client,
  forcedProductId: string | null,
  repairDryRun: (row: ProductRow) => Promise<RepairOutcome>,
): Promise<{
  row: ProductRow;
  reason: string;
  dryOutcome: RepairOutcome;
  probe_failures: string[];
} | null> {
  const pool = forcedProductId
    ? ([await loadProductById(client, forcedProductId)].filter(Boolean) as ProductRow[])
    : await loadCandidateProducts(client);

  const probeFailures: string[] = [];

  for (const row of pool) {
    if (urlBlocked(row.main_image_url)) continue;
    const suspicious = evaluateSuspiciousMainImage(row);
    const missing = !row.main_image_url?.trim();
    if (!missing && !suspicious.suspicious) continue;

    if (row.main_image_url?.trim()) {
      const asinCount = await clusterAsinCount(client, row.main_image_url);
      if (asinCount >= FANOUT_BLOCK_MIN_ASINS) continue;
    }

    const asin = String(row.asin ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) continue;

    const dryOutcome = await repairDryRun(row);
    if (dryOutcome.decision === "updated" && dryOutcome.new_candidate_url) {
      const reason = missing
        ? "missing_main_image_url"
        : suspicious.reasons.join("|") || "suspicious_main_image";
      return { row, reason, dryOutcome, probe_failures: probeFailures };
    }
    probeFailures.push(`${row.id}/${asin}:${dryOutcome.skip_reason ?? "no_candidate"}`);
  }
  return null;
}

function candidateInAmazonRaw(amazonRaw: unknown, candidateUrl: string): boolean {
  const key = canonicalAmazonImageKey(candidateUrl);
  if (!key) return false;
  return collectAmazonRawImageCandidates(amazonRaw).some(
    (u) => canonicalAmazonImageKey(u) === key,
  );
}

function provenanceOk(amazonRaw: unknown, productAsin: string): boolean {
  if (!amazonRaw || typeof amazonRaw !== "object" || Array.isArray(amazonRaw)) return false;
  const raw = amazonRaw as Record<string, unknown>;
  const prov = raw.pim_image_provenance;
  const sourceAsin = String(
    (prov && typeof prov === "object" && !Array.isArray(prov)
      ? (prov as Record<string, unknown>).image_source_asin
      : null) ??
      raw.image_source_asin ??
      "",
  )
    .trim()
    .toUpperCase();
  return sourceAsin === productAsin && Boolean(raw.image_fetch_path || (prov as Record<string, unknown>)?.image_fetch_path);
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const forcedProductId = argValue("--product-id");
  loadEnvLocalIntoProcess();
  wireStagingSupabaseEnv();

  const pgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!pgUrl.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL must target staging");
  if (pgUrl.includes(ORIGINAL_REF)) throw new Error("BLOCKED: original postgres URL");

  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  require.cache[require.resolve("server-only")] = {
    id: "server-only",
    filename: "server-only",
    loaded: true,
    exports: {},
  } as NodeModule;
  const { repairSuspiciousProductImage } = await import("../lib/pim-suspicious-image-repair");

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const repairDryRun = (row: ProductRow) =>
    repairSuspiciousProductImage({
      row,
      organizationId: ORG,
      storeId: STORE,
      dryRun: true,
      client,
      fetchPath: "phase5e_product_image_qa_staging_sample",
      forceRepair: true,
    });

  const picked = await pickRepairableCandidate(client, forcedProductId, repairDryRun);
  if (!picked) {
    await client.end();
    throw new Error("No repairable safe non-1883 staging candidate found (catalog fetch or policy)");
  }

  const { row, reason: reasonOld, dryOutcome } = picked;
  const preimage = {
    product_id: row.id,
    asin: row.asin,
    product_name: row.product_name,
    main_image_url: row.main_image_url,
    amazon_raw: row.amazon_raw,
  };
  fs.writeFileSync(path.join(outDir, "preimage.json"), JSON.stringify(preimage, null, 2));

  let rowsUpdated = 0;
  let postRow: ProductRow | null = null;
  let outcome = dryOutcome;

  if (execute && dryOutcome.decision === "updated" && dryOutcome.new_candidate_url) {
    outcome = await repairSuspiciousProductImage({
      row,
      organizationId: ORG,
      storeId: STORE,
      dryRun: false,
      client,
      fetchPath: "phase5e_product_image_qa_staging_sample",
      forceRepair: true,
    });
    if (outcome.decision === "updated" && !outcome.skip_reason) {
      rowsUpdated = 1;
      postRow = await loadProductById(client, row.id);
    }
  }

  await client.end();

  const productAsin = String(row.asin ?? "").trim().toUpperCase();
  const candidateInRaw = postRow
    ? candidateInAmazonRaw(postRow.amazon_raw, outcome.new_candidate_url ?? "")
    : false;
  const provWritten = postRow ? provenanceOk(postRow.amazon_raw, productAsin) : false;

  const rollbackSql = `-- PHASE-5E product image QA staging sample rollback
-- product_id: ${row.id}
-- asin: ${productAsin}
UPDATE public.products
SET main_image_url = ${preimage.main_image_url ? `'${String(preimage.main_image_url).replace(/'/g, "''")}'` : "NULL"},
    amazon_raw = '${JSON.stringify(preimage.amazon_raw ?? {}).replace(/'/g, "''")}'::jsonb,
    updated_at = now()
WHERE id = '${row.id}'::uuid
  AND organization_id = '${ORG}'::uuid
  AND store_id = '${STORE}'::uuid;
`;
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackSql);

  const visualQaNeeded =
    outcome.decision === "updated" && rowsUpdated === 1 && !isKnownBadImageUrl(outcome.new_candidate_url);

  const blockers: string[] = [];
  if (!execute) blockers.push("dry_run — pass --execute for single staging write");
  if (outcome.decision !== "updated") blockers.push(outcome.skip_reason ?? "repair_did_not_update");
  if (execute && rowsUpdated === 1 && !candidateInRaw) blockers.push("candidate_not_in_pim_image_candidates");
  if (execute && rowsUpdated === 1 && !provWritten) blockers.push("pim_image_provenance_missing_or_asin_mismatch");

  const summary = {
    phase: "5E-PRODUCT-IMAGE-QA-STAGING-SAMPLE",
    run_id: rid,
    staging_ref: STAGING_REF,
    execute,
    selected_product_id: row.id,
    asin: productAsin,
    old_main_image_url: row.main_image_url,
    new_candidate_url: outcome.new_candidate_url,
    reason_old_was_suspicious: reasonOld,
    suspicious_reasons: outcome.suspicious_reasons,
    provenance_written: execute && rowsUpdated === 1 ? provWritten : false,
    candidate_in_amazon_raw: execute && rowsUpdated === 1 ? candidateInRaw : null,
    rows_updated: rowsUpdated,
    rollback_artifact: path.join(outDir, "rollback.sql"),
    preimage_artifact: path.join(outDir, "preimage.json"),
    visual_qa_needed: visualQaNeeded ? "yes" : "no",
    SAFE_TO_RUN_NEXT_IMAGE_SAMPLE:
      execute && rowsUpdated === 1 && provWritten && candidateInRaw ? "yes" : "no",
    SAFE_TO_SCALE_IMAGE_REPAIR: "yes_with_conditions",
    SAFE_TO_SCALE_IMAGE_REPAIR_conditions:
      "Operator visual QA on staging sample; confirm 41gCLv9NY9L blocked; no production until manual-review.csv cleared for fanout clusters",
    NEXT_EXACT_PROMPT:
      execute && rowsUpdated === 1
        ? "PHASE-5E-PRODUCT-IMAGE-VISUAL-QA-STAGING-SAMPLE — operator review before/after PNG for selected product; then PHASE-5E-SECOND-SAMPLE or block 1883 cluster manual_review sweep"
        : "PHASE-5E-PRODUCT-IMAGE-QA-STAGING-SAMPLE --execute (fix blockers first)",
    blockers,
    probe_failures: picked.probe_failures,
    outcome,
    known_bad_includes_41gCLv9NY9L: KNOWN_BAD_IMAGE_SUBSTRINGS.includes("41gCLv9NY9L"),
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
